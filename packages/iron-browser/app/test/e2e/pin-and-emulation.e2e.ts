import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await check();
      if (res !== null) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(40);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ''}`,
  );
}

async function runPinAndEmulationE2E(): Promise<void> {
  const openSockets = new Set<Socket>();
  const pingHeaders: Array<{ ua: string; saveData: string | null }> = [];
  let pinIdentifyPosts = 0;
  let crossOriginSseOptionsCount = 0;
  let crossOriginSseGetCount = 0;
  let crossOriginHadCacheControlHeader = false;
  let crossOriginBaseUrl = '';

  const pinSpaHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EZ POS PinScreen Replica</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }
    .keypad { display: grid; grid-template-columns: repeat(3, 56px); gap: 8px; margin-top: 12px; }
    button { min-height: 40px; padding: 8px 14px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="app"></div>
  <input id="normal-note" type="text" placeholder="Order note" value="" style="margin-top:16px;display:block;padding:8px;" />
  <script>
    // Exact replica of ez-commerce auth.tsx + PinScreen.tsx + Numpad.tsx:
    // employeeJwt is hydrated from sessionStorage ONLY ONCE on initial module boot!
    window.__bootId = Math.random().toString(36).slice(2);
    window.__employeeJwt = sessionStorage.getItem('ez-stock:employee-jwt');
    window.__pinDigits = '';
    window.__inputEventsOnPin = 0;
    window.__ahoraNoClicks = 0;

    function enforceRouteGuard() {
      if (location.pathname.startsWith('/pos') && !window.__employeeJwt) {
        history.replaceState(null, '', '/login');
      } else if (location.pathname === '/login' && window.__employeeJwt) {
        history.replaceState(null, '', '/pos/cart');
      }
    }

    function render() {
      enforceRouteGuard();
      const root = document.getElementById('app');
      if (location.pathname === '/pos/cart' && window.__employeeJwt) {
        root.innerHTML =
          '<h1 id="screen-title">POS Cart Unlocked</h1>' +
          '<button id="btn-ahora-no" type="button">Ahora no</button>' +
          '<span id="ahora-count">' + window.__ahoraNoClicks + '</span>';
        document.getElementById('btn-ahora-no').addEventListener('click', () => {
          window.__ahoraNoClicks += 1;
          document.getElementById('ahora-count').textContent = String(window.__ahoraNoClicks);
        });
        return;
      }

      root.innerHTML =
        '<h1 id="screen-title">Ingresá tu PIN</h1>' +
        '<div id="pin-dots" data-len="' + window.__pinDigits.length + '">' + '*'.repeat(window.__pinDigits.length) + '</div>' +
        '<input id="pin-sr-input" type="text" inputmode="none" autocomplete="off" aria-label="PIN" class="sr-only" value="" />' +
        '<div class="keypad">' +
          ['1','2','3','4','5','6','7','8','9','⌫','0'].map((k) =>
            '<button type="button" data-key="' + k + '">' + k + '</button>'
          ).join('') +
        '</div>';

      const srInput = document.getElementById('pin-sr-input');
      srInput.addEventListener('input', () => {
        window.__inputEventsOnPin += 1;
      });
      srInput.addEventListener('keydown', (e) => {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          handleDigit(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          handleDigit('⌫');
        }
      });
      root.querySelectorAll('button[data-key]').forEach((btn) => {
        btn.addEventListener('click', () => handleDigit(btn.getAttribute('data-key')));
      });
      srInput.focus();
    }

    async function handleDigit(k) {
      if (k === '⌫') {
        window.__pinDigits = window.__pinDigits.slice(0, -1);
        const dots = document.getElementById('pin-dots');
        if (dots) {
          dots.setAttribute('data-len', String(window.__pinDigits.length));
          dots.textContent = '*'.repeat(window.__pinDigits.length);
        }
        return;
      }
      if (window.__pinDigits.length >= 4) return;
      window.__pinDigits += k;
      const dots = document.getElementById('pin-dots');
      if (dots) {
        dots.setAttribute('data-len', String(window.__pinDigits.length));
        dots.textContent = '*'.repeat(window.__pinDigits.length);
      }
      if (window.__pinDigits.length === 4) {
        const pin = window.__pinDigits;
        const res = await fetch('/auth/pin-identify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json();
        if (data.ok && data.jwt) {
          sessionStorage.setItem('ez-stock:employee-jwt', data.jwt);
          window.__employeeJwt = data.jwt;
          history.pushState(null, '', '/pos/cart');
          render();
        }
      }
    }

    window.addEventListener('popstate', () => render());
    document.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a) return;
      const u = new URL(a.href, location.href);
      if (u.origin === location.origin) {
        ev.preventDefault();
        history.pushState(null, '', u.pathname + u.search + u.hash);
        render();
      }
    });

    render();
  </script>
</body>
</html>`;

  const benchHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Slow Device Benchmark Fixture</title>
</head>
<body>
  <h1 id="bench-heading">Benchmark Ready</h1>
  <script>
    window.runFixedCpuBench = function(batches) {
      const runBatch = (seed) => {
        let x = (seed | 0) || 0x1234567;
        const arr = new Int32Array(64);
        for (let i = 0; i < 4000; i += 1) {
          x = (Math.imul(x ^ (x >>> 13), 0x5bd1e995) + i) | 0;
          arr[i & 63] = (arr[(i + 7) & 63] + x) | 0;
        }
        return (x ^ arr[19]) | 0;
      };
      // Warmup JIT
      let sink = 1;
      for (let w = 0; w < 8; w += 1) sink ^= runBatch(w + 1);

      const t0 = performance.now();
      for (let b = 0; b < batches; b += 1) {
        sink ^= runBatch(b + 1);
      }
      const elapsedMs = performance.now() - t0;
      return { elapsedMs, sink };
    };

    window.sunmiHotspotProfileWork = function() {
      let acc = 0x9e3779b9;
      const buf = new Int32Array(128);
      const t0 = performance.now();
      while (performance.now() - t0 < 85) {
        for (let i = 0; i < 4000; i += 1) {
          acc = (Math.imul(acc ^ (acc >>> 15), 0x85ebca6b) + i) | 0;
          buf[i & 127] = (buf[(i + 13) & 127] ^ acc) | 0;
        }
      }
      return acc ^ buf[7];
    };

    window.measureFetchLatency = async function() {
      const t0 = performance.now();
      const res = await fetch('/api/ping?t=' + Date.now(), { cache: 'no-store' });
      const body = await res.json();
      return { elapsedMs: performance.now() - t0, body };
    };
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/auth/pin-identify' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        pinIdentifyPosts += 1;
        const parsed = JSON.parse(body || '{}') as { pin?: string };
        const ok = parsed.pin === '1591';
        res.writeHead(ok ? 200 : 401, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(ok ? { ok: true, jwt: 'jwt-emp-1591' } : { ok: false }));
      });
      return;
    }

    if (reqUrl.pathname === '/api/ping') {
      const ua = String(req.headers['user-agent'] ?? '');
      const saveData =
        typeof req.headers['save-data'] === 'string' ? req.headers['save-data'] : null;
      pingHeaders.push({ ua, saveData });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, ua, saveData }));
      return;
    }

    if (reqUrl.pathname === '/bench') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(benchHtml);
      return;
    }

    if (reqUrl.pathname === '/pos-sse') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cross-Origin SSE</title></head>
<body>
  <div id="sse-state">connecting</div>
  <script>
    window.__sseSnapshots = [];
    window.__sseErrors = 0;
    const es = new EventSource(${JSON.stringify('') } + window.location.hash.slice(1));
    es.addEventListener('open', () => {
      document.getElementById('sse-state').textContent = 'open';
    });
    es.addEventListener('carts_snapshot', (ev) => {
      window.__sseSnapshots.push(ev.data);
      document.getElementById('sse-state').textContent = 'snapshot:' + ev.data;
    });
    es.addEventListener('error', () => {
      window.__sseErrors += 1;
    });
  </script>
</body>
</html>`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(pinSpaHtml);
  });

  server.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind E2E HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Second HTTP server on a distinct origin (different port) simulating
  // https://api.pos-terminal.example.com/api/v1/events?... accessed from https://app.pos-terminal.example.com:
  // Strictly rejects OPTIONS preflights (405) and rejects non-CORS-safelisted Cache-Control request headers!
  const sseServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      crossOriginSseOptionsCount += 1;
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed: EventSource must not send CORS preflight');
      return;
    }
    if (reqUrl.pathname === '/api/v1/events' && req.method === 'GET') {
      crossOriginSseGetCount += 1;
      if (req.headers['cache-control'] !== undefined) {
        crossOriginHadCacheControlHeader = true;
      }
      const origin = req.headers.origin ?? '*';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': String(origin),
      });
      res.write(
        `id: evt-1\nevent: carts_snapshot\ndata: ${JSON.stringify({ sellPoint: reqUrl.searchParams.get('sell_point_id'), items: 3 })}\n\n`,
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  sseServer.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise<void>((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
  const sseAddr = sseServer.address();
  if (!sseAddr || typeof sseAddr === 'string') {
    throw new Error('Failed to bind cross-origin SSE server');
  }
  crossOriginBaseUrl = `http://127.0.0.1:${sseAddr.port}`;

  const session = await launchElectronSession({ smoke: true });

  try {
    // Verify native Rust TabEventBus backend is loaded
    const initEvents = await session.ctl.events({ limit: 5 });
    assert.equal(initEvents.backend, 'rust-napi');

    // =========================================================================
    // PART 1: PIN Screen Physical Keyboard Sync + Post-Miss Route Reconciliation
    // =========================================================================
    const openedPin = await session.ctl.open(`${baseUrl}/login`, {
      mode: 'dual',
      session: 'shared',
    });
    const pinTabId = openedPin.activeTabId!;
    await session.ctl.waitForTabReady(pinTabId, { expectedUrlIncludes: '/login' });

    // Ensure #pin-sr-input is focused in landscape (just like clicking the landscape pane on DP-1)
    await session.ctl.evalJs(`document.getElementById('pin-sr-input')?.focus()`, 'landscape', pinTabId);

    // Simulate a REAL human typing '1', '5', '2', 'Backspace', '9', '1' (= '1591') ONLY on landscape
    // via simulate_human: true (no EchoLoopGuard on source pane -> exercises mirror-preload.ts capture!)
    for (const key of ['1', '5', '2', 'Backspace', '9', '1']) {
      await session.ctl.request('browser_interact', {
        tab_id: pinTabId,
        viewport: 'landscape',
        action: 'key',
        key,
        simulate_human: true,
      });
      await sleep(45);
    }

    // Both landscape AND portrait must unlock onto /pos/cart with 0 input events on #pin-sr-input
    // and only 1 deduplicated POST /auth/pin-identify hitting the backend!
    const unlockedState = await pollUntil('both viewports unlocked onto /pos/cart', 6_000, async () => {
      const lRaw = await session.ctl.evalJs(
        `JSON.stringify({ path: location.pathname, title: document.getElementById('screen-title')?.textContent, jwt: window.__employeeJwt, inputEvs: window.__inputEventsOnPin })`,
        'landscape',
        pinTabId,
      );
      const pRaw = await session.ctl.evalJs(
        `JSON.stringify({ path: location.pathname, title: document.getElementById('screen-title')?.textContent, jwt: window.__employeeJwt, inputEvs: window.__inputEventsOnPin })`,
        'portrait',
        pinTabId,
      );
      const l = JSON.parse(lRaw.value) as {
        path: string;
        title: string;
        jwt: string | null;
        inputEvs: number;
      };
      const p = JSON.parse(pRaw.value) as {
        path: string;
        title: string;
        jwt: string | null;
        inputEvs: number;
      };
      if (
        l.path === '/pos/cart' &&
        p.path === '/pos/cart' &&
        l.title === 'POS Cart Unlocked' &&
        p.title === 'POS Cart Unlocked'
      ) {
        return { l, p };
      }
      return null;
    });

    assert.equal(unlockedState.l.jwt, 'jwt-emp-1591');
    assert.equal(unlockedState.p.jwt, 'jwt-emp-1591');
    assert.equal(unlockedState.l.inputEvs, 0);
    assert.equal(unlockedState.p.inputEvs, 0);
    assert.equal(
      pinIdentifyPosts,
      1,
      `expected POST /auth/pin-identify to be deduplicated to 1 upstream call, got ${pinIdentifyPosts}`,
    );

    // Verify normal editable <input id="normal-note"> typing does NOT duplicate characters!
    await session.ctl.request('browser_interact', {
      tab_id: pinTabId,
      viewport: 'landscape',
      action: 'click',
      selector: '#normal-note',
      simulate_human: true,
    });
    await sleep(80);
    await session.ctl.evalJs(
      `(() => { const i = document.getElementById('normal-note'); i.focus(); return true; })()`,
      'landscape',
      pinTabId,
    );
    await session.ctl.request('browser_interact', {
      tab_id: pinTabId,
      viewport: 'landscape',
      action: 'type',
      selector: '#normal-note',
      text: 'sin sal',
      simulate_human: true,
    });

    const syncedNote = await pollUntil('normal input mirrored without duplication', 4_000, async () => {
      const lVal = (
        await session.ctl.evalJs(`document.getElementById('normal-note').value`, 'landscape', pinTabId)
      ).value;
      const pVal = (
        await session.ctl.evalJs(`document.getElementById('normal-note').value`, 'portrait', pinTabId)
      ).value;
      return lVal === 'sin sal' && pVal === 'sin sal' ? pVal : null;
    });
    assert.equal(syncedNote, 'sin sal');

    // Now test Post-Miss Route Reconciliation (`miss_reconcile` for "Ahora no"):
    // Force portrait into a diverged stale `/login` state (simulating an earlier unmirrored state)
    // while `sessionStorage['ez-stock:employee-jwt']` is already present in the shared tab.
    await session.ctl.evalJs(
      `(() => { window.__employeeJwt = null; history.replaceState(null, '', '/login'); render(); return location.pathname; })()`,
      'portrait',
      pinTabId,
    );
    const pBeforeMiss = (await session.ctl.evalJs(`location.pathname`, 'portrait', pinTabId)).value;
    assert.equal(pBeforeMiss, '/login');

    // Human clicks "Ahora no" (#btn-ahora-no) on landscape (/pos/cart).
    // Portrait has no #btn-ahora-no -> emits click:target-not-found ("Ahora no") ->
    // TabManager.onMirrorMiss sees portrait (/login) !== landscape (/pos/cart) ->
    // triggers `miss_reconcile` -> portrait reloads /pos/cart, hydrates sessionStorage JWT, and unlocks!
    await session.ctl.request('browser_interact', {
      tab_id: pinTabId,
      viewport: 'landscape',
      action: 'click',
      selector: '#btn-ahora-no',
      simulate_human: true,
    });

    const reconciled = await pollUntil('miss_reconcile converges portrait onto /pos/cart', 6_000, async () => {
      const pRaw = await session.ctl.evalJs(
        `JSON.stringify({ path: location.pathname, title: document.getElementById('screen-title')?.textContent, jwt: window.__employeeJwt })`,
        'portrait',
        pinTabId,
      );
      const p = JSON.parse(pRaw.value) as { path: string; title: string; jwt: string | null };
      return p.path === '/pos/cart' && p.title === 'POS Cart Unlocked' && p.jwt === 'jwt-emp-1591'
        ? p
        : null;
    });
    assert.equal(reconciled.path, '/pos/cart');

    const navEvents = await session.ctl.events({ tabId: pinTabId, domain: 'navigation', limit: 50 });
    assert.ok(
      navEvents.events.some((e) => e.kind === 'miss_reconcile'),
      'expected navigation:miss_reconcile event in TabEventBus',
    );

    // Also verify Layer 1 (`spa_auth_reconcile`): if sessionStorage is written + pushState fires on
    // landscape while portrait's in-memory __employeeJwt is still null (so spa_sync gets bounced
    // back to /login by portrait's route guard), spa_auth_reconcile automatically reloads portrait!
    const openedAuthBounce = await session.ctl.open(`${baseUrl}/login`, {
      mode: 'dual',
      session: 'shared',
    });
    const bounceTabId = openedAuthBounce.activeTabId!;
    await session.ctl.waitForTabReady(bounceTabId, { expectedUrlIncludes: '/login' });
    await session.ctl.evalJs(`sessionStorage.clear(); window.__employeeJwt = null;`, 'landscape', bounceTabId);
    await session.ctl.evalJs(`window.__employeeJwt = null;`, 'portrait', bounceTabId);

    // Simulate single-pane auth unlock directly in landscape JS (without mirrored keys)
    await session.ctl.evalJs(
      `(() => {
        sessionStorage.setItem('ez-stock:employee-jwt', 'jwt-bounce-777');
        window.__employeeJwt = 'jwt-bounce-777';
        history.pushState(null, '', '/pos/cart');
        render();
        return location.pathname;
      })()`,
      'landscape',
      bounceTabId,
    );

    const bounceConverged = await pollUntil(
      'spa_auth_reconcile converges portrait after auth-guard bounce',
      6_000,
      async () => {
        const pRaw = await session.ctl.evalJs(
          `JSON.stringify({ path: location.pathname, jwt: window.__employeeJwt, title: document.getElementById('screen-title')?.textContent })`,
          'portrait',
          bounceTabId,
        );
        const p = JSON.parse(pRaw.value) as { path: string; jwt: string | null; title: string };
        return p.path === '/pos/cart' && p.jwt === 'jwt-bounce-777' && p.title === 'POS Cart Unlocked'
          ? p
          : null;
      },
    );
    assert.equal(bounceConverged.jwt, 'jwt-bounce-777');
    const bounceNavEvents = await session.ctl.events({
      tabId: bounceTabId,
      domain: 'navigation',
      limit: 50,
    });
    assert.ok(
      bounceNavEvents.events.some((e) => e.kind === 'spa_auth_reconcile'),
      'expected navigation:spa_auth_reconcile event in TabEventBus',
    );

    // =========================================================================
    // PART 2: Slow-Device Emulation (`SLOW_DEVICE_EMULATION_REQUEST.md` Acceptance)
    // =========================================================================
    const openedBench = await session.ctl.open(`${baseUrl}/bench`, {
      mode: 'dual',
      session: 'shared',
    });
    const benchTabId = openedBench.activeTabId!;
    await session.ctl.waitForTabReady(benchTabId, { expectedUrlIncludes: '/bench' });

    // Record host baseline values with profile: "none"
    const hostInfoRaw = await session.ctl.evalJs(
      `JSON.stringify({
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory ?? null,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio
      })`,
      'portrait',
      benchTabId,
    );
    const hostInfo = JSON.parse(hostInfoRaw.value) as {
      ua: string;
      cores: number;
      mem: number | null;
      width: number;
      height: number;
      dpr: number;
    };
    assert.ok(!hostInfo.ua.includes('Android 7.1'), 'host UA should not contain Android 7.1 initially');

    // Measure unthrottled fetch latency
    const unthrottledFetchRaw = await session.ctl.evalJs(
      `window.measureFetchLatency()`,
      'portrait',
      benchTabId,
    );
    const unthrottledFetch = JSON.parse(unthrottledFetchRaw.value) as { elapsedMs: number };

    // Calibrate fixed work batch count (~45ms unthrottled) and measure unthrottled baseline (best of 2)
    const probeRaw = await session.ctl.evalJs(`window.runFixedCpuBench(200)`, 'portrait', benchTabId);
    const probeMs = Math.max(0.5, (JSON.parse(probeRaw.value) as { elapsedMs: number }).elapsedMs);
    const fixedBatches = Math.min(25_000, Math.max(200, Math.round((45 / probeMs) * 200)));

    const noneRun1 = JSON.parse(
      (await session.ctl.evalJs(`window.runFixedCpuBench(${fixedBatches})`, 'portrait', benchTabId))
        .value,
    ) as { elapsedMs: number };
    const noneRun2 = JSON.parse(
      (await session.ctl.evalJs(`window.runFixedCpuBench(${fixedBatches})`, 'portrait', benchTabId))
        .value,
    ) as { elapsedMs: number };
    const baselineCpuMs = Math.min(noneRun1.elapsedMs, noneRun2.elapsedMs);

    // Apply `sunmi-v2-pro` profile via `browser_emulate`
    const emuApplied = await session.ctl.emulate<{
      ok: boolean;
      emulation: {
        active: boolean;
        profile: string;
        portrait: { cpuRate: number; deviceMemory: number; hardwareConcurrency: number; presetId: string };
      };
    }>({
      tab: benchTabId,
      profile: 'sunmi-v2-pro',
      save_data: true,
      reduced_motion: true,
    });
    assert.equal(emuApplied.ok, true);
    assert.equal(emuApplied.emulation.active, true);
    assert.equal(emuApplied.emulation.profile, 'sunmi-v2-pro');
    assert.equal(emuApplied.emulation.portrait.cpuRate, 6);

    // Verify identity hints + geometry immediately on live page
    const sunmiInfoRaw = await session.ctl.evalJs(
      `JSON.stringify({
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        saveData: navigator.connection ? navigator.connection.saveData : null,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio
      })`,
      'portrait',
      benchTabId,
    );
    const sunmiInfo = JSON.parse(sunmiInfoRaw.value) as {
      ua: string;
      cores: number;
      mem: number;
      reducedMotion: boolean;
      saveData: boolean | null;
      width: number;
      height: number;
      dpr: number;
    };
    assert.equal(sunmiInfo.mem, 2, 'navigator.deviceMemory must equal 2');
    assert.equal(sunmiInfo.cores, 4, 'navigator.hardwareConcurrency must equal 4');
    assert.ok(
      sunmiInfo.ua.includes('Android 7.1'),
      `expected UA to contain Android 7.1, got ${sunmiInfo.ua}`,
    );
    assert.equal(sunmiInfo.reducedMotion, true);
    assert.equal(sunmiInfo.width, 360);
    assert.equal(sunmiInfo.height, 720);
    assert.equal(sunmiInfo.dpr, 2);

    // Verify CPU benchmark with `sunmi-v2-pro` (6x) is >= 4x slower than `none`!
    const throttledCpu = JSON.parse(
      (await session.ctl.evalJs(`window.runFixedCpuBench(${fixedBatches})`, 'portrait', benchTabId))
        .value,
    ) as { elapsedMs: number };
    const slowdownRatio = throttledCpu.elapsedMs / Math.max(0.5, baselineCpuMs);
    assert.ok(
      slowdownRatio >= 4.0,
      `expected sunmi-v2-pro CPU bench >= 4x slower than none, got ${slowdownRatio.toFixed(2)}x (${throttledCpu.elapsedMs.toFixed(1)}ms vs ${baselineCpuMs.toFixed(1)}ms)`,
    );

    // Verify slow-4g network preset measurably delays fetch (~150ms RTT) & sends Android UA + Save-Data header
    pingHeaders.length = 0;
    const throttledFetchRaw = await session.ctl.evalJs(
      `window.measureFetchLatency()`,
      'portrait',
      benchTabId,
    );
    const throttledFetch = JSON.parse(throttledFetchRaw.value) as {
      elapsedMs: number;
      body: { ua: string; saveData: string | null };
    };
    assert.ok(
      throttledFetch.elapsedMs >= 120 &&
        throttledFetch.elapsedMs > unthrottledFetch.elapsedMs + 80,
      `expected slow-4g fetch latency >= 120ms and +80ms above unthrottled (${unthrottledFetch.elapsedMs.toFixed(1)}ms), got ${throttledFetch.elapsedMs.toFixed(1)}ms`,
    );
    assert.ok(throttledFetch.body.ua.includes('Android 7.1'));
    assert.equal(throttledFetch.body.saveData, 'on');

    // Verify browser_metrics and browser_trace_start / browser_trace_stop include active emulation state
    const metricsSnap = await session.ctl.metrics();
    assert.equal((metricsSnap.emulation as { active?: boolean } | null)?.active, true);
    assert.equal((metricsSnap.emulation as { profile?: string } | null)?.profile, 'sunmi-v2-pro');

    const traceStarted = await session.ctl.request<{
      ok: boolean;
      emulation?: { active: boolean; profile: string };
    }>('browser_trace_start', { tab_id: benchTabId, max_duration_ms: 2000 });
    assert.equal(traceStarted.emulation?.active, true);
    assert.equal(traceStarted.emulation?.profile, 'sunmi-v2-pro');

    const traceStopped = await session.ctl.request<{
      ok: boolean;
      emulation?: { active: boolean; profile: string };
    }>('browser_trace_stop', { tab_id: benchTabId });
    assert.equal(traceStopped.emulation?.active, true);
    assert.equal(traceStopped.emulation?.profile, 'sunmi-v2-pro');

    // Verify profile survives reload (`location.reload()` and navigation)!
    await session.ctl.evalJs(`location.reload()`, 'portrait', benchTabId);
    await session.ctl.waitForTabReady(benchTabId, { expectedUrlIncludes: '/bench' });

    const afterReloadInfo = JSON.parse(
      (
        await session.ctl.evalJs(
          `JSON.stringify({
            ua: navigator.userAgent,
            cores: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory
          })`,
          'portrait',
          benchTabId,
        )
      ).value,
    ) as { ua: string; cores: number; mem: number };
    assert.equal(afterReloadInfo.mem, 2, 'deviceMemory === 2 must survive reload');
    assert.equal(afterReloadInfo.cores, 4, 'hardwareConcurrency === 4 must survive reload');
    assert.ok(afterReloadInfo.ua.includes('Android 7.1'), 'UA override must survive reload');

    // Verify `calibrate: true` measures hostScore, picks chosenRate, and returns resultingScore
    const calibrated = await session.ctl.emulate<{
      ok: boolean;
      calibration: {
        hostScore: number;
        targetScore: number;
        chosenRate: number;
        resultingScore: number;
      };
    }>({
      tab: benchTabId,
      profile: 'sunmi-v2-pro',
      calibrate: true,
    });
    assert.equal(calibrated.ok, true);
    assert.ok(calibrated.calibration.hostScore > 0);
    assert.ok(calibrated.calibration.chosenRate >= 1 && calibrated.calibration.chosenRate <= 20);
    assert.ok(calibrated.calibration.resultingScore > 0);

    // =========================================================================
    // PART 3: `browser_profile` CDP CPU Profiler working WITH active CPU throttle
    // =========================================================================
    const profStart = await session.ctl.profile<{
      ok: boolean;
      action: string;
      emulation?: { active: boolean; profile: string };
    }>({
      tab: benchTabId,
      viewport: 'portrait',
      action: 'start',
    });
    assert.equal(profStart.ok, true);
    assert.equal(profStart.action, 'start');
    assert.equal(profStart.emulation?.active, true);
    assert.equal(profStart.emulation?.profile, 'sunmi-v2-pro');

    await session.ctl.evalJs(`window.sunmiHotspotProfileWork()`, 'portrait', benchTabId);

    const profStop = await session.ctl.profile<{
      ok: boolean;
      action: string;
      profilePath: string;
      profileBytes: number;
      emulation?: { active: boolean; profile: string };
      summary: {
        activeMs: number;
        sampleCount: number;
        functions: Array<{
          functionName: string;
          url: string;
          line: number;
          location: string;
          selfMs: number;
          totalMs: number;
        }>;
        scripts: Array<{ url: string; selfMs: number }>;
      };
    }>({
      tab: benchTabId,
      viewport: 'portrait',
      action: 'stop',
      top: 15,
    });
    assert.equal(profStop.ok, true);
    assert.equal(profStop.action, 'stop');
    assert.equal(profStop.emulation?.active, true);
    assert.ok(profStop.profilePath.endsWith('.cpuprofile'));
    assert.equal(fs.existsSync(profStop.profilePath), true, 'expected raw .cpuprofile file on disk');
    const parsedCpuProfile = JSON.parse(fs.readFileSync(profStop.profilePath, 'utf8')) as {
      nodes?: unknown[];
      samples?: unknown[];
    };
    assert.ok(Array.isArray(parsedCpuProfile.nodes) && parsedCpuProfile.nodes.length > 0);
    assert.ok(Array.isArray(parsedCpuProfile.samples) && parsedCpuProfile.samples.length > 0);

    const hotspotFn = profStop.summary.functions.find((f) =>
      f.functionName.includes('sunmiHotspotProfileWork'),
    );
    assert.ok(
      hotspotFn && hotspotFn.selfMs > 0 && hotspotFn.totalMs >= hotspotFn.selfMs,
      `expected sunmiHotspotProfileWork in bottom-up functions summary, got ${JSON.stringify(profStop.summary.functions.slice(0, 5))}`,
    );
    assert.ok(hotspotFn.location.includes('/bench:'));
    const benchScriptEntry = profStop.summary.scripts.find((s) => s.url.includes('/bench'));
    assert.ok(
      benchScriptEntry && benchScriptEntry.selfMs > 0,
      `expected /bench in per-script selfMs summary, got ${JSON.stringify(profStop.summary.scripts)}`,
    );

    // Verify `reset: true` restores ALL values back to host values!
    const resetRes = await session.ctl.emulate<{
      ok: boolean;
      emulation: { active: boolean; profile: string };
    }>({
      tab: benchTabId,
      reset: true,
    });
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.emulation.active, false);
    assert.equal(resetRes.emulation.profile, 'none');

    const afterResetInfo = JSON.parse(
      (
        await session.ctl.evalJs(
          `JSON.stringify({
            ua: navigator.userAgent,
            cores: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory ?? null,
            reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            width: window.innerWidth,
            height: window.innerHeight
          })`,
          'portrait',
          benchTabId,
        )
      ).value,
    ) as {
      ua: string;
      cores: number;
      mem: number | null;
      reducedMotion: boolean;
      width: number;
      height: number;
    };
    assert.equal(afterResetInfo.ua, hostInfo.ua, 'UA must reset to exact host UA');
    assert.equal(afterResetInfo.cores, hostInfo.cores, 'hardwareConcurrency must reset to host cores');
    assert.equal(afterResetInfo.mem, hostInfo.mem, 'deviceMemory must reset to host value');
    assert.equal(afterResetInfo.reducedMotion, false);
    assert.equal(afterResetInfo.width, hostInfo.width, 'portrait width must reset to saved preset');
    assert.equal(afterResetInfo.height, hostInfo.height, 'portrait height must reset to saved preset');

    const afterResetFetch = JSON.parse(
      (await session.ctl.evalJs(`window.measureFetchLatency()`, 'portrait', benchTabId)).value,
    ) as { elapsedMs: number; body: { ua: string; saveData: string | null } };
    assert.ok(
      afterResetFetch.elapsedMs < 80,
      `expected reset fetch latency < 80ms, got ${afterResetFetch.elapsedMs.toFixed(1)}ms`,
    );
    assert.ok(!afterResetFetch.body.ua.includes('Android 7.1'));
    assert.equal(afterResetFetch.body.saveData, null);

    // =========================================================================
    // PART 4: Cross-Origin EventSource + CORS (Bug Report #3 Regression)
    // =========================================================================
    const crossSseTarget = `${crossOriginBaseUrl}/api/v1/events?token=secret123&sell_point_id=sp-7`;
    const openedSse = await session.ctl.open(
      `${baseUrl}/pos-sse#${crossSseTarget}`,
      { mode: 'dual', session: 'shared' },
    );
    const sseTabId = openedSse.activeTabId!;
    await session.ctl.waitForTabReady(sseTabId, { expectedUrlIncludes: '/pos-sse' });

    const sseBothReceived = await pollUntil(
      'both viewports receive cross-origin event: carts_snapshot',
      6_000,
      async () => {
        const p = JSON.parse(
          (
            await session.ctl.evalJs(
              `JSON.stringify({ snaps: window.__sseSnapshots, errs: window.__sseErrors })`,
              'portrait',
              sseTabId,
            )
          ).value,
        ) as { snaps: string[]; errs: number };
        const l = JSON.parse(
          (
            await session.ctl.evalJs(
              `JSON.stringify({ snaps: window.__sseSnapshots, errs: window.__sseErrors })`,
              'landscape',
              sseTabId,
            )
          ).value,
        ) as { snaps: string[]; errs: number };
        return p.snaps.length >= 1 && l.snaps.length >= 1 ? { p, l } : null;
      },
    );

    assert.deepEqual(JSON.parse(sseBothReceived.p.snaps[0]!), { sellPoint: 'sp-7', items: 3 });
    assert.deepEqual(JSON.parse(sseBothReceived.l.snaps[0]!), { sellPoint: 'sp-7', items: 3 });
    assert.equal(sseBothReceived.p.errs, 0, 'portrait cross-origin EventSource must have 0 errors');
    assert.equal(sseBothReceived.l.errs, 0, 'landscape cross-origin EventSource must have 0 errors');
    assert.equal(
      crossOriginSseOptionsCount,
      0,
      `cross-origin EventSource must NOT trigger OPTIONS CORS preflight, got ${crossOriginSseOptionsCount}`,
    );
    assert.equal(
      crossOriginHadCacheControlHeader,
      false,
      'cross-origin EventSource fetch must not send non-CORS-safelisted Cache-Control header',
    );
    assert.equal(
      crossOriginSseGetCount,
      1,
      `expected cross-origin EventSource to multiplex onto 1 upstream stream, got ${crossOriginSseGetCount}`,
    );

    const sseFailedNet = await session.ctl.network({ tabId: sseTabId, filter: 'failed' });
    assert.equal(
      sseFailedNet.count,
      0,
      `expected 0 failed network entries on cross-origin SSE tab, got ${JSON.stringify(sseFailedNet.entries)}`,
    );

    console.log(
      `PASS pin-and-emulation.e2e.ts (CPU slowdown=${slowdownRatio.toFixed(2)}x [${baselineCpuMs.toFixed(1)}ms -> ${throttledCpu.elapsedMs.toFixed(1)}ms], slow-4g fetch=${throttledFetch.elapsedMs.toFixed(1)}ms, calibration=${calibrated.calibration.hostScore}->rate ${calibrated.calibration.chosenRate}x->${calibrated.calibration.resultingScore}, hotspot=${hotspotFn?.functionName}:${hotspotFn?.selfMs}ms, crossOriginSse=1 stream / 0 preflight)`,
    );
  } finally {
    await session.close();
    for (const sock of openSockets) {
      sock.destroy();
    }
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await runPinAndEmulationE2E();
