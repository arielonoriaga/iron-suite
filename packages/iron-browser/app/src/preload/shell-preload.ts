import { contextBridge, ipcRenderer } from 'electron';
import type {
  DownloadProgressInfo,
  FindInPageResult,
  IronShellApi,
  ShellState,
  TelemetrySnapshot,
} from '../shared/types';

export type { IronShellApi } from '../shared/types';

const api: IronShellApi = {
  getInitialState: () => ipcRenderer.invoke('shell:get-initial-state'),
  newTab: (url, mode) => ipcRenderer.invoke('shell:new-tab', { url, mode }),
  closeTab: (tabId) => ipcRenderer.invoke('shell:close-tab', { tabId }),
  selectTab: (tabId) => ipcRenderer.invoke('shell:select-tab', { tabId }),
  sleepTab: (tabId) => ipcRenderer.invoke('shell:sleep-tab', { tabId }),
  navigate: (url) => ipcRenderer.invoke('shell:navigate', { url }),
  goBack: () => ipcRenderer.invoke('shell:go-back'),
  goForward: () => ipcRenderer.invoke('shell:go-forward'),
  reload: () => ipcRenderer.invoke('shell:reload'),
  toggleDualMode: () => ipcRenderer.invoke('shell:toggle-dual-mode'),
  toggleMirror: () => ipcRenderer.invoke('shell:toggle-mirror'),
  toggleDedup: (tabId) =>
    ipcRenderer.invoke('shell:toggle-dedup', tabId !== undefined ? { tabId } : undefined),
  toggleSessionMode: () => ipcRenderer.invoke('shell:toggle-session-mode'),
  setSessionMode: (mode) => ipcRenderer.invoke('shell:set-session-mode', { mode }),
  setPreset: (role, presetId) => ipcRenderer.invoke('shell:set-preset', { role, presetId }),
  setEmulationProfile: (profile, viewport, tabId) =>
    ipcRenderer.invoke('shell:set-emulation-profile', {
      profile,
      ...(viewport !== undefined ? { viewport } : {}),
      ...(tabId !== undefined ? { tabId } : {}),
    }),
  setRailCollapsed: (collapsed) => ipcRenderer.invoke('shell:set-rail-collapsed', { collapsed }),
  setDockOpen: (open) => ipcRenderer.invoke('shell:set-dock-open', { open }),
  setDockHeight: (height) => ipcRenderer.invoke('shell:set-dock-height', { height }),
  setSplitRatio: (ratio) => ipcRenderer.invoke('shell:set-split-ratio', { ratio }),
  setDevToolsTarget: (role) => ipcRenderer.invoke('shell:set-devtools-target', { role }),
  toggleAudio: (role) => ipcRenderer.invoke('shell:toggle-audio', { role }),
  setTheme: (theme) => ipcRenderer.invoke('shell:set-theme', { theme }),
  toggleEcoMode: () => ipcRenderer.invoke('shell:toggle-eco-mode'),
  setAutoSleep: (enabled) => ipcRenderer.invoke('shell:set-auto-sleep', { enabled }),
  copyMirrorMissDebug: () => ipcRenderer.invoke('shell:copy-mirror-miss-debug'),
  focusAnomaly: (kind) => ipcRenderer.invoke('shell:focus-anomaly', { kind }),
  openHistoryMenu: (x, y) => ipcRenderer.invoke('shell:open-history-menu', { x, y }),
  removeHistoryItem: (url) => ipcRenderer.invoke('shell:remove-history-item', { url }),
  clearHistory: () => ipcRenderer.invoke('shell:clear-history'),
  reopenClosedTab: () => ipcRenderer.invoke('shell:reopen-closed-tab'),
  toggleAgentDock: () => ipcRenderer.invoke('shell:toggle-agent-dock'),
  setAgentDockMode: (mode) => ipcRenderer.invoke('shell:set-agent-dock-mode', { mode }),
  setAgentDockWidth: (width) => ipcRenderer.invoke('shell:set-agent-dock-width', { width }),
  sendContextToAgent: () => ipcRenderer.invoke('shell:send-context-to-agent'),
  findInPage: (text, opts) => ipcRenderer.invoke('shell:find-in-page', { text, ...(opts ?? {}) }),
  stopFindInPage: (action) =>
    ipcRenderer.invoke('shell:stop-find-in-page', action !== undefined ? { action } : undefined),
  setFindOpen: (open) => ipcRenderer.invoke('shell:set-find-open', { open }),
  zoomIn: () => ipcRenderer.invoke('shell:zoom-in'),
  zoomOut: () => ipcRenderer.invoke('shell:zoom-out'),
  zoomReset: () => ipcRenderer.invoke('shell:zoom-reset'),
  retryLoad: (tabId) =>
    ipcRenderer.invoke('shell:retry-load', tabId !== undefined ? { tabId } : undefined),
  dismissLoadError: (tabId) =>
    ipcRenderer.invoke('shell:dismiss-load-error', tabId !== undefined ? { tabId } : undefined),
  onStateUpdate: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, state: ShellState) => cb(state);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  },
  onTelemetry: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, snap: TelemetrySnapshot) => cb(snap);
    ipcRenderer.on('shell:telemetry', listener);
    return () => ipcRenderer.removeListener('shell:telemetry', listener);
  },
  onFocusUrlBar: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('shell:focus-url-bar', listener);
    return () => ipcRenderer.removeListener('shell:focus-url-bar', listener);
  },
  onOpenFind: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('shell:open-find', listener);
    return () => ipcRenderer.removeListener('shell:open-find', listener);
  },
  onCloseFind: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('shell:close-find', listener);
    return () => ipcRenderer.removeListener('shell:close-find', listener);
  },
  onFindResult: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, res: FindInPageResult) => cb(res);
    ipcRenderer.on('shell:find-result', listener);
    return () => ipcRenderer.removeListener('shell:find-result', listener);
  },
  onDownloadEvent: (cb) => {
    const listener = (_ev: Electron.IpcRendererEvent, ev: DownloadProgressInfo) => cb(ev);
    ipcRenderer.on('shell:download-event', listener);
    return () => ipcRenderer.removeListener('shell:download-event', listener);
  },
};

contextBridge.exposeInMainWorld('ironShell', api);
