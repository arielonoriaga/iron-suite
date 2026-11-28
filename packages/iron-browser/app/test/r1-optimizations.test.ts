import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

let nextWcId = 100;
let mockHostScaleFactor = 1;
const lifecycleEvents: string[] = [];
const createdViews: FakeWebContentsView[] = [];
let lastMenuTemplate: Array<{ label?: string; click?: () => void }> = [];

class FakeDebugger extends EventEmitter {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  commandHandler?: (method: string, params?: Record<string, unknown>) => unknown;

  isAttached(): boolean {
    return this.attached;
  }

  attach(_version?: string): void {
    this.attachCalls += 1;
    this.attached = true;
  }

  detach(): void {
    this.detachCalls += 1;
    this.attached = false;
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    if (this.commandHandler) {
      return await this.commandHandler(method, params);
    }
    if (method === 'Performance.getMetrics') {
      return {
        metrics: [
          { name: 'JSHeapUsedSize', value: 10 * 1024 * 1024 },
          { name: 'Nodes', value: 120 },
          { name: 'LayoutCount', value: 4 },
          { name: 'RecalcStyleCount', value: 5 },
        ],
      };
    }
    return {};
  }
}

class FakeSession {
  clearCacheCalls = 0;
  clearStorageCalls = 0;
  clearCacheHandler?: () => Promise<void>;

  constructor(public readonly name: string) {}

  async clearCache(): Promise<void> {
    this.clearCacheCalls += 1;
    if (this.clearCacheHandler) {
      await this.clearCacheHandler();
    }
  }

  async clearStorageData(): Promise<void> {
    this.clearStorageCalls += 1;
  }
}

const defaultSession = new FakeSession('default');
const partitionSessions = new Map<string, FakeSession>();

class FakeWebContents extends EventEmitter {
  readonly id = nextWcId++;
  readonly debugger = new FakeDebugger();
  session: FakeSession;
  destroyed = false;
  loading = false;
  audible = false;
  audioMuted = false;
  zoomFactor = 1;
  currentUrl = 'about:blank';
  devtoolsOpened = false;
  suppressOpenDevTools = false;
  reloadCalls = 0;
  reloadIgnoringCacheCalls = 0;
  loadUrlCalls: string[] = [];
  inspectCalls: Array<{ x: number; y: number }> = [];
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  evalResult: unknown = 'ok';
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
  };

  constructor(partition?: string) {
    super();
    if (partition) {
      let part = partitionSessions.get(partition);
      if (!part) {
        part = new FakeSession(partition);
        partitionSessions.set(partition, part);
      }
      this.session = part;
    } else {
      this.session = defaultSession;
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    return this.loading;
  }

  isCurrentlyAudible(): boolean {
    return this.audible;
  }

  getURL(): string {
    return this.currentUrl;
  }

  getOSProcessId(): number {
    return 1000 + this.id;
  }

  setZoomFactor(factor: number): void {
    this.zoomFactor = factor;
  }

  getZoomFactor(): number {
    return this.zoomFactor;
  }

  setBackgroundThrottling(_allowed: boolean): void {}

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }

  async loadURL(url: string): Promise<void> {
    this.currentUrl = url;
    this.loadUrlCalls.push(url);
  }

  reload(): void {
    this.reloadCalls += 1;
  }

  reloadIgnoringCache(): void {
    this.reloadIgnoringCacheCalls += 1;
  }

  setDevToolsWebContents(_wc: FakeWebContents): void {}

  openDevTools(_opts?: unknown): void {
    if (!this.suppressOpenDevTools) {
      this.devtoolsOpened = true;
    }
    lifecycleEvents.push(`openDevTools:${this.id}`);
  }

  closeDevTools(): void {
    this.devtoolsOpened = false;
    lifecycleEvents.push(`closeDevTools:${this.id}`);
  }

  isDevToolsOpened(): boolean {
    return this.devtoolsOpened;
  }

  inspectElement(x: number, y: number): void {
    this.inspectCalls.push({ x, y });
  }

  async executeJavaScript(_expr: string): Promise<unknown> {
    return this.evalResult;
  }

  async capturePage() {
    return {
      toPNG: () => Buffer.from('png'),
      getSize: () => ({ width: 390, height: 844 }),
    };
  }

  send(_channel: string, ..._args: unknown[]): void {}

  close(): void {
    this.destroyed = true;
    lifecycleEvents.push(`closeWc:${this.id}`);
    this.emit('destroyed');
  }
}

class FakeWebContentsView {
  readonly webContents: FakeWebContents;
  readonly isDevToolsCandidate: boolean;
  visible = false;
  bounds = { x: 0, y: 0, width: 400, height: 600 };

  constructor(opts?: { webPreferences?: { preload?: string; partition?: string } }) {
    this.webContents = new FakeWebContents(opts?.webPreferences?.partition);
    this.isDevToolsCandidate = !opts?.webPreferences?.preload;
    createdViews.push(this);
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    this.bounds = b;
  }

  getBounds() {
    return this.bounds;
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly childViews: FakeWebContentsView[] = [];
  readonly sentMessages: Array<{ channel: string; payload: unknown }> = [];
  readonly contentView = {
    addChildView: (view: FakeWebContentsView) => {
      this.childViews.push(view);
    },
    removeChildView: (view: FakeWebContentsView) => {
      const idx = this.childViews.indexOf(view);
      if (idx !== -1) this.childViews.splice(idx, 1);
    },
  };
  destroyed = false;

  constructor() {
    super();
    this.webContents.send = (channel: string, payload: unknown) => {
      this.sentMessages.push({ channel, payload });
    };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getContentSize(): [number, number] {
    return [1480, 920];
  }

  getBounds() {
    return { x: 0, y: 0, width: 1480, height: 920 };
  }

  isMaximized(): boolean {
    return false;
  }

  getNormalBounds() {
    return this.getBounds();
  }

  async loadFile(): Promise<void> {}
}

class FakeIpcMain extends EventEmitter {
  handle(_channel: string, _fn: (...args: unknown[]) => unknown): void {}
}

const fakeIpcMain = new FakeIpcMain();
fakeIpcMain.setMaxListeners(50);

mock.module('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/tmp/iron-browser-test',
    setPath: () => {},
    getAppMetrics: () => [],
    commandLine: { appendSwitch: () => {} },
    whenReady: () => new Promise(() => {}),
    on: () => {},
    quit: () => {},
    exit: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  ipcMain: fakeIpcMain,
  clipboard: {
    writeText: () => {},
  },
  Menu: {
    buildFromTemplate: (template: Array<{ label?: string; click?: () => void }>) => {
      lastMenuTemplate = template;
      return { popup: () => {} };
    },
  },
  screen: {
    getDisplayMatching: () => ({
      scaleFactor: mockHostScaleFactor,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [],
  },
  session: {
    defaultSession,
    fromPartition: (name: string) => {
      let part = partitionSessions.get(name);
      if (!part) {
        part = new FakeSession(name);
        partitionSessions.set(name, part);
      }
      return part;
    },
  },
}));

const { DebuggerCoordinator } = await import('../src/main/debugger-coordinator');
const { TelemetryService, ACTIVE_POLL_INTERVAL_MS, BLUR_POLL_INTERVAL_MS } = await import(
  '../src/main/telemetry'
);
const { TabManager, computeEffectiveDpr, sanitizeMenuLabel } = await import(
  '../src/main/tab-manager'
);
const { dispatchGlobalShortcut } = await import('../src/main/index');
const { MAX_PERSISTED_TABS, sanitizePersistedSession } = await import(
  '../src/shared/session-store'
);

beforeEach(() => {
  mockHostScaleFactor = 1;
  lifecycleEvents.length = 0;
  createdViews.length = 0;
  lastMenuTemplate = [];
  defaultSession.clearCacheCalls = 0;
  defaultSession.clearCacheHandler = undefined;
  partitionSessions.clear();
});

describe('R1 Eco DPR cap', () => {
  test('computeEffectiveDpr clamps to [1, presetDpr] in Eco mode and preserves presetDpr in HiDPI mode', () => {
    expect(computeEffectiveDpr(3, 0.5, 1, true)).toBe(1);
    expect(computeEffectiveDpr(3, 0.7, 2, true)).toBeCloseTo(1.4, 5);
    expect(computeEffectiveDpr(2, 1.0, 2, true)).toBe(2);
    expect(computeEffectiveDpr(3, 0.5, 1, false)).toBe(3);
  });

  test('TabManager enables ecoMode by default and toggleEcoMode updates Emulation DPR', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const initial = mgr.createTab({ url: 'https://example.com', mode: 'dual' });
      expect(initial.ecoMode).toBe(true);

      const portraitWc = mgr.getViewportWebContents(initial.activeTabId!, 'portrait') as unknown as FakeWebContents;
      await Promise.resolve();
      await Promise.resolve();

      portraitWc.debugger.commands.length = 0;
      const toggled = mgr.toggleEcoMode();
      expect(toggled.ecoMode).toBe(false);
      await new Promise((r) => setTimeout(r, 10));

      const overrideCmd = portraitWc.debugger.commands.find(
        (c) => c.method === 'Emulation.setDeviceMetricsOverride',
      );
      expect(overrideCmd?.params?.deviceScaleFactor).toBe(3);
    } finally {
      mgr.dispose();
    }
  });
});

describe('DebuggerCoordinator', () => {
  test('serializes ensureAttached, installs single listeners, isolates errors, and cleans up on destroy', async () => {
    const coord = new DebuggerCoordinator();
    const wc = new FakeWebContents();

    const [ok1, ok2] = await Promise.all([
      coord.ensureAttached(wc),
      coord.ensureAttached(wc),
    ]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(wc.debugger.attachCalls).toBe(1);
    expect(wc.debugger.listenerCount('detach')).toBe(1);
    expect(wc.debugger.listenerCount('message')).toBe(1);

    const msgsA: string[] = [];
    const msgsB: string[] = [];
    const detaches: string[] = [];
    let reattachedB = 0;
    let destroyedA = 0;

    const unsubA = coord.registerParticipant(wc, 'a', {
      onMessage: (m) => {
        msgsA.push(m);
        throw new Error('boom A');
      },
      onDetach: (r) => {
        detaches.push(`a:${r}`);
        throw new Error('detach boom');
      },
      onDestroyed: () => {
        destroyedA += 1;
      },
    });
    coord.registerParticipant(wc, 'b', {
      onMessage: (m) => msgsB.push(m),
      onDetach: (r) => detaches.push(`b:${r}`),
      onReattach: async () => {
        reattachedB += 1;
      },
    });

    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' });
    expect(msgsA).toEqual(['Runtime.consoleAPICalled']);
    expect(msgsB).toEqual(['Runtime.consoleAPICalled']);

    wc.debugger.attached = false;
    wc.debugger.emit('detach', {}, 'target_closed');
    expect(detaches).toEqual(['a:target_closed', 'b:target_closed']);

    const restored = await coord.reattachAndRestore(wc);
    expect(restored).toBe(true);
    expect(wc.debugger.isAttached()).toBe(true);
    expect(reattachedB).toBe(1);

    unsubA();
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {});
    expect(msgsA).toEqual(['Runtime.consoleAPICalled']);
    expect(msgsB).toEqual(['Runtime.consoleAPICalled', 'Network.requestWillBeSent']);

    const res = await coord.sendCommand<{ metrics: unknown[] }>(wc, 'Performance.getMetrics');
    expect(Array.isArray(res.metrics)).toBe(true);

    wc.close();
    expect(destroyedA).toBe(0); // unsubscribed A does not fire
    expect(wc.debugger.listenerCount('detach')).toBe(0);
    expect(wc.debugger.listenerCount('message')).toBe(0);
    await expect(coord.sendCommand(wc, 'Performance.getMetrics')).rejects.toThrow(/destroyed/);
  });
});

describe('TelemetryService R1', () => {
  test('uses 2000ms active / 5000ms blur / paused timers, Network.enable {1,1,1} caps, ring buffers, and raf TTL', async () => {
    let nowMs = 10_000;
    const coord = new DebuggerCoordinator();
    const wc = new FakeWebContents();
    const snapshots: unknown[] = [];

    const telemetry = new TelemetryService(
      () => ({ tabId: 'tab-1', portraitWc: null, landscapeWc: wc as never }),
      (id) => id === wc.id,
      (snap) => snapshots.push(snap),
      coord,
      { now: () => nowMs, rafTtlMs: 5000, activePollMs: 40, blurPollMs: 120 },
    );

    try {
      const defaultIntervals = new TelemetryService(
        () => null,
        () => false,
        () => {},
        coord,
      );
      expect(defaultIntervals.getPollIntervalMs()).toBe(ACTIVE_POLL_INTERVAL_MS);
      expect(ACTIVE_POLL_INTERVAL_MS).toBe(2000);
      defaultIntervals.setThrottled(true);
      expect(defaultIntervals.getPollIntervalMs()).toBe(BLUR_POLL_INTERVAL_MS);
      expect(BLUR_POLL_INTERVAL_MS).toBe(5000);
      defaultIntervals.dispose();

      telemetry.attachViewportCollectors('tab-1', 'landscape', wc as never);
      await new Promise((r) => setTimeout(r, 15));

      const netEnable = wc.debugger.commands.find((c) => c.method === 'Network.enable');
      expect(netEnable?.params).toEqual({
        maxTotalBufferSize: 1,
        maxResourceBufferSize: 1,
        maxPostDataSize: 1,
      });

      // Console & network ring buffers work without DevTools
      wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ value: 'bad thing' }],
      });
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'r1',
        request: { method: 'POST', url: 'https://example.com/api' },
        type: 'Fetch',
      });
      wc.debugger.emit('message', {}, 'Network.responseReceived', {
        requestId: 'r1',
        response: { status: 500 },
      });

      expect(telemetry.getConsoleEntries({ tabId: 'tab-1' }).length).toBe(1);
      expect(telemetry.getNetworkEntries({ tabId: 'tab-1', filter: 'failed' }).length).toBe(1);

      // Re-enables domains via DebuggerCoordinator on detach/reattach
      wc.debugger.commands.length = 0;
      wc.debugger.attached = false;
      wc.debugger.emit('detach', {}, 'devtools');
      await coord.reattachAndRestore(wc);
      expect(wc.debugger.commands.some((c) => c.method === 'Network.enable')).toBe(true);

      // Stale rafByWcId TTL expiry
      fakeIpcMain.emit('iron:raf-stats', { sender: { id: wc.id } }, {
        fps: 60,
        p95FrameMs: 16.5,
        jankCount: 1,
        recentFrameMs: [16],
      });
      const freshSnap = await telemetry.sampleOnce();
      expect(freshSnap.landscape?.fps).toBe(60);

      nowMs += 6000;
      const expiredSnap = await telemetry.sampleOnce();
      expect(expiredSnap.landscape?.fps).toBe(0);
      expect(expiredSnap.landscape?.p95FrameMs).toBe(0);

      // Polling intervals: active vs blur vs paused
      telemetry.start();
      await new Promise((r) => setTimeout(r, 60));
      const countAfterActive = snapshots.length;
      expect(countAfterActive).toBeGreaterThanOrEqual(2);

      telemetry.setPaused(true);
      const countAtPause = snapshots.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(snapshots.length).toBe(countAtPause);
    } finally {
      telemetry.dispose();
    }
  });
});

describe('TabManager R1 Lazy DevTools, Lazy Restored Tabs, autoSleep, blur/focus, R5 & F12', () => {
  test('lazy DevTools: dockOpen=false default, closeDevTools before destroy, fresh devtoolsView on switch, Inspect awaits devtools-opened', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false, undefined, {
      inspectTimeoutMs: 100,
    });
    try {
      expect(mgr.getShellState().dockOpen).toBe(false);
      expect(createdViews.filter((v) => v.isDevToolsCandidate).length).toBe(0);

      mgr.createTab({ url: 'https://example.com', mode: 'dual' });
      expect(createdViews.filter((v) => v.isDevToolsCandidate).length).toBe(0);

      mgr.setDockOpen(true);
      const firstDv = createdViews.filter((v) => v.isDevToolsCandidate);
      expect(firstDv.length).toBe(1);
      expect(firstDv[0]?.webContents.windowOpenHandler?.({ url: 'https://evil.com' })).toEqual({
        action: 'deny',
      });

      const portraitWc = mgr.getViewportWebContents(undefined, 'portrait') as unknown as FakeWebContents;
      const landscapeWc = mgr.getViewportWebContents(undefined, 'landscape') as unknown as FakeWebContents;

      lifecycleEvents.length = 0;
      mgr.setDevToolsTarget('landscape');

      const allDv = createdViews.filter((v) => v.isDevToolsCandidate);
      expect(allDv.length).toBe(2);
      expect(firstDv[0]?.webContents.isDestroyed()).toBe(true);
      expect(allDv[1]?.webContents.isDestroyed()).toBe(false);

      const closeDtIdx = lifecycleEvents.indexOf(`closeDevTools:${portraitWc.id}`);
      const closeDvIdx = lifecycleEvents.indexOf(`closeWc:${firstDv[0]!.webContents.id}`);
      const openNewIdx = lifecycleEvents.indexOf(`openDevTools:${landscapeWc.id}`);
      expect(closeDtIdx).toBeGreaterThanOrEqual(0);
      expect(closeDvIdx).toBeGreaterThan(closeDtIdx);
      expect(openNewIdx).toBeGreaterThan(closeDvIdx);

      // Inspect Element waits for devtools-opened instead of hardcoded timeout
      mgr.setDockOpen(false);
      portraitWc.emit('context-menu', {}, { x: 42, y: 84 });
      const inspectItem = lastMenuTemplate.find((i) => i.label?.startsWith('Inspect Element'));
      expect(inspectItem).toBeDefined();
      inspectItem!.click!();
      expect(portraitWc.inspectCalls.length).toBe(0);
      portraitWc.emit('devtools-opened');
      await new Promise((r) => setTimeout(r, 10));
      expect(portraitWc.inspectCalls).toEqual([{ x: 42, y: 84 }]);
    } finally {
      mgr.dispose();
    }
  });

  test('lazy inactive restored tabs stay metadata-only until selected or MCP-targeted, and opt-in autoSleep skips active/audible tabs', async () => {
    const win = new FakeBrowserWindow();
    let dirtyCount = 0;
    const mgr = new TabManager(
      win as never,
      '/app/mirror-preload.js',
      () => false,
      () => {
        dirtyCount += 1;
      },
      { autoSleepAfterMs: 1000 },
    );

    try {
      const saved = sanitizePersistedSession({
        version: 1,
        activeTabIndex: 1,
        ecoMode: true,
        autoSleep: false,
        tabs: [
          { url: 'https://tab-zero.example/', title: 'Tab Zero', mode: 'dual' },
          { url: 'https://tab-one.example/', title: 'Tab One', mode: 'dual' },
          { url: 'https://tab-two.example/', title: 'Tab Two', mode: 'single' },
        ],
        history: [{ url: 'https://tab-one.example/', title: 'Tab One', visitedAt: 100, visitCount: 1 }],
      })!;

      const restoredState = mgr.restoreSession(saved);
      expect(restoredState.tabs.length).toBe(3);
      expect(restoredState.autoSleep).toBe(false);
      // Only active tab (index 1, dual mode) spawned 2 views (landscape + portrait)
      expect(createdViews.length).toBe(2);

      const dormantTab0 = restoredState.tabs[0]!;
      const activeTab1 = restoredState.tabs[1]!;
      const dormantTab2 = restoredState.tabs[2]!;
      expect(mgr.getViewportWebContents(dormantTab0.id, 'landscape')).toBeNull();
      expect(mgr.getViewportWebContents(dormantTab2.id, 'landscape')).toBeNull();
      expect(mgr.getViewportWebContents(activeTab1.id, 'landscape')).not.toBeNull();

      // Safe dormant operations (no view spawn, no throw)
      mgr.toggleDualMode(dormantTab2.id);
      mgr.setSessionMode('isolated', dormantTab0.id);
      expect(mgr.findByWebContentsId(999999)).toBeNull();
      expect(mgr.exportPersistedSession().tabs.length).toBe(3);

      // R5: loading events do not mark session dirty
      const dirtyBeforeLoading = dirtyCount;
      const activeWc = mgr.getViewportWebContents(activeTab1.id, 'landscape') as unknown as FakeWebContents;
      activeWc.emit('did-start-loading');
      activeWc.emit('did-stop-loading');
      expect(dirtyCount).toBe(dirtyBeforeLoading);

      // R5: skipNextRestoreHistoryCommit skips initial restore did-navigate redirect
      activeWc.currentUrl = 'https://tab-one.example/redirected';
      activeWc.emit('did-navigate', {}, 'https://tab-one.example/redirected');
      expect(mgr.getShellState().history.some((h) => h.url.includes('/redirected'))).toBe(false);

      // Subsequent navigation DOES record history, ignoring placeholder titles
      activeWc.currentUrl = 'https://tab-one.example/page2';
      activeWc.emit('did-navigate', {}, 'https://tab-one.example/page2');
      activeWc.emit('page-title-updated', {}, 'IronBrowser — Ready');
      expect(mgr.getShellState().history[0]?.url).toBe('https://tab-one.example/page2');
      expect(mgr.getShellState().history[0]?.title).not.toBe('IronBrowser — Ready');
      activeWc.emit('page-title-updated', {}, 'Real Page Two');
      expect(mgr.getShellState().history[0]?.title).toBe('Real Page Two');

      // Materialize dormant tab on selectTab
      mgr.selectTab(dormantTab0.id);
      const tab0Wc = mgr.getViewportWebContents(dormantTab0.id, 'landscape') as unknown as FakeWebContents;
      expect(tab0Wc).not.toBeNull();
      await new Promise((r) => setTimeout(r, 15));
      expect(tab0Wc.loadUrlCalls).toEqual(['https://tab-zero.example/']);

      // MCP evalJs on still-dormant tab2 (toggled to dual above) materializes both viewports and waits for did-finish-load
      const evalPromise = mgr.evalJs({ tabId: dormantTab2.id, expression: '1+1' });
      const tab2Wc = mgr.getViewportWebContents(dormantTab2.id, 'landscape') as unknown as FakeWebContents;
      const tab2PortraitWc = mgr.getViewportWebContents(dormantTab2.id, 'portrait') as unknown as FakeWebContents;
      expect(tab2Wc).not.toBeNull();
      expect(tab2PortraitWc).not.toBeNull();
      tab2Wc.emit('did-finish-load');
      tab2PortraitWc.emit('did-finish-load');
      const evalRes = await evalPromise;
      expect(evalRes.value).toBe('ok');

      // Opt-in autoSleep: OFF by default, skips active and audible tabs
      const farFuture = Date.now() + 60 * 60 * 1000;
      expect(mgr.sweepAutoSleep(farFuture, 1000)).toEqual([]);

      mgr.setAutoSleep(true);
      // Mark tab1 audible and tab2 silent idle
      const tab1Wc = mgr.getViewportWebContents(activeTab1.id, 'landscape') as unknown as FakeWebContents;
      tab1Wc.audible = true;

      const slept = mgr.sweepAutoSleep(farFuture, 1000);
      expect(slept).toEqual([dormantTab2.id]);
      expect(mgr.getTab(dormantTab2.id)?.sleeping).toBe(true);
      expect(mgr.getViewportWebContents(dormantTab2.id, 'landscape')).toBeNull();
      expect(mgr.getTab(activeTab1.id)?.sleeping).toBe(false);
      await expect(mgr.evalJs({ tabId: dormantTab2.id, expression: '1' })).rejects.toThrow(/sleeping/);

      // Window blur/focus throttling vs minimize/restore pause
      win.emit('blur');
      expect(mgr.telemetry.isThrottled()).toBe(true);
      expect(mgr.telemetry.isPaused()).toBe(false);
      win.emit('focus');
      expect(mgr.telemetry.isThrottled()).toBe(false);
      win.emit('minimize');
      expect(mgr.telemetry.isPaused()).toBe(true);
      win.emit('restore');
      expect(mgr.telemetry.isPaused()).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  test('R5 exportPersistedSession caps at MAX_PERSISTED_TABS preserving active tab, and openHistoryMenu escapes & and control chars', () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      for (let i = 0; i < MAX_PERSISTED_TABS + 3; i += 1) {
        mgr.createTab({
          url: `https://example.com/${i}`,
          title: `ATitle ${'Z'.repeat(150)}`,
          mode: 'single',
          lazy: true,
        });
      }
      const lastTab = mgr.getActiveTab()!;
      const exported = mgr.exportPersistedSession();
      expect(exported.tabs.length).toBe(MAX_PERSISTED_TABS);
      expect(exported.tabs[exported.activeTabIndex]?.url).toBe(lastTab.url);
      expect(exported.tabs[0]?.title.length).toBeLessThanOrEqual(120);

      mgr.navigate('https://example.com/a&b');
      const active = mgr.getActiveTab()!;
      active.title = 'Foo & Bar\u0007\nBaz';
      const wc = mgr.getViewportWebContents(active.id, 'landscape') as unknown as FakeWebContents;
      wc.emit('page-title-updated', {}, 'Foo & Bar\u0007\nBaz');

      mgr.openHistoryMenu();
      const historyItem = lastMenuTemplate.find((item) => item.label?.includes('Foo && Bar'));
      expect(historyItem).toBeDefined();
      expect(historyItem?.label).not.toContain('\u0007');
      expect(sanitizeMenuLabel('A & B\u0000C', 20)).toBe('A && BC');
    } finally {
      mgr.dispose();
    }
  });

  test('F12 cache-clearing reload() and reload shortcuts (Ctrl+R, Cmd+R, F5, Ctrl+Shift+R, Cmd+Shift+R)', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      mgr.createTab({ url: 'https://example.com', mode: 'dual', session: 'isolated' });
      const active = mgr.getActiveTab()!;
      const landscapeWc = mgr.getViewportWebContents(active.id, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(active.id, 'portrait') as unknown as FakeWebContents;

      const hookedTabs: string[] = [];
      mgr.registerBeforeReloadHook((tabId) => hookedTabs.push(tabId));

      await mgr.reload();
      expect(hookedTabs).toEqual([active.id]);
      expect(defaultSession.clearCacheCalls).toBe(1);
      expect(portraitWc.session.clearCacheCalls).toBe(1);
      expect(landscapeWc.reloadIgnoringCacheCalls).toBe(1);
      expect(portraitWc.reloadIgnoringCacheCalls).toBe(1);
      expect(landscapeWc.reloadCalls).toBe(0);
      expect(portraitWc.reloadCalls).toBe(0);

      // Context menu Reload calls cache-clearing reload()
      landscapeWc.emit('context-menu', {}, { x: 10, y: 10 });
      const reloadMenuItem = lastMenuTemplate.find((i) => i.label === 'Reload');
      expect(reloadMenuItem).toBeDefined();
      reloadMenuItem!.click!();
      await new Promise((r) => setTimeout(r, 10));
      expect(landscapeWc.reloadIgnoringCacheCalls).toBe(2);

      // Shortcut dispatcher
      let reloadCalls = 0;
      const fakeMgr = {
        getShellState: () => mgr.getShellState(),
        setRailCollapsed: () => mgr.getShellState(),
        toggleDualMode: () => mgr.getShellState(),
        toggleMirror: () => mgr.getShellState(),
        createTab: () => mgr.getShellState(),
        reopenClosedTab: () => mgr.getShellState(),
        getActiveTab: () => mgr.getActiveTab(),
        closeTab: () => mgr.getShellState(),
        setDockOpen: () => mgr.getShellState(),
        reload: async () => {
          reloadCalls += 1;
        },
      };

      const mkInput = (overrides: Partial<Electron.Input>): Electron.Input => ({
        type: 'keyDown',
        key: '',
        code: '',
        isAutoRepeat: false,
        isComposing: false,
        shift: false,
        control: false,
        alt: false,
        meta: false,
        location: 0,
        modifiers: [],
        ...overrides,
      });

      expect(dispatchGlobalShortcut(mkInput({ control: true, key: 'r' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(true);
      expect(dispatchGlobalShortcut(mkInput({ control: true, shift: true, key: 'R' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(true);
      expect(dispatchGlobalShortcut(mkInput({ meta: true, key: 'r' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(true);
      expect(dispatchGlobalShortcut(mkInput({ meta: true, shift: true, key: 'r' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(true);
      expect(dispatchGlobalShortcut(mkInput({ key: 'F5' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(true);
      expect(reloadCalls).toBe(5);

      expect(dispatchGlobalShortcut(mkInput({ alt: true, control: true, key: 'r' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(false);
      expect(dispatchGlobalShortcut(mkInput({ alt: true, key: 'F5' }), { tabManager: fakeMgr, mainWindow: win as never })).toBe(false);
      expect(reloadCalls).toBe(5);
    } finally {
      mgr.dispose();
    }
  });
});

describe('M1 Iteration 2 Challenger & Reviewer Regression Tests', () => {
  test('Bug 1: TabManager.reload() does not resurrect closed or disposed tabs after await clearCache()', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const s1 = mgr.createTab({ url: 'https://first.example/', mode: 'dual' });
      const tab1Id = s1.activeTabId!;
      const s2 = mgr.createTab({ url: 'https://second.example/', mode: 'dual', activate: true });
      const tab2Id = s2.activeTabId!;
      expect(win.childViews.length).toBe(4);

      let resolveClearCache!: () => void;
      defaultSession.clearCacheHandler = () =>
        new Promise<void>((resolve) => {
          resolveClearCache = resolve;
        });

      const reloadPromise = mgr.reload();
      // While clearCache() is pending, close tab2
      mgr.closeTab(tab2Id);
      expect(win.childViews.length).toBe(2);

      resolveClearCache();
      await reloadPromise;
      // tab2 must NOT be re-materialized
      expect(mgr.getTab(tab2Id)).toBeUndefined();
      expect(win.childViews.length).toBe(2);

      // Also test dispose() during clearCache()
      defaultSession.clearCacheHandler = () =>
        new Promise<void>((resolve) => {
          resolveClearCache = resolve;
        });
      const reloadPromise2 = mgr.reload();
      mgr.dispose();
      expect(win.childViews.length).toBe(0);
      resolveClearCache();
      await reloadPromise2;
      expect(mgr.getTab(tab1Id)).toBeUndefined();
      expect(win.childViews.length).toBe(0);
    } finally {
      defaultSession.clearCacheHandler = undefined;
      mgr.dispose();
    }
  });

  test('Bug 2: ensureTabMaterializedAndLoaded() coalesces concurrent callers and waits for both landscape and portrait views', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const saved = sanitizePersistedSession({
        version: 1,
        activeTabIndex: 1,
        tabs: [
          { url: 'https://dormant-dual.example/', title: 'Dormant Dual', mode: 'dual' },
          { url: 'https://active.example/', title: 'Active', mode: 'single' },
        ],
      })!;
      const state = mgr.restoreSession(saved);
      const dormantId = state.tabs[0]!.id;

      let eval1Done = false;
      let interact2Done = false;
      const p1 = mgr.evalJs({ tabId: dormantId, expression: '1+1' }).then((res) => {
        eval1Done = true;
        return res;
      });
      const p2 = mgr.interact({ tabId: dormantId, action: 'key', key: 'Enter' }).then((res) => {
        interact2Done = true;
        return res;
      });

      const landscapeWc = mgr.getViewportWebContents(dormantId, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(dormantId, 'portrait') as unknown as FakeWebContents;
      expect(landscapeWc).not.toBeNull();
      expect(portraitWc).not.toBeNull();

      await new Promise((r) => setTimeout(r, 10));
      expect(eval1Done).toBe(false);
      expect(interact2Done).toBe(false);

      // Only landscape finished loading -> both concurrent callers MUST still wait for portrait in dual mode
      landscapeWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 10));
      expect(eval1Done).toBe(false);
      expect(interact2Done).toBe(false);

      // Now portrait finishes -> both resolve
      portraitWc.emit('did-finish-load');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.value).toBe('ok');
      expect(r2.tabId).toBe(dormantId);

      // Also verify sleepTab mid-load settles cleanly without hanging until timeoutMs
      const saved2 = sanitizePersistedSession({
        version: 1,
        activeTabIndex: 1,
        tabs: [
          { url: 'https://dormant-sleep.example/', title: 'Sleepy', mode: 'dual' },
          { url: 'https://active2.example/', title: 'Active 2', mode: 'single' },
        ],
      })!;
      const win2 = new FakeBrowserWindow();
      const mgr2 = new TabManager(win2 as never, '/app/mirror-preload.js', () => false);
      try {
        const st2 = mgr2.restoreSession(saved2);
        const targetId = st2.tabs[0]!.id;
        const pSleep = mgr2.evalJs({ tabId: targetId, expression: '1' });
        mgr2.sleepTab(targetId);
        await expect(pSleep).rejects.toThrow(/sleeping/);
      } finally {
        mgr2.dispose();
      }
    } finally {
      mgr.dispose();
    }
  });

  test('Bug 5: DebuggerCoordinator.reattachAndRestore() preserves needsRestore when detach fires mid-onReattach', async () => {
    const coord = new DebuggerCoordinator();
    const wc = new FakeWebContents();
    let reattachCount = 0;

    coord.registerParticipant(wc, 'participant', {
      onReattach: async () => {
        reattachCount += 1;
        if (reattachCount === 1) {
          await Promise.resolve();
          wc.debugger.attached = false;
          wc.debugger.emit('detach', {}, 'crashed_mid_restore');
        }
      },
    });

    await coord.ensureAttached(wc);
    wc.debugger.attached = false;
    wc.debugger.emit('detach', {}, 'initial_detach');

    const firstOk = await coord.reattachAndRestore(wc);
    expect(firstOk).toBe(false);
    expect(reattachCount).toBe(1);

    // Even if another caller re-attaches via ensureAttached(), needsRestore must still be true
    expect(await coord.ensureAttached(wc)).toBe(true);
    const secondOk = await coord.reattachAndRestore(wc);
    expect(secondOk).toBe(true);
    expect(reattachCount).toBe(2);
  });

  test('Bug 6: TabManager.toggleDualMode() coerces audioSource portrait -> landscape when switching dual -> single', () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      mgr.createTab({ url: 'https://example.com', mode: 'dual' });
      const active = mgr.getActiveTab()!;
      const landscapeWc = mgr.getViewportWebContents(active.id, 'landscape') as unknown as FakeWebContents;

      const afterAudio = mgr.toggleAudio('portrait');
      expect(afterAudio.tabs[0]?.audioSource).toBe('portrait');
      expect(landscapeWc.audioMuted).toBe(true);

      const afterSingle = mgr.toggleDualMode(active.id);
      expect(afterSingle.tabs[0]?.mode).toBe('single');
      expect(afterSingle.tabs[0]?.audioSource).toBe('landscape');
      expect(landscapeWc.audioMuted).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  test('Minor 7: TabManager.inspectElementAt() skips wc.inspectElement() if devtools-opened times out while closed', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false, undefined, {
      inspectTimeoutMs: 30,
    });
    try {
      mgr.createTab({ url: 'https://example.com', mode: 'dual' });
      const portraitWc = mgr.getViewportWebContents(undefined, 'portrait') as unknown as FakeWebContents;
      portraitWc.suppressOpenDevTools = true;

      portraitWc.emit('context-menu', {}, { x: 15, y: 25 });
      const inspectItem = lastMenuTemplate.find((i) => i.label?.startsWith('Inspect Element'));
      expect(inspectItem).toBeDefined();
      inspectItem!.click!();

      await new Promise((r) => setTimeout(r, 60));
      expect(portraitWc.isDevToolsOpened()).toBe(false);
      expect(portraitWc.inspectCalls).toEqual([]);
    } finally {
      mgr.dispose();
    }
  });

  test('Minor 8: TelemetryService.setPaused() before start() updates paused state without sampling or emitting snapshots', async () => {
    const coord = new DebuggerCoordinator();
    const snapshots: unknown[] = [];
    let sampleTargetCalls = 0;
    const telemetry = new TelemetryService(
      () => {
        sampleTargetCalls += 1;
        return null;
      },
      () => false,
      (snap) => snapshots.push(snap),
      coord,
      { activePollMs: 20, blurPollMs: 50 },
    );

    try {
      telemetry.setPaused(true);
      expect(telemetry.isPaused()).toBe(true);
      expect(telemetry.getLatestSnapshot().paused).toBe(true);
      expect(snapshots.length).toBe(0);

      telemetry.setPaused(false);
      expect(telemetry.isPaused()).toBe(false);
      expect(telemetry.getLatestSnapshot().paused).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(sampleTargetCalls).toBe(0);
      expect(snapshots.length).toBe(0);
    } finally {
      telemetry.dispose();
    }
  });
});

describe('M1 Iteration 3 Challenger 2 Regression Tests', () => {
  test('Finding 1: TabManager.reload() stays aborted if sleepTab() runs mid-clearCache()', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const s1 = mgr.createTab({ url: 'https://first.example/', mode: 'dual' });
      const tab1Id = s1.activeTabId!;
      const s2 = mgr.createTab({ url: 'https://second.example/', mode: 'dual', activate: true });
      const tab2Id = s2.activeTabId!;
      expect(win.childViews.length).toBe(4);

      let resolveClearCache!: () => void;
      defaultSession.clearCacheHandler = () =>
        new Promise<void>((resolve) => {
          resolveClearCache = resolve;
        });

      const reloadPromise = mgr.reload();
      // Put active tab2 to sleep while clearCache() is pending
      mgr.sleepTab(tab2Id);
      expect(mgr.getTab(tab2Id)?.sleeping).toBe(true);
      expect(mgr.getActiveTab()?.id).toBe(tab1Id);
      expect(win.childViews.length).toBe(2);

      resolveClearCache();
      await reloadPromise;

      // tab2 must remain sleeping and MUST NOT spawn orphaned background views
      expect(mgr.getTab(tab2Id)?.sleeping).toBe(true);
      expect(mgr.getViewportWebContents(tab2Id, 'landscape')).toBeNull();
      expect(mgr.getViewportWebContents(tab2Id, 'portrait')).toBeNull();
      expect(win.childViews.length).toBe(2);
    } finally {
      defaultSession.clearCacheHandler = undefined;
      mgr.dispose();
    }
  });

  test('Finding 2a: ensureTabMaterializedAndLoaded() waits for portraitView when toggleDualMode switches single -> dual mid-load', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const saved = sanitizePersistedSession({
        version: 1,
        activeTabIndex: 1,
        tabs: [
          { url: 'https://dormant-single.example/', title: 'Dormant Single', mode: 'single' },
          { url: 'https://active.example/', title: 'Active', mode: 'single' },
        ],
      })!;
      const state = mgr.restoreSession(saved);
      const dormantId = state.tabs[0]!.id;

      let call1Done = false;
      let call2Done = false;
      const p1 = mgr
        .evalJs({ tabId: dormantId, viewport: 'landscape', expression: '1' })
        .then((res) => {
          call1Done = true;
          return res;
        });

      const landscapeWc = mgr.getViewportWebContents(
        dormantId,
        'landscape',
      ) as unknown as FakeWebContents;
      expect(landscapeWc).not.toBeNull();

      // Switch single -> dual while landscape is still loading
      mgr.toggleDualMode(dormantId);
      const portraitWc = mgr.getViewportWebContents(
        dormantId,
        'portrait',
      ) as unknown as FakeWebContents;
      expect(portraitWc).not.toBeNull();

      const p2 = mgr
        .evalJs({ tabId: dormantId, viewport: 'portrait', expression: '2' })
        .then((res) => {
          call2Done = true;
          return res;
        });

      landscapeWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 15));
      // Neither call may resolve before portraitWc finishes loading
      expect(call1Done).toBe(false);
      expect(call2Done).toBe(false);

      portraitWc.emit('did-finish-load');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.value).toBe('ok');
      expect(r2.value).toBe('ok');
    } finally {
      mgr.dispose();
    }
  });

  test('Finding 2b: selectTab(dormant) followed immediately by evalJs awaits did-finish-load, and closeTab mid-load rejects captureScreenshots/interact', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const saved = sanitizePersistedSession({
        version: 1,
        activeTabIndex: 1,
        tabs: [
          { url: 'https://dormant-select.example/', title: 'Dormant Select', mode: 'dual' },
          { url: 'https://active.example/', title: 'Active', mode: 'single' },
          { url: 'https://dormant-close.example/', title: 'Dormant Close', mode: 'dual' },
        ],
      })!;
      const state = mgr.restoreSession(saved);
      const selectId = state.tabs[0]!.id;
      const closeId = state.tabs[2]!.id;

      mgr.selectTab(selectId);
      const selLandscape = mgr.getViewportWebContents(
        selectId,
        'landscape',
      ) as unknown as FakeWebContents;
      const selPortrait = mgr.getViewportWebContents(
        selectId,
        'portrait',
      ) as unknown as FakeWebContents;

      let evalResolved = false;
      const evalPromise = mgr
        .evalJs({ tabId: selectId, viewport: 'portrait', expression: 'ready' })
        .then((res) => {
          evalResolved = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 15));
      expect(evalResolved).toBe(false);

      selLandscape.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 15));
      expect(evalResolved).toBe(false);

      selPortrait.emit('did-finish-load');
      const evalRes = await evalPromise;
      expect(evalRes.value).toBe('ok');

      // Also verify an external/renderer-initiated isLoading() === true transition is awaited
      selPortrait.loading = true;
      let navEvalResolved = false;
      const navEvalPromise = mgr
        .evalJs({ tabId: selectId, viewport: 'portrait', expression: 'after-nav' })
        .then((res) => {
          navEvalResolved = true;
          return res;
        });
      await new Promise((r) => setTimeout(r, 15));
      expect(navEvalResolved).toBe(false);
      selPortrait.loading = false;
      selPortrait.emit('did-finish-load');
      expect((await navEvalPromise).value).toBe('ok');

      // closeTab mid-load causes captureScreenshots and interact to reject cleanly
      const shotErr = mgr
        .captureScreenshots(closeId, 'both')
        .then(() => null, (err: unknown) => err as Error);
      const interactErr = mgr
        .interact({ tabId: closeId, action: 'key', key: 'Enter' })
        .then(() => null, (err: unknown) => err as Error);
      mgr.closeTab(closeId);
      const [sErr, iErr] = await Promise.all([shotErr, interactErr]);
      expect(sErr).toBeInstanceOf(Error);
      expect(sErr?.message).toMatch(/closed/);
      expect(iErr).toBeInstanceOf(Error);
      expect(iErr?.message).toMatch(/closed/);
    } finally {
      mgr.dispose();
    }
  });
});

describe('M1 Iteration 4 Challenger 3 Regression Tests', () => {
  test('Finding 1a: navigate() superseding an in-flight load re-waits for the replacement load', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const state = mgr.createTab({ url: 'https://initial.example/', mode: 'dual' });
      const tabId = state.activeTabId!;
      const landscapeWc = mgr.getViewportWebContents(tabId, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(tabId, 'portrait') as unknown as FakeWebContents;
      landscapeWc.evalResult = 'from-initial';

      let evalDone = false;
      const evalPromise = mgr
        .evalJs({ tabId, viewport: 'landscape', expression: 'window.location.href' })
        .then((res) => {
          evalDone = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 10));
      expect(evalDone).toBe(false);

      // Supersede both in-flight loads via navigate()
      mgr.navigate('https://superseded.example/', tabId);
      landscapeWc.evalResult = 'from-superseded';

      await new Promise((r) => setTimeout(r, 15));
      expect(evalDone).toBe(false);

      landscapeWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 10));
      expect(evalDone).toBe(false);

      portraitWc.emit('did-finish-load');
      const res = await evalPromise;
      expect(res.value).toBe('from-superseded');
    } finally {
      mgr.dispose();
    }
  });

  test('Finding 1b: handleNavSync() superseding an in-flight load re-waits cleanly', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const state = mgr.createTab({ url: 'https://sync-initial.example/', mode: 'dual', mirror: true });
      const tabId = state.activeTabId!;
      const landscapeWc = mgr.getViewportWebContents(tabId, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(tabId, 'portrait') as unknown as FakeWebContents;

      landscapeWc.emit('did-finish-load');
      portraitWc.evalResult = 'before-sync';

      let evalDone = false;
      const evalPromise = mgr
        .evalJs({ tabId, viewport: 'portrait', expression: 'window.location.href' })
        .then((res) => {
          evalDone = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 10));
      expect(evalDone).toBe(false);

      // Simulate a paired landscape redirect mirroring onto the still-loading portrait viewport
      mgr.getTab(tabId)!.navSuppressUntil.landscape = 0;
      landscapeWc.emit('did-navigate', {}, 'https://sync-redirected.example/');
      portraitWc.evalResult = 'after-sync-redirect';

      await new Promise((r) => setTimeout(r, 15));
      expect(evalDone).toBe(false);
      expect(portraitWc.loadUrlCalls).toContain('https://sync-redirected.example/');

      portraitWc.emit('did-finish-load');
      const res = await evalPromise;
      expect(res.value).toBe('after-sync-redirect');
    } finally {
      mgr.dispose();
    }
  });

  test('Finding 2: subframe did-fail-load (isMainFrame=false) does not abort main-frame load wait', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const state = mgr.createTab({ url: 'https://main-frame.example/', mode: 'single' });
      const tabId = state.activeTabId!;
      const landscapeWc = mgr.getViewportWebContents(tabId, 'landscape') as unknown as FakeWebContents;
      landscapeWc.evalResult = 'main-loaded';

      let evalDone = false;
      const evalPromise = mgr
        .evalJs({ tabId, viewport: 'landscape', expression: 'document.title' })
        .then((res) => {
          evalDone = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 10));
      expect(evalDone).toBe(false);

      // Subframe failure (-105) must NOT settle the main-frame load waiter
      landscapeWc.emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'https://broken-iframe.example/',
        false,
      );

      await new Promise((r) => setTimeout(r, 15));
      expect(evalDone).toBe(false);

      landscapeWc.emit('did-finish-load');
      const res = await evalPromise;
      expect(res.value).toBe('main-loaded');

      // Verify a real main-frame failure (isMainFrame=true) still rejects
      mgr.navigate('https://broken-main.example/', tabId);
      const failPromise = mgr
        .evalJs({ tabId, viewport: 'landscape', expression: 'document.title' })
        .then(() => null, (err: unknown) => err as Error);
      landscapeWc.emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'https://broken-main.example/',
        true,
      );
      const failErr = await failPromise;
      expect(failErr).toBeInstanceOf(Error);
      expect(failErr?.message).toMatch(/failed to finish loading/);
    } finally {
      mgr.dispose();
    }
  });

  test('Finding 3: fire-and-forget reload() while clearCache() is pending blocks evalJs() until reload finishes', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const state = mgr.createTab({ url: 'https://reload-race.example/', mode: 'dual' });
      const tabId = state.activeTabId!;
      const landscapeWc = mgr.getViewportWebContents(tabId, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(tabId, 'portrait') as unknown as FakeWebContents;

      landscapeWc.emit('did-finish-load');
      portraitWc.emit('did-finish-load');
      landscapeWc.evalResult = 'OLD_BEFORE_RELOAD';

      let resolveClearCache!: () => void;
      defaultSession.clearCacheHandler = () =>
        new Promise<void>((resolve) => {
          resolveClearCache = resolve;
        });

      // Fire-and-forget reload followed immediately by evalJs
      void mgr.reload();
      let evalDone = false;
      const evalPromise = mgr
        .evalJs({ tabId, viewport: 'landscape', expression: 'window.__marker' })
        .then((res) => {
          evalDone = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 15));
      expect(evalDone).toBe(false);
      expect(landscapeWc.reloadIgnoringCacheCalls).toBe(0);
      expect(portraitWc.reloadIgnoringCacheCalls).toBe(0);

      // Cache clear completes -> reloadIgnoringCache fires on both viewports, still awaiting did-finish-load
      landscapeWc.evalResult = 'NEW_AFTER_RELOAD';
      resolveClearCache();
      await new Promise((r) => setTimeout(r, 15));
      expect(landscapeWc.reloadIgnoringCacheCalls).toBe(1);
      expect(portraitWc.reloadIgnoringCacheCalls).toBe(1);
      expect(evalDone).toBe(false);

      landscapeWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 10));
      expect(evalDone).toBe(false);

      portraitWc.emit('did-finish-load');
      const res = await evalPromise;
      expect(res.value).toBe('NEW_AFTER_RELOAD');
    } finally {
      defaultSession.clearCacheHandler = undefined;
      mgr.dispose();
    }
  });

  test('F-01, F-02 & F-07: captureScreenshots bounds wedged exact_size finally, rejects 0-pane total failure, and stopPerfTrace requires active trace', async () => {
    const win = new FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const state = mgr.createTab({ url: 'https://exact-stall.example/', mode: 'dual' });
      const tabId = state.activeTabId!;
      const landscapeWc = mgr.getViewportWebContents(tabId, 'landscape') as unknown as FakeWebContents;
      const portraitWc = mgr.getViewportWebContents(tabId, 'portrait') as unknown as FakeWebContents;
      landscapeWc.emit('did-finish-load');
      portraitWc.emit('did-finish-load');

      // F-07: stopPerfTrace without startPerfTrace throws clean error
      await expect(mgr.stopPerfTrace({ tabId })).rejects.toThrow(/no active performance trace/);

      // F-01: Portrait succeeds initial Emulation.setDeviceMetricsOverride, then wedges on all subsequent CDP/DOM/capture calls
      let portraitOverrideCalls = 0;
      portraitWc.debugger.sendCommand = async (method: string) => {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          portraitOverrideCalls += 1;
          if (portraitOverrideCalls === 1) return {};
          return new Promise(() => {}); // Hang restore in finally!
        }
        return new Promise(() => {}); // Hang Page.captureScreenshot & setTouchEmulationEnabled!
      };
      portraitWc.capturePage = () => new Promise(() => {}) as never;

      // Landscape responds promptly to layoutAudit
      const origQueryDom = mgr.mirrorRelay.queryDom.bind(mgr.mirrorRelay);
      mgr.mirrorRelay.queryDom = async (wc, op, args, timeoutMs) => {
        if (wc.id === landscapeWc.id && op === 'layoutAudit') {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            dpr: 1,
            scrollWidth: 1280,
            scrollHeight: 720,
            horizontalOverflow: false,
            clippedElements: 0,
            clippedItems: [],
            canvasCount: 0,
          };
        }
        return origQueryDom(wc, op, args, timeoutMs);
      };

      const t0 = Date.now();
      const partialRes = await mgr.captureScreenshots(tabId, 'both', {
        exactSize: true,
        perPaneTimeoutMs: 180,
      });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2000);
      expect(partialRes.partial).toBe(true);
      expect((partialRes.captures as Record<string, unknown>).landscape).toBeDefined();
      expect((partialRes.captures as Record<string, unknown>).portrait).toBeUndefined();

      // F-02: Requesting ONLY the wedged portrait pane (0 captures) throws instead of resolving partial: true
      await expect(
        mgr.captureScreenshots(tabId, 'portrait', { perPaneTimeoutMs: 180 }),
      ).rejects.toThrow(/screenshot capture failed/);

      // Hidden-window rescue + F-08: if landscape capturePage initially throws
      // "Current display surface not available for capture", ForceRedraw + bounds nudge retries
      // capturePage cleanly and does NOT misreport exactSizeApplied when exactSize was false.
      const valid1x1PngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
      let landscapeCapCalls = 0;
      landscapeWc.capturePage = (() => {
        landscapeCapCalls += 1;
        if (landscapeCapCalls === 1) {
          return Promise.reject(new Error('Current display surface not available for capture'));
        }
        return Promise.resolve({
          toPNG: () => Buffer.from(valid1x1PngBase64, 'base64'),
          getSize: () => ({ width: 1, height: 1 }),
        });
      }) as never;
      const rescued = await mgr.captureScreenshots(tabId, 'landscape', {
        exactSize: false,
        perPaneTimeoutMs: 500,
      });
      expect(rescued.partial).toBe(false);
      expect(landscapeCapCalls).toBe(2);
      expect((rescued.captures as Record<string, { bytes: number }>).landscape?.bytes).toBeGreaterThan(0);
      expect(
        (rescued.viewportReport as Record<string, { exactSizeApplied?: boolean }>).landscape
          ?.exactSizeApplied,
      ).toBe(false);
    } finally {
      mgr.dispose();
    }
  });
});
