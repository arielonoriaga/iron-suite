import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  App,
  BrowserWindow as BrowserWindowType,
  Clipboard,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  WebContentsView as WebContentsViewType,
} from 'electron';

function loadElectronRuntime(): {
  app?: App;
  clipboard?: Clipboard;
  dialog?: Dialog;
  ipcMain?: IpcMain;
  WebContentsView?: typeof WebContentsViewType;
} {
  try {
    const mod =
      typeof require === 'function'
        ? require('electron')
        : createRequire(path.join(__dirname, 'index.js'))('electron');
    if (mod && typeof mod === 'object') {
      return mod as {
        app?: App;
        clipboard?: Clipboard;
        dialog?: Dialog;
        ipcMain?: IpcMain;
        WebContentsView?: typeof WebContentsViewType;
      };
    }
  } catch {
    // Running outside Electron runtime (e.g. unit test VM).
  }
  return {};
}
import { stripAnsiAll } from '../shared/agent-markdown';
import {
  clampAnchoredFloatBoundsUpdate,
  DEFAULT_AGENT_DOCK_WIDTH,
  MIN_AGENT_FLOAT_HEIGHT,
  MIN_AGENT_FLOAT_WIDTH,
} from '../shared/layout';
import type {
  AgentCliOption,
  AgentCliPreset,
  AgentDockMode,
  AgentDockState,
  AgentSessionSnapshot,
  Rect,
  RunningAgentInstance,
} from '../shared/types';
import {
  formatIronTermGridSnapshot,
  IronTermSessionConnection,
  listIronTermInstances,
  resolveIronTermSocketPath,
} from './iron-term-client';
import { loadNativePtyBinding, reserveSafeDownloadPath, type NativePtyBinding } from './tab-event-bus';

export { listIronTermInstances, resolveIronTermSocketPath };

const execFileAsync = promisify(execFile);

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const MAX_TRANSCRIPT_CHARS = 180_000;
const MAX_PTY_WRITE_CHUNK_BYTES = 32 * 1024;
const MAX_PTY_QUEUE_BYTES = 256 * 1024;
const PTY_SUBMIT_YIELD_MS = 20;
const PANE_TARGET_RE = /^[A-Za-z0-9_.-]+:[0-9]+\.[0-9]+$/;
const IRON_TERM_ID_RE = /^[A-Za-z0-9_.-]+$/;
const CLI_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const BUILTIN_AGENT_CLIS = ['agy', 'claude', 'codex', 'opencode'] as const;
const BUILTIN_AGENT_CLI_SET = new Set<string>(BUILTIN_AGENT_CLIS);
const AGENT_CMDS = new Set([
  'agy',
  'claude',
  'codex',
  'opencode',
  'iron',
  'iron-term',
  'bun',
  'node',
]);

export function isSafeCliToken(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 64 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    CLI_TOKEN_RE.test(trimmed)
  );
}

export function resolveExecutableOnPath(
  cmd: string,
  pathEnv: string | undefined = process.env.PATH,
): string | null {
  if (!isSafeCliToken(cmd) || !pathEnv) return null;
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

export function detectAvailableAgentClis(
  env: NodeJS.ProcessEnv = process.env,
): AgentCliOption[] {
  const rawOverride = env.IRON_BROWSER_AGENT_CLIS?.trim();
  const rawParts = rawOverride
    ? rawOverride
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];
  const candidates: Array<{ token: string; source: 'builtin' | 'env' }> = [];
  const seen = new Set<string>();

  if (rawParts.length > 0) {
    for (const tok of rawParts) {
      if (!isSafeCliToken(tok) || tok === 'shell' || seen.has(tok)) continue;
      seen.add(tok);
      candidates.push({
        token: tok,
        source: BUILTIN_AGENT_CLI_SET.has(tok) ? 'builtin' : 'env',
      });
    }
  } else {
    for (const tok of BUILTIN_AGENT_CLIS) {
      seen.add(tok);
      candidates.push({ token: tok, source: 'builtin' });
    }
  }

  const options: AgentCliOption[] = [];
  for (const { token, source } of candidates) {
    if (!resolveExecutableOnPath(token, env.PATH)) continue;
    const isBuiltin = BUILTIN_AGENT_CLI_SET.has(token);
    options.push({
      id: token,
      label: token,
      preset: isBuiltin ? (token as AgentCliPreset) : 'custom',
      ...(isBuiltin ? {} : { command: token }),
      available: true,
      source,
    });
  }

  options.push({
    id: 'shell',
    label: 'shell',
    preset: 'shell',
    available: true,
    source: 'shell',
  });

  return options;
}

export interface AgentDockCallbacks {
  getSocketPath(): string;
  getActiveTabId(): string | null;
  getBrowserContextSnippet(): string;
  onLayoutChanged(): void;
}

export function assertAgentSender(
  ev: IpcMainInvokeEvent,
  agentView: Pick<WebContentsViewType, 'webContents'> | null,
  expectedUrl?: string,
): void {
  if (
    !agentView ||
    agentView.webContents.isDestroyed() ||
    !ev?.sender ||
    !ev.senderFrame ||
    !agentView.webContents.mainFrame ||
    ev.sender.id !== agentView.webContents.id ||
    ev.senderFrame !== agentView.webContents.mainFrame ||
    (expectedUrl &&
      typeof ev.senderFrame.url === 'string' &&
      ev.senderFrame.url.length > 0 &&
      ev.senderFrame.url !== expectedUrl)
  ) {
    throw new Error('Unauthorized IPC sender for agent dock channel');
  }
}

export function parseTmuxListPanesOutput(stdout: string): RunningAgentInstance[] {
  const out: RunningAgentInstance[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [target = '', windowName = '', command = '', cwd = '', pidRaw = '0'] = line.split('\t');
    if (!PANE_TARGET_RE.test(target)) continue;
    const pid = Number.parseInt(pidRaw, 10) || 0;
    const cmdLower = command.toLowerCase();
    const winLower = windowName.toLowerCase();
    const isAgentLike =
      AGENT_CMDS.has(cmdLower) ||
      winLower.includes('claude') ||
      winLower.includes('agy') ||
      winLower.includes('codex') ||
      winLower.includes('opencode') ||
      winLower.includes('perf') ||
      winLower.includes('iron');
    out.push({
      kind: 'tmux',
      target,
      windowName: windowName || target,
      command: command || 'shell',
      cwd: cwd || '',
      pid,
      isAgentLike,
    });
  }
  out.sort((a, b) => {
    if (a.isAgentLike !== b.isAgentLike) return a.isAgentLike ? -1 : 1;
    return a.target.localeCompare(b.target);
  });
  return out;
}

export function resolveMcpBinaryPath(): string {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'iron-browser-mcp'),
    path.resolve(__dirname, '../../../target/release/iron-browser-mcp'),
    path.resolve(process.cwd(), '../target/release/iron-browser-mcp'),
    path.resolve(process.cwd(), 'target/release/iron-browser-mcp'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try next.
    }
  }
  return 'iron-browser-mcp';
}

export function writePerWindowMcpConfig(socketPath: string): string | null {
  try {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const cfgPath = path.join(dir, `mcp-${process.pid}.json`);
    try {
      if (fs.existsSync(cfgPath) && fs.lstatSync(cfgPath).isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }
    const payload = JSON.stringify(
      {
        mcpServers: {
          'iron-browser': {
            type: 'stdio',
            command: resolveMcpBinaryPath(),
            args: ['--socket', socketPath],
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(cfgPath, payload, { encoding: 'utf8', mode: 0o600 });
    return cfgPath;
  } catch {
    return null;
  }
}

export class AgentDockManager {
  private view: WebContentsViewType | null = null;
  private mode: AgentDockMode;
  private width = DEFAULT_AGENT_DOCK_WIDTH;
  private floatBounds: Rect = { x: 1040, y: 56, width: 400, height: 540 };
  private readonly ptyBinding: NativePtyBinding | null;

  private activePtyId: number | null = null;
  private activePtyDecoder = new TextDecoder('utf-8');
  private ptyPollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPtyWriteChunks: Buffer[] = [];
  private pendingPtyWriteBytes = 0;
  private ptyWriteFlushTimer: ReturnType<typeof setInterval> | null = null;
  private ptyDrainWaiters: Array<(ok: boolean) => void> = [];
  private ptyWriteChain: Promise<void> = Promise.resolve();
  private ptyPendingOps = 0;
  private sessionGen = 0;
  private readonly ptyDrainTimeoutMs: number;
  private mcpConfigPath: string | null = null;
  private readonly expectedAgentUrl: string;
  private readonly execFileFn: ExecFileFn;

  private attachedPane: string | null = null;
  private lastTmuxCapture = '';
  private tmuxPollTimer: ReturnType<typeof setInterval> | null = null;
  private tmuxWriteChain: Promise<void> = Promise.resolve();

  private readonly ironTermSocketOverride?: string;
  private ironTermConn: IronTermSessionConnection | null = null;
  private attachedIronTermSessionId: string | null = null;
  private lastIronTermRender = '';
  private ironTermWriteChain: Promise<void> = Promise.resolve();

  private sessionMeta: AgentSessionSnapshot;
  private transcript = '';
  private disposed = false;
  private ipcRegistered = false;

  constructor(
    private readonly win: BrowserWindowType,
    private readonly agentPreloadPath: string,
    private readonly agentHtmlPath: string,
    private readonly callbacks: AgentDockCallbacks,
    options: {
      initialMode?: AgentDockMode;
      initialFloatBounds?: Rect;
      ptyBinding?: NativePtyBinding | null;
      execFile?: ExecFileFn;
      ptyDrainTimeoutMs?: number;
      ironTermSocketPath?: string;
    } = {},
  ) {
    this.execFileFn = options.execFile ?? execFileAsync;
    this.ironTermSocketOverride = options.ironTermSocketPath;
    this.ptyDrainTimeoutMs =
      typeof options.ptyDrainTimeoutMs === 'number' &&
      Number.isFinite(options.ptyDrainTimeoutMs) &&
      options.ptyDrainTimeoutMs > 0
        ? Math.trunc(options.ptyDrainTimeoutMs)
        : 5000;
    this.mode = options.initialMode ?? 'minimized';
    if (options.initialFloatBounds) {
      const fb = options.initialFloatBounds;
      this.floatBounds = {
        x: Number.isFinite(fb.x) ? Math.round(fb.x) : this.floatBounds.x,
        y: Number.isFinite(fb.y) ? Math.round(fb.y) : this.floatBounds.y,
        width: Number.isFinite(fb.width)
          ? Math.max(MIN_AGENT_FLOAT_WIDTH, Math.round(fb.width))
          : this.floatBounds.width,
        height: Number.isFinite(fb.height)
          ? Math.max(MIN_AGENT_FLOAT_HEIGHT, Math.round(fb.height))
          : this.floatBounds.height,
      };
    }
    this.expectedAgentUrl = this.agentHtmlPath
      ? pathToFileURL(path.resolve(this.agentHtmlPath)).toString()
      : '';
    this.ptyBinding =
      options.ptyBinding !== undefined ? options.ptyBinding : loadNativePtyBinding();
    this.sessionMeta = {
      active: false,
      kind: 'none',
      label: 'Idle',
      socketPath: this.callbacks.getSocketPath(),
    };
  }

  getState(): AgentDockState {
    return {
      mode: this.mode,
      width: this.width,
      floatBounds: { ...this.floatBounds },
      session: {
        ...this.sessionMeta,
        socketPath: this.callbacks.getSocketPath(),
      },
    };
  }

  getView(): WebContentsViewType | null {
    return this.view;
  }

  ensureViewCreated(): WebContentsViewType | null {
    if (this.disposed || this.win.isDestroyed()) return null;
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }
    const WebContentsViewCtor = loadElectronRuntime().WebContentsView;
    if (typeof WebContentsViewCtor !== 'function') return null;

    const view = new WebContentsViewCtor({
      webPreferences: {
        preload: this.agentPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.view = view;

    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, targetUrl) => {
      if (this.expectedAgentUrl && targetUrl !== this.expectedAgentUrl) {
        event.preventDefault();
      }
    });
    view.webContents.on('will-redirect', (event, targetUrl) => {
      if (this.expectedAgentUrl && targetUrl !== this.expectedAgentUrl) {
        event.preventDefault();
      }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        (input.control || input.meta) &&
        !input.shift &&
        !input.alt &&
        (input.key === '`' || input.code === 'Backquote')
      ) {
        event.preventDefault();
        this.toggle();
      }
    });
    if (fs.existsSync(this.agentHtmlPath)) {
      void view.webContents.loadFile(this.agentHtmlPath).catch(() => {});
    }
    return view;
  }

  ensureTopMost(): void {
    if (!this.view || this.view.webContents.isDestroyed() || this.win.isDestroyed()) return;
    try {
      this.win.contentView.addChildView(this.view);
    } catch {
      // Ignore in stubbed unit test windows.
    }
  }

  applyBounds(rect: Rect | null): void {
    if (this.disposed || this.win.isDestroyed()) return;
    if (!rect || this.mode === 'minimized') {
      if (this.view && !this.view.webContents.isDestroyed()) {
        this.view.setVisible(false);
      }
      return;
    }
    const view = this.ensureViewCreated();
    if (!view || view.webContents.isDestroyed()) return;
    if (this.mode === 'floating') {
      const changed =
        this.floatBounds.x !== rect.x ||
        this.floatBounds.y !== rect.y ||
        this.floatBounds.width !== rect.width ||
        this.floatBounds.height !== rect.height;
      this.floatBounds = { ...rect };
      if (changed) {
        this.pushStateToView();
      }
    }
    this.ensureTopMost();
    view.setBounds(rect);
    view.setVisible(true);
  }

  setMode(mode: AgentDockMode): AgentDockState {
    this.mode = mode;
    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  toggle(): AgentDockState {
    return this.setMode(this.mode === 'minimized' ? 'docked' : 'minimized');
  }

  setWidth(width: number): AgentDockState {
    if (Number.isFinite(width)) {
      this.width = Math.max(280, Math.min(680, Math.round(width)));
      this.callbacks.onLayoutChanged();
    }
    return this.getState();
  }

  setFloatBounds(partial: Partial<Rect>): AgentDockState {
    const canReadContentSize =
      !this.win.isDestroyed() && typeof this.win.getContentSize === 'function';
    if (canReadContentSize) {
      const [winW = 1480, winH = 920] = this.win.getContentSize();
      this.floatBounds = clampAnchoredFloatBoundsUpdate(this.floatBounds, partial, winW, winH);
    } else {
      this.floatBounds = {
        x: Number.isFinite(partial.x) ? Math.round(partial.x!) : this.floatBounds.x,
        y: Number.isFinite(partial.y) ? Math.round(partial.y!) : this.floatBounds.y,
        width: Number.isFinite(partial.width)
          ? Math.max(MIN_AGENT_FLOAT_WIDTH, Math.round(partial.width!))
          : this.floatBounds.width,
        height: Number.isFinite(partial.height)
          ? Math.max(MIN_AGENT_FLOAT_HEIGHT, Math.round(partial.height!))
          : this.floatBounds.height,
      };
    }
    if (this.mode === 'floating') {
      this.callbacks.onLayoutChanged();
    }
    return this.getState();
  }

  private getIronTermSocket(): string {
    return this.ironTermSocketOverride ?? resolveIronTermSocketPath();
  }

  private async listTmuxInstances(): Promise<RunningAgentInstance[]> {
    try {
      const { stdout } = await this.execFileFn(
        'tmux',
        [
          'list-panes',
          '-a',
          '-F',
          '#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}',
        ],
        { timeout: 1500, maxBuffer: 512 * 1024 },
      );
      return parseTmuxListPanesOutput(stdout);
    } catch {
      return [];
    }
  }

  async listRunningInstances(): Promise<RunningAgentInstance[]> {
    const [tmuxInstances, ironTermInstances] = await Promise.all([
      this.listTmuxInstances(),
      listIronTermInstances(this.getIronTermSocket()),
    ]);
    const combined = [...ironTermInstances, ...tmuxInstances];
    combined.sort((a, b) => {
      if (a.isAgentLike !== b.isAgentLike) return a.isAgentLike ? -1 : 1;
      return a.target.localeCompare(b.target);
    });
    return combined;
  }

  private appendTranscript(chunk: string, replace = false): void {
    if (replace) {
      this.transcript = chunk.slice(-MAX_TRANSCRIPT_CHARS);
    } else {
      this.transcript = (this.transcript + chunk).slice(-MAX_TRANSCRIPT_CHARS);
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:output', {
        chunk,
        replace,
      });
    }
  }

  private pushStateToView(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:state', this.getState());
    }
  }

  private resolvePtyDrainWaiters(ok: boolean): void {
    if (this.ptyDrainWaiters.length === 0) return;
    const waiters = this.ptyDrainWaiters.splice(0);
    for (const resolve of waiters) {
      resolve(ok);
    }
  }

  private clearPtyWriteQueue(): void {
    if (this.ptyWriteFlushTimer) {
      clearInterval(this.ptyWriteFlushTimer);
      this.ptyWriteFlushTimer = null;
    }
    this.pendingPtyWriteChunks = [];
    this.pendingPtyWriteBytes = 0;
    this.resolvePtyDrainWaiters(false);
  }

  private cleanupMcpConfig(): void {
    const cfgPath = this.mcpConfigPath;
    this.mcpConfigPath = null;
    if (!cfgPath) return;
    try {
      const st = fs.lstatSync(cfgPath);
      if (st.isFile() && !st.isSymbolicLink()) {
        fs.unlinkSync(cfgPath);
      }
    } catch {
      // Ignore already-removed or inaccessible config cleanup errors.
    }
  }

  private flushPendingPtyWrites(): boolean {
    if (this.activePtyId === null || !this.ptyBinding || this.disposed) {
      this.clearPtyWriteQueue();
      return false;
    }
    while (this.pendingPtyWriteChunks.length > 0) {
      const head = this.pendingPtyWriteChunks[0]!;
      const res = JSON.parse(
        this.ptyBinding.ptyWrite(this.activePtyId, head.toString('base64')),
      ) as { ok: boolean; bytesWritten?: number };
      if (!res.ok) {
        this.clearPtyWriteQueue();
        return false;
      }
      const written = Math.max(0, Math.min(head.length, res.bytesWritten ?? 0));
      if (written >= head.length) {
        this.pendingPtyWriteChunks.shift();
        this.pendingPtyWriteBytes = Math.max(0, this.pendingPtyWriteBytes - head.length);
      } else {
        if (written > 0) {
          this.pendingPtyWriteChunks[0] = head.subarray(written);
          this.pendingPtyWriteBytes = Math.max(0, this.pendingPtyWriteBytes - written);
        }
        return true;
      }
    }
    if (this.pendingPtyWriteChunks.length === 0) {
      if (this.ptyWriteFlushTimer) {
        clearInterval(this.ptyWriteFlushTimer);
        this.ptyWriteFlushTimer = null;
      }
      this.resolvePtyDrainWaiters(true);
    }
    return true;
  }

  private enqueueOrWritePtyBuffer(ptyId: number, buf: Buffer): boolean {
    if (buf.length === 0) return true;
    if (this.disposed || this.activePtyId !== ptyId || !this.ptyBinding) return false;

    const chunks: Buffer[] = [];
    for (let offset = 0; offset < buf.length; offset += MAX_PTY_WRITE_CHUNK_BYTES) {
      chunks.push(buf.subarray(offset, Math.min(buf.length, offset + MAX_PTY_WRITE_CHUNK_BYTES)));
    }

    if (this.pendingPtyWriteChunks.length > 0) {
      this.pendingPtyWriteChunks.push(...chunks);
      this.pendingPtyWriteBytes += buf.length;
      return this.flushPendingPtyWrites();
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const res = JSON.parse(
        this.ptyBinding.ptyWrite(ptyId, chunk.toString('base64')),
      ) as { ok: boolean; bytesWritten?: number };
      if (!res.ok) {
        return false;
      }
      const written = Math.max(0, Math.min(chunk.length, res.bytesWritten ?? chunk.length));
      if (written < chunk.length) {
        const rem = chunk.subarray(written);
        this.pendingPtyWriteChunks.push(rem, ...chunks.slice(i + 1));
        for (const c of [rem, ...chunks.slice(i + 1)]) {
          this.pendingPtyWriteBytes += c.length;
        }
        if (!this.ptyWriteFlushTimer) {
          this.ptyWriteFlushTimer = setInterval(() => {
            this.flushPendingPtyWrites();
          }, 15);
          this.ptyWriteFlushTimer.unref?.();
        }
        return true;
      }
    }
    return true;
  }

  private waitForPtyWriteDrain(
    ptyId: number,
    timeoutMs = this.ptyDrainTimeoutMs,
  ): Promise<boolean> {
    if (this.disposed || this.activePtyId !== ptyId) return Promise.resolve(false);
    if (this.pendingPtyWriteChunks.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const onDone = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        const idx = this.ptyDrainWaiters.indexOf(onDone);
        if (idx >= 0) this.ptyDrainWaiters.splice(idx, 1);
        this.clearPtyWriteQueue();
        onDone(false);
      }, timeoutMs);
      timer.unref?.();
      this.ptyDrainWaiters.push(onDone);
    });
  }

  stopSession(): AgentDockState {
    this.sessionGen += 1;
    if (this.ptyPollTimer) {
      clearInterval(this.ptyPollTimer);
      this.ptyPollTimer = null;
    }
    this.clearPtyWriteQueue();
    this.ptyWriteChain = Promise.resolve();
    this.ptyPendingOps = 0;
    this.tmuxWriteChain = Promise.resolve();
    this.ironTermWriteChain = Promise.resolve();
    this.cleanupMcpConfig();
    if (this.tmuxPollTimer) {
      clearInterval(this.tmuxPollTimer);
      this.tmuxPollTimer = null;
    }
    if (this.activePtyId !== null && this.ptyBinding) {
      try {
        this.ptyBinding.ptyKill(this.activePtyId);
      } catch {
        // Ignore teardown errors.
      }
      this.activePtyId = null;
    }
    const prevIronConn = this.ironTermConn;
    const prevIronSid = this.attachedIronTermSessionId;
    this.ironTermConn = null;
    this.attachedIronTermSessionId = null;
    this.lastIronTermRender = '';
    if (prevIronConn) {
      if (!this.disposed && prevIronSid) {
        void prevIronConn
          .request({ type: 'detach_pty', session_id: prevIronSid }, 250)
          .catch(() => {})
          .finally(() => prevIronConn.close());
      } else {
        prevIronConn.close();
      }
    }
    this.attachedPane = null;
    this.lastTmuxCapture = '';
    this.sessionMeta = {
      active: false,
      kind: 'none',
      label: 'Idle',
      socketPath: this.callbacks.getSocketPath(),
    };
    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  private async attachIronTermInstance(cleanTarget: string, sessionId: string): Promise<AgentDockState> {
    if (!IRON_TERM_ID_RE.test(sessionId)) {
      throw new Error(`Invalid iron-term session target: ${cleanTarget}`);
    }
    this.stopSession();
    const opGen = this.sessionGen;
    const socketPath = this.getIronTermSocket();

    const conn = await IronTermSessionConnection.connect(
      socketPath,
      (ev) => {
        if (
          this.disposed ||
          this.sessionGen !== opGen ||
          this.sessionMeta.kind !== 'iron-term' ||
          this.attachedIronTermSessionId !== sessionId
        ) {
          return;
        }
        if (ev.event === 'grid_delta' && ev.snapshot?.session_id === sessionId) {
          const rendered = formatIronTermGridSnapshot(ev.snapshot);
          if (rendered !== this.lastIronTermRender) {
            this.lastIronTermRender = rendered;
            this.appendTranscript(rendered, true);
          }
        } else if (ev.event === 'fleet_delta' && Array.isArray(ev.sessions)) {
          const match = ev.sessions.find((s) => s && s.id === sessionId);
          if (!match || match.state === 'hibernated') {
            this.appendTranscript(
              `\n[IronBrowser: iron-term session ${sessionId} ended or hibernated]\n`,
              false,
            );
            this.stopSession();
          }
        }
      },
      (err) => {
        if (
          this.disposed ||
          this.sessionGen !== opGen ||
          this.sessionMeta.kind !== 'iron-term' ||
          this.attachedIronTermSessionId !== sessionId
        ) {
          return;
        }
        this.appendTranscript(
          `\n[IronBrowser: iron-term session ${sessionId} disconnected${err ? `: ${err.message}` : ''}]\n`,
          false,
        );
        this.stopSession();
      },
    );

    if (this.disposed || this.sessionGen !== opGen) {
      conn.close();
      return this.getState();
    }

    try {
      const attached = await conn.request({
        type: 'attach_pty',
        session_id: sessionId,
        cols: 92,
        rows: 30,
      });
      if (this.disposed || this.sessionGen !== opGen) {
        conn.close();
        return this.getState();
      }
      let title = sessionId;
      let cwd: string | undefined;
      try {
        const insp = await conn.request({ type: 'inspect_session', session_id: sessionId }, 600);
        const sess = (insp.inspection as { session?: { title?: string; worktree_path?: string } } | undefined)
          ?.session;
        if (sess?.title) title = sess.title;
        if (sess?.worktree_path) cwd = sess.worktree_path;
      } catch {
        // Optional metadata lookup; ignore if unavailable.
      }
      if (this.disposed || this.sessionGen !== opGen) {
        conn.close();
        return this.getState();
      }

      const initialRendered =
        attached.type === 'attached' && attached.snapshot
          ? formatIronTermGridSnapshot(attached.snapshot)
          : '';
      this.ironTermConn = conn;
      this.attachedIronTermSessionId = sessionId;
      this.lastIronTermRender = initialRendered;
      this.sessionMeta = {
        active: true,
        kind: 'iron-term',
        label: `iron-term ${title}`,
        targetPane: cleanTarget,
        ...(cwd ? { cwd } : {}),
        socketPath: this.callbacks.getSocketPath(),
      };
      this.transcript = '';
      this.appendTranscript(initialRendered, true);
      this.callbacks.onLayoutChanged();
      this.pushStateToView();
      return this.getState();
    } catch (err) {
      conn.close();
      throw err;
    }
  }

  async attachRunningInstance(targetPane: string): Promise<AgentDockState> {
    const cleanTarget = targetPane.trim();
    if (cleanTarget.startsWith('iron-term:')) {
      return this.attachIronTermInstance(cleanTarget, cleanTarget.slice('iron-term:'.length));
    }
    if (!PANE_TARGET_RE.test(cleanTarget)) {
      throw new Error(`Invalid agent instance target: ${cleanTarget}`);
    }
    this.stopSession();
    this.attachedPane = cleanTarget;
    this.sessionMeta = {
      active: true,
      kind: 'tmux',
      label: `tmux ${cleanTarget}`,
      targetPane: cleanTarget,
      socketPath: this.callbacks.getSocketPath(),
    };
    this.transcript = '';
    await this.captureAttachedPaneOnce(true);

    this.tmuxPollTimer = setInterval(() => {
      void this.captureAttachedPaneOnce(false);
    }, 400);
    this.tmuxPollTimer.unref?.();

    this.callbacks.onLayoutChanged();
    this.pushStateToView();
    return this.getState();
  }

  private async captureAttachedPaneOnce(force: boolean): Promise<void> {
    const pane = this.attachedPane;
    if (!pane || this.disposed) return;
    try {
      const { stdout } = await this.execFileFn(
        'tmux',
        ['capture-pane', '-p', '-J', '-t', pane, '-S', '-160'],
        { timeout: 1200, maxBuffer: 1024 * 1024 },
      );
      if (this.attachedPane !== pane) return;
      if (force || stdout !== this.lastTmuxCapture) {
        this.lastTmuxCapture = stdout;
        this.appendTranscript(stdout, true);
      }
    } catch (err) {
      if (this.attachedPane !== pane) return;
      this.appendTranscript(
        `\n[IronBrowser: tmux pane ${pane} ended or became unreachable: ${String(err)}]\n`,
        false,
      );
      this.stopSession();
    }
  }

  startCliAgent(input: {
    preset: AgentCliPreset;
    customCommand?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): AgentDockState {
    if (!this.ptyBinding) {
      throw new Error('Native Rust PTY binding is unavailable (run `bun run build:native`)');
    }
    this.stopSession();

    const userShell = process.env.SHELL?.trim() || '/bin/sh';
    let program = userShell;
    let args: string[] = [];
    let label: string = input.preset;

    switch (input.preset) {
      case 'agy':
        program = 'agy';
        args = [];
        label = 'agy';
        break;
      case 'claude':
        program = 'claude';
        args = [];
        label = 'claude';
        break;
      case 'codex':
        program = 'codex';
        args = [];
        label = 'codex';
        break;
      case 'opencode':
        program = 'opencode';
        args = [];
        label = 'opencode';
        break;
      case 'shell':
        program = userShell;
        args = ['-i'];
        label = path.basename(userShell);
        break;
      case 'custom': {
        const cmd = (input.customCommand ?? '').trim();
        if (!cmd || cmd.length > 512) {
          throw new Error('Custom CLI command must be 1..512 characters');
        }
        program = userShell;
        args = ['-lc', cmd];
        label = cmd.split(/\s+/)[0]?.slice(0, 24) || 'custom';
        break;
      }
      default:
        throw new Error(`Unsupported CLI preset: ${String(input.preset)}`);
    }

    const socketPath = this.callbacks.getSocketPath();
    const mcpCfgPath = writePerWindowMcpConfig(socketPath);
    this.mcpConfigPath = mcpCfgPath;

    try {
      if (input.preset === 'claude' && mcpCfgPath) {
        args = ['--mcp-config', mcpCfgPath];
      }

      const resolvedCwd = (() => {
        const raw = input.cwd?.trim();
        if (raw && fs.existsSync(raw)) {
          try {
            if (fs.statSync(raw).isDirectory()) return raw;
          } catch {
            // Fallback below.
          }
        }
        return process.cwd();
      })();

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') {
          env[k] = v;
        }
      }
      env.IRON_BROWSER_SOCKET = socketPath;
      const activeTabId = this.callbacks.getActiveTabId();
      if (activeTabId) env.IRON_BROWSER_DEFAULT_TAB = activeTabId;
      if (mcpCfgPath) env.IRON_BROWSER_MCP_CONFIG = mcpCfgPath;

      const safeCols =
        typeof input.cols === 'number' && Number.isFinite(input.cols) ? input.cols : 92;
      const safeRows =
        typeof input.rows === 'number' && Number.isFinite(input.rows) ? input.rows : 30;
      const rawSpawn = this.ptyBinding.ptySpawn(
        JSON.stringify({
          program,
          args,
          cwd: resolvedCwd,
          env,
          cols: Math.max(30, Math.min(300, Math.trunc(safeCols))),
          rows: Math.max(10, Math.min(160, Math.trunc(safeRows))),
        }),
      );
      const parsed = JSON.parse(rawSpawn) as {
        ok: boolean;
        id?: number;
        pid?: number;
        error?: string;
      };
      if (!parsed.ok || typeof parsed.id !== 'number') {
        throw new Error(parsed.error ?? `Failed to launch '${label}'`);
      }

      this.activePtyId = parsed.id;
      this.activePtyDecoder = new TextDecoder('utf-8');
      this.transcript = '';
      this.appendTranscript(
        `[IronBrowser Agent PTY · ${label} (pid ${parsed.pid ?? '?'}) · IRON_BROWSER_SOCKET=${socketPath}]\r\n`,
        true,
      );

      this.sessionMeta = {
        active: true,
        kind: 'pty',
        label,
        preset: input.preset,
        cwd: resolvedCwd,
        pid: parsed.pid ?? null,
        exited: false,
        exitCode: null,
        socketPath,
      };

      this.ptyPollTimer = setInterval(() => {
        this.pollPtyOnce();
      }, 35);
      this.ptyPollTimer.unref?.();

      this.callbacks.onLayoutChanged();
      this.pushStateToView();
      return this.getState();
    } catch (err) {
      this.cleanupMcpConfig();
      throw err;
    }
  }

  private pollPtyOnce(): void {
    if (this.activePtyId === null || !this.ptyBinding || this.disposed) return;
    try {
      const raw = this.ptyBinding.ptyPoll(this.activePtyId);
      const polled = JSON.parse(raw) as {
        ok: boolean;
        dataB64: string;
        exited: boolean;
        exitCode: number | null;
      };
      if (!polled.ok) return;
      if (polled.dataB64) {
        const bytes = Buffer.from(polled.dataB64, 'base64');
        const text = this.activePtyDecoder.decode(bytes, { stream: !polled.exited });
        if (text) this.appendTranscript(text, false);
      }
      if (polled.exited && !this.sessionMeta.exited) {
        const finishedId = this.activePtyId;
        this.sessionGen += 1;
        this.activePtyId = null;
        this.clearPtyWriteQueue();
        this.ptyWriteChain = Promise.resolve();
        this.ptyPendingOps = 0;
        this.cleanupMcpConfig();
        try {
          this.ptyBinding.ptyKill(finishedId);
        } catch {
          // Ignore teardown errors.
        }
        this.sessionMeta.exited = true;
        this.sessionMeta.exitCode = polled.exitCode;
        this.sessionMeta.active = false;
        this.appendTranscript(
          `\r\n[Process '${this.sessionMeta.label}' exited with code ${polled.exitCode ?? 0}]\r\n`,
          false,
        );
        if (this.ptyPollTimer) {
          clearInterval(this.ptyPollTimer);
          this.ptyPollTimer = null;
        }
        this.callbacks.onLayoutChanged();
        this.pushStateToView();
      }
    } catch {
      // Ignore transient poll parse errors.
    }
  }

  async writeInput(data: string, submitEnter = false): Promise<boolean> {
    if (!data && !submitEnter) return false;
    if (this.sessionMeta.kind === 'pty' && this.activePtyId !== null && this.ptyBinding) {
      const ptyId = this.activePtyId;
      const opGen = this.sessionGen;
      const dataBuf = Buffer.from(data, 'utf8');
      const extraEnterBytes = submitEnter ? 1 : 0;
      if (this.pendingPtyWriteBytes + dataBuf.length + extraEnterBytes > MAX_PTY_QUEUE_BYTES) {
        return false;
      }

      if (!submitEnter && this.ptyPendingOps === 0 && this.pendingPtyWriteChunks.length === 0) {
        return this.enqueueOrWritePtyBuffer(ptyId, dataBuf);
      }

      this.ptyPendingOps += 1;
      let result = false;
      const run = async () => {
        try {
          if (
            this.disposed ||
            this.sessionGen !== opGen ||
            this.sessionMeta.kind !== 'pty' ||
            this.activePtyId !== ptyId ||
            !this.ptyBinding
          ) {
            return;
          }
          if (this.pendingPtyWriteBytes + dataBuf.length + extraEnterBytes > MAX_PTY_QUEUE_BYTES) {
            return;
          }
          if (!submitEnter) {
            result = this.enqueueOrWritePtyBuffer(ptyId, dataBuf);
            return;
          }
          if (dataBuf.length > 0) {
            if (!this.enqueueOrWritePtyBuffer(ptyId, dataBuf)) return;
            if (!(await this.waitForPtyWriteDrain(ptyId))) {
              if (this.sessionGen === opGen && this.activePtyId === ptyId) {
                this.clearPtyWriteQueue();
              }
              return;
            }
            await new Promise((r) => setTimeout(r, PTY_SUBMIT_YIELD_MS));
            if (
              this.disposed ||
              this.sessionGen !== opGen ||
              this.sessionMeta.kind !== 'pty' ||
              this.activePtyId !== ptyId ||
              !this.ptyBinding
            ) {
              return;
            }
          }
          if (!this.enqueueOrWritePtyBuffer(ptyId, Buffer.from('\r', 'utf8'))) return;
          if (this.pendingPtyWriteChunks.length > 0) {
            const drained = await this.waitForPtyWriteDrain(ptyId);
            if (!drained) {
              if (this.sessionGen === opGen && this.activePtyId === ptyId) {
                this.clearPtyWriteQueue();
              }
              return;
            }
            result = true;
          } else {
            result = true;
          }
        } finally {
          if (this.sessionGen === opGen) {
            this.ptyPendingOps = Math.max(0, this.ptyPendingOps - 1);
          }
        }
      };

      const chained = this.ptyWriteChain.then(run, run);
      this.ptyWriteChain = chained.catch(() => {});
      await chained;
      return result;
    }

    if (this.sessionMeta.kind === 'tmux' && this.attachedPane) {
      const pane = this.attachedPane;
      const opGen = this.sessionGen;
      let result = false;
      const run = async () => {
        if (
          this.disposed ||
          this.sessionGen !== opGen ||
          this.sessionMeta.kind !== 'tmux' ||
          this.attachedPane !== pane
        ) {
          return;
        }
        try {
          if (data.length > 0) {
            const sendTimeoutMs = Math.min(4000, Math.max(1500, 1500 + Math.ceil(data.length / 20)));
            await this.execFileFn('tmux', ['send-keys', '-t', pane, '-l', '--', data], {
              timeout: sendTimeoutMs,
            });
          }
          if (submitEnter) {
            if (data.length > 0) {
              const delayMs = Math.min(500, Math.max(80, 60 + Math.ceil(data.length / 32)));
              await new Promise((r) => setTimeout(r, delayMs));
            }
            if (
              this.disposed ||
              this.sessionGen !== opGen ||
              this.sessionMeta.kind !== 'tmux' ||
              this.attachedPane !== pane
            ) {
              return;
            }
            await this.execFileFn('tmux', ['send-keys', '-t', pane, 'C-m'], { timeout: 1500 });
          }
          const timer = setTimeout(() => void this.captureAttachedPaneOnce(false), 120);
          timer.unref?.();
          result = true;
        } catch {
          result = false;
        }
      };

      const chained = this.tmuxWriteChain.then(run, run);
      this.tmuxWriteChain = chained.catch(() => {});
      await chained;
      return result;
    }

    if (
      this.sessionMeta.kind === 'iron-term' &&
      this.ironTermConn &&
      this.attachedIronTermSessionId
    ) {
      const conn = this.ironTermConn;
      const sid = this.attachedIronTermSessionId;
      const opGen = this.sessionGen;
      let result = false;
      const run = async () => {
        if (
          this.disposed ||
          this.sessionGen !== opGen ||
          this.sessionMeta.kind !== 'iron-term' ||
          this.ironTermConn !== conn ||
          this.attachedIronTermSessionId !== sid
        ) {
          return;
        }
        try {
          if (data.length > 0) {
            await conn.request({
              type: 'pty_input',
              session_id: sid,
              bytes: Array.from(Buffer.from(data, 'utf8')),
            });
          }
          if (submitEnter) {
            if (data.length > 0) {
              await new Promise((r) => setTimeout(r, PTY_SUBMIT_YIELD_MS));
            }
            if (
              this.disposed ||
              this.sessionGen !== opGen ||
              this.sessionMeta.kind !== 'iron-term' ||
              this.ironTermConn !== conn ||
              this.attachedIronTermSessionId !== sid
            ) {
              return;
            }
            await conn.request({
              type: 'pty_input',
              session_id: sid,
              bytes: [13],
            });
          }
          result = true;
        } catch {
          result = false;
        }
      };

      const chained = this.ironTermWriteChain.then(run, run);
      this.ironTermWriteChain = chained.catch(() => {});
      await chained;
      return result;
    }
    return false;
  }

  async sendSpecialKey(key: string): Promise<boolean> {
    const allowedTmuxKeys: Record<string, string> = {
      Enter: 'C-m',
      Escape: 'Escape',
      Interrupt: 'C-c',
      Up: 'Up',
      Down: 'Down',
      Tab: 'Tab',
      '1': '1',
      '2': '2',
      '3': '3',
    };
    const ptyMap: Record<string, string> = {
      Enter: '\r',
      Escape: '\x1b',
      Interrupt: '\x03',
      Up: '\x1b[A',
      Down: '\x1b[B',
      Tab: '\t',
      '1': '1',
      '2': '2',
      '3': '3',
    };

    if ((this.sessionMeta.kind === 'pty' || this.sessionMeta.kind === 'iron-term') && ptyMap[key]) {
      return this.writeInput(ptyMap[key]!, false);
    }
    if (this.sessionMeta.kind === 'tmux' && this.attachedPane && allowedTmuxKeys[key]) {
      const pane = this.attachedPane;
      const opGen = this.sessionGen;
      const tmuxKey = allowedTmuxKeys[key]!;
      let result = false;
      const run = async () => {
        if (
          this.disposed ||
          this.sessionGen !== opGen ||
          this.sessionMeta.kind !== 'tmux' ||
          this.attachedPane !== pane
        ) {
          return;
        }
        try {
          await this.execFileFn('tmux', ['send-keys', '-t', pane, tmuxKey], {
            timeout: 1500,
          });
          const timer = setTimeout(() => void this.captureAttachedPaneOnce(false), 120);
          timer.unref?.();
          result = true;
        } catch {
          result = false;
        }
      };

      const chained = this.tmuxWriteChain.then(run, run);
      this.tmuxWriteChain = chained.catch(() => {});
      await chained;
      return result;
    }
    return false;
  }

  resizePty(cols: number, rows: number): boolean {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return false;
    }
    const clampedCols = Math.max(20, Math.min(400, Math.trunc(cols)));
    const clampedRows = Math.max(8, Math.min(200, Math.trunc(rows)));
    if (
      this.sessionMeta.kind === 'iron-term' &&
      this.ironTermConn &&
      this.attachedIronTermSessionId
    ) {
      void this.ironTermConn
        .request({
          type: 'pty_resize',
          session_id: this.attachedIronTermSessionId,
          cols: clampedCols,
          rows: clampedRows,
        })
        .catch(() => {});
      return true;
    }
    if (this.activePtyId === null || !this.ptyBinding) return false;
    return this.ptyBinding.ptyResize(this.activePtyId, clampedCols, clampedRows);
  }

  injectBrowserContextToView(): boolean {
    const snippet = this.callbacks.getBrowserContextSnippet();
    if (this.mode === 'minimized') {
      this.setMode('docked');
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:inject-context', snippet);
      return true;
    }
    return false;
  }

  clearTranscript(): boolean {
    this.transcript = '';
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('agent:output', { chunk: '', replace: true });
    }
    return true;
  }

  copyTranscript(): boolean {
    const clean = stripAnsiAll(this.transcript);
    try {
      loadElectronRuntime().clipboard?.writeText(clean);
      return true;
    } catch {
      return false;
    }
  }

  async exportTranscript(): Promise<{
    ok: boolean;
    path?: string;
    canceled?: boolean;
    error?: string;
  }> {
    const clean = stripAnsiAll(this.transcript);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultFilename = `iron-agent-transcript-${stamp}.md`;
    const runtime = loadElectronRuntime();
    const isSmoke = process.env.IRON_BROWSER_SMOKE === '1' || process.argv.includes('--smoke');
    const envDir = process.env.IRON_BROWSER_DOWNLOAD_DIR?.trim();

    if (
      envDir ||
      isSmoke ||
      !runtime.dialog ||
      typeof runtime.dialog.showSaveDialog !== 'function'
    ) {
      let fallbackDir = envDir;
      if (!fallbackDir) {
        try {
          fallbackDir =
            typeof runtime.app?.getPath === 'function'
              ? path.join(runtime.app.getPath('userData'), 'downloads')
              : path.join(os.homedir(), 'Downloads');
        } catch {
          fallbackDir = path.join(os.homedir(), 'Downloads');
        }
      }
      const savePath = reserveSafeDownloadPath(fallbackDir, defaultFilename);
      if (!savePath) {
        return { ok: false, error: 'Failed to reserve safe transcript export path' };
      }
      fs.writeFileSync(savePath, clean, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, path: savePath };
    }

    let defaultDir = process.cwd();
    try {
      if (typeof runtime.app?.getPath === 'function') {
        defaultDir = runtime.app.getPath('downloads');
      }
    } catch {
      // Fallback to process.cwd().
    }

    const res = await runtime.dialog.showSaveDialog(this.win, {
      defaultPath: path.join(defaultDir, defaultFilename),
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
    });
    if (res.canceled || !res.filePath) {
      return { ok: false, canceled: true };
    }
    const savePath = reserveSafeDownloadPath(
      path.dirname(res.filePath),
      path.basename(res.filePath),
    );
    if (!savePath) {
      return { ok: false, error: 'Refused unsafe transcript export path' };
    }
    fs.writeFileSync(savePath, clean, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: savePath };
  }

  registerIpcHandlers(ipc?: Pick<IpcMain, 'handle'>): void {
    const targetIpc = ipc ?? loadElectronRuntime().ipcMain;
    if (!targetIpc || typeof targetIpc.handle !== 'function') return;
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    const handleAgent = (channel: string, fn: (raw: unknown) => unknown): void => {
      targetIpc.handle(channel, (ev, raw: unknown) => {
        assertAgentSender(ev, this.view, this.expectedAgentUrl);
        return fn(raw);
      });
    };

    handleAgent('agent:get-initial', async () => ({
      state: this.getState(),
      transcript: this.transcript,
      instances: await this.listRunningInstances(),
      defaultCwd: process.cwd(),
      contextSnippet: this.callbacks.getBrowserContextSnippet(),
      availableClis: detectAvailableAgentClis(),
    }));

    handleAgent('agent:list-clis', () => detectAvailableAgentClis());

    handleAgent('agent:list-instances', () => this.listRunningInstances());

    handleAgent('agent:start-cli', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const rawPreset = String(obj.preset ?? 'shell').trim();
      const allowed: AgentCliPreset[] = ['agy', 'claude', 'codex', 'opencode', 'shell', 'custom'];
      let preset: AgentCliPreset;
      let customCommand = typeof obj.customCommand === 'string' ? obj.customCommand : undefined;

      if (allowed.includes(rawPreset as AgentCliPreset)) {
        preset = rawPreset as AgentCliPreset;
      } else if (
        isSafeCliToken(rawPreset) &&
        detectAvailableAgentClis().some((c) => c.id === rawPreset)
      ) {
        preset = 'custom';
        customCommand = customCommand && customCommand.trim() ? customCommand : rawPreset;
      } else {
        throw new Error(`Unsupported CLI preset: ${rawPreset}`);
      }

      return this.startCliAgent({
        preset,
        customCommand,
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        cols: typeof obj.cols === 'number' ? obj.cols : undefined,
        rows: typeof obj.rows === 'number' ? obj.rows : undefined,
      });
    });

    handleAgent('agent:attach-instance', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.attachRunningInstance(String(obj.target ?? ''));
    });

    handleAgent('agent:stop', () => this.stopSession());

    handleAgent('agent:write', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const data = typeof obj.data === 'string' ? obj.data : '';
      const submitEnter = Boolean(obj.submitEnter);
      return this.writeInput(data, submitEnter);
    });

    handleAgent('agent:special-key', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.sendSpecialKey(String(obj.key ?? ''));
    });

    handleAgent('agent:resize', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.resizePty(Number(obj.cols ?? 90), Number(obj.rows ?? 28));
    });

    handleAgent('agent:set-mode', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const m = String(obj.mode ?? 'docked') as AgentDockMode;
      if (m !== 'docked' && m !== 'floating' && m !== 'minimized') {
        throw new Error(`Invalid agent dock mode: ${m}`);
      }
      return this.setMode(m);
    });

    handleAgent('agent:set-float-bounds', (raw) => {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return this.setFloatBounds({
        x: typeof obj.x === 'number' ? obj.x : undefined,
        y: typeof obj.y === 'number' ? obj.y : undefined,
        width: typeof obj.width === 'number' ? obj.width : undefined,
        height: typeof obj.height === 'number' ? obj.height : undefined,
      });
    });

    handleAgent('agent:get-context', () => this.callbacks.getBrowserContextSnippet());
    handleAgent('agent:clear-transcript', () => this.clearTranscript());
    handleAgent('agent:copy-transcript', () => this.copyTranscript());
    handleAgent('agent:export-transcript', () => this.exportTranscript());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSession();
    if (this.view) {
      const v = this.view;
      this.view = null;
      try {
        this.win.contentView.removeChildView(v);
      } catch {
        // Ignore.
      }
      try {
        if (!v.webContents.isDestroyed()) {
          v.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // Ignore.
      }
    }
  }
}
