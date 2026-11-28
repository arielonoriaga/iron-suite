import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import {
  CpuProfilerManager,
  summarizeCpuProfile,
  writeSafeCpuProfileFile,
} from '../src/main/cpu-profiler';
import {
  MainThreadWatchdog,
  scanLatestCrashDump,
  StructuredLogger,
} from '../src/main/diagnostics';
import { DebuggerCoordinator, type DebuggerTarget } from '../src/main/debugger-coordinator';
import { MirrorRelay, type IpcMainLike } from '../src/main/mirror-relay';
import {
  buildIdentityOverrideScript,
  clampCpuRate,
  EMULATION_PROFILES,
  HOST_HARDWARE_CONCURRENCY,
  resolveNetworkEmulationInput,
  SlowDeviceEmulationManager,
  SUNMI_V2_PRO_USER_AGENT,
} from '../src/main/slow-device-emulation';
import { TabEventBus } from '../src/main/tab-event-bus';
import { DEVICE_PRESETS, findPreset } from '../src/shared/presets';
import { buildWsSseMuxShimScript } from '../src/shared/ws-sse-mux-core';

class MockDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  nextScriptSeq = 1;

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `emu-script-${this.nextScriptSeq++}` };
    }
    return {};
  }
}

class MockWc extends EventEmitter implements DebuggerTarget {
  readonly debugger = new MockDebugger();
  destroyed = false;
  evalLog: string[] = [];
  evalHandler?: (code: string) => unknown;
  session = {
    getUserAgent: () => 'Mozilla/5.0 HostChromium/134.0',
  };

  constructor(public readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  async executeJavaScript(code: string): Promise<unknown> {
    this.evalLog.push(code);
    if (this.evalHandler) return this.evalHandler(code);
    return undefined;
  }
}

describe('Sunmi V2 Pro Preset & SlowDeviceEmulationManager', () => {
  test('registers sunmi-v2-pro preset with exact 360x720 CSS px, DPR 2, touch, portrait', () => {
    const preset = findPreset('sunmi-v2-pro');
    expect(preset).toBeDefined();
    expect(preset).toEqual({
      id: 'sunmi-v2-pro',
      label: 'Sunmi V2 Pro (360×720)',
      width: 360,
      height: 720,
      dpr: 2,
      touch: true,
      category: 'portrait',
    });
    expect(DEVICE_PRESETS.some((p) => p.id === 'sunmi-v2-pro')).toBe(true);
  });

  test('validates CPU rate (1..20) and network presets + custom latency/kbps', () => {
    expect(clampCpuRate(1)).toBe(1);
    expect(clampCpuRate(6)).toBe(6);
    expect(clampCpuRate(20)).toBe(20);
    expect(() => clampCpuRate(0.5)).toThrow();
    expect(() => clampCpuRate(25)).toThrow();
    expect(() => clampCpuRate(Number.NaN)).toThrow();

    const slow4g = resolveNetworkEmulationInput('slow-4g');
    expect(slow4g.offline).toBe(false);
    expect(slow4g.latencyMs).toBe(150);
    expect(slow4g.downloadBytesPerSec).toBe(200_000);
    expect(slow4g.uploadBytesPerSec).toBe(93_750);

    const offline = resolveNetworkEmulationInput('offline');
    expect(offline.offline).toBe(true);
    expect(offline.downloadBytesPerSec).toBe(0);

    const custom = resolveNetworkEmulationInput({
      latency_ms: 240,
      down_kbps: 800,
      up_kbps: 320,
    });
    expect(custom).toEqual({
      preset: 'custom',
      offline: false,
      latencyMs: 240,
      downloadBytesPerSec: 100_000,
      uploadBytesPerSec: 40_000,
    });

    expect(() => resolveNetworkEmulationInput('5g-ultra' as 'none')).toThrow();
  });

  test('applies sunmi-v2-pro CDP overrides, survives debugger detach/reattach, and resets cleanly to host values', async () => {
    const coord = new DebuggerCoordinator();
    const mgr = new SlowDeviceEmulationManager(coord, { now: () => 10_000 });
    const wc = new MockWc(101);

    const state = mgr.updateViewportConfig(
      'tab-1',
      'portrait',
      { profile: 'sunmi-v2-pro', reducedMotion: true, saveData: true },
      true,
    );
    expect(state.active).toBe(true);
    expect(state.profile).toBe('sunmi-v2-pro');
    expect(state.cpuRate).toBe(6);
    expect(state.deviceMemory).toBe(2);
    expect(state.hardwareConcurrency).toBe(4);
    expect(state.userAgent).toBe(SUNMI_V2_PRO_USER_AGENT);
    expect(state.presetId).toBe('sunmi-v2-pro');

    await mgr.syncViewport('tab-1', 'portrait', wc);

    const methods = wc.debugger.commands.map((c) => c.method);
    expect(methods).toContain('Emulation.setCPUThrottlingRate');
    expect(methods).toContain('Network.emulateNetworkConditions');
    expect(methods).toContain('Network.setExtraHTTPHeaders');
    expect(methods).toContain('Network.setUserAgentOverride');
    expect(methods).toContain('Emulation.setHardwareConcurrencyOverride');
    expect(methods).toContain('Emulation.setEmulatedMedia');
    expect(methods).toContain('Page.addScriptToEvaluateOnNewDocument');

    const uaCmd = wc.debugger.commands.find((c) => c.method === 'Network.setUserAgentOverride')!;
    expect(String(uaCmd.params?.userAgent)).toContain('Android 7.1');
    expect(uaCmd.params?.platform).toBe('Linux armv8l');

    const saveHeaderCmd = wc.debugger.commands.find(
      (c) => c.method === 'Network.setExtraHTTPHeaders',
    )!;
    expect(saveHeaderCmd.params?.headers).toEqual({ 'Save-Data': 'on' });

    // Simulate DevTools detach + reattach -> overrides re-applied automatically
    wc.debugger.commands.length = 0;
    wc.debugger.attached = false;
    wc.debugger.emit('detach', {}, 'target_closed');
    await coord.reattachAndRestore(wc);
    expect(
      wc.debugger.commands.some(
        (c) => c.method === 'Emulation.setCPUThrottlingRate' && c.params?.rate === 6,
      ),
    ).toBe(true);
    expect(
      wc.debugger.commands.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
    ).toBe(true);

    // Reset via profile: 'none' removes script and restores host values
    wc.debugger.commands.length = 0;
    const resetState = mgr.updateViewportConfig('tab-1', 'portrait', { profile: 'none' }, true);
    expect(resetState.active).toBe(false);
    await mgr.syncViewport('tab-1', 'portrait', wc);

    expect(
      wc.debugger.commands.some(
        (c) => c.method === 'Emulation.setCPUThrottlingRate' && c.params?.rate === 1,
      ),
    ).toBe(true);
    expect(
      wc.debugger.commands.some(
        (c) => c.method === 'Network.setUserAgentOverride' && c.params?.userAgent === '',
      ),
    ).toBe(true);
    expect(
      wc.debugger.commands.some(
        (c) =>
          c.method === 'Emulation.setHardwareConcurrencyOverride' &&
          c.params?.hardwareConcurrency === HOST_HARDWARE_CONCURRENCY,
      ),
    ).toBe(true);
    expect(
      wc.debugger.commands.some((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument'),
    ).toBe(true);
  });

  test('buildIdentityOverrideScript overrides and restores native Navigator.prototype.deviceMemory and connection.saveData descriptors', () => {
    const fakeConnProto: Record<string | symbol, unknown> = {};
    Object.defineProperty(fakeConnProto, 'saveData', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });
    const fakeConn = Object.create(fakeConnProto);

    class FakeNavigator {}
    Object.defineProperty(FakeNavigator.prototype, 'deviceMemory', {
      get: () => 8,
      configurable: true,
      enumerable: true,
    });
    const fakeNav = new FakeNavigator() as Record<string, unknown>;
    Object.defineProperty(fakeNav, 'connection', {
      value: fakeConn,
      configurable: true,
    });

    const ctx = vm.createContext({
      Navigator: FakeNavigator,
      navigator: fakeNav,
      Symbol,
      Object,
    });

    vm.runInContext(buildIdentityOverrideScript(2, true), ctx);
    expect(vm.runInContext('navigator.deviceMemory', ctx)).toBe(2);
    expect(vm.runInContext('navigator.connection.saveData', ctx)).toBe(true);

    // Idempotent second application keeps original stashed descriptor
    vm.runInContext(buildIdentityOverrideScript(4, true), ctx);
    expect(vm.runInContext('navigator.deviceMemory', ctx)).toBe(4);

    // Reset (null, false) restores exact original getters (8 and false)
    vm.runInContext(buildIdentityOverrideScript(null, false), ctx);
    expect(vm.runInContext('navigator.deviceMemory', ctx)).toBe(8);
    expect(vm.runInContext('navigator.connection.saveData', ctx)).toBe(false);
  });

  test('calibrateViewport picks clamped CPU rate from unthrottled hostScore / targetScore', async () => {
    const coord = new DebuggerCoordinator();
    const mgr = new SlowDeviceEmulationManager(coord, { now: () => 55_000 });
    const wc = new MockWc(202);
    let currentRate = 1;
    wc.debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      wc.debugger.commands.push({ method, params });
      if (method === 'Emulation.setCPUThrottlingRate') {
        currentRate = Number(params?.rate ?? 1);
      }
      return {};
    };
    wc.evalHandler = () => ({
      score: Math.round(126_000 / currentRate),
    });

    mgr.updateViewportConfig(
      'tab-cal',
      'portrait',
      { profile: 'sunmi-v2-pro', targetScore: EMULATION_PROFILES['sunmi-v2-pro'].targetScore ?? 95_000 },
      true,
    );
    const cal = await mgr.calibrateViewport('tab-cal', 'portrait', wc, 18_000);
    expect(cal.hostScore).toBe(126_000);
    expect(cal.targetScore).toBe(18_000);
    expect(cal.chosenRate).toBe(7); // 126_000 / 18_000 = 7
    expect(cal.resultingScore).toBe(18_000);
    expect(mgr.getViewportState('tab-cal', 'portrait').cpuRate).toBe(7);
  });
});

describe('PIN Keypad Mirroring & TabEventBus Path Resolution', () => {
  test('MirrorRelay.dispatchTrustedKey sends Digit0..9 codes and passes senderWc.id on mirror miss', async () => {
    const misses: Array<{ tabId: string; reason: string; sourceWcId?: number }> = [];
    const fakeIpc: IpcMainLike = {
      on: () => {},
      off: () => {},
    };
    const sentCdpKeys: Array<Record<string, unknown>> = [];
    const targetWc = {
      id: 22,
      isDestroyed: () => false,
      getURL: () => 'https://app.ez-stock.test/login',
      mainFrame: { origin: 'https://app.ez-stock.test' },
      debugger: {
        isAttached: () => true,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Input.dispatchKeyEvent' && params) {
            sentCdpKeys.push(params);
          }
          return {};
        },
      },
      send: () => {},
      sendInputEvent: () => {},
    };
    const senderWc = {
      id: 11,
      isDestroyed: () => false,
      getURL: () => 'https://app.ez-stock.test/pos/cart',
      mainFrame: { origin: 'https://app.ez-stock.test' },
    };

    const relay = new MirrorRelay(
      {
        findByWebContentsId: () => null,
        onMirrorMiss: (tabId, info, sourceWcId) => {
          misses.push({ tabId, reason: info.reason, sourceWcId });
        },
      },
      fakeIpc,
    );

    try {
      await relay.dispatchTrustedKey(targetWc as never, '5');
      expect(sentCdpKeys.length).toBe(2);
      expect(sentCdpKeys[0]!.key).toBe('5');
      expect(sentCdpKeys[0]!.code).toBe('Digit5');

      sentCdpKeys.length = 0;
      await relay.dispatchTrustedKey(targetWc as never, '1', [], 'Numpad1');
      expect(sentCdpKeys[0]!.key).toBe('1');
      expect(sentCdpKeys[0]!.code).toBe('Numpad1');

      // Trigger target-not-found miss via fast query timeout
      await relay.replayEvent(
        'tab-pin',
        'portrait',
        {
          ...targetWc,
          send: (_ch: string, payload: { reqId: string }) => {
            // Immediately reply not found
            const listeners = (fakeIpc as unknown as { cb?: unknown }).cb;
            void listeners;
            void payload;
          },
        } as never,
        {
          kind: 'click',
          button: 'left',
          clickCount: 1,
          modifiers: [],
          fingerprint: {
            tag: 'button',
            role: 'button',
            text: 'Ahora no',
            cssPath: 'button:nth-of-type(1)',
            isCanvas: false,
            relViewportX: 0.5,
            relViewportY: 0.5,
          },
        },
        1,
        {
          senderWc: senderWc as never,
          expectedOrigin: 'https://app.ez-stock.test',
          epoch: 0,
        },
      );
      expect(misses.length).toBe(1);
      expect(misses[0]).toEqual({
        tabId: 'tab-pin',
        reason: 'click:target-not-found',
        sourceWcId: 11,
      });
    } finally {
      relay.dispose();
    }
  });

  test('TabEventBus loads rust-napi addon even when process.cwd() is outside iron-browser/app and tracks sessionStorage write timestamps', () => {
    const origCwd = process.cwd();
    try {
      process.chdir(path.parse(origCwd).root === '/' ? '/tmp' : origCwd);
      const bus = new TabEventBus({ now: () => 42_000 });
      try {
        expect(bus.backend).toBe('rust-napi');
        expect(bus.getLastSessionStorageWriteMs('tab-1')).toBe(0);
        const res = bus.sessionStorageSet(
          'tab-1',
          'https://app.pos-terminal.example.com',
          'landscape',
          'pos:employee-jwt',
          'jwt-token',
          42_500,
        );
        expect(res.ok).toBe(true);
        expect(res.changed).toBe(true);
        expect(bus.getLastSessionStorageWriteMs('tab-1')).toBe(42_500);

        bus.sessionStorageClearTab('tab-1');
        expect(bus.getLastSessionStorageWriteMs('tab-1')).toBe(0);
      } finally {
        bus.dispose();
      }
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('Cross-Origin EventSource Shim & V8 CPU Profiler', () => {
  test('buildWsSseMuxShimScript omits non-CORS-safelisted Cache-Control header on SSE fetch and falls back to bypass on cross-origin failure', () => {
    const shim = buildWsSseMuxShimScript();
    expect(shim).not.toContain("'Cache-Control': 'no-cache'");
    expect(shim).toContain("'Accept': 'text/event-stream'");
    expect(shim).toContain('upstream-sse-bypass');
  });

  test('summarizeCpuProfile computes recursion-safe bottom-up selfMs/totalMs, per-script selfMs, and redacts script query tokens', () => {
    // Tree: (root:1) -> main(2, app.js:10) -> recurse(3, app.js:20) -> recurse(4, app.js:20) -> leafHelper(5, vendor.js:4)
    // Plus (idle:6) and (garbage collector:7)
    const profile = {
      startTime: 1_000_000,
      endTime: 1_100_000, // 100ms
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 6, 7] },
        {
          id: 2,
          callFrame: {
            functionName: 'reconcileCart',
            url: 'https://app.ez.test/pos.js?token=secret999',
            lineNumber: 9,
            columnNumber: 4,
          },
          children: [3],
        },
        {
          id: 3,
          callFrame: {
            functionName: 'recurseCalc',
            url: 'https://app.ez.test/pos.js?token=secret999',
            lineNumber: 19,
            columnNumber: 2,
          },
          children: [4],
        },
        {
          id: 4,
          callFrame: {
            functionName: 'recurseCalc',
            url: 'https://app.ez.test/pos.js?token=secret999',
            lineNumber: 19,
            columnNumber: 2,
          },
          children: [5],
        },
        {
          id: 5,
          callFrame: {
            functionName: 'formatPrice',
            url: 'https://cdn.ez.test/vendor.js',
            lineNumber: 3,
            columnNumber: 0,
          },
          children: [],
        },
        { id: 6, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, children: [] },
        { id: 7, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 }, children: [] },
      ],
      // Samples: node 4 (30ms), node 5 (20ms), node 2 (10ms), node 6 idle (30ms), node 7 GC (10ms)
      samples: [4, 5, 2, 6, 7],
      timeDeltas: [30_000, 20_000, 10_000, 30_000, 10_000],
    };

    const summary = summarizeCpuProfile(profile, 10);
    expect(summary.totalDurationMs).toBe(100);
    expect(summary.idleMs).toBe(30);
    expect(summary.gcMs).toBe(10);
    expect(summary.activeMs).toBe(70);

    // Top selfMs: recurseCalc (30ms self, 50ms total — NOT 80ms despite 2 recursive frames on stack!)
    const recurse = summary.functions.find((f) => f.functionName === 'recurseCalc')!;
    expect(recurse).toBeDefined();
    expect(recurse.selfMs).toBe(30);
    expect(recurse.totalMs).toBe(50);
    expect(recurse.line).toBe(20);
    expect(recurse.location).not.toContain('secret999');
    expect(recurse.location).toContain('https://app.ez.test/pos.js');

    const reconcile = summary.functions.find((f) => f.functionName === 'reconcileCart')!;
    expect(reconcile.selfMs).toBe(10);
    expect(reconcile.totalMs).toBe(60);

    const vendor = summary.functions.find((f) => f.functionName === 'formatPrice')!;
    expect(vendor.selfMs).toBe(20);
    expect(vendor.totalMs).toBe(20);

    // Per-script selfMs: pos.js = 40ms (30 + 10), vendor.js = 20ms, (internal) GC = 10ms
    const posScript = summary.scripts.find((s) => s.url.startsWith('https://app.ez.test/pos.js'))!;
    expect(posScript.selfMs).toBe(40);
    const vendorScript = summary.scripts.find((s) => s.url === 'https://cdn.ez.test/vendor.js')!;
    expect(vendorScript.selfMs).toBe(20);
  });

  test('CpuProfilerManager start/stop writes 0600 .cpuprofile and refuses symlinked profile directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-cpuprof-test-'));
    const profilesDir = path.join(tmpDir, 'profiles');
    try {
      const coord = new DebuggerCoordinator();
      const profiler = new CpuProfilerManager(coord, () => profilesDir, { now: () => 88_000 });
      const wc = new MockWc(303);
      wc.debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
        wc.debugger.commands.push({ method, params });
        if (method === 'Profiler.stop') {
          return {
            profile: {
              startTime: 0,
              endTime: 25_000,
              nodes: [
                { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
                { id: 2, callFrame: { functionName: 'posHotspot', url: 'http://127.0.0.1/pos.js', lineNumber: 41 }, children: [] },
              ],
              samples: [2],
              timeDeltas: [25_000],
            },
          };
        }
        return {};
      };

      const started = await profiler.start('tab-1', 'portrait', wc);
      expect(started.ok).toBe(true);
      expect(started.action).toBe('start');

      const stopped = (await profiler.stop('tab-1', 'portrait', { top: 5 })) as {
        ok: boolean;
        profilePath: string;
        summary: { functions: Array<{ functionName: string; selfMs: number; line: number }> };
      };
      expect(stopped.ok).toBe(true);
      expect(fs.existsSync(stopped.profilePath)).toBe(true);
      expect(stopped.profilePath.endsWith('.cpuprofile')).toBe(true);
      const st = fs.statSync(stopped.profilePath);
      expect(st.mode & 0o777).toBe(0o600);
      expect(stopped.summary.functions[0]?.functionName).toBe('posHotspot');
      expect(stopped.summary.functions[0]?.line).toBe(42);
      expect(stopped.summary.functions[0]?.selfMs).toBe(25);

      // Symlinked directory must fail closed
      const symTarget = path.join(tmpDir, 'real-dir');
      fs.mkdirSync(symTarget);
      const symPath = path.join(tmpDir, 'sym-profiles');
      fs.symlinkSync(symTarget, symPath);
      expect(() => writeSafeCpuProfileFile(symPath, 'tab-1', 'portrait', {})).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('F-23: standalone calibrateViewport registers debugger participant, restores on reattach, resets to rate 1, and restores prev rate on error', async () => {
    const coord = new DebuggerCoordinator();
    const mgr = new SlowDeviceEmulationManager(coord, { now: () => 50_000 });
    const wc = new MockWc(404);
    let evalCall = 0;
    wc.executeJavaScript = async () => {
      evalCall += 1;
      if (evalCall === 1) return { score: 120_000 };
      if (evalCall === 2) return { score: 20_000 };
      throw new Error('simulated page crash during calibration');
    };

    const cal = await mgr.calibrateViewport('tab-cal', 'portrait', wc, 20_000);
    expect(cal.chosenRate).toBe(6);
    expect(mgr.isViewportActive('tab-cal', 'portrait')).toBe(true);

    // Simulate DevTools detach & reattach -> must restore rate: 6!
    wc.debugger.commands.length = 0;
    wc.debugger.attached = false;
    wc.debugger.emit('detach', {}, 'replaced_with_devtools');
    await coord.reattachAndRestore(wc);
    expect(
      wc.debugger.commands.some(
        (c) => c.method === 'Emulation.setCPUThrottlingRate' && c.params?.rate === 6,
      ),
    ).toBe(true);

    // Simulate executeJavaScript throwing during re-calibration -> must restore rate: 6!
    wc.debugger.commands.length = 0;
    await expect(mgr.calibrateViewport('tab-cal', 'portrait', wc, 20_000)).rejects.toThrow();
    const cpuCmdsOnErr = wc.debugger.commands.filter(
      (c) => c.method === 'Emulation.setCPUThrottlingRate',
    );
    expect(cpuCmdsOnErr.map((c) => c.params?.rate)).toEqual([1, 6]);

    // Reset must send Emulation.setCPUThrottlingRate({ rate: 1 })
    wc.debugger.commands.length = 0;
    mgr.updateViewportConfig('tab-cal', 'portrait', { reset: true }, true);
    await mgr.syncViewport('tab-cal', 'portrait', wc);
    expect(
      wc.debugger.commands.some(
        (c) => c.method === 'Emulation.setCPUThrottlingRate' && c.params?.rate === 1,
      ),
    ).toBe(true);
    expect(mgr.isViewportActive('tab-cal', 'portrait')).toBe(false);
  });

  test('StructuredLogger (0600, rotation, token redaction), Crashpad dump scan, Watchdog stall detection, and CpuProfiler nav/size-cap', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-diag-test-'));
    try {
      const logDir = path.join(tmpDir, 'state-logs');
      const logger = new StructuredLogger(logDir, { maxBytes: 700, maxRotated: 2 });
      expect(fs.statSync(logger.logPath).mode & 0o777).toBe(0o600);

      logger.info('rpc.begin', {
        url: 'https://user:pass@app.ez.test/pos?token=secret777&sell_point_id=3',
      });
      for (let i = 0; i < 8; i += 1) {
        logger.warn('rpc.end', { iter: i, note: 'x'.repeat(80), jwt: 'token=supersecret' });
      }

      const tail = logger.tailLines(20);
      expect(tail.length).toBeGreaterThan(0);
      const joined = tail.join('\n');
      expect(joined).not.toContain('secret777');
      expect(joined).not.toContain('supersecret');
      expect(joined).not.toContain('user:pass');
      expect(fs.existsSync(`${logger.logPath}.1`)).toBe(true);
      expect(fs.statSync(`${logger.logPath}.1`).mode & 0o777).toBe(0o600);

      // Crashpad minidump scan picks latest .dmp in completed/
      const crashDir = path.join(tmpDir, 'Crashpad');
      fs.mkdirSync(path.join(crashDir, 'completed'), { recursive: true });
      const dmp1 = path.join(crashDir, 'completed', 'old.dmp');
      const dmp2 = path.join(crashDir, 'completed', 'latest.dmp');
      fs.writeFileSync(dmp1, 'dmp1');
      const past = new Date(Date.now() - 10_000);
      fs.utimesSync(dmp1, past, past);
      fs.writeFileSync(dmp2, 'dmp2-newer');
      const latestDump = scanLatestCrashDump(crashDir);
      expect(latestDump?.path).toBe(dmp2);
      expect(latestDump?.totalDumps).toBe(2);

      // MainThreadWatchdog detects simulated stall when beatTimer is paused and logs pending RPCs
      const wdLog = new StructuredLogger(path.join(tmpDir, 'wd-logs'));
      const wd = new MainThreadWatchdog(wdLog.logPath, {
        stallThresholdMs: 120,
        shutdownTimeoutMs: 5_000,
        pollIntervalMs: 40,
      });
      try {
        wd.start();
        wd.setPendingRpcs([
          { id: 42, method: 'browser_profile', startedAtMs: Date.now(), tabId: 'tab-2', viewport: 'portrait' },
        ]);
        // Pause main-thread heartbeats briefly to simulate a >120ms main-thread freeze
        const rawWd = wd as unknown as { beatTimer: ReturnType<typeof setInterval> | null; beat(): void };
        if (rawWd.beatTimer) {
          clearInterval(rawWd.beatTimer);
          rawWd.beatTimer = null;
        }
        const stallDeadline = Date.now() + 1_500;
        while (Date.now() < stallDeadline) {
          if (
            wd.getSnapshot().stallCount >= 1 &&
            wdLog.tailLines(20).join('\n').includes('watchdog.main_thread_stall')
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(wd.getSnapshot().stallCount).toBeGreaterThanOrEqual(1);
        rawWd.beat();
        const wdLines = wdLog.tailLines(20).join('\n');
        expect(wdLines).toContain('watchdog.main_thread_stall');
        expect(wdLines).toContain('browser_profile');
      } finally {
        wd.stop();
      }

      // CpuProfilerManager size-cap streaming truncation + navigation re-arm
      const profilesDir = path.join(tmpDir, 'profiles');
      const bigProfile = {
        startTime: 0,
        endTime: 100_000,
        nodes: [
          { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
          { id: 2, callFrame: { functionName: 'heavyLoop', url: 'http://127.0.0.1/a.js', lineNumber: 1 }, children: [] },
        ],
        samples: Array.from({ length: 5000 }, () => 2),
        timeDeltas: Array.from({ length: 5000 }, () => 20),
      };
      const capped = writeSafeCpuProfileFile(profilesDir, 'tab-cap', 'portrait', bigProfile, 99_000, 2048);
      expect(capped.truncated).toBe(true);
      expect(capped.bytes).toBeLessThanOrEqual(2200);
      const parsedCapped = JSON.parse(fs.readFileSync(capped.profilePath, 'utf8')) as { samples: number[] };
      expect(parsedCapped.samples.length).toBeGreaterThan(0);
      expect(parsedCapped.samples.length).toBeLessThan(5000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
