import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CtlRpcError } from '../lib/ctl-client';
import { runSubprocess, terminateChildProcess } from '../lib/env-harness';
import { McpJsonRpcError } from '../lib/mcp-harness';
import type { AcceptanceTestCase, PersistedSessionFixture } from '../lib/types';

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
  // =========================================================================
  // A1: Baseline, Rendering & Inspection Boundaries
  // =========================================================================
  {
    id: 'T2-A1-01',
    name: 'Corrupt session-state.json and offscreen bounds do not crash Electron startup',
    tier: 2,
    area: 'A1',
    requirement: 'R1 / F1',
    milestone: 'HEAD',
    tags: ['session', 'corrupt', 'bounds'],
    run: async (ctx) => {
      const s1 = await ctx.launchElectron({
        smoke: true,
        seedSession: '{not valid json!!!',
      });
      try {
        const pong = await s1.ctl.ping();
        assert.equal(pong.pong, true);
      } finally {
        await s1.close();
      }

      const offscreenSeed: PersistedSessionFixture = {
        version: 1,
        savedAt: Date.now(),
        window: { x: -99999, y: -99999, width: 1200, height: 800 },
        railCollapsed: false,
        dockOpen: false,
        dockHeight: 280,
        splitRatio: 0.35,
        theme: 'dark',
        activeTabIndex: 0,
        tabs: [],
        history: [],
      };
      const s2 = await ctx.launchElectron({ smoke: true, seedSession: offscreenSeed });
      try {
        const tabs = await s2.ctl.tabs();
        assert.ok(tabs.tabs.length >= 1);
      } finally {
        await s2.close();
      }
    },
  },
  {
    id: 'T2-A1-02',
    name: 'Reject unsafe symlinked ctl.sock / overlong sun_path (>= 107 bytes)',
    tier: 2,
    area: 'A1',
    requirement: 'R1 / F1',
    milestone: 'HEAD',
    tags: ['security', 'socket', 'symlink', 'sun_path'],
    run: async (ctx) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec-'));
      ctx.cleanup.trackDir(dir);
      const target = path.join(dir, 'real.sock');
      fs.writeFileSync(target, '');
      const symlinkSock = path.join(dir, 'sym.sock');
      fs.symlinkSync(target, symlinkSock);

      const doc = await ctx.runDoctor({ socketPath: symlinkSock, json: true });
      assert.equal(doc.json?.socketReachable, false);

      const longDir = path.join(dir, 'a'.repeat(110));
      fs.mkdirSync(longDir, { recursive: true });
      await assert.rejects(
        () => ctx.launchElectron({ smoke: true, sessionDir: longDir }),
        /sun_path limit/i,
      );
    },
  },
  {
    id: 'T2-A1-03',
    name: 'browser_eval enforces max_bytes truncation and invalid browser_interact returns RPC error',
    tier: 2,
    area: 'A1',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['eval', 'max_bytes', 'rpc-error'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'single' });
        const tabId = opened.tab!.id;
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/echo' });

        const evalRes = await session.ctl.evalJs('"X".repeat(12000)', 'landscape', tabId, 256);
        assert.equal(evalRes.truncated, true);
        assert.equal(evalRes.maxBytes, 256);
        assert.ok(Buffer.byteLength(evalRes.value, 'utf8') <= 256);
        assert.ok(evalRes.originalBytes >= 12000);

        await assert.rejects(
          () =>
            session.ctl.request('browser_interact', {
              tab_id: tabId,
              action: 'explode',
            }),
          (err: unknown) => err instanceof CtlRpcError,
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A1-04',
    name: 'bin/iron-browser mcp fails cleanly (exit 1) when IRON_BROWSER_MCP_BIN is invalid',
    tier: 2,
    area: 'A1',
    requirement: 'R1 / F1',
    milestone: 'HEAD',
    tags: ['cli', 'launcher', 'error'],
    run: async (ctx) => {
      const res = await runSubprocess(
        path.join(ctx.repoRoot, 'bin', 'iron-browser'),
        ['mcp', '--version'],
        {
          env: {
            ...process.env,
            IRON_BROWSER_MCP_BIN: '/nonexistent/path/to/iron-browser-mcp',
          },
          cleanup: ctx.cleanup,
        },
      );
      assert.notEqual(res.exitCode, 0);
    },
  },
  {
    id: 'T2-A1-05',
    name: 'browser_events with since_seq beyond latestSeq or unknown tab_id returns empty array cleanly',
    tier: 2,
    area: 'A1',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['events', 'boundary'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const res = await session.ctl.events({
          tabId: 'tab-does-not-exist-999',
          sinceSeq: 9_999_999,
          limit: 50,
        });
        assert.equal(res.count, 0);
        assert.deepEqual(res.events, []);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A2: Agent Chat Dock Boundaries
  // =========================================================================
  {
    id: 'T2-A2-01',
    name: 'writeInput handles leading-hyphen prompt (-n --help -rf) without flag error in PTY and tmux',
    tier: 2,
    area: 'A2',
    requirement: 'Follow-up / F3',
    milestone: 'M1',
    tags: ['writeInput', 'hyphen', 'tmux', 'pty'],
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present');
      const tmuxLog = path.join(env.rootDir, 'tmux-hyphen.log');
      env.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}
case "\${1:-}" in
  list-panes) printf 't:0.0\\tcli\\tclaude\\t%s\\t7777\\n' "$PWD" ;;
  capture-pane) printf 'ready\\n' ;;
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

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("btn-refresh-instances")?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<number>('document.querySelectorAll("#instance-list button, #instance-list .instance-item").length')) > 0
              ? true
              : false,
          4_000,
          'tmux item',
        );
        await dockCdp.evaluate('document.querySelector("#instance-list button, #instance-list .instance-item")?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')).includes('t:0.0')
              ? true
              : false,
          4_000,
          'tmux attached',
        );

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.value = '-n --help -rf';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const content = await waitUntil(async () => {
          if (!fs.existsSync(tmuxLog)) return false;
          const s = fs.readFileSync(tmuxLog, 'utf8');
          return s.includes('C-m') ? s : false;
        }, 4_000, 'tmux C-m logged');
        assert.match(content, /send-keys -t t:0\.0 -l -- -n --help -rf/);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A2-02',
    name: 'writeInput preserves multi-line prompt and submits cleanly in PTY',
    tier: 2,
    area: 'A2',
    requirement: 'Follow-up / F3',
    milestone: 'M1',
    tags: ['writeInput', 'multiline', 'pty'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const outPath = path.join(env.rootDir, 'multiline.txt');
      const pyScript = path.join(env.rootDir, 'ml.py');
      fs.writeFileSync(
        pyScript,
        `import sys, time
sys.stdout.write("ML_READY\\n")
sys.stdout.flush()
lines = []
for _ in range(2):
    lines.append(sys.stdin.readline().strip())
with open(${JSON.stringify(outPath)}, "w") as f:
    f.write("\\n".join(lines))
sys.stdout.write("ML_DONE\\n")
sys.stdout.flush()
time.sleep(0.5)
`,
      );

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate(`(() => {
          const inp = document.getElementById('input-custom-cli');
          inp.value = 'python3 ' + ${JSON.stringify(pyScript)};
          document.querySelector('#custom-cli-form .run-btn').click();
        })()`);

        await waitUntil(
          async () => {
            await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
            return (await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""')).includes('ML_READY')
              ? true
              : false;
          },
          5_000,
          'ML_READY',
        );

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = 'alpha-line\\nbeta-line';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const saved = await waitUntil(async () => {
          if (!fs.existsSync(outPath)) return false;
          const v = fs.readFileSync(outPath, 'utf8');
          return v.includes('beta-line') ? v : false;
        }, 5_000, 'multiline saved');
        assert.ok(saved.includes('alpha-line'));
        assert.ok(saved.includes('beta-line'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A2-03',
    name: 'writeInput rejects >256KB payload without crashing PTY or hanging Agent Dock',
    tier: 2,
    area: 'A2',
    requirement: 'Follow-up / F3, F6',
    milestone: 'M1',
    tags: ['writeInput', 'oversized', 'boundary'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate('document.querySelector(\'.chip-btn[data-preset="shell"]\')?.click()');
        await waitUntil(
          async () =>
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')).includes('bash') ||
            (await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""')).includes('sh')
              ? true
              : false,
          4_000,
          'shell active',
        );

        const writeResult = await dockCdp.evaluate<boolean>(
          `window.ironAgent ? window.ironAgent.write("A".repeat(270 * 1024), true) : false`,
        );
        assert.equal(writeResult, false, 'Oversized >256KB payload must return false');

        // Confirm PTY still alive after rejecting oversized payload.
        const smallOk = await dockCdp.evaluate<boolean>(
          `window.ironAgent ? window.ironAgent.write("echo STILL_ALIVE", true) : false`,
        );
        assert.equal(smallOk, true);
        await waitUntil(
          async () => {
            await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
            return (await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""')).includes('STILL_ALIVE')
              ? true
              : false;
          },
          4_000,
          'PTY still responsive',
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A2-04',
    name: 'Whitespace-only submit is ignored and failed submit preserves composer input',
    tier: 2,
    area: 'A2',
    requirement: 'R3 / F6',
    milestone: 'M2',
    tags: ['agent-dock', 'empty-input', 'non-destructive'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("btn-disconnect")?.click()');
        await sleep(100);

        // Whitespace-only must return false and not submit.
        const wsWrite = await dockCdp.evaluate<boolean>(
          `window.ironAgent ? window.ironAgent.write("", false) : true`,
        );
        assert.equal(wsWrite, false);

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.value = '   keep-whitespace-or-draft';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
        await sleep(150);
        const retained = await dockCdp.evaluate<string>('document.getElementById("chat-input")?.value ?? ""');
        assert.equal(retained, '   keep-whitespace-or-draft');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A2-05',
    name: 'Agent Dock rejects empty or >512-char custom command and handles invalid cwd safely',
    tier: 2,
    area: 'A2',
    requirement: 'R3 / F6',
    milestone: 'HEAD',
    tags: ['agent-dock', 'validation', 'cwd'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        const tooLongErr = await dockCdp.evaluate<string>(`(async () => {
          try {
            await window.ironAgent.startCli({ preset: 'custom', customCommand: 'x'.repeat(600), cwd: '/nonexistent/dir/xyz' });
            return 'NO_ERROR';
          } catch (e) {
            return String(e);
          }
        })()`);
        assert.ok(tooLongErr.includes('512') || tooLongErr !== 'NO_ERROR', `Expected error for >512 cmd, got ${tooLongErr}`);

        // Valid short command with non-existent cwd falls back cleanly.
        const okState = await dockCdp.evaluate<{ session: { active: boolean } }>(`(async () => {
          return await window.ironAgent.startCli({ preset: 'custom', customCommand: 'echo CWD_FALLBACK_OK && sleep 1', cwd: '/nonexistent/dir/xyz' });
        })()`);
        assert.equal(okState.session.active, true);
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A3: URL Normalization & Browser Controls Boundaries
  // =========================================================================
  {
    id: 'T2-A3-01',
    name: 'Disallowed URL schemes (javascript:, data:, file:, chrome:) are rejected cleanly',
    tier: 2,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'HEAD',
    tags: ['url', 'security', 'scheme'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        for (const bad of [
          'javascript:alert(1)',
          'data:text/html,<h1>xss</h1>',
          'file:///etc/passwd',
          'chrome://settings',
          'devtools://devtools/bundled/inspector.html',
        ]) {
          await assert.rejects(
            () => session.ctl.open(bad),
            (err: unknown) => err instanceof CtlRpcError,
            `Expected rejection for disallowed scheme ${bad}`,
          );
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A3-02',
    name: 'IPv4, dotless host:port, and IPv6 [::1]:port normalize to http:// instead of https:// or search',
    tier: 2,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['url', 'ipv4', 'host-port'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const port = new URL(ctx.servers.httpBaseUrl).port;
        const cases: Array<[string, string]> = [
          [`127.0.0.1:${port}/echo`, `http://127.0.0.1:${port}/echo`],
          ['192.168.1.50:3000/api', 'http://192.168.1.50:3000/api'],
          ['10.0.0.5', 'http://10.0.0.5/'],
          ['mydevbox:8080/health', 'http://mydevbox:8080/health'],
          ['[::1]:8080/test', 'http://[::1]:8080/test'],
        ];
        for (const [input, expectedPrefix] of cases) {
          const res = await session.ctl.open(input, { mode: 'single' });
          assert.ok(
            res.tab?.url.startsWith(expectedPrefix),
            `Input '${input}' normalized to '${res.tab?.url}', expected prefix '${expectedPrefix}'`,
          );
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A3-03',
    name: 'Subframe did-fail-load does NOT trigger main-frame error Retry banner',
    tier: 2,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['did-fail-load', 'subframe', 'error-banner'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/subframe-fail`, { mode: 'single' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/subframe-fail' });
        await sleep(300);

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        const hasVisibleRetry = await shellCdp.evaluate<boolean>(`(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.some(b => /retry/i.test(b.textContent || '') && b.offsetParent !== null);
        })()`);
        assert.equal(hasVisibleRetry, false, 'Subframe failure must not show main-frame Retry banner');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A3-04',
    name: 'Find-in-Page handles zero-match query (0/0) and empty query cleanly',
    tier: 2,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['find-in-page', 'zero-match', 'boundary'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/find`, { mode: 'single' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/find' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.dispatchKey({ key: 'f', code: 'KeyF', ctrl: true });
        await waitUntil(
          async () =>
            await shellCdp.evaluate<boolean>(
              'Boolean(document.querySelector("#find-input, input[aria-label*=\\"Find\\" i], input[placeholder*=\\"Find\\" i]"))',
            ),
          4_000,
          'find bar visible',
        );

        await shellCdp.evaluate(`(() => {
          const inp = document.querySelector('#find-input, input[aria-label*="Find" i], input[placeholder*="Find" i]');
          inp.value = 'zzz-nonexistent-needle-999';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);

        const zeroMatches = await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const bar = document.querySelector('#find-bar, .find-bar, [data-testid="find-bar"]') || document.body;
            return /\\b0\\s*\\/\\s*0\\b/.test(bar.textContent || '');
          })()`);
        }, 4_000, '0/0 match display');
        assert.equal(zeroMatches, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A3-05',
    name: 'Per-page Zoom clamps at extreme repeat zoom-in/zoom-out and resets cleanly',
    tier: 2,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['zoom', 'clamp', 'boundary'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/find`, { mode: 'single' });
        const tabId = opened.tab!.id;
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/find' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        for (let i = 0; i < 15; i += 1) {
          await shellCdp.dispatchKey({ key: '=', code: 'Equal', keyCode: 187, ctrl: true });
        }
        await sleep(150);
        const maxDpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
        assert.ok(Number.isFinite(maxDpr) && maxDpr <= 5.5 && maxDpr > 1.0, `Unexpected max zoom DPR=${maxDpr}`);

        for (let i = 0; i < 30; i += 1) {
          await shellCdp.dispatchKey({ key: '-', code: 'Minus', keyCode: 189, ctrl: true });
        }
        await sleep(150);
        const minDpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
        assert.ok(Number.isFinite(minDpr) && minDpr >= 0.2 && minDpr < 1.0, `Unexpected min zoom DPR=${minDpr}`);

        await shellCdp.dispatchKey({ key: '0', code: 'Digit0', keyCode: 48, ctrl: true });
        await waitUntil(async () => {
          const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
          return Math.abs(dpr - 1.0) < 0.05 ? true : false;
        }, 4_000, 'zoom reset to 1.0');
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A4: MCP Sidecar & ctl.sock Protocol Boundaries
  // =========================================================================
  {
    id: 'T2-A4-01',
    name: 'iron-browser-mcp --max-bytes 256 truncates large output strictly <= 256 UTF-8 bytes',
    tier: 2,
    area: 'A4',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['mcp', 'max-bytes', 'truncation'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'single' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/echo' });

        const mcp = await ctx.launchMcp({ socketPath: session.socketPath, maxBytes: 256 });
        try {
          const res = await mcp.callTool('browser_eval', {
            tab_id: opened.tab!.id,
            viewport: 'landscape',
            expression: '"Z".repeat(10000)',
          });
          const text = res.content[0]?.text ?? '';
          assert.ok(Buffer.byteLength(text, 'utf8') <= 256, `Expected <=256 bytes, got ${Buffer.byteLength(text, 'utf8')}`);
          const parsed = JSON.parse(text) as { truncated?: boolean; maxBytes?: number };
          assert.equal(parsed.truncated, true);
          assert.equal(parsed.maxBytes, 256);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A4-02',
    name: 'iron-browser-mcp rejects pre-init tools/call (-32002), cursor pagination, and >512KiB line (-32600)',
    tier: 2,
    area: 'A4',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['mcp', 'protocol', 'error-codes'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath, autoInitialize: false });
        try {
          await mcp.initialize('2025-06-18');
          // Omit notifications/initialized -> tools/call must fail with -32002
          await assert.rejects(
            () => mcp.callTool('browser_tabs', {}),
            (err: unknown) => err instanceof McpJsonRpcError && err.code === -32002,
          );

          mcp.sendInitialized();
          await assert.rejects(
            () => mcp.listTools({ cursor: 'bogus-cursor' }),
            (err: unknown) => err instanceof McpJsonRpcError && err.code === -32602,
          );

          // Oversized line (> 512 KiB)
          const hugePayload = JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            method: 'ping',
            params: { pad: 'A'.repeat(540 * 1024) },
          });
          mcp.sendRawLine(hugePayload);
          const exit = await mcp.waitForExit(4_000);
          assert.equal(exit.code !== undefined, true);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A4-03',
    name: 'MCP browser_wait_for fails with bounded timeout error on missing selector',
    tier: 2,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'wait_for', 'timeout'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const opened = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/home`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };
          await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/spa/home' });

          const t0 = Date.now();
          const res = await mcp.callTool('browser_wait_for', {
            tab_id: opened.tab.id,
            viewport: 'landscape',
            selector: '#definitely-never-exists-404',
            timeout_ms: 400,
          });
          const elapsed = Date.now() - t0;
          assert.equal(res.isError, true, 'Missing selector wait must return isError=true');
          assert.ok(elapsed < 4_000, `Timeout took too long: ${elapsed}ms`);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A4-04',
    name: 'MCP browser_close_tab on last tab keeps fallback tab; browser_select_tab rejects unknown ID',
    tier: 2,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'close_tab', 'select_tab', 'boundary'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const initial = JSON.parse((await mcp.callTool('browser_tabs', {})).content[0]!.text!) as { tabs: Array<{ id: string }> };
          for (const t of initial.tabs) {
            await mcp.callTool('browser_close_tab', { tab_id: t.id });
          }
          const after = JSON.parse((await mcp.callTool('browser_tabs', {})).content[0]!.text!) as { tabs: Array<{ id: string }> };
          assert.ok(after.tabs.length >= 1, 'Closing last tab must keep/open a fallback tab');

          const badSel = await mcp.callTool('browser_select_tab', { tab_id: 'nonexistent-tab-xyz' });
          assert.equal(badSel.isError, true);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A4-05',
    name: 'MCP browser_navigate_history at history edge & invalid browser_storage scope return structured errors',
    tier: 2,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'history', 'storage', 'error'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const opened = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/echo`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };
          await session.ctl.waitForTabReady(opened.tab.id, { expectedUrlIncludes: '/echo' });

          const backRes = await mcp.callTool('browser_navigate_history', {
            tab_id: opened.tab.id,
            direction: 'back',
          });
          // Either structured isError or ok:false without crashing
          const pingAfter = await session.ctl.ping();
          assert.equal(pingAfter.pong, true);
          assert.ok(
            backRes.isError === true || (backRes.content[0]?.text ?? '').includes('false'),
            `Expected structured edge result for canGoBack=false, got ${JSON.stringify(backRes)}`,
          );

          const badStorage = await mcp.callTool('browser_storage', {
            tab_id: opened.tab.id,
            action: 'get',
            scope: 'indexeddb_invalid',
          });
          assert.equal(badStorage.isError, true);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A5: iron-browser Decoupling Boundaries
  // =========================================================================
  {
    id: 'T2-A5-01',
    name: 'Agent Dock shell preset falls back to /bin/sh when SHELL is empty in no-personal-tools env',
    tier: 2,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['decoupling', 'shell-fallback', 'boundary'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', { envOverrides: { SHELL: '' } });
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        const state = await dockCdp.evaluate<{ session: { active: boolean; label: string } }>(
          'window.ironAgent.startCli({ preset: "shell" })',
        );
        assert.equal(state.session.active, true);
        assert.equal(
          state.session.label,
          'sh',
          `Expected /bin/sh fallback (label 'sh') when SHELL is empty, got '${state.session.label}'`,
        );

        const marker = path.join(env.rootDir, 'sh-fallback.txt');
        await dockCdp.evaluate(
          `window.ironAgent.write(${JSON.stringify(`printf '%s' "$0" > ${marker}`)}, true)`,
        );
        const shellArg0 = await waitUntil(
          async () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : false),
          4_000,
          '/bin/sh $0 probe',
        );
        assert.ok(
          shellArg0.endsWith('sh') && !shellArg0.endsWith('bash'),
          `Expected POSIX sh ($0 ending in sh, not bash), got '${shellArg0}'`,
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A5-02',
    name: 'Missing XDG_RUNTIME_DIR in no-personal-tools env resolves socket cleanly under /tmp/iron-browser-{uid}',
    tier: 2,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'HEAD',
    tags: ['xdg', 'socket', 'fallback'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', { unsetXdgRuntimeDir: true });
      const uid = process.getuid?.() ?? 1000;
      const doc = await ctx.runDoctor({
        env: env.env,
        json: true,
      });
      const expected = `/tmp/iron-browser-${uid}/ctl.sock`;
      assert.equal(doc.json?.socketPath, expected);
    },
  },
  {
    id: 'T2-A5-03',
    name: 'Corrupt or nonexistent IRON_BROWSER_AGENT_CLIS entries do not break Agent Dock launcher',
    tier: 2,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['agent-dock', 'env', 'resilience'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', {
        envOverrides: { IRON_BROWSER_AGENT_CLIS: ' , ;;nonexistent-cli-999, custom-cli-ok, shell , ' },
      });
      env.writeMockExecutable('custom-cli-ok', 'echo MOCK_CUSTOM_OK; sleep 1');
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));
        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');

        const paneCheck = await dockCdp.evaluate<{
          hasValidCustom: boolean;
          hasNonexistent: boolean;
          hasShellBtn: boolean;
        }>(`(() => {
          const pane = document.getElementById('pane-start');
          if (!pane) return { hasValidCustom: false, hasNonexistent: false, hasShellBtn: false };
          const text = (pane.textContent || '').toLowerCase();
          const chips = Array.from(pane.querySelectorAll('.chip-btn, button')).map((el) =>
            ((el.getAttribute('data-preset') || '') + ' ' + (el.textContent || '')).toLowerCase(),
          );
          const shellBtn = pane.querySelector('.chip-btn[data-preset="shell"]');
          return {
            hasValidCustom: text.includes('custom-cli-ok') || chips.some((c) => c.includes('custom-cli-ok')),
            hasNonexistent: chips.some((c) => c.includes('nonexistent-cli-999')),
            hasShellBtn: Boolean(shellBtn && !shellBtn.hasAttribute('disabled')),
          };
        })()`);
        assert.equal(
          paneCheck.hasValidCustom,
          true,
          'Expected IRON_BROWSER_AGENT_CLIS valid entry custom-cli-ok rendered in #pane-start',
        );
        assert.equal(
          paneCheck.hasNonexistent,
          false,
          'Invalid/missing nonexistent-cli-999 must not appear in #pane-start',
        );
        assert.equal(paneCheck.hasShellBtn, true, 'Portable shell fallback chip must remain enabled');

        const state = await dockCdp.evaluate<{ session: { active: boolean } }>(
          'window.ironAgent.startCli({ preset: "shell" })',
        );
        assert.equal(state.session.active, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A5-04',
    name: 'Agent Dock rejects invalid tmux attach target and handles missing tmux cleanly',
    tier: 2,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['agent-dock', 'tmux', 'error'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        const instances = await dockCdp.evaluate<unknown[]>('window.ironAgent.listInstances()');
        assert.equal(Array.isArray(instances), true);

        const errMsg = await dockCdp.evaluate<string>(`(async () => {
          try {
            await window.ironAgent.attachInstance('; rm -rf /');
            return 'NO_ERR';
          } catch (e) {
            return String(e);
          }
        })()`);
        assert.notEqual(errMsg, 'NO_ERR');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T2-A5-05',
    name: 'Electron smoke launches with WAYLAND_DISPLAY unset (X11-only) and DISPLAY unset (Wayland-only or headless)',
    tier: 2,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['ozone', 'x11', 'wayland', 'display'],
    run: async (ctx) => {
      if (process.env.DISPLAY) {
        const x11Env = ctx.createEnv('no-personal-tools', { envOverrides: { WAYLAND_DISPLAY: null } });
        const sX11 = await ctx.launchElectron({ smoke: true, isolatedEnv: x11Env, ozoneMode: 'x11' });
        try {
          assert.equal((await sX11.ctl.ping()).pong, true);
        } finally {
          await sX11.close();
        }
      }
      const headlessEnv = ctx.createEnv('no-personal-tools', {
        envOverrides: { DISPLAY: null, WAYLAND_DISPLAY: null },
      });
      const sHeadless = await ctx.launchElectron({
        smoke: true,
        isolatedEnv: headlessEnv,
        ozoneMode: 'headless',
      });
      try {
        assert.equal((await sHeadless.ctl.ping()).pong, true);
      } finally {
        await sHeadless.close();
      }
    },
  },

  // =========================================================================
  // A6: teamwork Hooks Boundaries
  // =========================================================================
  {
    id: 'T2-A6-01',
    name: 'sidebar-ctl.sh rejects unknown subcommand with exit 2 and usage stderr',
    tier: 2,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['sidebar-ctl', 'cli', 'error'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const res = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'nonexistent-cmd'],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(res.exitCode, 2);
      assert.ok(res.stderr.includes('usage:'));
    },
  },
  {
    id: 'T2-A6-02',
    name: 'sidebar-ctl.sh open refuses narrow tmux pane (<76 cols) with exit 1 and actionable message',
    tier: 2,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['sidebar-ctl', 'tmux', 'narrow-pane'],
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present');
      env.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
case "\${1:-}" in
  list-panes) printf '%%5\\tagy\\n' ;;
  display-message) printf '60\\n' ;;
  *) exit 0 ;;
esac
`,
      );
      const res = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open'],
        {
          env: { ...env.env, TMUX: '/tmp/tmux-mock/default,1,0', TMUX_PANE: '%5' },
          cleanup: ctx.cleanup,
        },
      );
      assert.equal(res.exitCode, 1);
      assert.ok(res.stderr.includes('narrow'));
    },
  },
  {
    id: 'T2-A6-03',
    name: 'All Python hook scripts fail-open ({} + exit 0) on malformed JSON and empty stdin',
    tier: 2,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['hooks', 'malformed-json', 'fail-open'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      for (const script of ['task-title-hook.py', 'flow-hook.py', 'todo-hook.py']) {
        for (const badInput of ['{corrupt json', '']) {
          const res = await runSubprocess('python3', [path.join(ctx.hooksDir, script)], {
            env: env.env,
            stdinData: badInput,
            cleanup: ctx.cleanup,
          });
          assert.equal(res.exitCode, 0, `${script} crashed on '${badInput}': ${res.stderr}`);
          assert.equal(res.stdout.trim(), '{}');
        }
      }
    },
  },
  {
    id: 'T2-A6-04',
    name: 'sidebar-ctl.sh handles stale TMUX env var when tmux binary is missing without crashing',
    tier: 2,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'M3',
    tags: ['sidebar-ctl', 'stale-tmux', 'fallback'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const res = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open', '--width', '999'],
        {
          env: { ...env.env, TMUX: '/tmp/dead-tmux-sock,1,0', TMUX_PANE: '%1' },
          cleanup: ctx.cleanup,
        },
      );
      assert.equal(res.exitCode, 0, `Expected graceful fallback exit 0, got ${res.exitCode}: ${res.stderr}`);
    },
  },
  {
    id: 'T2-A6-05',
    name: 'task-title-hook.py sanitizes special chars, quotes, and >20-char titles to kebab-case <=20 chars',
    tier: 2,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['task-title', 'sanitization', 'boundary'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const sid = 'conv-sanitize-1';
      const setRes = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'task-title-hook.py'), 'set', 'Very Long "Title" / With Special Chars! 12345', sid],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(setRes.exitCode, 0);
      const getRes = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'task-title-hook.py'), 'get', sid],
        { env: env.env, cleanup: ctx.cleanup },
      );
      const slug = getRes.stdout.trim();
      assert.ok(slug.length > 0 && slug.length <= 20, `Slug length out of range: '${slug}'`);
      assert.match(slug, /^[a-z0-9-]+$/);
    },
  },

  // =========================================================================
  // A7: iron-term & Packaging Boundaries
  // =========================================================================
  {
    id: 'T2-A7-01',
    name: 'iron-agentd refuses symlinked socket dir or symlinked socket path',
    tier: 2,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'HEAD',
    tags: ['iron-term', 'security', 'symlink'],
    run: async (ctx) => {
      const daemonBin = ctx.ironTerm.resolveBinary('iron-agentd');
      assert.ok(daemonBin);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-sym-'));
      ctx.cleanup.trackDir(dir);
      const realSub = path.join(dir, 'real');
      fs.mkdirSync(realSub, { mode: 0o700 });
      const symSub = path.join(dir, 'sym');
      fs.symlinkSync(realSub, symSub);

      const res = await runSubprocess(
        daemonBin,
        ['--socket', path.join(symSub, 'agentd.sock'), '--db', path.join(dir, 'db.sqlite')],
        { timeoutMs: 4_000, cleanup: ctx.cleanup },
      );
      assert.notEqual(res.exitCode, 0, 'iron-agentd must reject symlinked socket parent directory');
    },
  },
  {
    id: 'T2-A7-02',
    name: 'iron-term -e /bin/sh -c passes --title flag literally to child instead of iron-term option parser',
    tier: 2,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'HEAD',
    tags: ['iron-term', 'cli', 'hyphen-args'],
    run: async (ctx) => {
      const daemon = await ctx.ironTerm.startAgentd();
      const termBin = ctx.ironTerm.resolveBinary('iron-term');
      assert.ok(termBin);
      const marker = path.join(path.dirname(daemon.socketPath), 'hyphen-arg.txt');
      const gui = spawn(
        termBin,
        ['--socket', daemon.socketPath, '-e', '/bin/sh', '-c', `printf '%s' '--title' > ${marker}; sleep 2`],
        { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ctx.cleanup.trackProcess(gui, 'iron-term-hyphen');
      try {
        const val = await waitUntil(async () => {
          if (!fs.existsSync(marker)) return false;
          return fs.readFileSync(marker, 'utf8');
        }, 6_000, 'iron-term -e marker with --title');
        assert.equal(val, '--title');
      } finally {
        await terminateChildProcess(gui);
        ctx.cleanup.untrackProcess(gui);
        await daemon.close();
      }
    },
  },
  {
    id: 'T2-A7-03',
    name: 'iron-term with nonexistent IRON_TERM_FONT and empty IRON_TERM_HOSTS falls back cleanly',
    tier: 2,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'M4',
    tags: ['iron-term', 'font-fallback', 'hosts'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', {
        envOverrides: {
          IRON_TERM_FONT: 'NonExistentMonospaceFont_XYZ_999',
          IRON_TERM_HOSTS: '',
        },
      });
      const daemon = await ctx.ironTerm.startAgentd({ env: env.env });
      const termBin = ctx.ironTerm.resolveBinary('iron-term');
      assert.ok(termBin);
      const marker = path.join(env.rootDir, 'font-ok.txt');
      const gui = spawn(
        termBin,
        ['--socket', daemon.socketPath, '-e', '/bin/sh', '-c', `echo FONT_FALLBACK_OK > ${marker}; sleep 2`],
        { env: env.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ctx.cleanup.trackProcess(gui, 'iron-term-font');
      try {
        const ok = await waitUntil(async () => {
          if (!fs.existsSync(marker)) return false;
          return fs.readFileSync(marker, 'utf8').trim();
        }, 6_000, 'iron-term font fallback launch');
        assert.equal(ok, 'FONT_FALLBACK_OK');

        const status = await ctx.ironTerm.runCtlJson<{ hosts: unknown[] }>(['status'], {
          socketPath: daemon.socketPath,
          env: env.env,
        });
        assert.equal(status.hosts.length, 1, `Empty IRON_TERM_HOSTS must yield only local host: ${JSON.stringify(status.hosts)}`);
      } finally {
        await terminateChildProcess(gui);
        ctx.cleanup.untrackProcess(gui);
        await daemon.close();
      }
    },
  },
  {
    id: 'T2-A7-04',
    name: 'iron-termctl returns non-zero and structured error for invalid session, mode, or move host',
    tier: 2,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'HEAD',
    tags: ['iron-termctl', 'error-handling'],
    run: async (ctx) => {
      const daemon = await ctx.ironTerm.startAgentd();
      try {
        const r1 = await ctx.ironTerm.runCtl(['hibernate', 'no-such-session'], {
          socketPath: daemon.socketPath,
          json: true,
        });
        assert.notEqual(r1.exitCode, 0);
        const r1Json = JSON.parse(r1.stdout) as { type?: string; code?: string };
        assert.equal(r1Json.type, 'error');
        assert.equal(r1Json.code, 'NOT_FOUND');
        assert.ok(r1.stderr.includes('NOT_FOUND'), r1.stderr);

        const rMove = await ctx.ironTerm.runCtl(['move', 'no-such-session', '--host', 'foo'], {
          socketPath: daemon.socketPath,
          json: true,
        });
        assert.notEqual(rMove.exitCode, 0);
        const rMoveJson = JSON.parse(rMove.stdout) as { type?: string; code?: string };
        assert.equal(rMoveJson.type, 'error');
        assert.equal(rMoveJson.code, 'NOT_FOUND');

        const rHost = await ctx.ironTerm.runCtl(['host-mode', 'nonexistent-host', 'free'], {
          socketPath: daemon.socketPath,
          json: true,
        });
        assert.notEqual(rHost.exitCode, 0);
        const rHostJson = JSON.parse(rHost.stdout) as { type?: string; code?: string };
        assert.equal(rHostJson.type, 'error');
        assert.equal(rHostJson.code, 'HOST_NOT_FOUND');

        // Client-side mode validation fails before RPC with empty stdout and diagnostic stderr.
        const r2 = await ctx.ironTerm.runCtl(['host-mode', 'local', 'bogus-mode'], {
          socketPath: daemon.socketPath,
          json: true,
        });
        assert.notEqual(r2.exitCode, 0);
        assert.equal(r2.stdout.trim(), '');
        assert.ok(r2.stderr.includes("invalid host mode 'bogus-mode'"), r2.stderr);
      } finally {
        await daemon.close();
      }
    },
  },
  {
    id: 'T2-A7-05',
    name: 'iron-term install-desktop.sh is idempotent on re-run and fails on unwritable XDG_DATA_HOME',
    tier: 2,
    area: 'A7',
    requirement: 'R5 / F10',
    milestone: 'M4',
    tags: ['iron-term', 'installer', 'idempotent', 'permissions'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const r1 = await ctx.ironTerm.runInstallDesktop({ env });
      assert.equal(r1.exitCode, 0, r1.stderr);
      const r2 = await ctx.ironTerm.runInstallDesktop({ env });
      assert.equal(r2.exitCode, 0, r2.stderr);

      const roDir = path.join(env.rootDir, 'ro-data');
      fs.mkdirSync(roDir, { mode: 0o500 });
      try {
        const rFail = await ctx.ironTerm.runInstallDesktop({
          env,
          extraEnv: { XDG_DATA_HOME: path.join(roDir, 'nested') },
        });
        assert.notEqual(rFail.exitCode, 0);
      } finally {
        fs.chmodSync(roDir, 0o700);
      }
    },
  },
];
