import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessGroup, resolveExecutableOnHost, runSubprocess } from './env-harness';
import type {
  CleanupRegistry,
  DoctorOptions,
  DoctorResult,
  ElectronExitStatus,
  McpClientHandle,
  McpLaunchOptions,
  McpToolCallResult,
  McpToolInfo,
} from './types';

const APP_ROOT = path.resolve(import.meta.dir, '../../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const LAUNCHER_BIN = path.join(REPO_ROOT, 'bin', 'iron-browser');

export function resolveMcpBinary(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.IRON_BROWSER_MCP_BIN,
    path.join(REPO_ROOT, 'target', 'release', 'iron-browser-mcp'),
    path.join(REPO_ROOT, 'target', 'debug', 'iron-browser-mcp'),
    path.join(os.homedir(), '.cache', 'cargo-targets', 'main', 'release', 'iron-browser-mcp'),
    path.join(os.homedir(), '.cache', 'cargo-targets', 'Projects__iron-browser', 'release', 'iron-browser-mcp'),
    path.join(os.homedir(), '.local', 'bin', 'iron-browser-mcp'),
    resolveExecutableOnHost('iron-browser-mcp') ?? undefined,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // Next candidate.
    }
  }
  throw new Error(
    'iron-browser-mcp binary not found (checked IRON_BROWSER_MCP_BIN, target/release, target/debug, ~/.local/bin, PATH)',
  );
}

export class McpJsonRpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`MCP JSON-RPC error (${code}): ${message}`);
    this.name = 'McpJsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export async function launchMcpClient(
  opts: McpLaunchOptions = {},
  cleanup?: CleanupRegistry,
): Promise<McpClientHandle> {
  const binPath = resolveMcpBinary(opts.binPath);
  const args: string[] = [];
  if (opts.socketPath) {
    args.push('--socket', opts.socketPath);
  }
  if (opts.maxBytes !== undefined) {
    args.push('--max-bytes', String(opts.maxBytes));
  }

  const env: NodeJS.ProcessEnv = opts.env ? { ...opts.env } : { ...process.env };
  if (opts.socketPath && !env.IRON_BROWSER_SOCKET) {
    env.IRON_BROWSER_SOCKET = opts.socketPath;
  }

  const child = spawn(binPath, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanup?.trackProcess(child, 'iron-browser-mcp');

  let stdoutBuf = '';
  let stderrBuf = '';
  let nextId = 1;
  let exitStatus: ElectronExitStatus | null = null;
  const exitWaiters: Array<(s: ElectronExitStatus) => void> = [];
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  child.once('exit', (code, signal) => {
    exitStatus = { code, signal };
    for (const r of exitWaiters.splice(0)) r(exitStatus);
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(`iron-browser-mcp exited (code=${code}, signal=${signal})`));
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let nl = stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      nl = stdoutBuf.indexOf('\n');
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number | string | null;
          result?: unknown;
          error?: { code?: number; message?: string; data?: unknown };
        };
        if (typeof msg.id === 'number') {
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(
                new McpJsonRpcError(
                  msg.error.code ?? -32000,
                  msg.error.message ?? 'unknown error',
                  msg.error.data,
                ),
              );
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore non-JSON lines if any.
      }
    }
  });

  const sendRawLine = (line: string): void => {
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error('iron-browser-mcp stdin is closed');
    }
    child.stdin.write(`${line}\n`);
  };

  const request = <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 12_000,
  ): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      try {
        sendRawLine(JSON.stringify(payload));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const notify = (method: string, params?: Record<string, unknown>): void => {
    sendRawLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
  };

  const initialize = (protocolVersion = opts.protocolVersion ?? '2025-06-18') =>
    request<Record<string, unknown>>('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'iron-browser-acceptance', version: '1.0.0' },
    });

  const sendInitialized = () => {
    notify('notifications/initialized', {});
  };

  const handle: McpClientHandle = {
    process: child,
    binPath,
    request,
    notify,
    sendRawLine,
    initialize,
    sendInitialized,
    listTools: (params?: Record<string, unknown>) =>
      request<{ tools: McpToolInfo[] }>('tools/list', params ?? {}),
    callTool: (name: string, argsObj?: Record<string, unknown>, timeoutMs = 15_000) =>
      request<McpToolCallResult>(
        'tools/call',
        { name, arguments: argsObj ?? {} },
        timeoutMs,
      ),
    getStderr: () => stderrBuf,
    waitForExit: (timeoutMs = 5_000) => {
      if (exitStatus !== null) return Promise.resolve(exitStatus);
      return new Promise<ElectronExitStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = exitWaiters.indexOf(onExit);
          if (idx >= 0) exitWaiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for iron-browser-mcp exit after ${timeoutMs}ms`));
        }, timeoutMs);
        const onExit = (s: ElectronExitStatus) => {
          clearTimeout(timer);
          resolve(s);
        };
        exitWaiters.push(onExit);
      });
    },
    close: async () => {
      for (const [id, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error('MCP client closed'));
      }
      try {
        child.stdin?.end();
      } catch {
        // Ignore.
      }
      if (exitStatus === null) {
        await handle.waitForExit(1_000).catch(async () => {
          killProcessGroup(child, 'SIGTERM');
          await handle.waitForExit(1_500).catch(async () => {
            killProcessGroup(child, 'SIGKILL');
            await handle.waitForExit(1_000).catch(() => {});
          });
        });
      }
      killProcessGroup(child, 'SIGKILL');
      cleanup?.untrackProcess(child);
    },
  };

  if (opts.autoInitialize !== false) {
    await initialize();
    sendInitialized();
  }

  return handle;
}

export async function runMcpDoctor(
  opts: DoctorOptions = {},
  cleanup?: CleanupRegistry,
): Promise<DoctorResult> {
  const binPath = opts.viaLauncher ? LAUNCHER_BIN : resolveMcpBinary(opts.binPath);
  const args: string[] = opts.viaLauncher ? ['doctor'] : ['--doctor'];
  if (opts.socketPath) {
    args.push('--socket', opts.socketPath);
  }
  if (opts.lines !== undefined) {
    args.push('--lines', String(opts.lines));
  }
  if (opts.json !== false) {
    args.push('--json');
  }
  const res = await runSubprocess(binPath, args, {
    env: opts.env,
    cwd: REPO_ROOT,
    timeoutMs: 10_000,
    cleanup,
  });
  let parsed: Record<string, unknown> | null = null;
  if (opts.json !== false && res.stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return {
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    json: parsed,
  };
}
