import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { encodeFrame, FrameDecoder } from '../shared/frame';
import type { RunningAgentInstance } from '../shared/types';

export interface IronTermGridRow {
  row: number;
  text: string;
}

export interface IronTermGridSnapshot {
  session_id: string;
  seq: number;
  cols: number;
  rows: number;
  cursor_col: number;
  cursor_row: number;
  lines: IronTermGridRow[];
}

export interface IronTermSessionSummary {
  id: string;
  title?: string;
  cli?: string;
  host_id?: string;
  project?: string;
  worktree_path?: string;
  git_branch?: string;
  state?: string;
  phase?: string;
}

export type IronTermClientMsg =
  | { type: 'ping' }
  | { type: 'list_fleet' }
  | { type: 'attach_pty'; session_id: string; cols: number; rows: number }
  | { type: 'detach_pty'; session_id: string }
  | { type: 'pty_input'; session_id: string; bytes: number[] }
  | { type: 'pty_resize'; session_id: string; cols: number; rows: number }
  | { type: 'inspect_session'; session_id: string };

export interface IronTermRpcResponse {
  type: string;
  sessions?: IronTermSessionSummary[];
  snapshot?: IronTermGridSnapshot;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface IronTermDaemonEvent {
  event: string;
  snapshot?: IronTermGridSnapshot;
  sessions?: IronTermSessionSummary[];
  [key: string]: unknown;
}

type ServerFrame =
  | { kind: 'response'; id: number; response: IronTermRpcResponse }
  | { kind: 'event'; event: IronTermDaemonEvent };

export function resolveIronTermSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : 0,
): string {
  const explicit = env.IRON_TERM_SOCKET?.trim();
  if (explicit) return explicit;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, 'iron-term', 'agentd.sock');
  return `/tmp/iron-term-${uid}/agentd.sock`;
}

export function formatIronTermGridSnapshot(snapshot: IronTermGridSnapshot): string {
  if (!Array.isArray(snapshot.lines) || snapshot.lines.length === 0) return '';
  return snapshot.lines
    .slice()
    .sort((a, b) => a.row - b.row)
    .map((line) => line.text ?? '')
    .join('\n')
    .replace(/\n+$/, '');
}

function isLocalUnixSocket(socketPath: string): boolean {
  try {
    return fs.lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

export async function callIronTermRpc(
  socketPath: string,
  msg: IronTermClientMsg,
  timeoutMs = 1000,
): Promise<IronTermRpcResponse> {
  if (!isLocalUnixSocket(socketPath)) {
    throw new Error(`iron-term socket unavailable: ${socketPath}`);
  }

  return new Promise<IronTermRpcResponse>((resolve, reject) => {
    const reqId = 1;
    const decoder = new FrameDecoder();
    const sock = net.createConnection(socketPath);
    let settled = false;

    const finish = (err: Error | null, res?: IronTermRpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      try {
        sock.destroy();
      } catch {
        // Ignore cleanup errors.
      }
      if (err) reject(err);
      else resolve(res!);
    };

    const timer = setTimeout(() => {
      finish(new Error(`iron-term RPC timeout (${msg.type}) after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    sock.once('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    sock.once('close', () => finish(new Error(`iron-term socket closed before response (${msg.type})`)));

    sock.once('connect', () => {
      try {
        sock.write(encodeFrame({ id: reqId, msg }));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    sock.on('data', (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk) as ServerFrame[];
        for (const frame of frames) {
          if (!frame || typeof frame !== 'object') continue;
          if (frame.kind === 'event') continue;
          if (frame.kind === 'response' && frame.id === reqId) {
            if (frame.response?.type === 'error') {
              finish(
                new Error(
                  `iron-term RPC error (${frame.response.code ?? 'ERR'}): ${frame.response.message ?? 'unknown'}`,
                ),
              );
            } else {
              finish(null, frame.response);
            }
            return;
          }
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export async function listIronTermInstances(
  socketPath = resolveIronTermSocketPath(),
  timeoutMs = 800,
): Promise<RunningAgentInstance[]> {
  if (!isLocalUnixSocket(socketPath)) return [];
  try {
    const res = await callIronTermRpc(socketPath, { type: 'list_fleet' }, timeoutMs);
    if (res.type !== 'fleet' || !Array.isArray(res.sessions)) return [];
    const out: RunningAgentInstance[] = [];
    for (const sess of res.sessions) {
      if (!sess || typeof sess.id !== 'string' || !sess.id) continue;
      if (sess.state === 'hibernated') continue;
      out.push({
        kind: 'iron-term',
        target: `iron-term:${sess.id}`,
        sessionId: sess.id,
        windowName: sess.title || sess.id,
        command: sess.cli || 'iron-term',
        cwd: sess.worktree_path || '',
        pid: 0,
        isAgentLike: true,
        state: sess.state,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export class IronTermSessionConnection {
  private readonly sock: net.Socket;
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private closed = false;
  private connected = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (res: IronTermRpcResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(
    sock: net.Socket,
    private readonly onEvent: (ev: IronTermDaemonEvent) => void,
    private readonly onUnexpectedClose: (err?: Error) => void,
  ) {
    this.sock = sock;

    sock.on('data', (chunk: Buffer) => {
      try {
        const frames = this.decoder.push(chunk) as ServerFrame[];
        for (const frame of frames) {
          if (!frame || typeof frame !== 'object') continue;
          if (frame.kind === 'response') {
            const waiter = this.pending.get(frame.id);
            if (!waiter) continue;
            this.pending.delete(frame.id);
            clearTimeout(waiter.timer);
            if (frame.response?.type === 'error') {
              waiter.reject(
                new Error(
                  `iron-term RPC error (${frame.response.code ?? 'ERR'}): ${frame.response.message ?? 'unknown'}`,
                ),
              );
            } else {
              waiter.resolve(frame.response);
            }
          } else if (frame.kind === 'event' && frame.event) {
            this.onEvent(frame.event);
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleDisconnect(error);
      }
    });

    sock.on('error', (err) => {
      this.handleDisconnect(err instanceof Error ? err : new Error(String(err)));
    });

    sock.on('close', () => {
      this.handleDisconnect();
    });
  }

  static connect(
    socketPath: string,
    onEvent: (ev: IronTermDaemonEvent) => void,
    onUnexpectedClose: (err?: Error) => void,
    timeoutMs = 1500,
  ): Promise<IronTermSessionConnection> {
    if (!isLocalUnixSocket(socketPath)) {
      return Promise.reject(new Error(`iron-term socket unavailable: ${socketPath}`));
    }

    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.removeAllListeners();
        try {
          sock.destroy();
        } catch {
          // Ignore.
        }
        reject(new Error(`Timed out connecting to iron-term socket: ${socketPath}`));
      }, timeoutMs);
      timer.unref?.();

      sock.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners();
        try {
          sock.destroy();
        } catch {
          // Ignore.
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const conn = new IronTermSessionConnection(sock, onEvent, onUnexpectedClose);
        conn.connected = true;
        resolve(conn);
      });
    });
  }

  private handleDisconnect(err?: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.connected = false;
    for (const [id, waiter] of this.pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(err ?? new Error('iron-term socket disconnected'));
      this.pending.delete(id);
    }
    if (!wasClosed) {
      this.onUnexpectedClose(err);
    }
  }

  request(msg: IronTermClientMsg, timeoutMs = 1500): Promise<IronTermRpcResponse> {
    if (this.closed || !this.connected || this.sock.destroyed) {
      return Promise.reject(new Error('iron-term connection is closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iron-term RPC timeout (${msg.type}) after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sock.write(encodeFrame({ id, msg }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const [id, waiter] of this.pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('iron-term connection closed'));
      this.pending.delete(id);
    }
    try {
      this.sock.destroy();
    } catch {
      // Ignore cleanup errors.
    }
  }
}
