import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IronAgentDockApi } from '../src/preload/agent-preload';
import {
  AgentDockManager,
  detectAvailableAgentClis,
  isSafeCliToken,
  resolveExecutableOnPath,
  resolveIronTermSocketPath,
} from '../src/main/agent-dock';
import { extractOzonePlatformArg, resolveOzoneSwitchConfig } from '../src/main/ozone';
import { mountAgentDock } from '../src/renderer/agent-dock';
import { encodeFrame, FrameDecoder } from '../src/shared/frame';
import type { AgentCliOption, RunningAgentInstance } from '../src/shared/types';

function makeStubWindow() {
  return {
    isDestroyed: () => false,
    getContentSize: () => [1480, 920],
    contentView: {
      addChildView: () => {},
      removeChildView: () => {},
    },
  } as any;
}

describe('M3 F7 Setup-Agnostic Decoupling', () => {
  test('isSafeCliToken and resolveExecutableOnPath validate PATH executables safely', () => {
    expect(isSafeCliToken('claude')).toBe(true);
    expect(isSafeCliToken('custom-cli_1.0')).toBe(true);
    expect(isSafeCliToken('')).toBe(false);
    expect(isSafeCliToken('.')).toBe(false);
    expect(isSafeCliToken('..')).toBe(false);
    expect(isSafeCliToken('; rm -rf /')).toBe(false);
    expect(isSafeCliToken('foo/bar')).toBe(false);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cli-probe-'));
    try {
      const execPath = path.join(tmpDir, 'aider');
      const nonExecPath = path.join(tmpDir, 'not-exec');
      fs.writeFileSync(execPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      fs.writeFileSync(nonExecPath, '#!/bin/sh\necho no\n', { mode: 0o644 });

      expect(resolveExecutableOnPath('aider', tmpDir)).toBe(execPath);
      expect(resolveExecutableOnPath('not-exec', tmpDir)).toBeNull();
      expect(resolveExecutableOnPath('missing', tmpDir)).toBeNull();
      expect(resolveExecutableOnPath('aider', '')).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('detectAvailableAgentClis probes PATH, sanitizes IRON_BROWSER_AGENT_CLIS, and always keeps shell', () => {
    const emptyPath = detectAvailableAgentClis({ PATH: '' });
    expect(emptyPath).toEqual([
      { id: 'shell', label: 'shell', preset: 'shell', available: true, source: 'shell' },
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cli-detect-'));
    try {
      for (const name of ['claude', 'aider']) {
        fs.writeFileSync(path.join(tmpDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }

      const defaultDetected = detectAvailableAgentClis({ PATH: tmpDir });
      expect(defaultDetected.map((c) => c.id)).toEqual(['claude', 'shell']);

      const commasOnlyFallback = detectAvailableAgentClis({
        PATH: tmpDir,
        IRON_BROWSER_AGENT_CLIS: ' , , ',
      });
      expect(commasOnlyFallback.map((c) => c.id)).toEqual(['claude', 'shell']);

      const whitespaceOnlyFallback = detectAvailableAgentClis({
        PATH: tmpDir,
        IRON_BROWSER_AGENT_CLIS: '   ',
      });
      expect(whitespaceOnlyFallback.map((c) => c.id)).toEqual(['claude', 'shell']);

      const customDetected = detectAvailableAgentClis({
        PATH: tmpDir,
        IRON_BROWSER_AGENT_CLIS: ' , ;;nonexistent-999, aider, claude, shell, aider ',
      });
      expect(customDetected).toEqual([
        {
          id: 'aider',
          label: 'aider',
          preset: 'custom',
          command: 'aider',
          available: true,
          source: 'env',
        },
        {
          id: 'claude',
          label: 'claude',
          preset: 'claude',
          available: true,
          source: 'builtin',
        },
        {
          id: 'shell',
          label: 'shell',
          preset: 'shell',
          available: true,
          source: 'shell',
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('startCliAgent shell preset falls back to /bin/sh when SHELL is empty', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '';
    const spawned: Array<{ program: string; args: string[] }> = [];
    const mgr = new AgentDockManager(
      makeStubWindow(),
      '',
      '',
      {
        getSocketPath: () => '/tmp/ib-test.sock',
        getActiveTabId: () => null,
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        ptyBinding: {
          ptySpawn: (raw: string) => {
            const parsed = JSON.parse(raw) as { program: string; args: string[] };
            spawned.push({ program: parsed.program, args: parsed.args });
            return JSON.stringify({ ok: true, id: 1, pid: 4242 });
          },
          ptyPoll: () => JSON.stringify({ ok: true, dataB64: '', exited: false, exitCode: null }),
          ptyWrite: () => JSON.stringify({ ok: true, bytesWritten: 1 }),
          ptyResize: () => true,
          ptyKill: () => true,
        },
      },
    );

    try {
      const state = mgr.startCliAgent({ preset: 'shell' });
      expect(state.session.active).toBe(true);
      expect(state.session.kind).toBe('pty');
      expect(state.session.label).toBe('sh');
      expect(spawned).toEqual([{ program: '/bin/sh', args: ['-i'] }]);
    } finally {
      mgr.dispose();
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
    }
  });

  test('resolveIronTermSocketPath respects IRON_TERM_SOCKET, XDG_RUNTIME_DIR, and /tmp fallback', () => {
    expect(
      resolveIronTermSocketPath(
        { IRON_TERM_SOCKET: ' /custom/agentd.sock ', XDG_RUNTIME_DIR: '/run/user/1000' },
        1000,
      ),
    ).toBe('/custom/agentd.sock');
    expect(resolveIronTermSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(
      '/run/user/1000/iron-term/agentd.sock',
    );
    expect(resolveIronTermSocketPath({}, 1000)).toBe('/tmp/iron-term-1000/agentd.sock');
  });

  test('listRunningInstances returns [] cleanly when tmux is ENOENT and iron-term socket is absent', async () => {
    const mgr = new AgentDockManager(
      makeStubWindow(),
      '',
      '',
      {
        getSocketPath: () => '/tmp/ib-test.sock',
        getActiveTabId: () => null,
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        ptyBinding: null,
        ironTermSocketPath: '/tmp/nonexistent-iron-term-agentd-999999.sock',
        execFile: async () => {
          const err = new Error('spawn tmux ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        },
      },
    );

    try {
      const instances = await mgr.listRunningInstances();
      expect(instances).toEqual([]);
      await expect(mgr.attachRunningInstance('; rm -rf /')).rejects.toThrow();
    } finally {
      mgr.dispose();
    }
  });

  test('iron-term adapter discovers, attaches, streams interleaved grid_delta, writes with 20ms submit yield, resizes, and detaches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-it-rpc-'));
    const sockPath = path.join(tmpDir, 'agentd.sock');
    const receivedMsgs: Array<{ id: number; msg: any; ts: number }> = [];
    let activeSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      activeSocket = socket;
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        const frames = decoder.push(chunk) as Array<{ id: number; msg: any }>;
        for (const req of frames) {
          receivedMsgs.push({ id: req.id, msg: req.msg, ts: performance.now() });
          if (req.msg.type === 'list_fleet') {
            // Emit an interleaved event before the RPC response to verify frame filtering.
            socket.write(
              encodeFrame({
                kind: 'event',
                event: { event: 'fleet_delta', hosts: [], sessions: [], overhead: {} },
              }),
            );
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: {
                  type: 'fleet',
                  hosts: [],
                  sessions: [
                    {
                      id: 'sess-live-1',
                      title: 'worker-alpha',
                      cli: 'claude',
                      worktree_path: '/tmp/worktree-a',
                      state: 'running',
                    },
                    {
                      id: 'sess-sleep-2',
                      title: 'hibernated-one',
                      cli: 'codex',
                      worktree_path: '/tmp/worktree-b',
                      state: 'hibernated',
                    },
                  ],
                  overhead: {},
                },
              }),
            );
          } else if (req.msg.type === 'attach_pty') {
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: {
                  type: 'attached',
                  snapshot: {
                    session_id: req.msg.session_id,
                    seq: 1,
                    cols: req.msg.cols,
                    rows: req.msg.rows,
                    cursor_col: 0,
                    cursor_row: 1,
                    lines: [
                      { row: 0, text: 'IRON_TERM_INITIAL_LINE' },
                      { row: 1, text: '' },
                    ],
                  },
                },
              }),
            );
          } else if (req.msg.type === 'inspect_session') {
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: {
                  type: 'inspection',
                  inspection: {
                    session: {
                      id: req.msg.session_id,
                      title: 'worker-alpha',
                      worktree_path: '/tmp/worktree-a',
                    },
                  },
                },
              }),
            );
          } else {
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: { type: 'ok' },
              }),
            );
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const sentOutput: Array<{ chunk: string; replace: boolean }> = [];
    const fakeWin = makeStubWindow();
    const mgr = new AgentDockManager(
      fakeWin,
      '',
      '',
      {
        getSocketPath: () => '/tmp/ib-test.sock',
        getActiveTabId: () => null,
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        ptyBinding: null,
        ironTermSocketPath: sockPath,
        execFile: async (_file, args) => {
          if (args[0] === 'list-panes') {
            return { stdout: 'dev:0.0\tagent\tclaude\t/tmp/repo\t1234\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      },
    );
    (mgr as any).view = {
      webContents: {
        isDestroyed: () => false,
        send: (ch: string, payload: any) => {
          if (ch === 'agent:output') sentOutput.push(payload);
        },
      },
    };

    try {
      const instances = await mgr.listRunningInstances();
      expect(instances.length).toBe(2);
      const itInst = instances.find((i) => i.kind === 'iron-term');
      const tmuxInst = instances.find((i) => i.kind === 'tmux');
      expect(itInst).toEqual({
        kind: 'iron-term',
        target: 'iron-term:sess-live-1',
        sessionId: 'sess-live-1',
        windowName: 'worker-alpha',
        command: 'claude',
        cwd: '/tmp/worktree-a',
        pid: 0,
        isAgentLike: true,
        state: 'running',
      });
      expect(tmuxInst?.target).toBe('dev:0.0');

      const st = await mgr.attachRunningInstance('iron-term:sess-live-1');
      expect(st.session.active).toBe(true);
      expect(st.session.kind).toBe('iron-term');
      expect(st.session.label).toBe('iron-term worker-alpha');
      expect(st.session.cwd).toBe('/tmp/worktree-a');
      expect(sentOutput.at(-1)?.chunk).toBe('IRON_TERM_INITIAL_LINE');

      // Stream live grid_delta event from mock daemon
      activeSocket!.write(
        encodeFrame({
          kind: 'event',
          event: {
            event: 'grid_delta',
            snapshot: {
              session_id: 'sess-live-1',
              seq: 2,
              cols: 92,
              rows: 30,
              cursor_col: 0,
              cursor_row: 1,
              lines: [{ row: 0, text: 'IRON_TERM_STREAMED_UPDATE' }],
            },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 25));
      expect(sentOutput.at(-1)?.chunk).toBe('IRON_TERM_STREAMED_UPDATE');

      const okWrite = await mgr.writeInput('hello agent', true);
      expect(okWrite).toBe(true);
      const inputMsgs = receivedMsgs.filter((m) => m.msg.type === 'pty_input');
      expect(inputMsgs.length).toBe(2);
      expect(Buffer.from(inputMsgs[0]!.msg.bytes).toString('utf8')).toBe('hello agent');
      expect(inputMsgs[1]!.msg.bytes).toEqual([13]);
      expect(inputMsgs[1]!.ts - inputMsgs[0]!.ts).toBeGreaterThanOrEqual(15);

      const okInterrupt = await mgr.sendSpecialKey('Interrupt');
      expect(okInterrupt).toBe(true);
      expect(receivedMsgs.at(-1)?.msg).toEqual({
        type: 'pty_input',
        session_id: 'sess-live-1',
        bytes: [3],
      });

      expect(mgr.resizePty(120, 40)).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(receivedMsgs.some((m) => m.msg.type === 'pty_resize' && m.msg.cols === 120)).toBe(true);

      const stopped = mgr.stopSession();
      expect(stopped.session.active).toBe(false);
      await new Promise((r) => setTimeout(r, 25));
      expect(receivedMsgs.some((m) => m.msg.type === 'detach_pty')).toBe(true);
    } finally {
      mgr.dispose();
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('renderer mountAgentDock dynamically renders availableClis and iron-term instances without innerHTML', async () => {
    class MockClassList {
      private readonly set = new Set<string>();
      add(...t: string[]) {
        for (const x of t) if (x) this.set.add(x);
      }
      remove(...t: string[]) {
        for (const x of t) this.set.delete(x);
      }
      toggle(tok: string, force?: boolean) {
        if (force === true) {
          this.set.add(tok);
          return true;
        }
        if (force === false) {
          this.set.delete(tok);
          return false;
        }
        if (this.set.has(tok)) {
          this.set.delete(tok);
          return false;
        }
        this.set.add(tok);
        return true;
      }
      contains(tok: string) {
        return this.set.has(tok);
      }
    }

    class MockEl {
      id = '';
      value = '';
      textContent = '';
      innerHTML = '';
      type = '';
      disabled = false;
      className = '';
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      children: MockEl[] = [];
      classList = new MockClassList();
      listeners = new Map<string, Array<(ev: any) => void>>();
      addEventListener(type: string, fn: (ev: any) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      removeEventListener(type: string, fn: (ev: any) => void) {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter((f) => f !== fn));
      }
      click() {
        for (const fn of this.listeners.get('click') ?? []) fn({});
      }
      focus() {}
      contains() {
        return false;
      }
      appendChild(node: MockEl) {
        this.children.push(node);
        return node;
      }
      append(...nodes: MockEl[]) {
        this.children.push(...nodes);
      }
      replaceChildren(...nodes: MockEl[]) {
        this.children = [...nodes];
      }
      querySelector() {
        return null;
      }
    }

    const byId = new Map<string, MockEl>();
    for (const id of [
      'dock-root',
      'status-dot',
      'session-badge',
      'btn-format-md',
      'btn-mode-docked',
      'btn-mode-floating',
      'btn-mode-min',
      'dock-drag-bar',
      'tab-running',
      'tab-start',
      'pane-running',
      'pane-start',
      'preset-chips',
      'btn-refresh-instances',
      'btn-disconnect',
      'instance-list',
      'input-cwd',
      'custom-cli-form',
      'input-custom-cli',
      'terminal-wrap',
      'terminal-screen',
      'btn-insert-context',
      'composer-status',
      'chat-form',
      'chat-input',
      'btn-send',
    ]) {
      const el = new MockEl();
      el.id = id;
      byId.set(id, el);
    }

    const fakeDoc: any = {
      body: { style: {} },
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelector: () => byId.get('dock-root') ?? null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createDocumentFragment: () => new MockEl(),
      createElement: () => new MockEl(),
      createTextNode: (t: string) => ({ textContent: t }),
    };

    const startedClis: Array<{ preset: string; customCommand?: string }> = [];
    const availableClis: AgentCliOption[] = [
      { id: 'aider', label: 'aider', preset: 'custom', command: 'aider', available: true, source: 'env' },
      { id: 'shell', label: 'shell', preset: 'shell', available: true, source: 'shell' },
    ];
    const instances: RunningAgentInstance[] = [
      {
        kind: 'iron-term',
        target: 'iron-term:sess-1',
        sessionId: 'sess-1',
        windowName: 'my-session',
        command: 'claude',
        cwd: '/tmp/proj',
        pid: 0,
        isAgentLike: true,
        state: 'running',
      },
    ];

    const fakeApi: IronAgentDockApi = {
      getInitial: async () => ({
        state: {
          mode: 'docked',
          width: 360,
          floatBounds: { x: 100, y: 60, width: 400, height: 500 },
          session: { active: false, kind: 'none', label: 'Idle', socketPath: '/tmp/test.sock' },
        },
        transcript: '',
        instances,
        defaultCwd: '/tmp',
        contextSnippet: '',
        availableClis,
      }),
      listInstances: async () => instances,
      startCli: async (opts) => {
        startedClis.push({ preset: opts.preset, customCommand: opts.customCommand });
        return {
          mode: 'docked',
          width: 360,
          floatBounds: { x: 100, y: 60, width: 400, height: 500 },
          session: { active: true, kind: 'pty', label: opts.customCommand || opts.preset, socketPath: '/tmp/test.sock' },
        };
      },
      attachInstance: async () => {
        throw new Error('unused');
      },
      stop: async () => {
        throw new Error('unused');
      },
      write: async () => true,
      sendSpecialKey: async () => true,
      resize: async () => true,
      setMode: async () => {
        throw new Error('unused');
      },
      setFloatBounds: async () => {
        throw new Error('unused');
      },
      getContext: async () => '',
      onState: () => () => {},
      onOutput: () => () => {},
      onInjectContext: () => () => {},
    };

    mountAgentDock(fakeDoc, fakeApi, { getSelection: () => null, addEventListener: () => {} } as any);
    await new Promise((r) => setTimeout(r, 15));

    const chips = byId.get('preset-chips')!.children;
    expect(chips.map((c) => c.dataset.preset)).toEqual(['aider', 'shell']);
    chips[0]!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(startedClis).toEqual([{ preset: 'custom', customCommand: 'aider' }]);

    const instBtn = byId.get('instance-list')!.children[0]!;
    expect(instBtn.children[0]!.children[0]!.textContent).toBe('my-session · sess-1');
    expect(instBtn.children[1]!.textContent).toBe('iron-term · claude');
  });

  test('resolveOzoneSwitchConfig handles headless, Wayland-only, X11, and explicit flags cleanly', () => {
    const headless = resolveOzoneSwitchConfig(['electron', '.', '--smoke'], {}, true);
    expect(headless.isHeadlessOzone).toBe(true);
    expect(headless.switches).toContainEqual(['ozone-platform', 'headless']);
    expect(headless.switches).toContainEqual(['ozone-override-screen-size', '1480,920']);
    expect(headless.switches).toContainEqual(['enable-features', 'UseOzonePlatform']);
    expect(headless.switches.some(([k]) => k === 'ozone-platform-hint')).toBe(false);

    const waylandOnly = resolveOzoneSwitchConfig(
      ['electron', '.'],
      { WAYLAND_DISPLAY: 'wayland-1' },
      false,
    );
    expect(waylandOnly.isHeadlessOzone).toBe(false);
    expect(waylandOnly.switches).toContainEqual(['ozone-platform-hint', 'auto']);
    expect(waylandOnly.switches).toContainEqual([
      'enable-features',
      'UseOzonePlatform,WaylandWindowDecorations',
    ]);

    const explicitHeadlessWithDisplay = resolveOzoneSwitchConfig(
      ['electron', '.', '--ozone-platform=headless'],
      { DISPLAY: ':1' },
      true,
    );
    expect(explicitHeadlessWithDisplay.isHeadlessOzone).toBe(true);
    expect(explicitHeadlessWithDisplay.switches.some(([k]) => k === 'ozone-platform')).toBe(false);
    expect(explicitHeadlessWithDisplay.switches).toContainEqual([
      'ozone-override-screen-size',
      '1480,920',
    ]);

    expect(extractOzonePlatformArg(['electron', '.', '--ozone-platform', '--smoke'])).toBeNull();
    expect(extractOzonePlatformArg(['electron', '.', '--ozone-platform', '-x'])).toBeNull();
    expect(extractOzonePlatformArg(['electron', '.', '--ozone-platform='])).toBeNull();
    expect(
      extractOzonePlatformArg(['electron', '.', '--ozone-platform', '--smoke', '--ozone-platform=wayland']),
    ).toBe('wayland');
    expect(extractOzonePlatformArg(['electron', '.', '--ozone-platform', 'headless'])).toBe('headless');

    const malformedFlagHeadless = resolveOzoneSwitchConfig(
      ['electron', '.', '--ozone-platform', '--smoke'],
      {},
      true,
    );
    expect(malformedFlagHeadless.explicitOzonePlatform).toBeNull();
    expect(malformedFlagHeadless.isHeadlessOzone).toBe(true);
    expect(malformedFlagHeadless.switches).toContainEqual(['ozone-platform', 'headless']);
  });

  test('resizePty and agent:resize reject NaN and Infinity without emitting pty_resize or disconnecting iron-term', async () => {
    const ptyResizeCalls: Array<[number, number, number]> = [];
    const ptyMgr = new AgentDockManager(
      makeStubWindow(),
      '',
      '',
      {
        getSocketPath: () => '/tmp/ib-test.sock',
        getActiveTabId: () => null,
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        ptyBinding: {
          ptySpawn: () => JSON.stringify({ ok: true, id: 7, pid: 7777 }),
          ptyPoll: () => JSON.stringify({ ok: true, dataB64: '', exited: false, exitCode: null }),
          ptyWrite: () => JSON.stringify({ ok: true, bytesWritten: 1 }),
          ptyResize: (id: number, cols: number, rows: number) => {
            ptyResizeCalls.push([id, cols, rows]);
            return true;
          },
          ptyKill: () => true,
        },
      },
    );

    try {
      ptyMgr.startCliAgent({ preset: 'shell' });
      expect(ptyMgr.resizePty(Number.NaN, 24)).toBe(false);
      expect(ptyMgr.resizePty(80, Number.POSITIVE_INFINITY)).toBe(false);
      expect(ptyMgr.resizePty(Number.NEGATIVE_INFINITY, 24)).toBe(false);
      expect(ptyResizeCalls).toEqual([]);
      expect(ptyMgr.resizePty(80, 24)).toBe(true);
      expect(ptyResizeCalls).toEqual([[7, 80, 24]]);
    } finally {
      ptyMgr.dispose();
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-it-resize-'));
    const sockPath = path.join(tmpDir, 'agentd.sock');
    const receivedMsgs: Array<{ id: number; msg: any }> = [];

    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        const frames = decoder.push(chunk) as Array<{ id: number; msg: any }>;
        for (const req of frames) {
          receivedMsgs.push({ id: req.id, msg: req.msg });
          if (req.msg.type === 'attach_pty') {
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: {
                  type: 'attached',
                  snapshot: {
                    session_id: req.msg.session_id,
                    seq: 1,
                    cols: req.msg.cols,
                    rows: req.msg.rows,
                    cursor_col: 0,
                    cursor_row: 0,
                    lines: [{ row: 0, text: 'READY' }],
                  },
                },
              }),
            );
          } else if (req.msg.type === 'inspect_session') {
            socket.write(
              encodeFrame({
                kind: 'response',
                id: req.id,
                response: {
                  type: 'inspection',
                  inspection: { session: { id: req.msg.session_id, title: 'resize-check' } },
                },
              }),
            );
          } else if (req.msg.type === 'pty_resize') {
            if (typeof req.msg.cols !== 'number' || typeof req.msg.rows !== 'number') {
              socket.destroy();
              return;
            }
            socket.write(encodeFrame({ kind: 'response', id: req.id, response: { type: 'ok' } }));
          } else {
            socket.write(encodeFrame({ kind: 'response', id: req.id, response: { type: 'ok' } }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const mgr = new AgentDockManager(
      makeStubWindow(),
      '',
      '',
      {
        getSocketPath: () => '/tmp/ib-test.sock',
        getActiveTabId: () => null,
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {},
      },
      {
        ptyBinding: null,
        ironTermSocketPath: sockPath,
      },
    );
    const mainFrame = { url: '' };
    (mgr as any).view = {
      webContents: {
        id: 101,
        mainFrame,
        isDestroyed: () => false,
        send: () => {},
      },
    };
    const handlers = new Map<string, (ev: any, raw: unknown) => unknown>();
    mgr.registerIpcHandlers({
      handle: (channel: string, listener: (ev: any, raw: unknown) => unknown) => {
        handlers.set(channel, listener);
      },
    } as any);

    try {
      await mgr.attachRunningInstance('iron-term:sess-resize-1');
      const fakeEv = { sender: { id: 101 }, senderFrame: mainFrame };
      const resizeHandler = handlers.get('agent:resize')!;
      expect(typeof resizeHandler).toBe('function');

      expect(mgr.resizePty(Number.NaN, 24)).toBe(false);
      expect(mgr.resizePty(80, Number.POSITIVE_INFINITY)).toBe(false);
      expect(resizeHandler(fakeEv, { cols: Number.NaN, rows: 24 })).toBe(false);
      expect(resizeHandler(fakeEv, { cols: 'abc', rows: 24 })).toBe(false);
      expect(resizeHandler(fakeEv, { cols: 80, rows: Number.POSITIVE_INFINITY })).toBe(false);

      await new Promise((r) => setTimeout(r, 20));
      expect(receivedMsgs.some((m) => m.msg.type === 'pty_resize')).toBe(false);

      expect(await mgr.writeInput('still-connected', false)).toBe(true);
      expect(resizeHandler(fakeEv, { cols: 100, rows: 32 })).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(
        receivedMsgs.some(
          (m) => m.msg.type === 'pty_resize' && m.msg.cols === 100 && m.msg.rows === 32,
        ),
      ).toBe(true);
    } finally {
      mgr.dispose();
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
