import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {
  ControlSocketClientApi,
  E2ETestCase,
  E2ETestContext,
  PersistedSessionFixture,
  PersistedTabFixture,
  ViewportRole,
} from '../lib/types';

interface FetchResult {
  status: number;
  ok: boolean;
  dedupHeader: string | null;
  contentEncoding: string | null;
  bodyText: string;
  bodyLength: number;
  json: Record<string, unknown> | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null && value !== false && value !== undefined) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const suffix = lastErr !== null ? ` (last error: ${String(lastErr)})` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
}

function makeTabFixture(
  url: string,
  overrides: Partial<PersistedTabFixture> = {},
): PersistedTabFixture {
  return {
    url,
    title: 'Scenario Fixture',
    mode: 'dual',
    mirror: true,
    dedup: true,
    session: 'shared',
    sleeping: false,
    portraitPresetId: 'iphone-15',
    landscapePresetId: 'desktop-hd',
    devtoolsTarget: 'landscape',
    audioSource: 'landscape',
    ...overrides,
  };
}

function makeSeedSession(
  tabs: PersistedTabFixture[],
  overrides: Partial<PersistedSessionFixture> = {},
): PersistedSessionFixture {
  return {
    version: 1,
    savedAt: Date.now() - 5_000,
    railCollapsed: false,
    dockOpen: false,
    dockHeight: 290,
    splitRatio: 0.34,
    theme: 'dark',
    ecoMode: true,
    autoSleep: false,
    activeTabIndex: 0,
    tabs,
    history: [],
    ...overrides,
  };
}

async function execFetch(
  ctl: ControlSocketClientApi,
  role: ViewportRole,
  tabId: string,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual' | 'error';
  } = {},
): Promise<FetchResult> {
  const expr = `(async () => {
    const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
    const bodyText = await res.text();
    let json = null;
    try { json = JSON.parse(bodyText); } catch {}
    return JSON.stringify({
      status: res.status,
      ok: res.ok,
      dedupHeader: res.headers.get('x-iron-browser-dedup'),
      contentEncoding: res.headers.get('content-encoding'),
      bodyText: bodyText.length > 4096 ? bodyText.slice(0, 4096) : bodyText,
      bodyLength: bodyText.length,
      json,
    });
  })()`;
  const evalRes = await ctl.evalJs(expr, role, tabId);
  return JSON.parse(evalRes.value) as FetchResult;
}

function cleanupDirSafe(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup in outer finally.
  }
}

export const tests: E2ETestCase[] = [
  {
    id: 'T4-S01',
    tier: 4,
    features: ['F6', 'F7', 'F11'],
    title: 'Dual-Viewport Bet/Checkout Mutation Deduplication',
    description:
      'Exercises mirrored POST /mutate and POST /mutate-gzip with distinct client correlation IDs, verifying 1 upstream hit, replayed header, valid decompression, and no disk dirtying.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], {
          ecoMode: true,
          dockOpen: false,
        }),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected initial tab');
        await session.ctl.waitForTabReady(t0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await sleep(700);
        const baselineSavedAt =
          session.readStateFile<PersistedSessionFixture>()?.savedAt ?? null;

        // Phase A: Plain JSON POST /mutate
        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [plainP, plainL] = await Promise.all([
          execFetch(session.ctl, 'portrait', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'bet',
              amount: 50,
              idempotencyKey: 'bet-port-1001',
              ts: 1700000001000,
            }),
          }),
          execFetch(session.ctl, 'landscape', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'bet',
              amount: 50,
              idempotencyKey: 'bet-land-1002',
              ts: 1700000002000,
            }),
          }),
        ]);

        assert.equal(plainP.status, 200);
        assert.equal(plainL.status, 200);
        assert.equal(plainP.json?.ok, true);
        assert.equal(plainL.json?.ok, true);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          1,
          'Phase A: /mutate must hit server once',
        );
        const plainReplayed = [plainP.dedupHeader, plainL.dedupHeader].filter(
          (h) => h === 'replayed',
        ).length;
        assert.equal(plainReplayed, 1, 'Phase A: exactly 1 replayed header');

        const plainPCorr = plainP.json?.correlation as Record<string, unknown> | undefined;
        const plainLCorr = plainL.json?.correlation as Record<string, unknown> | undefined;
        assert.equal(plainPCorr?.idempotencyKey, 'bet-port-1001');
        assert.equal(plainLCorr?.idempotencyKey, 'bet-land-1002');

        // Phase B: Gzipped JSON POST /mutate-gzip
        ctx.servers.resetHttpLogs();
        const gzipUrl = `${ctx.servers.httpBaseUrl}/mutate-gzip`;
        const [gzipP, gzipL] = await Promise.all([
          execFetch(session.ctl, 'portrait', t0.id, gzipUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'checkout',
              amount: 120,
              clientBetId: 'cbet-port-2001',
              ts: 1700000003000,
            }),
          }),
          execFetch(session.ctl, 'landscape', t0.id, gzipUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'checkout',
              amount: 120,
              clientBetId: 'cbet-land-2002',
              ts: 1700000004000,
            }),
          }),
        ]);

        assert.equal(gzipP.status, 200);
        assert.equal(gzipL.status, 200);
        assert.equal(gzipP.json?.ok, true);
        assert.equal(gzipL.json?.ok, true);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate-gzip').length,
          1,
          'Phase B: /mutate-gzip must hit server once',
        );
        const gzipReplayed = [gzipP.dedupHeader, gzipL.dedupHeader].filter(
          (h) => h === 'replayed',
        ).length;
        assert.equal(gzipReplayed, 1, 'Phase B: exactly 1 replayed header');

        const gzipPCorr = gzipP.json?.correlation as Record<string, unknown> | undefined;
        const gzipLCorr = gzipL.json?.correlation as Record<string, unknown> | undefined;
        assert.equal(gzipPCorr?.clientBetId, 'cbet-port-2001');
        assert.equal(gzipLCorr?.clientBetId, 'cbet-land-2002');

        // Phase C: dedupCount & no spurious disk write
        const afterTabs = await session.ctl.tabs();
        const afterT0 = afterTabs.tabs[0];
        assert.ok(afterT0, 'expected tab snapshot');
        assert.ok(
          (afterT0.dedupCount ?? 0) >= 2,
          `expected dedupCount >= 2, got ${String(afterT0.dedupCount)}`,
        );

        await sleep(700);
        const afterSavedAt =
          session.readStateFile<PersistedSessionFixture>()?.savedAt ?? null;
        assert.equal(
          afterSavedAt,
          baselineSavedAt,
          'dedupCount increments must not dirty session-state.json',
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T4-S02',
    tier: 4,
    features: ['F3', 'F6', 'F7', 'F12'],
    title: 'Cache-Clearing Reload + R2 Dedup Slot Eviction',
    description:
      'Loads /cacheable, performs POST /mutate, triggers reload on both viewports, verifies seq incremented and post-reload POST /mutate succeeds without stale slot replay while DevTools stays closed (TabManager.reloadIgnoringCache & Ctrl+R/F5/Ctrl+Shift+R shortcuts verified in unit tests per TEST_INFRA.md §4.3).',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const cacheUrl = `${ctx.servers.httpBaseUrl}/cacheable?format=html`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(cacheUrl)], { dockOpen: false }),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab 0');
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/cacheable' });

        const [seqP1Eval, seqL1Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            t0.id,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            t0.id,
          ),
        ]);
        const seqP1 = Number(seqP1Eval.value);
        const seqL1 = Number(seqL1Eval.value);
        assert.ok(Number.isInteger(seqP1) && seqP1 >= 1, `expected seqP1 >= 1, got ${seqP1}`);
        assert.ok(Number.isInteger(seqL1) && seqL1 >= 1, `expected seqL1 >= 1, got ${seqL1}`);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, false);

        await session.ctl.evalJs("console.warn('s02-pre-reload')", 'portrait', t0.id);
        const preConsole = await pollUntil(
          async () => {
            const res = await session.ctl.console(t0.id, 50);
            return res.entries.some((e) => e.text.includes('s02-pre-reload'))
              ? res
              : null;
          },
          5_000,
          100,
          'console warning captured while DevTools closed',
        );
        assert.ok(preConsole.count >= 1);

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [preP, preL] = await Promise.all([
          execFetch(session.ctl, 'portrait', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bet', amount: 99, idempotencyKey: 's02-pre-1' }),
          }),
          execFetch(session.ctl, 'landscape', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bet', amount: 99, idempotencyKey: 's02-pre-2' }),
          }),
        ]);
        assert.equal(preP.status, 200);
        assert.equal(preL.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length, 1);

        // ControlSocketServer lacks a browser_reload RPC and CDP Input.dispatchKeyEvent does not trigger
        // Electron handleGlobalShortcut (TEST_INFRA.md §4.3); TabManager.reloadIgnoringCache + shortcuts are
        // tested in test/r1-optimizations.test.ts. window.location.reload() empirically hits /cacheable.
        const preReloadHits = ctx.servers.getHttpLogs('/cacheable').length;
        await Promise.all([
          session.ctl.evalJs('window.location.reload()', 'portrait', t0.id),
          session.ctl.evalJs('window.location.reload()', 'landscape', t0.id),
        ]);

        await pollUntil(
          async () => {
            if (ctx.servers.getHttpLogs('/cacheable').length < preReloadHits + 2) {
              return null;
            }
            const state = await session.ctl.tabs();
            const tab = state.tabs.find((t) => t.id === t0.id);
            return tab && !tab.loading ? true : null;
          },
          10_000,
          100,
          `cacheable reload >= ${preReloadHits + 2} hits and !loading`,
        );
        await new Promise((r) => setTimeout(r, 200));
        await session.ctl.waitForTabReady(t0.id, {
          expectedUrlIncludes: '/cacheable',
          waitForDomComplete: true,
          timeoutMs: 10_000,
        });

        const [seqP2Eval, seqL2Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            t0.id,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            t0.id,
          ),
        ]);
        const seqP2 = Number(seqP2Eval.value);
        const seqL2 = Number(seqL2Eval.value);
        assert.ok(
          Number.isInteger(seqP2) && Number.isInteger(seqL2) && seqP2 > seqP1 && seqL2 > seqL1,
          `cacheable seq > (${seqP1}, ${seqL1}) after reload, got (${seqP2}, ${seqL2})`,
        );

        ctx.servers.resetHttpLogs();
        const staticPayload = JSON.stringify({ action: 'bet', amount: 99 });
        const [postP, postL] = await Promise.all([
          execFetch(session.ctl, 'portrait', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: staticPayload,
          }),
          execFetch(session.ctl, 'landscape', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: staticPayload,
          }),
        ]);
        assert.equal(postP.status, 200);
        assert.equal(postL.status, 200);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          1,
          'post-reload POST /mutate must execute fresh against upstream once',
        );
        assert.equal(
          [postP.dedupHeader, postL.dedupHeader].filter((h) => h === 'replayed').length,
          1,
        );

        const net = await session.ctl.network(t0.id, 100);
        assert.ok(net.entries.some((e) => e.url.includes('/cacheable')));
        assert.ok(net.entries.some((e) => e.url.includes('/mutate')));
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, false);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T4-S03',
    tier: 4,
    features: ['F8', 'F11'],
    title: 'Live Realtime Lobby over Symmetric WS + SSE Mux with Owner Failover',
    description:
      'Verifies 1 WS + 1 SSE upstream connection for Dual viewports, text & binary ArrayBuffer fan-out, outbound WS dedup, named SSE events, and 1012 owner failover promotion.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetWsStats();
      ctx.servers.resetSseStats();
      const wsSseUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(wsSseUrl)]),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab 0');
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/ws-sse' });

        // 1. WS connect + 1-upstream verification
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          t0.id,
        );
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          t0.id,
        );
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'portrait',
              t0.id,
            );
            const l = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              t0.id,
            );
            return p.value === 'open:chat.v1' && l.value === 'open:chat.v1' ? true : null;
          },
          5_000,
          100,
          'both WS viewports open with chat.v1',
        );
        const wsStatsAfterOpen = ctx.servers.getWsStats();
        assert.equal(wsStatsAfterOpen.activeConnections, 1);
        assert.equal(wsStatsAfterOpen.totalConnections, 1);

        // 2. Inbound text + binary ArrayBuffer fan-out
        ctx.servers.broadcastWs('lobby-welcome');
        ctx.servers.broadcastWs(new Uint8Array([1, 2, 3, 4]));
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              'JSON.stringify(window.__wsLog)',
              'portrait',
              t0.id,
            );
            const l = await session.ctl.evalJs(
              'JSON.stringify(window.__wsLog)',
              'landscape',
              t0.id,
            );
            const pArr = JSON.parse(p.value) as unknown[];
            const lArr = JSON.parse(l.value) as unknown[];
            return pArr.length >= 2 && lArr.length >= 2 ? { pArr, lArr } : null;
          },
          5_000,
          100,
          'text and binary WS frames on both viewports',
        ).then(({ pArr, lArr }) => {
          assert.deepEqual(pArr, ['lobby-welcome', { binary: [1, 2, 3, 4] }]);
          assert.deepEqual(lArr, ['lobby-welcome', { binary: [1, 2, 3, 4] }]);
        });

        // 3. Outbound WS dedup (~1500ms)
        await Promise.all([
          session.ctl.evalJs(
            `window.__wsSend(${JSON.stringify(JSON.stringify({ op: 'place', requestId: 'ws-p-1', ts: 1000 }))})`,
            'portrait',
            t0.id,
          ),
          session.ctl.evalJs(
            `window.__wsSend(${JSON.stringify(JSON.stringify({ op: 'place', requestId: 'ws-l-2', ts: 1001 }))})`,
            'landscape',
            t0.id,
          ),
        ]);
        await sleep(300);
        assert.equal(
          ctx.servers.getWsStats().receivedMessages.length,
          1,
          'outbound mirrored WS frame must dedup within 1500ms',
        );

        // 4. SSE connect + 1-upstream + named events
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'portrait',
          t0.id,
        );
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'landscape',
          t0.id,
        );
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              "document.getElementById('sse-status')?.textContent ?? ''",
              'portrait',
              t0.id,
            );
            const l = await session.ctl.evalJs(
              "document.getElementById('sse-status')?.textContent ?? ''",
              'landscape',
              t0.id,
            );
            return p.value === 'open' && l.value === 'open' ? true : null;
          },
          5_000,
          100,
          'both SSE viewports open',
        );
        assert.equal(ctx.servers.getSseStats().activeConnections, 1);

        ctx.servers.pushSseEvent('ping-evt', '{"round":7}', 'evt-700');
        ctx.servers.pushSseEvent('room_state', '{"phase":"open"}', 'evt-701');
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              'JSON.stringify(window.__sseLog)',
              'portrait',
              t0.id,
            );
            const l = await session.ctl.evalJs(
              'JSON.stringify(window.__sseLog)',
              'landscape',
              t0.id,
            );
            const pArr = JSON.parse(p.value) as Array<Record<string, string>>;
            const lArr = JSON.parse(l.value) as Array<Record<string, string>>;
            return pArr.length >= 2 && lArr.length >= 2 ? { pArr, lArr } : null;
          },
          5_000,
          100,
          'named SSE events on both viewports',
        ).then(({ pArr, lArr }) => {
          assert.deepEqual(pArr, lArr);
          assert.equal(pArr[0]?.type, 'ping-evt');
          assert.equal(pArr[0]?.lastEventId, 'evt-700');
          assert.equal(pArr[1]?.type, 'room_state');
          assert.equal(pArr[1]?.lastEventId, 'evt-701');
        });

        // 5. Owner failover (1012) & survivor re-open
        assert.equal(ctx.servers.closeFirstWsOwner(1012, 'owner-teardown'), true);
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'portrait',
              t0.id,
            );
            const l = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              t0.id,
            );
            return p.value === 'closed:1012' && l.value === 'closed:1012' ? true : null;
          },
          5_000,
          100,
          'closed:1012 on both viewports',
        );

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          t0.id,
        );
        await pollUntil(
          async () => {
            const l = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              t0.id,
            );
            return l.value === 'open:chat.v1' &&
              ctx.servers.getWsStats().activeConnections === 1
              ? true
              : null;
          },
          5_000,
          100,
          'survivor promotes to new WS owner',
        );
        ctx.servers.broadcastWs('after-failover');
        await pollUntil(
          async () => {
            const l = await session.ctl.evalJs(
              'JSON.stringify(window.__wsLog)',
              'landscape',
              t0.id,
            );
            return l.value.includes('after-failover') ? true : null;
          },
          5_000,
          100,
          'post-failover message delivered',
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T4-S04',
    tier: 4,
    features: ['F4', 'F10', 'F11'],
    title: 'Multi-Tab Session Restart, Dormant Tabs & SIGTERM Persistence',
    description:
      'Opens 4 tabs, builds short history, flushes via SIGTERM, relaunches against the same sessionDir, and verifies sessionRestored, history parity, and lazy dormant tabs.',
    timeoutMs: 120_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const session1 = await ctx.launchElectron({
        smoke: true,
        keepTempDir: true,
      });
      const sharedDir = session1.sessionDir;

      let persisted1: PersistedSessionFixture | null = null;
      try {
        try {
          for (const idx of [1, 2, 3] as const) {
            const opened = await session1.ctl.open(
              `${ctx.servers.httpBaseUrl}/echo?tab=${idx}`,
              { mode: 'dual', session: 'shared' },
            );
            assert.ok(opened.tab, `expected tab ${idx}`);
            await session1.ctl.waitForTabReady(opened.tab.id, {
              expectedUrlIncludes: `/echo?tab=${idx}`,
            });
          }

          const activeOpened = await session1.ctl.open(
            `${ctx.servers.httpBaseUrl}/echo?tab=0`,
            { mode: 'dual', session: 'shared' },
          );
          assert.ok(activeOpened.tab, 'expected active tab 0');
          const activeId = activeOpened.tab.id;
          await session1.ctl.waitForTabReady(activeId, {
            expectedUrlIncludes: '/echo?tab=0',
          });

          await session1.ctl.navigate(
            `${ctx.servers.httpBaseUrl}/echo?tab=0&step=1`,
            activeId,
          );
          await session1.ctl.waitForTabReady(activeId, {
            expectedUrlIncludes: 'step=1',
          });
          await session1.ctl.navigate(
            `${ctx.servers.httpBaseUrl}/echo?tab=0&step=2`,
            activeId,
          );
          await session1.ctl.waitForTabReady(activeId, {
            expectedUrlIncludes: 'step=2',
          });

          session1.sendSignal('SIGTERM');
          await session1.waitForExit(8_000);
        } finally {
          await session1.close();
        }

        persisted1 = JSON.parse(
          fs.readFileSync(session1.stateFilePath, 'utf8'),
        ) as PersistedSessionFixture;
        assert.equal(persisted1.tabs.length, 4);
        assert.ok(persisted1.history.length >= 2, 'expected short history >= 2');
        assert.equal(persisted1.ecoMode, true);
        assert.equal(persisted1.autoSleep, false);
        assert.equal(persisted1.dockOpen, false);
        const savedActiveTab = persisted1.tabs[persisted1.activeTabIndex];
        assert.ok(savedActiveTab?.url.includes('step=2'));

        ctx.servers.resetHttpLogs();
        const session2 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedDir,
          keepTempDir: true,
        });
        try {
          const tabs2 = await session2.ctl.tabs();
          assert.equal(tabs2.tabs.length, 4);
          const activeRestored = tabs2.tabs.find((t) => t.id === tabs2.activeTabId);
          assert.ok(activeRestored && activeRestored.url.includes('step=2'));
          await session2.ctl.waitForTabReady(activeRestored.id, {
            expectedUrlIncludes: 'step=2',
          });

          const echoLogs = ctx.servers.getHttpLogs('/echo');
          assert.ok(
            echoLogs.some((e) => e.query.step === '2'),
            'active restored tab must load',
          );
          for (const dormantIdx of ['1', '2', '3']) {
            assert.equal(
              echoLogs.filter((e) => e.query.tab === dormantIdx).length,
              0,
              `dormant tab ${dormantIdx} must emit 0 HTTP hits before selection`,
            );
          }

          const dormantTab2 = tabs2.tabs.find((t) => t.url.includes('tab=2'));
          assert.ok(dormantTab2, 'expected dormant tab=2');
          const rs = await session2.ctl.evalJs(
            'document.readyState',
            'landscape',
            dormantTab2.id,
          );
          assert.equal(rs.value, 'complete');
          await pollUntil(
            async () => {
              const hits = ctx.servers
                .getHttpLogs('/echo')
                .filter((e) => e.query.tab === '2');
              return hits.length >= 1 ? hits : null;
            },
            5_000,
            100,
            'dormant tab 2 loaded after evalJs materialization',
          );

          session2.sendSignal('SIGTERM');
          await session2.waitForExit(8_000);
          const persisted2 = session2.readStateFile<PersistedSessionFixture>();
          assert.ok(persisted2, 'expected persisted state after launch 2 SIGTERM');
          assert.equal(
            persisted2.history.length,
            persisted1.history.length,
            'history must not corrupt or duplicate entries across restore',
          );
        } finally {
          await session2.close();
        }
      } finally {
        cleanupDirSafe(sharedDir);
      }
    },
  },

  {
    id: 'T4-S05',
    tier: 4,
    features: ['F1', 'F2', 'F3', 'F5'],
    title: 'Eco DPR Cap + Burst FPS + Telemetry Polling Lifecycle',
    description:
      'Verifies Eco DPR clamp vs HiDPI DPR=3, active 2s CDP Performance.getMetrics & burst FPS sampling (paused=false) with dockOpen=false, and console/network capture without DevTools (window blur/minimize throttling covered in test/r1-optimizations.test.ts because ControlSocketServer lacks blur/minimize RPCs per TEST_INFRA.md §4.3).',
    timeoutMs: 120_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;

      // Launch 1: EcoMode ON
      const sEco = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], {
          ecoMode: true,
          dockOpen: false,
        }),
      });
      try {
        const t0 = (await sEco.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected eco tab');
        await sEco.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        const ecoDpr = Number(
          (await sEco.ctl.evalJs('String(window.devicePixelRatio)', 'portrait', t0.id)).value,
        );
        assert.ok(
          Number.isFinite(ecoDpr) && ecoDpr >= 1 && ecoDpr < 3,
          `expected Eco DPR in [1, 3), got ${ecoDpr}`,
        );
        assert.equal(sEco.readStateFile<PersistedSessionFixture>()?.dockOpen, false);

        // ControlSocketServer exposes no window blur/minimize RPCs (TEST_INFRA.md §4.3);
        // this E2E scenario verifies active 2s CDP polling (paused=false), while blur (5s)
        // and minimize/hide (paused=true) transitions are verified in test/r1-optimizations.test.ts.
        const m1 = await sEco.ctl.metrics();
        await sleep(2_200);
        const m2 = await sEco.ctl.metrics();

        assert.equal(m2.paused, false);
        assert.ok(m2.timestampMs > m1.timestampMs);
        assert.ok(m2.portrait !== null && m2.landscape !== null);
        assert.ok(m2.landscape.domNodes > 0);
        assert.ok(m2.portrait.jsHeapUsedMb > 0);
        assert.ok(Number.isFinite(m2.totalMemoryMb) && m2.totalMemoryMb > 0);
        assert.ok(Number.isFinite(m2.portrait.fps) && m2.portrait.fps >= 0);
        assert.ok(Number.isFinite(m2.portrait.p95FrameMs) && m2.portrait.p95FrameMs >= 0);

        await sEco.ctl.evalJs("console.error('s05-err')", 'portrait', t0.id);
        await execFetch(sEco.ctl, 'landscape', t0.id, `${ctx.servers.httpBaseUrl}/status/500`, {
          method: 'POST',
        });

        await pollUntil(
          async () => {
            const con = await sEco.ctl.console(t0.id, 50);
            const net = await sEco.ctl.network(t0.id, 50);
            return con.entries.some((e) => e.text.includes('s05-err')) &&
              net.entries.some((e) => e.url.includes('/status/500'))
              ? true
              : null;
          },
          5_000,
          100,
          'console and network buffers active with dockOpen=false',
        );
      } finally {
        await sEco.close();
      }

      // Launch 2: EcoMode OFF (HiDPI)
      const sHi = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], {
          ecoMode: false,
          dockOpen: false,
        }),
      });
      try {
        const t0 = (await sHi.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected hidpi tab');
        await sHi.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        const hiDpr = Number(
          (await sHi.ctl.evalJs('String(window.devicePixelRatio)', 'portrait', t0.id)).value,
        );
        assert.equal(hiDpr, 3, 'expected un-capped HiDPI DPR === 3 on iphone-15');
      } finally {
        await sHi.close();
      }
    },
  },

  {
    id: 'T4-S06',
    tier: 4,
    features: ['F4', 'F10'],
    title: 'autoSleep Opt-In vs Active/Sleeping Tab Protection Across Restarts',
    description:
      'Verifies autoSleep defaults to false on clean launch, opt-in autoSleep=true persists across SIGTERM + relaunch, active tabs stay awake, and sleeping/dormant tabs emit 0 HTTP hits.',
    timeoutMs: 120_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      // Launch 1: Verify default autoSleep === false
      const sDefault = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await sDefault.ctl.open(`${ctx.servers.httpBaseUrl}/echo?default=1`);
        assert.ok(opened.tab);
        await sDefault.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        sDefault.sendSignal('SIGTERM');
        await sDefault.waitForExit(8_000);
        const persistedDefault = sDefault.readStateFile<PersistedSessionFixture>();
        assert.ok(persistedDefault, 'expected flushed default session');
        assert.equal(persistedDefault.autoSleep, false, 'autoSleep must default to false');
      } finally {
        await sDefault.close();
      }

      // Launch 2 & 3: Opt-in autoSleep=true with active, dormant, and sleeping tabs
      ctx.servers.resetHttpLogs();
      const activeUrl = `${ctx.servers.httpBaseUrl}/echo?active=1`;
      const dormantUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const sleptUrl = `${ctx.servers.httpBaseUrl}/echo?slept=1`;

      const s2 = await ctx.launchElectron({
        smoke: true,
        keepTempDir: true,
        seedSession: makeSeedSession(
          [
            makeTabFixture(activeUrl, { sleeping: false }),
            makeTabFixture(dormantUrl, { sleeping: false }),
            makeTabFixture(sleptUrl, { sleeping: true }),
          ],
          { autoSleep: true, activeTabIndex: 0 },
        ),
      });
      const sharedDir = s2.sessionDir;

      try {
        try {
          const tabs2 = await s2.ctl.tabs();
          const t0 = tabs2.tabs[0];
          const t1 = tabs2.tabs[1];
          const t2 = tabs2.tabs[2];
          assert.ok(t0 && t1 && t2, 'expected 3 tabs');
          await s2.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/echo' });

          const awakeSum = await s2.ctl.evalJs('String(1 + 1)', 'landscape', t0.id);
          assert.equal(awakeSum.value, '2');

          assert.equal(t2.sleeping, true);
          await assert.rejects(() => s2.ctl.evalJs('1', 'landscape', t2.id), /sleeping/i);

          assert.equal(
            ctx.servers.getHttpLogs('/echo').filter((e) => e.query.slept === '1').length,
            0,
          );
          assert.equal(ctx.servers.getHttpLogs('/page/ws-sse').length, 0);

          s2.sendSignal('SIGTERM');
          await s2.waitForExit(8_000);
        } finally {
          await s2.close();
        }

        const s3 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedDir,
          keepTempDir: true,
        });
        try {
          const tabs3 = await s3.ctl.tabs();
          const r0 = tabs3.tabs[0];
          const r2 = tabs3.tabs[2];
          assert.ok(r0 && r2, 'expected restored tabs');
          await s3.ctl.waitForTabReady(r0.id, { expectedUrlIncludes: '/echo' });
          assert.equal(r0.sleeping, false);
          assert.equal(r2.sleeping, true);
          assert.equal(
            ctx.servers.getHttpLogs('/echo').filter((e) => e.query.slept === '1').length,
            0,
          );

          s3.sendSignal('SIGTERM');
          await s3.waitForExit(8_000);
          const persisted3 = s3.readStateFile<PersistedSessionFixture>();
          assert.equal(persisted3?.autoSleep, true);
        } finally {
          await s3.close();
        }
      } finally {
        cleanupDirSafe(sharedDir);
      }
    },
  },

  {
    id: 'T4-S07',
    tier: 4,
    features: ['F2', 'F5', 'F9'],
    title: 'Complex Form, Slider, Canvas, Shadow DOM & Iframe UI Replication',
    description:
      'Drives ARIA toggles, select, range slider, canvas pointer events, top-level scroll, nested Shadow DOM, same-origin iframe, and cross-origin iframe isolation across Dual Mirror viewports.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const base = ctx.servers.httpBaseUrl;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(`${base}/page/interactions`)]),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab 0');
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        const injectViewportMetaExpr = `(() => {
          if (!document.querySelector('meta[name="viewport"]')) {
            const meta = document.createElement('meta');
            meta.name = 'viewport';
            meta.content = 'width=device-width, initial-scale=1';
            document.head.appendChild(meta);
          }
          return JSON.stringify({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
          });
        })()`;
        for (const role of ['portrait', 'landscape'] as const) {
          const dims = JSON.parse(
            (await session.ctl.evalJs(injectViewportMetaExpr, role, t0.id)).value,
          ) as { innerWidth: number; innerHeight: number; scrollHeight: number };
          assert.ok(
            dims.scrollHeight > dims.innerHeight,
            `${role} expected scrollHeight (${dims.scrollHeight}) > innerHeight (${dims.innerHeight})`,
          );
        }
        // Flush compositor hit-testing surfaces in --smoke offscreen windows before dispatching clicks.
        await session.ctl.screenshot(t0.id, 'both');

        // 1. ARIA & data-state toggles
        for (const selector of [
          '#btn-toggle-pressed',
          '#btn-toggle-checked',
          '#btn-toggle-selected',
          '#btn-toggle-state',
        ]) {
          await session.ctl.interact({
            action: 'click',
            tabId: t0.id,
            viewport: 'portrait',
            selector,
            mirror: true,
          });
        }

        // 2. Select option + range slider + canvas + document scroll
        await session.ctl.interact({
          action: 'click',
          tabId: t0.id,
          viewport: 'portrait',
          selector: '#color-select',
          mirror: true,
        });
        await session.ctl.interact({
          action: 'key',
          tabId: t0.id,
          viewport: 'portrait',
          key: 'ArrowDown',
          mirror: true,
        });
        await session.ctl.interact({
          action: 'key',
          tabId: t0.id,
          viewport: 'portrait',
          key: 'Enter',
          mirror: true,
        });

        await session.ctl.interact({
          action: 'click',
          tabId: t0.id,
          viewport: 'portrait',
          selector: '#range-slider',
          mirror: true,
        });

        await session.ctl.interact({
          action: 'hover',
          tabId: t0.id,
          viewport: 'portrait',
          selector: '#draw-canvas',
          mirror: true,
        });
        await session.ctl.interact({
          action: 'click',
          tabId: t0.id,
          viewport: 'portrait',
          selector: '#draw-canvas',
          mirror: true,
        });
        await session.ctl.interact({
          action: 'scroll',
          tabId: t0.id,
          viewport: 'portrait',
          ratioY: 0.5,
          mirror: true,
        });

        const interactionResults: Array<{
          role: ViewportRole;
          rangeVal: string;
          selectVal: string;
        }> = [];
        for (const role of ['portrait', 'landscape'] as const) {
          const stateEval = await session.ctl.evalJs(
            `JSON.stringify({
              pressed: document.getElementById('btn-toggle-pressed')?.getAttribute('aria-pressed'),
              checked: document.getElementById('btn-toggle-checked')?.getAttribute('aria-checked'),
              selected: document.getElementById('btn-toggle-selected')?.getAttribute('aria-selected'),
              dataState: document.getElementById('btn-toggle-state')?.getAttribute('data-state'),
              selectVal: document.getElementById('select-val')?.textContent ?? '',
              rangeVal: document.getElementById('range-val')?.textContent ?? '',
              canvasCount: Array.isArray(window.__canvasPoints) ? window.__canvasPoints.length : 0,
              scrollY: window.scrollY,
              innerScrollTop: document.getElementById('inner-scroll')?.scrollTop ?? -1,
            })`,
            role,
            t0.id,
          );
          const st = JSON.parse(stateEval.value) as {
            pressed: string | null;
            checked: string | null;
            selected: string | null;
            dataState: string | null;
            selectVal: string;
            rangeVal: string;
            canvasCount: number;
            scrollY: number;
            innerScrollTop: number;
          };
          assert.equal(st.pressed, 'true', `${role} aria-pressed`);
          assert.equal(st.checked, 'true', `${role} aria-checked`);
          assert.equal(st.selected, 'true', `${role} aria-selected`);
          assert.equal(st.dataState, 'open', `${role} data-state`);
          assert.equal(st.selectVal, 'green', `${role} select value`);
          assert.notEqual(st.rangeVal, '25', `${role} range slider changed`);
          assert.ok(st.canvasCount > 0, `${role} canvas events recorded`);
          assert.ok(st.scrollY > 0, `${role} top-level scrollY > 0`);
          assert.equal(st.innerScrollTop, 0, `${role} inner-scroll untouched`);
          interactionResults.push({ role, rangeVal: st.rangeVal, selectVal: st.selectVal });
        }
        assert.equal(
          interactionResults[0]?.rangeVal,
          interactionResults[1]?.rangeVal,
          'range slider values match across viewports',
        );

        // 3. Shadow DOM
        // Per TEST_INFRA.md §4.3, ctl.interact calls EchoLoopGuard.markReplaying() (bypassing MirrorRelay
        // capture-to-replay, which is verified in test/mirror-relay.test.ts) and bare selector lookup
        // in resolveTarget is not required to pierce Shadow DOM / iframes. Compute viewport-relative
        // coordinates via evalJs and click exact (x, y) coordinates on both viewports.
        await session.ctl.navigate(`${base}/page/shadow`, t0.id);
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/shadow' });
        await session.ctl.evalJs(injectViewportMetaExpr, 'portrait', t0.id);
        await session.ctl.evalJs(injectViewportMetaExpr, 'landscape', t0.id);
        await session.ctl.screenshot(t0.id, 'both');

        for (const role of ['portrait', 'landscape'] as const) {
          const coordsEval = await session.ctl.evalJs(
            `(() => {
              const btn = document
                .getElementById('shadow-host')
                ?.shadowRoot?.getElementById('nested-shadow-host')
                ?.shadowRoot?.getElementById('shadow-btn');
              if (!btn) return JSON.stringify({ found: false });
              const r = btn.getBoundingClientRect();
              return JSON.stringify({
                found: true,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
              });
            })()`,
            role,
            t0.id,
          );
          const coords = JSON.parse(coordsEval.value) as { found: boolean; x: number; y: number };
          assert.equal(coords.found, true, `${role} nested #shadow-btn found`);
          assert.ok(coords.x > 1 && coords.y > 1, `${role} shadow coords > 1 (${coords.x},${coords.y})`);
          await session.ctl.interact({
            action: 'click',
            tabId: t0.id,
            viewport: role,
            x: coords.x,
            y: coords.y,
            mirror: false,
          });
        }
        for (const role of ['portrait', 'landscape'] as const) {
          const out = await session.ctl.evalJs(
            "document.getElementById('shadow-output')?.textContent ?? ''",
            role,
            t0.id,
          );
          assert.equal(out.value, '1', `${role} nested shadow click incremented #shadow-output`);
        }

        // 4. Same-origin iframe
        await session.ctl.navigate(`${base}/page/iframe-same`, t0.id);
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/iframe-same' });
        await session.ctl.evalJs(injectViewportMetaExpr, 'portrait', t0.id);
        await session.ctl.evalJs(injectViewportMetaExpr, 'landscape', t0.id);
        await pollUntil(
          async () => {
            const [pReady, lReady] = await Promise.all([
              session.ctl.evalJs(
                "document.getElementById('child-frame')?.contentDocument?.readyState ?? ''",
                'portrait',
                t0.id,
              ),
              session.ctl.evalJs(
                "document.getElementById('child-frame')?.contentDocument?.readyState ?? ''",
                'landscape',
                t0.id,
              ),
            ]);
            return pReady.value === 'complete' && lReady.value === 'complete' ? true : null;
          },
          5_000,
          100,
          'same-origin child iframe ready on both viewports',
        );
        await session.ctl.screenshot(t0.id, 'both');

        for (const role of ['portrait', 'landscape'] as const) {
          const coordsEval = await session.ctl.evalJs(
            `(() => {
              const frame = document.getElementById('child-frame');
              const btn = frame?.contentDocument?.getElementById('iframe-btn');
              if (!frame || !btn) return JSON.stringify({ found: false });
              const fr = frame.getBoundingClientRect();
              const br = btn.getBoundingClientRect();
              return JSON.stringify({
                found: true,
                x: Math.round(fr.left + br.left + br.width / 2),
                y: Math.round(fr.top + br.top + br.height / 2),
              });
            })()`,
            role,
            t0.id,
          );
          const coords = JSON.parse(coordsEval.value) as { found: boolean; x: number; y: number };
          assert.equal(coords.found, true, `${role} same-origin #iframe-btn found`);
          assert.ok(coords.x > 1 && coords.y > 1, `${role} iframe coords > 1 (${coords.x},${coords.y})`);
          await session.ctl.interact({
            action: 'click',
            tabId: t0.id,
            viewport: role,
            x: coords.x,
            y: coords.y,
            mirror: false,
          });
        }
        for (const role of ['portrait', 'landscape'] as const) {
          const count = await session.ctl.evalJs(
            "document.getElementById('child-frame')?.contentDocument?.getElementById('iframe-count')?.textContent ?? ''",
            role,
            t0.id,
          );
          assert.equal(count.value, '1', `${role} same-origin iframe click incremented #iframe-count`);
        }

        // 5. Cross-origin iframe isolation + healthy metrics
        await session.ctl.navigate(`${base}/page/iframe-cross`, t0.id);
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/iframe-cross' });
        for (const role of ['portrait', 'landscape'] as const) {
          const crossCheck = await session.ctl.evalJs(
            `(() => {
              try {
                const doc = document.getElementById('cross-frame')?.contentDocument;
                return doc ? 'accessible' : 'blocked';
              } catch {
                return 'blocked';
              }
            })()`,
            role,
            t0.id,
          );
          assert.equal(crossCheck.value, 'blocked', `${role} cross-origin iframe isolated`);
        }

        const metrics = await session.ctl.metrics();
        assert.equal(metrics.paused, false);
        assert.ok(metrics.portrait && metrics.landscape);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T4-S08',
    tier: 4,
    features: ['F6', 'F7', 'F8', 'F9', 'F12'],
    title: 'Security & Fail-Open Boundary Stress Workflow',
    description:
      'Verifies fail-open handling for 302/401/500/>2MB/ndjson, isolated mode R2+R3 gating, password/token non-leakage on /page/password, cross-origin iframe isolation, and clean recovery.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const base = ctx.servers.httpBaseUrl;
      ctx.servers.resetHttpLogs();
      ctx.servers.resetWsStats();

      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(`${base}/page/interactions`)]),
      });
      try {
        const sharedTab = (await session.ctl.tabs()).tabs[0];
        assert.ok(sharedTab, 'expected shared tab');
        await session.ctl.waitForTabReady(sharedTab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        // 1. Fail-open HTTP boundaries
        const failOpenTargets: Array<{ path: string; redirect?: 'manual' }> = [
          { path: '/status/302', redirect: 'manual' },
          { path: '/status/401' },
          { path: '/status/500' },
          { path: '/large' },
          { path: '/stream?type=ndjson' },
        ];
        for (const target of failOpenTargets) {
          ctx.servers.resetHttpLogs();
          const url = `${base}${target.path}`;
          const [pRes, lRes]: [FetchResult, FetchResult] = await Promise.all([
            execFetch(session.ctl, 'portrait', sharedTab.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ probe: target.path }),
              redirect: target.redirect,
            }),
            execFetch(session.ctl, 'landscape', sharedTab.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ probe: target.path }),
              redirect: target.redirect,
            }),
          ]);
          assert.equal(pRes.dedupHeader, null);
          assert.equal(lRes.dedupHeader, null);
          const pathname = target.path.split('?')[0] ?? target.path;
          assert.equal(
            ctx.servers.getHttpLogs().filter((e) => e.path === pathname).length,
            2,
            `${target.path} must hit upstream twice`,
          );
        }
        assert.equal((await session.ctl.tabs()).tabs[0]?.dedupCount ?? 0, 0);

        // 2. Isolated session tab gates off R2 & R3
        const isoOpened = await session.ctl.open(`${base}/page/ws-sse`, {
          mode: 'dual',
          session: 'isolated',
        });
        assert.ok(isoOpened.tab, 'expected isolated tab');
        const isoId = isoOpened.tab.id;
        await session.ctl.waitForTabReady(isoId, { expectedUrlIncludes: '/page/ws-sse' });

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          isoId,
        );
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          isoId,
        );
        await pollUntil(
          async () =>
            ctx.servers.getWsStats().activeConnections === 2 ? true : null,
          5_000,
          100,
          'isolated tab opens 2 independent WS connections',
        );

        ctx.servers.resetHttpLogs();
        await Promise.all([
          execFetch(session.ctl, 'portrait', isoId, `${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso-s08', idempotencyKey: 'iso-1' }),
          }),
          execFetch(session.ctl, 'landscape', isoId, `${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso-s08', idempotencyKey: 'iso-2' }),
          }),
        ]);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          2,
        );

        // 3. Password fixture secret non-leakage & cross-origin iframe
        // Note (TEST_INFRA.md §4.3): ctl.interact calls EchoLoopGuard.markReplaying(), so MirrorRelay's
        // onMirrorMiss redaction path is verified directly in test/mirror-relay.test.ts / test/shell-ui.test.ts;
        // here we verify password/token form values and query tokens do not leak via console or mirrorMiss telemetry.
        await session.ctl.navigate(`${base}/page/password?token=secret-url-tok`, isoId);
        await session.ctl.waitForTabReady(isoId, { expectedUrlIncludes: '/page/password' });

        const pwPresent = await session.ctl.evalJs(
          "document.getElementById('secret-pass')?.getAttribute('type') === 'password' && document.getElementById('secret-pass')?.value === 's3cr3t-pw' && document.getElementById('secret-token')?.value === 'tok-abc'",
          'portrait',
          isoId,
        );
        assert.equal(pwPresent.value, 'true');

        await session.ctl.interact({
          action: 'click',
          tabId: isoId,
          viewport: 'portrait',
          selector: '#unmirrored-miss-target',
          mirror: false,
        });

        const conEntries = await session.ctl.console(isoId, 100);
        const netEntries = await session.ctl.network(isoId, 100);
        const metricsAfterPw = await session.ctl.metrics();
        const conAndMissJson = JSON.stringify({
          con: conEntries,
          miss: metricsAfterPw.mirrorMiss ?? null,
        });
        const netJson = JSON.stringify(netEntries);
        assert.equal(conAndMissJson.includes('s3cr3t-pw'), false);
        assert.equal(conAndMissJson.includes('tok-abc'), false);
        assert.equal(conAndMissJson.includes('secret-url-tok'), false);
        assert.equal(netJson.includes('s3cr3t-pw'), false);
        assert.equal(netJson.includes('tok-abc'), false);

        await session.ctl.navigate(`${base}/page/iframe-cross`, isoId);
        await session.ctl.waitForTabReady(isoId, { expectedUrlIncludes: '/page/iframe-cross' });
        const crossBlocked = await session.ctl.evalJs(
          "(() => { try { return document.getElementById('cross-frame')?.contentDocument ? 'open' : 'blocked'; } catch { return 'blocked'; } })()",
          'portrait',
          isoId,
        );
        assert.equal(crossBlocked.value, 'blocked');

        // 4. Shared tab recovery: open an active shared dual tab on /cacheable?format=html,
        // verify reload increments seq on both viewports, and verify fresh POST /mutate dedup.
        const recoveryOpened = await session.ctl.open(`${base}/cacheable?format=html`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(recoveryOpened.tab, 'expected fresh shared recovery tab');
        const recoveryId = recoveryOpened.tab.id;
        assert.equal(recoveryOpened.tab.session, 'shared');
        assert.equal(recoveryOpened.tab.mirror, true);
        assert.equal(recoveryOpened.tab.dedup, true);
        const tabsBeforeReload = await session.ctl.tabs();
        assert.equal(
          tabsBeforeReload.activeTabId,
          recoveryId,
          'recovery shared tab must be activeTabId before reload check',
        );
        await session.ctl.waitForTabReady(recoveryId, {
          expectedUrlIncludes: '/cacheable',
        });

        const [recP1Eval, recL1Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            recoveryId,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            recoveryId,
          ),
        ]);
        const recP1 = Number(recP1Eval.value);
        const recL1 = Number(recL1Eval.value);
        assert.ok(Number.isInteger(recP1) && recP1 >= 1);
        assert.ok(Number.isInteger(recL1) && recL1 >= 1);

        const preReloadHits = ctx.servers.getHttpLogs('/cacheable').length;
        await Promise.all([
          session.ctl.evalJs('window.location.reload()', 'portrait', recoveryId),
          session.ctl.evalJs('window.location.reload()', 'landscape', recoveryId),
        ]);
        await pollUntil(
          async () => {
            if (ctx.servers.getHttpLogs('/cacheable').length < preReloadHits + 2) {
              return null;
            }
            const state = await session.ctl.tabs();
            const tab = state.tabs.find((t) => t.id === recoveryId);
            return tab && !tab.loading ? true : null;
          },
          10_000,
          100,
          `recovery shared tab reload >= ${preReloadHits + 2} hits and !loading`,
        );
        await new Promise((r) => setTimeout(r, 200));
        await session.ctl.waitForTabReady(recoveryId, {
          expectedUrlIncludes: '/cacheable',
          waitForDomComplete: true,
          timeoutMs: 10_000,
        });

        const [recP2Eval, recL2Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            recoveryId,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            recoveryId,
          ),
        ]);
        const recP2 = Number(recP2Eval.value);
        const recL2 = Number(recL2Eval.value);
        assert.ok(
          Number.isInteger(recP2) && Number.isInteger(recL2) && recP2 > recP1 && recL2 > recL1,
          `recovery shared tab /cacheable seq > (${recP1}, ${recL1}), got (${recP2}, ${recL2})`,
        );

        ctx.servers.resetHttpLogs();
        const [finalP, finalL] = await Promise.all([
          execFetch(session.ctl, 'portrait', recoveryId, `${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'final-s08', idempotencyKey: 'fin-1' }),
          }),
          execFetch(session.ctl, 'landscape', recoveryId, `${base}/mutate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'final-s08', idempotencyKey: 'fin-2' }),
          }),
        ]);
        assert.equal(finalP.status, 200);
        assert.equal(finalL.status, 200);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          1,
        );
        assert.equal(
          [finalP.dedupHeader, finalL.dedupHeader].filter((h) => h === 'replayed').length,
          1,
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T4-S09',
    tier: 4,
    features: ['F12'],
    title: 'Background browser_open, tab-scoped browser_metrics, and bulk session browser_close_tab',
    description:
      'Opens dual and single isolated background tabs without stealing owner activeTabId, exercises eval/metrics/console/network/screenshot on background tabs, and bulk-closes isolated tabs while keeping owner shared tab intact.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const base = ctx.servers.httpBaseUrl;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(`${base}/echo?owner=1`)]),
      });
      try {
        const initialTabs = await session.ctl.tabs();
        const ownerId = initialTabs.activeTabId!;
        assert.ok(ownerId, 'expected active owner tab');
        await session.ctl.waitForTabReady(ownerId, { expectedUrlIncludes: '/echo?owner=1' });

        // 1. Open dual & single isolated background tabs without stealing focus
        const bgDual = await session.ctl.request<{
          activeTabId: string;
          tab: { id: string; mode: string; session: string } | null;
          viewportReport: Record<string, { effectiveCssSize: { width: number; height: number } | null }>;
        }>('browser_open', {
          url: `${base}/page/interactions?bg=dual`,
          mode: 'dual',
          session: 'isolated',
          background: true,
        });
        assert.equal(bgDual.activeTabId, ownerId, 'dual background open must not steal activeTabId');
        assert.ok(bgDual.tab && bgDual.tab.id !== ownerId);
        assert.equal(bgDual.tab.mode, 'dual');
        assert.equal(bgDual.tab.session, 'isolated');

        const bgSingle = await session.ctl.request<{
          activeTabId: string;
          tab: { id: string; mode: string; session: string } | null;
          viewportReport: Record<string, { effectiveCssSize: { width: number; height: number } | null }>;
        }>('browser_open', {
          url: `${base}/page/interactions?bg=single`,
          mode: 'single',
          session: 'isolated',
          background: true,
        });
        assert.equal(bgSingle.activeTabId, ownerId, 'single background open must not steal activeTabId');
        assert.ok(bgSingle.tab && bgSingle.tab.id !== ownerId);
        assert.equal(bgSingle.tab.mode, 'single');
        assert.equal(bgSingle.tab.session, 'isolated');

        const bgDualId = bgDual.tab.id;
        const bgSingleId = bgSingle.tab.id;
        await Promise.all([
          session.ctl.waitForTabReady(bgDualId, { expectedUrlIncludes: 'bg=dual' }),
          session.ctl.waitForTabReady(bgSingleId, { expectedUrlIncludes: 'bg=single' }),
        ]);

        // 2. Hidden single-mode tab keeps non-zero CSS viewport & captures screenshot cleanly
        const singleDimsEval = await session.ctl.evalJs(
          'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
          'landscape',
          bgSingleId,
        );
        const singleDims = JSON.parse(singleDimsEval.value) as { w: number; h: number };
        assert.ok(singleDims.w > 200 && singleDims.h > 200, `expected non-zero hidden single viewport, got ${singleDimsEval.value}`);

        const singleShot = await session.ctl.screenshot(bgSingleId, 'landscape');
        assert.ok((singleShot.captures.landscape?.bytes ?? 0) > 100, 'expected non-empty screenshot from background single tab');

        // 3. Background dual tab supports eval, console, network, screenshot, and tab-scoped metrics
        await session.ctl.evalJs(
          `console.error('bg-dual-sentinel'); fetch(${JSON.stringify(`${base}/echo?from=bg-dual`)}); 'ok'`,
          'portrait',
          bgDualId,
        );
        await pollUntil(
          async () => {
            const c = await session.ctl.console({ tabId: bgDualId, level: 'error', limit: 20 });
            const n = await session.ctl.network({ tabId: bgDualId, limit: 20 });
            return c.entries.some((e) => e.text.includes('bg-dual-sentinel')) &&
              n.entries.some((e) => e.url.includes('from=bg-dual'))
              ? true
              : null;
          },
          5_000,
          100,
          'background dual console & network entries',
        );

        const dualMetrics = await session.ctl.request<{
          tabId?: string;
          portrait: { domNodes: number } | null;
          landscape: { domNodes: number } | null;
          consoleErrorCount: number;
        }>('browser_metrics', { tab_id: bgDualId });
        assert.equal(dualMetrics.tabId, bgDualId);
        assert.ok(dualMetrics.portrait !== null && dualMetrics.landscape !== null);
        assert.ok(dualMetrics.landscape.domNodes > 0);
        assert.ok(dualMetrics.consoleErrorCount >= 1);

        const singleMetrics = await session.ctl.request<{
          tabId?: string;
          portrait: unknown;
          landscape: { domNodes: number } | null;
        }>('browser_metrics', { tab_id: bgSingleId });
        assert.equal(singleMetrics.tabId, bgSingleId);
        assert.equal(singleMetrics.portrait, null);
        assert.ok(singleMetrics.landscape !== null);

        // Active owner tab remains focused and unaffected
        assert.equal((await session.ctl.tabs()).activeTabId, ownerId);

        // 4. Reject session without all: true and reject unknown properties without closing active tab
        await assert.rejects(
          () => session.ctl.request('browser_close_tab', { session: 'isolated' }),
          (err: unknown) => err instanceof Error && err.message.includes('requires all=true'),
        );
        await assert.rejects(
          () => session.ctl.request('browser_close_tab', { foo: 1 }),
          (err: unknown) => err instanceof Error && err.message.includes("unknown property 'foo'"),
        );
        await assert.rejects(
          () => session.ctl.request('browser_close_tab', { tabId: bgDualId }),
          (err: unknown) => err instanceof Error && err.message.includes("unknown property 'tabId'"),
        );
        const tabsAfterReject = await session.ctl.tabs();
        assert.equal(tabsAfterReject.activeTabId, ownerId, 'unknown-key close rejection must preserve activeTabId');
        assert.equal(tabsAfterReject.tabs.length, 3, 'unknown-key close rejection must leave all 3 tabs intact');

        // 5. Bulk close all isolated tabs, leaving shared owner tab & activeTabId intact
        const bulkClose = await session.ctl.request<{
          ok: boolean;
          closedTabId: string | null;
          closedTabIds: string[];
          closedCount: number;
          activeTabId: string;
          tabs: Array<{ id: string; session: string }>;
        }>('browser_close_tab', { session: 'isolated', all: true });
        assert.equal(bulkClose.ok, true);
        assert.equal(bulkClose.closedTabId, null);
        assert.equal(bulkClose.closedCount, 2);
        assert.deepEqual(bulkClose.closedTabIds, [bgDualId, bgSingleId]);
        assert.equal(bulkClose.activeTabId, ownerId);
        assert.equal(bulkClose.tabs.length, 1);
        assert.equal(bulkClose.tabs[0]?.id, ownerId);

        // 6. Second bulk close of isolated tabs is an idempotent no-op
        const noopClose = await session.ctl.request<{
          ok: boolean;
          closedTabId: string | null;
          closedTabIds: string[];
          closedCount: number;
          activeTabId: string;
          tabs: Array<{ id: string }>;
        }>('browser_close_tab', { session: 'isolated', all: true });
        assert.equal(noopClose.ok, true);
        assert.equal(noopClose.closedTabId, null);
        assert.deepEqual(noopClose.closedTabIds, []);
        assert.equal(noopClose.closedCount, 0);
        assert.equal(noopClose.activeTabId, ownerId);
        assert.equal(noopClose.tabs.length, 1);
      } finally {
        await session.close();
      }
    },
  },
];

export default tests;
