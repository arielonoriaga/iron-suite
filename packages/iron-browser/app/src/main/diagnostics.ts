import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { redactMirrorUrl } from '../shared/mirror-core';

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB per rotated file
export const DEFAULT_MAX_ROTATED_LOGS = 3;
export const DEFAULT_STALL_THRESHOLD_MS = 4_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const SENSITIVE_KV_RE =
  /((?:^|[?&#\s"':,])(?:token|access_token|id_token|refresh_token|session_token|sessiontoken|jwt|secret|password|passwd|api_key|apikey|auth|signature|sig)=)([^&#\s"']+)/gi;
const SENSITIVE_FIELD_NAMES = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'session_token',
  'sessiontoken',
  'jwt',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
]);
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

export function redactDiagnosticText(raw: string, maxLen = 4096): string {
  if (!raw) return '';
  let out = raw.replace(URL_IN_TEXT_RE, (matched) => redactMirrorUrl(matched) ?? matched);
  out = out.replace(SENSITIVE_KV_RE, '$1[REDACTED]');
  if (out.length > maxLen) {
    return `${out.slice(0, maxLen)}…[truncated]`;
  }
  return out;
}

export function sanitizeDiagnosticFields(
  fields: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> {
  if (!fields || depth > 4) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = redactDiagnosticText(v);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (v instanceof Error) {
      out[k] = {
        name: v.name,
        message: redactDiagnosticText(v.message),
        stack: v.stack ? redactDiagnosticText(v.stack, 6144) : undefined,
      };
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 50).map((item) =>
        typeof item === 'string'
          ? redactDiagnosticText(item)
          : item && typeof item === 'object' && !Array.isArray(item)
            ? sanitizeDiagnosticFields(item as Record<string, unknown>, depth + 1)
            : item,
      );
    } else if (typeof v === 'object') {
      out[k] = sanitizeDiagnosticFields(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = redactDiagnosticText(String(v));
    }
  }
  return out;
}

export function resolveStateLogDir(opts?: {
  isSmoke?: boolean;
  userDataDir?: string;
}): string {
  const explicit = process.env.IRON_BROWSER_LOG_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const envUserData = process.env.IRON_BROWSER_USER_DATA?.trim();
  const candidateUserData = opts?.userDataDir?.trim() || envUserData;
  if (candidateUserData) {
    const resolvedUd = path.resolve(candidateUserData);
    const isCustomUserData =
      Boolean(opts?.isSmoke) ||
      Boolean(envUserData) ||
      path.basename(resolvedUd) !== 'iron-browser-app';
    if (isCustomUserData) {
      return path.join(resolvedUd, 'logs');
    }
  }
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) {
    return path.join(path.resolve(xdgState), 'iron-browser');
  }
  return path.join(os.homedir(), '.local', 'state', 'iron-browser');
}

export function resolveCrashDumpsDir(userDataDir?: string): string {
  const explicit = process.env.IRON_BROWSER_CRASH_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  if (userDataDir) {
    return path.join(path.resolve(userDataDir), 'Crashpad');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'iron-browser-app', 'Crashpad');
}

function ensureSafePrivateDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to use symlink or non-directory diagnostic path: ${dirPath}`);
    }
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to use symlink diagnostic directory: ${dirPath}`);
  }
}

export type LogLevel = 'info' | 'warn' | 'error' | 'fatal';

export class StructuredLogger {
  public readonly logDir: string;
  public readonly logPath: string;
  private readonly maxBytes: number;
  private readonly maxRotated: number;
  private bytesSinceCheck = 0;

  constructor(
    logDir: string,
    opts?: { maxBytes?: number; maxRotated?: number; filename?: string },
  ) {
    this.logDir = path.resolve(logDir);
    this.logPath = path.join(this.logDir, opts?.filename ?? 'main.log');
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxRotated = opts?.maxRotated ?? DEFAULT_MAX_ROTATED_LOGS;
    this.ensureReady();
  }

  private ensureReady(): void {
    ensureSafePrivateDir(this.logDir);
    if (fs.existsSync(this.logPath)) {
      const st = fs.lstatSync(this.logPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`refusing to write diagnostic log to symlink/non-file: ${this.logPath}`);
      }
      try {
        fs.chmodSync(this.logPath, 0o600);
      } catch {
        // Ignore chmod failure if not supported.
      }
    } else {
      const fd = fs.openSync(this.logPath, 'a', 0o600);
      fs.closeSync(fd);
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    this.bytesSinceCheck += incomingBytes;
    const checkThreshold = Math.min(16_384, Math.max(64, Math.floor(this.maxBytes / 4)));
    if (this.bytesSinceCheck < checkThreshold && incomingBytes < this.maxBytes) {
      return;
    }
    this.bytesSinceCheck = 0;
    try {
      if (!fs.existsSync(this.logPath)) return;
      const st = fs.lstatSync(this.logPath);
      if (st.isSymbolicLink() || st.size + incomingBytes <= this.maxBytes) {
        return;
      }
      for (let i = this.maxRotated; i >= 1; i -= 1) {
        const src = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
        const dst = `${this.logPath}.${i}`;
        if (fs.existsSync(src)) {
          const srcSt = fs.lstatSync(src);
          if (!srcSt.isSymbolicLink()) {
            fs.renameSync(src, dst);
            try {
              fs.chmodSync(dst, 0o600);
            } catch {
              // Ignore chmod errors.
            }
          }
        }
      }
      const fd = fs.openSync(this.logPath, 'a', 0o600);
      fs.closeSync(fd);
    } catch {
      // Never throw from diagnostic logger rotation.
    }
  }

  log(level: LogLevel, event: string, fields?: Record<string, unknown>, syncFsync = false): void {
    try {
      const record = {
        ts: new Date().toISOString(),
        pid: process.pid,
        level,
        event,
        ...sanitizeDiagnosticFields(fields),
      };
      const line = `${JSON.stringify(record)}\n`;
      const buf = Buffer.from(line, 'utf8');
      ensureSafePrivateDir(this.logDir);
      this.rotateIfNeeded(buf.length);
      if (fs.existsSync(this.logPath) && fs.lstatSync(this.logPath).isSymbolicLink()) {
        return;
      }
      const fd = fs.openSync(this.logPath, 'a', 0o600);
      try {
        fs.writeSync(fd, buf, 0, buf.length);
        if (syncFsync) {
          fs.fsyncSync(fd);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Diagnostic logging must never crash the caller.
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log('info', event, fields, false);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, fields, false);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log('error', event, fields, true);
  }

  fatal(event: string, fields?: Record<string, unknown>): void {
    this.log('fatal', event, fields, true);
  }

  tailLines(limit = 50): string[] {
    return tailLogLines(this.logPath, limit);
  }
}

export function tailLogLines(logPath: string, limit = 50): string[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit || 50), 1), 500);
  try {
    if (!fs.existsSync(logPath)) return [];
    const st = fs.lstatSync(logPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0) return [];

    const maxReadBytes = Math.min(st.size, 256 * 1024);
    const offset = Math.max(0, st.size - maxReadBytes);
    const buf = Buffer.alloc(maxReadBytes);
    const fd = fs.openSync(logPath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, maxReadBytes, offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (offset > 0 && lines.length > 1) {
      // Drop potentially partial leading line when reading from mid-file.
      lines.shift();
    }
    return lines.slice(-safeLimit);
  } catch {
    return [];
  }
}

export interface CrashDumpSummary {
  path: string;
  mtimeMs: number;
  mtimeIso: string;
  sizeBytes: number;
  totalDumps: number;
}

export function scanLatestCrashDump(crashDumpsDir: string): CrashDumpSummary | null {
  try {
    if (!fs.existsSync(crashDumpsDir)) return null;
    const rootSt = fs.lstatSync(crashDumpsDir);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return null;

    const subdirs = [
      crashDumpsDir,
      path.join(crashDumpsDir, 'completed'),
      path.join(crashDumpsDir, 'pending'),
      path.join(crashDumpsDir, 'reports'),
    ];
    let latest: { path: string; mtimeMs: number; sizeBytes: number } | null = null;
    let totalDumps = 0;

    for (const dir of subdirs) {
      if (!fs.existsSync(dir)) continue;
      const dirSt = fs.lstatSync(dir);
      if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.dmp') && !name.endsWith('.dmp.gz') && !name.endsWith('.minidump')) {
          continue;
        }
        const full = path.join(dir, name);
        try {
          const st = fs.lstatSync(full);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          totalDumps += 1;
          if (!latest || st.mtimeMs > latest.mtimeMs) {
            latest = { path: full, mtimeMs: Math.round(st.mtimeMs), sizeBytes: st.size };
          }
        } catch {
          // Ignore races with Crashpad cleanup.
        }
      }
    }

    if (!latest) return null;
    return {
      path: latest.path,
      mtimeMs: latest.mtimeMs,
      mtimeIso: new Date(latest.mtimeMs).toISOString(),
      sizeBytes: latest.sizeBytes,
      totalDumps,
    };
  } catch {
    return null;
  }
}

export interface PendingRpcSummary {
  id: number | string;
  method: string;
  startedAtMs: number;
  ageMs: number;
  tabId?: string;
  viewport?: string;
}

export interface WatchdogSnapshot {
  running: boolean;
  lastHeartbeatAgeMs: number;
  stallCount: number;
  lastStallAtMs: number | null;
  shuttingDown: boolean;
  shutdownReason: string | null;
}

const WATCHDOG_HEADER_INTS = 8; // 32 bytes
const WATCHDOG_BUF_BYTES = 4096;

const WATCHDOG_WORKER_SOURCE = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');

const { sab, logPath, pid, bootEpochMs, stallThresholdMs, shutdownTimeoutMs, pollIntervalMs } = workerData;
const i32 = new Int32Array(sab, 0, ${WATCHDOG_HEADER_INTS});
const u8 = new Uint8Array(sab, ${WATCHDOG_HEADER_INTS * 4});

let inspectorSession = null;
try {
  const inspector = require('node:inspector');
  if (inspector && typeof inspector.Session === 'function') {
    const sess = new inspector.Session();
    if (typeof sess.connectToMainThread === 'function') {
      sess.connectToMainThread();
      inspectorSession = sess;
    }
  }
} catch (_) {
  inspectorSession = null;
}

function readSharedContext() {
  try {
    const len = Math.min(Math.max(Atomics.load(i32, 4), 0), u8.byteLength);
    if (len === 0) return {};
    const copy = Buffer.from(u8.slice(0, len)).toString('utf8');
    return JSON.parse(copy);
  } catch (_) {
    return {};
  }
}

function appendLogSync(level, event, fields) {
  try {
    if (fs.existsSync(logPath) && fs.lstatSync(logPath).isSymbolicLink()) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid,
      level,
      event,
      ...fields,
    }) + '\\n';
    const fd = fs.openSync(logPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
}

function captureMainThreadStack(timeoutMs) {
  return new Promise((resolve) => {
    if (!inspectorSession) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (frames) => {
      if (settled) return;
      settled = true;
      try {
        inspectorSession.removeAllListeners('Debugger.paused');
        inspectorSession.post('Debugger.resume', () => {});
        inspectorSession.post('Debugger.disable', () => {});
      } catch (_) {}
      resolve(frames);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      inspectorSession.once('Debugger.paused', (msg) => {
        clearTimeout(timer);
        const rawFrames = (msg && msg.params && Array.isArray(msg.params.callFrames)) ? msg.params.callFrames : [];
        const top = rawFrames.slice(0, 12).map((f) => ({
          fn: (f && f.functionName) || '(anonymous)',
          url: (f && f.url) || '(internal)',
          line: f && f.location ? (f.location.lineNumber || 0) + 1 : 0,
          col: f && f.location ? (f.location.columnNumber || 0) + 1 : 0,
        }));
        finish(top);
      });
      inspectorSession.post('Debugger.enable', (err) => {
        if (err) {
          clearTimeout(timer);
          finish(null);
          return;
        }
        inspectorSession.post('Debugger.pause', (pauseErr) => {
          if (pauseErr) {
            clearTimeout(timer);
            finish(null);
          }
        });
      });
    } catch (_) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

let inStallEpisode = false;
let ticking = false;
let shutdownSeenAtMs = 0;

// NOTE: Do NOT call timer.unref() inside the Worker — w.unref() on the main thread already
// prevents this Worker from keeping the main process alive, whereas timer.unref() inside the
// Worker would cause the Worker's own event loop to exit immediately!
const timer = setInterval(async () => {
  if (Atomics.load(i32, 5) === 1) {
    clearInterval(timer);
    return;
  }
  if (ticking) return;
  ticking = true;
  try {
    const nowOffsetMs = Math.max(1, Date.now() - bootEpochMs);
    const shutdownFlag = Atomics.load(i32, 1);
    if (shutdownFlag !== 0) {
      if (shutdownSeenAtMs === 0) {
        shutdownSeenAtMs = Date.now();
      }
      const elapsedShutdown = Date.now() - shutdownSeenAtMs;
      if (elapsedShutdown >= shutdownTimeoutMs) {
        const ctx = readSharedContext();
        appendLogSync('fatal', 'watchdog.shutdown_timeout', {
          elapsedMs: elapsedShutdown,
          shutdownTimeoutMs,
          ...ctx,
        });
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) {}
        clearInterval(timer);
      }
      return;
    }

    const lastBeatOffset = Atomics.load(i32, 0);
    const stallMs = Math.max(0, nowOffsetMs - lastBeatOffset);
    if (stallMs >= stallThresholdMs) {
      if (!inStallEpisode) {
        inStallEpisode = true;
        Atomics.add(i32, 2, 1);
        Atomics.store(i32, 3, nowOffsetMs);
        const ctx = readSharedContext();
        const jsStack = await captureMainThreadStack(Math.min(350, Math.max(50, stallThresholdMs)));
        appendLogSync('warn', 'watchdog.main_thread_stall', {
          stallMs,
          stallThresholdMs,
          jsStack: jsStack || 'unavailable (native C++ / event-loop call or inspector busy)',
          ...ctx,
        });
      }
    } else if (inStallEpisode) {
      inStallEpisode = false;
      appendLogSync('info', 'watchdog.main_thread_recovered', {
        lastBeatGapMs: stallMs,
      });
    }
  } finally {
    ticking = false;
  }
}, pollIntervalMs);
`;

export class MainThreadWatchdog {
  private readonly sab = new SharedArrayBuffer(WATCHDOG_BUF_BYTES);
  private readonly i32 = new Int32Array(this.sab, 0, WATCHDOG_HEADER_INTS);
  private readonly u8 = new Uint8Array(this.sab, WATCHDOG_HEADER_INTS * 4);
  private readonly bootEpochMs = Date.now();
  private readonly stallThresholdMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;

  private worker: Worker | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBeatWallMs = Date.now();
  private shuttingDown = false;
  private shutdownReason: string | null = null;
  private pendingRpcs: Array<{
    id: number | string;
    method: string;
    startedAtMs: number;
    tabId?: string;
    viewport?: string;
  }> = [];

  constructor(
    private readonly logPath: string,
    opts?: {
      stallThresholdMs?: number;
      shutdownTimeoutMs?: number;
      pollIntervalMs?: number;
    },
  ) {
    this.stallThresholdMs = opts?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.shutdownTimeoutMs = opts?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 500;
  }

  private writeSharedContext(extra?: Record<string, unknown>): void {
    try {
      const now = Date.now();
      const payload = JSON.stringify({
        ...(this.shutdownReason ? { shutdownReason: this.shutdownReason } : {}),
        pendingRpcs: this.pendingRpcs.slice(0, 16).map((r) => ({
          id: r.id,
          method: r.method,
          ageMs: Math.max(0, now - r.startedAtMs),
          ...(r.tabId ? { tabId: r.tabId } : {}),
          ...(r.viewport ? { viewport: r.viewport } : {}),
        })),
        ...extra,
      });
      const encoded = Buffer.from(payload, 'utf8');
      const len = Math.min(encoded.length, this.u8.byteLength);
      this.u8.set(encoded.subarray(0, len), 0);
      Atomics.store(this.i32, 4, len);
    } catch {
      // Ignore context serialization errors.
    }
  }

  private beat(): void {
    const now = Date.now();
    this.lastBeatWallMs = now;
    Atomics.store(this.i32, 0, Math.max(1, now - this.bootEpochMs));
  }

  start(): void {
    if (this.worker) return;
    this.beat();
    this.writeSharedContext();

    this.beatTimer = setInterval(() => {
      this.beat();
    }, Math.min(500, Math.max(50, Math.floor(this.stallThresholdMs / 4))));
    this.beatTimer.unref?.();

    try {
      const w = new Worker(WATCHDOG_WORKER_SOURCE, {
        eval: true,
        workerData: {
          sab: this.sab,
          logPath: this.logPath,
          pid: process.pid,
          bootEpochMs: this.bootEpochMs,
          stallThresholdMs: this.stallThresholdMs,
          shutdownTimeoutMs: this.shutdownTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
        },
      });
      w.on('error', () => {
        // Never crash main process on watchdog worker error.
      });
      w.unref();
      this.worker = w;
    } catch {
      this.worker = null;
    }
  }

  setPendingRpcs(
    rpcs: Array<{
      id: number | string;
      method: string;
      startedAtMs: number;
      tabId?: string;
      viewport?: string;
    }>,
  ): void {
    this.pendingRpcs = rpcs;
    this.beat();
    this.writeSharedContext();
  }

  notifyShutdown(reason: string, extraPending?: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownReason = reason;
    this.writeSharedContext(extraPending);
    Atomics.store(this.i32, 1, Math.max(1, Date.now() - this.bootEpochMs));

    if (this.beatTimer) {
      clearInterval(this.beatTimer);
      this.beatTimer = null;
    }

    // Dual-layer shutdown watchdog: in-process unref timer + off-thread Worker SIGKILL backstop.
    this.shutdownFallbackTimer = setTimeout(() => {
      process.exit(0);
    }, this.shutdownTimeoutMs);
    this.shutdownFallbackTimer.unref?.();
  }

  getSnapshot(): WatchdogSnapshot {
    const stallCount = Atomics.load(this.i32, 2);
    const lastStallOffset = Atomics.load(this.i32, 3);
    return {
      running: this.worker !== null,
      lastHeartbeatAgeMs: Math.max(0, Date.now() - this.lastBeatWallMs),
      stallCount,
      lastStallAtMs: lastStallOffset > 0 ? this.bootEpochMs + lastStallOffset : null,
      shuttingDown: this.shuttingDown,
      shutdownReason: this.shutdownReason,
    };
  }

  stop(): void {
    Atomics.store(this.i32, 5, 1);
    if (this.beatTimer) {
      clearInterval(this.beatTimer);
      this.beatTimer = null;
    }
    if (this.shutdownFallbackTimer) {
      clearTimeout(this.shutdownFallbackTimer);
      this.shutdownFallbackTimer = null;
    }
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      void w.terminate().catch(() => {});
    }
  }
}

/**
 * Out-of-process zero-CPU pipe-EOF monitor that records fatal native crashes (`SIGSEGV`, `SIGABRT`,
 * `SIGBUS`, `SIGILL`) or external `SIGKILL`s into `main.log` even when V8/Node exit hooks cannot run.
 */
export class AbnormalExitMonitor {
  private child: ChildProcess | null = null;
  private notifiedClean = false;

  constructor(
    private readonly opts: {
      pid?: number;
      logPath: string;
      crashDumpsDir: string;
    },
  ) {}

  start(): void {
    if (process.platform === 'win32' || this.child) return;
    if (!this.opts.logPath || !fs.existsSync('/bin/sh')) return;
    const pidStr = String(this.opts.pid ?? process.pid);
    const script = [
      'IFS= read -r status_line || true',
      '[ "$status_line" = "clean" ] && exit 0',
      'sleep 0.05 2>/dev/null || sleep 1',
      'pid="$1"; log_path="$2"; crash_dir="$3"',
      '[ -z "$log_path" ] && exit 0',
      '[ -L "$log_path" ] && exit 0',
      'log_dir=$(dirname "$log_path")',
      '[ -L "$log_dir" ] && exit 0',
      'latest_dmp=""',
      'if [ -d "$crash_dir" ] && [ ! -L "$crash_dir" ]; then',
      '  for d in "$crash_dir/pending" "$crash_dir/completed" "$crash_dir"; do',
      '    [ -d "$d" ] && [ ! -L "$d" ] || continue',
      '    cand=$(ls -1t "$d"/*.dmp 2>/dev/null | head -n 1)',
      '    if [ -n "$cand" ]; then latest_dmp="$cand"; break; fi',
      '  done',
      'fi',
      'ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "")',
      'esc_dmp=$(printf "%s" "$latest_dmp" | tr -d \'\\n\\r"\\\\\')',
      'if [ -n "$esc_dmp" ]; then',
      '  printf \'{"ts":"%s","pid":%s,"level":"fatal","event":"process.abnormal_exit","reason":"native_signal_or_sigkill","latestCrashDump":"%s"}\\n\' "$ts" "$pid" "$esc_dmp" >> "$log_path" 2>/dev/null || true',
      'else',
      '  printf \'{"ts":"%s","pid":%s,"level":"fatal","event":"process.abnormal_exit","reason":"native_signal_or_sigkill"}\\n\' "$ts" "$pid" >> "$log_path" 2>/dev/null || true',
      'fi',
    ].join('\n');

    try {
      const child = spawn(
        '/bin/sh',
        ['-c', script, '_', pidStr, this.opts.logPath, this.opts.crashDumpsDir],
        {
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      child.unref();
      child.stdin?.on('error', () => {});
      (child.stdin as unknown as { unref?: () => void })?.unref?.();
      this.child = child;
    } catch {
      this.child = null;
    }
  }

  notifyCleanExit(): void {
    if (this.notifiedClean) return;
    this.notifiedClean = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      const rawFd = (child.stdin as unknown as { _handle?: { fd?: number } })?._handle?.fd;
      if (typeof rawFd === 'number' && rawFd >= 0) {
        fs.writeSync(rawFd, 'clean\n');
      } else {
        child.stdin?.write('clean\n');
      }
    } catch {
      // Ignore broken pipe if helper already exited.
    }
    try {
      child.stdin?.destroy();
    } catch {
      // Ignore stream close errors.
    }
  }
}
