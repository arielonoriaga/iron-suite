import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  ControlSocketClient,
  CtlFrameDecoder,
  CtlRpcError,
  encodeCtlFrame,
} from './lib/ctl-client';
import { launchElectronSession } from './lib/electron-harness';
import { createTestServerCluster } from './lib/test-servers';
import type {
  E2ERunResult,
  E2ESummaryReport,
  E2ETestCase,
  E2ETestContext,
  E2ETier,
} from './lib/types';

const E2E_ROOT = import.meta.dir;
const APP_ROOT = path.resolve(E2E_ROOT, '../..');
const DIST_MAIN_ENTRY = path.join(APP_ROOT, 'dist', 'main', 'index.js');

const TIER_MODULE_FILES: ReadonlyArray<{ tier: E2ETier; relPath: string }> = [
  { tier: 1, relPath: 'tiers/tier1-features.ts' },
  { tier: 2, relPath: 'tiers/tier2-boundaries.ts' },
  { tier: 3, relPath: 'tiers/tier3-pairwise.ts' },
  { tier: 4, relPath: 'tiers/tier4-scenarios.ts' },
  { tier: 'smoke', relPath: 'smoke.e2e.ts' },
];

interface ParsedCliOptions {
  help: boolean;
  list: boolean;
  selfCheck: boolean;
  json: boolean;
  tier: E2ETier | 'all';
  filter: string | null;
}

interface SelfCheckStepResult {
  name: string;
  passed: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

function parseTierValue(raw: string): E2ETier | 'all' {
  switch (raw) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    case 'smoke':
      return 'smoke';
    case 'all':
      return 'all';
    default:
      throw new Error(
        `Invalid --tier value '${raw}'. Expected 1|2|3|4|smoke|all.`,
      );
  }
}

function parseCliArgs(argv: string[]): ParsedCliOptions {
  const opts: ParsedCliOptions = {
    help: false,
    list: false,
    selfCheck: false,
    json: false,
    tier: 'all',
    filter: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--list') {
      opts.list = true;
    } else if (arg === '--self-check') {
      opts.selfCheck = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--tier=')) {
      opts.tier = parseTierValue(arg.slice('--tier='.length));
    } else if (arg === '--tier') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('Missing value for --tier');
      }
      opts.tier = parseTierValue(next);
      i += 1;
    } else if (arg.startsWith('--filter=')) {
      opts.filter = arg.slice('--filter='.length);
    } else if (arg === '--filter') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('Missing value for --filter');
      }
      opts.filter = next;
      i += 1;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

function isTestCaseArray(val: unknown): val is E2ETestCase[] {
  if (!Array.isArray(val)) return false;
  return val.every(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as E2ETestCase).id === 'string' &&
      typeof (item as E2ETestCase).run === 'function',
  );
}

async function loadRegisteredTests(): Promise<E2ETestCase[]> {
  const loaded: E2ETestCase[] = [];

  for (const spec of TIER_MODULE_FILES) {
    const absPath = path.join(E2E_ROOT, spec.relPath);
    if (!fs.existsSync(absPath)) continue;

    const mod = (await import(pathToFileURL(absPath).href)) as Record<
      string,
      unknown
    >;

    if (isTestCaseArray(mod.default)) {
      loaded.push(...mod.default);
      continue;
    }
    if (isTestCaseArray(mod.tests)) {
      loaded.push(...mod.tests);
      continue;
    }
    for (const exported of Object.values(mod)) {
      if (isTestCaseArray(exported)) {
        loaded.push(...exported);
        break;
      }
    }
  }

  return loaded;
}

function filterTests(
  tests: E2ETestCase[],
  tier: E2ETier | 'all',
  filter: string | null,
): E2ETestCase[] {
  const needle = filter?.trim().toLowerCase() ?? '';
  return tests.filter((tc) => {
    if (tier !== 'all' && tc.tier !== tier) return false;
    if (!needle) return true;
    const haystack = [
      tc.id,
      String(tc.tier),
      tc.title,
      tc.description,
      ...tc.features,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
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

async function runSelfCheck(jsonOutput: boolean): Promise<boolean> {
  const steps: SelfCheckStepResult[] = [];
  const servers = createTestServerCluster();

  const runStep = async (
    name: string,
    fn: () => Promise<string | void>,
  ): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({
        name,
        passed: true,
        durationMs: Date.now() - started,
        ...(detail ? { detail } : {}),
      });
    } catch (err) {
      steps.push({
        name,
        passed: false,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    await servers.start();

    await runStep('http-server-endpoints-and-logs', async () => {
      assert.ok(servers.httpBaseUrl.startsWith('http://127.0.0.1:'));
      assert.ok(servers.altOriginBaseUrl.startsWith('http://127.0.0.1:'));
      assert.notEqual(servers.httpBaseUrl, servers.altOriginBaseUrl);

      servers.resetHttpLogs();

      // /echo
      const echoRes = await fetch(`${servers.httpBaseUrl}/echo?foo=bar`);
      assert.equal(echoRes.status, 200);
      const echoJson = (await echoRes.json()) as {
        method: string;
        path: string;
        query: Record<string, string>;
        count: number;
      };
      assert.equal(echoJson.method, 'GET');
      assert.equal(echoJson.path, '/echo');
      assert.equal(echoJson.query.foo, 'bar');
      assert.equal(echoJson.count, 1);

      // /mutate across POST/PUT/PATCH/DELETE + correlation JSON
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await fetch(`${servers.httpBaseUrl}/mutate`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: `idem-${method}`,
            requestId: `req-${method}`,
            amount: 42,
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          ok: boolean;
          method: string;
          correlation: Record<string, unknown>;
        };
        assert.equal(body.ok, true);
        assert.equal(body.method, method);
        assert.equal(body.correlation.idempotencyKey, `idem-${method}`);
        assert.equal(body.correlation.requestId, `req-${method}`);
      }
      assert.equal(servers.getMutationCount('/mutate'), 4);

      // /mutate-gzip (decompress raw body directly or verify decompression)
      const gzipRes = await fetch(`${servers.httpBaseUrl}/mutate-gzip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
        },
        body: JSON.stringify({ correlationId: 'corr-gz' }),
        decompress: false,
      });
      assert.equal(gzipRes.status, 200);
      assert.equal(gzipRes.headers.get('content-encoding'), 'gzip');
      const gzipRaw = Buffer.from(await gzipRes.arrayBuffer());
      const gzipDecoded = JSON.parse(
        zlib.gunzipSync(gzipRaw).toString('utf8'),
      ) as { correlation: { correlationId?: string } };
      assert.equal(gzipDecoded.correlation.correlationId, 'corr-gz');

      // /mutate-br
      const brRes = await fetch(`${servers.httpBaseUrl}/mutate-br`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceId: 'tr-br' }),
        decompress: false,
      });
      assert.equal(brRes.status, 200);
      assert.equal(brRes.headers.get('content-encoding'), 'br');
      const brRaw = Buffer.from(await brRes.arrayBuffer());
      const brDecoded = JSON.parse(
        zlib.brotliDecompressSync(brRaw).toString('utf8'),
      ) as { correlation: { traceId?: string } };
      assert.equal(brDecoded.correlation.traceId, 'tr-br');

      // /mutate-deflate
      const defRes = await fetch(`${servers.httpBaseUrl}/mutate-deflate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: 'cr-def' }),
        decompress: false,
      });
      assert.equal(defRes.status, 200);
      assert.equal(defRes.headers.get('content-encoding'), 'deflate');
      const defRaw = Buffer.from(await defRes.arrayBuffer());
      const defDecoded = JSON.parse(
        zlib.inflateSync(defRaw).toString('utf8'),
      ) as { correlation: { clientRequestId?: string } };
      assert.equal(defDecoded.correlation.clientRequestId, 'cr-def');

      // /status/401 & /status/302
      const s401 = await fetch(`${servers.httpBaseUrl}/status/401`);
      assert.equal(s401.status, 401);
      const s302 = await fetch(`${servers.httpBaseUrl}/status/302`, {
        redirect: 'manual',
      });
      assert.equal(s302.status, 302);
      assert.equal(s302.headers.get('location'), '/echo');

      // /large (> 2 MiB)
      const largeRes = await fetch(`${servers.httpBaseUrl}/large`);
      assert.equal(largeRes.status, 200);
      const largeBuf = await largeRes.arrayBuffer();
      assert.ok(
        largeBuf.byteLength > 2 * 1024 * 1024,
        `expected >2MB, got ${largeBuf.byteLength}`,
      );

      // /stream (ndjson & binary)
      const ndjsonRes = await fetch(`${servers.httpBaseUrl}/stream?type=ndjson`);
      assert.equal(ndjsonRes.status, 200);
      assert.ok(
        ndjsonRes.headers.get('content-type')?.includes('application/x-ndjson'),
      );
      const ndjsonText = await ndjsonRes.text();
      assert.ok(ndjsonText.includes('{"seq":1}') && ndjsonText.includes('{"seq":2}'));

      const binRes = await fetch(`${servers.httpBaseUrl}/stream?type=bin`);
      assert.equal(binRes.status, 200);
      const binBytes = new Uint8Array(await binRes.arrayBuffer());
      assert.deepEqual(Array.from(binBytes), [1, 2, 3, 4, 5, 6, 7, 8]);

      // /cacheable incrementing seq
      const c1 = (await (
        await fetch(`${servers.httpBaseUrl}/cacheable?format=json`)
      ).json()) as { seq: number };
      const c2 = (await (
        await fetch(`${servers.httpBaseUrl}/cacheable?format=json`)
      ).json()) as { seq: number };
      assert.ok(c2.seq > c1.seq);

      // /page/* fixtures + altOriginBaseUrl
      for (const page of [
        '/page/interactions',
        '/page/shadow',
        '/page/iframe-same',
        '/page/iframe-cross',
        '/page/iframe-child',
        '/page/password',
        '/page/ws-sse',
      ]) {
        const pRes = await fetch(`${servers.httpBaseUrl}${page}`);
        assert.equal(pRes.status, 200, `Expected 200 for ${page}`);
        const pText = await pRes.text();
        assert.ok(pText.includes('<!doctype html>'));
      }
      const altRes = await fetch(`${servers.altOriginBaseUrl}/echo`);
      assert.equal(altRes.status, 200);
      const altJson = (await altRes.json()) as { origin: string };
      assert.equal(altJson.origin, 'alt');

      const logs = servers.getHttpLogs('/mutate');
      assert.ok(logs.length >= 4);
      servers.resetHttpLogs();
      assert.equal(servers.getHttpLogs().length, 0);

      return `${servers.httpBaseUrl} + alt ${servers.altOriginBaseUrl}`;
    });

    await runStep('websocket-subprotocol-binary-and-1012-close', async () => {
      servers.resetWsStats();
      const ws = new WebSocket(servers.wsBaseUrl, ['chat.v1']);
      ws.binaryType = 'arraybuffer';

      const received: Array<string | number[]> = [];
      let closeInfo: { code: number; reason: string } | null = null;

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout')), 5_000);
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

      const closedPromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.addEventListener('close', (ev) => {
            closeInfo = { code: ev.code, reason: ev.reason };
            resolve(closeInfo);
          });
        },
      );

      ws.addEventListener('message', (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          received.push(Array.from(new Uint8Array(ev.data)));
        } else {
          received.push(String(ev.data));
        }
      });

      ws.send('hello-ws');
      ws.send(new Uint8Array([9, 8, 7]));

      const deadline = Date.now() + 3_000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(received[0], 'hello-ws');
      assert.deepEqual(received[1], [9, 8, 7]);

      const stats = servers.getWsStats();
      assert.equal(stats.activeConnections, 1);
      assert.equal(stats.receivedMessages.length, 2);
      assert.equal(stats.receivedMessages[0]?.subprotocol, 'chat.v1');
      assert.equal(stats.receivedMessages[1]?.isBinary, true);

      const closedCount = servers.closeAllWs(1012, 'restart');
      assert.equal(closedCount, 1);
      const closed = await closedPromise;
      assert.equal(closed.code, 1012);
      assert.equal(closed.reason, 'restart');

      return 'subprotocol=chat.v1, text+binary echo, close=1012';
    });

    await runStep('sse-named-events-and-last-event-id', async () => {
      servers.resetSseStats();
      const abort1 = new AbortController();
      const res1 = await fetch(servers.sseBaseUrl, { signal: abort1.signal });
      assert.equal(res1.status, 200);
      assert.ok(res1.headers.get('content-type')?.includes('text/event-stream'));

      const reader = res1.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();

      // Drain initial comment
      const firstChunk = await reader.read();
      assert.equal(firstChunk.done, false);

      const delivered = servers.pushSseEvent('ping-evt', '{"ok":true}', 'evt-42');
      assert.equal(delivered, 1);

      let eventPayload = '';
      const deadline = Date.now() + 3_000;
      while (
        !eventPayload.includes('data: {"ok":true}') &&
        Date.now() < deadline
      ) {
        const next = await reader.read();
        if (next.done) break;
        eventPayload += decoder.decode(next.value, { stream: true });
      }
      assert.ok(eventPayload.includes('id: evt-42'));
      assert.ok(eventPayload.includes('event: ping-evt'));
      assert.ok(eventPayload.includes('data: {"ok":true}'));
      abort1.abort();

      // Reconnect with Last-Event-ID
      const abort2 = new AbortController();
      const res2 = await fetch(servers.sseBaseUrl, {
        headers: { 'Last-Event-ID': 'evt-42' },
        signal: abort2.signal,
      });
      assert.equal(res2.status, 200);
      abort2.abort();

      const stats = servers.getSseStats();
      assert.equal(stats.totalConnections, 2);
      assert.ok(stats.lastEventIdsReceived.includes('evt-42'));
      servers.closeAllSse();

      return 'event=ping-evt, id=evt-42, Last-Event-ID verified';
    });

    await runStep('ctl-client-framing-and-rpc-error-envelope', async () => {
      const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ctl-chk-'));
      const sockPath = path.join(sockDir, 'ctl.sock');
      const serverDecoder = new CtlFrameDecoder();

      const mockServer = net.createServer((sock) => {
        sock.on('data', (chunk) => {
          const frames = serverDecoder.push(chunk);
          for (const raw of frames) {
            const req = raw as { id: number | string; method: string };
            if (req.method === 'ping') {
              // Send split across 2 chunks to exercise client partial-frame buffering.
              const frame = encodeCtlFrame({
                id: req.id,
                ok: true,
                result: { pong: true, version: 'mock', socketPath: sockPath },
              });
              sock.write(frame.subarray(0, 3));
              setTimeout(() => {
                if (!sock.destroyed) sock.write(frame.subarray(3));
              }, 10);
            } else {
              sock.write(
                encodeCtlFrame({
                  id: req.id,
                  ok: false,
                  error: {
                    code: -32000,
                    message: `unknown RPC method: ${req.method}`,
                  },
                }),
              );
            }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        mockServer.once('error', reject);
        mockServer.listen(sockPath, resolve);
      });

      const client = await ControlSocketClient.connect(sockPath, 3_000);
      try {
        const pong = await client.ping();
        assert.equal(pong.pong, true);
        assert.equal(pong.version, 'mock');

        await assert.rejects(
          () => client.request('no_such_method'),
          (err: unknown) =>
            err instanceof CtlRpcError &&
            err.code === -32000 &&
            err.message.includes('unknown RPC method'),
        );
      } finally {
        client.close();
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
        fs.rmSync(sockDir, { recursive: true, force: true });
      }

      return 'chunked 4-byte LE framing + -32000 CtlRpcError';
    });

    await runStep('electron-smoke-harness-and-live-rpcs', async () => {
      if (!fs.existsSync(DIST_MAIN_ENTRY)) {
        return `SKIPPED (${DIST_MAIN_ENTRY} not built)`;
      }

      const session = await launchElectronSession({
        smoke: true,
        readyTimeoutMs: 15_000,
      });

      try {
        assert.ok(session.getStdout().includes('IRON_BROWSER_READY'));
        const pong = await session.ctl.ping();
        assert.equal(pong.pong, true);

        const initialTabs = await session.ctl.tabs();
        assert.ok(Array.isArray(initialTabs.tabs));

        const opened = await session.ctl.open(`${servers.httpBaseUrl}/echo`, {
          mode: 'dual',
          session: 'shared',
        });
        assert.ok(opened.tab?.id);

        const readyTab = await session.ctl.waitForTabReady(opened.tab.id, {
          expectedUrlIncludes: '/echo',
          timeoutMs: 10_000,
        });
        assert.equal(readyTab.loading, false);

        const evalRes = await session.ctl.evalJs(
          'document.readyState',
          'portrait',
          readyTab.id,
        );
        assert.equal(evalRes.value, 'complete');

        const metrics = await session.ctl.metrics();
        assert.equal(typeof metrics.totalMemoryMb, 'number');

        const shot = await session.ctl.screenshot(readyTab.id, 'both');
        assert.ok((shot.captures.portrait?.bytes ?? 0) > 0);
        assert.ok((shot.captures.landscape?.bytes ?? 0) > 0);

        const cons = await session.ctl.console(readyTab.id, 10);
        assert.ok(Array.isArray(cons.entries));

        const netEntries = await session.ctl.network(readyTab.id, 10);
        assert.ok(Array.isArray(netEntries.entries));

        await assert.rejects(
          () => session.ctl.request('unknown_e2e_probe_method'),
          (err: unknown) => err instanceof CtlRpcError && err.code === -32000,
        );

        return `pid=${session.process.pid ?? '?'} tab=${readyTab.id}`;
      } finally {
        await session.close();
      }
    });
  } finally {
    await servers.stop();
  }

  const allPassed = steps.every((s) => s.passed);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ selfCheck: allPassed, steps }, null, 2)}\n`);
  } else {
    for (const step of steps) {
      const tag = step.passed ? 'PASS' : 'FAIL';
      const extra = step.passed
        ? step.detail
          ? ` (${step.detail})`
          : ''
        : ` — ${step.error ?? 'unknown error'}`;
      process.stdout.write(`[${tag}] ${step.name} [${step.durationMs}ms]${extra}\n`);
    }
    process.stdout.write(
      `\nSelf-check ${allPassed ? 'PASSED' : 'FAILED'} (${steps.filter((s) => s.passed).length}/${steps.length} checks)\n`,
    );
  }
  return allPassed;
}

async function runTests(
  tests: E2ETestCase[],
  jsonOutput: boolean,
): Promise<boolean> {
  const startedAt = Date.now();
  const servers = createTestServerCluster();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-run-'));
  const results: E2ERunResult[] = [];

  await servers.start();
  try {
    const ctx: E2ETestContext = {
      servers,
      launchElectron: (opts) => launchElectronSession(opts),
      tmpRoot,
    };

    for (const tc of tests) {
      const tcStart = Date.now();
      const timeoutMs = tc.timeoutMs ?? 60_000;
      try {
        await runWithTimeout(() => tc.run(ctx), timeoutMs, tc.id);
        const durationMs = Date.now() - tcStart;
        results.push({
          id: tc.id,
          tier: tc.tier,
          features: tc.features,
          title: tc.title,
          passed: true,
          durationMs,
        });
        if (!jsonOutput) {
          process.stdout.write(
            `[PASS] ${tc.id} (${tc.features.join(',')}) — ${tc.title} [${durationMs}ms]\n`,
          );
        }
      } catch (err) {
        const durationMs = Date.now() - tcStart;
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          id: tc.id,
          tier: tc.tier,
          features: tc.features,
          title: tc.title,
          passed: false,
          durationMs,
          error: message,
        });
        if (!jsonOutput) {
          process.stdout.write(
            `[FAIL] ${tc.id} (${tc.features.join(',')}) — ${tc.title} [${durationMs}ms]\n  ${message}\n`,
          );
        }
      }
    }
  } finally {
    await servers.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const report: E2ESummaryReport = {
    total: results.length,
    passed,
    failed,
    durationMs: Date.now() - startedAt,
    results,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `\nE2E Summary: ${report.passed}/${report.total} passed, ${report.failed} failed (${report.durationMs}ms)\n`,
    );
  }

  return failed === 0;
}

function printHelp(): void {
  process.stdout.write(
    `IronBrowser Opaque-Box E2E Runner

Usage:
  bun run test/e2e/runner.ts [options]

Options:
  --self-check         Verify local HTTP/WS/SSE servers, CTL framing, and Electron --smoke
  --list               List registered tests matching --tier and --filter
  --tier=<val>         Filter by tier: 1 | 2 | 3 | 4 | smoke | all (default: all)
  --filter=<substr>    Filter test IDs, titles, descriptions, or features
  --json               Emit machine-readable JSON output
  --help, -h           Show this help message
`,
  );
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.selfCheck) {
    const ok = await runSelfCheck(opts.json);
    process.exit(ok ? 0 : 1);
  }

  const allTests = await loadRegisteredTests();
  const selected = filterTests(allTests, opts.tier, opts.filter);

  if (opts.list) {
    if (opts.json) {
      const payload = selected.map((tc) => ({
        id: tc.id,
        tier: tc.tier,
        features: tc.features,
        title: tc.title,
        description: tc.description,
      }));
      process.stdout.write(
        `${JSON.stringify({ total: payload.length, tests: payload }, null, 2)}\n`,
      );
    } else if (selected.length === 0) {
      process.stdout.write('No registered E2E tests matched.\n');
    } else {
      for (const tc of selected) {
        process.stdout.write(
          `${tc.id}\t[tier=${tc.tier}]\t[${tc.features.join(',')}]\t${tc.title}\n`,
        );
      }
      process.stdout.write(`\nTotal: ${selected.length} test(s)\n`);
    }
    process.exit(0);
  }

  if (selected.length === 0) {
    if (opts.json) {
      const emptyReport: E2ESummaryReport = {
        total: 0,
        passed: 0,
        failed: 0,
        durationMs: 0,
        results: [],
      };
      process.stdout.write(`${JSON.stringify(emptyReport, null, 2)}\n`);
    } else {
      process.stdout.write(
        'No E2E test suites matched (tier/smoke modules not yet present or filtered out).\n',
      );
    }
    process.exit(0);
  }

  const ok = await runTests(selected, opts.json);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(
    `E2E runner fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
