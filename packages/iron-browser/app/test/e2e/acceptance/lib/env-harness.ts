import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CleanupRegistry,
  CommandRunResult,
  CreateEnvOptions,
  EnvProfileName,
  IsolatedEnvHandle,
} from './types';

const PERSONAL_TOOL_BINS = new Set([
  'tmux',
  'alacritty',
  'hyprctl',
  'agy',
  'claude',
  'codex',
  'opencode',
]);

const ESSENTIAL_BINS = [
  'sh',
  'bash',
  'env',
  'awk',
  'gawk',
  'sed',
  'grep',
  'egrep',
  'fgrep',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'tr',
  'cut',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'ln',
  'chmod',
  'chown',
  'install',
  'readlink',
  'realpath',
  'dirname',
  'basename',
  'pwd',
  'echo',
  'printf',
  'sleep',
  'kill',
  'pkill',
  'ps',
  'uname',
  'hostname',
  'which',
  'touch',
  'date',
  'mktemp',
  'flock',
  'id',
  'whoami',
  'ls',
  'find',
  'xargs',
  'tee',
  'seq',
  'true',
  'false',
  'test',
  'expr',
  'python3',
  'python',
  'bun',
  'node',
  'cargo',
  'rustc',
  'desktop-file-validate',
  'update-desktop-database',
  'gtk-update-icon-cache',
  'xdg-open',
  'xclip',
  'wl-copy',
  'xsel',
];

const PERSONAL_ENV_VARS = [
  'TMUX',
  'TMUX_PANE',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'SWAYSOCK',
  'ALACRITTY_SOCKET',
  'ALACRITTY_LOG',
  'ALACRITTY_WINDOW_ID',
  'IRON_TERM_SOCKET',
  'IRON_TERM_HOSTS',
  'IRON_TERM_HOST_ID',
  'IRON_BROWSER_AGENT_CLIS',
  'IRON_BROWSER_SOCKET',
  'AGY_CONVERSATION_ID',
  'CLAUDE_CODE_SESSION_ID',
];

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0 && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group may have exited or child may not be a process-group leader; fall back to child.kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore already-exited child.
  }
}

export async function terminateChildProcess(
  child: ChildProcess,
  timeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    killProcessGroup(child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessGroup(child, 'SIGKILL');
        }
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // Post-exit sweep for any lingering grandchildren in the process group.
  killProcessGroup(child, 'SIGKILL');
}

export function resolveExecutableOnHost(
  cmd: string,
  searchPath?: string,
): string | null {
  if (!cmd) return null;
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      const st = fs.statSync(cmd);
      return st.isFile() ? cmd : null;
    } catch {
      return null;
    }
  }
  const explicitPath = searchPath !== undefined;
  const basePath = searchPath ?? process.env.PATH ?? '';
  const extraSearchDirs = explicitPath
    ? []
    : [
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.opencode', 'bin'),
        path.join(os.homedir(), '.bun', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ];
  const parts = [...basePath.split(path.delimiter).filter(Boolean), ...extraSearchDirs];
  const seen = new Set<string>();
  for (const dir of parts) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // Continue.
    }
  }
  return null;
}

export function createAcceptCleanupRegistry(): CleanupRegistry {
  const procs = new Map<ChildProcess, string>();
  const dirs = new Set<string>();
  const callbacks: Array<() => Promise<void> | void> = [];

  const killChildSafely = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      killProcessGroup(child, 'SIGKILL');
      return;
    }
    killProcessGroup(child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessGroup(child, 'SIGKILL');
        }
        resolve();
      }, 1_500);
      child.once('exit', () => {
        clearTimeout(timer);
        // Best-effort sweep for lingering grandchildren (e.g. chrome_crashpad_handler, NetworkService).
        killProcessGroup(child, 'SIGKILL');
        resolve();
      });
    });
  };

  return {
    trackProcess(proc: ChildProcess, label = 'child') {
      procs.set(proc, label);
      proc.once('exit', () => {
        procs.delete(proc);
      });
    },
    untrackProcess(proc: ChildProcess) {
      procs.delete(proc);
    },
    trackDir(dirPath: string) {
      dirs.add(dirPath);
    },
    trackCallback(fn: () => Promise<void> | void) {
      callbacks.push(fn);
    },
    async cleanupAll() {
      for (const fn of callbacks.splice(0).reverse()) {
        try {
          await fn();
        } catch {
          // Best-effort cleanup.
        }
      }
      const activeProcs = [...procs.keys()];
      procs.clear();
      await Promise.all(activeProcs.map((p) => killChildSafely(p)));
      for (const dir of [...dirs].reverse()) {
        dirs.delete(dir);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    },
  };
}

export function createIsolatedEnv(
  profile: EnvProfileName,
  opts: CreateEnvOptions = {},
  cleanup?: CleanupRegistry,
): IsolatedEnvHandle {
  // Keep path short for Linux sun_path (< 107 bytes) on Unix domain sockets.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-env-'));
  const homeDir = path.join(rootDir, 'home');
  const binDir = path.join(rootDir, 'bin');
  const configHome = path.join(homeDir, '.config');
  const dataHome = path.join(homeDir, '.local', 'share');
  const stateHome = path.join(homeDir, '.local', 'state');
  const cacheHome = path.join(homeDir, '.cache');
  const xdgBinHome = path.join(homeDir, '.local', 'bin');
  const runtimeDir = opts.unsetXdgRuntimeDir ? null : path.join(rootDir, 'rt');
  const agyHome = path.join(homeDir, '.gemini', 'antigravity-cli');
  const harnessHome = path.join(homeDir, '.claude');

  for (const dir of [
    homeDir,
    binDir,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    xdgBinHome,
    agyHome,
    harnessHome,
    ...(runtimeDir ? [runtimeDir] : []),
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const excluded = new Set(opts.excludeBins ?? []);
  if (profile === 'no-personal-tools') {
    for (const b of PERSONAL_TOOL_BINS) {
      excluded.add(b);
    }
  }

  const candidateBins =
    profile === 'adapter-present'
      ? [...ESSENTIAL_BINS, ...PERSONAL_TOOL_BINS]
      : [...ESSENTIAL_BINS];

  for (const binName of candidateBins) {
    if (excluded.has(binName)) continue;
    const resolved = resolveExecutableOnHost(binName);
    if (!resolved) continue;
    const linkPath = path.join(binDir, binName);
    try {
      fs.symlinkSync(resolved, linkPath);
    } catch {
      // Ignore duplicate or race.
    }
  }

  // Capture host paths before overriding HOME / XDG_RUNTIME_DIR.
  const origRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim() || '';
  const origXauthority = process.env.XAUTHORITY?.trim() || '';
  const hostHome = os.homedir();
  const rustupHome = process.env.RUSTUP_HOME?.trim() || path.join(hostHome, '.rustup');
  const cargoHome = process.env.CARGO_HOME?.trim() || path.join(hostHome, '.cargo');
  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim() || '';

  // Ensure xdgBinHome is also in PATH (after binDir) so portable installs can be invoked.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (profile === 'no-personal-tools') {
    for (const key of PERSONAL_ENV_VARS) {
      delete env[key];
    }
  }

  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = configHome;
  env.XDG_DATA_HOME = dataHome;
  env.XDG_STATE_HOME = stateHome;
  env.XDG_CACHE_HOME = cacheHome;
  env.XDG_BIN_HOME = xdgBinHome;
  env.AGY_HOME = agyHome;
  env.HARNESS_HOME = harnessHome;
  env.TASK_TITLE_RUN_DIR = path.join(harnessHome, 'run');
  env.PATH = `${binDir}${path.delimiter}${xdgBinHome}`;

  if (fs.existsSync(rustupHome)) env.RUSTUP_HOME = rustupHome;
  if (fs.existsSync(cargoHome)) env.CARGO_HOME = cargoHome;
  if (cargoTargetDir) env.CARGO_TARGET_DIR = cargoTargetDir;

  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  } else {
    delete env.XDG_RUNTIME_DIR;
  }

  if (opts.shell) {
    env.SHELL = opts.shell;
  } else {
    const defaultShell = path.join(binDir, 'bash');
    env.SHELL = fs.existsSync(defaultShell) ? defaultShell : '/bin/sh';
  }

  const writeMockExecutable = (name: string, scriptBody: string): string => {
    const targetPath = path.join(binDir, name);
    try {
      fs.unlinkSync(targetPath);
    } catch {
      // Not present yet.
    }
    const content = scriptBody.startsWith('#!')
      ? scriptBody
      : `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`;
    fs.writeFileSync(targetPath, content, { mode: 0o755 });
    return targetPath;
  };

  if (opts.extraBins) {
    for (const [name, script] of Object.entries(opts.extraBins)) {
      writeMockExecutable(name, script);
    }
  }

  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      if (v === null) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }
  }

  // Forward XAUTHORITY when DISPLAY is set and XAUTHORITY was not explicitly overridden/nulled.
  if (env.DISPLAY && opts.envOverrides?.XAUTHORITY === undefined && !env.XAUTHORITY) {
    const xauth = origXauthority || path.join(hostHome, '.Xauthority');
    if (fs.existsSync(xauth)) {
      env.XAUTHORITY = xauth;
    }
  }

  // Bridge host Wayland socket into isolated XDG_RUNTIME_DIR when WAYLAND_DISPLAY is relative
  // and was not explicitly overridden/nulled; delete dangling relative WAYLAND_DISPLAY if absent.
  const waylandDisplay = env.WAYLAND_DISPLAY?.trim();
  if (waylandDisplay && !path.isAbsolute(waylandDisplay)) {
    const hostWaylandSock = origRuntimeDir ? path.join(origRuntimeDir, waylandDisplay) : '';
    const hasHostWayland = Boolean(hostWaylandSock && fs.existsSync(hostWaylandSock));
    if (runtimeDir && hasHostWayland) {
      const targetSock = path.join(runtimeDir, waylandDisplay);
      try {
        if (!fs.existsSync(targetSock)) {
          fs.symlinkSync(hostWaylandSock, targetSock);
        }
      } catch {
        // Ignore duplicate or race.
      }
    } else if (!runtimeDir && hasHostWayland && opts.envOverrides?.WAYLAND_DISPLAY === undefined) {
      env.WAYLAND_DISPLAY = hostWaylandSock;
    } else if (opts.envOverrides?.WAYLAND_DISPLAY === undefined) {
      delete env.WAYLAND_DISPLAY;
    }
  }

  if (cleanup && !opts.keepTempDir) {
    cleanup.trackDir(rootDir);
  }

  return {
    profile,
    rootDir,
    homeDir,
    binDir,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    runtimeDir,
    xdgBinHome,
    agyHome,
    harnessHome,
    env,
    writeMockExecutable,
    which(cmd: string): string | null {
      return resolveExecutableOnHost(cmd, env.PATH ?? '');
    },
    dispose() {
      if (!opts.keepTempDir) {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    },
  };
}

export async function runSubprocess(
  command: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    unsetEnvKeys?: string[];
    cwd?: string;
    stdinData?: string;
    timeoutMs?: number;
    cleanup?: CleanupRegistry;
  } = {},
): Promise<CommandRunResult> {
  const childEnv: NodeJS.ProcessEnv = opts.env ? { ...opts.env } : { ...process.env };
  if (opts.unsetEnvKeys) {
    for (const k of opts.unsetEnvKeys) {
      delete childEnv[k];
    }
  }

  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: childEnv,
    detached: process.platform !== 'win32',
    stdio: [opts.stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  opts.cleanup?.trackProcess(child, path.basename(command));

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });

  if (opts.stdinData !== undefined && child.stdin) {
    child.stdin.write(opts.stdinData);
    child.stdin.end();
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timedOut = false;

  return new Promise<CommandRunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGKILL');
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
