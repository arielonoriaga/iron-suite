import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { WebContents } from 'electron';
import {
  buildDedupCacheKey,
  canonicalizeDiscriminatingHeaders,
  getContentEncodings,
  hasBinaryOrLossyPostData,
  isCacheableDedupStatus,
  isJsonContentType,
  isStreamContentType,
  MAX_BODY_BYTES,
  MAX_REPLAY_BODY_BYTES,
  normalizeRequestForDedup,
  parseAuthoritativeHttpOrigin,
  parseContentLengthHeader,
  remapJsonCorrelationValues,
  sanitizeReplayHeaders,
  shouldSkipResponseBodyFetch,
  type HeaderMapInput,
} from '../shared/request-dedup-core';
import type { DebuggerParticipantHooks, DebuggerTarget } from './debugger-coordinator';

export const MUTATION_TTL_MS = 2500;
export const INFLIGHT_WAIT_TIMEOUT_MS = 8000;
export const BODY_FETCH_TIMEOUT_MS = 2500;
export const MAX_TOTAL_SLOTS = 64;
export const MAX_QUEUED_PER_KEY = 4;
export const MAX_TOTAL_BUFFERED_BYTES = 16 * 1024 * 1024;

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

const yieldOutOfFetchEvent = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });

function hasNonTextPostDataEntries(entries: unknown): boolean {
  if (entries === undefined) return false;
  if (!Array.isArray(entries)) return true;
  if (entries.length === 0) return false;

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return true;
    }
    const rawBytes = (entry as { bytes?: unknown }).bytes;
    if (typeof rawBytes !== 'string') {
      // Non-inline CDP PostDataEntry (e.g. file/blob reference) must fail open.
      return true;
    }
    const buf = Buffer.from(rawBytes, 'base64');
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      return true;
    }
    chunks.push(buf);
  }

  try {
    const decoded = fatalUtf8Decoder.decode(Buffer.concat(chunks));
    return hasBinaryOrLossyPostData(decoded);
  } catch {
    return true;
  }
}

export interface DebuggerClient {
  isAttached(wc: DebuggerTarget | null | undefined): boolean;
  ensureAttached(wc: DebuggerTarget): Promise<boolean>;
  registerParticipant(
    wc: DebuggerTarget,
    id: string,
    hooks: DebuggerParticipantHooks,
  ): () => void;
  sendCommand<T = unknown>(
    wc: DebuggerTarget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

export interface DedupViewportContext<T extends DebuggerTarget = WebContents> {
  tabId: string;
  active: boolean;
  pairedWc: T | null;
  getOrigin: (wc: T) => string | null;
  getMainFrameId?: (wc: T) => string | null;
}

export interface RequestDedupOptions<T extends DebuggerTarget = WebContents> {
  resolveViewportContext: (wcId: number) => DedupViewportContext<T> | null;
  onDedupIncrement?: (wcId: number, countDelta: number) => void;
  ttlMs?: number;
  inflightWaitTimeoutMs?: number;
  bodyFetchTimeoutMs?: number;
}

interface BufferedResponse {
  ok: boolean;
  responseCode: number;
  responseHeaders: Array<{ name: string; value: string }>;
  bodyBase64: string;
  isJson: boolean;
}

interface DedupSlot {
  cacheKey: string;
  tabId: string;
  originWcId: number;
  initiatorOrigin: string;
  volatileValues: Record<string, string>;
  isMutation: boolean;
  createdAt: number;
  expiresAt: number;
  promise: Promise<BufferedResponse>;
  resolve: (res: BufferedResponse) => void;
  resolved: boolean;
  consumed: boolean;
  removed: boolean;
  bufferedBytes: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  networkKey: string;
}

const FAIL_RESPONSE: BufferedResponse = {
  ok: false,
  responseCode: 0,
  responseHeaders: [],
  bodyBase64: '',
  isJson: false,
};

const FETCH_PATTERNS = [
  { urlPattern: 'http://*', resourceType: 'XHR', requestStage: 'Request' },
  { urlPattern: 'https://*', resourceType: 'XHR', requestStage: 'Request' },
  { urlPattern: 'http://*', resourceType: 'Fetch', requestStage: 'Request' },
  { urlPattern: 'https://*', resourceType: 'Fetch', requestStage: 'Request' },
  { urlPattern: 'http://*', resourceType: 'XHR', requestStage: 'Response' },
  { urlPattern: 'https://*', resourceType: 'XHR', requestStage: 'Response' },
  { urlPattern: 'http://*', resourceType: 'Fetch', requestStage: 'Response' },
  { urlPattern: 'https://*', resourceType: 'Fetch', requestStage: 'Response' },
];

function extractRequestHeaders(raw: unknown): HeaderMapInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (Array.isArray(raw)) {
    const out: Array<{ name: string; value: string }> = [];
    for (const item of raw) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { value?: unknown }).value === 'string'
      ) {
        out.push({
          name: (item as { name: string }).name,
          value: (item as { value: string }).value,
        });
      }
    }
    return out;
  }
  const record: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      record[k] = v;
    }
  }
  return record;
}

interface DecompressOptions {
  isJson: boolean;
  base64Encoded: boolean;
}

function isValidUtf8Json(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isValidUtf8TextWithoutNul(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function decompressResponseBody(
  rawBuf: Buffer,
  encodings: string[],
  opts: DecompressOptions = { isJson: false, base64Encoded: true },
): Buffer | null {
  if (encodings.length === 0) {
    return rawBuf.length <= MAX_REPLAY_BODY_BYTES ? rawBuf : null;
  }

  const outerEnc = encodings[encodings.length - 1];
  const hasGzipMagic =
    (outerEnc === 'gzip' || outerEnc === 'x-gzip') &&
    rawBuf.length >= 2 &&
    rawBuf[0] === 0x1f &&
    rawBuf[1] === 0x8b;

  let buf = rawBuf;
  let hitSizeLimit = false;
  let failed = false;

  for (let i = encodings.length - 1; i >= 0; i -= 1) {
    const enc = encodings[i]!;
    try {
      if (enc === 'gzip' || enc === 'x-gzip') {
        buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_REPLAY_BODY_BYTES });
      } else if (enc === 'br') {
        buf = zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_REPLAY_BODY_BYTES });
      } else if (enc === 'deflate') {
        try {
          buf = zlib.inflateSync(buf, { maxOutputLength: MAX_REPLAY_BODY_BYTES });
        } catch (err) {
          if ((err as { code?: string })?.code === 'Z_DATA_ERROR') {
            buf = zlib.inflateRawSync(buf, { maxOutputLength: MAX_REPLAY_BODY_BYTES });
          } else {
            if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
              hitSizeLimit = true;
            }
            failed = true;
            break;
          }
        }
      } else {
        return null;
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
        hitSizeLimit = true;
      }
      failed = true;
      break;
    }
    if (buf.length > MAX_REPLAY_BODY_BYTES) {
      hitSizeLimit = true;
      failed = true;
      break;
    }
  }

  if (!failed) {
    return buf;
  }
  if (hitSizeLimit || hasGzipMagic) {
    return null;
  }

  // Chromium 134 / Electron 35 Fetch.getResponseBody may return already-decompressed bytes
  // even when Content-Encoding remains in responseHeaders.
  if (opts.isJson) {
    return isValidUtf8Json(rawBuf) ? rawBuf : null;
  }
  if (!opts.base64Encoded && isValidUtf8TextWithoutNul(rawBuf)) {
    return rawBuf;
  }
  return null;
}

export class RequestDedupMiddleware<T extends DebuggerTarget = WebContents> {
  private readonly enabledWcIds = new Set<number>();
  private readonly fetchEnabledWcIds = new Set<number>();
  private readonly desiredEnabledByWcId = new Map<number, boolean>();
  private readonly enableLocks = new Map<number, Promise<void>>();
  private readonly mainFrameIdByWcId = new Map<number, string>();
  private readonly participantUnsubs = new Map<number, () => void>();
  private readonly slotsByKey = new Map<string, DedupSlot[]>();
  private readonly allSlots = new Set<DedupSlot>();
  private readonly inFlightByNetworkKey = new Map<string, DedupSlot>();
  private readonly dedupCountByTab = new Map<string, number>();
  private totalBufferedBytes = 0;

  private readonly ttlMs: number;
  private readonly inflightWaitTimeoutMs: number;
  private readonly bodyFetchTimeoutMs: number;

  constructor(
    private readonly coordinator: DebuggerClient,
    private readonly options: RequestDedupOptions<T>,
  ) {
    this.ttlMs = options.ttlMs ?? MUTATION_TTL_MS;
    this.inflightWaitTimeoutMs = options.inflightWaitTimeoutMs ?? INFLIGHT_WAIT_TIMEOUT_MS;
    this.bodyFetchTimeoutMs = options.bodyFetchTimeoutMs ?? BODY_FETCH_TIMEOUT_MS;
  }

  getTabDedupCount(tabId: string): number {
    return this.dedupCountByTab.get(tabId) ?? 0;
  }

  getTotalBufferedBytes(): number {
    return this.totalBufferedBytes;
  }

  getActiveSlotCount(): number {
    return this.allSlots.size;
  }

  isViewportEnabled(wcId: number): boolean {
    return this.enabledWcIds.has(wcId);
  }

  clearTabSlots(tabId: string): void {
    const toFail: DedupSlot[] = [];
    for (const slot of this.allSlots) {
      if (slot.tabId === tabId) {
        toFail.push(slot);
      }
    }
    for (const slot of this.inFlightByNetworkKey.values()) {
      if (slot.tabId === tabId) {
        toFail.push(slot);
      }
    }
    for (const slot of toFail) {
      this.finalizeSlot(slot, FAIL_RESPONSE, 0);
      this.removeSlot(slot);
    }
  }

  clearTab(tabId: string): void {
    this.clearTabSlots(tabId);
    this.dedupCountByTab.delete(tabId);
  }

  disposeWebContents(wcId: number): void {
    const unsub = this.participantUnsubs.get(wcId);
    if (unsub) {
      this.participantUnsubs.delete(wcId);
      try {
        unsub();
      } catch {
        // Ignore cleanup errors.
      }
    }
    this.desiredEnabledByWcId.delete(wcId);
    this.enabledWcIds.delete(wcId);
    this.fetchEnabledWcIds.delete(wcId);
    this.mainFrameIdByWcId.delete(wcId);
    this.enableLocks.delete(wcId);
    this.failOpenWebContentsSlots(wcId);
  }

  dispose(): void {
    for (const unsub of Array.from(this.participantUnsubs.values())) {
      try {
        unsub();
      } catch {
        // Ignore cleanup errors.
      }
    }
    this.participantUnsubs.clear();
    this.desiredEnabledByWcId.clear();
    this.enabledWcIds.clear();
    this.fetchEnabledWcIds.clear();
    this.mainFrameIdByWcId.clear();
    this.enableLocks.clear();

    const toFail = [
      ...Array.from(this.allSlots),
      ...Array.from(this.inFlightByNetworkKey.values()),
    ];
    for (const slot of toFail) {
      this.finalizeSlot(slot, FAIL_RESPONSE, 0);
      this.removeSlot(slot);
    }
    this.slotsByKey.clear();
    this.allSlots.clear();
    this.inFlightByNetworkKey.clear();
    this.dedupCountByTab.clear();
    this.totalBufferedBytes = 0;
  }

  async setViewportEnabled(wc: T | null | undefined, enabled: boolean): Promise<void> {
    if (!wc || wc.isDestroyed()) return;
    const wcId = wc.id;
    this.desiredEnabledByWcId.set(wcId, enabled);

    if (!enabled) {
      this.enabledWcIds.delete(wcId);
      this.failOpenWebContentsSlots(wcId);
      const ctx = this.options.resolveViewportContext(wcId);
      if (ctx) {
        this.clearTabSlots(ctx.tabId);
      }
    }

    const prev = this.enableLocks.get(wcId) ?? Promise.resolve();
    const task = prev
      .catch(() => {})
      .then(async () => {
        if (wc.isDestroyed()) return;
        const want = this.desiredEnabledByWcId.get(wcId) === true;
        if (want) {
          await this.enableViewportInternal(wc);
        } else {
          await this.disableViewportInternal(wc);
        }
      });

    this.enableLocks.set(wcId, task);
    try {
      await task;
    } finally {
      if (this.enableLocks.get(wcId) === task) {
        this.enableLocks.delete(wcId);
      }
    }
  }

  private ensureParticipant(wc: T): void {
    if (this.participantUnsubs.has(wc.id) || wc.isDestroyed()) return;
    const unsub = this.coordinator.registerParticipant(wc, 'request-dedup', {
      onMessage: (method, params) => {
        if (method === 'Fetch.requestPaused') {
          void this.handleRequestPaused(wc, (params ?? {}) as Record<string, unknown>);
        } else if (method === 'Network.loadingFailed') {
          this.handleLoadingFailed(wc.id, (params ?? {}) as Record<string, unknown>);
        } else if (method === 'Page.frameNavigated') {
          this.handleFrameNavigated(wc.id, (params ?? {}) as Record<string, unknown>);
        }
      },
      onDetach: () => {
        this.enabledWcIds.delete(wc.id);
        this.fetchEnabledWcIds.delete(wc.id);
        this.mainFrameIdByWcId.delete(wc.id);
        this.failOpenWebContentsSlots(wc.id);
      },
      onReattach: async () => {
        if (
          this.desiredEnabledByWcId.get(wc.id) === true &&
          this.options.resolveViewportContext(wc.id)?.active === true
        ) {
          await this.setViewportEnabled(wc, true);
        }
      },
      onDestroyed: () => {
        this.disposeWebContents(wc.id);
      },
    });
    this.participantUnsubs.set(wc.id, unsub);
  }

  private async enableViewportInternal(wc: T): Promise<void> {
    if (wc.isDestroyed() || this.desiredEnabledByWcId.get(wc.id) !== true) return;
    this.ensureParticipant(wc);

    const attached = await this.coordinator.ensureAttached(wc);
    if (!attached || wc.isDestroyed() || this.desiredEnabledByWcId.get(wc.id) !== true) {
      return;
    }

    if (this.enabledWcIds.has(wc.id) && this.fetchEnabledWcIds.has(wc.id)) {
      return;
    }

    try {
      await this.coordinator.sendCommand(wc, 'Page.enable');
    } catch {
      // Ignore if Page domain is unsupported by a minimal target mock.
    }

    if (wc.isDestroyed() || this.desiredEnabledByWcId.get(wc.id) !== true) {
      return;
    }

    try {
      const tree = await this.coordinator.sendCommand<{
        frameTree?: { frame?: { id?: string } };
      }>(wc, 'Page.getFrameTree');
      const mainId = tree?.frameTree?.frame?.id;
      if (typeof mainId === 'string' && mainId.length > 0) {
        this.mainFrameIdByWcId.set(wc.id, mainId);
      }
    } catch {
      // Fall back to ctx.getMainFrameId or Page.frameNavigated if provided.
    }

    if (wc.isDestroyed() || this.desiredEnabledByWcId.get(wc.id) !== true) {
      return;
    }

    try {
      await this.coordinator.sendCommand(wc, 'Network.enable', {
        maxTotalBufferSize: 1,
        maxResourceBufferSize: 1,
        maxPostDataSize: 1,
      });
    } catch {
      // Ignore transient Network.enable errors; TelemetryService may also manage it.
    }

    if (wc.isDestroyed() || this.desiredEnabledByWcId.get(wc.id) !== true) {
      return;
    }

    try {
      await this.coordinator.sendCommand(wc, 'Fetch.enable', { patterns: FETCH_PATTERNS });
      this.fetchEnabledWcIds.add(wc.id);
    } catch {
      return;
    }

    if (
      !wc.isDestroyed() &&
      this.desiredEnabledByWcId.get(wc.id) === true &&
      this.coordinator.isAttached(wc)
    ) {
      this.enabledWcIds.add(wc.id);
    } else {
      await this.disableViewportInternal(wc);
    }
  }

  private async disableViewportInternal(wc: T): Promise<void> {
    this.enabledWcIds.delete(wc.id);
    this.failOpenWebContentsSlots(wc.id);

    if (!this.fetchEnabledWcIds.has(wc.id)) {
      return;
    }
    this.fetchEnabledWcIds.delete(wc.id);

    if (!wc.isDestroyed() && this.coordinator.isAttached(wc)) {
      try {
        await this.coordinator.sendCommand(wc, 'Fetch.disable');
      } catch {
        // Ignore transient detach errors.
      }
    }
  }

  private failOpenWebContentsSlots(wcId: number): void {
    const prefix = `${wcId}:`;
    const toFail: DedupSlot[] = [];
    for (const slot of this.allSlots) {
      if (slot.originWcId === wcId || slot.networkKey.startsWith(prefix)) {
        toFail.push(slot);
      }
    }
    for (const [netKey, slot] of this.inFlightByNetworkKey) {
      if (netKey.startsWith(prefix) || slot.originWcId === wcId) {
        toFail.push(slot);
      }
    }
    for (const slot of toFail) {
      this.finalizeSlot(slot, FAIL_RESPONSE, 0);
      this.removeSlot(slot);
    }
  }

  private handleFrameNavigated(wcId: number, params: Record<string, unknown>): void {
    const frame = params.frame as { id?: unknown; parentId?: unknown } | undefined;
    if (!frame || typeof frame !== 'object') return;
    if (typeof frame.id === 'string' && frame.id.length > 0 && !frame.parentId) {
      this.mainFrameIdByWcId.set(wcId, frame.id);
    }
  }

  private handleLoadingFailed(wcId: number, params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;
    const netKey = `${wcId}:${requestId}`;
    const slot = this.inFlightByNetworkKey.get(netKey);
    if (!slot) return;
    this.finalizeSlot(slot, FAIL_RESPONSE, 0);
    this.removeSlot(slot);
  }

  private removeSlot(slot: DedupSlot): void {
    if (slot.removed) return;
    slot.removed = true;
    if (slot.cleanupTimer) {
      clearTimeout(slot.cleanupTimer);
      slot.cleanupTimer = null;
    }
    this.allSlots.delete(slot);
    if (slot.bufferedBytes > 0) {
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - slot.bufferedBytes);
      slot.bufferedBytes = 0;
    }
    const queue = this.slotsByKey.get(slot.cacheKey);
    if (queue) {
      const idx = queue.indexOf(slot);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
      if (queue.length === 0) {
        this.slotsByKey.delete(slot.cacheKey);
      }
    }
    if (this.inFlightByNetworkKey.get(slot.networkKey) === slot) {
      this.inFlightByNetworkKey.delete(slot.networkKey);
    }
  }

  private evictOldestSlot(excludeSlot?: DedupSlot): boolean {
    let candidate: DedupSlot | null = null;
    for (const slot of this.allSlots) {
      if (slot === excludeSlot || slot.removed) continue;
      if (slot.resolved) {
        candidate = slot;
        break;
      }
      if (!candidate) {
        candidate = slot;
      }
    }
    if (!candidate) return false;
    if (!candidate.resolved) {
      this.finalizeSlot(candidate, FAIL_RESPONSE, 0);
    }
    this.removeSlot(candidate);
    return true;
  }

  private pruneExpiredInQueue(cacheKey: string, now: number): DedupSlot[] | undefined {
    const queue = this.slotsByKey.get(cacheKey);
    if (!queue) return undefined;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const s = queue[i]!;
      if (s.removed || s.consumed || (s.resolved && now > s.expiresAt)) {
        this.removeSlot(s);
      }
    }
    return this.slotsByKey.get(cacheKey);
  }

  private finalizeSlot(
    slot: DedupSlot,
    response: BufferedResponse,
    bufferedBytes: number,
  ): void {
    if (slot.resolved) return;
    slot.resolved = true;
    if (slot.cleanupTimer) {
      clearTimeout(slot.cleanupTimer);
      slot.cleanupTimer = null;
    }
    if (this.inFlightByNetworkKey.get(slot.networkKey) === slot) {
      this.inFlightByNetworkKey.delete(slot.networkKey);
    }

    if (!response.ok || slot.consumed || slot.removed || bufferedBytes > MAX_TOTAL_BUFFERED_BYTES) {
      slot.expiresAt = 0;
      slot.resolve(response);
      this.removeSlot(slot);
      return;
    }

    while (this.totalBufferedBytes + bufferedBytes > MAX_TOTAL_BUFFERED_BYTES) {
      if (!this.evictOldestSlot(slot)) {
        slot.expiresAt = 0;
        slot.resolve(FAIL_RESPONSE);
        this.removeSlot(slot);
        return;
      }
    }

    slot.bufferedBytes = bufferedBytes;
    this.totalBufferedBytes += bufferedBytes;
    slot.expiresAt = Date.now() + this.ttlMs;
    slot.resolve(response);

    if (this.ttlMs <= 0) {
      this.removeSlot(slot);
    } else {
      slot.cleanupTimer = setTimeout(() => {
        this.removeSlot(slot);
      }, this.ttlMs);
    }
  }

  private async sendFetchCommand<R = unknown>(
    wc: T,
    method: string,
    params: Record<string, unknown>,
  ): Promise<R> {
    // Chromium 134 (Electron 35) InterceptionJob UAF guard:
    // InterceptionJob::NotifyClient emits Fetch.requestPaused synchronously inside
    // RequestBodyCollector::Collect() before assigning `this->body_collector_`.
    // Continuing/fulfilling/failing/reading inside the same V8 MicrotasksScope destroys
    // InterceptionJob before Collect() returns (PartitionAlloc 0xefef... SIGSEGV).
    await yieldOutOfFetchEvent();
    if (wc.isDestroyed() || !this.coordinator.isAttached(wc)) {
      throw new Error(`Debugger detached before ${method}`);
    }
    return this.coordinator.sendCommand<R>(wc, method, params);
  }

  private async safeContinueRequest(wc: T, requestId: string): Promise<void> {
    if (wc.isDestroyed() || !this.coordinator.isAttached(wc)) return;
    try {
      await this.sendFetchCommand(wc, 'Fetch.continueRequest', { requestId });
    } catch {
      // Request may already be cancelled/closed.
    }
  }

  private async safeContinueResponse(
    wc: T,
    requestId: string,
    responseErrorReason?: string,
  ): Promise<void> {
    if (wc.isDestroyed() || !this.coordinator.isAttached(wc)) return;
    try {
      await this.sendFetchCommand(wc, 'Fetch.continueResponse', { requestId });
    } catch {
      if (responseErrorReason && !wc.isDestroyed() && this.coordinator.isAttached(wc)) {
        try {
          await this.sendFetchCommand(wc, 'Fetch.failRequest', {
            requestId,
            errorReason: responseErrorReason,
          });
        } catch {
          // Request may already be cancelled/closed.
        }
      }
    }
  }

  private resolveMainFrameId(wc: T, ctx: DedupViewportContext<T>): string | null {
    const provided = ctx.getMainFrameId?.(wc);
    if (typeof provided === 'string' && provided.length > 0) {
      return provided;
    }
    return this.mainFrameIdByWcId.get(wc.id) ?? null;
  }

  private async handleRequestPaused(wc: T, params: Record<string, unknown>): Promise<void> {
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;

    const isResponseStage =
      params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;

    if (isResponseStage) {
      await this.handleResponseStage(wc, requestId, params);
      return;
    }

    await this.handleRequestStage(wc, requestId, params);
  }

  private async handleRequestStage(
    wc: T,
    requestId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabledWcIds.has(wc.id) || wc.isDestroyed() || !this.coordinator.isAttached(wc)) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const ctx = this.options.resolveViewportContext(wc.id);
    if (!ctx || !ctx.active || !ctx.pairedWc || ctx.pairedWc.isDestroyed()) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const mainFrameId = this.resolveMainFrameId(wc, ctx);
    if (
      mainFrameId === null ||
      typeof params.frameId !== 'string' ||
      params.frameId !== mainFrameId
    ) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const originA = parseAuthoritativeHttpOrigin(ctx.getOrigin(wc));
    const originB = parseAuthoritativeHttpOrigin(ctx.getOrigin(ctx.pairedWc));
    if (originA === null || originA !== originB) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const req = (params.request ?? {}) as Record<string, unknown>;
    const method = typeof req.method === 'string' ? req.method : 'GET';
    const url = typeof req.url === 'string' ? req.url : '';
    const hasPostData = req.hasPostData === true;
    const postData = req.postData as string | undefined;
    const resourceType = typeof params.resourceType === 'string' ? params.resourceType : '';
    const networkId = typeof params.networkId === 'string' ? params.networkId : requestId;
    const reqHeaders = extractRequestHeaders(req.headers);

    if (hasPostData && hasNonTextPostDataEntries(req.postDataEntries)) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const normalized = normalizeRequestForDedup({
      method,
      url,
      resourceType,
      postData,
      hasPostData,
      requestHeaders: reqHeaders,
    });
    if (!normalized.eligible) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    const headerDigest = crypto
      .createHash('sha256')
      .update(canonicalizeDiscriminatingHeaders(reqHeaders))
      .digest('hex');

    const cacheKey = buildDedupCacheKey({
      tabId: ctx.tabId,
      initiatorOrigin: originA,
      headerDigest,
      normalizedKey: normalized.key,
    });

    const now = Date.now();
    const queue = this.pruneExpiredInQueue(cacheKey, now);
    const pairedWcId = ctx.pairedWc.id;

    let matched: DedupSlot | undefined;
    if (queue) {
      for (const s of queue) {
        if (
          !s.consumed &&
          !s.removed &&
          s.originWcId !== wc.id &&
          s.originWcId === pairedWcId &&
          (!s.resolved || now <= s.expiresAt)
        ) {
          matched = s;
          break;
        }
      }
    }

    if (matched) {
      // Synchronously claim the matched slot (consume-once) before any await.
      matched.consumed = true;
      if (queue) {
        const idx = queue.indexOf(matched);
        if (idx !== -1) {
          queue.splice(idx, 1);
        }
        if (queue.length === 0) {
          this.slotsByKey.delete(cacheKey);
        }
      }
      const wasAlreadyResolved = matched.resolved;
      if (wasAlreadyResolved) {
        this.removeSlot(matched);
      }

      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      const buffered = wasAlreadyResolved
        ? await matched.promise
        : await Promise.race<BufferedResponse | null>([
            matched.promise,
            new Promise<null>((resolve) => {
              waitTimer = setTimeout(() => resolve(null), this.inflightWaitTimeoutMs);
            }),
          ]).finally(() => {
            if (waitTimer) clearTimeout(waitTimer);
          });

      // Post-await validation: re-check activation, tab identity, enabled state, and origin parity.
      const postCtx = this.options.resolveViewportContext(wc.id);
      const postOriginA = postCtx ? parseAuthoritativeHttpOrigin(postCtx.getOrigin(wc)) : null;
      const postOriginB =
        postCtx && postCtx.pairedWc && !postCtx.pairedWc.isDestroyed()
          ? parseAuthoritativeHttpOrigin(postCtx.getOrigin(postCtx.pairedWc))
          : null;

      if (
        buffered &&
        buffered.ok &&
        !wc.isDestroyed() &&
        this.coordinator.isAttached(wc) &&
        this.enabledWcIds.has(wc.id) &&
        postCtx !== null &&
        postCtx.active === true &&
        postCtx.tabId === ctx.tabId &&
        postOriginA !== null &&
        postOriginA === matched.initiatorOrigin &&
        postOriginA === postOriginB
      ) {
        let bodyBase64 = buffered.bodyBase64;
        if (buffered.isJson && bodyBase64.length > 0) {
          try {
            const decoded = Buffer.from(bodyBase64, 'base64').toString('utf8');
            const remapped = remapJsonCorrelationValues(
              decoded,
              matched.volatileValues,
              normalized.volatileValues,
            );
            if (remapped !== decoded) {
              bodyBase64 = Buffer.from(remapped, 'utf8').toString('base64');
            }
          } catch {
            // Fall back to exact primary bytes.
          }
        }

        const fulfillParams: Record<string, unknown> = {
          requestId,
          responseCode: buffered.responseCode,
          responseHeaders: sanitizeReplayHeaders(buffered.responseHeaders),
        };
        if (bodyBase64.length > 0) {
          fulfillParams.body = bodyBase64;
        }

        try {
          await this.sendFetchCommand(wc, 'Fetch.fulfillRequest', fulfillParams);
          const nextCount = (this.dedupCountByTab.get(ctx.tabId) ?? 0) + 1;
          this.dedupCountByTab.set(ctx.tabId, nextCount);
          this.options.onDedupIncrement?.(wc.id, 1);
          return;
        } catch {
          // Fail open to real network if fulfillRequest fails.
        }
      }

      await this.safeContinueRequest(wc, requestId);
      return;
    }

    // Primary: enforce per-key queue cap (fail open if >= MAX_QUEUED_PER_KEY).
    if (queue && queue.length >= MAX_QUEUED_PER_KEY) {
      await this.safeContinueRequest(wc, requestId);
      return;
    }

    while (this.allSlots.size >= MAX_TOTAL_SLOTS) {
      if (!this.evictOldestSlot()) {
        break;
      }
    }

    let resolveFn!: (res: BufferedResponse) => void;
    const promise = new Promise<BufferedResponse>((resolve) => {
      resolveFn = resolve;
    });

    const networkKey = `${wc.id}:${networkId}`;
    const slot: DedupSlot = {
      cacheKey,
      tabId: ctx.tabId,
      originWcId: wc.id,
      initiatorOrigin: originA,
      volatileValues: normalized.volatileValues,
      isMutation: normalized.isMutation,
      createdAt: now,
      expiresAt: now + this.inflightWaitTimeoutMs,
      promise,
      resolve: resolveFn,
      resolved: false,
      consumed: false,
      removed: false,
      bufferedBytes: 0,
      cleanupTimer: null,
      networkKey,
    };

    slot.cleanupTimer = setTimeout(() => {
      this.finalizeSlot(slot, FAIL_RESPONSE, 0);
      this.removeSlot(slot);
    }, this.inflightWaitTimeoutMs);

    let targetQueue = this.slotsByKey.get(cacheKey);
    if (!targetQueue) {
      targetQueue = [];
      this.slotsByKey.set(cacheKey, targetQueue);
    }
    targetQueue.push(slot);
    this.allSlots.add(slot);
    this.inFlightByNetworkKey.set(networkKey, slot);

    await this.safeContinueRequest(wc, requestId);
  }

  private async handleResponseStage(
    wc: T,
    requestId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const networkId = typeof params.networkId === 'string' ? params.networkId : requestId;
    const netKey = `${wc.id}:${networkId}`;
    const slot = this.inFlightByNetworkKey.get(netKey);
    const responseErrorReason =
      typeof params.responseErrorReason === 'string' ? params.responseErrorReason : undefined;

    if (!slot) {
      await this.safeContinueResponse(wc, requestId, responseErrorReason);
      return;
    }
    this.inFlightByNetworkKey.delete(netKey);

    try {
      if (responseErrorReason || !this.enabledWcIds.has(wc.id) || slot.removed) {
        this.finalizeSlot(slot, FAIL_RESPONSE, 0);
        return;
      }

      const responseCode =
        typeof params.responseStatusCode === 'number' ? params.responseStatusCode : 200;
      const rawHeaders = Array.isArray(params.responseHeaders)
        ? (params.responseHeaders as Array<{ name?: string; value?: string }>)
        : [];
      const responseHeaders = rawHeaders
        .filter((h) => typeof h.name === 'string' && typeof h.value === 'string')
        .map((h) => ({ name: h.name!, value: h.value! }));

      if (!isCacheableDedupStatus(responseCode)) {
        this.finalizeSlot(slot, FAIL_RESPONSE, 0);
        return;
      }

      if (isStreamContentType(responseHeaders)) {
        this.finalizeSlot(slot, FAIL_RESPONSE, 0);
        return;
      }

      const contentLength = parseContentLengthHeader(responseHeaders);
      if (contentLength !== null && contentLength > MAX_REPLAY_BODY_BYTES) {
        this.finalizeSlot(slot, FAIL_RESPONSE, 0);
        return;
      }

      const encodings = getContentEncodings(responseHeaders);
      for (const enc of encodings) {
        if (enc !== 'gzip' && enc !== 'x-gzip' && enc !== 'br' && enc !== 'deflate') {
          this.finalizeSlot(slot, FAIL_RESPONSE, 0);
          return;
        }
      }

      let bodyBase64 = '';
      let bufferedBytes = 0;

      if (!shouldSkipResponseBodyFetch(responseCode)) {
        let bodyTimer: ReturnType<typeof setTimeout> | null = null;
        const bodyRes = (await Promise.race([
          this.sendFetchCommand<{ body?: string; base64Encoded?: boolean }>(
            wc,
            'Fetch.getResponseBody',
            { requestId },
          ),
          new Promise<null>((resolve) => {
            bodyTimer = setTimeout(() => resolve(null), this.bodyFetchTimeoutMs);
          }),
        ]).finally(() => {
          if (bodyTimer) clearTimeout(bodyTimer);
        })) as { body?: string; base64Encoded?: boolean } | null;

        if (!bodyRes) {
          this.finalizeSlot(slot, FAIL_RESPONSE, 0);
          return;
        }

        const rawBody = bodyRes.body ?? '';
        const rawBuf = bodyRes.base64Encoded
          ? Buffer.from(rawBody, 'base64')
          : Buffer.from(rawBody, 'utf8');

        if (rawBuf.length > MAX_REPLAY_BODY_BYTES) {
          this.finalizeSlot(slot, FAIL_RESPONSE, 0);
          return;
        }

        const plainBuf = decompressResponseBody(rawBuf, encodings, {
          isJson: isJsonContentType(responseHeaders),
          base64Encoded: Boolean(bodyRes.base64Encoded),
        });
        if (!plainBuf || plainBuf.length > MAX_REPLAY_BODY_BYTES) {
          this.finalizeSlot(slot, FAIL_RESPONSE, 0);
          return;
        }

        bufferedBytes = plainBuf.length;
        bodyBase64 = plainBuf.toString('base64');
      }

      this.finalizeSlot(
        slot,
        {
          ok: true,
          responseCode,
          responseHeaders,
          bodyBase64,
          isJson: isJsonContentType(responseHeaders),
        },
        bufferedBytes,
      );
    } catch {
      this.finalizeSlot(slot, FAIL_RESPONSE, 0);
    } finally {
      await this.safeContinueResponse(wc, requestId, responseErrorReason);
    }
  }
}
