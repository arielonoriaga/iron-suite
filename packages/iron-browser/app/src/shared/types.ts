export type ViewportRole = 'portrait' | 'landscape';
export type ViewMode = 'single' | 'dual';
export type SessionMode = 'shared' | 'isolated';
export type ThemeMode = 'dark' | 'light';
export type AgentDockMode = 'docked' | 'floating' | 'minimized';
export type AgentCliPreset = 'agy' | 'claude' | 'codex' | 'opencode' | 'shell' | 'custom';
export type AgentInstanceKind = 'tmux' | 'iron-term';

export interface AgentCliOption {
  id: string;
  label: string;
  preset: AgentCliPreset;
  command?: string;
  available: boolean;
  source: 'builtin' | 'env' | 'shell';
}

export interface RunningAgentInstance {
  target: string;
  windowName: string;
  command: string;
  cwd: string;
  pid: number;
  isAgentLike: boolean;
  kind?: AgentInstanceKind;
  sessionId?: string;
  state?: string;
}

export interface AgentSessionSnapshot {
  active: boolean;
  kind: 'none' | 'pty' | 'tmux' | 'iron-term';
  label: string;
  preset?: AgentCliPreset;
  targetPane?: string;
  cwd?: string;
  pid?: number | null;
  exited?: boolean;
  exitCode?: number | null;
  socketPath: string;
}

export interface AgentDockState {
  mode: AgentDockMode;
  width: number;
  floatBounds: Rect;
  session: AgentSessionSnapshot;
}

export interface WebGlViewportSummary {
  contexts: number;
  webgl2Contexts: number;
  drawCallsPerFrame: number;
  trianglesPerFrame: number;
  verticesPerFrame: number;
  instancedDrawCallsPerFrame: number;
  shaderSwitchesPerFrame: number;
  textureBindsPerFrame: number;
  renderPassesPerFrame: number;
  peakDrawCallsPerFrame: number;
  totalDrawCalls: number;
  resources: {
    programs: number;
    textures: number;
    buffers: number;
    framebuffers: number;
    renderbuffers: number;
    vaos: number;
  };
  contextLostCount: number;
  contextLost: boolean;
  renderer?: string;
  vendor?: string;
}

export interface WebGlRecordedDrawCall {
  seq: number;
  canvasIndex: number;
  passIndex: number;
  fboTarget: string;
  api: string;
  mode: string;
  count: number;
  instances: number;
  triangles: number;
  vertices: number;
  programId: number | null;
  activeTextureUnit: number;
  boundTexture2d: number | null;
  blendEnabled: boolean;
  depthTest: boolean;
  cullFace: boolean;
  scissorEnabled: boolean;
  viewport: [number, number, number, number];
}

export interface RenderingOrderLayer {
  paintOrder: number;
  selector: string;
  tag: string;
  isCanvas: boolean;
  canvasKind?: 'webgl2' | 'webgl' | '2d' | 'bitmaprenderer' | 'unknown';
  zIndex: string;
  position: string;
  opacity: number;
  createsStackingContext: boolean;
  compositorReasons: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

export type NetworkConditionPreset = 'none' | 'fast-4g' | 'slow-4g' | '3g' | 'offline';
export type EmulationProfileId = 'none' | 'sunmi-v2-pro' | 'low-end-android' | 'custom';

export interface NetworkEmulationConfig {
  preset: NetworkConditionPreset | 'custom';
  offline: boolean;
  latencyMs: number;
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
}

export interface CalibrationResult {
  hostScore: number;
  targetScore: number;
  chosenRate: number;
  resultingScore: number;
  measuredAtMs: number;
}

export interface ViewportEmulationState {
  active: boolean;
  profile: EmulationProfileId;
  cpuRate: number;
  network: NetworkEmulationConfig;
  presetId: string | null;
  userAgent: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  reducedMotion: boolean;
  saveData: boolean;
  targetScore: number | null;
  lastCalibration: CalibrationResult | null;
}

export interface TabEmulationSummary {
  active: boolean;
  profile: EmulationProfileId;
  label: string;
  portrait: ViewportEmulationState;
  landscape: ViewportEmulationState;
}

export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  dpr: number;
  touch: boolean;
  category: ViewportRole;
}

export interface ViewportDimensions {
  width: number;
  height: number;
  dpr: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutInput {
  windowWidth: number;
  windowHeight: number;
  mode: ViewMode;
  railCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  splitRatio: number;
  findBarOpen?: boolean;
  errorBannerOpen?: boolean;
  agentDockMode?: AgentDockMode;
  agentDockWidth?: number;
  agentFloatBounds?: Rect;
}

export interface LayoutResult {
  topBar: Rect;
  rail: Rect | null;
  errorBanner?: Rect | null;
  findBar?: Rect | null;
  portraitHeader: Rect | null;
  portraitView: Rect | null;
  divider: Rect | null;
  landscapeHeader: Rect;
  landscapeView: Rect;
  telemetryBar: Rect;
  devtoolsHeader: Rect | null;
  devtoolsView: Rect | null;
  agentDock?: Rect | null;
  clampedSplitRatio: number;
  clampedDockHeight: number;
  clampedAgentWidth?: number;
}

export interface ClippedElementDetail {
  selector: string;
  tag: string;
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  overflowPx: {
    left: number;
    right: number;
  };
}

export interface ScreenshotStageError {
  stage: string;
  viewport: ViewportRole;
  error: string;
}

export interface ViewportSizingSummary {
  role: ViewportRole;
  requestedSize: ViewportDimensions;
  effectiveCssSize: { width: number; height: number } | null;
  dpr: number | null;
  capturedPixels: { width: number; height: number } | null;
  exactSizeApplied?: boolean;
  sizeMismatch: boolean;
  mismatchReason?: string;
}

export interface TabLoadError {
  viewport: ViewportRole;
  errorCode: number;
  errorDescription: string;
  url: string;
  timestampMs: number;
}

export interface FindInPageResult {
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
  viewport: ViewportRole;
}

export interface DownloadProgressInfo {
  id: string;
  tabId: string;
  viewport: ViewportRole;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  savePath?: string | null;
}

export interface TabSnapshot {
  id: string;
  title: string;
  url: string;
  mode: ViewMode;
  mirror: boolean;
  dedup: boolean;
  session: SessionMode;
  sleeping: boolean;
  portraitPresetId: string;
  landscapePresetId: string;
  portraitSize: ViewportDimensions;
  landscapeSize: ViewportDimensions;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  devtoolsTarget: ViewportRole;
  audioSource: ViewportRole | 'muted';
  dedupCount: number;
  zoomFactor?: number;
  loadError?: TabLoadError | null;
  viewportReport?: Partial<Record<ViewportRole, ViewportSizingSummary>>;
  emulation?: TabEmulationSummary;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface MirrorMissInfo {
  reason: string;
  targetLabel: string;
  timestamp: number;
  url?: string;
}

export interface ShellState {
  tabs: TabSnapshot[];
  activeTabId: string | null;
  railCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  splitRatio: number;
  theme: ThemeMode;
  ecoMode: boolean;
  autoSleep: boolean;
  mirrorMiss?: MirrorMissInfo | null;
  agentDock?: AgentDockState;
  history: HistoryEntry[];
  closedTabCount: number;
}

export interface ElementFingerprint {
  testId?: string;
  id?: string;
  ariaLabel?: string;
  title?: string;
  name?: string;
  role?: string;
  text?: string;
  tag: string;
  classTokens?: string[];
  occurrenceIndex?: number;
  clickedSelfDirect?: boolean;
  elemRelX?: number;
  elemRelY?: number;
  dismissedOverlay?: boolean;
  iframePath?: number[];
  toggleState?: Record<string, string | null>;
  cssPath: string;
  isCanvas: boolean;
  canvasIndex?: number;
  normalizedX?: number;
  normalizedY?: number;
  relViewportX: number;
  relViewportY: number;
}

export interface MirrorCaptureMeta {
  pointerType?: string;
  toggleState?: Record<string, string | null>;
  iframePath?: number[];
  topNormX?: number;
  topNormY?: number;
}

export type MirrorCaptureEvent = (
  | {
      kind: 'click' | 'pointerdown' | 'pointerup' | 'hover';
      fingerprint: ElementFingerprint;
      button: 'left' | 'middle' | 'right';
      clickCount: number;
      modifiers: string[];
    }
  | {
      kind: 'input' | 'change';
      fingerprint: ElementFingerprint;
      value: string;
      checked?: boolean;
      inputType?: string;
      inputOp?: string;
      insertedText?: string;
    }
  | {
      kind: 'keydown' | 'keyup';
      fingerprint: ElementFingerprint;
      key: string;
      code: string;
      modifiers: string[];
      repeat?: boolean;
      holdUntilKeyup?: boolean;
      sensitive?: boolean;
      observeOnly?: boolean;
    }
  | {
      kind: 'wheel';
      fingerprint: ElementFingerprint;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'scroll';
      ratioX: number;
      ratioY: number;
      scrollX: number;
      scrollY: number;
    }
) &
  MirrorCaptureMeta;

export interface FrameStats {
  fps: number;
  p95FrameMs: number;
  jankCount: number;
  recentFrameMs: number[];
}

export interface ViewportMetrics {
  role: ViewportRole;
  pid: number | null;
  cpuPercent: number;
  memoryMb: number;
  jsHeapUsedMb: number;
  domNodes: number;
  layoutCount: number;
  recalcStyleCount: number;
  fps: number;
  p95FrameMs: number;
  jankCount: number;
  recentFrameMs: number[];
  webgl?: WebGlViewportSummary | null;
}

export interface TelemetrySnapshot {
  timestampMs: number;
  gpuCpuPercent: number;
  gpuProcessCpuPercent?: number;
  gpuExecutionTimeMs?: number | null;
  gpuMetricLabels?: {
    gpuProcessCpuPercent: string;
    gpuExecutionTimeMs: string;
  };
  gpuMemoryMb: number;
  totalMemoryMb: number;
  portrait: ViewportMetrics | null;
  landscape: ViewportMetrics | null;
  consoleErrorCount: number;
  failedNetworkCount: number;
  paused: boolean;
  mirrorMiss?: MirrorMissInfo | null;
  emulation?: TabEmulationSummary | null;
}

export interface IronShellApi {
  getInitialState(): Promise<{ state: ShellState; presets: readonly DevicePreset[] }>;
  newTab(url?: string, mode?: ViewMode): Promise<ShellState>;
  closeTab(tabId: string): Promise<ShellState>;
  selectTab(tabId: string): Promise<ShellState>;
  sleepTab(tabId: string): Promise<ShellState>;
  navigate(url: string): Promise<ShellState>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  toggleDualMode(): Promise<ShellState>;
  toggleMirror(): Promise<ShellState>;
  toggleDedup(tabId?: string): Promise<ShellState>;
  toggleSessionMode(): Promise<ShellState>;
  setSessionMode(mode: SessionMode): Promise<ShellState>;
  setPreset(role: ViewportRole, presetId: string): Promise<ShellState>;
  setEmulationProfile(
    profile: 'none' | 'sunmi-v2-pro' | 'low-end-android',
    viewport?: ViewportRole | 'both',
    tabId?: string,
  ): Promise<ShellState>;
  setRailCollapsed(collapsed: boolean): Promise<ShellState>;
  setDockOpen(open: boolean): Promise<ShellState>;
  setDockHeight(height: number): Promise<ShellState>;
  setSplitRatio(ratio: number): Promise<ShellState>;
  setDevToolsTarget(role: ViewportRole): Promise<ShellState>;
  toggleAudio(role: ViewportRole): Promise<ShellState>;
  setTheme(theme: ThemeMode): Promise<ShellState>;
  toggleEcoMode(): Promise<ShellState>;
  setAutoSleep(enabled: boolean): Promise<ShellState>;
  copyMirrorMissDebug(): Promise<boolean>;
  focusAnomaly(kind: 'console' | 'network'): Promise<ShellState>;
  openHistoryMenu(x?: number, y?: number): Promise<void>;
  removeHistoryItem(url: string): Promise<ShellState>;
  clearHistory(): Promise<ShellState>;
  reopenClosedTab(): Promise<ShellState>;
  toggleAgentDock?(): Promise<ShellState>;
  setAgentDockMode?(mode: AgentDockMode): Promise<ShellState>;
  setAgentDockWidth?(width: number): Promise<ShellState>;
  sendContextToAgent?(): Promise<boolean>;
  findInPage?(
    text: string,
    opts?: { forward?: boolean; findNext?: boolean; matchCase?: boolean; viewport?: ViewportRole },
  ): Promise<void>;
  stopFindInPage?(
    action?: 'clearSelection' | 'keepSelection' | 'activateSelection',
  ): Promise<void>;
  setFindOpen?(open: boolean): Promise<void>;
  zoomIn?(): Promise<ShellState>;
  zoomOut?(): Promise<ShellState>;
  zoomReset?(): Promise<ShellState>;
  retryLoad?(tabId?: string): Promise<ShellState>;
  dismissLoadError?(tabId?: string): Promise<ShellState>;
  onStateUpdate(cb: (state: ShellState) => void): () => void;
  onTelemetry(cb: (snapshot: TelemetrySnapshot) => void): () => void;
  onFocusUrlBar(cb: () => void): () => void;
  onOpenFind?(cb: () => void): () => void;
  onCloseFind?(cb: () => void): () => void;
  onFindResult?(cb: (res: FindInPageResult) => void): () => void;
  onDownloadEvent?(cb: (ev: DownloadProgressInfo) => void): () => void;
}

export interface ConsoleEntry {
  id: number;
  timestampMs: number;
  tabId: string;
  viewport: ViewportRole;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  url?: string;
  line?: number;
  source?: 'console-api' | 'exception' | 'log';
}

export interface NetworkInitiatorFrame {
  functionName: string;
  url: string;
  line: number;
  column: number;
  location: string;
  async?: boolean;
  asyncDescription?: string;
}

export interface NetworkInitiatorInfo {
  type: string;
  url?: string;
  line?: number;
  column?: number;
  frames: NetworkInitiatorFrame[];
}

export interface NetworkEntry {
  id: string;
  timestampMs: number;
  tabId: string;
  viewport: ViewportRole;
  method: string;
  url: string;
  status: number | null;
  failed: boolean;
  errorText?: string;
  resourceType?: string;
  mimeType?: string;
  protocol?: string;
  fromCache?: boolean;
  ttfbMs?: number;
  durationMs?: number;
  encodedBytes?: number;
  decodedBytes?: number;
  initiator?: NetworkInitiatorInfo;
}

export interface CtlRpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface CtlRpcResponse {
  id: number | string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}
