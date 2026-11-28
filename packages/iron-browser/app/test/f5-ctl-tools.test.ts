import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const nodeRequire = createRequire(import.meta.url);

async function loadF5VmEnv() {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'node' });

  class FakeDebugger extends EventEmitter {
    attached = false;
    commands: Array<{ method: string; params?: unknown }> = [];
    isAttached() {
      return this.attached;
    }
    attach() {
      this.attached = true;
    }
    detach() {
      this.attached = false;
    }
    async sendCommand(method: string, params?: unknown) {
      this.commands.push({ method, params });
      return {};
    }
  }

  class FakeCookies {
    private items: Array<{ url: string; name: string; value: string; path?: string }> = [];
    async get(filter: { url?: string; name?: string } = {}) {
      return this.items.filter((c) => {
        if (filter.url && !c.url.startsWith(new URL(filter.url).origin)) return false;
        if (filter.name && c.name !== filter.name) return false;
        return true;
      });
    }
    async set(details: { url: string; name: string; value: string }) {
      this.items = this.items.filter((c) => !(c.url === details.url && c.name === details.name));
      this.items.push({ url: details.url, name: details.name, value: details.value, path: '/' });
    }
    async remove(url: string, name: string) {
      this.items = this.items.filter(
        (c) => !(new URL(c.url).origin === new URL(url).origin && c.name === name),
      );
    }
  }

  class FakeSession extends EventEmitter {
    cookies = new FakeCookies();
    clearCacheCalls = 0;
    clearStorageCalls = 0;
    async clearCache() {
      this.clearCacheCalls += 1;
    }
    async clearStorageData() {
      this.clearStorageCalls += 1;
      this.itemsReset();
    }
    private itemsReset() {
      this.cookies = new FakeCookies();
    }
  }

  const defaultSession = new FakeSession();
  const partitions = new Map<string, FakeSession>();
  const getSession = (partition?: string) => {
    if (!partition) return defaultSession;
    let s = partitions.get(partition);
    if (!s) {
      s = new FakeSession();
      partitions.set(partition, s);
    }
    return s;
  };

  let nextWcId = 1;
  // Shared storage map per partition+origin so shared vs isolated partitions behave identically to Chromium!
  const webStorageMap = new Map<string, Map<string, string>>();
  const getWebStore = (sess: FakeSession, origin: string, kind: 'localStorage' | 'sessionStorage') => {
    const idx = sess === defaultSession ? 'shared' : `iso-${Array.from(partitions.entries()).find(([, v]) => v === sess)?.[0] ?? 'x'}`;
    const key = `${idx}:${origin}:${kind}`;
    let m = webStorageMap.get(key);
    if (!m) {
      m = new Map();
      webStorageMap.set(key, m);
    }
    return m;
  };

  class FakeWebContents extends EventEmitter {
    readonly id = nextWcId++;
    readonly debugger = new FakeDebugger();
    readonly session: FakeSession;
    destroyed = false;
    loading = false;
    zoomFactor = 1;
    history: string[] = [];
    historyIdx = -1;
    domSelectors = new Set<string>();
    bodyText = '';
    reloadCalls = 0;
    reloadIgnoringCacheCalls = 0;
    mainFrame = { origin: 'null' };
    navigationHistory = {
      canGoBack: () => this.historyIdx > 0,
      canGoForward: () => this.historyIdx < this.history.length - 1,
      getActiveIndex: () => this.historyIdx,
      length: () => this.history.length,
      getEntryAtIndex: (index: number) => {
        const u = this.history[index];
        return u !== undefined ? { url: u, title: u } : null;
      },
      removeEntryAtIndex: (index: number) => {
        if (index < 0 || index >= this.history.length || index === this.historyIdx) {
          return false;
        }
        this.history.splice(index, 1);
        if (index < this.historyIdx) {
          this.historyIdx -= 1;
        }
        return true;
      },
      goBack: () => {
        if (this.historyIdx > 0) {
          this.historyIdx -= 1;
          this.emit('did-navigate', {}, this.getURL());
          this.emit('did-finish-load');
        }
      },
      goForward: () => {
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx += 1;
          this.emit('did-navigate', {}, this.getURL());
          this.emit('did-finish-load');
        }
      },
    };

    constructor(partition?: string) {
      super();
      this.session = getSession(partition);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isLoading() {
      return this.loading;
    }
    isCurrentlyAudible() {
      return false;
    }
    getURL() {
      return this.history[this.historyIdx] ?? '';
    }
    getOSProcessId() {
      return 4000 + this.id;
    }
    setZoomFactor(f: number) {
      this.zoomFactor = f;
    }
    getZoomFactor() {
      return this.zoomFactor;
    }
    setBackgroundThrottling(_allowed: boolean) {}
    setAudioMuted(_m: boolean) {}
    setWindowOpenHandler(_fn: unknown) {}
    async loadURL(url: string) {
      this.history = this.history.slice(0, this.historyIdx + 1);
      this.history.push(url);
      this.historyIdx = this.history.length - 1;
      try {
        const u = new URL(url);
        this.mainFrame = { origin: u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : 'null' };
      } catch {
        this.mainFrame = { origin: 'null' };
      }
      this.emit('did-navigate', {}, url);
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
    reload() {
      this.reloadCalls += 1;
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
    reloadIgnoringCache() {
      this.reloadIgnoringCacheCalls += 1;
      this.emit('did-finish-load');
      this.emit('did-stop-loading');
    }
    async executeJavaScript(script: string) {
      const url = this.getURL();
      const origin = url.startsWith('http://') || url.startsWith('https://') ? new URL(url).origin : 'null';
      if (script.includes('document.querySelector')) {
        const selMatch = script.match(/const sel = ("[^"]+"|null)/);
        const txtMatch = script.match(/const txt = ("[^"]+"|null)/);
        const sel = selMatch ? (JSON.parse(selMatch[1]!) as string | null) : null;
        const txt = txtMatch ? (JSON.parse(txtMatch[1]!) as string | null) : null;
        if (sel && !this.domSelectors.has(sel)) return false;
        if (txt && !this.bodyText.includes(txt)) return false;
        return true;
      }
      if (script.includes('window.location.origin')) {
        if (origin === 'null') return { opaque: true, data: {} };
        const kindMatch = script.match(/window\[("(?:localStorage|sessionStorage)")\]/);
        const actMatch = script.match(/const act = ("[^"]+")/);
        const keyMatch = script.match(/const key = ("[^"]+"|null)/);
        const valMatch = script.match(/const val = ("[^"]*")/);
        const kind = JSON.parse(kindMatch![1]!) as 'localStorage' | 'sessionStorage';
        const act = JSON.parse(actMatch![1]!) as string;
        const key = JSON.parse(keyMatch![1]!) as string | null;
        const val = JSON.parse(valMatch![1]!) as string;
        const store = getWebStore(this.session, origin, kind);
        if (act === 'get') {
          if (key !== null) {
            const v = store.get(key) ?? null;
            return { data: v !== null ? { [key]: v } : {}, value: v };
          }
          return { data: Object.fromEntries(store.entries()) };
        }
        if (act === 'set' && key !== null) {
          store.set(key, val);
          return { data: { [key]: val }, value: val };
        }
        if (act === 'remove' && key !== null) {
          store.delete(key);
          return { data: {} };
        }
        if (act === 'clear') {
          store.clear();
          return { data: {} };
        }
      }
      return null;
    }
    setDevToolsWebContents(_wc: unknown) {}
    openDevTools() {}
    closeDevTools() {}
    isDevToolsOpened() {
      return false;
    }
    send(_channel: string, ..._args: unknown[]) {}
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }

  class FakeWebContentsView {
    readonly webContents: FakeWebContents;
    bounds = { x: 0, y: 0, width: 1280, height: 720 };
    constructor(opts?: { webPreferences?: { partition?: string } }) {
      this.webContents = new FakeWebContents(opts?.webPreferences?.partition);
    }
    setVisible() {}
    setBounds(b: { x: number; y: number; width: number; height: number }) {
      this.bounds = b;
    }
    getBounds() {
      return this.bounds;
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    readonly webContents = new FakeWebContents();
    readonly childViews: FakeWebContentsView[] = [];
    readonly contentView = {
      addChildView: (v: FakeWebContentsView) => this.childViews.push(v),
      removeChildView: (v: FakeWebContentsView) => {
        const idx = this.childViews.indexOf(v);
        if (idx !== -1) this.childViews.splice(idx, 1);
      },
    };
    isDestroyed() {
      return false;
    }
    isVisible() {
      return false;
    }
    getContentSize() {
      return [1480, 920];
    }
  }

  const fakeElectron = {
    app: {
      getAppPath: () => APP_ROOT,
      getPath: (k: string) => (k === 'userData' ? os.tmpdir() : os.tmpdir()),
      getAppMetrics: () => [],
    },
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: () => {} },
    ipcMain: new EventEmitter() as EventEmitter & { handle: () => void },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
    session: { defaultSession, fromPartition: (p: string) => getSession(p) },
    WebContentsView: FakeWebContentsView,
  };
  fakeElectron.ipcMain.handle = () => {};

  const loadBundle = async (entryRelPath: string): Promise<Record<string, unknown>> => {
    const fullPath = path.resolve(APP_ROOT, entryRelPath);
    const built = await Bun.build({
      entrypoints: [fullPath],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    if (!built.success || built.outputs.length === 0) {
      throw new Error(`Failed to build ${entryRelPath}: ${built.logs.map((l) => l.message).join('; ')}`);
    }
    const code = await built.outputs[0]!.text();
    const mod = { exports: {} as Record<string, unknown> };
    const localRequire = (spec: string) => {
      if (spec === 'electron') return fakeElectron;
      return nodeRequire(spec);
    };
    const fn = vm.runInNewContext(
      `(function(require, module, exports, __filename, __dirname) {\n${code}\n})`,
      {
        Buffer,
        process,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        console,
        TextEncoder,
        TextDecoder,
      },
    );
    fn(localRequire, mod, mod.exports, fullPath, path.dirname(fullPath));
    return mod.exports;
  };

  const telemetryMod = (await loadBundle('src/main/telemetry.ts')) as {
    TelemetryService: new (...args: unknown[]) => unknown;
  };
  const dbgMod = (await loadBundle('src/main/debugger-coordinator.ts')) as {
    DebuggerCoordinator: new () => unknown;
  };
  const tabMod = (await loadBundle('src/main/tab-manager.ts')) as {
    TabManager: new (...args: unknown[]) => any;
  };
  const ctlMod = (await loadBundle('src/main/ctl-socket.ts')) as {
    ControlSocketServer: new (...args: unknown[]) => any;
  };

  return {
    FakeBrowserWindow,
    FakeWebContents,
    telemetryMod,
    dbgMod,
    tabMod,
    ctlMod,
  };
}

describe('F5 Telemetry Network Idle & ControlSocketServer 6 New Tools', () => {
  test('TelemetryService.getNetworkIdleState ignores WebSocket/EventSource and tracks HTTP in-flight + idleForMs', async () => {
    const env = await loadF5VmEnv();
    let nowMs = 1000;
    const coord = new env.dbgMod.DebuggerCoordinator();
    const wc = new env.FakeWebContents();
    const telemetry = new env.telemetryMod.TelemetryService(
      () => ({ tabId: 'tab-1', portraitWc: null, landscapeWc: wc }),
      (id: number) => id === wc.id,
      () => {},
      coord,
      { now: () => nowMs },
    ) as any;

    try {
      telemetry.attachViewportCollectors('tab-1', 'landscape', wc);

      // Long-lived EventSource and WebSocket must NOT block network idle
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'ws-1',
        type: 'WebSocket',
        request: { method: 'GET', url: 'ws://127.0.0.1:8080/ws' },
      });
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'sse-1',
        type: 'EventSource',
        request: { method: 'GET', url: 'http://127.0.0.1:8080/sse' },
      });
      expect(telemetry.getNetworkIdleState(wc.id, nowMs).inFlightCount).toBe(0);

      // Regular Fetch marks in-flight and resets idleForMs to 0
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'http-1',
        type: 'Fetch',
        request: { method: 'GET', url: 'http://127.0.0.1:8080/api' },
      });
      expect(telemetry.getNetworkIdleState(wc.id, nowMs)).toEqual({
        inFlightCount: 1,
        idleForMs: 0,
      });

      nowMs = 1350;
      wc.debugger.emit('message', {}, 'Network.loadingFinished', {
        requestId: 'http-1',
      });
      expect(telemetry.getNetworkIdleState(wc.id, nowMs)).toEqual({
        inFlightCount: 0,
        idleForMs: 0,
      });

      nowMs = 1850;
      expect(telemetry.getNetworkIdleState(wc.id, nowMs)).toEqual({
        inFlightCount: 0,
        idleForMs: 500,
      });

      // Destroy cleans up tracking maps
      wc.emit('destroyed');
      expect(telemetry.getNetworkIdleState(wc.id, nowMs).inFlightCount).toBe(0);
    } finally {
      telemetry.dispose();
    }
  });

  test('ControlSocketServer dispatches browser_close_tab, browser_select_tab, browser_reload, browser_navigate_history, browser_wait_for, and browser_storage', async () => {
    const env = await loadF5VmEnv();
    const win = new env.FakeBrowserWindow();
    const mgr = new env.tabMod.TabManager(win as never, '/app/mirror-preload.js', () => false);
    const ctl = new env.ctlMod.ControlSocketServer(mgr, '/tmp/unused-f5-test.sock');
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      (ctl as unknown as { dispatch: (m: string, p: Record<string, unknown>) => Promise<any> }).dispatch(
        method,
        params,
      );

    try {
      const t1 = mgr.createTab({ url: 'http://127.0.0.1:4100/one', mode: 'dual', session: 'isolated' });
      const tab1Id = t1.activeTabId!;
      const t2 = mgr.createTab({ url: 'http://127.0.0.1:4100/two', mode: 'single' });
      const tab2Id = t2.activeTabId!;
      await new Promise((r) => setTimeout(r, 10));

      // browser_select_tab
      await expect(rpc('browser_select_tab', { tab_id: 'does-not-exist' })).rejects.toThrow('not found');
      const sel = await rpc('browser_select_tab', { tab_id: tab1Id });
      expect(sel.activeTabId).toBe(tab1Id);

      // browser_reload (ignore_cache=false vs true)
      const l1Wc = mgr.getViewportWebContents(tab1Id, 'landscape');
      await rpc('browser_reload', { tab_id: tab1Id, ignore_cache: false });
      expect(l1Wc.reloadCalls).toBe(1);
      await rpc('browser_reload', { tab_id: tab1Id, ignore_cache: true });
      expect(l1Wc.reloadIgnoringCacheCalls).toBe(1);

      // Fresh tabs primed via about:blank must NOT pollute navigationHistory
      const p1Wc = mgr.getViewportWebContents(tab1Id, 'portrait');
      expect(l1Wc.navigationHistory.canGoBack()).toBe(false);
      expect(p1Wc.navigationHistory.canGoBack()).toBe(false);
      expect(l1Wc.history).toEqual(['http://127.0.0.1:4100/one']);

      // browser_navigate_history at history edge + valid back/forward (without resetting history)
      const l2Wc = mgr.getViewportWebContents(tab2Id, 'landscape');
      await mgr.selectTab(tab2Id);
      expect(l2Wc.navigationHistory.canGoBack()).toBe(false);
      expect(l2Wc.history).toEqual(['http://127.0.0.1:4100/two']);
      const edgeBack = await rpc('browser_navigate_history', { tab_id: tab2Id, direction: 'back' });
      expect(edgeBack.ok).toBe(false);
      expect(edgeBack.canGoBack).toBe(false);
      expect(edgeBack.url).toBe('http://127.0.0.1:4100/two');

      mgr.navigate('http://127.0.0.1:4100/three', tab2Id);
      await new Promise((r) => setTimeout(r, 10));
      const backOk = await rpc('browser_navigate_history', { tab_id: tab2Id, direction: 'back' });
      expect(backOk.ok).toBe(true);
      expect(backOk.canGoForward).toBe(true);
      const fwdOk = await rpc('browser_navigate_history', { tab_id: tab2Id, direction: 'forward' });
      expect(fwdOk.ok).toBe(true);

      // browser_wait_for validation, timeout rejection, and delayed selector/text match
      await expect(rpc('browser_wait_for', { tab_id: tab2Id })).rejects.toThrow('requires at least one');
      await expect(
        rpc('browser_wait_for', {
          tab_id: tab2Id,
          viewport: 'landscape',
          selector: '#never-here',
          timeout_ms: 80,
        }),
      ).rejects.toThrow('Timed out');

      setTimeout(() => {
        l2Wc.domSelectors.add('#async-ready');
        l2Wc.bodyText = 'Async Ready Text';
      }, 40);
      const waited = await rpc('browser_wait_for', {
        tab_id: tab2Id,
        viewport: 'landscape',
        selector: '#async-ready',
        text: 'Async Ready Text',
        url_includes: '/three',
        timeout_ms: 1500,
      });
      expect(waited.ok).toBe(true);
      expect(waited.matched).toBe(true);

      // browser_storage: invalid scope, cookies, localStorage/sessionStorage, isolated vs shared, opaque about:blank
      await expect(
        rpc('browser_storage', { tab_id: tab1Id, action: 'get', scope: 'indexeddb_invalid' }),
      ).rejects.toThrow('browser_storage scope');

      await rpc('browser_storage', {
        tab_id: tab1Id,
        viewport: 'landscape',
        action: 'set',
        scope: 'localStorage',
        key: 'iso_key',
        value: 'iso_val',
      });
      const isoLand = await rpc('browser_storage', {
        tab_id: tab1Id,
        viewport: 'landscape',
        action: 'get',
        scope: 'localStorage',
        key: 'iso_key',
      });
      expect(isoLand.value).toBe('iso_val');
      const isoPort = await rpc('browser_storage', {
        tab_id: tab1Id,
        viewport: 'portrait',
        action: 'get',
        scope: 'localStorage',
        key: 'iso_key',
      });
      expect(isoPort.value).toBeNull();

      await rpc('browser_storage', {
        tab_id: tab2Id,
        viewport: 'landscape',
        action: 'set',
        scope: 'cookies',
        name: 'session_tok',
        value: 'abc123',
        url: 'http://127.0.0.1:4100/three',
      });
      const gotCookies = await rpc('browser_storage', {
        tab_id: tab2Id,
        viewport: 'landscape',
        action: 'get',
        scope: 'cookies',
        url: 'http://127.0.0.1:4100/three',
      });
      expect(gotCookies.cookies.some((c: any) => c.name === 'session_tok' && c.value === 'abc123')).toBe(true);

      // Opaque origin about:blank handles get(scope=all) cleanly without throwing
      const blankTab = mgr.createTab({ url: 'about:blank', mode: 'single' });
      await new Promise((r) => setTimeout(r, 10));
      const blankRes = await rpc('browser_storage', {
        tab_id: blankTab.activeTabId!,
        viewport: 'landscape',
        action: 'get',
        scope: 'all',
      });
      expect(blankRes.ok).toBe(true);
      expect(blankRes.localStorage).toEqual({});

      // Explicit about:blank tab keeps about:blank in history when subsequently navigated
      mgr.navigate('http://127.0.0.1:4100/from-blank', blankTab.activeTabId!);
      await new Promise((r) => setTimeout(r, 10));
      const backToExplicitBlank = await rpc('browser_navigate_history', {
        tab_id: blankTab.activeTabId!,
        direction: 'back',
      });
      expect(backToExplicitBlank.ok).toBe(true);
      expect(backToExplicitBlank.url).toBe('about:blank');

      // browser_close_tab closes tab and falls back cleanly when closing last tab
      await rpc('browser_close_tab', { tab_id: tab2Id });
      await rpc('browser_close_tab', { tab_id: tab1Id });
      const lastClose = await rpc('browser_close_tab', { tab_id: blankTab.activeTabId! });
      expect(lastClose.tabs.length).toBeGreaterThanOrEqual(1);
    } finally {
      ctl.close();
      mgr.dispose();
    }
  });

  test('F12 browser_close_tab bulk/session cleanup, browser_open background, hidden single-mode metrics override, and browser_metrics tab_id', async () => {
    const env = await loadF5VmEnv();
    const win = new env.FakeBrowserWindow();
    const mgr = new env.tabMod.TabManager(win as never, '/app/mirror-preload.js', () => false);
    const ctl = new env.ctlMod.ControlSocketServer(mgr, '/tmp/unused-f12-test.sock');
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      (ctl as unknown as { dispatch: (m: string, p: Record<string, unknown>) => Promise<any> }).dispatch(
        method,
        params,
      );

    try {
      // Owner shared active tab
      const ownerOpen = await rpc('browser_open', {
        url: 'http://127.0.0.1:4100/owner',
        mode: 'dual',
        session: 'shared',
      });
      const ownerId = ownerOpen.tab.id as string;
      expect(ownerOpen.activeTabId).toBe(ownerId);

      // Validation rejections on browser_open & browser_metrics & browser_close_tab
      await expect(
        rpc('browser_open', { url: 'http://127.0.0.1:4100/x', background: 'yes' }),
      ).rejects.toThrow('background must be a boolean');
      await expect(
        rpc('browser_open', { url: 'http://127.0.0.1:4100/x', extra: true }),
      ).rejects.toThrow("unknown property 'extra' for browser_open");
      await expect(
        rpc('browser_open', {
          url: 'http://127.0.0.1:4100/x',
          portrait_size: { width: 390, height: 844, extra: 1 },
        }),
      ).rejects.toThrow("unknown property 'extra' for browser_open.portrait_size");
      await expect(
        rpc('browser_open', {
          url: 'http://127.0.0.1:4100/x',
          landscape_size: { width: 1280, height: 720, extra: 1 },
        }),
      ).rejects.toThrow("unknown property 'extra' for browser_open.landscape_size");
      await expect(rpc('browser_metrics', { tab_id: '' })).rejects.toThrow('non-empty string');
      await expect(rpc('browser_metrics', { extra: true })).rejects.toThrow(
        "unknown property 'extra' for browser_metrics",
      );
      await expect(rpc('browser_metrics', { tab_id: 'missing-tab' })).rejects.toThrow('not found');
      await expect(rpc('browser_close_tab', { foo: 1 })).rejects.toThrow(
        "unknown property 'foo' for browser_close_tab",
      );
      await expect(rpc('browser_close_tab', { tabId: ownerId })).rejects.toThrow(
        "unknown property 'tabId' for browser_close_tab",
      );
      expect(mgr.getShellState().activeTabId).toBe(ownerId);
      expect(mgr.getShellState().tabs.map((t: { id: string }) => t.id)).toEqual([ownerId]);
      await expect(rpc('browser_close_tab', { session: 'isolated' })).rejects.toThrow(
        'session filter requires all=true',
      );
      await expect(rpc('browser_close_tab', { session: 'shared', all: false })).rejects.toThrow(
        'session filter requires all=true',
      );
      await expect(
        rpc('browser_close_tab', { tab_id: ownerId, all: true }),
      ).rejects.toThrow('cannot be combined');
      await expect(
        rpc('browser_close_tab', { tab_id: ownerId, session: 'isolated' }),
      ).rejects.toThrow('cannot be combined');
      await expect(
        rpc('browser_close_tab', { session: 'bogus', all: true }),
      ).rejects.toThrow("session must be 'isolated' or 'shared'");
      await expect(rpc('browser_close_tab', { all: 'true' })).rejects.toThrow('all must be a boolean');
      await expect(rpc('browser_close_tab', { tab_id: '   ' })).rejects.toThrow(
        'tab_id must be a non-empty string',
      );

      // Empty-match no-op when 0 isolated tabs exist
      const noopClose = await rpc('browser_close_tab', { session: 'isolated', all: true });
      expect(noopClose.ok).toBe(true);
      expect(noopClose.closedTabId).toBeNull();
      expect(noopClose.closedTabIds).toEqual([]);
      expect(noopClose.closedCount).toBe(0);
      expect(noopClose.activeTabId).toBe(ownerId);
      expect(noopClose.tabs.length).toBe(1);

      // Background dual isolated tab preserves owner activeTabId and returns created tab
      const bgDual = await rpc('browser_open', {
        url: 'http://127.0.0.1:4100/bg-dual',
        mode: 'dual',
        session: 'isolated',
        background: true,
      });
      const bgDualId = bgDual.tab.id as string;
      expect(bgDualId).not.toBe(ownerId);
      expect(bgDual.activeTabId).toBe(ownerId);
      expect(bgDual.tab.session).toBe('isolated');
      expect(bgDual.tab.mode).toBe('dual');

      // Background single isolated tab preserves activeTabId and applies DeviceMetricsOverride (never clear on hidden)
      const bgSingle = await rpc('browser_open', {
        url: 'http://127.0.0.1:4100/bg-single',
        mode: 'single',
        session: 'isolated',
        background: true,
      });
      const bgSingleId = bgSingle.tab.id as string;
      expect(bgSingleId).not.toBe(ownerId);
      expect(bgSingle.activeTabId).toBe(ownerId);
      expect(bgSingle.tab.mode).toBe('single');
      await new Promise((r) => setTimeout(r, 20));

      const bgSingleWc = mgr.getViewportWebContents(bgSingleId, 'landscape');
      const setCalls = bgSingleWc.debugger.commands.filter(
        (c: { method: string }) => c.method === 'Emulation.setDeviceMetricsOverride',
      );
      expect(setCalls.length).toBeGreaterThanOrEqual(1);
      const lastSet = setCalls[setCalls.length - 1]!.params as { width: number; height: number };
      expect(lastSet.width).toBeGreaterThan(0);
      expect(lastSet.height).toBeGreaterThan(0);

      // Promoting background single tab via browser_select_tab clears temporary DeviceMetricsOverride
      const preClearCount = bgSingleWc.debugger.commands.filter(
        (c: { method: string }) => c.method === 'Emulation.clearDeviceMetricsOverride',
      ).length;
      await rpc('browser_select_tab', { tab_id: bgSingleId });
      await new Promise((r) => setTimeout(r, 20));
      const postClearCount = bgSingleWc.debugger.commands.filter(
        (c: { method: string }) => c.method === 'Emulation.clearDeviceMetricsOverride',
      ).length;
      expect(postClearCount).toBeGreaterThan(preClearCount);

      // Switch back to owner shared tab, then verify browser_metrics({ tab_id }) is non-destructive
      await rpc('browser_select_tab', { tab_id: ownerId });
      await new Promise((r) => setTimeout(r, 15));
      const beforeActiveSnap = await rpc('browser_metrics', {});
      expect(beforeActiveSnap.portrait).not.toBeNull();
      expect(beforeActiveSnap.landscape).not.toBeNull();

      // Inject an isolated console error on bgSingle via CDP so we can verify tab-scoped metrics counts
      bgSingleWc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ value: 'bg-only-error' }],
      });

      let sentTelemetryForBg = false;
      const origWcSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel: string, ...args: unknown[]) => {
        if (channel === 'shell:telemetry') sentTelemetryForBg = true;
        return origWcSend(channel, ...args);
      };
      const bgMetrics = await rpc('browser_metrics', { tab_id: bgSingleId });
      expect(bgMetrics.tabId).toBe(bgSingleId);
      expect(bgMetrics.portrait).toBeNull();
      expect(bgMetrics.landscape).not.toBeNull();
      expect(bgMetrics.consoleErrorCount).toBe(1);
      expect(sentTelemetryForBg).toBe(false);
      // Active dual tab's lastSnapshot must remain intact (not overwritten by background single-mode tab)
      expect(mgr.telemetry.getLatestSnapshot().portrait).not.toBeNull();
      expect(mgr.telemetry.getLatestSnapshot().consoleErrorCount).toBe(0);

      // Sleeping tab rejected cleanly by browser_metrics
      mgr.sleepTab(bgDualId);
      await expect(rpc('browser_metrics', { tab_id: bgDualId })).rejects.toThrow('sleeping');

      // Bulk close isolated tabs leaves owner shared tab & activeTabId untouched
      const isoClose = await rpc('browser_close_tab', { session: 'isolated', all: true });
      expect(isoClose.ok).toBe(true);
      expect(isoClose.closedTabId).toBeNull();
      expect(isoClose.closedTabIds).toEqual([bgDualId, bgSingleId]);
      expect(isoClose.closedCount).toBe(2);
      expect(isoClose.activeTabId).toBe(ownerId);
      expect(isoClose.tabs.map((t: { id: string }) => t.id)).toEqual([ownerId]);

      // Single-tab close returns closedTabIds + closedCount=1 + fallback tab when last
      const sharedOpen2 = await rpc('browser_open', {
        url: 'http://127.0.0.1:4100/shared-2',
        mode: 'dual',
        session: 'shared',
        background: true,
      });
      const shared2Id = sharedOpen2.tab.id as string;
      const singleClose = await rpc('browser_close_tab', { tab_id: shared2Id });
      expect(singleClose.closedTabId).toBe(shared2Id);
      expect(singleClose.closedTabIds).toEqual([shared2Id]);
      expect(singleClose.closedCount).toBe(1);
      expect(singleClose.activeTabId).toBe(ownerId);

      // Closing all shared tabs creates one fallback dual tab
      const allClose = await rpc('browser_close_tab', { session: 'shared', all: true });
      expect(allClose.ok).toBe(true);
      expect(allClose.closedTabIds).toEqual([ownerId]);
      expect(allClose.closedCount).toBe(1);
      expect(allClose.closedTabId).toBe(ownerId);
      expect(allClose.tabs.length).toBe(1);
      expect(allClose.activeTabId).toBe(allClose.tabs[0].id);
      expect(allClose.activeTabId).not.toBe(ownerId);

      // Add another tab and test { all: true } closes everything and spawns 1 fallback dual tab
      await rpc('browser_open', {
        url: 'http://127.0.0.1:4100/extra',
        mode: 'single',
        session: 'isolated',
      });
      expect(mgr.getShellState().tabs.length).toBe(2);
      const nukeAll = await rpc('browser_close_tab', { all: true });
      expect(nukeAll.closedCount).toBe(2);
      expect(nukeAll.closedTabId).toBeNull();
      expect(nukeAll.tabs.length).toBe(1);
      expect(nukeAll.tabs[0].mode).toBe('dual');
      expect(nukeAll.tabs[0].session).toBe('shared');
    } finally {
      ctl.close();
      mgr.dispose();
    }
  });
});
