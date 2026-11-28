import type { SessionMode, ViewMode, ViewportDimensions } from './types';
import { normalizeUrl } from './url';

export interface CanvasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReproRecipe {
  version: 1;
  name: string;
  url: string;
  mode: ViewMode;
  session: SessionMode;
  seed?: string | number;
  phase?: string;
  frame?: number;
  multiplier?: number;
  timeMs?: number;
  fps?: number;
  portraitPresetId?: string;
  landscapePresetId?: string;
  portraitSize?: ViewportDimensions;
  landscapeSize?: ViewportDimensions;
  canvasSelector?: string;
  clipRegion?: CanvasRegion;
  savedAt: number;
}

export interface SceneStepSpec {
  seed?: string | number;
  phase?: string;
  frame?: number;
  deltaFrames?: number;
  multiplier?: number;
  timeMs?: number;
  fps?: number;
  canvasSelector?: string;
}

export interface SceneStepViewportOutcome {
  appliedViaDriver: boolean;
  driverName: string | null;
  frame: number | null;
  seed: string | number | null;
  phase: string | null;
  multiplier: number | null;
  timeMs: number | null;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  canvasBounds: CanvasRegion | null;
}

export const MAX_RECIPE_FILE_BYTES = 64 * 1024;
export const MAX_RECIPES = 100;
export const MAX_RECIPE_URL_LENGTH = 4096;

export function sanitizeRecipeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Recipe name must be a non-empty string');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) {
    throw new Error('Recipe name must be 1..64 characters');
  }
  if (trimmed === '.' || trimmed === '..' || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error('Recipe name may only contain [a-zA-Z0-9._-]');
  }
  return trimmed;
}

export function validateViewportSizeInput(
  raw: unknown,
  label: string,
  defaultDpr = 1,
): ViewportDimensions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const width = Number(rec.width);
  const height = Number(rec.height);
  const dpr = rec.dpr !== undefined ? Number(rec.dpr) : defaultDpr;
  if (
    !Number.isInteger(width) ||
    width < 200 ||
    width > 3840 ||
    !Number.isInteger(height) ||
    height < 200 ||
    height > 3840 ||
    !Number.isFinite(dpr) ||
    dpr < 1 ||
    dpr > 4
  ) {
    throw new Error(`Invalid ${label}: expected integer width/height in [200..3840] and dpr in [1..4]`);
  }
  return { width, height, dpr };
}

export function validateClipRegionInput(raw: unknown, label = 'clipRegion'): CanvasRegion | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const x = Number(rec.x);
  const y = Number(rec.y);
  const width = Number(rec.width);
  const height = Number(rec.height);
  if (
    !Number.isFinite(x) ||
    x < 0 ||
    x > 10_000 ||
    !Number.isFinite(y) ||
    y < 0 ||
    y > 10_000 ||
    !Number.isFinite(width) ||
    width < 1 ||
    width > 3840 ||
    !Number.isFinite(height) ||
    height < 1 ||
    height > 3840
  ) {
    throw new Error(`Invalid ${label}: expected finite x,y in [0..10000] and width,height in [1..3840]`);
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function validateSafeRecipeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Recipe url is required');
  }
  if (trimmed.length > MAX_RECIPE_URL_LENGTH) {
    throw new Error(`Recipe url exceeds ${MAX_RECIPE_URL_LENGTH} characters`);
  }
  const url = normalizeUrl(trimmed);
  if (url.length > MAX_RECIPE_URL_LENGTH) {
    throw new Error(`Normalized recipe url exceeds ${MAX_RECIPE_URL_LENGTH} characters`);
  }
  if (url !== 'about:blank') {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new Error('Recipe url must not contain embedded credentials');
    }
  }
  return url;
}

export function validateReproRecipe(raw: unknown, nowMs = Date.now()): ReproRecipe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Recipe must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const name = sanitizeRecipeName(rec.name);
  const rawUrl = typeof rec.url === 'string' ? rec.url : '';
  const url = validateSafeRecipeUrl(rawUrl);

  const mode: ViewMode = rec.mode === 'single' ? 'single' : 'dual';
  const session: SessionMode = rec.session === 'isolated' ? 'isolated' : 'shared';

  let seed: string | number | undefined;
  if (typeof rec.seed === 'string') {
    if (rec.seed.length > 256) throw new Error('seed string exceeds 256 chars');
    seed = rec.seed;
  } else if (typeof rec.seed === 'number' && Number.isFinite(rec.seed)) {
    seed = rec.seed;
  }

  let phase: string | undefined;
  if (typeof rec.phase === 'string' && rec.phase.trim().length > 0) {
    if (rec.phase.length > 128) throw new Error('phase exceeds 128 chars');
    phase = rec.phase.trim();
  }

  const frame =
    typeof rec.frame === 'number' && Number.isFinite(rec.frame) && rec.frame >= 0
      ? Math.round(rec.frame)
      : undefined;
  const multiplier =
    typeof rec.multiplier === 'number' && Number.isFinite(rec.multiplier)
      ? rec.multiplier
      : undefined;
  const timeMs =
    typeof rec.timeMs === 'number' && Number.isFinite(rec.timeMs) && rec.timeMs >= 0
      ? rec.timeMs
      : undefined;
  const fps =
    typeof rec.fps === 'number' && Number.isFinite(rec.fps) && rec.fps >= 1 && rec.fps <= 240
      ? rec.fps
      : undefined;

  const portraitPresetId =
    typeof rec.portraitPresetId === 'string' && rec.portraitPresetId.trim().length > 0
      ? rec.portraitPresetId.trim().slice(0, 64)
      : typeof rec.portrait_preset === 'string' && rec.portrait_preset.trim().length > 0
        ? rec.portrait_preset.trim().slice(0, 64)
        : undefined;

  const landscapePresetId =
    typeof rec.landscapePresetId === 'string' && rec.landscapePresetId.trim().length > 0
      ? rec.landscapePresetId.trim().slice(0, 64)
      : typeof rec.landscape_preset === 'string' && rec.landscape_preset.trim().length > 0
        ? rec.landscape_preset.trim().slice(0, 64)
        : undefined;

  const portraitSize = validateViewportSizeInput(
    rec.portraitSize ?? rec.portrait_size,
    'portraitSize',
  );
  const landscapeSize = validateViewportSizeInput(
    rec.landscapeSize ?? rec.landscape_size,
    'landscapeSize',
  );

  const rawCanvasSelector = rec.canvasSelector ?? rec.canvas_selector;
  const canvasSelector =
    typeof rawCanvasSelector === 'string' && rawCanvasSelector.trim().length > 0
      ? rawCanvasSelector.trim().slice(0, 256)
      : undefined;

  const clipRegion = validateClipRegionInput(rec.clipRegion ?? rec.clip_region, 'clipRegion');
  const savedAt =
    typeof rec.savedAt === 'number' && Number.isFinite(rec.savedAt) ? rec.savedAt : nowMs;

  return {
    version: 1,
    name,
    url,
    mode,
    session,
    ...(seed !== undefined ? { seed } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(frame !== undefined ? { frame } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(timeMs !== undefined ? { timeMs } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(portraitPresetId ? { portraitPresetId } : {}),
    ...(landscapePresetId ? { landscapePresetId } : {}),
    ...(portraitSize ? { portraitSize } : {}),
    ...(landscapeSize ? { landscapeSize } : {}),
    ...(canvasSelector ? { canvasSelector } : {}),
    ...(clipRegion ? { clipRegion } : {}),
    savedAt,
  };
}

/**
 * Builds the deterministic renderer-side script that steps an optional dev-only scene driver
 * (`window.__ironSceneDriver` or `window.__sceneDriver` or `'iron:scene-step'` CustomEvent)
 * to the exact target frame/seed/phase/multiplier and returns observed scene + canvas bounds.
 */
export function buildSceneStepScript(spec: SceneStepSpec): string {
  const payloadJson = JSON.stringify(spec);
  return `(async () => {
    const spec = ${payloadJson};
    const w = window;
    const prev = (w.__ironReproState && typeof w.__ironReproState === 'object') ? w.__ironReproState : {};
    const fps = typeof spec.fps === 'number' && spec.fps > 0 ? spec.fps : (typeof prev.fps === 'number' ? prev.fps : 60);
    const baseFrame = typeof spec.frame === 'number'
      ? Math.round(spec.frame)
      : (typeof prev.frame === 'number' ? prev.frame : 0) + (typeof spec.deltaFrames === 'number' ? Math.round(spec.deltaFrames) : 0);
    const targetTimeMs = typeof spec.timeMs === 'number'
      ? spec.timeMs
      : Math.round((baseFrame / fps) * 1000 * 100) / 100;
    const nextState = {
      seed: spec.seed !== undefined ? spec.seed : (prev.seed ?? null),
      phase:
        spec.phase !== undefined
          ? spec.phase
          : spec.frame !== undefined || spec.deltaFrames !== undefined
            ? null
            : (prev.phase ?? null),
      frame: baseFrame,
      multiplier: spec.multiplier !== undefined ? spec.multiplier : (prev.multiplier ?? null),
      timeMs: targetTimeMs,
      fps,
    };
    w.__ironReproState = nextState;

    const drv = w.__ironSceneDriver || w.__sceneDriver || null;
    let driverName = drv ? (w.__ironSceneDriver ? '__ironSceneDriver' : '__sceneDriver') : null;
    let appliedViaDriver = false;

    if (drv && typeof drv === 'object') {
      if (typeof drv.setState === 'function') {
        await drv.setState(nextState);
        appliedViaDriver = true;
      } else if (typeof drv.seek === 'function') {
        await drv.seek(nextState);
        appliedViaDriver = true;
      } else if (typeof drv.apply === 'function') {
        await drv.apply(nextState);
        appliedViaDriver = true;
      }
      if (typeof spec.deltaFrames === 'number' && spec.frame === undefined && typeof drv.step === 'function') {
        await drv.step(spec.deltaFrames, (spec.deltaFrames / fps) * 1000);
        appliedViaDriver = true;
      } else if (!appliedViaDriver && typeof drv.step === 'function') {
        await drv.step(0, 0, nextState);
        appliedViaDriver = true;
      }
    }

    try {
      w.dispatchEvent(new CustomEvent('iron:scene-step', { detail: nextState }));
    } catch {}

    // Allow a microtask / bounded paint settle without hanging hidden windows where rAF is paused.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(null); } };
      const t = setTimeout(finish, 24);
      if (document.visibilityState === 'visible' && typeof w.requestAnimationFrame === 'function') {
        w.requestAnimationFrame(() => { clearTimeout(t); finish(); });
      }
    });

    const reported = (drv && typeof drv.getState === 'function') ? (await drv.getState()) : null;
    const merged = (reported && typeof reported === 'object') ? { ...nextState, ...reported } : nextState;

    const sel = typeof spec.canvasSelector === 'string' && spec.canvasSelector.trim() ? spec.canvasSelector.trim() : 'canvas';
    let canvasBounds = null;
    try {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          canvasBounds = {
            x: Math.max(0, Math.round(r.left)),
            y: Math.max(0, Math.round(r.top)),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }
      }
    } catch {}

    return JSON.stringify({
      appliedViaDriver,
      driverName,
      frame: typeof merged.frame === 'number' ? merged.frame : nextState.frame,
      seed: merged.seed ?? null,
      phase: merged.phase ?? null,
      multiplier: typeof merged.multiplier === 'number' ? merged.multiplier : null,
      timeMs: typeof merged.timeMs === 'number' ? merged.timeMs : nextState.timeMs,
      viewportWidth: w.innerWidth,
      viewportHeight: w.innerHeight,
      dpr: w.devicePixelRatio || 1,
      canvasBounds,
    });
  })()`;
}
