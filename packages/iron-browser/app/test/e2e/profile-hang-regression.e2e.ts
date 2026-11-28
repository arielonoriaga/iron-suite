import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exact E2E regression for `.teamwork-handoff/HANG_REPORT_2026-11-27.md`:
 * 1. `browser_emulate` `{ tab_id, viewport: 'portrait', profile: 'sunmi-v2-pro' }` (6× CPU, slow-4g)
 * 2. `browser_profile` `{ tab_id, viewport: 'portrait', action: 'start' }`
 * 3. `browser_navigate` `{ tab_id, url: '<heavy POS SPA>' }`
 * 4. Wait a real 45 seconds while the heavy SPA executes continuous JS hotspots, DOM renders,
 *    API fetches (exercising CDP RequestDedupMiddleware), and SSE frames under 6× CPU throttle.
 * 5. Issue `browser_profile { action: 'stop', viewport: 'portrait', top: 40 }` concurrently with
 *    2 `browser_eval` calls in the same session.
 * 6. Verify all 3 replies arrive promptly, `.cpuprofile` is written (`0600`), `browser_health`
 *    reports 0 stalls / 0 crashes + structured RPC begin/end logs, and shutdown completes cleanly.
 */
async function runProfileHangRegressionE2E(): Promise<void> {
  const openSockets = new Set<Socket>();
  let apiTickCount = 0;

  const heavyPosHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Heavy POS Startup & Runtime</title>
</head>
<body>
  <div id="pos-root">
    <h1 id="pos-status">booting</h1>
    <ul id="cart-items"></ul>
  </div>
  <script>
    window.__posTicks = 0;
    window.__sseEvents = 0;

    function posStartupHydrateCatalog() {
      let acc = 0;
      for (let i = 1; i <= 180000; i += 1) {
        acc = (acc + ((i * 2654435761) >>> 0)) % 1000003;
      }
      return acc;
    }

    function posReconcileCartHotspot(iter) {
      let checksum = iter;
      for (let i = 1; i <= 90000; i += 1) {
        checksum = (checksum ^ ((i * 40503) & 0xffff)) + (i % 7);
      }
      const ul = document.getElementById('cart-items');
      if (ul) {
        ul.innerHTML = '';
        for (let r = 0; r < 18; r += 1) {
          const li = document.createElement('li');
          li.textContent = 'Burger #' + r + ' (' + (checksum % 997) + ')';
          ul.appendChild(li);
        }
      }
      return checksum;
    }

    // Startup burst during navigation load
    const bootDigest = posStartupHydrateCatalog();
    document.getElementById('pos-status').textContent = 'ready:' + bootDigest;

    // Live SSE stream + periodic background API sync & CPU bursts over the entire 45s window
    const es = new EventSource('/api/pos-events');
    es.addEventListener('cart_sync', () => {
      window.__sseEvents += 1;
    });

    setInterval(() => {
      window.__posTicks += 1;
      posReconcileCartHotspot(window.__posTicks);
      fetch('/api/pos-sync?tick=' + window.__posTicks, { cache: 'no-store' }).catch(() => {});
    }, 350);
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/api/pos-sync') {
      apiTickCount += 1;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, tick: apiTickCount }));
      return;
    }
    if (reqUrl.pathname === '/api/pos-events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('event: cart_sync\ndata: {"items":4}\n\n');
      const iv = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(iv);
          return;
        }
        res.write(`event: cart_sync\ndata: {"ts":${Date.now()}}\n\n`);
      }, 800);
      iv.unref?.();
      req.on('close', () => clearInterval(iv));
      return;
    }
    if (reqUrl.pathname === '/landing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Landing</h1></body></html>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(heavyPosHtml);
  });

  server.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind E2E server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const waitDurationMs = Number(process.env.IRON_PROFILE_SOAK_MS ?? 45_000);
  const session = await launchElectronSession({ smoke: true });

  try {
    const opened = await session.ctl.open(`${baseUrl}/landing`, {
      mode: 'dual',
      session: 'shared',
    });
    const tabId = opened.activeTabId!;
    await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/landing' });

    // 1. Apply sunmi-v2-pro on portrait (6x CPU, slow-4g)
    const emu = await session.ctl.emulate<{ ok: boolean }>({
      tab_id: tabId,
      viewport: 'portrait',
      profile: 'sunmi-v2-pro',
    });
    assert.equal(emu.ok, true);

    // 2. Start CPU profile BEFORE navigating to /pos
    const started = await session.ctl.profile<{
      ok: boolean;
      action: string;
      samplingIntervalUs: number;
    }>({
      tab_id: tabId,
      viewport: 'portrait',
      action: 'start',
    });
    assert.equal(started.ok, true);
    assert.equal(started.action, 'start');

    // 3. Navigate to heavy POS SPA while profiler is active
    await session.ctl.navigate(`${baseUrl}/pos`, tabId);
    await session.ctl.waitForTabReady(tabId, {
      expectedUrlIncludes: '/pos',
      timeoutMs: 20_000,
    });

    // 4. Soak for 45 seconds under 6x CPU throttle + slow-4g + live fetches & SSE
    await sleep(waitDurationMs);

    // 5. Concurrent stop + 2 browser_eval calls in the same session (exact hang repro!)
    const tStop0 = performance.now();
    const [stopped, eval1, eval2] = await Promise.all([
      session.ctl.profile<{
        ok: boolean;
        action: string;
        profilePath: string;
        profileBytes: number;
        truncated: boolean;
        summary: {
          sampleCount: number;
          activeMs: number;
          functions: Array<{ functionName: string; selfMs: number; totalMs: number }>;
          scripts: Array<{ url: string; selfMs: number }>;
        };
      }>({
        tab_id: tabId,
        viewport: 'portrait',
        action: 'stop',
        top: 40,
      }),
      session.ctl.evalJs(`document.getElementById('pos-status')?.textContent`, 'portrait', tabId),
      session.ctl.evalJs(`JSON.stringify({ ticks: window.__posTicks, sse: window.__sseEvents })`, 'portrait', tabId),
    ]);
    const stopElapsedMs = performance.now() - tStop0;

    // 6. Verify all 3 RPCs succeeded cleanly and app remains responsive!
    assert.equal(stopped.ok, true);
    assert.equal(stopped.action, 'stop');
    assert.equal(fs.existsSync(stopped.profilePath), true, 'expected .cpuprofile on disk');
    const st = fs.statSync(stopped.profilePath);
    assert.equal(st.mode & 0o777, 0o600, 'expected 0600 permissions on .cpuprofile');
    assert.ok(stopped.profileBytes > 100);
    assert.ok(stopped.summary.sampleCount > 0, 'expected non-zero CPU samples across navigated /pos');
    assert.ok(stopped.summary.functions.length > 0 && stopped.summary.functions.length <= 40);
    assert.ok(String(eval1.value).startsWith('ready:'));
    const eval2Parsed = JSON.parse(eval2.value) as { ticks: number; sse: number };
    assert.ok(eval2Parsed.ticks >= 5, `expected background POS ticks >= 5, got ${eval2Parsed.ticks}`);

    // 7. Verify browser_health reports structured main.log lines, 0 stalls, and 0 crashed viewports
    const health = await session.ctl.health<{
      ok: boolean;
      socketReachable: boolean;
      logPath: string;
      watchdog: { running: boolean; stallCount: number; shuttingDown: boolean };
      viewports: Array<{ viewport: string; crashed: boolean; unresponsive: boolean }>;
      recentLogs: string[];
    }>(80);
    assert.equal(health.ok, true);
    assert.equal(health.socketReachable, true);
    assert.equal(health.watchdog.running, true);
    assert.equal(health.watchdog.stallCount, 0, `expected 0 main-thread stalls, got ${health.watchdog.stallCount}`);
    assert.equal(health.viewports.every((v) => !v.crashed && !v.unresponsive), true);
    assert.ok(
      health.recentLogs.some((l) => l.includes('"method":"browser_profile"') && l.includes('"event":"rpc.end"')),
      'expected structured rpc.end log entry for browser_profile in main.log',
    );

    console.log(
      `PASS profile-hang-regression.e2e.ts (soak=${waitDurationMs}ms, stopRpc=${stopElapsedMs.toFixed(1)}ms, profileBytes=${stopped.profileBytes}, samples=${stopped.summary.sampleCount}, ticks=${eval2Parsed.ticks}, stalls=${health.watchdog.stallCount})`,
    );
  } finally {
    const closeStart = performance.now();
    await session.close();
    const closeMs = performance.now() - closeStart;
    assert.ok(closeMs < 8_000, `expected clean shutdown < 8s without hang, took ${closeMs.toFixed(0)}ms`);
    for (const sock of openSockets) {
      sock.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await runProfileHangRegressionE2E();
