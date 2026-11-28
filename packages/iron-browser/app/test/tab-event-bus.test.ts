import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  WS_SSE_MUX_IPC_CHANNELS,
  WS_SSE_MUX_WINDOW_MESSAGES,
  buildWsSseMuxShimScript,
  type MainToMuxMessage,
  type MuxToMainMessage,
} from '../src/shared/ws-sse-mux-core';
import {
  cleanupEmptyReservedDownload,
  reserveSafeDownloadPath,
  TabEventBus,
} from '../src/main/tab-event-bus';

function createShimStorageRealm(origin = 'https://game.example.com') {
  class MockStorage {
    #data = new Map<string, string>();
    getItem(key: string): string | null {
      if (arguments.length < 1) {
        throw new TypeError("Failed to execute 'getItem' on 'Storage': 1 argument required");
      }
      const k = String(key);
      return this.#data.has(k) ? this.#data.get(k)! : null;
    }
    setItem(key: string, value: string): void {
      if (arguments.length < 2) {
        throw new TypeError("Failed to execute 'setItem' on 'Storage': 2 arguments required");
      }
      this.#data.set(String(key), String(value));
    }
    removeItem(key: string): void {
      if (arguments.length < 1) {
        throw new TypeError("Failed to execute 'removeItem' on 'Storage': 1 argument required");
      }
      this.#data.delete(String(key));
    }
    clear(): void {
      this.#data.clear();
    }
    get length(): number {
      return this.#data.size;
    }
  }

  const sessionStore = new MockStorage();
  const localStore = new MockStorage();
  const sentToMain: MuxToMainMessage[] = [];
  const storageEvents: Array<{ key: string | null; oldValue: string | null; newValue: string | null }> = [];
  let portOnMessage: ((ev: { data: MainToMuxMessage }) => void) | null = null;
  let winMsgHandler: ((ev: unknown) => void) | null = null;

  class MockStorageEvent {
    type: string;
    key: string | null;
    oldValue: string | null;
    newValue: string | null;
    url: string;
    storageArea: unknown;
    constructor(
      type: string,
      init: {
        key?: string | null;
        oldValue?: string | null;
        newValue?: string | null;
        url?: string;
        storageArea?: unknown;
      } = {},
    ) {
      this.type = type;
      this.key = init.key ?? null;
      this.oldValue = init.oldValue ?? null;
      this.newValue = init.newValue ?? null;
      this.url = init.url ?? '';
      this.storageArea = init.storageArea ?? null;
    }
  }

  const fakePort = {
    postMessage(msg: MuxToMainMessage) {
      sentToMain.push(msg);
    },
    start() {},
    close() {},
    set onmessage(fn: ((ev: { data: MainToMuxMessage }) => void) | null) {
      portOnMessage = fn;
    },
  };

  class MockMessageEvent {
    type: string;
    data: unknown;
    source: unknown;
    ports: unknown[];
    constructor(
      type: string,
      init: { data?: unknown; source?: unknown; ports?: unknown[] } = {},
    ) {
      this.type = type;
      this.data = init.data;
      this.source = init.source ?? null;
      this.ports = init.ports ?? [];
    }
  }

  const sandboxWindow: Record<string, unknown> = {
    URL,
    Blob,
    TextDecoder,
    TextEncoder,
    AbortController,
    AbortSignal,
    Event,
    MessageEvent: MockMessageEvent,
    CloseEvent: Event,
    DOMException,
    EventTarget,
    WebSocket: class DummyWs {},
    StorageEvent: MockStorageEvent,
    sessionStorage: sessionStore,
    localStorage: localStore,
    location: { href: `${origin}/play` },
    document: { baseURI: `${origin}/play` },
    setTimeout,
    clearTimeout,
    postMessage() {},
    addEventListener(type: string, fn: (ev: unknown) => void) {
      if (type === 'message') {
        winMsgHandler = fn;
      }
    },
    removeEventListener() {},
    dispatchEvent(ev: unknown) {
      if (ev instanceof MockStorageEvent) {
        storageEvents.push({ key: ev.key, oldValue: ev.oldValue, newValue: ev.newValue });
      }
      return true;
    },
  };
  const context = vm.createContext(sandboxWindow);
  const windowProxy = vm.runInContext('globalThis', context) as Record<string, unknown>;
  sandboxWindow.window = windowProxy;
  sandboxWindow.top = windowProxy;

  vm.runInContext(buildWsSseMuxShimScript(), context);

  const connectPort = () => {
    if (!winMsgHandler) throw new Error('window message listener not installed');
    winMsgHandler(
      new MockMessageEvent('message', {
        source: windowProxy,
        data: { type: WS_SSE_MUX_WINDOW_MESSAGES.INIT },
        ports: [fakePort],
      }),
    );
  };

  const deliverFromMain = (msg: MainToMuxMessage) => {
    if (!portOnMessage) throw new Error('port.onmessage not wired');
    portOnMessage(new MockMessageEvent('message', { data: msg }) as { data: MainToMuxMessage });
  };

  return {
    sessionStore,
    localStore,
    sentToMain,
    storageEvents,
    connectPort,
    deliverFromMain,
    ipcChannels: WS_SSE_MUX_IPC_CHANNELS,
  };
}

describe('TabEventBus (Rust N-API + causal tracking + dedup claims + sessionStorage)', () => {
  const buses: TabEventBus[] = [];

  afterEach(() => {
    while (buses.length > 0) {
      buses.pop()?.dispose();
    }
  });

  test('loads compiled rust-napi addon and links causal gestureSeq within 1000ms window', () => {
    const bus = new TabEventBus({ maxEventsPerTab: 128 });
    buses.push(bus);

    expect(bus.backend).toBe('rust-napi');

    const gSeq = bus.beginGesture('tab-1', 'portrait', 'click', 10_000);
    expect(gSeq).toBe(1);

    const netSeq = bus.publish({
      tabId: 'tab-1',
      viewport: 'landscape',
      domain: 'http_dedup',
      kind: 'replayed',
      summary: 'GET https://api.spribe.co/auth?token=SUPER_SECRET_1&lang=EN#access_token=SUPER_SECRET_2',
      tsMs: 10_400,
    });
    expect(netSeq).toBe(2);

    // Outside 1000ms causal window: must NOT inherit stale gestureSeq
    bus.publish({
      tabId: 'tab-1',
      viewport: 'portrait',
      domain: 'console',
      kind: 'warn',
      summary: 'independent timer warning',
      tsMs: 11_500,
    });

    const res = bus.query({ tabId: 'tab-1' });
    expect(res.backend).toBe('rust-napi');
    expect(res.count).toBe(3);
    expect(res.events[0]?.domain).toBe('gesture');
    expect(res.events[0]?.gestureSeq).toBe(gSeq);

    expect(res.events[1]?.gestureSeq).toBe(gSeq);
    expect(res.events[1]?.summary).toContain('token=[REDACTED]&lang=EN#access_token=[REDACTED]');
    expect(res.events[1]?.summary).not.toContain('SUPER_SECRET_1');
    expect(res.events[1]?.summary).not.toContain('SUPER_SECRET_2');

    expect(res.events[2]?.gestureSeq).toBeUndefined();

    const byGesture = bus.query({ tabId: 'tab-1', gestureSeq: gSeq });
    expect(byGesture.count).toBe(2);
  });

  test('claimEffect atomically deduplicates cross-viewport downloads and popups consume-once', () => {
    const bus = new TabEventBus();
    buses.push(bus);

    const gSeq = bus.beginGesture('tab-dl', 'portrait', 'click', 20_000);

    const first = bus.claimEffect(
      'tab-dl',
      'portrait',
      'download',
      'https://cdn.example.com/export.csv?ticket=PRIV_TICKET|export.csv',
      3500,
      20_015,
    );
    expect(first.allowed).toBe(true);
    expect(first.gestureSeq).toBe(gSeq);

    // Paired landscape viewport triggers the mirrored download 18ms later -> suppressed!
    const duplicate = bus.claimEffect(
      'tab-dl',
      'landscape',
      'download',
      'https://cdn.example.com/export.csv?ticket=PRIV_TICKET|export.csv',
      3500,
      20_033,
    );
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.ownerSeq).toBe(first.seq);
    expect(duplicate.gestureSeq).toBe(gSeq);

    // Consume-once: a second intentional click by the user on landscape is allowed!
    const intentionalSecond = bus.claimEffect(
      'tab-dl',
      'landscape',
      'download',
      'https://cdn.example.com/export.csv?ticket=PRIV_TICKET|export.csv',
      3500,
      20_200,
    );
    expect(intentionalSecond.allowed).toBe(true);

    const dlEvents = bus.query({ tabId: 'tab-dl', domain: 'download' });
    expect(dlEvents.totalSuppressed).toBe(1);
    expect(dlEvents.events.map((e) => e.kind)).toEqual([
      'effect_claimed',
      'dedup_suppressed',
      'effect_claimed',
    ]);
    for (const ev of dlEvents.events) {
      expect(ev.summary).not.toContain('PRIV_TICKET');
      expect(ev.summary).toContain('ticket=[REDACTED]');
    }
  });

  test('sessionStorage enforces http/https origin isolation, 512KB quota, and clean clearTab', () => {
    const bus = new TabEventBus();
    buses.push(bus);

    expect(
      bus.sessionStorageSet('tab-1', 'file:///etc/passwd', 'portrait', 'a', '1').ok,
    ).toBe(false);
    expect(bus.sessionStorageSet('tab-1', 'null', 'portrait', 'a', '1').ok).toBe(false);

    const setRes = bus.sessionStorageSet(
      'tab-1',
      'https://aviator-demo.spribegaming.com',
      'portrait',
      '__sfs_token',
      'secret-session-jwt-value',
      30_000,
    );
    expect(setRes).toEqual({ ok: true, changed: true });

    // Other origins and other tabs never see the value
    expect(bus.sessionStorageSnapshot('tab-1', 'https://evil.example.com')).toEqual({});
    expect(bus.sessionStorageSnapshot('tab-2', 'https://aviator-demo.spribegaming.com')).toEqual({});
    expect(bus.sessionStorageSnapshot('tab-1', 'https://aviator-demo.spribegaming.com')).toEqual({
      __sfs_token: 'secret-session-jwt-value',
    });

    // Event log records byte length only, NEVER the secret sessionStorage value
    const storageEvents = bus.query({ tabId: 'tab-1', domain: 'storage' });
    expect(storageEvents.count).toBe(1);
    expect(storageEvents.events[0]?.summary).toContain('__sfs_token');
    expect(storageEvents.events[0]?.summary).not.toContain('secret-session-jwt-value');

    // Oversized > 512KB value rejected cleanly
    const huge = 'x'.repeat(530 * 1024);
    const overQuota = bus.sessionStorageSet(
      'tab-1',
      'https://aviator-demo.spribegaming.com',
      'portrait',
      'big',
      huge,
    );
    expect(overQuota.ok).toBe(false);

    bus.clearTab('tab-1');
    expect(bus.sessionStorageSnapshot('tab-1', 'https://aviator-demo.spribegaming.com')).toEqual({});
    expect(bus.query({ tabId: 'tab-1' }).count).toBe(0);
  });

  test('shim sessionStorage wrapper syncs mutations, protects pre-hydration local writes, and leaves localStorage untouched', () => {
    const portrait = createShimStorageRealm('https://game.example.com');
    const landscape = createShimStorageRealm('https://game.example.com');

    // Inline script writes 'localFirst' BEFORE MessagePort init arrives
    portrait.sessionStore.setItem('localFirst', 'fresh-inline-val');
    portrait.localStore.setItem('theme', 'dark');

    portrait.connectPort();
    landscape.connectPort();

    // localStorage must NOT emit ss-mut messages
    expect(
      portrait.sentToMain.some(
        (m) => m.type === 'ss-mut' && 'key' in m && m.key === 'theme',
      ),
    ).toBe(false);

    // ss-hello + queued ss-mut('localFirst') sent upon port connect
    expect(portrait.sentToMain).toEqual([
      { type: 'ss-hello', clientSocketId: '__ss__' },
      {
        type: 'ss-mut',
        clientSocketId: '__ss__',
        op: 'set',
        key: 'localFirst',
        value: 'fresh-inline-val',
      },
    ]);

    // Hydrate arrives with stale 'localFirst' + 'fromPaired': must NOT clobber 'localFirst'!
    portrait.deliverFromMain({
      type: 'mux-ss-sync',
      clientSocketId: '__ss__',
      op: 'hydrate',
      entries: {
        localFirst: 'stale-val',
        fromPaired: 'hydrated-ok',
      },
    });
    expect(portrait.sessionStore.getItem('localFirst')).toBe('fresh-inline-val');
    expect(portrait.sessionStore.getItem('fromPaired')).toBe('hydrated-ok');

    // Live set from portrait -> landscape updates landscape without echo loop and fires StorageEvent
    const beforeLen = landscape.sentToMain.length;
    landscape.deliverFromMain({
      type: 'mux-ss-sync',
      clientSocketId: '__ss__',
      op: 'set',
      key: 'roundSeed',
      value: 'seed-99',
    });
    expect(landscape.sessionStore.getItem('roundSeed')).toBe('seed-99');
    expect(landscape.sentToMain.length).toBe(beforeLen);
    expect(landscape.storageEvents).toEqual([
      { key: 'roundSeed', oldValue: null, newValue: 'seed-99' },
    ]);
  });

  test('reserveSafeDownloadPath neutralizes path traversal, dotfiles, symlinks, and empty failed placeholders', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dl-unit-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dl-outside-'));
    try {
      const p1 = reserveSafeDownloadPath(tmpDir, '../../etc/passwd');
      expect(p1).toBe(path.join(tmpDir, 'passwd'));

      const p2 = reserveSafeDownloadPath(tmpDir, 'passwd');
      expect(p2).toBe(path.join(tmpDir, 'passwd (1)'));

      const dotFile = reserveSafeDownloadPath(tmpDir, '.bashrc');
      expect(dotFile).toBe(path.join(tmpDir, 'download_bashrc'));

      // F-15: symlinked target directory must be rejected
      const symlinkTarget = path.join(tmpDir, 'sym-downloads');
      fs.symlinkSync(outsideDir, symlinkTarget);
      expect(reserveSafeDownloadPath(symlinkTarget, 'report.csv')).toBeNull();

      // F-15: failed/cancelled download removes 0-byte placeholder without touching non-empty files
      expect(fs.existsSync(p2!)).toBe(true);
      cleanupEmptyReservedDownload(p2);
      expect(fs.existsSync(p2!)).toBe(false);

      fs.writeFileSync(p1!, 'real-data');
      cleanupEmptyReservedDownload(p1);
      expect(fs.readFileSync(p1!, 'utf8')).toBe('real-data');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('Pass 9 regressions F-13 & F-14: hash-route token redaction and sessionStorageClearTab without losing events', () => {
    const bus = new TabEventBus();
    buses.push(bus);

    bus.publish({
      tabId: 'tab-f13',
      viewport: 'portrait',
      domain: 'navigation',
      kind: 'navigate',
      summary: 'https://casino.example.com/#/launch?token=HASH_ROUTE_SECRET_123&lang=EN',
      detail: 'https://app.example.com/?debug#access_token=FRAG_SECRET_456',
      tsMs: 40_000,
    });

    bus.sessionStorageSet(
      'tab-f13',
      'https://casino.example.com',
      'portrait',
      '__sfs_token',
      'USER_A_JWT',
      40_010,
    );
    expect(bus.sessionStorageSnapshot('tab-f13', 'https://casino.example.com')).toEqual({
      __sfs_token: 'USER_A_JWT',
    });

    // F-14: clearing tab sessionStorage wipes stale tokens while preserving diagnostic events
    expect(bus.sessionStorageClearTab('tab-f13')).toBe(true);
    expect(bus.sessionStorageClearTab('tab-f13')).toBe(false);
    expect(bus.sessionStorageSnapshot('tab-f13', 'https://casino.example.com')).toEqual({});

    const q = bus.query({ tabId: 'tab-f13' });
    expect(q.count).toBe(2);
    expect(q.events[0]?.summary).toBe(
      'https://casino.example.com/#/launch?token=[REDACTED]&lang=EN',
    );
    expect(q.events[0]?.detail).toBe(
      'https://app.example.com/?debug#access_token=[REDACTED]',
    );
  });
});
