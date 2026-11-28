import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AcceptanceControlClient } from './ctl-client';
import { killProcessGroup } from './env-harness';
import type {
  AcceptanceElectronOptions,
  AcceptanceElectronSession,
  CdpSessionHandle,
  CdpTargetInfo,
  CleanupRegistry,
  ElectronExitStatus,
} from './types';

const APP_ROOT = path.resolve(import.meta.dir, '../../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const LAUNCHER_BIN = path.join(REPO_ROOT, 'bin', 'iron-browser');
const MAX_SUN_PATH_BYTES = 107;
const DEFAULT_READY_TIMEOUT_MS = 18_000;

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
      if (exitStatus !== null) return Promise.resolve(exitStatus);
      return new Promise<ElectronExitStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onExit);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `Timed out waiting for Electron (pid=${child.pid ?? 'unknown'}) to exit after ${timeoutMs}ms`,
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

async function connectCdpTarget(
  target: CdpTargetInfo,
  timeoutMs = 5_000,
): Promise<CdpSessionHandle> {
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`CDP target ${target.id} (${target.url}) has no webSocketDebuggerUrl`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
      reject(new Error(`Timed out connecting CDP WebSocket to ${target.url}`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error connecting to ${target.url}`));
    });
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (typeof msg.id !== 'number') return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP error (${msg.error.code ?? -1}): ${msg.error.message ?? 'unknown'}`));
      } else {
        entry.resolve(msg.result);
      }
    } catch {
      // Ignore malformed event.
    }
  });

  ws.addEventListener('close', () => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error('CDP WebSocket closed'));
    }
  });

  const send = <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    callTimeoutMs = 8_000,
  ): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call '${method}' timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  };

  await send('Runtime.enable');

  return {
    target,
    send,
    async evaluate<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
      const res = await send<{
        result?: { value?: T; description?: string; type?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        const msg =
          res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          'CDP evaluation exception';
        throw new Error(msg);
      }
      return res.result?.value as T;
    },
    async dispatchKey(opts) {
      let modifiers = 0;
      if (opts.alt) modifiers |= 1;
      if (opts.ctrl) modifiers |= 2;
      if (opts.meta) modifiers |= 4;
      if (opts.shift) modifiers |= 8;
      const code = opts.code ?? (opts.key.length === 1 ? `Key${opts.key.toUpperCase()}` : opts.key);
      const vk = opts.keyCode ?? (opts.key.length === 1 ? opts.key.toUpperCase().charCodeAt(0) : 0);
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: opts.key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      if (opts.key.length === 1 && !opts.ctrl && !opts.meta && !opts.alt) {
        await send('Input.dispatchKeyEvent', {
          type: 'char',
          text: opts.key,
          unmodifiedText: opts.key,
          modifiers,
        });
      }
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: opts.key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    },
  };
}

export async function launchAcceptanceElectron(
  opts: AcceptanceElectronOptions = {},
  cleanup?: CleanupRegistry,
): Promise<AcceptanceElectronSession> {
  if (opts.viaLauncher) {
    if (!fs.existsSync(LAUNCHER_BIN)) {
      throw new Error(`Launcher script not found at ${LAUNCHER_BIN}`);
    }
  } else if (!fs.existsSync(ELECTRON_BIN)) {
    throw new Error(`Electron binary not found at ${ELECTRON_BIN}`);
  }

  const sessionDir =
    opts.sessionDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ib-acc-'));
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  if (!opts.keepTempDir) {
    cleanup?.trackDir(sessionDir);
  }

  const userDataDir = path.join(sessionDir, 'ud');
  const downloadDir = opts.downloadDir ?? path.join(sessionDir, 'dl');
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });

  const stateFilePath = path.join(sessionDir, 'session-state.json');
  const socketPath = path.join(sessionDir, 'ctl.sock');

  if (Buffer.byteLength(socketPath, 'utf8') >= MAX_SUN_PATH_BYTES) {
    throw new Error(
      `Control socket path '${socketPath}' (${Buffer.byteLength(socketPath, 'utf8')} bytes) exceeds sun_path limit (${MAX_SUN_PATH_BYTES - 1})`,
    );
  }

  if (opts.seedSession !== undefined) {
    const raw =
      typeof opts.seedSession === 'string'
        ? opts.seedSession
        : JSON.stringify(opts.seedSession, null, 2);
    fs.writeFileSync(stateFilePath, raw, { mode: 0o600 });
  }

  const baseEnv: NodeJS.ProcessEnv = opts.isolatedEnv
    ? { ...opts.isolatedEnv.env }
    : { ...process.env };

  if (opts.unsetEnvKeys) {
    for (const k of opts.unsetEnvKeys) {
      delete baseEnv[k];
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    IRON_BROWSER_USER_DATA: userDataDir,
    IRON_BROWSER_STATE_FILE: stateFilePath,
    IRON_BROWSER_SOCKET: socketPath,
    IRON_BROWSER_DOWNLOAD_DIR: downloadDir,
  };

  const isSmoke = opts.smoke !== false;
  if (isSmoke) {
    env.IRON_BROWSER_SMOKE = '1';
  } else {
    delete env.IRON_BROWSER_SMOKE;
  }

  if (opts.env) {
    Object.assign(env, opts.env);
  }

  const args: string[] = opts.viaLauncher
    ? [`--user-data-dir=${userDataDir}`]
    : ['.', '--class=iron-browser-acceptance', `--user-data-dir=${userDataDir}`];

  const hasOzoneArg = opts.extraArgs?.some((a) => a.startsWith('--ozone-platform'));
  if (isSmoke) {
    args.push('--smoke');
  }

  if (!hasOzoneArg && opts.ozoneMode !== 'none') {
    if (opts.ozoneMode === 'x11') {
      args.push('--ozone-platform=x11');
    } else if (opts.ozoneMode === 'wayland') {
      args.push('--ozone-platform=wayland');
    } else if (opts.ozoneMode === 'headless') {
      args.push('--ozone-platform=headless');
    } else if (opts.ozoneMode === 'auto') {
      args.push('--ozone-platform-hint=auto');
    } else {
      // Portable automatic selection without assuming xvfb-run:
      // prefer X11 when DISPLAY is present for offscreen smoke screenshots;
      // fall back to Wayland if only WAYLAND_DISPLAY is present, else headless.
      if (isSmoke && env.DISPLAY) {
        args.push('--ozone-platform=x11');
      } else if (!env.DISPLAY && env.WAYLAND_DISPLAY) {
        args.push('--ozone-platform=wayland');
      } else if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
        args.push('--ozone-platform=headless');
      }
    }
  }

  if (opts.enableCdp) {
    args.push('--remote-debugging-port=0');
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

  const spawnCmd = opts.viaLauncher ? LAUNCHER_BIN : ELECTRON_BIN;
  const child = spawn(spawnCmd, args, {
    cwd: opts.viaLauncher ? REPO_ROOT : APP_ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup?.trackProcess(child, 'electron-acceptance');

  let stdoutBuf = '';
  let stderrBuf = '';
  let cdpPort: number | null = null;
  const stdoutListeners = new Set<() => void>();

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    for (const listener of stdoutListeners) listener();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (cdpPort === null) {
      const match = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match?.[1]) {
        cdpPort = Number.parseInt(match[1], 10);
      }
    }
  });

  const tracker = attachExitTracker(child);
  const ctl = new AcceptanceControlClient(socketPath);
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const waitForSmokeReadyLine = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (/^IRON_BROWSER_READY\s+.+$/m.test(stdoutBuf)) {
          done();
          resolve();
          return;
        }
        const exited = tracker.getExit();
        if (exited !== null) {
          done();
          reject(
            new Error(
              `Electron exited prematurely (code=${exited.code}, signal=${exited.signal}) before IRON_BROWSER_READY.\nstdout:\n${stdoutBuf.slice(-1500)}\nstderr:\n${stderrBuf.slice(-1500)}`,
            ),
          );
        }
      };
      const onExit = () => check();
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            `Timed out waiting for IRON_BROWSER_READY after ${readyTimeoutMs}ms.\nstdout:\n${stdoutBuf.slice(-1500)}\nstderr:\n${stderrBuf.slice(-1500)}`,
          ),
        );
      }, readyTimeoutMs);
      const done = () => {
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
          `Electron exited prematurely (code=${exited.code}, signal=${exited.signal}) before ctl ping.\nstdout:\n${stdoutBuf.slice(-1500)}\nstderr:\n${stderrBuf.slice(-1500)}`,
        );
      }
      if (fs.existsSync(socketPath)) {
        try {
          await ctl.connect(1000);
          const pong = await ctl.ping();
          if (pong.pong) return;
        } catch (err) {
          lastErr = err;
          ctl.close();
        }
      }
      await sleep(50);
    }
    throw new Error(
      `Timed out waiting for ctl socket ping (${socketPath}) after ${readyTimeoutMs}ms: ${String(lastErr)}`,
    );
  };

  try {
    if (isSmoke) {
      await waitForSmokeReadyLine();
      await ctl.connect(Math.min(5_000, readyTimeoutMs));
      const pong = await ctl.ping();
      if (!pong.pong) throw new Error('Control socket ping returned pong=false');
    } else {
      await waitForCtlPing();
    }
  } catch (err) {
    ctl.close();
    if (tracker.getExit() === null) {
      killProcessGroup(child, 'SIGKILL');
      await tracker.waitForExit(2_000).catch(() => {});
    }
    killProcessGroup(child, 'SIGKILL');
    if (!opts.keepTempDir) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    throw err;
  }

  let closed = false;
  const openCdpSessions = new Set<CdpSessionHandle>();

  const listCdpTargets = async (): Promise<CdpTargetInfo[]> => {
    if (!opts.enableCdp) {
      throw new Error('CDP was not enabled (pass enableCdp: true)');
    }
    const deadline = Date.now() + 5_000;
    while (cdpPort === null && Date.now() < deadline) {
      await sleep(40);
    }
    if (cdpPort === null) {
      throw new Error('Electron did not report DevTools listening port on stderr');
    }
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!res.ok) {
      throw new Error(`CDP /json/list returned HTTP ${res.status}`);
    }
    return (await res.json()) as CdpTargetInfo[];
  };

  return {
    ctl,
    process: child,
    sessionDir,
    userDataDir,
    stateFilePath,
    downloadDir,
    socketPath,
    get cdpPort() {
      return cdpPort;
    },
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    readRawStateFile: () => (fs.existsSync(stateFilePath) ? fs.readFileSync(stateFilePath, 'utf8') : null),
    readStateFile: <T = unknown>() => {
      if (!fs.existsSync(stateFilePath)) return null;
      return JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as T;
    },
    listCdpTargets,
    async connectCdp(predicate, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const targets = await listCdpTargets();
        const found = targets.find(predicate);
        if (found?.webSocketDebuggerUrl) {
          const handle = await connectCdpTarget(found, Math.min(5_000, timeoutMs));
          openCdpSessions.add(handle);
          // Wait for DOM & preload bridge readiness before returning handle.
          const isAgentDock = found.url.endsWith('/agent-dock.html');
          const isShell = found.url.endsWith('/index.html');
          let ready = false;
          let lastReadyErr: unknown = null;
          while (Date.now() < deadline) {
            try {
              const expr = isAgentDock
                ? 'document.readyState === "complete" && Boolean(window.ironAgent)'
                : isShell
                  ? 'document.readyState === "complete" && Boolean(window.ironShell)'
                  : 'document.readyState === "complete"';
              ready = await handle.evaluate<boolean>(expr);
              if (ready) break;
            } catch (err) {
              lastReadyErr = err;
            }
            await sleep(40);
          }
          if (!ready) {
            openCdpSessions.delete(handle);
            handle.close();
            throw new Error(
              `Timed out waiting for CDP target '${found.url}' readiness after ${timeoutMs}ms${lastReadyErr ? ` (lastErr=${String(lastReadyErr)})` : ''}`,
            );
          }
          return handle;
        }
        await sleep(60);
      }
      const latest = await listCdpTargets().catch(() => []);
      throw new Error(
        `Timed out finding CDP target after ${timeoutMs}ms; available=${JSON.stringify(latest.map((t) => ({ type: t.type, url: t.url })))}`,
      );
    },
    sendSignal: (sig: NodeJS.Signals) => {
      if (tracker.getExit() === null) {
        killProcessGroup(child, sig);
      }
    },
    waitForExit: (timeoutMs = 5_000) => tracker.waitForExit(timeoutMs),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const s of openCdpSessions) {
        s.close();
      }
      openCdpSessions.clear();
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
      // Best-effort post-exit sweep for surviving chrome_crashpad_handler / NetworkService grandchildren.
      killProcessGroup(child, 'SIGKILL');
      cleanup?.untrackProcess(child);
      if (!opts.keepTempDir) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    },
  };
}
