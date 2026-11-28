import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { redactMirrorUrl } from '../shared/mirror-core';
import type { TabEmulationSummary, ViewportRole } from '../shared/types';
import type { DebuggerCoordinator, DebuggerTarget } from './debugger-coordinator';

export const DEFAULT_SAMPLING_INTERVAL_US = 1_000; // 1 ms (Chrome DevTools standard; 45s = <=45k samples)
export const MAX_CPUPROFILE_BYTES = 50 * 1024 * 1024; // 50 MB hard cap on disk write
export const PROFILER_STOP_TIMEOUT_MS = 25_000;

export interface CdpCallFrame {
  functionName?: string;
  scriptId?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface CdpProfileNode {
  id: number;
  callFrame?: CdpCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface CdpCpuProfile {
  nodes?: CdpProfileNode[];
  startTime?: number;
  endTime?: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface BottomUpFunctionEntry {
  functionName: string;
  url: string;
  line: number;
  column: number;
  location: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
  samples: number;
}

export interface ScriptSelfEntry {
  url: string;
  selfMs: number;
  selfPercent: number;
  samples: number;
}

export interface CallTreeInclusiveEntry {
  nodeId: number;
  functionName: string;
  url: string;
  line: number;
  column: number;
  location: string;
  inclusiveMs: number;
  inclusivePercent: number;
  selfMs: number;
  samples: number;
  depth: number;
  parentChain: string[];
}

export interface CpuProfileSummary {
  totalDurationMs: number;
  sampledDurationMs: number;
  activeMs: number;
  idleMs: number;
  programMs: number;
  gcMs: number;
  sampleCount: number;
  nodeCount: number;
  functions: BottomUpFunctionEntry[];
  callTree: CallTreeInclusiveEntry[];
  scripts: ScriptSelfEntry[];
}

export interface ActiveProfileInfo {
  profileId: string;
  tabId: string;
  viewport: ViewportRole;
  startedAtMs: number;
  durationMs: number;
  samplingIntervalUs: number;
}

const META_ROOT_OR_IDLE = new Set(['(root)', '(idle)']);

function roundMs(us: number): number {
  return Math.round((us / 1000) * 100) / 100;
}

function roundPct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round(((part / whole) * 100) * 10) / 10;
}

function sanitizeScriptUrl(rawUrl: string | undefined): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return '(internal)';
  return redactMirrorUrl(trimmed) ?? trimmed;
}

/**
 * Computes a Chrome-DevTools-style bottom-up CPU profile summary (`selfMs` + recursion-safe
 * inclusive `totalMs` per `functionName + scriptUrl:line`, plus `selfMs` per script URL)
 * from a raw V8 / CDP `Profiler.Profile` payload.
 */
export function summarizeCpuProfile(
  profile: CdpCpuProfile,
  top = 30,
): CpuProfileSummary {
  const safeTop = Math.min(Math.max(Math.floor(top || 30), 1), 200);
  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const nodeById = new Map<number, CdpProfileNode>();
  const parentById = new Map<number, number>();

  for (const node of nodes) {
    if (!node || typeof node.id !== 'number') continue;
    nodeById.set(node.id, node);
    if (Array.isArray(node.children)) {
      for (const childId of node.children) {
        if (typeof childId === 'number' && childId !== node.id) {
          parentById.set(childId, node.id);
        }
      }
    }
  }

  const startUs = typeof profile.startTime === 'number' ? profile.startTime : 0;
  const endUs = typeof profile.endTime === 'number' ? profile.endTime : startUs;
  const wallUs = Math.max(0, endUs - startUs);

  interface FuncAcc {
    functionName: string;
    url: string;
    line: number;
    column: number;
    location: string;
    selfUs: number;
    totalUs: number;
    samples: number;
  }

  const funcMap = new Map<string, FuncAcc>();
  const scriptMap = new Map<string, { url: string; selfUs: number; samples: number }>();
  const nodeSelfUs = new Map<number, number>();
  const nodeTotalUs = new Map<number, number>();
  const nodeSamples = new Map<number, number>();

  let sampledUs = 0;
  let idleUs = 0;
  let programUs = 0;
  let gcUs = 0;
  let sampleCount = 0;

  const nodeMetaCache = new Map<
    number,
    {
      key: string;
      functionName: string;
      url: string;
      line: number;
      column: number;
      location: string;
    }
  >();

  const getNodeMeta = (node: CdpProfileNode) => {
    const cached = nodeMetaCache.get(node.id);
    if (cached) return cached;
    const cf = node.callFrame ?? {};
    const rawFn = (cf.functionName ?? '').trim();
    const functionName = rawFn.length > 0 ? rawFn : '(anonymous)';
    const rawUrl = (cf.url ?? '').trim();
    const url = rawUrl.length > 0 ? sanitizeScriptUrl(rawUrl) : '(internal)';
    const line = typeof cf.lineNumber === 'number' && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0;
    const column =
      typeof cf.columnNumber === 'number' && cf.columnNumber >= 0 ? cf.columnNumber + 1 : 0;
    const location = line > 0 ? `${url}:${line}` : url;
    const key = `${functionName}\u0000${url}\u0000${line}\u0000${column}`;
    const computed = { key, functionName, url, line, column, location };
    nodeMetaCache.set(node.id, computed);
    return computed;
  };

  // Memoize unique ancestor function keys per leaf nodeId so 200k+ samples run in O(uniqueLeaves * depth) (~2ms)!
  const leafAncestorKeysCache = new Map<number, string[]>();
  const getAncestorKeys = (leafNodeId: number): string[] => {
    const cached = leafAncestorKeysCache.get(leafNodeId);
    if (cached) return cached;
    const seenFuncKeys = new Set<string>();
    const visitedNodes = new Set<number>();
    let curId: number | undefined = leafNodeId;
    while (curId !== undefined && !visitedNodes.has(curId)) {
      visitedNodes.add(curId);
      const curNode = nodeById.get(curId);
      if (!curNode) break;
      const meta = getNodeMeta(curNode);
      if (!META_ROOT_OR_IDLE.has(meta.functionName) && !seenFuncKeys.has(meta.key)) {
        seenFuncKeys.add(meta.key);
        if (!funcMap.has(meta.key)) {
          funcMap.set(meta.key, {
            functionName: meta.functionName,
            url: meta.url,
            line: meta.line,
            column: meta.column,
            location: meta.location,
            selfUs: 0,
            totalUs: 0,
            samples: 0,
          });
        }
      }
      curId = parentById.get(curId);
    }
    const keys = Array.from(seenFuncKeys);
    leafAncestorKeysCache.set(leafNodeId, keys);
    return keys;
  };

  const attributeSample = (leafNodeId: number, dtUs: number, hitWeight = 1) => {
    const leaf = nodeById.get(leafNodeId);
    if (!leaf || dtUs < 0) return;

    sampledUs += dtUs;
    sampleCount += hitWeight;

    const leafMeta = getNodeMeta(leaf);
    if (leafMeta.functionName === '(idle)') {
      idleUs += dtUs;
      return;
    }
    if (leafMeta.functionName === '(program)') {
      programUs += dtUs;
    } else if (leafMeta.functionName === '(garbage collector)') {
      gcUs += dtUs;
    }

    if (!META_ROOT_OR_IDLE.has(leafMeta.functionName)) {
      let fAcc = funcMap.get(leafMeta.key);
      if (!fAcc) {
        fAcc = {
          functionName: leafMeta.functionName,
          url: leafMeta.url,
          line: leafMeta.line,
          column: leafMeta.column,
          location: leafMeta.location,
          selfUs: 0,
          totalUs: 0,
          samples: 0,
        };
        funcMap.set(leafMeta.key, fAcc);
      }
      fAcc.selfUs += dtUs;
      fAcc.samples += hitWeight;

      let sAcc = scriptMap.get(leafMeta.url);
      if (!sAcc) {
        sAcc = { url: leafMeta.url, selfUs: 0, samples: 0 };
        scriptMap.set(leafMeta.url, sAcc);
      }
      sAcc.selfUs += dtUs;
      sAcc.samples += hitWeight;
    }

    const ancestorKeys = getAncestorKeys(leafNodeId);
    for (let k = 0; k < ancestorKeys.length; k += 1) {
      const acc = funcMap.get(ancestorKeys[k]!);
      if (acc) {
        acc.totalUs += dtUs;
      }
    }

    nodeSelfUs.set(leafNodeId, (nodeSelfUs.get(leafNodeId) ?? 0) + dtUs);
    const seenTreeNodes = new Set<number>();
    let walkId: number | undefined = leafNodeId;
    while (walkId !== undefined && !seenTreeNodes.has(walkId)) {
      seenTreeNodes.add(walkId);
      const wn = nodeById.get(walkId);
      if (!wn) break;
      nodeTotalUs.set(walkId, (nodeTotalUs.get(walkId) ?? 0) + dtUs);
      nodeSamples.set(walkId, (nodeSamples.get(walkId) ?? 0) + hitWeight);
      walkId = parentById.get(walkId);
    }
  };

  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];

  if (samples.length > 0) {
    const fallbackDeltaUs = samples.length > 0 ? wallUs / samples.length : 0;
    for (let i = 0; i < samples.length; i += 1) {
      const nodeId = samples[i];
      if (typeof nodeId !== 'number') continue;
      const rawDelta = deltas[i];
      const dtUs =
        typeof rawDelta === 'number' && Number.isFinite(rawDelta)
          ? Math.max(0, rawDelta)
          : fallbackDeltaUs;
      attributeSample(nodeId, dtUs, 1);
    }
  } else {
    let totalHits = 0;
    for (const node of nodes) {
      if (typeof node.hitCount === 'number' && node.hitCount > 0) {
        totalHits += node.hitCount;
      }
    }
    const perHitUs = totalHits > 0 ? wallUs / totalHits : 0;
    for (const node of nodes) {
      const hits = typeof node.hitCount === 'number' ? node.hitCount : 0;
      if (hits > 0) {
        attributeSample(node.id, hits * perHitUs, hits);
      }
    }
  }

  const activeUs = Math.max(0, sampledUs - idleUs);
  const functions: BottomUpFunctionEntry[] = Array.from(funcMap.values())
    .filter((f) => f.functionName !== '(program)' || f.selfUs > 0)
    .sort((a, b) => (b.selfUs !== a.selfUs ? b.selfUs - a.selfUs : b.totalUs - a.totalUs))
    .slice(0, safeTop)
    .map((f) => ({
      functionName: f.functionName,
      url: f.url,
      line: f.line,
      column: f.column,
      location: f.location,
      selfMs: roundMs(f.selfUs),
      totalMs: roundMs(f.totalUs),
      selfPercent: roundPct(f.selfUs, activeUs),
      samples: f.samples,
    }));

  const scripts: ScriptSelfEntry[] = Array.from(scriptMap.values())
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, safeTop)
    .map((s) => ({
      url: s.url,
      selfMs: roundMs(s.selfUs),
      selfPercent: roundPct(s.selfUs, activeUs),
      samples: s.samples,
    }));

  const buildParentChain = (nodeId: number): { depth: number; parentChain: string[] } => {
    const chain: string[] = [];
    const visited = new Set<number>([nodeId]);
    let pId = parentById.get(nodeId);
    let depth = 0;
    while (pId !== undefined && !visited.has(pId)) {
      visited.add(pId);
      const pn = nodeById.get(pId);
      if (!pn) break;
      const pm = getNodeMeta(pn);
      if (pm.functionName !== '(root)') {
        depth += 1;
        if (chain.length < 24) {
          const loc = pm.line > 0 ? `${pm.url}:${pm.line}:${pm.column}` : pm.url;
          chain.push(`${pm.functionName}@${loc}`);
        }
      }
      pId = parentById.get(pId);
    }
    return { depth, parentChain: chain };
  };

  const callTreeTop = safeTop;
  const callTree: CallTreeInclusiveEntry[] = Array.from(nodeTotalUs.entries())
    .filter(([nid, totUs]) => {
      if (totUs <= 0) return false;
      const n = nodeById.get(nid);
      if (!n) return false;
      const m = getNodeMeta(n);
      if (META_ROOT_OR_IDLE.has(m.functionName)) return false;
      if (m.functionName === '(program)' && (nodeSelfUs.get(nid) ?? 0) <= 0) return false;
      return true;
    })
    .map(([nid, totUs]) => {
      const n = nodeById.get(nid)!;
      const m = getNodeMeta(n);
      const selfU = nodeSelfUs.get(nid) ?? 0;
      const { depth, parentChain } = buildParentChain(nid);
      return {
        nodeId: nid,
        functionName: m.functionName,
        url: m.url,
        line: m.line,
        column: m.column,
        location: m.line > 0 ? `${m.url}:${m.line}:${m.column}` : m.url,
        inclusiveMs: roundMs(totUs),
        inclusivePercent: roundPct(totUs, activeUs),
        selfMs: roundMs(selfU),
        samples: nodeSamples.get(nid) ?? 0,
        depth,
        parentChain,
        _totUs: totUs,
      };
    })
    .sort((a, b) => (b._totUs !== a._totUs ? b._totUs - a._totUs : a.depth - b.depth))
    .slice(0, callTreeTop)
    .map(({ _totUs: _ignored, ...rest }) => rest);

  return {
    totalDurationMs: roundMs(wallUs > 0 ? wallUs : sampledUs),
    sampledDurationMs: roundMs(sampledUs),
    activeMs: roundMs(activeUs),
    idleMs: roundMs(idleUs),
    programMs: roundMs(programUs),
    gcMs: roundMs(gcUs),
    sampleCount,
    nodeCount: nodes.length,
    functions,
    callTree,
    scripts,
  };
}

/**
 * Streams a `.cpuprofile` JSON payload to a symlink-safe `0600` file in bounded chunks,
 * enforcing `maxBytes` so large profiles never allocate a single giant string or exceed disk cap.
 */
export function writeSafeCpuProfileFile(
  profilesDir: string,
  tabId: string,
  viewport: ViewportRole,
  profile: CdpCpuProfile,
  nowMs = Date.now(),
  maxBytes = MAX_CPUPROFILE_BYTES,
): { profilePath: string; bytes: number; truncated: boolean } {
  if (fs.existsSync(profilesDir)) {
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to write CPU profile into non-directory or symlink: ${profilesDir}`);
    }
  } else {
    fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to write CPU profile into symlink directory: ${profilesDir}`);
    }
  }

  const safeTab = tabId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tab';

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const filename = `profile-${safeTab}-${viewport}-${nowMs}${suffix}.cpuprofile`;
    const fullPath = path.join(profilesDir, filename);
    let fd: number;
    try {
      fd = fs.openSync(fullPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        continue;
      }
      throw err;
    }

    let bytes = 0;
    let truncated = false;
    const writeChunk = (str: string) => {
      const buf = Buffer.from(str, 'utf8');
      fs.writeSync(fd, buf, 0, buf.length);
      bytes += buf.length;
    };

    try {
      const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
      const samples = Array.isArray(profile.samples) ? profile.samples : [];
      const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
      const startTime = typeof profile.startTime === 'number' ? profile.startTime : 0;
      const endTime = typeof profile.endTime === 'number' ? profile.endTime : startTime;

      writeChunk(`{"startTime":${startTime},"endTime":${endTime},"nodes":[`);
      let batch = '';
      for (let i = 0; i < nodes.length; i += 1) {
        const prefix = i === 0 ? '' : ',';
        const encodedNode = JSON.stringify(nodes[i]);
        if (bytes + batch.length + encodedNode.length + 1024 > maxBytes && i > 0) {
          truncated = true;
          break;
        }
        batch += prefix + encodedNode;
        if (batch.length >= 65_536) {
          writeChunk(batch);
          batch = '';
        }
      }
      if (batch.length > 0) {
        writeChunk(batch);
        batch = '';
      }

      // Budget combined (sample + timeDelta) byte pairs strictly within maxBytes.
      const remBudget = Math.max(0, maxBytes - bytes - 48);

      writeChunk('],"samples":[');
      let keptSamples = 0;
      let pairBytesUsed = 0;
      for (let i = 0; i < samples.length; i += 1) {
        if (truncated) break;
        const piece = `${i === 0 ? '' : ','}${Number(samples[i] ?? 0)}`;
        const dPieceLen =
          i < deltas.length ? `${i === 0 ? '' : ','}${Number(deltas[i] ?? 0)}`.length : 0;
        if (pairBytesUsed + piece.length + dPieceLen > remBudget && i > 0) {
          truncated = true;
          break;
        }
        pairBytesUsed += piece.length + dPieceLen;
        batch += piece;
        keptSamples += 1;
        if (batch.length >= 65_536) {
          writeChunk(batch);
          batch = '';
        }
      }
      if (batch.length > 0) {
        writeChunk(batch);
        batch = '';
      }

      writeChunk('],"timeDeltas":[');
      const deltaLimit = Math.min(deltas.length, keptSamples);
      for (let i = 0; i < deltaLimit; i += 1) {
        const piece = `${i === 0 ? '' : ','}${Number(deltas[i] ?? 0)}`;
        batch += piece;
        if (batch.length >= 65_536) {
          writeChunk(batch);
          batch = '';
        }
      }
      if (batch.length > 0) {
        writeChunk(batch);
        batch = '';
      }
      writeChunk(']}');
    } finally {
      fs.closeSync(fd);
    }

    return { profilePath: fullPath, bytes, truncated };
  }

  throw new Error('failed to allocate unique .cpuprofile path');
}

function mergeCpuProfiles(segments: CdpCpuProfile[]): CdpCpuProfile {
  if (segments.length === 0) return { nodes: [], samples: [], timeDeltas: [] };
  if (segments.length === 1) return segments[0]!;

  const mergedNodes: CdpProfileNode[] = [];
  const mergedSamples: number[] = [];
  const mergedDeltas: number[] = [];
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  let nextIdOffset = 0;

  for (const seg of segments) {
    const sNodes = Array.isArray(seg.nodes) ? seg.nodes : [];
    if (sNodes.length === 0) continue;
    if (typeof seg.startTime === 'number' && seg.startTime < minStart) minStart = seg.startTime;
    if (typeof seg.endTime === 'number' && seg.endTime > maxEnd) maxEnd = seg.endTime;

    let localMaxId = 0;
    for (const n of sNodes) {
      if (typeof n.id === 'number' && n.id > localMaxId) localMaxId = n.id;
      mergedNodes.push({
        ...n,
        id: n.id + nextIdOffset,
        children: Array.isArray(n.children) ? n.children.map((c) => c + nextIdOffset) : undefined,
      });
    }
    const sSamples = Array.isArray(seg.samples) ? seg.samples : [];
    const sDeltas = Array.isArray(seg.timeDeltas) ? seg.timeDeltas : [];
    for (let i = 0; i < sSamples.length; i += 1) {
      mergedSamples.push((sSamples[i] ?? 0) + nextIdOffset);
      mergedDeltas.push(sDeltas[i] ?? 0);
    }
    nextIdOffset += localMaxId + 1;
  }

  return {
    startTime: Number.isFinite(minStart) ? minStart : 0,
    endTime: maxEnd,
    nodes: mergedNodes,
    samples: mergedSamples,
    timeDeltas: mergedDeltas,
  };
}

// Inline Worker code for off-thread CPU profile summarization + streaming 0600 file write.
// Kept self-contained so Bun's single-file CJS bundle (`dist/main/index.js`) works without extra worker files.
const CPU_PROFILE_WORKER_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const SENSITIVE_PARAMS = new Set([
  'token','access_token','id_token','refresh_token','sessiontoken','session_token',
  'session','auth','key','apikey','api_key','secret','ticket','code','password','passwd','sig','signature','jwt'
]);

function redactScriptUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '(internal)';
  try {
    const u = new URL(trimmed);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_PARAMS.has(k.toLowerCase())) {
        u.searchParams.set(k, '[REDACTED]');
      }
    }
    if (u.hash && u.hash.includes('=')) {
      u.hash = '';
    }
    return u.toString();
  } catch (_) {
    return trimmed;
  }
}

function roundMs(us) {
  return Math.round((us / 1000) * 100) / 100;
}
function roundPct(part, whole) {
  return whole <= 0 ? 0 : Math.round(((part / whole) * 100) * 10) / 10;
}

function summarize(profile, top) {
  const safeTop = Math.min(Math.max(Math.floor(top || 30), 1), 200);
  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const nodeById = new Map();
  const parentById = new Map();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'number') continue;
    nodeById.set(n.id, n);
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        if (typeof c === 'number' && c !== n.id) parentById.set(c, n.id);
      }
    }
  }
  const startUs = typeof profile.startTime === 'number' ? profile.startTime : 0;
  const endUs = typeof profile.endTime === 'number' ? profile.endTime : startUs;
  const wallUs = Math.max(0, endUs - startUs);
  const funcMap = new Map();
  const scriptMap = new Map();
  const nodeSelfUs = new Map();
  const nodeTotalUs = new Map();
  const nodeSamples = new Map();
  const metaCache = new Map();
  const ancestorCache = new Map();
  let sampledUs = 0, idleUs = 0, programUs = 0, gcUs = 0, sampleCount = 0;

  function getMeta(node) {
    let m = metaCache.get(node.id);
    if (m) return m;
    const cf = node.callFrame || {};
    const rawFn = String(cf.functionName || '').trim();
    const functionName = rawFn.length > 0 ? rawFn : '(anonymous)';
    const rawUrl = String(cf.url || '').trim();
    const url = rawUrl.length > 0 ? redactScriptUrl(rawUrl) : '(internal)';
    const line = typeof cf.lineNumber === 'number' && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0;
    const column = typeof cf.columnNumber === 'number' && cf.columnNumber >= 0 ? cf.columnNumber + 1 : 0;
    const location = line > 0 ? url + ':' + line : url;
    const key = functionName + '\\0' + url + '\\0' + line + '\\0' + column;
    m = { key, functionName, url, line, column, location };
    metaCache.set(node.id, m);
    return m;
  }

  function getAncestors(leafId) {
    let keys = ancestorCache.get(leafId);
    if (keys) return keys;
    const seen = new Set();
    const visited = new Set();
    let cur = leafId;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      const n = nodeById.get(cur);
      if (!n) break;
      const meta = getMeta(n);
      if (meta.functionName !== '(root)' && meta.functionName !== '(idle)' && !seen.has(meta.key)) {
        seen.add(meta.key);
        if (!funcMap.has(meta.key)) {
          funcMap.set(meta.key, {
            functionName: meta.functionName, url: meta.url, line: meta.line, column: meta.column,
            location: meta.location, selfUs: 0, totalUs: 0, samples: 0
          });
        }
      }
      cur = parentById.get(cur);
    }
    keys = Array.from(seen);
    ancestorCache.set(leafId, keys);
    return keys;
  }

  function addSample(leafId, dtUs, weight) {
    const leaf = nodeById.get(leafId);
    if (!leaf || dtUs < 0) return;
    sampledUs += dtUs;
    sampleCount += weight;
    const lm = getMeta(leaf);
    if (lm.functionName === '(idle)') { idleUs += dtUs; return; }
    if (lm.functionName === '(program)') programUs += dtUs;
    else if (lm.functionName === '(garbage collector)') gcUs += dtUs;

    if (lm.functionName !== '(root)' && lm.functionName !== '(idle)') {
      let fa = funcMap.get(lm.key);
      if (!fa) {
        fa = { functionName: lm.functionName, url: lm.url, line: lm.line, column: lm.column, location: lm.location, selfUs: 0, totalUs: 0, samples: 0 };
        funcMap.set(lm.key, fa);
      }
      fa.selfUs += dtUs;
      fa.samples += weight;
      let sa = scriptMap.get(lm.url);
      if (!sa) { sa = { url: lm.url, selfUs: 0, samples: 0 }; scriptMap.set(lm.url, sa); }
      sa.selfUs += dtUs;
      sa.samples += weight;
    }
    const anc = getAncestors(leafId);
    for (let i = 0; i < anc.length; i += 1) {
      const a = funcMap.get(anc[i]);
      if (a) a.totalUs += dtUs;
    }
    nodeSelfUs.set(leafId, (nodeSelfUs.get(leafId) || 0) + dtUs);
    const seenTree = new Set();
    let cur = leafId;
    while (cur !== undefined && !seenTree.has(cur)) {
      seenTree.add(cur);
      const wn = nodeById.get(cur);
      if (!wn) break;
      nodeTotalUs.set(cur, (nodeTotalUs.get(cur) || 0) + dtUs);
      nodeSamples.set(cur, (nodeSamples.get(cur) || 0) + weight);
      cur = parentById.get(cur);
    }
  }

  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  if (samples.length > 0) {
    const fb = wallUs / samples.length;
    for (let i = 0; i < samples.length; i += 1) {
      const id = samples[i];
      if (typeof id !== 'number') continue;
      const d = deltas[i];
      addSample(id, typeof d === 'number' && Number.isFinite(d) ? Math.max(0, d) : fb, 1);
    }
  } else {
    let totalHits = 0;
    for (const n of nodes) if (typeof n.hitCount === 'number' && n.hitCount > 0) totalHits += n.hitCount;
    const perHit = totalHits > 0 ? wallUs / totalHits : 0;
    for (const n of nodes) {
      const h = typeof n.hitCount === 'number' ? n.hitCount : 0;
      if (h > 0) addSample(n.id, h * perHit, h);
    }
  }

  const activeUs = Math.max(0, sampledUs - idleUs);
  const functions = Array.from(funcMap.values())
    .filter((f) => f.functionName !== '(program)' || f.selfUs > 0)
    .sort((a, b) => (b.selfUs !== a.selfUs ? b.selfUs - a.selfUs : b.totalUs - a.totalUs))
    .slice(0, safeTop)
    .map((f) => ({
      functionName: f.functionName, url: f.url, line: f.line, column: f.column, location: f.location,
      selfMs: roundMs(f.selfUs), totalMs: roundMs(f.totalUs), selfPercent: roundPct(f.selfUs, activeUs), samples: f.samples
    }));
  const scripts = Array.from(scriptMap.values())
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, safeTop)
    .map((s) => ({
      url: s.url, selfMs: roundMs(s.selfUs), selfPercent: roundPct(s.selfUs, activeUs), samples: s.samples
    }));
  function buildParents(nid) {
    const chain = [];
    const vis = new Set([nid]);
    let pid = parentById.get(nid);
    let depth = 0;
    while (pid !== undefined && !vis.has(pid)) {
      vis.add(pid);
      const pn = nodeById.get(pid);
      if (!pn) break;
      const pm = getMeta(pn);
      if (pm.functionName !== '(root)') {
        depth += 1;
        if (chain.length < 24) {
          const loc = pm.line > 0 ? pm.url + ':' + pm.line + ':' + pm.column : pm.url;
          chain.push(pm.functionName + '@' + loc);
        }
      }
      pid = parentById.get(pid);
    }
    return { depth, parentChain: chain };
  }
  const callTreeTop = safeTop;
  const callTree = Array.from(nodeTotalUs.entries())
    .filter(([nid, totUs]) => {
      if (totUs <= 0) return false;
      const n = nodeById.get(nid);
      if (!n) return false;
      const m = getMeta(n);
      if (m.functionName === '(root)' || m.functionName === '(idle)') return false;
      if (m.functionName === '(program)' && (nodeSelfUs.get(nid) || 0) <= 0) return false;
      return true;
    })
    .map(([nid, totUs]) => {
      const n = nodeById.get(nid);
      const m = getMeta(n);
      const su = nodeSelfUs.get(nid) || 0;
      const { depth, parentChain } = buildParents(nid);
      return {
        nodeId: nid,
        functionName: m.functionName,
        url: m.url,
        line: m.line,
        column: m.column,
        location: m.line > 0 ? m.url + ':' + m.line + ':' + m.column : m.url,
        inclusiveMs: roundMs(totUs),
        inclusivePercent: roundPct(totUs, activeUs),
        selfMs: roundMs(su),
        samples: nodeSamples.get(nid) || 0,
        depth,
        parentChain,
        _totUs: totUs
      };
    })
    .sort((a, b) => (b._totUs !== a._totUs ? b._totUs - a._totUs : a.depth - b.depth))
    .slice(0, callTreeTop)
    .map(({ _totUs: _ig, ...rest }) => rest);
  return {
    totalDurationMs: roundMs(wallUs > 0 ? wallUs : sampledUs),
    sampledDurationMs: roundMs(sampledUs),
    activeMs: roundMs(activeUs),
    idleMs: roundMs(idleUs),
    programMs: roundMs(programUs),
    gcMs: roundMs(gcUs),
    sampleCount,
    nodeCount: nodes.length,
    functions,
    callTree,
    scripts
  };
}

function writeSafe(profilesDir, tabId, viewport, profile, nowMs, maxBytes) {
  if (fs.existsSync(profilesDir)) {
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('refusing to write CPU profile into non-directory or symlink: ' + profilesDir);
    }
  } else {
    fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('refusing to write CPU profile into symlink directory: ' + profilesDir);
    }
  }
  const safeTab = String(tabId || 'tab').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tab';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : '-' + attempt;
    const fullPath = path.join(profilesDir, 'profile-' + safeTab + '-' + viewport + '-' + nowMs + suffix + '.cpuprofile');
    let fd;
    try {
      fd = fs.openSync(fullPath, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    let bytes = 0;
    let truncated = false;
    const writeChunk = (s) => {
      const b = Buffer.from(s, 'utf8');
      fs.writeSync(fd, b, 0, b.length);
      bytes += b.length;
    };
    try {
      const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
      const samples = Array.isArray(profile.samples) ? profile.samples : [];
      const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
      const startTime = typeof profile.startTime === 'number' ? profile.startTime : 0;
      const endTime = typeof profile.endTime === 'number' ? profile.endTime : startTime;
      writeChunk('{"startTime":' + startTime + ',"endTime":' + endTime + ',"nodes":[');
      let batch = '';
      for (let i = 0; i < nodes.length; i += 1) {
        const prefix = i === 0 ? '' : ',';
        const enc = JSON.stringify(nodes[i]);
        if (bytes + batch.length + enc.length + 1024 > maxBytes && i > 0) { truncated = true; break; }
        batch += prefix + enc;
        if (batch.length >= 65536) { writeChunk(batch); batch = ''; }
      }
      if (batch.length > 0) { writeChunk(batch); batch = ''; }
      const remBudget = Math.max(0, maxBytes - bytes - 48);
      writeChunk('],"samples":[');
      let kept = 0, pairBytes = 0;
      for (let i = 0; i < samples.length; i += 1) {
        if (truncated) break;
        const p = (i === 0 ? '' : ',') + Number(samples[i] || 0);
        const dpLen = i < deltas.length ? ((i === 0 ? '' : ',') + Number(deltas[i] || 0)).length : 0;
        if (pairBytes + p.length + dpLen > remBudget && i > 0) { truncated = true; break; }
        pairBytes += p.length + dpLen;
        batch += p;
        kept += 1;
        if (batch.length >= 65536) { writeChunk(batch); batch = ''; }
      }
      if (batch.length > 0) { writeChunk(batch); batch = ''; }
      writeChunk('],"timeDeltas":[');
      const dLim = Math.min(deltas.length, kept);
      for (let i = 0; i < dLim; i += 1) {
        batch += (i === 0 ? '' : ',') + Number(deltas[i] || 0);
        if (batch.length >= 65536) { writeChunk(batch); batch = ''; }
      }
      if (batch.length > 0) { writeChunk(batch); batch = ''; }
      writeChunk(']}');
    } finally {
      fs.closeSync(fd);
    }
    return { profilePath: fullPath, bytes, truncated };
  }
  throw new Error('failed to allocate unique .cpuprofile path');
}

try {
  const { profile, top, profilesDir, tabId, viewport, nowMs, maxBytes } = workerData;
  const summary = summarize(profile, top);
  const saved = writeSafe(profilesDir, tabId, viewport, profile, nowMs, maxBytes);
  parentPort.postMessage({ ok: true, summary, saved });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

async function offloadProfileFinalize(params: {
  profile: CdpCpuProfile;
  top: number;
  profilesDir: string;
  tabId: string;
  viewport: ViewportRole;
  nowMs: number;
  maxBytes: number;
}): Promise<{
  summary: CpuProfileSummary;
  saved: { profilePath: string; bytes: number; truncated: boolean };
}> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(CPU_PROFILE_WORKER_SCRIPT, {
        eval: true,
        workerData: params,
      });
    } catch {
      // Fallback if Worker cannot spawn in constrained test VM
      try {
        const summary = summarizeCpuProfile(params.profile, params.top);
        const saved = writeSafeCpuProfileFile(
          params.profilesDir,
          params.tabId,
          params.viewport,
          params.profile,
          params.nowMs,
          params.maxBytes,
        );
        resolve({ summary, saved });
      } catch (syncErr) {
        reject(syncErr);
      }
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().catch(() => {});
      reject(new Error('CPU profile off-thread finalization timed out after 30s'));
    }, 30_000);
    timeout.unref?.();

    worker.once('message', (msg: {
      ok?: boolean;
      error?: string;
      summary?: CpuProfileSummary;
      saved?: { profilePath: string; bytes: number; truncated: boolean };
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (msg?.ok && msg.summary && msg.saved) {
        resolve({ summary: msg.summary, saved: msg.saved });
      } else {
        reject(new Error(msg?.error ?? 'CPU profile worker failed'));
      }
    });

    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`CPU profile worker exited prematurely with code ${code}`));
    });
  });
}

export type ProfilableTarget = DebuggerTarget & {
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
};

interface ActiveCpuProfileSession {
  profileId: string;
  tabId: string;
  viewport: ViewportRole;
  wc: ProfilableTarget;
  startedAtMs: number;
  samplingIntervalUs: number;
  detachedMidRun: boolean;
  priorSegments: CdpCpuProfile[];
  rearmChain: Promise<void>;
  unsubParticipant: () => void;
  unsubNav: () => void;
}

export class CpuProfilerManager {
  private readonly sessions = new Map<string, ActiveCpuProfileSession>();
  private readonly now: () => number;
  private readonly useWorker: boolean;

  constructor(
    private readonly debuggerCoordinator: DebuggerCoordinator,
    private readonly getProfilesDir: () => string,
    opts: { now?: () => number; useWorker?: boolean } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.useWorker = opts.useWorker ?? true;
  }

  private sessionKey(tabId: string, viewport: ViewportRole): string {
    return `${tabId}:${viewport}`;
  }

  getActiveSessions(): ActiveProfileInfo[] {
    const now = this.now();
    return Array.from(this.sessions.values()).map((s) => ({
      profileId: s.profileId,
      tabId: s.tabId,
      viewport: s.viewport,
      startedAtMs: s.startedAtMs,
      durationMs: Math.max(0, now - s.startedAtMs),
      samplingIntervalUs: s.samplingIntervalUs,
    }));
  }

  async start(
    tabId: string,
    viewport: ViewportRole,
    wc: ProfilableTarget,
    emulation?: TabEmulationSummary,
    samplingIntervalUs = DEFAULT_SAMPLING_INTERVAL_US,
  ): Promise<Record<string, unknown>> {
    if (wc.isDestroyed()) {
      throw new Error(`viewport '${viewport}' is destroyed`);
    }

    const key = this.sessionKey(tabId, viewport);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.unsubParticipant();
      existing.unsubNav();
      this.sessions.delete(key);
      if (!existing.wc.isDestroyed() && this.debuggerCoordinator.isAttached(existing.wc)) {
        await this.debuggerCoordinator.sendCommand(existing.wc, 'Profiler.stop').catch(() => {});
        await this.debuggerCoordinator.sendCommand(existing.wc, 'Profiler.disable').catch(() => {});
      }
    }

    const attached = await this.debuggerCoordinator.ensureAttached(wc);
    if (!attached || wc.isDestroyed()) {
      throw new Error(`cannot attach CDP debugger to '${viewport}' viewport for CPU profiling`);
    }

    const safeInterval = Math.min(Math.max(Math.round(samplingIntervalUs), 200), 10_000);
    await this.debuggerCoordinator.sendCommand(wc, 'Profiler.enable');
    await this.debuggerCoordinator.sendCommand(wc, 'Profiler.setSamplingInterval', {
      interval: safeInterval,
    });
    await this.debuggerCoordinator.sendCommand(wc, 'Profiler.start');

    const startedAtMs = this.now();
    const profileId = `cpuprof-${tabId}-${viewport}-${startedAtMs}`;
    const session: ActiveCpuProfileSession = {
      profileId,
      tabId,
      viewport,
      wc,
      startedAtMs,
      samplingIntervalUs: safeInterval,
      detachedMidRun: false,
      priorSegments: [],
      rearmChain: Promise.resolve(),
      unsubParticipant: () => {},
      unsubNav: () => {},
    };

    // If a cross-document navigation swaps the Chromium RenderFrameHost mid-profile
    // (e.g. `browser_profile start` -> `browser_navigate /pos`), harvest any active segment
    // if still running and ensure `Profiler.start` is armed on the newly committed renderer!
    const onDidNavigate = () => {
      if (this.sessions.get(key) !== session || wc.isDestroyed()) return;
      session.rearmChain = session.rearmChain
        .catch(() => {})
        .then(async () => {
          if (this.sessions.get(key) !== session || wc.isDestroyed()) return;
          const prevSeg = await this.debuggerCoordinator
            .sendCommand<{ profile?: CdpCpuProfile }>(wc, 'Profiler.stop')
            .catch(() => null);
          if (prevSeg?.profile && Array.isArray(prevSeg.profile.nodes) && prevSeg.profile.nodes.length > 0) {
            if (session.priorSegments.length < 8) {
              session.priorSegments.push(prevSeg.profile);
            }
          }
          if (this.sessions.get(key) !== session || wc.isDestroyed()) return;
          await this.debuggerCoordinator.sendCommand(wc, 'Profiler.enable').catch(() => {});
          await this.debuggerCoordinator
            .sendCommand(wc, 'Profiler.setSamplingInterval', { interval: safeInterval })
            .catch(() => {});
          await this.debuggerCoordinator.sendCommand(wc, 'Profiler.start').catch(() => {});
        });
    };

    if (typeof wc.on === 'function') {
      wc.on('did-navigate', onDidNavigate);
      session.unsubNav = () => {
        try {
          if (typeof wc.off === 'function') wc.off('did-navigate', onDidNavigate);
          else if (typeof wc.removeListener === 'function')
            wc.removeListener('did-navigate', onDidNavigate);
        } catch {
          // Ignore listener removal errors on destroyed WebContents.
        }
      };
    }

    session.unsubParticipant = this.debuggerCoordinator.registerParticipant(
      wc,
      `cpu-profiler:${key}`,
      {
        onDetach: () => {
          session.detachedMidRun = true;
        },
        onDestroyed: () => {
          if (this.sessions.get(key) === session) {
            session.unsubNav();
            this.sessions.delete(key);
          }
        },
      },
    );

    this.sessions.set(key, session);

    return {
      ok: true,
      action: 'start',
      profileId,
      tabId,
      viewport,
      startedAtMs,
      samplingIntervalUs: safeInterval,
      ...(emulation ? { emulation } : {}),
    };
  }

  async stop(
    tabId: string,
    viewport: ViewportRole,
    opts: { top?: number; emulation?: TabEmulationSummary } = {},
  ): Promise<Record<string, unknown>> {
    const key = this.sessionKey(tabId, viewport);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error(
        `no active CPU profile on tab '${tabId}' (${viewport}); call browser_profile with action='start' first`,
      );
    }

    this.sessions.delete(key);
    session.unsubParticipant();
    session.unsubNav();

    await session.rearmChain.catch(() => {});

    if (session.wc.isDestroyed() || session.detachedMidRun) {
      throw new Error(
        `CPU profile '${session.profileId}' was interrupted because viewport '${viewport}' detached or closed`,
      );
    }

    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let rawResult: { profile?: CdpCpuProfile } | null = null;
    try {
      rawResult = await Promise.race([
        this.debuggerCoordinator.sendCommand<{ profile?: CdpCpuProfile }>(
          session.wc,
          'Profiler.stop',
        ),
        new Promise<never>((_, reject) => {
          stopTimer = setTimeout(() => {
            reject(
              new Error(`CDP Profiler.stop timed out after ${PROFILER_STOP_TIMEOUT_MS}ms`),
            );
          }, PROFILER_STOP_TIMEOUT_MS);
          stopTimer.unref?.();
        }),
      ]);
    } catch (err) {
      if (session.priorSegments.length === 0) {
        setImmediate(() => {
          if (!session.wc.isDestroyed() && this.debuggerCoordinator.isAttached(session.wc)) {
            void this.debuggerCoordinator.sendCommand(session.wc, 'Profiler.disable').catch(() => {});
          }
        });
        throw err;
      }
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
    }

    // Decouple Profiler.disable onto a future check tick so it never races or blocks the stop path.
    setImmediate(() => {
      if (!session.wc.isDestroyed() && this.debuggerCoordinator.isAttached(session.wc)) {
        void this.debuggerCoordinator.sendCommand(session.wc, 'Profiler.disable').catch(() => {});
      }
    });

    const segments = [...session.priorSegments];
    if (rawResult?.profile) {
      segments.push(rawResult.profile);
    }
    const combinedProfile = mergeCpuProfiles(segments);
    const nowMs = this.now();
    const profilesDir = this.getProfilesDir();
    const top = opts.top ?? 30;

    const finalized = this.useWorker
      ? await offloadProfileFinalize({
          profile: combinedProfile,
          top,
          profilesDir,
          tabId,
          viewport,
          nowMs,
          maxBytes: MAX_CPUPROFILE_BYTES,
        })
      : {
          summary: summarizeCpuProfile(combinedProfile, top),
          saved: writeSafeCpuProfileFile(
            profilesDir,
            tabId,
            viewport,
            combinedProfile,
            nowMs,
            MAX_CPUPROFILE_BYTES,
          ),
        };

    return {
      ok: true,
      action: 'stop',
      profileId: session.profileId,
      tabId,
      viewport,
      samplingIntervalUs: session.samplingIntervalUs,
      profilePath: finalized.saved.profilePath,
      profileBytes: finalized.saved.bytes,
      truncated: finalized.saved.truncated,
      wallDurationMs: Math.max(0, nowMs - session.startedAtMs),
      ...(opts.emulation ? { emulation: opts.emulation } : {}),
      summary: finalized.summary,
    };
  }

  disposeWebContents(wcId: number): void {
    for (const [key, session] of Array.from(this.sessions.entries())) {
      if (session.wc.id === wcId) {
        session.unsubParticipant();
        session.unsubNav();
        this.sessions.delete(key);
      }
    }
  }

  clearTab(tabId: string): void {
    for (const [key, session] of Array.from(this.sessions.entries())) {
      if (session.tabId === tabId) {
        session.unsubParticipant();
        session.unsubNav();
        this.sessions.delete(key);
        setImmediate(() => {
          if (!session.wc.isDestroyed() && this.debuggerCoordinator.isAttached(session.wc)) {
            void this.debuggerCoordinator.sendCommand(session.wc, 'Profiler.disable').catch(() => {});
          }
        });
      }
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.unsubParticipant();
      session.unsubNav();
    }
    this.sessions.clear();
  }
}
