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

function visibleLaunchArgs(): string[] {
  return !process.env.WAYLAND_DISPLAY && process.env.DISPLAY ? ['--ozone-platform=x11'] : [];
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
    title: 'Fixture',
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
    id: 'T3-P01',
    tier: 3,
    features: ['F1', 'F6', 'F7'],
    title: 'Dual + Shared + Mirror + Dedup + EcoMode + POST /mutate',
    description:
      'Verifies Eco DPR cap on iphone-15 portrait alongside concurrent mirrored POST /mutate deduplication with correlation key preservation.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], { ecoMode: true }),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected restored tab');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        const dprEval = await session.ctl.evalJs(
          'String(window.devicePixelRatio)',
          'portrait',
          tab0.id,
        );
        const dpr = Number(dprEval.value);
        assert.ok(
          Number.isFinite(dpr) && dpr >= 1 && dpr < 3,
          `expected Eco DPR in [1, 3), got ${dprEval.value}`,
        );

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [portRes, landRes] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'bet',
              amount: 25,
              idempotencyKey: 'p01-port-1',
              ts: 1700000000100,
            }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'bet',
              amount: 25,
              idempotencyKey: 'p01-land-2',
              ts: 1700000000200,
            }),
          }),
        ]);

        assert.equal(portRes.status, 200);
        assert.equal(landRes.status, 200);
        const mutateLogs = ctx.servers
          .getHttpLogs()
          .filter((entry) => entry.path === '/mutate');
        assert.equal(
          mutateLogs.length,
          1,
          `expected 1 /mutate upstream hit, got ${mutateLogs.length}`,
        );

        const replayedCount = [portRes.dedupHeader, landRes.dedupHeader].filter(
          (h) => h === 'replayed',
        ).length;
        assert.equal(
          replayedCount,
          1,
          `expected exactly 1 replayed header, got ${JSON.stringify([portRes.dedupHeader, landRes.dedupHeader])}`,
        );

        const portCorr = portRes.json?.correlation as Record<string, unknown> | undefined;
        const landCorr = landRes.json?.correlation as Record<string, unknown> | undefined;
        assert.equal(portCorr?.idempotencyKey, 'p01-port-1');
        assert.equal(landCorr?.idempotencyKey, 'p01-land-2');

        const afterTabs = await session.ctl.tabs();
        const afterTab0 = afterTabs.tabs[0];
        assert.ok(afterTab0, 'expected tab snapshot after dedup');
        assert.ok(
          (afterTab0.dedupCount ?? 0) >= 1,
          `expected dedupCount >= 1, got ${String(afterTab0.dedupCount)}`,
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P02',
    tier: 3,
    features: ['F1', 'F4', 'F10', 'F11'],
    title: 'Dual + Shared + EcoMode=false + Lazy Restore across 2 Launches',
    description:
      'Verifies HiDPI DPR=3 persists across SIGTERM + relaunch while inactive restored tabs stay dormant until materialized.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const tab0Url = `${ctx.servers.httpBaseUrl}/echo?tab=0`;
      const tab1Url = `${ctx.servers.httpBaseUrl}/echo?tab=1`;

      const session1 = await ctx.launchElectron({
        smoke: true,
        keepTempDir: true,
        seedSession: makeSeedSession(
          [
            makeTabFixture(tab0Url, { title: 'Tab 0' }),
            makeTabFixture(tab1Url, { title: 'Tab 1' }),
          ],
          { ecoMode: false, activeTabIndex: 0 },
        ),
      });

      const sharedDir = session1.sessionDir;
      try {
        try {
          const tabs1 = await session1.ctl.tabs();
          const t0 = tabs1.tabs[0];
          assert.ok(t0, 'expected tab 0 in launch 1');
          await session1.ctl.waitForTabReady(t0.id, {
            expectedUrlIncludes: '/echo?tab=0',
          });

          const dpr1 = await session1.ctl.evalJs(
            'String(window.devicePixelRatio)',
            'portrait',
            t0.id,
          );
          assert.equal(Number(dpr1.value), 3, 'expected HiDPI DPR === 3 when ecoMode=false');

          session1.sendSignal('SIGTERM');
          await session1.waitForExit(8_000);
        } finally {
          await session1.close();
        }

        const persisted = fs.existsSync(session1.stateFilePath)
          ? (JSON.parse(
              fs.readFileSync(session1.stateFilePath, 'utf8'),
            ) as PersistedSessionFixture)
          : null;
        assert.ok(persisted, 'expected persisted session-state.json after SIGTERM');
        assert.equal(persisted.ecoMode, false);
        assert.equal(persisted.tabs.length, 2);

        ctx.servers.resetHttpLogs();
        const session2 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedDir,
          keepTempDir: true,
        });
        try {
          const tabs2 = await session2.ctl.tabs();
          assert.equal(tabs2.tabs.length, 2);
          const r0 = tabs2.tabs[0];
          const r1 = tabs2.tabs[1];
          assert.ok(r0 && r1, 'expected 2 restored tabs');
          await session2.ctl.waitForTabReady(r0.id, {
            expectedUrlIncludes: '/echo?tab=0',
          });

          const preTab1Hits = ctx.servers
            .getHttpLogs('/echo')
            .filter((entry) => entry.query.tab === '1');
          assert.equal(
            preTab1Hits.length,
            0,
            'inactive restored tab 1 must not make HTTP requests before materialization',
          );

          const readyState = await session2.ctl.evalJs(
            'document.readyState',
            'landscape',
            r1.id,
          );
          assert.equal(readyState.value, 'complete');

          const postTab1Hits = await pollUntil(
            async () => {
              const hits = ctx.servers
                .getHttpLogs('/echo')
                .filter((entry) => entry.query.tab === '1');
              return hits.length >= 1 ? hits : null;
            },
            5_000,
            100,
            'tab 1 HTTP hit after materialization',
          );
          assert.ok(postTab1Hits.length >= 1);

          const dpr2 = await session2.ctl.evalJs(
            'String(window.devicePixelRatio)',
            'portrait',
            r1.id,
          );
          assert.equal(Number(dpr2.value), 3, 'expected ecoMode=false preserved on launch 2');
        } finally {
          await session2.close();
        }
      } finally {
        cleanupDirSafe(sharedDir);
      }
    },
  },

  {
    id: 'T3-P03',
    tier: 3,
    features: ['F3', 'F6'],
    title: 'Dual + Shared + DockOpen=false + Shared wc.debugger (Console/Network + Dedup)',
    description:
      'Verifies DevTools remains lazily closed (dockOpen=false) while TelemetryService console/network buffers and Fetch dedup share wc.debugger cleanly.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], { dockOpen: false }),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.evalJs("console.error('e2e-p03-console-err')", 'portrait', tab0.id);

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const status500Url = `${ctx.servers.httpBaseUrl}/status/500`;
        const [mPort, mLand, errRes] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bet', idempotencyKey: 'p03-1' }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'bet', idempotencyKey: 'p03-2' }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, status500Url, { method: 'POST' }),
        ]);

        assert.equal(mPort.status, 200);
        assert.equal(mLand.status, 200);
        assert.equal(errRes.status, 500);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          1,
        );

        const consoleMatches = await pollUntil(
          async () => {
            const res = await session.ctl.console(tab0.id, 100);
            const found = res.entries.filter((e) => e.text.includes('e2e-p03-console-err'));
            return found.length >= 1 ? found : null;
          },
          5_000,
          100,
          'console ring buffer entry',
        );
        assert.ok(consoleMatches.length >= 1);

        const netMatches = await pollUntil(
          async () => {
            const res = await session.ctl.network({ tabId: tab0.id, limit: 100 });
            const hasMutate = res.entries.some((e) => e.url.includes('/mutate'));
            const has500 = res.entries.some((e) => e.url.includes('/status/500'));
            return hasMutate && has500 ? res.entries : null;
          },
          5_000,
          100,
          'network ring buffer entries',
        );
        assert.ok(netMatches.length >= 2);

        const stateOnDisk = session.readStateFile<PersistedSessionFixture>();
        assert.equal(stateOnDisk?.dockOpen, false);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P04',
    tier: 3,
    features: ['F6', 'F7', 'F10'],
    title: 'Dual + Isolated + Mirror + Dedup + POST /mutate Auto-Disabled & No Disk Dirty',
    description:
      'Verifies R2 automatically disables in isolated sessions and HTTP activity does not dirty session-state.json.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([
          makeTabFixture(targetUrl, { session: 'isolated', mirror: true, dedup: true }),
        ]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected isolated tab');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await sleep(700);
        const baselineSavedAt =
          session.readStateFile<PersistedSessionFixture>()?.savedAt ?? null;

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [pRes, lRes] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso', idempotencyKey: 'p04-1' }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso', idempotencyKey: 'p04-2' }),
          }),
        ]);

        assert.equal(pRes.status, 200);
        assert.equal(lRes.status, 200);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);

        const logs = ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate');
        assert.equal(logs.length, 2, 'isolated session must bypass R2 dedup');

        const afterTabs = await session.ctl.tabs();
        assert.equal(afterTabs.tabs[0]?.dedupCount ?? 0, 0);

        await sleep(700);
        const afterSavedAt =
          session.readStateFile<PersistedSessionFixture>()?.savedAt ?? null;
        assert.equal(
          afterSavedAt,
          baselineSavedAt,
          'requests must not trigger session-state.json writes',
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P05',
    tier: 3,
    features: ['F6', 'F7'],
    title: 'Dual + Shared + Mirror=false + Dedup=true + PUT /mutate Gated Off',
    description:
      'Verifies mirror=false gates off R2 deduplication so concurrent PUT /mutate hits upstream twice.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([
          makeTabFixture(targetUrl, { mirror: false, dedup: true, session: 'shared' }),
        ]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        assert.equal(tab0.mirror, false);
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [pRes, lRes] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'put-test', idempotencyKey: 'p05-1' }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'put-test', idempotencyKey: 'p05-2' }),
          }),
        ]);

        assert.equal(pRes.status, 200);
        assert.equal(lRes.status, 200);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);

        const logs = ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate');
        assert.equal(logs.length, 2, 'mirror=false must disable R2 dedup');
        assert.ok(logs.every((e) => e.method === 'PUT'));
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P06',
    tier: 3,
    features: ['F6', 'F7'],
    title: 'Dual + Shared + Mirror=true + Dedup=false + PATCH /mutate Gated Off',
    description:
      'Verifies dedup=false gates off R2 deduplication so concurrent PATCH /mutate hits upstream twice.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([
          makeTabFixture(targetUrl, { mirror: true, dedup: false, session: 'shared' }),
        ]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        assert.equal(tab0.dedup, false);
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [pRes, lRes] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'patch-test', idempotencyKey: 'p06-1' }),
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'patch-test', idempotencyKey: 'p06-2' }),
          }),
        ]);

        assert.equal(pRes.status, 200);
        assert.equal(lRes.status, 200);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);

        const logs = ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate');
        assert.equal(logs.length, 2, 'dedup=false must disable R2 dedup');
        assert.ok(logs.every((e) => e.method === 'PATCH'));
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P07',
    tier: 3,
    features: ['F6', 'F9'],
    title: 'Single + Shared + DELETE /mutate + Landscape Click & Screenshot',
    description:
      'Verifies single-mode tabs only render landscape, execute clicks cleanly, and keep R2 gated off on DELETE /mutate.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
        const opened = await session.ctl.open(targetUrl, {
          mode: 'single',
          session: 'shared',
        });
        assert.ok(opened.tab, 'expected opened single-mode tab');
        const tabId = opened.tab.id;
        assert.equal(opened.tab.mode, 'single');

        await session.ctl.waitForTabReady(tabId, {
          expectedUrlIncludes: '/page/interactions',
        });

        const shot = await session.ctl.screenshot(tabId, 'both');
        assert.equal(shot.mode, 'single');
        assert.equal(shot.captures.portrait, undefined);
        assert.ok(
          shot.captures.landscape && shot.captures.landscape.pngBase64.length > 0,
          'expected non-empty landscape screenshot in single mode',
        );

        await session.ctl.interact({
          action: 'click',
          tabId,
          viewport: 'landscape',
          selector: '#btn-inc',
          mirror: true,
        });
        const incCount = await session.ctl.evalJs(
          "document.getElementById('inc-count')?.textContent ?? ''",
          'landscape',
          tabId,
        );
        assert.equal(incCount.value, '1');

        ctx.servers.resetHttpLogs();
        const delRes = await execFetch(
          session.ctl,
          'landscape',
          tabId,
          `${ctx.servers.httpBaseUrl}/mutate`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete-item', idempotencyKey: 'p07-del' }),
          },
        );
        assert.equal(delRes.status, 200);
        assert.equal(delRes.dedupHeader, null);
        const logs = ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate');
        assert.equal(logs.length, 1);
        assert.equal(logs[0]?.method, 'DELETE');
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P08',
    tier: 3,
    features: ['F6', 'F8'],
    title: 'Dual + Shared + Compressed Mutations (gzip/br/deflate) + Active WS',
    description:
      'Verifies gzip/br/deflate response decompression + correlation remapping under active muxed WebSocket without breaking WS delivery.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      ctx.servers.resetWsStats();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab0.id,
        );

        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'portrait',
              tab0.id,
            );
            const l = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              tab0.id,
            );
            return p.value === 'open:chat.v1' && l.value === 'open:chat.v1' ? true : null;
          },
          5_000,
          100,
          'both WS viewports open',
        );
        assert.equal(ctx.servers.getWsStats().activeConnections, 1);

        for (const ep of ['/mutate-gzip', '/mutate-br', '/mutate-deflate'] as const) {
          ctx.servers.resetHttpLogs();
          const url = `${ctx.servers.httpBaseUrl}${ep}`;
          const [pRes, lRes]: [FetchResult, FetchResult] = await Promise.all([
            execFetch(session.ctl, 'portrait', tab0.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'enc-test',
                correlationId: `${ep}-port-c`,
                traceId: `${ep}-port-t`,
                clientRequestId: `${ep}-port-r`,
              }),
            }),
            execFetch(session.ctl, 'landscape', tab0.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'enc-test',
                correlationId: `${ep}-land-c`,
                traceId: `${ep}-land-t`,
                clientRequestId: `${ep}-land-r`,
              }),
            }),
          ]);

          assert.equal(pRes.status, 200, `${ep} portrait status`);
          assert.equal(lRes.status, 200, `${ep} landscape status`);
          assert.equal(pRes.json?.ok, true, `${ep} portrait JSON ok`);
          assert.equal(lRes.json?.ok, true, `${ep} landscape JSON ok`);

          const epLogs = ctx.servers.getHttpLogs().filter((e) => e.path === ep);
          assert.equal(epLogs.length, 1, `expected 1 hit for ${ep}`);

          const replayed = [pRes.dedupHeader, lRes.dedupHeader].filter(
            (h) => h === 'replayed',
          ).length;
          assert.equal(replayed, 1, `expected 1 replayed header for ${ep}`);

          const pCorr = pRes.json?.correlation as Record<string, unknown> | undefined;
          const lCorr = lRes.json?.correlation as Record<string, unknown> | undefined;
          assert.equal(pCorr?.correlationId, `${ep}-port-c`);
          assert.equal(lCorr?.correlationId, `${ep}-land-c`);
          assert.equal(pCorr?.traceId, `${ep}-port-t`);
          assert.equal(lCorr?.traceId, `${ep}-land-t`);
          assert.equal(pCorr?.clientRequestId, `${ep}-port-r`);
          assert.equal(lCorr?.clientRequestId, `${ep}-land-r`);
        }

        assert.equal(ctx.servers.getWsStats().activeConnections, 1);
        ctx.servers.broadcastWs('post-dedup-ws');
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              'JSON.stringify(window.__wsLog)',
              'portrait',
              tab0.id,
            );
            const l = await session.ctl.evalJs(
              'JSON.stringify(window.__wsLog)',
              'landscape',
              tab0.id,
            );
            return p.value.includes('post-dedup-ws') && l.value.includes('post-dedup-ws')
              ? true
              : null;
          },
          5_000,
          100,
          'post-dedup WS broadcast on both viewports',
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P09',
    tier: 3,
    features: ['F8', 'F11'],
    title: 'Dual + Shared + WS/SSE Mux + Outbound Dedup + 1012 Failover',
    description:
      'Verifies 1 WS + 1 SSE upstream, outbound WS dedup within 1500ms, named SSE event fan-out, and 1012 owner teardown failover.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetWsStats();
      ctx.servers.resetSseStats();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'portrait',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
          'landscape',
          tab0.id,
        );

        await pollUntil(
          async () => {
            const pWs = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'portrait',
              tab0.id,
            );
            const lWs = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              tab0.id,
            );
            const pSse = await session.ctl.evalJs(
              "document.getElementById('sse-status')?.textContent ?? ''",
              'portrait',
              tab0.id,
            );
            const lSse = await session.ctl.evalJs(
              "document.getElementById('sse-status')?.textContent ?? ''",
              'landscape',
              tab0.id,
            );
            return pWs.value === 'open:chat.v1' &&
              lWs.value === 'open:chat.v1' &&
              pSse.value === 'open' &&
              lSse.value === 'open'
              ? true
              : null;
          },
          5_000,
          100,
          'WS and SSE open on both viewports',
        );

        assert.equal(ctx.servers.getWsStats().activeConnections, 1);
        assert.equal(ctx.servers.getSseStats().activeConnections, 1);

        await Promise.all([
          session.ctl.evalJs(
            `window.__wsSend(${JSON.stringify(JSON.stringify({ type: 'bet', requestId: 'r-1', ts: 100 }))})`,
            'portrait',
            tab0.id,
          ),
          session.ctl.evalJs(
            `window.__wsSend(${JSON.stringify(JSON.stringify({ type: 'bet', requestId: 'r-2', ts: 101 }))})`,
            'landscape',
            tab0.id,
          ),
        ]);
        await sleep(300);
        assert.equal(
          ctx.servers.getWsStats().receivedMessages.length,
          1,
          'expected outbound WS dedup within 1500ms',
        );

        ctx.servers.pushSseEvent('ping-evt', '{"seq":1}', 'e-1');
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              'JSON.stringify(window.__sseLog)',
              'portrait',
              tab0.id,
            );
            const l = await session.ctl.evalJs(
              'JSON.stringify(window.__sseLog)',
              'landscape',
              tab0.id,
            );
            return p.value.includes('"lastEventId":"e-1"') &&
              l.value.includes('"lastEventId":"e-1"')
              ? true
              : null;
          },
          5_000,
          100,
          'SSE named event e-1 on both viewports',
        );

        assert.equal(ctx.servers.closeFirstWsOwner(1012, 'owner-down'), true);
        await pollUntil(
          async () => {
            const p = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'portrait',
              tab0.id,
            );
            const l = await session.ctl.evalJs(
              "document.getElementById('ws-status')?.textContent ?? ''",
              'landscape',
              tab0.id,
            );
            return p.value === 'closed:1012' && l.value === 'closed:1012' ? true : null;
          },
          5_000,
          100,
          'closed:1012 on both viewports after owner teardown',
        );
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P10',
    tier: 3,
    features: ['F8', 'F9'],
    title: 'Dual + Isolated + WS/SSE Mux Bypass + Cross-Origin Iframe Isolation',
    description:
      'Verifies isolated mode opens independent WS/SSE upstream connections per viewport and cross-origin iframes remain isolated.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetWsStats();
      ctx.servers.resetSseStats();
      const wsUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([
          makeTabFixture(wsUrl, { session: 'isolated', mirror: true, dedup: true }),
        ]),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected isolated tab');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt'])`,
          'portrait',
          tab0.id,
        );
        await session.ctl.evalJs(
          `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt'])`,
          'landscape',
          tab0.id,
        );

        await pollUntil(
          async () => {
            const ws = ctx.servers.getWsStats();
            const sse = ctx.servers.getSseStats();
            return ws.activeConnections === 2 && sse.activeConnections === 2 ? true : null;
          },
          5_000,
          100,
          '2 WS and 2 SSE upstream connections in isolated session',
        );

        await session.ctl.navigate(`${ctx.servers.httpBaseUrl}/page/iframe-cross`, tab0.id);
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/iframe-cross',
        });

        for (const role of ['portrait', 'landscape'] as const) {
          const check = await session.ctl.evalJs(
            `(() => {
              const f = document.getElementById('cross-frame');
              try {
                const doc = f && f.contentDocument;
                return JSON.stringify({ accessible: Boolean(doc), src: f ? f.getAttribute('src') : null });
              } catch (err) {
                return JSON.stringify({ accessible: false, error: String(err), src: f ? f.getAttribute('src') : null });
              }
            })()`,
            role,
            tab0.id,
          );
          const parsed = JSON.parse(check.value) as { accessible: boolean; src: string | null };
          assert.equal(parsed.accessible, false, `${role} cross-frame contentDocument must be blocked`);
          assert.ok(
            parsed.src?.startsWith(ctx.servers.altOriginBaseUrl),
            `${role} iframe src should point to altOriginBaseUrl`,
          );
        }
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P11',
    tier: 3,
    features: ['F2', 'F3', 'F5'],
    title: 'Dual + Shared + DockOpen=false + Burst FPS & CDP Performance.getMetrics',
    description:
      'Verifies burst FPS sampling and CDP Performance.getMetrics polling work accurately while DevTools stays closed.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
        seedSession: makeSeedSession([makeTabFixture(targetUrl)], {
          dockOpen: false,
          ecoMode: true,
        }),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        const driveRaf = `new Promise((resolve) => {
          let i = 0;
          const step = () => {
            i += 1;
            if (i >= 15) return resolve('done');
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })`;
        await Promise.all([
          session.ctl.evalJs(driveRaf, 'portrait', tab0.id),
          session.ctl.evalJs(driveRaf, 'landscape', tab0.id),
          session.ctl.evalJs("console.error('p11-metrics-check')", 'portrait', tab0.id),
          execFetch(session.ctl, 'landscape', tab0.id, `${ctx.servers.httpBaseUrl}/status/500`, {
            method: 'POST',
          }),
        ]);

        const m1 = await session.ctl.metrics();
        await sleep(2_200);
        const m2 = await session.ctl.metrics();

        assert.equal(m2.paused, false);
        assert.ok(m2.timestampMs > m1.timestampMs, 'metrics timestamp should advance');
        assert.ok(m2.portrait !== null && m2.landscape !== null, 'both viewport metrics present');
        assert.ok(m2.landscape.domNodes > 0, 'domNodes > 0');
        assert.ok(m2.portrait.jsHeapUsedMb > 0, 'jsHeapUsedMb > 0');
        assert.ok(Number.isFinite(m2.totalMemoryMb) && m2.totalMemoryMb > 0);
        assert.ok(Number.isFinite(m2.portrait.fps) && m2.portrait.fps >= 0);
        assert.ok(Number.isFinite(m2.portrait.p95FrameMs) && m2.portrait.p95FrameMs >= 0);

        const consoleRes = await session.ctl.console(tab0.id, 50);
        assert.ok(consoleRes.entries.some((e) => e.text.includes('p11-metrics-check')));
        const networkRes = await session.ctl.network(tab0.id, 50);
        assert.ok(networkRes.entries.some((e) => e.url.includes('/status/500')));
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, false);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P12',
    tier: 3,
    features: ['F3', 'F6', 'F7', 'F12'],
    title: 'Dual + Shared + Cacheable Reload + R2 POST /mutate + Network Buffer',
    description:
      'Verifies page reload on /cacheable increments seq on both viewports and allows fresh POST /mutate without stale slot collision while DevTools stays closed (TabManager.reloadIgnoringCache & F5/Ctrl+R shortcuts covered in unit tests per TEST_INFRA.md §4.3).',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const cacheUrl = `${ctx.servers.httpBaseUrl}/cacheable?format=html`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(cacheUrl)], { dockOpen: false }),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const tab0 = tabsState.tabs[0];
        assert.ok(tab0, 'expected tab 0');
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/cacheable',
        });

        const [seqP1Eval, seqL1Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            tab0.id,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            tab0.id,
          ),
        ]);
        const seqP1 = Number(seqP1Eval.value);
        const seqL1 = Number(seqL1Eval.value);
        assert.ok(Number.isInteger(seqP1) && seqP1 >= 1, `expected seqP1 >= 1, got ${seqP1Eval.value}`);
        assert.ok(Number.isInteger(seqL1) && seqL1 >= 1, `expected seqL1 >= 1, got ${seqL1Eval.value}`);

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const bodyJson = JSON.stringify({ action: 'reload-check', amount: 10 });
        const [preP, preL] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyJson,
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyJson,
          }),
        ]);
        assert.equal(preP.status, 200);
        assert.equal(preL.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length, 1);

        // ControlSocketServer has no browser_reload RPC and CDP Input.dispatchKeyEvent does not invoke
        // Electron's before-input-event -> handleGlobalShortcut (TEST_INFRA.md §4.3); TabManager.reload()
        // (reloadIgnoringCache) and Ctrl+R/F5/Ctrl+Shift+R shortcuts are verified in test/r1-optimizations.test.ts.
        // Empirically verified in live Electron: window.location.reload() hits /cacheable (seq2 > seq1).
        const preReloadHits = ctx.servers.getHttpLogs('/cacheable').length;
        await Promise.all([
          session.ctl.evalJs('window.location.reload()', 'portrait', tab0.id),
          session.ctl.evalJs('window.location.reload()', 'landscape', tab0.id),
        ]);

        await pollUntil(
          async () => {
            if (ctx.servers.getHttpLogs('/cacheable').length < preReloadHits + 2) {
              return null;
            }
            const state = await session.ctl.tabs();
            const tab = state.tabs.find((t) => t.id === tab0.id);
            return tab && !tab.loading ? true : null;
          },
          10_000,
          100,
          `cacheable reload >= ${preReloadHits + 2} hits and !loading`,
        );
        await new Promise((r) => setTimeout(r, 200));
        await session.ctl.waitForTabReady(tab0.id, {
          expectedUrlIncludes: '/cacheable',
          waitForDomComplete: true,
          timeoutMs: 10_000,
        });

        const [seqP2Eval, seqL2Eval] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'portrait',
            tab0.id,
          ),
          session.ctl.evalJs(
            "document.getElementById('cache-seq')?.dataset.seq ?? '0'",
            'landscape',
            tab0.id,
          ),
        ]);
        const seqP2 = Number(seqP2Eval.value);
        const seqL2 = Number(seqL2Eval.value);
        assert.ok(
          Number.isInteger(seqP2) && Number.isInteger(seqL2) && seqP2 > seqP1 && seqL2 > seqL1,
          `cacheable seq > (${seqP1}, ${seqL1}) after reload, got (${seqP2}, ${seqL2})`,
        );

        ctx.servers.resetHttpLogs();
        const [postP, postL] = await Promise.all([
          execFetch(session.ctl, 'portrait', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyJson,
          }),
          execFetch(session.ctl, 'landscape', tab0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyJson,
          }),
        ]);
        assert.equal(postP.status, 200);
        assert.equal(postL.status, 200);
        assert.equal(
          ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length,
          1,
          'expected fresh single /mutate hit post-reload',
        );

        const net = await session.ctl.network(tab0.id, 100);
        assert.ok(net.entries.some((e) => e.url.includes('/cacheable')));
        assert.ok(net.entries.some((e) => e.url.includes('/mutate')));
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, false);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P13',
    tier: 3,
    features: ['F4', 'F9', 'F10'],
    title: 'Single Tab Active + Dormant Dual Tab Restore + Mirrored Click Materialization',
    description:
      'Verifies dormant dual tab emits 0 HTTP requests on startup, materializes both views when accessed, and replicates #btn-inc click.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const tab0Url = `${ctx.servers.httpBaseUrl}/echo?tab=single`;
      const tab1Url = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession(
          [
            makeTabFixture(tab0Url, { mode: 'single', audioSource: 'portrait' }),
            makeTabFixture(tab1Url, { mode: 'dual', mirror: true, sleeping: false }),
          ],
          { activeTabIndex: 0 },
        ),
      });
      try {
        const tabsState = await session.ctl.tabs();
        const t0 = tabsState.tabs[0];
        const t1 = tabsState.tabs[1];
        assert.ok(t0 && t1, 'expected 2 tabs');
        assert.equal(t0.mode, 'single');
        assert.equal(t0.audioSource, 'landscape', 'single mode coerces portrait audioSource to landscape');

        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/echo' });
        assert.equal(
          ctx.servers.getHttpLogs('/page/interactions').length,
          0,
          'dormant tab 1 must not load before materialization',
        );

        await session.ctl.evalJs('document.readyState', 'portrait', t1.id);
        await session.ctl.waitForTabReady(t1.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.interact({
          action: 'click',
          tabId: t1.id,
          viewport: 'portrait',
          selector: '#btn-inc',
          mirror: true,
        });

        const [pCount, lCount] = await Promise.all([
          session.ctl.evalJs(
            "document.getElementById('inc-count')?.textContent ?? ''",
            'portrait',
            t1.id,
          ),
          session.ctl.evalJs(
            "document.getElementById('inc-count')?.textContent ?? ''",
            'landscape',
            t1.id,
          ),
        ]);
        assert.equal(pCount.value, '1');
        assert.equal(lCount.value, '1');
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P14',
    tier: 3,
    features: ['F1', 'F2', 'F3', 'F5'],
    title: 'Dual + Tablet-Portrait + EcoMode=true vs EcoMode=false + Screenshot & Metrics',
    description:
      'Compares Eco vs HiDPI DPR on tablet-portrait preset and verifies PNG screenshots and finite metrics with dockOpen=false.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const makeTabletTab = () =>
        makeTabFixture(targetUrl, {
          portraitPresetId: 'tablet-portrait',
          landscapePresetId: 'desktop-1440',
        });

      let ecoDpr = 0;
      const sEco = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabletTab()], { ecoMode: true, dockOpen: false }),
      });
      try {
        const t0 = (await sEco.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab in eco session');
        await sEco.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        ecoDpr = Number(
          (await sEco.ctl.evalJs('String(window.devicePixelRatio)', 'portrait', t0.id)).value,
        );
        assert.ok(Number.isFinite(ecoDpr) && ecoDpr >= 1 && ecoDpr <= 2, `got ecoDpr=${ecoDpr}`);

        const shot = await sEco.ctl.screenshot(t0.id, 'both');
        assert.ok(shot.captures.portrait && shot.captures.portrait.pngBase64.length > 0);
        assert.ok(shot.captures.landscape && shot.captures.landscape.pngBase64.length > 0);

        const metrics = await sEco.ctl.metrics();
        assert.equal(metrics.paused, false);
        assert.ok(Number.isFinite(metrics.gpuMemoryMb) && metrics.gpuMemoryMb >= 0);
        assert.ok(Number.isFinite(metrics.totalMemoryMb) && metrics.totalMemoryMb > 0);
        assert.ok(metrics.landscape && metrics.landscape.domNodes > 0);
        assert.ok(metrics.landscape && metrics.landscape.layoutCount >= 0);
        assert.equal(sEco.readStateFile<PersistedSessionFixture>()?.dockOpen, false);
      } finally {
        await sEco.close();
      }

      const sHi = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabletTab()], { ecoMode: false, dockOpen: false }),
      });
      try {
        const t0 = (await sHi.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab in hidpi session');
        await sHi.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });
        const hiDpr = Number(
          (await sHi.ctl.evalJs('String(window.devicePixelRatio)', 'portrait', t0.id)).value,
        );
        assert.equal(hiDpr, 2, 'tablet-portrait preset DPR is 2 when ecoMode=false');
        assert.ok(ecoDpr <= hiDpr);
      } finally {
        await sHi.close();
      }
    },
  },

  {
    id: 'T3-P15',
    tier: 3,
    features: ['F2', 'F5', 'F8', 'F9'],
    title: 'Dual + Shared + Mirror + Active WS + Canvas + ARIA Slider + Top-Level Scroll',
    description:
      'Verifies active muxed WS coexists with canvas pointer events, ARIA slider interaction, top-level document scroll isolation, and healthy metrics.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetWsStats();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)]),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab 0');
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        // Inject responsive viewport meta so Chromium mobile emulation in portrait renders at 390x844
        // with scrollHeight > innerHeight, then warm up compositor hit-testing surfaces via screenshot.
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
          const dimsEval = await session.ctl.evalJs(injectViewportMetaExpr, role, t0.id);
          const dims = JSON.parse(dimsEval.value) as {
            innerWidth: number;
            innerHeight: number;
            scrollHeight: number;
          };
          assert.ok(
            dims.scrollHeight > dims.innerHeight,
            `${role} expected scrollHeight (${dims.scrollHeight}) > innerHeight (${dims.innerHeight})`,
          );
        }
        await session.ctl.screenshot(t0.id, 'both');

        // Open same-origin WS in both viewports while remaining on /page/interactions
        const openWsExpr = `new Promise((resolve) => {
          const ws = new WebSocket(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1');
          window.__p15Ws = ws;
          ws.addEventListener('open', () => resolve('open'));
          ws.addEventListener('error', () => resolve('error'));
        })`;
        const [wsP, wsL] = await Promise.all([
          session.ctl.evalJs(openWsExpr, 'portrait', t0.id),
          session.ctl.evalJs(openWsExpr, 'landscape', t0.id),
        ]);
        assert.equal(wsP.value, 'open');
        assert.equal(wsL.value, 'open');
        assert.equal(ctx.servers.getWsStats().activeConnections, 1);

        // Attach #aria-slider listener per E2E-M1 caveat #2
        const attachSliderExpr = `(() => {
          const s = document.getElementById('aria-slider');
          if (!s) return 'missing';
          s.addEventListener('click', () => s.setAttribute('aria-valuenow', '60'));
          return 'ok';
        })()`;
        await Promise.all([
          session.ctl.evalJs(attachSliderExpr, 'portrait', t0.id),
          session.ctl.evalJs(attachSliderExpr, 'landscape', t0.id),
        ]);

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
          action: 'click',
          tabId: t0.id,
          viewport: 'portrait',
          selector: '#aria-slider',
          mirror: true,
        });
        await session.ctl.interact({
          action: 'scroll',
          tabId: t0.id,
          viewport: 'portrait',
          ratioY: 0.5,
          mirror: true,
        });

        for (const role of ['portrait', 'landscape'] as const) {
          const domState = await session.ctl.evalJs(
            `JSON.stringify({
              canvasCount: Array.isArray(window.__canvasPoints) ? window.__canvasPoints.length : 0,
              ariaVal: document.getElementById('aria-slider')?.getAttribute('aria-valuenow'),
              scrollY: window.scrollY,
              innerScrollTop: document.getElementById('inner-scroll')?.scrollTop ?? -1,
            })`,
            role,
            t0.id,
          );
          const parsed = JSON.parse(domState.value) as {
            canvasCount: number;
            ariaVal: string | null;
            scrollY: number;
            innerScrollTop: number;
          };
          assert.ok(parsed.canvasCount > 0, `${role} canvas events recorded`);
          assert.equal(parsed.ariaVal, '60', `${role} aria-valuenow updated`);
          assert.ok(parsed.scrollY > 0, `${role} top-level scrollY > 0`);
          assert.equal(parsed.innerScrollTop, 0, `${role} #inner-scroll must stay 0`);
        }

        const metrics = await session.ctl.metrics();
        assert.equal(metrics.paused, false);
        assert.ok(metrics.portrait && metrics.portrait.fps >= 0);
        assert.ok(metrics.landscape && metrics.landscape.fps >= 0);
        assert.ok(Number.isFinite(metrics.totalMemoryMb) && metrics.totalMemoryMb > 0);
      } finally {
        await session.close();
      }
    },
  },

  {
    id: 'T3-P16',
    tier: 3,
    features: ['F4', 'F8', 'F10', 'F11'],
    title: 'Dual + Shared + Sleeping Tab Isolation + WS + SIGTERM Restore',
    description:
      'Verifies sleeping=true tabs reject evalJs with sleeping, emit 0 HTTP hits across 2 launches, and leave Tab 0 WS unaffected.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      ctx.servers.resetWsStats();
      const wsPageUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;
      const sleepUrl = `${ctx.servers.httpBaseUrl}/echo?sleep=1`;

      const session1 = await ctx.launchElectron({
        smoke: true,
        keepTempDir: true,
        seedSession: makeSeedSession(
          [
            makeTabFixture(wsPageUrl, { sleeping: false }),
            makeTabFixture(sleepUrl, { sleeping: true }),
          ],
          { activeTabIndex: 0 },
        ),
      });

      const sharedDir = session1.sessionDir;
      try {
        try {
          const tabs1 = await session1.ctl.tabs();
          const t0 = tabs1.tabs[0];
          const t1 = tabs1.tabs[1];
          assert.ok(t0 && t1, 'expected 2 tabs');
          assert.equal(t1.sleeping, true);
          await session1.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/ws-sse' });

          await assert.rejects(
            () => session1.ctl.evalJs('1', 'landscape', t1.id),
            /sleeping/i,
          );

          await session1.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
            'portrait',
            t0.id,
          );
          await session1.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
            'landscape',
            t0.id,
          );
          await pollUntil(
            async () =>
              ctx.servers.getWsStats().activeConnections === 1 ? true : null,
            5_000,
            100,
            'Tab 0 muxed WS activeConnections === 1',
          );

          session1.sendSignal('SIGTERM');
          await session1.waitForExit(8_000);
        } finally {
          await session1.close();
        }

        const session2 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedDir,
          keepTempDir: true,
        });
        try {
          const tabs2 = await session2.ctl.tabs();
          const r0 = tabs2.tabs[0];
          const r1 = tabs2.tabs[1];
          assert.ok(r0 && r1, 'expected 2 restored tabs');
          await session2.ctl.waitForTabReady(r0.id, { expectedUrlIncludes: '/page/ws-sse' });
          assert.equal(r1.sleeping, true);

          const sleepHits = ctx.servers
            .getHttpLogs('/echo')
            .filter((e) => e.query.sleep === '1');
          assert.equal(sleepHits.length, 0, 'sleeping tab must emit 0 HTTP hits across both launches');
        } finally {
          await session2.close();
        }
      } finally {
        cleanupDirSafe(sharedDir);
      }
    },
  },

  {
    id: 'T3-P17',
    tier: 3,
    features: ['F4', 'F8', 'F10'],
    title: 'Dual + AutoSleep=true Opt-In + Active Awake vs Dormant Persistence',
    description:
      'Verifies autoSleep=true persists across SIGTERM + relaunch, active Tab 0 stays awake, and dormant Tab 1 makes 0 HTTP hits until accessed.',
    timeoutMs: 90_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const activeUrl = `${ctx.servers.httpBaseUrl}/echo?active=1`;
      const dormantUrl = `${ctx.servers.httpBaseUrl}/page/ws-sse`;

      const session1 = await ctx.launchElectron({
        smoke: true,
        keepTempDir: true,
        seedSession: makeSeedSession(
          [
            makeTabFixture(activeUrl, { sleeping: false }),
            makeTabFixture(dormantUrl, { sleeping: false }),
          ],
          { autoSleep: true, activeTabIndex: 0 },
        ),
      });

      const sharedDir = session1.sessionDir;
      try {
        try {
          const tabs1 = await session1.ctl.tabs();
          const t0 = tabs1.tabs[0];
          const t1 = tabs1.tabs[1];
          assert.ok(t0 && t1, 'expected 2 tabs');
          assert.equal(t0.sleeping, false);
          await session1.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/echo' });
          assert.equal(ctx.servers.getHttpLogs('/page/ws-sse').length, 0);

          session1.sendSignal('SIGTERM');
          await session1.waitForExit(8_000);
        } finally {
          await session1.close();
        }

        const flushed = JSON.parse(
          fs.readFileSync(session1.stateFilePath, 'utf8'),
        ) as PersistedSessionFixture;
        assert.equal(flushed.autoSleep, true);
        assert.equal(flushed.tabs[0]?.sleeping, false);

        ctx.servers.resetHttpLogs();
        const session2 = await ctx.launchElectron({
          smoke: true,
          sessionDir: sharedDir,
          keepTempDir: true,
        });
        try {
          const tabs2 = await session2.ctl.tabs();
          const r0 = tabs2.tabs[0];
          const r1 = tabs2.tabs[1];
          assert.ok(r0 && r1, 'expected 2 restored tabs');
          await session2.ctl.waitForTabReady(r0.id, { expectedUrlIncludes: '/echo' });
          assert.equal(r0.sleeping, false, 'active tab must never sleep');
          assert.equal(
            ctx.servers.getHttpLogs('/page/ws-sse').length,
            0,
            'dormant tab 1 must remain unloaded until accessed',
          );

          await session2.ctl.evalJs('document.readyState', 'portrait', r1.id);
          await session2.ctl.waitForTabReady(r1.id, { expectedUrlIncludes: '/page/ws-sse' });
          assert.ok(ctx.servers.getHttpLogs('/page/ws-sse').length >= 1);
        } finally {
          await session2.close();
        }
      } finally {
        cleanupDirSafe(sharedDir);
      }
    },
  },

  {
    id: 'T3-P18',
    tier: 3,
    features: ['F6', 'F7', 'F12'],
    title: 'Dual + Shared + Mirror + Dedup + Fail-Open (302/401/500/>2MB/ndjson) + Clean Recovery',
    description:
      'Verifies non-cacheable statuses, >2MB body, and NDJSON stream fail open without polluting subsequent POST /mutate deduplication.',
    timeoutMs: 60_000,
    run: async (ctx: E2ETestContext): Promise<void> => {
      ctx.servers.resetHttpLogs();
      const targetUrl = `${ctx.servers.httpBaseUrl}/page/interactions`;
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: makeSeedSession([makeTabFixture(targetUrl)]),
      });
      try {
        const t0 = (await session.ctl.tabs()).tabs[0];
        assert.ok(t0, 'expected tab 0');
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: '/page/interactions' });

        const failOpenCases: Array<{
          path: string;
          expectedStatus: number;
          redirect?: 'manual';
        }> = [
          { path: '/status/302', expectedStatus: 0, redirect: 'manual' },
          { path: '/status/401', expectedStatus: 401 },
          { path: '/status/500', expectedStatus: 500 },
          { path: '/large', expectedStatus: 200 },
          { path: '/stream?type=ndjson', expectedStatus: 200 },
        ];

        for (const tc of failOpenCases) {
          ctx.servers.resetHttpLogs();
          const url = `${ctx.servers.httpBaseUrl}${tc.path}`;
          const [pRes, lRes]: [FetchResult, FetchResult] = await Promise.all([
            execFetch(session.ctl, 'portrait', t0.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ probe: tc.path }),
              redirect: tc.redirect,
            }),
            execFetch(session.ctl, 'landscape', t0.id, url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ probe: tc.path }),
              redirect: tc.redirect,
            }),
          ]);
          if (tc.expectedStatus !== 0) {
            assert.equal(pRes.status, tc.expectedStatus, `${tc.path} portrait status`);
            assert.equal(lRes.status, tc.expectedStatus, `${tc.path} landscape status`);
          }
          assert.equal(pRes.dedupHeader, null, `${tc.path} must not replay portrait`);
          assert.equal(lRes.dedupHeader, null, `${tc.path} must not replay landscape`);

          const pathname = tc.path.split('?')[0] ?? tc.path;
          const hits = ctx.servers.getHttpLogs().filter((e) => e.path === pathname);
          assert.equal(hits.length, 2, `${tc.path} must hit upstream twice (fail-open)`);
        }

        const midTabs = await session.ctl.tabs();
        assert.equal(midTabs.tabs[0]?.dedupCount ?? 0, 0);

        ctx.servers.resetHttpLogs();
        const mutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [mP, mL] = await Promise.all([
          execFetch(session.ctl, 'portrait', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'after-fail-open', idempotencyKey: 'p18-1' }),
          }),
          execFetch(session.ctl, 'landscape', t0.id, mutateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'after-fail-open', idempotencyKey: 'p18-2' }),
          }),
        ]);
        assert.equal(mP.status, 200);
        assert.equal(mL.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((e) => e.path === '/mutate').length, 1);
        const replayed = [mP.dedupHeader, mL.dedupHeader].filter(
          (h) => h === 'replayed',
        ).length;
        assert.equal(replayed, 1);
      } finally {
        await session.close();
      }
    },
  },
];

export default tests;
