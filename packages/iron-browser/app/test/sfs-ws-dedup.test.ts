import { deflateSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  buildClusterSiblingChannelKey,
  parseSfsBinaryPacket,
} from '../src/main/sfs-binary-codec';
import {
  WS_HANDSHAKE_BUFFER_TTL_MS,
  WS_MAX_FRAME_BYTES,
  WS_SSE_MUX_IPC_CHANNELS,
  WS_SSE_MUX_WINDOW_MESSAGES,
  buildWsSseMuxShimScript,
  type MainToMuxMessage,
} from '../src/shared/ws-sse-mux-core';
import { DebuggerCoordinator } from '../src/main/debugger-coordinator';
import vm from 'node:vm';

class FakeIpcMain {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(channel: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return this;
  }

  off(channel: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }

  removeListener(channel: string, listener: (...args: unknown[]) => void): this {
    return this.off(channel, listener);
  }

  emitMessage(channel: string, event: unknown, payload: unknown): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const fn of Array.from(set)) {
      fn(event, payload);
    }
  }
}

const fakeIpc = new FakeIpcMain();
mock.module('electron', () => ({
  ipcMain: fakeIpc,
}));

import type { MuxWebContents, WsMuxViewportContext, WsSseMux as WsSseMuxType } from '../src/main/ws-sse-mux';
const { WsSseMux } = await import('../src/main/ws-sse-mux');

// ---------------------------------------------------------------------------
// Minimal SFS2X Binary Packet Encoder for Deterministic Testing
// ---------------------------------------------------------------------------

type SfsFieldSpec =
  | { type: 'null' }
  | { type: 'bool'; value: boolean }
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'double'; value: number }
  | { type: 'utf'; value: string }
  | { type: 'text'; value: string }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'utfArray'; value: string[] }
  | { type: 'intArray'; value: number[] }
  | { type: 'array'; value: SfsFieldSpec[] }
  | { type: 'object'; value: Record<string, SfsFieldSpec> };

function encodeSfsField(spec: SfsFieldSpec): Uint8Array {
  const enc = new TextEncoder();
  switch (spec.type) {
    case 'null':
      return new Uint8Array([0]);
    case 'bool':
      return new Uint8Array([1, spec.value ? 1 : 0]);
    case 'byte':
      return new Uint8Array([2, spec.value & 0xff]);
    case 'short': {
      const b = new Uint8Array(3);
      b[0] = 3;
      new DataView(b.buffer).setInt16(1, spec.value, false);
      return b;
    }
    case 'int': {
      const b = new Uint8Array(5);
      b[0] = 4;
      new DataView(b.buffer).setInt32(1, spec.value, false);
      return b;
    }
    case 'double': {
      const b = new Uint8Array(9);
      b[0] = 7;
      new DataView(b.buffer).setFloat64(1, spec.value, false);
      return b;
    }
    case 'utf': {
      const strBytes = enc.encode(spec.value);
      const b = new Uint8Array(3 + strBytes.byteLength);
      b[0] = 8;
      new DataView(b.buffer).setUint16(1, strBytes.byteLength, false);
      b.set(strBytes, 3);
      return b;
    }
    case 'text': {
      const strBytes = enc.encode(spec.value);
      const b = new Uint8Array(5 + strBytes.byteLength);
      b[0] = 20;
      new DataView(b.buffer).setUint32(1, strBytes.byteLength, false);
      b.set(strBytes, 5);
      return b;
    }
    case 'bytes': {
      const b = new Uint8Array(5 + spec.value.byteLength);
      b[0] = 10;
      new DataView(b.buffer).setUint32(1, spec.value.byteLength, false);
      b.set(spec.value, 5);
      return b;
    }
    case 'utfArray': {
      const chunks: Uint8Array[] = [];
      const hdr = new Uint8Array(3);
      hdr[0] = 16;
      new DataView(hdr.buffer).setUint16(1, spec.value.length, false);
      chunks.push(hdr);
      for (const s of spec.value) {
        const sb = enc.encode(s);
        const lb = new Uint8Array(2 + sb.byteLength);
        new DataView(lb.buffer).setUint16(0, sb.byteLength, false);
        lb.set(sb, 2);
        chunks.push(lb);
      }
      return concatBytes(chunks);
    }
    case 'intArray': {
      const b = new Uint8Array(3 + spec.value.length * 4);
      b[0] = 12;
      const dv = new DataView(b.buffer);
      dv.setUint16(1, spec.value.length, false);
      spec.value.forEach((v, idx) => dv.setInt32(3 + idx * 4, v, false));
      return b;
    }
    case 'array': {
      const chunks: Uint8Array[] = [];
      const hdr = new Uint8Array(3);
      hdr[0] = 17;
      new DataView(hdr.buffer).setUint16(1, spec.value.length, false);
      chunks.push(hdr);
      for (const item of spec.value) chunks.push(encodeSfsField(item));
      return concatBytes(chunks);
    }
    case 'object': {
      const entries = Object.entries(spec.value);
      const chunks: Uint8Array[] = [];
      const hdr = new Uint8Array(3);
      hdr[0] = 18;
      new DataView(hdr.buffer).setUint16(1, entries.length, false);
      chunks.push(hdr);
      for (const [k, v] of entries) {
        const kb = enc.encode(k);
        const keyHdr = new Uint8Array(2 + kb.byteLength);
        new DataView(keyHdr.buffer).setUint16(0, kb.byteLength, false);
        keyHdr.set(kb, 2);
        chunks.push(keyHdr, encodeSfsField(v));
      }
      return concatBytes(chunks);
    }
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function encodeSfsEnvelope(
  controller: number,
  action: number,
  params: Record<string, SfsFieldSpec>,
  opts: { compress?: boolean; bigSized?: boolean } = {},
): Uint8Array {
  const body = encodeSfsField({
    type: 'object',
    value: {
      c: { type: 'byte', value: controller },
      a: { type: 'short', value: action },
      p: { type: 'object', value: params },
    },
  });
  const payload = opts.compress ? new Uint8Array(deflateSync(body)) : body;
  const big = Boolean(opts.bigSized);
  const headerByte = 0x80 | (opts.compress ? 0x20 : 0) | (big ? 0x08 : 0);
  const hdrLen = big ? 5 : 3;
  const packet = new Uint8Array(hdrLen + payload.byteLength);
  packet[0] = headerByte;
  const dv = new DataView(packet.buffer);
  if (big) {
    dv.setUint32(1, payload.byteLength, false);
  } else {
    dv.setUint16(1, payload.byteLength, false);
  }
  packet.set(payload, hdrLen);
  return packet;
}

class FakeSfsDebugger extends EventEmitter {
  private attached = false;
  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  async sendCommand(method?: string): Promise<unknown> {
    return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'id-1' } : {};
  }
}

let nextWcSeq = 500;
class FakeWc extends EventEmitter implements MuxWebContents {
  readonly id = nextWcSeq++;
  readonly debugger = new FakeSfsDebugger();
  mainFrame: { origin: string } | null;
  destroyed = false;
  sent: MainToMuxMessage[] = [];

  constructor(origin = 'https://aviator-demo.spribegaming.com') {
    super();
    this.mainFrame = { origin };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(_channel: string, ...args: unknown[]): void {
    if (args[0]) this.sent.push(args[0] as MainToMuxMessage);
  }
}

function ipcEv(wc: FakeWc) {
  return { sender: { id: wc.id }, senderFrame: wc.mainFrame };
}

describe('SmartFoxServer 2X binary codec & cluster sibling key', () => {
  test('parseSfsBinaryPacket canonicalizes volatile device/seed/timestamp keys across uncompressed, zlib-compressed, and big-sized frames while preserving domain fields', () => {
    const portraitLogin = encodeSfsEnvelope(0, 1, {
      zn: { type: 'utf', value: 'aviator_core_inst2_demo1' },
      un: { type: 'utf', value: '51336&&demo' },
      pw: { type: 'utf', value: '' },
      p: {
        type: 'object',
        value: {
          token: { type: 'utf', value: 'scxyUIu7YGAyzfeklgHPt1hozA6z83pI' },
          currency: { type: 'utf', value: 'USD' },
          sessionToken: { type: 'utf', value: 'portrait-random-64-hex' },
          platform: {
            type: 'object',
            value: {
              deviceType: { type: 'utf', value: 'MOBILE' },
              userAgent: { type: 'utf', value: 'iPhone iOS 17' },
            },
          },
        },
      },
    });

    const landscapeLogin = encodeSfsEnvelope(
      0,
      1,
      {
        zn: { type: 'utf', value: 'aviator_core_inst2_demo1' },
        un: { type: 'utf', value: '51336&&demo' },
        pw: { type: 'utf', value: '' },
        p: {
          type: 'object',
          value: {
            currency: { type: 'utf', value: 'USD' },
            token: { type: 'utf', value: 'scxyUIu7YGAyzfeklgHPt1hozA6z83pI' },
            sessionToken: { type: 'utf', value: 'landscape-random-64-hex-different' },
            platform: {
              type: 'object',
              value: {
                deviceType: { type: 'utf', value: 'DESKTOP' },
                userAgent: { type: 'utf', value: 'Mozilla/5.0 Linux x86_64' },
              },
            },
          },
        },
      },
      { compress: true, bigSized: true },
    );

    const parsedP = parseSfsBinaryPacket(portraitLogin);
    const parsedL = parseSfsBinaryPacket(landscapeLogin);
    expect(parsedP).not.toBeNull();
    expect(parsedL).not.toBeNull();
    expect(parsedP?.controller).toBe(0);
    expect(parsedP?.action).toBe(1);
    expect(parsedP?.canonicalJson).toBe(parsedL?.canonicalJson);

    // Mirrored Bet with rotated Provably Fair clientSeed and CashOut with Date.now() double
    const betP = parseSfsBinaryPacket(
      encodeSfsEnvelope(1, 13, {
        c: { type: 'utf', value: 'betHandler' },
        r: { type: 'int', value: -1 },
        p: {
          type: 'object',
          value: {
            bet: { type: 'double', value: 1 },
            betId: { type: 'double', value: 1 },
            clientSeed: { type: 'utf', value: 'SEED_PORTRAIT_AAA' },
          },
        },
      }),
    );
    const betL = parseSfsBinaryPacket(
      encodeSfsEnvelope(1, 13, {
        c: { type: 'utf', value: 'betHandler' },
        r: { type: 'int', value: -1 },
        p: {
          type: 'object',
          value: {
            bet: { type: 'double', value: 1 },
            betId: { type: 'double', value: 1 },
            clientSeed: { type: 'utf', value: 'SEED_LANDSCAPE_BBB' },
          },
        },
      }),
    );
    const betPanel2 = parseSfsBinaryPacket(
      encodeSfsEnvelope(1, 13, {
        c: { type: 'utf', value: 'betHandler' },
        r: { type: 'int', value: -1 },
        p: {
          type: 'object',
          value: {
            bet: { type: 'double', value: 1 },
            betId: { type: 'double', value: 2 },
            clientSeed: { type: 'utf', value: 'SEED_PANEL_2' },
          },
        },
      }),
    );
    expect(betP?.cmd).toBe('betHandler');
    expect(betP?.canonicalJson).toBe(betL?.canonicalJson);
    expect(betP?.canonicalJson).not.toBe(betPanel2?.canonicalJson);

    const cashP = parseSfsBinaryPacket(
      encodeSfsEnvelope(1, 13, {
        c: { type: 'utf', value: 'cashOutHandler' },
        r: { type: 'int', value: -1 },
        p: {
          type: 'object',
          value: {
            betId: { type: 'double', value: 1 },
            currentTimestamp: { type: 'double', value: 1795744200101 },
          },
        },
      }),
    );
    const cashL = parseSfsBinaryPacket(
      encodeSfsEnvelope(1, 13, {
        c: { type: 'utf', value: 'cashOutHandler' },
        r: { type: 'int', value: -1 },
        p: {
          type: 'object',
          value: {
            betId: { type: 'double', value: 1 },
            currentTimestamp: { type: 'double', value: 1795744200118 },
          },
        },
      }),
    );
    expect(cashP?.canonicalJson).toBe(cashL?.canonicalJson);

    // Rejects non-SFS binary, truncated length, trailing bytes, and zlib bombs > maxBytes
    expect(parseSfsBinaryPacket(new Uint8Array([0, 1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(parseSfsBinaryPacket(portraitLogin.subarray(0, portraitLogin.byteLength - 2))).toBeNull();
    const trailing = concatBytes([portraitLogin, new Uint8Array([99])]);
    expect(parseSfsBinaryPacket(trailing)).toBeNull();

    const bombRaw = new Uint8Array(4096);
    const bombPacket = encodeSfsEnvelope(
      1,
      13,
      { c: { type: 'utf', value: 'big' }, p: { type: 'bytes', value: bombRaw } },
      { compress: true },
    );
    expect(parseSfsBinaryPacket(bombPacket, 512)).toBeNull();
    expect(parseSfsBinaryPacket(bombPacket, WS_MAX_FRAME_BYTES)?.cmd).toBe('big');
  });

  test('buildClusterSiblingChannelKey matches numbered cluster shards on same origin & path while isolating distinct services, origins, and IP/localhost hosts', () => {
    const k1 = buildClusterSiblingChannelKey({
      tabId: 'tab-3',
      initiatorOrigin: 'https://aviator-demo.spribegaming.com',
      normalizedUrl: 'wss://app-demo.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });
    const k2 = buildClusterSiblingChannelKey({
      tabId: 'tab-3',
      initiatorOrigin: 'https://aviator-demo.spribegaming.com',
      normalizedUrl: 'wss://app-demo2.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });
    const k3 = buildClusterSiblingChannelKey({
      tabId: 'tab-3',
      initiatorOrigin: 'https://aviator-demo.spribegaming.com',
      normalizedUrl: 'wss://app-demo-03.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });
    const kDifferentService = buildClusterSiblingChannelKey({
      tabId: 'tab-3',
      initiatorOrigin: 'https://aviator-demo.spribegaming.com',
      normalizedUrl: 'wss://engagement.spribegaming.com/api/v1/public/engagement/et-player-stomp',
      protocols: [],
    });
    const kDifferentOrigin = buildClusterSiblingChannelKey({
      tabId: 'tab-3',
      initiatorOrigin: 'https://other.spribegaming.com',
      normalizedUrl: 'wss://app-demo2.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });

    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
    expect(k1).not.toBe(kDifferentService);
    expect(k1).not.toBe(kDifferentOrigin);
    expect(
      buildClusterSiblingChannelKey({
        tabId: 'tab-3',
        initiatorOrigin: 'http://127.0.0.1:8080',
        normalizedUrl: 'ws://127.0.0.1:8080/ws',
      }),
    ).toBeNull();
    expect(
      buildClusterSiblingChannelKey({
        tabId: 'tab-3',
        initiatorOrigin: 'https://example.com',
        normalizedUrl: 'wss://example.com/ws',
      }),
    ).toBeNull();
  });
});

describe('WsSseMux SFS2X session dedup, cluster shard failover race, and dedupCount wiring', () => {
  let activeMux: WsSseMuxType | null = null;

  afterEach(() => {
    activeMux?.dispose();
    activeMux = null;
  });

  test('dead cluster shard race promotes slow connecting owner to follower on healthy shard and deduplicates SFS2X Handshake + Login + Bet', () => {
    let nowMs = 1_000;
    let dedupIncrements = 0;
    const coordinator = new DebuggerCoordinator();
    const landscape = new FakeWc();
    const portrait = new FakeWc();

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        landscape.id,
        {
          tabId: 'tab-aviator',
          role: 'landscape',
          active: true,
          wc: landscape,
          pairedWc: portrait,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        portrait.id,
        {
          tabId: 'tab-aviator',
          role: 'portrait',
          active: true,
          wc: portrait,
          pairedWc: landscape,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null, {
      now: () => nowMs,
      onDedupIncrement: (_wcId, delta) => {
        dedupIncrements += delta;
      },
    });

    // 1. Landscape picks dead shard app-demo; Portrait picks live shard app-demo2. Both start as owners racing.
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(landscape), {
      type: 'ws-open',
      clientSocketId: 'l-ws-1',
      url: 'wss://app-demo.spribegaming.com:443/BlueBox/websocket',
      protocols: [],
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'ws-open',
      clientSocketId: 'p-ws-1',
      url: 'wss://app-demo2.spribegaming.com:443/BlueBox/websocket',
      protocols: [],
    });

    expect(landscape.sent[0]).toMatchObject({ type: 'mux-grant', role: 'owner' });
    expect(portrait.sent[0]).toMatchObject({ type: 'mux-grant', role: 'owner' });

    // 2. Portrait's live shard opens first -> Landscape is promoted to follower on Portrait's channel!
    nowMs += 300;
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'upstream-ws-open',
      clientSocketId: 'p-ws-1',
      protocol: '',
      extensions: '',
    });

    expect(landscape.sent[1]).toMatchObject({
      type: 'mux-promote-to-follower',
      clientSocketId: 'l-ws-1',
      alreadyOpen: true,
    });
    expect(activeMux.getStats().activeChannels).toBe(1);
    expect(dedupIncrements).toBe(1);

    // 3. Both send SFS Handshake -> only Portrait (owner) goes upstream; Landscape (follower) suppressed.
    const hsReq = encodeSfsEnvelope(0, 0, {
      api: { type: 'utf', value: '1.8.6' },
      cl: { type: 'utf', value: 'JavaScript' },
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(landscape), {
      type: 'ws-send',
      clientSocketId: 'l-ws-1',
      isBinary: true,
      data: hsReq,
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'ws-send',
      clientSocketId: 'p-ws-1',
      isBinary: true,
      data: hsReq,
    });

    const upstreamSendsAfterHs = portrait.sent.filter((m) => m.type === 'mux-ws-send-upstream');
    expect(upstreamSendsAfterHs.length).toBe(1);
    expect(dedupIncrements).toBe(2);

    // 4. Upstream HandshakeResponse arrives -> fanned out to Landscape.
    const hsResp = encodeSfsEnvelope(0, 0, {
      tk: { type: 'utf', value: 'srv-session-tk' },
      ct: { type: 'int', value: 1024 },
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'upstream-ws-frame',
      clientSocketId: 'p-ws-1',
      isBinary: true,
      data: hsResp,
    });

    // 5. Both send SFS Login with DIFFERENT zones, sessionTokens, and platform objects!
    // Only Portrait's (owner) Login goes upstream; Landscape's Login is suppressed so server never kicks!
    const pLogin = encodeSfsEnvelope(0, 1, {
      zn: { type: 'utf', value: 'aviator_core_inst2_demo1' },
      un: { type: 'utf', value: '51336&&demo' },
      p: {
        type: 'object',
        value: {
          token: { type: 'utf', value: 'tok-1' },
          sessionToken: { type: 'utf', value: 'stk-portrait' },
          platform: { type: 'utf', value: 'mobile' },
        },
      },
    });
    const lLogin = encodeSfsEnvelope(0, 1, {
      zn: { type: 'utf', value: 'aviator_core' },
      un: { type: 'utf', value: '51336&&demo' },
      p: {
        type: 'object',
        value: {
          token: { type: 'utf', value: 'tok-1' },
          sessionToken: { type: 'utf', value: 'stk-landscape' },
          platform: { type: 'utf', value: 'desktop' },
        },
      },
    });

    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'ws-send',
      clientSocketId: 'p-ws-1',
      isBinary: true,
      data: pLogin,
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(landscape), {
      type: 'ws-send',
      clientSocketId: 'l-ws-1',
      isBinary: true,
      data: lLogin,
    });

    const upstreamSendsAfterLogin = portrait.sent.filter((m) => m.type === 'mux-ws-send-upstream');
    expect(upstreamSendsAfterLogin.length).toBe(2);
    expect(dedupIncrements).toBe(3);

    // 6. Mirrored Bet with rotated clientSeed deduplicates consume-once!
    const pBet = encodeSfsEnvelope(1, 13, {
      c: { type: 'utf', value: 'betHandler' },
      r: { type: 'int', value: -1 },
      p: {
        type: 'object',
        value: {
          bet: { type: 'double', value: 1 },
          betId: { type: 'double', value: 1 },
          clientSeed: { type: 'utf', value: 'seed-A' },
        },
      },
    });
    const lBet = encodeSfsEnvelope(1, 13, {
      c: { type: 'utf', value: 'betHandler' },
      r: { type: 'int', value: -1 },
      p: {
        type: 'object',
        value: {
          bet: { type: 'double', value: 1 },
          betId: { type: 'double', value: 1 },
          clientSeed: { type: 'utf', value: 'seed-B' },
        },
      },
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(portrait), {
      type: 'ws-send',
      clientSocketId: 'p-ws-1',
      isBinary: true,
      data: pBet,
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(landscape), {
      type: 'ws-send',
      clientSocketId: 'l-ws-1',
      isBinary: true,
      data: lBet,
    });

    expect(portrait.sent.filter((m) => m.type === 'mux-ws-send-upstream').length).toBe(3);
    expect(dedupIncrements).toBe(4);
  });

  test('late-joining SFS2X follower (>5s after owner open) receives staged HandshakeResponse -> LoginResponse + init + recent state without premature multiplier ticks', () => {
    let nowMs = 10_000;
    const coordinator = new DebuggerCoordinator();
    const ownerWc = new FakeWc();
    const lateWc = new FakeWc();

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        ownerWc.id,
        {
          tabId: 'tab-late',
          role: 'landscape',
          active: true,
          wc: ownerWc,
          pairedWc: lateWc,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        lateWc.id,
        {
          tabId: 'tab-late',
          role: 'portrait',
          active: true,
          wc: lateWc,
          pairedWc: ownerWc,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null, {
      now: () => nowMs,
      sfsSessionTtlMs: 30_000,
    });

    // Owner connects, handshakes, logs in, receives init + changeState + 50 multiplier `x` ticks
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'ws-open',
      clientSocketId: 'o-1',
      url: 'wss://app-demo2.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-open',
      clientSocketId: 'o-1',
      protocol: '',
      extensions: '',
    });

    const hsResp = encodeSfsEnvelope(0, 0, { tk: { type: 'utf', value: 'tk-1' } });
    const loginResp = encodeSfsEnvelope(0, 1, { zn: { type: 'utf', value: 'z1' } });
    const initResp = encodeSfsEnvelope(1, 13, {
      c: { type: 'utf', value: 'init' },
      p: { type: 'object', value: { balance: { type: 'double', value: 30000 } } },
    });
    const stateResp = encodeSfsEnvelope(1, 13, {
      c: { type: 'utf', value: 'changeState' },
      p: { type: 'object', value: { newStateId: { type: 'int', value: 2 } } },
    });
    const xTick = encodeSfsEnvelope(1, 13, {
      c: { type: 'utf', value: 'x' },
      p: { type: 'object', value: { x: { type: 'double', value: 4.06 } } },
    });

    for (const f of [hsResp, loginResp, initResp, stateResp]) {
      fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
        type: 'upstream-ws-frame',
        clientSocketId: 'o-1',
        isBinary: true,
        data: f,
      });
    }
    for (let i = 0; i < 40; i += 1) {
      fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
        type: 'upstream-ws-frame',
        clientSocketId: 'o-1',
        isBinary: true,
        data: xTick,
      });
    }

    // Advance 8 seconds (past WS_HANDSHAKE_BUFFER_TTL_MS = 5000ms!) before lateWc joins on sibling shard!
    nowMs += WS_HANDSHAKE_BUFFER_TTL_MS + 3000;
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(lateWc), {
      type: 'ws-open',
      clientSocketId: 'f-late',
      url: 'wss://app-demo.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });

    // Only mux-grant(alreadyOpen: true) sent initially — no premature LoginResponse before HandshakeRequest!
    expect(lateWc.sent.length).toBe(1);
    expect(lateWc.sent[0]).toMatchObject({
      type: 'mux-grant',
      role: 'follower',
      alreadyOpen: true,
    });

    // Live `x` tick while follower is awaiting handshake is held back
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-frame',
      clientSocketId: 'o-1',
      isBinary: true,
      data: xTick,
    });
    expect(lateWc.sent.length).toBe(1);

    // Follower sends HandshakeRequest -> receives ONLY HandshakeResponse
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(lateWc), {
      type: 'ws-send',
      clientSocketId: 'f-late',
      isBinary: true,
      data: encodeSfsEnvelope(0, 0, { api: { type: 'utf', value: '1.8.6' } }),
    });
    expect(lateWc.sent.length).toBe(2);
    expect(parseSfsBinaryPacket(lateWc.sent[1] && 'data' in lateWc.sent[1] ? (lateWc.sent[1].data as Uint8Array) : new Uint8Array())?.action).toBe(0);

    // Follower sends LoginRequest -> receives LoginResponse + init + changeState, and unlocks live `x` ticks!
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(lateWc), {
      type: 'ws-send',
      clientSocketId: 'f-late',
      isBinary: true,
      data: encodeSfsEnvelope(0, 1, { un: { type: 'utf', value: '51336&&demo' } }),
    });
    expect(lateWc.sent.length).toBe(5);

    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-frame',
      clientSocketId: 'o-1',
      isBinary: true,
      data: xTick,
    });
    expect(lateWc.sent.length).toBe(6);

    // Advancing past sfsSessionTtlMs releases SFS session bytes cleanly to 0
    nowMs += 31_000;
    expect(activeMux.getStats().totalBufferedBytes).toBe(0);
  });

  test('shim mux-promote-to-follower aborts slow owner NativeWebSocket silently without firing error/close and transitions wrapper to open follower', () => {
    const script = buildWsSseMuxShimScript();
    const createdNative: Array<{ url: string; closed: boolean; dispatch: (ev: Event) => void }> = [];
    const windowListeners = new Map<string, Set<(ev: unknown) => void>>();
    let portToShim: MessagePort | null = null;

    class MockNativeWs extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = 'blob';
      protocol = '';
      extensions = '';
      bufferedAmount = 0;
      closed = false;

      constructor(public readonly url: string) {
        super();
        createdNative.push({
          url,
          closed: false,
          dispatch: (ev) => this.dispatchEvent(ev),
        });
      }

      send(): void {}
      close(): void {
        this.closed = true;
        createdNative[0]!.closed = true;
        this.readyState = 3;
        // Native close fires error + close asynchronously/synchronously; shim must ignore both!
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
      }
    }

    const sandbox: Record<string, unknown> = {
      location: { href: 'https://aviator-demo.spribegaming.com/' },
      WebSocket: MockNativeWs,
      URL,
      MessageChannel,
      MessagePort,
      Blob,
      Event,
      MessageEvent,
      CloseEvent,
      DOMException,
      setTimeout,
      clearTimeout,
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        let s = windowListeners.get(type);
        if (!s) {
          s = new Set();
          windowListeners.set(type, s);
        }
        s.add(fn);
      },
      removeEventListener: () => {},
      postMessage: () => {},
    };
    const context = vm.createContext(sandbox);
    const windowProxy = vm.runInContext('globalThis', context);
    sandbox.window = windowProxy;
    sandbox.self = windowProxy;
    sandbox.top = windowProxy;
    sandbox.globalThis = windowProxy;

    vm.runInContext(script, context);

    const ch = new MessageChannel();
    portToShim = ch.port1;
    const initEv = {
      data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
      source: windowProxy,
      ports: [ch.port2],
    };
    for (const fn of windowListeners.get('message') ?? []) {
      fn(initEv);
    }

    const eventsSeen: string[] = [];
    const WsCtor = sandbox.WebSocket as new (url: string) => WebSocket;
    const sock = new WsCtor('wss://app-demo.spribegaming.com/BlueBox/websocket');
    sock.onopen = () => eventsSeen.push('open');
    sock.onerror = () => eventsSeen.push('error');
    sock.onclose = () => eventsSeen.push('close');
    sock.onmessage = (e) => eventsSeen.push(`msg:${String(e.data)}`);

    portToShim.postMessage({
      type: 'mux-grant',
      clientSocketId: 'ws-1',
      kind: 'ws',
      role: 'owner',
    });

    // Wait a tick for MessagePort delivery
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(createdNative.length).toBe(1);
        expect(sock.readyState).toBe(0);

        portToShim!.postMessage({
          type: 'mux-promote-to-follower',
          clientSocketId: 'ws-1',
          alreadyOpen: true,
          protocol: '',
          extensions: '',
        });
        portToShim!.postMessage({
          type: 'mux-ws-frame',
          clientSocketId: 'ws-1',
          isBinary: false,
          data: 'live-tick',
        });

        setTimeout(() => {
          expect(createdNative[0]?.closed).toBe(true);
          expect(sock.readyState).toBe(1);
          expect(eventsSeen).toEqual(['open', 'msg:live-tick']);
          portToShim?.close();
          resolve();
        }, 25);
      }, 25);
    });
  });

  test('Pass 7 F-10: mux-promote-to-follower cleanly demotes an owner whose local NativeWebSocket ALREADY reached readyState === 1 without duplicate open or dropped frames', () => {
    const script = buildWsSseMuxShimScript();
    const createdNative: Array<{ closed: boolean; openLocal: () => void }> = [];
    const windowListeners = new Map<string, Set<(ev: unknown) => void>>();

    class MockHealthyNativeWs extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = 'blob';
      protocol = '';
      extensions = '';
      bufferedAmount = 0;

      constructor(public readonly url: string) {
        super();
        createdNative.push({
          closed: false,
          openLocal: () => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
          },
        });
      }
      send(): void {}
      close(): void {
        createdNative[0]!.closed = true;
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: '', wasClean: true }));
      }
    }

    const sandbox: Record<string, unknown> = {
      location: { href: 'https://aviator-demo.spribegaming.com/' },
      WebSocket: MockHealthyNativeWs,
      URL,
      MessageChannel,
      MessagePort,
      Blob,
      Event,
      MessageEvent,
      CloseEvent,
      DOMException,
      setTimeout,
      clearTimeout,
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        let s = windowListeners.get(type);
        if (!s) {
          s = new Set();
          windowListeners.set(type, s);
        }
        s.add(fn);
      },
      removeEventListener: () => {},
      postMessage: () => {},
    };
    const context = vm.createContext(sandbox);
    const windowProxy = vm.runInContext('globalThis', context);
    sandbox.window = windowProxy;
    sandbox.self = windowProxy;
    sandbox.top = windowProxy;
    sandbox.globalThis = windowProxy;
    vm.runInContext(script, context);

    const ch = new MessageChannel();
    const portToShim = ch.port1;
    for (const fn of windowListeners.get('message') ?? []) {
      fn({
        data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
        source: windowProxy,
        ports: [ch.port2],
      });
    }

    const eventsSeen: string[] = [];
    const WsCtor = sandbox.WebSocket as new (url: string) => WebSocket;
    const sock = new WsCtor('wss://app-demo.spribegaming.com/BlueBox/websocket');
    sock.onopen = () => eventsSeen.push('open');
    sock.onerror = () => eventsSeen.push('error');
    sock.onclose = () => eventsSeen.push('close');
    sock.onmessage = (e) => eventsSeen.push(`msg:${String(e.data)}`);

    portToShim.postMessage({
      type: 'mux-grant',
      clientSocketId: 'ws-1',
      kind: 'ws',
      role: 'owner',
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Local shard completes handshake BEFORE Main's mux-promote-to-follower arrives!
        createdNative[0]!.openLocal();
        expect(sock.readyState).toBe(1);
        expect(eventsSeen).toEqual(['open']);

        portToShim.postMessage({
          type: 'mux-promote-to-follower',
          clientSocketId: 'ws-1',
          alreadyOpen: true,
          protocol: '',
          extensions: '',
        });
        portToShim.postMessage({
          type: 'mux-ws-frame',
          clientSocketId: 'ws-1',
          isBinary: false,
          data: 'from-sibling-owner',
        });

        setTimeout(() => {
          expect(createdNative[0]?.closed).toBe(true);
          expect(sock.readyState).toBe(1);
          // Strictly 1 'open', zero 'close'/'error', and receives sibling owner's frames!
          expect(eventsSeen).toEqual(['open', 'msg:from-sibling-owner']);
          portToShim.close();
          resolve();
        }, 25);
      }, 25);
    });
  });

  test('Pass 7 F-12: mid-handshake SFS2X follower race (isSfsChannel=true while sfsHandshakeResp=null) delivers strictly 1 HandshakeResponse and 1 LoginResponse without duplicates', () => {
    const coordinator = new DebuggerCoordinator();
    const ownerWc = new FakeWc();
    const followerWc = new FakeWc();

    const ctxMap = new Map<number, WsMuxViewportContext>([
      [
        ownerWc.id,
        {
          tabId: 'tab-f12',
          role: 'landscape',
          active: true,
          wc: ownerWc,
          pairedWc: followerWc,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
      [
        followerWc.id,
        {
          tabId: 'tab-f12',
          role: 'portrait',
          active: true,
          wc: followerWc,
          pairedWc: ownerWc,
          getOrigin: (w) => w.mainFrame?.origin ?? null,
        },
      ],
    ]);

    activeMux = new WsSseMux(coordinator, (id) => ctxMap.get(id) ?? null);

    // Owner opens and sends HandshakeRequest (0, 0) while sfsHandshakeResp is still null
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'ws-open',
      clientSocketId: 'o-1',
      url: 'wss://app-demo2.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-open',
      clientSocketId: 'o-1',
      protocol: '',
      extensions: '',
    });
    const hsReq = encodeSfsEnvelope(0, 0, { api: { type: 'utf', value: '1.8.6' } });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'ws-send',
      clientSocketId: 'o-1',
      isBinary: true,
      data: hsReq,
    });

    // Follower attaches while sfsHandshakeResp is STILL null!
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(followerWc), {
      type: 'ws-open',
      clientSocketId: 'f-1',
      url: 'wss://app-demo2.spribegaming.com/BlueBox/websocket',
      protocols: [],
    });

    // Upstream sends HandshakeResponse (0, 0) + LoginResponse (0, 1) BEFORE follower sends HandshakeRequest
    const hsResp = encodeSfsEnvelope(0, 0, { tk: { type: 'utf', value: 'tk-mid' } });
    const loginResp = encodeSfsEnvelope(0, 1, { zn: { type: 'utf', value: 'z-mid' } });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-frame',
      clientSocketId: 'o-1',
      isBinary: true,
      data: hsResp,
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(ownerWc), {
      type: 'upstream-ws-frame',
      clientSocketId: 'o-1',
      isBinary: true,
      data: loginResp,
    });

    expect(followerWc.sent.filter((m) => m.type === 'mux-ws-frame').length).toBe(0);

    // Follower now sends (0, 0) then (0, 1) -> receives strictly 2 frames (1 hsResp + 1 loginResp), NOT 4!
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(followerWc), {
      type: 'ws-send',
      clientSocketId: 'f-1',
      isBinary: true,
      data: hsReq,
    });
    fakeIpc.emitMessage(WS_SSE_MUX_IPC_CHANNELS.TO_MAIN, ipcEv(followerWc), {
      type: 'ws-send',
      clientSocketId: 'f-1',
      isBinary: true,
      data: encodeSfsEnvelope(0, 1, { un: { type: 'utf', value: 'u1&&demo' } }),
    });

    const deliveredFrames = followerWc.sent.filter((m) => m.type === 'mux-ws-frame');
    expect(deliveredFrames.length).toBe(2);
  });
});
