import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSubprocess, terminateChildProcess } from '../lib/env-harness';
import type { AcceptanceTestCase } from '../lib/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  label: string,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const val = await probe();
      if (val !== null && val !== undefined && val !== false) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? ` (lastErr=${String(lastErr)})` : ''}`,
  );
}

export const tests: AcceptanceTestCase[] = [
  {
    id: 'T3-01',
    name: 'Zoom (Ctrl+=) + Dual Mirror interaction + browser_screenshot layoutAudit',
    tier: 3,
    area: 'A3',
    requirement: 'R2 + R3 (F2 × F4)',
    milestone: 'M2',
    tags: ['pairwise', 'zoom', 'dual', 'screenshot'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/spa/home`, {
          mode: 'dual',
          session: 'shared',
        });
        const tabId = opened.tab!.id;
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/home' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.dispatchKey({ key: '=', code: 'Equal', keyCode: 187, ctrl: true });
        await sleep(150);

        await session.ctl.interact({
          tabId,
          viewport: 'landscape',
          action: 'click',
          selector: '#nav-dashboard',
          mirror: true,
        });

        await waitUntil(async () => {
          const p = await session.ctl.evalJs('location.pathname', 'portrait', tabId);
          return p.value === '/spa/dashboard' ? true : false;
        }, 4_000, 'mirrored click after zoom');

        const shot = await session.ctl.screenshot(tabId, 'both');
        assert.ok(shot.captures.portrait && shot.captures.portrait.bytes > 0);
        assert.ok(shot.captures.landscape && shot.captures.landscape.bytes > 0);
        assert.ok(shot.captures.landscape.width > shot.captures.portrait.width);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T3-02',
    name: 'MCP browser_storage respects Shared vs Isolated dual-viewport partition contract',
    tier: 3,
    area: 'A4',
    requirement: 'R2 + R3 (F2 × F5)',
    milestone: 'M2',
    tags: ['pairwise', 'storage', 'shared', 'isolated'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const sharedOpen = JSON.parse(
            (await mcp.callTool('browser_open', {
              url: `${ctx.servers.httpBaseUrl}/echo`,
              mode: 'dual',
              session: 'shared',
            })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(sharedOpen.tab.id, { expectedUrlIncludes: '/echo' });

          await mcp.callTool('browser_storage', {
            tab_id: sharedOpen.tab.id,
            viewport: 'landscape',
            action: 'set',
            scope: 'localStorage',
            key: 'shared_k',
            value: 'shared_v',
          });
          const sharedPortrait = await mcp.callTool('browser_storage', {
            tab_id: sharedOpen.tab.id,
            viewport: 'portrait',
            action: 'get',
            scope: 'localStorage',
            key: 'shared_k',
          });
          assert.ok((sharedPortrait.content[0]?.text ?? '').includes('shared_v'));

          const isoOpen = JSON.parse(
            (await mcp.callTool('browser_open', {
              url: `${ctx.servers.httpBaseUrl}/echo`,
              mode: 'dual',
              session: 'isolated',
            })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(isoOpen.tab.id, { expectedUrlIncludes: '/echo' });

          await mcp.callTool('browser_storage', {
            tab_id: isoOpen.tab.id,
            viewport: 'landscape',
            action: 'set',
            scope: 'localStorage',
            key: 'iso_only_k',
            value: 'iso_secret_val',
          });
          const isoPortrait = await mcp.callTool('browser_storage', {
            tab_id: isoOpen.tab.id,
            viewport: 'portrait',
            action: 'get',
            scope: 'localStorage',
            key: 'iso_only_k',
          });
          assert.equal(
            (isoPortrait.content[0]?.text ?? '').includes('iso_secret_val'),
            false,
            'Isolated landscape storage must not leak into portrait partition',
          );
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T3-03',
    name: 'browser_reload + browser_wait_for recover flaky 500-then-200 endpoint cleanly',
    tier: 3,
    area: 'A4',
    requirement: 'R3 (F4 × F5)',
    milestone: 'M2',
    tags: ['pairwise', 'reload', 'wait_for', 'flaky'],
    run: async (ctx) => {
      ctx.servers.resetFlaky('t303');
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const opened = JSON.parse(
            (await mcp.callTool('browser_open', {
              url: `${ctx.servers.httpBaseUrl}/flaky?key=t303&fail_until=1`,
              mode: 'single',
            })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/flaky' });

          const reloadRes = await mcp.callTool('browser_reload', {
            tab_id: opened.tab.id,
            ignore_cache: true,
          });
          assert.notEqual(reloadRes.isError, true);

          const waitRes = await mcp.callTool('browser_wait_for', {
            tab_id: opened.tab.id,
            viewport: 'landscape',
            selector: '#recovered-ok',
            timeout_ms: 4_000,
          });
          assert.notEqual(waitRes.isError, true);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T3-04',
    name: 'Agent Dock PTY inherits IRON_BROWSER_SOCKET and executes iron-browser doctor --json cleanly',
    tier: 3,
    area: 'A2',
    requirement: 'Follow-up + R3 (F3 × F5)',
    milestone: 'M1',
    tags: ['pairwise', 'agent-dock', 'pty', 'mcp-socket'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const outJson = path.join(env.rootDir, 'dock-doctor.json');
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate('document.querySelector(\'.chip-btn[data-preset="shell"]\')?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')).length > 0 &&
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')) !== 'Idle'
              ? true
              : false,
          4_000,
          'shell active',
        );

        const launcher = path.join(ctx.repoRoot, 'bin', 'iron-browser');
        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = ${JSON.stringify(`${launcher} doctor --json > ${outJson}`)};
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const parsed = await waitUntil(async () => {
          if (!fs.existsSync(outJson)) return false;
          const raw = fs.readFileSync(outJson, 'utf8').trim();
          if (!raw.endsWith('}')) return false;
          return JSON.parse(raw) as { ok?: boolean; socketReachable?: boolean; socketPath?: string };
        }, 6_000, 'dock PTY doctor --json output');

        assert.equal(parsed.ok, true);
        assert.equal(parsed.socketReachable, true);
        assert.equal(parsed.socketPath, session.socketPath);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T3-05',
    name: 'Dual-mode Adapter Matrix: sterile no-personal-tools vs adapter-present across Agent Dock & sidebar-ctl.sh',
    tier: 3,
    area: 'A5',
    requirement: 'R4 (F7 × F8)',
    milestone: 'M3',
    tags: ['pairwise', 'matrix', 'sterile', 'adapter-present'],
    run: async (ctx) => {
      // Mode A: sterile no-personal-tools
      const sterile = ctx.createEnv('no-personal-tools');
      const sbA = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open'],
        { env: sterile.env, cleanup: ctx.cleanup },
      );
      assert.equal(sbA.exitCode, 0, `Sterile sidebar-ctl open failed: ${sbA.stderr}`);

      const sA = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: sterile });
      try {
        const shellA = await sA.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellA.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockA = await sA.connectCdp((t) => t.url.endsWith('/agent-dock.html'));
        const stA = await dockA.evaluate<{ session: { active: boolean } }>('window.ironAgent.startCli({ preset: "shell" })');
        assert.equal(stA.session.active, true);
      } finally {
        await sA.close();
      }

      // Mode B: adapter-present (mock tmux)
      const present = ctx.createEnv('adapter-present');
      present.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
case "\${1:-}" in
  list-panes)
    if [[ "$*" == *"-a"* ]]; then printf 'work:0.0\\tagent\\tcodex\\t%s\\t5555\\n' "$PWD";
    elif [[ "$*" == *"pane_current_command"* ]]; then printf '%%20\\tcodex\\n';
    elif [[ "$*" == *"pane_title"* ]]; then printf '%%20\\tmain\\n';
    else printf '%%20\\n'; fi
    ;;
  display-message) printf '160\\n' ;;
  split-window) printf '%%21\\n' ;;
  *) exit 0 ;;
esac
`,
      );
      const sbB = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open'],
        { env: { ...present.env, TMUX: '/tmp/mock-tmux,1,0', TMUX_PANE: '%20' }, cleanup: ctx.cleanup },
      );
      assert.equal(sbB.exitCode, 0, sbB.stderr);

      const sB = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: present });
      try {
        const shellB = await sB.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellB.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockB = await sB.connectCdp((t) => t.url.endsWith('/agent-dock.html'));
        const instances = await dockB.evaluate<Array<{ target: string }>>('window.ironAgent.listInstances()');
        assert.ok(instances.some((i) => i.target === 'work:0.0'));
      } finally {
        await sB.close();
      }
    },
  },
  {
    id: 'T3-06',
    name: 'iron-browser Agent Dock optionally discovers live iron-agentd session and degrades cleanly when stopped',
    tier: 3,
    area: 'A5',
    requirement: 'R4 (F7 × F9)',
    milestone: 'M3',
    tags: ['pairwise', 'iron-term', 'agent-dock', 'discovery'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const itSockDir = path.join(env.runtimeDir!, 'iron-term');
      fs.mkdirSync(itSockDir, { recursive: true, mode: 0o700 });
      const itSock = path.join(itSockDir, 'agentd.sock');
      const daemon = await ctx.ironTerm.startAgentd({
        socketPath: itSock,
        dbPath: path.join(env.rootDir, 'it-disc.db'),
        env: env.env,
      });

      const spawned = await ctx.ironTerm.runCtlJson<{ session: { id: string } }>(
        ['spawn', '--title', 'e2e-iron-term-agent', '--', '/bin/sh', '-c', 'sleep 15'],
        { socketPath: itSock, env: env.env },
      );
      assert.ok(spawned.session.id);

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        const instances = await dockCdp.evaluate<Array<Record<string, unknown>>>(
          'window.ironAgent.listInstances()',
        );
        assert.ok(
          JSON.stringify(instances).includes('e2e-iron-term-agent') ||
            JSON.stringify(instances).includes(spawned.session.id),
          `Expected iron-agentd session discovered in Agent Dock listInstances: ${JSON.stringify(instances)}`,
        );

        await daemon.close();
        const afterStop = await dockCdp.evaluate<Array<Record<string, unknown>>>(
          'window.ironAgent.listInstances()',
        );
        assert.equal(Array.isArray(afterStop), true);
      } finally {
        await daemon.close();
        await session.close();
      }
    },
  },
  {
    id: 'T3-07',
    name: 'iron-term CLI flags (--working-directory, --title, -e) spawn session on unified XDG_RUNTIME_DIR socket',
    tier: 3,
    area: 'A7',
    requirement: 'R4 (F9)',
    milestone: 'M4',
    tags: ['pairwise', 'iron-term', 'cli', 'unified-socket'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const workDir = path.join(env.rootDir, 'proj');
      fs.mkdirSync(workDir, { recursive: true });
      const marker = path.join(env.rootDir, 'cwd-check.txt');

      const daemonBin = ctx.ironTerm.resolveBinary('iron-agentd');
      const termBin = ctx.ironTerm.resolveBinary('iron-term');
      assert.ok(daemonBin && termBin);

      const xdgSockDir = path.join(env.runtimeDir!, 'iron-term');
      const xdgSock = path.join(xdgSockDir, 'agentd.sock');
      const daemonProc = spawn(daemonBin, ['--db', path.join(env.rootDir, 'unified.db')], {
        env: env.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ctx.cleanup.trackProcess(daemonProc, 'iron-agentd-t307');

      try {
        await waitUntil(async () => (fs.existsSync(xdgSock) ? true : false), 5_000, 'agentd unified sock');

        const gui = spawn(
          termBin,
          [
            '--working-directory',
            workDir,
            '--title',
            'PairwiseTerm',
            '-e',
            '/bin/sh',
            '-c',
            `pwd > ${marker}; sleep 3`,
          ],
          { env: env.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        ctx.cleanup.trackProcess(gui, 'iron-term-t307');

        try {
          const pwdOut = await waitUntil(async () => {
            if (!fs.existsSync(marker)) return false;
            return fs.readFileSync(marker, 'utf8').trim();
          }, 6_000, 'iron-term cwd marker');
          assert.equal(pwdOut, workDir);

          const status = await ctx.ironTerm.runCtlJson<{
            sessions: Array<{ title?: string; worktree_path?: string }>;
          }>(['status'], { env: env.env });
          assert.ok(
            status.sessions.some((s) => s.title === 'PairwiseTerm' && s.worktree_path === workDir),
            `Expected PairwiseTerm with worktree_path='${workDir}' in status: ${JSON.stringify(status)}`,
          );
        } finally {
          await terminateChildProcess(gui);
          ctx.cleanup.untrackProcess(gui);
        }
      } finally {
        await terminateChildProcess(daemonProc);
        ctx.cleanup.untrackProcess(daemonProc);
      }
    },
  },
  {
    id: 'T3-08',
    name: 'install-desktop.sh portable XDG install + desktop-file-validate + Exec launcher execution',
    tier: 3,
    area: 'A7',
    requirement: 'R5 (F10)',
    milestone: 'M4',
    tags: ['pairwise', 'desktop-entry', 'installer', 'exec'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const inst = await ctx.ironTerm.runInstallDesktop({ env });
      assert.equal(inst.exitCode, 0, inst.stderr);

      const desktopPath = path.join(env.dataHome, 'applications', 'iron-term.desktop');
      const val = await ctx.ironTerm.validateDesktopFile(desktopPath, { env: env.env });
      assert.equal(val.exitCode, 0, `${val.stdout} ${val.stderr}`);

      const content = fs.readFileSync(desktopPath, 'utf8');
      const execCmd = content.match(/^Exec=(.+)$/m)?.[1]?.trim() ?? '';
      const execBin = execCmd.match(/^"([^"]+)"/)?.[1] ?? execCmd.split(/\s+/)[0] ?? '';
      assert.ok(execBin.length > 0);

      const daemon = await ctx.ironTerm.startAgentd({ env: env.env });
      const marker = path.join(env.rootDir, 'desktop-exec-ok.txt');
      const resolvedExec = path.isAbsolute(execBin) ? execBin : env.which(execBin);
      assert.ok(resolvedExec, `Desktop Exec binary '${execBin}' not resolvable in isolated PATH`);
      assert.equal(resolvedExec, path.join(env.xdgBinHome, 'iron-term'));

      const gui = spawn(
        resolvedExec,
        ['--socket', daemon.socketPath, '-e', '/bin/sh', '-c', `echo DESKTOP_OK > ${marker}; sleep 2`],
        { env: env.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ctx.cleanup.trackProcess(gui, 'iron-term-desktop-exec');
      try {
        const txt = await waitUntil(async () => {
          if (!fs.existsSync(marker)) return false;
          return fs.readFileSync(marker, 'utf8').trim();
        }, 6_000, 'desktop Exec launch marker');
        assert.equal(txt, 'DESKTOP_OK');
      } finally {
        await terminateChildProcess(gui);
        ctx.cleanup.untrackProcess(gui);
        await daemon.close();
      }
    },
  },
];
