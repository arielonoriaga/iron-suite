import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import {
  DebuggerCoordinator,
  type DebuggerLike,
  type DebuggerTarget,
} from '../src/main/debugger-coordinator';
import {
  MAX_QUEUED_PER_KEY,
  MAX_TOTAL_BUFFERED_BYTES,
  MAX_TOTAL_SLOTS,
  RequestDedupMiddleware,
  type DedupViewportContext,
} from '../src/main/request-dedup';
import {
  buildDedupCacheKey,
  canonicalizeDiscriminatingHeaders,
  computeDiscriminatingHeaderDigest,
  getContentEncodings,
  isCacheableDedupStatus,
  isJsonContentType,
  isStreamContentType,
  MAX_BODY_BYTES,
  MAX_REPLAY_BODY_BYTES,
  normalizeRequestForDedup,
  parseAuthoritativeHttpOrigin,
  parseContentLengthHeader,
  parseHttpOrigin,
  remapJsonCorrelationValues,
  sanitizeReplayHeaders,
  shouldSkipResponseBodyFetch,
  VOLATILE_JSON_KEYS,
} from '../src/shared/request-dedup-core';

let nextWcId = 5000;

interface RecordedCommand {
  method: string;
  params?: Record<string, unknown>;
}

class FakeDebugger extends EventEmitter implements DebuggerLike {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  commands: RecordedCommand[] = [];
  mainFrameId = 'frame-main-1';
  commandHandler?: (method: string, params?: Record<string, unknown>) => Promise<unknown> | unknown;
  private commandWaiters: Array<{
    predicate: (cmd: RecordedCommand) => boolean;
    resolve: (cmd: RecordedCommand) => void;
  }> = [];

  isAttached(): boolean {
    return this.attached;
  }

  attach(_version?: string): void {
    this.attachCalls += 1;
    this.attached = true;
  }

  detach(): void {
    this.detachCalls += 1;
    this.attached = false;
  }

  waitForCommand(
    predicate: (cmd: RecordedCommand) => boolean,
    timeoutMs = 1000,
  ): Promise<RecordedCommand> {
    const existing = this.commands.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.commandWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.commandWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for CDP command`));
      }, timeoutMs);
      const wrappedResolve = (cmd: RecordedCommand) => {
        clearTimeout(timer);
        resolve(cmd);
      };
      this.commandWaiters.push({ predicate, resolve: wrappedResolve });
    });
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const rec: RecordedCommand = { method, params };
    this.commands.push(rec);
    for (let i = this.commandWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.commandWaiters[i]!;
      if (waiter.predicate(rec)) {
        this.commandWaiters.splice(i, 1);
        waiter.resolve(rec);
      }
    }
    if (this.commandHandler) {
      return await this.commandHandler(method, params);
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: this.mainFrameId } } };
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter implements DebuggerTarget {
  readonly id = nextWcId++;
  readonly debugger = new FakeDebugger();
  destroyed = false;
  origin: string | null = 'https://app.example.com';
  mainFrameId: string | null = 'frame-main-1';

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let m = 0; m < 6; m += 1) {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function emitRequestPaused(
  wc: FakeWebContents,
  opts: {
    requestId: string;
    networkId?: string;
    frameId?: string;
    resourceType?: string;
    method?: string;
    url?: string;
    postData?: string;
    postDataEntries?: Array<{ bytes?: string }>;
    hasPostData?: boolean;
    headers?: Record<string, string>;
  },
): void {
  wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
    requestId: opts.requestId,
    networkId: opts.networkId ?? `net-${opts.requestId}`,
    frameId: opts.frameId ?? wc.mainFrameId ?? 'frame-main-1',
    resourceType: opts.resourceType ?? 'Fetch',
    request: {
      method: opts.method ?? 'POST',
      url: opts.url ?? 'https://app.example.com/api/bet',
      postData: opts.postData,
      postDataEntries: opts.postDataEntries,
      hasPostData: opts.hasPostData,
      headers: opts.headers ?? { 'content-type': 'application/json' },
    },
  });
}

function emitResponsePaused(
  wc: FakeWebContents,
  opts: {
    requestId: string;
    networkId?: string;
    responseStatusCode?: number;
    responseHeaders?: Array<{ name: string; value: string }>;
    responseErrorReason?: string;
  },
): void {
  wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
    requestId: opts.requestId,
    networkId: opts.networkId ?? `net-${opts.requestId}`,
    responseStatusCode: opts.responseStatusCode ?? 200,
    responseHeaders: opts.responseHeaders ?? [{ name: 'Content-Type', value: 'application/json' }],
    responseErrorReason: opts.responseErrorReason,
  });
}

describe('R2 Request Dedup Core (src/shared/request-dedup-core.ts)', () => {
  test('U-01: rejects GET/OPTIONS/HEAD by default and accepts POST/PUT/PATCH/DELETE on XHR/Fetch only', () => {
    for (const method of ['GET', 'get', 'OPTIONS', 'HEAD']) {
      const res = normalizeRequestForDedup({
        method,
        url: 'https://example.com/api/items',
        resourceType: 'Fetch',
      });
      expect(res.eligible).toBe(false);
    }

    const explicitGet = normalizeRequestForDedup({
      method: 'GET',
      url: 'https://example.com/api/items',
      resourceType: 'XHR',
      allowGet: true,
    });
    expect(explicitGet.eligible).toBe(true);
    expect(explicitGet.isMutation).toBe(false);

    for (const method of ['post', 'PUT', 'patch', 'DELETE']) {
      for (const resourceType of ['XHR', 'Fetch']) {
        const res = normalizeRequestForDedup({
          method,
          url: 'https://example.com/api/items',
          resourceType,
          postData: '{"amount":10}',
        });
        expect(res.eligible).toBe(true);
        expect(res.isMutation).toBe(true);
      }
    }
  });

  test('U-02: rejects empty, undefined, or non-API resourceType on mutations', () => {
    for (const resourceType of [undefined, '', 'Document', 'Ping', 'Script', 'Image', 'Other']) {
      const res = normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/order',
        resourceType,
        postData: '{"ok":true}',
      });
      expect(res.eligible).toBe(false);
    }
  });

  test('U-03: rejects hasPostData without string postData and disallowed request Content-Type', () => {
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/upload',
        resourceType: 'Fetch',
        hasPostData: true,
        postData: undefined,
      }).eligible,
    ).toBe(false);

    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/upload',
        resourceType: 'Fetch',
        hasPostData: true,
        postData: new Uint8Array([1, 2, 3]) as unknown as string,
      }).eligible,
    ).toBe(false);

    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/submit',
        resourceType: 'XHR',
        hasPostData: true,
        postData: '{"ok":true}',
      }).eligible,
    ).toBe(true);

    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/upload',
        resourceType: 'Fetch',
        postData: '--boundary',
        requestHeaders: { 'Content-Type': 'multipart/form-data; boundary=abc' },
      }).eligible,
    ).toBe(false);

    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/bin',
        resourceType: 'Fetch',
        postData: 'rawbytes',
        requestHeaders: { 'content-type': 'application/octet-stream' },
      }).eligible,
    ).toBe(false);

    // Binary control bytes (\x00, \x01..\x08, \x0b, \x0c, \x0e..\x1f) and lossy UTF-8 replacement (\uFFFD) fail open
    for (const badPostData of [
      '\x01\x02\x03\x04',
      'abc\x00def',
      '\x0bvertical-tab',
      '\ufffd\x00\ufffd\x01',
    ]) {
      expect(
        normalizeRequestForDedup({
          method: 'POST',
          url: 'https://example.com/bin',
          resourceType: 'Fetch',
          hasPostData: true,
          postData: badPostData,
          requestHeaders: { 'content-type': 'text/plain;charset=UTF-8' },
        }).eligible,
      ).toBe(false);
    }

    // Allowed whitespace (\t, \n, \r) in valid JSON/text remains eligible when Content-Type is present
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/submit',
        resourceType: 'Fetch',
        hasPostData: true,
        postData: '{\n\t"ok": true\r\n}',
        requestHeaders: { 'content-type': 'application/json' },
      }).eligible,
    ).toBe(true);

    // hasPostData === true with non-empty body and requestHeaders present but missing Content-Type
    // (Chromium Uint8Array / ArrayBuffer / untyped Blob) fails open
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/mutate',
        resourceType: 'Fetch',
        hasPostData: true,
        postData: 'ABCD',
        requestHeaders: { accept: '*/*' },
      }).eligible,
    ).toBe(false);
  });

  test('U-04: rejects non-HTTP(S) URLs, embedded credentials, and >256KB postData', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/plain,hello',
      'blob:https://example.com/123',
      'about:blank',
      'ws://example.com/socket',
      'javascript:alert(1)',
      'https://user:secret@example.com/api',
      'http://admin@localhost:3000/api',
    ]) {
      expect(
        normalizeRequestForDedup({
          method: 'POST',
          url,
          resourceType: 'Fetch',
          postData: '{}',
        }).eligible,
      ).toBe(false);
    }

    const exact = 'a'.repeat(MAX_BODY_BYTES);
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api',
        resourceType: 'Fetch',
        postData: exact,
      }).eligible,
    ).toBe(true);

    // Multi-byte UTF-8 exceeds 256KB even with fewer characters
    const multiByteOver = '€'.repeat(Math.ceil(MAX_BODY_BYTES / 3) + 1);
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api',
        resourceType: 'Fetch',
        postData: multiByteOver,
      }).eligible,
    ).toBe(false);
  });

  test('U-05: canonicalizes query params, strips fragments/default ports/volatile query keys, preserves nonce, and sorts JSON keys', () => {
    const a = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com:443/api/bet?b=2&_=111&a=1&ts=222&requestId=r1#frag',
      resourceType: 'Fetch',
      postData: JSON.stringify({ z: 1, nested: { d: 4, c: 3 }, a: 'hello' }),
    });
    const b = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/bet?a=1&b=2&cachebust=999&idempotencyKey=k2',
      resourceType: 'XHR',
      postData: JSON.stringify({ nested: { c: 3, d: 4 }, a: 'hello', z: 1 }),
    });
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(true);
    expect(a.key).toBe(b.key);

    // Nonce in query params must remain distinct
    const n1 = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/auth?nonce=aaa',
      resourceType: 'Fetch',
    });
    const n2 = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/auth?nonce=bbb',
      resourceType: 'Fetch',
    });
    expect(n1.key).not.toBe(n2.key);
  });

  test('U-06: VOLATILE_JSON_KEYS keeps txId/transactionId/createdAt/nonce distinct and strips all 12 correlation keys', () => {
    expect(VOLATILE_JSON_KEYS.has('txid')).toBe(false);
    expect(VOLATILE_JSON_KEYS.has('transactionid')).toBe(false);
    expect(VOLATILE_JSON_KEYS.has('createdat')).toBe(false);
    expect(VOLATILE_JSON_KEYS.has('nonce')).toBe(false);

    for (const nonVolatile of ['txId', 'transactionId', 'createdAt', 'nonce']) {
      const r1 = normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/tx',
        resourceType: 'Fetch',
        postData: JSON.stringify({ [nonVolatile]: 'value-alpha-123' }),
      });
      const r2 = normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/tx',
        resourceType: 'Fetch',
        postData: JSON.stringify({ [nonVolatile]: 'value-bravo-456' }),
      });
      expect(r1.key).not.toBe(r2.key);
    }

    const twelveKeys = [
      'idempotencyKey',
      'clientRequestId',
      'requestId',
      'clientBetId',
      'clientTxId',
      'correlationId',
      'traceId',
      'timestamp',
      'ts',
      'clientTime',
      'clientTimestamp',
      'sentAt',
    ];
    expect(VOLATILE_JSON_KEYS.size).toBe(12);

    const payloadA: Record<string, string> = {};
    const payloadB: Record<string, string> = {};
    for (const k of twelveKeys) {
      payloadA[k] = `primary-${k}-value`;
      payloadB[k] = `follower-${k}-value`;
    }
    const normA = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/play',
      resourceType: 'Fetch',
      postData: JSON.stringify(payloadA),
    });
    const normB = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/play',
      resourceType: 'Fetch',
      postData: JSON.stringify(payloadB),
    });
    expect(normA.key).toBe(normB.key);
    for (const k of twelveKeys) {
      expect(normA.volatileValues[k]).toBe(`primary-${k}-value`);
      expect(normB.volatileValues[k]).toBe(`follower-${k}-value`);
    }
  });

  test('U-07: remapJsonCorrelationValues is strictly key-scoped and leaves non-correlation keys untouched', () => {
    const sharedToken = 'shared-secret-token-12345';
    const primaryNorm = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/play',
      resourceType: 'Fetch',
      postData: JSON.stringify({
        nested: { idempotencyKey: sharedToken },
        clientRequestId: 'req-primary-999',
      }),
    });
    const followerNorm = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/play',
      resourceType: 'Fetch',
      postData: JSON.stringify({
        nested: { idempotencyKey: 'follower-idem-67890' },
        clientRequestId: 'req-follower-111',
      }),
    });

    const responseJson = JSON.stringify({
      data: {
        correlation: {
          idempotencyKey: sharedToken,
        },
        clientRequestId: 'req-primary-999',
      },
      token: sharedToken,
      authToken: 'req-primary-999',
      signature: sharedToken,
      txId: sharedToken,
      nonce: sharedToken,
      balance: 500,
      ok: true,
      note: null,
      rawArray: [sharedToken],
    });

    const remapped = JSON.parse(
      remapJsonCorrelationValues(responseJson, primaryNorm.volatileValues, followerNorm.volatileValues),
    ) as Record<string, unknown>;

    const data = remapped.data as Record<string, unknown>;
    expect((data.correlation as Record<string, unknown>).idempotencyKey).toBe('follower-idem-67890');
    expect(data.clientRequestId).toBe('req-follower-111');
    expect(remapped.token).toBe(sharedToken);
    expect(remapped.authToken).toBe('req-primary-999');
    expect(remapped.signature).toBe(sharedToken);
    expect(remapped.txId).toBe(sharedToken);
    expect(remapped.nonce).toBe(sharedToken);
    expect(remapped.balance).toBe(500);
    expect(remapped.ok).toBe(true);
    expect(remapped.note).toBeNull();
    expect(remapped.rawArray).toEqual([sharedToken]);
  });

  test('U-08: enforces MAX_JSON_DEPTH = 32 and prevents __proto__/constructor prototype pollution', () => {
    const buildNested = (levels: number, leaf: unknown): unknown => {
      let cur = leaf;
      for (let i = 0; i < levels; i += 1) {
        cur = { a: cur };
      }
      return cur;
    };

    const ok32 = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/deep',
      resourceType: 'Fetch',
      postData: JSON.stringify(buildNested(32, 'ok')),
    });
    expect(ok32.eligible).toBe(true);

    for (const badDepth of [33, 35]) {
      const bad = normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/deep',
        resourceType: 'Fetch',
        postData: JSON.stringify(buildNested(badDepth, 'too-deep')),
      });
      expect(bad.eligible).toBe(false);
    }

    // Deeply nested value inside a volatile key must also respect MAX_JSON_DEPTH
    expect(
      normalizeRequestForDedup({
        method: 'POST',
        url: 'https://example.com/api/deep',
        resourceType: 'Fetch',
        postData: JSON.stringify({ idempotencyKey: buildNested(34, 'deep-volatile') }),
      }).eligible,
    ).toBe(false);

    // Depth > 32 in remapJsonCorrelationValues fails open returning input unchanged
    const deepResp = JSON.stringify(buildNested(33, { idempotencyKey: 'primary-val-123' }));
    expect(
      remapJsonCorrelationValues(
        deepResp,
        { idempotencyKey: 'primary-val-123' },
        { idempotencyKey: 'follower-val-456' },
      ),
    ).toBe(deepResp);

    // Prototype pollution payloads must not pollute Object.prototype or throw
    const protoPayload = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"pwned":1}},"idempotencyKey":"idem-abc-123"}';
    const protoNorm = normalizeRequestForDedup({
      method: 'POST',
      url: 'https://example.com/api/proto',
      resourceType: 'Fetch',
      postData: protoPayload,
    });
    expect(protoNorm.eligible).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    expect(protoNorm.key).toContain('"__proto__"');

    const remappedProto = remapJsonCorrelationValues(
      '{"__proto__":{"polluted":true},"idempotencyKey":"idem-abc-123"}',
      { idempotencyKey: 'idem-abc-123' },
      { idempotencyKey: 'idem-xyz-999' },
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(remappedProto).toContain('idem-xyz-999');
  });

  test('U-09: parseAuthoritativeHttpOrigin and parseHttpOrigin enforce strict non-opaque HTTP(S) origins', () => {
    expect(parseAuthoritativeHttpOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(parseAuthoritativeHttpOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');

    for (const bad of [
      null,
      undefined,
      '',
      'null',
      'file://',
      'file:///etc/passwd',
      'about:blank',
      'data:text/html,hi',
      'blob:https://example.com/1',
      'https://example.com/',
      'https://example.com/path',
      'https://user:pass@example.com',
      'https://example.com?a=1',
      'https://example.com#hash',
    ]) {
      expect(parseAuthoritativeHttpOrigin(bad)).toBeNull();
    }

    expect(parseHttpOrigin('https://app.example.com:8443/api/v1?x=1')).toBe('https://app.example.com:8443');
    expect(parseHttpOrigin('https://user:pass@app.example.com/api')).toBeNull();
    expect(parseHttpOrigin('file:///tmp/index.html')).toBeNull();
  });

  test('U-10: computeDiscriminatingHeaderDigest is case-insensitive, multi-value aware, distinguishes absent vs empty, and matches node:crypto SHA-256', () => {
    const h1 = computeDiscriminatingHeaderDigest({
      Authorization: 'Bearer tok',
      'X-CSRF-Token': 'csrf-1',
      'User-Agent': 'UA-1',
      'X-Custom': 'foo',
    });
    const h2 = computeDiscriminatingHeaderDigest([
      { name: 'authorization', value: 'Bearer tok' },
      { name: 'x-csrf-token', value: 'csrf-1' },
      { name: 'user-agent', value: 'UA-2' },
    ]);
    expect(h1).toBe(h2);

    const expectedNodeSha = crypto
      .createHash('sha256')
      .update(
        canonicalizeDiscriminatingHeaders({
          Authorization: 'Bearer tok',
          'X-CSRF-Token': 'csrf-1',
        }),
      )
      .digest('hex');
    expect(h1).toBe(expectedNodeSha);

    // Absent vs empty string must differ
    expect(computeDiscriminatingHeaderDigest({})).not.toBe(
      computeDiscriminatingHeaderDigest({ 'x-csrf-token': '' }),
    );

    // Multi-value / duplicate headers
    expect(
      computeDiscriminatingHeaderDigest([
        { name: 'Accept', value: 'application/json' },
        { name: 'accept', value: 'text/plain' },
      ]),
    ).toBe(computeDiscriminatingHeaderDigest({ accept: 'application/json, text/plain' }));

    // Every one of the 11 discriminating headers affects digest
    const base = computeDiscriminatingHeaderDigest({});
    for (const hdr of [
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
    ]) {
      expect(computeDiscriminatingHeaderDigest({ [hdr]: 'val' })).not.toBe(base);
    }

    const cacheKey = buildDedupCacheKey({
      tabId: 'tab-1',
      initiatorOrigin: 'https://app.example.com',
      headerDigest: h1,
      normalizedKey: 'POST https://app.example.com/api {}',
    });
    expect(cacheKey).toBe(`tab-1::https://app.example.com::${h1}::POST https://app.example.com/api {}`);
  });

  test('U-11: response status, body-skip, streaming/binary MIME, Content-Length, Content-Encoding, and header sanitization rules', () => {
    expect(isCacheableDedupStatus(200)).toBe(true);
    expect(isCacheableDedupStatus(201)).toBe(true);
    expect(isCacheableDedupStatus(204)).toBe(true);
    expect(isCacheableDedupStatus(205)).toBe(true);
    expect(isCacheableDedupStatus(400)).toBe(true);
    expect(isCacheableDedupStatus(404)).toBe(true);

    for (const nonCacheable of [100, 301, 302, 304, 307, 401, 403, 407, 408, 429, 500, 502, 503]) {
      expect(isCacheableDedupStatus(nonCacheable)).toBe(false);
    }

    expect(shouldSkipResponseBodyFetch(204)).toBe(true);
    expect(shouldSkipResponseBodyFetch(205)).toBe(true);
    expect(shouldSkipResponseBodyFetch(304)).toBe(true);
    expect(shouldSkipResponseBodyFetch(302)).toBe(true);
    expect(shouldSkipResponseBodyFetch(200)).toBe(false);

    for (const mime of [
      'text/event-stream',
      'application/grpc',
      'application/grpc+proto',
      'application/x-ndjson',
      'application/ndjson',
      'application/octet-stream',
      'application/wasm',
      'audio/mpeg',
      'video/mp4',
      'image/png',
      'multipart/mixed; boundary=x',
    ]) {
      expect(isStreamContentType([{ name: 'Content-Type', value: mime }])).toBe(true);
    }
    expect(isStreamContentType([{ name: 'Content-Type', value: 'application/json; charset=utf-8' }])).toBe(false);
    expect(isJsonContentType([{ name: 'content-type', value: 'application/problem+json; charset=utf-8' }])).toBe(true);

    expect(parseContentLengthHeader([{ name: 'Content-Length', value: String(MAX_REPLAY_BODY_BYTES + 1) }])).toBe(
      MAX_REPLAY_BODY_BYTES + 1,
    );
    expect(parseContentLengthHeader([{ name: 'Content-Length', value: 'invalid' }])).toBeNull();
    expect(getContentEncodings([{ name: 'Content-Encoding', value: 'gzip, identity, br' }])).toEqual([
      'gzip',
      'br',
    ]);

    const sanitized = sanitizeReplayHeaders([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Set-Cookie', value: 'sid=abc' },
      { name: 'Content-Length', value: '123' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'X-Iron-Browser-Dedup', value: 'spoofed' },
      { name: 'X-Request-Trace', value: 'keep-me' },
    ]);
    expect(sanitized).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Request-Trace', value: 'keep-me' },
      { name: 'x-iron-browser-dedup', value: 'replayed' },
    ]);
  });
});

describe('R2 RequestDedupMiddleware Mock-CDP Integration (src/main/request-dedup.ts)', () => {
  const disposables: Array<{ dispose(): void }> = [];

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
  });

  function setupPairedRig(opts?: {
    ttlMs?: number;
    inflightWaitTimeoutMs?: number;
    bodyFetchTimeoutMs?: number;
    useFallbackMainFrameId?: boolean;
  }) {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeWebContents();
    const landscape = new FakeWebContents();
    const contexts = new Map<number, DedupViewportContext<FakeWebContents>>([
      [
        portrait.id,
        {
          tabId: 'tab-1',
          active: true,
          pairedWc: landscape,
          getOrigin: (w) => w.origin,
          getMainFrameId: opts?.useFallbackMainFrameId ? () => null : (w) => w.mainFrameId,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-1',
          active: true,
          pairedWc: portrait,
          getOrigin: (w) => w.origin,
          getMainFrameId: opts?.useFallbackMainFrameId ? () => null : (w) => w.mainFrameId,
        },
      ],
    ]);

    const increments: Array<{ wcId: number; delta: number }> = [];
    const dedup = new RequestDedupMiddleware<FakeWebContents>(coordinator, {
      resolveViewportContext: (wcId) => contexts.get(wcId) ?? null,
      onDedupIncrement: (wcId, delta) => increments.push({ wcId, delta }),
      ttlMs: opts?.ttlMs,
      inflightWaitTimeoutMs: opts?.inflightWaitTimeoutMs,
      bodyFetchTimeoutMs: opts?.bodyFetchTimeoutMs,
    });
    disposables.push(dedup);

    return { coordinator, portrait, landscape, contexts, dedup, increments };
  }

  test('M-01: enforces ctx.active, mainFrameId, non-opaque origin parity, discriminating headers, and tab isolation', async () => {
    const { portrait, landscape, contexts, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    // 1. ctx.active === false fails open
    contexts.get(portrait.id)!.active = false;
    emitRequestPaused(portrait, { requestId: 'r-inactive', postData: '{"a":1}' });
    await flushMicrotasks();
    expect(portrait.debugger.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'r-inactive')).toBe(true);
    expect(dedup.getActiveSlotCount()).toBe(0);
    contexts.get(portrait.id)!.active = true;

    // 2. frameId !== mainFrameId fails open
    emitRequestPaused(portrait, { requestId: 'r-iframe', frameId: 'subframe-99', postData: '{"a":1}' });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(0);

    // 3. Opaque 'null' or mismatched origin fails open
    portrait.origin = 'null';
    emitRequestPaused(portrait, { requestId: 'r-opaque', postData: '{"a":1}' });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(0);

    portrait.origin = 'https://app.example.com';
    landscape.origin = 'https://evil.example.com';
    emitRequestPaused(portrait, { requestId: 'r-cross-origin', postData: '{"a":1}' });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(0);
    landscape.origin = 'https://app.example.com';

    // 4. Differing Authorization/X-CSRF-Token headers do not collide
    emitRequestPaused(portrait, {
      requestId: 'r-auth-1',
      postData: '{"bet":10}',
      headers: { authorization: 'Bearer user-A', 'x-csrf-token': 't1' },
    });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(1);

    emitRequestPaused(landscape, {
      requestId: 'r-auth-2',
      postData: '{"bet":10}',
      headers: { authorization: 'Bearer user-B', 'x-csrf-token': 't1' },
    });
    await flushMicrotasks();
    expect(
      landscape.debugger.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'r-auth-2'),
    ).toBe(true);
    expect(
      landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest'),
    ).toBe(false);

    // 5. Cross-tab isolation
    const coordinator2 = new DebuggerCoordinator();
    const tab2A = new FakeWebContents();
    const tab2B = new FakeWebContents();
    const sharedCtx = new Map<number, DedupViewportContext<FakeWebContents>>([
      [portrait.id, contexts.get(portrait.id)!],
      [landscape.id, contexts.get(landscape.id)!],
      [
        tab2A.id,
        {
          tabId: 'tab-2',
          active: true,
          pairedWc: tab2B,
          getOrigin: (w) => w.origin,
          getMainFrameId: (w) => w.mainFrameId,
        },
      ],
      [
        tab2B.id,
        {
          tabId: 'tab-2',
          active: true,
          pairedWc: tab2A,
          getOrigin: (w) => w.origin,
          getMainFrameId: (w) => w.mainFrameId,
        },
      ],
    ]);
    const crossDedup = new RequestDedupMiddleware<FakeWebContents>(coordinator2, {
      resolveViewportContext: (id) => sharedCtx.get(id) ?? null,
    });
    disposables.push(crossDedup);
    await crossDedup.setViewportEnabled(portrait, true);
    await crossDedup.setViewportEnabled(tab2B, true);

    emitRequestPaused(portrait, { requestId: 'r-tab1', postData: '{"bet":5}' });
    await flushMicrotasks();
    emitRequestPaused(tab2B, { requestId: 'r-tab2', postData: '{"bet":5}' });
    await flushMicrotasks();
    expect(tab2B.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);
    expect(tab2B.debugger.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'r-tab2')).toBe(true);
  });

  test('M-02: post-await re-check fails open if ctx.active becomes false or pairedWc origin changes mid-flight', async () => {
    const { portrait, landscape, contexts, dedup, increments } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: JSON.stringify({ ok: true }), base64Encoded: false };
      }
      return {};
    };

    // Case A: ctx.active flips to false while follower awaits
    emitRequestPaused(portrait, { requestId: 'p1', networkId: 'n1', postData: '{"x":1}' });
    await flushMicrotasks();
    emitRequestPaused(landscape, { requestId: 'f1', networkId: 'nf1', postData: '{"x":1}' });
    await flushMicrotasks();

    contexts.get(landscape.id)!.active = false;
    emitResponsePaused(portrait, { requestId: 'p1', networkId: 'n1', responseStatusCode: 200 });
    await flushMicrotasks(15);

    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);
    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f1')).toBe(true);
    expect(increments.length).toBe(0);

    // Case B: pairedWc navigates to another origin while follower awaits
    contexts.get(landscape.id)!.active = true;
    emitRequestPaused(portrait, { requestId: 'p2', networkId: 'n2', postData: '{"x":2}' });
    await flushMicrotasks();
    emitRequestPaused(landscape, { requestId: 'f2', networkId: 'nf2', postData: '{"x":2}' });
    await flushMicrotasks();

    portrait.origin = 'https://other.example.com';
    emitResponsePaused(portrait, { requestId: 'p2', networkId: 'n2', responseStatusCode: 200 });
    await flushMicrotasks(15);

    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);
    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f2')).toBe(true);
    expect(dedup.getTabDedupCount('tab-1')).toBe(0);
  });

  test('M-03: symmetric first-wins and synchronous FIFO claim prevents double replay on concurrent followers', async () => {
    const { portrait, landscape, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    const responseHandler = async (method: string) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: JSON.stringify({ win: 100 }), base64Encoded: false };
      }
      return {};
    };
    portrait.debugger.commandHandler = responseHandler;
    landscape.debugger.commandHandler = responseHandler;

    // Landscape-first wins symmetrically
    emitRequestPaused(landscape, { requestId: 'l-primary', networkId: 'nl1', postData: '{"spin":1}' });
    await flushMicrotasks();
    emitResponsePaused(landscape, { requestId: 'l-primary', networkId: 'nl1', responseStatusCode: 200 });
    await flushMicrotasks();

    emitRequestPaused(portrait, { requestId: 'p-follow', networkId: 'np1', postData: '{"spin":1}' });
    await flushMicrotasks(15);

    expect(portrait.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest' && c.params?.requestId === 'p-follow')).toBe(true);
    expect(dedup.getTabDedupCount('tab-1')).toBe(1);

    // Concurrent claim race: Portrait sends 1 primary; Landscape sends 2 concurrent matching mutations while primary is in-flight
    emitRequestPaused(portrait, { requestId: 'p-race-1', networkId: 'nr1', postData: '{"spin":2}' });
    await flushMicrotasks();

    emitRequestPaused(landscape, { requestId: 'l-follow-a', networkId: 'nfa', postData: '{"spin":2}' });
    emitRequestPaused(landscape, { requestId: 'l-follow-b', networkId: 'nfb', postData: '{"spin":2}' });
    await flushMicrotasks();

    emitResponsePaused(portrait, { requestId: 'p-race-1', networkId: 'nr1', responseStatusCode: 200 });
    await flushMicrotasks(15);

    const fulfills = landscape.debugger.commands.filter((c) => c.method === 'Fetch.fulfillRequest');
    const continues = landscape.debugger.commands.filter(
      (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'l-follow-b',
    );
    expect(fulfills.length).toBe(1);
    expect(fulfills[0]?.params?.requestId).toBe('l-follow-a');
    expect(continues.length).toBe(1);
    expect(dedup.getTabDedupCount('tab-1')).toBe(2);
  });

  test('M-04: per-key FIFO queue replays 4 rapid identical mutations 1:1 with correlation remapping and fails open on 5th', async () => {
    const { portrait, landscape, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    const bodyByRequestId = new Map<string, string>();
    portrait.debugger.commandHandler = async (method, params) => {
      if (method === 'Fetch.getResponseBody') {
        const reqId = String(params?.requestId ?? '');
        return {
          body: bodyByRequestId.get(reqId) ?? '{}',
          base64Encoded: false,
        };
      }
      return {};
    };

    // 5 rapid identical mutations on Portrait (cap = 4)
    for (let i = 1; i <= 5; i += 1) {
      const reqId = `p-${i}`;
      bodyByRequestId.set(
        reqId,
        JSON.stringify({ seq: i, idempotencyKey: `primary-key-${i}`, serverRoundId: `srv-${i}` }),
      );
      emitRequestPaused(portrait, {
        requestId: reqId,
        networkId: `np-${i}`,
        postData: JSON.stringify({ amount: 10, idempotencyKey: `primary-key-${i}` }),
      });
      await flushMicrotasks();
    }

    // Complete responses for slots 1..4
    for (let i = 1; i <= 4; i += 1) {
      emitResponsePaused(portrait, { requestId: `p-${i}`, networkId: `np-${i}`, responseStatusCode: 200 });
      await flushMicrotasks();
    }

    // 5 rapid matching mutations on Landscape: 1..4 replay in FIFO order, 5 fails open
    for (let i = 1; i <= MAX_QUEUED_PER_KEY + 1; i += 1) {
      emitRequestPaused(landscape, {
        requestId: `l-${i}`,
        networkId: `nl-${i}`,
        postData: JSON.stringify({ amount: 10, idempotencyKey: `follower-key-${i}` }),
      });
      await flushMicrotasks();
    }

    const fulfills = landscape.debugger.commands.filter((c) => c.method === 'Fetch.fulfillRequest');
    expect(fulfills.length).toBe(4);
    for (let i = 1; i <= 4; i += 1) {
      const fulfill = fulfills[i - 1]!;
      expect(fulfill.params?.requestId).toBe(`l-${i}`);
      const parsedBody = JSON.parse(
        Buffer.from(String(fulfill.params?.body ?? ''), 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      expect(parsedBody.seq).toBe(i);
      expect(parsedBody.idempotencyKey).toBe(`follower-key-${i}`);
      expect(parsedBody.serverRoundId).toBe(`srv-${i}`);
    }

    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'l-5',
      ),
    ).toBe(true);
    expect(dedup.getTabDedupCount('tab-1')).toBe(4);
  });

  test('M-05: decompresses gzip, x-gzip, br, deflate, and chained gzip+br; fails open on malformed/unknown/zip-bomb', async () => {
    const { portrait, landscape, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    const payloadObj = { ok: true, clientRequestId: 'primary-req-1234', token: 'primary-req-1234' };
    const plainBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');

    const cases: Array<{ encoding: string; compressed: Buffer }> = [
      { encoding: 'gzip', compressed: zlib.gzipSync(plainBuf) },
      { encoding: 'x-gzip', compressed: zlib.gzipSync(plainBuf) },
      { encoding: 'br', compressed: zlib.brotliCompressSync(plainBuf) },
      { encoding: 'deflate', compressed: zlib.deflateSync(plainBuf) },
      { encoding: 'deflate', compressed: zlib.deflateRawSync(plainBuf) },
      { encoding: 'gzip, br', compressed: zlib.brotliCompressSync(zlib.gzipSync(plainBuf)) },
    ];

    let idx = 0;
    for (const c of cases) {
      idx += 1;
      const reqP = `p-enc-${idx}`;
      const reqF = `f-enc-${idx}`;
      portrait.debugger.commandHandler = async (method) => {
        if (method === 'Fetch.getResponseBody') {
          return { body: c.compressed.toString('base64'), base64Encoded: true };
        }
        return {};
      };

      emitRequestPaused(portrait, {
        requestId: reqP,
        postData: JSON.stringify({ op: idx, clientRequestId: 'primary-req-1234' }),
      });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: reqP,
        responseStatusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Content-Encoding', value: c.encoding },
          { name: 'Set-Cookie', value: 'secret=1' },
        ],
      });
      await flushMicrotasks();

      emitRequestPaused(landscape, {
        requestId: reqF,
        postData: JSON.stringify({ op: idx, clientRequestId: 'follower-req-9999' }),
      });
      await flushMicrotasks(15);

      const fulfill = landscape.debugger.commands.find(
        (cmd) => cmd.method === 'Fetch.fulfillRequest' && cmd.params?.requestId === reqF,
      );
      expect(fulfill).toBeDefined();
      const hdrs = fulfill!.params?.responseHeaders as Array<{ name: string; value: string }>;
      expect(hdrs.some((h) => h.name.toLowerCase() === 'content-encoding')).toBe(false);
      expect(hdrs.some((h) => h.name.toLowerCase() === 'set-cookie')).toBe(false);
      expect(hdrs.some((h) => h.name === 'x-iron-browser-dedup' && h.value === 'replayed')).toBe(true);

      const replayedJson = JSON.parse(
        Buffer.from(String(fulfill!.params?.body ?? ''), 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      expect(replayedJson.clientRequestId).toBe('follower-req-9999');
      expect(replayedJson.token).toBe('primary-req-1234');
    }

    // Malformed gzip, unknown encoding zstd, and >2MB zip bomb all fail open
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_REPLAY_BODY_BYTES + 1024, 0x41));
    const badCases: Array<{ encoding: string; compressed: Buffer }> = [
      { encoding: 'gzip', compressed: Buffer.from('not-valid-gzip-data') },
      { encoding: 'zstd', compressed: Buffer.from('zstd-data') },
      { encoding: 'gzip', compressed: bomb },
    ];
    for (const bad of badCases) {
      idx += 1;
      const reqP = `p-bad-${idx}`;
      const reqF = `f-bad-${idx}`;
      portrait.debugger.commandHandler = async (method) => {
        if (method === 'Fetch.getResponseBody') {
          return { body: bad.compressed.toString('base64'), base64Encoded: true };
        }
        return {};
      };

      emitRequestPaused(portrait, { requestId: reqP, postData: JSON.stringify({ bad: idx }) });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: reqP,
        responseStatusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Content-Encoding', value: bad.encoding },
        ],
      });
      await flushMicrotasks();

      emitRequestPaused(landscape, { requestId: reqF, postData: JSON.stringify({ bad: idx }) });
      await flushMicrotasks(15);

      expect(
        landscape.debugger.commands.some(
          (cmd) => cmd.method === 'Fetch.fulfillRequest' && cmd.params?.requestId === reqF,
        ),
      ).toBe(false);
      expect(
        landscape.debugger.commands.some(
          (cmd) => cmd.method === 'Fetch.continueRequest' && cmd.params?.requestId === reqF,
        ),
      ).toBe(true);
    }

    // Chromium 134 / Electron 35 Fetch.getResponseBody may return already-decompressed bytes
    // while Content-Encoding (gzip, br, deflate) remains in responseHeaders.
    for (const enc of ['gzip', 'br', 'deflate'] as const) {
      for (const base64Encoded of [true, false] as const) {
        idx += 1;
        const reqP = `p-predec-${idx}`;
        const reqF = `f-predec-${idx}`;
        const preDecodedBody = JSON.stringify({
          ok: true,
          enc,
          clientRequestId: 'primary-predec-1',
          token: 'primary-predec-1',
        });
        portrait.debugger.commandHandler = async (method) => {
          if (method === 'Fetch.getResponseBody') {
            return {
              body: base64Encoded
                ? Buffer.from(preDecodedBody, 'utf8').toString('base64')
                : preDecodedBody,
              base64Encoded,
            };
          }
          return {};
        };

        emitRequestPaused(portrait, {
          requestId: reqP,
          postData: JSON.stringify({ predec: idx, clientRequestId: 'primary-predec-1' }),
        });
        await flushMicrotasks();
        emitResponsePaused(portrait, {
          requestId: reqP,
          responseStatusCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Content-Encoding', value: enc },
          ],
        });
        await flushMicrotasks();

        emitRequestPaused(landscape, {
          requestId: reqF,
          postData: JSON.stringify({ predec: idx, clientRequestId: 'follower-predec-2' }),
        });
        await flushMicrotasks(15);

        const fulfill = landscape.debugger.commands.find(
          (cmd) => cmd.method === 'Fetch.fulfillRequest' && cmd.params?.requestId === reqF,
        );
        expect(fulfill).toBeDefined();
        const hdrs = fulfill!.params?.responseHeaders as Array<{ name: string; value: string }>;
        expect(hdrs.some((h) => h.name.toLowerCase() === 'content-encoding')).toBe(false);
        expect(hdrs.some((h) => h.name === 'x-iron-browser-dedup' && h.value === 'replayed')).toBe(true);
        const replayedJson = JSON.parse(
          Buffer.from(String(fulfill!.params?.body ?? ''), 'base64').toString('utf8'),
        ) as Record<string, unknown>;
        expect(replayedJson.enc).toBe(enc);
        expect(replayedJson.clientRequestId).toBe('follower-predec-2');
        expect(replayedJson.token).toBe('primary-predec-1');
      }
    }

    // Corrupt gzip magic bytes (0x1f 0x8b) must still fail open even if Content-Type is JSON.
    idx += 1;
    const reqCorruptMagicP = `p-magic-${idx}`;
    const reqCorruptMagicF = `f-magic-${idx}`;
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        return {
          body: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x7b, 0x7d]).toString('base64'),
          base64Encoded: true,
        };
      }
      return {};
    };
    emitRequestPaused(portrait, { requestId: reqCorruptMagicP, postData: JSON.stringify({ badMagic: true }) });
    await flushMicrotasks();
    emitResponsePaused(portrait, {
      requestId: reqCorruptMagicP,
      responseStatusCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Encoding', value: 'gzip' },
      ],
    });
    await flushMicrotasks();
    emitRequestPaused(landscape, { requestId: reqCorruptMagicF, postData: JSON.stringify({ badMagic: true }) });
    await flushMicrotasks(15);
    expect(
      landscape.debugger.commands.some(
        (cmd) => cmd.method === 'Fetch.fulfillRequest' && cmd.params?.requestId === reqCorruptMagicF,
      ),
    ).toBe(false);
    expect(
      landscape.debugger.commands.some(
        (cmd) => cmd.method === 'Fetch.continueRequest' && cmd.params?.requestId === reqCorruptMagicF,
      ),
    ).toBe(true);

    expect(dedup.getTabDedupCount('tab-1')).toBe(12);
  });

  test('M-06: fail-open on 3xx/401/403/407/408/429/5xx, >2MB, and streaming MIME; skips getResponseBody on 204/205/304/3xx', async () => {
    const { portrait, landscape, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    let getBodyCalls = 0;
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        getBodyCalls += 1;
        return { body: 'a'.repeat(MAX_REPLAY_BODY_BYTES + 10), base64Encoded: false };
      }
      return {};
    };

    // 1. 204 and 205 replay without calling Fetch.getResponseBody and without body property
    for (const status of [204, 205]) {
      emitRequestPaused(portrait, { requestId: `p-${status}`, postData: JSON.stringify({ s: status }) });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: `p-${status}`,
        responseStatusCode: status,
        responseHeaders: [],
      });
      await flushMicrotasks();

      emitRequestPaused(landscape, { requestId: `f-${status}`, postData: JSON.stringify({ s: status }) });
      await flushMicrotasks(15);

      const fulfill = landscape.debugger.commands.find(
        (c) => c.method === 'Fetch.fulfillRequest' && c.params?.requestId === `f-${status}`,
      );
      expect(fulfill).toBeDefined();
      expect(fulfill!.params?.responseCode).toBe(status);
      expect('body' in (fulfill!.params ?? {})).toBe(false);
    }
    expect(getBodyCalls).toBe(0);

    // 2. 302, 304, 401, 403, 407, 408, 429, 500 fail open without calling getResponseBody
    for (const badStatus of [302, 304, 401, 403, 407, 408, 429, 500]) {
      emitRequestPaused(portrait, {
        requestId: `p-err-${badStatus}`,
        postData: JSON.stringify({ err: badStatus }),
      });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: `p-err-${badStatus}`,
        responseStatusCode: badStatus,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      });
      await flushMicrotasks();

      emitRequestPaused(landscape, {
        requestId: `f-err-${badStatus}`,
        postData: JSON.stringify({ err: badStatus }),
      });
      await flushMicrotasks(15);

      expect(
        landscape.debugger.commands.some(
          (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === `f-err-${badStatus}`,
        ),
      ).toBe(true);
    }
    expect(getBodyCalls).toBe(0);

    // 3. Content-Length > 2MB skips getResponseBody and fails open
    emitRequestPaused(portrait, { requestId: 'p-cl', postData: '{"cl":1}' });
    await flushMicrotasks();
    emitResponsePaused(portrait, {
      requestId: 'p-cl',
      responseStatusCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Length', value: String(MAX_REPLAY_BODY_BYTES + 1) },
      ],
    });
    await flushMicrotasks();
    expect(getBodyCalls).toBe(0);

    // 4. Streaming / binary MIME skips getResponseBody and fails open
    emitRequestPaused(portrait, { requestId: 'p-sse', postData: '{"sse":1}' });
    await flushMicrotasks();
    emitResponsePaused(portrait, {
      requestId: 'p-sse',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }],
    });
    await flushMicrotasks();
    expect(getBodyCalls).toBe(0);

    // 5. Chunked > 2MB (no Content-Length) fails open after getResponseBody
    emitRequestPaused(portrait, { requestId: 'p-chunked', postData: '{"chunked":1}' });
    await flushMicrotasks();
    emitResponsePaused(portrait, {
      requestId: 'p-chunked',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    });
    await flushMicrotasks();
    expect(getBodyCalls).toBe(1);
    emitRequestPaused(landscape, { requestId: 'f-chunked', postData: '{"chunked":1}' });
    await flushMicrotasks(15);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f-chunked',
      ),
    ).toBe(true);
    expect(dedup.getTabDedupCount('tab-1')).toBe(2);
  });

  test('M-07: enforces MAX_TOTAL_SLOTS (64) and MAX_TOTAL_BUFFERED_BYTES (16MB) with clean accounting', async () => {
    const { portrait, landscape, dedup } = setupPairedRig({ ttlMs: 40 });
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    const twoMbBody = 'x'.repeat(MAX_REPLAY_BODY_BYTES);
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: twoMbBody, base64Encoded: false };
      }
      return {};
    };

    // Nine 2MB buffered responses -> cap at 16MB (8 * 2MB)
    for (let i = 1; i <= 9; i += 1) {
      emitRequestPaused(portrait, { requestId: `p-mb-${i}`, postData: JSON.stringify({ mb: i }) });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: `p-mb-${i}`,
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
      });
      await flushMicrotasks();
    }
    expect(dedup.getTotalBufferedBytes()).toBeLessThanOrEqual(MAX_TOTAL_BUFFERED_BYTES);
    expect(dedup.getTotalBufferedBytes()).toBe(MAX_TOTAL_BUFFERED_BYTES);
    expect(dedup.getActiveSlotCount()).toBe(8);

    // clearTabSlots resets buffered bytes and slots
    dedup.clearTabSlots('tab-1');
    expect(dedup.getTotalBufferedBytes()).toBe(0);
    expect(dedup.getActiveSlotCount()).toBe(0);

    // 65 distinct keys evict oldest slot (MAX_TOTAL_SLOTS = 64)
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: '{"ok":true}', base64Encoded: false };
      }
      return {};
    };
    for (let i = 1; i <= MAX_TOTAL_SLOTS + 1; i += 1) {
      emitRequestPaused(portrait, { requestId: `p-cap-${i}`, postData: JSON.stringify({ cap: i }) });
      await flushMicrotasks();
      emitResponsePaused(portrait, {
        requestId: `p-cap-${i}`,
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      });
      await flushMicrotasks();
    }
    expect(dedup.getActiveSlotCount()).toBe(MAX_TOTAL_SLOTS);

    // Wait for TTL expiry and verify everything drains to 0
    await new Promise((r) => setTimeout(r, 80));
    expect(dedup.getActiveSlotCount()).toBe(0);
    expect(dedup.getTotalBufferedBytes()).toBe(0);
  });

  test('M-08: serialized enable/disable mutex, Network.loadingFailed, onDetach/onReattach, clearTabSlots, disposeWebContents, and Page.getFrameTree/frameNavigated fallback', async () => {
    const { coordinator, portrait, landscape, dedup } = setupPairedRig({
      useFallbackMainFrameId: true,
    });

    // 1. Overlapping enable(true) then enable(false) leaves Fetch.disable as final state
    let resolveAttachGate!: () => void;
    const attachGate = new Promise<void>((r) => {
      resolveAttachGate = r;
    });
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Page.getFrameTree') {
        await attachGate;
        return { frameTree: { frame: { id: 'tree-frame-1' } } };
      }
      return {};
    };

    const pEnable = dedup.setViewportEnabled(portrait, true);
    const pDisable = dedup.setViewportEnabled(portrait, false);
    resolveAttachGate();
    await Promise.all([pEnable, pDisable]);

    expect(dedup.isViewportEnabled(portrait.id)).toBe(false);
    expect(portrait.debugger.commands.some((c) => c.method === 'Fetch.enable')).toBe(false);

    // Test overlapping when Fetch.enable is already in flight
    let resolveFetchEnable!: () => void;
    const fetchGate = new Promise<void>((r) => {
      resolveFetchEnable = r;
    });
    portrait.debugger.commands.length = 0;
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'tree-frame-1' } } };
      }
      if (method === 'Fetch.enable') {
        await fetchGate;
      }
      return {};
    };
    const pEn2 = dedup.setViewportEnabled(portrait, true);
    await portrait.debugger.waitForCommand((c) => c.method === 'Fetch.enable');
    const pDis2 = dedup.setViewportEnabled(portrait, false);
    resolveFetchEnable();
    await Promise.all([pEn2, pDis2]);

    const fetchCmds = portrait.debugger.commands
      .filter((c) => c.method === 'Fetch.enable' || c.method === 'Fetch.disable')
      .map((c) => c.method);
    expect(fetchCmds[fetchCmds.length - 1]).toBe('Fetch.disable');
    expect(portrait.debugger.commands.some((c) => c.method === 'Page.disable')).toBe(false);

    // 2. Fallback mainFrameId via Page.getFrameTree + Page.frameNavigated
    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'tree-frame-1' } } };
      }
      if (method === 'Fetch.getResponseBody') {
        return { body: '{"ok":true}', base64Encoded: false };
      }
      return {};
    };
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    // Subframe navigation does NOT overwrite mainFrameId
    portrait.debugger.emit('message', {}, 'Page.frameNavigated', {
      frame: { id: 'child-frame-99', parentId: 'tree-frame-1' },
    });
    // Top-level navigation updates mainFrameId
    portrait.debugger.emit('message', {}, 'Page.frameNavigated', {
      frame: { id: 'nav-frame-2' },
    });

    emitRequestPaused(portrait, {
      requestId: 'p-nav',
      networkId: 'n-nav',
      frameId: 'nav-frame-2',
      postData: '{"nav":1}',
    });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(1);

    // 3. Network.loadingFailed immediately unblocks awaiting follower
    emitRequestPaused(landscape, {
      requestId: 'f-abort',
      networkId: 'nf-abort',
      frameId: 'frame-main-1',
      postData: '{"nav":1}',
    });
    await flushMicrotasks();

    portrait.debugger.emit('message', {}, 'Network.loadingFailed', { requestId: 'n-nav' });
    await flushMicrotasks(15);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f-abort',
      ),
    ).toBe(true);
    expect(dedup.getActiveSlotCount()).toBe(0);

    // 4. onDetach clears enabledWcIds + fails open awaiting follower; reattachAndRestore re-enables only if still desired-enabled
    emitRequestPaused(portrait, {
      requestId: 'p-det',
      networkId: 'n-det',
      frameId: 'nav-frame-2',
      postData: '{"det":1}',
    });
    await flushMicrotasks();
    emitRequestPaused(landscape, {
      requestId: 'f-det',
      networkId: 'nf-det',
      frameId: 'frame-main-1',
      postData: '{"det":1}',
    });
    await flushMicrotasks();

    portrait.debugger.attached = false;
    portrait.debugger.emit('detach', {}, 'target_closed');
    await flushMicrotasks(15);
    expect(dedup.isViewportEnabled(portrait.id)).toBe(false);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f-det',
      ),
    ).toBe(true);

    // Reattach while desiredEnabled === true restores Fetch.enable
    portrait.debugger.commands.length = 0;
    await coordinator.reattachAndRestore(portrait);
    expect(dedup.isViewportEnabled(portrait.id)).toBe(true);
    expect(portrait.debugger.commands.some((c) => c.method === 'Fetch.enable')).toBe(true);

    // Disable, detach, reattach -> should NOT re-enable
    await dedup.setViewportEnabled(portrait, false);
    portrait.debugger.attached = false;
    portrait.debugger.emit('detach', {}, 'devtools');
    portrait.debugger.commands.length = 0;
    await coordinator.reattachAndRestore(portrait);
    expect(dedup.isViewportEnabled(portrait.id)).toBe(false);
    expect(portrait.debugger.commands.some((c) => c.method === 'Fetch.enable')).toBe(false);

    // 5. clearTabSlots preserves dedupCount while clearing buffered slots
    await dedup.setViewportEnabled(portrait, true);
    emitRequestPaused(portrait, {
      requestId: 'p-cnt',
      networkId: 'n-cnt',
      frameId: 'tree-frame-1',
      postData: '{"cnt":1}',
    });
    await flushMicrotasks();
    emitResponsePaused(portrait, { requestId: 'p-cnt', networkId: 'n-cnt', responseStatusCode: 200 });
    await flushMicrotasks();
    emitRequestPaused(landscape, {
      requestId: 'f-cnt',
      networkId: 'nf-cnt',
      frameId: 'frame-main-1',
      postData: '{"cnt":1}',
    });
    await flushMicrotasks(15);
    expect(dedup.getTabDedupCount('tab-1')).toBe(1);

    emitRequestPaused(portrait, {
      requestId: 'p-pending',
      networkId: 'n-pending',
      frameId: 'tree-frame-1',
      postData: '{"cnt":2}',
    });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(1);

    dedup.clearTabSlots('tab-1');
    expect(dedup.getActiveSlotCount()).toBe(0);
    expect(dedup.getTabDedupCount('tab-1')).toBe(1);

    // 6. disposeWebContents cleans up state & participant
    portrait.destroy();
    await flushMicrotasks();
    expect(dedup.isViewportEnabled(portrait.id)).toBe(false);
  });

  test('M-09: fails open on binary Uint8Array / untyped Blob / lossy UTF-8 \\uFFFD / postDataEntries without colliding', async () => {
    const { portrait, landscape, dedup } = setupPairedRig();
    await dedup.setViewportEnabled(portrait, true);
    await dedup.setViewportEnabled(landscape, true);

    portrait.debugger.commandHandler = async (method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: JSON.stringify({ ok: true }), base64Encoded: false };
      }
      return {};
    };

    // 1. Uint8Array([1,2,3,4]) (control bytes + no Content-Type)
    emitRequestPaused(portrait, {
      requestId: 'p-u8-ctrl',
      hasPostData: true,
      postData: '\x01\x02\x03\x04',
      postDataEntries: [{ bytes: Buffer.from([1, 2, 3, 4]).toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks();
    emitRequestPaused(landscape, {
      requestId: 'l-u8-ctrl',
      hasPostData: true,
      postData: '\x01\x02\x03\x04',
      postDataEntries: [{ bytes: Buffer.from([1, 2, 3, 4]).toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks(10);
    expect(dedup.getActiveSlotCount()).toBe(0);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'l-u8-ctrl',
      ),
    ).toBe(true);
    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);

    // 2. Distinct non-UTF-8 payloads ([0xff,0x00,0xfe,0x01] vs [0xfe,0x00,0xff,0x01]) that Chromium
    // lossy-decodes to the same "\uFFFD\x00\uFFFD\x01" string must NEVER collide or replay
    emitRequestPaused(portrait, {
      requestId: 'p-lossy',
      hasPostData: true,
      postData: '\ufffd\x00\ufffd\x01',
      postDataEntries: [{ bytes: Buffer.from([0xff, 0x00, 0xfe, 0x01]).toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks();
    emitResponsePaused(portrait, { requestId: 'p-lossy', responseStatusCode: 200 });
    await flushMicrotasks();

    emitRequestPaused(landscape, {
      requestId: 'l-lossy',
      hasPostData: true,
      postData: '\ufffd\x00\ufffd\x01',
      postDataEntries: [{ bytes: Buffer.from([0xfe, 0x00, 0xff, 0x01]).toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks(10);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'l-lossy',
      ),
    ).toBe(true);
    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);

    // 3. Printable ASCII Uint8Array / untyped Blob (e.g. "ABCD") with hasPostData: true & missing Content-Type
    emitRequestPaused(portrait, {
      requestId: 'p-blob-notype',
      hasPostData: true,
      postData: 'ABCD',
      postDataEntries: [{ bytes: Buffer.from('ABCD', 'utf8').toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks();
    emitRequestPaused(landscape, {
      requestId: 'l-blob-notype',
      hasPostData: true,
      postData: 'ABCD',
      postDataEntries: [{ bytes: Buffer.from('ABCD', 'utf8').toString('base64') }],
      headers: { accept: '*/*' },
    });
    await flushMicrotasks(10);
    expect(
      landscape.debugger.commands.some(
        (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'l-blob-notype',
      ),
    ).toBe(true);
    expect(landscape.debugger.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false);

    // 4. Non-inline postDataEntries (missing bytes) or invalid UTF-8 in postDataEntries fails open
    // even if a caller supplied a Content-Type header
    emitRequestPaused(portrait, {
      requestId: 'p-entries-noninline',
      hasPostData: true,
      postData: '{"ok":true}',
      postDataEntries: [{}],
      headers: { 'content-type': 'application/json' },
    });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(0);

    emitRequestPaused(portrait, {
      requestId: 'p-entries-badutf8',
      hasPostData: true,
      postData: 'valid-fallback',
      postDataEntries: [{ bytes: Buffer.from([0xff, 0xfe]).toString('base64') }],
      headers: { 'content-type': 'application/json' },
    });
    await flushMicrotasks();
    expect(dedup.getActiveSlotCount()).toBe(0);
    expect(dedup.getTabDedupCount('tab-1')).toBe(0);
  });
});
