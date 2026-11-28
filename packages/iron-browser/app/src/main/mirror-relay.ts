import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IpcMainEvent, WebContents } from 'electron';

function resolveDefaultIpcMain(): IpcMainLike {
  let mod: { ipcMain?: IpcMainLike } | undefined;
  if (typeof require === 'function') {
    mod = require('electron') as { ipcMain?: IpcMainLike };
  } else {
    const req = createRequire(path.join(__dirname, 'index.js'));
    mod = req('electron') as { ipcMain?: IpcMainLike };
  }
  if (!mod?.ipcMain) {
    throw new Error('Electron ipcMain unavailable; pass an explicit IpcMainLike in tests');
  }
  return mod.ipcMain;
}
import {
  buildMirrorMissLabel,
  EchoLoopGuard,
  isActivationKey,
  isDragOrSliderTarget,
  isInteractiveFingerprint,
  type KeyActivationRecord,
  pairedViewport,
  parseHttpOrigin,
  redactMirrorUrl,
  sanitizeMirrorMissLabel,
  shouldSkipToggleClick,
  shouldSuppressSyntheticClick,
  type ToggleStateMap,
} from '../shared/mirror-core';
import type {
  ClippedElementDetail,
  ElementFingerprint,
  MirrorCaptureEvent,
  MirrorMissInfo,
  ViewportRole,
} from '../shared/types';

export type DomQueryOp =
  | 'resolveTarget'
  | 'applyScroll'
  | 'focusInput'
  | 'layoutAudit'
  | 'inspectAtPoint'
  | 'setClippedHighlight'
  | 'clearClippedHighlight'
  | 'traceStart'
  | 'traceStop';

export interface DomQueryResult {
  found?: boolean;
  tier?: 2 | 3;
  x?: number;
  y?: number;
  isCanvas?: boolean;
  tag?: string;
  ok?: boolean;
  needsClick?: boolean;
  handledDirectly?: boolean;
  currentValue?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  dpr?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  horizontalOverflow?: boolean;
  clippedElements?: number;
  clippedItems?: ClippedElementDetail[];
  highlightedCount?: number;
  canvasCount?: number;
  selector?: string;
  outerHtml?: string;
  fingerprint?: unknown;
  toggleState?: ToggleStateMap;
  traceId?: string;
  durationMs?: number;
  visibilityState?: string;
  samplingMode?: 'raf' | 'timer-fallback';
  frames?: Array<{ tMs: number; dtMs: number }>;
  marks?: Array<{ entryType: 'mark' | 'measure'; name: string; startTimeMs: number; durationMs: number }>;
  measures?: Array<{ entryType: 'mark' | 'measure'; name: string; startTimeMs: number; durationMs: number }>;
  error?: string;
}

export interface MirrorViewportLookup {
  findByWebContentsId(webContentsId: number): {
    tabId: string;
    role: ViewportRole;
    mirrorEnabled: boolean;
    pairedWebContents: WebContents | null;
    pairedScale: number;
  } | null;
  onMirrorMiss?: (tabId: string, info: MirrorMissInfo, sourceWcId?: number) => void;
  onGesture?: (tabId: string, role: ViewportRole, action: string) => void;
  onKeyboardEvent?: (
    tabId: string,
    role: ViewportRole,
    ev: {
      kind: 'keydown' | 'keyup';
      key: string;
      code: string;
      modifiers: string[];
      repeat: boolean;
      tag: string;
      sensitive: boolean;
    },
  ) => void;
  getOrigin?: (wc: WebContents) => string | null;
  isMainFrame?: (wc: WebContents, frame: unknown) => boolean;
  beforeMouseDispatch?: (wc: WebContents) => Promise<void>;
}

export interface IpcMainLike {
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
  removeListener?(
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ): unknown;
  off?(
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ): unknown;
}

export interface ReplayOriginContext {
  senderWc?: WebContents;
  expectedOrigin?: string;
  epoch?: number;
}

const VALID_CAPTURE_KINDS = new Set([
  'click',
  'pointerdown',
  'pointerup',
  'hover',
  'input',
  'change',
  'keydown',
  'keyup',
  'wheel',
  'scroll',
]);

const MAX_TAB_QUEUE_DEPTH = 64;
const MIRROR_MISS_LABEL_MAX_LEN = 32;

const SPECIAL_KEY_CODES: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  ' ': { key: ' ', code: 'Space', vk: 32 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  End: { key: 'End', code: 'End', vk: 35 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', vk: 93 },
  F1: { key: 'F1', code: 'F1', vk: 112 },
  F2: { key: 'F2', code: 'F2', vk: 113 },
  F3: { key: 'F3', code: 'F3', vk: 114 },
  F4: { key: 'F4', code: 'F4', vk: 115 },
  F5: { key: 'F5', code: 'F5', vk: 116 },
  F6: { key: 'F6', code: 'F6', vk: 117 },
  F7: { key: 'F7', code: 'F7', vk: 118 },
  F8: { key: 'F8', code: 'F8', vk: 119 },
  F9: { key: 'F9', code: 'F9', vk: 120 },
  F10: { key: 'F10', code: 'F10', vk: 121 },
  F11: { key: 'F11', code: 'F11', vk: 122 },
  F12: { key: 'F12', code: 'F12', vk: 123 },
};

function modifiersToCdpMask(modifiers: readonly string[] = []): number {
  let mask = 0;
  for (const mod of modifiers) {
    if (mod === 'alt') mask |= 1;
    else if (mod === 'control' || mod === 'ctrl') mask |= 2;
    else if (mod === 'meta' || mod === 'command') mask |= 4;
    else if (mod === 'shift') mask |= 8;
  }
  return mask;
}

function modifiersToElectron(
  modifiers: readonly string[] = [],
): Array<'shift' | 'control' | 'alt' | 'meta'> {
  const out: Array<'shift' | 'control' | 'alt' | 'meta'> = [];
  for (const mod of modifiers) {
    if (mod === 'shift' || mod === 'control' || mod === 'alt' || mod === 'meta') {
      out.push(mod);
    }
  }
  return out;
}

export class MirrorRelay {
  private readonly guards = new Map<string, EchoLoopGuard>();
  private readonly pendingQueries = new Map<
    string,
    {
      expectedSenderId: number;
      tabId?: string;
      epoch?: number;
      resolve: (value: DomQueryResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly tabQueues = new Map<string, Promise<void>>();
  private readonly tabQueueDepths = new Map<string, number>();
  private readonly tabEpochs = new Map<string, number>();
  private readonly activeDrags = new Map<
    string,
    { lastX: number; lastY: number; button: 'left' | 'middle' | 'right' }
  >();
  private readonly heldKeysByPane = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >();
  private readonly recentKeyActivations = new Map<string, KeyActivationRecord>();
  private readonly onDomQueryReply: (ev: IpcMainEvent, msg: unknown) => void;
  private readonly onMirrorCapture: (ev: IpcMainEvent, rawCapture: unknown) => void;
  private readonly onKeyObserve: (ev: IpcMainEvent, rawObs: unknown) => void;
  private disposed = false;

  constructor(
    private readonly lookup: MirrorViewportLookup,
    private readonly ipc: IpcMainLike = resolveDefaultIpcMain(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.onDomQueryReply = (ev: IpcMainEvent, msg: unknown) => {
      if (this.disposed) return;
      if (!msg || typeof msg !== 'object') return;
      const rec = msg as Record<string, unknown>;
      if (typeof rec.reqId !== 'string') return;
      const pending = this.pendingQueries.get(rec.reqId);
      if (!pending) return;
      // Fail closed: reject replies spoofed by a different WebContents or a subframe.
      if (pending.expectedSenderId !== ev.sender.id) return;
      if (!this.checkIsMainFrame(ev.sender, ev.senderFrame)) return;

      clearTimeout(pending.timer);
      this.pendingQueries.delete(rec.reqId);
      const result =
        rec.result && typeof rec.result === 'object'
          ? (rec.result as DomQueryResult)
          : { ok: false, error: 'invalid dom query reply' };
      pending.resolve(result);
    };

    this.onMirrorCapture = (ev: IpcMainEvent, rawCapture: unknown) => {
      if (this.disposed) return;
      if (!rawCapture || typeof rawCapture !== 'object') return;
      const rec = rawCapture as Record<string, unknown>;
      if (typeof rec.kind !== 'string' || !VALID_CAPTURE_KINDS.has(rec.kind)) return;
      const capture = rawCapture as MirrorCaptureEvent;

      const senderWc = ev.sender;
      if (!senderWc || senderWc.isDestroyed()) return;
      if (!this.checkIsMainFrame(senderWc, ev.senderFrame)) return;

      const info = this.lookup.findByWebContentsId(senderWc.id);
      if (!info) return;

      const guard = this.getGuard(info.tabId);
      if (guard.isEcho(info.role)) {
        return;
      }

      if (capture.kind === 'keydown' || capture.kind === 'keyup') {
        this.lookup.onKeyboardEvent?.(info.tabId, info.role, {
          kind: capture.kind,
          key: capture.key,
          code: capture.code,
          modifiers: Array.isArray(capture.modifiers) ? capture.modifiers : [],
          repeat: Boolean(capture.repeat),
          tag: capture.fingerprint?.tag ?? 'unknown',
          sensitive: Boolean(capture.sensitive),
        });
        if (capture.observeOnly) {
          return;
        }
      }

      if (!info.mirrorEnabled || !info.pairedWebContents) {
        return;
      }
      if (info.pairedWebContents.isDestroyed()) return;

      const sourceOrigin = this.resolveOrigin(senderWc);
      const pairedOrigin = this.resolveOrigin(info.pairedWebContents);
      if (!sourceOrigin || !pairedOrigin || sourceOrigin !== pairedOrigin) {
        return;
      }

      const tabId = info.tabId;
      const senderWcId = senderWc.id;
      const epoch = this.getTabEpoch(tabId);

      this.enqueueForTab(
        tabId,
        () => {
          if (this.disposed || epoch !== this.getTabEpoch(tabId)) return Promise.resolve();
          if (senderWc.isDestroyed()) return Promise.resolve();

          const fresh = this.lookup.findByWebContentsId(senderWcId);
          if (!fresh || !fresh.mirrorEnabled || !fresh.pairedWebContents) {
            return Promise.resolve();
          }
          if (fresh.pairedWebContents.isDestroyed()) return Promise.resolve();

          const freshSourceOrigin = this.resolveOrigin(senderWc);
          const freshPairedOrigin = this.resolveOrigin(fresh.pairedWebContents);
          if (!freshSourceOrigin || !freshPairedOrigin || freshSourceOrigin !== freshPairedOrigin) {
            return Promise.resolve();
          }

          if (this.getGuard(fresh.tabId).isEcho(fresh.role)) {
            return Promise.resolve();
          }

          this.lookup.onGesture?.(fresh.tabId, fresh.role, capture.kind);
          const targetRole = pairedViewport(fresh.role);
          return this.replayEvent(
            fresh.tabId,
            targetRole,
            fresh.pairedWebContents,
            capture,
            fresh.pairedScale,
            {
              senderWc,
              expectedOrigin: freshSourceOrigin,
              epoch,
            },
          );
        },
        epoch,
      );
    };

    this.onKeyObserve = (ev: IpcMainEvent, rawObs: unknown) => {
      if (this.disposed) return;
      if (!rawObs || typeof rawObs !== 'object') return;
      const senderWc = ev.sender;
      if (!senderWc || senderWc.isDestroyed()) return;
      if (!this.checkIsMainFrame(senderWc, ev.senderFrame)) return;
      const info = this.lookup.findByWebContentsId(senderWc.id);
      if (!info) return;
      if (this.getGuard(info.tabId).isEcho(info.role)) return;
      const rec = rawObs as Record<string, unknown>;
      if (rec.kind !== 'keydown' && rec.kind !== 'keyup') return;
      this.lookup.onKeyboardEvent?.(info.tabId, info.role, {
        kind: rec.kind,
        key: typeof rec.key === 'string' ? rec.key : '',
        code: typeof rec.code === 'string' ? rec.code : '',
        modifiers: Array.isArray(rec.modifiers) ? (rec.modifiers as string[]) : [],
        repeat: Boolean(rec.repeat),
        tag: typeof rec.tag === 'string' ? rec.tag : 'input',
        sensitive: Boolean(rec.sensitive),
      });
    };

    this.ipc.on('iron:dom-query-reply', this.onDomQueryReply);
    this.ipc.on('iron:mirror-capture', this.onMirrorCapture);
    this.ipc.on('iron:key-observe', this.onKeyObserve);
  }

  private getTabEpoch(tabId: string): number {
    return this.tabEpochs.get(tabId) ?? 0;
  }

  private checkIsMainFrame(wc: WebContents, frame: unknown): boolean {
    if (!wc || wc.isDestroyed()) return false;
    if (this.lookup.isMainFrame) {
      return Boolean(this.lookup.isMainFrame(wc, frame));
    }
    const mf = (wc as unknown as { mainFrame?: unknown }).mainFrame;
    return mf != null && frame === mf;
  }

  private resolveOrigin(wc: WebContents): string | null {
    if (!wc || wc.isDestroyed()) return null;
    if (this.lookup.getOrigin) {
      return parseHttpOrigin(this.lookup.getOrigin(wc));
    }
    const mf = (wc as unknown as { mainFrame?: { origin?: unknown } | null }).mainFrame;
    if (mf && typeof mf.origin === 'string') {
      if (mf.origin === 'null') return null;
      const frameOrigin = parseHttpOrigin(mf.origin);
      if (!frameOrigin) return null;
      const rawUrl = wc.getURL();
      if (rawUrl) {
        const urlOrigin = parseHttpOrigin(rawUrl);
        if (urlOrigin && urlOrigin !== frameOrigin) return null;
      }
      return frameOrigin;
    }
    return parseHttpOrigin(wc.getURL());
  }

  private enqueueForTab(
    tabId: string,
    task: () => Promise<void>,
    epoch = this.getTabEpoch(tabId),
  ): void {
    if (!this.tabEpochs.has(tabId)) {
      this.tabEpochs.set(tabId, epoch);
    }
    const depth = this.tabQueueDepths.get(tabId) ?? 0;
    if (depth >= MAX_TAB_QUEUE_DEPTH) {
      return;
    }
    this.tabQueueDepths.set(tabId, depth + 1);
    const prev = this.tabQueues.get(tabId) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // Isolate prior task errors so subsequent events in the tab FIFO never stall.
      })
      .then(() => {
        if (this.disposed || this.tabEpochs.get(tabId) !== epoch) return;
        return task();
      })
      .catch(() => {
        // Swallow individual replay errors after isolation.
      })
      .finally(() => {
        if (!this.disposed && this.tabEpochs.get(tabId) === epoch) {
          const curDepth = this.tabQueueDepths.get(tabId) ?? 1;
          if (curDepth <= 1) {
            this.tabQueueDepths.delete(tabId);
          } else {
            this.tabQueueDepths.set(tabId, curDepth - 1);
          }
        }
        if (this.tabQueues.get(tabId) === next) {
          this.tabQueues.delete(tabId);
        }
      });
    this.tabQueues.set(tabId, next);
  }

  private emitMiss(
    tabId: string,
    fp: ElementFingerprint,
    reason: string,
    senderWc?: WebContents,
  ): void {
    if (!this.lookup.onMirrorMiss) return;
    if (!isInteractiveFingerprint(fp)) return;
    // Sanitize targetLabel (<= 32 chars, strip control/bidi chars) and redact URL tokens.
    const rawLabel = buildMirrorMissLabel(fp, MIRROR_MISS_LABEL_MAX_LEN);
    const sanitized = sanitizeMirrorMissLabel(rawLabel, MIRROR_MISS_LABEL_MAX_LEN)
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .slice(0, 32);
    const safeUrl =
      senderWc && !senderWc.isDestroyed() ? redactMirrorUrl(senderWc.getURL()) : undefined;
    this.lookup.onMirrorMiss(
      tabId,
      {
        reason,
        targetLabel: sanitized || 'element',
        timestamp: this.now(),
        ...(safeUrl ? { url: safeUrl } : {}),
      },
      senderWc && !senderWc.isDestroyed() ? senderWc.id : undefined,
    );
  }

  getGuard(tabId: string): EchoLoopGuard {
    let guard = this.guards.get(tabId);
    if (!guard) {
      guard = new EchoLoopGuard(140, this.now);
      this.guards.set(tabId, guard);
    }
    return guard;
  }

  clearTab(tabId: string): void {
    this.tabEpochs.set(tabId, this.getTabEpoch(tabId) + 1);
    for (const [reqId, pending] of this.pendingQueries) {
      if (pending.tabId === tabId) {
        clearTimeout(pending.timer);
        this.pendingQueries.delete(reqId);
        pending.resolve({ found: false, ok: false, error: 'tab cleared' });
      }
    }
    this.guards.delete(tabId);
    this.tabQueues.delete(tabId);
    this.tabQueueDepths.delete(tabId);
    this.recentKeyActivations.delete(tabId);
    this.activeDrags.delete(`${tabId}:portrait`);
    this.activeDrags.delete(`${tabId}:landscape`);
    for (const paneKey of [`${tabId}:portrait`, `${tabId}:landscape`]) {
      const held = this.heldKeysByPane.get(paneKey);
      if (held) {
        for (const t of held.values()) clearTimeout(t);
        this.heldKeysByPane.delete(paneKey);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const remove =
      this.ipc.removeListener?.bind(this.ipc) ?? this.ipc.off?.bind(this.ipc);
    if (remove) {
      remove('iron:dom-query-reply', this.onDomQueryReply);
      remove('iron:mirror-capture', this.onMirrorCapture);
      remove('iron:key-observe', this.onKeyObserve);
    }
    for (const [, pending] of this.pendingQueries) {
      clearTimeout(pending.timer);
      pending.resolve({ found: false, ok: false, error: 'mirror relay disposed' });
    }
    this.pendingQueries.clear();
    this.guards.clear();
    this.tabQueues.clear();
    this.tabQueueDepths.clear();
    this.tabEpochs.clear();
    this.activeDrags.clear();
    for (const held of this.heldKeysByPane.values()) {
      for (const t of held.values()) clearTimeout(t);
    }
    this.heldKeysByPane.clear();
    this.recentKeyActivations.clear();
  }

  queryDom(
    wc: WebContents,
    op: DomQueryOp,
    args: Record<string, unknown>,
    timeoutMs = 1500,
    meta?: { tabId?: string; epoch?: number },
  ): Promise<DomQueryResult> {
    if (this.disposed || wc.isDestroyed()) {
      return Promise.resolve({ found: false, ok: false, error: 'webContents destroyed' });
    }
    const tabId = meta?.tabId ?? this.lookup.findByWebContentsId(wc.id)?.tabId;
    const epoch = meta?.epoch ?? (tabId !== undefined ? this.getTabEpoch(tabId) : undefined);
    if (tabId !== undefined && epoch !== undefined && epoch !== this.getTabEpoch(tabId)) {
      return Promise.resolve({ found: false, ok: false, error: 'tab cleared' });
    }
    const reqId = crypto.randomUUID();
    const expectedSenderId = wc.id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQueries.delete(reqId);
        resolve({ found: false, ok: false, error: 'dom query timeout' });
      }, timeoutMs);
      this.pendingQueries.set(reqId, { expectedSenderId, tabId, epoch, resolve, timer });
      try {
        wc.send('iron:dom-query', { reqId, op, args });
      } catch (err) {
        clearTimeout(timer);
        this.pendingQueries.delete(reqId);
        resolve({ found: false, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private async sendDebuggerCommand(
    wc: WebContents,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (wc.isDestroyed() || !wc.debugger.isAttached()) {
      throw new Error(`Debugger detached before ${method}`);
    }
    // Yield out of Electron's C++ WebContentsDebugger::DispatchProtocolMessage V8 MicrotasksScope
    // after sendCommand resolves/rejects so follow-up CDP commands never re-entrantly mutate
    // pending_requests_.
    try {
      return await wc.debugger.sendCommand(method, params);
    } finally {
      await new Promise<void>((resolve) => {
        if (typeof setImmediate === 'function') {
          setImmediate(resolve);
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  private sendBoundedMouseMoved(
    wc: WebContents,
    params: Record<string, unknown>,
    timeoutMs = 150,
  ): Promise<'ok' | 'timeout' | 'error'> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cmdPromise = this.sendDebuggerCommand(wc, 'Input.dispatchMouseEvent', params).then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    return Promise.race([cmdPromise, timeoutPromise]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
  }

  async dispatchTrustedClick(
    wc: WebContents,
    cssX: number,
    cssY: number,
    button: 'left' | 'middle' | 'right' = 'left',
    clickCount = 1,
    modifiers: readonly string[] = [],
    viewportScale = 1,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    if (this.lookup.beforeMouseDispatch) {
      await this.lookup.beforeMouseDispatch(wc);
      if (wc.isDestroyed()) return;
    }
    const x = Math.round(cssX * viewportScale);
    const y = Math.round(cssY * viewportScale);
    const count = Math.max(1, Math.min(3, Math.trunc(clickCount || 1)));
    const modMask = modifiersToCdpMask(modifiers);
    if (wc.debugger.isAttached()) {
      await this.sendBoundedMouseMoved(wc, {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        modifiers: modMask,
      });
      if (wc.isDestroyed()) return;
      try {
        await this.sendDebuggerCommand(wc, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: count,
          modifiers: modMask,
        });
        await this.sendDebuggerCommand(wc, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: count,
          modifiers: modMask,
        });
        return;
      } catch {
        // Fallback to native Electron sendInputEvent.
      }
    }
    const mods = modifiersToElectron(modifiers);
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: mods });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: count, modifiers: mods });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: count, modifiers: mods });
  }

  async dispatchTrustedMouseEvent(
    wc: WebContents,
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    cssX: number,
    cssY: number,
    button: 'left' | 'middle' | 'right' | 'none' = 'left',
    clickCount = 1,
    modifiers: readonly string[] = [],
    viewportScale = 1,
    buttons = 0,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    if ((type === 'mousePressed' || type === 'mouseMoved') && this.lookup.beforeMouseDispatch) {
      await this.lookup.beforeMouseDispatch(wc);
      if (wc.isDestroyed()) return;
    }
    const x = Math.round(cssX * viewportScale);
    const y = Math.round(cssY * viewportScale);
    const modMask = modifiersToCdpMask(modifiers);
    if (wc.debugger.isAttached()) {
      const payload = {
        type,
        x,
        y,
        button,
        ...(type === 'mouseMoved' ? { buttons } : { clickCount }),
        modifiers: modMask,
      };
      if (type === 'mouseMoved') {
        const status = await this.sendBoundedMouseMoved(wc, payload);
        if (status !== 'error') {
          return;
        }
      } else {
        try {
          await this.sendDebuggerCommand(wc, 'Input.dispatchMouseEvent', payload);
          return;
        } catch {
          // Fallback below.
        }
      }
    }
    const mods = modifiersToElectron(modifiers);
    if (type === 'mouseMoved') {
      wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: mods });
    } else if (type === 'mousePressed') {
      wc.sendInputEvent({
        type: 'mouseDown',
        x,
        y,
        button: button === 'none' ? 'left' : button,
        clickCount,
        modifiers: mods,
      });
    } else {
      wc.sendInputEvent({
        type: 'mouseUp',
        x,
        y,
        button: button === 'none' ? 'left' : button,
        clickCount,
        modifiers: mods,
      });
    }
  }

  async dispatchTrustedHover(
    wc: WebContents,
    cssX: number,
    cssY: number,
    viewportScale = 1,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    if (this.lookup.beforeMouseDispatch) {
      await this.lookup.beforeMouseDispatch(wc);
      if (wc.isDestroyed()) return;
    }
    const x = Math.round(cssX * viewportScale);
    const y = Math.round(cssY * viewportScale);
    if (wc.debugger.isAttached()) {
      const status = await this.sendBoundedMouseMoved(wc, {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
      });
      if (status !== 'error') {
        return;
      }
    }
    wc.sendInputEvent({ type: 'mouseMove', x, y });
  }

  async dispatchTrustedWheel(
    wc: WebContents,
    cssX: number,
    cssY: number,
    deltaX: number,
    deltaY: number,
    viewportScale = 1,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    const x = Math.round(cssX * viewportScale);
    const y = Math.round(cssY * viewportScale);
    const clampedX = Math.max(-5000, Math.min(5000, deltaX));
    const clampedY = Math.max(-5000, Math.min(5000, deltaY));
    if (wc.debugger.isAttached()) {
      try {
        await this.sendDebuggerCommand(wc, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: clampedX,
          deltaY: clampedY,
        });
        return;
      } catch {
        // Fallback below.
      }
    }
    // Electron sendInputEvent mouseWheel uses positive values to scroll up/left (opposite of DOM/CDP).
    wc.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: -Math.round(clampedX),
      deltaY: -Math.round(clampedY),
    });
  }

  async dispatchTrustedKeyPhase(
    wc: WebContents,
    phase: 'down' | 'up',
    rawKey: string,
    modifiers: readonly string[] = [],
    rawCode?: string,
    repeat = false,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    const normalizedKey = rawKey === ' ' ? 'Space' : rawKey;
    const spec = SPECIAL_KEY_CODES[normalizedKey];
    const modMask = modifiersToCdpMask(modifiers);

    if (wc.debugger.isAttached()) {
      try {
        const key = spec ? spec.key : rawKey;
        const safeRawCode = typeof rawCode === 'string' && rawCode.trim().length > 0 ? rawCode.trim() : '';
        const code =
          safeRawCode ||
          (spec
            ? spec.code
            : rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)
              ? `Key${rawKey.toUpperCase()}`
              : rawKey.length === 1 && /[0-9]/.test(rawKey)
                ? `Digit${rawKey}`
                : rawKey);
        const vk = spec
          ? spec.vk
          : rawKey.length === 1 && /^[a-zA-Z0-9]$/.test(rawKey)
            ? rawKey.toUpperCase().charCodeAt(0)
            : 0;

        if (phase === 'down') {
          const commands =
            normalizedKey.toLowerCase() === 'a' && (modMask & 2) !== 0 ? ['selectAll'] : undefined;
          const isEnter = normalizedKey === 'Enter';
          const isPrintableSingle = !spec && rawKey.length === 1 && (modMask & ~8) === 0;
          await this.sendDebuggerCommand(wc, 'Input.dispatchKeyEvent', {
            type: isEnter || isPrintableSingle ? 'keyDown' : 'rawKeyDown',
            key,
            code,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers: modMask,
            ...(repeat ? { autoRepeat: true } : {}),
            ...(isEnter
              ? { text: '\r', unmodifiedText: '\r' }
              : isPrintableSingle
                ? { text: rawKey, unmodifiedText: rawKey }
                : {}),
            ...(commands ? { commands } : {}),
          });
        } else {
          await this.sendDebuggerCommand(wc, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers: modMask,
          });
        }
        return;
      } catch {
        // Fallback below.
      }
    }

    const electronKey = normalizedKey === 'Space' ? 'Space' : rawKey;
    const mods = modifiersToElectron(modifiers);
    wc.sendInputEvent({
      type: phase === 'down' ? 'keyDown' : 'keyUp',
      keyCode: electronKey,
      modifiers: mods,
    });
  }

  async dispatchTrustedKey(
    wc: WebContents,
    rawKey: string,
    modifiers: readonly string[] = [],
    rawCode?: string,
  ): Promise<void> {
    await this.dispatchTrustedKeyPhase(wc, 'down', rawKey, modifiers, rawCode, false);
    await this.dispatchTrustedKeyPhase(wc, 'up', rawKey, modifiers, rawCode, false);
  }

  async dispatchTrustedText(wc: WebContents, text: string): Promise<void> {
    if (wc.isDestroyed() || text.length === 0) return;
    if (wc.debugger.isAttached()) {
      try {
        await this.sendDebuggerCommand(wc, 'Input.insertText', { text });
        return;
      } catch {
        // Fallback below.
      }
    }
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
    }
  }

  async replayEvent(
    tabId: string,
    targetRole: ViewportRole,
    targetWc: WebContents,
    capture: MirrorCaptureEvent,
    targetScale = 1,
    ctx?: ReplayOriginContext,
  ): Promise<void> {
    if (this.disposed || targetWc.isDestroyed()) return;

    const canStillDispatch = (): boolean => {
      if (this.disposed) return false;
      if (ctx?.epoch !== undefined && ctx.epoch !== this.getTabEpoch(tabId)) return false;
      if (targetWc.isDestroyed()) return false;
      if (ctx?.expectedOrigin) {
        if (this.resolveOrigin(targetWc) !== ctx.expectedOrigin) return false;
        if (
          ctx.senderWc &&
          (ctx.senderWc.isDestroyed() || this.resolveOrigin(ctx.senderWc) !== ctx.expectedOrigin)
        ) {
          return false;
        }
      }
      return true;
    };

    if (!canStillDispatch()) return;

    const queryMeta = { tabId, epoch: ctx?.epoch ?? this.getTabEpoch(tabId) };
    const guard = this.getGuard(tabId);

    if (capture.kind === 'scroll') {
      const ratioX = Number.isFinite(capture.ratioX) ? Math.min(Math.max(capture.ratioX, 0), 1) : 0;
      const ratioY = Number.isFinite(capture.ratioY) ? Math.min(Math.max(capture.ratioY, 0), 1) : 0;
      guard.beginReplaying(targetRole);
      try {
        await this.queryDom(targetWc, 'applyScroll', { ratioX, ratioY }, 1500, queryMeta);
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'wheel') {
      if (!Number.isFinite(capture.deltaX) || !Number.isFinite(capture.deltaY)) return;
      guard.beginReplaying(targetRole);
      try {
        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
            scrollIntoView: false,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        const pt =
          target.found && target.x !== undefined && target.y !== undefined
            ? { x: target.x, y: target.y }
            : { x: 100, y: 100 };
        await this.dispatchTrustedWheel(
          targetWc,
          pt.x,
          pt.y,
          capture.deltaX,
          capture.deltaY,
          targetScale,
        );
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'input' || capture.kind === 'change') {
      guard.beginReplaying(targetRole);
      try {
        const focused = await this.queryDom(
          targetWc,
          'focusInput',
          {
            fingerprint: capture.fingerprint,
            selectValue: capture.value,
            checked: capture.checked,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        if (!focused.found) {
          this.emitMiss(tabId, capture.fingerprint, `${capture.kind}:target-not-found`, ctx?.senderWc);
          return;
        }
        if (focused.handledDirectly) {
          return;
        }
        if (focused.needsClick && focused.x !== undefined && focused.y !== undefined) {
          await this.dispatchTrustedClick(
            targetWc,
            focused.x,
            focused.y,
            'left',
            1,
            [],
            targetScale,
          );
          return;
        }

        const currentVal = focused.currentValue ?? '';
        if (currentVal === capture.value) return;

        if (
          capture.inputOp === 'insertText' &&
          capture.insertedText &&
          `${currentVal}${capture.insertedText}` === capture.value
        ) {
          await this.dispatchTrustedText(targetWc, capture.insertedText);
        } else if (
          capture.inputOp === 'deleteContentBackward' &&
          currentVal.length === capture.value.length + 1 &&
          currentVal.startsWith(capture.value)
        ) {
          await this.dispatchTrustedKey(targetWc, 'Backspace');
        } else if (capture.inputOp === 'deleteContentForward') {
          await this.dispatchTrustedKey(targetWc, 'Delete');
        } else {
          await this.dispatchTrustedKey(targetWc, 'a', ['control']);
          if (!canStillDispatch()) return;
          if (capture.value.length === 0) {
            await this.dispatchTrustedKey(targetWc, 'Backspace');
          } else {
            await this.dispatchTrustedText(targetWc, capture.value);
          }
        }
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'keydown') {
      guard.beginReplaying(targetRole);
      try {
        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
            scrollIntoView: false,
            focusTarget: true,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        const fpTag = (capture.fingerprint?.tag || '').toLowerCase();
        const isGlobalOrBodyKey =
          fpTag === 'body' ||
          fpTag === 'html' ||
          capture.key === 'Escape' ||
          /^F([1-9]|1[0-2])$/.test(capture.key) ||
          capture.modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');

        if ((!target.found || target.x === undefined || target.y === undefined) && !isGlobalOrBodyKey) {
          this.emitMiss(tabId, capture.fingerprint, 'keydown:target-not-found', ctx?.senderWc);
          return;
        }

        if (capture.holdUntilKeyup) {
          const paneKey = `${tabId}:${targetRole}`;
          const codeKey = capture.code || capture.key;
          let paneMap = this.heldKeysByPane.get(paneKey);
          if (!paneMap) {
            paneMap = new Map();
            this.heldKeysByPane.set(paneKey, paneMap);
          }
          const prevTimer = paneMap.get(codeKey);
          if (prevTimer) clearTimeout(prevTimer);
          const autoUpTimer = setTimeout(() => {
            paneMap?.delete(codeKey);
            if (canStillDispatch()) {
              guard.beginReplaying(targetRole);
              void this.dispatchTrustedKeyPhase(
                targetWc,
                'up',
                capture.key,
                capture.modifiers,
                capture.code,
                false,
              ).finally(() => guard.endReplaying(targetRole));
            }
          }, 15_000);
          autoUpTimer.unref?.();
          paneMap.set(codeKey, autoUpTimer);

          await this.dispatchTrustedKeyPhase(
            targetWc,
            'down',
            capture.key,
            capture.modifiers,
            capture.code,
            Boolean(capture.repeat),
          );
        } else {
          await this.dispatchTrustedKey(targetWc, capture.key, capture.modifiers, capture.code);
        }

        if (isActivationKey(capture.key)) {
          this.recentKeyActivations.set(tabId, {
            key: capture.key,
            timestampMs: this.now(),
            fingerprint: capture.fingerprint,
          });
        }
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'keyup') {
      const paneKey = `${tabId}:${targetRole}`;
      const codeKey = capture.code || capture.key;
      const paneMap = this.heldKeysByPane.get(paneKey);
      if (paneMap) {
        const timer = paneMap.get(codeKey) ?? paneMap.get(capture.key);
        if (timer) clearTimeout(timer);
        paneMap.delete(codeKey);
        paneMap.delete(capture.key);
      }
      guard.beginReplaying(targetRole);
      try {
        if (!canStillDispatch()) return;
        await this.dispatchTrustedKeyPhase(
          targetWc,
          'up',
          capture.key,
          capture.modifiers,
          capture.code,
          false,
        );
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    const dragKey = `${tabId}:${targetRole}`;

    if (capture.kind === 'pointerdown') {
      if (!isDragOrSliderTarget(capture.fingerprint)) {
        return;
      }
      guard.beginReplaying(targetRole);
      try {
        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
            scrollIntoView: false,
            useElementRel: true,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        if (!target.found || target.x === undefined || target.y === undefined) {
          this.emitMiss(tabId, capture.fingerprint, 'pointerdown:target-not-found', ctx?.senderWc);
          return;
        }
        this.activeDrags.set(dragKey, {
          lastX: target.x,
          lastY: target.y,
          button: capture.button,
        });
        await this.dispatchTrustedMouseEvent(
          targetWc,
          'mousePressed',
          target.x,
          target.y,
          capture.button,
          1,
          capture.modifiers,
          targetScale,
          1,
        );
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'pointerup') {
      const drag = this.activeDrags.get(dragKey);
      if (!drag) {
        return;
      }
      this.activeDrags.delete(dragKey);
      guard.beginReplaying(targetRole);
      try {
        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
            scrollIntoView: false,
            useElementRel: true,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        const pt =
          target.found && target.x !== undefined && target.y !== undefined
            ? { x: target.x, y: target.y }
            : { x: drag.lastX, y: drag.lastY };
        await this.dispatchTrustedMouseEvent(
          targetWc,
          'mouseReleased',
          pt.x,
          pt.y,
          capture.button,
          1,
          capture.modifiers,
          targetScale,
          0,
        );
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'hover') {
      const drag = this.activeDrags.get(dragKey);
      guard.beginReplaying(targetRole);
      try {
        if (drag) {
          const target = await this.queryDom(
            targetWc,
            'resolveTarget',
            {
              fingerprint: capture.fingerprint,
              scrollIntoView: false,
              useElementRel: true,
            },
            1500,
            queryMeta,
          );
          if (!canStillDispatch()) return;
          const pt =
            target.found && target.x !== undefined && target.y !== undefined
              ? { x: target.x, y: target.y }
              : { x: drag.lastX, y: drag.lastY };
          drag.lastX = pt.x;
          drag.lastY = pt.y;
          await this.dispatchTrustedMouseEvent(
            targetWc,
            'mouseMoved',
            pt.x,
            pt.y,
            drag.button,
            0,
            capture.modifiers,
            targetScale,
            1,
          );
          return;
        }

        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
            scrollIntoView: false,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        if (!target.found || target.x === undefined || target.y === undefined) {
          return;
        }
        await this.dispatchTrustedHover(targetWc, target.x, target.y, targetScale);
      } finally {
        guard.endReplaying(targetRole);
      }
      return;
    }

    if (capture.kind === 'click') {
      const recentKeyRelay = this.recentKeyActivations.get(tabId);
      if (
        shouldSuppressSyntheticClick({
          clickCount: capture.clickCount,
          clickFingerprint: capture.fingerprint,
          recentKeyRelay,
          nowMs: this.now(),
        })
      ) {
        this.recentKeyActivations.delete(tabId);
        return;
      }

      guard.beginReplaying(targetRole);
      try {
        const target = await this.queryDom(
          targetWc,
          'resolveTarget',
          {
            fingerprint: capture.fingerprint,
          },
          1500,
          queryMeta,
        );
        if (!canStillDispatch()) return;
        if (!target.found || target.x === undefined || target.y === undefined) {
          this.emitMiss(tabId, capture.fingerprint, 'click:target-not-found', ctx?.senderWc);
          return;
        }

        // State-Aware Toggle Guard (aria-pressed, aria-checked, aria-selected, data-state).
        const preState = capture.fingerprint.toggleState;
        const postState = capture.toggleState ?? (preState ? {} : undefined);
        const shouldSkip =
          preState && postState
            ? shouldSkipToggleClick({ preState, postState, pairedState: target.toggleState })
            : shouldSkipToggleClick(postState ?? preState, target.toggleState);
        if (shouldSkip) {
          return;
        }

        await this.dispatchTrustedClick(
          targetWc,
          target.x,
          target.y,
          capture.button,
          capture.clickCount,
          capture.modifiers,
          targetScale,
        );
      } finally {
        guard.endReplaying(targetRole);
      }
    }
  }
}
