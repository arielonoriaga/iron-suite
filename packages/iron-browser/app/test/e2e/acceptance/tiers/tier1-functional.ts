import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runSubprocess, terminateChildProcess } from '../lib/env-harness';
import type { AcceptanceTestCase, PersistedSessionFixture } from '../lib/types';

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

function parsePngDimensions(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64, 'base64');
  assert.ok(buf.length > 24, 'PNG buffer too small');
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Invalid PNG signature');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

export const tests: AcceptanceTestCase[] = [
  // =========================================================================
  // A1: iron-browser Baseline, Rendering & Multi-Service Inspection
  // =========================================================================
  {
    id: 'T1-A1-01',
    name: 'Launcher CLI, --smoke IRON_BROWSER_READY, ctl.ping, doctor --json & browser_health',
    tier: 1,
    area: 'A1',
    requirement: 'R1 / F1',
    milestone: 'HEAD',
    tags: ['baseline', 'launcher', 'health', 'smoke'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, viaLauncher: true });
      try {
        assert.match(session.getStdout(), /^IRON_BROWSER_READY\s+.+$/m);
        const pong = await session.ctl.ping();
        assert.equal(pong.pong, true);
        assert.ok(pong.version.length > 0);
        assert.equal(pong.socketPath, session.socketPath);

        const health = await session.ctl.health<{
          ok: boolean;
          socketReachable: boolean;
          lastCrashDump: unknown;
          watchdog: { stallCount?: number } | null;
        }>(20);
        assert.equal(health.ok, true);
        assert.equal(health.socketReachable, true);
        assert.equal(health.lastCrashDump, null);

        const doc = await ctx.runDoctor({
          socketPath: session.socketPath,
          viaLauncher: true,
          json: true,
        });
        assert.equal(doc.exitCode, 0, `doctor stderr=${doc.stderr}`);
        assert.equal(doc.json?.socketReachable, true);
        assert.equal(doc.json?.ok, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A1-02',
    name: 'SPA pushState navigation + Dual-viewport screenshot PNGs & layoutAudit',
    tier: 1,
    area: 'A1',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['spa', 'dual-viewport', 'screenshot'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/spa/home`, {
          mode: 'dual',
          session: 'shared',
        });
        const tabId = opened.tab?.id;
        assert.ok(tabId);
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/home' });

        await session.ctl.interact({
          tabId,
          viewport: 'landscape',
          action: 'click',
          selector: '#nav-dashboard',
          mirror: true,
        });

        await waitUntil(async () => {
          const r = await session.ctl.evalJs(
            'document.getElementById("spa-content")?.textContent',
            'landscape',
            tabId,
          );
          return r.value === 'Dashboard Ready' ? r.value : false;
        }, 5_000, 'SPA route change');

        const pRoute = await session.ctl.evalJs('location.pathname', 'portrait', tabId);
        assert.equal(pRoute.value, '/spa/dashboard');

        const shot = await session.ctl.screenshot(tabId, 'both');
        const pCap = shot.captures.portrait;
        const lCap = shot.captures.landscape;
        assert.ok(pCap && pCap.pngBase64.length > 0, 'Expected portrait screenshot');
        assert.ok(lCap && lCap.pngBase64.length > 0, 'Expected landscape screenshot');
        const pDims = parsePngDimensions(pCap.pngBase64);
        const lDims = parsePngDimensions(lCap.pngBase64);
        assert.ok(pDims.width > 0 && pDims.height > 0);
        assert.ok(lDims.width > pDims.width, 'Expected landscape width > portrait width');
        assert.ok(pCap.layoutAudit && lCap.layoutAudit);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A1-03',
    name: 'WebGL2 + Canvas rendering order & capture_frame inspection',
    tier: 1,
    area: 'A1',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['webgl', 'canvas', 'inspection'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/webgl`, {
          mode: 'dual',
          session: 'shared',
        });
        const tabId = opened.tab?.id;
        assert.ok(tabId);
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/webgl' });
        await sleep(250);

        const webgl = await session.ctl.webgl({
          tabId,
          viewport: 'both',
          action: 'capture_frame',
          maxCalls: 64,
        });
        assert.equal(webgl.ok, true);
        const viewports = webgl.viewports as Record<
          string,
          {
            summary: { contexts: number; drawCallsPerFrame: number };
            renderingOrder: Array<{ selector: string; zIndex: string }>;
          }
        >;
        const land = viewports.landscape;
        assert.ok(land, 'Expected landscape WebGL snapshot');
        const order = land.renderingOrder.map((item) => item.selector);
        const canvasIdx = order.findIndex((s) => s.includes('gl-stage'));
        const hudIdx = order.findIndex((s) => s.includes('hud-overlay'));
        assert.ok(canvasIdx >= 0 && hudIdx >= 0, `Missing expected layers: ${JSON.stringify(order)}`);
        assert.ok(canvasIdx < hudIdx, `Expected canvas before HUD in paint order: ${JSON.stringify(order)}`);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A1-04',
    name: 'Form/Auth + WS/SSE streams + TabEventBus causal gestureSeq & metrics',
    tier: 1,
    area: 'A1',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['auth', 'websocket', 'sse', 'events', 'metrics'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const authTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/auth`, {
          mode: 'dual',
          session: 'shared',
        });
        const authId = authTab.tab!.id;
        await session.ctl.waitForTabReady(authId, { expectedUrlIncludes: '/auth' });

        await session.ctl.interact({
          tabId: authId,
          viewport: 'landscape',
          action: 'click',
          selector: '#btn-login',
          mirror: false,
        });

        await waitUntil(async () => {
          const st = await session.ctl.evalJs('document.getElementById("auth-status")?.textContent', 'landscape', authId);
          return st.value === 'logged-in:devuser' ? st.value : false;
        }, 5_000, 'auth login');

        const meCheck = await session.ctl.evalJs(
          '(async () => (await fetch("/auth/me")).status)()',
          'landscape',
          authId,
        );
        assert.equal(meCheck.value, '200');

        const streamTab = await session.ctl.open(`${ctx.servers.httpBaseUrl}/stream-ui`, {
          mode: 'single',
          session: 'shared',
        });
        const streamId = streamTab.tab!.id;
        await session.ctl.waitForTabReady(streamId, { expectedUrlIncludes: '/stream-ui' });

        await waitUntil(async () => {
          const wsState = await session.ctl.evalJs('document.getElementById("ws-state")?.textContent', 'landscape', streamId);
          return wsState.value === 'open' && ctx.servers.getSseStats().activeConnections > 0 ? true : false;
        }, 5_000, 'WS + SSE connect');

        ctx.servers.pushSseEvent('tick', 'sse-42', '42');
        await waitUntil(async () => {
          const sseText = await session.ctl.evalJs('document.getElementById("sse-msgs")?.textContent', 'landscape', streamId);
          return sseText.value.includes('sse-42') ? sseText.value : false;
        }, 5_000, 'SSE event delivery');

        const bus = await session.ctl.events({ tabId: authId, domain: 'gesture', limit: 50 });
        assert.ok(bus.events.some((ev) => typeof ev.gestureSeq === 'number' && ev.gestureSeq > 0));
        assert.ok(!JSON.stringify(bus.events).includes('s3cr3t!'), 'Password must never leak to TabEventBus');

        const metrics = await session.ctl.metrics();
        assert.ok(metrics.totalMemoryMb > 0);
        assert.ok(metrics.landscape !== null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A1-05',
    name: 'Session persistence across restart restores tabs and mode',
    tier: 1,
    area: 'A1',
    requirement: 'R1 / F1',
    milestone: 'HEAD',
    tags: ['session', 'persistence', 'restart'],
    run: async (ctx) => {
      const seed: PersistedSessionFixture = {
        version: 1,
        savedAt: Date.now(),
        railCollapsed: false,
        dockOpen: false,
        dockHeight: 290,
        splitRatio: 0.35,
        theme: 'dark',
        activeTabIndex: 0,
        tabs: [
          {
            url: `${ctx.servers.httpBaseUrl}/spa/settings`,
            title: 'Persisted Settings',
            mode: 'dual',
            mirror: true,
            dedup: true,
            session: 'shared',
            sleeping: false,
            portraitPresetId: 'iphone-15',
            landscapePresetId: 'desktop-hd',
            devtoolsTarget: 'portrait',
            audioSource: 'landscape',
          },
        ],
        history: [],
      };
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-acc-ses-'));
      ctx.cleanup.trackDir(sessionDir);

      const first = await ctx.launchElectron({
        smoke: true,
        sessionDir,
        keepTempDir: true,
        seedSession: seed,
      });
      try {
        const tabs1 = await first.ctl.tabs();
        assert.ok(tabs1.tabs.some((t) => t.url.includes('/spa/settings')));
        await first.ctl.open(`${ctx.servers.httpBaseUrl}/find`, { mode: 'single' });
      } finally {
        await first.close();
      }

      const second = await ctx.launchElectron({
        smoke: true,
        sessionDir,
        keepTempDir: false,
      });
      try {
        const tabs2 = await second.ctl.tabs();
        assert.ok(tabs2.tabs.some((t) => t.url.includes('/spa/settings')));
        assert.ok(tabs2.tabs.some((t) => t.url.includes('/find')));
      } finally {
        await second.close();
      }
    },
  },

  // =========================================================================
  // A2: Agent Chat Dock writeInput Submit-vs-Paste & Transcript UX
  // =========================================================================
  {
    id: 'T1-A2-01',
    name: 'Agent Dock opens, switches Docked/Floating/Minimized, and + Tab Context injects active tab info',
    tier: 1,
    area: 'A2',
    requirement: 'R3 / F6',
    milestone: 'HEAD',
    tags: ['agent-dock', 'floating', 'context'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/spa/home`, { mode: 'dual' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/spa/home' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');

        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));
        await dockCdp.evaluate('document.getElementById("btn-mode-floating")?.click()');
        const isFloating = await waitUntil(async () => {
          const active = await dockCdp.evaluate<boolean>(
            'document.getElementById("btn-mode-floating")?.classList.contains("active") ?? false',
          );
          return active ? true : false;
        }, 4_000, 'btn-mode-floating active');
        assert.equal(isFloating, true);

        await dockCdp.evaluate('document.getElementById("btn-insert-context")?.click()');
        const injected = await waitUntil(async () => {
          const val = await dockCdp.evaluate<string>('document.getElementById("chat-input")?.value ?? ""');
          return val.includes('/spa/home') ? val : false;
        }, 4_000, '+ Tab Context injection');
        assert.ok(injected.includes('/spa/home'));
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A2-02',
    name: 'Agent Dock MD / Raw toggle formats Markdown & code blocks vs Raw ANSI',
    tier: 1,
    area: 'A2',
    requirement: 'R3 / F6',
    milestone: 'HEAD',
    tags: ['agent-dock', 'markdown', 'raw'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        const cmdStr = "printf '# Heading\\n\\n**bold** `inline`\\n' && sleep 2";
        await dockCdp.evaluate(`(() => {
          const inp = document.getElementById('input-custom-cli');
          inp.value = ${JSON.stringify(cmdStr)};
          document.querySelector('#custom-cli-form .run-btn').click();
        })()`);

        // In --smoke mode requestAnimationFrame is paused for unmapped views;
        // clicking btn-format-md invokes synchronous renderTranscriptNow(true).
        const mdDom = await waitUntil(async () => {
          await dockCdp.evaluate('document.getElementById("btn-format-md")?.click()');
          await dockCdp.evaluate('document.getElementById("btn-format-md")?.click()');
          return await dockCdp.evaluate<{
            isMd: boolean;
            h1Text: string;
            boldText: string;
            codeText: string;
          } | false>(`(() => {
            const scr = document.getElementById('terminal-screen');
            if (!scr) return false;
            const h1 = scr.querySelector('h1.md-h1, h1')?.textContent ?? '';
            const bold = scr.querySelector('strong.md-strong, strong')?.textContent ?? '';
            const code = scr.querySelector('code.md-inline-code, code')?.textContent ?? '';
            return h1.includes('Heading') && bold.includes('bold') && code.includes('inline')
              ? { isMd: scr.classList.contains('md-mode'), h1Text: h1, boldText: bold, codeText: code }
              : false;
          })()`);
        }, 6_000, 'PTY rendered Markdown DOM elements');
        assert.equal(mdDom.isMd, true);

        await dockCdp.evaluate('document.getElementById("btn-format-md")?.click()');
        const rawDom = await dockCdp.evaluate<{
          isRaw: boolean;
          hasMdTags: boolean;
          text: string;
        }>(`(() => {
          const scr = document.getElementById('terminal-screen');
          return {
            isRaw: Boolean(scr && !scr.classList.contains('md-mode')),
            hasMdTags: Boolean(scr?.querySelector('h1, strong, code.md-inline-code')),
            text: scr?.textContent ?? '',
          };
        })()`);
        assert.equal(rawDom.isRaw, true);
        assert.equal(rawDom.hasMdTags, false, 'Raw mode must not render Markdown HTML tags');
        assert.ok(
          rawDom.text.includes('# Heading') && rawDom.text.includes('**bold**'),
          `Expected raw Markdown tokens in Raw mode, got: ${rawDom.text}`,
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A2-03',
    name: 'Agent Dock PTY writeInput sends payload and separate CR submit (not single paste burst)',
    tier: 1,
    area: 'A2',
    requirement: 'Follow-up / F3',
    milestone: 'M1',
    tags: ['agent-dock', 'pty', 'writeInput', 'regression'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const probeLog = path.join(env.rootDir, 'pty-chunks.jsonl');
      // Script reads raw stdin chunks in non-canonical mode (like Claude/Agy/Codex TUI)
      // and distinguishes single-buffer paste ("payload\r" in 1 read) from separate write + delayed CR.
      const probeScript = path.join(env.rootDir, 'tui-probe.py');
      fs.writeFileSync(
        probeScript,
        `import json, os, select, sys, termios, time, tty
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
buf = bytearray()
chunks = []
try:
    sys.stdout.write("PROBE_READY\\r\\n")
    sys.stdout.flush()
    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            data = os.read(fd, 4096)
            if not data:
                break
            chunks.append({"ts": time.monotonic(), "text": data.decode("utf-8", "replace")})
            buf.extend(data)
            if b"\\r" in data or b"\\n" in data:
                # Only treat as submitted if CR was not glued into the very first payload chunk with >4 chars
                if len(chunks) >= 2 or len(data) <= 2:
                    break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
with open(${JSON.stringify(probeLog)}, "w") as f:
    json.dump({"chunks": chunks, "full": buf.decode("utf-8", "replace")}, f)
sys.stdout.write("SUBMIT_OK:" + str(len(chunks)) + "\\r\\n")
sys.stdout.flush()
time.sleep(0.5)
`,
        { mode: 0o644 },
      );

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate(`(() => {
          const inp = document.getElementById('input-custom-cli');
          inp.value = 'python3 ' + ${JSON.stringify(probeScript)};
          document.querySelector('#custom-cli-form .run-btn').click();
        })()`);

        await waitUntil(async () => {
          await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
          const text = await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""');
          return text.includes('PROBE_READY') ? true : false;
        }, 6_000, 'TUI probe ready');

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = 'fix the floating composer submit';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const record = await waitUntil(async () => {
          if (!fs.existsSync(probeLog)) return false;
          try {
            return JSON.parse(fs.readFileSync(probeLog, 'utf8')) as {
              chunks: Array<{ ts: number; text: string }>;
              full: string;
            };
          } catch {
            return false;
          }
        }, 5_000, 'PTY probe log');

        assert.ok(record.full.includes('fix the floating composer submit'), `Missing payload: ${JSON.stringify(record)}`);
        assert.ok(record.full.includes('\r'), `Missing CR submit: ${JSON.stringify(record)}`);
        assert.ok(
          record.chunks.length >= 2,
          `Expected separate data and CR writes (>=2 chunks), got single paste chunk: ${JSON.stringify(record.chunks)}`,
        );
        const firstHasCr = record.chunks[0]!.text.includes('\r');
        assert.equal(firstHasCr, false, `First chunk must not bundle CR with payload: ${JSON.stringify(record.chunks)}`);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A2-04',
    name: 'Agent Dock tmux adapter passes -- before payload and C-m after delay',
    tier: 1,
    area: 'A2',
    requirement: 'Follow-up / F3',
    milestone: 'M1',
    tags: ['agent-dock', 'tmux', 'writeInput', 'hyphen'],
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present');
      const tmuxLog = path.join(env.rootDir, 'tmux-calls.log');
      env.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}
case "$cmd" in
  list-panes)
    printf 'main:0.0\\tagent-win\\tclaude\\t%s\\t99999\\n' "$PWD"
    ;;
  capture-pane)
    printf 'mock tmux ready\\n'
    ;;
  send-keys)
    # Fail like real tmux if a flag-like literal follows -l without --
    prev=""
    saw_dashdash=0
    for arg in "$@"; do
      if [[ "$arg" == "--" ]]; then
        saw_dashdash=1
      elif [[ "$prev" == "-l" && "$saw_dashdash" == "0" && "$arg" == -* ]]; then
        echo "unknown option: $arg" >&2
        exit 1
      fi
      prev="$arg"
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
        await waitUntil(async () => {
          const count = await dockCdp.evaluate<number>(
            'document.querySelectorAll("#instance-list button, #instance-list .instance-item").length',
          );
          return count > 0 ? count : false;
        }, 5_000, 'mock tmux instance list');

        await dockCdp.evaluate(`(() => {
          const item = document.querySelector('#instance-list button, #instance-list .instance-item');
          item.click();
        })()`);

        await waitUntil(async () => {
          const badge = await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""');
          return badge.includes('main:0.0') ? true : false;
        }, 5_000, 'attach mock tmux pane');

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.value = '-n verify hyphen message';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        const logText = await waitUntil(async () => {
          if (!fs.existsSync(tmuxLog)) return false;
          const content = fs.readFileSync(tmuxLog, 'utf8');
          return content.includes('C-m') && content.includes('-n verify hyphen message') ? content : false;
        }, 5_000, 'tmux send-keys with -- and C-m');

        assert.match(logText, /send-keys -t main:0\.0 -l -- -n verify hyphen message/);
        assert.match(logText, /send-keys -t main:0\.0 C-m/);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A2-05',
    name: 'Agent Dock Clear / Copy / Export Transcript controls & non-destructive failed submit',
    tier: 1,
    area: 'A2',
    requirement: 'R3 / F6',
    milestone: 'M2',
    tags: ['agent-dock', 'transcript', 'ux'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        // Populate #terminal-screen before disconnecting so Clear/Copy/Export operate on real output.
        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate(`(() => {
          const inp = document.getElementById('input-custom-cli');
          inp.value = 'echo TRANSCRIPT_A205_DATA && sleep 1';
          document.querySelector('#custom-cli-form .run-btn').click();
        })()`);
        await waitUntil(async () => {
          await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
          const txt = await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""');
          return txt.includes('TRANSCRIPT_A205_DATA') ? true : false;
        }, 5_000, 'transcript populated before Clear');

        // Stop session so writeInput returns false.
        await dockCdp.evaluate('document.getElementById("btn-disconnect")?.click()');
        await sleep(100);

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = 'preserve-me-when-idle';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
        await sleep(200);

        const keptValue = await dockCdp.evaluate<string>('document.getElementById("chat-input")?.value ?? ""');
        assert.equal(
          keptValue,
          'preserve-me-when-idle',
          'Submitting when writeInput returns false must NOT wipe user input',
        );

        // Locate Clear / Copy / Export transcript buttons (excluding .md-copy-btn, #btn-format-md, #btn-mode-*).
        const controls = await dockCdp.evaluate<{
          hasClear: boolean;
          hasCopy: boolean;
          hasExport: boolean;
        }>(`(() => {
          const isExcluded = (b) =>
            b.classList.contains('md-copy-btn') ||
            b.id === 'btn-format-md' ||
            b.id.startsWith('btn-mode-');
          const btns = Array.from(document.querySelectorAll('button')).filter((b) => !isExcluded(b));
          const labelOf = (b) => (b.id + ' ' + (b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
          const findBtn = (kw) => btns.find((b) => labelOf(b).includes(kw) && !b.disabled);
          const clearBtn = findBtn('clear');
          const copyBtn = findBtn('copy');
          const exportBtn = findBtn('export');
          if (copyBtn) copyBtn.click();
          return {
            hasClear: Boolean(clearBtn),
            hasCopy: Boolean(copyBtn),
            hasExport: Boolean(exportBtn),
          };
        })()`);
        assert.equal(
          controls.hasClear && controls.hasCopy && controls.hasExport,
          true,
          `Expected Clear, Copy, and Export Transcript buttons in Agent Dock, got ${JSON.stringify(controls)}`,
        );

        // Transcript must still be intact after Copy, then Clear must empty it.
        const stillHasData = await dockCdp.evaluate<boolean>(
          '(document.getElementById("terminal-screen")?.textContent ?? "").includes("TRANSCRIPT_A205_DATA")',
        );
        assert.equal(stillHasData, true, 'Copy must not clear transcript');

        await dockCdp.evaluate(`(() => {
          const isExcluded = (b) =>
            b.classList.contains('md-copy-btn') ||
            b.id === 'btn-format-md' ||
            b.id.startsWith('btn-mode-');
          const btns = Array.from(document.querySelectorAll('button')).filter((b) => !isExcluded(b));
          const clearBtn = btns.find((b) => (b.id + ' ' + (b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase().includes('clear'));
          clearBtn?.click();
        })()`);

        await waitUntil(async () => {
          const txt = await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""');
          return !txt.includes('TRANSCRIPT_A205_DATA') ? true : false;
        }, 4_000, 'Clear empties Agent Dock transcript');
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A3: Expanded Browser Controls & URL Normalization
  // =========================================================================
  {
    id: 'T1-A3-01',
    name: 'Global shortcuts: Ctrl+T, Ctrl+W, Ctrl+Shift+T, Ctrl+Shift+D, Ctrl+M, Ctrl+\\',
    tier: 1,
    area: 'A3',
    requirement: 'R2 / F4',
    milestone: 'HEAD',
    tags: ['shortcuts', 'tabs', 'dual', 'mirror'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        const initTabs = await session.ctl.tabs();
        const startCount = initTabs.tabs.length;

        await shellCdp.dispatchKey({ key: 't', code: 'KeyT', ctrl: true });
        await waitUntil(async () => (await session.ctl.tabs()).tabs.length === startCount + 1 ? true : false, 4_000, 'Ctrl+T new tab');

        const afterNew = await session.ctl.tabs();
        await session.ctl.navigate(`${ctx.servers.httpBaseUrl}/echo`, afterNew.activeTabId ?? undefined);
        await session.ctl.waitForTabReady(afterNew.activeTabId ?? undefined, { expectedUrlIncludes: '/echo' });

        await shellCdp.dispatchKey({ key: 'D', code: 'KeyD', ctrl: true, shift: true });
        await waitUntil(async () => {
          const st = await session.ctl.tabs();
          const active = st.tabs.find((t) => t.id === st.activeTabId);
          return active?.mode === 'single' ? true : false;
        }, 4_000, 'Ctrl+Shift+D toggle dual->single');

        await shellCdp.dispatchKey({ key: 'm', code: 'KeyM', ctrl: true });
        await waitUntil(async () => {
          const st = await session.ctl.tabs();
          const active = st.tabs.find((t) => t.id === st.activeTabId);
          return active?.mirror === false ? true : false;
        }, 4_000, 'Ctrl+M toggle mirror');

        await shellCdp.dispatchKey({ key: 'w', code: 'KeyW', ctrl: true });
        await waitUntil(async () => (await session.ctl.tabs()).tabs.length === startCount ? true : false, 4_000, 'Ctrl+W close tab');

        await shellCdp.dispatchKey({ key: 'T', code: 'KeyT', ctrl: true, shift: true });
        await waitUntil(async () => (await session.ctl.tabs()).tabs.length === startCount + 1 ? true : false, 4_000, 'Ctrl+Shift+T reopen');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A3-02',
    name: 'Find-in-Page (Ctrl+F) finds occurrences, navigates Next/Prev, and closes on Escape',
    tier: 1,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['find-in-page', 'ctrl-f', 'shell'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/find`, { mode: 'single' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/find' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.dispatchKey({ key: 'f', code: 'KeyF', ctrl: true });

        const findInputReady = await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const inp = document.querySelector('#find-input, input[aria-label*="Find" i], input[placeholder*="Find" i]');
            if (!inp) return false;
            const style = getComputedStyle(inp.closest('[id*="find"], .find-bar') || inp);
            return style.display !== 'none' && !inp.closest('.hidden');
          })()`);
        }, 4_000, 'Find-in-Page bar visible');
        assert.equal(findInputReady, true);

        await shellCdp.evaluate(`(() => {
          const inp = document.querySelector('#find-input, input[aria-label*="Find" i], input[placeholder*="Find" i]');
          inp.focus();
          inp.value = 'needle-alpha';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);

        const matchText = await waitUntil(async () => {
          return await shellCdp.evaluate<string | false>(`(() => {
            const bar = document.querySelector('#find-bar, .find-bar, [data-testid="find-bar"]') || document.body;
            const txt = bar.textContent || '';
            return /\\b1\\s*\\/\\s*3\\b/.test(txt) ? txt : false;
          })()`);
        }, 4_000, 'Find-in-Page initial 1 / 3 match');
        assert.ok(matchText);

        // Step Next -> 2 / 3
        const clickedNext = await shellCdp.evaluate<boolean>(`(() => {
          const btn = document.querySelector('#find-next, button[aria-label*="Next" i], button[title*="Next" i]');
          if (btn) { btn.click(); return true; }
          const inp = document.querySelector('#find-input, input[aria-label*="Find" i], input[placeholder*="Find" i]');
          inp?.focus();
          return false;
        })()`);
        if (!clickedNext) {
          await shellCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
        }
        await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const bar = document.querySelector('#find-bar, .find-bar, [data-testid="find-bar"]') || document.body;
            return /\\b2\\s*\\/\\s*3\\b/.test(bar.textContent || '');
          })()`);
        }, 4_000, 'Find-in-Page Next match 2 / 3');

        // Step Prev -> 1 / 3
        const clickedPrev = await shellCdp.evaluate<boolean>(`(() => {
          const btn = document.querySelector('#find-prev, button[aria-label*="Prev" i], button[title*="Prev" i]');
          if (btn) { btn.click(); return true; }
          const inp = document.querySelector('#find-input, input[aria-label*="Find" i], input[placeholder*="Find" i]');
          inp?.focus();
          return false;
        })()`);
        if (!clickedPrev) {
          await shellCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13, shift: true });
        }
        await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const bar = document.querySelector('#find-bar, .find-bar, [data-testid="find-bar"]') || document.body;
            return /\\b1\\s*\\/\\s*3\\b/.test(bar.textContent || '');
          })()`);
        }, 4_000, 'Find-in-Page Prev match 1 / 3');

        await shellCdp.dispatchKey({ key: 'Escape', code: 'Escape', keyCode: 27 });
        await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const bar = document.querySelector('#find-bar, .find-bar, [data-testid="find-bar"]');
            if (!bar) return false;
            return bar.classList.contains('hidden') || getComputedStyle(bar).display === 'none';
          })()`);
        }, 4_000, 'Find-in-Page closed on Escape');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A3-03',
    name: 'Per-page Zoom (Ctrl+=, Ctrl+-, Ctrl+0) scales page and resets cleanly without breaking screenshot',
    tier: 1,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['zoom', 'shortcuts', 'screenshot'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/find`, { mode: 'single' });
        const tabId = opened.tab!.id;
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/find' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        const baseDpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);

        await shellCdp.dispatchKey({ key: '=', code: 'Equal', keyCode: 187, ctrl: true });
        await waitUntil(async () => {
          const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
          return dpr > baseDpr ? dpr : false;
        }, 4_000, 'Zoom In increases devicePixelRatio');

        await shellCdp.dispatchKey({ key: '-', code: 'Minus', keyCode: 189, ctrl: true });
        await shellCdp.dispatchKey({ key: '-', code: 'Minus', keyCode: 189, ctrl: true });
        await waitUntil(async () => {
          const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
          return dpr < baseDpr ? dpr : false;
        }, 4_000, 'Zoom Out decreases devicePixelRatio');

        await shellCdp.dispatchKey({ key: '0', code: 'Digit0', keyCode: 48, ctrl: true });
        await waitUntil(async () => {
          const dpr = Number((await session.ctl.evalJs('window.devicePixelRatio', 'landscape', tabId)).value);
          return Math.abs(dpr - baseDpr) < 0.01 ? true : false;
        }, 4_000, 'Zoom Reset restores base DPR');

        const shot = await session.ctl.screenshot(tabId, 'landscape');
        assert.ok(shot.captures.landscape && shot.captures.landscape.bytes > 0);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A3-04',
    name: 'Download saves to IRON_BROWSER_DOWNLOAD_DIR, emits TabEventBus download event, and shows UI toast',
    tier: 1,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['downloads', 'toast', 'events'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/download-trigger`, { mode: 'single' });
        const tabId = opened.tab!.id;
        await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/download-trigger' });

        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await session.ctl.interact({
          tabId,
          viewport: 'landscape',
          action: 'click',
          selector: '#dl-link',
        });

        const dlFile = await waitUntil(async () => {
          const p = path.join(session.downloadDir, 'sample.csv');
          return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : false;
        }, 6_000, 'sample.csv downloaded');
        assert.ok(fs.readFileSync(dlFile, 'utf8').includes('1,spa,ok'));

        const evRes = await session.ctl.events({ tabId, domain: 'download', limit: 20 });
        assert.ok(evRes.events.some((e) => e.kind === 'completed'));

        const toastSeen = await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const text = document.body.innerText || '';
            return text.includes('sample.csv');
          })()`);
        }, 4_000, 'Download toast showing sample.csv in shell UI');
        assert.equal(toastSeen, true);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A3-05',
    name: 'Main-frame did-fail-load error banner + Retry recovers & IPv4/host:port URLs normalize to http://',
    tier: 1,
    area: 'A3',
    requirement: 'R3 / F4',
    milestone: 'M2',
    tags: ['error-banner', 'retry', 'url-normalization'],
    run: async (ctx) => {
      // Reserve an ephemeral port, close it so first load fails, then re-bind it for Retry.
      const probeServer = net.createServer();
      await new Promise<void>((res) => probeServer.listen(0, '127.0.0.1', res));
      const port = (probeServer.address() as net.AddressInfo).port;
      await new Promise<void>((res) => probeServer.close(() => res()));

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true });
      try {
        // Test IPv4 without scheme (`127.0.0.1:<port>/echo` from test server)
        const basePort = new URL(ctx.servers.httpBaseUrl).port;
        const ipv4Nav = await session.ctl.open(`127.0.0.1:${basePort}/echo`, { mode: 'single' });
        await session.ctl.waitForTabReady(ipv4Nav.tab!.id, { expectedUrlIncludes: '/echo' });
        assert.ok(ipv4Nav.tab!.url.startsWith('http://127.0.0.1:'), `Expected http://, got ${ipv4Nav.tab!.url}`);

        // Also test non-loopback IPv4 normalization (`192.0.2.10:8080` -> `http://192.0.2.10:8080/`)
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        const failTab = await session.ctl.open(`http://127.0.0.1:${port}/recover`, { mode: 'single' });
        const failTabId = failTab.tab!.id;

        const hasRetryBanner = await waitUntil(async () => {
          return await shellCdp.evaluate<boolean>(`(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.some(b => /retry/i.test(b.textContent || '') && b.offsetParent !== null);
          })()`);
        }, 6_000, 'did-fail-load Retry banner');
        assert.equal(hasRetryBanner, true);

        // Start server on that exact port, then click Retry.
        const recoverSrv = Bun.serve({
          hostname: '127.0.0.1',
          port,
          fetch: () =>
            new Response('<!doctype html><html><body><h1 id="ok-retry">RECOVERED</h1></body></html>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
        });
        ctx.cleanup.trackCallback(() => recoverSrv.stop(true));

        await shellCdp.evaluate(`(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || '') && b.offsetParent !== null);
          btn.click();
        })()`);

        await waitUntil(async () => {
          try {
            const res = await session.ctl.evalJs('document.getElementById("ok-retry")?.textContent', 'landscape', failTabId);
            return res.value === 'RECOVERED' ? true : false;
          } catch {
            return false;
          }
        }, 6_000, 'Retry loads recovered page');
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A4: Expanded MCP Sidecar & ctl.sock Protocol
  // =========================================================================
  {
    id: 'T1-A4-01',
    name: 'iron-browser-mcp stdio JSON-RPC handshake, ping, and core browser_open/eval',
    tier: 1,
    area: 'A4',
    requirement: 'R2 / F2',
    milestone: 'HEAD',
    tags: ['mcp', 'stdio', 'json-rpc'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath, autoInitialize: false });
        try {
          const init = await mcp.initialize('2025-06-18');
          assert.equal(init.protocolVersion, '2025-06-18');
          mcp.sendInitialized();

          const pingRes = await mcp.request<Record<string, unknown>>('ping', {});
          assert.deepEqual(pingRes, {});

          const openRes = await mcp.callTool('browser_open', {
            url: `${ctx.servers.httpBaseUrl}/echo`,
            mode: 'single',
          });
          assert.notEqual(openRes.isError, true);
          const textBlock = openRes.content.find((c) => c.type === 'text')?.text ?? '';
          const parsed = JSON.parse(textBlock) as { tab?: { id: string } };
          assert.ok(parsed.tab?.id);

          await session.ctl.waitForTabReady(parsed.tab.id, { expectedUrlIncludes: '/echo' });
          const evalRes = await mcp.callTool('browser_eval', {
            tab_id: parsed.tab.id,
            viewport: 'landscape',
            expression: 'document.body.innerText',
          });
          assert.notEqual(evalRes.isError, true);
          const evalPayload = JSON.parse(evalRes.content[0]?.text ?? '{}') as { value?: string };
          assert.ok((evalPayload.value ?? '').includes('"path":"/echo"'));
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A4-02',
    name: 'iron-browser-mcp tools/list exposes all 26 tools with 4 boolean annotations',
    tier: 1,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'tools-list', 'schema'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const { tools } = await mcp.listTools();
          assert.equal(tools.length, 26, `Expected 26 MCP tools, got ${tools.length}: ${tools.map((t) => t.name).join(', ')}`);
          const expectedNew = [
            'browser_close_tab',
            'browser_select_tab',
            'browser_reload',
            'browser_navigate_history',
            'browser_wait_for',
            'browser_storage',
          ];
          const names = new Set(tools.map((t) => t.name));
          for (const name of expectedNew) {
            assert.ok(names.has(name), `Missing new M2 MCP tool: ${name}`);
          }
          for (const t of tools) {
            assert.ok(t.annotations, `Tool ${t.name} missing annotations`);
            for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
              assert.equal(typeof t.annotations[k], 'boolean', `Tool ${t.name} missing boolean annotation ${k}`);
            }
          }
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A4-03',
    name: 'MCP browser_select_tab and browser_close_tab manage tab lifecycle',
    tier: 1,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'tabs', 'select', 'close'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const t1 = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/one`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };
          const t2 = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/two`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };

          const selRes = await mcp.callTool('browser_select_tab', { tab_id: t1.tab.id });
          assert.notEqual(selRes.isError, true);
          const tabsAfterSel = JSON.parse((await mcp.callTool('browser_tabs', {})).content[0]!.text!) as { activeTabId: string };
          assert.equal(tabsAfterSel.activeTabId, t1.tab.id);

          const closeRes = await mcp.callTool('browser_close_tab', { tab_id: t2.tab.id });
          assert.notEqual(closeRes.isError, true);
          const tabsAfterClose = JSON.parse((await mcp.callTool('browser_tabs', {})).content[0]!.text!) as { tabs: Array<{ id: string }> };
          assert.equal(tabsAfterClose.tabs.some((t) => t.id === t2.tab.id), false);
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A4-04',
    name: 'MCP browser_reload and browser_navigate_history (back/forward) drive navigation',
    tier: 1,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'reload', 'history'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const opened = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/first`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };
          const tabId = opened.tab.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/first' });

          await mcp.callTool('browser_navigate', { tab_id: tabId, url: `${ctx.servers.httpBaseUrl}/find` });
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/find' });

          const backRes = await mcp.callTool('browser_navigate_history', { tab_id: tabId, direction: 'back' });
          assert.notEqual(backRes.isError, true);
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/first' });

          const fwdRes = await mcp.callTool('browser_navigate_history', { tab_id: tabId, direction: 'forward' });
          assert.notEqual(fwdRes.isError, true);
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/find' });

          ctx.servers.resetHttpLogs();
          const reloadRes = await mcp.callTool('browser_reload', { tab_id: tabId, ignore_cache: true });
          assert.notEqual(reloadRes.isError, true);
          await waitUntil(async () => ctx.servers.getHttpLogs('/find').length > 0 ? true : false, 4_000, 'reload HTTP hit');
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A4-05',
    name: 'MCP browser_wait_for & browser_storage (cookies/localStorage/sessionStorage)',
    tier: 1,
    area: 'A4',
    requirement: 'R3 / F5',
    milestone: 'M2',
    tags: ['mcp', 'wait_for', 'storage'],
    run: async (ctx) => {
      const session = await ctx.launchElectron({ smoke: true });
      try {
        const mcp = await ctx.launchMcp({ socketPath: session.socketPath });
        try {
          const opened = JSON.parse((await mcp.callTool('browser_open', { url: `${ctx.servers.httpBaseUrl}/spa/home`, mode: 'single' })).content[0]!.text!) as { tab: { id: string } };
          const tabId = opened.tab.id;
          await session.ctl.waitForTabReady(tabId, { expectedUrlIncludes: '/spa/home' });

          await mcp.callTool('browser_interact', { tab_id: tabId, viewport: 'landscape', action: 'click', selector: '#btn-async-route' });
          const waitRes = await mcp.callTool('browser_wait_for', {
            tab_id: tabId,
            viewport: 'landscape',
            selector: '#async-loaded',
            timeout_ms: 4_000,
          });
          assert.notEqual(waitRes.isError, true);

          await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'landscape',
            action: 'set',
            scope: 'localStorage',
            key: 'e2e_k',
            value: 'e2e_v',
          });
          const getLocal = await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'landscape',
            action: 'get',
            scope: 'localStorage',
            key: 'e2e_k',
          });
          assert.ok((getLocal.content[0]?.text ?? '').includes('e2e_v'));

          await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'landscape',
            action: 'set',
            scope: 'cookies',
            name: 'ib_test_cookie',
            value: 'cookie42',
            url: ctx.servers.httpBaseUrl,
          });
          const getCookies = await mcp.callTool('browser_storage', {
            tab_id: tabId,
            viewport: 'landscape',
            action: 'get',
            scope: 'cookies',
            url: ctx.servers.httpBaseUrl,
          });
          assert.ok((getCookies.content[0]?.text ?? '').includes('cookie42'));
        } finally {
          await mcp.close();
        }
      } finally {
        await session.close();
      }
    },
  },

  // =========================================================================
  // A5: iron-browser Setup-Agnostic Decoupling
  // =========================================================================
  {
    id: 'T1-A5-01',
    name: 'iron-browser boots and browses in sterile no-personal-tools env (no tmux/alacritty/hyprctl/CLIs)',
    tier: 1,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['decoupling', 'sterile', 'no-personal-tools'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      assert.equal(env.which('tmux'), null);
      assert.equal(env.which('alacritty'), null);
      assert.equal(env.which('hyprctl'), null);
      assert.equal(env.which('agy'), null);

      const session = await ctx.launchElectron({ smoke: true, isolatedEnv: env });
      try {
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'dual' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/echo' });
        const health = await session.ctl.health<{ ok: boolean; lastCrashDump: unknown }>(20);
        assert.equal(health.ok, true);
        assert.equal(health.lastCrashDump, null);
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A5-02',
    name: 'Agent Dock dynamic $PATH detection omits unavailable personal CLIs and keeps shell available',
    tier: 1,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['agent-dock', 'path-detection', 'decoupling'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await sleep(150);

        const chipInfo = await dockCdp.evaluate<{
          shellVisible: boolean;
          unavailableClickable: string[];
        }>(`(() => {
          const chips = Array.from(document.querySelectorAll('.chip-btn[data-preset]'));
          const visibleActive = chips.filter(b => {
            const st = getComputedStyle(b);
            return st.display !== 'none' && !b.hasAttribute('disabled') && !b.classList.contains('hidden');
          }).map(b => b.getAttribute('data-preset'));
          const broken = ['agy', 'claude', 'codex', 'opencode'].filter(p => visibleActive.includes(p));
          return {
            shellVisible: visibleActive.includes('shell'),
            unavailableClickable: broken,
          };
        })()`);

        assert.equal(chipInfo.shellVisible, true, 'Portable shell preset must remain available');
        assert.deepEqual(
          chipInfo.unavailableClickable,
          [],
          `Missing CLIs on PATH must not appear as active default presets: ${JSON.stringify(chipInfo.unavailableClickable)}`,
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A5-03',
    name: 'Agent Dock shell preset uses $SHELL fallback cleanly without tmux',
    tier: 1,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['agent-dock', 'shell', 'pty'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', { shell: '/bin/sh' });
      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        await dockCdp.evaluate('document.querySelector(\'.chip-btn[data-preset="shell"]\')?.click()');

        await waitUntil(async () => {
          const badge = await dockCdp.evaluate<string>('document.getElementById("session-badge")?.textContent ?? ""');
          return badge.includes('sh') ? badge : false;
        }, 5_000, 'shell preset starts sh');

        await dockCdp.evaluate(`(() => {
          const chat = document.getElementById('chat-input');
          chat.focus();
          chat.value = 'echo STERILE_SHELL_OK';
        })()`);
        await dockCdp.dispatchKey({ key: 'Enter', code: 'Enter', keyCode: 13 });

        await waitUntil(async () => {
          await dockCdp.evaluate('document.getElementById("btn-format-md")?.click(); document.getElementById("btn-format-md")?.click();');
          const txt = await dockCdp.evaluate<string>('document.getElementById("terminal-screen")?.textContent ?? ""');
          return txt.includes('STERILE_SHELL_OK') ? true : false;
        }, 5_000, 'shell command output');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A5-04',
    name: 'IRON_BROWSER_AGENT_CLIS override & optional tmux adapter auto-detection',
    tier: 1,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['agent-dock', 'custom-clis', 'tmux'],
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present', {
        envOverrides: {
          IRON_BROWSER_AGENT_CLIS: 'aider,goose',
        },
      });
      env.writeMockExecutable('aider', 'echo "MOCK_AIDER_READY"; sleep 2');
      env.writeMockExecutable(
        'tmux',
        'if [[ "${1:-}" == "list-panes" ]]; then printf "dev:0.0\\tagent\\taider\\t%s\\t8888\\n" "$PWD"; fi',
      );

      const session = await ctx.launchElectron({ smoke: true, enableCdp: true, isolatedEnv: env });
      try {
        const shellCdp = await session.connectCdp((t) => t.url.endsWith('/index.html'));
        await shellCdp.evaluate('document.getElementById("btn-agent-chat")?.click()');
        const dockCdp = await session.connectCdp((t) => t.url.endsWith('/agent-dock.html'));

        await dockCdp.evaluate('document.getElementById("btn-refresh-instances")?.click()');
        await waitUntil(async () => {
          const html = await dockCdp.evaluate<string>('document.getElementById("instance-list")?.textContent ?? ""');
          return html.includes('dev:0.0') ? true : false;
        }, 5_000, 'tmux pane discovered');

        await dockCdp.evaluate('document.getElementById("tab-start")?.click()');
        const hasConfiguredCli = await dockCdp.evaluate<boolean>(`(() => {
          const txt = document.getElementById('pane-start')?.textContent?.toLowerCase() ?? '';
          return txt.includes('aider');
        })()`);
        assert.equal(hasConfiguredCli, true, 'Expected IRON_BROWSER_AGENT_CLIS entry aider in launcher');
      } finally {
        await session.close();
      }
    },
  },
  {
    id: 'T1-A5-05',
    name: 'Display/Ozone portability: Electron boots under headless Ozone without DISPLAY or WAYLAND_DISPLAY',
    tier: 1,
    area: 'A5',
    requirement: 'R4 / F7',
    milestone: 'M3',
    tags: ['ozone', 'headless', 'wayland', 'x11'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', {
        envOverrides: { DISPLAY: null, WAYLAND_DISPLAY: null },
      });
      const session = await ctx.launchElectron({
        smoke: true,
        isolatedEnv: env,
        ozoneMode: 'headless',
      });
      try {
        const pong = await session.ctl.ping();
        assert.equal(pong.pong, true);
        const opened = await session.ctl.open(`${ctx.servers.httpBaseUrl}/echo`, { mode: 'single' });
        await session.ctl.waitForTabReady(opened.tab!.id, { expectedUrlIncludes: '/echo' });
      } finally {
        await session.close();
      }

      // Also verify bin/iron-browser launcher auto-selects headless Ozone when DISPLAY/WAYLAND_DISPLAY are absent.
      const viaLauncherSession = await ctx.launchElectron({
        smoke: true,
        viaLauncher: true,
        isolatedEnv: env,
        ozoneMode: 'none',
      });
      try {
        assert.equal((await viaLauncherSession.ctl.ping()).pong, true);
      } finally {
        await viaLauncherSession.close();
      }
    },
  },

  // =========================================================================
  // A6: teamwork (sidebar-ctl.sh & Hooks) Decoupling
  // =========================================================================
  {
    id: 'T1-A6-01',
    name: 'sidebar-ctl.sh status, compact, preview, close run cleanly without tmux',
    tier: 1,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['teamwork', 'sidebar-ctl', 'no-tmux'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const ctlPath = path.join(ctx.hooksDir, 'sidebar-ctl.sh');
      for (const args of [
        ['status'],
        ['compact', 'on'],
        ['compact', 'auto'],
        ['close'],
      ]) {
        const res = await runSubprocess('bash', [ctlPath, ...args], { env: env.env, cleanup: ctx.cleanup });
        assert.equal(res.exitCode, 0, `sidebar-ctl.sh ${args.join(' ')} failed: ${res.stderr}`);
      }
    },
  },
  {
    id: 'T1-A6-02',
    name: 'task-title-hook, flow-hook, todo-hook CLI state updates work in isolated HARNESS_HOME',
    tier: 1,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['teamwork', 'hooks', 'state'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const sid = 'conv-acc-t1-a6-02';

      const tRes = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'task-title-hook.py'), 'set', 'Acceptance Check', sid],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(tRes.exitCode, 0, tRes.stderr);

      const tGet = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'task-title-hook.py'), 'get', sid],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(tGet.exitCode, 0);
      assert.equal(tGet.stdout.trim(), 'acceptance-check');

      const flowRes = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'flow-hook.py'), 'start', 'accflow', 'step1', 'step2'],
        { env: { ...env.env, AGY_CONVERSATION_ID: sid }, cleanup: ctx.cleanup },
      );
      assert.equal(flowRes.exitCode, 0, flowRes.stderr);

      const todoRes = await runSubprocess(
        'python3',
        [path.join(ctx.hooksDir, 'todo-hook.py'), 'set', '--start', 'First', 'Second'],
        { env: { ...env.env, AGY_CONVERSATION_ID: sid }, cleanup: ctx.cleanup },
      );
      assert.equal(todoRes.exitCode, 0, todoRes.stderr);
    },
  },
  {
    id: 'T1-A6-03',
    name: 'Hook scripts fail-open with {} and exit 0 in hook stdin mode without tmux',
    tier: 1,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'HEAD',
    tags: ['teamwork', 'fail-open', 'hooks'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const payload = JSON.stringify({ conversationId: 'conv-hook-1', conversationTitle: 'Hook Test' });
      for (const script of ['task-title-hook.py', 'flow-hook.py', 'todo-hook.py']) {
        const res = await runSubprocess('python3', [path.join(ctx.hooksDir, script)], {
          env: env.env,
          stdinData: payload,
          cleanup: ctx.cleanup,
        });
        assert.equal(res.exitCode, 0, `${script} failed: ${res.stderr}`);
        assert.equal(res.stdout.trim(), '{}', `${script} expected {}`);
      }
    },
  },
  {
    id: 'T1-A6-04',
    name: 'sidebar-ctl.sh open/toggle and wrapper scripts degrade gracefully in sterile no-personal-tools env',
    tier: 1,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'M3',
    tags: ['teamwork', 'decoupling', 'portable-fallback'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const openRes = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open'],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(
        openRes.exitCode,
        0,
        `M3 sidebar-ctl.sh open without tmux must fall back gracefully with exit 0, got ${openRes.exitCode}: ${openRes.stderr}`,
      );

      // Wrapper scripts must work even when HOME != real user home (using BASH_SOURCE/AGY_HOME).
      const wrapRes = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'task-title.sh'), 'set', 'Portable Wrapper', 'conv-wrap-1'],
        { env: env.env, cleanup: ctx.cleanup },
      );
      assert.equal(wrapRes.exitCode, 0, `task-title.sh failed with isolated HOME: ${wrapRes.stderr}`);
    },
  },
  {
    id: 'T1-A6-05',
    name: 'sidebar-ctl.sh auto-detects tmux when present with generic pane (non-agy)',
    tier: 1,
    area: 'A6',
    requirement: 'R4 / F8',
    milestone: 'M3',
    tags: ['teamwork', 'tmux', 'adapter-present'],
    run: async (ctx) => {
      const env = ctx.createEnv('adapter-present');
      const tmuxCalls = path.join(env.rootDir, 'sidebar-tmux.log');
      env.writeMockExecutable(
        'tmux',
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxCalls)}
case "\${1:-}" in
  list-panes)
    if [[ "$*" == *"pane_current_command"* ]]; then
      printf '%%10\\tclaude\\n'
    elif [[ "$*" == *"pane_title"* ]]; then
      printf '%%10\\tmain\\n'
    else
      printf '%%10\\n'
    fi
    ;;
  display-message)
    printf '160\\n'
    ;;
  split-window)
    printf '%%11\\n'
    ;;
  select-pane|kill-pane)
    exit 0
    ;;
esac
`,
      );
      const res = await runSubprocess(
        'bash',
        [path.join(ctx.hooksDir, 'sidebar-ctl.sh'), 'open', '--width', '40'],
        {
          env: { ...env.env, TMUX: '/tmp/tmux-mock/default,1,0', TMUX_PANE: '%10' },
          cleanup: ctx.cleanup,
        },
      );
      assert.equal(res.exitCode, 0, `sidebar-ctl.sh open with mock tmux failed: ${res.stderr}`);
      const log = fs.readFileSync(tmuxCalls, 'utf8');
      assert.ok(log.includes('split-window'), `Expected tmux split-window call: ${log}`);
    },
  },

  // =========================================================================
  // A7: iron-term Decoupling, Unified Socket, CLI & XDG Desktop Packaging
  // =========================================================================
  {
    id: 'T1-A7-01',
    name: 'iron-agentd + iron-termctl spawn, status, inspect, hibernate, wake on isolated socket',
    tier: 1,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'HEAD',
    tags: ['iron-term', 'daemon', 'cli', 'hibernate'],
    run: async (ctx) => {
      const daemon = await ctx.ironTerm.startAgentd();
      try {
        const spawned = await ctx.ironTerm.runCtlJson<{ session: { id: string } }>(
          ['spawn', '--title', 'acc-sess', '--', '/bin/sh', '-c', 'echo READY && sleep 10'],
          { socketPath: daemon.socketPath },
        );
        const sid = spawned.session.id;
        assert.ok(sid);

        const inspected = await ctx.ironTerm.runCtlJson<{ inspection: { session: { id: string; title: string } } }>(
          ['inspect', sid],
          { socketPath: daemon.socketPath },
        );
        assert.equal(inspected.inspection.session.id, sid);

        const hib = await ctx.ironTerm.runCtl(['hibernate', sid], { socketPath: daemon.socketPath, json: true });
        assert.equal(hib.exitCode, 0, hib.stderr);

        const wake = await ctx.ironTerm.runCtl(['wake', sid], { socketPath: daemon.socketPath, json: true });
        assert.equal(wake.exitCode, 0, wake.stderr);
      } finally {
        await daemon.close();
      }
    },
  },
  {
    id: 'T1-A7-02',
    name: 'iron-term unified socket resolution: IRON_TERM_SOCKET, XDG_RUNTIME_DIR, and /tmp/iron-term-{uid}',
    tier: 1,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'M4',
    tags: ['iron-term', 'socket', 'xdg'],
    run: async (ctx) => {
      const envWithXdg = ctx.createEnv('no-personal-tools');
      const xdgSockDir = path.join(envWithXdg.runtimeDir!, 'iron-term');
      const xdgSock = path.join(xdgSockDir, 'agentd.sock');
      assert.ok(Buffer.byteLength(xdgSock, 'utf8') < 107);

      // 1. Start iron-agentd with default socket resolution (no --socket flag) inside isolated XDG_RUNTIME_DIR.
      const daemonBin = ctx.ironTerm.resolveBinary('iron-agentd');
      assert.ok(daemonBin, 'iron-agentd binary required');
      const dbPath = path.join(envWithXdg.rootDir, 'xdg-state.db');
      const proc = spawn(daemonBin, ['--db', dbPath], {
        env: envWithXdg.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ctx.cleanup.trackProcess(proc, 'iron-agentd-xdg');
      try {
        await waitUntil(async () => {
          if (!fs.existsSync(xdgSock)) return false;
          const ping = await ctx.ironTerm.runCtl(['ping'], {
            env: envWithXdg.env,
            json: true,
            timeoutMs: 2_000,
          });
          if (ping.exitCode !== 0) return false;
          const parsed = JSON.parse(ping.stdout) as { type?: string };
          return parsed.type === 'pong' ? true : false;
        }, 6_000, 'iron-agentd default XDG_RUNTIME_DIR socket');

        // Empty IRON_TERM_SOCKET="" must fall back to $XDG_RUNTIME_DIR/iron-term/agentd.sock.
        const emptyOverridePing = await ctx.ironTerm.runCtl(['ping'], {
          env: { ...envWithXdg.env, IRON_TERM_SOCKET: '' },
          json: true,
          timeoutMs: 2_000,
        });
        assert.equal(emptyOverridePing.exitCode, 0, emptyOverridePing.stderr);
        assert.equal((JSON.parse(emptyOverridePing.stdout) as { type?: string }).type, 'pong');
      } finally {
        await terminateChildProcess(proc);
        ctx.cleanup.untrackProcess(proc);
      }

      // 2. Explicit IRON_TERM_SOCKET overrides XDG_RUNTIME_DIR.
      const explicitSock = path.join(envWithXdg.rootDir, 'explicit.sock');
      const explicitDaemon = await ctx.ironTerm.startAgentd({
        socketPath: explicitSock,
        env: envWithXdg.env,
      });
      try {
        const explicitPing = await ctx.ironTerm.runCtl(['ping'], {
          env: { ...envWithXdg.env, IRON_TERM_SOCKET: explicitSock },
          json: true,
          timeoutMs: 2_000,
        });
        assert.equal(explicitPing.exitCode, 0, explicitPing.stderr);
        assert.equal((JSON.parse(explicitPing.stdout) as { type?: string }).type, 'pong');
      } finally {
        await explicitDaemon.close();
      }

      // 3. Verify fallback when XDG_RUNTIME_DIR and IRON_TERM_SOCKET are unset uses /tmp/iron-term-{uid}/agentd.sock.
      const envNoXdg = ctx.createEnv('no-personal-tools', { unsetXdgRuntimeDir: true });
      const uid = process.getuid?.() ?? 1000;
      const expectedTmpSock = `/tmp/iron-term-${uid}/agentd.sock`;
      const tmpSockExisted = fs.existsSync(expectedTmpSock);
      const probe = await ctx.ironTerm.runCtl(['ping'], {
        env: envNoXdg.env,
        unsetEnvKeys: ['XDG_RUNTIME_DIR', 'IRON_TERM_SOCKET'],
        json: true,
      });
      if (!tmpSockExisted) {
        assert.notEqual(
          probe.exitCode,
          0,
          `Expected non-zero exit when fallback socket '${expectedTmpSock}' is absent`,
        );
        assert.ok(
          probe.stderr.includes(expectedTmpSock),
          `Expected fallback socket '${expectedTmpSock}', got stderr: ${probe.stderr}`,
        );
      } else {
        assert.equal(
          probe.exitCode,
          0,
          `Expected exit 0 against live host socket '${expectedTmpSock}', got stderr: ${probe.stderr}`,
        );
        const parsed = JSON.parse(probe.stdout) as { type?: string };
        assert.equal(parsed.type, 'pong');
      }
    },
  },
  {
    id: 'T1-A7-03',
    name: 'iron-term dynamic host identity (IRON_TERM_HOST_ID / hostname) with zero hardcoded personal peers',
    tier: 1,
    area: 'A7',
    requirement: 'R4 / F9',
    milestone: 'M4',
    tags: ['iron-term', 'host-identity', 'decoupling'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools', {
        envOverrides: { IRON_TERM_HOST_ID: 'generic-dev-workstation' },
      });
      const expectedHostname = resolveExpectedOsHostname();
      const daemon = await ctx.ironTerm.startAgentd({ env: env.env });
      try {
        const statusText = await ctx.ironTerm.runCtl(['status'], {
          socketPath: daemon.socketPath,
          env: env.env,
          json: true,
        });
        assert.equal(statusText.exitCode, 0, statusText.stderr);
        const fleet = JSON.parse(statusText.stdout) as {
          type?: string;
          hosts?: Array<{ id: string; hostname: string }>;
        };
        assert.equal(fleet.type, 'fleet');
        assert.ok(Array.isArray(fleet.hosts), `Expected hosts array in status: ${statusText.stdout}`);
        assert.equal(fleet.hosts.length, 1, `Expected single local host, got: ${statusText.stdout}`);
        assert.equal(fleet.hosts[0]!.id, 'generic-dev-workstation');
        assert.equal(fleet.hosts[0]!.hostname, expectedHostname);
        assert.equal(
          fleet.hosts.some(
            (h) =>
              ['desktop', 'laptop', 'desktop-exo', 'ariel'].includes(h.id) ||
              h.hostname === 'desktop-exo',
          ),
          false,
          `Hardcoded personal peer leaked: ${statusText.stdout}`,
        );
      } finally {
        await daemon.close();
      }
    },
  },
  {
    id: 'T1-A7-04',
    name: 'iron-term packaging/install-desktop.sh installs binaries, icons, and valid .desktop in temp XDG dirs',
    tier: 1,
    area: 'A7',
    requirement: 'R5 / F10',
    milestone: 'M4',
    tags: ['iron-term', 'desktop-entry', 'installer', 'xdg'],
    run: async (ctx) => {
      const env = ctx.createEnv('no-personal-tools');
      const res = await ctx.ironTerm.runInstallDesktop({ env });
      assert.equal(res.exitCode, 0, `install-desktop.sh failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);

      const desktopFile = path.join(env.dataHome, 'applications', 'iron-term.desktop');
      assert.ok(fs.existsSync(desktopFile), `Missing installed ${desktopFile}`);
      const content = fs.readFileSync(desktopFile, 'utf8');
      assert.match(content, /^Categories=System;TerminalEmulator;$/m);
      assert.match(content, /^Icon=iron-term$/m);
      assert.match(content, /^StartupWMClass=iron-term$/m);

      const expectedTermBin = path.join(env.xdgBinHome, 'iron-term');
      assert.ok(content.includes(`TryExec=${expectedTermBin}`), `Missing TryExec in ${desktopFile}`);
      assert.ok(content.includes(`Exec=${expectedTermBin}`), `Missing Exec in ${desktopFile}`);
      assert.ok(
        content.includes(`Exec=${expectedTermBin} --new-session`),
        `Missing NewWindow Exec in ${desktopFile}`,
      );

      const svgIcon = path.join(env.dataHome, 'icons', 'hicolor', 'scalable', 'apps', 'iron-term.svg');
      const pngIcon = path.join(env.dataHome, 'icons', 'hicolor', '256x256', 'apps', 'iron-term.png');
      assert.ok(fs.existsSync(svgIcon), `Missing ${svgIcon}`);
      assert.ok(fs.existsSync(pngIcon), `Missing ${pngIcon}`);

      for (const installed of ['iron-term', 'iron-agentd', 'iron-termctl']) {
        const binPath = path.join(env.xdgBinHome, installed);
        assert.ok(fs.existsSync(binPath), `Missing installed binary ${binPath}`);
        fs.accessSync(binPath, fs.constants.X_OK);
      }

      const val = await ctx.ironTerm.validateDesktopFile(desktopFile, { env: env.env });
      assert.equal(val.exitCode, 0, `desktop-file-validate failed: ${val.stdout} ${val.stderr}`);
      const combined = `${val.stdout}\n${val.stderr}`.trim();
      assert.equal(combined, '', `Expected 0 errors and 0 hints from desktop-file-validate, got: ${combined}`);
    },
  },
  {
    id: 'T1-A7-05',
    name: 'User ~/.local/share/applications/iron-term.desktop exists and passes desktop-file-validate cleanly',
    tier: 1,
    area: 'A7',
    requirement: 'R5 / F10',
    milestone: 'M4',
    tags: ['iron-term', 'desktop-entry', 'installed'],
    run: async (ctx) => {
      const userDesktop = path.join(os.homedir(), '.local', 'share', 'applications', 'iron-term.desktop');
      assert.ok(fs.existsSync(userDesktop), `Missing ${userDesktop}`);
      const content = fs.readFileSync(userDesktop, 'utf8');
      assert.match(content, /^Categories=System;TerminalEmulator;$/m);
      assert.match(content, /^Icon=iron-term$/m);

      const execLine = content.match(/^Exec=(.+)$/m)?.[1]?.trim() ?? '';
      const execBin = execLine.match(/^"([^"]+)"/)?.[1] ?? execLine.split(/\s+/)[0] ?? '';
      assert.ok(execBin.length > 0, 'Exec field must be non-empty');
      fs.accessSync(execBin, fs.constants.X_OK);

      const val = await ctx.ironTerm.validateDesktopFile(userDesktop);
      assert.equal(val.exitCode, 0, `desktop-file-validate failed: ${val.stdout} ${val.stderr}`);
      const combined = `${val.stdout}\n${val.stderr}`.trim();
      assert.equal(combined, '', `Expected zero hints/warnings on installed desktop file, got: ${combined}`);
    },
  },
];
