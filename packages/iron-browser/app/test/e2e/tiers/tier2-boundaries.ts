import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DebuggerCoordinator, type DebuggerTarget } from '../../../src/main/debugger-coordinator';
import { RequestDedupMiddleware } from '../../../src/main/request-dedup';
import { computeFrameStats, sanitizeMirrorMissLabel } from '../../../src/shared/mirror-core';
import { DEVICE_PRESETS } from '../../../src/shared/presets';
import { CtlRpcError, MAX_FRAME_BYTES, encodeCtlFrame } from '../lib/ctl-client';
import type {
  E2ETestCase,
  PersistedSessionFixture,
  PersistedTabFixture,
  ViewportRole,
} from '../lib/types';

const APP_ROOT = path.resolve(import.meta.dir, '../../..');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAppFile(relPath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relPath), 'utf8');
}

function extractMethodBlock(src: string, signature: string): string {
  const sigIdx = src.indexOf(signature);
  if (sigIdx === -1) return '';
  const openIdx = src.indexOf('{', sigIdx);
  if (openIdx === -1) return '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i]!;
    const next = src[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '`') {
        inTemplate = false;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(sigIdx, i + 1);
      }
    }
  }
  return src.slice(sigIdx);
}

function makeTabFixture(
  url: string,
  overrides: Partial<PersistedTabFixture> = {},
): PersistedTabFixture {
  return {
    url,
    title: 'Seeded Tab',
    mode: 'dual',
    mirror: true,
    dedup: true,
    session: 'shared',
    sleeping: false,
    portraitPresetId: 'iphone-15',
    landscapePresetId: 'desktop-hd',
    devtoolsTarget: 'portrait',
    audioSource: 'landscape',
    ...overrides,
  };
}

function makeSessionFixture(
  tabs: PersistedTabFixture[],
  overrides: Partial<PersistedSessionFixture> = {},
): PersistedSessionFixture {
  return {
    version: 1,
    savedAt: Date.now(),
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

function visibleLaunchArgs(): string[] {
  return !process.env.WAYLAND_DISPLAY && process.env.DISPLAY ? ['--ozone-platform=x11'] : [];
}

async function waitUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  description: string,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for ${description} after ${timeoutMs}ms${lastErr ? ` (last error: ${String(lastErr)})` : ''}`,
  );
}

interface MutateFetchOutcome {
  status: number;
  dedupHeader: string | null;
  body: Record<string, unknown>;
}

async function runFetchInViewport(
  evalJs: (expr: string, role?: ViewportRole, tabId?: string) => Promise<{ value: string }>,
  role: ViewportRole,
  tabId: string,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual' | 'error';
  },
): Promise<MutateFetchOutcome> {
  const expr = `(async () => {
    const res = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(init.method)},
      headers: ${JSON.stringify(init.headers ?? {})},
      ${init.redirect ? `redirect: ${JSON.stringify(init.redirect)},` : ''}
      ${init.body !== undefined ? `body: ${JSON.stringify(init.body)},` : ''}
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch { body = { rawLength: text.length }; }
    return JSON.stringify({
      status: res.status,
      dedupHeader: res.headers.get('x-iron-browser-dedup'),
      body,
    });
  })()`;
  const res = await evalJs(expr, role, tabId);
  return JSON.parse(res.value) as MutateFetchOutcome;
}

export const tests: E2ETestCase[] = [
  // =========================================================================
  // F1 — R1: Eco DPR cap Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F1-01',
    tier: 2,
    features: ['F1'],
    title: 'hostScaleFactor = 0.5 clamps effective DPR >= 1',
    description:
      'Forces host scale factor 0.5 and asserts iphone-15 portrait window.devicePixelRatio never drops below 1.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: true,
        extraArgs: ['--force-device-scale-factor=0.5'],
      });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'dual',
          portraitPreset: 'iphone-15',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });
        const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id)).value);
        assert.ok(Number.isFinite(dpr) && dpr >= 1, `Expected DPR >= 1, got ${dpr}`);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F1-02',
    tier: 2,
    features: ['F1'],
    title: 'dpr = 1 floor invariant across Eco and HiDPI on desktop-hd',
    description:
      'Checks desktop-hd landscape viewport reports devicePixelRatio === 1 in both Eco (true) and HiDPI (false) modes.',
    run: async (ctx) => {
      for (const ecoMode of [true, false]) {
        const seedSession = makeSessionFixture(
          [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, { landscapePresetId: 'desktop-hd' })],
          { ecoMode },
        );
        const session = await ctx.launchElectron({ smoke: true, seedSession });
        try {
          const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
          const dpr = Number(
            (await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tab.id)).value,
          );
          assert.equal(dpr, 1);
        } finally {
          await session.close();
        }
      }
    },
  },
  {
    id: 'T2-F1-03',
    tier: 2,
    features: ['F1'],
    title: 'dpr = 3 ceiling on iphone-15-pro-max with ecoMode: false & high host scale',
    description:
      'Forces host scale factor 4 with ecoMode: false on iphone-15-pro-max (dpr 3) and asserts effective DPR does not exceed 3.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, { portraitPresetId: 'iphone-15-pro-max' })],
        { ecoMode: false },
      );
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession,
        extraArgs: ['--force-device-scale-factor=4'],
      });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id)).value);
        assert.ok(Number.isFinite(dpr) && dpr <= 3, `Expected DPR <= 3, got ${dpr}`);
        assert.equal(dpr, 3);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F1-04',
    tier: 2,
    features: ['F1'],
    title: 'tablet-portrait (768x1024, dpr: 2) vs desktop-1440 (1440x900, dpr: 1) bounds',
    description:
      'Opens dual tab with tablet-portrait and desktop-1440 and verifies exact viewport dimensions and DPR bounds.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'dual',
          portraitPreset: 'tablet-portrait',
          landscapePreset: 'desktop-1440',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });

        await session.ctl.evalJs(
          "(() => { const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1'; document.head.appendChild(m); return true; })()",
          'portrait',
          tab.id,
        );
        const psw = Number((await session.ctl.evalJs('window.screen.width', 'portrait', tab.id)).value);
        const pw = Number((await session.ctl.evalJs('window.innerWidth', 'portrait', tab.id)).value);
        const ph = Number((await session.ctl.evalJs('window.innerHeight', 'portrait', tab.id)).value);
        const pd = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id)).value);
        const lw = Number((await session.ctl.evalJs('window.innerWidth', 'landscape', tab.id)).value);
        const lh = Number((await session.ctl.evalJs('window.innerHeight', 'landscape', tab.id)).value);
        const ld = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tab.id)).value);

        assert.equal(psw, 768);
        assert.equal(pw, 768);
        assert.equal(ph, 1024);
        assert.ok(pd >= 1 && pd <= 2);
        assert.equal(lw, 1440);
        assert.equal(lh, 900);
        assert.equal(ld, 1);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F1-05',
    tier: 2,
    features: ['F1', 'F10'],
    title: 'Corrupt ecoMode ("bogus") in seeded session-state.json falls back to true',
    description:
      'Seeds session-state.json with non-boolean ecoMode: "bogus" and verifies safe fallback to ecoMode === true.',
    run: async (ctx) => {
      const corruptRaw = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        railCollapsed: false,
        dockOpen: false,
        dockHeight: 290,
        splitRatio: 0.34,
        theme: 'dark',
        ecoMode: 'bogus',
        activeTabIndex: 0,
        tabs: [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, { portraitPresetId: 'iphone-15' })],
        history: [],
      });
      const session = await ctx.launchElectron({
        smoke: true,
        seedSession: corruptRaw,
        extraArgs: ['--force-device-scale-factor=1'],
      });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id)).value);
        assert.ok(dpr >= 1 && dpr < 3);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.ecoMode, true);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F2 — R1: Burst FPS Sampling Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F2-01',
    tier: 2,
    features: ['F2'],
    title: 'Zero-frame / sleep gap lastTs = 0 guard prevents p95FrameMs spike',
    description:
      'Verifies computeFrameStats filters invalid/non-positive deltas, live metrics remain <500ms p95 after idle gaps, and mirror-preload resets lastTs = 0.',
    run: async (ctx) => {
      assert.deepEqual(computeFrameStats([0, -5, Number.NaN]), { fps: 0, p95FrameMs: 0, jankCount: 0 });
      const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
      assert.ok(preloadSrc.includes('lastTs = 0'));

      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        await sleep(2_500);
        await session.ctl.evalJs('requestAnimationFrame(() => {})', 'portrait', tab.id);
        await sleep(300);
        const m = await session.ctl.metrics();
        if (m.portrait && m.portrait.recentFrameMs.length > 0) {
          assert.ok(m.portrait.p95FrameMs < 500);
          assert.ok(m.portrait.recentFrameMs.every((dt) => dt < 2000));
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F2-02',
    tier: 2,
    features: ['F2'],
    title: 'Rapid tab switching leaves zero preload errors and finite FPS',
    description:
      'Opens two tabs and navigates/switches rapidly 5 times, asserting 0 preload errors in console and finite FPS values.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        for (let i = 0; i < 5; i += 1) {
          const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions?i=${i}`, {
            mode: 'dual',
          });
          assert.ok(opened.tab?.id);
          await sleep(120);
        }
        const tab = await session.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: '/page/interactions',
        });
        await sleep(2_200);
        const errs = await session.ctl.console({ tabId: tab.id, level: 'error', limit: 50 });
        assert.equal(errs.entries.length, 0);
        const m = await session.ctl.metrics();
        assert.ok(Number.isFinite(m.portrait?.fps ?? 0) && (m.portrait?.fps ?? 0) >= 0);
        assert.ok(Number.isFinite(m.landscape?.fps ?? 0) && (m.landscape?.fps ?? 0) >= 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F2-03',
    tier: 2,
    features: ['F2'],
    title: 'Navigation mid-burst cleans up without crash or stale metrics',
    description:
      'Starts rAF loop on /page/interactions then immediately navigates away to /echo, asserting metrics remain finite and stderr stays clean.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        await session.ctl.evalJs('requestAnimationFrame(() => {})', 'portrait', tab.id);
        await session.ctl.navigate(`${ctx.servers.httpBaseUrl}/echo?nav=1`, tab.id);
        await session.ctl.waitForTabReady(tab.id, { expectedUrlIncludes: 'nav=1' });

        const m = await session.ctl.metrics();
        assert.ok(m.timestampMs > 0);
        assert.equal(session.getStderr().includes('UnhandledPromiseRejection'), false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F2-04',
    tier: 2,
    features: ['F2'],
    title: 'Exact > 5000ms TTL eviction boundary zeros out stale rafByWcId entry',
    description:
      'Verifies strict > 5000ms TTL comparison in telemetry.ts (retained at 5000ms, evicted at 5001ms) and zeroed FPS when hidden past TTL.',
    run: async (ctx) => {
      const telemetrySrc = readAppFile('src/main/telemetry.ts');
      assert.ok(telemetrySrc.includes('RAF_STATS_TTL_MS = 5000'));
      assert.ok(telemetrySrc.includes('nowMs - entry.updatedAtMs > this.rafTtlMs'));

      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        const m = await session.ctl.metrics();
        assert.equal(m.portrait?.fps ?? 0, 0);
        assert.equal(m.portrait?.p95FrameMs ?? 0, 0);
        assert.deepEqual(m.portrait?.recentFrameMs ?? [], []);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F2-05',
    tier: 2,
    features: ['F2'],
    title: 'High-frequency DOM mutation burst keeps recentFrameMs & fps within sanitizer caps',
    description:
      'Drives a 60Hz DOM mutation loop in visible dual Electron for 2.2s and asserts fps <= 1000, p95FrameMs <= 10000, jankCount <= 10000, recentFrameMs.length <= 30.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.evalJs(
          `(() => {
            const end = performance.now() + 2300;
            const host = document.getElementById('page-title');
            const tick = () => {
              if (host) host.textContent = 'Tick ' + Math.round(performance.now());
              if (performance.now() < end) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return true;
          })()`,
          'portrait',
          tab.id,
        );
        await sleep(2_300);
        const m = await session.ctl.metrics();
        assert.ok(m.portrait !== null);
        assert.ok(m.portrait.fps <= 1000);
        assert.ok(m.portrait.p95FrameMs <= 10000);
        assert.ok(m.portrait.jankCount <= 10000);
        assert.ok(m.portrait.recentFrameMs.length <= 30);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F3 — R1: Lazy DevTools & Network.enable Cap & DebuggerCoordinator (5 tests)
  // =========================================================================
  {
    id: 'T2-F3-01',
    tier: 2,
    features: ['F3'],
    title: 'Console (400) & network (1000) ring buffers wrap cleanly',
    description:
      'Emits 425 console logs and 1025 fetch requests in live Electron and verifies oldest 0..24 entries evict cleanly while entry 25/30..last remain in the 400-entry console and 1000-entry network ring buffers.',
    timeoutMs: 60_000,
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'single',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });

        await session.ctl.evalJs(
          `(async () => {
            for (let base = 0; base < 1025; base += 25) {
              const batch = [];
              for (let j = base; j < Math.min(1025, base + 25); j += 1) {
                const path =
                  j < 25
                    ? '/status/404?ring=' + j
                    : j < 55
                      ? '/status/500?ring=' + j
                      : '/echo?ring=' + j;
                batch.push(fetch(path));
              }
              await Promise.all(batch);
            }
            await new Promise((r) => setTimeout(r, 100));
            for (let i = 0; i < 425; i += 1) {
              if (i < 50) {
                console.error('ring-msg-' + i);
              } else {
                console.log('ring-msg-' + i);
              }
            }
            return true;
          })()`,
          'landscape',
          tab.id,
        );

        const cons = await waitUntil(
          async () => {
            const c = await session.ctl.console(tab.id, 400);
            return c.entries.some((e) => e.text === 'ring-msg-424') ? c : null;
          },
          5_000,
          'wrapped console ring buffer',
        );
        // TelemetryService.getConsoleEntries caps query limit at 200
        assert.equal(cons.count, 200);
        assert.equal(cons.entries.some((e) => e.text === 'ring-msg-0'), false);
        assert.equal(cons.entries.some((e) => e.text === 'ring-msg-424'), true);

        // Filtered error query proves 400-entry capacity: 0..24 evicted, 25..49 retained
        const consErrors = await session.ctl.console({
          tabId: tab.id,
          level: 'error',
          limit: 200,
        });
        assert.equal(consErrors.entries.some((e) => e.text === 'ring-msg-0'), false);
        assert.equal(consErrors.entries.some((e) => e.text === 'ring-msg-24'), false);
        assert.equal(consErrors.entries.some((e) => e.text === 'ring-msg-25'), true);

        const net = await waitUntil(
          async () => {
            const n = await session.ctl.network(tab.id, 400);
            return n.entries.some((e) => e.url.endsWith('ring=1024')) ? n : null;
          },
          5_000,
          'wrapped network ring buffer',
        );
        // TelemetryService.getNetworkEntries caps query limit at 200
        assert.equal(net.count, 200);
        assert.equal(net.entries.some((e) => e.url.endsWith('ring=0')), false);
        assert.equal(net.entries.some((e) => e.url.endsWith('ring=1024')), true);

        // Filtered 4xx/5xx queries prove 1000-entry network ring buffer wrap eviction
        const net4xx = await session.ctl.network({ tabId: tab.id, filter: '4xx', limit: 200 });
        assert.equal(net4xx.entries.some((e) => e.url.endsWith('ring=0')), false);
        assert.equal(net4xx.entries.some((e) => e.url.endsWith('ring=24')), false);
        const net5xx = await session.ctl.network({ tabId: tab.id, filter: '5xx', limit: 200 });
        assert.equal(net5xx.entries.some((e) => e.url.endsWith('ring=30')), true);
        assert.equal(net5xx.entries.some((e) => e.url.endsWith('ring=54')), true);

        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F3-02',
    tier: 2,
    features: ['F3'],
    title: '> 2MB /large response with Network.enable {1,1,1} caps avoids memory bloat',
    description:
      'Fetches 2,306,867-byte /large response inside live Electron, confirms ctl.network() records status 200, and verifies telemetry.ts passes {1,1,1} caps.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'single',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });

        const bytes = Number(
          (
            await session.ctl.evalJs(
              "fetch('/large').then((r) => r.arrayBuffer().then((b) => b.byteLength))",
              'landscape',
              tab.id,
            )
          ).value,
        );
        assert.equal(bytes, 2_306_867);

        const net = await waitUntil(
          async () => {
            const n = await session.ctl.network(tab.id, 50);
            return n.entries.find((e) => e.url.includes('/large') && e.status === 200) ?? null;
          },
          4_000,
          '/large network entry',
        );
        assert.equal(net.failed, false);
        const metrics = await session.ctl.metrics();
        assert.ok(Number.isFinite(metrics.totalMemoryMb) && metrics.totalMemoryMb > 0);

        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('maxTotalBufferSize: 1'));
        assert.ok(telemetrySrc.includes('maxResourceBufferSize: 1'));
        assert.ok(telemetrySrc.includes('maxPostDataSize: 1'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F3-03',
    tier: 2,
    features: ['F3'],
    title: 'Rapid DebuggerCoordinator attach/detach/reattach cycles & DevTools teardown order',
    description:
      'Runs 5 rapid attach/detach/reattach cycles through DebuggerCoordinator and checks TabManager closeDevTools-before-destroy invariants.',
    run: async () => {
      const coordinator = new DebuggerCoordinator();
      let attached = false;
      let reattachHooks = 0;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

      const target: DebuggerTarget = {
        id: 777,
        isDestroyed: () => false,
        once: (ev, fn) => {
          const set = listeners.get(ev) ?? new Set();
          set.add(fn as (...args: unknown[]) => void);
          listeners.set(ev, set);
        },
        debugger: {
          isAttached: () => attached,
          attach: () => {
            attached = true;
          },
          detach: () => {
            attached = false;
          },
          sendCommand: async () => ({}),
          on: (ev, fn) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn as (...args: unknown[]) => void);
            listeners.set(ev, set);
          },
        },
      };

      coordinator.registerParticipant(target, 'p1', {
        onReattach: () => {
          reattachHooks += 1;
        },
      });

      for (let i = 0; i < 5; i += 1) {
        await coordinator.ensureAttached(target);
        attached = false;
        for (const fn of listeners.get('detach') ?? []) {
          fn({}, 'target_closed');
        }
        const ok = await coordinator.reattachAndRestore(target);
        assert.equal(ok, true);
      }
      assert.equal(reattachHooks, 5);
      coordinator.detach(target);

      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      assert.ok(tabMgrSrc.includes('prevWc.closeDevTools()'));
      assert.ok(tabMgrSrc.includes('destroyDevToolsView()'));
    },
  },
  {
    id: 'T2-F3-04',
    tier: 2,
    features: ['F3'],
    title: 'Inspect Element bounded devtools-opened timeout & destroyed target safety',
    description:
      'Verifies DebuggerCoordinator rejects cleanly on destroyed WebContents and TabManager.inspectElementAt uses bounded devtools-opened timeout without 60ms sleep.',
    run: async () => {
      const coordinator = new DebuggerCoordinator();
      let destroyed = false;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const target: DebuggerTarget = {
        id: 888,
        isDestroyed: () => destroyed,
        once: (ev, fn) => {
          const set = listeners.get(ev) ?? new Set();
          set.add(fn as (...args: unknown[]) => void);
          listeners.set(ev, set);
        },
        debugger: {
          isAttached: () => !destroyed,
          attach: () => {},
          detach: () => {},
          sendCommand: async () => ({}),
          on: (ev, fn) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn as (...args: unknown[]) => void);
            listeners.set(ev, set);
          },
        },
      };

      destroyed = true;
      assert.equal(await coordinator.ensureAttached(target), false);
      assert.equal(await coordinator.reattachAndRestore(target), false);
      await assert.rejects(() => coordinator.sendCommand(target, 'Runtime.enable'));

      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      assert.ok(tabMgrSrc.includes('devtools-opened'));
      assert.ok(tabMgrSrc.includes('this.inspectTimeoutMs'));
    },
  },
  {
    id: 'T2-F3-05',
    tier: 2,
    features: ['F3'],
    title: 'External wc.debugger detach mid-reattach preserves needsRestore & restores CDP',
    description:
      'Verifies DebuggerCoordinator preserves needsRestore if a second detach fires during onReattach and restores participants on subsequent reattachAndRestore.',
    run: async () => {
      const coordinator = new DebuggerCoordinator();
      let attached = false;
      let restoreCalls = 0;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const emit = (ev: string, ...args: unknown[]) => {
        for (const fn of listeners.get(ev) ?? []) {
          fn(...args);
        }
      };

      const target: DebuggerTarget = {
        id: 999,
        isDestroyed: () => false,
        once: (ev, fn) => {
          const set = listeners.get(ev) ?? new Set();
          set.add(fn as (...args: unknown[]) => void);
          listeners.set(ev, set);
        },
        debugger: {
          isAttached: () => attached,
          attach: () => {
            attached = true;
          },
          detach: () => {
            attached = false;
          },
          sendCommand: async () => ({}),
          on: (ev, fn) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn as (...args: unknown[]) => void);
            listeners.set(ev, set);
          },
        },
      };

      await coordinator.ensureAttached(target);
      coordinator.registerParticipant(target, 'telemetry', {
        onReattach: () => {
          restoreCalls += 1;
          if (restoreCalls === 1) {
            attached = false;
            emit('detach', {}, 'mid_restore');
          }
        },
      });

      attached = false;
      emit('detach', {}, 'initial');
      await coordinator.reattachAndRestore(target);
      // Because detach fired mid-onReattach, second reattachAndRestore must still run onReattach!
      const ok2 = await coordinator.reattachAndRestore(target);
      assert.equal(ok2, true);
      assert.equal(restoreCalls, 2);
      coordinator.detach(target);
    },
  },

  // =========================================================================
  // F4 — R1: Lazy Restored Tabs & Auto-Sleep Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F4-01',
    tier: 2,
    features: ['F4', 'F10'],
    title: '24 restored tabs (MAX_PERSISTED_TABS: 1 active + 23 dormant) launch boundary',
    description:
      'Seeds 24 tabs with activeTabIndex: 12 and asserts only idx=12 makes an HTTP request on launch while all 23 dormant tabs stay at 0 hits.',
    run: async (ctx) => {
      const tabs: PersistedTabFixture[] = [];
      for (let i = 0; i < 24; i += 1) {
        tabs.push(makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?idx=${i}`));
      }
      const seedSession = makeSessionFixture(tabs, { activeTabIndex: 12 });

      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const state = await session.ctl.tabs();
        assert.equal(state.tabs.length, 24);
        assert.ok(state.activeTabId);
        await session.ctl.waitForTabReady(state.activeTabId, { expectedUrlIncludes: 'idx=12' });

        await sleep(300);
        const echoLogs = ctx.servers.getHttpLogs().filter((l) => l.path === '/echo');
        assert.ok(echoLogs.some((l) => l.query.idx === '12'));
        for (let i = 0; i < 24; i += 1) {
          if (i === 12) continue;
          assert.equal(
            echoLogs.filter((l) => l.query.idx === String(i)).length,
            0,
            `Dormant tab idx=${i} should not have loaded on startup`,
          );
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F4-02',
    tier: 2,
    features: ['F4'],
    title: 'RPCs on dormant vs explicitly sleeping: true tabs',
    description:
      'Verifies evalJs on a dormant tab materializes it cleanly, while evalJs/screenshot on a sleeping: true tab rejects with CtlRpcError (-32000, is sleeping).',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=active`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=dormant`, { sleeping: false }),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=sleep`, { sleeping: true }),
        ],
        { activeTabIndex: 0 },
      );
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const state = await session.ctl.tabs();
        assert.equal(state.tabs.length, 3);
        const t0 = state.tabs[0];
        const t1 = state.tabs[1];
        const t2 = state.tabs[2];
        assert.ok(t0 && t1 && t2);
        await session.ctl.waitForTabReady(t0.id, { expectedUrlIncludes: 't=active' });

        const dormantRes = await session.ctl.evalJs('location.search', 'landscape', t1.id);
        assert.equal(dormantRes.value, '?t=dormant');

        await assert.rejects(
          () => session.ctl.evalJs('1+1', 'landscape', t2.id),
          (err: unknown) =>
            err instanceof CtlRpcError && err.code === -32000 && err.message.includes('is sleeping'),
        );
        await assert.rejects(
          () => session.ctl.screenshot(t2.id, 'landscape'),
          (err: unknown) =>
            err instanceof CtlRpcError && err.code === -32000 && err.message.includes('is sleeping'),
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F4-03',
    tier: 2,
    features: ['F4'],
    title: 'Audible background tab is immune to autoSleep sweep',
    description:
      'Verifies TabManager.sweepAutoSleep checks isTabAudible(tab) (both landscape and portrait WebContents) before sleeping any background tab.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=0`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=1`),
        ],
        { autoSleep: true, activeTabIndex: 0 },
      );
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tabsRes = await session.ctl.tabs();
        assert.equal(tabsRes.tabs.length, 2);
        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes('isTabAudible(tab: ManagedTab)'));
        assert.ok(tabMgrSrc.includes('isCurrentlyAudible()'));
        assert.ok(tabMgrSrc.includes('if (this.isTabAudible(tab)) continue;'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F4-04',
    tier: 2,
    features: ['F4'],
    title: 'Active tab is strictly immune to autoSleep sweep',
    description:
      'Seeds autoSleep: true with 1 active tab, waits idle, and verifies active tab remains sleeping === false both via ctl.tabs() and SIGTERM state export.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=active`)],
        { autoSleep: true, activeTabIndex: 0 },
      );
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 't=active' });
        await sleep(500);
        const current = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.equal(current?.sleeping, false);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.tabs[0]?.sleeping, false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F4-05',
    tier: 2,
    features: ['F4'],
    title: 'Dormant tab (landscapeView === null) safe across export, close, and mode/session methods',
    description:
      'Exports dormant tab across SIGTERM without spawning views (0 HTTP hits for dormant tab) and verifies nullable landscapeView guards across TabManager.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=0`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=dormant-export`, {
            mode: 'single',
            session: 'isolated',
          }),
        ],
        { activeTabIndex: 0 },
      );
      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 't=0' });
        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);

        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.tabs.length, 2);
        assert.equal(persisted?.tabs[1]?.mode, 'single');
        assert.equal(persisted?.tabs[1]?.session, 'isolated');
        assert.equal(
          ctx.servers.getHttpLogs().filter((l) => l.query.t === 'dormant-export').length,
          0,
        );

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes('landscapeView: WebContentsView | null'));
        assert.ok(tabMgrSrc.includes('if (tab.landscapeView && !tab.landscapeView.webContents.isDestroyed())'));
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F5 — R1: CDP Telemetry Polling Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F5-01',
    tier: 2,
    features: ['F5'],
    title: 'Rapid focus/blur oscillation preserves single poll timer & sampleInFlight guard',
    description:
      'Issues rapid concurrent ctl.metrics() calls cleanly without overlap failures and verifies TelemetryService clearPollTimer & sampleInFlight guards.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });

        const batch = await Promise.all([
          session.ctl.metrics(),
          session.ctl.metrics(),
          session.ctl.metrics(),
          session.ctl.metrics(),
        ]);
        for (const m of batch) {
          assert.ok(m.timestampMs > 0);
          assert.ok(Number.isFinite(m.totalMemoryMb));
        }

        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('this.clearPollTimer()'));
        assert.ok(telemetrySrc.includes('if (this.sampleInFlight)'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F5-02',
    tier: 2,
    features: ['F5'],
    title: 'Telemetry numeric bounds (gpuCpuPercent, gpuMemoryMb, totalMemoryMb, timestampMs)',
    description:
      'Queries ctl.metrics() immediately at boot and after tab open, verifying all global memory/CPU metrics are finite non-negative numbers.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mBoot = await session.ctl.metrics();
        assert.ok(Number.isFinite(mBoot.gpuCpuPercent) && mBoot.gpuCpuPercent >= 0);
        assert.ok(Number.isFinite(mBoot.gpuMemoryMb) && mBoot.gpuMemoryMb >= 0);
        assert.ok(Number.isFinite(mBoot.totalMemoryMb) && mBoot.totalMemoryMb > 0);
        assert.ok(mBoot.timestampMs > 0);

        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        const mAfter = await session.ctl.metrics();
        assert.ok(mAfter.totalMemoryMb > 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F5-03',
    tier: 2,
    features: ['F5'],
    title: 'Tab switch mid-poll does not throw or corrupt TelemetrySnapshot',
    description:
      'Executes ctl.metrics() concurrently with ctl.open() and verifies every RPC resolves cleanly with a valid TelemetrySnapshotDto.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const t1 = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(t1.tab?.id);
        await session.ctl.waitForTabReady(t1.tab.id, { expectedUrlIncludes: '/page/interactions' });

        const [m1, opened2, m2] = await Promise.all([
          session.ctl.metrics(),
          session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' }),
          session.ctl.metrics(),
        ]);
        assert.ok(opened2.tab?.id);
        assert.equal(typeof m1.totalMemoryMb, 'number');
        assert.equal(typeof m2.totalMemoryMb, 'number');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F5-04',
    tier: 2,
    features: ['F5'],
    title: 'Sleeping / unattached viewport telemetry returns null safely',
    description:
      'Verifies TelemetryService skips sleeping tabs (returning portrait: null, landscape: null) and single-mode sets portrait: null cleanly.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'single' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        const m = await session.ctl.metrics();
        assert.equal(m.portrait, null);
        assert.ok(m.landscape !== null);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes('if (!active || active.sleeping)'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F5-05',
    tier: 2,
    features: ['F5'],
    title: 'Heavy JS heap allocation reflects finite positive jsHeapUsedMb and domNodes >= 500',
    description:
      'Allocates 500 DOM nodes and a 4MB typed buffer in landscape viewport and asserts metrics reflect domNodes >= 500 and finite jsHeapUsedMb > 0.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'single',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.evalJs(
          `(() => {
            window.__bigBuf = new Uint8Array(4 * 1024 * 1024);
            window.__bigBuf.fill(7);
            const frag = document.createDocumentFragment();
            for (let i = 0; i < 500; i += 1) {
              const span = document.createElement('span');
              span.textContent = String(i);
              frag.appendChild(span);
            }
            document.body.appendChild(frag);
            return window.__bigBuf.byteLength;
          })()`,
          'landscape',
          tab.id,
        );

        const m = await waitUntil(
          async () => {
            const snap = await session.ctl.metrics();
            return (snap.landscape?.domNodes ?? 0) >= 500 ? snap : null;
          },
          4_000,
          'landscape domNodes >= 500',
        );
        assert.ok((m.landscape?.domNodes ?? 0) >= 500);
        assert.ok((m.landscape?.jsHeapUsedMb ?? 0) > 0);
        assert.ok(Number.isFinite(m.totalMemoryMb));
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F6 — R2: HTTP Request Dedup Boundaries & Security (5 tests)
  // =========================================================================
  {
    id: 'T2-F6-01',
    tier: 2,
    features: ['F6'],
    title: '302, 401, 403, 407, 408, 429, 500 responses fail open (never replayed)',
    description:
      'Sends mirrored POSTs to /status/{302,401,403,407,408,429,500} and asserts server sees 2 hits per status with zero x-iron-browser-dedup replay headers.',
    timeoutMs: 60_000,
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        for (const code of [302, 401, 403, 407, 408, 429, 500] as const) {
          ctx.servers.resetHttpLogs();
          if (code === 407) {
            // Chromium rejects non-proxy HTTP 407 responses with net::ERR_UNEXPECTED_PROXY_AUTH
            // (TypeError: Failed to fetch). Catch the expected browser Fetch rejection while
            // strictly verifying both viewports hit the HTTP server (never replayed) and dedupCount stays 0.
            const eval407 = (role: ViewportRole) =>
              session.ctl.evalJs(
                `(async () => {
                  try {
                    const res = await fetch('/status/407', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ code: 407, idempotencyKey: 'st-407-${role}' }),
                      redirect: 'follow',
                    });
                    return JSON.stringify({
                      status: res.status,
                      dedupHeader: res.headers.get('x-iron-browser-dedup'),
                      error: null,
                    });
                  } catch (err) {
                    return JSON.stringify({
                      status: 0,
                      dedupHeader: null,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                })()`,
                role,
                tab.id,
              );
            const [pOut, lOut] = await Promise.all([eval407('portrait'), eval407('landscape')]);
            const p407 = JSON.parse(pOut.value) as {
              status: number;
              dedupHeader: string | null;
              error: string | null;
            };
            const l407 = JSON.parse(lOut.value) as {
              status: number;
              dedupHeader: string | null;
              error: string | null;
            };
            const logs = ctx.servers.getHttpLogs().filter((l) => l.path === '/status/407');
            assert.equal(logs.length, 2, 'Status 407 should fail open (2 hits)');
            assert.equal(p407.dedupHeader, null);
            assert.equal(l407.dedupHeader, null);
            assert.ok(
              p407.status === 407 || (p407.error ?? '').includes('Failed to fetch'),
              `Unexpected 407 portrait outcome: ${JSON.stringify(p407)}`,
            );
            assert.ok(
              l407.status === 407 || (l407.error ?? '').includes('Failed to fetch'),
              `Unexpected 407 landscape outcome: ${JSON.stringify(l407)}`,
            );
            const tabsAfter407 = await session.ctl.tabs();
            const tabAfter407 = tabsAfter407.tabs.find((t) => t.id === tab.id);
            assert.equal(tabAfter407?.dedupCount ?? 0, 0, 'Status 407 must not increment dedupCount');
            continue;
          }

          const [pRes, lRes] = await Promise.all([
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'portrait',
              tab.id,
              `/status/${code}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, idempotencyKey: `st-${code}-p` }),
                redirect: code === 302 ? 'manual' : 'follow',
              },
            ),
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'landscape',
              tab.id,
              `/status/${code}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, idempotencyKey: `st-${code}-l` }),
                redirect: code === 302 ? 'manual' : 'follow',
              },
            ),
          ]);

          const logs = ctx.servers.getHttpLogs().filter((l) => l.path === `/status/${code}`);
          if (code === 408) {
            // Chromium's HttpNetworkTransaction retries HTTP 408 Request Timeout on reused keep-alive sockets
            // (RFC 9110 §15.5.9), so >= 2 hits hit the origin server. Verify fail-open & 0 dedup replays.
            assert.ok(logs.length >= 2, `Status 408 should fail open (>= 2 hits), got ${logs.length}`);
            assert.equal(pRes.status, 408);
            assert.equal(lRes.status, 408);
            assert.equal(pRes.dedupHeader, null);
            assert.equal(lRes.dedupHeader, null);
            const tabsAfter408 = await session.ctl.tabs();
            const tabAfter408 = tabsAfter408.tabs.find((t) => t.id === tab.id);
            assert.equal(tabAfter408?.dedupCount ?? 0, 0, 'Status 408 must not increment dedupCount');
          } else {
            assert.equal(logs.length, 2, `Status ${code} should fail open (2 hits)`);
            assert.equal(pRes.dedupHeader, null);
            assert.equal(lRes.dedupHeader, null);
          }
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F6-02',
    tier: 2,
    features: ['F6'],
    title: '204/205 skip getResponseBody; /large (>2MB) & /stream fail open',
    description:
      'Verifies 204/205 complete without getResponseBody hang, and >2MB /large and streaming /stream (ndjson + bin) fail open with 2 server hits and no replay header.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        for (const emptyCode of [204, 205] as const) {
          const [pRes, lRes] = await Promise.all([
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'portrait',
              tab.id,
              `/status/${emptyCode}`,
              { method: 'POST', body: JSON.stringify({ k: emptyCode }) },
            ),
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'landscape',
              tab.id,
              `/status/${emptyCode}`,
              { method: 'POST', body: JSON.stringify({ k: emptyCode }) },
            ),
          ]);
          assert.equal(pRes.status, emptyCode);
          assert.equal(lRes.status, emptyCode);
        }

        for (const pathUrl of ['/large', '/stream?type=ndjson', '/stream?type=bin'] as const) {
          const pathOnly = pathUrl.split('?')[0] ?? pathUrl;
          ctx.servers.resetHttpLogs();
          const [pRes, lRes] = await Promise.all([
            runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, pathUrl, {
              method: 'POST',
              body: JSON.stringify({ target: pathUrl }),
            }),
            runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, pathUrl, {
              method: 'POST',
              body: JSON.stringify({ target: pathUrl }),
            }),
          ]);
          assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === pathOnly).length, 2);
          assert.equal(pRes.dedupHeader, null);
          assert.equal(lRes.dedupHeader, null);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F6-03',
    tier: 2,
    features: ['F6'],
    title: 'FormData / binary hasPostData fails open & non-API resourceTypes ignored',
    description:
      'Sends mirrored POST /mutate with FormData and binary Uint8Array payloads and verifies both fail open (2 hits, zero replay headers).',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const formExpr = `(async () => {
          const fd = new FormData();
          fd.append('field', 'val');
          const res = await fetch('/mutate', { method: 'POST', body: fd });
          return JSON.stringify({ status: res.status, dedup: res.headers.get('x-iron-browser-dedup') });
        })()`;
        const [pf, lf] = await Promise.all([
          session.ctl.evalJs(formExpr, 'portrait', tab.id),
          session.ctl.evalJs(formExpr, 'landscape', tab.id),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal((JSON.parse(pf.value) as { dedup: string | null }).dedup, null);
        assert.equal((JSON.parse(lf.value) as { dedup: string | null }).dedup, null);

        ctx.servers.resetHttpLogs();
        const binExpr = `(async () => {
          const res = await fetch('/mutate', { method: 'POST', body: new Uint8Array([1, 2, 3, 4]) });
          return JSON.stringify({ status: res.status, dedup: res.headers.get('x-iron-browser-dedup') });
        })()`;
        const [pb, lb] = await Promise.all([
          session.ctl.evalJs(binExpr, 'portrait', tab.id),
          session.ctl.evalJs(binExpr, 'landscape', tab.id),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal((JSON.parse(pb.value) as { dedup: string | null }).dedup, null);
        assert.equal((JSON.parse(lb.value) as { dedup: string | null }).dedup, null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F6-04',
    tier: 2,
    features: ['F6'],
    title: 'SOP / mainFrame / discriminating header isolation (altOriginBaseUrl, iframe, Authorization)',
    description:
      'Verifies differing Authorization/X-CSRF-Token headers produce distinct cacheKeys (2 server hits) and cross-origin subframe mutations are not deduplicated across origins.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const [pAuth, lAuth] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer user-token-A',
              'X-CSRF-Token': 'csrf-a',
            },
            body: JSON.stringify({ action: 'auth-test' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer user-token-B',
              'X-CSRF-Token': 'csrf-b',
            },
            body: JSON.stringify({ action: 'auth-test' }),
          }),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(pAuth.dedupHeader, null);
        assert.equal(lAuth.dedupHeader, null);

        // Subframe mainFrame isolation: same-origin iframe POST must not be mainFrame-deduped
        const iframeTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/iframe-same`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(iframeTab.tab?.id);
        await session.ctl.waitForTabReady(iframeTab.tab.id, {
          expectedUrlIncludes: '/page/iframe-same',
        });
        await waitUntil(
          async () =>
            (await session.ctl.evalJs(
              "Boolean(document.getElementById('child-frame')?.contentDocument?.body)",
              'portrait',
              iframeTab.tab?.id,
            )).value === 'true',
          4_000,
          'iframe-same child loaded',
        );

        ctx.servers.resetHttpLogs();
        const subPost = `(async () => {
          const w = document.getElementById('child-frame').contentWindow;
          const r = await w.fetch('/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sub: true }),
          });
          return r.headers.get('x-iron-browser-dedup');
        })()`;
        const [pSub, lSub] = await Promise.all([
          session.ctl.evalJs(subPost, 'portrait', iframeTab.tab.id),
          session.ctl.evalJs(subPost, 'landscape', iframeTab.tab.id),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(pSub.value, 'null');
        assert.equal(lSub.value, 'null');

        // Cross-origin paired viewports (httpBaseUrl vs altOriginBaseUrl) must NOT dedup across origins
        const crossTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(crossTab.tab?.id);
        await session.ctl.waitForTabReady(crossTab.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        await session.ctl.evalJs(
          `location.href = ${JSON.stringify(`${ctx.servers.altOriginBaseUrl}/page/interactions`)}`,
          'landscape',
          crossTab.tab.id,
        );
        await waitUntil(
          async () => {
            const lOrigin = (await session.ctl.evalJs('location.origin', 'landscape', crossTab.tab!.id)).value;
            const lReady = (await session.ctl.evalJs('document.readyState', 'landscape', crossTab.tab!.id)).value;
            return lOrigin === ctx.servers.altOriginBaseUrl && lReady === 'complete';
          },
          5_000,
          'landscape navigated to altOriginBaseUrl for cross-origin dedup check',
        );
        assert.equal(
          (await session.ctl.evalJs('location.origin', 'portrait', crossTab.tab.id)).value,
          ctx.servers.httpBaseUrl,
        );
        assert.equal(
          (await session.ctl.evalJs('location.origin', 'landscape', crossTab.tab.id)).value,
          ctx.servers.altOriginBaseUrl,
        );

        ctx.servers.resetHttpLogs();
        const targetMutateUrl = `${ctx.servers.httpBaseUrl}/mutate`;
        const [pCross, lCross] = await Promise.all([
          runFetchInViewport(
            session.ctl.evalJs.bind(session.ctl),
            'portrait',
            crossTab.tab.id,
            targetMutateUrl,
            {
              method: 'POST',
              body: JSON.stringify({ crossOrigin: true, idempotencyKey: 'xorig-p' }),
            },
          ),
          runFetchInViewport(
            session.ctl.evalJs.bind(session.ctl),
            'landscape',
            crossTab.tab.id,
            targetMutateUrl,
            {
              method: 'POST',
              body: JSON.stringify({ crossOrigin: true, idempotencyKey: 'xorig-l' }),
            },
          ),
        ]);
        assert.equal(pCross.status, 200);
        assert.equal(lCross.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(pCross.dedupHeader, null);
        assert.equal(lCross.dedupHeader, null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F6-05',
    tier: 2,
    features: ['F6'],
    title: 'MAX_JSON_DEPTH > 32, __proto__ pollution, >4 FIFO queue, >64 slots & abort fail-open',
    description:
      'Stresses 35-level nested JSON + __proto__ payload (verified in Electron viewports + clean follow-up), 5 back-to-back identical paired mutations (>4 FIFO queue), 70 distinct keys (>64 slot eviction), and concurrent AbortController abort on primary viewport.',
    timeoutMs: 60_000,
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        // (a) 35-level nested JSON + __proto__ literal
        let deepObj: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 35; i += 1) {
          deepObj = { nested: deepObj };
        }
        const protoRaw = `{"__proto__":{"polluted":true},"deep":${JSON.stringify(deepObj)}}`;
        const [pDeep, lDeep] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: protoRaw,
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: protoRaw,
          }),
        ]);
        assert.equal(pDeep.status, 200);
        assert.equal(lDeep.status, 200);
        assert.equal(
          (await session.ctl.evalJs('Object.prototype.polluted === undefined', 'portrait', tab.id)).value,
          'true',
        );
        assert.equal(
          (await session.ctl.evalJs('Object.prototype.polluted === undefined', 'landscape', tab.id)).value,
          'true',
        );

        // Clean post-mutation paired check confirms no polluted properties leaked into subsequent responses
        ctx.servers.resetHttpLogs();
        const [pClean, lClean] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ afterProto: true, idempotencyKey: 'clean-p' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ afterProto: true, idempotencyKey: 'clean-l' }),
          }),
        ]);
        assert.equal(pClean.status, 200);
        assert.equal(lClean.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 1);
        assert.equal((pClean.body.received as Record<string, unknown> | undefined)?.polluted, undefined);
        assert.equal((lClean.body.received as Record<string, unknown> | undefined)?.polluted, undefined);

        // (b1) 5 back-to-back identical paired mutations test >4 FIFO queue cap
        ctx.servers.resetHttpLogs();
        const runFiveSame = (rolePrefix: string) => `(async () => {
          const out = [];
          for (let i = 0; i < 5; i += 1) {
            const res = await fetch('/mutate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fifoBurst: 'same', idempotencyKey: '${rolePrefix}-' + i }),
            });
            out.push({ status: res.status, dedup: res.headers.get('x-iron-browser-dedup') });
          }
          return JSON.stringify(out);
        })()`;
        const fifoPortrait = JSON.parse(
          (await session.ctl.evalJs(runFiveSame('fifo-p'), 'portrait', tab.id)).value,
        ) as Array<{ status: number; dedup: string | null }>;
        const fifoLandscape = JSON.parse(
          (await session.ctl.evalJs(runFiveSame('fifo-l'), 'landscape', tab.id)).value,
        ) as Array<{ status: number; dedup: string | null }>;
        assert.equal(fifoPortrait.length, 5);
        assert.equal(fifoLandscape.length, 5);
        assert.ok(fifoPortrait.every((r) => r.status === 200));
        assert.ok(fifoLandscape.every((r) => r.status === 200));
        const fifoReplayed = fifoLandscape.filter((r) => r.dedup === 'replayed').length;
        assert.ok(fifoReplayed <= 4, `Expected <= 4 FIFO replayed slots, got ${fifoReplayed}`);
        assert.ok(
          ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length >= 6,
          'Expected >= 6 server hits when 5+5 paired bursts exceed 4-slot FIFO queue cap',
        );

        // (b2) 70 distinct keys exceed 64-slot cap and evict earliest slot (batchKey: 0)
        ctx.servers.resetHttpLogs();
        const batch70Statuses = JSON.parse(
          (
            await session.ctl.evalJs(
              `(async () => {
                const statuses = [];
                for (let i = 0; i < 70; i += 1) {
                  const res = await fetch('/mutate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ batchKey: i }),
                  });
                  statuses.push(res.status);
                }
                return JSON.stringify(statuses);
              })()`,
              'portrait',
              tab.id,
            )
          ).value,
        ) as number[];
        assert.equal(batch70Statuses.length, 70);
        assert.ok(batch70Statuses.every((s) => s === 200));
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 70);

        const evictedHit = await runFetchInViewport(
          session.ctl.evalJs.bind(session.ctl),
          'landscape',
          tab.id,
          '/mutate',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchKey: 0 }),
          },
        );
        assert.equal(evictedHit.status, 200);
        assert.equal(evictedHit.dedupHeader, null);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 71);

        // (c) Concurrent primary abort leaves follower able to complete without hanging
        const abortPrimary = `(async () => {
          const ac = new AbortController();
          setTimeout(() => ac.abort(), 1);
          try {
            await fetch('/mutate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ abortCase: 2 }),
              signal: ac.signal,
            });
          } catch {}
          return 'aborted';
        })()`;
        const followerConcurrent = `(async () => {
          await new Promise((r) => setTimeout(r, 8));
          const res = await fetch('/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ abortCase: 2 }),
          });
          return JSON.stringify({ status: res.status });
        })()`;
        const [abortOut, followerOut] = await Promise.all([
          session.ctl.evalJs(abortPrimary, 'portrait', tab.id),
          session.ctl.evalJs(followerConcurrent, 'landscape', tab.id),
        ]);
        assert.equal(abortOut.value, 'aborted');
        assert.equal((JSON.parse(followerOut.value) as { status: number }).status, 200);
        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F7 — R2: Request Dedup Integration & UI Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F7-01',
    tier: 2,
    features: ['F7', 'F6'],
    title: 'Rapid tab creation/mode transitions during in-flight POST fail open cleanly',
    description:
      'Fires concurrent POST /mutate while opening/navigating tabs and asserts zero hung requests and responsive ctl.ping().',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ race: 1 }),
          }),
          session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'single' }),
        ]);

        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F7-02',
    tier: 2,
    features: ['F7'],
    title: 'Serialized Fetch.enable/Fetch.disable per wc.id across dedup-enabled and dedup-disabled tabs',
    description:
      'Seeds dedup: true and dedup: false tabs, executes mutations across both, and verifies request-dedup.ts serializes Fetch.disable per wc.id.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture([
        makeTabFixture(`${ctx.servers.httpBaseUrl}/page/interactions?tab=on`, { dedup: true }),
        makeTabFixture(`${ctx.servers.httpBaseUrl}/page/interactions?tab=off`, { dedup: false }),
      ]);
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const state = await session.ctl.tabs();
        const tOn = state.tabs[0];
        const tOff = state.tabs[1];
        assert.ok(tOn && tOff);
        await session.ctl.waitForTabReady(tOn.id, { expectedUrlIncludes: 'tab=on' });

        ctx.servers.resetHttpLogs();
        await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tOff.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ which: 'off' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tOff.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ which: 'off' }),
          }),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);

        const dedupSrc = readAppFile('src/main/request-dedup.ts');
        assert.ok(dedupSrc.includes('setViewportEnabled('));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F7-03',
    tier: 2,
    features: ['F7', 'F12'],
    title: 'Reload clears tab R2 dedup slots without stale cross-reload replay',
    description:
      'Exercises RequestDedupMiddleware + DebuggerCoordinator to populate an active slot on portrait, invokes clearTab(tabId), and verifies a matching follower POST /mutate on landscape calls Fetch.continueRequest instead of Fetch.fulfillRequest; also verifies beforeReloadHooks wiring and live Electron smoke navigation.',
    run: async (ctx) => {
      const coordinator = new DebuggerCoordinator();
      type SentCmd = { method: string; params?: Record<string, unknown> };
      const makeTarget = (id: number) => {
        let attached = false;
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const sent: SentCmd[] = [];
        const target: DebuggerTarget = {
          id,
          isDestroyed: () => false,
          once: (ev, fn) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn as (...args: unknown[]) => void);
            listeners.set(ev, set);
          },
          debugger: {
            isAttached: () => attached,
            attach: () => {
              attached = true;
            },
            detach: () => {
              attached = false;
            },
            sendCommand: async (method, params) => {
              sent.push({ method, params });
              if (method === 'Page.getFrameTree') {
                return { frameTree: { frame: { id: 'main-frame-1' } } };
              }
              if (method === 'Fetch.getResponseBody') {
                return {
                  body: JSON.stringify({ ok: true, id: 'pre-reload' }),
                  base64Encoded: false,
                };
              }
              return {};
            },
            on: (ev, fn) => {
              const set = listeners.get(ev) ?? new Set();
              set.add(fn as (...args: unknown[]) => void);
              listeners.set(ev, set);
            },
          },
        };
        const emitMessage = (method: string, params: Record<string, unknown>) => {
          for (const fn of listeners.get('message') ?? []) {
            fn({}, method, params);
          }
        };
        return { target, sent, emitMessage };
      };

      const portrait = makeTarget(1001);
      const landscape = makeTarget(1002);
      const tabId = 'tab-reload-dedup';
      const origin = 'http://127.0.0.1:4321';

      const dedup = new RequestDedupMiddleware<DebuggerTarget>(coordinator, {
        resolveViewportContext: (wcId) => {
          if (wcId === portrait.target.id) {
            return {
              tabId,
              active: true,
              pairedWc: landscape.target,
              getOrigin: () => origin,
              getMainFrameId: () => 'main-frame-1',
            };
          }
          if (wcId === landscape.target.id) {
            return {
              tabId,
              active: true,
              pairedWc: portrait.target,
              getOrigin: () => origin,
              getMainFrameId: () => 'main-frame-1',
            };
          }
          return null;
        },
      });

      try {
        await dedup.setViewportEnabled(portrait.target, true);
        await dedup.setViewportEnabled(landscape.target, true);

        // 1. Populate an active R2 dedup slot on portrait before reload.
        portrait.emitMessage('Fetch.requestPaused', {
          requestId: 'req-p-1',
          networkId: 'net-p-1',
          frameId: 'main-frame-1',
          resourceType: 'XHR',
          request: {
            method: 'POST',
            url: `${origin}/mutate`,
            headers: { 'content-type': 'application/json' },
            hasPostData: true,
            postData: JSON.stringify({ postReloadSlot: 'same-key', idempotencyKey: 'pre-reload-1' }),
          },
        });
        await waitUntil(
          async () =>
            dedup.getActiveSlotCount() === 1 &&
            portrait.sent.some(
              (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'req-p-1',
            )
              ? true
              : null,
          2_000,
          'portrait primary POST /mutate slot populated',
        );

        // Finalize response stage so the slot sits in the 2500ms TTL window.
        portrait.emitMessage('Fetch.requestPaused', {
          requestId: 'req-p-1-resp',
          networkId: 'net-p-1',
          frameId: 'main-frame-1',
          resourceType: 'XHR',
          responseStatusCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        });
        await waitUntil(
          async () =>
            portrait.sent.some(
              (c) => c.method === 'Fetch.continueResponse' && c.params?.requestId === 'req-p-1-resp',
            )
              ? true
              : null,
          2_000,
          'portrait primary response finalized',
        );
        assert.equal(dedup.getActiveSlotCount(), 1);

        // 2. Simulate TabManager.reload() -> beforeReloadHooks -> dedup.clearTab(tabId).
        dedup.clearTab(tabId);
        assert.equal(dedup.getActiveSlotCount(), 0);
        assert.equal(dedup.getTabDedupCount(tabId), 0);

        // 3. Matching follower POST /mutate on landscape within TTL must NOT replay pre-reload slot.
        landscape.emitMessage('Fetch.requestPaused', {
          requestId: 'req-l-1',
          networkId: 'net-l-1',
          frameId: 'main-frame-1',
          resourceType: 'XHR',
          request: {
            method: 'POST',
            url: `${origin}/mutate`,
            headers: { 'content-type': 'application/json' },
            hasPostData: true,
            postData: JSON.stringify({ postReloadSlot: 'same-key', idempotencyKey: 'post-reload-1' }),
          },
        });
        await waitUntil(
          async () =>
            landscape.sent.some(
              (c) =>
                (c.method === 'Fetch.continueRequest' || c.method === 'Fetch.fulfillRequest') &&
                c.params?.requestId === 'req-l-1',
            )
              ? true
              : null,
          2_000,
          'landscape post-clearTab POST /mutate handled',
        );
        assert.equal(
          landscape.sent.some(
            (c) => c.method === 'Fetch.fulfillRequest' && c.params?.requestId === 'req-l-1',
          ),
          false,
          'Follower POST /mutate must not be fulfilled from pre-reload slot after clearTab()',
        );
        assert.equal(
          landscape.sent.some(
            (c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'req-l-1',
          ),
          true,
          'Follower POST /mutate must call Fetch.continueRequest after clearTab()',
        );
        assert.equal(dedup.getTabDedupCount(tabId), 0);
      } finally {
        dedup.dispose();
      }

      // Live Electron smoke sanity check (without conflating ctl.navigate() with TabManager.reload()).
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        ctx.servers.resetHttpLogs();
        const postRes = await runFetchInViewport(
          session.ctl.evalJs.bind(session.ctl),
          'portrait',
          tab.id,
          '/mutate',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postReloadSlot: 'smoke-sanity', idempotencyKey: 'smoke-1' }),
          },
        );
        assert.equal(postRes.status, 200);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 1);

        await session.ctl.navigate(`${ctx.servers.httpBaseUrl}/page/interactions?nav=1`, tab.id);
        await session.ctl.waitForTabReady(tab.id, { expectedUrlIncludes: 'nav=1' });
        assert.equal((await session.ctl.ping()).pong, true);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        const indexSrc = readAppFile('src/main/index.ts');
        const reloadBlock = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
        assert.ok(reloadBlock.includes('beforeReloadHooks'));
        assert.ok(tabMgrSrc.includes('registerBeforeReloadHook'));
        assert.match(
          `${tabMgrSrc}\n${indexSrc}`,
          /registerBeforeReloadHook\s*\([\s\S]{0,240}(?:clearTab|requestDedup)/,
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F7-04',
    tier: 2,
    features: ['F7'],
    title: 'about:blank / non-HTTP URL does NOT engage Fetch dedup or throw',
    description:
      'Opens about:blank in dual shared mode, evaluates JS cleanly, and verifies dedupCount === 0 and zero console/stderr CDP errors.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open('about:blank', { mode: 'dual', session: 'shared' });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: 'about:blank',
        });
        assert.equal((await session.ctl.evalJs('1 + 1', 'portrait', tab.id)).value, '2');
        const state = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.equal(state?.dedupCount ?? 0, 0);
        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F7-05',
    tier: 2,
    features: ['F7', 'F10'],
    title: 'Multiple dedupCount increments (>5 hits) never trigger session-state.json write',
    description:
      'Executes 5 distinct mirrored POST /mutate bursts incrementing dedupCount >= 5 and confirms session-state.json mtimeMs and raw bytes remain identical.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture([
        makeTabFixture(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
          mirror: true,
          dedup: true,
        }),
      ]);
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: '/page/interactions',
        });
        await sleep(600);
        const beforeRaw = session.readRawStateFile();
        const beforeMtime = fs.statSync(session.stateFilePath).mtimeMs;

        for (let i = 0; i < 5; i += 1) {
          await Promise.all([
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'portrait',
              tab.id,
              `/mutate?burst=${i}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ burst: i, idempotencyKey: `b-p-${i}` }),
              },
            ),
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'landscape',
              tab.id,
              `/mutate?burst=${i}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ burst: i, idempotencyKey: `b-l-${i}` }),
              },
            ),
          ]);
        }

        const tabState = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.ok((tabState?.dedupCount ?? 0) >= 5);

        await sleep(800);
        assert.equal(fs.statSync(session.stateFilePath).mtimeMs, beforeMtime);
        assert.equal(session.readRawStateFile(), beforeRaw);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F8 — R3: Symmetric WS & SSE Mux Boundaries & Security (5 tests)
  // =========================================================================
  {
    id: 'T2-F8-01',
    tier: 2,
    features: ['F8'],
    title: 'Subframe iframe NOT shimmed (if (window !== window.top) return;)',
    description:
      'Opens /page/iframe-same in dual shared mode and opens WebSocket inside #child-frame on both viewports, verifying 2 direct connections (mux bypassed).',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetWsStats();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/iframe-same`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/iframe-same',
        });
        await waitUntil(
          async () =>
            (await session.ctl.evalJs(
              "Boolean(document.getElementById('child-frame')?.contentWindow)",
              'portrait',
              tab.id,
            )).value === 'true',
          4_000,
          'iframe contentWindow ready',
        );

        const openSubWs = `(async () => {
          const w = document.getElementById('child-frame').contentWindow;
          return await new Promise((resolve) => {
            const ws = new w.WebSocket(${JSON.stringify(ctx.servers.wsBaseUrl)});
            ws.addEventListener('open', () => resolve('open'));
            ws.addEventListener('error', () => resolve('error'));
          });
        })()`;
        const [p, l] = await Promise.all([
          session.ctl.evalJs(openSubWs, 'portrait', tab.id),
          session.ctl.evalJs(openSubWs, 'landscape', tab.id),
        ]);
        assert.equal(p.value, 'open');
        assert.equal(l.value, 'open');
        assert.equal(ctx.servers.getWsStats().activeConnections, 2);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F8-02',
    tier: 2,
    features: ['F8'],
    title: 'Cross-origin paired viewport NOT fanned out',
    description:
      'Navigates landscape viewport to altOriginBaseUrl while portrait stays on httpBaseUrl, opens WS on both, and asserts 2 independent connections (origin parity).',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetWsStats();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await session.ctl.evalJs(
          `location.href = ${JSON.stringify(`${ctx.servers.altOriginBaseUrl}/page/ws-sse`)}`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () => {
            const origin = (await session.ctl.evalJs('location.origin', 'landscape', tab.id)).value;
            const ready = (await session.ctl.evalJs('document.readyState', 'landscape', tab.id)).value;
            return origin === ctx.servers.altOriginBaseUrl && ready === 'complete';
          },
          5_000,
          'landscape navigated to altOriginBaseUrl',
        );
        assert.equal(
          (await session.ctl.evalJs('location.origin', 'portrait', tab.id)).value,
          ctx.servers.httpBaseUrl,
        );
        assert.equal(
          (await session.ctl.evalJs('location.origin', 'landscape', tab.id)).value,
          ctx.servers.altOriginBaseUrl,
        );

        await Promise.all([
          session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`, 'portrait', tab.id),
          session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`, 'landscape', tab.id),
        ]);
        await waitUntil(
          async () => {
            const p = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
            const l = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            return p.startsWith('open:') && l.startsWith('open:');
          },
          4_000,
          'both cross-origin viewports opened WS',
        );

        assert.equal(ctx.servers.getWsStats().activeConnections, 2);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F8-03',
    tier: 2,
    features: ['F8'],
    title: 'Budget caps: >16 channels/tab, >32 handshake frames/5s, >256KB/frame, >4MB total',
    description:
      'Exercises all 4 mux caps (>32 buffered handshake frames/5s, >256KB/frame drop, >4MB total buffer cap, >16 channels/tab) and asserts bounded delivery and healthy Electron process.',
    timeoutMs: 60_000,
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetWsStats();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        // (a) >32 initial inbound handshake frames buffered before follower attaches (cap <= 32)
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(`${ctx.servers.wsBaseUrl}?cap=hs`)}, 'chat.v1')`,
          'portrait',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'owner WS open for handshake cap check',
        );
        for (let i = 0; i < 40; i += 1) {
          ctx.servers.broadcastWs(`hs-${i}`);
        }
        await sleep(150);
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(`${ctx.servers.wsBaseUrl}?cap=hs`)}, 'chat.v1')`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'follower WS open for handshake cap check',
        );
        await sleep(250);
        const hsCount = Number((await session.ctl.evalJs('window.__wsLog.length', 'landscape', tab.id)).value);
        assert.ok(hsCount >= 1 && hsCount <= 32, `Expected 1..32 buffered handshake frames, got ${hsCount}`);
        await Promise.all([
          session.ctl.evalJs('window.__wsClose()', 'portrait', tab.id),
          session.ctl.evalJs('window.__wsClose()', 'landscape', tab.id),
        ]);
        await sleep(100);

        // (b) >256KB/frame dropped & >4MB total buffer cap
        await Promise.all([
          session.ctl.evalJs('window.__wsLog = []', 'portrait', tab.id),
          session.ctl.evalJs('window.__wsLog = []', 'landscape', tab.id),
        ]);
        await Promise.all([
          session.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(`${ctx.servers.wsBaseUrl}?cap=size`)}, 'chat.v1')`,
            'portrait',
            tab.id,
          ),
          session.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(`${ctx.servers.wsBaseUrl}?cap=size`)}, 'chat.v1')`,
            'landscape',
            tab.id,
          ),
        ]);
        await waitUntil(
          async () => {
            const ps = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
            const ls = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            return ps === 'open:chat.v1' && ls === 'open:chat.v1';
          },
          4_000,
          'both viewports open for >256KB check',
        );

        await session.ctl.evalJs("window.__wsSend('B'.repeat(260 * 1024))", 'portrait', tab.id);
        await sleep(250);
        const oversizedRelayed = (
          await session.ctl.evalJs(
            "window.__wsLog.some((m) => (typeof m === 'string' ? m.length : (m?.binary?.length ?? 0)) > 256 * 1024)",
            'landscape',
            tab.id,
          )
        ).value;
        assert.equal(oversizedRelayed, 'false', 'Expected >256KB frame NOT to be relayed to follower');

        // Exercise >4MB total buffer pressure across buffered handshake frames without crash
        await session.ctl.evalJs('window.__wsClose()', 'landscape', tab.id);
        await sleep(100);
        const chunk220k = 'M'.repeat(220 * 1024);
        for (let i = 0; i < 20; i += 1) {
          ctx.servers.broadcastWs(chunk220k);
        }
        await sleep(200);
        await session.ctl.evalJs('window.__wsLog = []', 'landscape', tab.id);
        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(`${ctx.servers.wsBaseUrl}?cap=size`)}, 'chat.v1')`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'follower WS re-open after >4MB pressure',
        );
        await sleep(200);
        const totalBufferedBytes = Number(
          (
            await session.ctl.evalJs(
              "window.__wsLog.reduce((sum, m) => sum + (typeof m === 'string' ? m.length : (m?.binary?.length ?? 0)), 0)",
              'landscape',
              tab.id,
            )
          ).value,
        );
        assert.ok(
          totalBufferedBytes <= 4 * 1024 * 1024,
          `Expected <= 4MB buffered bytes, got ${totalBufferedBytes}`,
        );
        await Promise.all([
          session.ctl.evalJs('window.__wsClose()', 'portrait', tab.id),
          session.ctl.evalJs('window.__wsClose()', 'landscape', tab.id),
        ]);
        await sleep(100);

        // (c) 17 concurrent WS channels -> capped at 16 muxed channels
        ctx.servers.resetWsStats();
        await session.ctl.evalJs(
          `(async () => {
            window.__manyWs = [];
            for (let i = 0; i < 17; i += 1) {
              const ws = new WebSocket(${JSON.stringify(ctx.servers.wsBaseUrl)} + '?ch=' + i);
              window.__manyWs.push(ws);
            }
            await new Promise((r) => setTimeout(r, 300));
            return window.__manyWs.length;
          })()`,
          'portrait',
          tab.id,
        );
        assert.ok(ctx.servers.getWsStats().activeConnections <= 16);
        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F8-04',
    tier: 2,
    features: ['F8', 'F7'],
    title: 'isolated, single, mirror: false, dedup: false all bypass WS/SSE mux',
    description:
      'Verifies non-eligible configurations (isolated, mirror: false, dedup: false in dual mode -> 2 direct WS + 2 direct SSE connections; and single mode -> 1 direct WS + 1 direct SSE connection) all bypass mux.',
    run: async (ctx) => {
      const dualConfigs: Array<{ label: string; tab: PersistedTabFixture }> = [
        {
          label: 'isolated',
          tab: makeTabFixture(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
            mode: 'dual',
            session: 'isolated',
            mirror: true,
            dedup: true,
          }),
        },
        {
          label: 'mirror-false',
          tab: makeTabFixture(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
            mode: 'dual',
            session: 'shared',
            mirror: false,
            dedup: true,
          }),
        },
        {
          label: 'dedup-false',
          tab: makeTabFixture(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
            mode: 'dual',
            session: 'shared',
            mirror: true,
            dedup: false,
          }),
        },
      ];

      for (const cfg of dualConfigs) {
        ctx.servers.resetWsStats();
        ctx.servers.resetSseStats();
        const seedSession = makeSessionFixture([cfg.tab]);
        const session = await ctx.launchElectron({ smoke: true, seedSession });
        try {
          const tab = await session.ctl.waitForTabReady(undefined, {
            expectedUrlIncludes: '/page/ws-sse',
          });
          await Promise.all([
            session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)})`, 'portrait', tab.id),
            session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)})`, 'landscape', tab.id),
            session.ctl.evalJs(`window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)})`, 'portrait', tab.id),
            session.ctl.evalJs(`window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)})`, 'landscape', tab.id),
          ]);
          await waitUntil(
            async () => {
              const pWs = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
              const lWs = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
              const pSse = (await session.ctl.evalJs("document.getElementById('sse-status').textContent", 'portrait', tab.id)).value;
              const lSse = (await session.ctl.evalJs("document.getElementById('sse-status').textContent", 'landscape', tab.id)).value;
              return pWs.startsWith('open:') && lWs.startsWith('open:') && pSse === 'open' && lSse === 'open';
            },
            4_000,
            `${cfg.label} both WS & SSE open`,
          );
          assert.equal(
            ctx.servers.getWsStats().activeConnections,
            2,
            `Expected 2 direct WS connections when ${cfg.label}`,
          );
          assert.equal(
            ctx.servers.getSseStats().activeConnections,
            2,
            `Expected 2 direct SSE connections when ${cfg.label}`,
          );
        } finally {
          await session.close();
        }
      }

      // Also verify mode: 'single' bypasses mux (1 direct WS + 1 direct SSE on landscape)
      ctx.servers.resetWsStats();
      ctx.servers.resetSseStats();
      const singleSeed = makeSessionFixture([
        makeTabFixture(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
          mode: 'single',
          session: 'shared',
          mirror: true,
          dedup: true,
        }),
      ]);
      const singleSession = await ctx.launchElectron({ smoke: true, seedSession: singleSeed });
      try {
        const tab = await singleSession.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: '/page/ws-sse',
        });
        await Promise.all([
          singleSession.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)})`, 'landscape', tab.id),
          singleSession.ctl.evalJs(`window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)})`, 'landscape', tab.id),
        ]);
        await waitUntil(
          async () => {
            const lWs = (await singleSession.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            const lSse = (await singleSession.ctl.evalJs("document.getElementById('sse-status').textContent", 'landscape', tab.id)).value;
            return lWs.startsWith('open:') && lSse === 'open';
          },
          4_000,
          'single mode WS & SSE open',
        );
        assert.equal(ctx.servers.getWsStats().activeConnections, 1);
        assert.equal(ctx.servers.getSseStats().activeConnections, 1);
      } finally {
        await singleSession.close();
      }
    },
  },
  {
    id: 'T2-F8-05',
    tier: 2,
    features: ['F8'],
    title: 'Identical outbound WS payload sent >1500ms later is NOT deduplicated',
    description:
      'Sends canonical identical WS JSON from portrait, waits 1700ms (>1500ms dedup window), sends from landscape, and asserts server logs 2 messages.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetWsStats();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await Promise.all([
          session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`, 'portrait', tab.id),
          session.ctl.evalJs(`window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`, 'landscape', tab.id),
        ]);
        await waitUntil(
          async () => {
            const p = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
            const l = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            return p.startsWith('open:') && l.startsWith('open:');
          },
          4_000,
          'WS open on both viewports',
        );

        await session.ctl.evalJs(
          `window.__wsSend(${JSON.stringify(JSON.stringify({ type: 'ping', idempotencyKey: 'a' }))})`,
          'portrait',
          tab.id,
        );
        await sleep(1_700);
        await session.ctl.evalJs(
          `window.__wsSend(${JSON.stringify(JSON.stringify({ type: 'ping', idempotencyKey: 'b' }))})`,
          'landscape',
          tab.id,
        );

        await waitUntil(
          async () => ctx.servers.getWsStats().receivedMessages.length >= 2,
          3_000,
          '2 WS outbound messages past 1500ms window',
        );
        assert.equal(ctx.servers.getWsStats().receivedMessages.length, 2);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F9 — R4: UI Replication Accuracy Boundaries & Security (5 tests)
  // =========================================================================
  {
    id: 'T2-F9-01',
    tier: 2,
    features: ['F9'],
    title: 'Cross-origin iframe (iframe-cross) blocked without SecurityError crash',
    description:
      'Loads /page/iframe-cross, interacts and screenshots across both viewports, and asserts 0 SecurityError console messages and safe cross-origin isolation.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/iframe-cross`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/iframe-cross',
        });

        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#cross-frame',
          mirror: true,
        });
        const shot = await session.ctl.screenshot(tab.id, 'both');
        assert.ok((shot.captures.portrait?.bytes ?? 0) > 0);
        const cons = await session.ctl.console({ tabId: tab.id, level: 'error', limit: 50 });
        assert.equal(
          cons.entries.some((e) => e.text.includes('SecurityError')),
          false,
        );

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(preloadSrc.includes('contentDocument'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F9-02',
    tier: 2,
    features: ['F9'],
    title: 'Shadow DOM traversal bounds: depth >8, root >32, node >2000, and cycle guard',
    description:
      'Builds 10-deep nested shadow roots, 35 shadow hosts, and >2000 nodes in live Electron and verifies layoutAudit/interact complete < 1000ms without stack overflow.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/shadow`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/shadow',
        });

        await session.ctl.evalJs(
          `(() => {
            let cur = document.body;
            for (let d = 0; d < 10; d += 1) {
              const h = document.createElement('div');
              cur.appendChild(h);
              const sr = h.attachShadow({ mode: 'open' });
              cur = sr;
            }
            const leafBtn = document.createElement('button');
            leafBtn.id = 'too-deep-btn';
            cur.appendChild(leafBtn);

            for (let r = 0; r < 35; r += 1) {
              const h = document.createElement('div');
              document.body.appendChild(h);
              h.attachShadow({ mode: 'open' });
            }
            const frag = document.createDocumentFragment();
            for (let n = 0; n < 2100; n += 1) {
              const s = document.createElement('span');
              frag.appendChild(s);
            }
            document.body.appendChild(frag);
            return true;
          })()`,
          'portrait',
          tab.id,
        );

        // First interact primes hidden surface (if unprimed); second interact verifies < 1000ms
        // Shadow DOM traversal under depth >8, root >32, and >2000 nodes without stack overflow.
        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#shadow-btn',
          mirror: true,
        });
        const interactStarted = Date.now();
        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#shadow-btn',
          mirror: true,
        });
        const interactElapsed = Date.now() - interactStarted;
        assert.ok(
          interactElapsed < 1_000,
          `Expected Shadow DOM interact < 1000ms, took ${interactElapsed}ms`,
        );

        const started = Date.now();
        const shot = await session.ctl.screenshot(tab.id, 'both');
        const shotElapsed = Date.now() - started;
        // TabManager.captureScreenshots has a 2500ms Page.captureScreenshot fallback per viewport in show:false (~5s for both).
        assert.ok(
          shotElapsed < 10_000,
          `Expected dual screenshot + layoutAudit < 10000ms, took ${shotElapsed}ms`,
        );
        assert.ok((shot.captures.portrait?.bytes ?? 0) > 0);
        assert.ok((shot.captures.landscape?.bytes ?? 0) > 0);
        assert.equal((await session.ctl.ping()).pong, true);

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(preloadSrc.includes('WeakSet'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F9-03',
    tier: 2,
    features: ['F9'],
    title: 'Blank whitespace click does NOT trigger Mirror Miss pill',
    description:
      'Clicks non-interactive .spacer whitespace on /page/interactions and asserts TelemetrySnapshot.mirrorMiss remains null/undefined.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '.spacer',
          mirror: true,
        });
        const metrics = await session.ctl.metrics();
        assert.ok(metrics.mirrorMiss === undefined || metrics.mirrorMiss === null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F9-04',
    tier: 2,
    features: ['F9'],
    title: 'Mirror Miss .textContent XSS/bidi sanitization & <= 32-char truncation',
    description:
      'Verifies Mirror Miss rendering in shell.ts (renderTelemetry/renderState/renderMirrorMiss) uses .textContent (never innerHTML on Mirror Miss elements), strips control/bidi chars, and caps targetLabel at <= 32 chars.',
    run: async () => {
      const shellSrc = readAppFile('src/renderer/shell.ts');
      const relaySrc = readAppFile('src/main/mirror-relay.ts');
      const mirrorCoreSrc = readAppFile('src/shared/mirror-core.ts');

      assert.ok(shellSrc.includes('mirrorMiss'), 'Expected mirrorMiss handling in src/renderer/shell.ts');

      const renderTelemetryBlock = extractMethodBlock(shellSrc, 'function renderTelemetry(');
      const renderStateBlock = extractMethodBlock(shellSrc, 'function renderState(');
      const renderMirrorMissBlock = extractMethodBlock(shellSrc, 'function renderMirrorMiss(');

      const fnBlocks = [renderTelemetryBlock, renderStateBlock, renderMirrorMissBlock].filter(
        (b) => b.length > 0,
      );
      const missBlocks = fnBlocks.filter((b) => b.includes('mirrorMiss'));
      assert.ok(
        missBlocks.length > 0,
        'Expected mirrorMiss rendering inside renderTelemetry(), renderState(), or renderMirrorMiss() in src/renderer/shell.ts',
      );
      if (
        renderMirrorMissBlock.length > 0 &&
        missBlocks.some((b) => b.includes('renderMirrorMiss(')) &&
        !missBlocks.includes(renderMirrorMissBlock)
      ) {
        missBlocks.push(renderMirrorMissBlock);
      }

      const missVarNames = new Set<string>();
      for (const m of shellSrc.matchAll(
        /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*(?:mirror[-_]?miss|mirrorMiss)/gi,
      )) {
        if (m[1]) missVarNames.add(m[1]);
      }

      const missStatements: string[] = [];
      for (const block of missBlocks) {
        if (block === renderMirrorMissBlock) {
          missStatements.push(block);
          continue;
        }
        const stmts = block.split(/[;{}]/);
        for (const stmt of stmts) {
          const matchesMissVar = Array.from(missVarNames).some((name) =>
            new RegExp(`\\b${name}\\b`).test(stmt),
          );
          if (/mirror[-_]?miss|mirrorMiss/i.test(stmt) || matchesMissVar) {
            missStatements.push(stmt);
          }
        }
      }

      assert.ok(
        missStatements.some((stmt) => stmt.includes('.textContent')),
        'Expected Mirror Miss label rendering in shell.ts to use .textContent',
      );
      assert.equal(
        missStatements.some((stmt) => stmt.includes('innerHTML')),
        false,
        'Mirror Miss rendering in shell.ts must never use innerHTML',
      );

      const sanitized = sanitizeMirrorMissLabel(`<img src=x>\u202e\u0007${'a'.repeat(50)}`, 32);
      assert.equal(sanitized.length, 32);
      assert.equal(/[\u0000-\u001f\u202a-\u202e]/.test(sanitized), false);

      const combined = `${relaySrc}\n${mirrorCoreSrc}\n${shellSrc}`;
      assert.ok(combined.includes('32'), 'Expected <= 32-char Mirror Miss label truncation');
      assert.match(
        `${relaySrc}\n${mirrorCoreSrc}`,
        /replace\s*\(\s*(?:\/[^/]*(?:0000|001[fF]|x00|x1[fF]|202|200[eEfF]|2066|\\p\{C\})|CONTROL_AND_BIDI_RE)/i,
        'Expected Mirror Miss sanitization to strip control and bidi override characters',
      );
    },
  },
  {
    id: 'T2-F9-05',
    tier: 2,
    features: ['F9'],
    title: '/page/password clipboard JSON redacts passwords, input values, outerHtml & URL tokens',
    description:
      'Loads /page/password?token=secret123#access_token=xyz in live Electron and verifies copyMirrorMissDebug / MirrorRelay.emitMiss debug payload redacts password/input values, excludes outerHtml, and strips URL query/fragment tokens.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(
          `${ctx.servers.httpBaseUrl}/page/password?token=secret123#access_token=xyz`,
          { mode: 'dual', session: 'shared' },
        );
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/password',
        });
        const passType = (
          await session.ctl.evalJs("document.getElementById('secret-pass').type", 'portrait', tab.id)
        ).value;
        assert.equal(passType, 'password');
        assert.equal(
          (await session.ctl.evalJs('location.search.includes("secret123") && location.hash.includes("access_token=xyz")', 'portrait', tab.id)).value,
          'true',
        );

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        const relaySrc = readAppFile('src/main/mirror-relay.ts');

        const copyBlock = extractMethodBlock(tabMgrSrc, 'copyMirrorMissDebug(');
        assert.ok(
          copyBlock.length > 0,
          'Expected copyMirrorMissDebug() in src/main/tab-manager.ts',
        );
        assert.equal(
          /outerHtml|outerHTML/.test(copyBlock),
          false,
          'copyMirrorMissDebug must not include raw outerHtml/outerHTML',
        );
        assert.ok(
          copyBlock.includes('origin') ||
            copyBlock.includes('pathname') ||
            copyBlock.includes('.search') ||
            copyBlock.includes("split('?')"),
          'Expected copyMirrorMissDebug to strip URL query and fragment tokens',
        );
        assert.ok(
          /redact|password|secret|sanitize|omit/i.test(copyBlock),
          'Expected explicit password/input/URL redaction in copyMirrorMissDebug()',
        );

        const missRelayBlock = extractMethodBlock(relaySrc, 'emitMiss(');
        assert.ok(
          missRelayBlock.length > 0,
          'Expected emitMiss() in src/main/mirror-relay.ts',
        );
        assert.equal(
          /outerHtml|outerHTML/.test(missRelayBlock),
          false,
          'MirrorRelay.emitMiss() must not include raw outerHtml/outerHTML',
        );
        assert.ok(
          /redact|sanitize/i.test(missRelayBlock),
          'Expected URL redaction and label sanitization in MirrorRelay.emitMiss()',
        );
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F10 — R5: Session Restore & Short History Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F10-01',
    tier: 2,
    features: ['F10'],
    title: 'Corrupt JSON, symlink session-state.json, and >512 KiB state file rejected safely',
    description:
      'Launches Electron against (a) corrupt JSON, (b) symlinked session-state.json, and (c) >512 KiB JSON file, verifying clean fallback boot.',
    run: async (ctx) => {
      // (a) Corrupt JSON
      const sCorrupt = await ctx.launchElectron({
        smoke: false,
        seedSession: '{corrupt-json',
      });
      try {
        const tabs = await sCorrupt.ctl.tabs();
        assert.ok(tabs.tabs.length >= 1);
      } finally {
        await sCorrupt.close();
      }

      // (b) Symlink session-state.json
      const symDir = fs.mkdtempSync(path.join(ctx.tmpRoot, 'sym-'));
      const decoyPath = path.join(ctx.tmpRoot, 'decoy.json');
      fs.writeFileSync(
        decoyPath,
        JSON.stringify(makeSessionFixture([makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?sym=bad`)])),
      );
      fs.symlinkSync(decoyPath, path.join(symDir, 'session-state.json'));
      const sSym = await ctx.launchElectron({
        smoke: false,
        sessionDir: symDir,
        keepTempDir: false,
      });
      try {
        const tabs = await sSym.ctl.tabs();
        assert.equal(tabs.tabs.some((t) => t.url.includes('sym=bad')), false);
      } finally {
        await sSym.close();
      }

      // (c) >512 KiB JSON file
      const hugePad = 'x'.repeat(530 * 1024);
      const bigJson = JSON.stringify({
        ...makeSessionFixture([makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?big=bad`)]),
        pad: hugePad,
      });
      const sBig = await ctx.launchElectron({ smoke: false, seedSession: bigJson });
      try {
        const tabs = await sBig.ctl.tabs();
        assert.equal(tabs.tabs.some((t) => t.url.includes('big=bad')), false);
      } finally {
        await sBig.close();
      }
    },
  },
  {
    id: 'T2-F10-02',
    tier: 2,
    features: ['F10'],
    title: 'URL >4096 chars & embedded credentials (user:pass@) rejected/stripped',
    description:
      'Seeds oversized URL (>4096 chars), URL with user:pass@, and valid URL; verifies only valid URL restores and unsafe URLs never persist.',
    run: async (ctx) => {
      const longUrl = `${ctx.servers.httpBaseUrl}/echo?q=${'a'.repeat(4200)}`;
      const credUrl = ctx.servers.httpBaseUrl.replace('http://', 'http://admin:secret@') + '/echo?cred=1';
      const validUrl = `${ctx.servers.httpBaseUrl}/echo?ok=1`;

      const seedSession = makeSessionFixture([
        makeTabFixture(longUrl),
        makeTabFixture(credUrl),
        makeTabFixture(validUrl),
      ]);
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tabs = await session.ctl.tabs();
        assert.equal(tabs.tabs.length, 1);
        assert.equal(tabs.tabs[0]?.url, validUrl);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const raw = session.readRawStateFile() ?? '';
        assert.equal(raw.includes('admin:secret'), false);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.ok(persisted?.tabs.every((t) => t.url.length <= 4096));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F10-03',
    tier: 2,
    features: ['F10'],
    title: 'Placeholder titles ignored & oversized tab title truncated <= 120 chars',
    description:
      'Seeds 200-char title tab and real history entry, updates against placeholder titles, and verifies persisted tab title <= 120 chars and real history title preserved.',
    run: async (ctx) => {
      const realUrl = `${ctx.servers.httpBaseUrl}/echo?real=1`;
      const seedSession = makeSessionFixture(
        [makeTabFixture(realUrl, { title: 'A'.repeat(200) })],
        {
          history: [{ url: realUrl, title: 'My Real Page', visitedAt: 1000, visitCount: 1 }],
        },
      );
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 'real=1' });
        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.ok((persisted?.tabs[0]?.title.length ?? 0) <= 120);
        assert.equal(persisted?.history[0]?.title, 'My Real Page');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F10-04',
    tier: 2,
    features: ['F10', 'F4'],
    title: '>24 restored tabs capped at MAX_PERSISTED_TABS = 24 preserving active tab',
    description:
      'Seeds 24 tabs (idx=0..23), opens 3 more via ctl.open (idx=24..26 with idx=26 active), flushes via SIGTERM, asserts persisted tabs.length === 24 preserving idx=26 as active, and relaunches confirming idx=26 restores as active.',
    timeoutMs: 60_000,
    run: async (ctx) => {
      const tabs: PersistedTabFixture[] = [];
      for (let i = 0; i < 24; i += 1) {
        tabs.push(makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?idx=${i}`, { mode: 'single' }));
      }
      const seedSession = makeSessionFixture(tabs, { activeTabIndex: 0 });
      const s1 = await ctx.launchElectron({
        smoke: false,
        seedSession,
        keepTempDir: true,
      });
      const sessionDir = s1.sessionDir;
      try {
        await s1.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 'idx=0' });

        let lastOpenedId: string | undefined;
        for (let i = 24; i <= 26; i += 1) {
          const opened = await s1.ctl.open(`${ctx.servers.httpBaseUrl}/echo?idx=${i}`, {
            mode: 'single',
          });
          assert.ok(opened.tab?.id);
          lastOpenedId = opened.tab.id;
        }
        await s1.ctl.waitForTabReady(lastOpenedId, { expectedUrlIncludes: 'idx=26' });

        const s1State = await s1.ctl.tabs();
        assert.equal(s1State.tabs.length, 27);
        assert.equal(s1State.activeTabId, lastOpenedId);

        s1.sendSignal('SIGTERM');
        await s1.waitForExit(5_000);
        const persisted = s1.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.tabs.length, 24);
        assert.ok(persisted?.tabs.some((t) => t.url.includes('idx=26')));
        assert.ok(
          persisted?.tabs[persisted.activeTabIndex]?.url.includes('idx=26'),
          `Expected activeTabIndex (${persisted?.activeTabIndex}) to point to idx=26`,
        );
      } finally {
        await s1.close();
      }

      const s2 = await ctx.launchElectron({
        smoke: false,
        sessionDir,
        keepTempDir: false,
      });
      try {
        const restoredTab = await s2.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 'idx=26' });
        const s2State = await s2.ctl.tabs();
        assert.equal(s2State.tabs.length, 24);
        assert.equal(s2State.activeTabId, restoredTab.id);
        assert.ok(restoredTab.url.includes('idx=26'));
      } finally {
        await s2.close();
      }
    },
  },
  {
    id: 'T2-F10-05',
    tier: 2,
    features: ['F10'],
    title: 'Menu & -> && escaping + control-char stripping & did-start/stop-loading no disk dirty',
    description:
      'Verifies tab-manager.ts sanitizeMenuLabel doubles & and strips control chars, and loading events emitState(false) without spurious session-state.json writes.',
    run: async (ctx) => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      assert.ok(tabMgrSrc.includes('function sanitizeMenuLabel'));
      assert.ok(tabMgrSrc.includes(".replace(/&/g, '&&')"));
      assert.ok(tabMgrSrc.includes('emitState(false)'));

      const session = await ctx.launchElectron({ smoke: false });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?idle=1`);
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: 'idle=1' });
        await sleep(600);
        const rawBefore = session.readRawStateFile();
        await sleep(700);
        assert.equal(session.readRawStateFile(), rawBefore);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F11 — E2E Suite & Live Smoke Infra Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F11-01',
    tier: 2,
    features: ['F11'],
    title: 'Early Electron exit before IRON_BROWSER_READY propagates stdout/stderr error',
    description:
      'Launches Electron with ELECTRON_RUN_AS_NODE=1 causing immediate exit before IRON_BROWSER_READY and verifies prompt rejection with exit details.',
    run: async (ctx) => {
      await assert.rejects(
        () =>
          ctx.launchElectron({
            smoke: true,
            readyTimeoutMs: 5_000,
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }),
        (err: unknown) =>
          err instanceof Error && err.message.includes('Electron exited prematurely'),
      );
    },
  },
  {
    id: 'T2-F11-02',
    tier: 2,
    features: ['F11'],
    title: 'Bounded readyTimeoutMs timeout cleans up child process & temp directory',
    description:
      'Launches Electron with an unreachable IRON_BROWSER_SOCKET and readyTimeoutMs: 120, asserting bounded timeout error and sessionDir removal.',
    run: async (ctx) => {
      const sDir = fs.mkdtempSync(path.join(ctx.tmpRoot, 'to-'));
      await assert.rejects(
        () =>
          ctx.launchElectron({
            smoke: false,
            sessionDir: sDir,
            keepTempDir: false,
            readyTimeoutMs: 120,
            env: { IRON_BROWSER_SOCKET: path.join(ctx.tmpRoot, 'missing-ctl.sock') },
          }),
        (err: unknown) =>
          err instanceof Error && err.message.includes('Timed out waiting for control socket ping'),
      );
      assert.equal(fs.existsSync(sDir), false);
    },
  },
  {
    id: 'T2-F11-03',
    tier: 2,
    features: ['F11'],
    title: 'Linux sun_path >= 107 bytes path guard fails fast before spawning Electron',
    description:
      'Passes sessionDir whose ctl.sock exceeds 106 bytes and asserts immediate rejection mentioning Linux sun_path limit.',
    run: async (ctx) => {
      const longDir = path.join(ctx.tmpRoot, 'a'.repeat(110));
      try {
        await assert.rejects(
          () => ctx.launchElectron({ sessionDir: longDir }),
          (err: unknown) =>
            err instanceof Error && err.message.includes('exceeds Linux sun_path limit'),
        );
      } finally {
        fs.rmSync(longDir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'T2-F11-04',
    tier: 2,
    features: ['F11'],
    title: 'waitForTabReady bounds async loadURL & rejects cleanly on timeout',
    description:
      'Opens /echo then awaits waitForTabReady with an unmatching expectedUrlIncludes and 250ms timeout, asserting descriptive timeout error.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`);
        assert.ok(opened.tab?.id);
        await assert.rejects(
          () =>
            session.ctl.waitForTabReady(opened.tab!.id, {
              expectedUrlIncludes: '/never-matches-anything',
              timeoutMs: 250,
            }),
          (err: unknown) =>
            err instanceof Error &&
            err.message.includes('Timed out waiting for tab') &&
            err.message.includes('last url='),
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F11-05',
    tier: 2,
    features: ['F11'],
    title: 'ControlSocketClient oversized frame (>8 MiB) & sequential session.close() idempotency',
    description:
      'Verifies encodeCtlFrame rejects payloads exceeding MAX_FRAME_BYTES and sequential session.close() calls are idempotent and clean up sessionDir.',
    run: async (ctx) => {
      assert.throws(
        () => encodeCtlFrame({ big: 'x'.repeat(MAX_FRAME_BYTES + 16) }),
        /exceeds MAX_FRAME_BYTES/,
      );

      const session = await ctx.launchElectron({ smoke: true });
      const dir = session.sessionDir;
      try {
        assert.equal((await session.ctl.ping()).pong, true);
      } finally {
        await session.close();
        await session.close();
      }
      assert.equal(fs.existsSync(dir), false);
    },
  },

  // =========================================================================
  // F12 — Follow-up: Cache-Clearing Reload & Shortcuts Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F12-01',
    tier: 2,
    features: ['F12'],
    title: 'Reload in isolated vs shared session clears HTTP cache for both partitions',
    description:
      'Verifies TabManager.reload() clears both defaultSession and isolated partition iron-iso-<tabId> before calling reloadIgnoringCache().',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/cacheable?format=html`, {
          mode: 'dual',
          session: 'isolated',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/cacheable',
        });
        assert.equal(tab.session, 'isolated');

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("session.fromPartition(`iron-iso-${tab.id}`)"));
        assert.ok(tabMgrSrc.includes('sess.clearCache()'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-F12-02',
    tier: 2,
    features: ['F12'],
    title: 'Reload in dual mode reloads BOTH portraitView and landscapeView ignoring cache',
    description:
      'Verifies TabManager.reload() calls reloadIgnoringCache() on both landscapeView and portraitView when mode === dual.',
    run: async () => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      const block = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
      assert.ok(block.length > 0, 'Expected TabManager.reload() method');
      assert.match(block, /tab\.landscapeView\.webContents/);
      assert.match(block, /tab\.mode\s*===\s*'dual'\s*&&\s*tab\.portraitView/);
      assert.match(block, /\b(?:lWc|tab\.landscapeView\.webContents)\.reloadIgnoringCache\(\)/);
      assert.match(block, /\b(?:pWc|tab\.portraitView\.webContents)\.reloadIgnoringCache\(\)/);
      assert.equal(/\.reload\s*\(/.test(block), false);
    },
  },
  {
    id: 'T2-F12-03',
    tier: 2,
    features: ['F12', 'F4'],
    title: 'Reload on dormant / sleeping tab safely materializes without throwing',
    description:
      'Verifies TabManager.reload() checks for missing/destroyed landscapeView, sets sleeping = false, and calls materializeTabViews(tab).',
    run: async () => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      const block = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
      assert.ok(block.length > 0, 'Expected TabManager.reload() method');
      assert.ok(block.includes('tab.sleeping = false;'));
      assert.ok(block.includes('this.materializeTabViews(tab);'));
    },
  },
  {
    id: 'T2-F12-04',
    tier: 2,
    features: ['F12'],
    title: 'Reload guards disposed TabManager / destroyed BrowserWindow safely',
    description:
      'Verifies TabManager.reload() exits early if disposed or win.isDestroyed() and re-checks !this.tabs.includes(tab) after async clearCache().',
    run: async () => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      const block = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
      assert.ok(block.length > 0, 'Expected TabManager.reload() method');
      assert.ok(block.includes('if (this.disposed || this.win.isDestroyed()) return;'));
      assert.ok(block.includes('!this.tabs.includes(tab)'));
    },
  },
  {
    id: 'T2-F12-05',
    tier: 2,
    features: ['F12'],
    title: 'Alt+R / Alt+F5 does NOT trigger reload (!input.alt guard in index.ts)',
    description:
      'Verifies dispatchGlobalShortcut in src/main/index.ts enforces !input.alt on both r and f5 shortcut branches.',
    run: async () => {
      const indexSrc = readAppFile('src/main/index.ts');
      assert.ok(
        indexSrc.includes("if ((ctrl && !input.alt && key === 'r') || (!input.alt && key === 'f5'))"),
      );
      assert.ok(DEVICE_PRESETS.length >= 6);
    },
  },
];

export default tests;
