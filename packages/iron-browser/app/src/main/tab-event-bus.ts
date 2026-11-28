import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { ViewportRole } from '../shared/types';
import { isValidHttpOrigin } from '../shared/ws-sse-mux-core';

export type TabBusDomain =
  | 'gesture'
  | 'navigation'
  | 'http_dedup'
  | 'ws_mux'
  | 'storage'
  | 'download'
  | 'popup'
  | 'callback'
  | 'console'
  | 'network'
  | 'trace'
  | 'mirror'
  | 'lifecycle';

export interface TabBusEvent {
  seq: number;
  tsMs: number;
  tabId: string;
  viewport: ViewportRole | 'both';
  domain: TabBusDomain | string;
  kind: string;
  summary: string;
  gestureSeq?: number;
  detail?: string;
}

export interface PublishBusEventInput {
  tabId: string;
  viewport?: ViewportRole | 'both';
  domain: TabBusDomain;
  kind: string;
  summary: string;
  tsMs?: number;
  gestureSeq?: number;
  detail?: string;
}

export interface ClaimEffectResult {
  allowed: boolean;
  seq: number;
  ownerSeq: number;
  gestureSeq: number | null;
}

export interface SessionStorageMutationResult {
  ok: boolean;
  changed: boolean;
  entries?: Record<string, string>;
  error?: string;
}

export interface QueryBusFilter {
  tabId?: string;
  domain?: string;
  viewport?: ViewportRole | 'both';
  sinceSeq?: number;
  gestureSeq?: number;
  limit?: number;
}

export interface QueryBusResult {
  backend: 'rust-napi' | 'ts-fallback';
  latestSeq: number;
  totalPublished: number;
  totalSuppressed: number;
  count: number;
  events: TabBusEvent[];
}

interface NativeBusBinding {
  busCreate(maxEventsPerTab: number): number;
  busDestroy(handle: number): boolean;
  busBeginGesture(
    handle: number,
    tabId: string,
    role: string,
    action: string,
    nowMs: number,
  ): number;
  busPublish(handle: number, jsonPayload: string): number;
  busClaimEffect(
    handle: number,
    tabId: string,
    role: string,
    category: string,
    effectKey: string,
    windowMs: number,
    nowMs: number,
  ): string;
  busSessionStorageOp(handle: number, jsonPayload: string): string;
  busQuery(handle: number, jsonFilter: string): string;
  busClearTab(handle: number, tabId: string): boolean;
  ptySpawn?(jsonPayload: string): string;
  ptyWrite?(id: number, dataB64: string): string;
  ptyResize?(id: number, cols: number, rows: number): boolean;
  ptyPoll?(id: number): string;
  ptyKill?(id: number): boolean;
}

export interface NativePtyBinding {
  ptySpawn(jsonPayload: string): string;
  ptyWrite(id: number, dataB64: string): string;
  ptyResize(id: number, cols: number, rows: number): boolean;
  ptyPoll(id: number): string;
  ptyKill(id: number): boolean;
}

export function loadNativePtyBinding(): NativePtyBinding | null {
  const b = loadNativeBusBinding();
  if (
    b &&
    typeof b.ptySpawn === 'function' &&
    typeof b.ptyWrite === 'function' &&
    typeof b.ptyResize === 'function' &&
    typeof b.ptyPoll === 'function' &&
    typeof b.ptyKill === 'function'
  ) {
    return b as unknown as NativePtyBinding;
  }
  return null;
}

let cachedNativeBinding: NativeBusBinding | null | undefined;

function candidateNativeAddonPaths(): string[] {
  const candidates: string[] = [];
  const envPath = process.env.IRON_BROWSER_BUS_ADDON?.trim();
  if (envPath) candidates.push(envPath);

  // Resolve relative to `__dirname` (`app/dist/main` or `app/src/main`), Electron's `app.getAppPath()`,
  // and `process.cwd()` so launching IronBrowser from external repos always finds `iron_browser_bus.node`.
  const bases = [
    __dirname,
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  if (process.versions?.electron) {
    try {
      const reqSelf = createRequire(path.join(__dirname, 'index.js'));
      const electronMod = reqSelf('electron') as { app?: { getAppPath?: () => string } } | undefined;
      const appPath = electronMod?.app?.getAppPath?.();
      if (typeof appPath === 'string' && appPath.length > 0) {
        bases.unshift(appPath, path.resolve(appPath, '..'));
      }
    } catch {
      // Ignore when running outside Electron main process.
    }
  }

  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim();
  if (cargoTargetDir) {
    candidates.push(path.join(cargoTargetDir, 'release', 'iron_browser_bus.node'));
    candidates.push(path.join(cargoTargetDir, 'debug', 'iron_browser_bus.node'));
  }

  for (const base of bases) {
    candidates.push(path.resolve(base, '../native/iron_browser_bus.node'));
    candidates.push(path.resolve(base, 'dist/native/iron_browser_bus.node'));
    candidates.push(path.resolve(base, 'app/dist/native/iron_browser_bus.node'));
    candidates.push(path.resolve(base, '../../target/release/iron_browser_bus.node'));
    candidates.push(path.resolve(base, '../target/release/iron_browser_bus.node'));
    candidates.push(path.resolve(base, 'target/release/iron_browser_bus.node'));
  }
  return Array.from(new Set(candidates));
}

function loadNativeBusBinding(): NativeBusBinding | null {
  if (cachedNativeBinding !== undefined) {
    return cachedNativeBinding;
  }
  let req: NodeRequire;
  try {
    req = createRequire(__filename);
  } catch {
    req = createRequire(path.join(__dirname, 'index.js'));
  }
  for (const candidate of candidateNativeAddonPaths()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const candStat = fs.lstatSync(candidate);
      if (!candStat.isFile() || candStat.isSymbolicLink()) continue;

      // Copy to an exclusive mkdtempSync 0700 directory and unlink immediately after dlopen() so an
      // external in-place overwrite (`cp -f`) of `iron_browser_bus.node` can NEVER SIGSEGV our mapped pages,
      // while avoiding predictable /tmp directory names (F-32).
      let loadTarget = candidate;
      let tempDir: string | null = null;
      let tempCopy: string | null = null;
      try {
        const baseTmp = process.env.XDG_RUNTIME_DIR?.trim() || os.tmpdir();
        const createdDir = fs.mkdtempSync(path.join(baseTmp, 'iron-browser-nat-'));
        fs.chmodSync(createdDir, 0o700);
        const dirSt = fs.lstatSync(createdDir);
        const uidOk = typeof process.getuid !== 'function' || dirSt.uid === process.getuid();
        const modeOk = (dirSt.mode & 0o077) === 0;
        if (dirSt.isDirectory() && !dirSt.isSymbolicLink() && uidOk && modeOk) {
          tempDir = createdDir;
          const uniquePath = path.join(createdDir, `iron_browser_bus-${process.pid}.node`);
          const bytes = fs.readFileSync(candidate);
          const fd = fs.openSync(uniquePath, 'wx', 0o700);
          try {
            fs.writeSync(fd, bytes, 0, bytes.length);
          } finally {
            fs.closeSync(fd);
          }
          loadTarget = uniquePath;
          tempCopy = uniquePath;
        } else {
          try {
            fs.rmdirSync(createdDir);
          } catch {
            // Ignore cleanup failure.
          }
        }
      } catch {
        loadTarget = candidate;
        tempCopy = null;
      }
      let loaded: Partial<NativeBusBinding>;
      try {
        loaded = req(loadTarget) as Partial<NativeBusBinding>;
      } finally {
        if (tempCopy) {
          try {
            fs.unlinkSync(tempCopy);
          } catch {
            // Ignore unlink races.
          }
        }
        if (tempDir) {
          try {
            fs.rmdirSync(tempDir);
          } catch {
            // Ignore rmdir races.
          }
        }
      }
      if (
        loaded &&
        typeof loaded.busCreate === 'function' &&
        typeof loaded.busPublish === 'function' &&
        typeof loaded.busClaimEffect === 'function' &&
        typeof loaded.busSessionStorageOp === 'function' &&
        typeof loaded.busQuery === 'function'
      ) {
        cachedNativeBinding = loaded as NativeBusBinding;
        return cachedNativeBinding;
      }
    } catch {
      // Try next candidate path.
    }
  }
  cachedNativeBinding = null;
  return null;
}

const SENSITIVE_PARAM_RE =
  /([?&#](?:token|access_token|id_token|refresh_token|sessiontoken|session_token|session|auth|key|apikey|api_key|secret|ticket|code|password|passwd|sig|signature)=)[^&#"'\s]*/gi;

function redactFallbackText(s: string, maxLen: number): string {
  const red = s.replace(SENSITIVE_PARAM_RE, '$1[REDACTED]');
  return red.length <= maxLen ? red : red.slice(0, maxLen);
}

export function reserveSafeDownloadPath(targetDir: string, rawFilename: string): string | null {
  try {
    if (fs.existsSync(targetDir)) {
      const existingStat = fs.lstatSync(targetDir);
      if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) {
        return null;
      }
    } else {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const createdStat = fs.lstatSync(targetDir);
      if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
        return null;
      }
    }
    let clean = path
      .basename(rawFilename || 'download')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .trim();
    if (!clean || clean === '.' || clean === '..') {
      clean = 'download';
    } else if (clean.startsWith('.')) {
      clean = `download_${clean.slice(1) || 'file'}`;
    }
    const parsed = path.parse(clean);
    const stem = (parsed.name || 'download').slice(0, 160);
    const ext = parsed.ext.slice(0, 32);

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidateName = attempt === 0 ? `${stem}${ext}` : `${stem} (${attempt})${ext}`;
      const candidatePath = path.join(targetDir, candidateName);
      try {
        const fd = fs.openSync(candidatePath, 'wx', 0o600);
        fs.closeSync(fd);
        return candidatePath;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
          continue;
        }
        return null;
      }
    }
  } catch {
    // Fall back if target directory is not writable.
  }
  return null;
}

export function cleanupEmptyReservedDownload(reservedPath: string | null): void {
  if (!reservedPath) return;
  try {
    const st = fs.lstatSync(reservedPath);
    if (st.isFile() && !st.isSymbolicLink() && st.size === 0) {
      fs.unlinkSync(reservedPath);
    }
  } catch {
    // Ignore if Chromium already removed or replaced the file.
  }
}

/**
 * High-speed per-TabManager causal Event Bus backed by native in-process Rust (`crates/iron-browser-bus`)
 * via Node-API (`rust-napi`), with automatic behavioral fallback if the `.node` binary has not been built yet.
 */
export class TabEventBus {
  private readonly native: NativeBusBinding | null;
  private handle: number | null = null;
  private readonly now: () => number;
  private readonly maxEventsPerTab: number;
  private readonly listeners = new Set<(event: TabBusEvent) => void>();
  private disposed = false;

  // Fallback state (used only if native `.node` addon is absent)
  private fbSeq = 1;
  private fbPublished = 0;
  private fbSuppressed = 0;
  private readonly fbGestures = new Map<string, { seq: number; tsMs: number }>();
  private readonly fbEvents = new Map<string, TabBusEvent[]>();
  private readonly fbClaims = new Map<
    string,
    Map<string, { seq: number; sourceRole: string; tsMs: number; windowMs: number; gestureSeq: number | null }>
  >();
  private readonly fbSessionStorage = new Map<string, Map<string, Map<string, string>>>();
  private readonly lastSessionStorageWriteByTab = new Map<string, number>();

  constructor(opts: { maxEventsPerTab?: number; now?: () => number } = {}) {
    this.maxEventsPerTab = Math.min(Math.max(opts.maxEventsPerTab ?? 2048, 64), 16_384);
    this.now = opts.now ?? (() => Date.now());
    this.native = loadNativeBusBinding();
    if (this.native) {
      this.handle = this.native.busCreate(this.maxEventsPerTab);
    }
  }

  get backend(): 'rust-napi' | 'ts-fallback' {
    return this.native && this.handle !== null ? 'rust-napi' : 'ts-fallback';
  }

  subscribe(listener: (event: TabBusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(ev: TabBusEvent): void {
    if (this.listeners.size === 0) return;
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(ev);
      } catch {
        // Isolate subscriber callbacks.
      }
    }
  }

  beginGesture(tabId: string, sourceRole: ViewportRole, action: string, tsMs = this.now()): number {
    if (this.disposed || !tabId) return 0;
    let seq: number;
    if (this.native && this.handle !== null) {
      seq = this.native.busBeginGesture(this.handle, tabId, sourceRole, action, tsMs);
    } else {
      seq = this.fbSeq++;
      this.fbGestures.set(tabId, { seq, tsMs });
      this.fbPush({
        seq,
        tsMs,
        tabId,
        viewport: sourceRole,
        domain: 'gesture',
        kind: action,
        summary: `gesture:${action} on ${sourceRole}`,
        gestureSeq: seq,
      });
    }
    this.notifyListeners({
      seq,
      tsMs,
      tabId,
      viewport: sourceRole,
      domain: 'gesture',
      kind: action,
      summary: `gesture:${action} on ${sourceRole}`,
      gestureSeq: seq,
    });
    return seq;
  }

  publish(input: PublishBusEventInput): number {
    if (this.disposed || !input.tabId) return 0;
    const tsMs = input.tsMs ?? this.now();
    const viewport = input.viewport ?? 'both';
    let seq: number;
    if (this.native && this.handle !== null) {
      seq = this.native.busPublish(
        this.handle,
        JSON.stringify({
          tabId: input.tabId,
          viewport,
          domain: input.domain,
          kind: input.kind,
          summary: input.summary,
          tsMs,
          ...(input.gestureSeq !== undefined ? { gestureSeq: input.gestureSeq } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        }),
      );
    } else {
      seq = this.fbSeq++;
      const g = this.fbGestures.get(input.tabId);
      const gestureSeq =
        input.gestureSeq ?? (g && tsMs - g.tsMs <= 1000 ? g.seq : undefined);
      this.fbPush({
        seq,
        tsMs,
        tabId: input.tabId,
        viewport,
        domain: input.domain,
        kind: input.kind,
        summary: redactFallbackText(input.summary, 1024),
        ...(gestureSeq !== undefined ? { gestureSeq } : {}),
        ...(input.detail !== undefined ? { detail: redactFallbackText(input.detail, 4096) } : {}),
      });
    }
    if (this.listeners.size > 0) {
      this.notifyListeners({
        seq,
        tsMs,
        tabId: input.tabId,
        viewport,
        domain: input.domain,
        kind: input.kind,
        summary: redactFallbackText(input.summary, 1024),
        ...(input.gestureSeq !== undefined ? { gestureSeq: input.gestureSeq } : {}),
      });
    }
    return seq;
  }

  claimEffect(
    tabId: string,
    role: ViewportRole,
    category: 'popup' | 'download' | 'callback',
    effectKey: string,
    windowMs = 1500,
    tsMs = this.now(),
  ): ClaimEffectResult {
    if (this.disposed || !tabId) {
      return { allowed: true, seq: 0, ownerSeq: 0, gestureSeq: null };
    }
    if (this.native && this.handle !== null) {
      const raw = this.native.busClaimEffect(
        this.handle,
        tabId,
        role,
        category,
        effectKey,
        windowMs,
        tsMs,
      );
      return JSON.parse(raw) as ClaimEffectResult;
    }

    const seq = this.fbSeq++;
    let claims = this.fbClaims.get(tabId);
    if (!claims) {
      claims = new Map();
      this.fbClaims.set(tabId, claims);
    }
    for (const [k, c] of Array.from(claims.entries())) {
      if (tsMs - c.tsMs > c.windowMs) claims.delete(k);
    }
    const g = this.fbGestures.get(tabId);
    const currentGesture = g && tsMs - g.tsMs <= 1000 ? g.seq : null;
    const compKey = `${category}|${effectKey}`;
    const existing = claims.get(compKey);
    if (existing && existing.sourceRole !== role && tsMs - existing.tsMs <= existing.windowMs) {
      claims.delete(compKey);
      this.fbSuppressed += 1;
      const gSeq = existing.gestureSeq ?? currentGesture;
      this.fbPush({
        seq,
        tsMs,
        tabId,
        viewport: role,
        domain: category,
        kind: 'dedup_suppressed',
        summary: `suppressed duplicate ${category} (${redactFallbackText(effectKey, 240)}) -> owner #${existing.seq}`,
        ...(gSeq !== null ? { gestureSeq: gSeq } : {}),
      });
      return { allowed: false, seq, ownerSeq: existing.seq, gestureSeq: gSeq };
    }
    claims.set(compKey, { seq, sourceRole: role, tsMs, windowMs, gestureSeq: currentGesture });
    this.fbPush({
      seq,
      tsMs,
      tabId,
      viewport: role,
      domain: category,
      kind: 'effect_claimed',
      summary: `claimed ${category} (${redactFallbackText(effectKey, 240)})`,
      ...(currentGesture !== null ? { gestureSeq: currentGesture } : {}),
    });
    return { allowed: true, seq, ownerSeq: seq, gestureSeq: currentGesture };
  }

  getLastSessionStorageWriteMs(tabId: string): number {
    return this.lastSessionStorageWriteByTab.get(tabId) ?? 0;
  }

  sessionStorageSet(
    tabId: string,
    origin: string,
    viewport: ViewportRole,
    key: string,
    value: string,
    tsMs = this.now(),
  ): SessionStorageMutationResult {
    if (this.disposed || !tabId) return { ok: false, changed: false, error: 'disposed' };
    if (!isValidHttpOrigin(origin)) {
      return { ok: false, changed: false, error: 'invalid http/https origin' };
    }
    if (key.length + value.length > 512 * 1024) {
      return { ok: false, changed: false, error: 'sessionStorage quota exceeded' };
    }
    if (this.native && this.handle !== null) {
      try {
        const res = JSON.parse(
          this.native.busSessionStorageOp(
            this.handle,
            JSON.stringify({ op: 'set', tabId, origin, viewport, key, value, tsMs }),
          ),
        ) as SessionStorageMutationResult;
        if (res.ok && res.changed) {
          this.lastSessionStorageWriteByTab.set(tabId, tsMs);
        }
        return res;
      } catch (err) {
        return {
          ok: false,
          changed: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    let origins = this.fbSessionStorage.get(tabId);
    if (!origins) {
      origins = new Map();
      this.fbSessionStorage.set(tabId, origins);
    }
    let bucket = origins.get(origin);
    if (!bucket) {
      bucket = new Map();
      origins.set(origin, bucket);
    }
    const changed = bucket.get(key) !== value;
    if (changed) {
      bucket.set(key, value);
      this.lastSessionStorageWriteByTab.set(tabId, tsMs);
      const seq = this.fbSeq++;
      this.fbPush({
        seq,
        tsMs,
        tabId,
        viewport,
        domain: 'storage',
        kind: 'session_set',
        summary: `sessionStorage.setItem(${key.slice(0, 96)}, ${value.length}B)`,
      });
    }
    return { ok: true, changed };
  }

  sessionStorageRemove(
    tabId: string,
    origin: string,
    viewport: ViewportRole,
    key: string,
    tsMs = this.now(),
  ): SessionStorageMutationResult {
    if (this.disposed || !tabId) return { ok: false, changed: false, error: 'disposed' };
    if (this.native && this.handle !== null) {
      const res = JSON.parse(
        this.native.busSessionStorageOp(
          this.handle,
          JSON.stringify({ op: 'remove', tabId, origin, viewport, key, tsMs }),
        ),
      ) as SessionStorageMutationResult;
      if (res.ok && res.changed) {
        this.lastSessionStorageWriteByTab.set(tabId, tsMs);
      }
      return res;
    }
    if (!isValidHttpOrigin(origin)) {
      return { ok: false, changed: false, error: 'invalid http/https origin' };
    }
    const bucket = this.fbSessionStorage.get(tabId)?.get(origin);
    const removed = bucket ? bucket.delete(key) : false;
    if (removed) {
      this.lastSessionStorageWriteByTab.set(tabId, tsMs);
      const seq = this.fbSeq++;
      this.fbPush({
        seq,
        tsMs,
        tabId,
        viewport,
        domain: 'storage',
        kind: 'session_remove',
        summary: `sessionStorage.removeItem(${key.slice(0, 96)})`,
      });
    }
    return { ok: true, changed: removed };
  }

  sessionStorageClear(
    tabId: string,
    origin: string,
    viewport: ViewportRole,
    tsMs = this.now(),
  ): SessionStorageMutationResult {
    if (this.disposed || !tabId) return { ok: false, changed: false, error: 'disposed' };
    if (this.native && this.handle !== null) {
      const res = JSON.parse(
        this.native.busSessionStorageOp(
          this.handle,
          JSON.stringify({ op: 'clear', tabId, origin, viewport, tsMs }),
        ),
      ) as SessionStorageMutationResult;
      if (res.ok && res.changed) {
        this.lastSessionStorageWriteByTab.set(tabId, tsMs);
      }
      return res;
    }
    if (!isValidHttpOrigin(origin)) {
      return { ok: false, changed: false, error: 'invalid http/https origin' };
    }
    const bucket = this.fbSessionStorage.get(tabId)?.get(origin);
    const cleared = Boolean(bucket && bucket.size > 0);
    bucket?.clear();
    if (cleared) {
      this.lastSessionStorageWriteByTab.set(tabId, tsMs);
      const seq = this.fbSeq++;
      this.fbPush({
        seq,
        tsMs,
        tabId,
        viewport,
        domain: 'storage',
        kind: 'session_clear',
        summary: `sessionStorage.clear(${origin})`,
      });
    }
    return { ok: true, changed: cleared };
  }

  sessionStorageSnapshot(tabId: string, origin: string): Record<string, string> {
    if (this.disposed || !tabId || !isValidHttpOrigin(origin)) return {};
    if (this.native && this.handle !== null) {
      const res = JSON.parse(
        this.native.busSessionStorageOp(
          this.handle,
          JSON.stringify({ op: 'snapshot', tabId, origin, viewport: 'both', tsMs: this.now() }),
        ),
      ) as SessionStorageMutationResult;
      return res.ok && res.entries ? res.entries : {};
    }
    const bucket = this.fbSessionStorage.get(tabId)?.get(origin);
    if (!bucket) return {};
    return Object.fromEntries(bucket.entries());
  }

  sessionStorageClearTab(tabId: string): boolean {
    if (this.disposed || !tabId) return false;
    this.lastSessionStorageWriteByTab.delete(tabId);
    if (this.native && this.handle !== null) {
      const res = JSON.parse(
        this.native.busSessionStorageOp(
          this.handle,
          JSON.stringify({ op: 'clear_tab', tabId, origin: '', viewport: 'both', tsMs: this.now() }),
        ),
      ) as SessionStorageMutationResult;
      return Boolean(res.ok && res.changed);
    }
    return this.fbSessionStorage.delete(tabId);
  }

  query(filter: QueryBusFilter = {}): QueryBusResult {
    if (this.disposed) {
      return {
        backend: this.backend,
        latestSeq: 0,
        totalPublished: 0,
        totalSuppressed: 0,
        count: 0,
        events: [],
      };
    }
    if (this.native && this.handle !== null) {
      return JSON.parse(this.native.busQuery(this.handle, JSON.stringify(filter))) as QueryBusResult;
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const sinceSeq = filter.sinceSeq ?? 0;
    const all: TabBusEvent[] = [];
    const lists = filter.tabId
      ? [this.fbEvents.get(filter.tabId) ?? []]
      : Array.from(this.fbEvents.values());
    for (const list of lists) {
      for (const ev of list) {
        if (ev.seq <= sinceSeq) continue;
        if (filter.domain && filter.domain !== 'all' && ev.domain !== filter.domain) continue;
        if (
          filter.viewport &&
          filter.viewport !== 'both' &&
          ev.viewport !== filter.viewport &&
          ev.viewport !== 'both'
        ) {
          continue;
        }
        if (filter.gestureSeq !== undefined && ev.gestureSeq !== filter.gestureSeq) continue;
        all.push(ev);
      }
    }
    if (!filter.tabId) {
      all.sort((a, b) => a.seq - b.seq);
    }
    const sliced = all.length > limit ? all.slice(all.length - limit) : all;
    return {
      backend: 'ts-fallback',
      latestSeq: this.fbSeq - 1,
      totalPublished: this.fbPublished,
      totalSuppressed: this.fbSuppressed,
      count: sliced.length,
      events: sliced,
    };
  }

  clearTab(tabId: string): void {
    if (this.disposed || !tabId) return;
    this.lastSessionStorageWriteByTab.delete(tabId);
    if (this.native && this.handle !== null) {
      this.native.busClearTab(this.handle, tabId);
      return;
    }
    this.fbGestures.delete(tabId);
    this.fbEvents.delete(tabId);
    this.fbClaims.delete(tabId);
    this.fbSessionStorage.delete(tabId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.lastSessionStorageWriteByTab.clear();
    if (this.native && this.handle !== null) {
      this.native.busDestroy(this.handle);
      this.handle = null;
    }
    this.fbGestures.clear();
    this.fbEvents.clear();
    this.fbClaims.clear();
    this.fbSessionStorage.clear();
  }

  private fbPush(ev: TabBusEvent): void {
    let list = this.fbEvents.get(ev.tabId);
    if (!list) {
      list = [];
      this.fbEvents.set(ev.tabId, list);
    }
    if (list.length >= this.maxEventsPerTab) {
      list.shift();
    }
    list.push(ev);
    this.fbPublished += 1;
  }
}
