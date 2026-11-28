import { computeLayout } from '../shared/layout';
import { sanitizeMirrorMissLabel } from '../shared/mirror-core';
import type {
  DevicePreset,
  DownloadProgressInfo,
  FindInPageResult,
  HistoryEntry,
  IronShellApi,
  MirrorMissInfo,
  Rect,
  ShellState,
  TabEmulationSummary,
  TelemetrySnapshot,
} from '../shared/types';

export { sanitizeMirrorMissLabel };

declare global {
  interface Window {
    ironShell: IronShellApi;
  }
}

let docRef: Document | null = null;
let apiRef: IronShellApi | null = null;

const getApi = (): IronShellApi => apiRef ?? window.ironShell;

const $ = <T extends HTMLElement>(doc: Document, id: string): T => {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

let topBarEl!: HTMLElement;
let railEl!: HTMLElement;
let tabListEl!: HTMLElement;
let portraitHeaderEl!: HTMLElement;
let splitDividerEl!: HTMLElement;
let landscapeHeaderEl!: HTMLElement;
let landscapeTagEl!: HTMLElement;
let telemetryBarEl!: HTMLElement;
let dockResizeHandleEl!: HTMLElement;
let devtoolsHeaderEl!: HTMLElement;

let urlFormEl!: HTMLFormElement;
let urlInputEl!: HTMLInputElement;
let urlHistoryListEl!: HTMLDataListElement;
let btnRailEl!: HTMLButtonElement;
let btnBackEl!: HTMLButtonElement;
let btnForwardEl!: HTMLButtonElement;
let btnReloadEl!: HTMLButtonElement;
let btnHistoryEl!: HTMLButtonElement;
let historySectionEl!: HTMLElement;
let historyListEl!: HTMLElement;
let btnClearHistoryEl!: HTMLButtonElement;
let btnDualEl!: HTMLButtonElement;
let lblDualEl!: HTMLElement;
let btnMirrorEl!: HTMLButtonElement;
let lblMirrorEl!: HTMLElement;
let btnSessionEl!: HTMLButtonElement;
let lblSessionEl!: HTMLElement;
let btnDedupEl!: HTMLButtonElement;
let lblDedupEl!: HTMLElement;
let btnEcoEl!: HTMLButtonElement;
let lblEcoEl!: HTMLElement;
let btnAutoSleepEl!: HTMLButtonElement;
let lblAutoSleepEl!: HTMLElement;
let btnAgentChatEl: HTMLButtonElement | null = null;
let lblAgentChatEl: HTMLElement | null = null;
let agentChatDotEl: HTMLElement | null = null;
let agentResizeHandleEl: HTMLElement | null = null;
let btnThemeEl!: HTMLButtonElement;
let btnNewTabEl!: HTMLButtonElement;
let selectPortraitEl!: HTMLSelectElement;
let selectLandscapeEl!: HTMLSelectElement;
let btnAudioPortraitEl!: HTMLButtonElement;
let btnAudioLandscapeEl!: HTMLButtonElement;
let portraitFpsEl!: HTMLElement;
let landscapeFpsEl!: HTMLElement;

const ICON_SOUND_ON =
  '<svg viewBox="0 0 16 16"><polygon points="2.5 6 5.5 6 9 3 9 13 5.5 10 2.5 10"/><path d="M11.2 5.4a3.6 3.6 0 0 1 0 5.2"/><path d="M13 3.6a6 6 0 0 1 0 8.8"/></svg>';
const ICON_SOUND_OFF =
  '<svg viewBox="0 0 16 16"><polygon points="2.5 6 5.5 6 9 3 9 13 5.5 10 2.5 10"/><line x1="11.5" y1="6" x2="14.5" y2="10"/><line x1="14.5" y1="6" x2="11.5" y2="10"/></svg>';

let mGpuEl!: HTMLElement;
let mPortEl!: HTMLElement;
let mLandEl!: HTMLElement;
let mRamEl!: HTMLElement;
let mFrameEl!: HTMLElement;
let mHeapEl!: HTMLElement;
let mDomEl!: HTMLElement;
let mDcWrapEl: HTMLElement | null = null;
let mDcSepEl: HTMLElement | null = null;
let mDcEl: HTMLElement | null = null;
let mDedupEl!: HTMLElement;
let sparklineLineEl: SVGPolylineElement | null = null;

let pillEmulationEl!: HTMLButtonElement;
let emuPillLabelEl!: HTMLElement;
let pillMirrorMissEl!: HTMLButtonElement;
let mirrorMissLabelEl!: HTMLElement;
let pillConsoleEl!: HTMLButtonElement;
let errConsoleCountEl!: HTMLElement;
let pillNetworkEl!: HTMLButtonElement;
let errNetworkCountEl!: HTMLElement;
let btnDockToggleEl!: HTMLButtonElement;
let dtTargetPortraitEl!: HTMLButtonElement;
let dtTargetLandscapeEl!: HTMLButtonElement;

let loadErrorBannerEl: HTMLElement | null = null;
let loadErrorTextEl: HTMLElement | null = null;
let btnRetryLoadEl: HTMLButtonElement | null = null;
let btnDismissErrorEl: HTMLButtonElement | null = null;
let findBarEl: HTMLElement | null = null;
let findInputEl: HTMLInputElement | null = null;
let findCountEl: HTMLElement | null = null;
let findPrevEl: HTMLButtonElement | null = null;
let findNextEl: HTMLButtonElement | null = null;
let findCloseEl: HTMLButtonElement | null = null;
let btnZoomOutEl: HTMLButtonElement | null = null;
let btnZoomResetEl: HTMLButtonElement | null = null;
let btnZoomInEl: HTMLButtonElement | null = null;
let downloadToastEl: HTMLElement | null = null;

let currentState: ShellState | null = null;
let presets: readonly DevicePreset[] = [];
let lastRenderedHistory: HistoryEntry[] | null = null;
let findBarOpen = false;
let downloadToastTimer: ReturnType<typeof setTimeout> | null = null;

function bindDomElements(doc: Document): void {
  docRef = doc;
  topBarEl = $<HTMLElement>(doc, 'top-bar');
  railEl = $<HTMLElement>(doc, 'zen-rail');
  tabListEl = $<HTMLElement>(doc, 'tab-list');
  portraitHeaderEl = $<HTMLElement>(doc, 'portrait-header');
  splitDividerEl = $<HTMLElement>(doc, 'split-divider');
  landscapeHeaderEl = $<HTMLElement>(doc, 'landscape-header');
  landscapeTagEl = $<HTMLElement>(doc, 'landscape-tag');
  telemetryBarEl = $<HTMLElement>(doc, 'telemetry-bar');
  dockResizeHandleEl = $<HTMLElement>(doc, 'dock-resize-handle');
  devtoolsHeaderEl = $<HTMLElement>(doc, 'devtools-header');

  urlFormEl = $<HTMLFormElement>(doc, 'url-form');
  urlInputEl = $<HTMLInputElement>(doc, 'url-input');
  urlHistoryListEl = $<HTMLDataListElement>(doc, 'url-history-list');
  btnRailEl = $<HTMLButtonElement>(doc, 'btn-rail');
  btnBackEl = $<HTMLButtonElement>(doc, 'btn-back');
  btnForwardEl = $<HTMLButtonElement>(doc, 'btn-forward');
  btnReloadEl = $<HTMLButtonElement>(doc, 'btn-reload');
  btnHistoryEl = $<HTMLButtonElement>(doc, 'btn-history');
  historySectionEl = $<HTMLElement>(doc, 'history-section');
  historyListEl = $<HTMLElement>(doc, 'history-list');
  btnClearHistoryEl = $<HTMLButtonElement>(doc, 'btn-clear-history');
  btnDualEl = $<HTMLButtonElement>(doc, 'btn-dual');
  lblDualEl = $<HTMLElement>(doc, 'lbl-dual');
  btnMirrorEl = $<HTMLButtonElement>(doc, 'btn-mirror');
  lblMirrorEl = $<HTMLElement>(doc, 'lbl-mirror');
  btnSessionEl = $<HTMLButtonElement>(doc, 'btn-session');
  lblSessionEl = $<HTMLElement>(doc, 'lbl-session');
  btnDedupEl = $<HTMLButtonElement>(doc, 'btn-dedup');
  lblDedupEl = $<HTMLElement>(doc, 'lbl-dedup');
  btnEcoEl = $<HTMLButtonElement>(doc, 'btn-eco');
  lblEcoEl = $<HTMLElement>(doc, 'lbl-eco');
  btnAutoSleepEl = $<HTMLButtonElement>(doc, 'btn-auto-sleep');
  lblAutoSleepEl = $<HTMLElement>(doc, 'lbl-auto-sleep');
  btnAgentChatEl = doc.getElementById('btn-agent-chat') as HTMLButtonElement | null;
  lblAgentChatEl = doc.getElementById('lbl-agent-chat');
  agentChatDotEl = doc.getElementById('agent-chat-dot');
  agentResizeHandleEl = doc.getElementById('agent-resize-handle');
  btnThemeEl = $<HTMLButtonElement>(doc, 'btn-theme');
  btnNewTabEl = $<HTMLButtonElement>(doc, 'btn-new-tab');
  selectPortraitEl = $<HTMLSelectElement>(doc, 'select-portrait-preset');
  selectLandscapeEl = $<HTMLSelectElement>(doc, 'select-landscape-preset');
  btnAudioPortraitEl = $<HTMLButtonElement>(doc, 'btn-audio-portrait');
  btnAudioLandscapeEl = $<HTMLButtonElement>(doc, 'btn-audio-landscape');
  portraitFpsEl = $<HTMLElement>(doc, 'portrait-fps');
  landscapeFpsEl = $<HTMLElement>(doc, 'landscape-fps');

  mGpuEl = $<HTMLElement>(doc, 'm-gpu');
  mPortEl = $<HTMLElement>(doc, 'm-port');
  mLandEl = $<HTMLElement>(doc, 'm-land');
  mRamEl = $<HTMLElement>(doc, 'm-ram');
  mFrameEl = $<HTMLElement>(doc, 'm-frame');
  mHeapEl = $<HTMLElement>(doc, 'm-heap');
  mDomEl = $<HTMLElement>(doc, 'm-dom');
  mDcWrapEl = doc.getElementById('m-dc-wrap');
  mDcSepEl = doc.getElementById('m-dc-sep');
  mDcEl = doc.getElementById('m-dc');
  mDedupEl = $<HTMLElement>(doc, 'm-dedup');
  sparklineLineEl = doc.getElementById('sparkline-line') as SVGPolylineElement | null;

  pillEmulationEl = $<HTMLButtonElement>(doc, 'pill-emulation');
  emuPillLabelEl = $<HTMLElement>(doc, 'emu-pill-label');
  pillMirrorMissEl = $<HTMLButtonElement>(doc, 'pill-mirror-miss');
  mirrorMissLabelEl = $<HTMLElement>(doc, 'mirror-miss-label');
  pillConsoleEl = $<HTMLButtonElement>(doc, 'pill-console');
  errConsoleCountEl = $<HTMLElement>(doc, 'err-console-count');
  pillNetworkEl = $<HTMLButtonElement>(doc, 'pill-network');
  errNetworkCountEl = $<HTMLElement>(doc, 'err-network-count');
  btnDockToggleEl = $<HTMLButtonElement>(doc, 'btn-dock-toggle');
  dtTargetPortraitEl = $<HTMLButtonElement>(doc, 'dt-target-portrait');
  dtTargetLandscapeEl = $<HTMLButtonElement>(doc, 'dt-target-landscape');

  loadErrorBannerEl = doc.getElementById('load-error-banner');
  loadErrorTextEl = doc.getElementById('load-error-text');
  btnRetryLoadEl = doc.getElementById('btn-retry-load') as HTMLButtonElement | null;
  btnDismissErrorEl = doc.getElementById('btn-dismiss-error') as HTMLButtonElement | null;
  findBarEl = doc.getElementById('find-bar');
  findInputEl = doc.getElementById('find-input') as HTMLInputElement | null;
  findCountEl = doc.getElementById('find-count');
  findPrevEl = doc.getElementById('find-prev') as HTMLButtonElement | null;
  findNextEl = doc.getElementById('find-next') as HTMLButtonElement | null;
  findCloseEl = doc.getElementById('find-close') as HTMLButtonElement | null;
  btnZoomOutEl = doc.getElementById('btn-zoom-out') as HTMLButtonElement | null;
  btnZoomResetEl = doc.getElementById('btn-zoom-reset') as HTMLButtonElement | null;
  btnZoomInEl = doc.getElementById('btn-zoom-in') as HTMLButtonElement | null;
  downloadToastEl = doc.getElementById('download-toast');
}

function applyRect(el: HTMLElement, rect: Rect | null): void {
  if (!rect) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

const EMU_MENU_OPTIONS: ReadonlyArray<{
  value: string;
  profile: 'sunmi-v2-pro' | 'low-end-android' | 'none';
  label: string;
}> = [
  {
    value: 'emu:sunmi-v2-pro',
    profile: 'sunmi-v2-pro',
    label: 'Throttle: Sunmi V2 Pro (6× · slow-4g)',
  },
  {
    value: 'emu:low-end-android',
    profile: 'low-end-android',
    label: 'Throttle: Low-End Android (4× · fast-4g)',
  },
  {
    value: 'emu:none',
    profile: 'none',
    label: 'Throttle: Off (Reset)',
  },
];

function populatePresets(): void {
  const doc = docRef ?? document;
  selectPortraitEl.innerHTML = '';
  selectLandscapeEl.innerHTML = '';
  for (const preset of presets) {
    const optP = doc.createElement('option');
    optP.value = preset.id;
    optP.textContent = preset.label;
    selectPortraitEl.appendChild(optP);

    const optL = doc.createElement('option');
    optL.value = preset.id;
    optL.textContent = preset.label;
    selectLandscapeEl.appendChild(optL);
  }

  for (const selectEl of [selectPortraitEl, selectLandscapeEl]) {
    const group = doc.createElement('optgroup');
    group.setAttribute('label', 'Slow-Device Emulation');
    for (const item of EMU_MENU_OPTIONS) {
      const opt = doc.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }
}

function renderLayout(state: ShellState): void {
  const doc = docRef ?? document;
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  const errorBannerOpen = Boolean(active?.loadError);
  const layout = computeLayout({
    windowWidth: win?.innerWidth ?? 1480,
    windowHeight: win?.innerHeight ?? 920,
    mode: active?.mode ?? 'single',
    railCollapsed: state.railCollapsed,
    dockOpen: state.dockOpen,
    dockHeight: state.dockHeight,
    splitRatio: state.splitRatio,
    findBarOpen,
    errorBannerOpen,
    agentDockMode: state.agentDock?.mode,
    agentDockWidth: state.agentDock?.width,
    agentFloatBounds: state.agentDock?.floatBounds,
  });

  applyRect(topBarEl, layout.topBar);
  applyRect(railEl, layout.rail);
  if (loadErrorBannerEl) {
    applyRect(loadErrorBannerEl, layout.errorBanner ?? null);
  }
  if (findBarEl) {
    applyRect(findBarEl, layout.findBar ?? null);
  }
  applyRect(portraitHeaderEl, layout.portraitHeader);
  applyRect(splitDividerEl, layout.divider);
  applyRect(landscapeHeaderEl, layout.landscapeHeader);
  applyRect(telemetryBarEl, layout.telemetryBar);
  applyRect(devtoolsHeaderEl, layout.devtoolsHeader);
  if (agentResizeHandleEl) {
    if (state.agentDock?.mode === 'docked' && layout.agentDock) {
      applyRect(agentResizeHandleEl, {
        x: layout.agentDock.x - 4,
        y: layout.agentDock.y,
        width: 6,
        height: layout.agentDock.height,
      });
    } else {
      agentResizeHandleEl.classList.add('hidden');
    }
  }
}

export function renderEmulationPill(emulation: TabEmulationSummary | null | undefined): void {
  if (!emulation || !emulation.active) {
    emuPillLabelEl.textContent = '';
    pillEmulationEl.classList.add('hidden');
    pillEmulationEl.disabled = true;
    return;
  }
  const cleanLabel = sanitizeMirrorMissLabel(emulation.label || emulation.profile, 40);
  emuPillLabelEl.textContent = cleanLabel || 'Active';
  pillEmulationEl.classList.remove('hidden');
  pillEmulationEl.disabled = false;
}

export function renderMirrorMiss(miss: MirrorMissInfo | null | undefined): void {
  if (!miss || !miss.targetLabel) {
    mirrorMissLabelEl.textContent = '';
    pillMirrorMissEl.classList.add('hidden');
    pillMirrorMissEl.disabled = true;
    return;
  }
  const cleanLabel = sanitizeMirrorMissLabel(miss.targetLabel, 32);
  mirrorMissLabelEl.textContent = cleanLabel || 'element';
  pillMirrorMissEl.classList.remove('hidden');
  pillMirrorMissEl.disabled = false;
}

export function historyEquals(
  a: readonly HistoryEntry[] | null,
  b: readonly HistoryEntry[],
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.url !== b[i]!.url || a[i]!.title !== b[i]!.title) {
      return false;
    }
  }
  return true;
}

export function renderState(state: ShellState): void {
  const doc = docRef ?? document;
  currentState = state;
  doc.documentElement.dataset.theme = state.theme;
  renderLayout(state);

  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  if (active) {
    if (doc.activeElement !== urlInputEl) {
      urlInputEl.value = active.url.endsWith('/welcome.html') ? '' : active.url;
    }
    btnBackEl.disabled = !active.canGoBack;
    btnForwardEl.disabled = !active.canGoForward;

    const isDual = active.mode === 'dual';
    btnDualEl.classList.toggle('active', isDual);
    lblDualEl.textContent = isDual ? 'Dual' : 'Single';
    landscapeTagEl.textContent = isDual ? 'LANDSCAPE' : 'VIEWPORT';

    btnMirrorEl.classList.toggle('active', isDual && active.mirror);
    btnMirrorEl.disabled = !isDual;
    lblMirrorEl.textContent = active.mirror ? 'Mirror On' : 'Mirror Off';

    const isIsolated = active.session === 'isolated';
    btnSessionEl.classList.toggle('warn', isIsolated);
    btnSessionEl.classList.toggle('active', !isIsolated);
    lblSessionEl.textContent = isIsolated ? 'Isolated' : 'Shared';

    const dedupAllowed = isDual && !isIsolated && active.mirror;
    const dedupOn = dedupAllowed && active.dedup;
    btnDedupEl.disabled = !dedupAllowed;
    btnDedupEl.classList.toggle('active', dedupOn);
    lblDedupEl.textContent = dedupOn ? 'Dedup On' : 'Dedup Off';
    mDedupEl.textContent = String(active.dedupCount ?? 0);

    selectPortraitEl.value = active.portraitPresetId;
    selectLandscapeEl.value = active.landscapePresetId;

    if (btnZoomResetEl) {
      btnZoomResetEl.textContent = `${Math.round((active.zoomFactor ?? 1) * 100)}%`;
    }
    if (loadErrorTextEl) {
      loadErrorTextEl.textContent = active.loadError
        ? `${active.loadError.errorDescription} (${active.loadError.url})`
        : '';
    }

    const pAudioOn = active.audioSource === 'portrait';
    const lAudioOn = active.audioSource === 'landscape';
    btnAudioPortraitEl.innerHTML = pAudioOn ? ICON_SOUND_ON : ICON_SOUND_OFF;
    btnAudioPortraitEl.classList.toggle('active', pAudioOn);
    btnAudioPortraitEl.title = pAudioOn ? 'Portrait audio ON (click to mute)' : 'Portrait audio muted (click to switch audio here)';
    btnAudioLandscapeEl.innerHTML = lAudioOn ? ICON_SOUND_ON : ICON_SOUND_OFF;
    btnAudioLandscapeEl.classList.toggle('active', lAudioOn);
    btnAudioLandscapeEl.title = lAudioOn ? 'Landscape audio ON (click to mute)' : 'Landscape audio muted (click to switch audio here)';

    dtTargetPortraitEl.disabled = !isDual;
    dtTargetPortraitEl.classList.toggle('active', isDual && active.devtoolsTarget === 'portrait');
    dtTargetLandscapeEl.classList.toggle(
      'active',
      !isDual || active.devtoolsTarget === 'landscape',
    );
  } else {
    btnDedupEl.disabled = true;
    btnDedupEl.classList.remove('active');
    lblDedupEl.textContent = 'Dedup Off';
    mDedupEl.textContent = '0';
  }

  btnEcoEl.classList.toggle('active', state.ecoMode);
  lblEcoEl.textContent = state.ecoMode ? 'Eco' : 'HiDPI';

  btnAutoSleepEl.classList.toggle('active', state.autoSleep);
  lblAutoSleepEl.textContent = state.autoSleep ? 'Auto-Sleep On' : 'Auto-Sleep';

  if (btnAgentChatEl && lblAgentChatEl) {
    const dock = state.agentDock;
    const open = Boolean(dock && dock.mode !== 'minimized');
    const live = Boolean(dock?.session.active);
    btnAgentChatEl.classList.toggle('active', open);
    agentChatDotEl?.classList.toggle('live', live);
    lblAgentChatEl.textContent = live
      ? `Agent: ${sanitizeMirrorMissLabel(dock!.session.label, 18)}`
      : open
        ? 'Agent Chat'
        : 'Chat';
  }

  btnDockToggleEl.classList.toggle('active', state.dockOpen);
  renderEmulationPill(active?.emulation);
  renderMirrorMiss(state.mirrorMiss);

  // Render vertical tab list
  tabListEl.innerHTML = '';
  for (const tab of state.tabs) {
    const row = doc.createElement('div');
    row.className = 'tab-row';
    if (tab.id === state.activeTabId) row.classList.add('active');
    if (tab.sleeping) row.classList.add('sleeping');

    const dot = doc.createElement('span');
    dot.className = 'tab-dot';

    const meta = doc.createElement('div');
    meta.className = 'tab-meta';

    const title = doc.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New Tab';

    const sub = doc.createElement('span');
    sub.className = 'tab-sub';
    sub.textContent = tab.sleeping
      ? 'sleeping'
      : `${tab.mode === 'dual' ? 'dual' : 'single'}${tab.mirror && tab.mode === 'dual' ? ' · sync' : ''}`;

    meta.append(title, sub);

    const actions = doc.createElement('div');
    actions.className = 'tab-actions';

    const sleepBtn = doc.createElement('button');
    sleepBtn.className = 'tab-mini-btn';
    sleepBtn.title = tab.sleeping ? 'Wake Tab' : 'Sleep Tab';
    sleepBtn.innerHTML =
      '<svg viewBox="0 0 16 16"><path d="M11.5 10.5A4.8 4.8 0 0 1 5.5 4.5a4.8 4.8 0 1 0 6 6z"/></svg>';
    sleepBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void getApi().sleepTab(tab.id).then(renderState);
    });

    const closeBtn = doc.createElement('button');
    closeBtn.className = 'tab-mini-btn';
    closeBtn.title = 'Close Tab';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void getApi().closeTab(tab.id).then(renderState);
    });

    actions.append(sleepBtn, closeBtn);
    row.append(dot, meta, actions);
    row.addEventListener('click', () => {
      void getApi().selectTab(tab.id).then(renderState);
    });
    tabListEl.appendChild(row);
  }

  renderHistory(state);
}

function formatShortUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const tail = `${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`;
    const full = `${u.host}${tail}`;
    return full.length > 42 ? `${full.slice(0, 41)}…` : full;
  } catch {
    return rawUrl.slice(0, 42);
  }
}

export function renderHistory(state: ShellState): void {
  const doc = docRef ?? document;
  const entries = state.history ?? [];
  if (historyEquals(lastRenderedHistory, entries)) {
    return;
  }
  lastRenderedHistory = entries.map((e) => ({ ...e }));

  urlHistoryListEl.innerHTML = '';
  for (const item of entries) {
    const opt = doc.createElement('option');
    opt.value = item.url;
    opt.label = item.title;
    urlHistoryListEl.appendChild(opt);
  }

  historySectionEl.classList.toggle('hidden', entries.length === 0);
  historyListEl.innerHTML = '';
  for (const item of entries.slice(0, 10)) {
    const row = doc.createElement('div');
    row.className = 'history-row';
    row.title = `${item.title}\n${item.url}\n(Click to open · Ctrl+Click for new tab)`;

    const meta = doc.createElement('div');
    meta.className = 'history-meta';

    const title = doc.createElement('span');
    title.className = 'history-title';
    title.textContent = item.title || formatShortUrl(item.url);

    const sub = doc.createElement('span');
    sub.className = 'history-url';
    sub.textContent = formatShortUrl(item.url);

    meta.append(title, sub);

    const delBtn = doc.createElement('button');
    delBtn.className = 'tab-mini-btn history-del-btn';
    delBtn.title = 'Remove from history';
    delBtn.innerHTML =
      '<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void getApi().removeHistoryItem(item.url).then(renderState);
    });

    row.append(meta, delBtn);
    row.addEventListener('click', (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        void getApi().newTab(item.url).then(renderState);
      } else {
        void getApi().navigate(item.url).then(renderState);
      }
    });
    row.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        void getApi().newTab(item.url).then(renderState);
      }
    });
    historyListEl.appendChild(row);
  }
}

export function renderTelemetry(snap: TelemetrySnapshot): void {
  mGpuEl.textContent = `${snap.gpuCpuPercent.toFixed(1)}%`;
  mPortEl.textContent = snap.portrait
    ? `${snap.portrait.cpuPercent.toFixed(1)}% / ${Math.round(snap.portrait.memoryMb)}MB`
    : 'off';
  mLandEl.textContent = snap.landscape
    ? `${snap.landscape.cpuPercent.toFixed(1)}% / ${Math.round(snap.landscape.memoryMb)}MB`
    : '--';
  mRamEl.textContent = `${Math.round(snap.totalMemoryMb)} MB`;

  const primaryFrame = snap.portrait && snap.portrait.fps > 0 ? snap.portrait : snap.landscape;
  if (primaryFrame && primaryFrame.fps > 0) {
    mFrameEl.textContent = `${Math.round(primaryFrame.fps)}fps (p95 ${primaryFrame.p95FrameMs.toFixed(1)}ms · ${primaryFrame.jankCount}j)`;
  } else {
    mFrameEl.textContent = snap.paused ? 'paused' : 'idle';
  }

  portraitFpsEl.textContent = snap.portrait
    ? `${Math.round(snap.portrait.fps)} fps · ${snap.portrait.p95FrameMs.toFixed(1)}ms`
    : '-- fps';
  landscapeFpsEl.textContent = snap.landscape
    ? `${Math.round(snap.landscape.fps)} fps · ${snap.landscape.p95FrameMs.toFixed(1)}ms`
    : '-- fps';

  const heapMb = (snap.portrait?.jsHeapUsedMb ?? 0) + (snap.landscape?.jsHeapUsedMb ?? 0);
  const domNodes = (snap.portrait?.domNodes ?? 0) + (snap.landscape?.domNodes ?? 0);
  mHeapEl.textContent = `${heapMb.toFixed(1)} MB`;
  mDomEl.textContent = `${domNodes}`;

  if (mDcWrapEl && mDcSepEl && mDcEl) {
    const pGl = snap.portrait?.webgl;
    const lGl = snap.landscape?.webgl;
    const glCount = (pGl?.contexts ?? 0) + (lGl?.contexts ?? 0);
    if (glCount > 0) {
      const dc = (pGl?.drawCallsPerFrame ?? 0) + (lGl?.drawCallsPerFrame ?? 0);
      mDcEl.textContent = String(dc);
      mDcWrapEl.classList.remove('hidden');
      mDcSepEl.classList.remove('hidden');
    } else {
      mDcWrapEl.classList.add('hidden');
      mDcSepEl.classList.add('hidden');
    }
  }

  if (sparklineLineEl && primaryFrame && primaryFrame.recentFrameMs.length > 1) {
    const samples = primaryFrame.recentFrameMs;
    const maxMs = Math.max(33.3, ...samples);
    const pts = samples
      .map((ms, idx) => {
        const x = (idx / (samples.length - 1)) * 64;
        const y = 15 - Math.min(1, ms / maxMs) * 14;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    sparklineLineEl.setAttribute('points', pts);
  }

  errConsoleCountEl.textContent = String(snap.consoleErrorCount);
  pillConsoleEl.classList.toggle('has-errors', snap.consoleErrorCount > 0);
  errNetworkCountEl.textContent = String(snap.failedNetworkCount);
  pillNetworkEl.classList.toggle('has-errors', snap.failedNetworkCount > 0);

  if (snap.emulation !== undefined) {
    renderEmulationPill(snap.emulation);
  }
  if (snap.mirrorMiss !== undefined) {
    renderMirrorMiss(snap.mirrorMiss);
  }
}

function openFindBar(): void {
  findBarOpen = true;
  if (currentState) renderLayout(currentState);
  void getApi().setFindOpen?.(true);
  if (findInputEl) {
    findInputEl.focus();
    findInputEl.select();
    if (findInputEl.value) {
      void getApi().findInPage?.(findInputEl.value, { forward: true, findNext: true });
    }
  }
}

function closeFindBar(notifyBackend = true): void {
  findBarOpen = false;
  if (findCountEl) {
    findCountEl.textContent = '0 / 0';
  }
  if (currentState) renderLayout(currentState);
  if (notifyBackend) {
    void getApi().stopFindInPage?.('clearSelection');
    void getApi().setFindOpen?.(false);
  }
}

function renderFindResult(res: FindInPageResult): void {
  if (!findCountEl) return;
  findCountEl.textContent =
    res.matches > 0 ? `${res.activeMatchOrdinal} / ${res.matches}` : '0 / 0';
}

function renderDownloadToast(ev: DownloadProgressInfo): void {
  if (!downloadToastEl) return;
  if (downloadToastTimer) {
    clearTimeout(downloadToastTimer);
    downloadToastTimer = null;
  }
  let text: string;
  if (ev.state === 'progressing') {
    if (ev.totalBytes > 0) {
      const pct = Math.min(100, Math.round((ev.receivedBytes / ev.totalBytes) * 100));
      text = `Downloading ${ev.filename} (${pct}%)`;
    } else {
      text = `Downloading ${ev.filename}...`;
    }
  } else if (ev.state === 'completed') {
    text = `Saved ${ev.filename}`;
  } else if (ev.state === 'cancelled') {
    text = `Cancelled ${ev.filename}`;
  } else {
    text = `Failed ${ev.filename}`;
  }
  downloadToastEl.textContent = text;
  downloadToastEl.classList.remove('hidden');
  downloadToastEl.classList.toggle(
    'error',
    ev.state === 'interrupted' || ev.state === 'cancelled',
  );
  if (ev.state !== 'progressing') {
    downloadToastTimer = setTimeout(() => {
      downloadToastTimer = null;
      downloadToastEl?.classList.add('hidden');
    }, 10_000);
  }
}

function wireEvents(): void {
  const doc = docRef ?? document;
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);

  urlFormEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const val = urlInputEl.value.trim();
    if (!val) return;
    void getApi().navigate(val).then(renderState);
    urlInputEl.blur();
  });

  btnRailEl.addEventListener('click', () => {
    if (!currentState) return;
    void getApi().setRailCollapsed(!currentState.railCollapsed).then(renderState);
  });
  btnBackEl.addEventListener('click', () => void getApi().goBack());
  btnForwardEl.addEventListener('click', () => void getApi().goForward());
  btnReloadEl.addEventListener('click', () =>
    void (apiRef ? apiRef.reload() : window.ironShell.reload()),
  );
  btnHistoryEl.addEventListener('click', () => {
    const rect = btnHistoryEl.getBoundingClientRect();
    void getApi().openHistoryMenu(rect.left, rect.bottom + 4);
  });
  btnClearHistoryEl.addEventListener('click', () => {
    void getApi().clearHistory().then(renderState);
  });
  btnDualEl.addEventListener('click', () => void getApi().toggleDualMode().then(renderState));
  btnMirrorEl.addEventListener('click', () => void getApi().toggleMirror().then(renderState));
  btnSessionEl.addEventListener('click', () =>
    void getApi().toggleSessionMode().then(renderState),
  );
  btnDedupEl.addEventListener('click', () => void getApi().toggleDedup().then(renderState));
  btnEcoEl.addEventListener('click', () => void getApi().toggleEcoMode().then(renderState));
  btnAutoSleepEl.addEventListener('click', () => {
    if (!currentState) return;
    void getApi().setAutoSleep(!currentState.autoSleep).then(renderState);
  });
  btnAgentChatEl?.addEventListener('click', () => {
    const fn = getApi().toggleAgentDock;
    if (typeof fn === 'function') {
      void fn.call(getApi()).then(renderState);
    }
  });
  agentResizeHandleEl?.addEventListener('pointerdown', (startEv) => {
    if (!currentState || currentState.agentDock?.mode !== 'docked') return;
    agentResizeHandleEl!.setPointerCapture(startEv.pointerId);
    const onMove = (ev: PointerEvent) => {
      const nextWidth = (win?.innerWidth ?? 1480) - ev.clientX;
      const fn = getApi().setAgentDockWidth;
      if (typeof fn === 'function') {
        void fn.call(getApi(), nextWidth).then(renderState);
      }
    };
    const onUp = () => {
      agentResizeHandleEl?.removeEventListener('pointermove', onMove);
      agentResizeHandleEl?.removeEventListener('pointerup', onUp);
    };
    agentResizeHandleEl!.addEventListener('pointermove', onMove);
    agentResizeHandleEl!.addEventListener('pointerup', onUp);
  });
  btnThemeEl.addEventListener('click', () => {
    if (!currentState) return;
    const next = currentState.theme === 'dark' ? 'light' : 'dark';
    void getApi().setTheme(next).then(renderState);
  });
  btnNewTabEl.addEventListener('click', () => void getApi().newTab().then(renderState));

  const handlePresetOrProfileSelect = (
    role: 'portrait' | 'landscape',
    selectEl: HTMLSelectElement,
  ) => {
    const val = selectEl.value;
    if (val.startsWith('emu:')) {
      const st = currentState;
      const active = st?.tabs.find((t) => t.id === st.activeTabId) ?? st?.tabs[0];
      if (active) {
        selectEl.value = role === 'portrait' ? active.portraitPresetId : active.landscapePresetId;
      }
      const rawProfile = val.slice(4);
      if (
        rawProfile === 'sunmi-v2-pro' ||
        rawProfile === 'low-end-android' ||
        rawProfile === 'none'
      ) {
        void getApi().setEmulationProfile(rawProfile, 'both').then(renderState);
      }
      return;
    }
    void getApi().setPreset(role, val).then(renderState);
  };

  selectPortraitEl.addEventListener('change', () => {
    handlePresetOrProfileSelect('portrait', selectPortraitEl);
  });
  selectLandscapeEl.addEventListener('change', () => {
    handlePresetOrProfileSelect('landscape', selectLandscapeEl);
  });
  btnAudioPortraitEl.addEventListener('click', () => {
    void getApi().toggleAudio('portrait').then(renderState);
  });
  btnAudioLandscapeEl.addEventListener('click', () => {
    void getApi().toggleAudio('landscape').then(renderState);
  });

  pillEmulationEl.addEventListener('click', () => {
    void getApi().setEmulationProfile('none', 'both').then(renderState);
  });
  pillMirrorMissEl.addEventListener('click', () => {
    void getApi().copyMirrorMissDebug();
  });
  pillConsoleEl.addEventListener('click', () =>
    void getApi().focusAnomaly('console').then(renderState),
  );
  pillNetworkEl.addEventListener('click', () =>
    void getApi().focusAnomaly('network').then(renderState),
  );
  btnDockToggleEl.addEventListener('click', () => {
    if (!currentState) return;
    void getApi().setDockOpen(!currentState.dockOpen).then(renderState);
  });
  dtTargetPortraitEl.addEventListener('click', () =>
    void getApi().setDevToolsTarget('portrait').then(renderState),
  );
  dtTargetLandscapeEl.addEventListener('click', () =>
    void getApi().setDevToolsTarget('landscape').then(renderState),
  );

  // Split divider drag
  splitDividerEl.addEventListener('pointerdown', (startEv) => {
    if (!currentState) return;
    splitDividerEl.setPointerCapture(startEv.pointerId);
    splitDividerEl.classList.add('dragging');
    const railW = currentState.railCollapsed ? 0 : 216;
    const agentW =
      currentState.agentDock?.mode === 'docked' ? (currentState.agentDock.width ?? 360) : 0;
    const contentW = Math.max(200, (win?.innerWidth ?? 1480) - railW - agentW);

    const onMove = (ev: PointerEvent) => {
      const ratio = (ev.clientX - railW) / contentW;
      void getApi().setSplitRatio(ratio).then(renderState);
    };
    const onUp = () => {
      splitDividerEl.classList.remove('dragging');
      splitDividerEl.removeEventListener('pointermove', onMove);
      splitDividerEl.removeEventListener('pointerup', onUp);
    };
    splitDividerEl.addEventListener('pointermove', onMove);
    splitDividerEl.addEventListener('pointerup', onUp);
  });

  // Dock height drag
  dockResizeHandleEl.addEventListener('pointerdown', (startEv) => {
    if (!currentState || !currentState.dockOpen) return;
    dockResizeHandleEl.setPointerCapture(startEv.pointerId);
    const onMove = (ev: PointerEvent) => {
      const nextHeight = (win?.innerHeight ?? 920) - ev.clientY;
      void getApi().setDockHeight(nextHeight).then(renderState);
    };
    const onUp = () => {
      dockResizeHandleEl.removeEventListener('pointermove', onMove);
      dockResizeHandleEl.removeEventListener('pointerup', onUp);
    };
    dockResizeHandleEl.addEventListener('pointermove', onMove);
    dockResizeHandleEl.addEventListener('pointerup', onUp);
  });

  win?.addEventListener('resize', () => {
    if (currentState) renderLayout(currentState);
  });

  btnRetryLoadEl?.addEventListener('click', () => {
    void getApi().retryLoad?.().then((st) => {
      if (st) renderState(st);
    });
  });

  btnDismissErrorEl?.addEventListener('click', () => {
    void getApi().dismissLoadError?.().then((st) => {
      if (st) renderState(st);
    });
  });

  btnZoomOutEl?.addEventListener('click', () => {
    void getApi().zoomOut?.().then((st) => {
      if (st) renderState(st);
    });
  });

  btnZoomResetEl?.addEventListener('click', () => {
    void getApi().zoomReset?.().then((st) => {
      if (st) renderState(st);
    });
  });

  btnZoomInEl?.addEventListener('click', () => {
    void getApi().zoomIn?.().then((st) => {
      if (st) renderState(st);
    });
  });

  findInputEl?.addEventListener('input', () => {
    const query = findInputEl?.value ?? '';
    if (!query) {
      if (findCountEl) findCountEl.textContent = '0 / 0';
      void getApi().stopFindInPage?.('clearSelection');
      return;
    }
    void getApi().findInPage?.(query, { forward: true, findNext: true });
  });

  findInputEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const query = findInputEl?.value ?? '';
      if (query) {
        void getApi().findInPage?.(query, { forward: !ev.shiftKey, findNext: false });
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeFindBar(true);
    }
  });

  findNextEl?.addEventListener('click', () => {
    const query = findInputEl?.value ?? '';
    if (query) {
      void getApi().findInPage?.(query, { forward: true, findNext: false });
    }
  });

  findPrevEl?.addEventListener('click', () => {
    const query = findInputEl?.value ?? '';
    if (query) {
      void getApi().findInPage?.(query, { forward: false, findNext: false });
    }
  });

  findCloseEl?.addEventListener('click', () => {
    closeFindBar(true);
  });

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', (ev: KeyboardEvent) => {
      const ctrl = ev.ctrlKey || ev.metaKey;
      const key = (ev.key ?? '').toLowerCase();
      if (ctrl && !ev.shiftKey && !ev.altKey && key === 'f') {
        ev.preventDefault();
        openFindBar();
      } else if (!ctrl && !ev.shiftKey && !ev.altKey && ev.key === 'Escape' && findBarOpen) {
        ev.preventDefault();
        closeFindBar(true);
      } else if (
        ctrl &&
        !ev.altKey &&
        (ev.key === '=' || ev.key === '+' || ev.code === 'Equal' || ev.code === 'NumpadAdd')
      ) {
        ev.preventDefault();
        void getApi().zoomIn?.().then((st) => {
          if (st) renderState(st);
        });
      } else if (
        ctrl &&
        !ev.altKey &&
        (ev.key === '-' || ev.key === '_' || ev.code === 'Minus' || ev.code === 'NumpadSubtract')
      ) {
        ev.preventDefault();
        void getApi().zoomOut?.().then((st) => {
          if (st) renderState(st);
        });
      } else if (
        ctrl &&
        !ev.shiftKey &&
        !ev.altKey &&
        (ev.key === '0' || ev.code === 'Digit0' || ev.code === 'Numpad0')
      ) {
        ev.preventDefault();
        void getApi().zoomReset?.().then((st) => {
          if (st) renderState(st);
        });
      }
    });
  }
}

export async function mountShell(
  doc: Document = document,
  api: IronShellApi = window.ironShell,
): Promise<void> {
  apiRef = api;
  lastRenderedHistory = null;
  currentState = null;
  findBarOpen = false;
  if (downloadToastTimer) {
    clearTimeout(downloadToastTimer);
    downloadToastTimer = null;
  }
  bindDomElements(doc);
  wireEvents();
  const initial = await api.getInitialState();
  presets = initial.presets;
  populatePresets();
  renderState(initial.state);

  api.onStateUpdate(renderState);
  api.onTelemetry(renderTelemetry);
  api.onFocusUrlBar(() => {
    urlInputEl.focus();
    urlInputEl.select();
  });
  api.onOpenFind?.(() => openFindBar());
  api.onCloseFind?.(() => closeFindBar(false));
  api.onFindResult?.(renderFindResult);
  api.onDownloadEvent?.(renderDownloadToast);
}

if (typeof document !== 'undefined' && document.getElementById('shell-root')) {
  void mountShell(document, window.ironShell);
}
