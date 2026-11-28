import type { ElementFingerprint, Rect, ViewportRole } from './types';

export interface SelectorCandidate {
  strategy:
    | 'data-testid'
    | 'id'
    | 'aria-label'
    | 'title'
    | 'name'
    | 'role-text'
    | 'class-tokens'
    | 'css-path';
  priority: number;
  selector?: string;
  role?: string;
  text?: string;
  tag?: string;
}

export function extractStableClassTokens(classList: Iterable<string>, maxTokens = 4): string[] {
  const out: string[] = [];
  for (const raw of classList) {
    const token = raw.trim();
    if (!token || token.length < 2 || token.length > 48) continue;
    // Skip state/animation/hash-like utility classes that diverge between viewports.
    if (/^(is-|has-|active|hover|focus|selected|open|closed|portrait|landscape|mobile|desktop|sm:|md:|lg:|xl:)/i.test(token)) {
      continue;
    }
    if (/[[\]/:]/.test(token)) continue;
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

export function escapeCssAttrValue(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
}

/**
 * CSSOM CSS.escape()-compatible identifier escaping (handles leading digits,
 * `-` followed by a digit, lone `-`, control chars, and punctuation).
 */
export function escapeCssIdentifier(raw: string): string {
  if (raw.length === 0) return '';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = raw[i]!;
    if (code === 0x00) {
      out += '\uFFFD';
    } else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && raw.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && raw.length === 1 && code === 0x2d) {
      out += '\\-';
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      out += ch;
    } else {
      out += `\\${ch}`;
    }
  }
  return out;
}

export function normalizeText(raw: string | null | undefined, maxLen = 96): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Priority-ordered deterministic DOM candidates for Tier 2 semantic mirroring:
 * 1. [data-testid="..."]
 * 2. #id
 * 3. [aria-label="..."]
 * 4. [name="..."]
 * 5. Accessible role + trimmed text content
 * 6. Structural CSS path fallback
 */
export function buildSelectorCandidates(fp: ElementFingerprint): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];

  if (fp.testId && fp.testId.trim().length > 0) {
    out.push({
      strategy: 'data-testid',
      priority: 1,
      selector: `[data-testid="${escapeCssAttrValue(fp.testId.trim())}"]`,
    });
  }

  if (fp.id && fp.id.trim().length > 0) {
    out.push({
      strategy: 'id',
      priority: 2,
      selector: `#${escapeCssIdentifier(fp.id.trim())}`,
    });
  }

  if (fp.ariaLabel && fp.ariaLabel.trim().length > 0) {
    out.push({
      strategy: 'aria-label',
      priority: 3,
      selector: `[aria-label="${escapeCssAttrValue(fp.ariaLabel.trim())}"]`,
    });
  }

  if (fp.title && fp.title.trim().length > 0) {
    out.push({
      strategy: 'title',
      priority: 4,
      selector: `[title="${escapeCssAttrValue(fp.title.trim())}"]`,
    });
  }

  if (fp.name && fp.name.trim().length > 0) {
    const tagPrefix = fp.tag ? fp.tag.toLowerCase() : '';
    out.push({
      strategy: 'name',
      priority: 5,
      selector: `${tagPrefix}[name="${escapeCssAttrValue(fp.name.trim())}"]`,
    });
  }

  const trimmedText = normalizeText(fp.text);
  if (trimmedText.length > 0) {
    out.push({
      strategy: 'role-text',
      priority: 6,
      role: fp.role?.trim().toLowerCase() || undefined,
      text: trimmedText,
      tag: fp.tag?.toLowerCase() || undefined,
    });
  }

  if (fp.classTokens && fp.classTokens.length > 0) {
    const tagPrefix = fp.tag ? escapeCssIdentifier(fp.tag.toLowerCase()) : '';
    const classes = fp.classTokens.map((c) => `.${escapeCssIdentifier(c)}`).join('');
    out.push({
      strategy: 'class-tokens',
      priority: 7,
      selector: `${tagPrefix}${classes}`,
    });
  }

  if (fp.cssPath && fp.cssPath.trim().length > 0) {
    out.push({
      strategy: 'css-path',
      priority: 8,
      selector: fp.cssPath.trim(),
    });
  }

  return out;
}

/**
 * Tier 3 normalized coordinate mapping for <canvas>, WebGL, or unmatched targets.
 * Maps normalized (nx, ny) in [0, 1] into target viewport rect coordinates.
 */
export function mapNormalizedPoint(
  normX: number,
  normY: number,
  targetRect: Rect,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(normX) ||
    !Number.isFinite(normY) ||
    targetRect.width <= 0 ||
    targetRect.height <= 0
  ) {
    return null;
  }
  const cx = Math.min(Math.max(normX, 0), 1);
  const cy = Math.min(Math.max(normY, 0), 1);
  return {
    x: Math.round(targetRect.x + cx * targetRect.width),
    y: Math.round(targetRect.y + cy * targetRect.height),
  };
}

/**
 * Tier 1 proportional scroll mapping: maps source scroll ratio cleanly onto target maxScroll.
 */
export function computeProportionalScroll(
  sourceScroll: number,
  sourceMaxScroll: number,
  targetMaxScroll: number,
): number {
  if (
    !Number.isFinite(sourceScroll) ||
    !Number.isFinite(sourceMaxScroll) ||
    !Number.isFinite(targetMaxScroll) ||
    targetMaxScroll <= 0
  ) {
    return 0;
  }
  if (sourceMaxScroll <= 0) {
    return 0;
  }
  const ratio = Math.min(Math.max(sourceScroll / sourceMaxScroll, 0), 1);
  return Math.round(ratio * targetMaxScroll);
}

/**
 * Anti-echo loop guard: tracks active replay windows per target viewport so synthetic
 * events replayed into viewport B never bounce back to viewport A.
 */
export class EchoLoopGuard {
  private readonly activeUntil = new Map<ViewportRole, number>();
  private readonly inFlightCounts = new Map<ViewportRole, number>();

  constructor(
    private readonly windowMs = 110,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  beginReplaying(targetViewport: ViewportRole): void {
    this.inFlightCounts.set(targetViewport, (this.inFlightCounts.get(targetViewport) ?? 0) + 1);
  }

  endReplaying(targetViewport: ViewportRole, nowMs = this.clock()): void {
    const cur = this.inFlightCounts.get(targetViewport) ?? 0;
    if (cur <= 1) {
      this.inFlightCounts.delete(targetViewport);
    } else {
      this.inFlightCounts.set(targetViewport, cur - 1);
    }
    this.markReplaying(targetViewport, nowMs);
  }

  markReplaying(targetViewport: ViewportRole, nowMs = this.clock()): void {
    const until = nowMs + this.windowMs;
    const prev = this.activeUntil.get(targetViewport) ?? 0;
    this.activeUntil.set(targetViewport, Math.max(prev, until));
  }

  isEcho(sourceViewport: ViewportRole, nowMs = this.clock()): boolean {
    if ((this.inFlightCounts.get(sourceViewport) ?? 0) > 0) {
      return true;
    }
    const until = this.activeUntil.get(sourceViewport);
    if (until === undefined) return false;
    if (nowMs <= until) {
      return true;
    }
    this.activeUntil.delete(sourceViewport);
    return false;
  }

  clear(viewport?: ViewportRole): void {
    if (viewport) {
      this.activeUntil.delete(viewport);
      this.inFlightCounts.delete(viewport);
    } else {
      this.activeUntil.clear();
      this.inFlightCounts.clear();
    }
  }
}

export function pairedViewport(role: ViewportRole): ViewportRole {
  return role === 'portrait' ? 'landscape' : 'portrait';
}

export function computeFrameStats(frameDurationsMs: readonly number[]): {
  fps: number;
  p95FrameMs: number;
  jankCount: number;
} {
  if (frameDurationsMs.length === 0) {
    return { fps: 0, p95FrameMs: 0, jankCount: 0 };
  }
  const valid = frameDurationsMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (valid.length === 0) {
    return { fps: 0, p95FrameMs: 0, jankCount: 0 };
  }
  const sum = valid.reduce((acc, v) => acc + v, 0);
  const avgMs = sum / valid.length;
  const fps = Math.min(240, Math.round((1000 / Math.max(avgMs, 1)) * 10) / 10);

  const sorted = [...valid].sort((a, b) => a - b);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95FrameMs = Math.round((sorted[p95Idx] ?? 0) * 10) / 10;
  const jankCount = valid.filter((ms) => ms > 20).length;

  return { fps, p95FrameMs, jankCount };
}

export const DOM_PIERCE_LIMITS = {
  maxDepth: 8,
  maxRoots: 32,
  maxNodes: 2000,
} as const;

export const PIERCE_LIMITS = DOM_PIERCE_LIMITS;

export function isOpaqueOrigin(origin: string | null | undefined): boolean {
  return !origin || origin.trim().toLowerCase() === 'null';
}

export function parseHttpOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (isOpaqueOrigin(parsed.origin)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function areSameHttpOrigin(
  sourceUrlOrOrigin: string | null | undefined,
  pairedUrlOrOrigin: string | null | undefined,
): boolean {
  const a = parseHttpOrigin(sourceUrlOrOrigin);
  const b = parseHttpOrigin(pairedUrlOrOrigin);
  return a !== null && b !== null && a === b;
}

export function accumulateIframeOffset(
  rects: ReadonlyArray<{ left: number; top: number }>,
): { offsetX: number; offsetY: number } {
  let offsetX = 0;
  let offsetY = 0;
  for (const r of rects) {
    if (Number.isFinite(r.left)) offsetX += r.left;
    if (Number.isFinite(r.top)) offsetY += r.top;
  }
  return { offsetX, offsetY };
}

export const TOGGLE_STATE_ATTRIBUTES = [
  'aria-pressed',
  'aria-checked',
  'aria-selected',
  'data-state',
] as const;

export type ToggleStateMap = Record<string, string | null>;

export function extractToggleState(
  attrs: Record<string, string | null | undefined>,
  checked?: boolean | null,
): ToggleStateMap | undefined {
  const out: ToggleStateMap = {};
  let hasAny = false;
  for (const key of TOGGLE_STATE_ATTRIBUTES) {
    const raw = attrs[key];
    if (typeof raw === 'string') {
      out[key] = raw.trim().toLowerCase();
      hasAny = true;
    }
  }
  if (typeof checked === 'boolean') {
    out.checked = checked ? 'true' : 'false';
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function collectDefinedToggleEntries(
  state: ToggleStateMap | null | undefined,
): Array<[string, string]> {
  if (!state) return [];
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'string') {
      entries.push([k, v.trim().toLowerCase()]);
    }
  }
  return entries;
}

export function compareToggleStates(
  sourceState: ToggleStateMap | null | undefined,
  pairedState: ToggleStateMap | null | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (!sourceState || !pairedState) return 'unknown';
  const srcEntries = collectDefinedToggleEntries(sourceState);
  const dstEntries = collectDefinedToggleEntries(pairedState);
  if (srcEntries.length === 0 && dstEntries.length === 0) return 'unknown';
  if (srcEntries.length === 0 || dstEntries.length === 0) {
    // Explicit empty `{}` (removed attribute) mismatches a non-empty toggle state.
    return 'mismatch';
  }

  const srcMap = new Map(srcEntries);
  const dstMap = new Map(dstEntries);
  const keys = new Set([...srcMap.keys(), ...dstMap.keys()]);
  for (const k of keys) {
    if ((srcMap.get(k) ?? null) !== (dstMap.get(k) ?? null)) {
      return 'mismatch';
    }
  }
  return 'match';
}

export function toggleStatesEqual(
  a: ToggleStateMap | null | undefined,
  b: ToggleStateMap | null | undefined,
): boolean {
  return compareToggleStates(a, b) === 'match';
}

export interface ToggleGuardParams {
  preState?: ToggleStateMap | null;
  postState?: ToggleStateMap | null;
  pairedState?: ToggleStateMap | null;
}

export function shouldSkipToggleClick(
  sourceOrParams: ToggleStateMap | ToggleGuardParams | null | undefined,
  pairedStateArg?: ToggleStateMap | null,
): boolean {
  if (!sourceOrParams) return false;

  const isParamsObj =
    typeof sourceOrParams === 'object' &&
    ('preState' in sourceOrParams || 'postState' in sourceOrParams || 'pairedState' in sourceOrParams);

  if (isParamsObj) {
    const params = sourceOrParams as ToggleGuardParams;
    const pairedState = params.pairedState ?? pairedStateArg;
    const pre = params.preState;
    const post = params.postState;
    if (collectDefinedToggleEntries(pairedState).length === 0) return false;

    const hasPre = collectDefinedToggleEntries(pre).length > 0;
    const postIsDefinedObject = post !== null && post !== undefined;
    const hasPost = collectDefinedToggleEntries(post).length > 0;

    if (hasPre && postIsDefinedObject) {
      const didChange = compareToggleStates(pre, post) === 'mismatch';
      if (didChange) {
        return compareToggleStates(post, pairedState) === 'match';
      }
      // If source state did not change synchronously (e.g. async handler), skip only if
      // paired is already in a different state than source preState.
      return compareToggleStates(pre, pairedState) === 'mismatch';
    }

    const single = hasPost ? post : pre;
    return compareToggleStates(single, pairedState) === 'match';
  }

  return compareToggleStates(sourceOrParams as ToggleStateMap, pairedStateArg) === 'match';
}

export interface KeyActivationRecord {
  key: string;
  timestampMs: number;
  fingerprint: ElementFingerprint;
}

export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Space';
}

export function fingerprintsReferSameTarget(
  a: Partial<ElementFingerprint> | null | undefined,
  b: Partial<ElementFingerprint> | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.testId && b.testId) return a.testId === b.testId;
  if (a.id && b.id) return a.id === b.id;
  if (a.cssPath && b.cssPath) {
    if (a.cssPath === b.cssPath) {
      const aPath = a.iframePath?.join(',') ?? '';
      const bPath = b.iframePath?.join(',') ?? '';
      return aPath === bPath;
    }
    return false;
  }
  if (a.ariaLabel && b.ariaLabel && a.tag === b.tag) return a.ariaLabel === b.ariaLabel;
  if (a.name && b.name && a.tag === b.tag) return a.name === b.name;
  return Boolean(a.tag && b.tag && a.tag === b.tag && a.role === b.role && a.text === b.text);
}

export function shouldSuppressSyntheticClick(params: {
  clickCount: number;
  clickFingerprint: ElementFingerprint;
  recentKeyRelay: KeyActivationRecord | null | undefined;
  nowMs: number;
  windowMs?: number;
}): boolean {
  const { clickCount, recentKeyRelay, nowMs, windowMs = 350 } = params;
  if (!recentKeyRelay || !isActivationKey(recentKeyRelay.key)) return false;
  const elapsed = nowMs - recentKeyRelay.timestampMs;
  if (elapsed < 0 || elapsed > windowMs) return false;
  return clickCount === 0;
}

export function isDragOrSliderTarget(
  fp: Pick<ElementFingerprint, 'tag' | 'role' | 'isCanvas'> & { inputType?: string },
): boolean {
  if (fp.isCanvas) return true;
  const tag = (fp.tag || '').toLowerCase();
  if (tag === 'canvas') return true;
  if (fp.role?.toLowerCase() === 'slider') return true;
  if (tag === 'input' && fp.inputType?.toLowerCase() === 'range') return true;
  return false;
}

export const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'label',
  'canvas',
  'summary',
]);

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'radio',
  'switch',
  'option',
  'checkbox',
  'menuitem',
  'slider',
  'combobox',
  'textbox',
]);

export function isInteractiveTarget(target: {
  tag?: string | null;
  role?: string | null;
  testId?: string | null;
  tabIndex?: string | number | null;
  hasHref?: boolean | null;
  isCanvas?: boolean | null;
}): boolean {
  if (target.isCanvas) return true;
  const tag = (target.tag ?? '').trim().toLowerCase();
  if (tag === 'a') {
    if (target.hasHref === true) return true;
    if (target.hasHref === undefined && !target.role) return true;
  } else if (INTERACTIVE_TAGS.has(tag)) {
    return true;
  }
  if (target.role && INTERACTIVE_ROLES.has(target.role.trim().toLowerCase())) return true;
  if (target.testId && target.testId.trim().length > 0) return true;
  if (target.tabIndex !== undefined && target.tabIndex !== null) {
    if (typeof target.tabIndex === 'number') {
      if (Number.isFinite(target.tabIndex) && target.tabIndex >= 0) return true;
    } else {
      const trimmed = target.tabIndex.trim();
      if (trimmed.length > 0 && trimmed !== '-1') {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed >= 0) return true;
      }
    }
  }
  return false;
}

export function isInteractiveFingerprint(fp: ElementFingerprint): boolean {
  const tabIndexMatch = /\[tabindex="([^"]*)"\]/i.exec(fp.cssPath || '');
  const tabIndexFromPath = tabIndexMatch?.[1] ?? null;
  return isInteractiveTarget({
    tag: fp.tag,
    role: fp.role,
    testId: fp.testId,
    isCanvas: fp.isCanvas,
    tabIndex: tabIndexFromPath,
  });
}

const CONTROL_AND_BIDI_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function sanitizeMirrorMissLabel(
  raw: string | null | undefined,
  maxLen = 32,
): string {
  if (!raw || typeof raw !== 'string') return '';
  const cap = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : 32;
  if (cap === 0) return '';
  const cleaned = raw.replace(CONTROL_AND_BIDI_RE, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, cap);
}

export const sanitizeMirrorLabel = sanitizeMirrorMissLabel;

export function buildMirrorMissLabel(fp: ElementFingerprint, maxLen = 32): string {
  const tag = (fp.tag || '').toLowerCase();
  const isFormOrCanvas =
    fp.isCanvas || tag === 'input' || tag === 'textarea' || tag === 'select';
  const safeText = isFormOrCanvas ? undefined : fp.text;
  const candidate =
    fp.ariaLabel || safeText || fp.title || fp.testId || fp.id || fp.name || fp.role || fp.tag;
  return (
    sanitizeMirrorMissLabel(candidate, maxLen) ||
    sanitizeMirrorMissLabel(fp.tag, maxLen) ||
    'element'
  );
}

export const buildMirrorMissTargetLabel = buildMirrorMissLabel;

export function redactMirrorUrl(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'about:') {
      return parsed.href === 'about:blank' ? 'about:blank' : 'about:';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const withoutCreds = trimmed
      .replace(/^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^/?#]*@/, '$1')
      .replace(/^[^/?#:]+:[^/?#]*@/, '');
    const stripped = withoutCreds.replace(/[?#].*$/, '');
    return stripped || undefined;
  }
}

function findHtmlTagEnd(html: string, openTagStart: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = openTagStart + 1; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return html.length - 1;
}

function redactInputTag(tagHtml: string): string {
  let i = 6; // right after `<input`
  let out = tagHtml.slice(0, i);
  const len = tagHtml.length;

  while (i < len) {
    const ch = tagHtml[i]!;
    if (ch === '>' || (ch === '/' && tagHtml[i + 1] === '>')) {
      out += tagHtml.slice(i);
      break;
    }
    if (/\s/.test(ch) || ch === '/') {
      out += ch;
      i += 1;
      continue;
    }

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(tagHtml[i]!)) {
      i += 1;
    }
    const attrName = tagHtml.slice(nameStart, i);
    let j = i;
    while (j < len && /\s/.test(tagHtml[j]!)) j += 1;

    if (tagHtml[j] !== '=') {
      out += tagHtml.slice(nameStart, i);
      continue;
    }

    j += 1; // skip '='
    while (j < len && /\s/.test(tagHtml[j]!)) j += 1;

    let valEnd = j;
    if (j < len && (tagHtml[j] === '"' || tagHtml[j] === "'")) {
      const q = tagHtml[j]!;
      valEnd = j + 1;
      while (valEnd < len && tagHtml[valEnd] !== q) {
        valEnd += 1;
      }
      if (valEnd < len) valEnd += 1;
    } else {
      while (valEnd < len && !/[\s>]/.test(tagHtml[valEnd]!)) {
        valEnd += 1;
      }
    }

    if (attrName.toLowerCase() === 'value') {
      out += 'value="[REDACTED]"';
    } else {
      out += tagHtml.slice(nameStart, valEnd);
    }
    i = valEnd;
  }

  return out;
}

export function redactOuterHtml(rawHtml: string | null | undefined): string {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  let out = '';
  let pos = 0;

  while (pos < rawHtml.length) {
    const lt = rawHtml.indexOf('<', pos);
    if (lt === -1) {
      out += rawHtml.slice(pos);
      break;
    }
    out += rawHtml.slice(pos, lt);

    const rest = rawHtml.slice(lt);
    if (/^<input(?=[\s/>]|$)/i.test(rest)) {
      const end = findHtmlTagEnd(rawHtml, lt);
      out += redactInputTag(rawHtml.slice(lt, end + 1));
      pos = end + 1;
      continue;
    }

    if (/^<textarea(?=[\s/>]|$)/i.test(rest)) {
      const openEnd = findHtmlTagEnd(rawHtml, lt);
      out += rawHtml.slice(lt, openEnd + 1);
      const closeMatch = /<\/textarea\s*>/i.exec(rawHtml.slice(openEnd + 1));
      if (closeMatch) {
        out += `[REDACTED]${closeMatch[0]}`;
        pos = openEnd + 1 + closeMatch.index + closeMatch[0].length;
      } else {
        out += '[REDACTED]';
        pos = rawHtml.length;
      }
      continue;
    }

    out += '<';
    pos = lt + 1;
  }

  return out;
}

export function redactMirrorFingerprint(fp: ElementFingerprint): ElementFingerprint {
  const tag = (fp.tag || '').toLowerCase();
  const isFormInput = tag === 'input' || tag === 'textarea' || tag === 'select' || fp.isCanvas;
  return {
    ...fp,
    text: isFormInput ? undefined : fp.text ? sanitizeMirrorMissLabel(fp.text, 80) : undefined,
    ariaLabel: fp.ariaLabel ? sanitizeMirrorMissLabel(fp.ariaLabel, 80) : undefined,
    title: fp.title ? sanitizeMirrorMissLabel(fp.title, 80) : undefined,
  };
}

const REDACTED_SECRET_KEYS = new Set([
  'outerhtml',
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'value',
  'currentvalue',
  'insertedtext',
  'selectvalue',
]);

const REDACTED_URL_KEYS = new Set(['url', 'href', 'action']);

export function redactMirrorDebugPayload<T>(payload: T): T {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (depth > 16) return '[TRUNCATED]';
    if (seen.has(node)) return '[Circular]';
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }

    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const tag = typeof src.tag === 'string' ? src.tag.toLowerCase() : '';
    const inputType = typeof src.inputType === 'string' ? src.inputType.toLowerCase() : '';
    const isFormRecord =
      tag === 'input' || tag === 'textarea' || tag === 'select' || inputType === 'password';

    for (const [key, val] of Object.entries(src)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      const lowerKey = key.toLowerCase();
      if (REDACTED_SECRET_KEYS.has(lowerKey)) {
        out[key] = '[REDACTED]';
        continue;
      }
      if (REDACTED_URL_KEYS.has(lowerKey) && typeof val === 'string') {
        out[key] = redactMirrorUrl(val) ?? '[REDACTED]';
        continue;
      }
      if (lowerKey === 'text' && isFormRecord && typeof val === 'string') {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = walk(val, depth + 1);
    }

    return out;
  };

  return walk(payload, 0) as T;
}
