import type { ChildProcess } from 'node:child_process';
import type { AcceptanceControlClient } from './ctl-client';
import type {
  ElectronExitStatus,
  LaunchOptions,
  PersistedSessionFixture,
  TabSnapshotDto,
  ViewportRole,
} from '../../lib/types';

export type {
  ConsoleEntryDto,
  ConsoleQueryOptions,
  ConsoleResultDto,
  ControlSocketClientApi,
  ElectronExitStatus,
  EvalResultDto,
  HistoryEntryDto,
  HttpLogEntry,
  InteractAction,
  InteractParams,
  InteractResultDto,
  LaunchOptions,
  LayoutAuditDto,
  NetworkEntryDto,
  NetworkQueryOptions,
  NetworkResultDto,
  OpenOrNavigateResultDto,
  OpenTabOptions,
  PersistedSessionFixture,
  PersistedTabFixture,
  PersistedWindowBoundsDto,
  PingResultDto,
  ScreenshotCaptureDto,
  SessionMode,
  SseStats,
  TabSnapshotDto,
  TabsResultDto,
  TelemetrySnapshotDto,
  ThemeMode,
  ViewMode,
  ViewportDimensionsDto,
  ViewportMetricsDto,
  ViewportRole,
  ViewportScreenshotDto,
  WaitForTabReadyOptions,
  WsReceivedMessage,
  WsStats,
} from '../../lib/types';

export type AcceptanceTier = 1 | 2 | 3 | 4;

export type AcceptanceMilestone = 'HEAD' | 'M1' | 'M2' | 'M3' | 'M4';

export type FeatureArea = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7';

export type EnvProfileName = 'no-personal-tools' | 'adapter-present';

export interface CleanupRegistry {
  trackProcess(proc: ChildProcess, label?: string): void;
  untrackProcess(proc: ChildProcess): void;
  trackDir(dirPath: string): void;
  trackCallback(fn: () => Promise<void> | void): void;
  cleanupAll(): Promise<void>;
}

export interface CreateEnvOptions {
  /** Extra executable stubs to create inside the isolated bin/ directory. */
  extraBins?: Record<string, string>;
  /** Extra environment variables to set (or null to explicitly unset). */
  envOverrides?: Record<string, string | null>;
  /** Omit XDG_RUNTIME_DIR completely when true. */
  unsetXdgRuntimeDir?: boolean;
  /** Keep temp directory after cleanup for post-mortem inspection. */
  keepTempDir?: boolean;
  /** Override PATH mode: exclude specific binary names even in adapter-present. */
  excludeBins?: string[];
  /** Override shell path inside env (default '/bin/sh' or host bash). */
  shell?: string;
}

export interface IsolatedEnvHandle {
  readonly profile: EnvProfileName;
  readonly rootDir: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly runtimeDir: string | null;
  readonly xdgBinHome: string;
  readonly agyHome: string;
  readonly harnessHome: string;
  readonly env: NodeJS.ProcessEnv;
  writeMockExecutable(name: string, scriptBody: string): string;
  which(cmd: string): string | null;
  dispose(): void;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpSessionHandle {
  readonly target: CdpTargetInfo;
  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  evaluate<T = unknown>(expression: string, awaitPromise?: boolean): Promise<T>;
  dispatchKey(opts: {
    key: string;
    code?: string;
    keyCode?: number;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  }): Promise<void>;
  close(): void;
}

export interface AcceptanceElectronOptions extends LaunchOptions {
  /** Enable Chromium remote debugging (--remote-debugging-port=0) for opaque-box shell/dock UI inspection. */
  enableCdp?: boolean;
  /** Explicit isolated env; if provided, its env vars replace process.env (plus socket/userData overrides). */
  isolatedEnv?: IsolatedEnvHandle;
  /** Unset specific keys in child env (e.g., ['DISPLAY', 'TMUX']). */
  unsetEnvKeys?: string[];
  /** Custom download dir override (defaults to `<sessionDir>/downloads`). */
  downloadDir?: string;
  /** Explicit Ozone platform flag override ('x11' | 'wayland' | 'headless' | 'auto' | 'none'). */
  ozoneMode?: 'x11' | 'wayland' | 'headless' | 'auto' | 'none';
  /** Launch via `bin/iron-browser` wrapper instead of direct electron binary. */
  viaLauncher?: boolean;
}

export interface AcceptanceElectronSession {
  readonly ctl: AcceptanceControlClient;
  readonly process: ChildProcess;
  readonly sessionDir: string;
  readonly userDataDir: string;
  readonly stateFilePath: string;
  readonly downloadDir: string;
  readonly socketPath: string;
  readonly cdpPort: number | null;
  getStdout(): string;
  getStderr(): string;
  readStateFile<T = unknown>(): T | null;
  readRawStateFile(): string | null;
  listCdpTargets(): Promise<CdpTargetInfo[]>;
  connectCdp(predicate: (t: CdpTargetInfo) => boolean, timeoutMs?: number): Promise<CdpSessionHandle>;
  sendSignal(sig: NodeJS.Signals): void;
  waitForExit(timeoutMs?: number): Promise<ElectronExitStatus>;
  close(): Promise<void>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolCallResult {
  isError?: boolean;
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  [key: string]: unknown;
}

export interface McpLaunchOptions {
  socketPath?: string;
  maxBytes?: number;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  autoInitialize?: boolean;
  protocolVersion?: string;
}

export interface McpClientHandle {
  readonly process: ChildProcess;
  readonly binPath: string;
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  sendRawLine(line: string): void;
  initialize(protocolVersion?: string): Promise<Record<string, unknown>>;
  sendInitialized(): void;
  listTools(params?: Record<string, unknown>): Promise<{ tools: McpToolInfo[] }>;
  callTool(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<McpToolCallResult>;
  getStderr(): string;
  waitForExit(timeoutMs?: number): Promise<ElectronExitStatus>;
  close(): Promise<void>;
}

export interface DoctorOptions {
  socketPath?: string;
  lines?: number;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  binPath?: string;
  viaLauncher?: boolean;
}

export interface DoctorResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

export interface IronAgentdOptions {
  socketPath?: string;
  dbPath?: string;
  hostId?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnvKeys?: string[];
  readyTimeoutMs?: number;
}

export interface IronAgentdHandle {
  readonly process: ChildProcess;
  readonly socketPath: string;
  readonly dbPath: string;
  getStdout(): string;
  getStderr(): string;
  close(): Promise<void>;
}

export interface IronTermCtlOptions {
  socketPath?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  unsetEnvKeys?: string[];
  timeoutMs?: number;
}

export interface CommandRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface IronTermHarness {
  resolveBinary(name: 'iron-agentd' | 'iron-termctl' | 'iron-term'): string | null;
  startAgentd(opts?: IronAgentdOptions): Promise<IronAgentdHandle>;
  runCtl(args: string[], opts?: IronTermCtlOptions): Promise<CommandRunResult>;
  runCtlJson<T = unknown>(args: string[], opts?: Omit<IronTermCtlOptions, 'json'>): Promise<T>;
  runIronTerm(args: string[], opts?: { env?: NodeJS.ProcessEnv; unsetEnvKeys?: string[]; timeoutMs?: number }): Promise<CommandRunResult>;
  runInstallDesktop(opts: {
    env: IsolatedEnvHandle;
    extraEnv?: Record<string, string>;
    timeoutMs?: number;
    noBuild?: boolean;
    binDir?: string;
    extraArgs?: string[];
  }): Promise<CommandRunResult>;
  validateDesktopFile(desktopPath: string, opts?: { env?: NodeJS.ProcessEnv }): Promise<CommandRunResult>;
}

export interface AcceptanceServerCluster {
  readonly httpBaseUrl: string;
  readonly altOriginBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly sseBaseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getHttpLogs(pathPrefix?: string): Array<{
    id: number;
    timestampMs: number;
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    bodyText: string;
  }>;
  resetHttpLogs(): void;
  resetFlaky(key?: string): void;
  getFlakyCount(key?: string): number;
  broadcastWs(data: string | Uint8Array): number;
  getWsStats(): { activeConnections: number; totalConnections: number; receivedMessages: Array<{ data: string | Uint8Array; isBinary: boolean }> };
  pushSseEvent(eventName: string | null, data: string, id?: string): number;
  getSseStats(): { activeConnections: number; totalConnections: number; lastEventIdsReceived: string[] };
  closeAllSse(): void;
}

export interface AcceptanceContext {
  servers: AcceptanceServerCluster;
  launchElectron: (opts?: AcceptanceElectronOptions) => Promise<AcceptanceElectronSession>;
  createEnv: (profile: EnvProfileName, opts?: CreateEnvOptions) => IsolatedEnvHandle;
  launchMcp: (opts?: McpLaunchOptions) => Promise<McpClientHandle>;
  runDoctor: (opts?: DoctorOptions) => Promise<DoctorResult>;
  ironTerm: IronTermHarness;
  cleanup: CleanupRegistry;
  tmpRoot: string;
  appRoot: string;
  repoRoot: string;
  ironTermRoot: string;
  hooksDir: string;
}

export interface AcceptanceTestCase {
  id: string;
  name: string;
  tier: AcceptanceTier;
  area: FeatureArea;
  requirement: string;
  milestone: AcceptanceMilestone;
  tags: string[];
  timeoutMs?: number;
  run: (ctx: AcceptanceContext) => Promise<void>;
}

export interface AcceptanceRunResult {
  id: string;
  name: string;
  tier: AcceptanceTier;
  area: FeatureArea;
  requirement: string;
  milestone: AcceptanceMilestone;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface AcceptanceSummaryReport {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: AcceptanceRunResult[];
}
