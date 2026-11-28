import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ViewportRole } from '../shared/types';
import type { DebuggerCoordinator, DebuggerTarget } from './debugger-coordinator';

export const DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES = 32_768; // 32 KB (Chrome DevTools default)
export const MAX_HEAPSNAPSHOT_BYTES = 256 * 1024 * 1024; // 256 MB hard disk cap per snapshot
export const MAX_HEAPPROFILE_BYTES = 64 * 1024 * 1024; // 64 MB hard disk cap per sampling profile
export const HEAP_SNAPSHOT_TIMEOUT_MS = 45_000;
export const HEAP_WORKER_TIMEOUT_MS = 35_000;

export type HeapAction = 'snapshot' | 'sampling_start' | 'sampling_stop' | 'diff';

export interface HeapConstructorSummary {
  name: string;
  type: string;
  count: number;
  selfBytes: number;
  retainedBytes: number;
  selfPercent: number;
  retainedPercent: number;
}

export interface HeapRetainerEdge {
  fromObjectId: number;
  fromName: string;
  fromType: string;
  edgeType: string;
  edgeName: string;
  fromSelfBytes: number;
  fromRetainedBytes: number;
}

export interface HeapDominatorHop {
  objectId: number;
  name: string;
  type: string;
  edgeLabel: string;
  retainedBytes: number;
}

export interface HeapLargestObjectSummary {
  objectId: number;
  name: string;
  type: string;
  detached: boolean;
  selfBytes: number;
  retainedBytes: number;
  retainedPercent: number;
  dominatorChain: HeapDominatorHop[];
  topRetainers: HeapRetainerEdge[];
}

export interface HeapSnapshotSummary {
  totalHeapBytes: number;
  usedHeapBytes: number;
  snapshotSelfBytes: number;
  nodeCount: number;
  edgeCount: number;
  detachedDomNodeCount: number;
  detachedDomSelfBytes: number;
  detachedDomRetainedBytes: number;
  constructors: HeapConstructorSummary[];
  constructorsBySelf: HeapConstructorSummary[];
  largestObjects: HeapLargestObjectSummary[];
}

export interface HeapSamplingStackEntry {
  functionName: string;
  url: string;
  line: number;
  column: number;
  location: string;
  selfBytes: number;
  totalBytes: number;
  selfPercent: number;
  totalPercent: number;
  allocations: number;
  stack: string[];
}

export interface HeapSamplingSummary {
  totalAllocatedBytes: number;
  nodeCount: number;
  sampleCount: number;
  topAllocatingStacks: HeapSamplingStackEntry[];
  topInclusiveStacks: HeapSamplingStackEntry[];
}

export interface HeapDiffConstructorEntry {
  name: string;
  type: string;
  countBefore: number;
  countAfter: number;
  countDelta: number;
  selfBytesBefore: number;
  selfBytesAfter: number;
  selfBytesDelta: number;
  retainedBytesBefore: number;
  retainedBytesAfter: number;
  retainedBytesDelta: number;
}

export interface HeapDiffSummary {
  beforePath: string;
  afterPath: string;
  beforeTotalSelfBytes: number;
  afterTotalSelfBytes: number;
  totalSelfBytesDelta: number;
  beforeNodeCount: number;
  afterNodeCount: number;
  nodeCountDelta: number;
  beforeDetachedDomCount: number;
  afterDetachedDomCount: number;
  detachedDomCountDelta: number;
  grownConstructors: HeapDiffConstructorEntry[];
  freedConstructors: HeapDiffConstructorEntry[];
}

// Self-contained Worker script so Bun's single-file CJS bundle (`dist/main/index.js`) runs off-thread
// with zero extra external files. Performs all JSON parsing, Cooper-Harvey-Kennedy dominator tree
// construction, retainer extraction, sampling aggregation, and snapshot diffing off the Electron main thread.
const HEAP_WORKER_SCRIPT = `
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
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_PARAMS.has(k.toLowerCase())) u.searchParams.set(k, '[REDACTED]');
    }
    if (u.hash && u.hash.includes('=')) u.hash = '';
    return u.toString();
  } catch (_) {
    return trimmed;
  }
}

function roundPct(part, whole) {
  return whole <= 0 ? 0 : Math.round(((part / whole) * 100) * 10) / 10;
}

const URL_SUBSTR_RE = /https?:\\/\\/[^\\s"'<>]+/gi;
const BEARER_RE = /\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi;
const JWT_RE = /\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}/g;
const KV_SECRET_RE = /((?:^|[?&#\\s"':,])(?:token|access_token|id_token|refresh_token|session_token|sessiontoken|jwt|secret|password|passwd|api_key|apikey|auth|signature|sig)=)([^&#\\s"']+)/gi;

function sanitizeHeapText(raw) {
  if (!raw) return '';
  let out = String(raw);
  out = out.replace(URL_SUBSTR_RE, (m) => redactScriptUrl(m));
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(JWT_RE, '[REDACTED_JWT]');
  out = out.replace(KV_SECRET_RE, '$1[REDACTED]');
  return out;
}

function normalizeConstructorBucket(tName, rawName) {
  if (tName === 'string' || tName === 'concatenated string' || tName === 'sliced string') {
    return { name: '(string)', type: 'string' };
  }
  if (tName === 'closure') return { name: '(closure)', type: 'closure' };
  if (tName === 'regexp') return { name: 'RegExp', type: 'regexp' };
  if (tName === 'code') return { name: '(compiled code)', type: 'code' };
  if (tName === 'number' || tName === 'heap number') return { name: '(number)', type: 'number' };
  if (tName === 'bigint') return { name: '(bigint)', type: 'bigint' };
  if (tName === 'symbol') return { name: '(symbol)', type: 'symbol' };
  if (tName === 'array') {
    if (rawName && rawName.startsWith('(')) return { name: rawName, type: 'array' };
    return { name: sanitizeHeapText(rawName) || 'Array', type: 'array' };
  }
  if (rawName.startsWith('Window / ') || rawName === 'Window') {
    return { name: 'Window', type: tName };
  }
  if (rawName.startsWith('Detached Window / ') || rawName === 'Detached Window') {
    return { name: 'Detached Window', type: tName };
  }
  const cleaned = sanitizeHeapText(rawName);
  return { name: cleaned || ('(' + tName + ')'), type: tName };
}

function formatSafeNodeName(tName, rawName, szBytes) {
  if (tName === 'string' || tName === 'concatenated string' || tName === 'sliced string') {
    return '<string (' + Math.round(szBytes || 0) + 'B)>';
  }
  if (tName === 'regexp') return 'RegExp';
  const cleaned = sanitizeHeapText(rawName);
  return (cleaned || ('(' + tName + ')')).slice(0, 120);
}

const SYNTHETIC_SKIP_NAMES = new Set([
  '', '(GC roots)', '(Strong roots)', '(Read-only roots)', '(Bootstrapper)',
  '(Isolate)', '(Relocatable)', '(Builtins)', '(Stack roots)', '(Handles)',
  '(External strings)', '(Global handles)', '(Eternal handles)', '(Thread manager)',
  '(Extensions)', '(Code flusher)', '(Startup object cache)', '(Weak roots)'
]);

function parseV8HeapGraph(snapshotPath) {
  const rawText = fs.readFileSync(snapshotPath, 'utf8');
  const parsed = JSON.parse(rawText);
  const snap = parsed && parsed.snapshot ? parsed.snapshot : {};
  const meta = snap.meta || {};
  const nodeFields = Array.isArray(meta.node_fields) ? meta.node_fields : [];
  const nodeTypes = Array.isArray(meta.node_types) && Array.isArray(meta.node_types[0]) ? meta.node_types[0] : [];
  const edgeFields = Array.isArray(meta.edge_fields) ? meta.edge_fields : [];
  const edgeTypes = Array.isArray(meta.edge_types) && Array.isArray(meta.edge_types[0]) ? meta.edge_types[0] : [];
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const strings = Array.isArray(parsed.strings) ? parsed.strings : [];

  const nfc = nodeFields.length;
  const efc = edgeFields.length;
  if (nfc === 0 || efc === 0) {
    throw new Error('Malformed V8 .heapsnapshot: missing meta.node_fields or meta.edge_fields');
  }
  const nodeCount = Math.floor(nodes.length / nfc);
  const edgeCount = Math.floor(edges.length / efc);

  const iType = nodeFields.indexOf('type');
  const iName = nodeFields.indexOf('name');
  const iId = nodeFields.indexOf('id');
  const iSelfSize = nodeFields.indexOf('self_size');
  const iEdgeCount = nodeFields.indexOf('edge_count');
  const iDetached = nodeFields.indexOf('detachedness');

  const iEType = edgeFields.indexOf('type');
  const iEName = edgeFields.indexOf('name_or_index');
  const iETo = edgeFields.indexOf('to_node');
  if (iETo < 0 || iEdgeCount < 0) {
    throw new Error('Malformed V8 .heapsnapshot: missing to_node or edge_count field');
  }

  const weakEdgeTypeIdx = edgeTypes.indexOf('weak');
  const shortcutEdgeTypeIdx = edgeTypes.indexOf('shortcut');
  const elementEdgeTypeIdx = edgeTypes.indexOf('element');
  const hiddenEdgeTypeIdx = edgeTypes.indexOf('hidden');

  const firstOutEdge = new Int32Array(nodeCount + 1);
  const selfSize = new Float64Array(nodeCount);
  const nodeTypeIdx = new Uint8Array(nodeCount);
  const nodeNameIdx = new Int32Array(nodeCount);
  const nodeObjId = new Float64Array(nodeCount);
  const detachedFlags = new Uint8Array(nodeCount);

  let eCursor = 0;
  let totalSelfBytes = 0;
  let detachedDomNodeCount = 0;
  let detachedDomSelfBytes = 0;

  for (let u = 0; u < nodeCount; u += 1) {
    const base = u * nfc;
    firstOutEdge[u] = eCursor;
    const deg = iEdgeCount >= 0 ? (nodes[base + iEdgeCount] | 0) : 0;
    eCursor += Math.max(0, deg);

    const sz = iSelfSize >= 0 ? Math.max(0, Number(nodes[base + iSelfSize] || 0)) : 0;
    selfSize[u] = sz;
    totalSelfBytes += sz;

    const tIdx = iType >= 0 ? (nodes[base + iType] | 0) : 0;
    nodeTypeIdx[u] = tIdx;
    const nIdx = iName >= 0 ? (nodes[base + iName] | 0) : 0;
    nodeNameIdx[u] = nIdx;
    nodeObjId[u] = iId >= 0 ? Number(nodes[base + iId] || 0) : u;

    const tName = nodeTypes[tIdx] || 'object';
    const sName = String(strings[nIdx] ?? '');
    const detVal = iDetached >= 0 ? (nodes[base + iDetached] | 0) : 0;
    const isDetached = detVal === 2 || (tName === 'native' && sName.startsWith('Detached '));
    if (isDetached) {
      detachedFlags[u] = 1;
      detachedDomNodeCount += 1;
      detachedDomSelfBytes += sz;
    }
  }
  firstOutEdge[nodeCount] = Math.min(eCursor, edgeCount);

  // Detect whether to_node is V8's standard (ordinal * nfc) or direct ordinal.
  let usesFieldOffset = true;
  if (edgeCount > 0 && nodeCount > 1) {
    for (let e = 0; e < Math.min(edgeCount, 64); e += 1) {
      const rawTo = Math.trunc(Number(edges[e * efc + iETo] || 0));
      if (rawTo % nfc !== 0) {
        usesFieldOffset = false;
        break;
      }
    }
  }

  const edgeTarget = new Int32Array(edgeCount);
  const edgeTypeArr = new Uint8Array(edgeCount);
  for (let e = 0; e < edgeCount; e += 1) {
    const eb = e * efc;
    const rawTo = Math.trunc(Number(edges[eb + iETo] || 0));
    const targetOrd = usesFieldOffset ? Math.floor(rawTo / nfc) : rawTo;
    edgeTarget[e] = targetOrd >= 0 && targetOrd < nodeCount ? targetOrd : -1;
    edgeTypeArr[e] = iEType >= 0 ? (edges[eb + iEType] | 0) : 0;
  }

  function isEssentialEdge(fromOrd, eIdx) {
    const et = edgeTypeArr[eIdx];
    if (et === weakEdgeTypeIdx) return false;
    if (et === shortcutEdgeTypeIdx && fromOrd !== 0) return false;
    return true;
  }

  // Iterative DFS from root (0) to compute Reverse Post-Order (RPO) without recursion overflow.
  const rpoNum = new Int32Array(nodeCount);
  rpoNum.fill(-1);
  const postOrder = new Int32Array(nodeCount);
  let postLen = 0;

  if (nodeCount > 0) {
    const visited = new Uint8Array(nodeCount);
    const stackNode = new Int32Array(nodeCount);
    const stackNextEdge = new Int32Array(nodeCount);
    let sp = 0;
    visited[0] = 1;
    stackNode[0] = 0;
    stackNextEdge[0] = firstOutEdge[0];
    sp = 1;

    while (sp > 0) {
      const u = stackNode[sp - 1];
      const endE = firstOutEdge[u + 1];
      let curE = stackNextEdge[sp - 1];
      let pushed = false;
      while (curE < endE) {
        const eIdx = curE++;
        if (!isEssentialEdge(u, eIdx)) continue;
        const v = edgeTarget[eIdx];
        if (v >= 0 && visited[v] === 0) {
          visited[v] = 1;
          stackNextEdge[sp - 1] = curE;
          stackNode[sp] = v;
          stackNextEdge[sp] = firstOutEdge[v];
          sp += 1;
          pushed = true;
          break;
        }
      }
      if (!pushed) {
        postOrder[postLen++] = u;
        sp -= 1;
      }
    }
  }

  const rpoCount = postLen;
  const rpoOrder = new Int32Array(rpoCount);
  for (let i = 0; i < rpoCount; i += 1) {
    const u = postOrder[rpoCount - 1 - i];
    rpoOrder[i] = u;
    rpoNum[u] = i;
  }

  // Build CSR incoming essential edges among reachable nodes for fast O(V + E) Cooper-Harvey-Kennedy dominators.
  const inDeg = new Int32Array(nodeCount);
  for (let i = 0; i < rpoCount; i += 1) {
    const u = rpoOrder[i];
    const sE = firstOutEdge[u];
    const eE = firstOutEdge[u + 1];
    for (let e = sE; e < eE; e += 1) {
      if (!isEssentialEdge(u, e)) continue;
      const v = edgeTarget[e];
      if (v > 0 && rpoNum[v] >= 0) {
        inDeg[v] += 1;
      }
    }
  }
  const firstIn = new Int32Array(nodeCount + 1);
  let inTotal = 0;
  for (let u = 0; u < nodeCount; u += 1) {
    firstIn[u] = inTotal;
    inTotal += inDeg[u];
  }
  firstIn[nodeCount] = inTotal;
  const inSources = new Int32Array(inTotal);
  const inWrite = new Int32Array(firstIn.subarray(0, nodeCount));
  for (let i = 0; i < rpoCount; i += 1) {
    const u = rpoOrder[i];
    const sE = firstOutEdge[u];
    const eE = firstOutEdge[u + 1];
    for (let e = sE; e < eE; e += 1) {
      if (!isEssentialEdge(u, e)) continue;
      const v = edgeTarget[e];
      if (v > 0 && rpoNum[v] >= 0) {
        inSources[inWrite[v]++] = u;
      }
    }
  }

  // Cooper-Harvey-Kennedy iterative dominator algorithm in RPO number space.
  const idomRpo = new Int32Array(rpoCount);
  idomRpo.fill(-1);
  if (rpoCount > 0) idomRpo[0] = 0;

  function intersect(b1, b2) {
    let f1 = b1;
    let f2 = b2;
    while (f1 !== f2) {
      while (f1 > f2) f1 = idomRpo[f1];
      while (f2 > f1) f2 = idomRpo[f2];
    }
    return f1;
  }

  let changed = true;
  let passes = 0;
  while (changed && passes < 50) {
    changed = false;
    passes += 1;
    for (let idx = 1; idx < rpoCount; idx += 1) {
      const u = rpoOrder[idx];
      const sI = firstIn[u];
      const eI = firstIn[u + 1];
      let newIdom = -1;
      for (let k = sI; k < eI; k += 1) {
        const predRpo = rpoNum[inSources[k]];
        if (predRpo >= 0 && idomRpo[predRpo] !== -1) {
          newIdom = newIdom === -1 ? predRpo : intersect(predRpo, newIdom);
        }
      }
      if (newIdom !== -1 && idomRpo[idx] !== newIdom) {
        idomRpo[idx] = newIdom;
        changed = true;
      }
    }
  }

  const idomNode = new Int32Array(nodeCount);
  idomNode.fill(-1);
  for (let idx = 1; idx < rpoCount; idx += 1) {
    const domRpo = idomRpo[idx];
    if (domRpo >= 0) idomNode[rpoOrder[idx]] = rpoOrder[domRpo];
  }

  const retainedSize = new Float64Array(selfSize);
  for (let idx = rpoCount - 1; idx >= 1; idx -= 1) {
    const u = rpoOrder[idx];
    const dom = idomNode[u];
    if (dom >= 0) {
      retainedSize[dom] += retainedSize[u];
    }
  }

  let detachedDomRetainedBytes = 0;
  for (let u = 0; u < nodeCount; u += 1) {
    if (detachedFlags[u]) {
      let anc = idomNode[u];
      let ancDetached = false;
      let guard = 0;
      while (anc > 0 && guard++ < 256) {
        if (detachedFlags[anc]) { ancDetached = true; break; }
        anc = idomNode[anc];
      }
      if (!ancDetached) detachedDomRetainedBytes += retainedSize[u];
    }
  }

  // Per-constructor aggregation (with Chrome DevTools ancestor deduplication for retainedBytes).
  const ctorKeyByNode = new Int32Array(nodeCount);
  const ctorKeyMap = new Map();
  const ctorList = [];

  for (let u = 0; u < nodeCount; u += 1) {
    const tName = nodeTypes[nodeTypeIdx[u]] || 'object';
    const rawName = String(strings[nodeNameIdx[u]] ?? '');
    const bucket = normalizeConstructorBucket(tName, rawName);
    const key = bucket.type + '\\0' + bucket.name;
    let cid = ctorKeyMap.get(key);
    if (cid === undefined) {
      cid = ctorList.length;
      ctorKeyMap.set(key, cid);
      ctorList.push({ name: bucket.name, type: bucket.type, count: 0, selfBytes: 0, retainedBytes: 0 });
    }
    ctorKeyByNode[u] = cid;
    const entry = ctorList[cid];
    entry.count += 1;
    entry.selfBytes += selfSize[u];
  }

  for (let u = 1; u < nodeCount; u += 1) {
    if (rpoNum[u] < 0) continue;
    const cid = ctorKeyByNode[u];
    let anc = idomNode[u];
    let sameCtorAncestor = false;
    let guard = 0;
    while (anc > 0 && guard++ < 512) {
      if (ctorKeyByNode[anc] === cid) {
        sameCtorAncestor = true;
        break;
      }
      anc = idomNode[anc];
    }
    if (!sameCtorAncestor) {
      ctorList[cid].retainedBytes += retainedSize[u];
    }
  }

  function formatEdgeName(eIdx) {
    const eb = eIdx * efc;
    const et = edgeTypeArr[eIdx];
    const rawNameOrIdx = iEName >= 0 ? Math.trunc(Number(edges[eb + iEName] || 0)) : 0;
    if (et === elementEdgeTypeIdx || et === hiddenEdgeTypeIdx) {
      return '[' + rawNameOrIdx + ']';
    }
    return sanitizeHeapText(String(strings[rawNameOrIdx] ?? rawNameOrIdx));
  }

  return {
    nodeCount,
    edgeCount,
    totalSelfBytes,
    detachedDomNodeCount,
    detachedDomSelfBytes,
    detachedDomRetainedBytes,
    nodeTypes,
    edgeTypes,
    strings,
    firstOutEdge,
    edgeTarget,
    edgeTypeArr,
    selfSize,
    retainedSize,
    nodeTypeIdx,
    nodeNameIdx,
    nodeObjId,
    detachedFlags,
    idomNode,
    rpoNum,
    ctorList,
    weakEdgeTypeIdx,
    formatEdgeName
  };
}

function analyzeSnapshot(snapshotPath, top, topLargest, v8HeapUsage) {
  const safeTop = Math.min(Math.max(Math.floor(top || 30), 1), 200);
  const safeLargest = Math.min(Math.max(Math.floor(topLargest || 5), 1), 20);
  const g = parseV8HeapGraph(snapshotPath);

  const nonRootCtors = g.ctorList.filter((c) => !(c.type === 'synthetic' && SYNTHETIC_SKIP_NAMES.has(c.name)));

  const constructors = [...nonRootCtors]
    .sort((a, b) => (b.retainedBytes !== a.retainedBytes ? b.retainedBytes - a.retainedBytes : b.selfBytes - a.selfBytes))
    .slice(0, safeTop)
    .map((c) => ({
      name: c.name,
      type: c.type,
      count: c.count,
      selfBytes: Math.round(c.selfBytes),
      retainedBytes: Math.round(c.retainedBytes),
      selfPercent: roundPct(c.selfBytes, g.totalSelfBytes),
      retainedPercent: roundPct(c.retainedBytes, g.totalSelfBytes)
    }));

  const constructorsBySelf = [...nonRootCtors]
    .sort((a, b) => (b.selfBytes !== a.selfBytes ? b.selfBytes - a.selfBytes : b.retainedBytes - a.retainedBytes))
    .slice(0, safeTop)
    .map((c) => ({
      name: c.name,
      type: c.type,
      count: c.count,
      selfBytes: Math.round(c.selfBytes),
      retainedBytes: Math.round(c.retainedBytes),
      selfPercent: roundPct(c.selfBytes, g.totalSelfBytes),
      retainedPercent: roundPct(c.retainedBytes, g.totalSelfBytes)
    }));

  // Pick top N largest non-synthetic/user objects by retainedBytes (excluding internal backing arrays
  // and raw string literals, and deduplicating redundant ancestor/descendant wrappers).
  const candidates = [];
  for (let u = 1; u < g.nodeCount; u += 1) {
    if (g.rpoNum[u] < 0) continue;
    const tName = g.nodeTypes[g.nodeTypeIdx[u]] || 'object';
    const sName = String(g.strings[g.nodeNameIdx[u]] ?? '');
    if (tName === 'synthetic' || tName === 'hidden' || tName === 'code' || tName === 'Simd128') continue;
    if (tName === 'string' || tName === 'concatenated string' || tName === 'sliced string') continue;
    if (tName === 'array' && sName.startsWith('(')) continue;
    if (!g.detachedFlags[u] && (sName === 'Window' || sName.startsWith('Window / '))) continue;
    if (SYNTHETIC_SKIP_NAMES.has(sName) || sName.startsWith('system /')) continue;
    candidates.push(u);
  }
  candidates.sort((a, b) => {
    if (g.retainedSize[b] !== g.retainedSize[a]) return g.retainedSize[b] - g.retainedSize[a];
    return g.selfSize[b] - g.selfSize[a];
  });

  function isDominatorRelated(a, b) {
    let cur = a;
    let guard = 0;
    while (cur > 0 && guard++ < 64) {
      if (cur === b) return true;
      cur = g.idomNode[cur];
    }
    cur = b;
    guard = 0;
    while (cur > 0 && guard++ < 64) {
      if (cur === a) return true;
      cur = g.idomNode[cur];
    }
    return false;
  }

  const chosen = [];
  for (let i = 0; i < candidates.length && chosen.length < safeLargest; i += 1) {
    const u = candidates[i];
    let redundant = false;
    for (let j = 0; j < chosen.length; j += 1) {
      const v = chosen[j];
      if (isDominatorRelated(u, v)) {
        const hi = Math.max(g.retainedSize[u], g.retainedSize[v]);
        const lo = Math.min(g.retainedSize[u], g.retainedSize[v]);
        if (hi > 0 && lo / hi >= 0.9) {
          redundant = true;
          break;
        }
      }
    }
    if (!redundant) chosen.push(u);
  }
  if (chosen.length < safeLargest) {
    const chosenSet = new Set(chosen);
    for (let i = 0; i < candidates.length && chosen.length < safeLargest; i += 1) {
      if (!chosenSet.has(candidates[i])) {
        chosen.push(candidates[i]);
        chosenSet.add(candidates[i]);
      }
    }
  }

  // Collect incoming retainers for chosen nodes + edge labels along their dominator chains in one O(E) scan!
  const targetSet = new Set(chosen);
  const domParentEdgeTargetSet = new Set();
  for (const u of chosen) {
    let cur = u;
    let guard = 0;
    while (cur > 0 && guard++ < 32) {
      domParentEdgeTargetSet.add(cur);
      cur = g.idomNode[cur];
    }
  }

  const retainersByTarget = new Map();
  for (const u of chosen) retainersByTarget.set(u, []);
  const domEdgeLabel = new Map(); // childOrd -> edgeLabel from idomNode[childOrd]

  for (let from = 0; from < g.nodeCount; from += 1) {
    if (g.rpoNum[from] < 0) continue;
    const sE = g.firstOutEdge[from];
    const eE = g.firstOutEdge[from + 1];
    for (let e = sE; e < eE; e += 1) {
      const to = g.edgeTarget[e];
      if (to < 0) continue;
      const et = g.edgeTypeArr[e];
      if (et === g.weakEdgeTypeIdx) continue;
      if (domParentEdgeTargetSet.has(to) && g.idomNode[to] === from && !domEdgeLabel.has(to)) {
        const eTypeStr = g.edgeTypes[et] || 'property';
        domEdgeLabel.set(to, eTypeStr + ':' + g.formatEdgeName(e));
      }
      if (targetSet.has(to) && from !== to) {
        const list = retainersByTarget.get(to);
        const fromType = g.nodeTypes[g.nodeTypeIdx[from]] || 'object';
        const rawFromName = String(g.strings[g.nodeNameIdx[from]] ?? '');
        const fromName = formatSafeNodeName(fromType, rawFromName, g.selfSize[from]);
        list.push({
          fromObjectId: g.nodeObjId[from],
          fromName,
          fromType,
          edgeType: g.edgeTypes[et] || 'property',
          edgeName: g.formatEdgeName(e).slice(0, 120),
          fromSelfBytes: Math.round(g.selfSize[from]),
          fromRetainedBytes: Math.round(g.retainedSize[from])
        });
      }
    }
  }

  const largestObjects = chosen.map((u) => {
    const tName = g.nodeTypes[g.nodeTypeIdx[u]] || 'object';
    const rawSName = String(g.strings[g.nodeNameIdx[u]] ?? '');
    const sName = formatSafeNodeName(tName, rawSName, g.selfSize[u]);
    const rets = (retainersByTarget.get(u) || [])
      .sort((a, b) => (b.fromRetainedBytes !== a.fromRetainedBytes ? b.fromRetainedBytes - a.fromRetainedBytes : b.fromSelfBytes - a.fromSelfBytes))
      .slice(0, 8);

    const dominatorChain = [];
    let cur = u;
    let guard = 0;
    while (cur >= 0 && guard++ < 16) {
      const ct = g.nodeTypes[g.nodeTypeIdx[cur]] || 'object';
      const rawCn = String(g.strings[g.nodeNameIdx[cur]] ?? '');
      const cn = cur === 0 ? '(GC roots)' : formatSafeNodeName(ct, rawCn, g.selfSize[cur]);
      dominatorChain.push({
        objectId: g.nodeObjId[cur],
        name: cn,
        type: ct,
        edgeLabel: domEdgeLabel.get(cur) || (cur === 0 ? 'root' : 'dominates'),
        retainedBytes: Math.round(g.retainedSize[cur])
      });
      if (cur === 0) break;
      cur = g.idomNode[cur];
    }

    return {
      objectId: g.nodeObjId[u],
      name: sName,
      type: tName,
      detached: Boolean(g.detachedFlags[u]),
      selfBytes: Math.round(g.selfSize[u]),
      retainedBytes: Math.round(g.retainedSize[u]),
      retainedPercent: roundPct(g.retainedSize[u], g.totalSelfBytes),
      dominatorChain,
      topRetainers: rets
    };
  });

  const usedHeapBytes =
    v8HeapUsage && typeof v8HeapUsage.usedSize === 'number' && v8HeapUsage.usedSize > 0
      ? Math.round(v8HeapUsage.usedSize)
      : Math.round(g.totalSelfBytes);
  const totalHeapBytes =
    v8HeapUsage && typeof v8HeapUsage.totalSize === 'number' && v8HeapUsage.totalSize > 0
      ? Math.round(v8HeapUsage.totalSize)
      : Math.round(g.totalSelfBytes);

  return {
    totalHeapBytes,
    usedHeapBytes,
    snapshotSelfBytes: Math.round(g.totalSelfBytes),
    nodeCount: g.nodeCount,
    edgeCount: g.edgeCount,
    detachedDomNodeCount: g.detachedDomNodeCount,
    detachedDomSelfBytes: Math.round(g.detachedDomSelfBytes),
    detachedDomRetainedBytes: Math.round(g.detachedDomRetainedBytes),
    constructors,
    constructorsBySelf,
    largestObjects
  };
}

function diffSnapshots(beforePath, afterPath, top) {
  const safeTop = Math.min(Math.max(Math.floor(top || 30), 1), 200);
  const beforeG = parseV8HeapGraph(beforePath);
  const afterG = parseV8HeapGraph(afterPath);

  const byKey = new Map();
  for (const c of beforeG.ctorList) {
    if (c.type === 'synthetic' && SYNTHETIC_SKIP_NAMES.has(c.name)) continue;
    const k = c.type + '\\0' + c.name;
    byKey.set(k, {
      name: c.name,
      type: c.type,
      countBefore: c.count,
      countAfter: 0,
      selfBytesBefore: Math.round(c.selfBytes),
      selfBytesAfter: 0,
      retainedBytesBefore: Math.round(c.retainedBytes),
      retainedBytesAfter: 0
    });
  }
  for (const c of afterG.ctorList) {
    if (c.type === 'synthetic' && SYNTHETIC_SKIP_NAMES.has(c.name)) continue;
    const k = c.type + '\\0' + c.name;
    let rec = byKey.get(k);
    if (!rec) {
      rec = {
        name: c.name,
        type: c.type,
        countBefore: 0,
        countAfter: 0,
        selfBytesBefore: 0,
        selfBytesAfter: 0,
        retainedBytesBefore: 0,
        retainedBytesAfter: 0
      };
      byKey.set(k, rec);
    }
    rec.countAfter = c.count;
    rec.selfBytesAfter = Math.round(c.selfBytes);
    rec.retainedBytesAfter = Math.round(c.retainedBytes);
  }

  const allDiffs = Array.from(byKey.values()).map((r) => ({
    ...r,
    countDelta: r.countAfter - r.countBefore,
    selfBytesDelta: r.selfBytesAfter - r.selfBytesBefore,
    retainedBytesDelta: r.retainedBytesAfter - r.retainedBytesBefore
  }));

  const grownConstructors = allDiffs
    .filter((d) => d.selfBytesDelta > 0 || d.retainedBytesDelta > 0 || d.countDelta > 0)
    .sort((a, b) => (b.retainedBytesDelta !== a.retainedBytesDelta ? b.retainedBytesDelta - a.retainedBytesDelta : b.selfBytesDelta - a.selfBytesDelta))
    .slice(0, safeTop);

  const freedConstructors = allDiffs
    .filter((d) => d.selfBytesDelta < 0 || d.countDelta < 0)
    .sort((a, b) => a.selfBytesDelta - b.selfBytesDelta)
    .slice(0, Math.min(safeTop, 15));

  return {
    beforePath,
    afterPath,
    beforeTotalSelfBytes: Math.round(beforeG.totalSelfBytes),
    afterTotalSelfBytes: Math.round(afterG.totalSelfBytes),
    totalSelfBytesDelta: Math.round(afterG.totalSelfBytes - beforeG.totalSelfBytes),
    beforeNodeCount: beforeG.nodeCount,
    afterNodeCount: afterG.nodeCount,
    nodeCountDelta: afterG.nodeCount - beforeG.nodeCount,
    beforeDetachedDomCount: beforeG.detachedDomNodeCount,
    afterDetachedDomCount: afterG.detachedDomNodeCount,
    detachedDomCountDelta: afterG.detachedDomNodeCount - beforeG.detachedDomNodeCount,
    grownConstructors,
    freedConstructors
  };
}

function finalizeSampling(profile, profilesDir, tabId, viewport, nowMs, maxBytes, top) {
  const safeTop = Math.min(Math.max(Math.floor(top || 30), 1), 200);
  if (fs.existsSync(profilesDir)) {
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('refusing to write heap sampling profile into non-directory or symlink: ' + profilesDir);
    }
  } else {
    fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  }
  const safeTab = String(tabId || 'tab').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tab';
  let savedPath = '';
  let savedBytes = 0;
  let truncated = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : '-' + attempt;
    const candidate = path.join(profilesDir, 'heap-sampling-' + safeTab + '-' + viewport + '-' + nowMs + suffix + '.heapprofile');
    let fd;
    try {
      fd = fs.openSync(candidate, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      const jsonStr = JSON.stringify(profile || {});
      const buf = Buffer.from(jsonStr, 'utf8');
      if (buf.length <= maxBytes) {
        fs.writeSync(fd, buf, 0, buf.length);
        savedBytes = buf.length;
      } else {
        truncated = true;
        const stub = Buffer.from(JSON.stringify({ truncated: true, originalBytes: buf.length, head: profile && profile.head ? { callFrame: profile.head.callFrame, selfSize: profile.head.selfSize } : null }), 'utf8');
        fs.writeSync(fd, stub, 0, stub.length);
        savedBytes = stub.length;
      }
      savedPath = candidate;
    } finally {
      fs.closeSync(fd);
    }
    break;
  }

  // Walk SamplingHeapProfile tree(s) (profile.head or multi-segment profiles) + samples count
  const segList = Array.isArray(profile && profile.__segments)
    ? profile.__segments
    : [profile || {}];
  let totalSamplesCount = 0;
  const stackEntries = [];
  let nodeCount = 0;
  let totalAllocatedBytes = 0;

  for (let segIdx = 0; segIdx < segList.length; segIdx += 1) {
    const seg = segList[segIdx] || {};
    const samplesArr = Array.isArray(seg.samples) ? seg.samples : [];
    totalSamplesCount += samplesArr.length;
    const allocCountByNodeId = new Map();
    for (const s of samplesArr) {
      if (s && typeof s.nodeId === 'number') {
        allocCountByNodeId.set(s.nodeId, (allocCountByNodeId.get(s.nodeId) || 0) + 1);
      }
    }

    function walk(node, ancestorStack) {
      if (!node || typeof node !== 'object') return 0;
      nodeCount += 1;
      const cf = node.callFrame || {};
      const rawFn = String(cf.functionName || '').trim();
      const functionName = rawFn.length > 0 ? rawFn : '(anonymous)';
      const rawUrl = String(cf.url || '').trim();
      const url = rawUrl.length > 0 ? redactScriptUrl(rawUrl) : '(internal)';
      const line = typeof cf.lineNumber === 'number' && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0;
      const column = typeof cf.columnNumber === 'number' && cf.columnNumber >= 0 ? cf.columnNumber + 1 : 0;
      const location = line > 0 ? url + ':' + line + ':' + column : url;
      const frameStr = functionName + '@' + location;
      const nextStack = functionName === '(root)' ? ancestorStack : [frameStr, ...ancestorStack].slice(0, 24);

      const selfB = typeof node.selfSize === 'number' && node.selfSize > 0 ? node.selfSize : 0;
      totalAllocatedBytes += selfB;

      let childrenBytes = 0;
      const kids = Array.isArray(node.children) ? node.children : [];
      for (const k of kids) {
        childrenBytes += walk(k, nextStack);
      }
      const totalB = selfB + childrenBytes;
      const nid = typeof node.id === 'number' ? node.id : 0;
      const allocs = allocCountByNodeId.get(nid) || (selfB > 0 ? 1 : 0);

      if (functionName !== '(root)' && totalB > 0) {
        stackEntries.push({
          functionName,
          url,
          line,
          column,
          location,
          selfBytes: Math.round(selfB),
          totalBytes: Math.round(totalB),
          allocations: allocs,
          stack: nextStack
        });
      }
      return totalB;
    }

    if (seg && seg.head) {
      walk(seg.head, []);
    }
  }

  const topAllocatingStacks = [...stackEntries]
    .filter((e) => e.selfBytes > 0)
    .sort((a, b) => (b.selfBytes !== a.selfBytes ? b.selfBytes - a.selfBytes : b.totalBytes - a.totalBytes))
    .slice(0, safeTop)
    .map((e) => ({
      ...e,
      selfPercent: roundPct(e.selfBytes, totalAllocatedBytes),
      totalPercent: roundPct(e.totalBytes, totalAllocatedBytes)
    }));

  const topInclusiveStacks = [...stackEntries]
    .sort((a, b) => (b.totalBytes !== a.totalBytes ? b.totalBytes - a.totalBytes : b.selfBytes - a.selfBytes))
    .slice(0, safeTop)
    .map((e) => ({
      ...e,
      selfPercent: roundPct(e.selfBytes, totalAllocatedBytes),
      totalPercent: roundPct(e.totalBytes, totalAllocatedBytes)
    }));

  return {
    saved: { profilePath: savedPath, bytes: savedBytes, truncated },
    summary: {
      totalAllocatedBytes: Math.round(totalAllocatedBytes),
      nodeCount,
      sampleCount: totalSamplesCount,
      topAllocatingStacks,
      topInclusiveStacks
    }
  };
}

try {
  const op = workerData.op;
  if (op === 'analyze_snapshot') {
    const summary = analyzeSnapshot(workerData.snapshotPath, workerData.top, workerData.topLargest, workerData.v8HeapUsage);
    parentPort.postMessage({ ok: true, summary });
  } else if (op === 'diff_snapshots') {
    const diff = diffSnapshots(workerData.beforePath, workerData.afterPath, workerData.top);
    parentPort.postMessage({ ok: true, diff });
  } else if (op === 'finalize_sampling') {
    const out = finalizeSampling(
      workerData.profile,
      workerData.profilesDir,
      workerData.tabId,
      workerData.viewport,
      workerData.nowMs,
      workerData.maxBytes,
      workerData.top
    );
    parentPort.postMessage({ ok: true, ...out });
  } else {
    throw new Error('Unknown heap worker op: ' + op);
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

function runHeapWorker<T>(payload: Record<string, unknown>, timeoutMs = HEAP_WORKER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(HEAP_WORKER_SCRIPT, {
      eval: true,
      workerData: payload,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().catch(() => {});
      reject(new Error(`Heap analysis worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    worker.once('message', (msg: { ok: boolean; error?: string } & T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!msg?.ok) {
        reject(new Error(msg?.error ?? 'Heap worker failed'));
        return;
      }
      resolve(msg);
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Heap worker exited unexpectedly with code ${code}`));
    });
  });
}

function ensureSafeProfilesDir(profilesDir: string): string {
  if (fs.existsSync(profilesDir)) {
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to use non-directory or symlink profiles dir: ${profilesDir}`);
    }
  } else {
    fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(profilesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to use symlink profiles dir: ${profilesDir}`);
    }
  }
  return fs.realpathSync(profilesDir);
}

export function validateHeapSnapshotPathInDir(profilesDir: string, candidatePath: string): string {
  const realDir = ensureSafeProfilesDir(profilesDir);
  const resolved = path.resolve(candidatePath);
  if (!resolved.endsWith('.heapsnapshot')) {
    throw new Error(`snapshot path must end with .heapsnapshot: ${candidatePath}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`heap snapshot file not found: ${resolved}`);
  }
  const lst = fs.lstatSync(resolved);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error(`refusing symlink or non-file heap snapshot: ${resolved}`);
  }
  const realFile = fs.realpathSync(resolved);
  const rel = path.relative(realDir, realFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`heap snapshot path must reside inside profiles directory (${realDir})`);
  }
  return realFile;
}

export async function analyzeHeapSnapshotOffThread(
  snapshotPath: string,
  opts: {
    top?: number;
    topLargest?: number;
    v8HeapUsage?: { usedSize?: number; totalSize?: number };
  } = {},
): Promise<HeapSnapshotSummary> {
  const res = await runHeapWorker<{ summary: HeapSnapshotSummary }>({
    op: 'analyze_snapshot',
    snapshotPath,
    top: opts.top ?? 30,
    topLargest: opts.topLargest ?? 5,
    v8HeapUsage: opts.v8HeapUsage ?? null,
  });
  return res.summary;
}

export async function diffHeapSnapshotsOffThread(
  beforePath: string,
  afterPath: string,
  top = 30,
): Promise<HeapDiffSummary> {
  const res = await runHeapWorker<{ diff: HeapDiffSummary }>({
    op: 'diff_snapshots',
    beforePath,
    afterPath,
    top,
  });
  return res.diff;
}

interface ActiveHeapSamplingSession {
  samplingId: string;
  tabId: string;
  viewport: ViewportRole;
  wc: DebuggerTarget;
  startedAtMs: number;
  samplingIntervalBytes: number;
  priorSegments: Record<string, unknown>[];
  navChain: Promise<void>;
  unsubNav: () => void;
  unregister: () => void;
}

const HEAP_STOP_SAMPLING_TIMEOUT_MS = 15_000;

export class HeapProfilerManager {
  private readonly activeSampling = new Map<string, ActiveHeapSamplingSession>();
  private readonly recentSnapshotsByPane = new Map<string, string[]>();
  private readonly inFlightSnapshots = new Map<string, number>();
  private nextSeq = 1;
  private disposed = false;

  constructor(
    private readonly coordinator: DebuggerCoordinator,
    private readonly getProfilesDir: () => string,
  ) {}

  private paneKey(tabId: string, viewport: ViewportRole): string {
    return `${tabId}:${viewport}`;
  }

  private hasActiveHeapWorkOnWc(wcId: number): boolean {
    for (const activeWcId of this.inFlightSnapshots.values()) {
      if (activeWcId === wcId) return true;
    }
    for (const sess of this.activeSampling.values()) {
      if (sess.wc.id === wcId) return true;
    }
    return false;
  }

  private scheduleDisableHeapProfilerIfIdle(wc: DebuggerTarget): void {
    const wcId = wc.id;
    setImmediate(() => {
      if (!this.disposed && !wc.isDestroyed() && !this.hasActiveHeapWorkOnWc(wcId)) {
        void this.coordinator.sendCommand(wc, 'HeapProfiler.disable').catch(() => {});
      }
    });
  }

  private recordSnapshotPath(tabId: string, viewport: ViewportRole, snapshotPath: string): void {
    const key = this.paneKey(tabId, viewport);
    const list = this.recentSnapshotsByPane.get(key) ?? [];
    list.push(snapshotPath);
    if (list.length > 10) list.splice(0, list.length - 10);
    this.recentSnapshotsByPane.set(key, list);
  }

  async takeSnapshot(params: {
    tabId: string;
    viewport: ViewportRole;
    wc: DebuggerTarget;
    top?: number;
    topLargest?: number;
    maxBytes?: number;
  }): Promise<{
    ok: true;
    action: 'snapshot';
    tabId: string;
    viewport: ViewportRole;
    snapshotPath: string;
    snapshotBytes: number;
    elapsedMs: number;
    summary: HeapSnapshotSummary;
  }> {
    if (this.disposed) throw new Error('HeapProfilerManager is disposed');
    if (params.wc.isDestroyed()) throw new Error('target viewport WebContents is destroyed');

    const key = this.paneKey(params.tabId, params.viewport);
    if (this.inFlightSnapshots.has(key)) {
      throw new Error(`heap snapshot already in progress on ${key}`);
    }
    this.inFlightSnapshots.set(key, params.wc.id);

    const t0 = Date.now();
    const maxBytes = params.maxBytes ?? MAX_HEAPSNAPSHOT_BYTES;
    const profilesDir = this.getProfilesDir();
    ensureSafeProfilesDir(profilesDir);

    const safeTab = params.tabId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'tab';
    let snapshotPath = '';
    let fd: number | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt}`;
      const candidate = path.join(
        profilesDir,
        `heap-${safeTab}-${params.viewport}-${t0}${suffix}.heapsnapshot`,
      );
      try {
        fd = fs.openSync(candidate, 'wx', 0o600);
        snapshotPath = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
        this.inFlightSnapshots.delete(key);
        throw err;
      }
    }
    if (fd === null || !snapshotPath) {
      this.inFlightSnapshots.delete(key);
      throw new Error('failed to allocate unique .heapsnapshot file');
    }

    let bytesWritten = 0;
    let exceededCap = false;
    let pendingStr = '';
    let writeChain = Promise.resolve();
    let writeError: Error | null = null;

    const flushPending = (force: boolean) => {
      if (pendingStr.length === 0 || (!force && pendingStr.length < 131_072)) return;
      const chunkBuf = Buffer.from(pendingStr, 'utf8');
      pendingStr = '';
      if (exceededCap || writeError) return;
      if (bytesWritten + chunkBuf.length > maxBytes) {
        exceededCap = true;
        return;
      }
      bytesWritten += chunkBuf.length;
      const targetFd = fd!;
      writeChain = writeChain.then(
        () =>
          new Promise<void>((resolve) => {
            fs.write(targetFd, chunkBuf, 0, chunkBuf.length, null, (err) => {
              if (err && !writeError) writeError = err;
              resolve();
            });
          }),
      );
    };

    let abortDestroyed: (() => void) | null = null;
    const unregister = this.coordinator.registerParticipant(
      params.wc,
      `heap-snapshot:${key}:${this.nextSeq++}`,
      {
        onMessage: (method, msgParams) => {
          if (method === 'HeapProfiler.addHeapSnapshotChunk') {
            const chunk =
              msgParams && typeof (msgParams as { chunk?: unknown }).chunk === 'string'
                ? (msgParams as { chunk: string }).chunk
                : '';
            if (chunk && !exceededCap && !writeError) {
              pendingStr += chunk;
              if (pendingStr.length >= 131_072) {
                flushPending(true);
              }
            }
          }
        },
        onDestroyed: () => {
          abortDestroyed?.();
        },
      },
    );

    try {
      const attached = await this.coordinator.ensureAttached(params.wc);
      if (!attached) {
        throw new Error(`failed to attach CDP debugger to ${key}`);
      }

      const v8HeapUsage = (await this.coordinator
        .sendCommand(params.wc, 'Runtime.getHeapUsage')
        .catch(() => null)) as { usedSize?: number; totalSize?: number } | null;

      await this.coordinator.sendCommand(params.wc, 'HeapProfiler.enable');

      let snapTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.coordinator.sendCommand(params.wc, 'HeapProfiler.takeHeapSnapshot', {
            reportProgress: false,
            treatGlobalObjectsAsRoots: true,
          }),
          new Promise<never>((_resolve, reject) => {
            abortDestroyed = () =>
              reject(new Error(`viewport ${key} destroyed during takeHeapSnapshot`));
            snapTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `HeapProfiler.takeHeapSnapshot timed out after ${HEAP_SNAPSHOT_TIMEOUT_MS}ms`,
                  ),
                ),
              HEAP_SNAPSHOT_TIMEOUT_MS,
            );
            snapTimer.unref?.();
          }),
        ]);
      } finally {
        if (snapTimer) clearTimeout(snapTimer);
      }

      flushPending(true);
      await writeChain;
      fs.closeSync(fd);
      fd = null;

      if (writeError) {
        throw writeError;
      }
      if (exceededCap) {
        try {
          fs.unlinkSync(snapshotPath);
        } catch {
          // Ignore cleanup errors.
        }
        throw new Error(`heap snapshot exceeded ${maxBytes} byte cap`);
      }

      const summary = await analyzeHeapSnapshotOffThread(snapshotPath, {
        top: params.top ?? 30,
        topLargest: params.topLargest ?? 5,
        v8HeapUsage: v8HeapUsage ?? undefined,
      });

      this.recordSnapshotPath(params.tabId, params.viewport, snapshotPath);

      return {
        ok: true,
        action: 'snapshot',
        tabId: params.tabId,
        viewport: params.viewport,
        snapshotPath,
        snapshotBytes: bytesWritten,
        elapsedMs: Math.max(0, Date.now() - t0),
        summary,
      };
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore.
        }
        fd = null;
      }
      try {
        if (snapshotPath && fs.existsSync(snapshotPath)) {
          fs.unlinkSync(snapshotPath);
        }
      } catch {
        // Ignore.
      }
      throw err;
    } finally {
      unregister();
      this.inFlightSnapshots.delete(key);
      this.scheduleDisableHeapProfilerIfIdle(params.wc);
    }
  }

  async startSampling(params: {
    tabId: string;
    viewport: ViewportRole;
    wc: DebuggerTarget;
    samplingIntervalBytes?: number;
  }): Promise<{
    ok: true;
    action: 'sampling_start';
    samplingId: string;
    tabId: string;
    viewport: ViewportRole;
    samplingIntervalBytes: number;
    startedAtMs: number;
  }> {
    if (this.disposed) throw new Error('HeapProfilerManager is disposed');
    if (params.wc.isDestroyed()) throw new Error('target viewport WebContents is destroyed');

    const key = this.paneKey(params.tabId, params.viewport);
    if (this.activeSampling.has(key)) {
      throw new Error(`heap sampling already active on ${key}; call sampling_stop first`);
    }

    const attached = await this.coordinator.ensureAttached(params.wc);
    if (!attached) {
      throw new Error(`failed to attach CDP debugger to ${key}`);
    }

    const samplingIntervalBytes = Math.min(
      Math.max(
        Math.round(params.samplingIntervalBytes ?? DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES),
        512,
      ),
      1024 * 1024,
    );

    const samplingId = `heapsamp-${this.nextSeq++}`;
    const startedAtMs = Date.now();

    const session: ActiveHeapSamplingSession = {
      samplingId,
      tabId: params.tabId,
      viewport: params.viewport,
      wc: params.wc,
      startedAtMs,
      samplingIntervalBytes,
      priorSegments: [],
      navChain: Promise.resolve(),
      unsubNav: () => {},
      unregister: () => {},
    };

    const wcEvents = params.wc as unknown as {
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
      removeListener?: (ev: string, fn: () => void) => void;
    };
    const onDidNavigate = () => {
      session.navChain = session.navChain
        .catch(() => {})
        .then(async () => {
          if (this.activeSampling.get(key) !== session || session.wc.isDestroyed()) return;
          const prev = (await this.coordinator
            .sendCommand(session.wc, 'HeapProfiler.stopSampling')
            .catch(() => null)) as { profile?: Record<string, unknown> } | null;
          if (prev?.profile && session.priorSegments.length < 8) {
            session.priorSegments.push(prev.profile);
          }
          if (this.activeSampling.get(key) !== session || session.wc.isDestroyed()) return;
          await this.coordinator.sendCommand(session.wc, 'HeapProfiler.enable').catch(() => {});
          await this.coordinator
            .sendCommand(session.wc, 'HeapProfiler.startSampling', {
              samplingInterval: session.samplingIntervalBytes,
            })
            .catch(() => {});
        });
    };
    if (typeof wcEvents.on === 'function') {
      wcEvents.on('did-navigate', onDidNavigate);
      session.unsubNav = () => {
        try {
          if (typeof wcEvents.off === 'function') wcEvents.off('did-navigate', onDidNavigate);
          else if (typeof wcEvents.removeListener === 'function')
            wcEvents.removeListener('did-navigate', onDidNavigate);
        } catch {
          // Ignore listener removal errors on destroyed WebContents.
        }
      };
    }

    session.unregister = this.coordinator.registerParticipant(
      params.wc,
      `heap-sampling:${key}:${samplingId}`,
      {
        onReattach: async () => {
          const cur = this.activeSampling.get(key);
          if (cur !== session || cur.wc.isDestroyed()) return;
          await this.coordinator.sendCommand(cur.wc, 'HeapProfiler.enable').catch(() => {});
          await this.coordinator
            .sendCommand(cur.wc, 'HeapProfiler.startSampling', {
              samplingInterval: cur.samplingIntervalBytes,
            })
            .catch(() => {});
        },
        onDestroyed: () => {
          const cur = this.activeSampling.get(key);
          if (cur === session) {
            cur.unsubNav();
            cur.unregister();
            this.activeSampling.delete(key);
          }
        },
      },
    );

    try {
      await this.coordinator.sendCommand(params.wc, 'HeapProfiler.enable');
      await this.coordinator.sendCommand(params.wc, 'HeapProfiler.startSampling', {
        samplingInterval: samplingIntervalBytes,
      });
    } catch (err) {
      session.unsubNav();
      session.unregister();
      throw err;
    }

    this.activeSampling.set(key, session);

    return {
      ok: true,
      action: 'sampling_start',
      samplingId,
      tabId: params.tabId,
      viewport: params.viewport,
      samplingIntervalBytes,
      startedAtMs,
    };
  }

  async stopSampling(params: {
    tabId: string;
    viewport: ViewportRole;
    top?: number;
  }): Promise<{
    ok: true;
    action: 'sampling_stop';
    samplingId: string;
    tabId: string;
    viewport: ViewportRole;
    durationMs: number;
    profilePath: string;
    profileBytes: number;
    truncated: boolean;
    summary: HeapSamplingSummary;
  }> {
    const key = this.paneKey(params.tabId, params.viewport);
    const session = this.activeSampling.get(key);
    if (!session) {
      throw new Error(`no active heap sampling session on ${key}`);
    }
    this.activeSampling.delete(key);
    session.unsubNav();
    session.unregister();
    await session.navChain.catch(() => {});

    const nowMs = Date.now();
    const durationMs = Math.max(0, nowMs - session.startedAtMs);

    if (session.wc.isDestroyed()) {
      throw new Error(`viewport ${key} was destroyed before sampling_stop`);
    }

    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let res: { profile?: Record<string, unknown> } | undefined;
    try {
      res = (await Promise.race([
        this.coordinator.sendCommand(session.wc, 'HeapProfiler.stopSampling'),
        new Promise<never>((_resolve, reject) => {
          stopTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `HeapProfiler.stopSampling timed out after ${HEAP_STOP_SAMPLING_TIMEOUT_MS}ms`,
                ),
              ),
            HEAP_STOP_SAMPLING_TIMEOUT_MS,
          );
          stopTimer.unref?.();
        }),
      ])) as { profile?: Record<string, unknown> } | undefined;
    } catch (err) {
      if (session.priorSegments.length === 0) {
        this.scheduleDisableHeapProfilerIfIdle(session.wc);
        throw err;
      }
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
    }

    this.scheduleDisableHeapProfilerIfIdle(session.wc);

    const allSegments = [...session.priorSegments];
    if (res?.profile) allSegments.push(res.profile);
    const profilePayload =
      allSegments.length <= 1 ? (allSegments[0] ?? {}) : { __segments: allSegments };

    const out = await runHeapWorker<{
      saved: { profilePath: string; bytes: number; truncated: boolean };
      summary: HeapSamplingSummary;
    }>({
      op: 'finalize_sampling',
      profile: profilePayload,
      profilesDir: this.getProfilesDir(),
      tabId: params.tabId,
      viewport: params.viewport,
      nowMs,
      maxBytes: MAX_HEAPPROFILE_BYTES,
      top: params.top ?? 30,
    });

    return {
      ok: true,
      action: 'sampling_stop',
      samplingId: session.samplingId,
      tabId: params.tabId,
      viewport: params.viewport,
      durationMs,
      profilePath: out.saved.profilePath,
      profileBytes: out.saved.bytes,
      truncated: out.saved.truncated,
      summary: out.summary,
    };
  }

  async diffSnapshots(params: {
    tabId: string;
    viewport: ViewportRole;
    beforePath?: string;
    afterPath?: string;
    top?: number;
  }): Promise<{
    ok: true;
    action: 'diff';
    tabId: string;
    viewport: ViewportRole;
    diff: HeapDiffSummary;
  }> {
    const profilesDir = this.getProfilesDir();
    const key = this.paneKey(params.tabId, params.viewport);
    const recent = this.recentSnapshotsByPane.get(key) ?? [];

    const rawBefore = params.beforePath?.trim() || (recent.length >= 2 ? recent[recent.length - 2] : '');
    const rawAfter = params.afterPath?.trim() || (recent.length >= 1 ? recent[recent.length - 1] : '');

    if (!rawBefore || !rawAfter) {
      throw new Error(
        'browser_heap diff requires before_path and after_path (or at least 2 prior snapshots on this viewport)',
      );
    }

    const safeBefore = validateHeapSnapshotPathInDir(profilesDir, rawBefore);
    const safeAfter = validateHeapSnapshotPathInDir(profilesDir, rawAfter);

    const diff = await diffHeapSnapshotsOffThread(safeBefore, safeAfter, params.top ?? 30);
    return {
      ok: true,
      action: 'diff',
      tabId: params.tabId,
      viewport: params.viewport,
      diff,
    };
  }

  clearTab(tabId: string): void {
    for (const [k, s] of Array.from(this.activeSampling.entries())) {
      if (s.tabId === tabId) {
        s.unsubNav();
        s.unregister();
        this.activeSampling.delete(k);
        if (!s.wc.isDestroyed()) {
          void this.coordinator.sendCommand(s.wc, 'HeapProfiler.stopSampling').catch(() => {});
          this.scheduleDisableHeapProfilerIfIdle(s.wc);
        }
      }
    }
    this.recentSnapshotsByPane.delete(`${tabId}:portrait`);
    this.recentSnapshotsByPane.delete(`${tabId}:landscape`);
  }

  disposeWebContents(wcId: number): void {
    for (const [k, s] of Array.from(this.activeSampling.entries())) {
      if (s.wc.id === wcId) {
        s.unsubNav();
        s.unregister();
        this.activeSampling.delete(k);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.activeSampling.values()) {
      s.unsubNav();
      s.unregister();
    }
    this.activeSampling.clear();
    this.recentSnapshotsByPane.clear();
    this.inFlightSnapshots.clear();
  }
}
