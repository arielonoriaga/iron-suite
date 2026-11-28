import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchAcceptanceElectron } from './lib/electron-harness';
import {
  createAcceptCleanupRegistry,
  createIsolatedEnv,
} from './lib/env-harness';
import { createIronTermHarness } from './lib/iron-term-harness';
import { launchMcpClient, runMcpDoctor } from './lib/mcp-harness';
import { createAcceptanceServerCluster } from './lib/test-servers';
import type {
  AcceptanceContext,
  AcceptanceMilestone,
  AcceptanceRunResult,
  AcceptanceSummaryReport,
  AcceptanceTestCase,
  AcceptanceTier,
} from './lib/types';

const ACCEPTANCE_ROOT = import.meta.dir;
const APP_ROOT = path.resolve(ACCEPTANCE_ROOT, '../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const IRON_TERM_ROOT = process.env.IRON_TERM_ROOT ?? '/home/ariel/Projects/iron-term';
const HOOKS_DIR =
  process.env.AGY_HOOKS_DIR ??
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'hooks');

const TIER_FILES: ReadonlyArray<{ tier: AcceptanceTier; relPath: string }> = [
  { tier: 1, relPath: 'tiers/tier1-functional.ts' },
  { tier: 2, relPath: 'tiers/tier2-boundaries.ts' },
  { tier: 3, relPath: 'tiers/tier3-pairwise.ts' },
  { tier: 4, relPath: 'tiers/tier4-scenarios.ts' },
];

interface CliOptions {
  help: boolean;
  list: boolean;
  selfCheck: boolean;
  json: boolean;
  tier: AcceptanceTier | 'all';
  milestone: AcceptanceMilestone | 'all';
  filter: string | null;
}

interface SelfCheckStep {
  name: string;
  passed: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

function parseTier(raw: string): AcceptanceTier | 'all' {
  switch (raw) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    case 'all':
      return 'all';
    default:
      throw new Error(`Invalid --tier '${raw}'. Expected 1|2|3|4|all.`);
  }
}

function parseMilestone(raw: string): AcceptanceMilestone | 'all' {
  switch (raw) {
    case 'HEAD':
    case 'M1':
    case 'M2':
    case 'M3':
    case 'M4':
    case 'all':
      return raw;
    default:
      throw new Error(`Invalid --milestone '${raw}'. Expected HEAD|M1|M2|M3|M4|all.`);
  }
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    list: false,
    selfCheck: false,
    json: false,
    tier: 'all',
    milestone: 'all',
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
      opts.tier = parseTier(arg.slice('--tier='.length));
    } else if (arg === '--tier') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --tier');
      opts.tier = parseTier(next);
      i += 1;
    } else if (arg.startsWith('--milestone=')) {
      opts.milestone = parseMilestone(arg.slice('--milestone='.length));
    } else if (arg === '--milestone') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --milestone');
      opts.milestone = parseMilestone(next);
      i += 1;
    } else if (arg.startsWith('--filter=')) {
      opts.filter = arg.slice('--filter='.length);
    } else if (arg === '--filter') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Missing value for --filter');
      opts.filter = next;
      i += 1;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`Iron Stack Opaque-Box E2E Acceptance Runner

Usage:
  bun run test/e2e/acceptance/runner.ts [options]

Options:
  --self-check                       Validate 5 infrastructure harnesses without running full suite
  --list                             List registered acceptance tests (with tier & milestone counts)
  --tier=<1|2|3|4|all>               Filter by tier (default: all)
  --milestone=<HEAD|M1|M2|M3|M4|all> Filter by target milestone (default: all)
  --filter=<substr>                  Substring filter over id, name, area, requirement, tags
  --json                             Emit JSON report on stdout
  -h, --help                         Show this help message`);
}

function isTestCaseArray(val: unknown): val is AcceptanceTestCase[] {
  if (!Array.isArray(val)) return false;
  return val.every(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as AcceptanceTestCase).id === 'string' &&
      typeof (item as AcceptanceTestCase).run === 'function',
  );
}

async function loadAllAcceptanceTests(): Promise<AcceptanceTestCase[]> {
  const loaded: AcceptanceTestCase[] = [];
  for (const spec of TIER_FILES) {
    const absPath = path.join(ACCEPTANCE_ROOT, spec.relPath);
    if (!fs.existsSync(absPath)) continue;
    const mod = (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
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
  tests: AcceptanceTestCase[],
  tier: AcceptanceTier | 'all',
  milestone: AcceptanceMilestone | 'all',
  filter: string | null,
): AcceptanceTestCase[] {
  const needle = filter?.trim().toLowerCase() ?? '';
  return tests.filter((tc) => {
    if (tier !== 'all' && tc.tier !== tier) return false;
    if (milestone !== 'all' && tc.milestone !== milestone) return false;
    if (!needle) return true;
    const hay = [
      tc.id,
      String(tc.tier),
      tc.area,
      tc.requirement,
      tc.milestone,
      tc.name,
      ...tc.tags,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
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

function buildContext(
  servers: ReturnType<typeof createAcceptanceServerCluster>,
  cleanup: ReturnType<typeof createAcceptCleanupRegistry>,
  tmpRoot: string,
): AcceptanceContext {
  const ironTerm = createIronTermHarness(IRON_TERM_ROOT, cleanup);
  return {
    servers,
    launchElectron: (opts = {}) => launchAcceptanceElectron(opts, cleanup),
    createEnv: (profile, opts = {}) => createIsolatedEnv(profile, opts, cleanup),
    launchMcp: (opts = {}) => launchMcpClient(opts, cleanup),
    runDoctor: (opts = {}) => runMcpDoctor(opts, cleanup),
    ironTerm,
    cleanup,
    tmpRoot,
    appRoot: APP_ROOT,
    repoRoot: REPO_ROOT,
    ironTermRoot: IRON_TERM_ROOT,
    hooksDir: HOOKS_DIR,
  };
}

async function runSelfCheck(
  jsonOutput: boolean,
  cleanup: ReturnType<typeof createAcceptCleanupRegistry>,
): Promise<boolean> {
  const steps: SelfCheckStep[] = [];
  const servers = createAcceptanceServerCluster();

  const runStep = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
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

  let sharedSession: Awaited<ReturnType<typeof launchAcceptanceElectron>> | null = null;

  try {
    await servers.start();

    await runStep('acceptance-test-servers', async () => {
      const spaRes = await fetch(`${servers.httpBaseUrl}/spa/dashboard`);
      assert.equal(spaRes.status, 200);
      assert.ok((await spaRes.text()).includes('Acceptance SPA'));

      const flaky1 = await fetch(`${servers.httpBaseUrl}/flaky?key=sc`);
      assert.equal(flaky1.status, 500);
      const flaky2 = await fetch(`${servers.httpBaseUrl}/flaky?key=sc`);
      assert.equal(flaky2.status, 200);

      const dlRes = await fetch(`${servers.httpBaseUrl}/download/sample.csv`);
      assert.equal(dlRes.status, 200);
      assert.ok((dlRes.headers.get('content-disposition') ?? '').includes('sample.csv'));

      return `http=${servers.httpBaseUrl} alt=${servers.altOriginBaseUrl}`;
    });

    await runStep('isolated-env-harness', async () => {
      const sterile = createIsolatedEnv('no-personal-tools', {}, cleanup);
      assert.equal(sterile.which('tmux'), null);
      assert.equal(sterile.which('alacritty'), null);
      assert.equal(sterile.which('hyprctl'), null);
      assert.equal(sterile.which('agy'), null);
      assert.ok(sterile.which('bash'));
      assert.ok(sterile.which('python3'));
      assert.ok(Buffer.byteLength(path.join(sterile.rootDir, 'rt', 'iron-term', 'agentd.sock'), 'utf8') < 107);
      assert.equal(sterile.env.TMUX, undefined);

      const withAdapters = createIsolatedEnv(
        'adapter-present',
        { extraBins: { 'mock-agent': 'echo mock-ok' } },
        cleanup,
      );
      assert.ok(withAdapters.which('mock-agent'));
      sterile.dispose();
      withAdapters.dispose();
      return 'no-personal-tools & adapter-present verified';
    });

    await runStep('electron-smoke-and-cdp', async () => {
      sharedSession = await launchAcceptanceElectron(
        { smoke: true, enableCdp: true },
        cleanup,
      );
      const pong = await sharedSession.ctl.ping();
      assert.equal(pong.pong, true);
      const opened = await sharedSession.ctl.open(`${servers.httpBaseUrl}/spa/home`, {
        mode: 'dual',
        session: 'shared',
      });
      const tabId = opened.tab?.id;
      assert.ok(tabId);
      await sharedSession.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/home' });
      const evalRes = await sharedSession.ctl.evalJs('document.getElementById("spa-route")?.textContent', 'landscape', tabId);
      assert.equal(evalRes.value, '/spa/home');
      const targets = await sharedSession.listCdpTargets();
      assert.ok(targets.some((t) => t.url.endsWith('/index.html')));
      return `sock=${sharedSession.socketPath} cdpPort=${sharedSession.cdpPort}`;
    });

    await runStep('mcp-sidecar-stdio-and-doctor', async () => {
      assert.ok(sharedSession, 'Electron session required for MCP self-check');
      const mcp = await launchMcpClient(
        { socketPath: sharedSession.socketPath },
        cleanup,
      );
      try {
        const listed = await mcp.listTools();
        assert.ok(listed.tools.length >= 20, `expected >=20 tools, got ${listed.tools.length}`);
        const tabsCall = await mcp.callTool('browser_tabs', {});
        assert.notEqual(tabsCall.isError, true);
      } finally {
        await mcp.close();
      }
      const doc = await runMcpDoctor({ socketPath: sharedSession.socketPath, json: true }, cleanup);
      assert.equal(doc.exitCode, 0);
      assert.equal(doc.json?.socketReachable, true);
      return `mcpTools>=20 doctorOk=${String(doc.json?.ok)}`;
    });

    await runStep('iron-term-harness-and-desktop-validate', async () => {
      const ironTerm = createIronTermHarness(IRON_TERM_ROOT, cleanup);
      const daemon = await ironTerm.startAgentd();
      try {
        const ping = await ironTerm.runCtlJson<{ ok?: boolean; pong?: boolean; status?: string }>(
          ['ping'],
          { socketPath: daemon.socketPath },
        );
        assert.ok(ping, 'expected JSON ping response from iron-termctl');
      } finally {
        await daemon.close();
      }
      const browserDesktop = path.join(REPO_ROOT, 'packaging', 'iron-browser.desktop');
      const val = await ironTerm.validateDesktopFile(browserDesktop);
      assert.equal(val.exitCode, 0, `desktop-file-validate failed: ${val.stdout} ${val.stderr}`);
      return 'iron-agentd + iron-termctl + desktop-file-validate ok';
    });
  } finally {
    if (sharedSession) {
      await (sharedSession as Awaited<ReturnType<typeof launchAcceptanceElectron>>).close().catch(() => {});
    }
    await servers.stop();
  }

  const allPassed = steps.every((s) => s.passed);
  if (jsonOutput) {
    console.log(JSON.stringify({ selfCheck: true, passed: allPassed, steps }, null, 2));
  } else {
    console.log('\nAcceptance Infrastructure Self-Check:');
    for (const s of steps) {
      const badge = s.passed ? 'PASS' : 'FAIL';
      const extra = s.passed ? (s.detail ?? '') : (s.error ?? 'unknown error');
      console.log(`  [${badge}] ${s.name} (${s.durationMs}ms)${extra ? ` — ${extra}` : ''}`);
    }
    console.log(`\nSelf-check ${allPassed ? 'PASSED' : 'FAILED'} (${steps.filter((s) => s.passed).length}/${steps.length} checks).`);
  }
  return allPassed;
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const cleanup = createAcceptCleanupRegistry();
  const handleTermination = (sig: string) => {
    process.stderr.write(`\nReceived ${sig}; cleaning up acceptance child processes and temp dirs...\n`);
    void cleanup.cleanupAll().finally(() => {
      process.exit(130);
    });
  };
  process.once('SIGINT', () => handleTermination('SIGINT'));
  process.once('SIGTERM', () => handleTermination('SIGTERM'));

  try {
    if (opts.selfCheck) {
      const ok = await runSelfCheck(opts.json, cleanup);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    const allTests = await loadAllAcceptanceTests();
    const selected = filterTests(allTests, opts.tier, opts.milestone, opts.filter);

    if (opts.list) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            selected.map((t) => ({
              id: t.id,
              tier: t.tier,
              area: t.area,
              milestone: t.milestone,
              requirement: t.requirement,
              name: t.name,
              tags: t.tags,
            })),
            null,
            2,
          ),
        );
        return;
      }

      const byTier = new Map<AcceptanceTier, number>();
      const byMilestone = new Map<AcceptanceMilestone, number>();
      const byArea = new Map<string, number>();
      for (const tc of selected) {
        byTier.set(tc.tier, (byTier.get(tc.tier) ?? 0) + 1);
        byMilestone.set(tc.milestone, (byMilestone.get(tc.milestone) ?? 0) + 1);
        byArea.set(tc.area, (byArea.get(tc.area) ?? 0) + 1);
        console.log(
          `${tc.id.padEnd(10)} tier=${tc.tier} area=${tc.area} [${tc.milestone.padEnd(4)}] ${tc.name} (${tc.requirement})`,
        );
      }
      console.log(`\nTotal: ${selected.length} test(s)`);
      console.log(
        `By Tier: T1=${byTier.get(1) ?? 0} T2=${byTier.get(2) ?? 0} T3=${byTier.get(3) ?? 0} T4=${byTier.get(4) ?? 0}`,
      );
      console.log(
        `By Milestone: HEAD=${byMilestone.get('HEAD') ?? 0} M1=${byMilestone.get('M1') ?? 0} M2=${byMilestone.get('M2') ?? 0} M3=${byMilestone.get('M3') ?? 0} M4=${byMilestone.get('M4') ?? 0}`,
      );
      console.log(
        `By Area: ${(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const).map((a) => `${a}=${byArea.get(a) ?? 0}`).join(' ')}`,
      );
      return;
    }

    if (selected.length === 0) {
      throw new Error('No acceptance tests matched the given --tier / --milestone / --filter criteria.');
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-acc-run-'));
    cleanup.trackDir(tmpRoot);
    const servers = createAcceptanceServerCluster();
    const suiteStarted = Date.now();
    const results: AcceptanceRunResult[] = [];

    try {
      await servers.start();
      const ctx = buildContext(servers, cleanup, tmpRoot);

      for (const tc of selected) {
        const timeoutMs = tc.timeoutMs ?? 60_000;
        const started = Date.now();
        if (!opts.json) {
          process.stdout.write(`RUN  ${tc.id} [${tc.milestone}] ${tc.name} ... `);
        }
        try {
          await runWithTimeout(() => tc.run(ctx), timeoutMs, tc.id);
          const durationMs = Date.now() - started;
          results.push({
            id: tc.id,
            name: tc.name,
            tier: tc.tier,
            area: tc.area,
            requirement: tc.requirement,
            milestone: tc.milestone,
            passed: true,
            durationMs,
          });
          if (!opts.json) {
            process.stdout.write(`PASS (${durationMs}ms)\n`);
          }
        } catch (err) {
          const durationMs = Date.now() - started;
          const message = err instanceof Error ? err.stack || err.message : String(err);
          results.push({
            id: tc.id,
            name: tc.name,
            tier: tc.tier,
            area: tc.area,
            requirement: tc.requirement,
            milestone: tc.milestone,
            passed: false,
            durationMs,
            error: message,
          });
          if (!opts.json) {
            process.stdout.write(`FAIL (${durationMs}ms)\n  ${message.split('\n')[0]}\n`);
          }
        }
      }
    } finally {
      await servers.stop();
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const report: AcceptanceSummaryReport = {
      total: results.length,
      passed,
      failed,
      durationMs: Date.now() - suiteStarted,
      results,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\nAcceptance Summary: ${passed}/${report.total} passed, ${failed} failed (${report.durationMs}ms).`);
      if (failed > 0) {
        console.log('\nFailures:');
        for (const r of results.filter((x) => !x.passed)) {
          console.log(`- ${r.id} [${r.milestone}] (${r.name}): ${r.error}`);
        }
      }
    }

    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await cleanup.cleanupAll();
  }
}

main().catch((err) => {
  console.error('Acceptance runner fatal error:', err);
  process.exit(1);
});
