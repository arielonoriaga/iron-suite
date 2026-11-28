import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  killProcessGroup,
  resolveExecutableOnHost,
  runSubprocess,
  terminateChildProcess,
} from './env-harness';
import type {
  CleanupRegistry,
  CommandRunResult,
  IronAgentdHandle,
  IronAgentdOptions,
  IronTermCtlOptions,
  IronTermHarness,
} from './types';

const DEFAULT_IRON_TERM_ROOT = '/home/ariel/Projects/iron-term';
const MAX_SUN_PATH_BYTES = 107;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createIronTermHarness(
  ironTermRoot = process.env.IRON_TERM_ROOT ?? DEFAULT_IRON_TERM_ROOT,
  cleanup?: CleanupRegistry,
): IronTermHarness {
  const resolveBinary = (name: 'iron-agentd' | 'iron-termctl' | 'iron-term'): string | null => {
    const cargoTargetDir = path.join(os.homedir(), '.cache', 'cargo-targets');
    const candidates: Array<string | undefined> = [
      process.env.IRON_TERM_BIN_DIR ? path.join(process.env.IRON_TERM_BIN_DIR, name) : undefined,
      path.join(ironTermRoot, 'target', 'release', name),
      path.join(ironTermRoot, 'target', 'debug', name),
      path.join(cargoTargetDir, 'iron-term-m4', 'release', name),
      path.join(cargoTargetDir, 'iron-term-m4', 'debug', name),
      path.join(cargoTargetDir, 'main', 'release', name),
      path.join(cargoTargetDir, 'main', 'debug', name),
      path.join(os.homedir(), '.local', 'bin', name),
      resolveExecutableOnHost(name) ?? undefined,
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        fs.accessSync(c, fs.constants.X_OK);
        if (fs.statSync(c).isFile()) return c;
      } catch {
        // Next.
      }
    }
    return null;
  };

  const requireBinary = (name: 'iron-agentd' | 'iron-termctl' | 'iron-term'): string => {
    const resolved = resolveBinary(name);
    if (!resolved) {
      throw new Error(`Required iron-term binary '${name}' not found`);
    }
    return resolved;
  };

  const runCtl = async (args: string[], opts: IronTermCtlOptions = {}): Promise<CommandRunResult> => {
    const ctlBin = requireBinary('iron-termctl');
    const fullArgs: string[] = [];
    if (opts.socketPath) {
      fullArgs.push('--socket', opts.socketPath);
    }
    if (opts.json) {
      fullArgs.push('--json');
    }
    fullArgs.push(...args);
    return runSubprocess(ctlBin, fullArgs, {
      env: opts.env,
      unsetEnvKeys: opts.unsetEnvKeys,
      timeoutMs: opts.timeoutMs ?? 12_000,
      cleanup,
    });
  };

  const runCtlJson = async <T = unknown>(
    args: string[],
    opts: Omit<IronTermCtlOptions, 'json'> = {},
  ): Promise<T> => {
    const res = await runCtl(args, { ...opts, json: true });
    if (res.exitCode !== 0) {
      throw new Error(
        `iron-termctl ${args.join(' ')} failed (exit=${res.exitCode}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
    }
    return JSON.parse(res.stdout) as T;
  };

  const startAgentd = async (opts: IronAgentdOptions = {}): Promise<IronAgentdHandle> => {
    const daemonBin = requireBinary('iron-agentd');
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-acc-'));
    fs.chmodSync(sessionDir, 0o700);
    cleanup?.trackDir(sessionDir);

    const socketPath = opts.socketPath ?? path.join(sessionDir, 'agentd.sock');
    const dbPath = opts.dbPath ?? path.join(sessionDir, 'state.db');

    if (Buffer.byteLength(socketPath, 'utf8') >= MAX_SUN_PATH_BYTES) {
      throw new Error(
        `iron-agentd socket path '${socketPath}' exceeds Linux sun_path limit (${MAX_SUN_PATH_BYTES - 1})`,
      );
    }

    const args = ['--socket', socketPath, '--db', dbPath];
    if (opts.hostId) {
      args.push('--host-id', opts.hostId);
    }

    const childEnv: NodeJS.ProcessEnv = opts.env ? { ...opts.env } : { ...process.env };
    if (opts.unsetEnvKeys) {
      for (const k of opts.unsetEnvKeys) {
        delete childEnv[k];
      }
    }

    const child = spawn(daemonBin, args, {
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup?.trackProcess(child, 'iron-agentd');

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });

    const readyTimeoutMs = opts.readyTimeoutMs ?? 8_000;
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `iron-agentd exited prematurely (code=${child.exitCode}, signal=${child.signalCode}):\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
        );
      }
      if (fs.existsSync(socketPath)) {
        const pingRes = await runCtl(['ping'], {
          socketPath,
          json: true,
          env: childEnv,
          timeoutMs: 2_000,
        }).catch(() => null);
        if (pingRes?.exitCode === 0) {
          ready = true;
          break;
        }
      }
      await sleep(50);
    }

    if (!ready) {
      killProcessGroup(child, 'SIGKILL');
      throw new Error(
        `Timed out waiting for iron-agentd on ${socketPath} after ${readyTimeoutMs}ms.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
      );
    }

    let closed = false;
    return {
      process: child,
      socketPath,
      dbPath,
      getStdout: () => stdoutBuf,
      getStderr: () => stderrBuf,
      async close() {
        if (closed) return;
        closed = true;
        await terminateChildProcess(child, 2_000);
        cleanup?.untrackProcess(child);
        fs.rmSync(sessionDir, { recursive: true, force: true });
      },
    };
  };

  return {
    resolveBinary,
    startAgentd,
    runCtl,
    runCtlJson,
    async runIronTerm(args, opts = {}) {
      const bin = requireBinary('iron-term');
      return runSubprocess(bin, args, {
        env: opts.env,
        unsetEnvKeys: opts.unsetEnvKeys,
        timeoutMs: opts.timeoutMs ?? 12_000,
        cleanup,
      });
    },
    async runInstallDesktop(opts) {
      const installerPath = path.join(ironTermRoot, 'packaging', 'install-desktop.sh');
      if (!fs.existsSync(installerPath)) {
        throw new Error(`iron-term desktop installer not found at ${installerPath}`);
      }
      const env: NodeJS.ProcessEnv = {
        ...opts.env.env,
        ...(opts.extraEnv ?? {}),
      };
      const args: string[] = [installerPath];
      if (opts.extraArgs && opts.extraArgs.length > 0) {
        args.push(...opts.extraArgs);
      } else if (opts.noBuild !== false) {
        let prebuiltBinDir: string | null = opts.binDir ?? null;
        if (!prebuiltBinDir) {
          const ironTermBin = resolveBinary('iron-term');
          if (ironTermBin) {
            const candidateDir = path.dirname(ironTermBin);
            if (
              fs.existsSync(path.join(candidateDir, 'iron-agentd')) &&
              fs.existsSync(path.join(candidateDir, 'iron-termctl'))
            ) {
              prebuiltBinDir = candidateDir;
            }
          }
        }
        args.push('--no-build');
        if (prebuiltBinDir) {
          args.push('--bin-dir', prebuiltBinDir);
        }
      }
      return runSubprocess('bash', args, {
        env,
        cwd: ironTermRoot,
        timeoutMs: opts.timeoutMs ?? 15_000,
        cleanup,
      });
    },
    async validateDesktopFile(desktopPath, opts = {}) {
      const validator = resolveExecutableOnHost('desktop-file-validate');
      if (!validator) {
        throw new Error('desktop-file-validate binary not found on host');
      }
      return runSubprocess(validator, [desktopPath], {
        env: opts.env,
        timeoutMs: 8_000,
        cleanup,
      });
    },
  };
}
