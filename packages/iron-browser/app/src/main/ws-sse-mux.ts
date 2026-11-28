import { createHash } from 'node:crypto';
import { ipcMain, type IpcMainEvent } from 'electron';
import type { ViewportRole } from '../shared/types';
import {
  WS_HANDSHAKE_BUFFER_TTL_MS,
  WS_MAX_CHANNELS_PER_TAB,
  WS_MAX_FRAME_BYTES,
  WS_MAX_HANDSHAKE_FRAMES,
  WS_MAX_TOTAL_BUFFER_BYTES,
  WS_OUTBOUND_DEDUP_WINDOW_MS,
  WS_OWNER_TEARDOWN_CLOSE_CODE,
  WS_OWNER_TEARDOWN_CLOSE_REASON,
  WS_REJECT_CAP_CLOSE_CODE,
  WS_REJECT_CAP_CLOSE_REASON,
  WS_SSE_MUX_IPC_CHANNELS,
  buildMuxChannelKey,
  buildWsSseMuxShimScript,
  canonicalizeWsOutboundPayload,
  isValidHttpOrigin,
  normalizeMuxUrl,
  normalizeWsProtocols,
  type MainToMuxMessage,
  type MuxChannelKind,
  type MuxToMainMessage,
} from '../shared/ws-sse-mux-core';
import type { DebuggerParticipantHooks, DebuggerTarget } from './debugger-coordinator';
import { buildClusterSiblingChannelKey, parseSfsBinaryPacket } from './sfs-binary-codec';
import type { TabEventBus } from './tab-event-bus';

export interface MuxWebContents extends DebuggerTarget {
  mainFrame?: { origin?: string | null } | null;
  send(channel: string, ...args: unknown[]): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MuxDebuggerClient {
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

export interface WsMuxViewportContext {
  tabId: string;
  role: ViewportRole;
  active: boolean;
  wc: MuxWebContents;
  pairedWc: MuxWebContents | null;
  getOrigin: (wc: MuxWebContents) => string | null;
}

export interface IpcLike {
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
  off?(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
  removeListener?(
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ): unknown;
}

export interface WsSseMuxOptions {
  now?: () => number;
  handshakeTtlMs?: number;
  sfsSessionTtlMs?: number;
  outboundDedupWindowMs?: number;
  maxChannelsPerTab?: number;
  maxHandshakeFrames?: number;
  maxFrameBytes?: number;
  maxTotalBufferBytes?: number;
  ipc?: IpcLike;
  onDedupIncrement?: (wcId: number, countDelta: number) => void;
  eventBus?: TabEventBus;
}

export interface WsSseMuxStats {
  activeChannels: number;
  totalBufferedBytes: number;
  installedWcIds: number[];
}

type SfsFollowerState = 'passthrough' | 'wait_hs_req' | 'wait_login_req' | 'ready';

interface EndpointRef {
  wcId: number;
  clientSocketId: string;
  handshakeFlushed: boolean;
  sfsFollowerState?: SfsFollowerState;
}

interface HandshakeFrame {
  kind: MuxChannelKind;
  isBinary?: boolean;
  data: string | Uint8Array;
  eventType?: string;
  lastEventId?: string;
  byteLength: number;
  ts: number;
}

interface OutboundDedupEntry {
  key: string;
  channelId: string;
  senderWcId: number;
  ts: number;
  byteLength: number;
}

interface MuxChannel {
  channelId: string;
  tabId: string;
  initiatorOrigin: string;
  kind: MuxChannelKind;
  normalizedUrl: string;
  channelKey: string;
  clusterKey: string | null;
  protocols: string[];
  negotiatedProtocol: string;
  negotiatedExtensions: string;
  withCredentials: boolean;
  owner: EndpointRef;
  followers: Map<string, EndpointRef>;
  state: 'connecting' | 'open';
  createdAt: number;
  handshakeBuffer: HandshakeFrame[];
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  ownerClosingByClient: boolean;
  isSfsChannel: boolean;
  sfsSessionUpdatedAt: number;
  sfsHandshakeResp: HandshakeFrame | null;
  sfsLoginResp: HandshakeFrame | null;
  sfsInitFrame: HandshakeFrame | null;
  sfsRecentFrames: HandshakeFrame[];
}

interface SocketLookupEntry {
  channelId: string;
  wcId: number;
  clientSocketId: string;
  role: 'owner' | 'follower';
}

interface ViewportScriptState {
  wc: MuxWebContents;
  desiredActive: boolean;
  scriptIdentifier: string | null;
  pageEnabled: boolean;
  detachEpoch: number;
  syncChain: Promise<void>;
  participantUnsub: (() => void) | null;
  lifecycleCleanup: (() => void) | null;
  disposed: boolean;
}

const PARTICIPANT_ID = 'ws-sse-mux';
const DEDUP_ENTRY_OVERHEAD_BYTES = 128;
const DEFAULT_SFS_SESSION_TTL_MS = 60_000;
const MAX_SFS_RECENT_INIT_FRAMES = 6;

function makeSocketKey(wcId: number, clientSocketId: string): string {
  return `${wcId}:${clientSocketId}`;
}

function toUint8Array(data: unknown): Uint8Array | null {
  let view: Uint8Array | null = null;
  if (data instanceof Uint8Array) {
    view = data;
  } else if (ArrayBuffer.isView(data)) {
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (!view) return null;
  if (view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength) {
    return view.slice();
  }
  return view;
}

function byteSizeOfData(data: string | Uint8Array): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }
  return data.byteLength;
}

export class WsSseMux {
  private readonly now: () => number;
  private readonly handshakeTtlMs: number;
  private readonly sfsSessionTtlMs: number;
  private readonly outboundDedupWindowMs: number;
  private readonly maxChannelsPerTab: number;
  private readonly maxHandshakeFrames: number;
  private readonly maxFrameBytes: number;
  private readonly maxTotalBufferBytes: number;
  private readonly ipc: IpcLike;
  private readonly onDedupIncrement?: (wcId: number, countDelta: number) => void;
  private readonly eventBus?: TabEventBus;
  private readonly shimScript: string;

  private readonly wcStates = new Map<number, ViewportScriptState>();
  private readonly channelsByKey = new Map<string, MuxChannel>();
  private readonly channelsByClusterKey = new Map<string, Set<string>>();
  private readonly channelsById = new Map<string, MuxChannel>();
  private readonly channelsByWcId = new Map<number, Set<string>>();
  private readonly socketLookup = new Map<string, SocketLookupEntry>();
  private readonly outboundDedup: OutboundDedupEntry[] = [];

  private nextChannelSeq = 1;
  private totalBufferedBytes = 0;
  private disposed = false;

  private readonly ipcListener: (ev: IpcMainEvent, raw: unknown) => void;

  constructor(
    private readonly debuggerCoordinator: MuxDebuggerClient,
    private readonly resolveViewportContext: (wcId: number) => WsMuxViewportContext | null,
    opts: WsSseMuxOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.handshakeTtlMs = opts.handshakeTtlMs ?? WS_HANDSHAKE_BUFFER_TTL_MS;
    this.sfsSessionTtlMs = opts.sfsSessionTtlMs ?? DEFAULT_SFS_SESSION_TTL_MS;
    this.outboundDedupWindowMs = opts.outboundDedupWindowMs ?? WS_OUTBOUND_DEDUP_WINDOW_MS;
    this.maxChannelsPerTab = opts.maxChannelsPerTab ?? WS_MAX_CHANNELS_PER_TAB;
    this.maxHandshakeFrames = opts.maxHandshakeFrames ?? WS_MAX_HANDSHAKE_FRAMES;
    this.maxFrameBytes = opts.maxFrameBytes ?? WS_MAX_FRAME_BYTES;
    this.maxTotalBufferBytes = opts.maxTotalBufferBytes ?? WS_MAX_TOTAL_BUFFER_BYTES;
    this.ipc = opts.ipc ?? ipcMain;
    this.onDedupIncrement = opts.onDedupIncrement;
    this.eventBus = opts.eventBus;
    this.shimScript = buildWsSseMuxShimScript();

    this.ipcListener = (ev, raw) => {
      this.handleIpcMessage(ev, raw);
    };
    this.ipc.on(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, this.ipcListener);
  }

  private getOrCreateWcState(wc: MuxWebContents): ViewportScriptState {
    const existing = this.wcStates.get(wc.id);
    if (existing && existing.wc === wc && !existing.disposed) {
      return existing;
    }
    if (existing) {
      this.cleanupWcState(wc.id);
    }

    const state: ViewportScriptState = {
      wc,
      desiredActive: false,
      scriptIdentifier: null,
      pageEnabled: false,
      detachEpoch: 0,
      syncChain: Promise.resolve(),
      participantUnsub: null,
      lifecycleCleanup: null,
      disposed: false,
    };

    state.participantUnsub = this.debuggerCoordinator.registerParticipant(wc, PARTICIPANT_ID, {
      onDetach: () => {
        // DevTools attach detaches wc.debugger without killing the page; clear ONLY CDP script state.
        state.detachEpoch += 1;
        state.scriptIdentifier = null;
        state.pageEnabled = false;
      },
      onReattach: () => {
        if (!this.disposed && !state.disposed && state.desiredActive && !state.wc.isDestroyed()) {
          return this.syncViewport(state.wc, true);
        }
        return undefined;
      },
    });

    const onDestroyed = () => {
      this.disposeWebContents(wc.id);
    };
    const onRenderProcessGone = () => {
      this.handleViewportTeardown(wc.id, 'render-process-gone');
    };
    const onDidStartNavigation = (
      details: unknown,
      _url?: unknown,
      isInPlace?: unknown,
      isMainFrame?: unknown,
    ) => {
      const det = details as { isSameDocument?: boolean; isMainFrame?: boolean } | undefined;
      const sameDoc =
        typeof det?.isSameDocument === 'boolean' ? det.isSameDocument : Boolean(isInPlace);
      const mainFrame =
        typeof det?.isMainFrame === 'boolean' ? det.isMainFrame : isMainFrame !== false;
      if (mainFrame && !sameDoc) {
        this.handleViewportTeardown(wc.id, 'navigation');
      }
    };

    if (typeof wc.on === 'function') {
      wc.on('destroyed', onDestroyed);
      wc.on('render-process-gone', onRenderProcessGone);
      wc.on('did-start-navigation', onDidStartNavigation);
      state.lifecycleCleanup = () => {
        const remove = wc.off?.bind(wc) ?? wc.removeListener?.bind(wc);
        if (remove) {
          remove('destroyed', onDestroyed);
          remove('render-process-gone', onRenderProcessGone);
          remove('did-start-navigation', onDidStartNavigation);
        }
      };
    }

    this.wcStates.set(wc.id, state);
    return state;
  }

  private cleanupWcState(wcId: number): void {
    const state = this.wcStates.get(wcId);
    if (!state) return;
    state.disposed = true;
    this.wcStates.delete(wcId);
    try {
      state.participantUnsub?.();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      state.lifecycleCleanup?.();
    } catch {
      // Ignore cleanup errors.
    }
    state.participantUnsub = null;
    state.lifecycleCleanup = null;
    state.scriptIdentifier = null;
    state.pageEnabled = false;
  }

  async syncViewport(wc: MuxWebContents | null, active: boolean): Promise<void> {
    if (this.disposed || !wc || wc.isDestroyed()) return;
    const state = this.getOrCreateWcState(wc);
    state.desiredActive = active;

    state.syncChain = state.syncChain
      .catch(() => {})
      .then(async () => {
        if (this.disposed || state.disposed || state.wc.isDestroyed()) return;

        if (state.desiredActive) {
          if (state.scriptIdentifier !== null) return;
          const attached = await this.debuggerCoordinator.ensureAttached(state.wc);
          if (!attached || this.disposed || state.disposed || state.wc.isDestroyed()) return;
          if (!state.desiredActive) return;

          try {
            const epochBeforeEnable = state.detachEpoch;
            if (!state.pageEnabled) {
              await this.debuggerCoordinator.sendCommand(state.wc, 'Page.enable');
              if (
                state.detachEpoch !== epochBeforeEnable ||
                !this.debuggerCoordinator.isAttached(state.wc) ||
                state.disposed ||
                state.wc.isDestroyed()
              ) {
                state.pageEnabled = false;
                state.scriptIdentifier = null;
                return;
              }
              state.pageEnabled = true;
            }
            if (!state.desiredActive || this.disposed || state.wc.isDestroyed()) return;

            const epochBeforeAdd = state.detachEpoch;
            const res = await this.debuggerCoordinator.sendCommand<{ identifier?: string }>(
              state.wc,
              'Page.addScriptToEvaluateOnNewDocument',
              { source: this.shimScript },
            );
            if (
              state.detachEpoch !== epochBeforeAdd ||
              !this.debuggerCoordinator.isAttached(state.wc) ||
              state.disposed ||
              state.wc.isDestroyed()
            ) {
              state.scriptIdentifier = null;
              state.pageEnabled = false;
              return;
            }
            const identifier = typeof res?.identifier === 'string' ? res.identifier : null;
            if (!identifier) return;

            if (!state.desiredActive) {
              if (this.debuggerCoordinator.isAttached(state.wc)) {
                try {
                  await this.debuggerCoordinator.sendCommand(
                    state.wc,
                    'Page.removeScriptToEvaluateOnNewDocument',
                    { identifier },
                  );
                } catch {
                  // Best-effort cleanup on concurrent toggle.
                }
              }
              return;
            }
            state.scriptIdentifier = identifier;
          } catch {
            if (!this.debuggerCoordinator.isAttached(state.wc)) {
              state.pageEnabled = false;
              state.scriptIdentifier = null;
            }
          }
          return;
        }

        this.teardownChannelsForInactiveViewport(state.wc.id, WS_OWNER_TEARDOWN_CLOSE_REASON);
        const identifier = state.scriptIdentifier;
        if (identifier === null) return;
        state.scriptIdentifier = null;
        if (!state.wc.isDestroyed() && this.debuggerCoordinator.isAttached(state.wc)) {
          try {
            await this.debuggerCoordinator.sendCommand(
              state.wc,
              'Page.removeScriptToEvaluateOnNewDocument',
              { identifier },
            );
          } catch {
            // Ignore detach/close races during script removal.
          }
        }
      });

    return state.syncChain;
  }

  getStats(): WsSseMuxStats {
    this.pruneExpiredBuffers(this.now());
    const installedWcIds: number[] = [];
    for (const [wcId, state] of this.wcStates) {
      if (state.scriptIdentifier !== null && !state.disposed && !state.wc.isDestroyed()) {
        installedWcIds.push(wcId);
      }
    }
    return {
      activeChannels: this.channelsById.size,
      totalBufferedBytes: this.totalBufferedBytes,
      installedWcIds,
    };
  }

  handleViewportTeardown(wcId: number, reason = WS_OWNER_TEARDOWN_CLOSE_REASON): void {
    const channelIds = this.channelsByWcId.get(wcId);
    if (!channelIds || channelIds.size === 0) return;

    const snapshot = Array.from(channelIds);
    for (const channelId of snapshot) {
      const channel = this.channelsById.get(channelId);
      if (!channel) continue;

      if (channel.owner.wcId === wcId) {
        this.teardownChannelAsOwnerDown(channel, reason);
      } else {
        this.detachFollowersByWcId(channel, wcId);
      }
    }
  }

  clearTab(tabId: string): void {
    const toClear: MuxChannel[] = [];
    for (const ch of this.channelsById.values()) {
      if (ch.tabId === tabId) {
        toClear.push(ch);
      }
    }
    for (const ch of toClear) {
      this.teardownChannelAsOwnerDown(ch, 'tab-cleared');
    }
  }

  disposeWebContents(wcId: number): void {
    this.handleViewportTeardown(wcId, 'webcontents-destroyed');
    this.cleanupWcState(wcId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const remove = this.ipc.off?.bind(this.ipc) ?? this.ipc.removeListener?.bind(this.ipc);
    if (remove) {
      remove(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, this.ipcListener);
    }

    for (const channel of Array.from(this.channelsById.values())) {
      this.destroyChannelState(channel);
    }
    this.channelsByKey.clear();
    this.channelsByClusterKey.clear();
    this.channelsById.clear();
    this.channelsByWcId.clear();
    this.socketLookup.clear();

    this.outboundDedup.length = 0;
    this.totalBufferedBytes = 0;

    for (const wcId of Array.from(this.wcStates.keys())) {
      this.cleanupWcState(wcId);
    }
  }

  private resolveAuthoritativeOrigin(ctx: WsMuxViewportContext): string | null {
    const frameOrigin = ctx.wc.mainFrame?.origin;
    if (typeof frameOrigin === 'string' && frameOrigin.length > 0) {
      return isValidHttpOrigin(frameOrigin) ? frameOrigin : null;
    }
    const fallbackOrigin = ctx.getOrigin(ctx.wc);
    return isValidHttpOrigin(fallbackOrigin) ? fallbackOrigin : null;
  }

  private safeSendToRenderer(wc: MuxWebContents, msg: MainToMuxMessage): void {
    if (this.disposed || wc.isDestroyed()) return;
    try {
      wc.send(WS_SSE_MUX_IPC_CHANNELS.TO_RENDERER, msg);
    } catch {
      // Ignore send errors if WebContents closed mid-dispatch.
    }
  }

  private trackWcChannel(wcId: number, channelId: string): void {
    let set = this.channelsByWcId.get(wcId);
    if (!set) {
      set = new Set();
      this.channelsByWcId.set(wcId, set);
    }
    set.add(channelId);
  }

  private untrackWcChannelIfUnused(channel: MuxChannel, wcId: number): void {
    if (channel.owner.wcId === wcId) return;
    for (const f of channel.followers.values()) {
      if (f.wcId === wcId) return;
    }
    const set = this.channelsByWcId.get(wcId);
    if (set) {
      set.delete(channel.channelId);
      if (set.size === 0) {
        this.channelsByWcId.delete(wcId);
      }
    }
  }

  private countChannelsForTab(tabId: string): number {
    let count = 0;
    for (const ch of this.channelsById.values()) {
      if (ch.tabId === tabId) count += 1;
    }
    return count;
  }

  private expireChannelHandshakeBuffer(channelId: string): void {
    const channel = this.channelsById.get(channelId);
    if (!channel) return;
    if (channel.handshakeTimer) {
      clearTimeout(channel.handshakeTimer);
      channel.handshakeTimer = null;
    }
    this.releaseChannelHandshakeBuffer(channel);
  }

  private releaseChannelHandshakeBuffer(channel: MuxChannel): void {
    if (channel.handshakeBuffer.length === 0) return;
    for (const frame of channel.handshakeBuffer) {
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - frame.byteLength);
    }
    channel.handshakeBuffer.length = 0;
  }

  private releaseChannelSfsSession(channel: MuxChannel): void {
    if (channel.sfsHandshakeResp) {
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - channel.sfsHandshakeResp.byteLength);
      channel.sfsHandshakeResp = null;
    }
    if (channel.sfsLoginResp) {
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - channel.sfsLoginResp.byteLength);
      channel.sfsLoginResp = null;
    }
    if (channel.sfsInitFrame) {
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - channel.sfsInitFrame.byteLength);
      channel.sfsInitFrame = null;
    }
    if (channel.sfsRecentFrames.length > 0) {
      for (const frame of channel.sfsRecentFrames) {
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - frame.byteLength);
      }
      channel.sfsRecentFrames.length = 0;
    }
  }

  private markChannelAsSfs(channel: MuxChannel): void {
    if (!channel.isSfsChannel) {
      channel.isSfsChannel = true;
    }
    for (const follower of channel.followers.values()) {
      if (follower.sfsFollowerState === undefined || follower.sfsFollowerState === 'passthrough') {
        follower.sfsFollowerState = 'wait_hs_req';
      }
    }
  }

  private storeChannelSfsFrame(
    channel: MuxChannel,
    slot: 'handshake' | 'login' | 'init' | 'recent',
    frame: HandshakeFrame,
    now: number,
  ): void {
    channel.sfsSessionUpdatedAt = now;
    if (slot === 'handshake') {
      const prevBytes = channel.sfsHandshakeResp?.byteLength ?? 0;
      if (this.totalBufferedBytes - prevBytes + frame.byteLength > this.maxTotalBufferBytes) return;
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - prevBytes) + frame.byteLength;
      channel.sfsHandshakeResp = frame;
      return;
    }
    if (slot === 'login') {
      const prevBytes = channel.sfsLoginResp?.byteLength ?? 0;
      if (this.totalBufferedBytes - prevBytes + frame.byteLength > this.maxTotalBufferBytes) return;
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - prevBytes) + frame.byteLength;
      channel.sfsLoginResp = frame;
      return;
    }
    if (slot === 'init') {
      const prevBytes = channel.sfsInitFrame?.byteLength ?? 0;
      if (this.totalBufferedBytes - prevBytes + frame.byteLength > this.maxTotalBufferBytes) return;
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - prevBytes) + frame.byteLength;
      channel.sfsInitFrame = frame;
      return;
    }
    let evictedBytes = 0;
    const willEvict = channel.sfsRecentFrames.length >= MAX_SFS_RECENT_INIT_FRAMES;
    if (willEvict) {
      evictedBytes = channel.sfsRecentFrames[0]?.byteLength ?? 0;
    }
    if (this.totalBufferedBytes - evictedBytes + frame.byteLength > this.maxTotalBufferBytes) return;
    if (willEvict) {
      channel.sfsRecentFrames.shift();
      this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - evictedBytes);
    }
    channel.sfsRecentFrames.push(frame);
    this.totalBufferedBytes += frame.byteLength;
  }

  private pruneExpiredBuffers(now: number): void {
    for (let i = this.outboundDedup.length - 1; i >= 0; i -= 1) {
      const entry = this.outboundDedup[i];
      if (!entry || now - entry.ts > this.outboundDedupWindowMs) {
        if (entry) {
          this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - entry.byteLength);
        }
        this.outboundDedup.splice(i, 1);
      }
    }
    for (const channel of this.channelsById.values()) {
      if (
        channel.handshakeBuffer.length > 0 &&
        now - channel.createdAt > this.handshakeTtlMs
      ) {
        this.expireChannelHandshakeBuffer(channel.channelId);
      }
      if (
        channel.isSfsChannel &&
        now - channel.sfsSessionUpdatedAt > this.sfsSessionTtlMs
      ) {
        this.releaseChannelSfsSession(channel);
      }
    }
  }

  private destroyChannelState(channel: MuxChannel): void {
    if (channel.handshakeTimer) {
      clearTimeout(channel.handshakeTimer);
      channel.handshakeTimer = null;
    }
    this.releaseChannelHandshakeBuffer(channel);
    this.releaseChannelSfsSession(channel);

    for (let i = this.outboundDedup.length - 1; i >= 0; i -= 1) {
      const entry = this.outboundDedup[i];
      if (entry && entry.channelId === channel.channelId) {
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - entry.byteLength);
        this.outboundDedup.splice(i, 1);
      }
    }

    this.channelsByKey.delete(channel.channelKey);
    if (channel.clusterKey !== null) {
      const cSet = this.channelsByClusterKey.get(channel.clusterKey);
      if (cSet) {
        cSet.delete(channel.channelId);
        if (cSet.size === 0) {
          this.channelsByClusterKey.delete(channel.clusterKey);
        }
      }
    }
    this.channelsById.delete(channel.channelId);

    this.socketLookup.delete(makeSocketKey(channel.owner.wcId, channel.owner.clientSocketId));
    const ownerSet = this.channelsByWcId.get(channel.owner.wcId);
    if (ownerSet) {
      ownerSet.delete(channel.channelId);
      if (ownerSet.size === 0) this.channelsByWcId.delete(channel.owner.wcId);
    }

    for (const [sockKey, follower] of channel.followers) {
      this.socketLookup.delete(sockKey);
      const fSet = this.channelsByWcId.get(follower.wcId);
      if (fSet) {
        fSet.delete(channel.channelId);
        if (fSet.size === 0) this.channelsByWcId.delete(follower.wcId);
      }
    }
    channel.followers.clear();
  }

  private detachFollowersByWcId(channel: MuxChannel, wcId: number): void {
    for (const [sockKey, follower] of Array.from(channel.followers.entries())) {
      if (follower.wcId === wcId) {
        channel.followers.delete(sockKey);
        this.socketLookup.delete(sockKey);
      }
    }
    this.untrackWcChannelIfUnused(channel, wcId);
  }

  private getEligibleFollowerCtx(channel: MuxChannel, wcId: number): WsMuxViewportContext | null {
    const ctx = this.resolveViewportContext(wcId);
    if (!ctx || !ctx.active || ctx.wc.isDestroyed()) return null;
    if (ctx.tabId !== channel.tabId) return null;
    const origin = this.resolveAuthoritativeOrigin(ctx);
    if (!origin || origin !== channel.initiatorOrigin) return null;
    return ctx;
  }

  private teardownChannelsForInactiveViewport(wcId: number, reason: string): void {
    const channelIds = this.channelsByWcId.get(wcId);
    if (!channelIds || channelIds.size === 0) return;

    const snapshot = Array.from(channelIds);
    for (const channelId of snapshot) {
      const channel = this.channelsById.get(channelId);
      if (!channel) continue;
      this.teardownChannelAsInactive(channel, reason);
    }
  }

  private teardownChannelAsInactive(channel: MuxChannel, reason: string): void {
    const owner = channel.owner;
    const surviving = Array.from(channel.followers.values());
    this.destroyChannelState(channel);

    const notifyEndpoint = (ep: EndpointRef) => {
      const ctx = this.resolveViewportContext(ep.wcId);
      if (!ctx || ctx.wc.isDestroyed() || ctx.tabId !== channel.tabId) return;
      if (channel.kind === 'ws') {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-ws-close',
          clientSocketId: ep.clientSocketId,
          code: WS_OWNER_TEARDOWN_CLOSE_CODE,
          reason,
          wasClean: true,
        });
      } else {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-sse-error',
          clientSocketId: ep.clientSocketId,
          fatal: false,
          ownerTeardown: true,
        });
      }
    };

    notifyEndpoint(owner);
    for (const follower of surviving) {
      notifyEndpoint(follower);
    }
  }

  private teardownChannelAsOwnerDown(channel: MuxChannel, reason: string): void {
    const surviving = Array.from(channel.followers.values());
    this.destroyChannelState(channel);

    for (const follower of surviving) {
      const ctx = this.resolveViewportContext(follower.wcId);
      if (!ctx || ctx.wc.isDestroyed() || ctx.tabId !== channel.tabId) continue;
      if (channel.kind === 'ws') {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-ws-close',
          clientSocketId: follower.clientSocketId,
          code: WS_OWNER_TEARDOWN_CLOSE_CODE,
          reason,
          wasClean: true,
        });
      } else {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-sse-error',
          clientSocketId: follower.clientSocketId,
          fatal: false,
          ownerTeardown: true,
        });
      }
    }
  }

  private flushHandshakeBufferToFollower(
    channel: MuxChannel,
    followerWc: MuxWebContents,
    clientSocketId: string,
    now: number,
  ): void {
    if (now - channel.createdAt > this.handshakeTtlMs) {
      this.expireChannelHandshakeBuffer(channel.channelId);
      return;
    }
    for (const frame of channel.handshakeBuffer) {
      if (now - frame.ts > this.handshakeTtlMs) continue;
      if (frame.kind === 'ws') {
        this.safeSendToRenderer(followerWc, {
          type: 'mux-ws-frame',
          clientSocketId,
          isBinary: Boolean(frame.isBinary),
          data: frame.data,
        });
      } else {
        this.safeSendToRenderer(followerWc, {
          type: 'mux-sse-event',
          clientSocketId,
          eventType: frame.eventType ?? 'message',
          data: typeof frame.data === 'string' ? frame.data : '',
          lastEventId: frame.lastEventId ?? '',
        });
      }
    }
  }

  private handleIpcMessage(ev: IpcMainEvent, raw: unknown): void {
    if (this.disposed) return;
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Partial<MuxToMainMessage>;
    if (typeof msg.type !== 'string' || typeof msg.clientSocketId !== 'string' || !msg.clientSocketId) {
      return;
    }

    const senderWcId = ev.sender?.id;
    if (typeof senderWcId !== 'number') return;

    const ctx = this.resolveViewportContext(senderWcId);
    if (!ctx || ctx.wc.isDestroyed()) return;

    // Security gate: strictly mainFrame + valid non-opaque http/https origin.
    const mainFrame = ctx.wc.mainFrame;
    if (!ev.senderFrame || !mainFrame || ev.senderFrame !== mainFrame) {
      return;
    }
    const initiatorOrigin = ev.senderFrame.origin;
    if (!isValidHttpOrigin(initiatorOrigin)) {
      return;
    }

    switch (msg.type) {
      case 'ws-open':
        this.handleOpen(ctx, initiatorOrigin, 'ws', msg.clientSocketId, msg.url, msg.protocols);
        break;
      case 'sse-open':
        this.handleOpen(
          ctx,
          initiatorOrigin,
          'sse',
          msg.clientSocketId,
          msg.url,
          undefined,
          msg.withCredentials,
        );
        break;
      case 'upstream-ws-open':
        this.handleUpstreamWsOpen(ctx, initiatorOrigin, msg.clientSocketId, msg.protocol, msg.extensions);
        break;
      case 'upstream-sse-open':
        this.handleUpstreamSseOpen(ctx, initiatorOrigin, msg.clientSocketId);
        break;
      case 'ws-send':
        this.handleWsSend(ctx, initiatorOrigin, msg.clientSocketId, msg.isBinary, msg.data);
        break;
      case 'upstream-ws-frame':
        this.handleUpstreamWsFrame(ctx, initiatorOrigin, msg.clientSocketId, msg.isBinary, msg.data);
        break;
      case 'upstream-sse-event':
        this.handleUpstreamSseEvent(
          ctx,
          initiatorOrigin,
          msg.clientSocketId,
          msg.eventType,
          msg.data,
          msg.lastEventId,
        );
        break;
      case 'ws-close':
        this.handleClientWsClose(ctx, initiatorOrigin, msg.clientSocketId);
        break;
      case 'sse-close':
        this.handleClientSseClose(ctx, initiatorOrigin, msg.clientSocketId);
        break;
      case 'upstream-ws-close':
        this.handleUpstreamWsClose(ctx, initiatorOrigin, msg.clientSocketId, msg.code, msg.reason, msg.wasClean);
        break;
      case 'upstream-ws-error':
        this.handleUpstreamWsError(ctx, initiatorOrigin, msg.clientSocketId);
        break;
      case 'upstream-sse-error':
        this.handleUpstreamSseError(ctx, initiatorOrigin, msg.clientSocketId, msg.fatal, msg.retryMs);
        break;
      case 'upstream-sse-bypass':
        this.handleUpstreamSseBypass(ctx, initiatorOrigin, msg.clientSocketId);
        break;
      case 'ss-hello':
        this.handleSessionStorageHello(ctx, initiatorOrigin);
        break;
      case 'ss-mut':
        this.handleSessionStorageMut(ctx, initiatorOrigin, msg.op, msg.key, msg.value);
        break;
      default:
        break;
    }
  }

  private handleSessionStorageHello(ctx: WsMuxViewportContext, initiatorOrigin: string): void {
    if (!ctx.active || !this.eventBus) return;
    const ctxOrigin = ctx.getOrigin(ctx.wc);
    if (ctxOrigin !== null && ctxOrigin !== initiatorOrigin) return;
    const entries = this.eventBus.sessionStorageSnapshot(ctx.tabId, initiatorOrigin);
    if (Object.keys(entries).length === 0) return;
    this.safeSendToRenderer(ctx.wc, {
      type: 'mux-ss-sync',
      clientSocketId: '__ss__',
      op: 'hydrate',
      entries,
    });
  }

  private handleSessionStorageMut(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    op: unknown,
    rawKey: unknown,
    rawValue: unknown,
  ): void {
    if (!ctx.active || !this.eventBus) return;
    const ctxOrigin = ctx.getOrigin(ctx.wc);
    if (ctxOrigin !== null && ctxOrigin !== initiatorOrigin) return;

    const now = this.now();
    let changed = false;
    let forwardMsg: MainToMuxMessage | null = null;

    if (op === 'set' && typeof rawKey === 'string' && typeof rawValue === 'string') {
      const res = this.eventBus.sessionStorageSet(
        ctx.tabId,
        initiatorOrigin,
        ctx.role,
        rawKey,
        rawValue,
        now,
      );
      if (res.ok && res.changed) {
        changed = true;
        forwardMsg = {
          type: 'mux-ss-sync',
          clientSocketId: '__ss__',
          op: 'set',
          key: rawKey,
          value: rawValue,
        };
      }
    } else if (op === 'remove' && typeof rawKey === 'string') {
      const res = this.eventBus.sessionStorageRemove(
        ctx.tabId,
        initiatorOrigin,
        ctx.role,
        rawKey,
        now,
      );
      if (res.ok && res.changed) {
        changed = true;
        forwardMsg = {
          type: 'mux-ss-sync',
          clientSocketId: '__ss__',
          op: 'remove',
          key: rawKey,
        };
      }
    } else if (op === 'clear') {
      const res = this.eventBus.sessionStorageClear(ctx.tabId, initiatorOrigin, ctx.role, now);
      if (res.ok && res.changed) {
        changed = true;
        forwardMsg = {
          type: 'mux-ss-sync',
          clientSocketId: '__ss__',
          op: 'clear',
        };
      }
    }

    if (!changed || !forwardMsg || !ctx.pairedWc || ctx.pairedWc.isDestroyed()) {
      return;
    }
    const pairedCtx = this.resolveViewportContext(ctx.pairedWc.id);
    if (!pairedCtx || !pairedCtx.active || pairedCtx.tabId !== ctx.tabId) return;
    const pairedOrigin = this.resolveAuthoritativeOrigin(pairedCtx);
    if (!pairedOrigin || pairedOrigin !== initiatorOrigin) return;
    this.safeSendToRenderer(ctx.pairedWc, forwardMsg);
  }

  private handleOpen(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    kind: MuxChannelKind,
    clientSocketId: string,
    rawUrl: unknown,
    rawProtocols?: unknown,
    rawWithCredentials?: unknown,
  ): void {
    const bypass = () => {
      this.safeSendToRenderer(ctx.wc, {
        type: 'mux-grant',
        clientSocketId,
        kind,
        role: 'bypass',
      });
    };

    if (!ctx.active || typeof rawUrl !== 'string') {
      bypass();
      return;
    }

    const ctxOrigin = ctx.getOrigin(ctx.wc);
    if (ctxOrigin !== null && ctxOrigin !== initiatorOrigin) {
      bypass();
      return;
    }

    const normalizedUrl = normalizeMuxUrl(rawUrl, kind, initiatorOrigin);
    if (!normalizedUrl) {
      bypass();
      return;
    }

    const protocols = kind === 'ws' ? normalizeWsProtocols(rawProtocols as string | string[] | undefined) : [];
    const withCredentials = kind === 'sse' ? Boolean(rawWithCredentials) : false;

    const channelKey = buildMuxChannelKey({
      tabId: ctx.tabId,
      initiatorOrigin,
      kind,
      normalizedUrl,
      protocols,
      withCredentials,
    });
    if (!channelKey) {
      bypass();
      return;
    }

    const sockKey = makeSocketKey(ctx.wc.id, clientSocketId);
    const staleLookup = this.socketLookup.get(sockKey);
    if (staleLookup) {
      const staleCh = this.channelsById.get(staleLookup.channelId);
      if (staleCh) {
        if (staleLookup.role === 'follower') {
          staleCh.followers.delete(sockKey);
          this.socketLookup.delete(sockKey);
          this.untrackWcChannelIfUnused(staleCh, ctx.wc.id);
        } else {
          this.teardownChannelAsOwnerDown(staleCh, 'stale-socket-reopen');
        }
      } else {
        this.socketLookup.delete(sockKey);
      }
    }

    const now = this.now();
    this.pruneExpiredBuffers(now);

    const clusterKey =
      kind === 'ws'
        ? buildClusterSiblingChannelKey({
            tabId: ctx.tabId,
            initiatorOrigin,
            normalizedUrl,
            protocols,
          })
        : null;

    let existing = this.channelsByKey.get(channelKey);
    const sameWcAlreadyAttached =
      existing !== undefined &&
      (existing.owner.wcId === ctx.wc.id ||
        Array.from(existing.followers.values()).some((f) => f.wcId === ctx.wc.id));
    if (existing && sameWcAlreadyAttached) {
      // Extra concurrent socket to the same URL from the same viewport bypasses mux so closing one never kills the other.
      bypass();
      return;
    }

    // If no exact URL channel matched, check if the paired viewport already has an OPEN sibling cluster shard.
    if (!existing && clusterKey !== null) {
      const siblingIds = this.channelsByClusterKey.get(clusterKey);
      if (siblingIds) {
        for (const sibId of siblingIds) {
          const sib = this.channelsById.get(sibId);
          if (!sib || sib.kind !== 'ws' || sib.state !== 'open') continue;
          const sibHasSameWc =
            sib.owner.wcId === ctx.wc.id ||
            Array.from(sib.followers.values()).some((f) => f.wcId === ctx.wc.id);
          if (!sibHasSameWc) {
            existing = sib;
            break;
          }
        }
      }
    }

    if (existing) {
      const waitForSfsHandshake = kind === 'ws' && existing.isSfsChannel;
      const ref: EndpointRef = {
        wcId: ctx.wc.id,
        clientSocketId,
        handshakeFlushed: false,
        sfsFollowerState: waitForSfsHandshake ? 'wait_hs_req' : 'passthrough',
      };
      existing.followers.set(sockKey, ref);
      this.socketLookup.set(sockKey, {
        channelId: existing.channelId,
        wcId: ctx.wc.id,
        clientSocketId,
        role: 'follower',
      });
      this.trackWcChannel(ctx.wc.id, existing.channelId);
      this.onDedupIncrement?.(ctx.wc.id, 1);
      this.eventBus?.publish({
        tabId: ctx.tabId,
        viewport: ctx.role,
        domain: 'ws_mux',
        kind: 'follower_attached',
        summary: `attached ${kind} follower (${existing.normalizedUrl})`,
        tsMs: now,
      });

      if (existing.state === 'open') {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-grant',
          clientSocketId,
          kind,
          role: 'follower',
          alreadyOpen: true,
          ...(kind === 'ws'
            ? {
                protocol: existing.negotiatedProtocol,
                extensions: existing.negotiatedExtensions,
              }
            : {}),
        });
        ref.handshakeFlushed = true;
        if (!waitForSfsHandshake) {
          this.flushHandshakeBufferToFollower(existing, ctx.wc, clientSocketId, now);
        }
      } else {
        this.safeSendToRenderer(ctx.wc, {
          type: 'mux-grant',
          clientSocketId,
          kind,
          role: 'follower',
          alreadyOpen: false,
        });
      }
      return;
    }

    if (this.countChannelsForTab(ctx.tabId) >= this.maxChannelsPerTab) {
      this.safeSendToRenderer(ctx.wc, {
        type: 'mux-grant',
        clientSocketId,
        kind,
        role: 'reject',
        code: WS_REJECT_CAP_CLOSE_CODE,
        reason: WS_REJECT_CAP_CLOSE_REASON,
      });
      return;
    }

    const channelId = `ch-${this.nextChannelSeq++}`;
    const timer = setTimeout(() => {
      this.expireChannelHandshakeBuffer(channelId);
    }, this.handshakeTtlMs);
    timer.unref?.();

    const channel: MuxChannel = {
      channelId,
      tabId: ctx.tabId,
      initiatorOrigin,
      kind,
      normalizedUrl,
      channelKey,
      clusterKey,
      protocols,
      negotiatedProtocol: '',
      negotiatedExtensions: '',
      withCredentials,
      owner: { wcId: ctx.wc.id, clientSocketId, handshakeFlushed: false },
      followers: new Map(),
      state: 'connecting',
      createdAt: now,
      handshakeBuffer: [],
      handshakeTimer: timer,
      ownerClosingByClient: false,
      isSfsChannel: false,
      sfsSessionUpdatedAt: now,
      sfsHandshakeResp: null,
      sfsLoginResp: null,
      sfsInitFrame: null,
      sfsRecentFrames: [],
    };

    this.channelsByKey.set(channelKey, channel);
    if (clusterKey !== null) {
      let cSet = this.channelsByClusterKey.get(clusterKey);
      if (!cSet) {
        cSet = new Set();
        this.channelsByClusterKey.set(clusterKey, cSet);
      }
      cSet.add(channelId);
    }
    this.channelsById.set(channelId, channel);
    this.socketLookup.set(sockKey, {
      channelId,
      wcId: ctx.wc.id,
      clientSocketId,
      role: 'owner',
    });
    this.trackWcChannel(ctx.wc.id, channelId);

    this.safeSendToRenderer(ctx.wc, {
      type: 'mux-grant',
      clientSocketId,
      kind,
      role: 'owner',
    });
  }

  private getOwnedChannel(
    wcId: number,
    clientSocketId: string,
    kind?: MuxChannelKind,
  ): MuxChannel | null {
    const lookup = this.socketLookup.get(makeSocketKey(wcId, clientSocketId));
    if (!lookup || lookup.role !== 'owner') return null;
    const channel = this.channelsById.get(lookup.channelId);
    if (!channel || (kind && channel.kind !== kind)) return null;
    return channel;
  }

  private handleUpstreamWsOpen(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    protocol: unknown,
    extensions: unknown,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'ws');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    channel.state = 'open';
    channel.negotiatedProtocol = typeof protocol === 'string' ? protocol : '';
    channel.negotiatedExtensions = typeof extensions === 'string' ? extensions : '';

    const now = this.now();

    // If a paired viewport is still stuck in `connecting` on a sibling cluster shard (e.g. dead/504 node),
    // promote that slow owner onto this live open channel transparently.
    if (channel.clusterKey !== null) {
      const siblingIds = Array.from(this.channelsByClusterKey.get(channel.clusterKey) ?? []);
      for (const sibId of siblingIds) {
        if (sibId === channel.channelId) continue;
        const sib = this.channelsById.get(sibId);
        if (!sib || sib.kind !== 'ws' || sib.state !== 'connecting') continue;
        if (sib.owner.wcId === channel.owner.wcId) continue;
        const alreadyHasSibOwner = Array.from(channel.followers.values()).some(
          (f) => f.wcId === sib.owner.wcId,
        );
        if (alreadyHasSibOwner) continue;

        const promotedOwner = sib.owner;
        const migratedFollowers = Array.from(sib.followers.values());
        this.destroyChannelState(sib);

        const pCtx = this.getEligibleFollowerCtx(channel, promotedOwner.wcId);
        if (pCtx) {
          const pKey = makeSocketKey(promotedOwner.wcId, promotedOwner.clientSocketId);
          const waitHs = channel.isSfsChannel;
          const pRef: EndpointRef = {
            wcId: promotedOwner.wcId,
            clientSocketId: promotedOwner.clientSocketId,
            handshakeFlushed: true,
            sfsFollowerState: waitHs ? 'wait_hs_req' : 'passthrough',
          };
          channel.followers.set(pKey, pRef);
          this.socketLookup.set(pKey, {
            channelId: channel.channelId,
            wcId: promotedOwner.wcId,
            clientSocketId: promotedOwner.clientSocketId,
            role: 'follower',
          });
          this.trackWcChannel(promotedOwner.wcId, channel.channelId);
          this.onDedupIncrement?.(promotedOwner.wcId, 1);
          this.eventBus?.publish({
            tabId: channel.tabId,
            viewport: pCtx.role,
            domain: 'ws_mux',
            kind: 'cluster_promoted',
            summary: `promoted sibling cluster shard to follower (${channel.normalizedUrl})`,
            tsMs: now,
          });
          this.safeSendToRenderer(pCtx.wc, {
            type: 'mux-promote-to-follower',
            clientSocketId: promotedOwner.clientSocketId,
            alreadyOpen: true,
            protocol: channel.negotiatedProtocol,
            extensions: channel.negotiatedExtensions,
          });
          if (!waitHs) {
            this.flushHandshakeBufferToFollower(channel, pCtx.wc, promotedOwner.clientSocketId, now);
          }
        }

        for (const mf of migratedFollowers) {
          if (
            mf.wcId === channel.owner.wcId ||
            Array.from(channel.followers.values()).some((f) => f.wcId === mf.wcId)
          ) {
            continue;
          }
          const mfKey = makeSocketKey(mf.wcId, mf.clientSocketId);
          const mfRef: EndpointRef = {
            wcId: mf.wcId,
            clientSocketId: mf.clientSocketId,
            handshakeFlushed: false,
            sfsFollowerState: 'passthrough',
          };
          channel.followers.set(mfKey, mfRef);
          this.socketLookup.set(mfKey, {
            channelId: channel.channelId,
            wcId: mf.wcId,
            clientSocketId: mf.clientSocketId,
            role: 'follower',
          });
          this.trackWcChannel(mf.wcId, channel.channelId);
        }
      }
    }

    for (const follower of channel.followers.values()) {
      if (follower.handshakeFlushed) continue;
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-ws-open',
        clientSocketId: follower.clientSocketId,
        protocol: channel.negotiatedProtocol,
        extensions: channel.negotiatedExtensions,
      });
      follower.handshakeFlushed = true;
      this.flushHandshakeBufferToFollower(channel, fCtx.wc, follower.clientSocketId, now);
    }
  }

  private handleUpstreamSseOpen(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'sse');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    channel.state = 'open';
    const now = this.now();
    for (const follower of channel.followers.values()) {
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-sse-open',
        clientSocketId: follower.clientSocketId,
      });
      if (!follower.handshakeFlushed) {
        follower.handshakeFlushed = true;
        this.flushHandshakeBufferToFollower(channel, fCtx.wc, follower.clientSocketId, now);
      }
    }
  }

  private handleWsSend(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    isBinary: unknown,
    rawData: unknown,
  ): void {
    const sockKey = makeSocketKey(ctx.wc.id, clientSocketId);
    const lookup = this.socketLookup.get(sockKey);
    if (!lookup) return;
    const channel = this.channelsById.get(lookup.channelId);
    if (!channel || channel.kind !== 'ws' || channel.initiatorOrigin !== initiatorOrigin) return;
    if (!ctx.active && ctx.wc.id !== channel.owner.wcId) return;

    const binaryFlag = Boolean(isBinary);
    let normalizedPayload: string | Uint8Array;
    if (binaryFlag) {
      const u8 = toUint8Array(rawData);
      if (!u8) return;
      normalizedPayload = u8;
    } else if (typeof rawData === 'string') {
      normalizedPayload = rawData;
    } else {
      return;
    }

    const byteLength = byteSizeOfData(normalizedPayload);
    if (byteLength > this.maxFrameBytes) {
      return;
    }

    const now = this.now();
    this.pruneExpiredBuffers(now);

    const parsedSfs =
      binaryFlag && normalizedPayload instanceof Uint8Array
        ? parseSfsBinaryPacket(normalizedPayload, this.maxFrameBytes)
        : null;

    if (parsedSfs) {
      this.markChannelAsSfs(channel);
      channel.sfsSessionUpdatedAt = now;

      // SFS2X System Handshake (c=0, a=0) and Login (c=0, a=1) are strictly once-per-socket:
      // only the channel owner sends them upstream; followers synchronize against the owner's session.
      if (parsedSfs.controller === 0 && parsedSfs.action === 0) {
        if (lookup.role === 'follower') {
          this.onDedupIncrement?.(ctx.wc.id, 1);
          this.eventBus?.publish({
            tabId: ctx.tabId,
            viewport: ctx.role,
            domain: 'ws_mux',
            kind: 'sfs_handshake_dedup',
            summary: `deduplicated SFS2X handshake (${channel.normalizedUrl})`,
            tsMs: now,
          });
          const fRef = channel.followers.get(sockKey);
          if (fRef) {
            fRef.sfsFollowerState = 'wait_login_req';
          }
          if (channel.sfsHandshakeResp) {
            this.safeSendToRenderer(ctx.wc, {
              type: 'mux-ws-frame',
              clientSocketId,
              isBinary: Boolean(channel.sfsHandshakeResp.isBinary),
              data: channel.sfsHandshakeResp.data,
            });
          }
          return;
        }
      } else if (parsedSfs.controller === 0 && parsedSfs.action === 1) {
        if (lookup.role === 'follower') {
          this.onDedupIncrement?.(ctx.wc.id, 1);
          this.eventBus?.publish({
            tabId: ctx.tabId,
            viewport: ctx.role,
            domain: 'ws_mux',
            kind: 'sfs_login_dedup',
            summary: `deduplicated SFS2X login (${channel.normalizedUrl})`,
            tsMs: now,
          });
          const fRef = channel.followers.get(sockKey);
          if (fRef) {
            fRef.sfsFollowerState = 'ready';
          }
          if (channel.sfsLoginResp) {
            this.safeSendToRenderer(ctx.wc, {
              type: 'mux-ws-frame',
              clientSocketId,
              isBinary: Boolean(channel.sfsLoginResp.isBinary),
              data: channel.sfsLoginResp.data,
            });
            if (channel.sfsInitFrame) {
              this.safeSendToRenderer(ctx.wc, {
                type: 'mux-ws-frame',
                clientSocketId,
                isBinary: Boolean(channel.sfsInitFrame.isBinary),
                data: channel.sfsInitFrame.data,
              });
            }
            for (const rf of channel.sfsRecentFrames) {
              this.safeSendToRenderer(ctx.wc, {
                type: 'mux-ws-frame',
                clientSocketId,
                isBinary: Boolean(rf.isBinary),
                data: rf.data,
              });
            }
          }
          return;
        }
      }
    }

    const canonical = parsedSfs
      ? `sfs:${parsedSfs.canonicalJson}`
      : canonicalizeWsOutboundPayload(normalizedPayload);
    if (canonical === null) {
      return;
    }

    const payloadHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

    // Symmetric cross-viewport consume-once match within 1500ms window.
    for (let i = 0; i < this.outboundDedup.length; i += 1) {
      const entry = this.outboundDedup[i];
      if (
        entry &&
        entry.channelId === channel.channelId &&
        entry.key === payloadHash &&
        entry.senderWcId !== ctx.wc.id &&
        now - entry.ts <= this.outboundDedupWindowMs
      ) {
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - entry.byteLength);
        this.outboundDedup.splice(i, 1);
        this.onDedupIncrement?.(ctx.wc.id, 1);
        this.eventBus?.publish({
          tabId: ctx.tabId,
          viewport: ctx.role,
          domain: 'ws_mux',
          kind: 'outbound_dedup',
          summary: `deduplicated outbound WS frame (${channel.normalizedUrl}, ${byteLength}B)`,
          tsMs: now,
        });
        return;
      }
    }

    if (this.totalBufferedBytes + DEDUP_ENTRY_OVERHEAD_BYTES <= this.maxTotalBufferBytes) {
      this.outboundDedup.push({
        key: payloadHash,
        channelId: channel.channelId,
        senderWcId: ctx.wc.id,
        ts: now,
        byteLength: DEDUP_ENTRY_OVERHEAD_BYTES,
      });
      this.totalBufferedBytes += DEDUP_ENTRY_OVERHEAD_BYTES;
    }

    const ownerCtx = this.resolveViewportContext(channel.owner.wcId);
    if (!ownerCtx || ownerCtx.wc.isDestroyed()) return;
    if (!ownerCtx.active && ctx.wc.id !== channel.owner.wcId) return;
    const ownerOrigin = this.resolveAuthoritativeOrigin(ownerCtx);
    if (!ownerOrigin || ownerOrigin !== channel.initiatorOrigin) return;

    this.safeSendToRenderer(ownerCtx.wc, {
      type: 'mux-ws-send-upstream',
      clientSocketId: channel.owner.clientSocketId,
      isBinary: binaryFlag,
      data: normalizedPayload,
    });
  }

  private bufferHandshakeFrame(channel: MuxChannel, frame: HandshakeFrame, now: number): void {
    this.pruneExpiredBuffers(now);
    if (now - channel.createdAt > this.handshakeTtlMs) return;
    if (channel.handshakeBuffer.length >= this.maxHandshakeFrames) return;
    if (this.totalBufferedBytes + frame.byteLength > this.maxTotalBufferBytes) return;

    channel.handshakeBuffer.push(frame);
    this.totalBufferedBytes += frame.byteLength;
  }

  private handleUpstreamWsFrame(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    isBinary: unknown,
    rawData: unknown,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'ws');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    const binaryFlag = Boolean(isBinary);
    let payload: string | Uint8Array;
    if (binaryFlag) {
      const u8 = toUint8Array(rawData);
      if (!u8) return;
      payload = u8;
    } else if (typeof rawData === 'string') {
      payload = rawData;
    } else {
      return;
    }

    const byteLength = byteSizeOfData(payload);
    if (byteLength > this.maxFrameBytes) {
      return;
    }

    const now = this.now();
    const hsFrame: HandshakeFrame = {
      kind: 'ws',
      isBinary: binaryFlag,
      data: payload,
      byteLength,
      ts: now,
    };

    const parsedSfs =
      binaryFlag && payload instanceof Uint8Array
        ? parseSfsBinaryPacket(payload, this.maxFrameBytes)
        : null;

    if (parsedSfs) {
      this.markChannelAsSfs(channel);
      if (parsedSfs.controller === 0 && parsedSfs.action === 0) {
        this.storeChannelSfsFrame(channel, 'handshake', hsFrame, now);
      } else if (parsedSfs.controller === 0 && parsedSfs.action === 1 && !parsedSfs.hasErrorCode) {
        this.storeChannelSfsFrame(channel, 'login', hsFrame, now);
      } else if (
        parsedSfs.controller === 1 &&
        parsedSfs.action === 13 &&
        parsedSfs.cmd === 'init'
      ) {
        this.storeChannelSfsFrame(channel, 'init', hsFrame, now);
      } else if (
        channel.sfsLoginResp !== null &&
        !(parsedSfs.controller === 1 && parsedSfs.action === 13 && parsedSfs.cmd === 'x') &&
        !(parsedSfs.controller === 0 && parsedSfs.action === 29) &&
        !(parsedSfs.controller === 1 && parsedSfs.action === 13 && parsedSfs.cmd === 'ping')
      ) {
        this.storeChannelSfsFrame(channel, 'recent', hsFrame, now);
      }
    }

    this.bufferHandshakeFrame(channel, hsFrame, now);

    for (const follower of channel.followers.values()) {
      if (parsedSfs) {
        if (follower.sfsFollowerState === 'wait_hs_req') {
          continue;
        }
        if (
          follower.sfsFollowerState === 'wait_login_req' &&
          !(parsedSfs.controller === 0 && parsedSfs.action === 0)
        ) {
          continue;
        }
      }
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-ws-frame',
        clientSocketId: follower.clientSocketId,
        isBinary: binaryFlag,
        data: payload,
      });
    }
  }

  private handleUpstreamSseEvent(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    rawEventType: unknown,
    rawData: unknown,
    rawLastEventId: unknown,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'sse');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;
    if (typeof rawData !== 'string') return;

    const eventType = typeof rawEventType === 'string' && rawEventType ? rawEventType : 'message';
    const lastEventId = typeof rawLastEventId === 'string' ? rawLastEventId : '';
    const byteLength =
      Buffer.byteLength(eventType, 'utf8') +
      Buffer.byteLength(rawData, 'utf8') +
      Buffer.byteLength(lastEventId, 'utf8');

    if (byteLength > this.maxFrameBytes) {
      return;
    }

    const now = this.now();
    this.bufferHandshakeFrame(
      channel,
      {
        kind: 'sse',
        eventType,
        data: rawData,
        lastEventId,
        byteLength,
        ts: now,
      },
      now,
    );

    for (const follower of channel.followers.values()) {
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-sse-event',
        clientSocketId: follower.clientSocketId,
        eventType,
        data: rawData,
        lastEventId,
      });
    }
  }

  private handleClientWsClose(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
  ): void {
    const sockKey = makeSocketKey(ctx.wc.id, clientSocketId);
    const lookup = this.socketLookup.get(sockKey);
    if (!lookup) return;
    const channel = this.channelsById.get(lookup.channelId);
    if (!channel || channel.kind !== 'ws' || channel.initiatorOrigin !== initiatorOrigin) return;

    if (lookup.role === 'follower') {
      channel.followers.delete(sockKey);
      this.socketLookup.delete(sockKey);
      this.untrackWcChannelIfUnused(channel, ctx.wc.id);
      return;
    }

    channel.ownerClosingByClient = true;
    this.teardownChannelAsOwnerDown(channel, WS_OWNER_TEARDOWN_CLOSE_REASON);
  }

  private handleClientSseClose(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
  ): void {
    const sockKey = makeSocketKey(ctx.wc.id, clientSocketId);
    const lookup = this.socketLookup.get(sockKey);
    if (!lookup) return;
    const channel = this.channelsById.get(lookup.channelId);
    if (!channel || channel.kind !== 'sse' || channel.initiatorOrigin !== initiatorOrigin) return;

    if (lookup.role === 'follower') {
      channel.followers.delete(sockKey);
      this.socketLookup.delete(sockKey);
      this.untrackWcChannelIfUnused(channel, ctx.wc.id);
      return;
    }

    channel.ownerClosingByClient = true;
    this.teardownChannelAsOwnerDown(channel, WS_OWNER_TEARDOWN_CLOSE_REASON);
  }

  private handleUpstreamWsClose(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    code: unknown,
    reason: unknown,
    wasClean: unknown,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'ws');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    const closeCode = typeof code === 'number' ? code : 1005;
    const closeReason = typeof reason === 'string' ? reason : '';
    const clean = Boolean(wasClean);

    const surviving = Array.from(channel.followers.values());
    this.destroyChannelState(channel);

    for (const follower of surviving) {
      const fCtx = this.resolveViewportContext(follower.wcId);
      if (!fCtx || fCtx.wc.isDestroyed() || fCtx.tabId !== channel.tabId) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-ws-close',
        clientSocketId: follower.clientSocketId,
        code: closeCode,
        reason: closeReason,
        wasClean: clean,
      });
    }
  }

  private handleUpstreamWsError(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'ws');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    for (const follower of channel.followers.values()) {
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-ws-error',
        clientSocketId: follower.clientSocketId,
      });
    }
  }

  private handleUpstreamSseError(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
    fatal: unknown,
    retryMs: unknown,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'sse');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    const isFatal = Boolean(fatal);
    const retry = typeof retryMs === 'number' && Number.isFinite(retryMs) ? retryMs : undefined;
    const followers = Array.from(channel.followers.values());

    if (isFatal) {
      this.destroyChannelState(channel);
    }

    for (const follower of followers) {
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-sse-error',
        clientSocketId: follower.clientSocketId,
        fatal: isFatal,
        ...(retry !== undefined ? { retryMs: retry } : {}),
      });
    }
  }

  private handleUpstreamSseBypass(
    ctx: WsMuxViewportContext,
    initiatorOrigin: string,
    clientSocketId: string,
  ): void {
    const channel = this.getOwnedChannel(ctx.wc.id, clientSocketId, 'sse');
    if (!channel || channel.initiatorOrigin !== initiatorOrigin) return;

    const followers = Array.from(channel.followers.values());
    this.destroyChannelState(channel);

    for (const follower of followers) {
      const fCtx = this.getEligibleFollowerCtx(channel, follower.wcId);
      if (!fCtx) continue;
      this.safeSendToRenderer(fCtx.wc, {
        type: 'mux-grant',
        clientSocketId: follower.clientSocketId,
        kind: 'sse',
        role: 'bypass',
      });
    }
  }
}
