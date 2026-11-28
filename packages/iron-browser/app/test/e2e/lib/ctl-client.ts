import net from 'node:net';
import type {
  ConsoleQueryOptions,
  ConsoleResultDto,
  ControlSocketClientApi,
  EvalResultDto,
  InteractParams,
  InteractResultDto,
  NetworkQueryOptions,
  NetworkResultDto,
  OpenOrNavigateResultDto,
  OpenTabOptions,
  PingResultDto,
  ScreenshotCaptureDto,
  TabSnapshotDto,
  TabsResultDto,
  TelemetrySnapshotDto,
  ViewportRole,
  WaitForTabReadyOptions,
} from './types';

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

interface CtlRpcRequestWire {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface CtlRpcResponseWire {
  id: number | string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class CtlRpcError extends Error {
  public readonly code: number;
  public readonly method?: string;

  constructor(code: number, message: string, method?: string) {
    super(`RPC error (${code})${method ? ` in ${method}` : ''}: ${message}`);
    this.name = 'CtlRpcError';
    this.code = code;
    this.method = method;
  }
}

export function encodeCtlFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error(
      `frame size ${body.length} exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class CtlFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`invalid frame length: ${length} (max ${MAX_FRAME_BYTES})`);
      }
      if (this.buffer.length < 4 + length) {
        break;
      }
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(body.toString('utf8')));
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ControlSocketClient implements ControlSocketClientApi {
  private socket: net.Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private decoder = new CtlFrameDecoder();
  private nextId = 1;
  private pending = new Map<number | string, PendingCall>();
  private closedManually = false;

  constructor(public readonly socketPath: string) {}

  static async connect(
    socketPath: string,
    timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
  ): Promise<ControlSocketClient> {
    const client = new ControlSocketClient(socketPath);
    await client.connect(timeoutMs);
    return client;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable;
  }

  async connect(timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    this.closedManually = false;
    this.decoder.reset();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        this.socket = null;
        this.connectPromise = null;
        reject(new Error(`Timed out connecting to control socket ${this.socketPath} after ${timeoutMs}ms`));
      }, timeoutMs);

      const onInitialError = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        this.socket = null;
        this.connectPromise = null;
        reject(err);
      };

      sock.once('error', onInitialError);

      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.off('error', onInitialError);
        this.socket = sock;
        this.connectPromise = null;
        this.attachSocketListeners(sock);
        resolve();
      });
    });

    return this.connectPromise;
  }

  private attachSocketListeners(sock: net.Socket): void {
    sock.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        const decodeErr = err instanceof Error ? err : new Error(String(err));
        this.failAllPending(decodeErr);
        sock.destroy();
        return;
      }

      for (const msg of messages) {
        this.handleResponse(msg);
      }
    });

    sock.on('error', (err: Error) => {
      this.failAllPending(err);
    });

    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = null;
      }
      this.decoder.reset();
      const reason = this.closedManually
        ? 'ControlSocketClient closed'
        : `Control socket ${this.socketPath} closed unexpectedly`;
      this.failAllPending(new Error(reason));
    });
  }

  private handleResponse(raw: unknown): void {
    if (!isRecord(raw)) return;
    const id = raw.id;
    if (typeof id !== 'number' && typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    clearTimeout(entry.timer);

    const resp = raw as unknown as CtlRpcResponseWire;
    if (resp.ok) {
      entry.resolve(resp.result);
      return;
    }

    const errObj = isRecord(resp.error) ? resp.error : undefined;
    const code = typeof errObj?.code === 'number' ? errObj.code : -32000;
    const message =
      typeof errObj?.message === 'string' ? errObj.message : 'unknown RPC error';
    entry.reject(new CtlRpcError(code, message, entry.method));
  }

  private failAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.isConnected()) {
      await this.connect();
    }
    const sock = this.socket;
    if (!sock || sock.destroyed) {
      throw new Error(`Control socket ${this.socketPath} is not connected`);
    }

    const id = this.nextId++;
    const payload: CtlRpcRequestWire =
      params !== undefined ? { id, method, params } : { id, method };
    const frame = encodeCtlFrame(payload);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`RPC '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });

      try {
        sock.write(frame, (writeErr) => {
          if (writeErr && this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(writeErr);
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  ping(): Promise<PingResultDto> {
    return this.request<PingResultDto>('ping');
  }

  tabs(): Promise<TabsResultDto> {
    return this.request<TabsResultDto>('browser_tabs');
  }

  open(url = 'about:blank', opts?: OpenTabOptions): Promise<OpenOrNavigateResultDto> {
    const resolvedUrl = url.trim().length > 0 ? url : 'about:blank';
    const params: Record<string, unknown> = { url: resolvedUrl };
    if (opts?.mode !== undefined) params.mode = opts.mode;
    if (opts?.session !== undefined) params.session = opts.session;
    if (opts?.portraitPreset !== undefined) params.portrait_preset = opts.portraitPreset;
    if (opts?.landscapePreset !== undefined) params.landscape_preset = opts.landscapePreset;
    if (opts?.portraitSize !== undefined) params.portrait_size = opts.portraitSize;
    if (opts?.landscapeSize !== undefined) params.landscape_size = opts.landscapeSize;
    return this.request<OpenOrNavigateResultDto>('browser_open', params);
  }

  navigate(url: string, tabId?: string): Promise<OpenOrNavigateResultDto> {
    const params: Record<string, unknown> = { url };
    if (tabId !== undefined) params.tab_id = tabId;
    return this.request<OpenOrNavigateResultDto>('browser_navigate', params);
  }

  screenshot(
    tabId?: string,
    target: ViewportRole | 'both' = 'both',
  ): Promise<ScreenshotCaptureDto> {
    const params: Record<string, unknown> = { target };
    if (tabId !== undefined) params.tab_id = tabId;
    return this.request<ScreenshotCaptureDto>('browser_screenshot', params);
  }

  metrics(): Promise<TelemetrySnapshotDto> {
    return this.request<TelemetrySnapshotDto>('browser_metrics');
  }

  interact(params: InteractParams): Promise<InteractResultDto> {
    const wire: Record<string, unknown> = { action: params.action };
    if (params.tabId !== undefined) wire.tab_id = params.tabId;
    if (params.viewport !== undefined) wire.viewport = params.viewport;
    if (params.selector !== undefined) wire.selector = params.selector;
    if (params.text !== undefined) wire.text = params.text;
    if (params.key !== undefined) wire.key = params.key;
    if (params.x !== undefined) wire.x = params.x;
    if (params.y !== undefined) wire.y = params.y;
    if (params.ratioY !== undefined) wire.ratio_y = params.ratioY;
    if (params.mirror !== undefined) wire.mirror = params.mirror;
    return this.request<InteractResultDto>('browser_interact', wire);
  }

  console(
    tabIdOrOpts?: string | ConsoleQueryOptions,
    limit?: number,
  ): Promise<ConsoleResultDto> {
    const params: Record<string, unknown> = {};
    if (typeof tabIdOrOpts === 'string') {
      params.tab_id = tabIdOrOpts;
      if (limit !== undefined) params.limit = limit;
    } else if (tabIdOrOpts) {
      if (tabIdOrOpts.tabId !== undefined) params.tab_id = tabIdOrOpts.tabId;
      if (tabIdOrOpts.viewport !== undefined) params.viewport = tabIdOrOpts.viewport;
      if (tabIdOrOpts.level !== undefined) params.level = tabIdOrOpts.level;
      if (tabIdOrOpts.limit !== undefined) params.limit = tabIdOrOpts.limit;
    } else if (limit !== undefined) {
      params.limit = limit;
    }
    return this.request<ConsoleResultDto>('browser_console', params);
  }

  network(
    tabIdOrOpts?: string | NetworkQueryOptions,
    limit?: number,
  ): Promise<NetworkResultDto> {
    const params: Record<string, unknown> = {};
    if (typeof tabIdOrOpts === 'string') {
      params.tab_id = tabIdOrOpts;
      if (limit !== undefined) params.limit = limit;
    } else if (tabIdOrOpts) {
      if (tabIdOrOpts.tabId !== undefined) params.tab_id = tabIdOrOpts.tabId;
      if (tabIdOrOpts.viewport !== undefined) params.viewport = tabIdOrOpts.viewport;
      if (tabIdOrOpts.filter !== undefined) params.filter = tabIdOrOpts.filter;
      if (tabIdOrOpts.limit !== undefined) params.limit = tabIdOrOpts.limit;
    } else if (limit !== undefined) {
      params.limit = limit;
    }
    return this.request<NetworkResultDto>('browser_network', params);
  }

  evalJs(
    expression: string,
    role?: ViewportRole,
    tabId?: string,
    maxBytes?: number,
  ): Promise<EvalResultDto> {
    const params: Record<string, unknown> = { expression };
    if (role !== undefined) params.viewport = role;
    if (tabId !== undefined) params.tab_id = tabId;
    if (maxBytes !== undefined) params.max_bytes = maxBytes;
    return this.request<EvalResultDto>('browser_eval', params);
  }

  emulate<T = Record<string, unknown>>(params: Record<string, unknown>): Promise<T> {
    return this.request<T>('browser_emulate', params);
  }

  profile<T = Record<string, unknown>>(params: Record<string, unknown>): Promise<T> {
    return this.request<T>('browser_profile', params, 40_000);
  }

  health<T = Record<string, unknown>>(lines = 50): Promise<T> {
    return this.request<T>('browser_health', { lines }, 10_000);
  }

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
  }> {
    const params: Record<string, unknown> = {};
    if (opts?.tabId !== undefined) params.tab_id = opts.tabId;
    if (opts?.domain !== undefined) params.domain = opts.domain;
    if (opts?.viewport !== undefined) params.viewport = opts.viewport;
    if (opts?.sinceSeq !== undefined) params.since_seq = opts.sinceSeq;
    if (opts?.gestureSeq !== undefined) params.gesture_seq = opts.gestureSeq;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    return this.request('browser_events', params);
  }

  async waitForTabReady(
    tabId?: string,
    opts?: WaitForTabReadyOptions,
  ): Promise<TabSnapshotDto> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const pollMs = opts?.pollMs ?? 50;
    const waitForDomComplete = opts?.waitForDomComplete ?? true;
    const deadline = Date.now() + timeoutMs;

    let lastTab: TabSnapshotDto | undefined;
    while (Date.now() < deadline) {
      const state = await this.tabs();
      const targetId = tabId ?? state.activeTabId ?? undefined;
      const tab = targetId
        ? state.tabs.find((t) => t.id === targetId)
        : state.tabs[0];

      if (tab) {
        lastTab = tab;
        const urlOk =
          !opts?.expectedUrlIncludes ||
          tab.url.includes(opts.expectedUrlIncludes);

        if (!tab.loading && urlOk) {
          if (!waitForDomComplete || tab.sleeping) {
            return tab;
          }
          try {
            const evalViewport: ViewportRole =
              tab.mode === 'dual' ? 'portrait' : 'landscape';
            const res = await this.evalJs(
              'document.readyState',
              evalViewport,
              tab.id,
            );
            if (res.value === 'complete') {
              if (tab.mode === 'dual') {
                const landRes = await this.evalJs(
                  'document.readyState',
                  'landscape',
                  tab.id,
                );
                if (landRes.value === 'complete') {
                  return tab;
                }
              } else {
                return tab;
              }
            }
          } catch {
            // Viewport may still be transitioning during navigation; retry until deadline.
          }
        }
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new Error(
      `Timed out waiting for tab ${tabId ?? '(active)'} to be ready after ${timeoutMs}ms (last url=${lastTab?.url ?? 'none'}, loading=${String(lastTab?.loading)})`,
    );
  }

  close(): void {
    this.closedManually = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.decoder.reset();
    this.failAllPending(new Error('ControlSocketClient closed'));
  }
}
