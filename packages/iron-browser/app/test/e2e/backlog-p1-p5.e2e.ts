import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decodePngToRgba } from '../../src/shared/png-filmstrip';
import { readPngDimensions } from '../../src/shared/viewport-report';
import { ControlSocketClient } from './lib/ctl-client';
import { launchElectronSession } from './lib/electron-harness';

const APP_ROOT = path.resolve(import.meta.dir, '../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const BIN_LAUNCHER = path.join(REPO_ROOT, 'bin', 'iron-browser');

interface StepResult {
  id: string;
  title: string;
  passed: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startBacklogFixtureServer(): Promise<{
  baseUrl: string;
  getHistoryHitCount: () => number;
  resetCounts: () => void;
  close: () => Promise<void>;
}> {
  let historyHitCount = 0;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (u.pathname === '/api/room/history') {
      historyHitCount += 1;
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: 'unauthorized', hit: historyHitCount }));
      return;
    }

    if (u.pathname === '/origami-rush') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Origami Rush Repro Fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #0f172a; color: #f8fafc; font-family: sans-serif; overflow-x: hidden; }
    #game-canvas { display: block; width: 320px; height: 180px; margin: 12px; border: 2px solid #38bdf8; }
    .clipped-row { position: relative; height: 48px; }
    #offscreen-cta {
      position: absolute;
      left: calc(100vw - 60px);
      top: 4px;
      width: 180px;
      height: 36px;
      background: #0284c7;
      color: #fff;
      border: 0;
    }
    #clipped-secret-input {
      position: absolute;
      left: calc(100vw - 40px);
      top: 44px;
      width: 160px;
      height: 28px;
    }
  </style>
</head>
<body>
  <div id="hud">Ready</div>
  <canvas id="game-canvas" width="320" height="180"></canvas>
  <div class="clipped-row">
    <button id="offscreen-cta" data-testid="offscreen-cta" type="button">Launch Fold 1.94x</button>
    <input id="clipped-secret-input" type="password" value="top-secret-dont-leak" />
  </div>
  <script>
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const state = {
      seed: 'default-seed',
      phase: 'forest',
      frame: 0,
      multiplier: 1.0,
      timeMs: 0,
    };

    function renderScene() {
      const isSea = state.frame >= 120 || state.phase === 'sea';
      ctx.fillStyle = isSea ? '#0369a1' : '#15803d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#facc15';
      const x = 20 + ((state.frame * 2) % 240);
      ctx.fillRect(x, 60, 40, 40);
      document.getElementById('hud').textContent =
        state.seed + ' | f=' + state.frame + ' | ' + state.multiplier + 'x | ' + (isSea ? 'sea' : 'forest') + ' | ' + window.innerWidth + 'x' + window.innerHeight;
    }

    window.__ironSceneDriver = {
      setState(next) {
        if (next.seed !== undefined && next.seed !== null) state.seed = next.seed;
        if (typeof next.frame === 'number') state.frame = next.frame;
        if (typeof next.multiplier === 'number') state.multiplier = next.multiplier;
        if (typeof next.timeMs === 'number') state.timeMs = next.timeMs;
        if (next.phase) {
          state.phase = next.phase;
        } else {
          state.phase = state.frame >= 120 ? 'sea' : 'forest';
        }
        renderScene();
      },
      step(deltaFrames) {
        state.frame += Number(deltaFrames || 0);
        state.phase = state.frame >= 120 ? 'sea' : 'forest';
        renderScene();
      },
      getState() {
        return { ...state };
      },
    };
    renderScene();
  </script>
</body>
</html>`);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind backlog server');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    getHistoryHitCount: () => historyHitCount,
    resetCounts: () => {
      historyHitCount = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function callMcpToolsViaSymlink(
  symlinkPath: string,
  socketPath: string,
  requests: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(symlinkPath, ['mcp'], {
      cwd: path.dirname(symlinkPath),
      env: {
        ...process.env,
        IRON_BROWSER_SOCKET: socketPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP symlink call timed out. stderr=${stderr}`));
    }, 15_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`MCP exited with code=${code}: ${stderr}`));
        return;
      }
      const lines = stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve(lines);
    });

    const wire =
      requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
    child.stdin.write(wire);
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const results: StepResult[] = [];
  const srv = await startBacklogFixtureServer();
  const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-symlink-e2e-'));
  const symlinkBin = path.join(symlinkDir, 'iron-browser');
  fs.symlinkSync(BIN_LAUNCHER, symlinkBin);

  const runCase = async (
    id: string,
    title: string,
    fn: () => Promise<string | void>,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      const durationMs = Date.now() - t0;
      results.push({ id, title, passed: true, durationMs, ...(detail ? { detail } : {}) });
      process.stdout.write(`[PASS] ${id} — ${title} [${durationMs}ms]${detail ? ` (${detail})` : ''}\n`);
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      results.push({ id, title, passed: false, durationMs, error: message });
      process.stdout.write(`[FAIL] ${id} — ${title} [${durationMs}ms]\n  ${message}\n`);
    }
  };

  try {
    // 0. Symlink Launcher Smoke Test (Electron + MCP)
    await runCase(
      'BL-00',
      'Launcher symlink smoke test (bin/iron-browser via external symlink for Electron --smoke and MCP)',
      async () => {
        const smokeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sym-run-'));
        try {
          const ud = path.join(smokeTmp, 'ud');
          const sock = path.join(smokeTmp, 'ctl.sock');
          const args = [`--user-data-dir=${ud}`, '--smoke', '--smoke-exit-ms=250'];
          if (process.env.DISPLAY) {
            args.push('--ozone-platform=x11');
          } else if (process.env.WAYLAND_DISPLAY) {
            args.push('--ozone-platform=wayland');
          }

          const res = spawnSync(symlinkBin, args, {
            cwd: symlinkDir,
            env: {
              ...process.env,
              IRON_BROWSER_SMOKE: '1',
              IRON_BROWSER_USER_DATA: ud,
              IRON_BROWSER_SOCKET: sock,
            },
            encoding: 'utf8',
            timeout: 15_000,
          });
          assert.equal(res.status, 0, `symlink Electron smoke failed: ${res.stderr}`);
          assert.ok(res.stdout.includes('IRON_BROWSER_READY'), 'expected IRON_BROWSER_READY');

          const mcpVer = spawnSync(symlinkBin, ['mcp', '--version'], {
            cwd: symlinkDir,
            encoding: 'utf8',
            timeout: 5_000,
          });
          assert.equal(mcpVer.status, 0, `symlink MCP --version failed: ${mcpVer.stderr}`);
          assert.ok(mcpVer.stdout.includes('iron-browser-mcp'));
          return `Electron exit=0 & ${mcpVer.stdout.trim()}`;
        } finally {
          fs.rmSync(smokeTmp, { recursive: true, force: true });
        }
      },
    );

    // Launch isolated Electron session on a narrow 760x520 shell window to test P1..P5
    const session = await launchElectronSession({
      smoke: true,
      seedSession: {
        version: 1,
        savedAt: Date.now(),
        window: { width: 760, height: 520 },
        railCollapsed: false,
        dockOpen: false,
        dockHeight: 220,
        splitRatio: 0.36,
        theme: 'dark',
        ecoMode: true,
        autoSleep: false,
        activeTabIndex: 0,
        tabs: [],
        history: [],
      },
    });

    try {
      // P1 — Effective Viewport Reporting & Exact-Size Capture
      await runCase(
        'BL-P1',
        'Effective viewport reporting (sizeMismatch on narrow window) + exact_size:true 1050x660 capture & restore',
        async () => {
          const openRes = await session.ctl.request<{
            activeTabId: string;
            tab: { id: string; viewportReport?: Record<string, { sizeMismatch: boolean; effectiveCssSize: { width: number; height: number } | null }> };
            viewportReport: Record<string, { sizeMismatch: boolean; effectiveCssSize: { width: number; height: number } | null }>;
          }>('browser_open', {
            url: `${srv.baseUrl}/origami-rush`,
            mode: 'single',
            landscape_size: { width: 1050, height: 660, dpr: 1 },
          });
          const tabId = openRes.activeTabId;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/origami-rush' });

          const tabsRes = await session.ctl.request<{
            viewportReport: Record<string, { sizeMismatch: boolean; effectiveCssSize: { width: number; height: number }; requestedSize: { width: number; height: number } }>;
          }>('browser_tabs');
          const narrowReport = tabsRes.viewportReport.landscape;
          assert.ok(narrowReport, 'expected landscape viewportReport on browser_tabs');
          assert.equal(narrowReport.requestedSize.width, 1050);
          assert.equal(narrowReport.requestedSize.height, 660);
          assert.equal(
            narrowReport.sizeMismatch,
            true,
            `expected sizeMismatch=true on narrow 760x520 window in single mode, got ${JSON.stringify(narrowReport)}`,
          );

          // Default capture in narrow single mode reports sizeMismatch: true
          const rawShot = await session.ctl.request<{
            captures: { landscape: { width: number; height: number; pngBase64: string } };
            viewportReport: { landscape: { sizeMismatch: boolean; capturedPixels: { width: number; height: number } } };
          }>('browser_screenshot', { tab_id: tabId, target: 'landscape', exact_size: false });
          assert.equal(rawShot.viewportReport.landscape.sizeMismatch, true);

          // exact_size: true captures exact 1050x660 independent of narrow 760x520 window, then restores!
          const exactShot = await session.ctl.request<{
            captures: { landscape: { width: number; height: number; pngBase64: string; layoutAudit: { viewportWidth: number; viewportHeight: number } } };
            viewportReport: { landscape: { sizeMismatch: boolean; capturedPixels: { width: number; height: number } } };
          }>('browser_screenshot', { tab_id: tabId, target: 'landscape', exact_size: true });
          const exactPngDims = readPngDimensions(
            Buffer.from(exactShot.captures.landscape.pngBase64, 'base64'),
          );
          assert.deepEqual(exactPngDims, { width: 1050, height: 660 });
          assert.equal(exactShot.captures.landscape.layoutAudit.viewportWidth, 1050);
          assert.equal(exactShot.captures.landscape.layoutAudit.viewportHeight, 660);
          assert.equal(exactShot.viewportReport.landscape.sizeMismatch, false);

          // Verify single-mode visual bounds were restored after exact_size capture
          const postInnerW = Number(
            (await session.ctl.evalJs('window.innerWidth', 'landscape', tabId)).value,
          );
          assert.ok(postInnerW < 800, `expected restored narrow innerWidth < 800, got ${postInnerW}`);
          return `narrow=${narrowReport.effectiveCssSize.width}x${narrowReport.effectiveCssSize.height} (sizeMismatch=true) -> exact=1050x660 -> restored=${postInnerW}px`;
        },
      );

      // P2 — Saved Reproduction Recipes, Paired Frame Stepping & Labelled Filmstrip Export
      await runCase(
        'BL-P2',
        'Saved forest-to-sea 1.94x recipe reopen, paired scene-driver stepping & -1s..+1s labelled filmstrip PNG via Rust MCP',
        async () => {
          const saveRes = await session.ctl.request<{ ok: boolean; recipe: { name: string } }>(
            'browser_repro',
            {
              action: 'save',
              name: 'forest-to-sea-194',
              url: `${srv.baseUrl}/origami-rush`,
              mode: 'dual',
              session: 'shared',
              seed: 'island-seed-194',
              phase: 'sea',
              frame: 120,
              multiplier: 1.94,
              fps: 60,
              portrait_size: { width: 390, height: 844, dpr: 1 },
              landscape_size: { width: 1050, height: 660, dpr: 1 },
              canvas_selector: '#game-canvas',
            },
          );
          assert.equal(saveRes.ok, true);

          // Reopen recipe and Replay -1s..+1s around frame 120 (frames 60..180) over the real Rust MCP stdio sidecar!
          const mcpResponses = await callMcpToolsViaSymlink(symlinkBin, session.socketPath, [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'backlog-e2e', version: '1.0' },
              },
            },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'browser_filmstrip',
                arguments: {
                  recipe_name: 'forest-to-sea-194',
                  start_frame: 60,
                  end_frame: 180,
                  frame_step: 60,
                  fps: 60,
                  exact_size: true,
                  canvas_only: true,
                },
              },
            },
          ]);

          const listResp = mcpResponses.find((r) => r.id === 2) as {
            result: { tools: Array<{ name: string }> };
          };
          assert.equal(listResp.result.tools.length, 26, 'expected all 26 MCP tools exposed');

          const stripResp = mcpResponses.find((r) => r.id === 3) as {
            result: {
              isError: boolean;
              content: Array<{ type: string; data?: string; text?: string; mimeType?: string }>;
            };
          };
          assert.equal(stripResp.result.isError, false);
          const imgBlock = stripResp.result.content.find((c) => c.type === 'image');
          const txtBlock = stripResp.result.content.find((c) => c.type === 'text');
          assert.ok(imgBlock?.data, 'expected filmstrip PNG image content block');
          assert.ok(txtBlock?.text, 'expected filmstrip metadata text block');

          const decodedStrip = decodePngToRgba(Buffer.from(imgBlock.data, 'base64'));
          assert.ok(decodedStrip.width > 200 && decodedStrip.height > 200);

          const meta = JSON.parse(txtBlock.text) as {
            rows: number;
            columns: number;
            steps: Array<{
              frame: number;
              seed: string;
              phase: string;
              multiplier: number;
              pairedMatch: boolean;
            }>;
          };
          assert.equal(meta.rows, 3);
          assert.equal(meta.columns, 2);
          assert.deepEqual(
            meta.steps.map((s) => s.frame),
            [60, 120, 180],
          );
          assert.ok(meta.steps.every((s) => s.seed === 'island-seed-194'));
          assert.ok(meta.steps.every((s) => s.multiplier === 1.94));
          assert.ok(meta.steps.every((s) => s.pairedMatch === true));
          assert.equal(meta.steps[0]?.phase, 'forest');
          assert.equal(meta.steps[1]?.phase, 'sea');
          assert.equal(meta.steps[2]?.phase, 'sea');
          return `filmstrip=${decodedStrip.width}x${decodedStrip.height}px, steps=60(forest)->120(sea)->180(sea) @ 1.94x`;
        },
      );

      // P3 — Cross-Pane Diagnostic Incident Grouping
      await runCase(
        'BL-P3',
        'Cross-pane 401 room-history grouped into 1 incident across 2 viewports; single-pane JS exception stays distinct',
        async () => {
          srv.resetCounts();
          const opened = await session.ctl.open(`${srv.baseUrl}/origami-rush`, {
            mode: 'dual',
            session: 'shared',
          });
          const tabId = opened.tab!.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/origami-rush' });

          const trigger401Expr = `(async () => {
            const r = await fetch(${JSON.stringify(`${srv.baseUrl}/api/room/history?token=secret-jwt`)});
            if (!r.ok) {
              console.error('History endpoint failed: ' + r.status + ' /api/room/history');
            }
            return r.status;
          })()`;
          await Promise.all([
            session.ctl.evalJs(trigger401Expr, 'portrait', tabId),
            session.ctl.evalJs(trigger401Expr, 'landscape', tabId),
          ]);

          // Trigger an uncaught JS exception on Portrait ONLY
          await session.ctl.evalJs(
            `setTimeout(() => { throw new ReferenceError('origamiWingFoldNull'); }, 0); 'scheduled'`,
            'portrait',
            tabId,
          );
          await sleep(250);

          // Both GET requests hit upstream (not suppressed by R2 GET or incident grouping)
          assert.equal(
            srv.getHistoryHitCount(),
            2,
            'both panes must hit /api/room/history while grouping diagnostically',
          );

          const incRes = await session.ctl.request<{
            count: number;
            incidents: Array<{
              kind: string;
              method: string | null;
              sanitizedPath: string | null;
              status: number | null;
              affectedViewports: string[];
              requests: unknown[];
              consoleEntries: Array<{ text: string }>;
            }>;
          }>('browser_incidents', { tab_id: tabId });

          const historyIncidents = incRes.incidents.filter(
            (i) => i.kind === 'network-failure' && i.sanitizedPath === '/api/room/history',
          );
          assert.equal(historyIncidents.length, 1, '401 history must group into 1 cross-pane incident');
          const hInc = historyIncidents[0]!;
          assert.equal(hInc.method, 'GET');
          assert.equal(hInc.status, 401);
          assert.deepEqual(hInc.affectedViewports, ['portrait', 'landscape']);
          assert.equal(hInc.requests.length, 2);
          assert.ok(hInc.consoleEntries.length >= 2, 'linked console errors from both panes attached');
          assert.equal(JSON.stringify(hInc).includes('secret-jwt'), false);

          const jsExceptions = incRes.incidents.filter((i) => i.kind === 'js-exception');
          assert.equal(jsExceptions.length, 1, 'single-pane JS exception must stay distinct');
          assert.deepEqual(jsExceptions[0]?.affectedViewports, ['portrait']);
          assert.ok(
            jsExceptions[0]?.consoleEntries.some((c) => c.text.includes('origamiWingFoldNull')),
          );
          return `1 cross-pane 401 incident (2 reqs + ${hInc.consoleEntries.length} console errs) + 1 distinct portrait JS exception`;
        },
      );

      // P4 — Partial Dual Screenshots, Stage Diagnostics & Clipped-Element Highlighting
      await runCase(
        'BL-P4',
        'Clipped element details ({selector, bounds, overflowPx}), highlight_clipped:true overlay, and partial dual capture when 1 pane stalls',
        async () => {
          // Use isolated session so Portrait and Landscape run in separate Chromium renderer processes,
          // allowing us to deterministically wedge Portrait's main thread without starving Landscape's V8 isolate.
          const opened = await session.ctl.open(`${srv.baseUrl}/origami-rush`, {
            mode: 'dual',
            session: 'isolated',
          });
          const tabId = opened.tab!.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/origami-rush' });

          const plainShot = await session.ctl.request<{
            captures: {
              portrait: {
                pngBase64: string;
                layoutAudit: {
                  clippedElements: number;
                  clippedItems: Array<{
                    selector: string;
                    tag: string;
                    text: string;
                    bounds: { x: number; y: number; width: number; height: number };
                    overflowPx: { left: number; right: number };
                  }>;
                };
              };
            };
          }>('browser_screenshot', {
            tab_id: tabId,
            target: 'portrait',
            exact_size: true,
            highlight_clipped: false,
          });

          const audit = plainShot.captures.portrait.layoutAudit;
          assert.ok(audit.clippedElements >= 2, `expected >=2 clipped elements, got ${audit.clippedElements}`);
          const ctaItem = audit.clippedItems.find((item) => item.selector.includes('offscreen-cta'));
          assert.ok(ctaItem, 'expected #offscreen-cta in clippedItems');
          assert.equal(ctaItem.tag, 'button');
          assert.ok(ctaItem.overflowPx.right > 50, `expected right overflow > 50px, got ${ctaItem.overflowPx.right}`);
          assert.equal(
            JSON.stringify(audit.clippedItems).includes('top-secret-dont-leak'),
            false,
            'clipped password input value must be redacted',
          );

          const highlightedShot = await session.ctl.request<{
            captures: { portrait: { pngBase64: string } };
          }>('browser_screenshot', {
            tab_id: tabId,
            target: 'portrait',
            exact_size: true,
            highlight_clipped: true,
          });
          assert.notEqual(
            highlightedShot.captures.portrait.pngBase64,
            plainShot.captures.portrait.pngBase64,
            'highlight_clipped:true should draw visual outline into PNG',
          );

          const leftoverOverlay = await session.ctl.evalJs(
            "Boolean(document.getElementById('__iron_clipped_highlight_root__'))",
            'portrait',
            tabId,
          );
          assert.equal(leftoverOverlay.value, 'false', 'temporary highlight overlay must be removed');

          // Stall Portrait main thread for 2200ms while requesting dual screenshot with timeout_ms: 1000:
          // Landscape still returns its PNG + layoutAudit while Portrait reports a stage error!
          const busyExpr = `new Promise((resolve) => {
            setTimeout(() => {
              const end = Date.now() + 2200;
              while (Date.now() < end) {}
              resolve('done');
            }, 10);
          })`;
          const busyPromise = session.ctl.evalJs(busyExpr, 'portrait', tabId);
          await sleep(50);

          const partialShot = await session.ctl.request<{
            partial: boolean;
            captures: {
              portrait?: { pngBase64: string };
              landscape?: { pngBase64: string; layoutAudit: { viewportWidth: number } };
            };
            errors?: Array<{ stage: string; viewport: string; error: string }>;
          }>('browser_screenshot', {
            tab_id: tabId,
            target: 'both',
            timeout_ms: 1000,
          });
          await busyPromise;

          assert.ok(
            partialShot.captures.landscape && partialShot.captures.landscape.pngBase64.length > 0,
            'healthy landscape pane PNG must still return when portrait stalls',
          );
          assert.equal(partialShot.partial, true, 'expected partial=true when portrait layout_audit stalled');
          assert.ok(
            partialShot.errors?.some((e) => e.viewport === 'portrait'),
            `expected portrait stage diagnostic error, got ${JSON.stringify(partialShot.errors)}`,
          );
          return `clippedItems=${audit.clippedItems.length} (${ctaItem.selector} +${ctaItem.overflowPx.right}px), partial recovery verified`;
        },
      );

      // P5 — Short MCP Performance Traces Around App Marks
      await runCase(
        'BL-P5',
        '2-second biome_crossing trace returns before/during/after frame times for both panes & separates GPU-process CPU% from GPU execution time',
        async () => {
          const opened = await session.ctl.open(`${srv.baseUrl}/origami-rush`, {
            mode: 'dual',
            session: 'shared',
          });
          const tabId = opened.tab!.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/origami-rush' });

          const started = await session.ctl.request<{ ok: boolean; traceId: string }>(
            'browser_trace_start',
            { tab_id: tabId, max_duration_ms: 5000 },
          );
          assert.equal(started.ok, true);

          await sleep(500);
          await Promise.all([
            session.ctl.evalJs("performance.mark('biome_crossing:start'); 'ok'", 'portrait', tabId),
            session.ctl.evalJs("performance.mark('biome_crossing:start'); 'ok'", 'landscape', tabId),
          ]);
          await sleep(500);
          await Promise.all([
            session.ctl.evalJs(
              "performance.mark('biome_crossing:end'); performance.measure('biome_crossing_span', 'biome_crossing:start', 'biome_crossing:end'); 'ok'",
              'portrait',
              tabId,
            ),
            session.ctl.evalJs(
              "performance.mark('biome_crossing:end'); performance.measure('biome_crossing_span', 'biome_crossing:start', 'biome_crossing:end'); 'ok'",
              'landscape',
              tabId,
            ),
          ]);
          await sleep(600);

          const trace = await session.ctl.request<{
            ok: boolean;
            durationMs: number;
            gpu: {
              gpuProcessCpuPercent: number;
              gpuExecutionTimeMs: number | null;
              gpuProcessCpuLabel: string;
              gpuExecutionTimeLabel: string;
            };
            viewports: Record<
              'portrait' | 'landscape',
              {
                summary: { frameCount: number; fps: number };
                marks: Array<{ name: string }>;
                measures: Array<{ name: string }>;
                markWindows: Array<{
                  name: string;
                  before: { frameCount: number };
                  during: { frameCount: number };
                  after: { frameCount: number };
                }>;
              }
            >;
          }>('browser_trace_stop', { tab_id: tabId });

          assert.equal(trace.ok, true);
          assert.ok(trace.durationMs >= 1400, `expected ~1.6s+ trace duration, got ${trace.durationMs}ms`);
          assert.equal(typeof trace.gpu.gpuProcessCpuPercent, 'number');
          assert.equal(trace.gpu.gpuExecutionTimeMs, null);
          assert.ok(trace.gpu.gpuProcessCpuLabel.includes('NOT hardware GPU shader execution time'));

          for (const role of ['portrait', 'landscape'] as const) {
            const vp = trace.viewports[role];
            assert.ok(vp, `expected ${role} trace report`);
            assert.ok(vp.summary.frameCount >= 20, `${role} expected >=20 frame samples, got ${vp.summary.frameCount}`);
            assert.ok(vp.marks.some((m) => m.name === 'biome_crossing:start'));
            const handoff = vp.markWindows.find((w) => w.name === 'biome_crossing');
            assert.ok(handoff, `${role} expected biome_crossing before/during/after breakdown`);
            assert.ok(handoff.before.frameCount > 0, `${role} before frames > 0`);
            assert.ok(handoff.during.frameCount > 0, `${role} during frames > 0`);
            assert.ok(handoff.after.frameCount > 0, `${role} after frames > 0`);
          }
          return `portrait=${trace.viewports.portrait.summary.frameCount}f, landscape=${trace.viewports.landscape.summary.frameCount}f, gpuProcessCpu=${trace.gpu.gpuProcessCpuPercent}% (gpuExecMs=null)`;
        },
      );
    } finally {
      await session.close();
    }
  } finally {
    await srv.close();
    fs.rmSync(symlinkDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  process.stdout.write(
    `\nBacklog Phase 3 E2E Summary: ${passed}/${results.length} passed, ${failed} failed\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
