import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectronSession } from './lib/electron-harness';
import { createTestServerCluster } from './lib/test-servers';
import type {
  E2ETestCase,
  E2ETestContext,
  ElectronSession,
  PersistedSessionFixture,
  TabSnapshotDto,
  ViewportRole,
} from './lib/types';

interface MutateCorrelationDto {
  idempotencyKey?: string;
  [key: string]: unknown;
}

interface MutatePayloadDto {
  ok?: boolean;
  count?: number;
  method?: string;
  path?: string;
  correlation?: MutateCorrelationDto;
}

interface MutateEvalResponse {
  status: number;
  dedupHeader: string | null;
  body: MutatePayloadDto | null;
  rawText?: string;
}

type WsLogItem = string | { binary: number[] };

interface SseLogItem {
  type: string;
  data: string;
  lastEventId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

type PollResult<T> = { ok: true; value: T } | { ok: false; value?: never };

async function pollUntil<T>(
  probe: () => Promise<PollResult<T>> | PollResult<T>,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    description: string;
  },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const res = await probe();
      if (res.ok) {
        return res.value;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(pollMs);
  }

  const errSuffix =
    lastError !== null
      ? ` (lastError=${lastError instanceof Error ? lastError.message : String(lastError)})`
      : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${opts.description}${errSuffix}`);
}

async function evalJson<T>(
  session: ElectronSession,
  expression: string,
  role: ViewportRole,
  tabId: string,
): Promise<T> {
  const res = await session.ctl.evalJs(expression, role, tabId);
  return JSON.parse(res.value) as T;
}

async function sendMutateFromViewport(
  session: ElectronSession,
  role: ViewportRole,
  tabId: string,
  endpointPath: '/mutate' | '/mutate-gzip',
  idempotencyKey: string,
): Promise<MutateEvalResponse> {
  const expr = `(async () => {
    const res = await fetch(${JSON.stringify(endpointPath)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'bet',
        idempotencyKey: ${JSON.stringify(idempotencyKey)},
        ts: Date.now()
      })
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return {
      status: res.status,
      dedupHeader: res.headers.get('x-iron-browser-dedup'),
      body,
      rawText: body ? undefined : text.slice(0, 200)
    };
  })()`;
  return evalJson<MutateEvalResponse>(session, expr, role, tabId);
}

async function pollElementText(
  session: ElectronSession,
  role: ViewportRole,
  tabId: string,
  selector: string,
  expectedText: string,
  timeoutMs = 8_000,
): Promise<string> {
  return pollUntil(
    async () => {
      const res = await session.ctl.evalJs(
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
        role,
        tabId,
      );
      if (res.value === expectedText) {
        return { ok: true, value: res.value };
      }
      return { ok: false };
    },
    {
      timeoutMs,
      pollMs: 40,
      description: `${role} ${selector} === ${JSON.stringify(expectedText)}`,
    },
  );
}

async function pollTabTitleIncludes(
  session: ElectronSession,
  tabId: string,
  expectedSubstring: string,
  timeoutMs = 8_000,
): Promise<TabSnapshotDto> {
  return pollUntil(
    async () => {
      const state = await session.ctl.tabs();
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab && tab.title.includes(expectedSubstring)) {
        return { ok: true, value: tab };
      }
      return { ok: false };
    },
    {
      timeoutMs,
      pollMs: 50,
      description: `tab ${tabId} title includes ${JSON.stringify(expectedSubstring)}`,
    },
  );
}

function isBinaryArrayMatch(item: WsLogItem, expected: number[]): boolean {
  if (typeof item !== 'object' || item === null || !Array.isArray(item.binary)) {
    return false;
  }
  if (item.binary.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (item.binary[i] !== expected[i]) return false;
  }
  return true;
}

export const smokeTests: E2ETestCase[] = [
  {
    id: 'SMOKE-A',
    tier: 'smoke',
    features: ['F6', 'F7', 'F11'],
    title: 'Live Electron mirrored POST + gzip dedup & state isolation',
    description:
      'Verifies mirrored POST /mutate and POST /mutate-gzip hit the HTTP server once, replay to follower with x-iron-browser-dedup: replayed and per-viewport idempotencyKey remapping, increment dedupCount, and do not rewrite session-state.json.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(
          `${ctx.servers.httpBaseUrl}/page/interactions`,
          { mode: 'dual', session: 'shared' },
        );
        assert.ok(opened.tab?.id, 'Expected opened tab to have an id');
        const tabId = opened.tab.id;

        const tab = await session.ctl.waitForTabReady(tabId, {
          expectedUrlIncludes: '/page/interactions',
          waitForDomComplete: true,
          timeoutMs: 15_000,
        });

        assert.equal(tab.mode, 'dual', 'Expected dual mode');
        assert.equal(tab.session, 'shared', 'Expected shared session');
        assert.equal(tab.mirror, true, 'Expected mirror=true');
        assert.equal(tab.dedup, true, 'Expected dedup=true');

        await pollUntil(
          () => {
            const st = session.readStateFile<PersistedSessionFixture>();
            if (!st || !st.tabs.some((t) => t.url.includes('/page/interactions'))) {
              return { ok: false };
            }
            return { ok: true, value: st };
          },
          {
            timeoutMs: 8_000,
            pollMs: 100,
            description: 'initial session-state.json write',
          },
        );
        // Allow any trailing 400ms save debounce from initial navigation/title update to settle.
        await sleep(500);

        const rawBefore = session.readRawStateFile();
        const stateBefore = session.readStateFile<PersistedSessionFixture>();
        assert.ok(
          rawBefore !== null && stateBefore !== null,
          'Expected non-null session-state.json before mutations',
        );

        ctx.servers.resetHttpLogs();

        // 1) Plain JSON POST /mutate across Portrait and Landscape (75ms stagger)
        const plainPortraitKey = 'smoke-a-plain-portrait';
        const plainLandscapeKey = 'smoke-a-plain-landscape';
        const [plainPortrait, plainLandscape] = await Promise.all([
          sendMutateFromViewport(session, 'portrait', tabId, '/mutate', plainPortraitKey),
          sleep(75).then(() =>
            sendMutateFromViewport(session, 'landscape', tabId, '/mutate', plainLandscapeKey),
          ),
        ]);

        assert.equal(plainPortrait.status, 200, 'Portrait /mutate status');
        assert.equal(plainLandscape.status, 200, 'Landscape /mutate status');
        assert.equal(plainPortrait.body?.ok, true, 'Portrait /mutate body.ok');
        assert.equal(plainLandscape.body?.ok, true, 'Landscape /mutate body.ok');
        assert.equal(plainPortrait.body?.count, 1, 'Portrait /mutate body.count === 1');
        assert.equal(plainLandscape.body?.count, 1, 'Landscape /mutate body.count === 1');
        assert.equal(plainPortrait.body?.path, '/mutate', 'Portrait /mutate body.path');
        assert.equal(plainLandscape.body?.path, '/mutate', 'Landscape /mutate body.path');
        assert.equal(
          plainPortrait.body?.correlation?.idempotencyKey,
          plainPortraitKey,
          'Portrait /mutate idempotencyKey',
        );
        assert.equal(
          plainLandscape.body?.correlation?.idempotencyKey,
          plainLandscapeKey,
          'Landscape /mutate idempotencyKey',
        );
        const plainPrimaries = [plainPortrait, plainLandscape].filter(
          (r) => r.dedupHeader === null,
        );
        const plainFollowers = [plainPortrait, plainLandscape].filter(
          (r) => r.dedupHeader === 'replayed',
        );
        assert.equal(
          plainPrimaries.length,
          1,
          `Expected exactly 1 primary /mutate response (dedupHeader === null), got [${String(plainPortrait.dedupHeader)}, ${String(plainLandscape.dedupHeader)}]`,
        );
        assert.equal(
          plainFollowers.length,
          1,
          `Expected exactly 1 follower /mutate response (dedupHeader === 'replayed'), got [${String(plainPortrait.dedupHeader)}, ${String(plainLandscape.dedupHeader)}]`,
        );

        // 2) Gzipped JSON POST /mutate-gzip across Portrait and Landscape (75ms stagger)
        const gzipPortraitKey = 'smoke-a-gzip-portrait';
        const gzipLandscapeKey = 'smoke-a-gzip-landscape';
        const [gzipPortrait, gzipLandscape] = await Promise.all([
          sendMutateFromViewport(session, 'portrait', tabId, '/mutate-gzip', gzipPortraitKey),
          sleep(75).then(() =>
            sendMutateFromViewport(session, 'landscape', tabId, '/mutate-gzip', gzipLandscapeKey),
          ),
        ]);

        assert.equal(gzipPortrait.status, 200, 'Portrait /mutate-gzip status');
        assert.equal(gzipLandscape.status, 200, 'Landscape /mutate-gzip status');
        assert.equal(
          gzipPortrait.body?.ok,
          true,
          `Portrait /mutate-gzip body.ok (raw=${gzipPortrait.rawText ?? ''})`,
        );
        assert.equal(
          gzipLandscape.body?.ok,
          true,
          `Landscape /mutate-gzip body.ok (raw=${gzipLandscape.rawText ?? ''})`,
        );
        assert.equal(gzipPortrait.body?.count, 1, 'Portrait /mutate-gzip body.count === 1');
        assert.equal(gzipLandscape.body?.count, 1, 'Landscape /mutate-gzip body.count === 1');
        assert.equal(gzipPortrait.body?.path, '/mutate-gzip', 'Portrait /mutate-gzip body.path');
        assert.equal(gzipLandscape.body?.path, '/mutate-gzip', 'Landscape /mutate-gzip body.path');
        assert.equal(
          gzipPortrait.body?.correlation?.idempotencyKey,
          gzipPortraitKey,
          'Portrait /mutate-gzip idempotencyKey',
        );
        assert.equal(
          gzipLandscape.body?.correlation?.idempotencyKey,
          gzipLandscapeKey,
          'Landscape /mutate-gzip idempotencyKey',
        );
        const gzipPrimaries = [gzipPortrait, gzipLandscape].filter(
          (r) => r.dedupHeader === null,
        );
        const gzipFollowers = [gzipPortrait, gzipLandscape].filter(
          (r) => r.dedupHeader === 'replayed',
        );
        assert.equal(
          gzipPrimaries.length,
          1,
          `Expected exactly 1 primary /mutate-gzip response (dedupHeader === null), got [${String(gzipPortrait.dedupHeader)}, ${String(gzipLandscape.dedupHeader)}]`,
        );
        assert.equal(
          gzipFollowers.length,
          1,
          `Expected exactly 1 follower /mutate-gzip response (dedupHeader === 'replayed'), got [${String(gzipPortrait.dedupHeader)}, ${String(gzipLandscape.dedupHeader)}]`,
        );

        const allLogs = ctx.servers.getHttpLogs();
        const plainHits = allLogs.filter((entry) => entry.path === '/mutate');
        const gzipHits = allLogs.filter((entry) => entry.path === '/mutate-gzip');
        assert.equal(
          plainHits.length,
          1,
          `Expected exactly 1 HTTP hit for /mutate, got ${plainHits.length}`,
        );
        assert.equal(
          gzipHits.length,
          1,
          `Expected exactly 1 HTTP hit for /mutate-gzip, got ${gzipHits.length}`,
        );

        const tabsAfter = await session.ctl.tabs();
        const tabAfter = tabsAfter.tabs.find((t) => t.id === tabId);
        assert.ok(tabAfter, 'Expected tab to exist after mutations');
        assert.ok(
          (tabAfter.dedupCount ?? 0) >= 2,
          `Expected dedupCount >= 2, got ${String(tabAfter.dedupCount)}`,
        );

        await sleep(600);
        const rawAfter = session.readRawStateFile();
        const stateAfter = session.readStateFile<PersistedSessionFixture>();
        assert.ok(
          rawAfter !== null && stateAfter !== null,
          'Expected valid session-state.json after dedup',
        );
        assert.equal(
          stateAfter.tabs.length,
          stateBefore.tabs.length,
          'Expected tab count in session-state.json to remain unchanged',
        );
        assert.equal(
          stateAfter.savedAt,
          stateBefore.savedAt,
          'Expected dedupCount increments not to rewrite session-state.json',
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'SMOKE-B',
    tier: 'smoke',
    features: ['F8', 'F11'],
    title: 'Live Electron symmetric WS + SSE multiplexer & 1012 owner failover',
    description:
      'Verifies both viewports share 1 upstream WS (chat.v1 + text/binary) and 1 upstream SSE (named events + lastEventId) connection, receive frames in order, and survive owner teardown via 1012 failover.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(
          `${ctx.servers.httpBaseUrl}/page/ws-sse`,
          { mode: 'dual', session: 'shared' },
        );
        assert.ok(opened.tab?.id, 'Expected opened tab to have an id');
        const tabId = opened.tab.id;

        await session.ctl.waitForTabReady(tabId, {
          expectedUrlIncludes: '/page/ws-sse',
          waitForDomComplete: true,
          timeoutMs: 15_000,
        });

        ctx.servers.resetWsStats();
        ctx.servers.resetSseStats();

        // 1) Open WebSocket on Portrait (owner) then Landscape (follower)
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tabId,
        );
        await pollElementText(session, 'portrait', tabId, '#ws-status', 'open:chat.v1');

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tabId,
        );
        await pollElementText(session, 'landscape', tabId, '#ws-status', 'open:chat.v1');

        const wsStatsAfterOpen = ctx.servers.getWsStats();
        assert.equal(
          wsStatsAfterOpen.activeConnections,
          1,
          'Expected exactly 1 active upstream WS connection',
        );
        assert.equal(
          wsStatsAfterOpen.totalConnections,
          1,
          'Expected exactly 1 total upstream WS connection',
        );

        // 2) Open SSE on Portrait (owner) then Landscape (follower)
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'portrait',
          tabId,
        );
        await pollElementText(session, 'portrait', tabId, '#sse-status', 'open');

        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'landscape',
          tabId,
        );
        await pollElementText(session, 'landscape', tabId, '#sse-status', 'open');

        const sseStatsAfterOpen = ctx.servers.getSseStats();
        assert.equal(
          sseStatsAfterOpen.activeConnections,
          1,
          'Expected exactly 1 active upstream SSE connection',
        );
        assert.equal(
          sseStatsAfterOpen.totalConnections,
          1,
          'Expected exactly 1 total upstream SSE connection',
        );

        // 3) Send WS text & binary ArrayBuffer from Portrait + server broadcast text & binary
        await session.ctl.evalJs(
          `window.__wsSend('smoke-client-txt')`,
          'portrait',
          tabId,
        );
        await session.ctl.evalJs(
          `window.__wsSendBinary([1, 2, 3, 4])`,
          'portrait',
          tabId,
        );

        const wsStatsAfterSend = await pollUntil(
          () => {
            const stats = ctx.servers.getWsStats();
            if (stats.receivedMessages.length >= 2) {
              return { ok: true, value: stats };
            }
            return { ok: false };
          },
          {
            timeoutMs: 8_000,
            pollMs: 40,
            description: 'server to receive client WS text + binary frames',
          },
        );

        const clientTxtMsg = wsStatsAfterSend.receivedMessages.find(
          (m) => !m.isBinary && m.data === 'smoke-client-txt',
        );
        const clientBinMsg = wsStatsAfterSend.receivedMessages.find(
          (m) => m.isBinary && m.data instanceof Uint8Array,
        );
        assert.ok(clientTxtMsg, 'Expected server to receive smoke-client-txt');
        assert.equal(clientTxtMsg.subprotocol, 'chat.v1');
        assert.ok(clientBinMsg, 'Expected server to receive binary frame');
        assert.equal(clientBinMsg.subprotocol, 'chat.v1');
        assert.deepEqual(
          Array.from(clientBinMsg.data as Uint8Array),
          [1, 2, 3, 4],
        );

        assert.equal(ctx.servers.broadcastWs('smoke-srv-txt'), 1);
        assert.equal(ctx.servers.broadcastWs(new Uint8Array([9, 8, 7])), 1);

        for (const role of ['portrait', 'landscape'] as const) {
          const log = await pollUntil(
            async () => {
              const items = await evalJson<WsLogItem[]>(
                session,
                'window.__wsLog',
                role,
                tabId,
              );
              const txtIdx = items.indexOf('smoke-srv-txt');
              const binIdx = items.findIndex((item) =>
                isBinaryArrayMatch(item, [9, 8, 7]),
              );
              if (txtIdx >= 0 && binIdx >= 0) {
                return { ok: true, value: { items, txtIdx, binIdx } };
              }
              return { ok: false };
            },
            {
              timeoutMs: 8_000,
              pollMs: 40,
              description: `${role} window.__wsLog to receive server text and binary frames`,
            },
          );
          assert.ok(
            log.txtIdx < log.binIdx,
            `Expected text frame before binary frame on ${role}, got txtIdx=${log.txtIdx}, binIdx=${log.binIdx}`,
          );
        }

        // 4) Push SSE named events and verify both viewports receive them with lastEventId
        assert.equal(
          ctx.servers.pushSseEvent('ping-evt', '{"n":1}', 'sse-1'),
          1,
        );
        assert.equal(
          ctx.servers.pushSseEvent('room_state', '{"ok":true}', 'sse-2'),
          1,
        );

        for (const role of ['portrait', 'landscape'] as const) {
          await pollUntil(
            async () => {
              const items = await evalJson<SseLogItem[]>(
                session,
                'window.__sseLog',
                role,
                tabId,
              );
              const hasPing = items.some(
                (e) =>
                  e.type === 'ping-evt' &&
                  e.data === '{"n":1}' &&
                  e.lastEventId === 'sse-1',
              );
              const hasRoom = items.some(
                (e) =>
                  e.type === 'room_state' &&
                  e.data === '{"ok":true}' &&
                  e.lastEventId === 'sse-2',
              );
              if (hasPing && hasRoom) {
                return { ok: true, value: items };
              }
              return { ok: false };
            },
            {
              timeoutMs: 8_000,
              pollMs: 40,
              description: `${role} window.__sseLog to receive ping-evt & room_state`,
            },
          );
        }

        // 5) Owner teardown via Portrait reload -> Landscape receives 1012 and promotes on reconnect
        await session.ctl.evalJs('location.reload()', 'portrait', tabId);
        await pollElementText(session, 'landscape', tabId, '#ws-status', 'closed:1012');

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tabId,
        );
        await pollElementText(session, 'landscape', tabId, '#ws-status', 'open:chat.v1');

        await pollUntil(
          () => {
            const stats = ctx.servers.getWsStats();
            if (stats.activeConnections === 1) {
              return { ok: true, value: stats };
            }
            return { ok: false };
          },
          {
            timeoutMs: 5_000,
            pollMs: 40,
            description: 'WS activeConnections === 1 after Landscape failover reconnect',
          },
        );

        assert.equal(ctx.servers.broadcastWs('after-1012-failover'), 1);
        await pollUntil(
          async () => {
            const items = await evalJson<WsLogItem[]>(
              session,
              'window.__wsLog',
              'landscape',
              tabId,
            );
            if (items.includes('after-1012-failover')) {
              return { ok: true, value: items };
            }
            return { ok: false };
          },
          {
            timeoutMs: 8_000,
            pollMs: 40,
            description: 'Landscape to receive after-1012-failover frame',
          },
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'SMOKE-C',
    tier: 'smoke',
    features: ['F4', 'F10', 'F11'],
    title: 'Live Electron 2-launch session restore, lazy tabs & history integrity',
    description:
      'Verifies SIGTERM flushes multi-tab session & short history, Launch 2 restores active tab while keeping inactive tabs dormant (0 HTTP hits), sessionRestored prevents startup wipe, and materializing a dormant tab preserves history via skipNextRestoreHistoryCommit.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const urlA = `${ctx.servers.httpBaseUrl}/echo?tab=a`;
      const urlInteractions = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const urlB = `${ctx.servers.httpBaseUrl}/echo?tab=b`;
      const urlShadow = `${ctx.servers.httpBaseUrl}/page/shadow`;

      const sharedSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-'));
      fs.chmodSync(sharedSessionDir, 0o700);

      try {
        const session1 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedSessionDir,
          keepTempDir: true,
        });
        try {
          const initial = await session1.ctl.tabs();
          const tab1 = initial.tabs[0];
          assert.ok(tab1, 'Expected initial tab on Launch 1');

          await session1.ctl.navigate(urlA, tab1.id);
          await session1.ctl.waitForTabReady(tab1.id, {
            expectedUrlIncludes: '/echo?tab=a',
            waitForDomComplete: true,
            timeoutMs: 15_000,
          });

          await session1.ctl.navigate(urlInteractions, tab1.id);
          await session1.ctl.waitForTabReady(tab1.id, {
            expectedUrlIncludes: '/page/interactions',
            waitForDomComplete: true,
            timeoutMs: 15_000,
          });
          await pollTabTitleIncludes(session1, tab1.id, 'Interactions Fixture');

          const opened2 = await session1.ctl.open(urlB);
          assert.ok(opened2.tab?.id, 'Expected tab-2 id');
          await session1.ctl.waitForTabReady(opened2.tab.id, {
            expectedUrlIncludes: '/echo?tab=b',
            waitForDomComplete: true,
            timeoutMs: 15_000,
          });

          const opened3 = await session1.ctl.open(urlShadow);
          assert.ok(opened3.tab?.id, 'Expected tab-3 id');
          await session1.ctl.waitForTabReady(opened3.tab.id, {
            expectedUrlIncludes: '/page/shadow',
            waitForDomComplete: true,
            timeoutMs: 15_000,
          });
          await pollTabTitleIncludes(session1, opened3.tab.id, 'Shadow DOM Fixture');

          session1.sendSignal('SIGTERM');
          await session1.waitForExit(5_000);
        } finally {
          await session1.close();
        }

        const persisted1 = session1.readStateFile<PersistedSessionFixture>();
        assert.ok(persisted1 !== null, 'Expected session-state.json after Launch 1 SIGTERM');
        assert.equal(persisted1.tabs.length, 3, 'Expected 3 persisted tabs');
        assert.equal(persisted1.activeTabIndex, 2, 'Expected activeTabIndex === 2');
        assert.deepEqual(
          persisted1.tabs.map((t) => t.url),
          [urlInteractions, urlB, urlShadow],
          'Expected persisted tab URLs to match Launch 1 order',
        );
        // History is recorded most-recent-first in session-store.ts.
        assert.deepEqual(
          persisted1.history.map((h) => h.url),
          [urlShadow, urlB, urlInteractions, urlA],
          'Expected 4 history URLs in most-recent-first order after Launch 1',
        );

        ctx.servers.resetHttpLogs();

        const session2 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedSessionDir,
          keepTempDir: false,
        });
        try {
          const restoredTabs = await session2.ctl.tabs();
          assert.equal(restoredTabs.tabs.length, 3, 'Expected 3 restored tabs on Launch 2');
          const restoredTab1 = restoredTabs.tabs[0];
          const restoredTab3 = restoredTabs.tabs[2];
          assert.ok(restoredTab1 && restoredTab3, 'Expected restoredTab1 and restoredTab3');
          assert.equal(
            restoredTabs.activeTabId,
            restoredTab3.id,
            'Expected activeTabId === restoredTab3.id',
          );

          await session2.ctl.waitForTabReady(restoredTab3.id, {
            expectedUrlIncludes: '/page/shadow',
            waitForDomComplete: true,
            timeoutMs: 15_000,
          });
          // Allow post-restore startup resize/move/save settle window to pass.
          await sleep(600);

          const persistedMid = session2.readStateFile<PersistedSessionFixture>();
          assert.ok(persistedMid !== null, 'Expected session-state.json on Launch 2');
          assert.equal(
            persistedMid.tabs.length,
            3,
            'Expected startup settle not to wipe persisted tabs',
          );
          assert.deepEqual(
            persistedMid.history,
            persisted1.history,
            'Expected Launch 2 restore not to alter persisted history',
          );

          const logsAfterRestore = ctx.servers.getHttpLogs();
          const shadowHits = logsAfterRestore.filter((l) => l.path === '/page/shadow');
          const interactionsHitsBefore = logsAfterRestore.filter(
            (l) => l.path === '/page/interactions',
          );
          const tabBHitsBefore = logsAfterRestore.filter(
            (l) => l.path === '/echo' && l.query.tab === 'b',
          );
          assert.ok(
            shadowHits.length >= 1,
            'Expected active restored tab (/page/shadow) to load on startup',
          );
          assert.equal(
            interactionsHitsBefore.length,
            0,
            'Expected dormant restored tab (/page/interactions) to have 0 HTTP hits on startup',
          );
          assert.equal(
            tabBHitsBefore.length,
            0,
            'Expected dormant restored tab (/echo?tab=b) to have 0 HTTP hits on startup',
          );

          // Materialize dormant restoredTab1 via evalJs (triggers ensureTabMaterializedAndLoaded).
          const readyRes = await session2.ctl.evalJs(
            'document.readyState',
            'landscape',
            restoredTab1.id,
          );
          assert.equal(
            readyRes.value,
            'complete',
            'Expected materialized dormant tab readyState === complete',
          );

          const tabsAfterMaterialize = await session2.ctl.tabs();
          const restoredTab1After = tabsAfterMaterialize.tabs.find(
            (t) => t.id === restoredTab1.id,
          );
          assert.ok(
            restoredTab1After,
            'Expected restoredTab1 to remain in tabs() after materialization',
          );
          assert.equal(
            restoredTab1After.sleeping,
            false,
            'Expected materialized restoredTab1.sleeping === false',
          );

          const logsAfterMaterialize = ctx.servers.getHttpLogs();
          const interactionsHitsAfter = logsAfterMaterialize.filter(
            (l) => l.path === '/page/interactions',
          );
          const tabBHitsAfter = logsAfterMaterialize.filter(
            (l) => l.path === '/echo' && l.query.tab === 'b',
          );
          assert.ok(
            interactionsHitsAfter.length >= 1,
            'Expected /page/interactions HTTP hit after dormant tab materialization',
          );
          assert.equal(
            tabBHitsAfter.length,
            0,
            'Expected unvisited dormant tab (/echo?tab=b) to remain at 0 HTTP hits',
          );

          session2.sendSignal('SIGTERM');
          await session2.waitForExit(5_000);

          const persisted2 = session2.readStateFile<PersistedSessionFixture>();
          assert.ok(
            persisted2 !== null,
            'Expected final session-state.json after Launch 2 SIGTERM',
          );
          assert.equal(persisted2.tabs.length, 3, 'Expected 3 tabs in final session-state.json');
          assert.deepEqual(
            persisted2.tabs.map((t) => t.url),
            persisted1.tabs.map((t) => t.url),
            'Expected final tab URLs to match Launch 1',
          );
          assert.deepEqual(
            persisted2.history.map((h) => ({
              url: h.url,
              visitCount: h.visitCount,
            })),
            persisted1.history.map((h) => ({
              url: h.url,
              visitCount: h.visitCount,
            })),
            'Expected final history URLs, order, and visitCounts to remain unmodified across restore + dormant materialization',
          );
        } finally {
          await session2.close();
        }
      } finally {
        fs.rmSync(sharedSessionDir, { recursive: true, force: true });
      }
    },
  },
];

export default smokeTests;

async function runStandaloneSmokeSuite(): Promise<void> {
  const servers = createTestServerCluster();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-smoke-'));
  let failed = 0;

  try {
    await servers.start();
    const ctx: E2ETestContext = {
      servers,
      launchElectron: (opts) => launchElectronSession(opts),
      tmpRoot,
    };

    for (const tc of smokeTests) {
      const started = Date.now();
      const timeoutMs = tc.timeoutMs ?? 60_000;
      try {
        await runWithTimeout(() => tc.run(ctx), timeoutMs, tc.id);
        process.stdout.write(
          `[PASS] ${tc.id} (${tc.features.join(',')}) — ${tc.title} [${Date.now() - started}ms]\n`,
        );
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `[FAIL] ${tc.id} (${tc.features.join(',')}) — ${tc.title} [${Date.now() - started}ms]\n  ${message}\n`,
        );
      }
    }
  } finally {
    await servers.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    `\nSmoke Summary: ${smokeTests.length - failed}/${smokeTests.length} passed, ${failed} failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  runStandaloneSmokeSuite().catch((err) => {
    process.stderr.write(
      `Standalone smoke runner fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
