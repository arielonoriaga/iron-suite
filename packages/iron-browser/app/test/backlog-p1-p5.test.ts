import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  groupDiagnosticIncidents,
  sanitizeIncidentUrl,
} from '../src/shared/incident-grouping';
import {
  buildGpuTelemetrySeparation,
  segmentFramesAroundMarks,
  summarizeFrameWindow,
} from '../src/shared/perf-trace';
import {
  composeFilmstripPng,
  cropRgba,
  decodePngToRgba,
  encodeRgbaToPng,
} from '../src/shared/png-filmstrip';
import {
  buildSceneStepScript,
  sanitizeRecipeName,
  validateClipRegionInput,
  validateReproRecipe,
  validateViewportSizeInput,
} from '../src/shared/repro-recipe';
import {
  deleteReproRecipeFile,
  listReproRecipesInDir,
  loadReproRecipeFile,
  saveReproRecipeFile,
} from '../src/main/repro-recipe-file';
import type { ConsoleEntry, NetworkEntry } from '../src/shared/types';
import {
  buildViewportSizingReport,
  readPngDimensions,
} from '../src/shared/viewport-report';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const BIN_LAUNCHER = path.join(REPO_ROOT, 'bin', 'iron-browser');

describe('Backlog Symlink Launcher Resolution (bin/iron-browser)', () => {
  test('resolves ROOT_DIR through an external symlink in another directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-symlink-unit-'));
    const symlinkBin = path.join(tmpDir, 'iron-browser');
    try {
      fs.symlinkSync(BIN_LAUNCHER, symlinkBin);

      const mcpBinCandidates = [
        path.join(REPO_ROOT, 'target', 'release', 'iron-browser-mcp'),
        path.join(REPO_ROOT, 'target', 'debug', 'iron-browser-mcp'),
        path.join(os.homedir(), '.cache', 'cargo-targets', 'main', 'release', 'iron-browser-mcp'),
      ];
      const existingMcpBin = mcpBinCandidates.find((p) => fs.existsSync(p));
      if (existingMcpBin) {
        const res = spawnSync(symlinkBin, ['mcp', '--version'], {
          cwd: tmpDir,
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toContain('iron-browser-mcp');
      } else {
        // Verify bash readlink -f resolution logic directly even before cargo build runs.
        const probe = spawnSync(
          'bash',
          [
            '-c',
            'SCRIPT_PATH="$(readlink -f "$1")"; ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"; echo "$ROOT_DIR"',
            '_',
            symlinkBin,
          ],
          { cwd: tmpDir, encoding: 'utf8' },
        );
        expect(probe.status).toBe(0);
        expect(probe.stdout.trim()).toBe(REPO_ROOT);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('P1 — Effective Viewport Reporting & PNG Pixel Inspection', () => {
  test('readPngDimensions reads exact IHDR dimensions and rejects non-PNG data', () => {
    const img = encodeRgbaToPng({
      width: 105,
      height: 66,
      data: new Uint8Array(105 * 66 * 4).fill(200),
    });
    expect(readPngDimensions(img)).toEqual({ width: 105, height: 66 });
    expect(readPngDimensions(Buffer.from('not-a-png'))).toBeNull();
  });

  test('buildViewportSizingReport flags CSS mismatch on narrow windows and passes exact match', () => {
    const mismatch = buildViewportSizingReport({
      role: 'landscape',
      requestedSize: { width: 1050, height: 660, dpr: 1 },
      effectiveCssSize: { width: 473, height: 916 },
      dpr: 1,
      capturedPixels: { width: 473, height: 916 },
    });
    expect(mismatch.sizeMismatch).toBe(true);
    expect(mismatch.mismatchReason).toContain('473x916');
    expect(mismatch.mismatchReason).toContain('1050x660');

    const exact = buildViewportSizingReport({
      role: 'landscape',
      requestedSize: { width: 1050, height: 660, dpr: 1 },
      effectiveCssSize: { width: 1050, height: 660 },
      dpr: 1,
      capturedPixels: { width: 1050, height: 660 },
      exactSizeApplied: true,
    });
    expect(exact.sizeMismatch).toBe(false);
    expect(exact.mismatchReason).toBeUndefined();
  });
});

describe('P2 — Saved Reproduction Recipes & Labelled Filmstrip PNG Compositor', () => {
  test('sanitizeRecipeName blocks path traversal and persists recipes atomically', () => {
    expect(() => sanitizeRecipeName('../escape')).toThrow();
    expect(() => sanitizeRecipeName('a/b')).toThrow();
    expect(() => sanitizeRecipeName('..')).toThrow();
    expect(sanitizeRecipeName('forest-to-sea_1.94x')).toBe('forest-to-sea_1.94x');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-recipes-test-'));
    try {
      const recipe = validateReproRecipe({
        name: 'forest-to-sea',
        url: 'http://127.0.0.1:4123/game',
        mode: 'dual',
        session: 'shared',
        seed: 'biome-77',
        phase: 'forest-to-sea',
        frame: 116,
        multiplier: 1.94,
        portraitSize: { width: 390, height: 844, dpr: 2 },
        landscapeSize: { width: 1050, height: 660, dpr: 1 },
        clipRegion: { x: 10, y: 20, width: 300, height: 200 },
      });

      saveReproRecipeFile(dir, recipe);
      const loaded = loadReproRecipeFile(dir, 'forest-to-sea');
      expect(loaded.seed).toBe('biome-77');
      expect(loaded.multiplier).toBe(1.94);
      expect(loaded.frame).toBe(116);
      expect(loaded.landscapeSize).toEqual({ width: 1050, height: 660, dpr: 1 });

      const listed = listReproRecipesInDir(dir);
      expect(listed.length).toBe(1);
      expect(deleteReproRecipeFile(dir, 'forest-to-sea')).toBe(true);
      expect(listReproRecipesInDir(dir).length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('buildSceneStepScript embeds deterministic frame/seed/multiplier state', () => {
    const script = buildSceneStepScript({
      seed: 'seed-99',
      phase: 'sea',
      frame: 120,
      multiplier: 1.94,
      fps: 60,
    });
    expect(script).toContain('__ironSceneDriver');
    expect(script).toContain('"multiplier":1.94');
    expect(script).toContain('"seed":"seed-99"');
  });

  test('composeFilmstripPng decodes, crops, stamps metadata headers, and stitches multi-step tiles', () => {
    const makeSolidPng = (w: number, h: number, r: number, g: number, b: number): Buffer => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i += 1) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
      }
      return encodeRgbaToPng({ width: w, height: h, data });
    };

    const pTile = makeSolidPng(120, 160, 30, 140, 90);
    const lTile = makeSolidPng(200, 120, 40, 90, 200);

    const decodedP = decodePngToRgba(pTile);
    expect(decodedP.width).toBe(120);
    expect(decodedP.height).toBe(160);
    const cropped = cropRgba(decodedP, { x: 10, y: 10, width: 80, height: 80 });
    expect(cropped.width).toBe(80);
    expect(cropped.height).toBe(80);

    const filmstrip = composeFilmstripPng([
      {
        tiles: [
          { labelLines: ['PORTRAIT 390X844 | F:60 | SEED:S1', 'MULT:1.94X | FOREST'], pngBuffer: pTile },
          { labelLines: ['LANDSCAPE 1050X660 | F:60 | SEED:S1', 'MULT:1.94X | FOREST'], pngBuffer: lTile },
        ],
      },
      {
        tiles: [
          { labelLines: ['PORTRAIT 390X844 | F:120 | SEED:S1', 'MULT:1.94X | SEA'], pngBuffer: pTile },
          { labelLines: ['LANDSCAPE 1050X660 | F:120 | SEED:S1', 'MULT:1.94X | SEA'], pngBuffer: lTile },
        ],
      },
    ]);

    expect(filmstrip.rows).toBe(2);
    expect(filmstrip.columns).toBe(2);
    const roundtrip = decodePngToRgba(filmstrip.pngBuffer);
    expect(roundtrip.width).toBe(filmstrip.width);
    expect(roundtrip.height).toBe(filmstrip.height);
    expect(roundtrip.width).toBeGreaterThan(320);
    expect(roundtrip.height).toBeGreaterThan(340);
  });
});

describe('P3 — Cross-Pane Diagnostic Incident Grouping', () => {
  test('groups matching 401 history failures across both viewports with linked console errors while keeping single-pane JS exceptions distinct', () => {
    expect(sanitizeIncidentUrl('https://game.example.com/api/room/history?token=secret#frag')).toEqual({
      origin: 'https://game.example.com',
      sanitizedPath: '/api/room/history',
    });

    const net: NetworkEntry[] = [
      {
        id: '10:r1',
        timestampMs: 1000,
        tabId: 'tab-1',
        viewport: 'portrait',
        method: 'GET',
        url: 'https://game.example.com/api/room/history?session=tok-p',
        status: 401,
        failed: true,
      },
      {
        id: '11:r1',
        timestampMs: 1045,
        tabId: 'tab-1',
        viewport: 'landscape',
        method: 'GET',
        url: 'https://game.example.com/api/room/history?session=tok-l',
        status: 401,
        failed: true,
      },
      {
        id: '10:r2',
        timestampMs: 1100,
        tabId: 'tab-1',
        viewport: 'portrait',
        method: 'GET',
        url: 'https://game.example.com/api/health',
        status: 200,
        failed: false,
      },
    ];

    const con: ConsoleEntry[] = [
      {
        id: 1,
        timestampMs: 1010,
        tabId: 'tab-1',
        viewport: 'portrait',
        level: 'error',
        text: 'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
        url: 'https://game.example.com/api/room/history?session=tok-p',
        source: 'log',
      },
      {
        id: 2,
        timestampMs: 1055,
        tabId: 'tab-1',
        viewport: 'landscape',
        level: 'error',
        text: 'Room history fetch failed: 401 /api/room/history',
        source: 'console-api',
      },
      {
        id: 3,
        timestampMs: 1200,
        tabId: 'tab-1',
        viewport: 'portrait',
        level: 'error',
        text: 'TypeError: Cannot read properties of null (reading "foldAngle")',
        url: 'https://game.example.com/assets/app.js',
        line: 88,
        source: 'exception',
      },
    ];

    const incidents = groupDiagnosticIncidents(net, con, { tabId: 'tab-1' });
    expect(incidents.length).toBe(2);

    const netInc = incidents.find((i) => i.kind === 'network-failure');
    expect(netInc).toBeDefined();
    expect(netInc?.method).toBe('GET');
    expect(netInc?.sanitizedPath).toBe('/api/room/history');
    expect(netInc?.status).toBe(401);
    expect(netInc?.affectedViewports).toEqual(['portrait', 'landscape']);
    expect(netInc?.requests.length).toBe(2);
    expect(netInc?.consoleEntries.length).toBe(2);
    expect(JSON.stringify(netInc)).not.toContain('tok-p');
    expect(JSON.stringify(netInc)).not.toContain('tok-l');

    const excInc = incidents.find((i) => i.kind === 'js-exception');
    expect(excInc).toBeDefined();
    expect(excInc?.affectedViewports).toEqual(['portrait']);
    expect(excInc?.requests.length).toBe(0);
    expect(excInc?.consoleEntries.length).toBe(1);
    expect(excInc?.consoleEntries[0]?.text).toContain('foldAngle');
  });
});

describe('P5 — Performance Trace Mark Segmentation & GPU Metric Separation', () => {
  test('segments frame samples into before/during/after around biome_crossing marks and labels GPU CPU separately from GPU execution time', () => {
    const frames: Array<{ tMs: number; dtMs: number }> = [];
    // 0..600ms (before): ~16ms smooth
    for (let t = 16; t < 600; t += 16) {
      frames.push({ tMs: t, dtMs: 16 });
    }
    // 600..1000ms (during biome_crossing): ~34ms janky
    for (let t = 634; t <= 1000; t += 34) {
      frames.push({ tMs: t, dtMs: 34 });
    }
    // 1000..2000ms (after): ~16.5ms smooth
    for (let t = 1016; t <= 2000; t += 16.5) {
      frames.push({ tMs: Math.round(t * 10) / 10, dtMs: 16.5 });
    }

    const overall = summarizeFrameWindow(frames, 2000);
    expect(overall.frameCount).toBe(frames.length);
    expect(overall.jankCount).toBeGreaterThan(5);

    const windows = segmentFramesAroundMarks(
      frames,
      [
        { entryType: 'mark', name: 'biome_crossing:start', startTimeMs: 600, durationMs: 0 },
        { entryType: 'mark', name: 'biome_crossing:end', startTimeMs: 1000, durationMs: 0 },
      ],
      [],
      2000,
    );

    expect(windows.length).toBe(1);
    const bc = windows[0]!;
    expect(bc.name).toBe('biome_crossing');
    expect(bc.before.frameCount).toBeGreaterThan(20);
    expect(bc.before.p95FrameMs).toBeLessThanOrEqual(17);
    expect(bc.during.frameCount).toBeGreaterThan(8);
    expect(bc.during.avgFrameMs).toBeGreaterThan(30);
    expect(bc.after.frameCount).toBeGreaterThan(40);
    expect(bc.after.p95FrameMs).toBeLessThanOrEqual(17);

    const gpu = buildGpuTelemetrySeparation(14.6, 180.2, null);
    expect(gpu.gpuProcessCpuPercent).toBe(14.6);
    expect(gpu.gpuExecutionTimeMs).toBeNull();
    expect(gpu.gpuProcessCpuLabel).toContain('NOT hardware GPU shader execution time');
    expect(gpu.gpuExecutionTimeLabel).toContain('never conflate');
  });
});

describe('Adversarial Review Regressions (F-01..F-07)', () => {
  test('F-03 & F-04: src/shared/repro-recipe.ts stays pure, blocks URL credentials/>4096 chars, validates dims/clip, and caps PNG dimensions', () => {
    const sharedSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'app', 'src', 'shared', 'repro-recipe.ts'),
      'utf8',
    );
    expect(sharedSrc).not.toContain('node:fs');
    expect(sharedSrc).not.toContain('node:path');

    expect(() =>
      validateReproRecipe({
        name: 'bad-creds',
        url: 'https://user:secret@example.com/game',
      }),
    ).toThrow(/credentials/i);
    expect(() =>
      validateReproRecipe({
        name: 'too-long',
        url: `https://example.com/${'a'.repeat(4100)}`,
      }),
    ).toThrow(/4096/);

    expect(() => validateViewportSizeInput([1000, 800], 'portraitSize')).toThrow();
    expect(() => validateViewportSizeInput({ width: 20000, height: 800 }, 'portraitSize')).toThrow();
    expect(() => validateClipRegionInput({ x: Number.NaN, y: 0, width: 100, height: 100 })).toThrow();
    expect(() =>
      validateClipRegionInput({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }),
    ).toThrow();

    // Oversized IHDR > 16.7M pixels must reject before inflating multi-GB buffers
    const fakeHeaderPng = encodeRgbaToPng({
      width: 4,
      height: 4,
      data: new Uint8Array(64).fill(255),
    });
    const mutated = Buffer.from(fakeHeaderPng);
    mutated.writeUInt32BE(5000, 16);
    mutated.writeUInt32BE(5000, 20);
    expect(() => decodePngToRgba(mutated)).toThrow(/oversized|dimensions/i);

    // maxTileWidth <= 0 clamps to >= 120 instead of bypassing downscaling
    const widePng = encodeRgbaToPng({
      width: 600,
      height: 200,
      data: new Uint8Array(600 * 200 * 4).fill(120),
    });
    const clampedStrip = composeFilmstripPng(
      [{ tiles: [{ labelLines: ['TEST'], pngBuffer: widePng }] }],
      { maxTileWidth: 0 },
    );
    expect(clampedStrip.width).toBeLessThan(200);
  });

  test('F-04 & F-05 & F-07: redacts URL tokens inside console text, accepts clipped exact_size without false mismatch, and handles unclosed/duplicate trace marks', () => {
    const incidents = groupDiagnosticIncidents(
      [
        {
          id: '1:r1',
          timestampMs: 500,
          tabId: 'tab-1',
          viewport: 'portrait',
          method: 'GET',
          url: 'https://api.example.com/room?token=super-secret-123',
          status: 401,
          failed: true,
        },
      ],
      [
        {
          id: 1,
          timestampMs: 505,
          tabId: 'tab-1',
          viewport: 'portrait',
          level: 'error',
          text: 'Access to fetch at https://user:pw@api.example.com/room?token=super-secret-123#frag failed with 401',
          source: 'log',
        },
      ],
      { tabId: 'tab-1' },
    );
    const serialized = JSON.stringify(incidents);
    expect(serialized).not.toContain('super-secret-123');
    expect(serialized).not.toContain('user:pw');
    expect(serialized).not.toContain('#frag');
    expect(serialized).toContain('https://api.example.com/room');

    // F-05: exact_size + clip validates against expectedCapturePixels (300x200), not full requestedSize (1050x660)
    const clippedReport = buildViewportSizingReport({
      role: 'landscape',
      requestedSize: { width: 1050, height: 660, dpr: 1 },
      effectiveCssSize: { width: 1050, height: 660 },
      dpr: 1,
      capturedPixels: { width: 300, height: 200 },
      expectedCapturePixels: { width: 300, height: 200 },
      exactSizeApplied: true,
    });
    expect(clippedReport.sizeMismatch).toBe(false);

    // F-07: deduplicates measure + start/end marks and preserves unclosed :start marks
    const frames = [
      { tMs: 50, dtMs: 16 },
      { tMs: 150, dtMs: 24 },
      { tMs: 350, dtMs: 16 },
    ];
    const deduped = segmentFramesAroundMarks(
      frames,
      [
        { entryType: 'mark', name: 'fold:start', startTimeMs: 100, durationMs: 0 },
        { entryType: 'mark', name: 'fold:end', startTimeMs: 200, durationMs: 0 },
        { entryType: 'mark', name: 'launch:start', startTimeMs: 300, durationMs: 0 },
      ],
      [{ entryType: 'measure', name: 'fold_span', startTimeMs: 100, durationMs: 100 }],
      400,
    );
    expect(deduped.length).toBe(2);
    expect(deduped.some((w) => w.name.startsWith('fold'))).toBe(true);
    expect(deduped.some((w) => w.name === 'launch' && w.markEndMs === 400)).toBe(true);
  });
});

