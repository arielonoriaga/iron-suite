import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

async function runTabEventBusE2E(): Promise<void> {
  let downloadHitCount = 0;
  const csvBody = 'round,multiplier,payout\n101,4.06,40.60\n';
  const openSockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/report.csv') {
      downloadHitCount += 1;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="report.csv"',
        'Cache-Control': 'no-store',
      });
      res.end(csvBody);
      return;
    }
    if (reqUrl.pathname === '/subframe') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html><body>subframe</body></html>');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bus E2E Fixture</title></head>
<body>
  <a id="dl-report" href="/report.csv" download="report.csv" style="display:inline-block;padding:18px 28px;background:#10b981;color:#fff;">Download CSV</a>
  <iframe id="sub-frame" src="/subframe" style="width:40px;height:20px;border:0;"></iframe>
  <script>
    window.__bootId = Math.random().toString(36).slice(2);
    window.__ssEvents = [];
    window.addEventListener('storage', (ev) => {
      if (ev.storageArea === window.sessionStorage) {
        window.__ssEvents.push({ key: ev.key, newValue: ev.newValue });
      }
    });
    // Delegated SPA anchor router (like SvelteKit / Next.js async client navigation)
    document.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a || a.hasAttribute('download')) return;
      const u = new URL(a.href, location.href);
      if (u.origin === location.origin && u.pathname === '/spa-async') {
        ev.preventDefault();
        setTimeout(() => {
          history.pushState({ spa: true }, '', '/spa-async-done');
        }, 240);
        return;
      }
      if (u.origin === location.origin && u.pathname.startsWith('/spa-')) {
        ev.preventDefault();
        history.pushState({ spa: true }, '', u.pathname + u.search + u.hash);
      }
    });
    // Responsive canonicalizing popstate router (adversarial ping-pong fixture for F-21)
    window.addEventListener('popstate', () => {
      if (window.innerWidth < 600 && location.pathname === '/responsive-lobby') {
        history.replaceState({}, '', '/mobile-lobby');
      } else if (window.innerWidth >= 600 && location.pathname === '/mobile-lobby') {
        history.replaceState({}, '', '/responsive-lobby');
      } else if (window.innerWidth < 600 && location.pathname === '/delayed-desktop') {
        setTimeout(() => history.replaceState({}, '', '/delayed-mobile'), 50);
      } else if (window.innerWidth >= 600 && location.pathname === '/delayed-mobile') {
        setTimeout(() => history.replaceState({}, '', '/delayed-desktop'), 50);
      }
    });
  </script>
</body>
</html>`);
  });

  server.on('connection', (sock: Socket) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind E2E HTTP fixture server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dl-e2e-'));

  const session = await launchElectronSession({
    smoke: true,
    env: {
      IRON_BROWSER_DOWNLOAD_DIR: downloadDir,
    },
  });

  try {
    const opened = await session.ctl.open(`${baseUrl}/app?token=TOP_SECRET_TOK&lang=EN`, {
      mode: 'dual',
      session: 'shared',
    });
    const sharedTabId = opened.activeTabId!;
    assert.ok(sharedTabId, 'expected active shared tab id');
    await session.ctl.waitForTabReady(sharedTabId);

    // 1. Verify native rust-napi backend + URL token redaction on bus events (including F-17 whitespace tab_id fallback)
    const initialEvents = await session.ctl.events({ tabId: '   ' });
    assert.equal(initialEvents.backend, 'rust-napi');
    assert.equal(initialEvents.tabId, sharedTabId);
    assert.ok(initialEvents.events.length >= 1, 'expected lifecycle/navigation events');
    for (const ev of initialEvents.events) {
      assert.ok(
        !ev.summary.includes('TOP_SECRET_TOK'),
        `bus event leaked secret token: ${ev.summary}`,
      );
    }

    // 2. Live cross-viewport sessionStorage replication (Portrait -> Landscape) + reload hydration
    await session.ctl.evalJs(
      `sessionStorage.setItem('__sp_stk', 'aviator-live-777'); 'ok'`,
      'portrait',
      sharedTabId,
    );

    const replicatedVal = await pollUntil(
      'landscape sessionStorage live sync',
      4_000,
      async () => {
        const r = await session.ctl.evalJs(
          `JSON.stringify({ val: sessionStorage.getItem('__sp_stk'), events: window.__ssEvents.length })`,
          'landscape',
          sharedTabId,
        );
        const parsed = JSON.parse(r.value) as { val: string | null; events: number };
        return parsed.val === 'aviator-live-777' && parsed.events >= 1 ? parsed.val : null;
      },
    );
    assert.equal(replicatedVal, 'aviator-live-777');

    // Navigate shared tab to another path on same origin and verify hydration restores sessionStorage
    await session.ctl.navigate(`${baseUrl}/page2`, sharedTabId);
    await session.ctl.waitForTabReady(sharedTabId, { expectedUrlIncludes: '/page2' });

    const hydratedVal = await pollUntil(
      'post-navigation sessionStorage hydration',
      4_000,
      async () => {
        const p = await session.ctl.evalJs(
          `sessionStorage.getItem('__sp_stk')`,
          'portrait',
          sharedTabId,
        );
        const l = await session.ctl.evalJs(
          `sessionStorage.getItem('__sp_stk')`,
          'landscape',
          sharedTabId,
        );
        return p.value === 'aviator-live-777' && l.value === 'aviator-live-777' ? l.value : null;
      },
    );
    assert.equal(hydratedVal, 'aviator-live-777');

    // 3. Mirrored download deduplication: clicking #dl-report across Portrait + Landscape saves 1 file & cancels duplicate
    await session.ctl.interact({
      tabId: sharedTabId,
      action: 'click',
      selector: '#dl-report',
      mirror: true,
    });

    const dlCheck = await pollUntil('completed single deduplicated download', 6_000, async () => {
      const evs = await session.ctl.events({ tabId: sharedTabId, domain: 'download' });
      const hasClaimed = evs.events.some((e) => e.kind === 'effect_claimed');
      const hasSuppressed = evs.events.some((e) => e.kind === 'dedup_suppressed');
      const hasCompleted = evs.events.some((e) => e.kind === 'completed');
      if (!hasClaimed || !hasSuppressed || !hasCompleted) return null;
      return evs;
    });

    const claimedEv = dlCheck.events.find((e) => e.kind === 'effect_claimed')!;
    const suppressedEv = dlCheck.events.find((e) => e.kind === 'dedup_suppressed')!;
    assert.ok(claimedEv.gestureSeq && claimedEv.gestureSeq > 0, 'expected causal gestureSeq');
    assert.equal(
      suppressedEv.gestureSeq,
      claimedEv.gestureSeq,
      'claimed and suppressed download events must share causal gestureSeq',
    );

    // Give 150ms settle window to prove no second file ever materializes
    await sleep(150);
    const savedFiles = fs.readdirSync(downloadDir).sort();
    assert.deepEqual(
      savedFiles,
      ['report.csv'],
      `expected exactly 1 downloaded file, got: ${JSON.stringify(savedFiles)}`,
    );
    assert.equal(fs.readFileSync(path.join(downloadDir, 'report.csv'), 'utf8'), csvBody);

    const tabsAfterDl = await session.ctl.tabs();
    const sharedSnap = tabsAfterDl.tabs.find((t) => t.id === sharedTabId)!;
    assert.ok(
      (sharedSnap.dedupCount ?? 0) >= 1,
      `expected dedupCount >= 1 after suppressed duplicate download, got ${sharedSnap.dedupCount}`,
    );

    // 4. SPA in-page pushState syncs paired viewport WITHOUT hard reload, and ignores subframe pushState
    const bootBeforeL = (
      await session.ctl.evalJs(`window.__bootId`, 'landscape', sharedTabId)
    ).value;
    const bootBeforeP = (
      await session.ctl.evalJs(`window.__bootId`, 'portrait', sharedTabId)
    ).value;

    // Subframe pushState must NOT alter tab URL or trigger spa_sync
    await session.ctl.evalJs(
      `document.getElementById('sub-frame').contentWindow.history.pushState({}, '', '/subframe-pushed'); 'ok'`,
      'landscape',
      sharedTabId,
    );
    await sleep(350);
    const pUrlAfterSubframe = (
      await session.ctl.evalJs(`location.pathname`, 'portrait', sharedTabId)
    ).value;
    assert.equal(pUrlAfterSubframe, '/page2', 'subframe pushState must never sync main-frame URL');

    // Chained main-frame SPA pushState + replaceState on landscape converges portrait in-page with ZERO reload
    await session.ctl.evalJs(
      `history.pushState({}, '', '/spa-casino'); setTimeout(() => history.replaceState({}, '', '/spa-modal?modal=restricted'), 60); 'ok'`,
      'landscape',
      sharedTabId,
    );
    const spaConverged = await pollUntil('in-page SPA sync without reload', 4_000, async () => {
      const p = await session.ctl.evalJs(
        `JSON.stringify({ href: location.pathname + location.search, boot: window.__bootId })`,
        'portrait',
        sharedTabId,
      );
      const parsed = JSON.parse(p.value) as { href: string; boot: string };
      return parsed.href === '/spa-modal?modal=restricted' ? parsed : null;
    });
    assert.equal(
      spaConverged.boot,
      bootBeforeP,
      'Portrait SPA sync must transition in-page without reloading document',
    );
    const bootAfterL = (
      await session.ctl.evalJs(`window.__bootId`, 'landscape', sharedTabId)
    ).value;
    assert.equal(bootAfterL, bootBeforeL);

    // F-18 regression: popstate-only SPA route (not matching /spa-* delegated click handler) ALSO syncs in-page with ZERO reload!
    await session.ctl.evalJs(
      `history.pushState({}, '', '/react-router-view?tab=bets'); 'ok'`,
      'portrait',
      sharedTabId,
    );
    const popstateConverged = await pollUntil(
      'popstate-only SPA sync without reload',
      4_000,
      async () => {
        const l = await session.ctl.evalJs(
          `JSON.stringify({ href: location.pathname + location.search, boot: window.__bootId })`,
          'landscape',
          sharedTabId,
        );
        const parsed = JSON.parse(l.value) as { href: string; boot: string };
        return parsed.href === '/react-router-view?tab=bets' ? parsed : null;
      },
    );
    assert.equal(
      popstateConverged.boot,
      bootBeforeL,
      'F-18: popstate-only SPA sync must NOT trigger a cold reload',
    );

    // F-21a regression: async delegated router (>180ms) completes in-page without premature cold reload
    await session.ctl.interact({
      tabId: sharedTabId,
      action: 'hover',
      x: 12,
      y: 12,
      mirror: false,
    });
    await session.ctl.evalJs(
      `history.pushState({}, '', '/spa-async'); 'ok'`,
      'landscape',
      sharedTabId,
    );
    const asyncSpaConverged = await pollUntil(
      'async delegated SPA sync (>180ms) without reload',
      4_000,
      async () => {
        const p = await session.ctl.evalJs(
          `JSON.stringify({ href: location.pathname, boot: window.__bootId })`,
          'portrait',
          sharedTabId,
        );
        const parsed = JSON.parse(p.value) as { href: string; boot: string };
        return parsed.href === '/spa-async-done' ? parsed : null;
      },
    );
    assert.equal(
      asyncSpaConverged.boot,
      bootBeforeP,
      'F-21a: async delegated router must NOT be interrupted by a cold reload',
    );

    // F-21b regression: responsive canonicalizing router (sync + delayed) never ping-pongs or cold-reloads
    await session.ctl.interact({
      tabId: sharedTabId,
      action: 'hover',
      x: 14,
      y: 14,
      mirror: false,
    });
    const spaEventsBeforeSyncCanon = (
      await session.ctl.events({ tabId: sharedTabId, domain: 'navigation' })
    ).events.filter((e) => e.kind === 'spa_sync').length;
    await session.ctl.evalJs(
      `history.pushState({}, '', '/responsive-lobby'); 'ok'`,
      'landscape',
      sharedTabId,
    );
    await pollUntil('sync canonicalizing router settles on /mobile-lobby', 4_000, async () => {
      const p = (await session.ctl.evalJs(`location.pathname`, 'portrait', sharedTabId)).value;
      return p === '/mobile-lobby' ? p : null;
    });
    await sleep(400);
    const spaEventsAfterSyncCanon = (
      await session.ctl.events({ tabId: sharedTabId, domain: 'navigation' })
    ).events.filter((e) => e.kind === 'spa_sync').length;
    assert.equal(
      spaEventsAfterSyncCanon - spaEventsBeforeSyncCanon,
      1,
      'F-21b: sync canonicalizing replaceState during spa_sync must be suppressed as echo (1 hop)',
    );

    await session.ctl.interact({
      tabId: sharedTabId,
      action: 'hover',
      x: 16,
      y: 16,
      mirror: false,
    });
    const spaEventsBeforeDelayedCanon = (
      await session.ctl.events({ tabId: sharedTabId, domain: 'navigation' })
    ).events.filter((e) => e.kind === 'spa_sync').length;
    await session.ctl.evalJs(
      `history.pushState({}, '', '/delayed-desktop'); 'ok'`,
      'landscape',
      sharedTabId,
    );
    await sleep(950);
    const spaEventsAfterDelayedCanon = (
      await session.ctl.events({ tabId: sharedTabId, domain: 'navigation' })
    ).events.filter((e) => e.kind === 'spa_sync').length;
    assert.ok(
      spaEventsAfterDelayedCanon - spaEventsBeforeDelayedCanon <= 2,
      `F-21b: delayed responsive canonicalizer must terminate within <=2 hops, got ${spaEventsAfterDelayedCanon - spaEventsBeforeDelayedCanon}`,
    );
    assert.equal(
      (await session.ctl.evalJs(`window.__bootId`, 'portrait', sharedTabId)).value,
      bootBeforeP,
      'F-21b: responsive canonicalizer must never cold-reload portrait',
    );
    assert.equal(
      (await session.ctl.evalJs(`window.__bootId`, 'landscape', sharedTabId)).value,
      bootBeforeL,
      'F-21b: responsive canonicalizer must never cold-reload landscape',
    );

    // 5. Isolated session tab MUST NOT inherit or replicate sessionStorage across panes
    const isoOpened = await session.ctl.open(`${baseUrl}/isolated`, {
      mode: 'dual',
      session: 'isolated',
    });
    const isoTabId = isoOpened.activeTabId!;
    await session.ctl.waitForTabReady(isoTabId, { expectedUrlIncludes: '/isolated' });

    const isoInitial = await session.ctl.evalJs(
      `String(sessionStorage.getItem('__sp_stk'))`,
      'portrait',
      isoTabId,
    );
    assert.equal(isoInitial.value, 'null');

    await session.ctl.evalJs(
      `sessionStorage.setItem('__iso_only', 'p-secret'); 'ok'`,
      'portrait',
      isoTabId,
    );
    await sleep(150);
    const isoLandscape = await session.ctl.evalJs(
      `String(sessionStorage.getItem('__iso_only'))`,
      'landscape',
      isoTabId,
    );
    assert.equal(
      isoLandscape.value,
      'null',
      'isolated session mode must never sync sessionStorage across Portrait and Landscape',
    );

    console.log(
      `PASS tab-event-bus.e2e: backend=${dlCheck.backend} gestureSeq=${claimedEv.gestureSeq} savedFiles=${savedFiles.length} downloadHits=${downloadHitCount} dedupCount=${sharedSnap.dedupCount}`,
    );
  } finally {
    await session.close();
    for (const sock of openSockets) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

await runTabEventBusE2E();
