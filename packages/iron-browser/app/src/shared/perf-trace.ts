export interface TraceFrameSample {
  tMs: number;
  dtMs: number;
}

export interface TraceMarkEvent {
  entryType: 'mark' | 'measure';
  name: string;
  startTimeMs: number;
  durationMs: number;
}

export interface FrameWindowSummary {
  frameCount: number;
  windowDurationMs: number;
  fps: number;
  avgFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  jankCount: number;
  frameDurationsMs: number[];
}

export interface MarkPhaseBreakdown {
  name: string;
  markStartMs: number;
  markEndMs: number;
  before: FrameWindowSummary;
  during: FrameWindowSummary;
  after: FrameWindowSummary;
}

export interface ViewportTraceReport {
  visibilityState: string;
  summary: FrameWindowSummary;
  marks: TraceMarkEvent[];
  measures: TraceMarkEvent[];
  markWindows: MarkPhaseBreakdown[];
  frames: TraceFrameSample[];
}

export interface GpuTelemetrySeparation {
  gpuProcessCpuPercent: number;
  gpuMemoryMb: number;
  gpuExecutionTimeMs: number | null;
  gpuProcessCpuLabel: string;
  gpuExecutionTimeLabel: string;
}

export const MAX_TRACE_FRAMES = 1800;
export const MAX_TRACE_MARKS = 256;
export const MAX_TRACE_DURATION_MS = 30_000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarizeFrameWindow(
  frames: readonly TraceFrameSample[],
  windowDurationMs = 0,
): FrameWindowSummary {
  const valid = frames
    .map((f) => f.dtMs)
    .filter((dt) => Number.isFinite(dt) && dt > 0 && dt < 5000);

  if (valid.length === 0) {
    return {
      frameCount: 0,
      windowDurationMs: round1(Math.max(0, windowDurationMs)),
      fps: 0,
      avgFrameMs: 0,
      p50FrameMs: 0,
      p95FrameMs: 0,
      maxFrameMs: 0,
      jankCount: 0,
      frameDurationsMs: [],
    };
  }

  const sum = valid.reduce((a, b) => a + b, 0);
  const avg = sum / valid.length;
  const sorted = [...valid].sort((a, b) => a - b);
  const p50 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const jankCount = valid.filter((dt) => dt > 20).length;
  const fps = Math.min(240, round1(1000 / Math.max(avg, 1)));

  return {
    frameCount: valid.length,
    windowDurationMs: round1(windowDurationMs > 0 ? windowDurationMs : sum),
    fps,
    avgFrameMs: round1(avg),
    p50FrameMs: round1(p50),
    p95FrameMs: round1(p95),
    maxFrameMs: round1(max),
    jankCount,
    frameDurationsMs: valid.slice(-120).map(round1),
  };
}

/**
 * Segments recorded frame samples into `before`, `during`, and `after` windows
 * around application `performance.mark` / `performance.measure` events.
 * Supports:
 * 1. Explicit `performance.measure(name, ...)` spans (`[startTimeMs, startTimeMs + durationMs]`).
 * 2. Paired `<name>:start` / `<name>_start` and `<name>:end` / `<name>_end` marks.
 * 3. Instantaneous marks (e.g. `biome_crossing`, `fold`, `launch`) using a `[-80ms, +220ms]` handoff window.
 */
export function segmentFramesAroundMarks(
  frames: readonly TraceFrameSample[],
  marks: readonly TraceMarkEvent[],
  measures: readonly TraceMarkEvent[],
  totalDurationMs: number,
): MarkPhaseBreakdown[] {
  interface Span {
    name: string;
    startMs: number;
    endMs: number;
  }

  const spans: Span[] = [];
  const seenSpanKeys = new Set<string>();
  const consumedMarkNames = new Set<string>();

  const addSpan = (name: string, startMs: number, endMs: number) => {
    const normBase = name.replace(/([:_-])(span|measure)$/i, '');
    const key = `${normBase.toLowerCase()}:${Math.round(startMs)}:${Math.round(endMs)}`;
    if (seenSpanKeys.has(key)) return;
    seenSpanKeys.add(key);
    spans.push({ name, startMs, endMs });
  };

  const startMarks = new Map<string, TraceMarkEvent>();
  for (const mk of marks) {
    const startMatch = /^(.*?)([:_-])(start|begin)$/i.exec(mk.name);
    if (startMatch && startMatch[1]) {
      startMarks.set(startMatch[1], mk);
      consumedMarkNames.add(mk.name);
      continue;
    }
    const endMatch = /^(.*?)([:_-])(end|finish|done)$/i.exec(mk.name);
    if (endMatch && endMatch[1]) {
      const base = endMatch[1];
      const pairedStart = startMarks.get(base);
      if (pairedStart) {
        consumedMarkNames.add(mk.name);
        startMarks.delete(base);
        const s = Math.min(pairedStart.startTimeMs, mk.startTimeMs);
        const e = Math.max(pairedStart.startTimeMs + 16, mk.startTimeMs);
        addSpan(base, Math.max(0, s), e);
      }
    }
  }

  for (const m of measures) {
    const startMs = Math.max(0, m.startTimeMs);
    const endMs = Math.max(startMs + 16, startMs + Math.max(m.durationMs, 16));
    addSpan(m.name, startMs, endMs);
    consumedMarkNames.add(m.name);
  }

  // Emit [startMs, totalDurationMs] for any unclosed `<name>:start` mark.
  for (const [base, openStart] of startMarks.entries()) {
    const s = Math.max(0, openStart.startTimeMs);
    const e = Math.max(s + 16, totalDurationMs);
    addSpan(base, s, e);
  }

  for (const mk of marks) {
    if (consumedMarkNames.has(mk.name)) continue;
    const center = Math.max(0, mk.startTimeMs);
    const s = Math.max(0, center - 80);
    const e = Math.min(Math.max(totalDurationMs, center + 220), center + 220);
    addSpan(mk.name, s, Math.max(s + 32, e));
  }

  spans.sort((a, b) => a.startMs - b.startMs);

  return spans.slice(0, 32).map((span) => {
    const beforeFrames = frames.filter((f) => f.tMs < span.startMs);
    const duringFrames = frames.filter((f) => f.tMs >= span.startMs && f.tMs <= span.endMs);
    const afterFrames = frames.filter((f) => f.tMs > span.endMs);

    return {
      name: span.name,
      markStartMs: round1(span.startMs),
      markEndMs: round1(span.endMs),
      before: summarizeFrameWindow(beforeFrames, span.startMs),
      during: summarizeFrameWindow(duringFrames, Math.max(0, span.endMs - span.startMs)),
      after: summarizeFrameWindow(afterFrames, Math.max(0, totalDurationMs - span.endMs)),
    };
  });
}

export function buildGpuTelemetrySeparation(
  gpuProcessCpuPercent: number,
  gpuMemoryMb: number,
  gpuExecutionTimeMs: number | null = null,
): GpuTelemetrySeparation {
  return {
    gpuProcessCpuPercent: round1(Math.max(0, gpuProcessCpuPercent)),
    gpuMemoryMb: round1(Math.max(0, gpuMemoryMb)),
    gpuExecutionTimeMs:
      gpuExecutionTimeMs !== null && Number.isFinite(gpuExecutionTimeMs)
        ? round1(Math.max(0, gpuExecutionTimeMs))
        : null,
    gpuProcessCpuLabel:
      'Chromium GPU-process host OS CPU % (from Electron app.getAppMetrics() GPU process; NOT hardware GPU shader execution time)',
    gpuExecutionTimeLabel:
      gpuExecutionTimeMs !== null
        ? 'Hardware GPU frame execution time (ms)'
        : 'Unavailable from OS process metrics (requires WebGPU timestamp-query / driver counter; kept null so reports never conflate GPU-process CPU % with GPU execution time)',
  };
}
