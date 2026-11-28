import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  AgentDockManager,
  assertAgentSender,
  parseTmuxListPanesOutput,
  writePerWindowMcpConfig,
} from '../src/main/agent-dock';
import { mountAgentDock } from '../src/renderer/agent-dock';
import type { IronAgentDockApi } from '../src/preload/agent-preload';
import { MirrorRelay, type IpcMainLike } from '../src/main/mirror-relay';
import {
  clampAnchoredFloatBoundsUpdate,
  clampFloatBounds,
  computeLayout,
  computeResizedFloatBounds,
  FLOAT_MARGIN_BOTTOM,
  FLOAT_MARGIN_TOP,
  FLOAT_MARGIN_X,
  MIN_AGENT_FLOAT_HEIGHT,
  MIN_AGENT_FLOAT_WIDTH,
  TOP_BAR_HEIGHT,
} from '../src/shared/layout';
import { sanitizePersistedSession } from '../src/shared/session-store';
import { buildWebGlInspectorInitScript } from '../src/shared/webgl-inspector-core';
import type { ElementFingerprint, ViewportRole } from '../src/shared/types';

describe('Full Keyboard Event Listening & Hold/Keyup Mirroring', () => {
  test('MirrorRelay emits onKeyboardEvent even when mirror is off, holds keyDown until keyUp when holdUntilKeyup=true, and supports Home/End/PageUp/F1..F12', async () => {
    const ipc = new EventEmitter();
    const mkWc = (id: number) => {
      const dbg = Object.assign(new EventEmitter(), {
        attached: true,
        commands: [] as Array<{ method: string; params?: Record<string, unknown> }>,
        isAttached() {
          return this.attached;
        },
        attach() {
          this.attached = true;
        },
        detach() {
          this.attached = false;
        },
        async sendCommand(method: string, params?: Record<string, unknown>) {
          this.commands.push({ method, params });
          return {};
        },
      });
      const mf = { origin: 'https://game.example.com' };
      const wc: any = Object.assign(new EventEmitter(), {
        id,
        mainFrame: mf,
        debugger: dbg,
        isDestroyed: () => false,
        getURL: () => 'https://game.example.com/play',
        send: (ch: string, msg: any) => {
          if (ch === 'iron:dom-query') {
            queueMicrotask(() => {
              ipc.emit(
                'iron:dom-query-reply',
                { sender: wc, senderFrame: mf },
                {
                  reqId: msg.reqId,
                  result: { found: true, tier: 3, x: 200, y: 300, isCanvas: true, tag: 'canvas' },
                },
              );
            });
          }
        },
        sendInputEvent: () => {},
      });
      return wc;
    };

    const portrait = mkWc(201);
    const landscape = mkWc(202);
    let mirrorEnabled = false;
    const observedKeys: Array<{ role: ViewportRole; kind: string; key: string; sensitive: boolean }> =
      [];

    const relay = new MirrorRelay(
      {
        findByWebContentsId: (id) =>
          id === landscape.id
            ? {
                tabId: 'tab-k1',
                role: 'landscape',
                mirrorEnabled,
                pairedWebContents: portrait,
                pairedScale: 1,
              }
            : null,
        onKeyboardEvent: (_tabId, role, ev) => {
          observedKeys.push({
            role,
            kind: ev.kind,
            key: ev.key,
            sensitive: ev.sensitive,
          });
        },
      },
      ipc as unknown as IpcMainLike,
    );

    try {
      const canvasFp: ElementFingerprint = {
        tag: 'canvas',
        cssPath: 'canvas:nth-of-type(1)',
        isCanvas: true,
        relViewportX: 0.5,
        relViewportY: 0.5,
      };

      // 1. Even with mirrorEnabled=false, keyboard events are observed for TabEventBus!
      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          fingerprint: canvasFp,
          key: 'w',
          code: 'KeyW',
          modifiers: [],
          holdUntilKeyup: true,
          sensitive: false,
        },
      );
      expect(observedKeys).toEqual([
        { role: 'landscape', kind: 'keydown', key: 'w', sensitive: false },
      ]);
      expect(portrait.debugger.commands.length).toBe(0);

      // 2. iron:key-observe (editable typing) records onKeyboardEvent with sensitive=true and NEVER replays!
      mirrorEnabled = true;
      ipc.emit(
        'iron:key-observe',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          key: 's',
          code: 'KeyS',
          modifiers: [],
          repeat: false,
          tag: 'input',
          sensitive: true,
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      expect(observedKeys[1]).toEqual({
        role: 'landscape',
        kind: 'keydown',
        key: 's',
        sensitive: true,
      });
      expect(portrait.debugger.commands.length).toBe(0);

      // 3. holdUntilKeyup=true sends ONLY keyDown on keydown, then keyUp when keyup arrives!
      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          fingerprint: canvasFp,
          key: 'PageDown',
          code: 'PageDown',
          modifiers: [],
          holdUntilKeyup: true,
          repeat: false,
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(portrait.debugger.commands.length).toBe(1);
      expect(portrait.debugger.commands[0]!.params).toMatchObject({
        type: 'rawKeyDown',
        key: 'PageDown',
        code: 'PageDown',
        windowsVirtualKeyCode: 34,
      });

      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keyup',
          fingerprint: canvasFp,
          key: 'PageDown',
          code: 'PageDown',
          modifiers: [],
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(portrait.debugger.commands.length).toBe(2);
      expect(portrait.debugger.commands[1]!.params).toMatchObject({
        type: 'keyUp',
        key: 'PageDown',
        code: 'PageDown',
        windowsVirtualKeyCode: 34,
      });
    } finally {
      relay.dispose();
    }
  });
});

describe('WebGL Draw-Call, Resource & Rendering-Order Inspector', () => {
  test('buildWebGlInspectorInitScript hooks WebGL prototypes, counts drawCalls/triangles/passes/resources, captures 1-frame ordered draw log, and sorts rendering layers', async () => {
    const script = buildWebGlInspectorInitScript();
    expect(script).not.toContain('require(');

    let rafCb: (() => void) | null = null;
    class FakeWebGL2RenderingContext {
      drawingBufferWidth = 1280;
      drawingBufferHeight = 720;
      canvas = { addEventListener: () => {} };
      getExtension(name: string) {
        if (name === 'WEBGL_debug_renderer_info') return {};
        return null;
      }
      getParameter(p: number) {
        if (p === 0x9246) return 'ANGLE (Mock GPU)';
        if (p === 0x9245) return 'IronVendor';
        return null;
      }
      createProgram() {
        return { kind: 'prog' };
      }
      deleteProgram(_p: unknown) {}
      createTexture() {
        return { kind: 'tex' };
      }
      deleteTexture(_t: unknown) {}
      createBuffer() {
        return { kind: 'buf' };
      }
      deleteBuffer(_b: unknown) {}
      createFramebuffer() {
        return { kind: 'fbo' };
      }
      deleteFramebuffer(_f: unknown) {}
      useProgram(_p: unknown) {}
      activeTexture(_u: number) {}
      bindTexture(_target: number, _tex: unknown) {}
      bindFramebuffer(_target: number, _fbo: unknown) {}
      enable(_cap: number) {}
      disable(_cap: number) {}
      viewport(_x: number, _y: number, _w: number, _h: number) {}
      drawArrays(_mode: number, _first: number, _count: number) {}
      drawElements(_mode: number, _count: number, _type: number, _offset: number) {}
      drawElementsInstanced(
        _mode: number,
        _count: number,
        _type: number,
        _offset: number,
        _instances: number,
      ) {}
    }

    const hudEl = {
      tagName: 'DIV',
      className: 'hud-top',
      getAttribute: (k: string) => (k === 'id' ? 'hud' : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 60 }),
      style: { position: 'fixed', zIndex: '20', opacity: '1', transform: 'translateZ(0)' },
    };
    const canvasEl: any = {
      tagName: 'CANVAS',
      className: 'stage',
      __ironCanvasKind: 'webgl2',
      getAttribute: (k: string) => (k === 'id' ? 'game-canvas' : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      style: { position: 'relative', zIndex: '1', opacity: '1', transform: 'none' },
    };

    const fakeDoc = {
      body: {
        querySelectorAll: () => [hudEl, canvasEl],
      },
      querySelectorAll: (sel: string) => (sel === 'canvas' ? [canvasEl] : []),
    };
    const fakeWin: any = {
      document: fakeDoc,
      WebGL2RenderingContext: FakeWebGL2RenderingContext,
      WebGLRenderingContext: FakeWebGL2RenderingContext,
      requestAnimationFrame: (cb: () => void) => {
        rafCb = cb;
        return 1;
      },
      getComputedStyle: (el: any) => ({
        display: 'block',
        visibility: 'visible',
        position: el.style.position,
        zIndex: el.style.zIndex,
        opacity: el.style.opacity,
        transform: el.style.transform,
        willChange: 'auto',
        filter: 'none',
        backdropFilter: 'none',
        mixBlendMode: 'normal',
        isolation: 'auto',
      }),
    };
    const sandbox: Record<string, unknown> = {
      window: fakeWin,
      document: fakeDoc,
      WebGL2RenderingContext: FakeWebGL2RenderingContext,
      WebGLRenderingContext: FakeWebGL2RenderingContext,
      performance: { now: () => 100 },
      setTimeout,
      clearTimeout,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(script, sandbox);

    const gl = new FakeWebGL2RenderingContext();
    const progA = gl.createProgram();
    const progB = gl.createProgram();
    const tex1 = gl.createTexture();
    const fbo1 = gl.createFramebuffer();

    const inspector = fakeWin.__ironWebGlInspector;
    const capturePromise = inspector.captureFrame(64, 500, 32);

    // Pass 0: Offscreen FBO shadow/bloom pass
    gl.bindFramebuffer(0x8d40, fbo1);
    gl.useProgram(progA);
    gl.activeTexture(0x84c0);
    gl.bindTexture(0x0de1, tex1);
    gl.drawElements(0x0004, 36, 0x1403, 0); // 12 triangles

    // Pass 1: Main screen pass with instanced particles
    gl.bindFramebuffer(0x8d40, null);
    gl.enable(0x0be2); // BLEND
    gl.useProgram(progB);
    gl.drawElementsInstanced(0x0004, 6, 0x1403, 0, 50); // 2 * 50 = 100 triangles

    if (rafCb) (rafCb as () => void)();
    const captured = await capturePromise;

    expect(captured.capturedFrames).toBe(1);
    expect(captured.passes.length).toBe(2);
    expect(captured.passes[0]).toMatchObject({
      passIndex: 0,
      fboTarget: 'fbo#4',
      drawCalls: 1,
      triangles: 12,
    });
    expect(captured.passes[1]).toMatchObject({
      passIndex: 1,
      fboTarget: 'screen',
      drawCalls: 1,
      triangles: 100,
    });
    expect(captured.drawCalls.length).toBe(2);
    expect(captured.drawCalls[0]!.mode).toBe('TRIANGLES');
    expect(captured.drawCalls[1]!.api).toBe('drawElementsInstanced');
    expect(captured.drawCalls[1]!.blendEnabled).toBe(true);
    expect(captured.summary.drawCallsPerFrame).toBe(2);
    expect(captured.summary.trianglesPerFrame).toBe(112);
    expect(captured.summary.resources.programs).toBe(2);
    expect(captured.summary.renderer).toBe('ANGLE (Mock GPU)');

    // Rendering order: z-index 1 canvas painted BEFORE z-index 20 HUD regardless of DOM order!
    expect(captured.renderingOrder.map((l: any) => l.selector)).toEqual([
      'canvas#game-canvas',
      'div#hud',
    ]);
  });
});

describe('Embedded Multi-CLI & Running-Instance Agent Chat Dock', () => {
  test('parseTmuxListPanesOutput prioritizes running agent CLIs and computeLayout reserves docked / floating / minimized geometry cleanly', () => {
    const instances = parseTmuxListPanesOutput(
      [
        '0:1.1\tzsh\tzsh\t/home/dev\t1001',
        '0:2.1\tpos-perf\tclaude\t/home/dev/shop\t1002',
        '8:1.1\tcodex-work\tcodex\t/home/dev/game\t1003',
        'bad-target-without-pane\tfoo\tbar\t/tmp\t999',
      ].join('\n'),
    );
    expect(instances.length).toBe(3);
    expect(instances[0]!.isAgentLike).toBe(true);
    expect(instances.map((i) => i.command)).toEqual(['claude', 'codex', 'zsh']);

    const docked = computeLayout({
      windowWidth: 1480,
      windowHeight: 920,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      agentDockMode: 'docked',
      agentDockWidth: 360,
    });
    expect(docked.agentDock).toEqual({ x: 1120, y: 40, width: 360, height: 880 });
    expect(docked.landscapeView.x + docked.landscapeView.width).toBeLessThanOrEqual(1120);

    const floating = computeLayout({
      windowWidth: 1480,
      windowHeight: 920,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      agentDockMode: 'floating',
      agentFloatBounds: { x: 900, y: 80, width: 400, height: 500 },
    });
    expect(floating.agentDock).toEqual({ x: 900, y: 80, width: 400, height: 500 });
    expect(floating.landscapeView.x + floating.landscapeView.width).toBe(1480);
  });

  test('AgentDockManager spawns real native Rust PTY CLI with IRON_BROWSER_SOCKET + 0600 mcp.json, streams output, and enforces assertAgentSender', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-agent-dock-'));
    const sockPath = path.join(tmpDir, 'ctl.sock');
    const cfgPath = writePerWindowMcpConfig(sockPath);
    expect(cfgPath).not.toBeNull();
    const stat = fs.statSync(cfgPath!);
    expect(stat.mode & 0o777).toBe(0o600);

    const outputs: string[] = [];
    const fakeAgentWc = Object.assign(new EventEmitter(), {
      id: 777,
      mainFrame: { id: 1 },
      isDestroyed: () => false,
      send: (ch: string, payload: any) => {
        if (ch === 'agent:output' && typeof payload?.chunk === 'string') {
          outputs.push(payload.chunk);
        }
      },
      close: () => {},
    });
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-42',
        getBrowserContextSnippet: () => '[IronBrowser tab=tab-42]',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked' },
    );
    // Attach fake view to verify sender isolation & live output forwarding
    (mgr as any).view = { webContents: fakeAgentWc, setVisible: () => {}, setBounds: () => {} };

    try {
      // Reject spoofed IPC from untrusted viewport WebContents or navigated frame URL (F-27)
      expect(() =>
        assertAgentSender(
          { sender: { id: 999 }, senderFrame: fakeAgentWc.mainFrame } as any,
          (mgr as any).view,
        ),
      ).toThrow('Unauthorized IPC sender');
      const navigatedFrame = { id: 1, url: 'https://evil.example/' };
      expect(() =>
        assertAgentSender(
          {
            sender: fakeAgentWc,
            senderFrame: navigatedFrame,
          } as any,
          {
            webContents: {
              ...fakeAgentWc,
              mainFrame: navigatedFrame,
            },
          } as any,
          'file:///expected/agent-dock.html',
        ),
      ).toThrow('Unauthorized IPC sender');

      const st = mgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'printf "SOCK=%s TAB=%s\\n" "$IRON_BROWSER_SOCKET" "$IRON_BROWSER_DEFAULT_TAB"; IFS= read -r msg; printf "REPLY=%s\\n" "$msg"',
        cwd: tmpDir,
      });
      expect(st.session.active).toBe(true);

      await new Promise((r) => setTimeout(r, 120));
      await mgr.writeInput('ping-from-browser', true);

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (outputs.join('').includes('REPLY=ping-from-browser') && !mgr.getState().session.active) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      const joined = outputs.join('');
      expect(joined).toContain(`SOCK=${sockPath}`);
      expect(joined).toContain('TAB=tab-42');
      expect(joined).toContain('REPLY=ping-from-browser');
      // F-28: Natural exit cleans up activePtyId automatically
      expect((mgr as any).activePtyId).toBeNull();

      // F-26: >16KB paste into raw-mode PTY while busy never blocks main thread and flushes losslessly
      outputs.length = 0;
      mgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'stty raw -echo; printf "RAW_READY\\n"; sleep 0.12; bytes=$(head -c 12000 | wc -c); stty sane; printf "DRAINED=%s\\n" "$bytes"',
        cwd: tmpDir,
      });
      const readyDl = Date.now() + 2000;
      while (Date.now() < readyDl && !outputs.join('').includes('RAW_READY')) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const tWrite0 = performance.now();
      const okWrite = await mgr.writeInput('X'.repeat(12_000), false);
      const writeMs = performance.now() - tWrite0;
      expect(okWrite).toBe(true);
      expect(writeMs).toBeLessThan(80);

      const drainDl = Date.now() + 3000;
      while (Date.now() < drainDl && !outputs.join('').includes('DRAINED=12000')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(outputs.join('')).toContain('DRAINED=12000');
    } finally {
      mgr.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('floating Agent Dock supports custom 8-edge/corner resizing with anchored opposite edges, window clamping, and session persistence', () => {
    const winW = 1480;
    const winH = 920;
    const origin = { x: 500, y: 200, width: 400, height: 350 };

    // 1. East & South expand cleanly while anchoring x/y
    expect(computeResizedFloatBounds(origin, 'e', 120, 40, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 520,
      height: 350,
    });
    expect(computeResizedFloatBounds(origin, 's', 40, 110, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 400,
      height: 460,
    });
    expect(computeResizedFloatBounds(origin, 'se', 150, 90, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 550,
      height: 440,
    });

    // 2. West & North anchor right/bottom even when shrunk past minimum dimensions
    const westMin = computeResizedFloatBounds(origin, 'w', 500, 0, winW, winH);
    expect(westMin.width).toBe(MIN_AGENT_FLOAT_WIDTH);
    expect(westMin.x + westMin.width).toBe(origin.x + origin.width);

    const northMin = computeResizedFloatBounds(origin, 'n', 0, 500, winW, winH);
    expect(northMin.height).toBe(MIN_AGENT_FLOAT_HEIGHT);
    expect(northMin.y + northMin.height).toBe(origin.y + origin.height);

    // 3. NW corner expanding past left/top window margins anchors right/bottom without sliding
    const nwPastMargin = computeResizedFloatBounds(origin, 'nw', -900, -500, winW, winH);
    expect(nwPastMargin.x).toBe(FLOAT_MARGIN_X);
    expect(nwPastMargin.y).toBe(TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP);
    expect(nwPastMargin.x + nwPastMargin.width).toBe(origin.x + origin.width);
    expect(nwPastMargin.y + nwPastMargin.height).toBe(origin.y + origin.height);

    // 4. NE and SW corners resize diagonally with exact opposite-corner anchoring
    const neRes = computeResizedFloatBounds(origin, 'ne', 80, -60, winW, winH);
    expect(neRes).toEqual({ x: 500, y: 140, width: 480, height: 410 });
    const swRes = computeResizedFloatBounds(origin, 'sw', -75, 55, winW, winH);
    expect(swRes).toEqual({ x: 425, y: 200, width: 475, height: 405 });

    // 5. SE expanding past right/bottom clamps cleanly to window margins without shifting x/y
    const sePastMargin = computeResizedFloatBounds(origin, 'se', 2000, 2000, winW, winH);
    expect(sePastMargin.x).toBe(500);
    expect(sePastMargin.y).toBe(200);
    expect(sePastMargin.x + sePastMargin.width).toBe(winW - FLOAT_MARGIN_X);
    expect(sePastMargin.y + sePastMargin.height).toBe(winH - FLOAT_MARGIN_BOTTOM);

    // 6. Non-finite deltas are ignored cleanly
    expect(computeResizedFloatBounds(origin, 'se', Number.NaN, Number.POSITIVE_INFINITY)).toEqual(origin);

    // 7. Main-process anchored clamping preserves right/bottom on west/north overflow and preserves size on move-only
    const anchoredWest = clampAnchoredFloatBoundsUpdate(
      origin,
      { x: -100, width: 1000 },
      winW,
      winH,
    );
    expect(anchoredWest.x).toBe(FLOAT_MARGIN_X);
    expect(anchoredWest.x + anchoredWest.width).toBe(900);

    const moveOnly = clampAnchoredFloatBoundsUpdate(origin, { x: -50, y: 0 }, winW, winH);
    expect(moveOnly).toEqual({
      x: FLOAT_MARGIN_X,
      y: TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP,
      width: 400,
      height: 350,
    });

    // 8. AgentDockManager clamps setFloatBounds against window size and syncs applyBounds on window shrink
    const pushedStates: Array<{ floatBounds: { x: number; y: number; width: number; height: number } }> = [];
    const fakeWc = Object.assign(new EventEmitter(), {
      id: 888,
      mainFrame: { id: 1 },
      isDestroyed: () => false,
      send: (ch: string, payload: any) => {
        if (ch === 'agent:state') pushedStates.push(payload);
      },
      close: () => {},
    });
    let currentWinSize: [number, number] = [1480, 920];
    const appliedRects: Array<{ x: number; y: number; width: number; height: number }> = [];
    const fakeWin: any = {
      isDestroyed: () => false,
      getContentSize: () => currentWinSize,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => '/tmp/fake.sock',
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {
          const rect = clampFloatBounds(mgr.getState().floatBounds, currentWinSize[0], currentWinSize[1]);
          mgr.applyBounds(rect);
        },
      },
      {
        initialMode: 'floating',
        initialFloatBounds: { x: 600, y: 120, width: 520, height: 480 },
        ptyBinding: null,
      },
    );
    (mgr as any).view = {
      webContents: fakeWc,
      setVisible: () => {},
      setBounds: (r: any) => appliedRects.push(r),
    };

    try {
      expect(mgr.getState().floatBounds).toEqual({ x: 600, y: 120, width: 520, height: 480 });
      const resized = mgr.setFloatBounds({ x: 300, y: 90, width: 700, height: 610 });
      expect(resized.floatBounds).toEqual({ x: 300, y: 90, width: 700, height: 610 });
      expect(appliedRects[appliedRects.length - 1]).toEqual({ x: 300, y: 90, width: 700, height: 610 });

      // Shrinking main window clamps floatBounds and pushes updated state to renderer
      pushedStates.length = 0;
      currentWinSize = [800, 500];
      mgr.applyBounds(clampFloatBounds(mgr.getState().floatBounds, 800, 500));
      expect(mgr.getState().floatBounds).toEqual({
        x: 92,
        y: 44,
        width: 700,
        height: 452,
      });
      expect(pushedStates.length).toBe(1);
      expect(pushedStates[0]!.floatBounds).toEqual(mgr.getState().floatBounds);
    } finally {
      mgr.dispose();
    }

    // 9. Persisted session sanitizes custom agentFloatBounds cleanly
    const persisted = sanitizePersistedSession({
      version: 1,
      savedAt: 1000,
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      theme: 'dark',
      agentFloatBounds: { x: 320.4, y: 95.6, width: 640, height: 520 },
      activeTabIndex: 0,
      tabs: [],
      history: [],
    });
    expect(persisted?.agentFloatBounds).toEqual({ x: 320, y: 96, width: 640, height: 520 });

    const clampedPersisted = sanitizePersistedSession({
      version: 1,
      savedAt: 1000,
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      theme: 'dark',
      agentFloatBounds: { x: -50, y: -10, width: 50, height: 40 },
      activeTabIndex: 0,
      tabs: [],
      history: [],
    });
    expect(clampedPersisted?.agentFloatBounds).toEqual({
      x: 0,
      y: 0,
      width: MIN_AGENT_FLOAT_WIDTH,
      height: MIN_AGENT_FLOAT_HEIGHT,
    });

    // 10. Renderer HTML/CSS expose all 8 floating resize handles gated on .dock-root.floating
    const html = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.html'), 'utf8');
    const css = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.css'), 'utf8');
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(html).toContain(`data-resize-edge="${edge}"`);
      expect(css).toContain(`.handle-${edge}`);
    }
    expect(css).toContain('.dock-root.floating .float-resize-handle');
  });

  test('F3 PTY writeInput separates data and CR across drain + >=15ms yield (including partial backpressure), chunks >64 KiB payloads on real Rust PTY, and cleans mcp-<pid>.json on dispose', async () => {
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    // 1. Spy PTY binding with partial-write backpressure on first write
    const writeEvents: Array<{ ts: number; data: string }> = [];
    let partialCount = 0;
    const mockBinding: any = {
      ptySpawn: () => JSON.stringify({ ok: true, id: 101, pid: 4242 }),
      ptyPoll: () => JSON.stringify({ ok: true, dataB64: '', exited: false, exitCode: null }),
      ptyResize: () => true,
      ptyKill: () => true,
      ptyWrite: (_id: number, dataB64: string) => {
        const buf = Buffer.from(dataB64, 'base64');
        const text = buf.toString('utf8');
        if (partialCount === 0 && buf.length >= 6) {
          partialCount += 1;
          const half = Math.floor(buf.length / 2);
          writeEvents.push({ ts: performance.now(), data: buf.subarray(0, half).toString('utf8') });
          return JSON.stringify({ ok: true, bytesWritten: half });
        }
        writeEvents.push({ ts: performance.now(), data: text });
        return JSON.stringify({ ok: true, bytesWritten: buf.length });
      },
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-f3-pty-'));
    const sockPath = path.join(tmpDir, 'ctl.sock');
    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked', ptyBinding: mockBinding },
    );

    try {
      mgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      const expectedCfg = path.join(tmpDir, `mcp-${process.pid}.json`);
      expect(fs.existsSync(expectedCfg)).toBe(true);

      const ok = await mgr.writeInput('hello-agent', true);
      expect(ok).toBe(true);
      expect(writeEvents.length).toBe(3);
      expect(writeEvents[0]!.data).toBe('hello');
      expect(writeEvents[1]!.data).toBe('-agent');
      expect(writeEvents[2]!.data).toBe('\r');
      expect(writeEvents[2]!.ts - writeEvents[1]!.ts).toBeGreaterThanOrEqual(15);

      // Stopping session cleans up per-window mcp-<pid>.json
      mgr.stopSession();
      expect(fs.existsSync(expectedCfg)).toBe(false);
    } finally {
      mgr.dispose();
    }

    // 2. Real Rust PTY: raw-mode node reader sees payload and CR separately, and >64 KiB (72 KB) succeeds via chunking
    const outputs: string[] = [];
    const realMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked' },
    );
    (realMgr as any).view = {
      webContents: {
        isDestroyed: () => false,
        send: (ch: string, payload: any) => {
          if (ch === 'agent:output' && typeof payload?.chunk === 'string') {
            outputs.push(payload.chunk);
          }
        },
        close: () => {},
      },
      setVisible: () => {},
      setBounds: () => {},
    };

    try {
      realMgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'stty raw -echo; node -e "const chunks=[]; process.stdin.on(\'data\', d => { chunks.push(d.toString(\'utf8\')); if (d.includes(\'\\r\')) { process.stdout.write(\'CHUNKS=\'+JSON.stringify(chunks)+\'\\n\'); process.exit(0); } }); process.stdin.resume(); process.stdout.write(\'READY\\n\');"',
        cwd: tmpDir,
      });
      const readyDl = Date.now() + 2500;
      while (Date.now() < readyDl && !outputs.join('').includes('READY')) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const okRaw = await realMgr.writeInput('discrete-submit', true);
      expect(okRaw).toBe(true);
      const doneDl = Date.now() + 3000;
      while (Date.now() < doneDl && !outputs.join('').includes('CHUNKS=')) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const lineMatch = outputs.join('').match(/CHUNKS=(\[[^\r\n]+\])/);
      expect(lineMatch).not.toBeNull();
      const chunks = JSON.parse(lineMatch![1]!) as string[];
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[chunks.length - 1]).toBe('\r');
      expect(chunks.slice(0, -1).join('')).toBe('discrete-submit');

      // >64 KiB payload (72,000 bytes) must succeed via <=32 KiB chunking instead of hitting MAX_PTY_WRITE_BYTES
      outputs.length = 0;
      realMgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'stty raw -echo; printf "BIG_READY\\n"; sleep 0.1; bytes=$(head -c 72000 | wc -c); stty sane; printf "BIG=%s\\n" "$bytes"',
        cwd: tmpDir,
      });
      const bigReadyDl = Date.now() + 2500;
      while (Date.now() < bigReadyDl && !outputs.join('').includes('BIG_READY')) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const okBig = await realMgr.writeInput('B'.repeat(72_000), false);
      expect(okBig).toBe(true);
      const bigDoneDl = Date.now() + 4000;
      while (Date.now() < bigDoneDl && !outputs.join('').includes('BIG=72000')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(outputs.join('')).toContain('BIG=72000');
    } finally {
      realMgr.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('F3 tmux writeInput uses -- before leading-dash payload, scales delay >60ms on larger payloads, and aborts C-m on failure', async () => {
    const calls: Array<{ file: string; args: string[]; ts: number }> = [];
    let shouldFailSend = false;
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };
    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => '/tmp/fake-tmux.sock',
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        initialMode: 'docked',
        ptyBinding: null,
        execFile: async (file, args) => {
          calls.push({ file, args: [...args], ts: performance.now() });
          if (args[0] === 'capture-pane') {
            return { stdout: 'pane output', stderr: '' };
          }
          if (shouldFailSend && args.includes('-l')) {
            throw new Error('tmux send-keys failed');
          }
          return { stdout: '', stderr: '' };
        },
      },
    );

    try {
      await mgr.attachRunningInstance('main:0.1');
      calls.length = 0;

      const okDash = await mgr.writeInput('-leading-dash --flag', true);
      expect(okDash).toBe(true);
      const sendCalls = calls.filter((c) => c.args[0] === 'send-keys');
      expect(sendCalls.length).toBe(2);
      expect(sendCalls[0]!.args).toEqual([
        'send-keys',
        '-t',
        'main:0.1',
        '-l',
        '--',
        '-leading-dash --flag',
      ]);
      expect(sendCalls[1]!.args).toEqual(['send-keys', '-t', 'main:0.1', 'C-m']);
      const shortGapMs = sendCalls[1]!.ts - sendCalls[0]!.ts;
      expect(shortGapMs).toBeGreaterThanOrEqual(70);

      calls.length = 0;
      const okLarge = await mgr.writeInput('Z'.repeat(8000), true);
      expect(okLarge).toBe(true);
      const largeCalls = calls.filter((c) => c.args[0] === 'send-keys');
      const largeGapMs = largeCalls[1]!.ts - largeCalls[0]!.ts;
      expect(largeGapMs).toBeGreaterThan(120);

      calls.length = 0;
      shouldFailSend = true;
      const okFail = await mgr.writeInput('-should-fail', true);
      expect(okFail).toBe(false);
      expect(calls.filter((c) => c.args.includes('C-m')).length).toBe(0);
    } finally {
      mgr.dispose();
    }
  });

  test('F3 renderer submitPrompt awaits api.write, clears only on true, preserves text + shows status on false/reject, and guards double-submit', async () => {
    class MockClassList {
      private readonly set = new Set<string>();
      constructor(initial: string[] = []) {
        for (const c of initial) if (c) this.set.add(c);
      }
      add(...t: string[]) {
        for (const x of t) this.set.add(x);
      }
      remove(...t: string[]) {
        for (const x of t) this.set.delete(x);
      }
      toggle(tok: string, force?: boolean) {
        if (force === true) {
          this.set.add(tok);
          return true;
        }
        if (force === false) {
          this.set.delete(tok);
          return false;
        }
        if (this.set.has(tok)) {
          this.set.delete(tok);
          return false;
        }
        this.set.add(tok);
        return true;
      }
      contains(tok: string) {
        return this.set.has(tok);
      }
    }

    class MockEl {
      id = '';
      value = '';
      textContent = '';
      innerHTML = '';
      disabled = false;
      focused = false;
      scrollTop = 0;
      scrollHeight = 100;
      clientHeight = 100;
      clientWidth = 400;
      className = '';
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      classList = new MockClassList();
      listeners = new Map<string, Array<(ev: any) => void>>();
      addEventListener(type: string, fn: (ev: any) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      removeEventListener(type: string, fn: (ev: any) => void) {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter((f) => f !== fn));
      }
      dispatch(type: string, ev: any = {}) {
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      }
      click() {
        this.dispatch('click', {});
      }
      focus() {
        this.focused = true;
      }
      contains() {
        return false;
      }
      appendChild(node: any) {
        return node;
      }
      append() {}
      replaceChildren() {}
    }

    const byId = new Map<string, MockEl>();
    for (const id of [
      'dock-root',
      'status-dot',
      'session-badge',
      'btn-format-md',
      'btn-mode-docked',
      'btn-mode-floating',
      'btn-mode-min',
      'dock-drag-bar',
      'tab-running',
      'tab-start',
      'pane-running',
      'pane-start',
      'btn-refresh-instances',
      'btn-disconnect',
      'instance-list',
      'input-cwd',
      'custom-cli-form',
      'input-custom-cli',
      'terminal-wrap',
      'terminal-screen',
      'btn-insert-context',
      'composer-status',
      'chat-form',
      'chat-input',
      'btn-send',
    ]) {
      const el = new MockEl();
      el.id = id;
      if (id === 'composer-status') el.classList.add('hidden');
      byId.set(id, el);
    }

    const fakeDoc: any = {
      body: { style: {} },
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelector: () => byId.get('dock-root') ?? null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createDocumentFragment: () => new MockEl(),
      createElement: () => new MockEl(),
      createTextNode: (t: string) => ({ textContent: t }),
    };
    const fakeWin: any = {
      getSelection: () => null,
      addEventListener: () => {},
    };

    const writes: Array<{ data: string; submitEnter?: boolean }> = [];
    let writeImpl: (data: string, submitEnter?: boolean) => Promise<boolean> = async () => true;
    const fakeApi: IronAgentDockApi = {
      getInitial: async () => ({
        state: {
          mode: 'docked',
          width: 360,
          floatBounds: { x: 100, y: 60, width: 400, height: 500 },
          session: { active: false, kind: 'none', label: 'Idle', socketPath: '/tmp/test.sock' },
        },
        transcript: '',
        instances: [],
        defaultCwd: '/tmp',
        contextSnippet: '',
      }),
      listInstances: async () => [],
      startCli: async () => {
        throw new Error('unused');
      },
      attachInstance: async () => {
        throw new Error('unused');
      },
      stop: async () => {
        throw new Error('unused');
      },
      write: (data, submitEnter) => {
        writes.push({ data, submitEnter });
        return writeImpl(data, submitEnter);
      },
      sendSpecialKey: async () => true,
      resize: async () => true,
      setMode: async () => {
        throw new Error('unused');
      },
      setFloatBounds: async () => {
        throw new Error('unused');
      },
      getContext: async () => '',
      onState: () => () => {},
      onOutput: () => () => {},
      onInjectContext: () => () => {},
    };

    mountAgentDock(fakeDoc, fakeApi, fakeWin);
    await new Promise((r) => setTimeout(r, 10));

    const chatInput = byId.get('chat-input')!;
    const composerStatus = byId.get('composer-status')!;
    const btnSend = byId.get('btn-send')!;

    // 1. write returns false -> preserve unsent prompt + show non-destructive status
    writeImpl = async () => false;
    chatInput.value = 'keep me on failure';
    chatInput.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    await new Promise((r) => setTimeout(r, 15));
    expect(chatInput.value).toBe('keep me on failure');
    expect(composerStatus.classList.contains('hidden')).toBe(false);
    expect(composerStatus.classList.contains('error')).toBe(true);
    expect(composerStatus.textContent).toContain('No active agent session');

    // 2. write rejects -> preserve unsent prompt + show error
    writeImpl = async () => {
      throw new Error('ipc closed');
    };
    chatInput.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    await new Promise((r) => setTimeout(r, 15));
    expect(chatInput.value).toBe('keep me on failure');
    expect(composerStatus.textContent).toContain('ipc closed');

    // 3. Double-submit blocked while api.write is in flight, clears input only after resolving true
    writes.length = 0;
    let resolvePending!: (v: boolean) => void;
    writeImpl = () =>
      new Promise<boolean>((resolve) => {
        resolvePending = resolve;
      });
    chatInput.value = 'send once';
    chatInput.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    chatInput.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    expect(writes.length).toBe(1);
    expect(btnSend.disabled).toBe(true);
    expect(chatInput.value).toBe('send once');
    resolvePending(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(chatInput.value).toBe('');
    expect(btnSend.disabled).toBe(false);
    expect(composerStatus.classList.contains('hidden')).toBe(true);
  });

  test('F3 regression: concurrent PTY writeInput(true)+writeInput(false) preserves order on real PTY, stopSession mid-yield does not clobber new session, drain timeout clears queue, and >256 KiB saturation recovers cleanly', async () => {
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-f3-reg-'));
    const sockPath = path.join(tmpDir, 'ctl.sock');

    // 1. Real PTY: Promise.all([writeInput('first', true), writeInput('second', false)]) -> 'first\rsecond'
    const realOutputs: string[] = [];
    const realMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked' },
    );
    (realMgr as any).view = {
      webContents: {
        isDestroyed: () => false,
        send: (ch: string, payload: any) => {
          if (ch === 'agent:output' && typeof payload?.chunk === 'string') {
            realOutputs.push(payload.chunk);
          }
        },
        close: () => {},
      },
      setVisible: () => {},
      setBounds: () => {},
    };

    try {
      realMgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'stty raw -echo; node -e "let buf=\'\'; process.stdin.on(\'data\', d => { buf += d.toString(\'utf8\'); if (buf.length >= 12) { process.stdout.write(\'GOT=\'+JSON.stringify(buf)+\'\\n\'); process.exit(0); } }); process.stdin.resume(); process.stdout.write(\'READY\\n\');"',
        cwd: tmpDir,
      });
      const readyDl = Date.now() + 2500;
      while (Date.now() < readyDl && !realOutputs.join('').includes('READY')) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const [ok1, ok2] = await Promise.all([
        realMgr.writeInput('first', true),
        realMgr.writeInput('second', false),
      ]);
      expect(ok1).toBe(true);
      expect(ok2).toBe(true);

      const gotDl = Date.now() + 3000;
      while (Date.now() < gotDl && !realOutputs.join('').includes('GOT=')) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const gotMatch = realOutputs.join('').match(/GOT=("[^"\r\n]+")/);
      expect(gotMatch).not.toBeNull();
      expect(JSON.parse(gotMatch![1]!)).toBe('first\rsecond');
    } finally {
      realMgr.dispose();
    }

    // 2. stopSession() mid-yield -> immediate startCliAgent() -> old finally must not clobber session 2
    let nextId = 0;
    const writesByPty = new Map<number, string[]>();
    const clobberBinding: any = {
      ptySpawn: () => {
        nextId += 1;
        writesByPty.set(nextId, []);
        return JSON.stringify({ ok: true, id: nextId, pid: 5000 + nextId });
      },
      ptyPoll: () => JSON.stringify({ ok: true, dataB64: '', exited: false, exitCode: null }),
      ptyResize: () => true,
      ptyKill: () => true,
      ptyWrite: (id: number, dataB64: string) => {
        const text = Buffer.from(dataB64, 'base64').toString('utf8');
        writesByPty.get(id)?.push(text);
        return JSON.stringify({ ok: true, bytesWritten: Buffer.byteLength(text, 'utf8') });
      },
    };
    const clobberMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked', ptyBinding: clobberBinding },
    );

    try {
      clobberMgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      const p1 = clobberMgr.writeInput('s1_first', true);
      await new Promise((r) => setTimeout(r, 5));
      clobberMgr.stopSession();
      clobberMgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      const p3 = clobberMgr.writeInput('s2_third', true);
      await new Promise((r) => setTimeout(r, 17));
      const p4 = clobberMgr.writeInput('s2_fourth', false);
      const [r1, r3, r4] = await Promise.all([p1, p3, p4]);
      expect(r1).toBe(false);
      expect(r3).toBe(true);
      expect(r4).toBe(true);
      expect(writesByPty.get(1)).toEqual(['s1_first']);
      expect(writesByPty.get(2)).toEqual(['s2_third', '\r', 's2_fourth']);
      expect(writesByPty.get(2)?.join('')).toBe('s2_third\rs2_fourth');
    } finally {
      clobberMgr.dispose();
    }

    // 3. waitForPtyWriteDrain() timeout clears queue so 0 bytes leak afterward + >256 KiB saturation recovers
    let acceptWrites = true;
    let firstPartialDone = false;
    const drainWrites: string[] = [];
    const drainBinding: any = {
      ptySpawn: () => JSON.stringify({ ok: true, id: 77, pid: 7777 }),
      ptyPoll: () => JSON.stringify({ ok: true, dataB64: '', exited: false, exitCode: null }),
      ptyResize: () => true,
      ptyKill: () => true,
      ptyWrite: (_id: number, dataB64: string) => {
        const buf = Buffer.from(dataB64, 'base64');
        if (!firstPartialDone) {
          firstPartialDone = true;
          acceptWrites = false;
          drainWrites.push(buf.subarray(0, 1).toString('utf8'));
          return JSON.stringify({ ok: true, bytesWritten: 1 });
        }
        if (!acceptWrites) {
          return JSON.stringify({ ok: true, bytesWritten: 0 });
        }
        drainWrites.push(buf.toString('utf8'));
        return JSON.stringify({ ok: true, bytesWritten: buf.length });
      },
    };
    const drainMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked', ptyBinding: drainBinding, ptyDrainTimeoutMs: 60 },
    );

    try {
      drainMgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      const timedOutOk = await drainMgr.writeInput('ABC_LEAK', true);
      expect(timedOutOk).toBe(false);
      expect((drainMgr as any).pendingPtyWriteChunks.length).toBe(0);
      expect((drainMgr as any).pendingPtyWriteBytes).toBe(0);
      expect((drainMgr as any).ptyWriteFlushTimer).toBeNull();

      // Resume accepting writes and verify zero buffered bytes leak afterward
      const countAtFalse = drainWrites.length;
      acceptWrites = true;
      await new Promise((r) => setTimeout(r, 100));
      expect(drainWrites.length).toBe(countAtFalse);
      expect(drainWrites).toEqual(['A']);

      // >256 KiB saturation returns false without corrupting subsequent normal writes
      const overCapFalse = await drainMgr.writeInput('Q'.repeat(256 * 1024 + 1), false);
      const overCapSubmit = await drainMgr.writeInput('Q'.repeat(256 * 1024), true);
      expect(overCapFalse).toBe(false);
      expect(overCapSubmit).toBe(false);
      expect((drainMgr as any).pendingPtyWriteBytes).toBe(0);

      drainWrites.length = 0;
      const okAfterCap = await drainMgr.writeInput('after-cap', true);
      expect(okAfterCap).toBe(true);
      expect(drainWrites).toEqual(['after-cap', '\r']);
    } finally {
      drainMgr.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('F3 regression: tmux writeInput and sendSpecialKey serialize concurrently without interleaving, and mcp-<pid>.json is cleaned on startCliAgent throw & natural PTY exit', async () => {
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    // 1. Concurrent tmux writeInput & sendSpecialKey must execute sequentially
    const tmuxCalls: string[][] = [];
    const tmuxMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => '/tmp/fake-tmux-concurrent.sock',
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        initialMode: 'docked',
        ptyBinding: null,
        execFile: async (_file, args) => {
          if (args[0] === 'capture-pane') {
            return { stdout: 'pane', stderr: '' };
          }
          tmuxCalls.push([...args]);
          if (args.includes('-l')) {
            await new Promise((r) => setTimeout(r, 15));
          }
          return { stdout: '', stderr: '' };
        },
      },
    );

    try {
      await tmuxMgr.attachRunningInstance('main:0.1');
      tmuxCalls.length = 0;

      const [t1, t2, t3] = await Promise.all([
        tmuxMgr.writeInput('tmux_first', true),
        tmuxMgr.writeInput('tmux_second', true),
        tmuxMgr.sendSpecialKey('Interrupt'),
      ]);
      expect(t1).toBe(true);
      expect(t2).toBe(true);
      expect(t3).toBe(true);
      expect(tmuxCalls).toEqual([
        ['send-keys', '-t', 'main:0.1', '-l', '--', 'tmux_first'],
        ['send-keys', '-t', 'main:0.1', 'C-m'],
        ['send-keys', '-t', 'main:0.1', '-l', '--', 'tmux_second'],
        ['send-keys', '-t', 'main:0.1', 'C-m'],
        ['send-keys', '-t', 'main:0.1', 'C-c'],
      ]);
    } finally {
      tmuxMgr.dispose();
    }

    // 2. mcp-<pid>.json must not leak on startCliAgent validation throw, spawn failure, or natural PTY exit
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-f3-mcp-'));
    const sockPath = path.join(tmpDir, 'ctl.sock');
    let spawnShouldFail = false;
    let exitedNow = false;
    const mcpBinding: any = {
      ptySpawn: () => {
        if (spawnShouldFail) {
          return JSON.stringify({ ok: false, error: 'spawn boom' });
        }
        return JSON.stringify({ ok: true, id: 88, pid: 8888 });
      },
      ptyPoll: () =>
        JSON.stringify({
          ok: true,
          dataB64: '',
          exited: exitedNow,
          exitCode: exitedNow ? 0 : null,
        }),
      ptyResize: () => true,
      ptyKill: () => true,
      ptyWrite: () => JSON.stringify({ ok: true, bytesWritten: 0 }),
    };
    const mcpMgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked', ptyBinding: mcpBinding },
    );

    const listMcpFiles = () => fs.readdirSync(tmpDir).filter((f) => /^mcp-.*\.json$/.test(f));

    try {
      expect(() => mcpMgr.startCliAgent({ preset: 'custom', customCommand: '' })).toThrow(
        'Custom CLI command must be 1..512 characters',
      );
      expect(listMcpFiles()).toEqual([]);

      spawnShouldFail = true;
      expect(() => mcpMgr.startCliAgent({ preset: 'shell', cwd: tmpDir })).toThrow('spawn boom');
      expect(listMcpFiles()).toEqual([]);

      spawnShouldFail = false;
      mcpMgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      expect(listMcpFiles()).toEqual([`mcp-${process.pid}.json`]);

      exitedNow = true;
      await new Promise((r) => setTimeout(r, 90));
      expect(mcpMgr.getState().session.active).toBe(false);
      expect(listMcpFiles()).toEqual([]);
    } finally {
      mcpMgr.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('F6 AgentDockManager clearTranscript, copyTranscript, non-blocking exportTranscript, and renderer toolbar', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-f6-export-'));
    const prevDlDir = process.env.IRON_BROWSER_DOWNLOAD_DIR;
    process.env.IRON_BROWSER_DOWNLOAD_DIR = tmpDir;

    const sentMsgs: Array<{ channel: string; payload: unknown }> = [];
    const fakeWin: any = {
      isDestroyed: () => false,
      getContentSize: () => [1480, 920],
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      webContents: {
        id: 1,
        isDestroyed: () => false,
        send: (ch: string, payload: unknown) => sentMsgs.push({ channel: ch, payload }),
      },
    };
    const fakePty: any = {
      ptySpawn: () => JSON.stringify({ ok: true, id: 77, pid: 7777 }),
      ptyPoll: () =>
        JSON.stringify({
          ok: true,
          dataB64: Buffer.from('\x1b[32mHello F6\x1b[0m\r\n').toString('base64'),
          exited: false,
          exitCode: null,
        }),
      ptyResize: () => true,
      ptyKill: () => true,
      ptyWrite: () => JSON.stringify({ ok: true, bytesWritten: 0 }),
    };

    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => path.join(tmpDir, 'ctl.sock'),
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked', ptyBinding: fakePty },
    );
    try {
      mgr.startCliAgent({ preset: 'shell', cwd: tmpDir });
      await new Promise((r) => setTimeout(r, 60));

      const exported = await mgr.exportTranscript();
      expect(exported.ok).toBe(true);
      expect(exported.path).toBeDefined();
      expect(exported.path!.startsWith(tmpDir)).toBe(true);
      const written = fs.readFileSync(exported.path!, 'utf8');
      expect(written).toContain('Hello F6');
      expect(written).not.toContain('\x1b[');

      expect(mgr.copyTranscript()).toBe(true);
      expect(mgr.clearTranscript()).toBe(true);
      const exportedAfterClear = await mgr.exportTranscript();
      expect(exportedAfterClear.ok).toBe(true);
      expect(fs.readFileSync(exportedAfterClear.path!, 'utf8')).toBe('');

      // Renderer toolbar Clear/Copy/Export synchronously updates #terminal-screen on Clear
      const html = fs.readFileSync(
        path.resolve(import.meta.dir, '../src/renderer/agent-dock.html'),
        'utf8',
      );
      expect(html).toContain('id="btn-copy-transcript"');
      expect(html).toContain('id="btn-export-transcript"');
      expect(html).toContain('id="btn-clear-transcript"');
    } finally {
      mgr.dispose();
      if (prevDlDir === undefined) {
        delete process.env.IRON_BROWSER_DOWNLOAD_DIR;
      } else {
        process.env.IRON_BROWSER_DOWNLOAD_DIR = prevDlDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
