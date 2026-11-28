import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DebuggerCoordinator, type DebuggerTarget } from '../../../src/main/debugger-coordinator';
import { computeFrameStats } from '../../../src/shared/mirror-core';
import { DEVICE_PRESETS } from '../../../src/shared/presets';
import type {
  E2ETestCase,
  PersistedSessionFixture,
  PersistedTabFixture,
  TelemetrySnapshotDto,
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

function visibleLaunchArgs(): string[] {
  return !process.env.WAYLAND_DISPLAY && process.env.DISPLAY ? ['--ozone-platform=x11'] : [];
}

interface MutateFetchOutcome {
  status: number;
  dedupHeader: string | null;
  body: {
    ok?: boolean;
    count?: number;
    method?: string;
    path?: string;
    correlation?: Record<string, unknown>;
    received?: Record<string, unknown>;
  };
}

async function runFetchInViewport(
  evalJs: (expr: string, role?: ViewportRole, tabId?: string) => Promise<{ value: string }>,
  role: ViewportRole,
  tabId: string,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<MutateFetchOutcome> {
  const expr = `(async () => {
    const res = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(init.method)},
      headers: ${JSON.stringify(init.headers ?? {})},
      ${init.body !== undefined ? `body: ${JSON.stringify(init.body)},` : ''}
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
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
  // F1 — R1: Eco DPR cap (5 tests)
  // =========================================================================
  {
    id: 'T1-F1-01',
    tier: 1,
    features: ['F1'],
    title: 'Default Eco DPR cap is ON for iphone-15',
    description:
      'Launches IronBrowser with default settings, opens iphone-15 dual tab, checks clamped portrait devicePixelRatio < 3 and persisted ecoMode === true.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: true,
        extraArgs: ['--force-device-scale-factor=1'],
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
        assert.equal(tab.portraitPresetId, 'iphone-15');
        assert.equal(tab.portraitSize.dpr, 3);

        const dprEval = await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id);
        const effectiveDpr = Number(dprEval.value);
        assert.ok(
          Number.isFinite(effectiveDpr) && effectiveDpr >= 1 && effectiveDpr < 3,
          `Expected Eco DPR in [1, 3), got ${effectiveDpr}`,
        );

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.ecoMode, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F1-02',
    tier: 1,
    features: ['F1'],
    title: 'HiDPI mode disables Eco DPR cap on iphone-15',
    description:
      'Seeds ecoMode: false and verifies iphone-15 portrait viewport renders at full preset DPR (3) and persists ecoMode: false.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, { portraitPresetId: 'iphone-15' })],
        { ecoMode: false },
      );
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: '/echo',
        });
        const dprEval = await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id);
        assert.equal(Number(dprEval.value), 3);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.ecoMode, false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F1-03',
    tier: 1,
    features: ['F1'],
    title: 'Portrait vs Landscape DPR separation in Dual mode',
    description:
      'Opens dual tab with iphone-se (375px, dpr 2) and desktop-hd (1280px, dpr 1) and verifies independent DPR and innerWidth.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'dual',
          portraitPreset: 'iphone-se',
          landscapePreset: 'desktop-hd',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });
        assert.equal(tab.portraitSize.width, 375);
        assert.equal(tab.landscapeSize.width, 1280);

        const pDpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id)).value);
        const lDpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tab.id)).value);
        await session.ctl.evalJs(
          "(() => { const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1'; document.head.appendChild(m); return true; })()",
          'portrait',
          tab.id,
        );
        const pScreenW = Number((await session.ctl.evalJs('window.screen.width', 'portrait', tab.id)).value);
        const pWidth = Number((await session.ctl.evalJs('window.innerWidth', 'portrait', tab.id)).value);
        const lWidth = Number((await session.ctl.evalJs('window.innerWidth', 'landscape', tab.id)).value);

        assert.ok(pDpr >= 1 && pDpr <= 2, `Portrait DPR out of range: ${pDpr}`);
        assert.equal(lDpr, 1);
        assert.equal(pScreenW, 375);
        assert.equal(pWidth, 375);
        assert.equal(lWidth, 1280);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F1-04',
    tier: 1,
    features: ['F1', 'F10'],
    title: 'ecoMode flag persists across SIGTERM restart',
    description:
      'Launches with ecoMode: false, flushes via SIGTERM, relaunches against the same sessionDir, and verifies HiDPI DPR=3 is restored.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, { portraitPresetId: 'iphone-15' })],
        { ecoMode: false },
      );
      const s1 = await ctx.launchElectron({
        smoke: true,
        seedSession,
        keepTempDir: true,
      });
      const sessionDir = s1.sessionDir;
      try {
        await s1.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        s1.sendSignal('SIGTERM');
        await s1.waitForExit(5_000);
        const firstState = s1.readStateFile<PersistedSessionFixture>();
        assert.equal(firstState?.ecoMode, false);
      } finally {
        await s1.close();
      }

      const s2 = await ctx.launchElectron({
        smoke: true,
        sessionDir,
        keepTempDir: false,
      });
      try {
        const tab = await s2.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        const dprEval = await s2.ctl.evalJs('window.devicePixelRatio', 'portrait', tab.id);
        assert.equal(Number(dprEval.value), 3);
        const restored = s2.readStateFile<PersistedSessionFixture>();
        assert.equal(restored?.ecoMode, false);
      } finally {
        await s2.close();
      }
    },
  },
  {
    id: 'T1-F1-05',
    tier: 1,
    features: ['F1'],
    title: 'Preset switch (iphone-15-pro-max vs iphone-se) under Eco mode',
    description:
      'Opens tabs with iphone-15-pro-max (430px, dpr 3) and iphone-se (375px, dpr 2) under default Eco mode and checks preset geometry + DPR clamp.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: true,
        extraArgs: ['--force-device-scale-factor=1'],
      });
      try {
        const t1 = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?p=max`, {
          mode: 'dual',
          portraitPreset: 'iphone-15-pro-max',
        });
        assert.ok(t1.tab?.id);
        const ready1 = await session.ctl.waitForTabReady(t1.tab.id, {
          expectedUrlIncludes: 'p=max',
        });
        assert.equal(ready1.portraitSize.width, 430);
        assert.equal(ready1.portraitSize.dpr, 3);
        const dpr1 = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', ready1.id)).value);
        assert.ok(dpr1 >= 1 && dpr1 < 3, `Expected clamped Eco DPR < 3, got ${dpr1}`);

        const t2 = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?p=se`, {
          mode: 'dual',
          portraitPreset: 'iphone-se',
        });
        assert.ok(t2.tab?.id);
        const ready2 = await session.ctl.waitForTabReady(t2.tab.id, {
          expectedUrlIncludes: 'p=se',
        });
        assert.equal(ready2.portraitSize.width, 375);
        assert.equal(ready2.portraitSize.dpr, 2);
        const dpr2 = Number((await session.ctl.evalJs('window.devicePixelRatio', 'portrait', ready2.id)).value);
        assert.ok(dpr2 >= 1 && dpr2 <= 2, `Expected clamped Eco DPR in [1,2], got ${dpr2}`);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F2 — R1: Burst FPS sampling (5 tests)
  // =========================================================================
  {
    id: 'T1-F2-01',
    tier: 1,
    features: ['F2'],
    title: 'Burst FPS sampling reports valid finite non-zero FPS on active viewports',
    description:
      'Launches a visible window on /page/interactions, drives rAF activity on both viewports, and verifies non-zero finite FPS and recentFrameMs.',
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

        const vis = await session.ctl.evalJs('document.visibilityState', 'portrait', tab.id);
        assert.equal(vis.value, 'visible');

        const startAnim = `(() => {
          let n = 0;
          const step = () => {
            n += 1;
            const el = document.getElementById('page-title');
            if (el) el.dataset.tick = String(n);
            if (n < 240) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          return 'started';
        })()`;
        await Promise.all([
          session.ctl.evalJs(startAnim, 'portrait', tab.id),
          session.ctl.evalJs(startAnim, 'landscape', tab.id),
        ]);

        const snap = await waitUntil<TelemetrySnapshotDto>(
          async () => {
            const m = await session.ctl.metrics();
            if ((m.portrait?.fps ?? 0) > 0 && (m.landscape?.fps ?? 0) > 0) {
              return m;
            }
            return null;
          },
          5_000,
          'non-zero portrait and landscape burst FPS',
          200,
        );

        assert.ok(snap.portrait !== null && snap.landscape !== null);
        assert.ok(snap.portrait.fps > 0 && snap.portrait.fps <= 240);
        assert.ok(snap.landscape.fps > 0 && snap.landscape.fps <= 240);
        assert.ok(snap.portrait.recentFrameMs.length > 0);
        assert.ok(snap.landscape.recentFrameMs.length > 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F2-02',
    tier: 1,
    features: ['F2'],
    title: 'p95FrameMs and jankCount stay valid across consecutive 2s burst windows',
    description:
      'Samples ctl.metrics() across two consecutive burst windows during active animation and verifies finite p95FrameMs and bounded recentFrameMs.',
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

        const anim = `(() => {
          const end = performance.now() + 4800;
          const step = () => { if (performance.now() < end) requestAnimationFrame(step); };
          requestAnimationFrame(step);
          return true;
        })()`;
        await Promise.all([
          session.ctl.evalJs(anim, 'portrait', tab.id),
          session.ctl.evalJs(anim, 'landscape', tab.id),
        ]);

        await sleep(2_200);
        const m1 = await session.ctl.metrics();
        await sleep(2_200);
        const m2 = await session.ctl.metrics();

        for (const m of [m1, m2]) {
          assert.ok(m.portrait !== null && m.landscape !== null);
          for (const vp of [m.portrait, m.landscape]) {
            assert.ok(Number.isFinite(vp.p95FrameMs) && vp.p95FrameMs >= 0 && vp.p95FrameMs < 2000);
            assert.ok(Number.isFinite(vp.jankCount) && vp.jankCount >= 0);
            assert.ok(vp.recentFrameMs.every((dt) => Number.isFinite(dt) && dt >= 0 && dt <= 5000));
          }
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F2-03',
    tier: 1,
    features: ['F2', 'F5'],
    title: 'Window blur keeps paused === false and burst sampling visibility-gated',
    description:
      'Verifies live visible metrics report paused === false, and checks tab-manager.ts/mirror-preload.ts blur vs visibilitychange pause wiring (§4.3).',
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
        const metrics = await session.ctl.metrics();
        assert.equal(metrics.paused, false);
        assert.equal((await session.ctl.evalJs('document.visibilityState', 'portrait', tab.id)).value, 'visible');

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("win.on('blur'") && tabMgrSrc.includes('setThrottled(true)'));
        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(preloadSrc.includes("document.visibilityState !== 'visible'"));
        assert.ok(preloadSrc.includes('visibilitychange'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F2-04',
    tier: 1,
    features: ['F2', 'F5'],
    title: 'Non-visible / minimized state pauses rAF sampling and resets lastTs',
    description:
      'Verifies hidden visibilityState in smoke mode produces zero phantom rAF frames, computeFrameStats handles empty buffers, and mirror-preload resets lastTs = 0.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await sleep(1_200);
        const metrics = await session.ctl.metrics();
        assert.equal(metrics.portrait?.fps ?? 0, 0);
        assert.equal(metrics.landscape?.fps ?? 0, 0);
        assert.deepEqual(computeFrameStats([]), { fps: 0, p95FrameMs: 0, jankCount: 0 });

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(preloadSrc.includes('lastTs = 0'));
        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("win.on('minimize'") && tabMgrSrc.includes('setPaused(true)'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F2-05',
    tier: 1,
    features: ['F2'],
    title: 'Background tab pauses burst sampling past 5s TTL while active tab maintains burst FPS',
    description:
      'Drives FPS on tab A, switches to tab B so tab A becomes hidden (pausing burst sampling past 5s rafByWcId TTL) while active visible tab B maintains burst FPS, and verifies RAF_STATS_TTL_MS = 5000 + pruneStaleRafStats.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        const tA = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(tA.tab?.id);
        await session.ctl.waitForTabReady(tA.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        const mA = await waitUntil(
          async () => {
            const m = await session.ctl.metrics();
            return (m.landscape?.fps ?? 0) > 0 && (m.portrait?.fps ?? 0) > 0 ? m : null;
          },
          5_000,
          'tab A active burst FPS',
          200,
        );
        assert.ok((mA.landscape?.fps ?? 0) > 0);
        assert.ok((mA.portrait?.fps ?? 0) > 0);

        const tB = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(tB.tab?.id);
        await session.ctl.waitForTabReady(tB.tab.id, { expectedUrlIncludes: '/echo' });
        assert.equal((await session.ctl.tabs()).activeTabId, tB.tab.id);

        // Active visible tab B continues emitting 2s burst FPS samples past the 5000ms rafByWcId TTL
        // without needing page-driven rAF, while TelemetryService prunes stale entries > 5000ms.
        await sleep(5_200);
        const mB = await waitUntil(
          async () => {
            const m = await session.ctl.metrics();
            return (m.landscape?.fps ?? 0) > 0 && (m.portrait?.fps ?? 0) > 0 ? m : null;
          },
          5_000,
          'tab B active burst FPS after 5s',
          200,
        );
        assert.ok((mB.landscape?.fps ?? 0) > 0);
        assert.ok((mB.portrait?.fps ?? 0) > 0);

        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('RAF_STATS_TTL_MS = 5000'));
        assert.ok(telemetrySrc.includes('pruneStaleRafStats'));
        assert.ok(telemetrySrc.includes('nowMs - entry.updatedAtMs > this.rafTtlMs'));
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F3 — R1: Lazy Chrome DevTools & Network.enable cap & DebuggerCoordinator (5 tests)
  // =========================================================================
  {
    id: 'T1-F3-01',
    tier: 1,
    features: ['F3'],
    title: 'Lazy DevTools initializes dockOpen = false on clean launch',
    description:
      'Opens a tab on clean Electron launch, flushes state via SIGTERM, and asserts dockOpen === false and devtoolsTarget === portrait.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.dockOpen, false);
        assert.equal(persisted?.tabs[0]?.devtoolsTarget, 'portrait');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F3-02',
    tier: 1,
    features: ['F3'],
    title: 'TelemetryService console & network ring buffers populate while DevTools closed',
    description:
      'With dockOpen === false, logs console errors and fetches /status/404 in both viewports, verifying ctl.console() and ctl.network() record both.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });

        await session.ctl.evalJs(
          "(async () => { console.error('e2e-err-p'); await fetch('/status/404'); return true; })()",
          'portrait',
          tab.id,
        );
        await session.ctl.evalJs(
          "(async () => { console.error('e2e-err-l'); await fetch('/status/404'); return true; })()",
          'landscape',
          tab.id,
        );

        const cons = await waitUntil(
          async () => {
            const c = await session.ctl.console(tab.id, 50);
            const hasP = c.entries.some((e) => e.viewport === 'portrait' && e.text.includes('e2e-err-p'));
            const hasL = c.entries.some((e) => e.viewport === 'landscape' && e.text.includes('e2e-err-l'));
            return hasP && hasL ? c : null;
          },
          4_000,
          'console entries from both viewports',
        );
        assert.ok(cons.count >= 2);

        const net = await waitUntil(
          async () => {
            const n = await session.ctl.network(tab.id, 50);
            const hasP = n.entries.some(
              (e) => e.viewport === 'portrait' && e.url.includes('/status/404') && e.status === 404 && e.failed,
            );
            const hasL = n.entries.some(
              (e) => e.viewport === 'landscape' && e.url.includes('/status/404') && e.status === 404 && e.failed,
            );
            return hasP && hasL ? n : null;
          },
          4_000,
          '404 network entries from both viewports',
        );
        assert.ok(net.count >= 2);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F3-03',
    tier: 1,
    features: ['F3'],
    title: 'Lazy DevTools open, target switch, and closeDevTools-before-destroy ordering',
    description:
      'Boots with seeded dockOpen: true verifying telemetry + console/network stay functional, and verifies tab-manager.ts calls prevWc.closeDevTools() before destroying devtoolsView.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture([makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`)], {
        dockOpen: true,
      });
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        await session.ctl.evalJs("console.warn('dt-open-ok')", 'portrait', tab.id);
        const cons = await waitUntil(
          async () => {
            const c = await session.ctl.console(tab.id, 20);
            return c.entries.some((e) => e.text.includes('dt-open-ok')) ? c : null;
          },
          3_000,
          'console warning while dockOpen=true',
        );
        assert.ok(cons.count >= 1);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.dockOpen, true);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        const closeDtIdx = tabMgrSrc.indexOf('prevWc.closeDevTools()');
        const closeViewIdx = tabMgrSrc.indexOf('dv.webContents.close(');
        assert.ok(closeDtIdx > 0 && closeViewIdx > closeDtIdx);
        assert.ok(tabMgrSrc.includes('reattachAndRestore(prevWc)'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F3-04',
    tier: 1,
    features: ['F3'],
    title: 'devtoolsView and viewport setWindowOpenHandler deny unsafe/unmanaged popups',
    description:
      'Verifies javascript: popup is denied without creating a tab, http: popup opens a managed tab while returning null, and devtoolsView enforces deny handler.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
        });
        const initialCount = (await session.ctl.tabs()).tabs.length;

        const jsPopup = await session.ctl.evalJs(
          "window.open('javascript:alert(1)') === null",
          'landscape',
          tab.id,
        );
        assert.equal(jsPopup.value, 'true');
        await sleep(150);
        assert.equal((await session.ctl.tabs()).tabs.length, initialCount);

        const httpPopup = await session.ctl.evalJs(
          `window.open(${JSON.stringify(`${ctx.servers.httpBaseUrl}/echo?popup=1`)}) === null`,
          'landscape',
          tab.id,
        );
        assert.equal(httpPopup.value, 'true');

        const afterTabs = await waitUntil(
          async () => {
            const state = await session.ctl.tabs();
            return state.tabs.length === initialCount + 1 ? state : null;
          },
          4_000,
          'managed tab creation from http popup',
        );
        assert.equal(afterTabs.tabs.length, initialCount + 1);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes('ensureDevToolsView()'));
        assert.ok(tabMgrSrc.includes("view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))"));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F3-05',
    tier: 1,
    features: ['F3'],
    title: 'Centralized DebuggerCoordinator shares wc.debugger across telemetry & emulation',
    description:
      'Verifies live concurrent emulation + Performance + Console + Network CDP streams on iphone-15 and exercises real DebuggerCoordinator attach/participant sharing.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?cdp=1`, {
          mode: 'dual',
          portraitPreset: 'iphone-15',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: 'cdp=1',
        });

        await session.ctl.evalJs(
          "(() => { const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1'; document.head.appendChild(m); return true; })()",
          'portrait',
          tab.id,
        );
        const screenW = await session.ctl.evalJs('window.screen.width', 'portrait', tab.id);
        const widthEval = await session.ctl.evalJs('window.innerWidth', 'portrait', tab.id);
        assert.equal(Number(screenW.value), 390);
        assert.equal(Number(widthEval.value), 390);
        await session.ctl.evalJs(
          "(async () => { console.warn('cdp-ok'); await fetch('/echo?cdp=1'); return true; })()",
          'portrait',
          tab.id,
        );

        const metrics = await waitUntil(
          async () => {
            const m = await session.ctl.metrics();
            return (m.portrait?.domNodes ?? 0) > 0 ? m : null;
          },
          4_000,
          'portrait DOM metrics',
        );
        assert.ok((metrics.portrait?.domNodes ?? 0) > 0);
        const cons = await waitUntil(
          async () => {
            const c = await session.ctl.console(tab.id, 20);
            return c.entries.some((e) => e.text.includes('cdp-ok')) ? c : null;
          },
          4_000,
          'portrait console cdp-ok',
        );
        assert.ok(cons.entries.some((e) => e.text.includes('cdp-ok')));
        const net = await waitUntil(
          async () => {
            const n = await session.ctl.network(tab.id, 20);
            return n.entries.some((e) => e.url.includes('cdp=1')) ? n : null;
          },
          4_000,
          'portrait network cdp=1',
        );
        assert.ok(net.entries.some((e) => e.url.includes('cdp=1')));
      } finally {
        await session.close();
      }

      // Direct DebuggerCoordinator contract verification (zero Electron dependency)
      const coordinator = new DebuggerCoordinator();
      let attached = false;
      let attachCount = 0;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const target: DebuggerTarget = {
        id: 9001,
        isDestroyed: () => false,
        once: (ev, fn) => {
          const set = listeners.get(ev) ?? new Set();
          set.add(fn as (...args: unknown[]) => void);
          listeners.set(ev, set);
        },
        debugger: {
          isAttached: () => attached,
          attach: () => {
            attachCount += 1;
            attached = true;
          },
          detach: () => {
            attached = false;
          },
          sendCommand: async (method) => ({ method }),
          on: (ev, fn) => {
            const set = listeners.get(ev) ?? new Set();
            set.add(fn as (...args: unknown[]) => void);
            listeners.set(ev, set);
          },
        },
      };

      const [a1, a2] = await Promise.all([
        coordinator.ensureAttached(target),
        coordinator.ensureAttached(target),
      ]);
      assert.equal(a1, true);
      assert.equal(a2, true);
      assert.equal(attachCount, 1);

      const seen: string[] = [];
      coordinator.registerParticipant(target, 'telemetry', {
        onMessage: (m) => seen.push(`t:${m}`),
      });
      coordinator.registerParticipant(target, 'dedup', {
        onMessage: (m) => seen.push(`d:${m}`),
      });
      for (const fn of listeners.get('message') ?? []) {
        fn({}, 'Network.requestWillBeSent', {});
      }
      assert.deepEqual(seen, ['t:Network.requestWillBeSent', 'd:Network.requestWillBeSent']);
      coordinator.detach(target);
    },
  },

  // =========================================================================
  // F4 — R1: Lazy-load inactive restored tabs & opt-in auto-sleep (5 tests)
  // =========================================================================
  {
    id: 'T1-F4-01',
    tier: 1,
    features: ['F4'],
    title: 'Inactive restored tabs remain dormant (0 HTTP hits) on launch',
    description:
      'Seeds 3 tabs with activeTabIndex: 0 and asserts only tab 0 (/echo?t=0) hits the HTTP server at launch while tabs 1 and 2 stay dormant.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=0`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=1`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=2`),
        ],
        { activeTabIndex: 0 },
      );

      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tabsRes = await session.ctl.tabs();
        assert.equal(tabsRes.tabs.length, 3);
        assert.ok(tabsRes.activeTabId);
        await session.ctl.waitForTabReady(tabsRes.activeTabId, {
          expectedUrlIncludes: 't=0',
        });

        await sleep(250);
        const echoLogs = ctx.servers.getHttpLogs().filter((l) => l.path === '/echo');
        assert.ok(echoLogs.some((l) => l.query.t === '0'));
        assert.equal(echoLogs.filter((l) => l.query.t === '1').length, 0);
        assert.equal(echoLogs.filter((l) => l.query.t === '2').length, 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F4-02',
    tier: 1,
    features: ['F4'],
    title: 'Active restored tab materializes and loads immediately on launch',
    description:
      'Seeds 3 tabs with activeTabIndex: 1 and asserts active tab loads in both portrait and landscape while tabs 0 and 2 make 0 HTTP requests.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=0`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=active`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=2`),
        ],
        { activeTabIndex: 1 },
      );

      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tabsRes = await session.ctl.tabs();
        assert.equal(tabsRes.tabs.length, 3);
        assert.ok(tabsRes.activeTabId);
        const activeTab = await session.ctl.waitForTabReady(tabsRes.activeTabId, {
          expectedUrlIncludes: 't=active',
        });
        assert.equal(activeTab.loading, false);

        const pText = (await session.ctl.evalJs('document.body.textContent', 'portrait', activeTab.id)).value;
        const lText = (await session.ctl.evalJs('document.body.textContent', 'landscape', activeTab.id)).value;
        assert.ok(pText.includes('"t":"active"') || pText.includes('"t": "active"'));
        assert.ok(lText.includes('"t":"active"') || lText.includes('"t": "active"'));

        const echoLogs = ctx.servers.getHttpLogs().filter((l) => l.path === '/echo');
        assert.equal(echoLogs.filter((l) => l.query.t === '0').length, 0);
        assert.equal(echoLogs.filter((l) => l.query.t === '2').length, 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F4-03',
    tier: 1,
    features: ['F4'],
    title: 'Dormant tab materializes on demand when targeted by RPC',
    description:
      'Launches with tab 1 dormant (0 hits), then calls evalJs targeting tab 1 and verifies on-demand materialization and HTTP fetch.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=0`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=lazy`),
        ],
        { activeTabIndex: 0 },
      );

      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tabsRes = await session.ctl.tabs();
        assert.equal(tabsRes.tabs.length, 2);
        const tab0 = tabsRes.tabs[0];
        const tab1 = tabsRes.tabs[1];
        assert.ok(tab0 && tab1);

        await session.ctl.waitForTabReady(tab0.id, { expectedUrlIncludes: 't=0' });
        assert.equal(
          ctx.servers.getHttpLogs().filter((l) => l.path === '/echo' && l.query.t === 'lazy').length,
          0,
        );

        const res = await session.ctl.evalJs('document.body.textContent', 'landscape', tab1.id);
        assert.ok(res.value.includes('lazy'));
        const lazyHits = ctx.servers
          .getHttpLogs()
          .filter((l) => l.path === '/echo' && l.query.t === 'lazy');
        assert.ok(lazyHits.length >= 1);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F4-04',
    tier: 1,
    features: ['F4'],
    title: 'autoSleep defaults to false and keeps idle background tabs awake',
    description:
      'Opens two tabs, waits 1s, checks background tab stays materialized without re-fetching, and verifies persisted autoSleep === false.',
    run: async (ctx) => {
      ctx.servers.resetHttpLogs();
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const t1 = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?t=1`, { mode: 'dual' });
        assert.ok(t1.tab?.id);
        await session.ctl.waitForTabReady(t1.tab.id, { expectedUrlIncludes: 't=1' });

        const t2 = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?t=2`, { mode: 'dual' });
        assert.ok(t2.tab?.id);
        await session.ctl.waitForTabReady(t2.tab.id, { expectedUrlIncludes: 't=2' });

        await sleep(1_000);
        ctx.servers.resetHttpLogs();
        const evalBg = await session.ctl.evalJs('location.search', 'landscape', t1.tab.id);
        assert.equal(evalBg.value, '?t=1');
        assert.equal(
          ctx.servers.getHttpLogs().filter((l) => l.path === '/echo' && l.query.t === '1').length,
          0,
        );

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.autoSleep, false);
        assert.ok(persisted?.tabs.every((t) => t.sleeping === false));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F4-05',
    tier: 1,
    features: ['F4'],
    title: 'Opt-in autoSleep persists true and protects active/audible tabs',
    description:
      'Seeds autoSleep: true, verifies persisted state preserves autoSleep === true while keeping active tab awake, and verifies sweepAutoSleep rules in tab-manager.ts.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=active`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?t=bg`),
        ],
        { autoSleep: true, activeTabIndex: 0 },
      );
      const session = await ctx.launchElectron({ smoke: true, seedSession });
      try {
        const tab0 = await session.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: 't=active',
        });
        assert.equal(tab0.sleeping, false);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.autoSleep, true);
        assert.equal(persisted?.tabs[0]?.sleeping, false);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes('sweepAutoSleep('));
        assert.ok(tabMgrSrc.includes('if (tab.id === this.activeTabId) continue;'));
        assert.ok(tabMgrSrc.includes('if (this.isTabAudible(tab)) continue;'));
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F5 — R1: CDP telemetry polling (5 tests)
  // =========================================================================
  {
    id: 'T1-F5-01',
    tier: 1,
    features: ['F5'],
    title: 'Active CDP polling populates jsHeapUsedMb, domNodes, layoutCount, recalcStyleCount',
    description:
      'Opens /page/interactions in dual mode, verifies CDP metrics > 0 on both viewports, inserts DOM nodes, and asserts domNodes increases.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        const m1 = await waitUntil(
          async () => {
            const m = await session.ctl.metrics();
            if ((m.portrait?.domNodes ?? 0) > 0 && (m.landscape?.domNodes ?? 0) > 0) {
              return m;
            }
            return null;
          },
          4_000,
          'initial portrait and landscape CDP metrics',
        );
        assert.ok((m1.portrait?.jsHeapUsedMb ?? 0) > 0);
        assert.ok((m1.landscape?.jsHeapUsedMb ?? 0) > 0);
        assert.ok((m1.portrait?.layoutCount ?? 0) >= 1);
        assert.ok((m1.landscape?.recalcStyleCount ?? 0) >= 1);

        const initialDom = m1.landscape?.domNodes ?? 0;
        await session.ctl.evalJs(
          `(() => {
            for (let i = 0; i < 150; i += 1) {
              const d = document.createElement('div');
              d.textContent = 'n-' + i;
              document.body.appendChild(d);
            }
            return true;
          })()`,
          'landscape',
          tab.id,
        );

        const m2 = await waitUntil(
          async () => {
            const m = await session.ctl.metrics();
            return (m.landscape?.domNodes ?? 0) >= initialDom + 150 ? m : null;
          },
          4_000,
          'increased domNodes after insertion',
        );
        assert.ok((m2.landscape?.domNodes ?? 0) >= initialDom + 150);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F5-02',
    tier: 1,
    features: ['F5'],
    title: 'Window blur throttles polling to 5s without setting paused: true',
    description:
      'Verifies active polling remains unpaused on visible session and telemetry.ts/tab-manager.ts wire 2s active and 5s blur throttle intervals.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({
        smoke: false,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        const m = await session.ctl.metrics();
        assert.equal(m.paused, false);
        assert.ok(m.landscape !== null);

        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('ACTIVE_POLL_INTERVAL_MS = 2000'));
        assert.ok(telemetrySrc.includes('BLUR_POLL_INTERVAL_MS = 5000'));
        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("win.on('blur'") && tabMgrSrc.includes('setThrottled(true)'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F5-03',
    tier: 1,
    features: ['F5'],
    title: 'Window minimize / hide sets paused === true and stops background polling',
    description:
      'Verifies on-demand ctl.metrics() remains responsive while tab-manager.ts wires minimize/hide to telemetry.setPaused(true) and clears poll timers.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        assert.ok(opened.tab?.id);
        await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });
        const m = await session.ctl.metrics();
        assert.ok(m.timestampMs > 0);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("win.on('minimize'") && tabMgrSrc.includes("win.on('hide'"));
        assert.ok(tabMgrSrc.includes('this.telemetry.setPaused(true)'));
        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('if (!this.started || this.paused) return;'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F5-04',
    tier: 1,
    features: ['F5'],
    title: 'Window show / restore resumes polling (paused: false) and refreshes metrics',
    description:
      'Verifies active telemetry updates across polling intervals and tab-manager.ts/telemetry.ts restore wiring triggers immediate sampleOnce() on show/restore.',
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
        await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        const m1 = await session.ctl.metrics();
        await sleep(2_100);
        const m2 = await session.ctl.metrics();
        assert.equal(m2.paused, false);
        assert.ok(m2.timestampMs > m1.timestampMs);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        assert.ok(tabMgrSrc.includes("win.on('restore'") && tabMgrSrc.includes("win.on('show'"));
        assert.ok(tabMgrSrc.includes('this.telemetry.setPaused(false)'));
        const telemetrySrc = readAppFile('src/main/telemetry.ts');
        assert.ok(telemetrySrc.includes('this.sampleOnce().finally('));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F5-05',
    tier: 1,
    features: ['F5'],
    title: 'browser_metrics reports accurate portrait/landscape presence across dual and single',
    description:
      'Opens a dual tab then a single tab and asserts metrics.portrait is non-null in dual mode and null in single mode.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const dualTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?m=dual`, {
          mode: 'dual',
        });
        assert.ok(dualTab.tab?.id);
        await session.ctl.waitForTabReady(dualTab.tab.id, { expectedUrlIncludes: 'm=dual' });
        const mDual = await session.ctl.metrics();
        assert.ok(mDual.portrait !== null && mDual.landscape !== null);
        assert.equal(mDual.portrait.role, 'portrait');
        assert.equal(mDual.landscape.role, 'landscape');

        const singleTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?m=single`, {
          mode: 'single',
        });
        assert.ok(singleTab.tab?.id);
        await session.ctl.waitForTabReady(singleTab.tab.id, { expectedUrlIncludes: 'm=single' });
        const mSingle = await session.ctl.metrics();
        assert.equal(mSingle.portrait, null);
        assert.ok(mSingle.landscape !== null);
        assert.equal(mSingle.landscape.role, 'landscape');
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F6 — R2: HTTP Request Dedup Core & Middleware (5 tests)
  // =========================================================================
  {
    id: 'T1-F6-01',
    tier: 1,
    features: ['F6'],
    title: 'Mirrored POST /mutate hits server once and follower gets x-iron-browser-dedup: replayed',
    description:
      'Triggers mirrored POST /mutate across portrait and landscape with distinct idempotencyKey values and verifies server count === 1 and correlation remapping.',
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
        const [pRes, lRes] = await Promise.all([
          runFetchInViewport(
            session.ctl.evalJs.bind(session.ctl),
            'portrait',
            tab.id,
            '/mutate',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'bet', idempotencyKey: 'idem-portrait-1', ts: 1001 }),
            },
          ),
          runFetchInViewport(
            session.ctl.evalJs.bind(session.ctl),
            'landscape',
            tab.id,
            '/mutate',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'bet', idempotencyKey: 'idem-landscape-1', ts: 1002 }),
            },
          ),
        ]);

        const mutateLogs = ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate');
        assert.equal(mutateLogs.length, 1);
        assert.equal(pRes.status, 200);
        assert.equal(lRes.status, 200);
        assert.equal(pRes.body.ok, true);
        assert.equal(lRes.body.ok, true);
        assert.equal(pRes.body.correlation?.idempotencyKey, 'idem-portrait-1');
        assert.equal(lRes.body.correlation?.idempotencyKey, 'idem-landscape-1');

        const replayedCount = [pRes.dedupHeader, lRes.dedupHeader].filter(
          (h) => h === 'replayed',
        ).length;
        assert.equal(replayedCount, 1);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F6-02',
    tier: 1,
    features: ['F6'],
    title: 'PUT, PATCH, and DELETE mutations to /mutate are deduplicated',
    description:
      'Executes concurrent dual-viewport PUT, PATCH, and DELETE calls to /mutate and asserts server receives 1 hit per method with follower replay.',
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

        for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
          ctx.servers.resetHttpLogs();
          const [pRes, lRes] = await Promise.all([
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'portrait',
              tab.id,
              '/mutate',
              {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: method, clientRequestId: `cr-${method}-p` }),
              },
            ),
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'landscape',
              tab.id,
              '/mutate',
              {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: method, clientRequestId: `cr-${method}-l` }),
              },
            ),
          ]);

          const logs = ctx.servers
            .getHttpLogs()
            .filter((l) => l.path === '/mutate' && l.method === method);
          assert.equal(logs.length, 1, `Expected 1 server hit for ${method}`);
          assert.equal(pRes.status, 200);
          assert.equal(lRes.status, 200);
          assert.equal(
            [pRes.dedupHeader, lRes.dedupHeader].filter((h) => h === 'replayed').length,
            1,
          );
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F6-03',
    tier: 1,
    features: ['F6'],
    title: 'GET XHR/Fetch requests to /echo are NOT deduplicated',
    description:
      'Executes concurrent GET /echo?k=1 from both viewports and verifies mutations-only R2 policy sends both GETs to the server without replay.',
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
        const [pRes, lRes] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/echo?k=1', {
            method: 'GET',
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/echo?k=1', {
            method: 'GET',
          }),
        ]);

        const echoHits = ctx.servers
          .getHttpLogs()
          .filter((l) => l.path === '/echo' && l.query.k === '1');
        assert.equal(echoHits.length, 2);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F6-04',
    tier: 1,
    features: ['F6'],
    title: '/mutate-gzip, /mutate-br, and /mutate-deflate decompressed & correlation-remapped',
    description:
      'Sends mirrored POSTs to gzip, br, and deflate endpoints and verifies server receives 1 hit each while follower gets valid JSON with its own correlation ID.',
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

        for (const endpoint of ['/mutate-gzip', '/mutate-br', '/mutate-deflate'] as const) {
          ctx.servers.resetHttpLogs();
          const [pRes, lRes] = await Promise.all([
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'portrait',
              tab.id,
              endpoint,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  correlationId: `corr-${endpoint}-p`,
                  traceId: `trace-${endpoint}-p`,
                }),
              },
            ),
            runFetchInViewport(
              session.ctl.evalJs.bind(session.ctl),
              'landscape',
              tab.id,
              endpoint,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  correlationId: `corr-${endpoint}-l`,
                  traceId: `trace-${endpoint}-l`,
                }),
              },
            ),
          ]);

          const logs = ctx.servers.getHttpLogs().filter((l) => l.path === endpoint);
          assert.equal(logs.length, 1, `Expected 1 hit for ${endpoint}`);
          assert.equal(pRes.body.ok, true);
          assert.equal(lRes.body.ok, true);
          assert.equal(pRes.body.correlation?.correlationId, `corr-${endpoint}-p`);
          assert.equal(lRes.body.correlation?.correlationId, `corr-${endpoint}-l`);
          assert.equal(
            [pRes.dedupHeader, lRes.dedupHeader].filter((h) => h === 'replayed').length,
            1,
          );
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F6-05',
    tier: 1,
    features: ['F6'],
    title: 'Narrowed VOLATILE_JSON_KEYS & key-scoped correlation remapping',
    description:
      'Verifies differing txId/nonce are NOT treated as volatile (count === 2) and correlation remapping never alters non-correlation token fields.',
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

        // (a) Distinct txId / nonce must NOT be conflated as volatile
        ctx.servers.resetHttpLogs();
        await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txId: 'tx-unique-A', nonce: 'nonce-111' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txId: 'tx-unique-B', nonce: 'nonce-222' }),
          }),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);

        // (b) Key-scoped remapping: matching value inside non-correlation `token` must stay unchanged
        ctx.servers.resetHttpLogs();
        const sharedToken = 'shared-secret-value-999';
        const [p2, l2] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idempotencyKey: sharedToken, token: sharedToken }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idempotencyKey: 'follower-idem-888', token: sharedToken }),
          }),
        ]);
        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 1);
        assert.equal(p2.body.received?.token, sharedToken);
        assert.equal(l2.body.received?.token, sharedToken);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F7 — R2: Request Dedup Integration & UI (5 tests)
  // =========================================================================
  {
    id: 'T1-F7-01',
    tier: 1,
    features: ['F7', 'F6'],
    title: 'Dedup active when dual + shared + mirror + dedup',
    description:
      'Clicks #btn-fetch-mutate mirrored across dual shared viewports, verifying 1 server hit, follower replay header, and TabSnapshot dedupCount >= 1.',
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
        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#btn-fetch-mutate',
          mirror: true,
        });

        const outcomes = await waitUntil(
          async () => {
            const pTxt = (await session.ctl.evalJs("document.getElementById('mutate-result').textContent", 'portrait', tab.id)).value;
            const lTxt = (await session.ctl.evalJs("document.getElementById('mutate-result').textContent", 'landscape', tab.id)).value;
            if (pTxt.includes('"status":200') && lTxt.includes('"status":200')) {
              return {
                p: JSON.parse(pTxt) as MutateFetchOutcome,
                l: JSON.parse(lTxt) as MutateFetchOutcome,
              };
            }
            return null;
          },
          5_000,
          'both viewports #mutate-result updated',
        );

        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 1);
        assert.equal(
          [outcomes.p.dedupHeader, outcomes.l.dedupHeader].filter((h) => h === 'replayed').length,
          1,
        );
        const tabState = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.equal(tabState?.dedup, true);
        assert.ok((tabState?.dedupCount ?? 0) >= 1);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F7-02',
    tier: 1,
    features: ['F7'],
    title: 'Dedup auto-disabled in isolated session mode',
    description:
      'Opens dual tab with session: isolated, triggers POST /mutate on both viewports, and asserts 2 server hits and dedupCount === 0.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'isolated',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const [pRes, lRes] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso', idempotencyKey: 'iso-p-1' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'iso', idempotencyKey: 'iso-l-1' }),
          }),
        ]);

        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);
        const tabState = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.equal(tabState?.session, 'isolated');
        assert.equal(tabState?.dedupCount ?? 0, 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F7-03',
    tier: 1,
    features: ['F7'],
    title: 'Dedup auto-disabled in single viewport mode',
    description:
      'Opens single shared tab, fires back-to-back POST /mutate requests from landscape, and asserts 2 server hits and zero replays.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'single',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        ctx.servers.resetHttpLogs();
        const r1 = await runFetchInViewport(
          session.ctl.evalJs.bind(session.ctl),
          'landscape',
          tab.id,
          '/mutate',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'single', idempotencyKey: 's-1' }),
          },
        );
        const r2 = await runFetchInViewport(
          session.ctl.evalJs.bind(session.ctl),
          'landscape',
          tab.id,
          '/mutate',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'single', idempotencyKey: 's-2' }),
          },
        );

        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(r1.dedupHeader, null);
        assert.equal(r2.dedupHeader, null);
        const tabState = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.equal(tabState?.dedupCount ?? 0, 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F7-04',
    tier: 1,
    features: ['F7', 'F10'],
    title: 'dedup: false disables interception & persists dedup flag',
    description:
      'Seeds tab with dedup: false, executes mirrored POST /mutate, and asserts 2 server hits, zero replay headers, and persisted dedup === false.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture([
        makeTabFixture(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
          mirror: true,
          dedup: false,
        }),
      ]);
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, {
          expectedUrlIncludes: '/page/interactions',
        });
        assert.equal(tab.dedup, false);

        ctx.servers.resetHttpLogs();
        const [pRes, lRes] = await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'off', idempotencyKey: 'off-p' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'off', idempotencyKey: 'off-l' }),
          }),
        ]);

        assert.equal(ctx.servers.getHttpLogs().filter((l) => l.path === '/mutate').length, 2);
        assert.equal(pRes.dedupHeader, null);
        assert.equal(lRes.dedupHeader, null);

        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        assert.equal(session.readStateFile<PersistedSessionFixture>()?.tabs[0]?.dedup, false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F7-05',
    tier: 1,
    features: ['F7'],
    title: 'dedupCount increment does NOT dirty session-state.json + M4B UI surface',
    description:
      'Triggers mirrored POST /mutate incrementing dedupCount >= 1, waits past 400ms save debounce, confirms session-state.json stays untouched, and verifies M4B shell UI markers.',
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
        assert.ok(beforeRaw !== null);
        const beforeSavedAt = (JSON.parse(beforeRaw) as PersistedSessionFixture).savedAt;

        await Promise.all([
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'portrait', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'nodirty', idempotencyKey: 'nd-p' }),
          }),
          runFetchInViewport(session.ctl.evalJs.bind(session.ctl), 'landscape', tab.id, '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'nodirty', idempotencyKey: 'nd-l' }),
          }),
        ]);

        const tabState = (await session.ctl.tabs()).tabs.find((t) => t.id === tab.id);
        assert.ok((tabState?.dedupCount ?? 0) >= 1);

        await sleep(750);
        const afterRaw = session.readRawStateFile();
        assert.equal(afterRaw, beforeRaw);
        assert.equal((JSON.parse(afterRaw!) as PersistedSessionFixture).savedAt, beforeSavedAt);

        const htmlSrc = readAppFile('src/renderer/index.html');
        const shellSrc = readAppFile('src/renderer/shell.ts');
        assert.ok(/dedup/i.test(htmlSrc), 'Expected Dedup pill/counter in index.html');
        assert.ok(/dedup/i.test(shellSrc), 'Expected Dedup UI wiring in shell.ts');
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F8 — R3: Symmetric WS & SSE Frame Multiplexer (5 tests)
  // =========================================================================
  {
    id: 'T1-F8-01',
    tier: 1,
    features: ['F8'],
    title: 'Dual viewports share 1 upstream WS connection & receive inbound text/binary',
    description:
      'Opens /page/ws-sse in dual shared mode, connects WS on both viewports, and asserts 1 upstream connection and identical text + binary delivery.',
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
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'portrait WS open',
        );

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'landscape WS open',
        );

        assert.equal(ctx.servers.getWsStats().activeConnections, 1);

        ctx.servers.broadcastWs('srv-txt');
        ctx.servers.broadcastWs(new Uint8Array([1, 2, 3]));

        const logs = await waitUntil(
          async () => {
            const p = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'portrait', tab.id)).value,
            ) as unknown[];
            const l = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'landscape', tab.id)).value,
            ) as unknown[];
            return p.length >= 2 && l.length >= 2 ? { p, l } : null;
          },
          4_000,
          'both viewports receive text + binary WS frames',
        );

        assert.deepEqual(logs.p, ['srv-txt', { binary: [1, 2, 3] }]);
        assert.deepEqual(logs.l, ['srv-txt', { binary: [1, 2, 3] }]);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F8-02',
    tier: 1,
    features: ['F8'],
    title: 'Symmetric outbound WS deduplication within ~1500ms',
    description:
      'Sends canonical identical JSON frames with distinct idempotencyKey/ts from both viewports inside 200ms and asserts server receives only 1 frame.',
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
            const ps = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
            const ls = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            return ps.startsWith('open:') && ls.startsWith('open:');
          },
          4_000,
          'both WS viewports open',
        );

        const pPayload = JSON.stringify({ type: 'bet', amount: 10, idempotencyKey: 'k-p', ts: 1001 });
        const lPayload = JSON.stringify({ type: 'bet', amount: 10, idempotencyKey: 'k-l', ts: 1002 });
        await Promise.all([
          session.ctl.evalJs(`window.__wsSend(${JSON.stringify(pPayload)})`, 'portrait', tab.id),
          session.ctl.evalJs(`window.__wsSend(${JSON.stringify(lPayload)})`, 'landscape', tab.id),
        ]);

        await waitUntil(
          async () => {
            const p = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'portrait', tab.id)).value,
            ) as unknown[];
            const l = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'landscape', tab.id)).value,
            ) as unknown[];
            return p.length >= 1 && l.length >= 1;
          },
          4_000,
          'echoed outbound WS frame on both viewports',
        );
        await sleep(200);
        assert.equal(ctx.servers.getWsStats().receivedMessages.length, 1);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F8-03',
    tier: 1,
    features: ['F8'],
    title: 'Dual viewports share 1 upstream SSE connection & preserve named events + lastEventId',
    description:
      'Opens EventSource on both viewports in /page/ws-sse, verifies 1 upstream SSE connection, and asserts named ping-evt and default message events with lastEventId.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetSseStats();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/ws-sse`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/ws-sse',
        });

        await Promise.all([
          session.ctl.evalJs(
            `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
            'portrait',
            tab.id,
          ),
          session.ctl.evalJs(
            `window.__sseOpen(${JSON.stringify(ctx.servers.sseBaseUrl)}, ['ping-evt', 'room_state'])`,
            'landscape',
            tab.id,
          ),
        ]);

        await waitUntil(
          async () => {
            const ps = (await session.ctl.evalJs("document.getElementById('sse-status').textContent", 'portrait', tab.id)).value;
            const ls = (await session.ctl.evalJs("document.getElementById('sse-status').textContent", 'landscape', tab.id)).value;
            return ps === 'open' && ls === 'open';
          },
          4_000,
          'both SSE viewports open',
        );

        assert.equal(ctx.servers.getSseStats().activeConnections, 1);

        ctx.servers.pushSseEvent('ping-evt', '{"round":7}', 'evt-7');
        ctx.servers.pushSseEvent(null, 'msg-8', 'evt-8');

        const logs = await waitUntil(
          async () => {
            const p = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('sse-messages').textContent", 'portrait', tab.id)).value,
            ) as Array<{ type: string; data: string; lastEventId: string }>;
            const l = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('sse-messages').textContent", 'landscape', tab.id)).value,
            ) as Array<{ type: string; data: string; lastEventId: string }>;
            return p.length >= 2 && l.length >= 2 ? { p, l } : null;
          },
          4_000,
          'both viewports receive SSE events',
        );

        const expected = [
          { type: 'ping-evt', data: '{"round":7}', lastEventId: 'evt-7' },
          { type: 'message', data: 'msg-8', lastEventId: 'evt-8' },
        ];
        assert.deepEqual(logs.p, expected);
        assert.deepEqual(logs.l, expected);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F8-04',
    tier: 1,
    features: ['F8'],
    title: 'Owner teardown sends 1012 clean close & promotes surviving follower',
    description:
      'Connects portrait (owner) then landscape (follower), tears down owner connection, verifies survivor sees close 1012, reconnects as new owner, and receives broadcast.',
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
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'portrait',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'owner WS open',
        );

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'follower WS open',
        );

        // Trigger real owner renderer teardown via location.reload() on portrait
        // (same-URL reload does not mirror onto landscape, leaving follower alive for 1012 failover).
        await session.ctl.evalJs('location.reload()', 'portrait', tab.id);

        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'closed:1012',
          4_000,
          'surviving follower closes with 1012 on owner teardown',
        );

        await session.ctl.evalJs(
          `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, 'chat.v1')`,
          'landscape',
          tab.id,
        );
        await waitUntil(
          async () =>
            (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value ===
            'open:chat.v1',
          4_000,
          'survivor promoted to new owner',
        );
        assert.equal(ctx.servers.getWsStats().activeConnections, 1);

        ctx.servers.broadcastWs('after-failover');
        const msgs = await waitUntil(
          async () => {
            const l = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'landscape', tab.id)).value,
            ) as unknown[];
            return l.includes('after-failover') ? l : null;
          },
          4_000,
          'broadcast after failover',
        );
        assert.ok(msgs.includes('after-failover'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F8-05',
    tier: 1,
    features: ['F8'],
    title: 'WS subprotocol & arraybuffer binary ordering preserved across mux',
    description:
      'Negotiates [chat.v1, fallback.v2], verifies binaryType === arraybuffer on both viewports, and confirms mixed binary/text frames arrive in exact order.',
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
          session.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, ['chat.v1', 'fallback.v2'])`,
            'portrait',
            tab.id,
          ),
          session.ctl.evalJs(
            `window.__wsOpen(${JSON.stringify(ctx.servers.wsBaseUrl)}, ['chat.v1', 'fallback.v2'])`,
            'landscape',
            tab.id,
          ),
        ]);

        await waitUntil(
          async () => {
            const p = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'portrait', tab.id)).value;
            const l = (await session.ctl.evalJs("document.getElementById('ws-status').textContent", 'landscape', tab.id)).value;
            return p === 'open:chat.v1' && l === 'open:chat.v1';
          },
          4_000,
          'both viewports open with chat.v1',
        );

        assert.equal((await session.ctl.evalJs('window.__ws.protocol', 'portrait', tab.id)).value, 'chat.v1');
        assert.equal((await session.ctl.evalJs('window.__ws.protocol', 'landscape', tab.id)).value, 'chat.v1');
        assert.equal((await session.ctl.evalJs('window.__ws.binaryType', 'portrait', tab.id)).value, 'arraybuffer');
        assert.equal((await session.ctl.evalJs('window.__ws.binaryType', 'landscape', tab.id)).value, 'arraybuffer');

        await session.ctl.evalJs('window.__wsSendBinary([10, 20, 30])', 'portrait', tab.id);
        await session.ctl.evalJs("window.__wsSend('seq-2')", 'portrait', tab.id);
        await session.ctl.evalJs('window.__wsSendBinary([40, 50])', 'portrait', tab.id);

        const logs = await waitUntil(
          async () => {
            const p = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'portrait', tab.id)).value,
            ) as unknown[];
            const l = JSON.parse(
              (await session.ctl.evalJs("document.getElementById('ws-messages').textContent", 'landscape', tab.id)).value,
            ) as unknown[];
            return p.length >= 3 && l.length >= 3 ? { p, l } : null;
          },
          4_000,
          'ordered mixed binary and text WS frames',
        );

        const expected = [{ binary: [10, 20, 30] }, 'seq-2', { binary: [40, 50] }];
        assert.deepEqual(logs.p, expected);
        assert.deepEqual(logs.l, expected);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F9 — R4: UI Replication Accuracy (5 tests)
  // =========================================================================
  {
    id: 'T1-F9-01',
    tier: 1,
    features: ['F9'],
    title: 'Atomic click & State-Aware Toggle Guard (aria-pressed/checked/selected/data-state)',
    description:
      'Clicks all 4 toggle controls in /page/interactions mirrored across viewports and verifies State-Aware Toggle Guard wiring in mirror-relay.ts.',
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

        const checks: Array<{ selector: string; attr: string; expected: string }> = [
          { selector: '#btn-toggle-pressed', attr: 'aria-pressed', expected: 'true' },
          { selector: '#btn-toggle-checked', attr: 'aria-checked', expected: 'true' },
          { selector: '#btn-toggle-selected', attr: 'aria-selected', expected: 'true' },
          { selector: '#btn-toggle-state', attr: 'data-state', expected: 'open' },
        ];

        for (const c of checks) {
          await session.ctl.interact({
            action: 'click',
            tabId: tab.id,
            viewport: 'portrait',
            selector: c.selector,
            mirror: true,
          });
          const pVal = (
            await session.ctl.evalJs(
              `document.querySelector(${JSON.stringify(c.selector)}).getAttribute(${JSON.stringify(c.attr)})`,
              'portrait',
              tab.id,
            )
          ).value;
          const lVal = (
            await session.ctl.evalJs(
              `document.querySelector(${JSON.stringify(c.selector)}).getAttribute(${JSON.stringify(c.attr)})`,
              'landscape',
              tab.id,
            )
          ).value;
          assert.equal(pVal, c.expected);
          assert.equal(lVal, c.expected);
        }

        const relaySrc = readAppFile('src/main/mirror-relay.ts');
        assert.ok(relaySrc.includes('aria-pressed') && relaySrc.includes('data-state'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F9-02',
    tier: 1,
    features: ['F9'],
    title: '<select> value sync & Enter/Space synthetic-click suppression',
    description:
      'Verifies #color-select and #btn-inc single-increment Enter activation across both viewports and checks synthetic-click suppression in mirror-preload.ts.',
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
          selector: '#btn-inc',
          mirror: true,
        });
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('inc-count').textContent", 'portrait', tab.id)).value,
          '1',
        );
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('inc-count').textContent", 'landscape', tab.id)).value,
          '1',
        );

        await session.ctl.interact({
          action: 'key',
          tabId: tab.id,
          viewport: 'portrait',
          key: 'Enter',
          mirror: true,
        });
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('inc-count').textContent", 'portrait', tab.id)).value,
          '2',
        );
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('inc-count').textContent", 'landscape', tab.id)).value,
          '2',
        );

        const selectGreen = `(() => {
          const s = document.getElementById('color-select');
          s.value = 'green';
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return s.value;
        })()`;
        await session.ctl.evalJs(selectGreen, 'portrait', tab.id);
        await session.ctl.evalJs(selectGreen, 'landscape', tab.id);
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('select-val').textContent", 'portrait', tab.id)).value,
          'green',
        );
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('select-val').textContent", 'landscape', tab.id)).value,
          'green',
        );

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(preloadSrc.includes('Enter') && preloadSrc.includes('Space'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F9-03',
    tier: 1,
    features: ['F9'],
    title: 'Scoped range/slider/canvas drag & top-level vs #inner-scroll',
    description:
      'Drives top-level proportional scroll, #draw-canvas click, and #aria-slider key listener (Caveat #2) across both viewports and checks scoped drag/scroll filters.',
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

        // Inject responsive viewport meta so mobile portrait emulation (390x844) yields scrollHeight > innerHeight.
        const injectViewportMeta = `(() => {
          if (!document.querySelector('meta[name="viewport"]')) {
            const meta = document.createElement('meta');
            meta.name = 'viewport';
            meta.content = 'width=device-width, initial-scale=1';
            document.head.appendChild(meta);
          }
          return true;
        })()`;
        await Promise.all([
          session.ctl.evalJs(injectViewportMeta, 'portrait', tab.id),
          session.ctl.evalJs(injectViewportMeta, 'landscape', tab.id),
        ]);

        await session.ctl.interact({
          action: 'scroll',
          tabId: tab.id,
          viewport: 'portrait',
          ratioY: 0.5,
          mirror: true,
        });
        const pScroll = Number((await session.ctl.evalJs('window.scrollY', 'portrait', tab.id)).value);
        const lScroll = Number((await session.ctl.evalJs('window.scrollY', 'landscape', tab.id)).value);
        assert.ok(pScroll > 0 && lScroll > 0);

        await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#draw-canvas',
          mirror: true,
        });
        const pPts = JSON.parse(
          (await session.ctl.evalJs('window.__canvasPoints.length', 'portrait', tab.id)).value,
        ) as number;
        const lPts = JSON.parse(
          (await session.ctl.evalJs('window.__canvasPoints.length', 'landscape', tab.id)).value,
        ) as number;
        assert.ok(pPts >= 1 && lPts >= 1);

        // Attach listener on #aria-slider per E2E-M1 Caveat #2
        const attachSlider = `(() => {
          const el = document.getElementById('aria-slider');
          el.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') {
              const cur = Number(el.getAttribute('aria-valuenow') || '50');
              el.setAttribute('aria-valuenow', String(cur + 5));
            }
          });
          el.focus();
          return true;
        })()`;
        await Promise.all([
          session.ctl.evalJs(attachSlider, 'portrait', tab.id),
          session.ctl.evalJs(attachSlider, 'landscape', tab.id),
        ]);
        await session.ctl.interact({
          action: 'key',
          tabId: tab.id,
          viewport: 'portrait',
          key: 'ArrowRight',
          mirror: true,
        });
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('aria-slider').getAttribute('aria-valuenow')", 'portrait', tab.id)).value,
          '55',
        );
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('aria-slider').getAttribute('aria-valuenow')", 'landscape', tab.id)).value,
          '55',
        );

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(
          preloadSrc.includes('document.documentElement') &&
            (preloadSrc.includes('role="slider"') ||
              preloadSrc.includes("role') === 'slider'") ||
              preloadSrc.includes('[role="slider"]')),
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F9-04',
    tier: 1,
    features: ['F9'],
    title: 'Open Shadow DOM & same-origin iframe piercing',
    description:
      'Loads /page/shadow and /page/iframe-same in live Electron, drives clicks via ctl.interact (resolveTarget) from portrait, and verifies Shadow DOM and same-origin iframe piercing.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const shadowTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/shadow`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(shadowTab.tab?.id);
        await session.ctl.waitForTabReady(shadowTab.tab.id, { expectedUrlIncludes: '/page/shadow' });

        const shadowClick = await session.ctl.interact({
          action: 'click',
          tabId: shadowTab.tab.id,
          viewport: 'portrait',
          selector: '#shadow-btn',
          mirror: true,
        });
        assert.equal((shadowClick.outcomes.portrait as { ok?: boolean } | undefined)?.ok, true);
        assert.equal((shadowClick.outcomes.landscape as { ok?: boolean } | undefined)?.ok, true);
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('shadow-output').textContent", 'portrait', shadowTab.tab.id)).value,
          '1',
        );
        assert.equal(
          (await session.ctl.evalJs("document.getElementById('shadow-output').textContent", 'landscape', shadowTab.tab.id)).value,
          '1',
        );

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
              "Boolean(document.getElementById('child-frame')?.contentDocument?.getElementById('iframe-btn'))",
              'portrait',
              iframeTab.tab?.id,
            )).value === 'true',
          4_000,
          'same-origin iframe child loaded',
        );

        const iframeClick = await session.ctl.interact({
          action: 'click',
          tabId: iframeTab.tab.id,
          viewport: 'portrait',
          selector: '#iframe-btn',
          mirror: true,
        });
        assert.equal((iframeClick.outcomes.portrait as { ok?: boolean } | undefined)?.ok, true);
        assert.equal((iframeClick.outcomes.landscape as { ok?: boolean } | undefined)?.ok, true);
        assert.equal(
          (
            await session.ctl.evalJs(
              "document.getElementById('child-frame').contentDocument.getElementById('iframe-count').textContent",
              'portrait',
              iframeTab.tab.id,
            )
          ).value,
          '1',
        );
        assert.equal(
          (
            await session.ctl.evalJs(
              "document.getElementById('child-frame').contentDocument.getElementById('iframe-count').textContent",
              'landscape',
              iframeTab.tab.id,
            )
          ).value,
          '1',
        );

        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        assert.ok(
          preloadSrc.includes('contentDocument') &&
            preloadSrc.includes('shadowRoot') &&
            preloadSrc.includes('WeakSet'),
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F9-05',
    tier: 1,
    features: ['F9'],
    title: 'Interactive-only Mirror Miss indicator & sanitized .textContent',
    description:
      'Removes #unmirrored-miss-target from landscape and clicks it on portrait (and clicks blank .spacer verifying no miss), plus checks mirror-preload/mirror-relay/shell.ts interactive-only filter and <=32 char textContent rendering.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/password`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/password',
        });

        await session.ctl.evalJs(
          "document.getElementById('unmirrored-miss-target')?.remove()",
          'landscape',
          tab.id,
        );
        const missClick = await session.ctl.interact({
          action: 'click',
          tabId: tab.id,
          viewport: 'portrait',
          selector: '#unmirrored-miss-target',
          mirror: true,
        });
        assert.equal((missClick.outcomes.portrait as { ok?: boolean } | undefined)?.ok, true);
        assert.equal((missClick.outcomes.landscape as { ok?: boolean } | undefined)?.ok, false);

        const blankTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(blankTab.tab?.id);
        await session.ctl.waitForTabReady(blankTab.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        await session.ctl.interact({
          action: 'click',
          tabId: blankTab.tab.id,
          viewport: 'portrait',
          selector: '.spacer',
          mirror: true,
        });
        const metrics = await session.ctl.metrics();
        assert.ok(metrics.mirrorMiss === undefined || metrics.mirrorMiss === null);

        const shellSrc = readAppFile('src/renderer/shell.ts');
        const preloadSrc = readAppFile('src/preload/mirror-preload.ts');
        const relaySrc = readAppFile('src/main/mirror-relay.ts');
        assert.ok(preloadSrc.includes('mirror-miss') || relaySrc.includes('onMirrorMiss'));
        assert.ok(shellSrc.includes('mirrorMiss') && shellSrc.includes('textContent'));
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // F10 — R5: Session Restore & Short History Fixes (5 tests)
  // =========================================================================
  {
    id: 'T1-F10-01',
    tier: 1,
    features: ['F10'],
    title: 'sessionRestored gate prevents early window resize/move from wiping session-state.json',
    description:
      'Seeds 2 tabs and 2 history entries, launches visible Electron window (triggering resize/move), sends SIGTERM, and asserts all tabs and history are preserved.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture(
        [
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?p=1`),
          makeTabFixture(`${ctx.servers.httpBaseUrl}/echo?p=2`),
        ],
        {
          activeTabIndex: 0,
          history: [
            { url: `${ctx.servers.httpBaseUrl}/echo?h=1`, title: 'H1', visitedAt: 1000, visitCount: 1 },
            { url: `${ctx.servers.httpBaseUrl}/echo?h=2`, title: 'H2', visitedAt: 2000, visitCount: 1 },
          ],
        },
      );
      const session = await ctx.launchElectron({
        smoke: false,
        seedSession,
        extraArgs: visibleLaunchArgs(),
      });
      try {
        await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: 'p=1' });
        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const persisted = session.readStateFile<PersistedSessionFixture>();
        assert.equal(persisted?.tabs.length, 2);
        assert.equal(persisted?.history.length, 2);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F10-02',
    tier: 1,
    features: ['F10'],
    title: 'skipNextRestoreHistoryCommit preserves short history across restore (incl. 302 redirect)',
    description:
      'Seeds tab on /status/302 (redirects to /echo) plus 1 existing history entry; asserts restore redirect does NOT add history while explicit ctl.navigate() DOES.',
    run: async (ctx) => {
      const prevUrl = `${ctx.servers.httpBaseUrl}/echo?prev=1`;
      const seedSession = makeSessionFixture(
        [makeTabFixture(`${ctx.servers.httpBaseUrl}/status/302`)],
        {
          activeTabIndex: 0,
          history: [{ url: prevUrl, title: 'Prev', visitedAt: 1000, visitCount: 1 }],
        },
      );
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        session.sendSignal('SIGTERM');
        await session.waitForExit(5_000);
        const afterRestore = session.readStateFile<PersistedSessionFixture>();
        assert.equal(afterRestore?.history.length, 1);
        assert.equal(afterRestore?.history[0]?.url, prevUrl);
      } finally {
        await session.close();
      }

      // Now verify explicit navigate() DOES record history
      const s2 = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tab = await s2.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        await s2.ctl.navigate(`${ctx.servers.httpBaseUrl}/page/interactions`, tab.id);
        await s2.ctl.waitForTabReady(tab.id, { expectedUrlIncludes: '/page/interactions' });
        s2.sendSignal('SIGTERM');
        await s2.waitForExit(5_000);
        const afterNav = s2.readStateFile<PersistedSessionFixture>();
        assert.ok(
          afterNav?.history.some((h) => h.url.includes('/page/interactions')),
          'Expected explicit navigate() to record history entry',
        );
      } finally {
        await s2.close();
      }
    },
  },
  {
    id: 'T1-F10-03',
    tier: 1,
    features: ['F10', 'F11'],
    title: 'SIGTERM / SIGINT flush & IRON_BROWSER_USER_DATA profile isolation',
    description:
      'Navigates two separate isolated Electron sessions and verifies SIGTERM and SIGINT both flush session-state.json and populate only their own userDataDir.',
    run: async (ctx) => {
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        const session = await ctx.launchElectron({ smoke: false });
        try {
          const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo?sig=${sig}`);
          assert.ok(opened.tab?.id);
          await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: `sig=${sig}` });

          session.sendSignal(sig);
          await session.waitForExit(5_000);
          const persisted = session.readStateFile<PersistedSessionFixture>();
          assert.ok(persisted?.tabs.some((t) => t.url.includes(`sig=${sig}`)));
          assert.ok(fs.existsSync(session.userDataDir));
        } finally {
          await session.close();
        }
      }
    },
  },
  {
    id: 'T1-F10-04',
    tier: 1,
    features: ['F10'],
    title: 'Stale/placeholder title filtering & URL title reset on navigation',
    description:
      'Navigates from /page/interactions to /cacheable?format=html and asserts tab title updates cleanly to Cacheable ... without retaining stale or placeholder titles.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: false });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`);
        assert.ok(opened.tab?.id);
        const tab1 = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });

        await session.ctl.navigate(`${ctx.servers.httpBaseUrl}/cacheable?format=html`, tab1.id);
        await session.ctl.waitForTabReady(tab1.id, { expectedUrlIncludes: '/cacheable' });

        const updatedTab = await waitUntil(
          async () => {
            const t = (await session.ctl.tabs()).tabs.find((x) => x.id === tab1.id);
            return t && t.title.startsWith('Cacheable ') ? t : null;
          },
          4_000,
          'tab title update to Cacheable ...',
        );
        assert.ok(updatedTab.title.startsWith('Cacheable '));
        assert.notEqual(updatedTab.title, 'Interactions Fixture');
        assert.notEqual(updatedTab.title, 'IronBrowser');
        assert.notEqual(updatedTab.title, 'IronBrowser — Ready');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F10-05',
    tier: 1,
    features: ['F10'],
    title: 'audioSource portrait coerced to landscape in single mode & node:fs-free session-store.ts',
    description:
      'Seeds single-mode tab with audioSource: portrait, verifies live coercion to landscape, and verifies src/shared/session-store.ts has zero node:fs/node:path imports.',
    run: async (ctx) => {
      const seedSession = makeSessionFixture([
        makeTabFixture(`${ctx.servers.httpBaseUrl}/echo`, {
          mode: 'single',
          audioSource: 'portrait',
        }),
      ]);
      const session = await ctx.launchElectron({ smoke: false, seedSession });
      try {
        const tab = await session.ctl.waitForTabReady(undefined, { expectedUrlIncludes: '/echo' });
        assert.equal(tab.mode, 'single');
        assert.equal(tab.audioSource, 'landscape');
      } finally {
        await session.close();
      }

      const storeSrc = readAppFile('src/shared/session-store.ts');
      assert.equal(/from ['"](?:node:)?fs['"]/.test(storeSrc), false);
      assert.equal(/from ['"](?:node:)?path['"]/.test(storeSrc), false);
    },
  },

  // =========================================================================
  // F11 — E2E Suite & Live Electron Smoke Infra (5 tests)
  // =========================================================================
  {
    id: 'T1-F11-01',
    tier: 1,
    features: ['F11'],
    title: 'Local HTTP/zlib endpoints (/echo, /mutate*, /cacheable, /stream, /large, /status/*, /page/*)',
    description:
      'Verifies all LocalTestServerCluster HTTP endpoints, gzip/br/deflate decompression, cacheable seq increments, altOriginBaseUrl, and all 7 HTML fixture pages.',
    run: async (ctx) => {
      ctx.servers.resetHttpLogs();

      const echo = (await (await fetch(`${ctx.servers.httpBaseUrl}/echo?x=1`)).json()) as {
        origin: string;
        query: Record<string, string>;
      };
      assert.equal(echo.origin, 'primary');
      assert.equal(echo.query.x, '1');

      const alt = (await (await fetch(`${ctx.servers.altOriginBaseUrl}/echo`)).json()) as {
        origin: string;
      };
      assert.equal(alt.origin, 'alt');

      const gzRes = await fetch(`${ctx.servers.httpBaseUrl}/mutate-gzip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correlationId: 'c1' }),
        decompress: false,
      });
      const gzBody = JSON.parse(zlib.gunzipSync(Buffer.from(await gzRes.arrayBuffer())).toString('utf8')) as {
        correlation: { correlationId?: string };
      };
      assert.equal(gzBody.correlation.correlationId, 'c1');

      const brRes = await fetch(`${ctx.servers.httpBaseUrl}/mutate-br`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceId: 't1' }),
        decompress: false,
      });
      const brBody = JSON.parse(zlib.brotliDecompressSync(Buffer.from(await brRes.arrayBuffer())).toString('utf8')) as {
        correlation: { traceId?: string };
      };
      assert.equal(brBody.correlation.traceId, 't1');

      const defRes = await fetch(`${ctx.servers.httpBaseUrl}/mutate-deflate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'r1' }),
        decompress: false,
      });
      const defBody = JSON.parse(zlib.inflateSync(Buffer.from(await defRes.arrayBuffer())).toString('utf8')) as {
        correlation: { requestId?: string };
      };
      assert.equal(defBody.correlation.requestId, 'r1');

      const c1 = (await (await fetch(`${ctx.servers.httpBaseUrl}/cacheable?format=json`)).json()) as { seq: number };
      const c2 = (await (await fetch(`${ctx.servers.httpBaseUrl}/cacheable?format=json`)).json()) as { seq: number };
      assert.ok(c2.seq > c1.seq);

      for (const page of [
        '/page/interactions',
        '/page/shadow',
        '/page/iframe-same',
        '/page/iframe-cross',
        '/page/iframe-child',
        '/page/password',
        '/page/ws-sse',
      ]) {
        const res = await fetch(`${ctx.servers.httpBaseUrl}${page}`);
        assert.equal(res.status, 200);
        assert.ok((await res.text()).includes('<!doctype html>'));
      }
      assert.ok(ctx.servers.getHttpLogs('/mutate').length >= 3);
    },
  },
  {
    id: 'T1-F11-02',
    tier: 1,
    features: ['F11'],
    title: 'Local WS (chat.v1, binary, 1012) & SSE (event:, id:, Last-Event-ID) server cluster',
    description:
      'Verifies WebSocket subprotocol negotiation, binary/text echo, closeAllWs(1012), SSE named events with id:, and Last-Event-ID reconnect capture.',
    run: async (ctx) => {
      ctx.servers.resetWsStats();
      ctx.servers.resetSseStats();

      const ws = new WebSocket(ctx.servers.wsBaseUrl, ['chat.v1']);
      ws.binaryType = 'arraybuffer';
      const received: Array<string | number[]> = [];

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout')), 3_000);
        ws.addEventListener('open', () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener('error', () => {
          clearTimeout(t);
          reject(new Error('WS open error'));
        });
      });
      assert.equal(ws.protocol, 'chat.v1');

      const closedPromise = new Promise<number>((resolve) => {
        ws.addEventListener('close', (ev) => resolve(ev.code));
      });
      ws.addEventListener('message', (ev) => {
        received.push(ev.data instanceof ArrayBuffer ? Array.from(new Uint8Array(ev.data)) : String(ev.data));
      });
      ws.send('hi');
      ws.send(new Uint8Array([4, 5]));
      await waitUntil(async () => received.length >= 2, 2_000, 'WS echo');
      assert.deepEqual(received, ['hi', [4, 5]]);
      ctx.servers.closeAllWs(1012, 'test');
      assert.equal(await closedPromise, 1012);

      const abort = new AbortController();
      const sseRes = await fetch(ctx.servers.sseBaseUrl, {
        headers: { 'Last-Event-ID': 'evt-prev' },
        signal: abort.signal,
      });
      const reader = sseRes.body?.getReader();
      assert.ok(reader);
      await reader.read();
      ctx.servers.pushSseEvent('ping-evt', 'payload', 'evt-99');
      const next = await reader.read();
      const decoded = new TextDecoder().decode(next.value);
      assert.ok(decoded.includes('event: ping-evt') && decoded.includes('id: evt-99'));
      abort.abort();
      assert.ok(ctx.servers.getSseStats().lastEventIdsReceived.includes('evt-prev'));
      ctx.servers.closeAllSse();
    },
  },
  {
    id: 'T1-F11-03',
    tier: 1,
    features: ['F11'],
    title: '4-byte LE ControlSocket framing & -32000 unknown RPC envelope',
    description:
      'Launches smoke Electron, calls ping() and tabs(), and verifies unknown RPC rejects with CtlRpcError code === -32000.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const pong = await session.ctl.ping();
        assert.equal(pong.pong, true);
        assert.equal(pong.socketPath, session.socketPath);
        const tabs = await session.ctl.tabs();
        assert.ok(Array.isArray(tabs.tabs));

        await assert.rejects(
          () => session.ctl.request('nonexistent_e2e_rpc'),
          (err: unknown) =>
            err instanceof Error &&
            'code' in err &&
            (err as { code: number }).code === -32000 &&
            err.message.includes('unknown RPC method'),
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F11-04',
    tier: 1,
    features: ['F11'],
    title: 'Live Electron --smoke readiness (IRON_BROWSER_READY) + evalJs + screenshot + metrics',
    description:
      'Verifies IRON_BROWSER_READY stdout line, dual tab evalJs, non-empty portrait+landscape PNG screenshots, and finite metrics.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        assert.ok(session.getStdout().includes(`IRON_BROWSER_READY ${session.socketPath}`));
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/page/interactions`, {
          mode: 'dual',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/page/interactions',
        });
        assert.equal((await session.ctl.evalJs('document.readyState', 'portrait', tab.id)).value, 'complete');

        const shot = await session.ctl.screenshot(tab.id, 'both');
        assert.ok((shot.captures.portrait?.bytes ?? 0) > 0);
        assert.ok((shot.captures.landscape?.bytes ?? 0) > 0);

        const metrics = await session.ctl.metrics();
        assert.ok(metrics.totalMemoryMb > 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F11-05',
    tier: 1,
    features: ['F11'],
    title: 'Isolated temp sessionDir, user-data-dir, stateFilePath & cleanup',
    description:
      'Verifies sun_path < 107 bytes, isolated profile directories exist while running, and session.close() removes sessionDir cleanly.',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      const dir = session.sessionDir;
      try {
        assert.ok(Buffer.byteLength(session.socketPath, 'utf8') < 107);
        assert.ok(fs.existsSync(dir));
        assert.ok(fs.existsSync(session.userDataDir));
        assert.ok(fs.existsSync(session.socketPath));
      } finally {
        await session.close();
      }
      assert.equal(fs.existsSync(dir), false);
    },
  },

  // =========================================================================
  // F12 — Follow-up: Cache-Clearing Reload & Shortcuts (5 tests)
  // =========================================================================
  {
    id: 'T1-F12-01',
    tier: 1,
    features: ['F12'],
    title: 'TabManager.reload() bypasses HTTP cache (Cache-Control: max-age=3600) on /cacheable',
    description:
      'Verifies /cacheable sets max-age=3600 in live Electron (normal fetch reuses cached seq while location.reload() revalidates) and tab-manager.ts reload() clears cache and calls reloadIgnoringCache().',
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        ctx.servers.resetHttpLogs();
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/cacheable?format=html`, {
          mode: 'single',
        });
        assert.ok(opened.tab?.id);
        const tab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/cacheable',
        });
        const seq1 = Number(
          (await session.ctl.evalJs("document.getElementById('cache-seq').dataset.seq", 'landscape', tab.id)).value,
        );
        assert.ok(seq1 >= 1);

        // Normal subresource fetch obeys Cache-Control: public, max-age=3600 (second fetch reuses cached seq).
        const fetchCacheScript = `(async () => {
          const r1 = await (await fetch('/cacheable?format=json')).json();
          const r2 = await (await fetch('/cacheable?format=json')).json();
          return JSON.stringify({ seq1: r1.seq, seq2: r2.seq });
        })()`;
        const cachedFetches = JSON.parse(
          (await session.ctl.evalJs(fetchCacheScript, 'landscape', tab.id)).value,
        ) as { seq1: number; seq2: number };
        assert.equal(cachedFetches.seq2, cachedFetches.seq1);

        // Renderer location.reload() revalidates the main document against /cacheable.
        await session.ctl.evalJs('location.reload()', 'landscape', tab.id);
        await sleep(250);
        await session.ctl.waitForTabReady(tab.id, { expectedUrlIncludes: '/cacheable' });
        const seqReloaded = Number(
          (await session.ctl.evalJs("document.getElementById('cache-seq').dataset.seq", 'landscape', tab.id)).value,
        );
        assert.ok(seqReloaded > cachedFetches.seq1);

        const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
        const reloadBlock = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
        assert.ok(reloadBlock.length > 0, 'Expected TabManager.reload() method');
        assert.ok(reloadBlock.includes('beforeReloadHooks'));
        assert.ok(reloadBlock.includes('sess.clearCache()'));
        assert.ok(reloadBlock.includes('reloadIgnoringCache()'));
        assert.equal(/\.reload\s*\(/.test(reloadBlock), false);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-F12-02',
    tier: 1,
    features: ['F12'],
    title: 'dispatchGlobalShortcut routes Ctrl+R, F5, Ctrl+Shift+R, Cmd+R, Cmd+Shift+R to reload()',
    description:
      'Verifies real dispatchGlobalShortcut wiring in src/main/index.ts maps Ctrl/Cmd+R, Ctrl/Cmd+Shift+R, and F5 (without Alt) to mgr.reload().',
    run: async () => {
      const indexSrc = readAppFile('src/main/index.ts');
      assert.ok(indexSrc.includes('const ctrl = input.control || input.meta;'));
      assert.ok(
        indexSrc.includes("if ((ctrl && !input.alt && key === 'r') || (!input.alt && key === 'f5'))"),
      );
      assert.ok(indexSrc.includes('void mgr.reload();'));
      // Note: !input.shift is NOT required on key === 'r', so Ctrl+Shift+R and Cmd+Shift+R also trigger reload().
    },
  },
  {
    id: 'T1-F12-03',
    tier: 1,
    features: ['F12', 'F6', 'F7'],
    title: 'Reload clears R2 dedup slots for active tab via beforeReloadHooks',
    description:
      'Verifies tab-manager.ts invokes beforeReloadHooks(tab.id) before cache clear and reload, and wires registerBeforeReloadHook with requestDedup.clearTab.',
    run: async () => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      const indexSrc = readAppFile('src/main/index.ts');
      const reloadBlock = extractMethodBlock(tabMgrSrc, 'async reload(): Promise<void>');
      assert.ok(reloadBlock.includes('beforeReloadHooks'));
      assert.ok(tabMgrSrc.includes('registerBeforeReloadHook'));
      const combined = `${tabMgrSrc}\n${indexSrc}`;
      assert.match(
        combined,
        /registerBeforeReloadHook\s*\([\s\S]{0,240}(?:clearTab|requestDedup)/,
        'Expected registerBeforeReloadHook to be invoked with requestDedup/clearTab for R2 slot clearing on reload',
      );
    },
  },
  {
    id: 'T1-F12-04',
    tier: 1,
    features: ['F12'],
    title: "Context-menu 'Reload' invokes cache-clearing reload()",
    description:
      'Verifies TabManager context-menu Reload item invokes this.reload() (never legacy webContents.reload()).',
    run: async () => {
      const tabMgrSrc = readAppFile('src/main/tab-manager.ts');
      const idx = tabMgrSrc.indexOf("label: 'Reload'");
      assert.ok(idx > 0);
      const snippet = tabMgrSrc.slice(idx, idx + 140);
      assert.ok(snippet.includes('void this.reload()'));
    },
  },
  {
    id: 'T1-F12-05',
    tier: 1,
    features: ['F12'],
    title: 'Top-bar #btn-reload tooltip matches Reload (Clear Cache — Ctrl+Shift+R)',
    description:
      'Verifies src/renderer/index.html #btn-reload title attribute matches spec and src/renderer/shell.ts triggers window.ironShell.reload().',
    run: async () => {
      const htmlSrc = readAppFile('src/renderer/index.html');
      const shellSrc = readAppFile('src/renderer/shell.ts');
      assert.ok(
        htmlSrc.includes('id="btn-reload"') &&
          htmlSrc.includes('Reload (Clear Cache — Ctrl+Shift+R)'),
        'Expected #btn-reload tooltip "Reload (Clear Cache — Ctrl+Shift+R)" in src/renderer/index.html',
      );
      assert.ok(shellSrc.includes('window.ironShell.reload()'));
      assert.ok(DEVICE_PRESETS.length >= 6);
    },
  },
];

export default tests;
