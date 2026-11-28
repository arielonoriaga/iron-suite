import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  historyEquals,
  mountShell,
  renderHistory,
  renderMirrorMiss,
  renderState,
  renderTelemetry,
  sanitizeMirrorMissLabel,
} from '../src/renderer/shell';
import type {
  DevicePreset,
  IronShellApi,
  MirrorMissInfo,
  ShellState,
  TelemetrySnapshot,
} from '../src/shared/types';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const nodeRequire = createRequire(import.meta.url);
const testTempUserDataDirs: string[] = [];

afterAll(() => {
  for (const dir of testTempUserDataDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Self-contained minimal DOM test harness (for src/renderer/shell.ts)
// ---------------------------------------------------------------------------

class FakeClassList {
  private readonly set = new Set<string>();
  constructor(initial: string[] = []) {
    for (const c of initial) {
      if (c) this.set.add(c);
    }
  }
  add(...tokens: string[]): void {
    for (const t of tokens) this.set.add(t);
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
  }
  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(token);
      return true;
    }
    if (force === false) {
      this.set.delete(token);
      return false;
    }
    if (this.set.has(token)) {
      this.set.delete(token);
      return false;
    }
    this.set.add(token);
    return true;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
}

class FakeElement {
  id = '';
  className = '';
  classList = new FakeClassList();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  value = '';
  label = '';
  title = '';
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  innerHtmlWrites = 0;
  private _innerHTML = '';
  private _textContent = '';
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(public readonly tagName: string) {}

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this.innerHtmlWrites += 1;
    this._innerHTML = String(val);
    if (val === '') {
      this.children = [];
    }
  }

  get textContent(): string {
    return this._textContent;
  }

  set textContent(val: string) {
    this._textContent = String(val);
  }

  append(...nodes: FakeElement[]): void {
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  appendChild(node: FakeElement): FakeElement {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  setAttribute(name: string, val: string): void {
    this.attributes[name] = String(val);
  }

  getBoundingClientRect() {
    return { left: 10, top: 10, right: 40, bottom: 36, width: 30, height: 26 };
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    this.listeners.set(
      type,
      arr.filter((item) => item !== fn),
    );
  }

  dispatchEvent(ev: { type: string; [k: string]: unknown }): void {
    const arr = this.listeners.get(ev.type) ?? [];
    for (const fn of [...arr]) {
      fn({
        preventDefault: () => {},
        stopPropagation: () => {},
        ...ev,
      });
    }
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent({ type: 'click' });
  }

  focus(): void {}
  select(): void {}
  blur(): void {}
  setPointerCapture(_id: number): void {}
}

class FakeDocument {
  documentElement = new FakeElement('html');
  activeElement: FakeElement | null = null;
  defaultView = {
    innerWidth: 1480,
    innerHeight: 920,
    addEventListener: (_type: string, _fn: unknown) => {},
  };
  private readonly elementsById = new Map<string, FakeElement>();

  constructor() {
    const ids: Array<[string, string, string[]?]> = [
      ['shell-root', 'div'],
      ['top-bar', 'header'],
      ['zen-rail', 'aside'],
      ['tab-list', 'div'],
      ['portrait-header', 'div'],
      ['split-divider', 'div'],
      ['landscape-header', 'div'],
      ['landscape-tag', 'span'],
      ['telemetry-bar', 'div'],
      ['dock-resize-handle', 'div'],
      ['devtools-header', 'div'],
      ['url-form', 'form'],
      ['url-input', 'input'],
      ['url-history-list', 'datalist'],
      ['btn-rail', 'button'],
      ['btn-back', 'button'],
      ['btn-forward', 'button'],
      ['btn-reload', 'button'],
      ['btn-history', 'button'],
      ['history-section', 'div', ['hidden']],
      ['history-list', 'div'],
      ['btn-clear-history', 'button'],
      ['btn-dual', 'button'],
      ['lbl-dual', 'span'],
      ['btn-mirror', 'button'],
      ['lbl-mirror', 'span'],
      ['btn-session', 'button'],
      ['lbl-session', 'span'],
      ['btn-dedup', 'button'],
      ['lbl-dedup', 'span'],
      ['btn-eco', 'button'],
      ['lbl-eco', 'span'],
      ['btn-auto-sleep', 'button'],
      ['lbl-auto-sleep', 'span'],
      ['btn-theme', 'button'],
      ['btn-new-tab', 'button'],
      ['select-portrait-preset', 'select'],
      ['select-landscape-preset', 'select'],
      ['btn-audio-portrait', 'button'],
      ['btn-audio-landscape', 'button'],
      ['portrait-fps', 'span'],
      ['landscape-fps', 'span'],
      ['m-gpu', 'span'],
      ['m-port', 'span'],
      ['m-land', 'span'],
      ['m-ram', 'span'],
      ['m-frame', 'span'],
      ['m-heap', 'span'],
      ['m-dom', 'span'],
      ['m-dedup', 'span'],
      ['sparkline-line', 'polyline'],
      ['pill-emulation', 'button', ['hidden']],
      ['emu-pill-label', 'span'],
      ['pill-mirror-miss', 'button', ['hidden']],
      ['mirror-miss-label', 'span'],
      ['pill-console', 'button'],
      ['err-console-count', 'span'],
      ['pill-network', 'button'],
      ['err-network-count', 'span'],
      ['btn-dock-toggle', 'button'],
      ['dt-target-portrait', 'button'],
      ['dt-target-landscape', 'button'],
      ['load-error-banner', 'div', ['hidden']],
      ['load-error-text', 'span'],
      ['btn-retry-load', 'button'],
      ['btn-dismiss-error', 'button'],
      ['find-bar', 'div', ['hidden']],
      ['find-input', 'input'],
      ['find-count', 'span'],
      ['find-prev', 'button'],
      ['find-next', 'button'],
      ['find-close', 'button'],
      ['btn-zoom-out', 'button'],
      ['btn-zoom-reset', 'button'],
      ['btn-zoom-in', 'button'],
      ['download-toast', 'span', ['hidden']],
    ];
    for (const [id, tag, classes] of ids) {
      const el = new FakeElement(tag);
      el.id = id;
      if (classes) {
        el.classList = new FakeClassList(classes);
      }
      this.elementsById.set(id, el);
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.elementsById.get(id) ?? null;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  private readonly docListeners = new Map<string, Array<(ev: unknown) => void>>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const arr = this.docListeners.get(type) ?? [];
    arr.push(fn);
    this.docListeners.set(type, arr);
  }
  dispatchEvent(ev: { type: string; [k: string]: unknown }): void {
    const arr = this.docListeners.get(ev.type) ?? [];
    for (const fn of [...arr]) {
      fn({
        preventDefault: () => {},
        stopPropagation: () => {},
        ...ev,
      });
    }
  }
}

function makeSampleState(overrides: Partial<ShellState> = {}): ShellState {
  return {
    tabs: [
      {
        id: 'tab-1',
        title: 'App',
        url: 'https://app.test/',
        mode: 'dual',
        mirror: true,
        dedup: true,
        session: 'shared',
        sleeping: false,
        portraitPresetId: 'iphone-15',
        landscapePresetId: 'desktop-hd',
        portraitSize: { width: 390, height: 844, dpr: 3 },
        landscapeSize: { width: 1280, height: 720, dpr: 1 },
        canGoBack: false,
        canGoForward: false,
        loading: false,
        devtoolsTarget: 'portrait',
        audioSource: 'landscape',
        dedupCount: 0,
      },
    ],
    activeTabId: 'tab-1',
    railCollapsed: false,
    dockOpen: false,
    dockHeight: 290,
    splitRatio: 0.34,
    theme: 'dark',
    ecoMode: true,
    autoSleep: false,
    mirrorMiss: null,
    history: [
      { url: 'https://app.test/', title: 'App', visitedAt: 1000, visitCount: 1 },
      { url: 'https://docs.test/guide', title: 'Guide', visitedAt: 900, visitCount: 1 },
    ],
    closedTabCount: 0,
    ...overrides,
  };
}

function makeFakeShellApi(initialState: ShellState) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let stateListener: ((s: ShellState) => void) | null = null;
  let telemetryListener: ((t: TelemetrySnapshot) => void) | null = null;
  const presets: DevicePreset[] = [
    { id: 'iphone-15', label: 'iPhone 15', width: 390, height: 844, dpr: 3, touch: true, category: 'portrait' },
    { id: 'desktop-hd', label: 'Desktop HD', width: 1280, height: 720, dpr: 1, touch: false, category: 'landscape' },
  ];

  const api: IronShellApi = {
    getInitialState: async () => ({ state: initialState, presets }),
    newTab: async (url, mode) => {
      calls.push({ method: 'newTab', args: [url, mode] });
      return initialState;
    },
    closeTab: async (tabId) => {
      calls.push({ method: 'closeTab', args: [tabId] });
      return initialState;
    },
    selectTab: async (tabId) => {
      calls.push({ method: 'selectTab', args: [tabId] });
      return initialState;
    },
    sleepTab: async (tabId) => {
      calls.push({ method: 'sleepTab', args: [tabId] });
      return initialState;
    },
    navigate: async (url) => {
      calls.push({ method: 'navigate', args: [url] });
      return initialState;
    },
    goBack: async () => {
      calls.push({ method: 'goBack', args: [] });
    },
    goForward: async () => {
      calls.push({ method: 'goForward', args: [] });
    },
    reload: async () => {
      calls.push({ method: 'reload', args: [] });
    },
    toggleDualMode: async () => {
      calls.push({ method: 'toggleDualMode', args: [] });
      return initialState;
    },
    toggleMirror: async () => {
      calls.push({ method: 'toggleMirror', args: [] });
      return initialState;
    },
    toggleDedup: async (tabId) => {
      calls.push({ method: 'toggleDedup', args: [tabId] });
      return initialState;
    },
    toggleSessionMode: async () => {
      calls.push({ method: 'toggleSessionMode', args: [] });
      return initialState;
    },
    setSessionMode: async (mode) => {
      calls.push({ method: 'setSessionMode', args: [mode] });
      return initialState;
    },
    setPreset: async (role, presetId) => {
      calls.push({ method: 'setPreset', args: [role, presetId] });
      return initialState;
    },
    setEmulationProfile: async (profile, viewport, tabId) => {
      calls.push({ method: 'setEmulationProfile', args: [profile, viewport, tabId] });
      return initialState;
    },
    setRailCollapsed: async (collapsed) => {
      calls.push({ method: 'setRailCollapsed', args: [collapsed] });
      return initialState;
    },
    setDockOpen: async (open) => {
      calls.push({ method: 'setDockOpen', args: [open] });
      return initialState;
    },
    setDockHeight: async (height) => {
      calls.push({ method: 'setDockHeight', args: [height] });
      return initialState;
    },
    setSplitRatio: async (ratio) => {
      calls.push({ method: 'setSplitRatio', args: [ratio] });
      return initialState;
    },
    setDevToolsTarget: async (role) => {
      calls.push({ method: 'setDevToolsTarget', args: [role] });
      return initialState;
    },
    toggleAudio: async (role) => {
      calls.push({ method: 'toggleAudio', args: [role] });
      return initialState;
    },
    setTheme: async (theme) => {
      calls.push({ method: 'setTheme', args: [theme] });
      return initialState;
    },
    toggleEcoMode: async () => {
      calls.push({ method: 'toggleEcoMode', args: [] });
      return initialState;
    },
    setAutoSleep: async (enabled) => {
      calls.push({ method: 'setAutoSleep', args: [enabled] });
      return initialState;
    },
    copyMirrorMissDebug: async () => {
      calls.push({ method: 'copyMirrorMissDebug', args: [] });
      return true;
    },
    focusAnomaly: async (kind) => {
      calls.push({ method: 'focusAnomaly', args: [kind] });
      return initialState;
    },
    openHistoryMenu: async (x, y) => {
      calls.push({ method: 'openHistoryMenu', args: [x, y] });
    },
    removeHistoryItem: async (url) => {
      calls.push({ method: 'removeHistoryItem', args: [url] });
      return initialState;
    },
    clearHistory: async () => {
      calls.push({ method: 'clearHistory', args: [] });
      return initialState;
    },
    reopenClosedTab: async () => {
      calls.push({ method: 'reopenClosedTab', args: [] });
      return initialState;
    },
    onStateUpdate: (cb) => {
      stateListener = cb;
      return () => {
        stateListener = null;
      };
    },
    onTelemetry: (cb) => {
      telemetryListener = cb;
      return () => {
        telemetryListener = null;
      };
    },
    onFocusUrlBar: () => () => {},
  };

  return {
    api,
    calls,
    emitState: (s: ShellState) => stateListener?.(s),
    emitTelemetry: (t: TelemetrySnapshot) => telemetryListener?.(t),
  };
}

// ---------------------------------------------------------------------------
// Isolated CJS Bundle Runner (no global mock.module('electron', ...) needed)
// ---------------------------------------------------------------------------

async function loadInIsolatedElectronVm(entryRelPath: string) {
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

  let nextWcId = 700;
  let lastMenuTemplate: Array<{ label?: string; click?: () => void }> = [];
  const clipboardWrites: string[] = [];
  const ipcHandles = new Map<string, (ev: unknown, args: unknown) => unknown>();

  class FakeDebugger extends EventEmitter {
    attached = false;
    commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    commandHandler?: (method: string, params?: Record<string, unknown>) => unknown;

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
      if (this.commandHandler) return await this.commandHandler(method, params);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: `script-${this.commands.length}` };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame-1' } } };
      }
      if (method === 'Performance.getMetrics') {
        return { metrics: [] };
      }
      return {};
    }
  }

  class FakeSession extends EventEmitter {
    clearCacheCalls = 0;
    async clearCache(): Promise<void> {
      this.clearCacheCalls += 1;
    }
    async clearStorageData(): Promise<void> {}
  }

  const defaultSession = new FakeSession();

  class FakeWebContents extends EventEmitter {
    readonly id = nextWcId++;
    readonly debugger = new FakeDebugger();
    readonly session = defaultSession;
    destroyed = false;
    loading = false;
    zoomFactor = 1;
    currentUrl = 'about:blank';
    mainFrame: { origin: string } = { origin: 'null' };
    loadUrlCalls: string[] = [];
    reloadIgnoringCacheCalls = 0;
    backgroundThrottlingValues: boolean[] = [];
    devtoolsOpened = false;
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };

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
      return this.currentUrl;
    }
    getOSProcessId() {
      return 2000 + this.id;
    }
    setZoomFactor(f: number) {
      this.zoomFactor = f;
    }
    getZoomFactor() {
      return this.zoomFactor;
    }
    setBackgroundThrottling(allowed: boolean) {
      this.backgroundThrottlingValues.push(allowed);
    }
    setAudioMuted(_m: boolean) {}
    setWindowOpenHandler(_fn: unknown) {}
    async loadURL(url: string) {
      this.currentUrl = url;
      try {
        const u = new URL(url);
        this.mainFrame = { origin: u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : 'null' };
      } catch {
        this.mainFrame = { origin: 'null' };
      }
      this.loadUrlCalls.push(url);
    }
    reloadIgnoringCache() {
      this.reloadIgnoringCacheCalls += 1;
    }
    setDevToolsWebContents(_wc: unknown) {}
    openDevTools() {
      this.devtoolsOpened = true;
    }
    closeDevTools() {
      this.devtoolsOpened = false;
    }
    isDevToolsOpened() {
      return this.devtoolsOpened;
    }
    send(_ch: string, ..._args: unknown[]) {}
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    visible = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    setVisible(v: boolean) {
      this.visible = v;
    }
    setBounds(b: { x: number; y: number; width: number; height: number }) {
      this.bounds = b;
    }
    getBounds() {
      return this.bounds;
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    readonly webContents = new FakeWebContents();
    readonly sentMessages: Array<{ channel: string; payload: unknown }> = [];
    readonly childViews: FakeWebContentsView[] = [];
    readonly contentView = {
      addChildView: (v: FakeWebContentsView) => this.childViews.push(v),
      removeChildView: (v: FakeWebContentsView) => {
        const idx = this.childViews.indexOf(v);
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
    isDestroyed() {
      return this.destroyed;
    }
    getContentSize() {
      return [1480, 920];
    }
    getBounds() {
      return { x: 0, y: 0, width: 1480, height: 920 };
    }
    isMaximized() {
      return false;
    }
    getNormalBounds() {
      return this.getBounds();
    }
    async loadFile() {}
    destroy() {
      this.destroyed = true;
    }
  }

  class FakeIpcMain extends EventEmitter {
    handle(channel: string, fn: (ev: unknown, args: unknown) => unknown) {
      ipcHandles.set(channel, fn);
    }
  }
  const fakeIpcMain = new FakeIpcMain();

  const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-shell-ui-'));
  testTempUserDataDirs.push(testUserDataDir);

  const fakeElectron = {
    app: {
      getAppPath: () => APP_ROOT,
      getPath: () => testUserDataDir,
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
      writeText: (txt: string) => clipboardWrites.push(txt),
    },
    Menu: {
      buildFromTemplate: (tpl: Array<{ label?: string; click?: () => void }>) => {
        lastMenuTemplate = tpl;
        return { popup: () => {} };
      },
    },
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getAllDisplays: () => [],
    },
    session: {
      defaultSession,
      fromPartition: () => new FakeSession(),
    },
  };

  const mod = { exports: {} as Record<string, unknown> };
  const fakeRequire = (id: string) => {
    if (id === 'electron') return fakeElectron;
    return nodeRequire(id);
  };
  const fn = vm.runInNewContext(`(function(require, module, exports, __filename, __dirname) {\n${code}\n})`, {
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
  });
  fn(fakeRequire, mod, mod.exports, fullPath, path.dirname(fullPath));

  return {
    exports: mod.exports,
    FakeBrowserWindow,
    FakeWebContents,
    FakeIpcMain,
    fakeIpcMain,
    ipcHandles,
    clipboardWrites,
    getLastMenuTemplate: () => lastMenuTemplate,
    defaultSession,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M4B HTML, CSS & Preload Contract', () => {
  test('index.html has Reload tooltip, Dedup/Eco/Auto-Sleep top-bar pills, and Dedup/Mirror-Miss telemetry pills', () => {
    const html = fs.readFileSync(path.join(APP_ROOT, 'src/renderer/index.html'), 'utf8');
    expect(html).toContain('id="btn-reload"');
    expect(html).toContain('Reload (Clear Cache — Ctrl+Shift+R)');
    expect(html).toContain('id="btn-dedup"');
    expect(html).toContain('id="btn-eco"');
    expect(html).toContain('id="btn-auto-sleep"');
    expect(html).toContain('id="m-dedup"');
    expect(html).toContain('id="pill-mirror-miss"');
    expect(html).toContain('id="mirror-miss-label"');
  });

  test('styles.css keeps .top-bar single-row 40px without wrap and defines :disabled/.mirror-miss-pill', () => {
    const css = fs.readFileSync(path.join(APP_ROOT, 'src/renderer/styles.css'), 'utf8');
    expect(css).toContain('height: 40px;');
    expect(css).toContain('flex-wrap: nowrap;');
    expect(css).toContain('.pill-btn:disabled');
    expect(css).toContain('.mirror-miss-pill');
  });

  test('shell-preload.ts unifies IronShellApi from shared/types and exposes M4B IPC methods', async () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'src/preload/shell-preload.ts'), 'utf8');
    expect(src).not.toContain('export interface IronShellApi');
    expect(src).toContain("from '../shared/types'");

    const built = await Bun.build({
      entrypoints: [path.resolve(APP_ROOT, 'src/preload/shell-preload.ts')],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();

    let exposedKey = '';
    let exposedApi: IronShellApi | null = null;
    const invokes: Array<{ channel: string; args: unknown }> = [];
    const fakeElectron = {
      contextBridge: {
        exposeInMainWorld: (key: string, api: IronShellApi) => {
          exposedKey = key;
          exposedApi = api;
        },
      },
      ipcRenderer: {
        invoke: async (channel: string, args?: unknown) => {
          invokes.push({ channel, args });
          return true;
        },
        on: () => {},
        removeListener: () => {},
      },
    };
    const mod = { exports: {} };
    const fn = vm.runInNewContext(`(function(require, module, exports) {\n${code}\n})`, {
      console,
    });
    fn((id: string) => (id === 'electron' ? fakeElectron : nodeRequire(id)), mod, mod.exports);

    expect(exposedKey).toBe('ironShell');
    expect(exposedApi).not.toBeNull();
    await exposedApi!.toggleDedup('tab-9');
    await exposedApi!.toggleDedup();
    await exposedApi!.toggleEcoMode();
    await exposedApi!.setAutoSleep(true);
    await exposedApi!.copyMirrorMissDebug();

    expect(invokes).toEqual([
      { channel: 'shell:toggle-dedup', args: { tabId: 'tab-9' } },
      { channel: 'shell:toggle-dedup', args: undefined },
      { channel: 'shell:toggle-eco-mode', args: undefined },
      { channel: 'shell:set-auto-sleep', args: { enabled: true } },
      { channel: 'shell:copy-mirror-miss-debug', args: undefined },
    ]);
  });
});

describe('M4B Shell UI (shell.ts)', () => {
  test('renders Dedup, Eco/HiDPI, Auto-Sleep, Dedup N counter, and handles click events', async () => {
    const doc = new FakeDocument();
    const initial = makeSampleState();
    const { api, calls } = makeFakeShellApi(initial);

    await mountShell(doc as unknown as Document, api);

    const btnDedup = doc.getElementById('btn-dedup')!;
    const lblDedup = doc.getElementById('lbl-dedup')!;
    const btnEco = doc.getElementById('btn-eco')!;
    const lblEco = doc.getElementById('lbl-eco')!;
    const btnAutoSleep = doc.getElementById('btn-auto-sleep')!;
    const lblAutoSleep = doc.getElementById('lbl-auto-sleep')!;
    const mDedup = doc.getElementById('m-dedup')!;

    // Default: dual + shared + mirror + dedup -> enabled & active
    expect(btnDedup.disabled).toBe(false);
    expect(btnDedup.classList.contains('active')).toBe(true);
    expect(lblDedup.textContent).toBe('Dedup On');
    expect(mDedup.textContent).toBe('0');
    expect(btnEco.classList.contains('active')).toBe(true);
    expect(lblEco.textContent).toBe('Eco');
    expect(btnAutoSleep.classList.contains('active')).toBe(false);
    expect(lblAutoSleep.textContent).toBe('Auto-Sleep');

    // Click handlers invoke new APIs
    btnDedup.click();
    btnEco.click();
    btnAutoSleep.click();
    expect(calls.map((c) => c.method)).toEqual(['toggleDedup', 'toggleEcoMode', 'setAutoSleep']);
    expect(calls[2]!.args).toEqual([true]);

    // Dedup counter + disabled gates across single / isolated / mirror=false / dedup=false
    const tab = initial.tabs[0]!;
    renderState(
      makeSampleState({
        ecoMode: false,
        autoSleep: true,
        tabs: [{ ...tab, dedupCount: 7, mode: 'single' }],
      }),
    );
    expect(btnDedup.disabled).toBe(true);
    expect(lblDedup.textContent).toBe('Dedup Off');
    expect(mDedup.textContent).toBe('7');
    expect(lblEco.textContent).toBe('HiDPI');
    expect(btnEco.classList.contains('active')).toBe(false);
    expect(lblAutoSleep.textContent).toBe('Auto-Sleep On');
    expect(btnAutoSleep.classList.contains('active')).toBe(true);

    renderState(makeSampleState({ tabs: [{ ...tab, session: 'isolated' }] }));
    expect(btnDedup.disabled).toBe(true);

    renderState(makeSampleState({ tabs: [{ ...tab, mirror: false }] }));
    expect(btnDedup.disabled).toBe(true);

    renderState(makeSampleState({ tabs: [{ ...tab, dedup: false }] }));
    expect(btnDedup.disabled).toBe(false);
    expect(btnDedup.classList.contains('active')).toBe(false);
    expect(lblDedup.textContent).toBe('Dedup Off');
  });

  test('Mirror miss pill uses sanitized .textContent (<= 32 chars, no XSS/bidi), hides on null, and copies debug JSON on click', async () => {
    const doc = new FakeDocument();
    const { api, calls, emitTelemetry } = makeFakeShellApi(makeSampleState());
    await mountShell(doc as unknown as Document, api);

    const pill = doc.getElementById('pill-mirror-miss')!;
    const label = doc.getElementById('mirror-miss-label')!;

    expect(pill.classList.contains('hidden')).toBe(true);
    expect(pill.disabled).toBe(true);

    const xssMiss: MirrorMissInfo = {
      reason: 'target_not_found',
      targetLabel: `<script>alert(1)</script>\u202e\u0007${'X'.repeat(50)}`,
      timestamp: Date.now(),
      url: 'https://app.test/login',
    };
    renderMirrorMiss(xssMiss);

    expect(pill.classList.contains('hidden')).toBe(false);
    expect(pill.disabled).toBe(false);
    expect(label.innerHtmlWrites).toBe(0);
    expect(label.textContent.length).toBeLessThanOrEqual(32);
    expect(/[\u0000-\u001f\u202a-\u202e]/.test(label.textContent)).toBe(false);
    expect(sanitizeMirrorMissLabel(xssMiss.targetLabel, 32).length).toBe(32);

    pill.click();
    expect(calls.some((c) => c.method === 'copyMirrorMissDebug')).toBe(true);

    // Telemetry snapshot clearing mirrorMiss hides pill
    emitTelemetry({
      timestampMs: Date.now(),
      gpuCpuPercent: 0,
      gpuMemoryMb: 0,
      totalMemoryMb: 100,
      portrait: null,
      landscape: null,
      consoleErrorCount: 0,
      failedNetworkCount: 0,
      paused: false,
      mirrorMiss: null,
    });
    expect(pill.classList.contains('hidden')).toBe(true);

    // Non-null telemetry mirrorMiss shows pill via renderTelemetry
    renderTelemetry({
      timestampMs: Date.now(),
      gpuCpuPercent: 1.5,
      gpuMemoryMb: 20,
      totalMemoryMb: 120,
      portrait: null,
      landscape: null,
      consoleErrorCount: 0,
      failedNetworkCount: 0,
      paused: false,
      mirrorMiss: { reason: 'target_not_found', targetLabel: 'Submit Btn', timestamp: Date.now() },
    });
    expect(pill.classList.contains('hidden')).toBe(false);
    expect(label.textContent).toBe('Submit Btn');
  });

  test('R5 renderHistory() memoizes by (url, title) and skips DOM rebuild when history is unchanged', async () => {
    const doc = new FakeDocument();
    const state = makeSampleState();
    const { api } = makeFakeShellApi(state);
    await mountShell(doc as unknown as Document, api);

    const urlList = doc.getElementById('url-history-list')!;
    const histList = doc.getElementById('history-list')!;
    const firstRow = histList.children[0];
    const writesAfterBootUrl = urlList.innerHtmlWrites;
    const writesAfterBootHist = histList.innerHtmlWrites;
    expect(histList.children.length).toBe(2);

    // Clone history array with identical (url, title) -> MUST NOT clear/rebuild DOM
    const clonedState = makeSampleState({
      history: state.history.map((h) => ({ ...h, visitedAt: h.visitedAt + 50 })),
    });
    expect(historyEquals(state.history, clonedState.history)).toBe(true);
    renderHistory(clonedState);

    expect(urlList.innerHtmlWrites).toBe(writesAfterBootUrl);
    expect(histList.innerHtmlWrites).toBe(writesAfterBootHist);
    expect(histList.children[0]).toBe(firstRow);

    // Changing title or adding entry MUST rebuild DOM
    const updatedState = makeSampleState({
      history: [
        { url: 'https://new.test/', title: 'New', visitedAt: 2000, visitCount: 1 },
        ...state.history,
      ],
    });
    renderHistory(updatedState);
    expect(histList.innerHtmlWrites).toBe(writesAfterBootHist + 1);
    expect(histList.children.length).toBe(3);
  });

  test('Slow-device emulation pill renders active profile, hides when inactive, and toggles from preset menu', async () => {
    const doc = new FakeDocument();
    const state = makeSampleState();
    const { api, calls } = makeFakeShellApi(state);
    await mountShell(doc as unknown as Document, api);

    const emuPill = doc.getElementById('pill-emulation')!;
    const emuLabel = doc.getElementById('emu-pill-label')!;
    const portraitSelect = doc.getElementById('select-portrait-preset')!;

    // Default: inactive -> hidden
    expect(emuPill.classList.contains('hidden')).toBe(true);
    expect(emuPill.disabled).toBe(true);

    // Selecting emu:sunmi-v2-pro from preset menu invokes setEmulationProfile('sunmi-v2-pro', 'both')
    portraitSelect.value = 'emu:sunmi-v2-pro';
    portraitSelect.dispatchEvent({ type: 'change' });
    expect(portraitSelect.value).toBe('iphone-15');
    expect(calls.some((c) => c.method === 'setEmulationProfile' && c.args[0] === 'sunmi-v2-pro')).toBe(
      true,
    );

    // Render active emulation summary -> shows #pill-emulation
    const tab = state.tabs[0]!;
    renderState(
      makeSampleState({
        tabs: [
          {
            ...tab,
            emulation: {
              active: true,
              profile: 'sunmi-v2-pro',
              label: 'Sunmi V2 Pro · 6× CPU · slow-4g',
              portrait: {
                active: true,
                profile: 'sunmi-v2-pro',
                cpuRate: 6,
                network: {
                  preset: 'slow-4g',
                  offline: false,
                  latencyMs: 150,
                  downloadBytesPerSec: 200_000,
                  uploadBytesPerSec: 93_750,
                },
                presetId: 'sunmi-v2-pro',
                userAgent: 'Android 7.1',
                hardwareConcurrency: 4,
                deviceMemory: 2,
                reducedMotion: false,
                saveData: false,
                targetScore: 18_000,
                lastCalibration: null,
              },
              landscape: {
                active: true,
                profile: 'sunmi-v2-pro',
                cpuRate: 6,
                network: {
                  preset: 'slow-4g',
                  offline: false,
                  latencyMs: 150,
                  downloadBytesPerSec: 200_000,
                  uploadBytesPerSec: 93_750,
                },
                presetId: null,
                userAgent: 'Android 7.1',
                hardwareConcurrency: 4,
                deviceMemory: 2,
                reducedMotion: false,
                saveData: false,
                targetScore: 18_000,
                lastCalibration: null,
              },
            },
          },
        ],
      }),
    );

    expect(emuPill.classList.contains('hidden')).toBe(false);
    expect(emuPill.disabled).toBe(false);
    expect(emuLabel.textContent).toContain('Sunmi V2 Pro');

    // Clicking #pill-emulation resets to 'none'
    emuPill.click();
    expect(
      calls.some((c) => c.method === 'setEmulationProfile' && c.args[0] === 'none'),
    ).toBe(true);
  });
});

describe('M4B Main IPCs (index.ts) & TabManager Wiring', () => {
  test('assertShellSender and registerIpcHandlers validate sender frame and M4B shell:* payloads', async () => {
    const vmEnv = await loadInIsolatedElectronVm('src/main/index.ts');
    const assertShellSender = vmEnv.exports.assertShellSender as (ev: unknown, win: unknown) => void;
    const registerIpcHandlers = vmEnv.exports.registerIpcHandlers as (
      win: unknown,
      mgr: unknown,
      ipc: unknown,
    ) => void;

    const win = new vmEnv.FakeBrowserWindow();
    const mainFrame = win.webContents.mainFrame;
    const subFrame = { origin: 'https://evil.test' };

    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: mainFrame }, win),
    ).not.toThrow();
    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: subFrame }, win),
    ).toThrow();
    expect(() =>
      assertShellSender({ sender: { id: 99999 }, senderFrame: mainFrame }, win),
    ).toThrow();
    win.destroyed = true;
    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: mainFrame }, win),
    ).toThrow();
    win.destroyed = false;

    win.webContents.destroyed = true;
    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: mainFrame }, win),
    ).toThrow();
    win.webContents.destroyed = false;

    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: null }, win),
    ).toThrow();
    const savedMainFrame = win.webContents.mainFrame;
    (win.webContents as { mainFrame: unknown }).mainFrame = null;
    expect(() =>
      assertShellSender({ sender: win.webContents, senderFrame: null }, win),
    ).toThrow();
    (win.webContents as { mainFrame: unknown }).mainFrame = savedMainFrame;
    expect(() =>
      assertShellSender({ sender: null, senderFrame: mainFrame }, win),
    ).toThrow();

    const fakeMgrCalls: string[] = [];
    const fakeMgr = {
      toggleDedup: (tabId?: string) => {
        fakeMgrCalls.push(`toggleDedup:${tabId ?? ''}`);
        return { ok: true };
      },
      toggleEcoMode: () => {
        fakeMgrCalls.push('toggleEcoMode');
        return { ok: true };
      },
      setAutoSleep: (enabled: boolean) => {
        fakeMgrCalls.push(`setAutoSleep:${enabled}`);
        return { ok: true };
      },
      copyMirrorMissDebug: () => {
        fakeMgrCalls.push('copyMirrorMissDebug');
        return true;
      },
      setEmulationProfile: (profile: string, viewport?: string, tabId?: string) => {
        fakeMgrCalls.push(`setEmulationProfile:${profile}:${viewport ?? 'both'}:${tabId ?? ''}`);
        return { ok: true };
      },
    };
    const localHandlers = new Map<string, (ev: unknown, args: unknown) => unknown>();
    registerIpcHandlers(win, fakeMgr, {
      handle: (ch: string, fn: (ev: unknown, args: unknown) => unknown) => {
        localHandlers.set(ch, fn);
      },
    });

    const validEv = { sender: win.webContents, senderFrame: mainFrame };
    expect(localHandlers.get('shell:toggle-dedup')!(validEv, undefined)).toEqual({ ok: true });
    expect(localHandlers.get('shell:toggle-dedup')!(validEv, { tabId: 'tab-2' })).toEqual({ ok: true });
    expect(() => localHandlers.get('shell:toggle-dedup')!(validEv, { tabId: '' })).toThrow();
    expect(() =>
      localHandlers.get('shell:toggle-dedup')!({ sender: win.webContents, senderFrame: subFrame }, undefined),
    ).toThrow();

    expect(localHandlers.get('shell:copy-mirror-miss-debug')!(validEv, undefined)).toBe(true);
    expect(localHandlers.get('shell:toggle-eco-mode')!(validEv, undefined)).toEqual({ ok: true });
    expect(localHandlers.get('shell:set-auto-sleep')!(validEv, { enabled: true })).toEqual({ ok: true });
    expect(() => localHandlers.get('shell:set-auto-sleep')!(validEv, { enabled: 'yes' })).toThrow();
    expect(fakeMgrCalls).toEqual([
      'toggleDedup:',
      'toggleDedup:tab-2',
      'copyMirrorMissDebug',
      'toggleEcoMode',
      'setAutoSleep:true',
    ]);
  });

  test('TabManager wires M2 RequestDedup, M3 WsSseMux, M4A MirrorMiss/redaction, and Bug 1/2/3 fixes', async () => {
    const vmEnv = await loadInIsolatedElectronVm('src/main/tab-manager.ts');
    const TabManager = vmEnv.exports.TabManager as new (
      win: unknown,
      mirrorPreloadPath: string,
      onShortcut: () => boolean,
      onStateDirty?: () => void,
    ) => {
      requestDedup: {
        isViewportEnabled(wcId: number): boolean;
        getActiveSlotCount(): number;
      };
      wsSseMux: {
        getStats(): { activeChannels: number; totalBufferedBytes: number; installedWcIds: number[] };
      };
      createTab(opts?: Record<string, unknown>): ShellState;
      selectTab(tabId: string): ShellState;
      toggleDedup(tabId?: string): ShellState;
      toggleMirror(tabId?: string): ShellState;
      toggleDualMode(tabId?: string): ShellState;
      setSessionMode(mode: 'shared' | 'isolated', tabId?: string): ShellState;
      setDockOpen(open: boolean): ShellState;
      reload(): Promise<void>;
      navigate(url: string, tabId?: string): ShellState;
      onMirrorMiss(tabId: string, info: MirrorMissInfo): void;
      copyMirrorMissDebug(): boolean;
      getTelemetrySnapshot(): TelemetrySnapshot | null;
      getViewportWebContents(tabId: string, role: 'portrait' | 'landscape'): {
        id: number;
        loadUrlCalls: string[];
        reloadIgnoringCacheCalls: number;
        zoomFactor: number;
        debugger: { commands: Array<{ method: string; params?: Record<string, unknown> }>; attached: boolean };
        emit(ev: string, ...args: unknown[]): void;
      } | null;
      getTab(tabId: string): { id: string; dedupCount: number; landscapeScale: number; landscapeView: { getBounds(): { width: number } } | null } | undefined;
      getShellState(): ShellState;
      telemetry: { sampleOnce(): Promise<TelemetrySnapshot> };
      dispose(): void;
    };

    const win = new vmEnv.FakeBrowserWindow();
    let dirtyCount = 0;
    const mgr = new TabManager(win, '/app/mirror-preload.js', () => false, () => {
      dirtyCount += 1;
    });

    try {
      const state = mgr.createTab({ url: 'https://app.test/start', mode: 'dual', session: 'shared' });
      const tabId = state.activeTabId!;
      const lWc = mgr.getViewportWebContents(tabId, 'landscape')!;
      const pWc = mgr.getViewportWebContents(tabId, 'portrait')!;

      // Wait for async syncViewport + loadURL + emulation
      await new Promise((r) => setTimeout(r, 20));
      expect(lWc.loadUrlCalls).toEqual(['https://app.test/start']);
      expect(pWc.loadUrlCalls).toEqual(['https://app.test/start']);

      // M3 WsSseMux installed Page.addScriptToEvaluateOnNewDocument BEFORE loadURL
      const lAddScript = lWc.debugger.commands.find(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument',
      );
      expect(lAddScript).toBeDefined();
      expect(mgr.wsSseMux.getStats().installedWcIds).toContain(lWc.id);

      // M2 RequestDedup enabled when dual + shared + mirror + dedup
      expect(mgr.requestDedup.isViewportEnabled(lWc.id)).toBe(true);
      expect(mgr.requestDedup.isViewportEnabled(pWc.id)).toBe(true);

      // Bug 3: Dual-mode landscapeView applies Emulation.setDeviceMetricsOverride (mobile: false, scale: 1) + zoomFactor
      lWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 15));
      const lOverride = lWc.debugger.commands.find(
        (c) => c.method === 'Emulation.setDeviceMetricsOverride',
      );
      expect(lOverride?.params?.width).toBe(1280);
      expect(lOverride?.params?.height).toBe(720);
      expect(lOverride?.params?.mobile).toBe(false);
      expect(lOverride?.params?.scale).toBe(1);
      expect(lWc.zoomFactor).toBe(1);
      expect(mgr.getTab(tabId)!.landscapeScale).toBe(1);

      // M2 dedupCount increment does NOT trigger onStateDirty (session-state.json untouched)
      const dirtyBefore = dirtyCount;
      // @ts-expect-error accessing internal options callback via requestDedup behavior
      mgr.requestDedup.options.onDedupIncrement?.(lWc.id, 1);
      expect(mgr.getShellState().tabs[0]!.dedupCount).toBe(1);
      expect(dirtyCount).toBe(dirtyBefore);

      // Reload clears dedup slots via beforeReloadHooks (preserving dedupCount) and calls reloadIgnoringCache
      await mgr.reload();
      await new Promise((r) => setTimeout(r, 15));
      expect(lWc.reloadIgnoringCacheCalls).toBe(1);
      expect(mgr.getShellState().tabs[0]!.dedupCount).toBe(1);

      // M4A MirrorMiss updates ShellState + TelemetrySnapshot and copyMirrorMissDebug redacts URL tokens
      mgr.onMirrorMiss(tabId, {
        reason: 'target_not_found',
        targetLabel: 'Pay Now',
        timestamp: 12345,
        url: 'https://user:pass@app.test/checkout?token=secret123#access_token=xyz',
      });
      expect(mgr.getShellState().mirrorMiss?.targetLabel).toBe('Pay Now');
      const snap = await mgr.telemetry.sampleOnce();
      expect(snap.mirrorMiss?.targetLabel).toBe('Pay Now');
      expect(mgr.getTelemetrySnapshot()?.mirrorMiss?.targetLabel).toBe('Pay Now');

      expect(mgr.copyMirrorMissDebug()).toBe(true);
      const copied = vmEnv.clipboardWrites[vmEnv.clipboardWrites.length - 1]!;
      expect(copied).toContain('https://app.test/checkout');
      expect(copied).not.toContain('secret123');
      expect(copied).not.toContain('access_token=xyz');
      expect(copied).not.toContain('user:pass');
      expect(copied).not.toContain('outerHtml');

      // Navigate clears mirrorMiss
      mgr.navigate('https://app.test/next', tabId);
      expect(mgr.getShellState().mirrorMiss).toBeNull();

      // toggleDedup disables Fetch & removes mux script
      const afterToggle = mgr.toggleDedup(tabId);
      expect(afterToggle.tabs[0]!.dedup).toBe(false);
      await new Promise((r) => setTimeout(r, 15));
      expect(mgr.requestDedup.isViewportEnabled(lWc.id)).toBe(false);
      expect(mgr.wsSseMux.getStats().installedWcIds).not.toContain(lWc.id);

      // Re-enable dedup, then test Dual -> Single disables dedup/mux
      mgr.toggleDedup(tabId);
      await new Promise((r) => setTimeout(r, 15));
      expect(mgr.requestDedup.isViewportEnabled(lWc.id)).toBe(true);
      mgr.toggleDualMode(tabId);
      await new Promise((r) => setTimeout(r, 15));
      expect(mgr.requestDedup.isViewportEnabled(lWc.id)).toBe(false);
      expect(mgr.wsSseMux.getStats().installedWcIds).not.toContain(lWc.id);

      // Bug 1: non-active materialized tab gets non-zero bounds in applyLayout()
      const t2State = mgr.createTab({ url: 'https://app.test/tab2', mode: 'dual', activate: false });
      const tab2Id = t2State.tabs[1]!.id;
      const tab2Obj = mgr.getTab(tab2Id)!;
      expect(tab2Obj.landscapeView!.getBounds().width).toBeGreaterThan(0);

      // F-24: Single-mode browser_emulate syncs landscapePresetId/viewportReport, honors setPreset, and preserves portrait throttle across Single->Dual
      const singleMgr = mgr as unknown as {
        createTab(opts: { url: string; mode: 'single' | 'dual'; activate?: boolean }): ShellState;
        emulate(params: Record<string, unknown>): Promise<Record<string, unknown>>;
        setPreset(role: 'portrait' | 'landscape', presetId: string, tabId?: string): ShellState;
        toggleDualMode(tabId?: string): ShellState;
        slowDeviceEmulation: {
          getViewportState(tabId: string, role: 'portrait' | 'landscape'): {
            active: boolean;
            cpuRate: number;
            presetId: string | null;
          };
        };
      };
      const t3State = singleMgr.createTab({ url: 'https://app.test/single', mode: 'single', activate: true });
      const tab3Id = t3State.activeTabId!;
      const l3Wc = mgr.getViewportWebContents(tab3Id, 'landscape')!;
      await new Promise((r) => setTimeout(r, 15));
      l3Wc.emit('did-finish-load');
      l3Wc.emit('did-stop-loading');
      await singleMgr.emulate({ tabId: tab3Id, profile: 'sunmi-v2-pro' });
      const afterSingleEmu = mgr.getShellState().tabs.find((t) => t.id === tab3Id)!;
      expect(afterSingleEmu.landscapePresetId).toBe('sunmi-v2-pro');
      expect(afterSingleEmu.viewportReport?.landscape?.sizeMismatch).toBe(false);

      // Single -> Dual restores landscape desktop preset while keeping portrait active at 6x CPU!
      const afterToDual = singleMgr.toggleDualMode(tab3Id).tabs.find((t) => t.id === tab3Id)!;
      expect(afterToDual.landscapePresetId).toBe('desktop-hd');
      expect(afterToDual.portraitPresetId).toBe('sunmi-v2-pro');
      expect(singleMgr.slowDeviceEmulation.getViewportState(tab3Id, 'portrait').active).toBe(true);
      expect(singleMgr.slowDeviceEmulation.getViewportState(tab3Id, 'portrait').cpuRate).toBe(6);

      const p3Wc = mgr.getViewportWebContents(tab3Id, 'portrait')!;
      await new Promise((r) => setTimeout(r, 15));
      p3Wc.emit('did-finish-load');
      p3Wc.emit('did-stop-loading');

      // Manual setPreset during active emulation is honored and not clobbered on reset
      singleMgr.setPreset('portrait', 'iphone-se', tab3Id);
      await singleMgr.emulate({ tabId: tab3Id, reset: true });
      const afterManualReset = mgr.getShellState().tabs.find((t) => t.id === tab3Id)!;
      expect(afterManualReset.portraitPresetId).toBe('iphone-se');

      // Bug 2: dockOpen: true + dispose() is idempotent and does not reattach debuggers
      mgr.setDockOpen(true);
      mgr.dispose();
      mgr.dispose();
    } finally {
      mgr.dispose();
    }
  });

  test('F4 Shell UI (find bar, error banner, zoom controls, download toast) & TabManager F4 behaviors', async () => {
    // 1. Renderer shell.ts M2 controls
    const doc = new FakeDocument();
    const state0 = makeSampleState();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let findOpenCb: (() => void) | null = null;
    let findResCb: ((res: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean; viewport: 'portrait' | 'landscape' }) => void) | null = null;
    let dlCb: ((ev: { id: string; tabId: string; viewport: 'portrait' | 'landscape'; filename: string; receivedBytes: number; totalBytes: number; state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; savePath?: string | null }) => void) | null = null;

    const { api } = makeFakeShellApi(state0);
    const m2Api: IronShellApi = {
      ...api,
      findInPage: async (text, opts) => {
        calls.push({ method: 'findInPage', args: [text, opts] });
      },
      stopFindInPage: async (action) => {
        calls.push({ method: 'stopFindInPage', args: [action] });
      },
      setFindOpen: async (open) => {
        calls.push({ method: 'setFindOpen', args: [open] });
      },
      zoomIn: async () => {
        calls.push({ method: 'zoomIn', args: [] });
        return makeSampleState({
          tabs: [{ ...state0.tabs[0]!, zoomFactor: 1.1 }],
        });
      },
      zoomOut: async () => {
        calls.push({ method: 'zoomOut', args: [] });
        return makeSampleState({
          tabs: [{ ...state0.tabs[0]!, zoomFactor: 0.9 }],
        });
      },
      zoomReset: async () => {
        calls.push({ method: 'zoomReset', args: [] });
        return makeSampleState({
          tabs: [{ ...state0.tabs[0]!, zoomFactor: 1 }],
        });
      },
      retryLoad: async () => {
        calls.push({ method: 'retryLoad', args: [] });
        return makeSampleState({
          tabs: [{ ...state0.tabs[0]!, loadError: null }],
        });
      },
      dismissLoadError: async () => {
        calls.push({ method: 'dismissLoadError', args: [] });
        return makeSampleState({
          tabs: [{ ...state0.tabs[0]!, loadError: null }],
        });
      },
      onOpenFind: (cb) => {
        findOpenCb = cb;
        return () => {};
      },
      onCloseFind: () => () => {},
      onFindResult: (cb) => {
        findResCb = cb;
        return () => {};
      },
      onDownloadEvent: (cb) => {
        dlCb = cb;
        return () => {};
      },
    };

    await mountShell(doc as unknown as Document, m2Api);

    // Open Find Bar -> type query (findNext: true) -> Next (findNext: false) -> Result -> Escape
    findOpenCb!();
    expect(doc.getElementById('find-bar')!.classList.contains('hidden')).toBe(false);
    const findInput = doc.getElementById('find-input')!;
    findInput.value = 'needle';
    findInput.dispatchEvent({ type: 'input' });
    doc.getElementById('find-next')!.click();
    doc.getElementById('find-prev')!.click();
    findResCb!({ activeMatchOrdinal: 2, matches: 5, finalUpdate: true, viewport: 'landscape' });
    expect(doc.getElementById('find-count')!.textContent).toBe('2 / 5');
    findResCb!({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true, viewport: 'landscape' });
    expect(doc.getElementById('find-count')!.textContent).toBe('0 / 0');

    expect(calls.filter((c) => c.method === 'findInPage')).toEqual([
      { method: 'findInPage', args: ['needle', { forward: true, findNext: true }] },
      { method: 'findInPage', args: ['needle', { forward: true, findNext: false }] },
      { method: 'findInPage', args: ['needle', { forward: false, findNext: false }] },
    ]);

    doc.dispatchEvent({ type: 'keydown', key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    expect(doc.getElementById('find-bar')!.classList.contains('hidden')).toBe(true);
    expect(calls.some((c) => c.method === 'stopFindInPage' && c.args[0] === 'clearSelection')).toBe(true);

    // Zoom controls update label
    doc.getElementById('btn-zoom-in')!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.getElementById('btn-zoom-reset')!.textContent).toBe('110%');

    // Error banner & Retry
    renderState(
      makeSampleState({
        tabs: [
          {
            ...state0.tabs[0]!,
            loadError: {
              viewport: 'landscape',
              errorCode: -102,
              errorDescription: 'ERR_CONNECTION_REFUSED',
              url: 'http://127.0.0.1:9999/',
              timestampMs: 123,
            },
          },
        ],
      }),
    );
    expect(doc.getElementById('load-error-banner')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('load-error-text')!.textContent).toContain('ERR_CONNECTION_REFUSED');
    doc.getElementById('btn-retry-load')!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.getElementById('load-error-banner')!.classList.contains('hidden')).toBe(true);

    // Download toast uses textContent only (XSS-safe)
    const toast = doc.getElementById('download-toast')!;
    dlCb!({
      id: 'dl-1',
      tabId: 'tab-1',
      viewport: 'landscape',
      filename: '<img src=x>.csv',
      receivedBytes: 50,
      totalBytes: 100,
      state: 'progressing',
    });
    expect(toast.classList.contains('hidden')).toBe(false);
    expect(toast.textContent).toBe('Downloading <img src=x>.csv (50%)');
    expect(toast.innerHtmlWrites).toBe(0);
    dlCb!({
      id: 'dl-1',
      tabId: 'tab-1',
      viewport: 'landscape',
      filename: 'report.csv',
      receivedBytes: 100,
      totalBytes: 100,
      state: 'completed',
    });
    expect(toast.textContent).toBe('Saved report.csv');

    // 2. TabManager VM tests for did-fail-load, zoom preservation, findInPage, context-menu, downloads
    const vmEnv = await loadInIsolatedElectronVm('src/main/tab-manager.ts');
    const TabManager = vmEnv.exports.TabManager as new (...args: unknown[]) => any;
    const win = new vmEnv.FakeBrowserWindow();
    const mgr = new TabManager(win as never, '/app/mirror-preload.js', () => false);
    try {
      const st = mgr.createTab({ url: 'http://127.0.0.1:9999/fail', mode: 'single' });
      const tabId = st.activeTabId!;
      const lWc = mgr.getViewportWebContents(tabId, 'landscape')!;

      // Subframe & ERR_ABORTED (-3) & chrome-error:// must NOT trigger loadError
      lWc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9999/sub', false);
      expect(mgr.getShellState().tabs[0]!.loadError).toBeNull();
      lWc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:9999/abort', true);
      expect(mgr.getShellState().tabs[0]!.loadError).toBeNull();
      lWc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'chrome-error://chromewebdata/', true);
      expect(mgr.getShellState().tabs[0]!.loadError).toBeNull();

      // Main-frame failure sets loadError; Electron 35 error-page did-finish-load (with wc.getURL() === failed URL) MUST NOT clear it
      lWc.emit('did-start-loading');
      lWc.currentUrl = 'http://127.0.0.1:9999/fail';
      lWc.mainFrame = { origin: 'null' };
      lWc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9999/fail', true);
      expect(mgr.getShellState().tabs[0]!.loadError?.errorDescription).toBe('ERR_CONNECTION_REFUSED');
      lWc.emit('did-finish-load');
      lWc.emit('did-stop-loading');
      expect(mgr.getShellState().tabs[0]!.loadError).not.toBeNull();
      expect(mgr.getShellState().tabs[0]!.loadError?.errorDescription).toBe('ERR_CONNECTION_REFUSED');

      // Retry that fails again preserves loadError across the second error-page did-finish-load
      mgr.retryLoad(tabId);
      lWc.emit('did-start-loading');
      lWc.currentUrl = 'http://127.0.0.1:9999/fail';
      lWc.mainFrame = { origin: 'null' };
      lWc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9999/fail', true);
      lWc.emit('did-finish-load');
      lWc.emit('did-stop-loading');
      expect(mgr.getShellState().tabs[0]!.loadError).not.toBeNull();

      // chrome-error:// did-finish-load also does NOT clear loadError
      lWc.currentUrl = 'chrome-error://chromewebdata/';
      lWc.emit('did-finish-load');
      expect(mgr.getShellState().tabs[0]!.loadError).not.toBeNull();

      // Subsequent real navigation (did-start-loading -> did-finish-load on real URL) clears loadError
      lWc.emit('did-start-loading');
      lWc.currentUrl = 'http://127.0.0.1:9999/ok';
      lWc.mainFrame = { origin: 'http://127.0.0.1:9999' };
      lWc.emit('did-finish-load');
      expect(mgr.getShellState().tabs[0]!.loadError).toBeNull();

      // Zoom steps & clamping + preservation across applyViewportEmulation
      mgr.zoomIn(tabId);
      expect(mgr.getShellState().tabs[0]!.zoomFactor).toBe(1.1);
      expect(lWc.zoomFactor).toBe(1.1);
      lWc.emit('did-finish-load');
      await new Promise((r) => setTimeout(r, 15));
      expect(lWc.zoomFactor).toBe(1.1);
      for (let i = 0; i < 20; i += 1) mgr.zoomIn(tabId);
      expect(mgr.getShellState().tabs[0]!.zoomFactor).toBe(5.0);
      for (let i = 0; i < 25; i += 1) mgr.zoomOut(tabId);
      expect(mgr.getShellState().tabs[0]!.zoomFactor).toBe(0.25);
      mgr.zoomReset(tabId);
      expect(mgr.getShellState().tabs[0]!.zoomFactor).toBe(1.0);

      // Context menu expanded items
      lWc.emit('context-menu', {}, {
        x: 12,
        y: 18,
        isEditable: true,
        selectionText: 'abc',
        linkURL: 'https://example.com/link',
        mediaType: 'image',
        srcURL: 'https://example.com/pic.png',
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      });
      const labels = vmEnv
        .getLastMenuTemplate()
        .map((item: { label?: string }) => item.label)
        .filter(Boolean);
      for (const expected of [
        'Back',
        'Forward',
        'Reload',
        'Cut',
        'Copy',
        'Paste',
        'Select All',
        'Open Link in New Tab',
        'Copy Link Address',
        'Save Image',
        'Copy Image',
        'Copy Image Address',
        'Inspect Element (landscape)',
      ]) {
        expect(labels).toContain(expected);
      }

      // Download progress & completion emits shell:download-event
      const fakeItem = new EventEmitter() as EventEmitter & {
        getURL: () => string;
        getFilename: () => string;
        getTotalBytes: () => number;
        getReceivedBytes: () => number;
        setSavePath: (p: string) => void;
      };
      fakeItem.getURL = () => 'http://127.0.0.1:8080/sample.csv';
      fakeItem.getFilename = () => 'sample.csv';
      fakeItem.getTotalBytes = () => 100;
      fakeItem.getReceivedBytes = () => 100;
      fakeItem.setSavePath = () => {};
      win.sentMessages.length = 0;
      vmEnv.defaultSession.emit('will-download', { preventDefault: () => {} }, fakeItem, lWc);
      fakeItem.emit('done', {}, 'completed');
      const dlEvents = win.sentMessages.filter(
        (m: { channel: string; payload: unknown }) => m.channel === 'shell:download-event',
      );
      expect(dlEvents.length).toBeGreaterThanOrEqual(2);
      expect((dlEvents[dlEvents.length - 1]!.payload as { state: string }).state).toBe('completed');
    } finally {
      mgr.dispose();
    }
  });
});
