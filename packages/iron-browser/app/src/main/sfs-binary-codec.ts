import { inflateSync } from 'node:zlib';
import {
  WS_MAX_FRAME_BYTES,
  WS_SSE_MAX_JSON_DEPTH,
  WS_VOLATILE_JSON_KEYS,
  isValidHttpOrigin,
  normalizeWsProtocols,
} from '../shared/ws-sse-mux-core';

/**
 * Additional volatile / per-viewport device-telemetry keys stripped ONLY inside
 * decoded binary game-protocol envelopes (e.g. SmartFoxServer 2X SFSObject) so
 * portrait (mobile UA / DPR) and landscape (desktop UA / DPR) frames canonicalize
 * identically without altering `WS_VOLATILE_JSON_KEYS` for text JSON frames.
 */
const SFS_EXTRA_VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'currenttimestamp',
  'sessiontoken',
  'clientseed',
  'platform',
  'deviceinfo',
  'useragent',
  'devicetype',
]);

const SHARED_UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

export interface ParsedSfsPacket {
  controller: number;
  action: number;
  cmd?: string;
  hasErrorCode: boolean;
  canonicalJson: string;
}

class SfsBoundsError extends Error {
  constructor() {
    super('SFS binary packet bounds or depth exceeded');
  }
}

function normalizeSfsVolatileKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function isSfsVolatileKey(key: string): boolean {
  const norm = normalizeSfsVolatileKey(key);
  return WS_VOLATILE_JSON_KEYS.has(norm) || SFS_EXTRA_VOLATILE_KEYS.has(norm);
}

class SfsBinaryCursor {
  private readonly view: DataView;
  public offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private ensure(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength) {
      throw new SfsBoundsError();
    }
  }

  readUint8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8(): number {
    this.ensure(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUint16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt16(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readUint32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64String(): string {
    this.ensure(8);
    const hi = this.view.getInt32(this.offset, false);
    const lo = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    const combined = (BigInt(hi) << 32n) | BigInt(lo);
    return combined.toString();
  }

  readFloat32(): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return Number.isFinite(v) ? Number(v.toPrecision(7)) : 0;
  }

  readFloat64(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return Number.isFinite(v) ? v : 0;
  }

  readBytes(len: number): Uint8Array {
    this.ensure(len);
    const sub = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return sub;
  }

  readUtfString16(): string {
    const len = this.readUint16();
    if (len === 0) return '';
    return SHARED_UTF8_DECODER.decode(this.readBytes(len));
  }

  readUtfString32(): string {
    const len = this.readUint32();
    if (len === 0) return '';
    return SHARED_UTF8_DECODER.decode(this.readBytes(len));
  }
}

function decodeSfsTypedValue(cursor: SfsBinaryCursor, depth: number): unknown {
  if (depth > WS_SSE_MAX_JSON_DEPTH) {
    throw new SfsBoundsError();
  }
  const typeId = cursor.readUint8();
  switch (typeId) {
    case 0: // NULL
      return null;
    case 1: // BOOL
      return cursor.readUint8() !== 0;
    case 2: // BYTE
      return cursor.readInt8();
    case 3: // SHORT
      return cursor.readInt16();
    case 4: // INT
      return cursor.readInt32();
    case 5: // LONG
      return cursor.readInt64String();
    case 6: // FLOAT
      return cursor.readFloat32();
    case 7: // DOUBLE
      return cursor.readFloat64();
    case 8: // UTF_STRING
      return cursor.readUtfString16();
    case 9: { // BOOL_ARRAY
      const n = cursor.readUint16();
      const arr: boolean[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readUint8() !== 0);
      return arr;
    }
    case 10: { // BYTE_ARRAY (uint32 length in SFS2X wire format)
      const n = cursor.readUint32();
      const raw = cursor.readBytes(n);
      return Buffer.from(raw).toString('base64');
    }
    case 11: { // SHORT_ARRAY
      const n = cursor.readUint16();
      const arr: number[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readInt16());
      return arr;
    }
    case 12: { // INT_ARRAY
      const n = cursor.readUint16();
      const arr: number[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readInt32());
      return arr;
    }
    case 13: { // LONG_ARRAY
      const n = cursor.readUint16();
      const arr: string[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readInt64String());
      return arr;
    }
    case 14: { // FLOAT_ARRAY
      const n = cursor.readUint16();
      const arr: number[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readFloat32());
      return arr;
    }
    case 15: { // DOUBLE_ARRAY
      const n = cursor.readUint16();
      const arr: number[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readFloat64());
      return arr;
    }
    case 16: { // UTF_STRING_ARRAY
      const n = cursor.readUint16();
      const arr: string[] = [];
      for (let i = 0; i < n; i += 1) arr.push(cursor.readUtfString16());
      return arr;
    }
    case 17: { // SFS_ARRAY
      const n = cursor.readUint16();
      const arr: unknown[] = [];
      for (let i = 0; i < n; i += 1) {
        arr.push(decodeSfsTypedValue(cursor, depth + 1));
      }
      return arr;
    }
    case 18: // SFS_OBJECT
      return decodeSfsObjectBody(cursor, depth + 1);
    case 20: // TEXT (uint32 UTF-8 string)
      return cursor.readUtfString32();
    default:
      throw new SfsBoundsError();
  }
}

function decodeSfsObjectBody(
  cursor: SfsBinaryCursor,
  depth: number,
): Record<string, unknown> {
  if (depth > WS_SSE_MAX_JSON_DEPTH) {
    throw new SfsBoundsError();
  }
  const entryCount = cursor.readUint16();
  const rawEntries: Array<[string, unknown]> = [];
  for (let i = 0; i < entryCount; i += 1) {
    const key = cursor.readUtfString16();
    const val = decodeSfsTypedValue(cursor, depth);
    rawEntries.push([key, val]);
  }
  rawEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, val] of rawEntries) {
    Object.defineProperty(out, key, {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function canonicalizeSfsValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > WS_SSE_MAX_JSON_DEPTH) {
    throw new SfsBoundsError();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeSfsValue(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const normalized = isSfsVolatileKey(key)
      ? '<volatile>'
      : canonicalizeSfsValue(obj[key], depth + 1);
    Object.defineProperty(out, key, {
      value: normalized,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Parses a SmartFoxServer 2X binary frame (`0x80` / `0x88` / `0xa0` / `0xa8` header
 * + length + root `0x12` SFSObject `{ c, a, p }`) into its canonical structure.
 * Returns `null` immediately for any non-SFS binary frame.
 */
export function parseSfsBinaryPacket(
  bytes: Uint8Array,
  maxBytes = WS_MAX_FRAME_BYTES,
): ParsedSfsPacket | null {
  if (bytes.byteLength < 6 || bytes.byteLength > maxBytes) {
    return null;
  }
  const header = bytes[0]!;
  // Valid SFS2X binary headers set 0x80 and optionally 0x20 (zlib) and/or 0x08 (int32 length).
  if ((header & 0x80) === 0 || (header & 0x57) !== 0) {
    return null;
  }

  const isCompressed = (header & 0x20) !== 0;
  const isBigSized = (header & 0x08) !== 0;
  const headerLen = isBigSized ? 5 : 3;
  if (bytes.byteLength <= headerLen) {
    return null;
  }

  const headerView = new DataView(bytes.buffer, bytes.byteOffset, headerLen);
  const declaredLen = isBigSized
    ? headerView.getUint32(1, false)
    : headerView.getUint16(1, false);
  if (declaredLen === 0 || headerLen + declaredLen !== bytes.byteLength) {
    return null;
  }

  let payload = bytes.subarray(headerLen);
  if (isCompressed) {
    try {
      const inflated = inflateSync(payload, { maxOutputLength: maxBytes });
      payload = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
    } catch {
      return null;
    }
  }

  if (payload.byteLength < 3 || payload[0] !== 18) {
    return null;
  }

  try {
    const cursor = new SfsBinaryCursor(payload);
    const rootObj = decodeSfsTypedValue(cursor, 1);
    if (cursor.remaining !== 0 || rootObj === null || typeof rootObj !== 'object' || Array.isArray(rootObj)) {
      return null;
    }

    const rec = rootObj as Record<string, unknown>;
    const c = rec['c'];
    const a = rec['a'];
    const p = rec['p'];
    if (typeof c !== 'number' || typeof a !== 'number' || p === undefined) {
      return null;
    }

    let cmd: string | undefined;
    let hasErrorCode = false;
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      const pRec = p as Record<string, unknown>;
      if (typeof pRec['c'] === 'string') {
        cmd = pRec['c'];
      }
      if (typeof pRec['ec'] === 'number') {
        hasErrorCode = true;
      }
    }

    const canonicalRoot = canonicalizeSfsValue(rootObj, 1);
    return {
      controller: c,
      action: a,
      ...(cmd !== undefined ? { cmd } : {}),
      hasErrorCode,
      canonicalJson: JSON.stringify(canonicalRoot),
    };
  } catch {
    return null;
  }
}

function isIpOrLocalHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost' || hostname.startsWith('[') || hostname.includes(':')) {
    return true;
  }
  return /^\d+(?:\.\d+){3}$/.test(hostname);
}

/**
 * Builds a cluster-sibling equivalence key for load-balanced WebSocket endpoints
 * (e.g. `wss://app-demo.spribegaming.com/BlueBox/websocket` and
 * `wss://app-demo2.spribegaming.com/BlueBox/websocket`) opened by paired viewports
 * of the same `(tabId, initiatorOrigin)` with identical scheme, port, parent domain,
 * shard stem, pathname, query, and subprotocols.
 */
export function buildClusterSiblingChannelKey(params: {
  tabId: string;
  initiatorOrigin: string;
  normalizedUrl: string;
  protocols?: readonly string[];
}): string | null {
  if (!params.tabId || !isValidHttpOrigin(params.initiatorOrigin)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(params.normalizedUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isIpOrLocalHostname(hostname)) {
    return null;
  }
  const labels = hostname.split('.');
  if (labels.length < 3) {
    return null;
  }
  const firstLabel = labels[0] ?? '';
  const parentDomain = labels.slice(1).join('.');
  const shardStem = firstLabel.replace(/(?:-\d+|\d+)$/, '');
  if (shardStem.length < 2 || parentDomain.length < 4) {
    return null;
  }

  const protos = normalizeWsProtocols(params.protocols as string[] | undefined);
  const protoPart = protos.map((p) => encodeURIComponent(p)).join(',');
  return `${params.tabId}|${params.initiatorOrigin}|ws-cluster|${parsed.protocol}//${shardStem}.${parentDomain}:${parsed.port}${parsed.pathname}${parsed.search}|${protoPart}`;
}
