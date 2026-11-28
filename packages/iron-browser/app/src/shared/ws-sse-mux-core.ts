export const WS_SSE_MUX_IPC_CHANNELS = {
  TO_MAIN: 'iron:ws-mux:to-main',
  TO_RENDERER: 'iron:ws-mux:to-renderer',
} as const;

export const WS_SSE_MUX_WINDOW_MESSAGES = {
  READY: '__iron_ws_mux_ready__',
  INIT: '__iron_ws_mux_init__',
} as const;

export const WS_MUX_HANDSHAKE_FAIL_OPEN_MS = 150;
export const WS_OUTBOUND_DEDUP_WINDOW_MS = 1500;
export const WS_MAX_CHANNELS_PER_TAB = 16;
export const WS_MAX_HANDSHAKE_FRAMES = 32;
export const WS_HANDSHAKE_BUFFER_TTL_MS = 5000;
export const WS_MAX_FRAME_BYTES = 256 * 1024;
export const WS_MAX_TOTAL_BUFFER_BYTES = 4 * 1024 * 1024;
export const WS_OWNER_TEARDOWN_CLOSE_CODE = 1012;
export const WS_OWNER_TEARDOWN_CLOSE_REASON = 'mux-owner-teardown';
export const WS_REJECT_CAP_CLOSE_CODE = 1008;
export const WS_REJECT_CAP_CLOSE_REASON = 'mux-channel-limit-exceeded';
export const WS_SSE_MAX_JSON_DEPTH = 32;

export type MuxChannelKind = 'ws' | 'sse';
export type MuxRole = 'owner' | 'follower' | 'bypass' | 'reject';

export type MuxToMainMessage =
  | { type: 'ws-open'; clientSocketId: string; url: string; protocols: string[] }
  | { type: 'ws-send'; clientSocketId: string; isBinary: boolean; data: string | Uint8Array }
  | { type: 'ws-close'; clientSocketId: string; code?: number; reason?: string }
  | {
      type: 'sse-open';
      clientSocketId: string;
      url: string;
      withCredentials: boolean;
      lastEventId?: string;
    }
  | { type: 'sse-close'; clientSocketId: string }
  | { type: 'upstream-ws-open'; clientSocketId: string; protocol: string; extensions: string }
  | {
      type: 'upstream-ws-frame';
      clientSocketId: string;
      isBinary: boolean;
      data: string | Uint8Array;
    }
  | { type: 'upstream-ws-error'; clientSocketId: string }
  | {
      type: 'upstream-ws-close';
      clientSocketId: string;
      code: number;
      reason: string;
      wasClean: boolean;
    }
  | { type: 'upstream-sse-open'; clientSocketId: string }
  | {
      type: 'upstream-sse-event';
      clientSocketId: string;
      eventType: string;
      data: string;
      lastEventId: string;
    }
  | { type: 'upstream-sse-error'; clientSocketId: string; fatal: boolean; retryMs?: number }
  | { type: 'upstream-sse-bypass'; clientSocketId: string }
  | { type: 'ss-hello'; clientSocketId: string }
  | {
      type: 'ss-mut';
      clientSocketId: string;
      op: 'set' | 'remove' | 'clear';
      key?: string;
      value?: string;
    };

export type MainToMuxMessage =
  | {
      type: 'mux-grant';
      clientSocketId: string;
      kind: MuxChannelKind;
      role: MuxRole;
      alreadyOpen?: boolean;
      protocol?: string;
      extensions?: string;
      code?: number;
      reason?: string;
    }
  | {
      type: 'mux-promote-to-follower';
      clientSocketId: string;
      alreadyOpen: boolean;
      protocol?: string;
      extensions?: string;
    }
  | { type: 'mux-ws-open'; clientSocketId: string; protocol: string; extensions: string }
  | {
      type: 'mux-ws-send-upstream';
      clientSocketId: string;
      isBinary: boolean;
      data: string | Uint8Array;
    }
  | {
      type: 'mux-ws-frame';
      clientSocketId: string;
      isBinary: boolean;
      data: string | Uint8Array;
    }
  | { type: 'mux-ws-error'; clientSocketId: string }
  | {
      type: 'mux-ws-close';
      clientSocketId: string;
      code: number;
      reason: string;
      wasClean: boolean;
    }
  | { type: 'mux-sse-open'; clientSocketId: string }
  | {
      type: 'mux-sse-event';
      clientSocketId: string;
      eventType: string;
      data: string;
      lastEventId: string;
    }
  | {
      type: 'mux-sse-error';
      clientSocketId: string;
      fatal: boolean;
      ownerTeardown?: boolean;
      retryMs?: number;
    }
  | {
      type: 'mux-ss-sync';
      clientSocketId: string;
      op: 'hydrate' | 'set' | 'remove' | 'clear';
      entries?: Record<string, string>;
      key?: string;
      value?: string;
    };

/**
 * Strictly the 12 correlation/idempotency/timestamp keys that may differ between
 * mirrored portrait and landscape viewports on semantically identical outbound WS frames.
 * Does NOT include domain keys like `txid`, `transactionid`, `createdat`, or `nonce`.
 */
export const WS_VOLATILE_JSON_KEYS: ReadonlySet<string> = new Set([
  'idempotencykey',
  'clientrequestid',
  'requestid',
  'clientbetid',
  'clienttxid',
  'correlationid',
  'traceid',
  'timestamp',
  'ts',
  'clienttime',
  'clienttimestamp',
  'sentat',
]);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SHARED_TEXT_ENCODER = new TextEncoder();

class JsonDepthExceededError extends Error {
  constructor() {
    super('JSON depth exceeds WS_SSE_MAX_JSON_DEPTH');
  }
}

function normalizeVolatileKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.byteLength;
  if (len === 0) return '';
  let out = '';
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const hasB1 = i + 1 < len;
    const hasB2 = i + 2 < len;
    const b1 = hasB1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = hasB2 ? (bytes[i + 2] ?? 0) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 0x3f] ?? '';
    out += BASE64_ALPHABET[(triplet >> 12) & 0x3f] ?? '';
    out += hasB1 ? (BASE64_ALPHABET[(triplet >> 6) & 0x3f] ?? '') : '=';
    out += hasB2 ? (BASE64_ALPHABET[triplet & 0x3f] ?? '') : '=';
  }
  return out;
}

function assertJsonDepth(value: unknown, depth: number): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (depth > WS_SSE_MAX_JSON_DEPTH) {
    throw new JsonDepthExceededError();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonDepth(item, depth + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    assertJsonDepth(obj[key], depth + 1);
  }
}

function canonicalizeJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > WS_SSE_MAX_JSON_DEPTH) {
    throw new JsonDepthExceededError();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const normalized = WS_VOLATILE_JSON_KEYS.has(normalizeVolatileKey(key))
      ? (assertJsonDepth(obj[key], depth + 1), '<volatile>')
      : canonicalizeJsonValue(obj[key], depth + 1);
    Object.defineProperty(out, key, {
      value: normalized,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function canonicalizeWsOutboundPayload(
  payload: string | ArrayBuffer | ArrayBufferView,
): string | null {
  if (typeof payload !== 'string') {
    let view: Uint8Array;
    if (payload instanceof ArrayBuffer) {
      view = new Uint8Array(payload);
    } else if (ArrayBuffer.isView(payload)) {
      view = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    } else {
      return null;
    }
    if (view.byteLength > WS_MAX_FRAME_BYTES) {
      return null;
    }
    return `bin:${view.byteLength}:${bytesToBase64(view)}`;
  }

  if (SHARED_TEXT_ENCODER.encode(payload).byteLength > WS_MAX_FRAME_BYTES) {
    return null;
  }

  const trimmed = payload.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const canonical = canonicalizeJsonValue(parsed, 1);
        return `json:${JSON.stringify(canonical)}`;
      }
    } catch {
      // Fall back to raw text marker when malformed JSON or depth > 32.
    }
  }
  return `txt:${payload}`;
}

export function isValidHttpOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

export function normalizeMuxUrl(
  rawUrl: string,
  kind: MuxChannelKind,
  baseUrl?: string,
): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = baseUrl !== undefined ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }

  if (kind === 'ws') {
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:';
    } else if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:';
    } else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }
  } else if (kind === 'sse') {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } else {
    return null;
  }

  // Re-parse after protocol adjustment to guarantee default port stripping (:80/:443).
  try {
    parsed = new URL(parsed.href);
  } catch {
    return null;
  }

  parsed.hash = '';
  const entries = Array.from(parsed.searchParams.entries()).sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  if (entries.length > 0) {
    const sp = new URLSearchParams();
    for (const [k, v] of entries) {
      sp.append(k, v);
    }
    parsed.search = `?${sp.toString()}`;
  } else {
    parsed.search = '';
  }

  return parsed.href;
}

export function normalizeWsProtocols(protocols?: string | readonly string[]): string[] {
  if (protocols === undefined || protocols === null) return [];
  if (typeof protocols === 'string') return [protocols];
  if (Array.isArray(protocols)) {
    return protocols.map((p) => String(p));
  }
  return [];
}

export interface MuxChannelKeyInput {
  tabId: string;
  initiatorOrigin: string;
  kind: MuxChannelKind;
  normalizedUrl: string;
  protocols?: readonly string[];
  withCredentials?: boolean;
}

export function buildMuxChannelKey(input: MuxChannelKeyInput): string | null {
  if (typeof input.tabId !== 'string' || input.tabId.length === 0) return null;
  if (!isValidHttpOrigin(input.initiatorOrigin)) return null;
  if (typeof input.normalizedUrl !== 'string' || input.normalizedUrl.length === 0) return null;
  if (input.kind !== 'ws' && input.kind !== 'sse') return null;

  const extra =
    input.kind === 'ws' ? [...(input.protocols ?? [])] : Boolean(input.withCredentials);

  return JSON.stringify([
    input.tabId,
    input.initiatorOrigin,
    input.kind,
    input.normalizedUrl,
    extra,
  ]);
}

export interface SseParsedEvent {
  type: string;
  data: string;
  lastEventId: string;
}

export interface SseParseResult {
  events: SseParsedEvent[];
  lastEventId: string;
  retryMs: number | null;
}

export class SseStreamParser {
  private readonly decoder = new TextDecoder('utf-8');
  private started = false;
  private lineBuffer = '';
  private lastWasCr = false;
  private dataBuffer = '';
  private eventTypeBuffer = '';
  lastEventId = '';
  retryMs: number | null = null;

  reset(): void {
    this.started = false;
    this.lineBuffer = '';
    this.lastWasCr = false;
    this.dataBuffer = '';
    this.eventTypeBuffer = '';
    this.lastEventId = '';
    this.retryMs = null;
  }

  push(chunk: string | Uint8Array): SseParsedEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
    }
    const events: SseParsedEvent[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (this.lastWasCr) {
        this.lastWasCr = false;
        if (ch === '\n') {
          continue;
        }
      }
      if (ch === '\r') {
        this.processLine(this.lineBuffer, events);
        this.lineBuffer = '';
        this.lastWasCr = true;
      } else if (ch === '\n') {
        this.processLine(this.lineBuffer, events);
        this.lineBuffer = '';
      } else {
        this.lineBuffer += ch;
      }
    }
    return events;
  }

  finish(): SseParsedEvent[] {
    // Flush decoder and discard any unterminated block per HTML EventSource spec.
    this.decoder.decode();
    this.lineBuffer = '';
    this.lastWasCr = false;
    this.dataBuffer = '';
    this.eventTypeBuffer = '';
    return [];
  }

  private processLine(line: string, out: SseParsedEvent[]): void {
    if (line === '') {
      if (this.dataBuffer.length > 0) {
        const data = this.dataBuffer.slice(0, -1);
        const type = this.eventTypeBuffer.length > 0 ? this.eventTypeBuffer : 'message';
        out.push({
          type,
          data,
          lastEventId: this.lastEventId,
        });
      }
      this.dataBuffer = '';
      this.eventTypeBuffer = '';
      return;
    }

    if (line.charCodeAt(0) === 0x3a /* ':' */) {
      return;
    }

    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.charCodeAt(0) === 0x20 /* ' ' */) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        this.eventTypeBuffer = value;
        break;
      case 'data':
        this.dataBuffer += `${value}\n`;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value;
        }
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) {
          this.retryMs = Number.parseInt(value, 10);
        }
        break;
      default:
        break;
    }
  }
}

export function parseSseChunk(chunk: string | Uint8Array): SseParseResult {
  const parser = new SseStreamParser();
  const events = parser.push(chunk);
  return {
    events,
    lastEventId: parser.lastEventId,
    retryMs: parser.retryMs,
  };
}

/**
 * Generates the self-contained main-world WebSocket/EventSource mux shim script
 * injected via CDP `Page.addScriptToEvaluateOnNewDocument`.
 *
 * Line 1 strictly starts with `(function () { if (window !== window.top) return;`
 * so subframes are never shimmed. All JS intrinsics are captured and bound upfront,
 * and MuxedWebSocket / MuxedEventSource + their prototypes are frozen.
 */
export function buildWsSseMuxShimScript(): string {
  const readyMsg = JSON.stringify(WS_SSE_MUX_WINDOW_MESSAGES.READY);
  const initMsg = JSON.stringify(WS_SSE_MUX_WINDOW_MESSAGES.INIT);
  const failOpenMs = String(WS_MUX_HANDSHAKE_FAIL_OPEN_MS);
  const maxFrameBytes = String(WS_MAX_FRAME_BYTES);

  return `(function () { if (window !== window.top) return;
'use strict';

var globalObj = window;
var NativeObject = Object;
var NativeDefineProperty = NativeObject.defineProperty;
var NativeFreeze = NativeObject.freeze;
var NativeCreate = NativeObject.create;
var NativeGetOwnPropDesc = NativeObject.getOwnPropertyDescriptor;
var NativeGetPrototypeOf = NativeObject.getPrototypeOf;
var NativeSetPrototypeOf = NativeObject.setPrototypeOf;
var nativeCall = Function.prototype.call;
var nativeBind = Function.prototype.bind;
var uncurry = nativeBind.bind(nativeCall);
var callFn = uncurry(nativeCall);
var applyFn = uncurry(Function.prototype.apply);
var bindFn = uncurry(nativeBind);
var hasOwn = typeof NativeObject.hasOwn === 'function'
  ? NativeObject.hasOwn
  : uncurry(NativeObject.prototype.hasOwnProperty);
var isProtoOf = uncurry(NativeObject.prototype.isPrototypeOf);
var objToString = uncurry(NativeObject.prototype.toString);
var NativeSymbolFor = typeof Symbol === 'function' && Symbol.for ? Symbol.for : null;
var NativeSymbolHasInstance = typeof Symbol === 'function' && Symbol.hasInstance ? Symbol.hasInstance : null;
var NativeSymbolIterator = typeof Symbol === 'function' && Symbol.iterator ? Symbol.iterator : null;
var NativeNumberIsInteger = Number.isInteger;
var GUARD_KEY = NativeSymbolFor ? NativeSymbolFor('__iron.wsSseMux.v1__') : '__iron_ws_sse_mux_v1__';

if (hasOwn(globalObj, GUARD_KEY)) {
  return;
}
try {
  NativeDefineProperty(globalObj, GUARD_KEY, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
} catch (_) {
  return;
}

var NativeWebSocket = globalObj.WebSocket;
var NativeEventSource = globalObj.EventSource;
if (typeof NativeWebSocket !== 'function' && typeof NativeEventSource !== 'function') {
  return;
}

var NativeArray = Array;
var ArrayIsArray = NativeArray.isArray;
var ArrayFrom = NativeArray.from;
var arrayPush = uncurry(NativeArray.prototype.push);
var arraySlice = uncurry(NativeArray.prototype.slice);
var arraySplice = uncurry(NativeArray.prototype.splice);
var arrayIndexOf = uncurry(NativeArray.prototype.indexOf);

var strTrim = uncurry(String.prototype.trim);
var strToLower = uncurry(String.prototype.toLowerCase);
var strIndexOf = uncurry(String.prototype.indexOf);
var strSlice = uncurry(String.prototype.slice);
var strCharCodeAt = uncurry(String.prototype.charCodeAt);
var strCharAt = uncurry(String.prototype.charAt);
var strIncludes = uncurry(String.prototype.includes);

var NativeMap = Map;
var mapGet = uncurry(NativeMap.prototype.get);
var mapSet = uncurry(NativeMap.prototype.set);
var mapHas = uncurry(NativeMap.prototype.has);
var mapDelete = uncurry(NativeMap.prototype.delete);
var mapKeys = uncurry(NativeMap.prototype.keys);
var mapValues = uncurry(NativeMap.prototype.values);
var mapClear = uncurry(NativeMap.prototype.clear);
var mapIterProto = NativeGetPrototypeOf((new NativeMap()).keys());
var mapIterNext = mapIterProto && typeof mapIterProto.next === 'function' ? uncurry(mapIterProto.next) : null;

var NativeSet = Set;
var setAdd = uncurry(NativeSet.prototype.add);
var setHas = uncurry(NativeSet.prototype.has);
var setDelete = uncurry(NativeSet.prototype.delete);
var setValues = uncurry(NativeSet.prototype.values);
var setClear = uncurry(NativeSet.prototype.clear);
var setIterProto = NativeGetPrototypeOf((new NativeSet()).values());
var setIterNext = setIterProto && typeof setIterProto.next === 'function' ? uncurry(setIterProto.next) : null;

var NativeWeakMap = WeakMap;
var weakMapGet = uncurry(NativeWeakMap.prototype.get);
var weakMapSet = uncurry(NativeWeakMap.prototype.set);

var NativePromise = Promise;
var promiseThen = uncurry(NativePromise.prototype.then);
var promiseResolve = bindFn(NativePromise.resolve, NativePromise);

var NativeURL = globalObj.URL;
var NativeArrayBuffer = ArrayBuffer;
var arrayBufferSlice = uncurry(NativeArrayBuffer.prototype.slice);
var ArrayBufferIsView = NativeArrayBuffer.isView;
var NativeUint8Array = Uint8Array;
var uint8Set = uncurry(NativeUint8Array.prototype.set);
var NativeBlob = globalObj.Blob;
var blobArrayBuffer = NativeBlob && NativeBlob.prototype ? uncurry(NativeBlob.prototype.arrayBuffer) : null;

var NativeTextDecoder = globalObj.TextDecoder;
var NativeTextEncoder = globalObj.TextEncoder;
var textDecoderDecode = NativeTextDecoder && NativeTextDecoder.prototype ? uncurry(NativeTextDecoder.prototype.decode) : null;
var textEncoderEncode = NativeTextEncoder && NativeTextEncoder.prototype ? uncurry(NativeTextEncoder.prototype.encode) : null;
var sharedEncoder = typeof NativeTextEncoder === 'function' ? new NativeTextEncoder() : null;

var NativeAbortController = globalObj.AbortController;
var abortCtrlAbort = NativeAbortController && NativeAbortController.prototype ? uncurry(NativeAbortController.prototype.abort) : null;
var abortCtrlSignalDesc = NativeAbortController && NativeAbortController.prototype ? NativeGetOwnPropDesc(NativeAbortController.prototype, 'signal') : null;
var abortCtrlSignalGet = abortCtrlSignalDesc && abortCtrlSignalDesc.get ? uncurry(abortCtrlSignalDesc.get) : null;

var nativeFetch = typeof globalObj.fetch === 'function' ? bindFn(globalObj.fetch, globalObj) : null;
var nativeSetTimeout = bindFn(globalObj.setTimeout, globalObj);
var nativeClearTimeout = bindFn(globalObj.clearTimeout, globalObj);
var nativePostMessage = bindFn(globalObj.postMessage, globalObj);
var nativeAddEventListener = bindFn(globalObj.addEventListener, globalObj);
var nativeRemoveEventListener = bindFn(globalObj.removeEventListener, globalObj);

var NativeEvent = globalObj.Event;
var NativeMessageEvent = globalObj.MessageEvent;
var NativeCloseEvent = globalObj.CloseEvent;
var NativeDOMException = globalObj.DOMException;
var NativeTypeError = TypeError;
var NativeError = Error;
var NativeMessagePort = globalObj.MessagePort;
var NativeStorageEvent = typeof globalObj.StorageEvent === 'function' ? globalObj.StorageEvent : null;
var nativeSessionStorage = null;
var storageProtoRef = null;
var rawStorageSetItem = null;
var rawStorageRemoveItem = null;
var rawStorageClear = null;
var rawStorageGetItem = null;
var applyingRemoteSs = false;
var localDirtySsKeys = new NativeSet();
var localClearedSs = false;
try {
  var candSs = globalObj.sessionStorage;
  var candStorageProto = candSs ? NativeGetPrototypeOf(candSs) : null;
  if (
    candSs &&
    candStorageProto &&
    typeof candStorageProto.setItem === 'function' &&
    typeof candStorageProto.removeItem === 'function' &&
    typeof candStorageProto.clear === 'function' &&
    typeof candStorageProto.getItem === 'function'
  ) {
    nativeSessionStorage = candSs;
    storageProtoRef = candStorageProto;
    rawStorageSetItem = candStorageProto.setItem;
    rawStorageRemoveItem = candStorageProto.removeItem;
    rawStorageClear = candStorageProto.clear;
    rawStorageGetItem = candStorageProto.getItem;
  }
} catch (_) {}
var portPostMessage = NativeMessagePort && NativeMessagePort.prototype ? uncurry(NativeMessagePort.prototype.postMessage) : null;
var portStart = NativeMessagePort && NativeMessagePort.prototype && typeof NativeMessagePort.prototype.start === 'function' ? uncurry(NativeMessagePort.prototype.start) : null;
var portClose = NativeMessagePort && NativeMessagePort.prototype && typeof NativeMessagePort.prototype.close === 'function' ? uncurry(NativeMessagePort.prototype.close) : null;
var portOnMsgDesc = NativeMessagePort && NativeMessagePort.prototype ? NativeGetOwnPropDesc(NativeMessagePort.prototype, 'onmessage') : null;
var portOnMsgSet = portOnMsgDesc && portOnMsgDesc.set ? uncurry(portOnMsgDesc.set) : null;

var wsProto = typeof NativeWebSocket === 'function' ? NativeWebSocket.prototype : null;
var esProto = typeof NativeEventSource === 'function' ? NativeEventSource.prototype : null;
var NativeEventTarget = globalObj.EventTarget;
var etProto = NativeEventTarget && NativeEventTarget.prototype
  ? NativeEventTarget.prototype
  : (wsProto ? NativeGetPrototypeOf(wsProto) : (esProto ? NativeGetPrototypeOf(esProto) : null));
var eventTargetAddListener = etProto && typeof etProto.addEventListener === 'function' ? uncurry(etProto.addEventListener) : null;
var eventTargetRemoveListener = etProto && typeof etProto.removeEventListener === 'function' ? uncurry(etProto.removeEventListener) : null;
var wsAddListener = wsProto && typeof wsProto.addEventListener === 'function' ? uncurry(wsProto.addEventListener) : eventTargetAddListener;
var esAddListener = esProto && typeof esProto.addEventListener === 'function' ? uncurry(esProto.addEventListener) : eventTargetAddListener;
var NativeAbortSignal = globalObj.AbortSignal;
var abortSignalAddListener = NativeAbortSignal && NativeAbortSignal.prototype && typeof NativeAbortSignal.prototype.addEventListener === 'function'
  ? uncurry(NativeAbortSignal.prototype.addEventListener)
  : eventTargetAddListener;
var portAddListener = NativeMessagePort && NativeMessagePort.prototype && typeof NativeMessagePort.prototype.addEventListener === 'function'
  ? uncurry(NativeMessagePort.prototype.addEventListener)
  : eventTargetAddListener;

var msgEvDataDesc = NativeMessageEvent && NativeMessageEvent.prototype ? NativeGetOwnPropDesc(NativeMessageEvent.prototype, 'data') : null;
var msgEvSourceDesc = NativeMessageEvent && NativeMessageEvent.prototype ? NativeGetOwnPropDesc(NativeMessageEvent.prototype, 'source') : null;
var msgEvPortsDesc = NativeMessageEvent && NativeMessageEvent.prototype ? NativeGetOwnPropDesc(NativeMessageEvent.prototype, 'ports') : null;
var msgEvDataGet = msgEvDataDesc && msgEvDataDesc.get ? uncurry(msgEvDataDesc.get) : null;
var msgEvSourceGet = msgEvSourceDesc && msgEvSourceDesc.get ? uncurry(msgEvSourceDesc.get) : null;
var msgEvPortsGet = msgEvPortsDesc && msgEvPortsDesc.get ? uncurry(msgEvPortsDesc.get) : null;

var closeEvCodeDesc = NativeCloseEvent && NativeCloseEvent.prototype ? NativeGetOwnPropDesc(NativeCloseEvent.prototype, 'code') : null;
var closeEvReasonDesc = NativeCloseEvent && NativeCloseEvent.prototype ? NativeGetOwnPropDesc(NativeCloseEvent.prototype, 'reason') : null;
var closeEvCleanDesc = NativeCloseEvent && NativeCloseEvent.prototype ? NativeGetOwnPropDesc(NativeCloseEvent.prototype, 'wasClean') : null;
var closeEvCodeGet = closeEvCodeDesc && closeEvCodeDesc.get ? uncurry(closeEvCodeDesc.get) : null;
var closeEvReasonGet = closeEvReasonDesc && closeEvReasonDesc.get ? uncurry(closeEvReasonDesc.get) : null;
var closeEvCleanGet = closeEvCleanDesc && closeEvCleanDesc.get ? uncurry(closeEvCleanDesc.get) : null;

var wsSendNative = wsProto ? uncurry(wsProto.send) : null;
var wsCloseNative = wsProto ? uncurry(wsProto.close) : null;
var wsBinTypeDesc = wsProto ? NativeGetOwnPropDesc(wsProto, 'binaryType') : null;
var wsBinTypeSet = wsBinTypeDesc && wsBinTypeDesc.set ? uncurry(wsBinTypeDesc.set) : null;
var wsProtoDesc = wsProto ? NativeGetOwnPropDesc(wsProto, 'protocol') : null;
var wsProtoGet = wsProtoDesc && wsProtoDesc.get ? uncurry(wsProtoDesc.get) : null;
var wsExtDesc = wsProto ? NativeGetOwnPropDesc(wsProto, 'extensions') : null;
var wsExtGet = wsExtDesc && wsExtDesc.get ? uncurry(wsExtDesc.get) : null;
var wsReadyDesc = wsProto ? NativeGetOwnPropDesc(wsProto, 'readyState') : null;
var wsReadyGet = wsReadyDesc && wsReadyDesc.get ? uncurry(wsReadyDesc.get) : null;
var wsBufDesc = wsProto ? NativeGetOwnPropDesc(wsProto, 'bufferedAmount') : null;
var wsBufGet = wsBufDesc && wsBufDesc.get ? uncurry(wsBufDesc.get) : null;

var esCloseNative = esProto ? uncurry(esProto.close) : null;
var esReadyDesc = esProto ? NativeGetOwnPropDesc(esProto, 'readyState') : null;
var esReadyGet = esReadyDesc && esReadyDesc.get ? uncurry(esReadyDesc.get) : null;

var urlProto = NativeURL && NativeURL.prototype ? NativeURL.prototype : null;
var urlHrefDesc = urlProto ? NativeGetOwnPropDesc(urlProto, 'href') : null;
var urlHrefGet = urlHrefDesc && urlHrefDesc.get ? uncurry(urlHrefDesc.get) : null;
var urlProtocolDesc = urlProto ? NativeGetOwnPropDesc(urlProto, 'protocol') : null;
var urlProtocolGet = urlProtocolDesc && urlProtocolDesc.get ? uncurry(urlProtocolDesc.get) : null;
var urlOriginDesc = urlProto ? NativeGetOwnPropDesc(urlProto, 'origin') : null;
var urlOriginGet = urlOriginDesc && urlOriginDesc.get ? uncurry(urlOriginDesc.get) : null;
var urlUserDesc = urlProto ? NativeGetOwnPropDesc(urlProto, 'username') : null;
var urlUserGet = urlUserDesc && urlUserDesc.get ? uncurry(urlUserDesc.get) : null;
var urlPassDesc = urlProto ? NativeGetOwnPropDesc(urlProto, 'password') : null;
var urlPassGet = urlPassDesc && urlPassDesc.get ? uncurry(urlPassDesc.get) : null;

var ResponseCtor = globalObj.Response;
var resProto = ResponseCtor && ResponseCtor.prototype ? ResponseCtor.prototype : null;
var resStatusDesc = resProto ? NativeGetOwnPropDesc(resProto, 'status') : null;
var resStatusGet = resStatusDesc && resStatusDesc.get ? uncurry(resStatusDesc.get) : null;
var resHeadersDesc = resProto ? NativeGetOwnPropDesc(resProto, 'headers') : null;
var resHeadersGet = resHeadersDesc && resHeadersDesc.get ? uncurry(resHeadersDesc.get) : null;
var resBodyDesc = resProto ? NativeGetOwnPropDesc(resProto, 'body') : null;
var resBodyGet = resBodyDesc && resBodyDesc.get ? uncurry(resBodyDesc.get) : null;
var HeadersCtor = globalObj.Headers;
var headersGet = HeadersCtor && HeadersCtor.prototype ? uncurry(HeadersCtor.prototype.get) : null;

var ReadableStreamCtor = globalObj.ReadableStream;
var rsGetReader = ReadableStreamCtor && ReadableStreamCtor.prototype ? uncurry(ReadableStreamCtor.prototype.getReader) : null;
var RegExpTest = uncurry(RegExp.prototype.test);
var RE_DIGITS = /^[0-9]+$/;
var NativeParseInt = Number.parseInt;

var CONSTS = NativeFreeze({
  READY_MSG: ${readyMsg},
  INIT_MSG: ${initMsg},
  FAIL_OPEN_MS: ${failOpenMs},
  MAX_FRAME_BYTES: ${maxFrameBytes},
  SSE_DEFAULT_RETRY_MS: 3000
});

function readProp(obj, getter, key) {
  if (getter) {
    try {
      return getter(obj);
    } catch (_) {}
  }
  return obj[key];
}

function getBaseHref() {
  try {
    return String(globalObj.location.href || '');
  } catch (_) {
    return '';
  }
}

function makeDOMException(message, name) {
  if (typeof NativeDOMException === 'function') {
    try {
      return new NativeDOMException(message, name);
    } catch (_) {}
  }
  var err = new NativeError(message);
  err.name = name;
  return err;
}

function makeEvent(type) {
  return new NativeEvent(type);
}

function makeMessageEvent(type, init) {
  if (typeof NativeMessageEvent === 'function') {
    return new NativeMessageEvent(type, init);
  }
  var ev = new NativeEvent(type);
  ev.data = init ? init.data : undefined;
  ev.lastEventId = init && init.lastEventId ? init.lastEventId : '';
  ev.origin = init && init.origin ? init.origin : '';
  return ev;
}

function makeCloseEvent(code, reason, wasClean) {
  if (typeof NativeCloseEvent === 'function') {
    return new NativeCloseEvent('close', { code: code, reason: reason, wasClean: wasClean });
  }
  var ev = new NativeEvent('close');
  ev.code = code;
  ev.reason = reason;
  ev.wasClean = wasClean;
  return ev;
}

function utf8ByteLength(str) {
  if (sharedEncoder && textEncoderEncode) {
    return textEncoderEncode(sharedEncoder, str).byteLength;
  }
  var bytes = 0;
  for (var i = 0; i < str.length; i += 1) {
    var code = strCharCodeAt(str, i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function copyToUint8Array(data) {
  if (data instanceof NativeUint8Array) {
    return new NativeUint8Array(data);
  }
  if (data instanceof NativeArrayBuffer || objToString(data) === '[object ArrayBuffer]') {
    return new NativeUint8Array(arrayBufferSlice(data, 0));
  }
  if (ArrayBufferIsView(data)) {
    return new NativeUint8Array(new NativeUint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

function convertBinaryForWrapper(u8, binaryType) {
  if (binaryType === 'arraybuffer') {
    var copy = new NativeUint8Array(u8.byteLength);
    if (uint8Set) uint8Set(copy, u8);
    else copy.set(u8);
    return copy.buffer;
  }
  if (typeof NativeBlob === 'function') {
    return new NativeBlob([u8]);
  }
  var fallback = new NativeUint8Array(u8.byteLength);
  if (uint8Set) uint8Set(fallback, u8);
  else fallback.set(u8);
  return fallback.buffer;
}

var nextSocketSeq = 1;
function makeClientId(prefix) {
  var id = prefix + '-' + nextSocketSeq;
  nextSocketSeq += 1;
  return id;
}

var handshakeState = 'pending'; // 'pending' | 'connected' | 'failed-open'
var activePort = null;
var pendingMessages = [];
var pendingInstances = new NativeSet();
var socketsById = new NativeMap();
var sourcesById = new NativeMap();
var failOpenTimer = null;
var readyTimer = null;

function sendToMain(msg) {
  if (handshakeState === 'connected' && activePort) {
    if (portPostMessage) {
      portPostMessage(activePort, msg);
    } else {
      activePort.postMessage(msg);
    }
    return;
  }
  if (handshakeState === 'pending') {
    arrayPush(pendingMessages, msg);
  }
}

var wsStateMap = new NativeWeakMap();
var esStateMap = new NativeWeakMap();

function dispatchTargetEvent(target, state, ev) {
  var type = ev.type;
  try {
    NativeDefineProperty(ev, 'target', { value: target, configurable: true, enumerable: true });
    NativeDefineProperty(ev, 'currentTarget', { value: target, configurable: true, enumerable: true });
  } catch (_) {}

  var handler = state.handlers[type];
  if (typeof handler === 'function') {
    try {
      callFn(handler, target, ev);
    } catch (_) {}
  }

  var list = mapGet(state.listeners, type);
  if (!list || list.length === 0) return;

  var snapshot = arraySlice(list, 0);
  var remaining = [];
  for (var i = 0; i < list.length; i += 1) {
    if (!list[i].once) {
      arrayPush(remaining, list[i]);
    }
  }
  if (remaining.length > 0) {
    mapSet(state.listeners, type, remaining);
  } else {
    mapDelete(state.listeners, type);
  }

  for (var j = 0; j < snapshot.length; j += 1) {
    var entry = snapshot[j];
    try {
      if (typeof entry.fn === 'function') {
        callFn(entry.fn, target, ev);
      } else if (entry.fn && typeof entry.fn.handleEvent === 'function') {
        entry.fn.handleEvent(ev);
      }
    } catch (_) {}
  }
}

function addTargetListener(target, state, type, listener, options) {
  if (!listener) return;
  if (typeof listener !== 'function' && typeof listener !== 'object') return;
  var typeStr = String(type);
  var capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
  var once = typeof options === 'object' && options !== null ? Boolean(options.once) : false;
  var signal = typeof options === 'object' && options !== null ? options.signal : null;
  if (signal && signal.aborted) return;

  var list = mapGet(state.listeners, typeStr);
  if (!list) {
    list = [];
    mapSet(state.listeners, typeStr, list);
  }
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].fn === listener && list[i].capture === capture) {
      return;
    }
  }
  var rec = { fn: listener, capture: capture, once: once };
  arrayPush(list, rec);

  if (state.onListenerAdded) {
    state.onListenerAdded(typeStr);
  }

  var abortFn = function () {
    removeTargetListener(state, typeStr, listener, capture);
  };
  if (signal) {
    if (abortSignalAddListener) {
      try {
        abortSignalAddListener(signal, 'abort', abortFn, { once: true });
      } catch (_) {}
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abortFn, { once: true });
    }
  }
}

function removeTargetListener(state, type, listener, options) {
  var typeStr = String(type);
  var capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
  var list = mapGet(state.listeners, typeStr);
  if (!list) return;
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].fn === listener && list[i].capture === capture) {
      arraySplice(list, i, 1);
      break;
    }
  }
  if (list.length === 0) {
    mapDelete(state.listeners, typeStr);
  }
}

function wireBypassWebSocket(state) {
  if (state.bypassed || state.nativeWs) return;
  state.bypassed = true;
  state.role = 'bypass';
  setDelete(pendingInstances, state);
  mapDelete(socketsById, state.id);

  if (state.closedBeforeGrant) {
    if (state.readyState !== 3) {
      state.readyState = 3;
      var pc = state.pendingClose;
      dispatchTargetEvent(state.wrapper, state, makeCloseEvent(pc && pc.code !== undefined ? pc.code : 1005, pc && pc.reason ? pc.reason : '', true));
    }
    return;
  }

  var nws = state.hasProtocolsArg
    ? new NativeWebSocket(state.rawUrl, state.rawProtocols)
    : new NativeWebSocket(state.rawUrl);
  state.nativeWs = nws;
  if (wsBinTypeSet) {
    try { wsBinTypeSet(nws, state.binaryType); } catch (_) {}
  } else {
    nws.binaryType = state.binaryType;
  }

  function addWsLis(type, fn) {
    if (wsAddListener) wsAddListener(nws, type, fn);
    else nws.addEventListener(type, fn);
  }

  addWsLis('open', function () {
    state.readyState = 1;
    state.protocol = wsProtoGet ? wsProtoGet(nws) : (nws.protocol || '');
    state.extensions = wsExtGet ? wsExtGet(nws) : (nws.extensions || '');
    dispatchTargetEvent(state.wrapper, state, makeEvent('open'));
  });
  addWsLis('message', function (ev) {
    var d = readProp(ev, msgEvDataGet, 'data');
    dispatchTargetEvent(state.wrapper, state, makeMessageEvent('message', { data: d, origin: state.origin }));
  });
  addWsLis('error', function () {
    dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
  });
  addWsLis('close', function (ev) {
    state.readyState = 3;
    var c = readProp(ev, closeEvCodeGet, 'code');
    var r = readProp(ev, closeEvReasonGet, 'reason');
    var w = readProp(ev, closeEvCleanGet, 'wasClean');
    dispatchTargetEvent(state.wrapper, state, makeCloseEvent(c, r, w));
  });

  if (state.pendingClose) {
    state.readyState = 2;
    if (wsCloseNative) {
      wsCloseNative(nws, state.pendingClose.code, state.pendingClose.reason);
    } else {
      nws.close(state.pendingClose.code, state.pendingClose.reason);
    }
  }
}

function startOwnerWebSocket(state) {
  if (state.nativeWs || state.closedBeforeGrant || state.tornDownByMain) return;
  var nws = state.hasProtocolsArg
    ? new NativeWebSocket(state.resolvedUrl, state.protocols)
    : new NativeWebSocket(state.resolvedUrl);
  state.nativeWs = nws;
  if (wsBinTypeSet) {
    wsBinTypeSet(nws, 'arraybuffer');
  } else {
    nws.binaryType = 'arraybuffer';
  }

  function addOwnerWsLis(type, fn) {
    if (wsAddListener) wsAddListener(nws, type, fn);
    else nws.addEventListener(type, fn);
  }

  addOwnerWsLis('open', function () {
    if (state.tornDownByMain || state.nativeWs !== nws) {
      try {
        if (wsCloseNative) wsCloseNative(nws, 1000, '');
        else nws.close(1000, '');
      } catch (_) {}
      return;
    }
    if (state.pendingClose || state.closedBeforeGrant) {
      if (wsCloseNative) {
        wsCloseNative(nws, state.pendingClose ? state.pendingClose.code : undefined, state.pendingClose ? state.pendingClose.reason : undefined);
      } else {
        nws.close();
      }
      return;
    }
    state.readyState = 1;
    state.protocol = wsProtoGet ? wsProtoGet(nws) : (nws.protocol || '');
    state.extensions = wsExtGet ? wsExtGet(nws) : (nws.extensions || '');
    sendToMain({
      type: 'upstream-ws-open',
      clientSocketId: state.id,
      protocol: state.protocol,
      extensions: state.extensions
    });
    dispatchTargetEvent(state.wrapper, state, makeEvent('open'));
  });

  addOwnerWsLis('message', function (ev) {
    if (state.tornDownByMain || state.nativeWs !== nws || state.readyState === 3) return;
    var raw = readProp(ev, msgEvDataGet, 'data');
    if (typeof raw === 'string') {
      if (utf8ByteLength(raw) <= CONSTS.MAX_FRAME_BYTES) {
        sendToMain({
          type: 'upstream-ws-frame',
          clientSocketId: state.id,
          isBinary: false,
          data: raw
        });
      }
      dispatchTargetEvent(state.wrapper, state, makeMessageEvent('message', { data: raw, origin: state.origin }));
      return;
    }

    var u8 = copyToUint8Array(raw);
    if (u8) {
      if (u8.byteLength <= CONSTS.MAX_FRAME_BYTES) {
        sendToMain({
          type: 'upstream-ws-frame',
          clientSocketId: state.id,
          isBinary: true,
          data: u8
        });
      }
      var localPayload = convertBinaryForWrapper(u8, state.binaryType);
      dispatchTargetEvent(state.wrapper, state, makeMessageEvent('message', { data: localPayload, origin: state.origin }));
      return;
    }

    if (NativeBlob && raw instanceof NativeBlob && blobArrayBuffer) {
      var blobStep = promiseThen(state.inboundBlobQueue, function () {
        return promiseThen(blobArrayBuffer(raw), function (buf) {
          if (state.tornDownByMain || state.nativeWs !== nws || state.readyState === 3) return;
          var bytes = new NativeUint8Array(buf);
          if (bytes.byteLength <= CONSTS.MAX_FRAME_BYTES) {
            sendToMain({
              type: 'upstream-ws-frame',
              clientSocketId: state.id,
              isBinary: true,
              data: bytes
            });
          }
          var localData = convertBinaryForWrapper(bytes, state.binaryType);
          dispatchTargetEvent(state.wrapper, state, makeMessageEvent('message', { data: localData, origin: state.origin }));
        });
      });
      state.inboundBlobQueue = promiseThen(blobStep, undefined, function () {});
    }
  });

  addOwnerWsLis('error', function () {
    if (state.tornDownByMain || state.nativeWs !== nws) return;
    sendToMain({ type: 'upstream-ws-error', clientSocketId: state.id });
    dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
  });

  addOwnerWsLis('close', function (ev) {
    if (state.tornDownByMain || state.nativeWs !== nws) return;
    state.readyState = 3;
    mapDelete(socketsById, state.id);
    var c = readProp(ev, closeEvCodeGet, 'code');
    var r = readProp(ev, closeEvReasonGet, 'reason');
    var w = readProp(ev, closeEvCleanGet, 'wasClean');
    sendToMain({
      type: 'upstream-ws-close',
      clientSocketId: state.id,
      code: typeof c === 'number' ? c : 1005,
      reason: typeof r === 'string' ? r : '',
      wasClean: Boolean(w)
    });
    dispatchTargetEvent(state.wrapper, state, makeCloseEvent(c, r, w));
  });

  if (state.pendingClose) {
    if (wsCloseNative) {
      wsCloseNative(nws, state.pendingClose.code, state.pendingClose.reason);
    } else {
      nws.close(state.pendingClose.code, state.pendingClose.reason);
    }
  }
}

function attachBypassEsListener(state, type) {
  if (!state.nativeEs || mapHas(state.bypassListeners, type)) return;
  var fn = function (ev) {
    if (type === 'open') {
      state.readyState = 1;
      dispatchTargetEvent(state.wrapper, state, makeEvent('open'));
    } else if (type === 'error') {
      state.readyState = esReadyGet ? esReadyGet(state.nativeEs) : state.nativeEs.readyState;
      dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
    } else {
      var data = readProp(ev, msgEvDataGet, 'data');
      var lastId = ev && typeof ev.lastEventId === 'string' ? ev.lastEventId : '';
      state.lastEventId = lastId;
      dispatchTargetEvent(state.wrapper, state, makeMessageEvent(type, { data: data, lastEventId: lastId, origin: state.origin }));
    }
  };
  mapSet(state.bypassListeners, type, fn);
  if (esAddListener) {
    esAddListener(state.nativeEs, type, fn);
  } else {
    state.nativeEs.addEventListener(type, fn);
  }
}

function wireBypassEventSource(state) {
  if (state.bypassed || state.nativeEs) return;
  state.bypassed = true;
  state.role = 'bypass';
  setDelete(pendingInstances, state);
  mapDelete(sourcesById, state.id);

  if (state.closed) {
    state.readyState = 2;
    return;
  }

  var nes = state.initArg !== undefined
    ? new NativeEventSource(state.rawUrl, state.initArg)
    : new NativeEventSource(state.rawUrl);
  state.nativeEs = nes;

  attachBypassEsListener(state, 'open');
  attachBypassEsListener(state, 'message');
  attachBypassEsListener(state, 'error');

  var iter = mapKeys(state.listeners);
  var step = mapIterNext ? mapIterNext(iter) : iter.next();
  while (!step.done) {
    attachBypassEsListener(state, step.value);
    step = mapIterNext ? mapIterNext(iter) : iter.next();
  }
}

function createIncrementalSseParser(initialLastEventId, onEvent, onRetry, onIdChange) {
  var decoder = typeof NativeTextDecoder === 'function' ? new NativeTextDecoder('utf-8') : null;
  var started = false;
  var lineBuffer = '';
  var lastWasCr = false;
  var dataBuffer = '';
  var eventTypeBuffer = '';
  var lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';

  function processLine(line) {
    if (line === '') {
      if (dataBuffer.length > 0) {
        var data = strSlice(dataBuffer, 0, -1);
        var evType = eventTypeBuffer.length > 0 ? eventTypeBuffer : 'message';
        onEvent(evType, data, lastEventId);
      }
      dataBuffer = '';
      eventTypeBuffer = '';
      return;
    }
    if (strCharCodeAt(line, 0) === 0x3a) {
      return;
    }
    var colonIdx = strIndexOf(line, ':');
    var field;
    var value;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = strSlice(line, 0, colonIdx);
      value = strSlice(line, colonIdx + 1);
      if (strCharCodeAt(value, 0) === 0x20) {
        value = strSlice(value, 1);
      }
    }
    if (field === 'event') {
      eventTypeBuffer = value;
    } else if (field === 'data') {
      dataBuffer += value + '\\n';
    } else if (field === 'id') {
      if (!strIncludes(value, '\\0')) {
        lastEventId = value;
        if (typeof onIdChange === 'function') {
          onIdChange(lastEventId);
        }
      }
    } else if (field === 'retry') {
      if (RegExpTest(RE_DIGITS, value)) {
        onRetry(NativeParseInt(value, 10));
      }
    }
  }

  return {
    push: function (chunk) {
      var text = typeof chunk === 'string'
        ? chunk
        : (decoder && textDecoderDecode ? textDecoderDecode(decoder, chunk, { stream: true }) : String(chunk));
      if (!started && text.length > 0) {
        started = true;
        if (strCharCodeAt(text, 0) === 0xfeff) {
          text = strSlice(text, 1);
        }
      }
      for (var i = 0; i < text.length; i += 1) {
        var ch = strCharAt(text, i);
        if (lastWasCr) {
          lastWasCr = false;
          if (ch === '\\n') continue;
        }
        if (ch === '\\r') {
          processLine(lineBuffer);
          lineBuffer = '';
          lastWasCr = true;
        } else if (ch === '\\n') {
          processLine(lineBuffer);
          lineBuffer = '';
        } else {
          lineBuffer += ch;
        }
      }
    },
    finish: function () {
      if (decoder && textDecoderDecode) {
        try { textDecoderDecode(decoder); } catch (_) {}
      }
      lineBuffer = '';
      lastWasCr = false;
      dataBuffer = '';
      eventTypeBuffer = '';
    }
  };
}

function startOwnerEventSource(state) {
  if (state.closed || state.role !== 'owner') return;
  state.sseGen += 1;
  var myGen = state.sseGen;

  if (!nativeFetch) {
    state.readyState = 2;
    state.closed = true;
    sendToMain({ type: 'upstream-sse-error', clientSocketId: state.id, fatal: true });
    dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
    return;
  }

  if (state.reconnectTimer !== null) {
    nativeClearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  var ctrl = typeof NativeAbortController === 'function' ? new NativeAbortController() : null;
  state.abortCtrl = ctrl;
  var pageOrigin = '';
  try {
    var baseParsed = new NativeURL(getBaseHref());
    pageOrigin = String((urlOriginGet ? urlOriginGet(baseParsed) : baseParsed.origin) || '');
  } catch (_) {}
  var isSameOriginSse = Boolean(pageOrigin && state.origin && pageOrigin === state.origin);

  // IMPORTANT: Omit non-safelisted cache-control / cross-origin last-event-id request headers on JS fetch —
  // only CORS-safelisted headers (like Accept) avoid triggering an OPTIONS preflight that standard SSE
  // servers reject with net::ERR_FAILED. Using cache: 'no-store' keeps cross-origin GET a simple CORS
  // request identical to NativeEventSource while still streaming custom event: frames to both viewports.
  var reqHeaders = {
    'Accept': 'text/event-stream'
  };
  if (state.lastEventId && isSameOriginSse) {
    reqHeaders['Last-Event-ID'] = state.lastEventId;
  }
  var fetchOpts = {
    method: 'GET',
    headers: reqHeaders,
    mode: 'cors',
    credentials: state.withCredentials ? 'include' : 'same-origin',
    cache: 'no-store'
  };
  if (ctrl) {
    fetchOpts.signal = abortCtrlSignalGet ? abortCtrlSignalGet(ctrl) : ctrl.signal;
  }

  function fallbackCrossOriginToBypass() {
    if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
    state.abortCtrl = null;
    sendToMain({ type: 'upstream-sse-bypass', clientSocketId: state.id });
    wireBypassEventSource(state);
  }

  function scheduleOwnerReconnect() {
    if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
    if (!isSameOriginSse && state.lastEventId) {
      // Cross-origin reconnect with non-empty Last-Event-ID requires browser-native CORS-exempt header support.
      fallbackCrossOriginToBypass();
      return;
    }
    state.readyState = 0;
    sendToMain({
      type: 'upstream-sse-error',
      clientSocketId: state.id,
      fatal: false,
      retryMs: state.retryMs
    });
    dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
    if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
    state.reconnectTimer = nativeSetTimeout(function () {
      state.reconnectTimer = null;
      startOwnerEventSource(state);
    }, state.retryMs);
  }

  function failFatal() {
    if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
    state.closed = true;
    state.readyState = 2;
    mapDelete(sourcesById, state.id);
    sendToMain({ type: 'upstream-sse-error', clientSocketId: state.id, fatal: true });
    dispatchTargetEvent(state.wrapper, state, makeEvent('error'));
  }

  promiseThen(
    nativeFetch(state.resolvedUrl, fetchOpts),
    function (res) {
      if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
      var status = readProp(res, resStatusGet, 'status');
      var hdrs = readProp(res, resHeadersGet, 'headers');
      var ct = '';
      if (hdrs) {
        ct = headersGet ? (headersGet(hdrs, 'content-type') || '') : (typeof hdrs.get === 'function' ? (hdrs.get('content-type') || '') : '');
      }
      var ctLower = strToLower(String(ct));
      if (status !== 200 || !strIncludes(ctLower, 'text/event-stream')) {
        failFatal();
        return;
      }

      var body = readProp(res, resBodyGet, 'body');
      if (!body) {
        scheduleOwnerReconnect();
        return;
      }

      state.everOpened = true;
      state.readyState = 1;
      sendToMain({ type: 'upstream-sse-open', clientSocketId: state.id });
      dispatchTargetEvent(state.wrapper, state, makeEvent('open'));
      if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;

      var reader = rsGetReader ? rsGetReader(body) : body.getReader();
      state.reader = reader;

      var parser = createIncrementalSseParser(
        state.lastEventId,
        function (evType, data, lastId) {
          if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
          state.lastEventId = lastId;
          var totalLen = utf8ByteLength(evType) + utf8ByteLength(data) + utf8ByteLength(lastId);
          if (totalLen <= CONSTS.MAX_FRAME_BYTES) {
            sendToMain({
              type: 'upstream-sse-event',
              clientSocketId: state.id,
              eventType: evType,
              data: data,
              lastEventId: lastId
            });
          }
          dispatchTargetEvent(state.wrapper, state, makeMessageEvent(evType, {
            data: data,
            lastEventId: lastId,
            origin: state.origin
          }));
        },
        function (ms) {
          if (typeof ms === 'number' && ms >= 0) {
            state.retryMs = ms;
          }
        },
        function (newId) {
          if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
          state.lastEventId = newId;
        }
      );

      function pump() {
        if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
        promiseThen(
          reader.read(),
          function (chunkRes) {
            if (state.closed || state.role !== 'owner' || state.sseGen !== myGen) return;
            if (!chunkRes || chunkRes.done) {
              parser.finish();
              state.reader = null;
              scheduleOwnerReconnect();
              return;
            }
            parser.push(chunkRes.value);
            pump();
          },
          function () {
            state.reader = null;
            if (!state.closed && state.role === 'owner' && state.sseGen === myGen) {
              scheduleOwnerReconnect();
            }
          }
        );
      }

      pump();
    },
    function () {
      if (!state.closed && state.role === 'owner' && state.sseGen === myGen) {
        if (!isSameOriginSse && !state.everOpened) {
          fallbackCrossOriginToBypass();
          return;
        }
        scheduleOwnerReconnect();
      }
    }
  );
}

function handlePortMessage(ev) {
  var msg = readProp(ev, msgEvDataGet, 'data');
  if (!msg || typeof msg !== 'object') return;
  var clientId = msg.clientSocketId;
  if (typeof clientId !== 'string') return;

  if (msg.type === 'mux-ss-sync' && clientId === '__ss__' && nativeSessionStorage) {
    applyingRemoteSs = true;
    try {
      var locHref = globalObj.location ? String(globalObj.location.href || '') : '';
      if (msg.op === 'hydrate' && msg.entries && typeof msg.entries === 'object' && !localClearedSs) {
        var hKeys = NativeObject.keys(msg.entries);
        for (var hi = 0; hi < hKeys.length; hi += 1) {
          var hk = hKeys[hi];
          if (!setHas(localDirtySsKeys, hk) && typeof msg.entries[hk] === 'string') {
            callFn(rawStorageSetItem, nativeSessionStorage, hk, msg.entries[hk]);
          }
        }
      } else if (msg.op === 'set' && typeof msg.key === 'string' && typeof msg.value === 'string') {
        var prevVal = callFn(rawStorageGetItem, nativeSessionStorage, msg.key);
        if (prevVal !== msg.value) {
          callFn(rawStorageSetItem, nativeSessionStorage, msg.key, msg.value);
          if (NativeStorageEvent) {
            try {
              globalObj.dispatchEvent(new NativeStorageEvent('storage', {
                key: msg.key,
                oldValue: prevVal,
                newValue: msg.value,
                url: locHref,
                storageArea: nativeSessionStorage
              }));
            } catch (_) {}
          }
        }
      } else if (msg.op === 'remove' && typeof msg.key === 'string') {
        var prevRem = callFn(rawStorageGetItem, nativeSessionStorage, msg.key);
        if (prevRem !== null) {
          callFn(rawStorageRemoveItem, nativeSessionStorage, msg.key);
          if (NativeStorageEvent) {
            try {
              globalObj.dispatchEvent(new NativeStorageEvent('storage', {
                key: msg.key,
                oldValue: prevRem,
                newValue: null,
                url: locHref,
                storageArea: nativeSessionStorage
              }));
            } catch (_) {}
          }
        }
      } else if (msg.op === 'clear') {
        callFn(rawStorageClear, nativeSessionStorage);
        if (NativeStorageEvent) {
          try {
            globalObj.dispatchEvent(new NativeStorageEvent('storage', {
              key: null,
              oldValue: null,
              newValue: null,
              url: locHref,
              storageArea: nativeSessionStorage
            }));
          } catch (_) {}
        }
      }
    } catch (_) {
    } finally {
      applyingRemoteSs = false;
    }
    return;
  }

  var wsState = mapGet(socketsById, clientId);
  if (wsState) {
    if (msg.type === 'mux-grant') {
      setDelete(pendingInstances, wsState);
      if (wsState.closedBeforeGrant) {
        if (msg.role === 'owner' || msg.role === 'follower') {
          sendToMain({ type: 'ws-close', clientSocketId: wsState.id });
        }
        mapDelete(socketsById, wsState.id);
        return;
      }
      if (msg.role === 'bypass') {
        wireBypassWebSocket(wsState);
        return;
      }
      if (msg.role === 'reject') {
        wsState.role = 'reject';
        wsState.readyState = 3;
        mapDelete(socketsById, wsState.id);
        dispatchTargetEvent(wsState.wrapper, wsState, makeEvent('error'));
        dispatchTargetEvent(wsState.wrapper, wsState, makeCloseEvent(msg.code || 1008, msg.reason || 'mux-rejected', false));
        return;
      }
      if (msg.role === 'owner') {
        wsState.role = 'owner';
        startOwnerWebSocket(wsState);
        return;
      }
      if (msg.role === 'follower') {
        wsState.role = 'follower';
        if (msg.alreadyOpen) {
          wsState.readyState = 1;
          wsState.protocol = msg.protocol || '';
          wsState.extensions = msg.extensions || '';
          dispatchTargetEvent(wsState.wrapper, wsState, makeEvent('open'));
        }
        return;
      }
      return;
    }

    if (msg.type === 'mux-promote-to-follower') {
      if (wsState.role === 'owner' && (wsState.readyState === 0 || wsState.readyState === 1)) {
        var wasConnecting = wsState.readyState === 0;
        var oldNws = wsState.nativeWs;
        wsState.nativeWs = null;
        wsState.role = 'follower';
        if (oldNws) {
          try {
            if (wsCloseNative) wsCloseNative(oldNws, 1000, '');
            else oldNws.close(1000, '');
          } catch (_) {}
        }
        if (msg.alreadyOpen) {
          wsState.readyState = 1;
          wsState.protocol = msg.protocol || '';
          wsState.extensions = msg.extensions || '';
          if (wasConnecting) {
            dispatchTargetEvent(wsState.wrapper, wsState, makeEvent('open'));
          }
        }
      }
      return;
    }

    if (msg.type === 'mux-ws-open') {
      if (wsState.role === 'follower' && wsState.readyState === 0) {
        wsState.readyState = 1;
        wsState.protocol = msg.protocol || '';
        wsState.extensions = msg.extensions || '';
        dispatchTargetEvent(wsState.wrapper, wsState, makeEvent('open'));
      }
      return;
    }

    if (msg.type === 'mux-ws-send-upstream') {
      if (wsState.role === 'owner' && wsState.nativeWs && wsState.readyState === 1) {
        var nwsReady = wsReadyGet ? wsReadyGet(wsState.nativeWs) : wsState.nativeWs.readyState;
        if (nwsReady === 1) {
          var outPayload = msg.isBinary ? copyToUint8Array(msg.data) : msg.data;
          if (outPayload !== null) {
            if (wsSendNative) {
              wsSendNative(wsState.nativeWs, outPayload);
            } else {
              wsState.nativeWs.send(outPayload);
            }
          }
        }
      }
      return;
    }

    if (msg.type === 'mux-ws-frame') {
      if (wsState.role === 'follower' && wsState.readyState === 1) {
        var inPayload;
        if (msg.isBinary) {
          var bytes = copyToUint8Array(msg.data);
          if (!bytes) return;
          inPayload = convertBinaryForWrapper(bytes, wsState.binaryType);
        } else {
          inPayload = msg.data;
        }
        dispatchTargetEvent(wsState.wrapper, wsState, makeMessageEvent('message', {
          data: inPayload,
          origin: wsState.origin
        }));
      }
      return;
    }

    if (msg.type === 'mux-ws-error') {
      if (wsState.role === 'follower' || wsState.role === 'pending') {
        dispatchTargetEvent(wsState.wrapper, wsState, makeEvent('error'));
      }
      return;
    }

    if (msg.type === 'mux-ws-close') {
      if ((wsState.role === 'follower' || wsState.role === 'owner' || wsState.role === 'pending') && wsState.readyState < 3) {
        setDelete(pendingInstances, wsState);
        wsState.readyState = 3;
        wsState.tornDownByMain = true;
        mapDelete(socketsById, wsState.id);
        if (wsState.role === 'owner' && wsState.nativeWs) {
          var nws = wsState.nativeWs;
          var closeCode = typeof msg.code === 'number' && (msg.code === 1000 || (msg.code >= 3000 && msg.code <= 4999)) ? msg.code : 1000;
          var closeReason = typeof msg.reason === 'string' && utf8ByteLength(msg.reason) <= 123 ? msg.reason : '';
          try {
            if (wsCloseNative) wsCloseNative(nws, closeCode, closeReason);
            else nws.close(closeCode, closeReason);
          } catch (_) {}
        }
        dispatchTargetEvent(wsState.wrapper, wsState, makeCloseEvent(msg.code, msg.reason || '', Boolean(msg.wasClean)));
      }
      return;
    }
    return;
  }

  var esState = mapGet(sourcesById, clientId);
  if (esState) {
    if (msg.type === 'mux-grant') {
      setDelete(pendingInstances, esState);
      if (esState.closed) {
        if (msg.role === 'owner' || msg.role === 'follower') {
          sendToMain({ type: 'sse-close', clientSocketId: esState.id });
        }
        mapDelete(sourcesById, esState.id);
        return;
      }
      if (msg.role === 'bypass') {
        wireBypassEventSource(esState);
        return;
      }
      if (msg.role === 'reject') {
        esState.role = 'reject';
        esState.closed = true;
        esState.readyState = 2;
        mapDelete(sourcesById, esState.id);
        dispatchTargetEvent(esState.wrapper, esState, makeEvent('error'));
        return;
      }
      if (msg.role === 'owner') {
        esState.role = 'owner';
        startOwnerEventSource(esState);
        return;
      }
      if (msg.role === 'follower') {
        esState.role = 'follower';
        if (msg.alreadyOpen) {
          esState.readyState = 1;
          dispatchTargetEvent(esState.wrapper, esState, makeEvent('open'));
        }
        return;
      }
      return;
    }

    if (msg.type === 'mux-sse-open') {
      if (esState.role === 'follower' && !esState.closed) {
        esState.readyState = 1;
        dispatchTargetEvent(esState.wrapper, esState, makeEvent('open'));
      }
      return;
    }

    if (msg.type === 'mux-sse-event') {
      if (esState.role === 'follower' && !esState.closed) {
        esState.lastEventId = msg.lastEventId || '';
        dispatchTargetEvent(esState.wrapper, esState, makeMessageEvent(msg.eventType || 'message', {
          data: msg.data,
          lastEventId: esState.lastEventId,
          origin: esState.origin
        }));
      }
      return;
    }

    if (msg.type === 'mux-sse-error') {
      if (!esState.closed && (esState.role === 'follower' || (esState.role === 'owner' && msg.ownerTeardown))) {
        if (esState.role === 'owner') {
          esState.sseGen += 1;
          esState.role = 'pending';
          if (esState.reconnectTimer !== null) {
            nativeClearTimeout(esState.reconnectTimer);
            esState.reconnectTimer = null;
          }
          if (esState.abortCtrl) {
            try {
              if (abortCtrlAbort) abortCtrlAbort(esState.abortCtrl);
              else esState.abortCtrl.abort();
            } catch (_) {}
            esState.abortCtrl = null;
          }
          if (esState.reader && typeof esState.reader.cancel === 'function') {
            try { esState.reader.cancel(); } catch (_) {}
            esState.reader = null;
          }
        }
        if (msg.fatal) {
          esState.closed = true;
          esState.readyState = 2;
          mapDelete(sourcesById, esState.id);
          dispatchTargetEvent(esState.wrapper, esState, makeEvent('error'));
          return;
        }
        esState.readyState = 0;
        dispatchTargetEvent(esState.wrapper, esState, makeEvent('error'));
        if (msg.ownerTeardown && !esState.closed) {
          if (esState.reconnectTimer !== null) {
            nativeClearTimeout(esState.reconnectTimer);
          }
          var delay = typeof msg.retryMs === 'number' && msg.retryMs >= 0 ? msg.retryMs : 25;
          esState.reconnectTimer = nativeSetTimeout(function () {
            esState.reconnectTimer = null;
            if (esState.closed) return;
            esState.role = 'pending';
            sendToMain({
              type: 'sse-open',
              clientSocketId: esState.id,
              url: esState.resolvedUrl,
              withCredentials: esState.withCredentials,
              lastEventId: esState.lastEventId
            });
          }, delay);
        }
      }
      return;
    }
  }
}

function triggerFailOpen() {
  failOpenTimer = null;
  if (readyTimer !== null) {
    nativeClearTimeout(readyTimer);
    readyTimer = null;
  }
  if (handshakeState !== 'pending') return;
  handshakeState = 'failed-open';
  pendingMessages = [];

  var iter = setValues(pendingInstances);
  var step = setIterNext ? setIterNext(iter) : iter.next();
  while (!step.done) {
    var instState = step.value;
    if (instState.kind === 'ws') {
      wireBypassWebSocket(instState);
    } else if (instState.kind === 'sse') {
      wireBypassEventSource(instState);
    }
    step = setIterNext ? setIterNext(iter) : iter.next();
  }
  setClear(pendingInstances);
}

function onWindowMessage(ev) {
  var src = readProp(ev, msgEvSourceGet, 'source');
  if (src !== globalObj) return;
  var data = readProp(ev, msgEvDataGet, 'data');
  if (!data || typeof data !== 'object' || data.type !== CONSTS.INIT_MSG) return;
  var ports = readProp(ev, msgEvPortsGet, 'ports');
  var port = ports && ports[0];
  if (!port) return;

  if (activePort) {
    try {
      if (portOnMsgSet) portOnMsgSet(activePort, null);
      else activePort.onmessage = null;
    } catch (_) {}
    if (portClose) {
      try { portClose(activePort); } catch (_) {}
    } else if (typeof activePort.close === 'function') {
      try { activePort.close(); } catch (_) {}
    }
  }

  activePort = port;
  if (portOnMsgSet) {
    portOnMsgSet(activePort, handlePortMessage);
  } else {
    activePort.onmessage = handlePortMessage;
  }
  if (portStart) {
    try { portStart(activePort); } catch (_) {}
  } else if (typeof activePort.start === 'function') {
    try { activePort.start(); } catch (_) {}
  }

  if (failOpenTimer !== null) {
    nativeClearTimeout(failOpenTimer);
    failOpenTimer = null;
  }
  if (readyTimer !== null) {
    nativeClearTimeout(readyTimer);
    readyTimer = null;
  }
  handshakeState = 'connected';
  if (nativeSessionStorage) {
    if (portPostMessage) {
      portPostMessage(activePort, { type: 'ss-hello', clientSocketId: '__ss__' });
    } else {
      activePort.postMessage({ type: 'ss-hello', clientSocketId: '__ss__' });
    }
  }

  if (pendingMessages.length > 0) {
    var queued = pendingMessages;
    pendingMessages = [];
    for (var i = 0; i < queued.length; i += 1) {
      if (portPostMessage) {
        portPostMessage(activePort, queued[i]);
      } else {
        activePort.postMessage(queued[i]);
      }
    }
  }
}

nativeAddEventListener('message', onWindowMessage, true);
failOpenTimer = nativeSetTimeout(triggerFailOpen, CONSTS.FAIL_OPEN_MS);
readyTimer = nativeSetTimeout(function () {
  readyTimer = null;
  if (!activePort && handshakeState === 'pending') {
    nativePostMessage({ type: CONSTS.READY_MSG }, '*');
  }
}, 15);

if (typeof NativeWebSocket === 'function') {
  var MuxedWebSocket = function WebSocket(url, protocols) {
    if (!(this instanceof MuxedWebSocket)) {
      throw new NativeTypeError("Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    if (arguments.length < 1) {
      throw new NativeTypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
    }

    var hasProtocolsArg = arguments.length >= 2 && protocols !== undefined;
    var resolved = null;
    var scheme = '';
    var hasCreds = false;
    var origin = '';
    try {
      resolved = new NativeURL(String(url), getBaseHref());
      scheme = strToLower(urlProtocolGet ? urlProtocolGet(resolved) : resolved.protocol);
      var u = urlUserGet ? urlUserGet(resolved) : resolved.username;
      var p = urlPassGet ? urlPassGet(resolved) : resolved.password;
      hasCreds = Boolean(u || p);
      origin = urlOriginGet ? urlOriginGet(resolved) : resolved.origin;
    } catch (_) {
      return hasProtocolsArg ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    }

    if (
      handshakeState === 'failed-open' ||
      hasCreds ||
      (scheme !== 'ws:' && scheme !== 'wss:' && scheme !== 'http:' && scheme !== 'https:')
    ) {
      return hasProtocolsArg ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    }

    var normProtocols = [];
    if (hasProtocolsArg) {
      if (typeof protocols === 'string') {
        normProtocols = [protocols];
      } else if (ArrayIsArray(protocols)) {
        for (var i = 0; i < protocols.length; i += 1) {
          arrayPush(normProtocols, String(protocols[i]));
        }
      } else if (protocols && NativeSymbolIterator && typeof protocols[NativeSymbolIterator] === 'function') {
        normProtocols = ArrayFrom(protocols, String);
      } else {
        normProtocols = [String(protocols)];
      }
    }

    var resolvedHref = urlHrefGet ? urlHrefGet(resolved) : resolved.href;
    if (scheme === 'http:') {
      resolvedHref = 'ws:' + strSlice(resolvedHref, 5);
    } else if (scheme === 'https:') {
      resolvedHref = 'wss:' + strSlice(resolvedHref, 6);
    }

    var state = {
      kind: 'ws',
      id: makeClientId('ws'),
      wrapper: this,
      rawUrl: url,
      rawProtocols: protocols,
      hasProtocolsArg: hasProtocolsArg,
      resolvedUrl: resolvedHref,
      origin: origin || '',
      protocols: normProtocols,
      role: 'pending',
      bypassed: false,
      nativeWs: null,
      readyState: 0,
      protocol: '',
      extensions: '',
      binaryType: 'blob',
      closedBeforeGrant: false,
      tornDownByMain: false,
      pendingClose: null,
      blobSendChain: null,
      inboundBlobQueue: promiseResolve(undefined),
      listeners: new NativeMap(),
      handlers: { open: null, message: null, error: null, close: null },
      onListenerAdded: null
    };

    weakMapSet(wsStateMap, this, state);
    mapSet(socketsById, state.id, state);
    if (handshakeState === 'pending') {
      setAdd(pendingInstances, state);
    }
    sendToMain({
      type: 'ws-open',
      clientSocketId: state.id,
      url: state.resolvedUrl,
      protocols: normProtocols
    });
  };

  if (wsProto) {
    NativeSetPrototypeOf(MuxedWebSocket.prototype, wsProto);
  }

  function defineWsProp(name, desc) {
    NativeDefineProperty(MuxedWebSocket.prototype, name, desc);
  }

  defineWsProp('CONNECTING', { value: 0, enumerable: true });
  defineWsProp('OPEN', { value: 1, enumerable: true });
  defineWsProp('CLOSING', { value: 2, enumerable: true });
  defineWsProp('CLOSED', { value: 3, enumerable: true });

  NativeDefineProperty(MuxedWebSocket, 'CONNECTING', { value: 0, enumerable: true });
  NativeDefineProperty(MuxedWebSocket, 'OPEN', { value: 1, enumerable: true });
  NativeDefineProperty(MuxedWebSocket, 'CLOSING', { value: 2, enumerable: true });
  NativeDefineProperty(MuxedWebSocket, 'CLOSED', { value: 3, enumerable: true });

  if (NativeSymbolHasInstance) {
    NativeDefineProperty(MuxedWebSocket, NativeSymbolHasInstance, {
      value: function (inst) {
        if (inst === null || (typeof inst !== 'object' && typeof inst !== 'function')) return false;
        if (isProtoOf(MuxedWebSocket.prototype, inst)) return true;
        return wsProto ? isProtoOf(wsProto, inst) : false;
      }
    });
  }

  defineWsProp('url', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      return s.resolvedUrl;
    }
  });
  defineWsProp('readyState', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeWs) {
        return wsReadyGet ? wsReadyGet(s.nativeWs) : s.nativeWs.readyState;
      }
      return s.readyState;
    }
  });
  defineWsProp('protocol', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeWs) {
        return wsProtoGet ? wsProtoGet(s.nativeWs) : s.nativeWs.protocol;
      }
      return s.protocol;
    }
  });
  defineWsProp('extensions', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeWs) {
        return wsExtGet ? wsExtGet(s.nativeWs) : s.nativeWs.extensions;
      }
      return s.extensions;
    }
  });
  defineWsProp('bufferedAmount', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeWs) {
        return wsBufGet ? wsBufGet(s.nativeWs) : s.nativeWs.bufferedAmount;
      }
      return 0;
    }
  });
  defineWsProp('binaryType', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      return s.binaryType;
    },
    set: function (val) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (val === 'blob' || val === 'arraybuffer') {
        s.binaryType = val;
        if (s.bypassed && s.nativeWs) {
          if (wsBinTypeSet) wsBinTypeSet(s.nativeWs, val);
          else s.nativeWs.binaryType = val;
        }
      }
    }
  });

  var wsEventKeys = ['open', 'message', 'error', 'close'];
  for (var ek = 0; ek < wsEventKeys.length; ek += 1) {
    (function (evName) {
      defineWsProp('on' + evName, {
        enumerable: true,
        get: function () {
          var s = weakMapGet(wsStateMap, this);
          if (!s) throw new NativeTypeError('Illegal invocation');
          return s.handlers[evName];
        },
        set: function (fn) {
          var s = weakMapGet(wsStateMap, this);
          if (!s) throw new NativeTypeError('Illegal invocation');
          s.handlers[evName] = typeof fn === 'function' ? fn : null;
        }
      });
    })(wsEventKeys[ek]);
  }

  defineWsProp('send', {
    enumerable: true,
    value: function send(data) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeWs) {
        if (wsSendNative) wsSendNative(s.nativeWs, data);
        else s.nativeWs.send(data);
        return;
      }
      if (s.readyState === 0) {
        throw makeDOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      }
      if (s.readyState >= 2) {
        return;
      }

      if (NativeBlob && data instanceof NativeBlob && blobArrayBuffer) {
        var prev = s.blobSendChain || promiseResolve(undefined);
        var next = promiseThen(prev, function () {
          return promiseThen(blobArrayBuffer(data), function (buf) {
            if (s.readyState !== 1) return;
            var u8 = new NativeUint8Array(buf);
            if (u8.byteLength <= CONSTS.MAX_FRAME_BYTES) {
              sendToMain({ type: 'ws-send', clientSocketId: s.id, isBinary: true, data: u8 });
            }
          });
        });
        var blobTail = promiseThen(next, function () {
          if (s.blobSendChain === blobTail) s.blobSendChain = null;
        }, function () {
          if (s.blobSendChain === blobTail) s.blobSendChain = null;
        });
        s.blobSendChain = blobTail;
        return;
      }

      var isBin = false;
      var payload;
      if (typeof data === 'string') {
        if (utf8ByteLength(data) > CONSTS.MAX_FRAME_BYTES) return;
        payload = data;
      } else {
        var bytes = copyToUint8Array(data);
        if (bytes) {
          if (bytes.byteLength > CONSTS.MAX_FRAME_BYTES) return;
          isBin = true;
          payload = bytes;
        } else {
          var text = String(data);
          if (utf8ByteLength(text) > CONSTS.MAX_FRAME_BYTES) return;
          payload = text;
        }
      }

      if (s.blobSendChain) {
        var prevChain = s.blobSendChain;
        var nextChain = promiseThen(prevChain, function () {
          if (s.readyState !== 1) return;
          sendToMain({ type: 'ws-send', clientSocketId: s.id, isBinary: isBin, data: payload });
        });
        var chainTail = promiseThen(nextChain, function () {
          if (s.blobSendChain === chainTail) s.blobSendChain = null;
        }, function () {
          if (s.blobSendChain === chainTail) s.blobSendChain = null;
        });
        s.blobSendChain = chainTail;
        return;
      }

      sendToMain({ type: 'ws-send', clientSocketId: s.id, isBinary: isBin, data: payload });
    }
  });

  defineWsProp('close', {
    enumerable: true,
    value: function close(code, reason) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (code !== undefined) {
        if (typeof code !== 'number' || !NativeNumberIsInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) {
          throw makeDOMException("Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999.", 'InvalidAccessError');
        }
      }
      var reasonStr = reason !== undefined ? String(reason) : undefined;
      if (reasonStr !== undefined && utf8ByteLength(reasonStr) > 123) {
        throw makeDOMException("Failed to execute 'close' on 'WebSocket': The message must not be greater than 123 bytes.", 'SyntaxError');
      }
      if (s.bypassed && s.nativeWs) {
        if (wsCloseNative) wsCloseNative(s.nativeWs, code, reasonStr);
        else s.nativeWs.close(code, reasonStr);
        return;
      }
      if (s.readyState >= 2) return;
      s.readyState = 2;

      if (s.role === 'pending') {
        s.closedBeforeGrant = true;
        s.pendingClose = { code: code, reason: reasonStr };
        setDelete(pendingInstances, s);
        nativeSetTimeout(function () {
          if (s.readyState === 3) return;
          s.readyState = 3;
          dispatchTargetEvent(s.wrapper, s, makeCloseEvent(code !== undefined ? code : 1005, reasonStr || '', true));
        }, 0);
        return;
      }

      if (s.role === 'owner') {
        s.pendingClose = { code: code, reason: reasonStr };
        sendToMain({ type: 'ws-close', clientSocketId: s.id, code: code, reason: reasonStr });
        if (s.nativeWs) {
          if (wsCloseNative) wsCloseNative(s.nativeWs, code, reasonStr);
          else s.nativeWs.close(code, reasonStr);
        }
        return;
      }

      if (s.role === 'follower') {
        sendToMain({ type: 'ws-close', clientSocketId: s.id, code: code, reason: reasonStr });
        mapDelete(socketsById, s.id);
        nativeSetTimeout(function () {
          if (s.readyState === 3) return;
          s.readyState = 3;
          dispatchTargetEvent(s.wrapper, s, makeCloseEvent(code !== undefined ? code : 1005, reasonStr || '', true));
        }, 0);
      }
    }
  });

  defineWsProp('addEventListener', {
    enumerable: true,
    value: function addEventListener(type, listener, options) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      addTargetListener(this, s, type, listener, options);
    }
  });
  defineWsProp('removeEventListener', {
    enumerable: true,
    value: function removeEventListener(type, listener, options) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      removeTargetListener(s, type, listener, options);
    }
  });
  defineWsProp('dispatchEvent', {
    enumerable: true,
    value: function dispatchEvent(ev) {
      var s = weakMapGet(wsStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      dispatchTargetEvent(this, s, ev);
      return true;
    }
  });

  NativeFreeze(MuxedWebSocket.prototype);
  NativeFreeze(MuxedWebSocket);
  NativeDefineProperty(globalObj, 'WebSocket', {
    value: MuxedWebSocket,
    writable: true,
    enumerable: false,
    configurable: true
  });
}

if (typeof NativeEventSource === 'function') {
  var MuxedEventSource = function EventSource(url, eventSourceInitDict) {
    if (!(this instanceof MuxedEventSource)) {
      throw new NativeTypeError("Failed to construct 'EventSource': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    if (arguments.length < 1) {
      throw new NativeTypeError("Failed to construct 'EventSource': 1 argument required, but only 0 present.");
    }

    var hasInitArg = arguments.length >= 2 && eventSourceInitDict !== undefined;
    var resolved = null;
    var scheme = '';
    var hasCreds = false;
    var origin = '';
    try {
      resolved = new NativeURL(String(url), getBaseHref());
      scheme = strToLower(urlProtocolGet ? urlProtocolGet(resolved) : resolved.protocol);
      var u = urlUserGet ? urlUserGet(resolved) : resolved.username;
      var p = urlPassGet ? urlPassGet(resolved) : resolved.password;
      hasCreds = Boolean(u || p);
      origin = urlOriginGet ? urlOriginGet(resolved) : resolved.origin;
    } catch (_) {
      return hasInitArg ? new NativeEventSource(url, eventSourceInitDict) : new NativeEventSource(url);
    }

    if (
      handshakeState === 'failed-open' ||
      hasCreds ||
      (scheme !== 'http:' && scheme !== 'https:')
    ) {
      return hasInitArg ? new NativeEventSource(url, eventSourceInitDict) : new NativeEventSource(url);
    }

    var resolvedHref = urlHrefGet ? urlHrefGet(resolved) : resolved.href;
    var withCreds = Boolean(eventSourceInitDict && eventSourceInitDict.withCredentials);

    var state = {
      kind: 'sse',
      id: makeClientId('sse'),
      wrapper: this,
      rawUrl: url,
      initArg: eventSourceInitDict,
      resolvedUrl: resolvedHref,
      origin: origin || '',
      withCredentials: withCreds,
      role: 'pending',
      bypassed: false,
      nativeEs: null,
      bypassListeners: new NativeMap(),
      everOpened: false,
      readyState: 0,
      closed: false,
      lastEventId: '',
      retryMs: CONSTS.SSE_DEFAULT_RETRY_MS,
      abortCtrl: null,
      reader: null,
      reconnectTimer: null,
      sseGen: 0,
      listeners: new NativeMap(),
      handlers: { open: null, message: null, error: null },
      onListenerAdded: null
    };
    state.onListenerAdded = function (evType) {
      if (state.bypassed && state.nativeEs) {
        attachBypassEsListener(state, evType);
      }
    };

    weakMapSet(esStateMap, this, state);
    mapSet(sourcesById, state.id, state);
    if (handshakeState === 'pending') {
      setAdd(pendingInstances, state);
    }
    sendToMain({
      type: 'sse-open',
      clientSocketId: state.id,
      url: state.resolvedUrl,
      withCredentials: state.withCredentials,
      lastEventId: state.lastEventId
    });
  };

  if (esProto) {
    NativeSetPrototypeOf(MuxedEventSource.prototype, esProto);
  }

  function defineEsProp(name, desc) {
    NativeDefineProperty(MuxedEventSource.prototype, name, desc);
  }

  defineEsProp('CONNECTING', { value: 0, enumerable: true });
  defineEsProp('OPEN', { value: 1, enumerable: true });
  defineEsProp('CLOSED', { value: 2, enumerable: true });

  NativeDefineProperty(MuxedEventSource, 'CONNECTING', { value: 0, enumerable: true });
  NativeDefineProperty(MuxedEventSource, 'OPEN', { value: 1, enumerable: true });
  NativeDefineProperty(MuxedEventSource, 'CLOSED', { value: 2, enumerable: true });

  if (NativeSymbolHasInstance) {
    NativeDefineProperty(MuxedEventSource, NativeSymbolHasInstance, {
      value: function (inst) {
        if (inst === null || (typeof inst !== 'object' && typeof inst !== 'function')) return false;
        if (isProtoOf(MuxedEventSource.prototype, inst)) return true;
        return esProto ? isProtoOf(esProto, inst) : false;
      }
    });
  }

  defineEsProp('url', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      return s.resolvedUrl;
    }
  });
  defineEsProp('withCredentials', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      return s.withCredentials;
    }
  });
  defineEsProp('readyState', {
    enumerable: true,
    get: function () {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.bypassed && s.nativeEs) {
        return esReadyGet ? esReadyGet(s.nativeEs) : s.nativeEs.readyState;
      }
      return s.readyState;
    }
  });

  var esEventKeys = ['open', 'message', 'error'];
  for (var eek = 0; eek < esEventKeys.length; eek += 1) {
    (function (evName) {
      defineEsProp('on' + evName, {
        enumerable: true,
        get: function () {
          var s = weakMapGet(esStateMap, this);
          if (!s) throw new NativeTypeError('Illegal invocation');
          return s.handlers[evName];
        },
        set: function (fn) {
          var s = weakMapGet(esStateMap, this);
          if (!s) throw new NativeTypeError('Illegal invocation');
          s.handlers[evName] = typeof fn === 'function' ? fn : null;
        }
      });
    })(esEventKeys[eek]);
  }

  defineEsProp('close', {
    enumerable: true,
    value: function close() {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      if (s.closed) return;
      s.closed = true;
      s.readyState = 2;
      setDelete(pendingInstances, s);
      if (s.reconnectTimer !== null) {
        nativeClearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }
      if (s.abortCtrl) {
        try {
          if (abortCtrlAbort) abortCtrlAbort(s.abortCtrl);
          else s.abortCtrl.abort();
        } catch (_) {}
        s.abortCtrl = null;
      }
      if (s.reader && typeof s.reader.cancel === 'function') {
        try { s.reader.cancel(); } catch (_) {}
        s.reader = null;
      }
      if (s.bypassed && s.nativeEs) {
        if (esCloseNative) esCloseNative(s.nativeEs);
        else s.nativeEs.close();
        return;
      }
      if (s.role === 'owner' || s.role === 'follower') {
        mapDelete(sourcesById, s.id);
        sendToMain({ type: 'sse-close', clientSocketId: s.id });
      }
    }
  });

  defineEsProp('addEventListener', {
    enumerable: true,
    value: function addEventListener(type, listener, options) {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      addTargetListener(this, s, type, listener, options);
    }
  });
  defineEsProp('removeEventListener', {
    enumerable: true,
    value: function removeEventListener(type, listener, options) {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      removeTargetListener(s, type, listener, options);
    }
  });
  defineEsProp('dispatchEvent', {
    enumerable: true,
    value: function dispatchEvent(ev) {
      var s = weakMapGet(esStateMap, this);
      if (!s) throw new NativeTypeError('Illegal invocation');
      dispatchTargetEvent(this, s, ev);
      return true;
    }
  });

  NativeFreeze(MuxedEventSource.prototype);
  NativeFreeze(MuxedEventSource);
  NativeDefineProperty(globalObj, 'EventSource', {
    value: MuxedEventSource,
    writable: true,
    enumerable: false,
    configurable: true
  });
}

if (nativeSessionStorage && storageProtoRef) {
  try {
    NativeDefineProperty(storageProtoRef, 'setItem', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function setItem(key, value) {
        var ret = applyFn(rawStorageSetItem, this, arguments);
        if (this === nativeSessionStorage && !applyingRemoteSs && handshakeState !== 'failed-open') {
          var kStr = String(key);
          var vStr = String(value);
          if (kStr.length + vStr.length <= 524288) {
            setAdd(localDirtySsKeys, kStr);
            sendToMain({
              type: 'ss-mut',
              clientSocketId: '__ss__',
              op: 'set',
              key: kStr,
              value: vStr
            });
          }
        }
        return ret;
      }
    });
    NativeDefineProperty(storageProtoRef, 'removeItem', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function removeItem(key) {
        var ret = applyFn(rawStorageRemoveItem, this, arguments);
        if (this === nativeSessionStorage && !applyingRemoteSs && handshakeState !== 'failed-open') {
          var kStr = String(key);
          if (kStr.length <= 524288) {
            setAdd(localDirtySsKeys, kStr);
            sendToMain({
              type: 'ss-mut',
              clientSocketId: '__ss__',
              op: 'remove',
              key: kStr
            });
          }
        }
        return ret;
      }
    });
    NativeDefineProperty(storageProtoRef, 'clear', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function clear() {
        var ret = applyFn(rawStorageClear, this, arguments);
        if (this === nativeSessionStorage && !applyingRemoteSs && handshakeState !== 'failed-open') {
          localClearedSs = true;
          setClear(localDirtySsKeys);
          sendToMain({
            type: 'ss-mut',
            clientSocketId: '__ss__',
            op: 'clear'
          });
        }
        return ret;
      }
    });
  } catch (_) {}
}
})();`;
}
