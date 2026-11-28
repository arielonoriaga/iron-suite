export const MAX_JSON_DEPTH = 32;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;

export const VOLATILE_JSON_KEYS = new Set([
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

export const VOLATILE_QUERY_KEYS = new Set([
  '_',
  't',
  'ts',
  'timestamp',
  'cachebust',
  'cb',
  'requestid',
  'idempotencykey',
]);

export const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const API_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);

export const DISCRIMINATING_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'origin',
  'proxy-authorization',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
] as const;

export const DISALLOWED_REQUEST_CONTENT_TYPE_PREFIXES = [
  'multipart/',
  'application/octet-stream',
] as const;

export const NON_CACHEABLE_MIME_EXACT = new Set([
  'text/event-stream',
  'application/grpc',
  'application/x-ndjson',
  'application/ndjson',
  'application/octet-stream',
  'application/wasm',
]);

export const NON_CACHEABLE_MIME_PREFIXES = [
  'application/grpc+',
  'audio/',
  'video/',
  'image/',
  'multipart/',
] as const;

const STRIPPED_REPLAY_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'upgrade',
  'set-cookie',
  'x-iron-browser-dedup',
]);

const DANGEROUS_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const BINARY_CONTROL_OR_REPLACEMENT_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/;

const textEncoder = new TextEncoder();

export type HeaderMapInput =
  | Record<string, string>
  | ReadonlyArray<{ name: string; value: string }>;

export interface NormalizedDedupRequest {
  eligible: boolean;
  key: string;
  isMutation: boolean;
  volatileValues: Record<string, string>;
}

class JsonDepthExceededError extends Error {
  constructor() {
    super('JSON recursion depth exceeded MAX_JSON_DEPTH');
  }
}

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function createNullRecord<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function defineSafeProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function assertJsonDepth(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new JsonDepthExceededError();
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonDepth(item, depth + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    assertJsonDepth(obj[k], depth + 1);
  }
}

function canonicalizeJsonValue(
  value: unknown,
  path: string,
  volatiles: Record<string, string>,
  depth = 0,
  inDangerousBranch = false,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new JsonDepthExceededError();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      canonicalizeJsonValue(item, `${path}[${idx}]`, volatiles, depth + 1, inDangerousBranch),
    );
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out = createNullRecord();
  for (const k of sortedKeys) {
    const childPath = path ? `${path}.${k}` : k;
    const rawVal = obj[k];
    const nextDangerous = inDangerousBranch || DANGEROUS_KEY_NAMES.has(k);
    if (VOLATILE_JSON_KEYS.has(normalizeKeyName(k))) {
      assertJsonDepth(rawVal, depth + 1);
      if (!nextDangerous && typeof rawVal === 'string' && rawVal.length >= 6) {
        defineSafeProperty(volatiles, childPath, rawVal);
      }
      defineSafeProperty(out, k, `<volatile:${childPath}>`);
    } else {
      defineSafeProperty(
        out,
        k,
        canonicalizeJsonValue(rawVal, childPath, volatiles, depth + 1, nextDangerous),
      );
    }
  }
  return out;
}

function collectLowerHeaders(headers?: HeaderMapInput): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!headers) return map;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
      const lower = entry.name.trim().toLowerCase();
      if (!lower) continue;
      let list = map.get(lower);
      if (!list) {
        list = [];
        map.set(lower, list);
      }
      list.push(entry.value);
    }
    return map;
  }
  const record = headers as Record<string, string>;
  for (const name of Object.keys(record)) {
    const value = record[name];
    if (typeof value !== 'string') continue;
    const lower = name.trim().toLowerCase();
    if (!lower) continue;
    let list = map.get(lower);
    if (!list) {
      list = [];
      map.set(lower, list);
    }
    list.push(value);
  }
  return map;
}

function isDisallowedRequestContentType(headers?: HeaderMapInput): boolean {
  if (!headers) return false;
  const collected = collectLowerHeaders(headers);
  const values = collected.get('content-type');
  if (!values) return false;
  for (const raw of values) {
    const mime = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!mime) continue;
    for (const prefix of DISALLOWED_REQUEST_CONTENT_TYPE_PREFIXES) {
      if (mime === prefix || mime.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

function hasRequestContentType(headers?: HeaderMapInput): boolean {
  if (!headers) return false;
  const collected = collectLowerHeaders(headers);
  const values = collected.get('content-type');
  return values !== undefined && values.some((v) => v.trim().length > 0);
}

export function hasBinaryOrLossyPostData(postData: string): boolean {
  return BINARY_CONTROL_OR_REPLACEMENT_RE.test(postData);
}

/**
 * Validates that a raw origin string is a strict, non-opaque `http:` or `https:` origin
 * with no paths, queries, fragments, or embedded credentials.
 */
export function parseAuthoritativeHttpOrigin(rawOrigin: string | null | undefined): string | null {
  if (typeof rawOrigin !== 'string' || rawOrigin.length === 0 || rawOrigin === 'null') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.origin === 'null' || parsed.origin !== rawOrigin) {
    return null;
  }
  return parsed.origin;
}

/**
 * Extracts a non-opaque `http:` or `https:` origin from a URL string (rejecting embedded credentials).
 */
export function parseHttpOrigin(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.origin === 'null') {
    return null;
  }
  return parsed.origin;
}

export function canonicalizeDiscriminatingHeaders(headers?: HeaderMapInput): string {
  const collected = collectLowerHeaders(headers);
  const pairs: Array<[string, string | null]> = DISCRIMINATING_REQUEST_HEADERS.map((name) => {
    const vals = collected.get(name);
    return [name, vals !== undefined ? vals.join(', ') : null];
  });
  return JSON.stringify(pairs);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(input: string): string {
  const bytes = textEncoder.encode(input);
  const len = bytes.length;
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[len] = 0x80;

  const bitLen = len * 8;
  const bitLenHi = Math.floor(bitLen / 0x100000000);
  const bitLenLo = bitLen >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export function computeDiscriminatingHeaderDigest(headers?: HeaderMapInput): string {
  return sha256Hex(canonicalizeDiscriminatingHeaders(headers));
}

export function buildDedupCacheKey(parts: {
  tabId: string;
  initiatorOrigin: string;
  headerDigest: string;
  normalizedKey: string;
}): string {
  return `${parts.tabId}::${parts.initiatorOrigin}::${parts.headerDigest}::${parts.normalizedKey}`;
}

export function normalizeRequestForDedup(input: {
  method: string;
  url: string;
  resourceType?: string;
  postData?: string;
  hasPostData?: boolean;
  requestHeaders?: HeaderMapInput;
  allowGet?: boolean;
}): NormalizedDedupRequest {
  const method = (input.method || 'GET').toUpperCase();
  const isMutation = MUTATION_METHODS.has(method);
  const resourceType = input.resourceType ?? '';

  if (!API_RESOURCE_TYPES.has(resourceType)) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (!isMutation && !(input.allowGet === true && method === 'GET')) {
    return { eligible: false, key: '', isMutation: false, volatileValues: createNullRecord<string>() };
  }

  if (input.hasPostData === true && typeof input.postData !== 'string') {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (input.postData !== undefined && typeof input.postData !== 'string') {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (typeof input.postData === 'string' && hasBinaryOrLossyPostData(input.postData)) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (
    input.hasPostData === true &&
    typeof input.postData === 'string' &&
    input.postData.length > 0 &&
    input.requestHeaders !== undefined &&
    !hasRequestContentType(input.requestHeaders)
  ) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (isDisallowedRequestContentType(input.requestHeaders)) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin === 'null' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }

  const queryPairs: Array<[string, string]> = [];
  parsed.searchParams.forEach((val, key) => {
    const lowerKey = key.toLowerCase();
    if (!VOLATILE_QUERY_KEYS.has(lowerKey) && !VOLATILE_QUERY_KEYS.has(normalizeKeyName(key))) {
      queryPairs.push([key, val]);
    }
  });
  queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = queryPairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const rawBody = input.postData ?? '';
  if (textEncoder.encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return { eligible: false, key: '', isMutation, volatileValues: createNullRecord<string>() };
  }

  const volatileValues = createNullRecord<string>();
  let canonicalBody = '';
  const trimmedBody = rawBody.trim();
  if (trimmedBody.length > 0) {
    if (trimmedBody.startsWith('{') || trimmedBody.startsWith('[')) {
      try {
        const parsedJson: unknown = JSON.parse(trimmedBody);
        const normalized = canonicalizeJsonValue(parsedJson, '', volatileValues, 0);
        canonicalBody = JSON.stringify(normalized);
      } catch (err) {
        if (err instanceof JsonDepthExceededError) {
          return {
            eligible: false,
            key: '',
            isMutation,
            volatileValues: createNullRecord<string>(),
          };
        }
        canonicalBody = rawBody;
      }
    } else {
      canonicalBody = rawBody;
    }
  }

  const key = `${method} ${parsed.origin}${parsed.pathname}${canonicalQuery ? `?${canonicalQuery}` : ''} ${canonicalBody}`;
  return {
    eligible: true,
    key,
    isMutation,
    volatileValues,
  };
}

function extractLeafPropertyName(path: string): string {
  const withoutTrailingArray = path.replace(/(\[\d+\])+$/, '');
  const dotIdx = withoutTrailingArray.lastIndexOf('.');
  return dotIdx === -1 ? withoutTrailingArray : withoutTrailingArray.slice(dotIdx + 1);
}

function replaceJsonStrings(
  value: unknown,
  byNormKey: Map<string, Map<string, string>>,
  byValueFallback: Map<string, string>,
  currentVolatileKey: string | null,
  depth = 0,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new JsonDepthExceededError();
  }
  if (typeof value === 'string') {
    if (currentVolatileKey === null) {
      return value;
    }
    return byNormKey.get(currentVolatileKey)?.get(value) ?? byValueFallback.get(value) ?? value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceJsonStrings(item, byNormKey, byValueFallback, currentVolatileKey, depth + 1),
    );
  }
  const obj = value as Record<string, unknown>;
  const out = createNullRecord();
  for (const k of Object.keys(obj)) {
    const norm = normalizeKeyName(k);
    const nextVolatileKey = VOLATILE_JSON_KEYS.has(norm) ? norm : null;
    const remapped = replaceJsonStrings(
      obj[k],
      byNormKey,
      byValueFallback,
      nextVolatileKey,
      depth + 1,
    );
    defineSafeProperty(out, k, remapped);
  }
  return out;
}

/**
 * If Viewport A sent `{ clientBetId: "uuid-A" }` and Viewport B sent `{ clientBetId: "uuid-B" }`,
 * remaps matching string values ONLY under correlation/idempotency keys in the replayed JSON response,
 * while preserving non-correlation fields (`token`, `signature`, `txId`, `nonce`, `balance`, etc.) untouched.
 */
export function remapJsonCorrelationValues(
  bodyText: string,
  primaryVolatiles: Record<string, string>,
  followerVolatiles: Record<string, string>,
): string {
  const byNormKey = new Map<string, Map<string, string>>();
  const byValueFallback = new Map<string, string>();

  for (const path of Object.keys(primaryVolatiles)) {
    if (!Object.hasOwn(primaryVolatiles, path) || !Object.hasOwn(followerVolatiles, path)) {
      continue;
    }
    const primaryVal = primaryVolatiles[path];
    const followerVal = followerVolatiles[path];
    if (
      typeof primaryVal !== 'string' ||
      typeof followerVal !== 'string' ||
      primaryVal.length < 6 ||
      followerVal.length < 6 ||
      followerVal === primaryVal
    ) {
      continue;
    }
    const normKey = normalizeKeyName(extractLeafPropertyName(path));
    if (!VOLATILE_JSON_KEYS.has(normKey)) {
      continue;
    }
    let mapForKey = byNormKey.get(normKey);
    if (!mapForKey) {
      mapForKey = new Map<string, string>();
      byNormKey.set(normKey, mapForKey);
    }
    mapForKey.set(primaryVal, followerVal);
    byValueFallback.set(primaryVal, followerVal);
  }
  if (byValueFallback.size === 0) return bodyText;

  const trimmed = bodyText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return bodyText;
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);
    const remapped = replaceJsonStrings(parsed, byNormKey, byValueFallback, null, 0);
    return JSON.stringify(remapped);
  } catch {
    return bodyText;
  }
}

export function isCacheableDedupStatus(status: number): boolean {
  if (!Number.isInteger(status) || status < 200 || status >= 500) {
    return false;
  }
  if (status >= 300 && status <= 399) {
    return false;
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 407 ||
    status === 408 ||
    status === 429
  ) {
    return false;
  }
  return true;
}

export const isCacheableResponseStatus = isCacheableDedupStatus;

export function shouldSkipResponseBodyFetch(status: number): boolean {
  return status === 204 || status === 205 || status === 304 || (status >= 300 && status <= 399);
}

export const shouldSkipResponseBody = shouldSkipResponseBodyFetch;

export function sanitizeReplayHeaders(
  headers: ReadonlyArray<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const h of headers) {
    if (!h.name) continue;
    if (STRIPPED_REPLAY_HEADERS.has(h.name.toLowerCase())) continue;
    out.push({ name: h.name, value: h.value });
  }
  out.push({ name: 'x-iron-browser-dedup', value: 'replayed' });
  return out;
}

export function isStreamContentType(
  headers: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  for (const h of headers) {
    if (h.name.toLowerCase() === 'content-type') {
      const mime = h.value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!mime) continue;
      if (NON_CACHEABLE_MIME_EXACT.has(mime)) {
        return true;
      }
      for (const prefix of NON_CACHEABLE_MIME_PREFIXES) {
        if (mime.startsWith(prefix)) {
          return true;
        }
      }
    }
  }
  return false;
}

export const isNonCacheableContentType = isStreamContentType;

export function parseContentLengthHeader(
  headers: ReadonlyArray<{ name: string; value: string }>,
): number | null {
  let maxLen: number | null = null;
  for (const h of headers) {
    if (h.name.toLowerCase() === 'content-length') {
      const trimmed = h.value.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isSafeInteger(parsed)) {
          maxLen = maxLen === null ? parsed : Math.max(maxLen, parsed);
        }
      }
    }
  }
  return maxLen;
}

export const getContentLength = parseContentLengthHeader;

export function getContentEncodings(
  headers: ReadonlyArray<{ name: string; value: string }>,
): string[] {
  const encodings: string[] = [];
  for (const h of headers) {
    if (h.name.toLowerCase() === 'content-encoding') {
      for (const part of h.value.split(',')) {
        const enc = part.trim().toLowerCase();
        if (enc && enc !== 'identity') {
          encodings.push(enc);
        }
      }
    }
  }
  return encodings;
}

export function isJsonContentType(
  headers: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  for (const h of headers) {
    if (h.name.toLowerCase() === 'content-type') {
      const mime = h.value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (mime === 'application/json' || mime.endsWith('+json')) {
        return true;
      }
    }
  }
  return false;
}
