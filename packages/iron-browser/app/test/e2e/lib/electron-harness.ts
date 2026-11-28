import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ControlSocketClient } from './ctl-client';
import type {
  ElectronExitStatus,
  ElectronSession,
  LaunchOptions,
} from './types';

const APP_ROOT = path.resolve(import.meta.dir, '../../..');
function resolveElectronBinary(): string {
  try {
    const req = createRequire(path.join(APP_ROOT, 'package.json'));
    const resolved = req('electron') as unknown;
    if (typeof resolved === 'string' && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Fallback below.
  }
  return path.join(APP_ROOT, 'node_modules', '.bin', 'electron');
}
const ELECTRON_BIN = resolveElectronBinary();
const MAX_SUN_PATH_BYTES = 107;
const DEFAULT_READY_TIMEOUT_MS = 15_000;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0 && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to direct child.kill below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore already-exited child.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachExitTracker(child: ChildProcess): {
  getExit: () => ElectronExitStatus | null;
  waitForExit: (timeoutMs?: number) => Promise<ElectronExitStatus>;
} {
  let exitStatus: ElectronExitStatus | null = null;
  const waiters: Array<(status: ElectronExitStatus) => void> = [];

  child.once('exit', (code, signal) => {
    exitStatus = { code, signal };
    for (const resolve of waiters.splice(0)) {
      resolve(exitStatus);
    }
  });

  return {
    getExit: () => exitStatus,
    waitForExit: (timeoutMs = 5_000) => {
      if (exitStatus !== null) {
        return Promise.resolve(exitStatus);
      }
      return new Promise<ElectronExitStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onExit);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `Timed out waiting for Electron process (pid=${child.pid ?? 'unknown'}) to exit after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);

        const onExit = (status: ElectronExitStatus) => {
          clearTimeout(timer);
          resolve(status);
        };
        waiters.push(onExit);
      });
    },
  };
}

export async function launchElectronSession(
  opts: LaunchOptions = {},
): Promise<ElectronSession> {
  if (!fs.existsSync(ELECTRON_BIN)) {
    throw new Error(`Electron binary not found at ${ELECTRON_BIN}`);
  }

  const sessionDir =
    opts.sessionDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-'));
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const userDataDir = path.join(sessionDir, 'ud');
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });

  const stateFilePath = path.join(sessionDir, 'session-state.json');
  const socketPath = path.join(sessionDir, 'ctl.sock');

  if (Buffer.byteLength(socketPath, 'utf8') >= MAX_SUN_PATH_BYTES) {
    throw new Error(
      `Control socket path '${socketPath}' (${Buffer.byteLength(socketPath, 'utf8')} bytes) exceeds Linux sun_path limit (${MAX_SUN_PATH_BYTES - 1})`,
    );
  }

  if (opts.seedSession !== undefined) {
    const raw =
      typeof opts.seedSession === 'string'
        ? opts.seedSession
        : JSON.stringify(opts.seedSession, null, 2);
    fs.writeFileSync(stateFilePath, raw, { mode: 0o600 });
  }

  const isSmoke = opts.smoke !== false;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IRON_BROWSER_USER_DATA: userDataDir,
    IRON_BROWSER_STATE_FILE: stateFilePath,
    IRON_BROWSER_SOCKET: socketPath,
  };
  if (isSmoke) {
    env.IRON_BROWSER_SMOKE = '1';
  } else {
    delete env.IRON_BROWSER_SMOKE;
  }
  if (opts.env) {
    Object.assign(env, opts.env);
  }

  const args: string[] = ['.', '--class=iron-browser-e2e', `--user-data-dir=${userDataDir}`];
  const hasOzoneArg = opts.extraArgs?.some((a) =>
    a.startsWith('--ozone-platform'),
  );
  if (isSmoke) {
    args.push('--smoke');
  }
  if (!hasOzoneArg) {
    const hasDisplay = Boolean(env.DISPLAY?.trim());
    const hasWayland = Boolean(env.WAYLAND_DISPLAY?.trim());
    if (isSmoke && hasDisplay) {
      args.push('--ozone-platform=x11');
    } else if (!hasDisplay && hasWayland) {
      args.push('--ozone-platform=wayland');
    } else if (!hasDisplay && !hasWayland) {
      args.push('--ozone-platform=headless', '--ozone-override-screen-size=1480,920');
    }
  }
  if (opts.smokeExitMs !== undefined) {
    args.push(`--smoke-exit-ms=${opts.smokeExitMs}`);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  if (opts.initialUrl) {
    args.push(opts.initialUrl);
  }

  const child = spawn(ELECTRON_BIN, args, {
    cwd: APP_ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  const stdoutListeners = new Set<() => void>();

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    for (const listener of stdoutListeners) {
      listener();
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const tracker = attachExitTracker(child);
  const ctl = new ControlSocketClient(socketPath);
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const waitForSmokeReadyLine = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (/^IRON_BROWSER_READY\s+.+$/m.test(stdoutBuf)) {
          cleanup();
          resolve();
          return;
        }
        const exited = tracker.getExit();
        if (exited !== null) {
          cleanup();
          reject(
            new Error(
              `Electron exited prematurely (code=${exited.code}, signal=${exited.signal}) before IRON_BROWSER_READY.\nstdout:\n${stdoutBuf.slice(-2000)}\nstderr:\n${stderrBuf.slice(-2000)}`,
            ),
          );
        }
      };

      const onExit = () => check();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for IRON_BROWSER_READY after ${readyTimeoutMs}ms.\nstdout:\n${stdoutBuf.slice(-2000)}\nstderr:\n${stderrBuf.slice(-2000)}`,
          ),
        );
      }, readyTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        stdoutListeners.delete(check);
        child.off('exit', onExit);
      };

      stdoutListeners.add(check);
      child.once('exit', onExit);
      check();
    });

  const waitForCtlPing = async (): Promise<void> => {
    const deadline = Date.now() + readyTimeoutMs;
    let lastErr: unknown = null;

    while (Date.now() < deadline) {
      const exited = tracker.getExit();
      if (exited !== null) {
        throw new Error(
          `Electron exited prematurely (code=${exited.code}, signal=${exited.signal}) before control socket ping succeeded.\nstdout:\n${stdoutBuf.slice(-2000)}\nstderr:\n${stderrBuf.slice(-2000)}`,
        );
      }

      if (fs.existsSync(socketPath)) {
        try {
          await ctl.connect(1000);
          const res = await ctl.ping();
          if (res.pong) return;
        } catch (err) {
          lastErr = err;
          ctl.close();
        }
      }
      await sleep(50);
    }

    throw new Error(
      `Timed out waiting for control socket ping (${socketPath}) after ${readyTimeoutMs}ms: ${String(lastErr)}\nstdout:\n${stdoutBuf.slice(-2000)}\nstderr:\n${stderrBuf.slice(-2000)}`,
    );
  };

  try {
    if (isSmoke) {
      await waitForSmokeReadyLine();
      await ctl.connect(Math.min(5000, readyTimeoutMs));
      const pong = await ctl.ping();
      if (!pong.pong) {
        throw new Error('Control socket ping returned pong=false');
      }
    } else {
      await waitForCtlPing();
    }
  } catch (err) {
    ctl.close();
    if (tracker.getExit() === null) {
      killProcessGroup(child, 'SIGKILL');
      await tracker.waitForExit(2000).catch(() => {});
    } else {
      killProcessGroup(child, 'SIGKILL');
    }
    if (!opts.keepTempDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    throw err;
  }

  let closed = false;

  return {
    ctl,
    process: child,
    sessionDir,
    userDataDir,
    stateFilePath,
    socketPath,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    readRawStateFile: () => {
      if (!fs.existsSync(stateFilePath)) return null;
      return fs.readFileSync(stateFilePath, 'utf8');
    },
    readStateFile: <T = unknown>() => {
      if (!fs.existsSync(stateFilePath)) return null;
      const raw = fs.readFileSync(stateFilePath, 'utf8');
      return JSON.parse(raw) as T;
    },
    sendSignal: (sig: NodeJS.Signals) => {
      if (tracker.getExit() === null) {
        child.kill(sig);
      }
    },
    waitForExit: (timeoutMs = 5_000) => tracker.waitForExit(timeoutMs),
    close: async () => {
      if (closed) return;
      closed = true;

      ctl.close();
      if (tracker.getExit() === null) {
        killProcessGroup(child, 'SIGTERM');
        try {
          await tracker.waitForExit(3_000);
        } catch {
          if (tracker.getExit() === null) {
            killProcessGroup(child, 'SIGKILL');
            await tracker.waitForExit(2_000).catch(() => {});
          }
        }
      }
      killProcessGroup(child, 'SIGKILL');

      if (!opts.keepTempDir) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    },
  };
}
