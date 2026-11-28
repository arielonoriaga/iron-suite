import { app, ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import type {
  ConsoleEntry,
  FrameStats,
  NetworkEntry,
  TabEmulationSummary,
  TelemetrySnapshot,
  ViewportMetrics,
  ViewportRole,
  WebGlViewportSummary,
} from '../shared/types';
import { truncateUtf8 } from '../shared/frame';
import { extractNetworkInitiator, MAX_ASYNC_STACK_DEPTH } from '../shared/network-initiator';
import {
  groupDiagnosticIncidents,
  type DiagnosticIncident,
  type IncidentGroupingOptions,
} from '../shared/incident-grouping';
import { buildGpuTelemetrySeparation } from '../shared/perf-trace';
import { DebuggerCoordinator } from './debugger-coordinator';

export interface ActiveTabTarget {
  tabId: string;
  portraitWc: WebContents | null;
  landscapeWc: WebContents | null;
  emulation?: TabEmulationSummary | null;
}

export interface TelemetryServiceOptions {
  now?: () => number;
  rafTtlMs?: number;
  activePollMs?: number;
  blurPollMs?: number;
  onBusEvent?: (ev: {
    tabId: string;
    viewport: ViewportRole;
    domain: 'console' | 'network';
    kind: string;
    summary: string;
    tsMs: number;
  }) => void;
  pollWebGl?: (wc: WebContents) => Promise<WebGlViewportSummary | null>;
}

const MAX_CONSOLE_ENTRIES = 400;
const MAX_NETWORK_ENTRIES = 1000;

export { extractNetworkInitiator };
const CDP_PERF_TIMEOUT_MS = 800;
const MAX_RAF_RECENT_SAMPLES = 30;
export const ACTIVE_POLL_INTERVAL_MS = 2000;
export const BLUR_POLL_INTERVAL_MS = 5000;
export const RAF_STATS_TTL_MS = 5000;

function sanitizeFrameStats(raw: unknown): FrameStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const fps = Number(rec.fps);
  const p95FrameMs = Number(rec.p95FrameMs);
  const jankCount = Number(rec.jankCount);
  if (
    !Number.isFinite(fps) ||
    fps < 0 ||
    fps > 1000 ||
    !Number.isFinite(p95FrameMs) ||
    p95FrameMs < 0 ||
    p95FrameMs > 10_000 ||
    !Number.isFinite(jankCount) ||
    jankCount < 0 ||
    jankCount > 10_000
  ) {
    return null;
  }

  const recentFrameMs: number[] = [];
  if (Array.isArray(rec.recentFrameMs)) {
    for (const item of rec.recentFrameMs.slice(-MAX_RAF_RECENT_SAMPLES)) {
      const val = Number(item);
      if (Number.isFinite(val) && val >= 0 && val <= 5000) {
        recentFrameMs.push(val);
      }
    }
  }

  return {
    fps,
    p95FrameMs,
    jankCount: Math.floor(jankCount),
    recentFrameMs,
  };
}

export class TelemetryService {
  private readonly rafByWcId = new Map<number, { stats: FrameStats; updatedAtMs: number }>();
  private readonly webglByWcId = new Map<number, WebGlViewportSummary | null>();
  private readonly cdpPerfByWcId = new Map<
    number,
    { jsHeapUsedMb: number; domNodes: number; layoutCount: number; recalcStyleCount: number }
  >();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries: NetworkEntry[] = [];
  private readonly networkByReqId = new Map<string, NetworkEntry>();
  private readonly reqTimingByReqId = new Map<
    string,
    { startMonoSec: number | null; decodedBytes: number }
  >();
  private readonly inFlightReqsByWcId = new Map<
    number,
    Map<string, { startedAtMs: number; resourceType?: string }>
  >();
  private readonly lastNetworkActivityByWcId = new Map<number, number>();
  private readonly collectorUnsubs = new Map<number, () => void>();
  private readonly now: () => number;
  private readonly rafTtlMs: number;
  private readonly activePollMs: number;
  private readonly blurPollMs: number;
  private readonly onBusEvent?: TelemetryServiceOptions['onBusEvent'];
  private readonly pollWebGl?: TelemetryServiceOptions['pollWebGl'];
  private readonly rafListener: (ev: IpcMainEvent, rawStats: unknown) => void;
  private nextConsoleId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sampleInFlight: Promise<TelemetrySnapshot> | null = null;
  private started = false;
  private throttled = false;
  private paused = false;
  private lastSnapshot: TelemetrySnapshot;

  constructor(
    private readonly getActiveTarget: () => ActiveTabTarget | null,
    private readonly isManagedWebContents: (wcId: number) => boolean,
    private readonly onSnapshot: (snapshot: TelemetrySnapshot) => void,
    private readonly debuggerCoordinator: DebuggerCoordinator = new DebuggerCoordinator(),
    opts: TelemetryServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.rafTtlMs = opts.rafTtlMs ?? RAF_STATS_TTL_MS;
    this.activePollMs = opts.activePollMs ?? ACTIVE_POLL_INTERVAL_MS;
    this.blurPollMs = opts.blurPollMs ?? BLUR_POLL_INTERVAL_MS;
    this.onBusEvent = opts.onBusEvent;
    this.pollWebGl = opts.pollWebGl;
    const initGpu = buildGpuTelemetrySeparation(0, 0, null);
    this.lastSnapshot = {
      timestampMs: this.now(),
      gpuCpuPercent: 0,
      gpuProcessCpuPercent: initGpu.gpuProcessCpuPercent,
      gpuExecutionTimeMs: initGpu.gpuExecutionTimeMs,
      gpuMetricLabels: {
        gpuProcessCpuPercent: initGpu.gpuProcessCpuLabel,
        gpuExecutionTimeMs: initGpu.gpuExecutionTimeLabel,
      },
      gpuMemoryMb: 0,
      totalMemoryMb: 0,
      portrait: null,
      landscape: null,
      consoleErrorCount: 0,
      failedNetworkCount: 0,
      paused: false,
    };

    this.rafListener = (ev, rawStats) => {
      if (!this.isManagedWebContents(ev.sender.id)) return;
      const stats = sanitizeFrameStats(rawStats);
      if (!stats) return;
      this.rafByWcId.set(ev.sender.id, { stats, updatedAtMs: this.now() });
    };
    ipcMain.on('iron:raf-stats', this.rafListener);
  }

  private clearPollTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextPoll(): void {
    this.clearPollTimer();
    if (!this.started || this.paused) return;
    const intervalMs = this.throttled ? this.blurPollMs : this.activePollMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.started || this.paused) return;
      void this.sampleOnce().finally(() => {
        if (this.started && !this.paused) {
          this.scheduleNextPoll();
        }
      });
    }, intervalMs);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNextPoll();
  }

  stop(): void {
    this.started = false;
    this.clearPollTimer();
  }

  dispose(): void {
    this.stop();
    if (typeof ipcMain.off === 'function') {
      ipcMain.off('iron:raf-stats', this.rafListener);
    } else {
      ipcMain.removeListener('iron:raf-stats', this.rafListener);
    }
    for (const unsub of this.collectorUnsubs.values()) {
      unsub();
    }
    this.collectorUnsubs.clear();
    this.webglByWcId.clear();
    this.reqTimingByReqId.clear();
    this.inFlightReqsByWcId.clear();
    this.lastNetworkActivityByWcId.clear();
  }

  setThrottled(throttled: boolean): void {
    if (this.throttled === throttled) return;
    this.throttled = throttled;
    if (this.started && !this.paused) {
      this.scheduleNextPoll();
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.lastSnapshot = { ...this.lastSnapshot, paused };
    this.clearPollTimer();
    if (!this.started) {
      return;
    }
    if (paused) {
      this.onSnapshot(this.lastSnapshot);
    } else {
      void this.sampleOnce().finally(() => {
        if (this.started && !this.paused) {
          this.scheduleNextPoll();
        }
      });
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  isThrottled(): boolean {
    return this.throttled;
  }

  getPollIntervalMs(): number {
    return this.throttled ? this.blurPollMs : this.activePollMs;
  }

  pruneStaleRafStats(nowMs = this.now()): number {
    let pruned = 0;
    for (const [wcId, entry] of this.rafByWcId.entries()) {
      if (nowMs - entry.updatedAtMs > this.rafTtlMs) {
        this.rafByWcId.delete(wcId);
        pruned += 1;
      }
    }
    return pruned;
  }

  getLatestSnapshot(): TelemetrySnapshot {
    return this.lastSnapshot;
  }

  private async enableCdpDomains(wc: WebContents): Promise<void> {
    if (wc.isDestroyed() || !this.debuggerCoordinator.isAttached(wc)) return;
    await Promise.all([
      this.debuggerCoordinator.sendCommand(wc, 'Performance.enable').catch(() => {}),
      this.debuggerCoordinator
        .sendCommand(wc, 'Runtime.enable')
        .then(() =>
          this.debuggerCoordinator
            .sendCommand(wc, 'Runtime.setAsyncCallStackDepth', { maxDepth: MAX_ASYNC_STACK_DEPTH })
            .catch(() =>
              this.debuggerCoordinator
                .sendCommand(wc, 'Debugger.enable', { maxScriptsCacheSize: 2_000_000 })
                .then(() =>
                  this.debuggerCoordinator.sendCommand(wc, 'Debugger.setAsyncCallStackDepth', {
                    maxDepth: MAX_ASYNC_STACK_DEPTH,
                  }),
                )
                .catch(() => {}),
            ),
        )
        .catch(() => {}),
      this.debuggerCoordinator
        .sendCommand(wc, 'Network.enable', {
          maxTotalBufferSize: 1,
          maxResourceBufferSize: 1,
          maxPostDataSize: 1,
        })
        .catch(() => {}),
      this.debuggerCoordinator.sendCommand(wc, 'Log.enable').catch(() => {}),
    ]);
  }

  private handleCdpMessage(
    tabId: string,
    role: ViewportRole,
    wcId: number,
    method: string,
    rawParams: unknown,
  ): void {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<
      string,
      unknown
    >;
    if (method === 'Runtime.consoleAPICalled') {
      const type = String(params.type ?? 'log');
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((a: Record<string, unknown>) =>
          typeof a.value === 'string'
            ? a.value
            : a.value !== undefined
              ? JSON.stringify(a.value)
              : String(a.description ?? a.type ?? ''),
        )
        .join(' ');
      const level =
        type === 'error'
          ? 'error'
          : type === 'warning'
            ? 'warn'
            : type === 'info'
              ? 'info'
              : type === 'debug'
                ? 'debug'
                : 'log';
      this.pushConsole({
        id: this.nextConsoleId++,
        timestampMs: this.now(),
        tabId,
        viewport: role,
        level,
        text,
        source: 'console-api',
      });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = (params.exceptionDetails ?? {}) as Record<string, unknown>;
      const exc = (details.exception ?? {}) as Record<string, unknown>;
      const text = String(exc.description ?? details.text ?? 'Uncaught exception');
      this.pushConsole({
        id: this.nextConsoleId++,
        timestampMs: this.now(),
        tabId,
        viewport: role,
        level: 'error',
        text,
        url: typeof details.url === 'string' ? details.url : undefined,
        line: typeof details.lineNumber === 'number' ? details.lineNumber : undefined,
        source: 'exception',
      });
    } else if (method === 'Log.entryAdded') {
      const entry = (params.entry ?? {}) as Record<string, unknown>;
      const rawLevel = String(entry.level ?? 'info');
      const level =
        rawLevel === 'error' ? 'error' : rawLevel === 'warning' ? 'warn' : 'info';
      this.pushConsole({
        id: this.nextConsoleId++,
        timestampMs: this.now(),
        tabId,
        viewport: role,
        level,
        text: String(entry.text ?? ''),
        url: typeof entry.url === 'string' ? entry.url : undefined,
        line: typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined,
        source: 'log',
      });
    } else if (method === 'Network.requestWillBeSent') {
      const requestId = `${wcId}:${String(params.requestId ?? '')}`;
      const req = (params.request ?? {}) as Record<string, unknown>;
      const monoTs =
        typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
          ? params.timestamp
          : null;
      const resourceType = typeof params.type === 'string' ? params.type : undefined;
      if (resourceType !== 'WebSocket' && resourceType !== 'EventSource') {
        const nowMs = this.now();
        let wcMap = this.inFlightReqsByWcId.get(wcId);
        if (!wcMap) {
          wcMap = new Map();
          this.inFlightReqsByWcId.set(wcId, wcMap);
        }
        wcMap.set(requestId, { startedAtMs: nowMs, resourceType });
        this.lastNetworkActivityByWcId.set(wcId, nowMs);
      }
      const initiator = extractNetworkInitiator(params.initiator);
      const existing = this.networkByReqId.get(requestId);
      if (existing) {
        // Redirect chain on same requestId: update target URL/method while preserving initial start time & root initiator.
        existing.method = String(req.method ?? existing.method);
        existing.url = this.sanitizeTelemetryUrl(String(req.url ?? existing.url)) ?? existing.url;
        if (!existing.initiator && initiator) {
          existing.initiator = initiator;
        }
      } else {
        const entry: NetworkEntry = {
          id: requestId,
          timestampMs: this.now(),
          tabId,
          viewport: role,
          method: String(req.method ?? 'GET'),
          url: String(req.url ?? ''),
          status: null,
          failed: false,
          resourceType: typeof params.type === 'string' ? params.type : undefined,
          ...(initiator ? { initiator } : {}),
        };
        this.reqTimingByReqId.set(requestId, { startMonoSec: monoTs, decodedBytes: 0 });
        this.networkByReqId.set(requestId, entry);
        this.pushNetwork(entry);
      }
    } else if (method === 'Network.responseReceived') {
      const requestId = `${wcId}:${String(params.requestId ?? '')}`;
      const resp = (params.response ?? {}) as Record<string, unknown>;
      const existing = this.networkByReqId.get(requestId);
      if (existing) {
        const status = typeof resp.status === 'number' ? resp.status : null;
        existing.status = status;
        existing.failed = status !== null && status >= 400;
        if (typeof resp.mimeType === 'string' && resp.mimeType) {
          existing.mimeType = resp.mimeType;
        }
        if (typeof resp.protocol === 'string' && resp.protocol) {
          existing.protocol = resp.protocol;
        }
        if (resp.fromDiskCache === true || resp.fromPrefetchCache === true) {
          existing.fromCache = true;
        }
        if (typeof resp.encodedDataLength === 'number' && resp.encodedDataLength >= 0) {
          existing.encodedBytes = resp.encodedDataLength;
        }
        const timing = this.reqTimingByReqId.get(requestId);
        const respMono =
          typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
            ? params.timestamp
            : null;
        const ttfbMs =
          timing?.startMonoSec !== null && timing?.startMonoSec !== undefined && respMono !== null
            ? Math.max(0, Math.round((respMono - timing.startMonoSec) * 1000 * 100) / 100)
            : Math.max(0, this.now() - existing.timestampMs);
        existing.ttfbMs = ttfbMs;
        existing.durationMs = ttfbMs;
        if (existing.failed) {
          this.onBusEvent?.({
            tabId,
            viewport: role,
            domain: 'network',
            kind: status !== null && status >= 500 ? 'http_5xx' : 'http_4xx',
            summary: `${existing.method} ${existing.url} -> ${status}`,
            tsMs: this.now(),
          });
        }
      }
    } else if (method === 'Network.dataReceived') {
      const requestId = `${wcId}:${String(params.requestId ?? '')}`;
      const existing = this.networkByReqId.get(requestId);
      const timing = this.reqTimingByReqId.get(requestId);
      const chunkLen = typeof params.dataLength === 'number' && params.dataLength > 0 ? params.dataLength : 0;
      if (timing && chunkLen > 0) {
        timing.decodedBytes += chunkLen;
        if (existing) {
          existing.decodedBytes = timing.decodedBytes;
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const requestId = `${wcId}:${String(params.requestId ?? '')}`;
      const existing = this.networkByReqId.get(requestId);
      const timing = this.reqTimingByReqId.get(requestId);
      if (existing) {
        if (typeof params.encodedDataLength === 'number' && params.encodedDataLength >= 0) {
          existing.encodedBytes = params.encodedDataLength;
        }
        const endMono =
          typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
            ? params.timestamp
            : null;
        existing.durationMs =
          timing?.startMonoSec !== null && timing?.startMonoSec !== undefined && endMono !== null
            ? Math.max(0, Math.round((endMono - timing.startMonoSec) * 1000 * 100) / 100)
            : Math.max(0, this.now() - existing.timestampMs);
        if (timing && timing.decodedBytes > 0) {
          existing.decodedBytes = timing.decodedBytes;
        }
      }
      this.reqTimingByReqId.delete(requestId);
      this.inFlightReqsByWcId.get(wcId)?.delete(requestId);
      this.lastNetworkActivityByWcId.set(wcId, this.now());
    } else if (method === 'Network.loadingFailed') {
      const requestId = `${wcId}:${String(params.requestId ?? '')}`;
      const existing = this.networkByReqId.get(requestId);
      const timing = this.reqTimingByReqId.get(requestId);
      if (existing) {
        existing.failed = true;
        existing.errorText = typeof params.errorText === 'string' ? params.errorText : 'failed';
        const endMono =
          typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)
            ? params.timestamp
            : null;
        existing.durationMs =
          timing?.startMonoSec !== null && timing?.startMonoSec !== undefined && endMono !== null
            ? Math.max(0, Math.round((endMono - timing.startMonoSec) * 1000 * 100) / 100)
            : Math.max(0, this.now() - existing.timestampMs);
        this.onBusEvent?.({
          tabId,
          viewport: role,
          domain: 'network',
          kind: 'loading_failed',
          summary: `${existing.method} ${existing.url} (${existing.errorText})`,
          tsMs: this.now(),
        });
      }
      this.reqTimingByReqId.delete(requestId);
      this.inFlightReqsByWcId.get(wcId)?.delete(requestId);
      this.lastNetworkActivityByWcId.set(wcId, this.now());
    }
  }

  attachViewportCollectors(tabId: string, role: ViewportRole, wc: WebContents): void {
    if (wc.isDestroyed()) return;
    this.collectorUnsubs.get(wc.id)?.();

    const unsub = this.debuggerCoordinator.registerParticipant(wc, `telemetry:${tabId}:${role}`, {
      onMessage: (method, params) => {
        this.handleCdpMessage(tabId, role, wc.id, method, params);
      },
      onReattach: () => this.enableCdpDomains(wc),
      onDestroyed: () => {
        this.rafByWcId.delete(wc.id);
        this.cdpPerfByWcId.delete(wc.id);
        this.webglByWcId.delete(wc.id);
        this.inFlightReqsByWcId.delete(wc.id);
        this.lastNetworkActivityByWcId.delete(wc.id);
        this.collectorUnsubs.delete(wc.id);
      },
    });
    this.collectorUnsubs.set(wc.id, unsub);

    void this.debuggerCoordinator.ensureAttached(wc).then((ok) => {
      if (ok && !wc.isDestroyed()) {
        return this.enableCdpDomains(wc);
      }
    });
  }

  private sanitizeTelemetryUrl(rawUrl: string | undefined): string | undefined {
    if (!rawUrl || typeof rawUrl !== 'string') return undefined;
    if (/^data:/i.test(rawUrl)) {
      return rawUrl.length > 64 ? 'data:[redacted]' : rawUrl;
    }
    return rawUrl.length > 2048 ? truncateUtf8(rawUrl, 2048).text : rawUrl;
  }

  private pushConsole(entry: ConsoleEntry): void {
    const safeEntry: ConsoleEntry = {
      ...entry,
      text: entry.text.length > 4096 ? truncateUtf8(entry.text, 4096).text : entry.text,
      ...(entry.url !== undefined ? { url: this.sanitizeTelemetryUrl(entry.url) } : {}),
    };
    this.consoleEntries.push(safeEntry);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE_ENTRIES);
    }
    if (safeEntry.level === 'error' || safeEntry.level === 'warn') {
      this.onBusEvent?.({
        tabId: safeEntry.tabId,
        viewport: safeEntry.viewport,
        domain: 'console',
        kind: safeEntry.level,
        summary: safeEntry.text.slice(0, 512),
        tsMs: safeEntry.timestampMs,
      });
    }
  }

  private pushNetwork(entry: NetworkEntry): void {
    entry.url = this.sanitizeTelemetryUrl(entry.url) ?? '';
    this.networkEntries.push(entry);
    if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
      const removed = this.networkEntries.splice(0, this.networkEntries.length - MAX_NETWORK_ENTRIES);
      for (const item of removed) {
        this.networkByReqId.delete(item.id);
        this.reqTimingByReqId.delete(item.id);
      }
    }
  }

  getConsoleEntries(opts: {
    tabId?: string;
    viewport?: ViewportRole | 'both';
    level?: string;
    limit?: number;
  }): ConsoleEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.consoleEntries
      .filter((e) => {
        if (opts.tabId && e.tabId !== opts.tabId) return false;
        if (opts.viewport && opts.viewport !== 'both' && e.viewport !== opts.viewport) return false;
        if (opts.level && opts.level !== 'all' && e.level !== opts.level) return false;
        return true;
      })
      .slice(-limit);
  }

  getNetworkEntries(opts: {
    tabId?: string;
    viewport?: ViewportRole | 'both';
    filter?: 'all' | 'failed' | '4xx' | '5xx';
    urlContains?: string;
    limit?: number;
  }): NetworkEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const filter = opts.filter ?? 'all';
    const needle = typeof opts.urlContains === 'string' ? opts.urlContains.trim().toLowerCase() : '';
    return this.networkEntries
      .filter((e) => {
        if (opts.tabId && e.tabId !== opts.tabId) return false;
        if (opts.viewport && opts.viewport !== 'both' && e.viewport !== opts.viewport) return false;
        if (filter === 'failed' && !e.failed) return false;
        if (filter === '4xx' && !(e.status !== null && e.status >= 400 && e.status < 500)) return false;
        if (filter === '5xx' && !(e.status !== null && e.status >= 500)) return false;
        if (needle && !e.url.toLowerCase().includes(needle)) return false;
        return true;
      })
      .slice(-limit);
  }

  getDiagnosticIncidents(opts: IncidentGroupingOptions = {}): DiagnosticIncident[] {
    return groupDiagnosticIncidents(this.networkEntries, this.consoleEntries, opts);
  }

  findLatestErrorViewport(tabId: string, kind: 'console' | 'network'): ViewportRole | null {
    if (kind === 'console') {
      for (let i = this.consoleEntries.length - 1; i >= 0; i -= 1) {
        const entry = this.consoleEntries[i]!;
        if (entry.tabId === tabId && entry.level === 'error') {
          return entry.viewport;
        }
      }
      return null;
    }
    for (let i = this.networkEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.networkEntries[i]!;
      if (entry.tabId === tabId && entry.failed) {
        return entry.viewport;
      }
    }
    return null;
  }

  clearTabEntries(tabId: string): void {
    for (let i = this.consoleEntries.length - 1; i >= 0; i -= 1) {
      if (this.consoleEntries[i]!.tabId === tabId) this.consoleEntries.splice(i, 1);
    }
    for (let i = this.networkEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.networkEntries[i]!;
      if (entry.tabId === tabId) {
        this.networkEntries.splice(i, 1);
        this.networkByReqId.delete(entry.id);
        this.reqTimingByReqId.delete(entry.id);
        for (const wcMap of this.inFlightReqsByWcId.values()) {
          wcMap.delete(entry.id);
        }
      }
    }
  }

  clearTabViewportEntries(tabId: string, viewport: ViewportRole): void {
    for (let i = this.consoleEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.consoleEntries[i]!;
      if (entry.tabId === tabId && entry.viewport === viewport) {
        this.consoleEntries.splice(i, 1);
      }
    }
    for (let i = this.networkEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.networkEntries[i]!;
      if (entry.tabId === tabId && entry.viewport === viewport) {
        this.networkEntries.splice(i, 1);
        this.networkByReqId.delete(entry.id);
        this.reqTimingByReqId.delete(entry.id);
        for (const wcMap of this.inFlightReqsByWcId.values()) {
          wcMap.delete(entry.id);
        }
      }
    }
  }

  getNetworkIdleState(
    wcId: number,
    nowMs = this.now(),
  ): { inFlightCount: number; idleForMs: number } {
    const wcMap = this.inFlightReqsByWcId.get(wcId);
    if (wcMap) {
      for (const [reqKey, meta] of wcMap.entries()) {
        if (nowMs - meta.startedAtMs > 60_000) {
          wcMap.delete(reqKey);
        }
      }
    }
    const inFlightCount = wcMap?.size ?? 0;
    const lastActivity = this.lastNetworkActivityByWcId.get(wcId) ?? 0;
    const idleForMs = inFlightCount === 0 ? Math.max(0, nowMs - lastActivity) : 0;
    return { inFlightCount, idleForMs };
  }

  private async pollCdpPerformance(wc: WebContents | null): Promise<void> {
    if (!wc || wc.isDestroyed() || !this.debuggerCoordinator.isAttached(wc)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const res = (await Promise.race([
        this.debuggerCoordinator.sendCommand<{
          metrics?: Array<{ name: string; value: number }>;
        }>(wc, 'Performance.getMetrics'),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CDP_PERF_TIMEOUT_MS);
        }),
      ])) as { metrics?: Array<{ name: string; value: number }> } | null;

      if (!res) return;
      const map = new Map<string, number>();
      for (const m of res.metrics ?? []) {
        map.set(m.name, m.value);
      }
      this.cdpPerfByWcId.set(wc.id, {
        jsHeapUsedMb: Math.round(((map.get('JSHeapUsedSize') ?? 0) / (1024 * 1024)) * 10) / 10,
        domNodes: Math.round(map.get('Nodes') ?? 0),
        layoutCount: Math.round(map.get('LayoutCount') ?? 0),
        recalcStyleCount: Math.round(map.get('RecalcStyleCount') ?? 0),
      });
    } catch {
      // Ignore transient debugger errors during navigation or paused breakpoints.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private buildViewportMetrics(
    role: ViewportRole,
    wc: WebContents | null,
    metricsByPid: Map<number, { cpu: number; memMb: number }>,
    nowMs = this.now(),
  ): ViewportMetrics | null {
    if (!wc || wc.isDestroyed()) return null;
    const pid = wc.getOSProcessId();
    const proc = metricsByPid.get(pid) ?? { cpu: 0, memMb: 0 };
    const perf = this.cdpPerfByWcId.get(wc.id) ?? {
      jsHeapUsedMb: 0,
      domNodes: 0,
      layoutCount: 0,
      recalcStyleCount: 0,
    };
    const rafEntry = this.rafByWcId.get(wc.id);
    const raf =
      rafEntry && nowMs - rafEntry.updatedAtMs <= this.rafTtlMs
        ? rafEntry.stats
        : {
            fps: 0,
            p95FrameMs: 0,
            jankCount: 0,
            recentFrameMs: [],
          };
    return {
      role,
      pid,
      cpuPercent: proc.cpu,
      memoryMb: proc.memMb,
      jsHeapUsedMb: perf.jsHeapUsedMb,
      domNodes: perf.domNodes,
      layoutCount: perf.layoutCount,
      recalcStyleCount: perf.recalcStyleCount,
      fps: raf.fps,
      p95FrameMs: raf.p95FrameMs,
      jankCount: raf.jankCount,
      recentFrameMs: raf.recentFrameMs,
      webgl: this.webglByWcId.get(wc.id) ?? null,
    };
  }

  private async pollViewportWebGl(wc: WebContents | null): Promise<void> {
    if (!wc || wc.isDestroyed() || !this.pollWebGl) return;
    try {
      const summary = await this.pollWebGl(wc);
      if (!wc.isDestroyed()) {
        this.webglByWcId.set(wc.id, summary && summary.contexts > 0 ? summary : null);
      }
    } catch {
      // Ignore transient navigation errors.
    }
  }

  sampleOnce(): Promise<TelemetrySnapshot> {
    if (this.sampleInFlight) {
      return this.sampleInFlight;
    }
    const run = this.doSampleOnce().finally(() => {
      if (this.sampleInFlight === run) {
        this.sampleInFlight = null;
      }
    });
    this.sampleInFlight = run;
    return run;
  }

  sampleTargetOnce(target: ActiveTabTarget): Promise<TelemetrySnapshot> {
    return this.doSampleTarget(target, false);
  }

  private async doSampleOnce(): Promise<TelemetrySnapshot> {
    return this.doSampleTarget(this.getActiveTarget(), true);
  }

  private async doSampleTarget(
    target: ActiveTabTarget | null,
    emitShellUpdate: boolean,
  ): Promise<TelemetrySnapshot> {
    const nowMs = this.now();
    this.pruneStaleRafStats(nowMs);
    await Promise.all([
      this.pollCdpPerformance(target?.portraitWc ?? null),
      this.pollCdpPerformance(target?.landscapeWc ?? null),
      this.pollViewportWebGl(target?.portraitWc ?? null),
      this.pollViewportWebGl(target?.landscapeWc ?? null),
    ]);

    const appMetrics = app.getAppMetrics();
    const metricsByPid = new Map<number, { cpu: number; memMb: number }>();
    let gpuCpuPercent = 0;
    let gpuMemoryMb = 0;
    let totalMemoryMb = 0;

    for (const m of appMetrics) {
      const cpu = Math.round(m.cpu.percentCPUUsage * 10) / 10;
      const memMb = Math.round((m.memory.workingSetSize / 1024) * 10) / 10;
      totalMemoryMb += memMb;
      metricsByPid.set(m.pid, { cpu, memMb });
      if (m.type === 'GPU') {
        gpuCpuPercent = Math.round((gpuCpuPercent + cpu) * 10) / 10;
        gpuMemoryMb = Math.round((gpuMemoryMb + memMb) * 10) / 10;
      }
    }

    const activeTabId = target?.tabId;
    let consoleErrorCount = 0;
    let failedNetworkCount = 0;
    if (activeTabId) {
      for (const e of this.consoleEntries) {
        if (e.tabId === activeTabId && e.level === 'error') consoleErrorCount += 1;
      }
      for (const e of this.networkEntries) {
        if (e.tabId === activeTabId && e.failed) failedNetworkCount += 1;
      }
    }

    const sampleTimestamp = this.now();
    const gpuSep = buildGpuTelemetrySeparation(gpuCpuPercent, gpuMemoryMb, null);
    const snapshot: TelemetrySnapshot = {
      timestampMs: sampleTimestamp,
      gpuCpuPercent,
      gpuProcessCpuPercent: gpuSep.gpuProcessCpuPercent,
      gpuExecutionTimeMs: gpuSep.gpuExecutionTimeMs,
      gpuMetricLabels: {
        gpuProcessCpuPercent: gpuSep.gpuProcessCpuLabel,
        gpuExecutionTimeMs: gpuSep.gpuExecutionTimeLabel,
      },
      gpuMemoryMb,
      totalMemoryMb: Math.round(totalMemoryMb * 10) / 10,
      portrait: this.buildViewportMetrics(
        'portrait',
        target?.portraitWc ?? null,
        metricsByPid,
        sampleTimestamp,
      ),
      landscape: this.buildViewportMetrics(
        'landscape',
        target?.landscapeWc ?? null,
        metricsByPid,
        sampleTimestamp,
      ),
      consoleErrorCount,
      failedNetworkCount,
      paused: this.paused,
      emulation: target?.emulation ?? null,
    };

    if (emitShellUpdate) {
      this.lastSnapshot = snapshot;
      this.onSnapshot(snapshot);
    }
    return snapshot;
  }
}
