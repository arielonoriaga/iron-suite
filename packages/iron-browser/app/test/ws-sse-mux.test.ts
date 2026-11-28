import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Mock electron ipcMain before importing WsSseMux.
class FakeIpcMain extends EventEmitter {
  emitMessage(channel: string, ev: unknown, payload: unknown): void {
    this.emit(channel, ev, payload);
  }
}

const sharedFakeIpcMain = new FakeIpcMain();

mock.module('electron', () => ({
  ipcMain: sharedFakeIpcMain,
}));

import { DebuggerCoordinator } from '../src/main/debugger-coordinator';
import type {
  MuxWebContents,
  WsMuxViewportContext,
  WsSseMux as WsSseMuxInstance,
} from '../src/main/ws-sse-mux';

const { WsSseMux } = await import('../src/main/ws-sse-mux');
import {
  SseStreamParser,
  WS_HANDSHAKE_BUFFER_TTL_MS,
  WS_MAX_CHANNELS_PER_TAB,
  WS_MAX_FRAME_BYTES,
  WS_MAX_HANDSHAKE_FRAMES,
  WS_MAX_TOTAL_BUFFER_BYTES,
  WS_MUX_HANDSHAKE_FAIL_OPEN_MS,
  WS_OUTBOUND_DEDUP_WINDOW_MS,
  WS_OWNER_TEARDOWN_CLOSE_CODE,
  WS_REJECT_CAP_CLOSE_CODE,
  WS_SSE_MUX_IPC_CHANNELS,
  WS_SSE_MUX_WINDOW_MESSAGES,
  WS_VOLATILE_JSON_KEYS,
  buildMuxChannelKey,
  buildWsSseMuxShimScript,
  canonicalizeWsOutboundPayload,
  isValidHttpOrigin,
  normalizeMuxUrl,
  normalizeWsProtocols,
  parseSseChunk,
  type MainToMuxMessage,
} from '../src/shared/ws-sse-mux-core';

// ---------------------------------------------------------------------------
// Test Doubles
// ---------------------------------------------------------------------------

class FakeDebugger extends EventEmitter {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  private nextScriptSeq = 1;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  commandHandler?: (method: string, params?: Record<string, unknown>) => Promise<unknown> | unknown;

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

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    if (this.commandHandler) {
      return await this.commandHandler(method, params);
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `script-${this.nextScriptSeq++}` };
    }
    return {};
  }
}

let nextFakeWcId = 1;

class FakeMuxWebContents extends EventEmitter implements MuxWebContents {
  readonly id = nextFakeWcId++;
  readonly debugger = new FakeDebugger();
  mainFrame: { origin: string } | null;
  destroyed = false;
  sentMessages: Array<{ channel: string; msg: MainToMuxMessage }> = [];

  constructor(origin = 'https://app.example.com') {
    super();
    this.mainFrame = { origin };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.sentMessages.push({ channel, msg: args[0] as MainToMuxMessage });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

function makeFakeIpcEvent(wc: FakeMuxWebContents, senderFrame?: { origin: string } | null) {
  return {
    sender: { id: wc.id },
    senderFrame: senderFrame === undefined ? wc.mainFrame : senderFrame,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure Core Helpers
// ---------------------------------------------------------------------------

describe('ws-sse-mux-core pure helpers', () => {
  test('contains zero node:* imports or Buffer references for sandbox: true preload safety', () => {
    const src = readFileSync(join(import.meta.dir, '../src/shared/ws-sse-mux-core.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:/);
    expect(src).not.toMatch(/\bBuffer\b/);
  });

  test('WS_VOLATILE_JSON_KEYS has strictly the 12 correlation keys and excludes domain keys', () => {
    expect(WS_VOLATILE_JSON_KEYS.size).toBe(12);
    for (const key of [
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
    ]) {
      expect(WS_VOLATILE_JSON_KEYS.has(key)).toBe(true);
    }
    for (const excluded of ['txid', 'transactionid', 'createdat', 'nonce']) {
      expect(WS_VOLATILE_JSON_KEYS.has(excluded)).toBe(false);
    }
  });

  test('canonicalizeWsOutboundPayload normalizes key order, 12 volatile keys, depth cap 32, __proto__, and binary slices', () => {
    const p1 = JSON.stringify({
      b: 2,
      a: 1,
      idempotencyKey: 'k-1',
      client_request_id: 'cr-1',
      'request-id': 'r-1',
      clientBetId: 'cb-1',
      clientTxId: 'ct-1',
      correlationId: 'co-1',
      traceId: 'tr-1',
      timestamp: 111,
      ts: 222,
      clientTime: 333,
      clientTimestamp: 444,
      sentAt: 555,
      nested: [{ ts: 1, keep: true }],
    });
    const p2 = JSON.stringify({
      nested: [{ keep: true, ts: 999 }],
      sentAt: 999,
      clientTimestamp: 888,
      clientTime: 777,
      ts: 666,
      timestamp: 555,
      traceId: 'x',
      correlationId: 'y',
      clientTxId: 'z',
      clientBetId: 'w',
      'request-id': 'r-2',
      client_request_id: 'cr-2',
      idempotencyKey: 'k-2',
      a: 1,
      b: 2,
    });
    expect(canonicalizeWsOutboundPayload(p1)).toBe(canonicalizeWsOutboundPayload(p2));

    // Non-volatile keys must remain distinct.
    const t1 = canonicalizeWsOutboundPayload(JSON.stringify({ txId: '1', nonce: 1, createdAt: 10 }));
    const t2 = canonicalizeWsOutboundPayload(JSON.stringify({ txId: '2', nonce: 1, createdAt: 10 }));
    expect(t1).not.toBe(t2);
    expect(t1).toContain('"txId":"1"');

    // Depth 32 canonicalizes; depth 33 falls back safely to txt: without throwing.
    let obj32: Record<string, unknown> = { leaf: 1, ts: 10 };
    for (let i = 1; i < 32; i += 1) obj32 = { next: obj32 };
    const canon32 = canonicalizeWsOutboundPayload(JSON.stringify(obj32));
    expect(canon32?.startsWith('json:')).toBe(true);
    expect(canon32).toContain('<volatile>');

    const obj33 = { extra: obj32 };
    const raw33 = JSON.stringify(obj33);
    expect(canonicalizeWsOutboundPayload(raw33)).toBe(`txt:${raw33}`);

    // __proto__ pollution safety.
    const protoPayload = '{"__proto__":{"polluted":true},"a":1}';
    const protoCanon = canonicalizeWsOutboundPayload(protoPayload);
    expect(protoCanon).toContain('"__proto__"');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    // Non-JSON & malformed JSON fall back to txt:
    expect(canonicalizeWsOutboundPayload('hello')).toBe('txt:hello');
    expect(canonicalizeWsOutboundPayload('{bad-json')).toBe('txt:{bad-json');

    // Binary slices with non-zero byteOffset + 256KB size cap.
    const backing = new Uint8Array([99, 10, 20, 30, 88]);
    const slice = backing.subarray(1, 4);
    const exact = new Uint8Array([10, 20, 30]);
    expect(canonicalizeWsOutboundPayload(slice)).toBe(canonicalizeWsOutboundPayload(exact));
    expect(canonicalizeWsOutboundPayload(exact.buffer)).toBe(canonicalizeWsOutboundPayload(exact));

    const oversizedBin = new Uint8Array(WS_MAX_FRAME_BYTES + 1);
    expect(canonicalizeWsOutboundPayload(oversizedBin)).toBeNull();
    expect(canonicalizeWsOutboundPayload('A'.repeat(WS_MAX_FRAME_BYTES + 1))).toBeNull();
  });

  test('normalizeMuxUrl, isValidHttpOrigin, normalizeWsProtocols, and buildMuxChannelKey enforce strict isolation', () => {
    expect(isValidHttpOrigin('https://app.example.com')).toBe(true);
    expect(isValidHttpOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isValidHttpOrigin('null')).toBe(false);
    expect(isValidHttpOrigin('file://')).toBe(false);
    expect(isValidHttpOrigin('https://user:pass@app.example.com')).toBe(false);
    expect(isValidHttpOrigin('https://app.example.com/path')).toBe(false);

    expect(normalizeMuxUrl('ws://Example.COM:80/chat?b=2&a=1&b=1#frag', 'ws')).toBe(
      'ws://example.com/chat?a=1&b=1&b=2',
    );
    expect(normalizeMuxUrl('/stream?z=9&a=1', 'ws', 'https://app.example.com:443')).toBe(
      'wss://app.example.com/stream?a=1&z=9',
    );
    expect(normalizeMuxUrl('/events?b=2&a=1#h', 'sse', 'http://127.0.0.1:80')).toBe(
      'http://127.0.0.1/events?a=1&b=2',
    );

    expect(normalizeMuxUrl('ws://user:pass@example.com/ws', 'ws')).toBeNull();
    expect(normalizeMuxUrl('ftp://example.com/file', 'ws')).toBeNull();
    expect(normalizeMuxUrl('ws://example.com/ws', 'sse')).toBeNull();
    expect(normalizeMuxUrl('javascript:alert(1)', 'sse')).toBeNull();
    expect(normalizeMuxUrl('', 'ws')).toBeNull();

    expect(normalizeWsProtocols(undefined)).toEqual([]);
    expect(normalizeWsProtocols('chat.v1')).toEqual(['chat.v1']);
    expect(normalizeWsProtocols(['chat.v1', 'fallback'])).toEqual(['chat.v1', 'fallback']);

    const kA = buildMuxChannelKey({
      tabId: 'tab-1',
      initiatorOrigin: 'https://a.example.com',
      kind: 'ws',
      normalizedUrl: 'wss://a.example.com/ws',
      protocols: ['p1', 'p2'],
    });
    const kB = buildMuxChannelKey({
      tabId: 'tab-1',
      initiatorOrigin: 'https://a.example.com',
      kind: 'ws',
      normalizedUrl: 'wss://a.example.com/ws',
      protocols: ['p2', 'p1'],
    });
    const kCrossOrigin = buildMuxChannelKey({
      tabId: 'tab-1',
      initiatorOrigin: 'https://b.example.com',
      kind: 'ws',
      normalizedUrl: 'wss://a.example.com/ws',
      protocols: ['p1', 'p2'],
    });
    expect(kA).not.toBeNull();
    expect(kA).not.toBe(kB);
    expect(kA).not.toBe(kCrossOrigin);
    expect(
      buildMuxChannelKey({
        tabId: 'tab-1',
        initiatorOrigin: 'null',
        kind: 'sse',
        normalizedUrl: 'https://a.example.com/sse',
        withCredentials: false,
      }),
    ).toBeNull();
  });

  test('SseStreamParser handles BOM, split CRLF, comments, multi-line data, named events, id:\\0, retry, and EOF discard', () => {
    const parser = new SseStreamParser();
    // Split UTF-8 BOM across chunks + \r\n split across chunks + multi-byte UTF-8 split
    const euroBytes = new TextEncoder().encode('€');
    const c1 = new Uint8Array([0xef, 0xbb]);
    const c2 = new Uint8Array([0xbf, ...new TextEncoder().encode(': connected\r\nevent: ping-evt\r')]);
    const c3 = new Uint8Array([
      ...new TextEncoder().encode('\nid: evt-1\nretry: 1500\ndata:  hello '),
      euroBytes[0]!,
    ]);
    const c4 = new Uint8Array([
      euroBytes[1]!,
      euroBytes[2]!,
      ...new TextEncoder().encode('\ndata: line2\r\r'),
    ]);

    expect(parser.push(c1)).toEqual([]);
    expect(parser.push(c2)).toEqual([]);
    expect(parser.push(c3)).toEqual([]);
    const events = parser.push(c4);
    expect(events).toEqual([
      {
        type: 'ping-evt',
        data: ' hello €\nline2',
        lastEventId: 'evt-1',
      },
    ]);
    expect(parser.retryMs).toBe(1500);

    // Subsequent default event resets event type to 'message', preserves lastEventId, ignores id with \0 and invalid retry
    const next = parser.push('id: bad\0id\nretry: abc\ndata:\n\n');
    expect(next).toEqual([{ type: 'message', data: '', lastEventId: 'evt-1' }]);
    expect(parser.retryMs).toBe(1500);

    // id-only block updates lastEventId without dispatching
    expect(parser.push('id: evt-2\n\n')).toEqual([]);
    expect(parser.lastEventId).toBe('evt-2');

    // Unterminated block discarded on finish()
    expect(parser.push('data: incomplete')).toEqual([]);
    expect(parser.finish()).toEqual([]);
    expect(parser.push('\ndata: fresh\n\n')).toEqual([
      { type: 'message', data: 'fresh', lastEventId: 'evt-2' },
    ]);

    const stateless = parseSseChunk('\uFEFFevent: room_state\ndata: ok\n\n');
    expect(stateless.events).toEqual([{ type: 'room_state', data: 'ok', lastEventId: '' }]);
  });
});

// ---------------------------------------------------------------------------
// 2. Main-World Shim Script in node:vm Sandbox
// ---------------------------------------------------------------------------

interface VmHarnessOptions {
  isTop?: boolean;
  href?: string;
  onPostMessage?: (data: unknown) => void;
}

function createVmBrowserHarness(opts: VmHarnessOptions = {}) {
  const isTop = opts.isTop ?? true;
  const href = opts.href ?? 'https://app.example.com/page';

  const nativeWsCreated: FakeNativeWebSocket[] = [];
  const nativeEsCreated: FakeNativeEventSource[] = [];
  const windowListeners = new Map<string, Set<(ev: unknown) => void>>();
  const postedWindowMessages: unknown[] = [];
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  let fetchHandler: (url: string, init: RequestInit) => Promise<unknown> = async () => ({
    status: 204,
    headers: new Headers(),
    body: null,
  });

  class FakeNativeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    protocol = '';
    extensions = '';
    bufferedAmount = 0;
    sent: unknown[] = [];
    closedCalls: Array<{ code?: number; reason?: string }> = [];

    constructor(
      public readonly url: string,
      public readonly protocols?: string | string[],
    ) {
      super();
      nativeWsCreated.push(this);
    }

    send(data: unknown): void {
      this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
      this.closedCalls.push({ code, reason });
      this.readyState = 3;
      const ev = new Event('close') as Event & { code: number; reason: string; wasClean: boolean };
      ev.code = code ?? 1000;
      ev.reason = reason ?? '';
      ev.wasClean = true;
      this.dispatchEvent(ev);
    }

    triggerOpen(protocol = '', extensions = ''): void {
      this.readyState = 1;
      this.protocol = protocol;
      this.extensions = extensions;
      this.dispatchEvent(new Event('open'));
    }

    triggerMessage(data: unknown): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }

  class FakeNativeEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    closed = false;

    constructor(
      public readonly url: string,
      public readonly init?: EventSourceInit,
    ) {
      super();
      nativeEsCreated.push(this);
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
    }

    triggerOpen(): void {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }

    triggerEvent(type: string, data: string, lastEventId = ''): void {
      this.dispatchEvent(new MessageEvent(type, { data, lastEventId }));
    }
  }

  const sandbox: Record<string, unknown> = {
    location: { href },
    WebSocket: FakeNativeWebSocket,
    EventSource: FakeNativeEventSource,
    URL,
    Headers,
    Response,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    AbortController,
    MessageChannel,
    MessagePort,
    Blob,
    Event,
    MessageEvent,
    CloseEvent,
    DOMException,
    setTimeout,
    clearTimeout,
    fetch: (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return fetchHandler(url, init);
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      let set = windowListeners.get(type);
      if (!set) {
        set = new Set();
        windowListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      windowListeners.get(type)?.delete(fn);
    },
    postMessage: (data: unknown) => {
      postedWindowMessages.push(data);
      opts.onPostMessage?.(data);
    },
  };

  const context = vm.createContext(sandbox);
  const windowProxy = vm.runInContext('globalThis', context) as Record<string, unknown>;
  sandbox.window = windowProxy;
  sandbox.top = isTop ? windowProxy : { differentTop: true };
  const script = buildWsSseMuxShimScript();
  vm.runInContext(script, context);

  function dispatchWindowMessage(ev: { source: unknown; data: unknown; ports?: unknown[] }) {
    for (const fn of windowListeners.get('message') ?? []) {
      fn(ev);
    }
  }

  return {
    sandbox,
    windowProxy,
    context,
    script,
    FakeNativeWebSocket,
    FakeNativeEventSource,
    nativeWsCreated,
    nativeEsCreated,
    postedWindowMessages,
    fetchCalls,
    setFetchHandler(fn: (url: string, init: RequestInit) => Promise<unknown>) {
      fetchHandler = fn;
    },
    dispatchWindowMessage,
  };
}

describe('buildWsSseMuxShimScript in node:vm', () => {
  test('line 1 starts with window !== window.top guard and leaves subframes unshimmed', () => {
    const script = buildWsSseMuxShimScript();
    const firstLine = script.split('\n')[0] ?? '';
    expect(firstLine.startsWith('(function () { if (window !== window.top) return;')).toBe(true);

    const sub = createVmBrowserHarness({ isTop: false });
    expect(sub.sandbox.WebSocket).toBe(sub.FakeNativeWebSocket);
    expect(sub.sandbox.EventSource).toBe(sub.FakeNativeEventSource);
    expect(sub.postedWindowMessages).toEqual([]);
  });

  test('freezes WebSocket/EventSource wrappers & prototypes and resists global intrinsic tampering', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    expect(h.postedWindowMessages).toEqual([]);
    await new Promise((r) => setTimeout(r, 25));
    expect(h.postedWindowMessages).toEqual([{ type: WS_SSE_MUX_WINDOW_MESSAGES.READY }]);

    const WebSocketCtor = h.sandbox.WebSocket as typeof WebSocket;
    const EventSourceCtor = h.sandbox.EventSource as typeof EventSource;
    expect(Object.isFrozen(WebSocketCtor)).toBe(true);
    expect(Object.isFrozen(WebSocketCtor.prototype)).toBe(true);
    expect(Object.isFrozen(EventSourceCtor)).toBe(true);
    expect(Object.isFrozen(EventSourceCtor.prototype)).toBe(true);

    const ch = new MessageChannel();
    const toMainMsgs: unknown[] = [];
    ch.port1.onmessage = (ev) => toMainMsgs.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    // Tamper with globals after shim runs.
    vm.runInContext(
      `
      Array.prototype.push = function() { throw new Error('tampered push'); };
      Promise = function() { throw new Error('tampered Promise'); };
      Object.defineProperty = function() { throw new Error('tampered defineProperty'); };
      JSON.stringify = function() { throw new Error('tampered JSON'); };
      fetch = function() { throw new Error('tampered fetch'); };
      `,
      h.context,
    );

    const ws = vm.runInContext(`new WebSocket('wss://app.example.com/ws', 'chat.v1')`, h.context) as WebSocket;
    expect(ws instanceof WebSocketCtor).toBe(true);
    expect(ws.readyState).toBe(0);
    await new Promise((r) => setTimeout(r, 15));
    expect(toMainMsgs.length).toBe(1);
    expect((toMainMsgs[0] as { type: string }).type).toBe('ws-open');

    ch.port1.close();
  });

  test('rejects cross-origin __iron_ws_mux_init__, replaces prior port cleanly, and handles early fail-open timeout', async () => {
    const h = createVmBrowserHarness({ isTop: true });

    // Cross-origin source must be ignored.
    const spoofedCh = new MessageChannel();
    const spoofedMsgs: unknown[] = [];
    spoofedCh.port1.onmessage = (ev) => spoofedMsgs.push(ev.data);
    h.dispatchWindowMessage({
      source: { otherWindow: true },
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [spoofedCh.port2],
    });

    // Early socket queued before handshake -> falls back to native after 150ms fail-open timeout.
    const earlyWs = vm.runInContext(`new WebSocket('wss://app.example.com/early')`, h.context) as WebSocket;
    const earlyEs = vm.runInContext(`new EventSource('https://app.example.com/early-sse')`, h.context) as EventSource;
    expect(h.nativeWsCreated.length).toBe(0);
    expect(h.nativeEsCreated.length).toBe(0);

    await new Promise((r) => setTimeout(r, WS_MUX_HANDSHAKE_FAIL_OPEN_MS + 40));
    expect(spoofedMsgs.length).toBe(0);
    expect(h.nativeWsCreated.length).toBe(1);
    expect(h.nativeEsCreated.length).toBe(1);

    h.nativeWsCreated[0]!.triggerOpen('p1');
    expect(earlyWs.readyState).toBe(1);
    expect(earlyWs.protocol).toBe('p1');

    h.nativeEsCreated[0]!.triggerOpen();
    expect(earlyEs.readyState).toBe(1);
    spoofedCh.port1.close();
  });

  test('handles port replacement, protocol scoping bypass, reject 1008, owner binaryType=arraybuffer, and follower WS lifecycle', async () => {
    const h = createVmBrowserHarness({ isTop: true });

    const ch1 = new MessageChannel();
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch1.port2],
    });

    // Replace with ch2 cleanly.
    const ch2 = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch2.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch2.port2],
    });

    // Non-ws/http scheme bypasses immediately without sending to Main.
    vm.runInContext(`try { new WebSocket('ftp://app.example.com/x'); } catch {}`, h.context);
    expect(h.nativeWsCreated.length).toBe(1);
    expect(toMain.length).toBe(0);

    // Owner WebSocket
    const ownerWs = vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/chat', ['chat.v1', 'v2']);
        ws.binaryType = 'arraybuffer';
        window.__ownerEvents = [];
        ws.addEventListener('open', () => window.__ownerEvents.push('open:' + ws.protocol));
        ws.addEventListener('message', (ev) => window.__ownerEvents.push(ev.data instanceof ArrayBuffer ? Array.from(new Uint8Array(ev.data)) : ev.data));
        return ws;
      })()`,
      h.context,
    ) as WebSocket;

    await new Promise((r) => setTimeout(r, 15));
    const ownerOpenMsg = toMain.find((m) => m.type === 'ws-open')!;
    expect(ownerOpenMsg.protocols).toEqual(['chat.v1', 'v2']);

    ch2.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: ownerOpenMsg.clientSocketId,
      kind: 'ws',
      role: 'owner',
    } satisfies MainToMuxMessage);

    await new Promise((r) => setTimeout(r, 15));
    const nativeOwner = h.nativeWsCreated[1]!;
    expect(nativeOwner.binaryType).toBe('arraybuffer');

    nativeOwner.triggerOpen('chat.v1');
    await new Promise((r) => setTimeout(r, 15));
    expect(toMain.some((m) => m.type === 'upstream-ws-open' && m.protocol === 'chat.v1')).toBe(true);

    // Outbound send MUST go through ws-send -> mux-ws-send-upstream, never directly on nativeOwner.
    ownerWs.send('hello');
    expect(nativeOwner.sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 15));
    expect(toMain.some((m) => m.type === 'ws-send' && m.data === 'hello')).toBe(true);

    ch2.port1.postMessage({
      type: 'mux-ws-send-upstream',
      clientSocketId: ownerOpenMsg.clientSocketId,
      isBinary: false,
      data: 'hello',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    expect(nativeOwner.sent).toEqual(['hello']);

    // Inbound binary frame on owner
    nativeOwner.triggerMessage(new Uint8Array([7, 8, 9]).buffer);
    await new Promise((r) => setTimeout(r, 15));
    expect(h.sandbox.__ownerEvents).toEqual(['open:chat.v1', [7, 8, 9]]);
    expect(toMain.some((m) => m.type === 'upstream-ws-frame' && m.isBinary === true)).toBe(true);

    // Reject role -> CLOSED + error + close(1008)
    vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/cap');
        window.__rejected = [];
        ws.addEventListener('error', () => window.__rejected.push('error'));
        ws.addEventListener('close', (ev) => window.__rejected.push('close:' + ev.code + ':' + ws.readyState));
      })()`,
      h.context,
    );
    await new Promise((r) => setTimeout(r, 15));
    const rejOpen = toMain.find((m) => m.type === 'ws-open' && String(m.url).includes('/cap'))!;
    ch2.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: rejOpen.clientSocketId,
      kind: 'ws',
      role: 'reject',
      code: 1008,
      reason: 'cap',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    expect(h.sandbox.__rejected).toEqual(['error', 'close:1008:3']);

    // Follower WebSocket with alreadyOpen + 1012 close
    vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/follow');
        ws.binaryType = 'arraybuffer';
        window.__follow = [];
        ws.addEventListener('open', () => window.__follow.push('open:' + ws.protocol));
        ws.addEventListener('message', (ev) => window.__follow.push(ev.data instanceof ArrayBuffer ? Array.from(new Uint8Array(ev.data)) : ev.data));
        ws.addEventListener('close', (ev) => window.__follow.push('close:' + ev.code));
      })()`,
      h.context,
    );
    await new Promise((r) => setTimeout(r, 15));
    const folOpen = toMain.find((m) => m.type === 'ws-open' && String(m.url).includes('/follow'))!;
    ch2.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: folOpen.clientSocketId,
      kind: 'ws',
      role: 'follower',
      alreadyOpen: true,
      protocol: 'chat.v1',
      extensions: '',
    } satisfies MainToMuxMessage);
    ch2.port1.postMessage({
      type: 'mux-ws-frame',
      clientSocketId: folOpen.clientSocketId,
      isBinary: true,
      data: new Uint8Array([4, 5]),
    } satisfies MainToMuxMessage);
    ch2.port1.postMessage({
      type: 'mux-ws-close',
      clientSocketId: folOpen.clientSocketId,
      code: 1012,
      reason: 'owner-down',
      wasClean: true,
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sandbox.__follow).toEqual(['open:chat.v1', [4, 5], 'close:1012']);
    // No native WebSocket opened for follower or rejected socket!
    expect(h.nativeWsCreated.length).toBe(2);

    ch1.port1.close();
    ch2.port1.close();
  });

  test('MuxedEventSource uses fetch()+ReadableStream on owner, preserves named events/lastEventId, and promotes follower on ownerTeardown', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    const enc = new TextEncoder();
    let streamCtrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    h.setFetchHandler(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          streamCtrl = c;
        },
      }),
    }));

    // Owner SSE
    const ownerEs = vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/events', { withCredentials: true });
        window.__sseOwner = [];
        es.addEventListener('open', () => window.__sseOwner.push('open'));
        es.addEventListener('ping-evt', (ev) => window.__sseOwner.push({ t: 'ping-evt', d: ev.data, id: ev.lastEventId }));
        es.onmessage = (ev) => window.__sseOwner.push({ t: 'message', d: ev.data, id: ev.lastEventId });
        return es;
      })()`,
      h.context,
    ) as EventSource;

    await new Promise((r) => setTimeout(r, 15));
    const sseOpen = toMain.find((m) => m.type === 'sse-open')!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: sseOpen.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);

    await new Promise((r) => setTimeout(r, 20));
    expect(h.nativeEsCreated.length).toBe(0);
    expect(h.fetchCalls.length).toBe(1);
    expect(h.fetchCalls[0]!.init.credentials).toBe('include');
    expect(ownerEs.readyState).toBe(1);

    streamCtrl!.enqueue(enc.encode(': connected\n\nevent: ping-evt\nid: e-1\ndata: {"ok":true}\n\ndata: plain\n\n'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sandbox.__sseOwner).toEqual([
      'open',
      { t: 'ping-evt', d: '{"ok":true}', id: 'e-1' },
      { t: 'message', d: 'plain', id: 'e-1' },
    ]);
    expect(toMain.some((m) => m.type === 'upstream-sse-event' && m.eventType === 'ping-evt' && m.lastEventId === 'e-1')).toBe(true);
    ownerEs.close();
    expect(ownerEs.readyState).toBe(2);

    // Follower SSE receives ownerTeardown -> CONNECTING (0), fires error, re-issues sse-open with lastEventId
    vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/events2');
        window.__sseFollower = [];
        es.addEventListener('open', () => window.__sseFollower.push('open'));
        es.addEventListener('room_state', (ev) => window.__sseFollower.push({ d: ev.data, id: ev.lastEventId }));
        es.addEventListener('error', () => window.__sseFollower.push('error:rs=' + es.readyState));
        window.__esFol = es;
      })()`,
      h.context,
    );
    await new Promise((r) => setTimeout(r, 15));
    const folOpen = toMain.find((m) => m.type === 'sse-open' && String(m.url).includes('/events2'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: folOpen.clientSocketId,
      kind: 'sse',
      role: 'follower',
      alreadyOpen: true,
    } satisfies MainToMuxMessage);
    ch.port1.postMessage({
      type: 'mux-sse-event',
      clientSocketId: folOpen.clientSocketId,
      eventType: 'room_state',
      data: 'round-9',
      lastEventId: 'id-9',
    } satisfies MainToMuxMessage);
    ch.port1.postMessage({
      type: 'mux-sse-error',
      clientSocketId: folOpen.clientSocketId,
      fatal: false,
      ownerTeardown: true,
      retryMs: 10,
    } satisfies MainToMuxMessage);

    await new Promise((r) => setTimeout(r, 40));
    expect(h.sandbox.__sseFollower).toEqual(['open', { d: 'round-9', id: 'id-9' }, 'error:rs=0']);
    const reconnectMsg = toMain.filter(
      (m) => m.type === 'sse-open' && m.clientSocketId === folOpen.clientSocketId,
    );
    expect(reconnectMsg.length).toBe(2);
    expect(reconnectMsg[1]!.lastEventId).toBe('id-9');

    // Clean up follower
    vm.runInContext(`window.__esFol.close()`, h.context);
    ch.port1.close();
  });

  test('MuxedEventSource handles fatal HTTP 204/500/non-SSE MIME and AbortController on close(), and MuxedWebSocket preserves Blob send ordering', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    // Fatal 204
    h.setFetchHandler(async () => ({
      status: 204,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: null,
    }));
    const es204 = vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/204');
        window.__es204Err = 0;
        es.addEventListener('error', () => { window.__es204Err += 1; });
        return es;
      })()`,
      h.context,
    ) as EventSource;
    await new Promise((r) => setTimeout(r, 15));
    const open204 = toMain.find((m) => m.type === 'sse-open' && String(m.url).includes('/204'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: open204.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 25));
    expect(es204.readyState).toBe(2);
    expect(h.sandbox.__es204Err).toBe(1);
    expect(toMain.some((m) => m.type === 'upstream-sse-error' && m.clientSocketId === open204.clientSocketId && m.fatal === true)).toBe(true);

    // Fatal wrong Content-Type
    h.setFetchHandler(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
    }));
    const esJson = vm.runInContext(`new EventSource('https://app.example.com/json')`, h.context) as EventSource;
    await new Promise((r) => setTimeout(r, 15));
    const openJson = toMain.find((m) => m.type === 'sse-open' && String(m.url).includes('/json'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: openJson.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 25));
    expect(esJson.readyState).toBe(2);

    // AbortController aborted on close()
    let capturedSignal: AbortSignal | undefined;
    h.setFetchHandler(async (_url, init) => {
      capturedSignal = init.signal ?? undefined;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({ start() {} }),
      };
    });
    const esAbort = vm.runInContext(`new EventSource('https://app.example.com/abort')`, h.context) as EventSource;
    await new Promise((r) => setTimeout(r, 15));
    const openAbort = toMain.find((m) => m.type === 'sse-open' && String(m.url).includes('/abort'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: openAbort.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal?.aborted).toBe(false);
    esAbort.close();
    expect(capturedSignal?.aborted).toBe(true);

    // Blob followed by text send preserves strict order
    const ws = vm.runInContext(`new WebSocket('wss://app.example.com/blob-order')`, h.context) as WebSocket;
    await new Promise((r) => setTimeout(r, 15));
    const wsOpen = toMain.find((m) => m.type === 'ws-open' && String(m.url).includes('/blob-order'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: wsOpen.clientSocketId,
      kind: 'ws',
      role: 'follower',
      alreadyOpen: true,
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    ws.send(new Blob(['first']));
    ws.send('second');
    await new Promise((r) => setTimeout(r, 30));
    const sends = toMain.filter((m) => m.type === 'ws-send' && m.clientSocketId === wsOpen.clientSocketId);
    expect(sends.length).toBe(2);
    expect(sends[0]!.isBinary).toBe(true);
    expect(new TextDecoder().decode(sends[0]!.data as Uint8Array)).toBe('first');
    expect(sends[1]!.isBinary).toBe(false);
    expect(sends[1]!.data).toBe('second');

    ch.port1.close();
  });
});

// ---------------------------------------------------------------------------
// 3. WsSseMux Main Process & DebuggerCoordinator Integration
// ---------------------------------------------------------------------------

describe('WsSseMux main process integration', () => {
  let activeMux: WsSseMuxInstance | null = null;

  afterEach(() => {
    activeMux?.dispose();
    activeMux = null;
  });

  beforeEach(() => {
    nextFakeWcId = 100;
  });

  test('CDP syncViewport serializes rapid true->false->true, handles onDetach without killing live channels, and restores on onReattach', async () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-1',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-1',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    // Delay Page.addScriptToEvaluateOnNewDocument slightly to verify serialization
    let addCalls = 0;
    let removeCalls = 0;
    portrait.debugger.commandHandler = async (method) => {
      await new Promise((r) => setTimeout(r, 5));
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        addCalls += 1;
        return { identifier: `id-${addCalls}` };
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
        removeCalls += 1;
      }
      return {};
    };

    // Rapid true -> false -> true
    await Promise.all([
      activeMux.syncViewport(portrait, true),
      activeMux.syncViewport(portrait, false),
      activeMux.syncViewport(portrait, true),
    ]);
    expect(activeMux.getStats().installedWcIds).toEqual([portrait.id]);
    expect(addCalls).toBe(1);

    // Open a live WS channel on portrait
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'ws-1', url: '/live', protocols: [] },
    );
    expect(activeMux.getStats().activeChannels).toBe(1);

    // Simulate DevTools opening (debugger detach): must NOT kill live channels!
    portrait.debugger.attached = false;
    portrait.debugger.emit('detach', {}, 'replaced_with_devtools');
    expect(activeMux.getStats().activeChannels).toBe(1);
    expect(activeMux.getStats().installedWcIds).toEqual([]);

    // Simulate DevTools closing -> reattachAndRestore: re-installs document script cleanly.
    await coordinator.reattachAndRestore(portrait);
    await new Promise((r) => setTimeout(r, 20));
    expect(activeMux.getStats().installedWcIds).toEqual([portrait.id]);
    expect(addCalls).toBe(2);

    // Disable viewport -> removes script.
    await activeMux.syncViewport(portrait, false);
    expect(activeMux.getStats().installedWcIds).toEqual([]);
    expect(removeCalls).toBe(1);
  });

  test('enforces senderFrame === mainFrame, non-opaque origin, cross-origin isolation, and inactive bypass', () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://other.example.com');
    let activeFlag = true;

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-1',
          role: 'portrait',
          get active() {
            return activeFlag;
          },
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-1',
          role: 'landscape',
          get active() {
            return activeFlag;
          },
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    // Spoofed senderFrame !== mainFrame -> ignored silently
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait, { origin: 'https://app.example.com' }),
      { type: 'ws-open', clientSocketId: 'spoof', url: 'wss://app.example.com/ws', protocols: [] },
    );
    expect(portrait.sentMessages.length).toBe(0);

    // Opaque 'null' origin -> ignored
    const nullOriginWc = new FakeMuxWebContents('null');
    ctxMap.set(nullOriginWc.id, {
      tabId: 'tab-1',
      role: 'portrait',
      active: true,
      wc: nullOriginWc,
      pairedWc: null,
      getOrigin: () => 'null',
    });
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(nullOriginWc),
      { type: 'ws-open', clientSocketId: 'null-1', url: 'wss://app.example.com/ws', protocols: [] },
    );
    expect(nullOriginWc.sentMessages.length).toBe(0);

    // Cross-origin paired viewports get 2 independent owners (no cross-origin fan-out)
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-1', url: 'wss://shared.example.com/ws', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'l-1', url: 'wss://shared.example.com/ws', protocols: [] },
    );
    expect(portrait.sentMessages[0]?.msg).toMatchObject({ type: 'mux-grant', role: 'owner' });
    expect(landscape.sentMessages[0]?.msg).toMatchObject({ type: 'mux-grant', role: 'owner' });
    expect(activeMux.getStats().activeChannels).toBe(2);

    // Inactive context returns role: 'bypass'
    activeFlag = false;
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-bypass', url: 'wss://shared.example.com/b', protocols: [] },
    );
    expect(portrait.sentMessages[1]?.msg).toMatchObject({ type: 'mux-grant', role: 'bypass' });
  });

  test('symmetric WS & SSE state machine, outbound 1500ms dedup, navigation/teardown 1012, and server close code', () => {
    let nowMs = 10_000;
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-1',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-1',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null, {
      now: () => nowMs,
    });
    void activeMux.syncViewport(portrait, true);
    void activeMux.syncViewport(landscape, true);

    // 1. Follower joins while owner is still connecting -> held until upstream-ws-open
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-ws', url: '/chat', protocols: ['chat.v1'] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'l-ws', url: '/chat', protocols: ['chat.v1'] },
    );
    expect(portrait.sentMessages[0]?.msg).toMatchObject({ type: 'mux-grant', role: 'owner' });
    expect(landscape.sentMessages[0]?.msg).toMatchObject({
      type: 'mux-grant',
      role: 'follower',
      alreadyOpen: false,
    });

    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'upstream-ws-open', clientSocketId: 'p-ws', protocol: 'chat.v1', extensions: '' },
    );
    expect(landscape.sentMessages[1]?.msg).toEqual({
      type: 'mux-ws-open',
      clientSocketId: 'l-ws',
      protocol: 'chat.v1',
      extensions: '',
    });

    // 2. Symmetric outbound WS dedup: follower-first then owner within 1500ms -> 1 send upstream
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      {
        type: 'ws-send',
        clientSocketId: 'l-ws',
        isBinary: false,
        data: JSON.stringify({ type: 'bet', amount: 50, idempotencyKey: 'l-1', ts: 100 }),
      },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      {
        type: 'ws-send',
        clientSocketId: 'p-ws',
        isBinary: false,
        data: JSON.stringify({ ts: 200, idempotencyKey: 'p-1', amount: 50, type: 'bet' }),
      },
    );
    const upstreamSends1 = portrait.sentMessages.filter((m) => m.msg.type === 'mux-ws-send-upstream');
    expect(upstreamSends1.length).toBe(1);

    // Different non-volatile txId -> NOT deduped (2 sends upstream)
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      {
        type: 'ws-send',
        clientSocketId: 'p-ws',
        isBinary: false,
        data: JSON.stringify({ type: 'bet', txId: 'tx-A' }),
      },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      {
        type: 'ws-send',
        clientSocketId: 'l-ws',
        isBinary: false,
        data: JSON.stringify({ type: 'bet', txId: 'tx-B' }),
      },
    );
    expect(portrait.sentMessages.filter((m) => m.msg.type === 'mux-ws-send-upstream').length).toBe(3);

    // Same payload sent > 1500ms later -> NOT deduped
    nowMs += WS_OUTBOUND_DEDUP_WINDOW_MS + 100;
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      {
        type: 'ws-send',
        clientSocketId: 'l-ws',
        isBinary: false,
        data: JSON.stringify({ type: 'bet', amount: 50, idempotencyKey: 'l-2', ts: 300 }),
      },
    );
    expect(portrait.sentMessages.filter((m) => m.msg.type === 'mux-ws-send-upstream').length).toBe(4);

    // 3. Same-document and subframe navigations must NOT tear down live WS
    portrait.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true });
    portrait.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false });
    expect(activeMux.getStats().activeChannels).toBe(1);

    // 4. Main-frame non-same-document navigation on owner -> 1012 close to surviving follower
    portrait.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });
    expect(activeMux.getStats().activeChannels).toBe(0);
    expect(landscape.sentMessages.at(-1)?.msg).toMatchObject({
      type: 'mux-ws-close',
      clientSocketId: 'l-ws',
      code: WS_OWNER_TEARDOWN_CLOSE_CODE,
    });

    // 5. Survivor re-opens as new owner; upstream server close forwards exact code (4001)
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'l-ws-2', url: '/chat', protocols: ['chat.v1'] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'upstream-ws-open', clientSocketId: 'l-ws-2', protocol: 'chat.v1', extensions: '' },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-ws-2', url: '/chat', protocols: ['chat.v1'] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      {
        type: 'upstream-ws-close',
        clientSocketId: 'l-ws-2',
        code: 4001,
        reason: 'server-kick',
        wasClean: true,
      },
    );
    expect(portrait.sentMessages.at(-1)?.msg).toEqual({
      type: 'mux-ws-close',
      clientSocketId: 'p-ws-2',
      code: 4001,
      reason: 'server-kick',
      wasClean: true,
    });
  });

  test('enforces all 4 memory budgets: 16 channels/tab reject 1008, 32 handshake frames / 5s TTL, 256KB frame drop, 4MB total buffer cap', () => {
    let nowMs = 50_000;
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-budget',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-budget',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null, {
      now: () => nowMs,
    });

    // (a) 16 channels/tab cap -> 17th unique channel rejected with 1008, while follower on ch0 succeeds
    for (let i = 0; i < WS_MAX_CHANNELS_PER_TAB; i += 1) {
      sharedFakeIpcMain.emitMessage(
        WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
        makeFakeIpcEvent(portrait),
        { type: 'ws-open', clientSocketId: `c-${i}`, url: `/ch?i=${i}`, protocols: [] },
      );
      sharedFakeIpcMain.emitMessage(
        WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
        makeFakeIpcEvent(portrait),
        { type: 'upstream-ws-open', clientSocketId: `c-${i}`, protocol: '', extensions: '' },
      );
    }
    expect(activeMux.getStats().activeChannels).toBe(16);

    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'c-17', url: '/ch?i=16', protocols: [] },
    );
    expect(portrait.sentMessages.at(-1)?.msg).toMatchObject({
      type: 'mux-grant',
      clientSocketId: 'c-17',
      role: 'reject',
      code: WS_REJECT_CAP_CLOSE_CODE,
    });
    expect(activeMux.getStats().activeChannels).toBe(16);

    // Follower on existing channel 0 still succeeds even at 16/16 cap
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'f-0', url: '/ch?i=0', protocols: [] },
    );
    expect(landscape.sentMessages.at(-1)?.msg).toMatchObject({
      type: 'mux-grant',
      clientSocketId: 'f-0',
      role: 'follower',
      alreadyOpen: true,
    });

    // (b) 32 handshake frames cap & 5s TTL
    for (let f = 0; f < 40; f += 1) {
      sharedFakeIpcMain.emitMessage(
        WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
        makeFakeIpcEvent(portrait),
        { type: 'upstream-ws-frame', clientSocketId: 'c-1', isBinary: false, data: `hs-${f}` },
      );
    }
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'f-1', url: '/ch?i=1', protocols: [] },
    );
    const replayedHs = landscape.sentMessages.filter(
      (m) => m.msg.type === 'mux-ws-frame' && m.msg.clientSocketId === 'f-1',
    );
    expect(replayedHs.length).toBe(WS_MAX_HANDSHAKE_FRAMES);

    // Advance past 5000ms TTL -> handshake buffer expires on next join
    nowMs += WS_HANDSHAKE_BUFFER_TTL_MS + 50;
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'f-1-late', url: '/ch?i=1', protocols: [] },
    );
    const lateReplayed = landscape.sentMessages.filter(
      (m) => m.msg.type === 'mux-ws-frame' && m.msg.clientSocketId === 'f-1-late',
    );
    expect(lateReplayed.length).toBe(0);

    // (c) >256KB frame dropped (not buffered, not fanned out, not sent upstream)
    const oversized = 'X'.repeat(WS_MAX_FRAME_BYTES + 1);
    const beforeUp = portrait.sentMessages.length;
    const beforeFol = landscape.sentMessages.length;
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-send', clientSocketId: 'f-0', isBinary: false, data: oversized },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'upstream-ws-frame', clientSocketId: 'c-0', isBinary: false, data: oversized },
    );
    expect(portrait.sentMessages.length).toBe(beforeUp);
    expect(landscape.sentMessages.length).toBe(beforeFol);

    // (d) 4MB global buffer cap across channels
    activeMux.clearTab('tab-budget');
    expect(activeMux.getStats().activeChannels).toBe(0);
    expect(activeMux.getStats().totalBufferedBytes).toBe(0);

    const chunk220k = 'M'.repeat(220 * 1024);
    for (let ch = 0; ch < 2; ch += 1) {
      sharedFakeIpcMain.emitMessage(
        WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
        makeFakeIpcEvent(portrait),
        { type: 'ws-open', clientSocketId: `big-${ch}`, url: `/big?i=${ch}`, protocols: [] },
      );
      sharedFakeIpcMain.emitMessage(
        WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
        makeFakeIpcEvent(portrait),
        { type: 'upstream-ws-open', clientSocketId: `big-${ch}`, protocol: '', extensions: '' },
      );
      for (let k = 0; k < 12; k += 1) {
        sharedFakeIpcMain.emitMessage(
          WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
          makeFakeIpcEvent(portrait),
          { type: 'upstream-ws-frame', clientSocketId: `big-${ch}`, isBinary: false, data: chunk220k },
        );
      }
    }
    expect(activeMux.getStats().totalBufferedBytes).toBeLessThanOrEqual(WS_MAX_TOTAL_BUFFER_BYTES);
    expect(activeMux.getStats().totalBufferedBytes).toBeGreaterThan(3 * 1024 * 1024);

    // clearTab frees all buffers cleanly.
    activeMux.clearTab('tab-budget');
    expect(activeMux.getStats().totalBufferedBytes).toBe(0);
    expect(activeMux.getStats().activeChannels).toBe(0);
  });

  test('SSE mux symmetric fan-out, follower close keeps owner alive, ownerTeardown promotes follower, and dispose() unregisters ipc', () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-sse',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-sse',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    // Owner + follower open SSE
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'sse-open', clientSocketId: 'p-es', url: '/sse', withCredentials: false },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'upstream-sse-open', clientSocketId: 'p-es' },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'sse-open', clientSocketId: 'l-es', url: '/sse', withCredentials: false },
    );
    expect(landscape.sentMessages[0]?.msg).toMatchObject({
      type: 'mux-grant',
      role: 'follower',
      alreadyOpen: true,
    });

    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      {
        type: 'upstream-sse-event',
        clientSocketId: 'p-es',
        eventType: 'room_state',
        data: '{"round":1}',
        lastEventId: 'r-1',
      },
    );
    expect(landscape.sentMessages[1]?.msg).toEqual({
      type: 'mux-sse-event',
      clientSocketId: 'l-es',
      eventType: 'room_state',
      data: '{"round":1}',
      lastEventId: 'r-1',
    });

    // Follower closes -> owner & channel stay alive!
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'sse-close', clientSocketId: 'l-es' },
    );
    expect(activeMux.getStats().activeChannels).toBe(1);

    // Follower re-joins and receives buffered handshake SSE event, then owner tears down -> ownerTeardown: true
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'sse-open', clientSocketId: 'l-es-2', url: '/sse', withCredentials: false },
    );
    expect(landscape.sentMessages.at(-1)?.msg).toEqual({
      type: 'mux-sse-event',
      clientSocketId: 'l-es-2',
      eventType: 'room_state',
      data: '{"round":1}',
      lastEventId: 'r-1',
    });

    activeMux.handleViewportTeardown(portrait.id);
    expect(activeMux.getStats().activeChannels).toBe(0);
    expect(landscape.sentMessages.at(-1)?.msg).toEqual({
      type: 'mux-sse-error',
      clientSocketId: 'l-es-2',
      fatal: false,
      ownerTeardown: true,
    });

    // Surviving follower re-opens and promotes to owner
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'sse-open', clientSocketId: 'l-es-2', url: '/sse', withCredentials: false },
    );
    expect(landscape.sentMessages.at(-1)?.msg).toMatchObject({
      type: 'mux-grant',
      role: 'owner',
    });

    // dispose() unregisters ipcMain listener
    const listenerCountBefore = sharedFakeIpcMain.listenerCount(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN);
    activeMux.dispose();
    activeMux = null;
    expect(sharedFakeIpcMain.listenerCount(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN)).toBe(
      listenerCountBefore - 1,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Iteration 2 Regression Tests (Reviewer + Challenger Findings)
// ---------------------------------------------------------------------------

describe('WsSseMux Iteration 2 regressions', () => {
  let activeMux: WsSseMuxInstance | null = null;

  afterEach(() => {
    activeMux?.dispose();
    activeMux = null;
  });

  beforeEach(() => {
    nextFakeWcId = 300;
  });

  test('resists post-shim Function.prototype.call/apply and EventTarget.prototype.addEventListener tampering', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    const WebSocketCtor = h.sandbox.WebSocket as typeof WebSocket;
    const EventSourceCtor = h.sandbox.EventSource as typeof EventSource;

    // Create and open an owner WebSocket BEFORE tampering.
    const wsPre = vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/pre');
        window.__preEvents = [];
        ws.onopen = () => window.__preEvents.push('onopen');
        ws.addEventListener('message', (ev) => window.__preEvents.push(ev.data instanceof ArrayBuffer ? Array.from(new Uint8Array(ev.data)) : ev.data));
        ws.addEventListener('message', { handleEvent: (ev) => window.__preEvents.push('he:' + (typeof ev.data === 'string' ? ev.data : 'bin')) });
        return ws;
      })()`,
      h.context,
    ) as WebSocket;

    await new Promise((r) => setTimeout(r, 15));
    const preOpen = toMain.find((m) => m.type === 'ws-open' && String(m.url).includes('/pre'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: preOpen.clientSocketId,
      kind: 'ws',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    const nativePre = h.nativeWsCreated[0]!;
    nativePre.triggerOpen();

    const etProto = Object.getPrototypeOf(h.FakeNativeWebSocket.prototype) as typeof EventTarget.prototype;
    const origEtAdd = etProto.addEventListener;
    const origEtRemove = etProto.removeEventListener;

    try {
      // Mutate EventTarget.prototype.addEventListener on shared prototype AND Function.prototype.call/apply inside VM.
      etProto.addEventListener = function () {
        throw new Error('TAMPERED EventTarget.prototype.addEventListener');
      };
      etProto.removeEventListener = function () {
        throw new Error('TAMPERED EventTarget.prototype.removeEventListener');
      };
      vm.runInContext(
        `
        Function.prototype.call = function() { throw new Error('TAMPERED Function.prototype.call'); };
        Function.prototype.apply = function() { throw new Error('TAMPERED Function.prototype.apply'); };
        Symbol = undefined;
        Number.isInteger = function() { return true; };
        `,
        h.context,
      );

      // Existing owner socket dispatches events & sends ArrayBuffer without touching tampered .call or .addEventListener
      nativePre.triggerMessage('hi');
      wsPre.send(new Uint8Array([1, 2, 3, 4]).buffer);
      await new Promise((r) => setTimeout(r, 15));
      expect(h.sandbox.__preEvents).toEqual(['onopen', 'hi', 'he:hi']);
      expect(toMain.some((m) => m.type === 'ws-send' && m.isBinary === true)).toBe(true);

      // New WebSocket & EventSource construction, instanceof, and startOwnerWebSocket under active tamper
      const postResult = vm.runInContext(
        `(() => {
          const ws = new WebSocket('wss://app.example.com/post', ['p1']);
          const es = new EventSource('https://app.example.com/post-sse');
          window.__postWs = ws;
          return {
            wsInst: ws instanceof WebSocket,
            esInst: es instanceof EventSource,
          };
        })()`,
        h.context,
      ) as { wsInst: boolean; esInst: boolean };
      expect(postResult.wsInst).toBe(true);
      expect(postResult.esInst).toBe(true);
      expect(wsPre instanceof WebSocketCtor).toBe(true);
      expect(vm.runInContext(`new EventSource('https://app.example.com/es2')`, h.context) instanceof EventSourceCtor).toBe(true);

      await new Promise((r) => setTimeout(r, 15));
      const postOpen = toMain.find((m) => m.type === 'ws-open' && String(m.url).includes('/post'))!;
      ch.port1.postMessage({
        type: 'mux-grant',
        clientSocketId: postOpen.clientSocketId,
        kind: 'ws',
        role: 'owner',
      } satisfies MainToMuxMessage);
      await new Promise((r) => setTimeout(r, 15));
      expect(h.nativeWsCreated.length).toBe(2);
    } finally {
      etProto.addEventListener = origEtAdd;
      etProto.removeEventListener = origEtRemove;
      ch.port1.close();
    }
  });

  test('MessageChannel handshake handles NewDocument-before-preload without dropping early pendingMessages (Probe 2A) and delayed preload via 15ms READY', async () => {
    // Case A: NewDocument runs first, opens early WS, then mirror-preload's upfront issueMuxPort arrives before 15ms.
    const hA = createVmBrowserHarness({ isTop: true });
    vm.runInContext(`window.__early = new WebSocket('wss://app.example.com/early-2a');`, hA.context);

    const ipcToMainA: unknown[] = [];
    let activePortA: MessagePort | null = null;
    const issuePortA = () => {
      if (activePortA) {
        activePortA.onmessage = null;
        activePortA.close();
      }
      const ch = new MessageChannel();
      activePortA = ch.port1;
      ch.port1.onmessage = (ev) => ipcToMainA.push(ev.data);
      ch.port1.start?.();
      hA.dispatchWindowMessage({
        source: hA.windowProxy,
        data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
        ports: [ch.port2],
      });
    };
    // Simulate mirror-preload executing ~2ms after NewDocument, plus listener for READY
    setTimeout(() => {
      issuePortA();
    }, 2);

    await new Promise((r) => setTimeout(r, 35));
    // Shim must NOT emit READY once activePort was established before 15ms, so ch1 was never closed!
    expect(hA.postedWindowMessages).toEqual([]);
    expect(ipcToMainA.length).toBe(1);
    expect((ipcToMainA[0] as { type: string; url: string }).type).toBe('ws-open');
    expect(hA.nativeWsCreated.length).toBe(0);
    (activePortA as MessagePort | null)?.close();

    // Case B: Initial preload init was missed before NewDocument -> 15ms READY triggers re-issue well before 150ms fail-open.
    const ipcToMainB: unknown[] = [];
    let activePortB: MessagePort | null = null;
    const hB = createVmBrowserHarness({
      isTop: true,
      onPostMessage: (data) => {
        if (data && typeof data === 'object' && (data as { type?: string }).type === WS_SSE_MUX_WINDOW_MESSAGES.READY) {
          const ch = new MessageChannel();
          activePortB = ch.port1;
          ch.port1.onmessage = (ev) => ipcToMainB.push(ev.data);
          ch.port1.start?.();
          hB.dispatchWindowMessage({
            source: hB.windowProxy,
            data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
            ports: [ch.port2],
          });
        }
      },
    });
    vm.runInContext(`window.__earlyB = new WebSocket('wss://app.example.com/early-2b');`, hB.context);
    await new Promise((r) => setTimeout(r, 45));
    expect(hB.postedWindowMessages).toEqual([{ type: WS_SSE_MUX_WINDOW_MESSAGES.READY }]);
    expect(ipcToMainB.length).toBe(1);
    expect((ipcToMainB[0] as { type: string }).type).toBe('ws-open');
    expect(hB.nativeWsCreated.length).toBe(0);
    (activePortB as MessagePort | null)?.close();
  });

  test('SSE Last-Event-ID persists across reconnects, id-only blocks, and follower-to-owner promotion when subsequent events omit id:', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    const enc = new TextEncoder();
    const seenLastEventHeaders: Array<string | null> = [];
    let attempt = 0;

    h.setFetchHandler(async (_url, init) => {
      attempt += 1;
      const headersObj = init.headers as Record<string, string> | undefined;
      seenLastEventHeaders.push(headersObj?.['Last-Event-ID'] ?? null);
      const currentAttempt = attempt;

      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
          start(ctrl) {
            if (currentAttempt === 1) {
              ctrl.enqueue(enc.encode('retry: 10\nevent: ping-evt\nid: evt-42\ndata: first\n\n'));
              ctrl.close();
            } else if (currentAttempt === 2) {
              // Event without id: followed by id-only block, then disconnect
              ctrl.enqueue(enc.encode('event: ping-evt\ndata: second-without-id\n\nid: evt-99\n\n'));
              ctrl.close();
            } else {
              ctrl.enqueue(enc.encode('data: third\n\n'));
            }
          },
        }),
      };
    });

    const esOwner = vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/sse-persist');
        window.__sseLogs = [];
        es.addEventListener('ping-evt', (ev) => window.__sseLogs.push({ t: 'ping-evt', d: ev.data, id: ev.lastEventId }));
        es.onmessage = (ev) => window.__sseLogs.push({ t: 'message', d: ev.data, id: ev.lastEventId });
        return es;
      })()`,
      h.context,
    ) as EventSource;

    await new Promise((r) => setTimeout(r, 15));
    const openMsg = toMain.find((m) => m.type === 'sse-open')!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: openMsg.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);

    await new Promise((r) => setTimeout(r, 80));
    esOwner.close();

    expect(seenLastEventHeaders.slice(0, 3)).toEqual([null, 'evt-42', 'evt-99']);
    expect(h.sandbox.__sseLogs).toEqual([
      { t: 'ping-evt', d: 'first', id: 'evt-42' },
      { t: 'ping-evt', d: 'second-without-id', id: 'evt-42' },
      { t: 'message', d: 'third', id: 'evt-99' },
    ]);
    const upstreamEvents = toMain.filter((m) => m.type === 'upstream-sse-event');
    expect(upstreamEvents[1]?.lastEventId).toBe('evt-42');

    // Follower promoted to owner retains lastEventId even when first owner event omits id:
    const promoHeaders: Array<string | null> = [];
    h.setFetchHandler(async (_url, init) => {
      const headersObj = init.headers as Record<string, string> | undefined;
      promoHeaders.push(headersObj?.['Last-Event-ID'] ?? null);
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(enc.encode('data: after-promo-no-id\n\n'));
          },
        }),
      };
    });

    const esPromo = vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/sse-promo');
        window.__promoLogs = [];
        es.onmessage = (ev) => window.__promoLogs.push({ d: ev.data, id: ev.lastEventId });
        return es;
      })()`,
      h.context,
    ) as EventSource;
    await new Promise((r) => setTimeout(r, 15));
    const promoOpen = toMain.find((m) => m.type === 'sse-open' && String(m.url).includes('/sse-promo'))!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: promoOpen.clientSocketId,
      kind: 'sse',
      role: 'follower',
      alreadyOpen: true,
    } satisfies MainToMuxMessage);
    ch.port1.postMessage({
      type: 'mux-sse-event',
      clientSocketId: promoOpen.clientSocketId,
      eventType: 'message',
      data: 'before-promo',
      lastEventId: 'id-9',
    } satisfies MainToMuxMessage);
    ch.port1.postMessage({
      type: 'mux-sse-error',
      clientSocketId: promoOpen.clientSocketId,
      fatal: false,
      ownerTeardown: true,
      retryMs: 5,
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 30));
    const promoReopen = toMain.filter(
      (m) => m.type === 'sse-open' && m.clientSocketId === promoOpen.clientSocketId,
    );
    expect(promoReopen.length).toBe(2);
    expect(promoReopen[1]?.lastEventId).toBe('id-9');

    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: promoOpen.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 30));
    esPromo.close();

    expect(promoHeaders).toEqual(['id-9']);
    expect(h.sandbox.__promoLogs).toEqual([
      { d: 'before-promo', id: 'id-9' },
      { d: 'after-promo-no-id', id: 'id-9' },
    ]);
    ch.port1.close();
  });

  test('ws.close(NaN/Infinity/non-int) throws InvalidAccessError and rejected inbound Blob does not wedge subsequent Blobs', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    const closeErrors = vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/close-validation');
        window.__valWs = ws;
        const results = [];
        for (const bad of [Number.NaN, Infinity, -Infinity, 1000.5, 1001, 2999, 5000]) {
          try {
            ws.close(bad);
            results.push({ bad: String(bad), threw: false });
          } catch (err) {
            results.push({ bad: String(bad), threw: true, name: err.name });
          }
        }
        return results;
      })()`,
      h.context,
    ) as Array<{ bad: string; threw: boolean; name?: string }>;

    for (const r of closeErrors) {
      expect(r.threw).toBe(true);
      expect(r.name).toBe('InvalidAccessError');
    }

    // Grant owner and send a rejecting Blob followed by a valid Blob
    await new Promise((r) => setTimeout(r, 15));
    const openMsg = toMain.find((m) => m.type === 'ws-open')!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: openMsg.clientSocketId,
      kind: 'ws',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));

    const nativeWs = h.nativeWsCreated[0]!;
    nativeWs.triggerOpen();

    vm.runInContext(
      `
      window.__blobMsgs = [];
      window.__valWs.binaryType = 'arraybuffer';
      window.__valWs.addEventListener('message', (ev) => {
        window.__blobMsgs.push(Array.from(new Uint8Array(ev.data)));
      });
      `,
      h.context,
    );

    const badBlob = Object.create(Blob.prototype) as Blob;
    nativeWs.triggerMessage(badBlob);
    nativeWs.triggerMessage(new Blob([new Uint8Array([9, 8, 7])]));

    await new Promise((r) => setTimeout(r, 30));
    expect(h.sandbox.__blobMsgs).toEqual([[9, 8, 7]]);
    ch.port1.close();
  });

  test('syncViewport onDetach race during in-flight Page.addScriptToEvaluateOnNewDocument prevents stale scriptIdentifier and allows onReattach', async () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-race',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: null,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);
    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    let resolveAdd!: (val: unknown) => void;
    let addCalls = 0;
    portrait.debugger.commandHandler = (method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        addCalls += 1;
        if (addCalls === 1) {
          return new Promise((res) => {
            resolveAdd = res;
          });
        }
        return Promise.resolve({ identifier: `fresh-${addCalls}` });
      }
      return Promise.resolve({});
    };

    const syncPromise = activeMux.syncViewport(portrait, true);
    // Wait until Page.addScriptToEvaluateOnNewDocument is actually in-flight.
    await new Promise((r) => setTimeout(r, 10));
    expect(addCalls).toBe(1);

    // Emit detach while addScript is awaiting, then resolve addScript with stale identifier.
    portrait.debugger.attached = false;
    portrait.debugger.emit('detach', {}, 'replaced_with_devtools');
    resolveAdd({ identifier: 'stale-id-1' });
    await syncPromise;

    expect(activeMux.getStats().installedWcIds).toEqual([]);

    // Reattach must cleanly re-install the shim.
    await coordinator.reattachAndRestore(portrait);
    await new Promise((r) => setTimeout(r, 15));
    expect(addCalls).toBe(2);
    expect(activeMux.getStats().installedWcIds).toEqual([portrait.id]);
  });

  test('syncViewport(wc, false) tears down live channels cleanly on both owner & follower (Dual->Single and Dedup Off) and preserves in-flight owner ws-send', async () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');
    let activeFlag = true;

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-teardown',
          role: 'portrait',
          get active() {
            return activeFlag;
          },
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-teardown',
          role: 'landscape',
          get active() {
            return activeFlag;
          },
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);
    await activeMux.syncViewport(portrait, true);
    await activeMux.syncViewport(landscape, true);

    // Case 1: Dual -> Single when Landscape is owner & Portrait is follower.
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-open', clientSocketId: 'l-owner', url: '/room', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'upstream-ws-open', clientSocketId: 'l-owner', protocol: '', extensions: '' },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-fol', url: '/room', protocols: [] },
    );

    // Destroy portrait and flip active = false before syncViewport(landscape, false) finishes
    activeFlag = false;
    portrait.destroy();
    activeMux.disposeWebContents(portrait.id);

    // During transition before syncViewport(landscape, false) completes, owner ws-send must NOT be dropped!
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(landscape),
      { type: 'ws-send', clientSocketId: 'l-owner', isBinary: false, data: 'in-flight-msg' },
    );
    expect(
      landscape.sentMessages.some(
        (m) => m.msg.type === 'mux-ws-send-upstream' && m.msg.data === 'in-flight-msg',
      ),
    ).toBe(true);

    await activeMux.syncViewport(landscape, false);
    expect(activeMux.getStats().activeChannels).toBe(0);
    expect(landscape.sentMessages.at(-1)?.msg).toEqual({
      type: 'mux-ws-close',
      clientSocketId: 'l-owner',
      code: WS_OWNER_TEARDOWN_CLOSE_CODE,
      reason: 'mux-owner-teardown',
      wasClean: true,
    });

    // Case 2: Dedup Off with both viewports alive (WS + SSE).
    const p2 = new FakeMuxWebContents('https://app.example.com');
    const l2 = new FakeMuxWebContents('https://app.example.com');
    let dedupOn = true;
    ctxMap.set(p2.id, {
      tabId: 'tab-dedup-off',
      role: 'portrait',
      get active() {
        return dedupOn;
      },
      wc: p2,
      pairedWc: l2,
      getOrigin: (w) => w.mainFrame?.origin ?? null,
    });
    ctxMap.set(l2.id, {
      tabId: 'tab-dedup-off',
      role: 'landscape',
      get active() {
        return dedupOn;
      },
      wc: l2,
      pairedWc: p2,
      getOrigin: (w) => w.mainFrame?.origin ?? null,
    });
    await activeMux.syncViewport(p2, true);
    await activeMux.syncViewport(l2, true);

    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(p2),
      { type: 'ws-open', clientSocketId: 'p2-ws', url: '/ws2', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(l2),
      { type: 'ws-open', clientSocketId: 'l2-ws', url: '/ws2', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(p2),
      { type: 'sse-open', clientSocketId: 'p2-sse', url: '/sse2', withCredentials: false },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(l2),
      { type: 'sse-open', clientSocketId: 'l2-sse', url: '/sse2', withCredentials: false },
    );
    expect(activeMux.getStats().activeChannels).toBe(2);

    dedupOn = false;
    await activeMux.syncViewport(p2, false);
    await activeMux.syncViewport(l2, false);

    expect(activeMux.getStats().activeChannels).toBe(0);
    expect(p2.sentMessages.some((m) => m.msg.type === 'mux-ws-close' && m.msg.clientSocketId === 'p2-ws' && m.msg.code === 1012)).toBe(true);
    expect(l2.sentMessages.some((m) => m.msg.type === 'mux-ws-close' && m.msg.clientSocketId === 'l2-ws' && m.msg.code === 1012)).toBe(true);
    expect(p2.sentMessages.some((m) => m.msg.type === 'mux-sse-error' && m.msg.clientSocketId === 'p2-sse' && m.msg.ownerTeardown === true)).toBe(true);
    expect(l2.sentMessages.some((m) => m.msg.type === 'mux-sse-error' && m.msg.clientSocketId === 'l2-sse' && m.msg.ownerTeardown === true)).toBe(true);
  });

  test('owner MuxedWebSocket and MuxedEventSource handle main teardown (1012 / ownerTeardown) cleanly and reconnect as bypass', async () => {
    const h = createVmBrowserHarness({ isTop: true });
    const ch = new MessageChannel();
    const toMain: Array<{ type: string; clientSocketId: string; [k: string]: unknown }> = [];
    ch.port1.onmessage = (ev) => toMain.push(ev.data);
    h.dispatchWindowMessage({
      source: h.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [ch.port2],
    });

    // Owner WS teardown
    const ownerWs = vm.runInContext(
      `(() => {
        const ws = new WebSocket('wss://app.example.com/owner-td');
        window.__ownWsLogs = [];
        ws.addEventListener('open', () => window.__ownWsLogs.push('open'));
        ws.addEventListener('error', () => window.__ownWsLogs.push('error'));
        ws.addEventListener('close', (ev) => window.__ownWsLogs.push('close:' + ev.code + ':' + ev.wasClean));
        return ws;
      })()`,
      h.context,
    ) as WebSocket;

    await new Promise((r) => setTimeout(r, 15));
    const wsOpen = toMain.find((m) => m.type === 'ws-open')!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: wsOpen.clientSocketId,
      kind: 'ws',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    const nativeOwnerWs = h.nativeWsCreated[0]!;
    nativeOwnerWs.triggerOpen();

    await new Promise((r) => setTimeout(r, 15));
    const toMainCountBeforeClose = toMain.length;
    ch.port1.postMessage({
      type: 'mux-ws-close',
      clientSocketId: wsOpen.clientSocketId,
      code: 1012,
      reason: 'mux-owner-teardown',
      wasClean: true,
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));

    expect(ownerWs.readyState).toBe(3);
    expect(nativeOwnerWs.closedCalls.length).toBe(1);
    expect(nativeOwnerWs.closedCalls[0]?.code).toBe(1000);
    // Must not emit spurious upstream-ws-error or duplicate upstream-ws-close
    expect(toMain.slice(toMainCountBeforeClose)).toEqual([]);
    expect(h.sandbox.__ownWsLogs).toEqual(['open', 'close:1012:true']);

    // Owner SSE teardown aborts fetch stream, fires error (readyState=0), and reconnects -> bypass
    let abortedSignal: AbortSignal | undefined;
    h.setFetchHandler(async (_url, init) => {
      abortedSignal = init.signal ?? undefined;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({ start() {} }),
      };
    });

    const ownerEs = vm.runInContext(
      `(() => {
        const es = new EventSource('https://app.example.com/owner-sse-td');
        window.__ownEsLogs = [];
        es.addEventListener('open', () => window.__ownEsLogs.push('open'));
        es.addEventListener('error', () => window.__ownEsLogs.push('error:rs=' + es.readyState));
        return es;
      })()`,
      h.context,
    ) as EventSource;
    await new Promise((r) => setTimeout(r, 15));
    const esOpen = toMain.find((m) => m.type === 'sse-open')!;
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: esOpen.clientSocketId,
      kind: 'sse',
      role: 'owner',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(abortedSignal?.aborted).toBe(false);

    ch.port1.postMessage({
      type: 'mux-sse-error',
      clientSocketId: esOpen.clientSocketId,
      fatal: false,
      ownerTeardown: true,
      retryMs: 10,
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 30));

    expect(abortedSignal?.aborted).toBe(true);
    expect(h.sandbox.__ownEsLogs).toEqual(['open', 'error:rs=0']);
    const sseOpens = toMain.filter((m) => m.type === 'sse-open' && m.clientSocketId === esOpen.clientSocketId);
    expect(sseOpens.length).toBe(2);

    // Grant bypass on reconnect -> opens NativeEventSource
    ch.port1.postMessage({
      type: 'mux-grant',
      clientSocketId: esOpen.clientSocketId,
      kind: 'sse',
      role: 'bypass',
    } satisfies MainToMuxMessage);
    await new Promise((r) => setTimeout(r, 15));
    expect(h.nativeEsCreated.length).toBe(1);
    ownerEs.close();
    ch.port1.close();
  });

  test('getStats prunes expired TTL buffers and close/error handlers reject mismatched initiatorOrigin', () => {
    let nowMs = 100_000;
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');
    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-minor',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-minor',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null, { now: () => nowMs });
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'p-m', url: '/m', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'upstream-ws-open', clientSocketId: 'p-m', protocol: '', extensions: '' },
    );
    // Send a sliced view over a larger backing buffer to verify sliced storage + TTL pruning
    const bigBacking = new Uint8Array(4096);
    const smallSlice = bigBacking.subarray(10, 110);
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'upstream-ws-frame', clientSocketId: 'p-m', isBinary: true, data: smallSlice },
    );
    expect(activeMux.getStats().totalBufferedBytes).toBe(100);

    // Mismatched initiatorOrigin on ws-close must be ignored
    portrait.mainFrame = { origin: 'https://evil.example.com' };
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-close', clientSocketId: 'p-m' },
    );
    expect(activeMux.getStats().activeChannels).toBe(1);

    // Advancing past handshake TTL causes getStats() to prune expired buffers immediately
    nowMs += WS_HANDSHAKE_BUFFER_TTL_MS + 10;
    expect(activeMux.getStats().totalBufferedBytes).toBe(0);
  });

  test('SSE owner transient disconnect and reconnect within handshake TTL does not replay buffered events to follower (EXTRA_1)', async () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');
    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-extra1',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-extra1',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    const hP = createVmBrowserHarness({ isTop: true });
    const hL = createVmBrowserHarness({ isTop: true });
    const chP = new MessageChannel();
    const chL = new MessageChannel();

    const origSendP = portrait.send.bind(portrait);
    portrait.send = (channel: string, ...args: unknown[]) => {
      origSendP(channel, ...args);
      if (channel === WS_SSE_MUX_IPC_CHANNELS.TO_RENDERER && args.length > 0) {
        chP.port1.postMessage(args[0]);
      }
    };
    const origSendL = landscape.send.bind(landscape);
    landscape.send = (channel: string, ...args: unknown[]) => {
      origSendL(channel, ...args);
      if (channel === WS_SSE_MUX_IPC_CHANNELS.TO_RENDERER && args.length > 0) {
        chL.port1.postMessage(args[0]);
      }
    };

    chP.port1.onmessage = (ev) => {
      sharedFakeIpcMain.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, makeFakeIpcEvent(portrait), ev.data);
    };
    chL.port1.onmessage = (ev) => {
      sharedFakeIpcMain.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, makeFakeIpcEvent(landscape), ev.data);
    };
    chP.port1.start?.();
    chL.port1.start?.();

    hP.dispatchWindowMessage({
      source: hP.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [chP.port2],
    });
    hL.dispatchWindowMessage({
      source: hL.windowProxy,
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      ports: [chL.port2],
    });

    const enc = new TextEncoder();
    let attempt = 0;
    const ctrls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    const seenLastEventHeaders: Array<string | null> = [];

    hP.setFetchHandler(async (_url, init) => {
      attempt += 1;
      const headersObj = init.headers as Record<string, string> | undefined;
      seenLastEventHeaders.push(headersObj?.['Last-Event-ID'] ?? null);
      const current = attempt;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrls.push(ctrl);
            if (current === 1) {
              ctrl.enqueue(enc.encode('retry: 10\nid: t-1\ndata: m1\n\n'));
            } else {
              ctrl.enqueue(enc.encode('data: m2\n\n'));
            }
          },
        }),
      };
    });

    try {
      // 1. Owner opens SSE and emits id: t-1 / data: m1
      vm.runInContext(
        `(() => {
          const es = new EventSource('https://app.example.com/tr-sse');
          window.__logs = [];
          window.__ids = [];
          es.addEventListener('open', () => window.__logs.push('open'));
          es.addEventListener('message', (ev) => {
            window.__logs.push(ev.data);
            window.__ids.push(ev.lastEventId);
          });
          es.addEventListener('error', () => window.__logs.push('error'));
          window.__es = es;
        })()`,
        hP.context,
      );

      await new Promise((r) => setTimeout(r, 30));
      expect(hP.sandbox.__logs).toEqual(['open', 'm1']);

      // 2. Follower joins after m1 is buffered (alreadyOpen: true) -> receives m1 once
      vm.runInContext(
        `(() => {
          const es = new EventSource('https://app.example.com/tr-sse');
          window.__logs = [];
          window.__ids = [];
          es.addEventListener('open', () => window.__logs.push('open'));
          es.addEventListener('message', (ev) => {
            window.__logs.push(ev.data);
            window.__ids.push(ev.lastEventId);
          });
          es.addEventListener('error', () => window.__logs.push('error'));
          window.__es = es;
        })()`,
        hL.context,
      );

      await new Promise((r) => setTimeout(r, 30));
      expect(hL.sandbox.__logs).toEqual(['open', 'm1']);

      // 3. Owner Stream 1 EOF -> upstream-sse-error { fatal: false } -> Stream 2 opens -> emits m2 within TTL
      ctrls[0]?.close();
      await new Promise((r) => setTimeout(r, 60));

      expect(attempt).toBe(2);
      expect(seenLastEventHeaders).toEqual([null, 't-1']);
      expect(hP.sandbox.__logs).toEqual(['open', 'm1', 'error', 'open', 'm2']);
      expect(hL.sandbox.__logs).toEqual(['open', 'm1', 'error', 'open', 'm2']);
      expect(hP.sandbox.__ids).toEqual(['t-1', 't-1']);
      expect(hL.sandbox.__ids).toEqual(['t-1', 't-1']);
      expect(hL.fetchCalls.length).toBe(0);

      // Clean up streams
      ctrls[1]?.close();
      vm.runInContext(`window.__es.close()`, hP.context);
      vm.runInContext(`window.__es.close()`, hL.context);
    } finally {
      chP.port1.close();
      chL.port1.close();
    }
  });

  test('F-06: second concurrent socket to the same URL from the SAME viewport bypasses mux so closing first does not cross-close second', () => {
    const coordinator = new DebuggerCoordinator();
    const portrait = new FakeMuxWebContents('https://app.example.com');
    const landscape = new FakeMuxWebContents('https://app.example.com');

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        portrait.id,
        {
          tabId: 'tab-f06',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        landscape.id,
        {
          tabId: 'tab-f06',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'ws-1', url: '/live', protocols: [] },
    );
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-open', clientSocketId: 'ws-2', url: '/live', protocols: [] },
    );

    expect(portrait.sentMessages[0]?.msg).toMatchObject({
      type: 'mux-grant',
      clientSocketId: 'ws-1',
      role: 'owner',
    });
    expect(portrait.sentMessages[1]?.msg).toMatchObject({
      type: 'mux-grant',
      clientSocketId: 'ws-2',
      role: 'bypass',
    });

    // Closing ws-1 on portrait does not send 1012 teardown to ws-2
    sharedFakeIpcMain.emitMessage(
      WS_SSE_MUX_IPC_CHANNELS.TO_MAIN,
      makeFakeIpcEvent(portrait),
      { type: 'ws-close', clientSocketId: 'ws-1', code: 1000, reason: 'done' },
    );
    expect(
      portrait.sentMessages.some(
        (m) => (m.msg as { clientSocketId?: string }).clientSocketId === 'ws-2' && m.msg.type === 'mux-ws-close',
      ),
    ).toBe(false);
  });
});
