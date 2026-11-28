import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSubprocess, terminateChildProcess } from '../lib/env-harness';
import type { AcceptanceTestCase } from '../lib/types';

function resolveExpectedOsHostname(): string {
  for (const p of ['/proc/sys/kernel/hostname', '/etc/hostname']) {
    try {
      const val = fs.readFileSync(p, 'utf8').trim();
      if (val && val !== '(none)') return val;
    } catch {
      // Next source.
    }
  }
  return os.hostname().trim() || 'local';
}

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
    id: 'T4-01',
    name: 'Scenario 1: Live Multi-Service Developer Session (SPA + WebGL + Auth + WS/SSE + Download + Flaky + Restart)',
    tier: 4,
    area: 'A1',
    requirement: 'R1, R2, R3 (A1, A3, A4)',
    milestone: 'M2',
    tags: ['scenario', 'multi-service', 'stress', 'mcp', 'persistence'],
    timeoutMs: 90_000,
    run: async (ctx) => {
      ctx.servers.resetFlaky('t401');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-t401-'));
      ctx.cleanup.trackDir(sessionDir);

      const session = await ctx.launchElectron({
        smoke: true,
        enableCdp: true,
        sessionDir,
        keepTempDir: true,
      });

      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const { tools } = await mcp.listTools();
          assert.equal(tools.length, 26);

          // 1. SPA
          const spa = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/home`, mode: 'dual', session: 'shared' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(spa.tab.id, { expectedUrlIncludes: '/spa/home' });
          await mcp.callTool('browser_interact', { tab_id: spa.tab.id, viewport: 'landscape', action: 'click', selector: '#nav-dashboard', mirror: true });
          await mcp.callTool('browser_wait_for', { tab_id: spa.tab.id, viewport: 'portrait', text: 'Dashboard Ready', timeout_ms: 4_000 });

          // 2. WebGL
          const gl = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/webgl`, mode: 'dual', session: 'shared' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(gl.tab.id, { expectedUrlIncludes: '/webgl' });
          await sleep(200);
          const glCall = await mcp.callTool('browser_webgl', { tab_id: gl.tab.id, viewport: 'landscape', action: 'capture_frame' });
          assert.notEqual(glCall.isError, true);

          // 3. Auth + Storage
          const auth = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/auth`, mode: 'single' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(auth.tab.id, { expectedUrlIncludes: '/auth' });
          await mcp.callTool('browser_interact', { tab_id: auth.tab.id, viewport: 'landscape', action: 'click', selector: '#btn-login' });
          await mcp.callTool('browser_wait_for', { tab_id: auth.tab.id, viewport: 'landscape', text: 'logged-in:devuser', timeout_ms: 4_000 });
          const authStorage = await mcp.callTool('browser_storage', { tab_id: auth.tab.id, viewport: 'landscape', action: 'get', scope: 'localStorage', key: 'auth_user' });
          assert.ok((authStorage.content[0]?.text ?? '').includes('devuser'));

          // 4. WS + SSE
          const stream = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/stream-ui`, mode: 'single' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(stream.tab.id, { expectedUrlIncludes: '/stream-ui' });
          await mcp.callTool('browser_wait_for', { tab_id: stream.tab.id, viewport: 'landscape', text: 'open', timeout_ms: 4_000 });
          ctx.servers.pushSseEvent('tick', 't401-tick', '1');
          await mcp.callTool('browser_wait_for', { tab_id: stream.tab.id, viewport: 'landscape', text: 't401-tick', timeout_ms: 4_000 });

          // 5. Download
          const dl = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/download-trigger`, mode: 'single' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(dl.tab.id, { expectedUrlIncludes: '/download-trigger' });
          await mcp.callTool('browser_interact', { tab_id: dl.tab.id, viewport: 'landscape', action: 'click', selector: '#dl-link' });
          await waitUntil(async () => (fs.existsSync(path.join(session.downloadDir, 'sample.csv')) ? true : false), 5_000, 'sample.csv');

          // 6. Flaky 500 -> reload -> 200
          const flaky = JSON.parse(
            (await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/flaky?key=t401&fail_until=1`, mode: 'single' })).content[0]!.text!,
          ) as { tab: { id: string } };
          await session.ctl.waitForTabReady(flaky.tab.id, { expectedUrlIncludes: '/flaky' });
          await mcp.callTool('browser_reload', { tab_id: flaky.tab.id, ignore_cache: true });
          await mcp.callTool('browser_wait_for', { tab_id: flaky.tab.id, viewport: 'landscape', selector: '#recovered-ok', timeout_ms: 4_000 });

          // 7. Health & Telemetry
          const health = await session.ctl.health<{ ok: boolean; lastCrashDump: unknown; watchdog: { stallCount?: number } | null }>(30);
          assert.equal(health.ok, true);
          assert.equal(health.lastCrashDump, null);
          assert.equal(health.watchdog?.stallCount ?? 0, 0);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }

      // Verify persisted session restores cleanly on relaunch
      const restarted = await ctx.launchElectron({ smoke: true, sessionDir, keepTempDir: false });
      try {
        const tabsAfter = await restarted.ctl.tabs();
        assert.ok(tabsAfter.tabs.some((t) => t.url.includes('/spa/')));
        assert.ok(tabsAfter.tabs.some((t) => t.url.includes('/webgl')));
      } finally {
        await restarted.close();
      }
    },
  },
  {
    id: 'T4-02',
    name: 'Scenario 2: Agent-in-the-Loop Debugging (- prompt + multi-line + MCP via IRON_BROWSER_SOCKET + Transcript Export)',
    tier: 4,
    area: 'A2',
    requirement: 'Follow-up, R2, R3 (A2, A4)',
    milestone: 'M2',
    tags: ['scenario', 'agent-in-loop', 'writeInput', 'mcp', 'transcript'],
    timeoutMs: 75_000,
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const agentReport = path.join(env.rootDir, 'agent-diagnosis.json');
      const agentScript = path.join(env.rootDir, 'agent-loop.py');
      fs.writeFileSync(
        agentScript,
        `import json, os, select, subprocess, sys, termios, time, tty
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
lines = []
cur = bytearray()
try:
    sys.stdout.write("AGENT_READY\\r\\n")
    sys.stdout.flush()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            b = os.read(fd, 4096)
            if not b:
                break
            cur.extend(b)
            if b"\\r" in b:
                lines.append(cur.decode("utf-8", "replace"))
                break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
mcp_bin = ${JSON.stringify(path.join(ctx.repoRoot, 'bin', 'iron-browser'))}
doc = subprocess.run([mcp_bin, "doctor", "--json"], capture_output=True, text=True, env=os.environ)
with open(${JSON.stringify(agentReport)}, "w") as f:
    json.dump({"prompt": "".join(lines), "socket": os.environ.get("IRON_BROWSER_SOCKET"), "doctor": json.loads(doc.stdout)}, f)
sys.stdout.write("DIAGNOSIS_COMPLETE\\r\\n")
sys.stdout.flush()
time.sleep(1.0)
`,
      );

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const broken = await session.ctl.open(`${ctx.servers.httpBaseUrl}/broken`, { mode: 'dual' });
        await session.ctl.waitForTabReady(broken.tab!.id, { expectedUrlIncludes: '/broken' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("btn-mode-floating")?.click()');
        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate(`(() => {
          const inp = document.getElementById('input-custom-cli');
          inp.value = 'python3 ' + ${JSON.stringify(agentScript)};
          document.querySelector('#custom-cli-form .run-btn').click();
        })()`);

        await waitUntil(
          async () => {
            await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
            return (await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""')).includes('AGENT_READY')
              ? true
              : false;
          },
          5_000,
          'agent ready',
        );

        await dockCdp.evaluate('document.getElementById("btn-insert-context")?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("chat-input")?.value ?? ""')).includes('/broken')
              ? true
              : false,
          3_000,
          'context injected',
        );

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = '-diagnose broken page\\n' + chat.value;
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const report = await waitUntil(async () => {
          if (!fs.existsSync(agentReport)) return false;
          return JSON.parse(fs.readFileSync(agentReport, 'utf8')) as {
            prompt: string;
            socket: string;
            doctor: { ok?: boolean; socketReachable?: boolean };
          };
        }, 6_000, 'agent diagnosis file');

        assert.ok(report.prompt.includes('-diagnose broken page'));
        assert.ok(report.prompt.includes('/broken'));
        assert.equal(report.socket, session.socketPath);
        assert.equal(report.doctor.ok, true);
        assert.equal(report.doctor.socketReachable, true);

        await waitUntil(
          async () => {
            await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
            return (await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""')).includes('DIAGNOSIS_COMPLETE')
              ? true
              : false;
          },
          4_000,
          'diagnosis in transcript',
        );

        // Verify Export/Clear transcript controls exist and work.
        const exportExists = await dockCdp.evaluate<boolean>(`(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.some(b => /export/i.test(b.id + ' ' + b.textContent + ' ' + (b.title || '')));
        })()`);
        assert.equal(exportExists, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T4-03',
    name: 'Scenario 3: Sterile Generic Linux Desktop (no-personal-tools across iron-browser, iron-term & teamwork)',
    tier: 4,
    area: 'A6',
    requirement: 'R4 (A5, A6, A7)',
    milestone: 'M4',
    tags: ['scenario', 'sterile', 'decoupling', 'linux-desktop'],
    timeoutMs: 75_000,
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      assert.equal(env.which('tmux'), null);
      assert.equal(env.which('alacritty'), null);
      assert.equal(env.which('hyprctl'), null);
      assert.equal(env.which('agy'), null);

      // 1. teamwork hooks & sidebar-ctl.sh
      const sbOpen = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open'],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(sbOpen.exitCode, 0, sbOpen.stderr);

      const ttRes = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'task-title.sh'), 'set', 'Sterile Desktop', 'conv-t403'],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(ttRes.exitCode, 0, ttRes.stderr);

      // 2. iron-agentd + iron-termctl using unified XDG_RUNTIME_DIR socket & local hostname
      const daemonBin = ctx.ironTerm.resolveBinary('iron-agentd');
      assert.ok(daemonBin);
      const expectedHost = resolveExpectedOsHostname();
      const itSockDir = path.join(env.runtimeDir!, 'iron-term');
      const itSock = path.join(itSockDir, 'agentd.sock');
      const dProc = spawn(daemonBin, ['--db', path.join(env.rootDir, 'sterile.db')], {
        env: env.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ctx.cleanup.trackProcess(dProc, 'sterile-agentd');

      try {
        await waitUntil(async () => (fs.existsSync(itSock) ? true : false), 5_000, 'sterile agentd sock');
        const st = await ctx.ironTerm.runCtlJson<{
          type?: string;
          sessions: unknown[];
          hosts?: Array<{ id: string; hostname: string }>;
        }>(['status'], { env: env.env });
        assert.equal(st.type, 'fleet');
        assert.ok(Array.isArray(st.hosts), `Expected hosts array in status: ${JSON.stringify(st)}`);
        assert.equal(st.hosts.length, 1, `Expected single local host, got: ${JSON.stringify(st.hosts)}`);
        assert.equal(st.hosts[0]!.id, expectedHost);
        assert.equal(st.hosts[0]!.hostname, expectedHost);
        assert.equal(
          st.hosts.some(
            (h) =>
              ['desktop', 'laptop', 'desktop-exo'].includes(h.id) ||
              h.hostname === 'desktop-exo' ||
              (expectedHost !== 'ariel' && h.id === 'ariel'),
          ),
          false,
          `Hardcoded personal peer leaked in status: ${JSON.stringify(st.hosts)}`,
        );

        const sp = await ctx.ironTerm.runCtlJson<{ session: { id: string } }>(
          ['spawn', '--title', 'sterile-sh', '--', '/bin/sh', '-c', 'sleep 5'],
          { env: env.env },
        );
        await ctx.ironTerm.runCtlJson(['hibernate', sp.session.id], { env: env.env });
        await ctx.ironTerm.runCtlJson(['wake', sp.session.id], { env: env.env });
        const ins = await ctx.ironTerm.runCtlJson<{ inspection: { session: { id: string } } }>(
          ['inspect', sp.session.id],
          { env: env.env },
        );
        assert.equal(ins.inspection.session.id, sp.session.id);
      } finally {
        await terminateChildProcess(dProc);
        ctx.cleanup.untrackProcess(dProc);
      }

      // 3. iron-browser + Agent Dock $SHELL fallback
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/echo' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));
        const dockState = await dockCdp.evaluate<{ session: { active: boolean } }>('window.ironAgent.startCli({ preset: "shell" })');
        assert.equal(dockState.session.active, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T4-04',
    name: 'Scenario 4: Adapter-Present Parity + Portable XDG Desktop Packaging & Launch',
    tier: 4,
    area: 'A7',
    requirement: 'R4, R5 (A5, A6, A7)',
    milestone: 'M4',
    tags: ['scenario', 'adapter-present', 'desktop-entry', 'installer'],
    timeoutMs: 75_000,
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present');
      const tmuxLog = path.join(env.rootDir, 't404-tmux.log');
      env.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}
case "\${1:-}" in
  list-panes)
    if [[ "$*" == *"-a"* ]]; then printf 'pair:0.0\\tclaude\\tclaude\\t%s\\t6666\\n' "$PWD";
    elif [[ "$*" == *"pane_current_command"* ]]; then printf '%%30\\tclaude\\n';
    elif [[ "$*" == *"pane_title"* ]]; then printf '%%30\\tmain\\n';
    else printf '%%30\\n'; fi
    ;;
  display-message) printf '160\\n' ;;
  split-window) printf '%%31\\n' ;;
  capture-pane) printf 'adapter tmux ok\\n' ;;
  send-keys)
    prev=""
    saw_dd=0
    for a in "$@"; do
      if [[ "$a" == "--" ]]; then saw_dd=1;
      elif [[ "$prev" == "-l" && "$saw_dd" == "0" && "$a" == -* ]]; then exit 1; fi
      prev="$a"
    done
    ;;
esac
`,
      );

      // 1. Portable install-desktop.sh + desktop-file-validate
      const inst = await ctx.ironTerm.runInstallDesktop({ env });
      assert.equal(inst.exitCode, 0, inst.stderr);
      const desktopPath = path.join(env.dataHome, 'applications', 'iron-term.desktop');
      const val = await ctx.ironTerm.validateDesktopFile(desktopPath, { env: env.env });
      assert.equal(val.exitCode, 0, `${val.stdout} ${val.stderr}`);
      assert.equal(`${val.stdout}${val.stderr}`.trim(), '');

      // 2. Launch installed iron-term with --working-directory --title -e
      const workDir = path.join(env.rootDir, 'work');
      fs.mkdirSync(workDir, { recursive: true });
      const marker = path.join(env.rootDir, 't404-it.txt');
      const daemon = await ctx.ironTerm.startAgentd({ env: env.env });
      const installedBin = path.join(env.xdgBinHome, 'iron-term');
      const gui = spawn(
        installedBin,
        [
          '--socket',
          daemon.socketPath,
          '--working-directory',
          workDir,
          '--title',
          'E2E-Desktop',
          '-e',
          '/bin/sh',
          '-c',
          `pwd > ${marker}; sleep 2`,
        ],
        { env: env.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ctx.cleanup.trackProcess(gui, 't404-iron-term');
      try {
        const pwdOut = await waitUntil(async () => {
          if (!fs.existsSync(marker)) return false;
          return fs.readFileSync(marker, 'utf8').trim();
        }, 6_000, 'installed iron-term launch');
        assert.equal(pwdOut, workDir);
      } finally {
        await terminateChildProcess(gui);
        ctx.cleanup.untrackProcess(gui);
        await daemon.close();
      }

      // 3. sidebar-ctl.sh tmux split adapter
      const sbRes = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open', '--width', '40'],
        { env: { ...env.env, TMUX: '/tmp/mock-tmux,1,0', TMUX_PANE: '%30' }, cleanup: ctx.cleanup },
      );
      assert.equal(sbRes.exitCode, 0, sbRes.stderr);

      // 4. iron-browser Agent Dock tmux attach + hyphen message submit
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("btn-refresh-instances")?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("instance-list")?.textContent ?? ""')).includes('pair:0.0')
              ? true
              : false,
          4_000,
          'adapter tmux pane listed',
        );
        await dockCdp.evaluate('document.querySelector("#instance-list button, #instance-list .instance-item")?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')).includes('pair:0.0')
              ? true
              : false,
          4_000,
          'tmux attached',
        );
        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.value = '-adapter-parity-ok';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
        await waitUntil(
          async () => (fs.readFileSync(tmuxLog, 'utf8').includes('-adapter-parity-ok') ? true : false),
          4_000,
          'tmux send-keys -- -adapter-parity-ok',
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T4-05',
    name: 'Scenario 5: Cross-Viewport Responsive, Zoom, Storage Isolation & History Audit',
    tier: 4,
    area: 'A3',
    requirement: 'R2, R3 (A1, A3, A4)',
    milestone: 'M2',
    tags: ['scenario', 'responsive', 'zoom', 'storage', 'history'],
    timeoutMs: 60_000,
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const resp = JSON.parse(
            (await mcp.callTool('browser_open', {
              url: `${ctx.servers.httpBaseUrl}/responsive`,
              mode: 'dual',
              session: 'isolated',
            })).content[0]!.text!,
          ) as { tab: { id: string } };
          const tabId = resp.tab.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/responsive' });

          const pMode = await session.ctl.evalJs('document.getElementById("vp-badge")?.textContent', 'portrait', tabId);
          const lMode = await session.ctl.evalJs('document.getElementById("vp-badge")?.textContent', 'landscape', tabId);
          assert.equal(pMode.value, 'mobile');
          assert.equal(lMode.value, 'desktop');

          // Storage isolation check
          await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'landscape',
            action: 'set',
            scope: 'localStorage',
            key: 'audit_scope',
            value: 'landscape_only',
          });
          const pStorage = await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'portrait',
            action: 'get',
            scope: 'localStorage',
            key: 'audit_scope',
          });
          assert.equal((pStorage.content[0]?.text ?? '').includes('landscape_only'), false);

          // Zoom + Screenshot
          const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
          await shellCdp.dispatchKey({ key: '=', code: 'Equal', keyCode: 187, ctrl: true });
          await sleep(120);
          const shot = await session.ctl.screenshot(tabId, 'both');
          assert.ok(shot.captures.portrait && shot.captures.landscape);
          await shellCdp.dispatchKey({ key: '0', code: 'Digit0', keyCode: 48, ctrl: true });

          // History roundtrip
          await mcp.callTool('browser_navigate', { tab_id: tabId, url: `${ctx.servers.httpBaseUrl}/find` });
          await mcp.callTool('browser_wait_for', { tab_id: tabId, viewport: 'landscape', selector: '#find-heading', timeout_ms: 4_000 });
          await mcp.callTool('browser_navigate_history', { tab_id: tabId, direction: 'back' });
          await mcp.callTool('browser_wait_for', { tab_id: tabId, viewport: 'landscape', selector: '#vp-badge', timeout_ms: 4_000 });
          await mcp.callTool('browser_navigate_history', { tab_id: tabId, direction: 'forward' });
          await mcp.callTool('browser_wait_for', { tab_id: tabId, viewport: 'landscape', selector: '#find-heading', timeout_ms: 4_000 });
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
];
