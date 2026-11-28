import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { summarizeCpuProfile } from '../src/main/cpu-profiler';
import { DebuggerCoordinator } from '../src/main/debugger-coordinator';
import { AbnormalExitMonitor, resolveStateLogDir } from '../src/main/diagnostics';
import {
  analyzeHeapSnapshotOffThread,
  diffHeapSnapshotsOffThread,
  HeapProfilerManager,
  validateHeapSnapshotPathInDir,
} from '../src/main/heap-profiler';
import { TabEventBus } from '../src/main/tab-event-bus';
import { extractNetworkInitiator } from '../src/shared/network-initiator';

function buildSyntheticV8Snapshot(opts: { cartCount: number; detachedDivCount: number }) {
  // V8 standard meta layout: 7 node_fields, 3 edge_fields (to_node = ordinal * 7)
  const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'];
  const nodeTypes = [
    ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'],
    'string',
    'number',
    'number',
    'number',
    'number',
    'number',
  ];
  const edgeFields = ['type', 'name_or_index', 'to_node'];
  const edgeTypes = [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'];

  const strings: string[] = [
    '',
    '(GC roots)',
    'Window',
    'CartStore',
    'CartItem',
    'HTMLDivElement',
    '__cartStore',
    'items',
    'detachedCache',
    'weakRef',
  ];
  const strIdx = (s: string) => {
    let idx = strings.indexOf(s);
    if (idx === -1) {
      idx = strings.length;
      strings.push(s);
    }
    return idx;
  };

  interface NodeDef {
    typeIdx: number;
    name: string;
    id: number;
    selfSize: number;
    detached: number;
    edges: Array<{ typeIdx: number; nameOrIdx: number; toOrd: number }>;
  }

  const nodeDefs: NodeDef[] = [];
  // 0: (GC roots) -> Window (1)
  nodeDefs.push({ typeIdx: 9, name: '(GC roots)', id: 1, selfSize: 0, detached: 0, edges: [] });
  // 1: Window -> CartStore (2) via __cartStore
  nodeDefs.push({ typeIdx: 3, name: 'Window', id: 10, selfSize: 256, detached: 0, edges: [] });
  // 2: CartStore -> items Array (3) + detachedCache Array (4)
  nodeDefs.push({ typeIdx: 3, name: 'CartStore', id: 20, selfSize: 512, detached: 0, edges: [] });
  // 3: Array (items)
  nodeDefs.push({ typeIdx: 1, name: 'Array', id: 30, selfSize: 128, detached: 0, edges: [] });
  // 4: Array (detachedCache)
  nodeDefs.push({ typeIdx: 1, name: 'Array', id: 40, selfSize: 128, detached: 0, edges: [] });

  nodeDefs[0]!.edges.push({ typeIdx: 2, nameOrIdx: strIdx('window'), toOrd: 1 });
  nodeDefs[1]!.edges.push({ typeIdx: 2, nameOrIdx: strIdx('__cartStore'), toOrd: 2 });
  nodeDefs[2]!.edges.push({ typeIdx: 2, nameOrIdx: strIdx('items'), toOrd: 3 });
  nodeDefs[2]!.edges.push({ typeIdx: 2, nameOrIdx: strIdx('detachedCache'), toOrd: 4 });

  let nextObjId = 100;
  for (let i = 0; i < opts.cartCount; i += 1) {
    const ord = nodeDefs.length;
    nodeDefs.push({
      typeIdx: 3,
      name: 'CartItem',
      id: nextObjId++,
      selfSize: 2048,
      detached: 0,
      edges: [],
    });
    nodeDefs[3]!.edges.push({ typeIdx: 1, nameOrIdx: i, toOrd: ord });
    // Weak edge from Window should NOT steal dominator ownership from CartStore -> items!
    nodeDefs[1]!.edges.push({ typeIdx: 6, nameOrIdx: strIdx('weakRef'), toOrd: ord });
  }

  for (let d = 0; d < opts.detachedDivCount; d += 1) {
    const ord = nodeDefs.length;
    nodeDefs.push({
      typeIdx: 8,
      name: 'HTMLDivElement',
      id: nextObjId++,
      selfSize: 1024,
      detached: 2, // kDetached
      edges: [],
    });
    nodeDefs[4]!.edges.push({ typeIdx: 1, nameOrIdx: d, toOrd: ord });
  }

  const nodes: number[] = [];
  const edges: number[] = [];
  for (const nd of nodeDefs) {
    nodes.push(
      nd.typeIdx,
      strIdx(nd.name),
      nd.id,
      nd.selfSize,
      nd.edges.length,
      0,
      nd.detached,
    );
    for (const ed of nd.edges) {
      edges.push(ed.typeIdx, ed.nameOrIdx, ed.toOrd * 7);
    }
  }

  return {
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: nodeTypes,
        edge_fields: edgeFields,
        edge_types: edgeTypes,
      },
      node_count: nodeDefs.length,
      edge_count: edges.length / 3,
    },
    nodes,
    edges,
    strings,
  };
}

describe('browser_heap Off-Thread Dominators, Retainers, Sampling, Diff & Path Containment', () => {
  test('computes exact retained sizes (ignoring weak edges), detached DOM count, top retainers, and snapshot diff off-thread', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-heap-unit-'));
    try {
      const beforePath = path.join(tmpDir, 'heap-tab-1-portrait-1000.heapsnapshot');
      const afterPath = path.join(tmpDir, 'heap-tab-1-portrait-2000.heapsnapshot');

      fs.writeFileSync(
        beforePath,
        JSON.stringify(buildSyntheticV8Snapshot({ cartCount: 5, detachedDivCount: 1 })),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        afterPath,
        JSON.stringify(buildSyntheticV8Snapshot({ cartCount: 25, detachedDivCount: 4 })),
        { mode: 0o600 },
      );

      const summary = await analyzeHeapSnapshotOffThread(afterPath, {
        top: 30,
        topLargest: 5,
        v8HeapUsage: { usedSize: 90_000, totalSize: 128_000 },
      });

      expect(summary.usedHeapBytes).toBe(90_000);
      expect(summary.totalHeapBytes).toBe(128_000);
      expect(summary.detachedDomNodeCount).toBe(4);
      expect(summary.detachedDomSelfBytes).toBe(4096);

      const cartStoreCtor = summary.constructors.find((c) => c.name === 'CartStore');
      expect(cartStoreCtor).toBeDefined();
      // CartStore (512) + items Array (128 + 25*2048 = 51328) + detachedCache Array (128 + 4*1024 = 4224) = 56064
      expect(cartStoreCtor!.retainedBytes).toBe(512 + 128 + 25 * 2048 + 128 + 4 * 1024);

      const cartStoreObj = summary.largestObjects.find((o) => o.name === 'CartStore');
      expect(cartStoreObj).toBeDefined();
      expect(cartStoreObj!.topRetainers[0]?.fromName).toBe('Window');
      expect(cartStoreObj!.topRetainers[0]?.edgeName).toBe('__cartStore');
      expect(cartStoreObj!.dominatorChain.map((h) => h.name)).toContain('Window');

      const diff = await diffHeapSnapshotsOffThread(beforePath, afterPath, 30);
      expect(diff.detachedDomCountDelta).toBe(3);
      const cartItemDelta = diff.grownConstructors.find((c) => c.name === 'CartItem');
      expect(cartItemDelta).toBeDefined();
      expect(cartItemDelta!.countDelta).toBe(20);
      expect(cartItemDelta!.selfBytesDelta).toBe(20 * 2048);

      // Path containment: reject path outside profilesDir and reject symlinks
      const outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.heapsnapshot`);
      fs.writeFileSync(outsidePath, '{}');
      const symlinkPath = path.join(tmpDir, 'evil.heapsnapshot');
      fs.symlinkSync(outsidePath, symlinkPath);
      try {
        expect(() => validateHeapSnapshotPathInDir(tmpDir, outsidePath)).toThrow(/inside profiles directory/);
        expect(() => validateHeapSnapshotPathInDir(tmpDir, symlinkPath)).toThrow(/symlink/);
      } finally {
        fs.rmSync(outsidePath, { force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('HeapProfilerManager streams addHeapSnapshotChunk to 0600 file and finalizes sampling off-thread', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-heap-mgr-'));
    try {
      const coord = new DebuggerCoordinator();
      const dbg: any = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() {
          return this.attached;
        },
        attach() {
          this.attached = true;
        },
        detach() {
          this.attached = false;
        },
        async sendCommand(method: string) {
          if (method === 'Runtime.getHeapUsage') {
            return { usedSize: 64_000, totalSize: 96_000 };
          }
          if (method === 'HeapProfiler.takeHeapSnapshot') {
            const fullJson = JSON.stringify(
              buildSyntheticV8Snapshot({ cartCount: 8, detachedDivCount: 2 }),
            );
            for (let i = 0; i < fullJson.length; i += 200) {
              (this as unknown as EventEmitter).emit('message', {}, 'HeapProfiler.addHeapSnapshotChunk', {
                chunk: fullJson.slice(i, i + 200),
              });
            }
            return {};
          }
          if (method === 'HeapProfiler.stopSampling') {
            return {
              profile: {
                head: {
                  id: 1,
                  callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
                  selfSize: 0,
                  children: [
                    {
                      id: 2,
                      callFrame: {
                        functionName: 'hydrateCatalog',
                        url: 'https://app.example.com/catalog.js?token=secret99',
                        lineNumber: 41,
                        columnNumber: 8,
                      },
                      selfSize: 16_384,
                      children: [
                        {
                          id: 3,
                          callFrame: {
                            functionName: 'buildProductRows',
                            url: 'https://app.example.com/catalog.js?token=secret99',
                            lineNumber: 89,
                            columnNumber: 4,
                          },
                          selfSize: 65_536,
                          children: [],
                        },
                      ],
                    },
                  ],
                },
                samples: [
                  { size: 16_384, nodeId: 2, ordinal: 1 },
                  { size: 65_536, nodeId: 3, ordinal: 2 },
                ],
              },
            };
          }
          return {};
        },
      });
      const fakeWc: any = Object.assign(new EventEmitter(), {
        id: 77,
        debugger: dbg,
        isDestroyed: () => false,
      });

      const mgr = new HeapProfilerManager(coord, () => tmpDir);
      const snap = await mgr.takeSnapshot({
        tabId: 'tab-1',
        viewport: 'portrait',
        wc: fakeWc,
      });
      expect(snap.ok).toBe(true);
      expect(fs.statSync(snap.snapshotPath).mode & 0o777).toBe(0o600);
      expect(snap.summary.detachedDomNodeCount).toBe(2);

      const started = await mgr.startSampling({
        tabId: 'tab-1',
        viewport: 'portrait',
        wc: fakeWc,
        samplingIntervalBytes: 8192,
      });
      expect(started.samplingIntervalBytes).toBe(8192);

      const stopped = await mgr.stopSampling({
        tabId: 'tab-1',
        viewport: 'portrait',
      });
      expect(fs.statSync(stopped.profilePath).mode & 0o777).toBe(0o600);
      expect(stopped.summary.topAllocatingStacks[0]?.functionName).toBe('buildProductRows');
      expect(stopped.summary.topAllocatingStacks[0]?.location).not.toContain('secret99');
      expect(stopped.summary.topAllocatingStacks[0]?.location).toContain(':90:5');
      expect(stopped.summary.topInclusiveStacks[0]?.functionName).toBe('hydrateCatalog');
      expect(stopped.summary.topInclusiveStacks[0]?.totalBytes).toBe(81_920);
      mgr.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('browser_network Initiator Call Stacks & browser_profile Inclusive Call Trees', () => {
  test('extractNetworkInitiator captures sync + async parent frames with 1-based line:col and redacts tokens', () => {
    const initiator = extractNetworkInitiator({
      type: 'script',
      stack: {
        callFrames: [
          {
            functionName: 'apiFetch',
            url: 'https://app.example.com/client.js?access_token=tok123',
            lineNumber: 19,
            columnNumber: 6,
          },
        ],
        parent: {
          description: 'await',
          callFrames: [
            {
              functionName: 'loadCart',
              url: 'https://app.example.com/pos.js',
              lineNumber: 104,
              columnNumber: 11,
            },
          ],
        },
      },
    });
    expect(initiator).toBeDefined();
    expect(initiator!.type).toBe('script');
    expect(initiator!.frames.length).toBe(2);
    expect(initiator!.frames[0]).toMatchObject({
      functionName: 'apiFetch',
      line: 20,
      column: 7,
    });
    expect(initiator!.frames[0]!.url).toBe('https://app.example.com/client.js');
    expect(initiator!.frames[0]!.url).not.toContain('tok123');
    expect(initiator!.frames[1]).toMatchObject({
      functionName: 'loadCart',
      line: 105,
      column: 12,
      async: true,
      asyncDescription: 'await',
    });
  });

  test('summarizeCpuProfile returns top inclusive callTree frames with caller parentChain', () => {
    const summary = summarizeCpuProfile({
      startTime: 0,
      endTime: 100_000,
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
        {
          id: 2,
          callFrame: { functionName: 'posCheckoutClick', url: 'https://app.test/pos.js', lineNumber: 49, columnNumber: 2 },
          children: [3],
        },
        {
          id: 3,
          callFrame: { functionName: 'recomputeDiscounts', url: 'https://app.test/cart.js', lineNumber: 119, columnNumber: 8 },
          children: [4],
        },
        {
          id: 4,
          callFrame: { functionName: 'innerPriceLoop', url: 'https://app.test/cart.js', lineNumber: 145, columnNumber: 14 },
          children: [],
        },
      ],
      samples: [4, 4, 4, 3],
      timeDeltas: [25_000, 25_000, 25_000, 25_000],
    });

    expect(summary.callTree.length).toBe(3);
    expect(summary.callTree[0]!.functionName).toBe('posCheckoutClick');
    expect(summary.callTree[0]!.inclusiveMs).toBe(100);
    expect(summary.callTree[0]!.selfMs).toBe(0);
    expect(summary.callTree[0]!.parentChain).toEqual([]);

    const leafTree = summary.callTree.find((n) => n.functionName === 'innerPriceLoop')!;
    expect(leafTree.inclusiveMs).toBe(75);
    expect(leafTree.selfMs).toBe(75);
    expect(leafTree.parentChain).toEqual([
      'recomputeDiscounts@https://app.test/cart.js:120:9',
      'posCheckoutClick@https://app.test/pos.js:50:3',
    ]);
  });

  test('resolveStateLogDir isolates custom userDataDir logs and TabEventBus loads private unlinked native inode', () => {
    const prevLogDir = process.env.IRON_BROWSER_LOG_DIR;
    const prevUserData = process.env.IRON_BROWSER_USER_DATA;
    delete process.env.IRON_BROWSER_LOG_DIR;
    delete process.env.IRON_BROWSER_USER_DATA;
    try {
      expect(
        resolveStateLogDir({ isSmoke: false, userDataDir: '/home/dev/.cache/iron-browser-ezc' }),
      ).toBe('/home/dev/.cache/iron-browser-ezc/logs');
      expect(
        resolveStateLogDir({ isSmoke: false, userDataDir: '/home/dev/.config/iron-browser-app' }),
      ).toContain(path.join('iron-browser'));
      expect(
        resolveStateLogDir({ isSmoke: false, userDataDir: '/home/dev/.config/iron-browser-app' }),
      ).not.toBe('/home/dev/.config/iron-browser-app/logs');
    } finally {
      if (prevLogDir !== undefined) process.env.IRON_BROWSER_LOG_DIR = prevLogDir;
      if (prevUserData !== undefined) process.env.IRON_BROWSER_USER_DATA = prevUserData;
    }

    const bus = new TabEventBus();
    expect(bus.backend).toBe('rust-napi');
    // Oversized >512KB sessionStorage item returns structured error instead of throwing from native N-API
    const quotaRes = bus.sessionStorageSet(
      'tab-1',
      'https://app.ez-commerce.huggian.com',
      'portrait',
      'huge_catalog_cache',
      'X'.repeat(600 * 1024),
    );
    expect(quotaRes.ok).toBe(false);
    expect(quotaRes.error).toContain('quota');
    bus.dispose();
  });

  test('F-30 & F-31: groups (string)/Window constructors, redacts JWT/Bearer/URL secrets, and preserves sampling across snapshot + did-navigate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-f30-f31-'));
    try {
      const snapWithSecrets = {
        snapshot: {
          meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
            node_types: [
              ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'],
              'string', 'number', 'number', 'number', 'number', 'number',
            ],
            edge_fields: ['type', 'name_or_index', 'to_node'],
            edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
          },
          node_count: 5,
          edge_count: 4,
        },
        nodes: [
          // 0: synthetic root
          9, 1, 1, 0, 1, 0, 0,
          // 1: Window / https://pos.example.com/pay?access_token=tok_live_999
          3, 2, 10, 256, 3, 0, 0,
          // 2: string literal with Bearer JWT
          2, 3, 20, 4096, 0, 0, 0,
          // 3: internal backing array '(object elements)'
          1, 4, 30, 8192, 0, 0, 0,
          // 4: PosCatalogStore object
          3, 5, 40, 2048, 0, 0, 0,
        ],
        edges: [
          4, 0, 1 * 7,
          2, 6, 2 * 7,
          4, 7, 3 * 7,
          2, 8, 4 * 7,
        ],
        strings: [
          '',
          '(GC roots)',
          'Window / https://pos.example.com/pay?access_token=tok_live_999',
          'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.secret_sig_999',
          '(object elements)',
          'PosCatalogStore',
          'authHeader',
          'elements',
          'catalogStore',
        ],
      };
      const snapPath = path.join(tmpDir, 'secrets.heapsnapshot');
      fs.writeFileSync(snapPath, JSON.stringify(snapWithSecrets), { mode: 0o600 });

      const summary = await analyzeHeapSnapshotOffThread(snapPath, { top: 20, topLargest: 5 });
      const rawJson = JSON.stringify(summary);
      expect(rawJson).not.toContain('tok_live_999');
      expect(rawJson).not.toContain('secret_sig_999');
      expect(rawJson).not.toContain('eyJhbGci');

      const stringBucket = summary.constructors.find((c) => c.name === '(string)');
      expect(stringBucket).toBeDefined();
      expect(stringBucket!.count).toBe(1);
      expect(stringBucket!.selfBytes).toBe(4096);

      const winBucket = summary.constructors.find((c) => c.name === 'Window');
      expect(winBucket).toBeDefined();
      expect(summary.largestObjects.some((o) => o.name === '(object elements)')).toBe(false);

      // Verify F-31: sampling_start -> takeSnapshot -> did-navigate -> sampling_stop succeeds without HeapProfiler.disable killing sampling!
      const coord = new DebuggerCoordinator();
      let samplingActiveInV8 = false;
      let segmentSeq = 0;
      const dbg = Object.assign(new EventEmitter(), {
        isAttached: () => true,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method: string) => {
          if (method === 'HeapProfiler.startSampling') {
            samplingActiveInV8 = true;
            return {};
          }
          if (method === 'HeapProfiler.disable') {
            samplingActiveInV8 = false;
            return {};
          }
          if (method === 'HeapProfiler.takeHeapSnapshot') {
            dbg.emit('message', {}, 'HeapProfiler.addHeapSnapshotChunk', {
              chunk: JSON.stringify(snapWithSecrets),
            });
            return {};
          }
          if (method === 'HeapProfiler.stopSampling') {
            if (!samplingActiveInV8) {
              throw new Error('Sampling heap profiler was not started');
            }
            samplingActiveInV8 = false;
            segmentSeq += 1;
            return {
              profile: {
                head: {
                  id: 1,
                  callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
                  selfSize: 0,
                  children: [
                    {
                      id: 2,
                      callFrame: {
                        functionName: `segAlloc${segmentSeq}`,
                        scriptId: '1',
                        url: 'https://pos.example.com/app.js',
                        lineNumber: 10,
                        columnNumber: 2,
                      },
                      selfSize: 16_384,
                      children: [],
                    },
                  ],
                },
                samples: [{ size: 16_384, nodeId: 2, ordinal: segmentSeq }],
              },
            };
          }
          return {};
        },
      });
      const fakeWc: any = Object.assign(new EventEmitter(), {
        id: 88,
        debugger: dbg,
        isDestroyed: () => false,
      });

      const mgr = new HeapProfilerManager(coord, () => tmpDir);
      await mgr.startSampling({ tabId: 'tab-1', viewport: 'portrait', wc: fakeWc });
      await mgr.takeSnapshot({ tabId: 'tab-1', viewport: 'portrait', wc: fakeWc });
      // Wait past setImmediate in scheduleDisableHeapProfilerIfIdle
      await new Promise((r) => setTimeout(r, 20));
      expect(samplingActiveInV8).toBe(true);

      // Simulate cross-document navigation harvesting segment #1 and re-arming segment #2
      fakeWc.emit('did-navigate');
      await new Promise((r) => setTimeout(r, 30));
      const stopped = await mgr.stopSampling({ tabId: 'tab-1', viewport: 'portrait' });
      expect(stopped.summary.totalAllocatedBytes).toBe(32_768);
      expect(stopped.summary.topAllocatingStacks.map((s) => s.functionName).sort()).toEqual([
        'segAlloc1',
        'segAlloc2',
      ]);
      mgr.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('AbnormalExitMonitor records process.abnormal_exit and latestCrashDump in main.log when parent dies by SIGKILL', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-exitmon-'));
    try {
      const logPath = path.join(tmpDir, 'main.log');
      const crashDir = path.join(tmpDir, 'Crashpad');
      fs.mkdirSync(path.join(crashDir, 'pending'), { recursive: true, mode: 0o700 });
      const fakeDump = path.join(crashDir, 'pending', 'test-crash-123.dmp');
      fs.writeFileSync(fakeDump, 'MDMP', { mode: 0o600 });

      const victimScript = `
        const { AbnormalExitMonitor } = require(${JSON.stringify(path.resolve(import.meta.dir, '../src/main/diagnostics.ts'))});
        const mon = new AbnormalExitMonitor({
          pid: process.pid,
          logPath: ${JSON.stringify(logPath)},
          crashDumpsDir: ${JSON.stringify(crashDir)},
        });
        mon.start();
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `;
      const victim = spawn(process.execPath, ['-e', victimScript], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('victim boot timeout')), 5000);
        victim.stdout!.on('data', (chunk) => {
          if (String(chunk).includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      victim.kill('SIGKILL');
      await new Promise<void>((resolve) => victim.once('exit', () => resolve()));

      // Poll up to 1.5s for the detached pipe-EOF watcher to flush main.log
      const deadline = Date.now() + 1500;
      let logContent = '';
      while (Date.now() < deadline) {
        if (fs.existsSync(logPath)) {
          logContent = fs.readFileSync(logPath, 'utf8').trim();
          if (logContent.length > 0) break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(logContent).toContain('"event":"process.abnormal_exit"');
      expect(logContent).toContain('"latestCrashDump":');
      expect(logContent).toContain('test-crash-123.dmp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
