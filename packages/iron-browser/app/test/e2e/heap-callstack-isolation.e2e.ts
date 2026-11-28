import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runHeapCallstackIsolationE2E(): Promise<void> {
  const spaJs = `
    window.__retainedLeakStore = [];
    window.__detachedLeakNodes = [];

    class CartLeakItem {
      constructor(index) {
        this.index = index;
        this.sku = 'SKU-' + index + '-' + 'X'.repeat(240);
        this.matrix = new Float64Array(64);
      }
    }

    function allocateCartLeakBatch(count) {
      for (let i = 0; i < count; i++) {
        window.__retainedLeakStore.push(new CartLeakItem(i));
      }
      for (let d = 0; d < 6; d++) {
        const detachedRoot = document.createElement('div');
        detachedRoot.className = 'detached-pos-row';
        const child = document.createElement('span');
        child.textContent = 'detached-' + d;
        detachedRoot.appendChild(child);
        window.__detachedLeakNodes.push(detachedRoot);
      }
      return window.__retainedLeakStore.length;
    }

    function taxLoopHotspot(iterations) {
      let acc = 0;
      const start = performance.now();
      while (performance.now() - start < iterations) {
        for (let i = 1; i < 4000; i++) {
          acc += Math.imul(i, 31) ^ (acc >>> 3);
        }
      }
      return acc;
    }

    function computeCartTotals(ms) {
      return taxLoopHotspot(ms);
    }

    function posRootEntry(ms) {
      return computeCartTotals(ms);
    }

    async function syncCartBeforePay(cartId) {
      await new Promise((r) => setTimeout(r, 12));
      const resp = await fetch('/api/v1/pos/checkout?cart=' + cartId);
      return await resp.json();
    }

    async function onPosCheckoutClick(cartId) {
      return await syncCartBeforePay(cartId);
    }

    window.allocateCartLeakBatch = allocateCartLeakBatch;
    window.posRootEntry = posRootEntry;
    window.onPosCheckoutClick = onPosCheckoutClick;
  `;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Heavy SPA Perf + Isolation E2E</title></head>
<body>
  <div id="app">POS Perf Ready</div>
  <script src="/pos-app.js"></script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/pos-app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(spaJs);
      return;
    }
    if (u.pathname === '/api/v1/pos/checkout') {
      const payload = JSON.stringify({
        ok: true,
        cart: u.searchParams.get('cart'),
        items: Array.from({ length: 20 }, (_, i) => ({ id: i, price: 1990 })),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const session = await launchElectronSession({ smoke: true });
  try {
    // -----------------------------------------------------------------------
    // 1. Regression for session:"isolated" bug (__iso_probe must NEVER leak to shared tab-1!)
    // -----------------------------------------------------------------------
    const sharedOpen = await session.ctl.open(`${baseUrl}/pos`, {
      mode: 'dual',
      session: 'shared',
    });
    const sharedTabId = sharedOpen.tab!.id;
    await session.ctl.waitForTabReady(sharedTabId, { expectedUrlIncludes: '/pos' });

    const isoOpen = await session.ctl.open(`${baseUrl}/pos`, {
      mode: 'dual',
      session: 'isolated',
    });
    const isoTabId = isoOpen.tab!.id;
    await session.ctl.waitForTabReady(isoTabId, { expectedUrlIncludes: '/pos' });

    await session.ctl.evalJs(
      "localStorage.setItem('__iso_probe', 'isolated-landscape-val')",
      'landscape',
      isoTabId,
    );
    await session.ctl.evalJs(
      "localStorage.setItem('__iso_probe', 'isolated-portrait-val')",
      'portrait',
      isoTabId,
    );

    const sharedLandscapeProbe = await session.ctl.evalJs(
      "String(localStorage.getItem('__iso_probe'))",
      'landscape',
      sharedTabId,
    );
    const sharedPortraitProbe = await session.ctl.evalJs(
      "String(localStorage.getItem('__iso_probe'))",
      'portrait',
      sharedTabId,
    );
    const isoLandscapeProbe = await session.ctl.evalJs(
      "String(localStorage.getItem('__iso_probe'))",
      'landscape',
      isoTabId,
    );
    const isoPortraitProbe = await session.ctl.evalJs(
      "String(localStorage.getItem('__iso_probe'))",
      'portrait',
      isoTabId,
    );

    assert.equal(
      sharedLandscapeProbe.value,
      'null',
      `__iso_probe leaked from isolated tab into shared landscape: ${sharedLandscapeProbe.value}`,
    );
    assert.equal(
      sharedPortraitProbe.value,
      'null',
      `__iso_probe leaked from isolated tab into shared portrait: ${sharedPortraitProbe.value}`,
    );
    assert.equal(isoLandscapeProbe.value, 'isolated-landscape-val');
    assert.equal(isoPortraitProbe.value, 'isolated-portrait-val');

    // -----------------------------------------------------------------------
    // 2. Enable sunmi-v2-pro (6x CPU + slow-4g) on sharedTabId portrait
    // -----------------------------------------------------------------------
    await session.ctl.request('browser_emulate', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      profile: 'sunmi-v2-pro',
    });

    // -----------------------------------------------------------------------
    // 3. Verify browser_network initiator call stacks (sync + async) + timing + url_contains
    // -----------------------------------------------------------------------
    await session.ctl.evalJs('window.onPosCheckoutClick(777)', 'portrait', sharedTabId);
    await sleep(80);

    const netRes = await session.ctl.request<{
      entries: Array<{
        url: string;
        status: number;
        durationMs?: number;
        ttfbMs?: number;
        encodedBytes?: number;
        decodedBytes?: number;
        initiator?: {
          type: string;
          frames: Array<{ functionName: string; location: string; async?: boolean }>;
        };
      }>;
    }>('browser_network', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      url_contains: '/api/v1/pos/checkout',
      limit: 20,
    });

    assert.equal(netRes.entries.length, 1);
    const checkoutReq = netRes.entries[0]!;
    assert.equal(checkoutReq.status, 200);
    assert.ok((checkoutReq.durationMs ?? 0) > 0, 'expected monotonic durationMs > 0');
    assert.ok((checkoutReq.decodedBytes ?? 0) > 20, 'expected decodedBytes > 20');
    assert.equal(checkoutReq.initiator?.type, 'script');
    const frameFns = (checkoutReq.initiator?.frames ?? []).map((f) => f.functionName);
    assert.ok(
      frameFns.includes('syncCartBeforePay'),
      `expected syncCartBeforePay in initiator frames: ${JSON.stringify(checkoutReq.initiator)}`,
    );
    assert.ok(
      frameFns.includes('onPosCheckoutClick'),
      `expected async parent onPosCheckoutClick in initiator frames: ${JSON.stringify(checkoutReq.initiator)}`,
    );

    // -----------------------------------------------------------------------
    // 4. Verify browser_profile inclusive callTree under sunmi-v2-pro
    // -----------------------------------------------------------------------
    await session.ctl.request('browser_profile', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'start',
    });
    await session.ctl.evalJs('window.posRootEntry(65)', 'portrait', sharedTabId);
    const profStop = await session.ctl.request<{
      summary: {
        callTree: Array<{
          functionName: string;
          inclusiveMs: number;
          selfMs: number;
          parentChain: string[];
        }>;
      };
    }>('browser_profile', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'stop',
      top: 30,
    });
    const rootTree = profStop.summary.callTree.find((c) => c.functionName === 'posRootEntry');
    const leafTree = profStop.summary.callTree.find((c) => c.functionName === 'taxLoopHotspot');
    assert.ok(rootTree && rootTree.inclusiveMs > 15, `missing posRootEntry in callTree`);
    assert.ok(leafTree && leafTree.parentChain.some((p) => p.startsWith('computeCartTotals@')));

    // -----------------------------------------------------------------------
    // 5. Verify browser_heap (snapshot #1 -> sampling -> snapshot #2 -> diff) under sunmi-v2-pro
    //    while verifying main-thread responsiveness!
    // -----------------------------------------------------------------------
    const snapBefore = await session.ctl.request<{
      ok: boolean;
      snapshotPath: string;
      summary: {
        totalHeapBytes: number;
        detachedDomNodeCount: number;
        constructors: Array<{ name: string; count: number; retainedBytes: number }>;
        largestObjects: Array<{ name: string; topRetainers: unknown[]; dominatorChain: unknown[] }>;
      };
    }>('browser_heap', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'snapshot',
      top: 30,
    });
    assert.equal(snapBefore.ok, true);
    assert.ok(fs.existsSync(snapBefore.snapshotPath));
    assert.equal(snapBefore.summary.largestObjects.length, 5);

    await session.ctl.request('browser_heap', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'sampling_start',
      sampling_interval_bytes: 4096,
    });
    await session.ctl.evalJs('window.allocateCartLeakBatch(350)', 'portrait', sharedTabId);
    const sampStop = await session.ctl.request<{
      ok: boolean;
      profilePath: string;
      summary: {
        totalAllocatedBytes: number;
        topAllocatingStacks: Array<{ functionName: string; location: string; selfBytes: number }>;
        topInclusiveStacks: Array<{ functionName: string; totalBytes: number }>;
      };
    }>('browser_heap', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'sampling_stop',
      top: 30,
    });
    assert.equal(sampStop.ok, true);
    assert.ok(fs.existsSync(sampStop.profilePath));
    assert.ok(sampStop.summary.totalAllocatedBytes > 0, 'expected sampled allocations > 0');
    assert.ok(
      sampStop.summary.topInclusiveStacks.some(
        (s) => s.functionName === 'allocateCartLeakBatch' || s.functionName === 'CartLeakItem',
      ),
      `expected allocateCartLeakBatch/CartLeakItem in sampling stacks: ${JSON.stringify(sampStop.summary.topInclusiveStacks.slice(0, 5))}`,
    );

    // Concurrent ping while snapshot #2 runs under 6x CPU throttling proves main thread stays responsive!
    const [snapAfter, pingDuringSnap] = await Promise.all([
      session.ctl.request<{
        ok: boolean;
        snapshotPath: string;
        summary: { detachedDomNodeCount: number };
      }>('browser_heap', {
        tab_id: sharedTabId,
        viewport: 'portrait',
        action: 'snapshot',
        top: 30,
      }),
      sleep(25).then(() => session.ctl.request<{ pong: boolean }>('ping', {})),
    ]);
    assert.equal(pingDuringSnap.pong, true);
    assert.equal(snapAfter.ok, true);
    assert.ok(
      snapAfter.summary.detachedDomNodeCount > snapBefore.summary.detachedDomNodeCount,
      `expected detached DOM count to grow (${snapBefore.summary.detachedDomNodeCount} -> ${snapAfter.summary.detachedDomNodeCount})`,
    );

    const diffRes = await session.ctl.request<{
      ok: boolean;
      diff: {
        detachedDomCountDelta: number;
        grownConstructors: Array<{ name: string; countDelta: number; retainedBytesDelta: number }>;
      };
    }>('browser_heap', {
      tab_id: sharedTabId,
      viewport: 'portrait',
      action: 'diff',
      before_path: snapBefore.snapshotPath,
      after_path: snapAfter.snapshotPath,
      top: 30,
    });
    assert.equal(diffRes.ok, true);
    const leakedCtor = diffRes.diff.grownConstructors.find((c) => c.name === 'CartLeakItem');
    assert.ok(
      leakedCtor && leakedCtor.countDelta >= 300 && leakedCtor.retainedBytesDelta > 0,
      `expected CartLeakItem in grownConstructors: ${JSON.stringify(diffRes.diff.grownConstructors.slice(0, 8))}`,
    );

    const health = await session.ctl.request<{
      logPath: string;
      watchdog: { stallCount: number };
    }>('browser_health', { lines: 10 });
    assert.equal(health.watchdog.stallCount, 0, 'main thread must report 0 watchdog stalls');
    const expectedLogPath = path.join(session.sessionDir, 'ud', 'logs', 'main.log');
    assert.equal(
      health.logPath,
      expectedLogPath,
      `expected custom userDataDir instance to isolate main.log at ${expectedLogPath}, got ${health.logPath}`,
    );
    assert.ok(fs.existsSync(expectedLogPath), 'expected isolated main.log to exist on disk');

    // -----------------------------------------------------------------------
    // 6. Regression for bee4c1a5 SIGSEGV: rebuilding iron_browser_bus.node while
    //    Electron is live and publishing TabEventBus events must NEVER crash!
    // -----------------------------------------------------------------------
    const appRoot = path.resolve(import.meta.dir, '../..');
    execFileSync('bash', ['scripts/build-native.sh'], { cwd: appRoot, stdio: 'pipe' });
    await session.ctl.evalJs("console.warn('post-rebuild-bus-probe-ok')", 'portrait', sharedTabId);
    const eventsAfterRebuild = await session.ctl.request<{
      events: Array<{ kind: string }>;
    }>('browser_events', { tab_id: sharedTabId, limit: 20 });
    assert.ok(eventsAfterRebuild.events.length > 0, 'expected TabEventBus events after live native rebuild');
    const pingAfterRebuild = await session.ctl.request<{ pong: boolean }>('ping', {});
    assert.equal(pingAfterRebuild.pong, true);
    assert.equal(session.process.exitCode, null, 'Electron process must remain alive across native .node rebuild');
    assert.equal(session.process.signalCode, null, 'Electron process must have no crash signal across native .node rebuild');

    console.log(
      `PASS heap-callstack-isolation.e2e.ts (iso=isolated, logIsolated=true, liveRebuildSafe=true, initiatorFrames=${frameFns.join('<-')}, callTreeRoot=${rootTree.inclusiveMs}ms, leakedCartItem=+${leakedCtor.countDelta}, detachedDomDelta=+${diffRes.diff.detachedDomCountDelta}, stalls=${health.watchdog.stallCount})`,
    );
  } finally {
    await session.close();
    server.close();
  }
}

runHeapCallstackIsolationE2E().catch((err) => {
  console.error('FAIL heap-callstack-isolation.e2e.ts:', err);
  process.exit(1);
});
