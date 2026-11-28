import * as electron from 'electron';
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent } from 'electron';

const { app, BrowserWindow, crashReporter, ipcMain, screen } = electron;
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDockMode, SessionMode, ThemeMode, ViewMode, ViewportRole } from '../shared/types';
import { type PersistedWindowBounds } from '../shared/session-store';
import { normalizeUrl } from '../shared/url';
import { AgentDockManager } from './agent-dock';
import { ControlSocketServer, resolveControlSocketPath } from './ctl-socket';
import {
  AbnormalExitMonitor,
  MainThreadWatchdog,
  resolveCrashDumpsDir,
  resolveStateLogDir,
  scanLatestCrashDump,
  StructuredLogger,
} from './diagnostics';
import { loadPersistedSession, savePersistedSession } from './session-file';
import { resolveOzoneSwitchConfig } from './ozone';
import { TabManager } from './tab-manager';

const BOOT_STARTED_AT_MS = Date.now();
const isSmokeBoot = process.env.IRON_BROWSER_SMOKE === '1' || process.argv.includes('--smoke');

const userDataOverride = process.env.IRON_BROWSER_USER_DATA?.trim();
if (userDataOverride && typeof app?.setPath === 'function') {
  app.setPath('userData', path.resolve(userDataOverride));
}

function safeGetUserDataPath(): string | undefined {
  try {
    if (typeof app?.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // Ignore when imported inside unit-test VMs with stubbed electron.app.
  }
  return userDataOverride ? path.resolve(userDataOverride) : undefined;
}

const configuredUserDataDir = safeGetUserDataPath();
const crashDumpsDir = resolveCrashDumpsDir(configuredUserDataDir);
if (typeof app?.setPath === 'function') {
  try {
    app.setPath('crashDumps', crashDumpsDir);
  } catch {
    // Ignore if crashDumps path cannot be set in stubbed test environments.
  }
}
if (crashReporter && typeof crashReporter.start === 'function') {
  try {
    crashReporter.start({
      submitURL: '',
      uploadToServer: false,
      compress: false,
    });
  } catch {
    // Ignore Crashpad init errors in headless/stubbed environments.
  }
}

// Ozone platform detection (X11 / Wayland / headless) + lean Chromium switches.
const ozoneConfig = resolveOzoneSwitchConfig(process.argv, process.env, isSmokeBoot);
const isHeadlessOzone = ozoneConfig.isHeadlessOzone;
if (app?.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  for (const [sw, val] of ozoneConfig.switches) {
    if (val !== undefined) {
      app.commandLine.appendSwitch(sw, val);
    } else {
      app.commandLine.appendSwitch(sw);
    }
  }
}

let mainWindow: BrowserWindowType | null = null;
let tabManager: TabManager | null = null;
let agentDock: AgentDockManager | null = null;
let ctlServer: ControlSocketServer | null = null;
let diagLogger: StructuredLogger | null = null;
let watchdog: MainThreadWatchdog | null = null;
let exitMonitor: AbnormalExitMonitor | null = null;
let sessionFilePath: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastNormalBounds: PersistedWindowBounds | undefined;
let sessionRestored = false;
let sessionFlushed = false;
let quitReason = 'external_or_user_close';

function requestQuitWithReason(reason: string): void {
  quitReason = reason;
  diagLogger?.info('lifecycle.request_quit', { reason });
  app.quit();
}

function captureWindowBounds(win: BrowserWindowType | null): PersistedWindowBounds | undefined {
  if (!win || win.isDestroyed()) return lastNormalBounds;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  if (bounds.width >= 760 && bounds.height >= 520) {
    lastNormalBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    };
  } else if (lastNormalBounds) {
    lastNormalBounds = { ...lastNormalBounds, maximized };
  }
  return lastNormalBounds;
}

function flushSessionNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!sessionFilePath || !tabManager || !sessionRestored || sessionFlushed) return;
  try {
    const snapshot = tabManager.exportPersistedSession(captureWindowBounds(mainWindow));
    savePersistedSession(sessionFilePath, snapshot);
  } catch (err) {
    diagLogger?.error('session.save_error', { error: err });
    process.stderr.write(`IronBrowser session save error: ${String(err)}\n`);
  }
}

function scheduleSessionSave(): void {
  if (!sessionFilePath || !sessionRestored || sessionFlushed) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushSessionNow();
  }, 400);
}

function isBoundsVisibleOnAnyDisplay(bounds: PersistedWindowBounds): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return false;
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const wa = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
    const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
    if (overlapX >= 120 && overlapY >= 80) {
      return true;
    }
  }
  return false;
}

function parseInitialUrlFromArgv(): string | undefined {
  for (const arg of process.argv.slice(1)) {
    if (
      arg.startsWith('--') ||
      arg === '.' ||
      arg.startsWith('./') ||
      arg.startsWith('../') ||
      arg.startsWith('/') ||
      arg.endsWith('.js')
    ) {
      continue;
    }
    if (
      /^(https?:|(?:[a-z0-9-]+\.)*localhost(?::\d{1,5})?(?:[/?#]|$)|\[[0-9a-f:]+\](?::\d{1,5})?(?:[/?#]|$)|(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)|[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{1,5}(?:[/?#]|$))/i.test(
        arg,
      )
    ) {
      try {
        return normalizeUrl(arg);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function assertShellSender(ev: IpcMainInvokeEvent, win: BrowserWindowType): void {
  if (
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    !ev?.sender ||
    !ev.senderFrame ||
    !win.webContents.mainFrame ||
    ev.sender.id !== win.webContents.id ||
    ev.senderFrame !== win.webContents.mainFrame
  ) {
    throw new Error('Unauthorized IPC sender for shell channel');
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected object IPC payload');
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC field '${field}': expected non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid IPC field '${field}': expected boolean`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid IPC field '${field}': expected finite number`);
  }
  return value;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid IPC field '${field}': expected one of ${allowed.join('|')}`);
  }
  return value as T;
}

export interface ShortcutTarget {
  tabManager: Pick<
    TabManager,
    | 'getShellState'
    | 'setRailCollapsed'
    | 'toggleDualMode'
    | 'toggleMirror'
    | 'createTab'
    | 'reopenClosedTab'
    | 'getActiveTab'
    | 'closeTab'
    | 'setDockOpen'
    | 'reload'
  > & {
    toggleAgentDock?: () => unknown;
    zoomIn?: () => unknown;
    zoomOut?: () => unknown;
    zoomReset?: () => unknown;
    isFindOpen?: () => boolean;
    closeFindBar?: () => void;
  } | null;
  mainWindow: Pick<BrowserWindowType, 'webContents'> | null;
}

export function dispatchGlobalShortcut(
  input: Electron.Input,
  deps: ShortcutTarget,
): boolean {
  const { tabManager: mgr, mainWindow: win } = deps;
  if (!mgr || !win) return false;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (ctrl && !input.shift && (key === '`' || input.code === 'Backquote')) {
    if (typeof mgr.toggleAgentDock === 'function') {
      mgr.toggleAgentDock();
      return true;
    }
  }

  if (ctrl && !input.shift && !input.alt && key === 'f') {
    win.webContents.focus();
    win.webContents.send('shell:open-find');
    return true;
  }
  if (!ctrl && !input.shift && !input.alt && key === 'escape') {
    if (mgr.isFindOpen?.()) {
      mgr.closeFindBar?.();
      return true;
    }
  }
  if (
    ctrl &&
    !input.alt &&
    (key === '=' || key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd')
  ) {
    mgr.zoomIn?.();
    return true;
  }
  if (
    ctrl &&
    !input.alt &&
    (key === '-' || key === '_' || input.code === 'Minus' || input.code === 'NumpadSubtract')
  ) {
    mgr.zoomOut?.();
    return true;
  }
  if (
    ctrl &&
    !input.shift &&
    !input.alt &&
    (key === '0' || input.code === 'Digit0' || input.code === 'Numpad0')
  ) {
    mgr.zoomReset?.();
    return true;
  }

  if (ctrl && !input.shift && key === '\\') {
    const state = mgr.getShellState();
    mgr.setRailCollapsed(!state.railCollapsed);
    return true;
  }
  if (ctrl && !input.shift && key === 'l') {
    win.webContents.focus();
    win.webContents.send('shell:focus-url-bar');
    return true;
  }
  if (ctrl && input.shift && key === 'd') {
    mgr.toggleDualMode();
    return true;
  }
  if (ctrl && !input.shift && key === 'm') {
    mgr.toggleMirror();
    return true;
  }
  if (ctrl && !input.shift && key === 't') {
    mgr.createTab({ mode: 'dual' });
    return true;
  }
  if (ctrl && input.shift && key === 't') {
    mgr.reopenClosedTab();
    return true;
  }
  if (ctrl && !input.shift && key === 'w') {
    const active = mgr.getActiveTab();
    if (active) mgr.closeTab(active.id);
    return true;
  }
  if ((ctrl && !input.alt && key === 'r') || (!input.alt && key === 'f5')) {
    void mgr.reload();
    return true;
  }
  if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
    const state = mgr.getShellState();
    mgr.setDockOpen(!state.dockOpen);
    return true;
  }
  return false;
}

function handleGlobalShortcut(input: Electron.Input): boolean {
  return dispatchGlobalShortcut(input, { tabManager, mainWindow });
}

export function registerIpcHandlers(
  win: BrowserWindowType,
  mgr: TabManager,
  ipc: Pick<Electron.IpcMain, 'handle'> = ipcMain,
): void {
  const handleShell = (
    channel: string,
    fn: (args: unknown) => unknown,
  ): void => {
    ipc.handle(channel, (ev, args: unknown) => {
      assertShellSender(ev, win);
      return fn(args);
    });
  };

  handleShell('shell:get-initial-state', () => ({
    state: mgr.getShellState(),
    presets: mgr.getPresets(),
  }));

  handleShell('shell:new-tab', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.createTab();
    }
    const obj = asObject(raw);
    const url = obj.url !== undefined ? asNonEmptyString(obj.url, 'url') : undefined;
    const mode =
      obj.mode !== undefined
        ? asEnum<ViewMode>(obj.mode, ['single', 'dual'], 'mode')
        : undefined;
    return mgr.createTab({ url, mode });
  });

  handleShell('shell:close-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.closeTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:select-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.selectTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:sleep-tab', (raw) => {
    const obj = asObject(raw);
    return mgr.sleepTab(asNonEmptyString(obj.tabId, 'tabId'));
  });

  handleShell('shell:navigate', (raw) => {
    const obj = asObject(raw);
    return mgr.navigate(asNonEmptyString(obj.url, 'url'));
  });

  handleShell('shell:go-back', () => mgr.goBack());
  handleShell('shell:go-forward', () => mgr.goForward());
  handleShell('shell:reload', () => mgr.reload());
  handleShell('shell:toggle-dual-mode', () => mgr.toggleDualMode());
  handleShell('shell:toggle-mirror', () => mgr.toggleMirror());
  handleShell('shell:toggle-dedup', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.toggleDedup();
    }
    const obj = asObject(raw);
    const tabId = obj.tabId !== undefined ? asNonEmptyString(obj.tabId, 'tabId') : undefined;
    return mgr.toggleDedup(tabId);
  });
  handleShell('shell:toggle-session-mode', () => mgr.toggleSessionMode());

  handleShell('shell:set-session-mode', (raw) => {
    const obj = asObject(raw);
    return mgr.setSessionMode(
      asEnum<SessionMode>(obj.mode, ['shared', 'isolated'], 'mode'),
    );
  });

  handleShell('shell:set-preset', (raw) => {
    const obj = asObject(raw);
    return mgr.setPreset(
      asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'),
      asNonEmptyString(obj.presetId, 'presetId'),
    );
  });

  handleShell('shell:set-emulation-profile', (raw) => {
    const obj = asObject(raw);
    const profile = asEnum<'none' | 'sunmi-v2-pro' | 'low-end-android'>(
      obj.profile,
      ['none', 'sunmi-v2-pro', 'low-end-android'],
      'profile',
    );
    const viewport =
      obj.viewport !== undefined
        ? asEnum<ViewportRole | 'both'>(obj.viewport, ['portrait', 'landscape', 'both'], 'viewport')
        : 'both';
    const tabId = obj.tabId !== undefined ? asNonEmptyString(obj.tabId, 'tabId') : undefined;
    return mgr.setEmulationProfile(profile, viewport, tabId);
  });

  handleShell('shell:set-rail-collapsed', (raw) => {
    const obj = asObject(raw);
    return mgr.setRailCollapsed(asBoolean(obj.collapsed, 'collapsed'));
  });

  handleShell('shell:set-dock-open', (raw) => {
    const obj = asObject(raw);
    return mgr.setDockOpen(asBoolean(obj.open, 'open'));
  });

  handleShell('shell:set-dock-height', (raw) => {
    const obj = asObject(raw);
    return mgr.setDockHeight(asFiniteNumber(obj.height, 'height'));
  });

  handleShell('shell:set-split-ratio', (raw) => {
    const obj = asObject(raw);
    return mgr.setSplitRatio(asFiniteNumber(obj.ratio, 'ratio'));
  });

  handleShell('shell:set-devtools-target', (raw) => {
    const obj = asObject(raw);
    return mgr.setDevToolsTarget(
      asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'),
    );
  });

  handleShell('shell:toggle-audio', (raw) => {
    const obj = asObject(raw);
    return mgr.toggleAudio(asEnum<ViewportRole>(obj.role, ['portrait', 'landscape'], 'role'));
  });

  handleShell('shell:set-theme', (raw) => {
    const obj = asObject(raw);
    return mgr.setTheme(asEnum<ThemeMode>(obj.theme, ['dark', 'light'], 'theme'));
  });

  handleShell('shell:focus-anomaly', (raw) => {
    const obj = asObject(raw);
    return mgr.focusAnomaly(
      asEnum<'console' | 'network'>(obj.kind, ['console', 'network'], 'kind'),
    );
  });

  handleShell('shell:open-history-menu', (raw) => {
    if (raw === undefined || raw === null) {
      mgr.openHistoryMenu();
      return;
    }
    const obj = asObject(raw);
    const x = obj.x !== undefined ? asFiniteNumber(obj.x, 'x') : undefined;
    const y = obj.y !== undefined ? asFiniteNumber(obj.y, 'y') : undefined;
    mgr.openHistoryMenu(x, y);
  });

  handleShell('shell:remove-history-item', (raw) => {
    const obj = asObject(raw);
    return mgr.removeHistoryItem(asNonEmptyString(obj.url, 'url'));
  });

  handleShell('shell:clear-history', () => mgr.clearHistory());
  handleShell('shell:reopen-closed-tab', () => mgr.reopenClosedTab());
  handleShell('shell:toggle-eco-mode', () => mgr.toggleEcoMode());
  handleShell('shell:set-auto-sleep', (raw) => {
    const obj = asObject(raw);
    return mgr.setAutoSleep(asBoolean(obj.enabled, 'enabled'));
  });
  handleShell('shell:copy-mirror-miss-debug', () => mgr.copyMirrorMissDebug());
  handleShell('shell:toggle-agent-dock', () => mgr.toggleAgentDock());
  handleShell('shell:set-agent-dock-mode', (raw) => {
    const obj = asObject(raw);
    return mgr.setAgentDockMode(
      asEnum<AgentDockMode>(obj.mode, ['docked', 'floating', 'minimized'], 'mode'),
    );
  });
  handleShell('shell:set-agent-dock-width', (raw) => {
    const obj = asObject(raw);
    return mgr.setAgentDockWidth(asFiniteNumber(obj.width, 'width'));
  });
  handleShell('shell:send-context-to-agent', () => mgr.sendContextToAgent());

  handleShell('shell:find-in-page', (raw) => {
    const obj = asObject(raw);
    const text = typeof obj.text === 'string' ? obj.text : '';
    const forward = obj.forward !== undefined ? asBoolean(obj.forward, 'forward') : undefined;
    const findNext = obj.findNext !== undefined ? asBoolean(obj.findNext, 'findNext') : undefined;
    const matchCase = obj.matchCase !== undefined ? asBoolean(obj.matchCase, 'matchCase') : undefined;
    const viewport =
      obj.viewport !== undefined
        ? asEnum<ViewportRole>(obj.viewport, ['portrait', 'landscape'], 'viewport')
        : undefined;
    mgr.findInPage(text, { forward, findNext, matchCase, viewport });
  });

  handleShell('shell:stop-find-in-page', (raw) => {
    if (raw === undefined || raw === null) {
      mgr.stopFindInPage();
      return;
    }
    const obj = asObject(raw);
    const action =
      obj.action !== undefined
        ? asEnum<'clearSelection' | 'keepSelection' | 'activateSelection'>(
            obj.action,
            ['clearSelection', 'keepSelection', 'activateSelection'],
            'action',
          )
        : undefined;
    mgr.stopFindInPage(action);
  });

  handleShell('shell:set-find-open', (raw) => {
    const obj = asObject(raw);
    mgr.setFindOpen(asBoolean(obj.open, 'open'));
  });

  handleShell('shell:zoom-in', () => mgr.zoomIn());
  handleShell('shell:zoom-out', () => mgr.zoomOut());
  handleShell('shell:zoom-reset', () => mgr.zoomReset());

  handleShell('shell:retry-load', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.retryLoad();
    }
    const obj = asObject(raw);
    const tabId = obj.tabId !== undefined ? asNonEmptyString(obj.tabId, 'tabId') : undefined;
    return mgr.retryLoad(tabId);
  });

  handleShell('shell:dismiss-load-error', (raw) => {
    if (raw === undefined || raw === null) {
      return mgr.dismissLoadError();
    }
    const obj = asObject(raw);
    const tabId = obj.tabId !== undefined ? asNonEmptyString(obj.tabId, 'tabId') : undefined;
    return mgr.dismissLoadError(tabId);
  });
}

function getPendingShutdownSummary(): Record<string, unknown> {
  return {
    pendingRpcs: ctlServer?.getPendingRpcs() ?? [],
    activeProfiles: tabManager?.cpuProfiler.getActiveSessions() ?? [],
    openTabs: tabManager?.getShellState().tabs.length ?? 0,
  };
}

async function createMainWindow(): Promise<void> {
  const isSmoke = isSmokeBoot;
  const userDataDir = app.getPath('userData');
  const logDir = resolveStateLogDir({ isSmoke, userDataDir });
  try {
    diagLogger = new StructuredLogger(logDir);
    watchdog = new MainThreadWatchdog(diagLogger.logPath);
    watchdog.start();
  } catch (err) {
    process.stderr.write(`IronBrowser diagnostics init warning: ${String(err)}\n`);
  }

  diagLogger?.info('lifecycle.startup', {
    version: '0.1.1',
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    smoke: isSmoke,
    userDataDir,
    logPath: diagLogger?.logPath ?? null,
    crashDumpsDir,
  });
  try {
    const latestDump = scanLatestCrashDump(crashDumpsDir);
    if (latestDump) {
      const markerPath = path.join(userDataDir, '.last-reported-crashdump');
      let prevSeen = '';
      try {
        if (fs.existsSync(markerPath) && !fs.lstatSync(markerPath).isSymbolicLink()) {
          prevSeen = fs.readFileSync(markerPath, 'utf8').trim();
        }
      } catch {
        // Ignore read error.
      }
      const dumpKey = `${latestDump.path}|${latestDump.mtimeMs}`;
      if (prevSeen !== dumpKey) {
        diagLogger?.error('lifecycle.previous_native_crash_dump', {
          dumpPath: latestDump.path,
          dumpMtimeIso: latestDump.mtimeIso,
          sizeBytes: latestDump.sizeBytes,
          totalDumps: latestDump.totalDumps,
        });
        try {
          if (!fs.existsSync(markerPath) || !fs.lstatSync(markerPath).isSymbolicLink()) {
            fs.writeFileSync(markerPath, dumpKey, { mode: 0o600 });
          }
        } catch {
          // Ignore marker write error.
        }
      }
    }
  } catch {
    // Ignore post-mortem dump check failure.
  }
  process.stderr.write(
    `IronBrowser diagnostics: log=${diagLogger?.logPath ?? 'disabled'} crashDumps=${crashDumpsDir}\n`,
  );
  if (diagLogger?.logPath) {
    exitMonitor = new AbnormalExitMonitor({
      pid: process.pid,
      logPath: diagLogger.logPath,
      crashDumpsDir,
    });
    exitMonitor.start();
  }

  const explicitStateFile = process.env.IRON_BROWSER_STATE_FILE?.trim();
  sessionFilePath = explicitStateFile
    ? explicitStateFile
    : isSmoke
      ? null
      : path.join(userDataDir, 'session-state.json');

  const savedSession = sessionFilePath ? loadPersistedSession(sessionFilePath) : null;
  const savedWin = savedSession?.window;
  const useSavedPos = savedWin ? isBoundsVisibleOnAnyDisplay(savedWin) : false;

  const distRoot = path.join(app.getAppPath(), 'dist');
  const shellPreloadPath = path.join(distRoot, 'preload', 'shell-preload.js');
  const mirrorPreloadPath = path.join(distRoot, 'preload', 'mirror-preload.js');
  const agentPreloadPath = path.join(distRoot, 'preload', 'agent-preload.js');
  const rendererHtmlPath = path.join(distRoot, 'renderer', 'index.html');
  const agentHtmlPath = path.join(distRoot, 'renderer', 'agent-dock.html');
  const expectedRendererUrl = pathToFileURL(rendererHtmlPath).toString();

  const iconPath = path.join(app.getAppPath(), '..', 'packaging', 'iron-browser.png');
  const win = new BrowserWindow({
    width: savedWin?.width ?? 1480,
    height: savedWin?.height ?? 920,
    ...(useSavedPos && savedWin?.x !== undefined && savedWin?.y !== undefined
      ? { x: savedWin.x, y: savedWin.y }
      : {}),
    minWidth: 760,
    minHeight: 520,
    show: !isSmoke && !isHeadlessOzone,
    title: 'IronBrowser',
    icon: iconPath,
    backgroundColor: savedSession?.theme === 'light' ? '#f5f7fb' : '#060b13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(isSmoke || isHeadlessOzone ? { offscreen: true } : {}),
    },
  });
  mainWindow = win;
  if (!isSmoke && !isHeadlessOzone && savedWin?.maximized) {
    win.maximize();
  }
  captureWindowBounds(win);

  win.on('resize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('move', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('maximize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('unmaximize', () => {
    captureWindowBounds(win);
    scheduleSessionSave();
  });
  win.on('close', () => {
    quitReason = 'main_window_closed';
    diagLogger?.info('lifecycle.main_window_close');
    flushSessionNow();
    sessionFlushed = true;
  });

  win.webContents.on('unresponsive', () => {
    diagLogger?.warn('shell.unresponsive');
  });
  win.webContents.on('responsive', () => {
    diagLogger?.info('shell.responsive');
  });
  win.webContents.on('render-process-gone', (_ev, details) => {
    diagLogger?.error('shell.render_process_gone', {
      reason: details?.reason ?? 'unknown',
      exitCode: details?.exitCode ?? null,
    });
  });

  // Lock main shell window against external navigation or popup windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, targetUrl) => {
    if (targetUrl !== expectedRendererUrl) {
      ev.preventDefault();
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && handleGlobalShortcut(input)) {
      event.preventDefault();
    }
  });

  const mgr = new TabManager(win, mirrorPreloadPath, handleGlobalShortcut, scheduleSessionSave, {
    logger: diagLogger,
  });
  tabManager = mgr;
  const plannedSocketPath = resolveControlSocketPath();
  const dock = new AgentDockManager(
    win,
    agentPreloadPath,
    agentHtmlPath,
    {
      getSocketPath: () => ctlServer?.socketPath ?? plannedSocketPath,
      getActiveTabId: () => mgr.getActiveTab()?.id ?? null,
      getBrowserContextSnippet: () => mgr.buildBrowserContextSnippet(),
      onLayoutChanged: () => {
        mgr.applyLayout();
        scheduleSessionSave();
        if (!win.isDestroyed()) {
          win.webContents.send('shell:state', mgr.getShellState());
        }
      },
    },
    {
      initialMode: isSmoke ? 'minimized' : 'docked',
      initialFloatBounds: savedSession?.agentFloatBounds,
    },
  );
  agentDock = dock;
  dock.registerIpcHandlers();
  mgr.attachAgentDock(dock);
  registerIpcHandlers(win, mgr);

  await win.loadFile(rendererHtmlPath);

  const initialUrl = parseInitialUrlFromArgv();
  mgr.restoreSession(savedSession, initialUrl);
  sessionRestored = true;
  mgr.telemetry.start();

  const ctl = new ControlSocketServer(mgr, undefined, {
    logger: diagLogger,
    watchdog,
    logPath: diagLogger?.logPath,
    crashDumpsDir,
    startedAtMs: BOOT_STARTED_AT_MS,
  });
  ctlServer = ctl;
  const sockPath = await ctl.start();
  diagLogger?.info('lifecycle.ready', {
    socketPath: sockPath,
    uptimeMs: Date.now() - BOOT_STARTED_AT_MS,
  });

  if (isSmoke) {
    process.stdout.write(`IRON_BROWSER_READY ${sockPath}\n`);
    const smokeExitArg = process.argv.find((a) => a.startsWith('--smoke-exit-ms='));
    if (smokeExitArg) {
      const ms = Number(smokeExitArg.split('=')[1] ?? 500);
      setTimeout(() => {
        requestQuitWithReason('smoke_exit_timer');
      }, Number.isFinite(ms) ? Math.max(100, ms) : 500);
    }
  }
}

if (typeof app?.whenReady === 'function') {
  process.on('uncaughtException', (err) => {
    diagLogger?.fatal('process.uncaught_exception', {
      error: err,
      ...getPendingShutdownSummary(),
    });
    process.stderr.write(`IronBrowser uncaughtException: ${err?.stack ?? String(err)}\n`);
  });

  process.on('unhandledRejection', (reason) => {
    diagLogger?.error('process.unhandled_rejection', {
      reason: reason instanceof Error ? reason : String(reason),
      ...getPendingShutdownSummary(),
    });
    process.stderr.write(
      `IronBrowser unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  });

  app.on('render-process-gone', (_ev, wc, details) => {
    const hit = tabManager?.findByWebContentsId(wc.id);
    let safeUrl = '';
    try {
      if (!wc.isDestroyed()) safeUrl = wc.getURL();
    } catch {
      // Ignore URL lookup on destroyed WebContents.
    }
    diagLogger?.error('app.render_process_gone', {
      wcId: wc.id,
      osProcessId: (() => {
        try {
          return !wc.isDestroyed() ? wc.getOSProcessId() : null;
        } catch {
          return null;
        }
      })(),
      tabId: hit?.tabId ?? null,
      viewport: hit?.role ?? null,
      reason: details?.reason ?? 'unknown',
      exitCode: details?.exitCode ?? null,
      url: safeUrl,
    });
  });

  app.on('child-process-gone', (_ev, details) => {
    diagLogger?.error('app.child_process_gone', {
      type: details?.type ?? 'unknown',
      reason: details?.reason ?? 'unknown',
      exitCode: details?.exitCode ?? null,
      serviceName: details?.serviceName ?? null,
      name: details?.name ?? null,
    });
  });

  let exitLogged = false;
  process.on('exit', (code) => {
    exitMonitor?.notifyCleanExit();
    if (exitLogged) return;
    exitLogged = true;
    diagLogger?.log('info', 'process.exit', { exitCode: code, reason: quitReason }, true);
  });

  app.whenReady().then(() => {
    void createMainWindow().catch((err) => {
      diagLogger?.fatal('lifecycle.startup_failed', { error: err });
      process.stderr.write(`IronBrowser startup error: ${String(err)}\n`);
      app.exit(1);
    });
  });

  app.on('window-all-closed', () => {
    if (quitReason === 'external_or_user_close') {
      quitReason = 'window_all_closed';
    }
    diagLogger?.info('lifecycle.window_all_closed', { reason: quitReason });
    app.quit();
  });

  let shuttingDown = false;

  app.on('before-quit', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const pending = getPendingShutdownSummary();
    diagLogger?.info('lifecycle.before_quit', { reason: quitReason, ...pending });
    watchdog?.notifyShutdown(quitReason, pending);
    flushSessionNow();
    sessionFlushed = true;
    ctlServer?.close();
    agentDock?.dispose();
    tabManager?.dispose();
  });

  app.on('will-quit', () => {
    diagLogger?.info('lifecycle.will_quit', { reason: quitReason });
  });

  app.on('quit', (_ev, exitCode) => {
    diagLogger?.info('lifecycle.quit', { reason: quitReason, exitCode });
    watchdog?.stop();
  });

  const handleShutdownSignal = (sig: string): void => {
    quitReason = `signal:${sig}`;
    if (shuttingDown) return;
    shuttingDown = true;
    const pending = getPendingShutdownSummary();
    diagLogger?.info('lifecycle.signal', { signal: sig, ...pending });
    watchdog?.notifyShutdown(quitReason, pending);
    flushSessionNow();
    sessionFlushed = true;
    ctlServer?.close();
    agentDock?.dispose();
    tabManager?.dispose();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    app.quit();
    setTimeout(() => {
      app.exit(0);
    }, 250).unref();
  };

  process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
}
