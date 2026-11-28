import type { ChildProcess } from 'node:child_process';

export type E2ETier = 1 | 2 | 3 | 4 | 'smoke';

export type FeatureId =
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12';

export type ViewMode = 'single' | 'dual';
export type SessionMode = 'shared' | 'isolated';
export type ViewportRole = 'portrait' | 'landscape';
export type ThemeMode = 'dark' | 'light';
export type AudioSource = ViewportRole | 'muted';

export interface ViewportDimensionsDto {
  width: number;
  height: number;
  dpr: number;
}

export interface HistoryEntryDto {
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface PersistedWindowBoundsDto {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface PersistedTabFixture {
  url: string;
  title: string;
  mode: ViewMode;
  mirror: boolean;
  dedup?: boolean;
  session: SessionMode;
  sleeping: boolean;
  portraitPresetId: string;
  landscapePresetId: string;
  devtoolsTarget: ViewportRole;
  audioSource: AudioSource;
}

export interface PersistedSessionFixture {
  version: 1;
  savedAt: number;
  window?: PersistedWindowBoundsDto;
  railCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  splitRatio: number;
  theme: ThemeMode;
  ecoMode?: boolean;
  autoSleep?: boolean;
  activeTabIndex: number;
  tabs: PersistedTabFixture[];
  history: HistoryEntryDto[];
}

export interface TabSnapshotDto {
  id: string;
  title: string;
  url: string;
  mode: ViewMode;
  mirror: boolean;
  dedup?: boolean;
  session: SessionMode;
  sleeping: boolean;
  portraitPresetId: string;
  landscapePresetId: string;
  portraitSize: ViewportDimensionsDto;
  landscapeSize: ViewportDimensionsDto;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  devtoolsTarget: ViewportRole;
  audioSource: AudioSource;
  dedupCount?: number;
  emulation?: Record<string, unknown>;
}

export interface ViewportMetricsDto {
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
}

export interface MirrorMissInfoDto {
  reason: string;
  targetLabel: string;
  timestamp: number;
  url?: string;
}

export interface TelemetrySnapshotDto {
  timestampMs: number;
  gpuCpuPercent: number;
  gpuMemoryMb: number;
  totalMemoryMb: number;
  portrait: ViewportMetricsDto | null;
  landscape: ViewportMetricsDto | null;
  consoleErrorCount: number;
  failedNetworkCount: number;
  paused: boolean;
  mirrorMiss?: MirrorMissInfoDto | null;
  emulation?: Record<string, unknown> | null;
}

export interface ConsoleEntryDto {
  id: number;
  timestampMs: number;
  tabId: string;
  viewport: ViewportRole;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkEntryDto {
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
  durationMs?: number;
  encodedBytes?: number;
}

export interface LayoutAuditDto {
  viewportWidth?: number;
  viewportHeight?: number;
  [key: string]: unknown;
}

export interface ViewportScreenshotDto {
  mimeType: 'image/png';
  width: number;
  height: number;
  bytes: number;
  pngBase64: string;
  layoutAudit: LayoutAuditDto;
}

export interface ScreenshotCaptureDto {
  tabId: string;
  url: string;
  mode: ViewMode;
  captures: Partial<Record<ViewportRole, ViewportScreenshotDto>>;
}

export type InteractAction = 'click' | 'type' | 'scroll' | 'key' | 'hover';

export interface InteractParams {
  action: InteractAction;
  tabId?: string;
  viewport?: ViewportRole;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  ratioY?: number;
  mirror?: boolean;
}

export interface InteractResultDto {
  tabId: string;
  action: string;
  mirrored: boolean;
  outcomes: Record<string, unknown>;
}

export interface EvalResultDto {
  tabId: string;
  viewport: ViewportRole;
  value: string;
  truncated: boolean;
  originalBytes: number;
  maxBytes: number;
}

export interface PingResultDto {
  pong: boolean;
  version: string;
  socketPath: string;
}

export interface TabsResultDto {
  activeTabId: string | null;
  tabs: TabSnapshotDto[];
}

export interface OpenOrNavigateResultDto {
  activeTabId: string | null;
  tab: TabSnapshotDto | null;
}

export interface ConsoleResultDto {
  tabId: string | undefined;
  count: number;
  entries: ConsoleEntryDto[];
}

export interface NetworkResultDto {
  tabId: string | undefined;
  count: number;
  entries: NetworkEntryDto[];
}

export interface OpenTabOptions {
  mode?: ViewMode;
  session?: SessionMode;
  portraitPreset?: string;
  landscapePreset?: string;
  portraitSize?: { width: number; height: number; dpr?: number };
  landscapeSize?: { width: number; height: number; dpr?: number };
}

export interface ConsoleQueryOptions {
  tabId?: string;
  viewport?: ViewportRole | 'both';
  level?: string;
  limit?: number;
}

export interface NetworkQueryOptions {
  tabId?: string;
  viewport?: ViewportRole | 'both';
  filter?: 'all' | 'failed' | '4xx' | '5xx';
  limit?: number;
}

export interface WaitForTabReadyOptions {
  expectedUrlIncludes?: string;
  waitForDomComplete?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

export interface ControlSocketClientApi {
  readonly socketPath: string;
  isConnected(): boolean;
  connect(timeoutMs?: number): Promise<void>;
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  ping(): Promise<PingResultDto>;
  tabs(): Promise<TabsResultDto>;
  open(url?: string, opts?: OpenTabOptions): Promise<OpenOrNavigateResultDto>;
  navigate(url: string, tabId?: string): Promise<OpenOrNavigateResultDto>;
  screenshot(
    tabId?: string,
    target?: ViewportRole | 'both',
  ): Promise<ScreenshotCaptureDto>;
  metrics(): Promise<TelemetrySnapshotDto>;
  interact(params: InteractParams): Promise<InteractResultDto>;
  console(
    tabIdOrOpts?: string | ConsoleQueryOptions,
    limit?: number,
  ): Promise<ConsoleResultDto>;
  network(
    tabIdOrOpts?: string | NetworkQueryOptions,
    limit?: number,
  ): Promise<NetworkResultDto>;
  evalJs(
    expression: string,
    role?: ViewportRole,
    tabId?: string,
    maxBytes?: number,
  ): Promise<EvalResultDto>;
  emulate<T = Record<string, unknown>>(params: Record<string, unknown>): Promise<T>;
  profile<T = Record<string, unknown>>(params: Record<string, unknown>): Promise<T>;
  events(opts?: {
    tabId?: string;
    domain?: string;
    viewport?: ViewportRole | 'both';
    sinceSeq?: number;
    gestureSeq?: number;
    limit?: number;
  }): Promise<{
    tabId: string | null;
    backend: 'rust-napi' | 'ts-fallback';
    latestSeq: number;
    totalPublished: number;
    totalSuppressed: number;
    count: number;
    events: Array<{
      seq: number;
      tsMs: number;
      tabId: string;
      viewport: string;
      domain: string;
      kind: string;
      summary: string;
      gestureSeq?: number;
      detail?: string;
    }>;
  }>;
  waitForTabReady(
    tabId?: string,
    opts?: WaitForTabReadyOptions,
  ): Promise<TabSnapshotDto>;
  health<T = Record<string, unknown>>(lines?: number): Promise<T>;
  close(): void;
}

export interface LaunchOptions {
  smoke?: boolean;
  smokeExitMs?: number;
  initialUrl?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  seedSession?: PersistedSessionFixture | string;
  sessionDir?: string;
  keepTempDir?: boolean;
  readyTimeoutMs?: number;
}

export interface ElectronExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ElectronSession {
  ctl: ControlSocketClientApi;
  process: ChildProcess;
  sessionDir: string;
  userDataDir: string;
  stateFilePath: string;
  socketPath: string;
  getStdout(): string;
  getStderr(): string;
  readStateFile<T = unknown>(): T | null;
  readRawStateFile(): string | null;
  sendSignal(sig: NodeJS.Signals): void;
  waitForExit(timeoutMs?: number): Promise<ElectronExitStatus>;
  close(): Promise<void>;
}

export interface HttpLogEntry {
  id: number;
  timestampMs: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyText: string;
}

export interface WsReceivedMessage {
  ts: number;
  data: string | Uint8Array;
  isBinary: boolean;
  subprotocol: string | null;
  connectionId: number;
}

export interface WsStats {
  activeConnections: number;
  totalConnections: number;
  receivedMessages: WsReceivedMessage[];
}

export interface SseStats {
  activeConnections: number;
  totalConnections: number;
  lastEventIdsReceived: string[];
}

export interface TestServerCluster {
  readonly httpBaseUrl: string;
  readonly altOriginBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly sseBaseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHttpLogs(pathPrefix?: string): HttpLogEntry[];
  resetHttpLogs(): void;
  getMutationCount(pathPrefix?: string): number;
  broadcastWs(data: string | Uint8Array): number;
  closeAllWs(code?: number, reason?: string): number;
  closeFirstWsOwner(code?: number, reason?: string): boolean;
  getWsStats(): WsStats;
  resetWsStats(): void;
  pushSseEvent(eventName: string | null, data: string, id?: string): number;
  getSseStats(): SseStats;
  resetSseStats(): void;
  closeAllSse(): void;
}

export interface E2ETestContext {
  servers: TestServerCluster;
  launchElectron: (opts?: LaunchOptions) => Promise<ElectronSession>;
  tmpRoot: string;
}

export interface E2ETestCase {
  id: string;
  tier: E2ETier;
  features: FeatureId[];
  title: string;
  description: string;
  timeoutMs?: number;
  run: (ctx: E2ETestContext) => Promise<void>;
}

export interface E2ERunResult {
  id: string;
  tier: E2ETier;
  features: FeatureId[];
  title: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface E2ESummaryReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: E2ERunResult[];
}
