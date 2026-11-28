import { ipcRenderer } from 'electron';
import {
  accumulateIframeOffset,
  buildSelectorCandidates,
  computeFrameStats,
  computeProportionalScroll,
  DOM_PIERCE_LIMITS,
  escapeCssAttrValue,
  escapeCssIdentifier,
  extractStableClassTokens,
  extractToggleState,
  INTERACTIVE_TAGS,
  isOpaqueOrigin,
  mapNormalizedPoint,
  normalizeText,
  redactOuterHtml,
  TOGGLE_STATE_ATTRIBUTES,
} from '../shared/mirror-core';
import type { ElementFingerprint, MirrorCaptureEvent } from '../shared/types';

let suppressScrollCapture = false;

interface PiercedRoot {
  root: Document | ShadowRoot;
  doc: Document;
  win: Window;
  depth: number;
  offsetX: number;
  offsetY: number;
  iframePath: number[];
}

interface ResolvedElement {
  element: Element | null;
  tier: 2 | 3;
  rootMeta?: PiercedRoot;
}

const INTERACTIVE_SELECTOR =
  '[data-testid], button, a[href], input, textarea, select, label, [role="button"], [role="link"], [role="tab"], [role="radio"], [role="switch"], [role="option"], [role="checkbox"], [role="menuitem"], [role="slider"], [tabindex]:not([tabindex="-1"])';

const DRAG_SLIDER_SELECTOR = 'canvas, input[type="range"], [role="slider"]';

function isElementNode(node: unknown): node is Element {
  return Boolean(
    node &&
      typeof node === 'object' &&
      (node as Node).nodeType === 1 &&
      typeof (node as Element).tagName === 'string',
  );
}

function isShadowRootNode(node: unknown): node is ShadowRoot {
  return Boolean(
    node &&
      typeof node === 'object' &&
      (node as Node).nodeType === 11 &&
      'host' in (node as object),
  );
}

function isDocumentNode(node: unknown): node is Document {
  return Boolean(node && typeof node === 'object' && (node as Node).nodeType === 9);
}

function getTagName(el: Element): string {
  return (el.tagName || '').toLowerCase();
}

function isInputElement(node: unknown): node is HTMLInputElement {
  return isElementNode(node) && getTagName(node) === 'input';
}

function isTextAreaElement(node: unknown): node is HTMLTextAreaElement {
  return isElementNode(node) && getTagName(node) === 'textarea';
}

function isSelectElement(node: unknown): node is HTMLSelectElement {
  return isElementNode(node) && getTagName(node) === 'select';
}

function isIframeElement(node: unknown): node is HTMLIFrameElement {
  return isElementNode(node) && getTagName(node) === 'iframe';
}

function isEditableElement(node: unknown): boolean {
  if (!isElementNode(node)) return false;
  const tag = getTagName(node);
  if (tag === 'input' || tag === 'textarea') return true;
  return Boolean((node as HTMLElement).isContentEditable);
}

function getWindowOf(el: Element): Window {
  return el.ownerDocument?.defaultView ?? window;
}

function getEventRawTarget(ev: Event): EventTarget | null {
  if (typeof ev.composedPath === 'function') {
    const path = ev.composedPath();
    for (const item of path) {
      if (isElementNode(item)) return item;
    }
  }
  return ev.target;
}

function implicitRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.toLowerCase();
  const tag = getTagName(el);
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  return '';
}

function extractElementToggleState(el: Element): Record<string, string | null> | undefined {
  const attrs: Record<string, string | null> = {};
  for (const attr of TOGGLE_STATE_ATTRIBUTES) {
    attrs[attr] = el.getAttribute(attr);
  }
  const checked =
    isInputElement(el) &&
    (el.type.toLowerCase() === 'checkbox' || el.type.toLowerCase() === 'radio')
      ? Boolean(el.checked)
      : undefined;
  return extractToggleState(attrs, checked);
}

function buildCssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;
  while (current && current.nodeType === 1 && depth < 6) {
    const tag = getTagName(current);
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag);
      break;
    }
    const id = current.getAttribute('id');
    if (id && id.trim().length > 0) {
      let seg = `#${escapeCssIdentifier(id.trim())}`;
      if (current === el && current.hasAttribute('tabindex')) {
        const ti = current.getAttribute('tabindex')?.trim() ?? '';
        if (ti.length > 0 && ti !== '-1') {
          seg += `[tabindex="${escapeCssAttrValue(ti)}"]`;
        }
      }
      parts.unshift(seg);
      break;
    }
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx += 1;
      sibling = sibling.previousElementSibling;
    }
    let seg = `${escapeCssIdentifier(tag)}:nth-of-type(${idx})`;
    if (
      current === el &&
      !INTERACTIVE_TAGS.has(tag) &&
      !implicitRole(current) &&
      !current.getAttribute('data-testid') &&
      current.hasAttribute('tabindex')
    ) {
      const ti = current.getAttribute('tabindex')?.trim() ?? '';
      if (ti.length > 0 && ti !== '-1') {
        seg = `${escapeCssIdentifier(tag)}[tabindex="${escapeCssAttrValue(ti)}"]:nth-of-type(${idx})`;
      }
    }
    parts.unshift(seg);
    current = current.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

function closestAcrossShadow(raw: Element, selector: string): Element | null {
  let cur: Element | null = raw;
  let depth = 0;
  const visited = new WeakSet<Node>();
  while (cur && depth <= DOM_PIERCE_LIMITS.maxDepth) {
    if (visited.has(cur)) break;
    visited.add(cur);
    try {
      const hit = cur.closest(selector);
      if (hit) return hit;
    } catch {
      return null;
    }
    const root = cur.getRootNode();
    if (isShadowRootNode(root) && isElementNode(root.host)) {
      cur = root.host;
      depth += 1;
    } else {
      break;
    }
  }
  return null;
}

function interactiveElement(raw: EventTarget | null): Element | null {
  if (!isElementNode(raw)) return null;
  if (getTagName(raw) === 'canvas') return raw;
  const semantic = closestAcrossShadow(raw, INTERACTIVE_SELECTOR);
  return semantic ?? raw;
}

function resolveDragSliderTarget(raw: EventTarget | null): Element | null {
  if (!isElementNode(raw)) return null;
  if (getTagName(raw) === 'canvas') return raw;
  return closestAcrossShadow(raw, DRAG_SLIDER_SELECTOR);
}

function safeGetSameOriginIframeDoc(iframe: HTMLIFrameElement): Document | null {
  if (isOpaqueOrigin(window.location.origin)) return null;
  try {
    const doc = iframe.contentDocument;
    if (!doc) return null;
    const childOrigin = doc.location?.origin;
    if (isOpaqueOrigin(childOrigin) || childOrigin !== window.location.origin) {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

function getIframeContentOffset(iframe: HTMLIFrameElement): { x: number; y: number } {
  const rect = iframe.getBoundingClientRect();
  const win = getWindowOf(iframe);
  const cs = win.getComputedStyle(iframe);
  const borderLeft = Number.parseFloat(cs.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(cs.borderTopWidth) || 0;
  const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
  const padTop = Number.parseFloat(cs.paddingTop) || 0;
  return {
    x: rect.left + borderLeft + padLeft,
    y: rect.top + borderTop + padTop,
  };
}

function getElementFrameContext(el: Element): {
  offsetX: number;
  offsetY: number;
  iframePath: number[];
} {
  const offsets: Array<{ left: number; top: number }> = [];
  const iframePath: number[] = [];
  const visitedWins = new WeakSet<Window>();

  let win: Window | null = el.ownerDocument?.defaultView ?? null;
  let depth = 0;
  while (win && win !== window.top && depth < DOM_PIERCE_LIMITS.maxDepth) {
    if (visitedWins.has(win)) break;
    visitedWins.add(win);

    let fe: Element | null = null;
    try {
      fe = win.frameElement;
    } catch {
      break;
    }
    if (!isIframeElement(fe)) break;

    const off = getIframeContentOffset(fe);
    offsets.push({ left: off.x, top: off.y });

    const parentRoot = fe.getRootNode();
    let idx = 0;
    if (isDocumentNode(parentRoot) || isShadowRootNode(parentRoot)) {
      const frames = Array.from(parentRoot.querySelectorAll('iframe'));
      const foundIdx = frames.indexOf(fe);
      idx = foundIdx >= 0 ? foundIdx : 0;
    }
    iframePath.unshift(idx);

    win = fe.ownerDocument?.defaultView ?? null;
    depth += 1;
  }

  const { offsetX, offsetY } = accumulateIframeOffset(offsets);
  return { offsetX, offsetY, iframePath };
}

function collectPiercedRoots(startDoc: Document = document): PiercedRoot[] {
  const roots: PiercedRoot[] = [];
  const visitedRoots = new WeakSet<Node>();
  const visitedEls = new WeakSet<Node>();
  let nodesVisited = 0;

  const startWin = startDoc.defaultView ?? window;
  const queue: PiercedRoot[] = [
    {
      root: startDoc,
      doc: startDoc,
      win: startWin,
      depth: 0,
      offsetX: 0,
      offsetY: 0,
      iframePath: [],
    },
  ];
  visitedRoots.add(startDoc);

  while (queue.length > 0 && roots.length < DOM_PIERCE_LIMITS.maxRoots) {
    const current = queue.shift()!;
    roots.push(current);

    if (current.depth >= DOM_PIERCE_LIMITS.maxDepth) continue;
    if (nodesVisited >= DOM_PIERCE_LIMITS.maxNodes) continue;

    // Track iframe ordinal inside this root so iframePath matches getElementFrameContext.
    let iframeOrdinal = 0;
    const stack: Element[] = [];
    const rootChildren = current.root.children;
    for (let i = rootChildren.length - 1; i >= 0; i -= 1) {
      const child = rootChildren[i];
      if (child && isElementNode(child)) stack.push(child);
    }

    while (stack.length > 0 && nodesVisited < DOM_PIERCE_LIMITS.maxNodes) {
      const el = stack.pop()!;
      if (visitedEls.has(el)) continue;
      visitedEls.add(el);
      nodesVisited += 1;

      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (
        sr &&
        isShadowRootNode(sr) &&
        !visitedRoots.has(sr) &&
        roots.length + queue.length < DOM_PIERCE_LIMITS.maxRoots &&
        current.depth + 1 <= DOM_PIERCE_LIMITS.maxDepth
      ) {
        visitedRoots.add(sr);
        queue.push({
          root: sr,
          doc: current.doc,
          win: current.win,
          depth: current.depth + 1,
          offsetX: current.offsetX,
          offsetY: current.offsetY,
          iframePath: current.iframePath,
        });
      }

      if (isIframeElement(el)) {
        const myIframeIndex = iframeOrdinal;
        iframeOrdinal += 1;
        if (
          roots.length + queue.length < DOM_PIERCE_LIMITS.maxRoots &&
          current.depth + 1 <= DOM_PIERCE_LIMITS.maxDepth
        ) {
          const childDoc = safeGetSameOriginIframeDoc(el);
          if (childDoc && !visitedRoots.has(childDoc)) {
            visitedRoots.add(childDoc);
            const off = getIframeContentOffset(el);
            queue.push({
              root: childDoc,
              doc: childDoc,
              win: childDoc.defaultView ?? current.win,
              depth: current.depth + 1,
              offsetX: current.offsetX + off.x,
              offsetY: current.offsetY + off.y,
              iframePath: [...current.iframePath, myIframeIndex],
            });
          }
        }
      }

      const children = el.children;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child && isElementNode(child)) stack.push(child);
      }
    }
  }

  return roots;
}

function isVisibleElement(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getWindowOf(el).getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

function safeQuerySelectorAll(
  selector: string,
  roots: readonly PiercedRoot[] = collectPiercedRoots(),
): Array<{ element: Element; rootMeta: PiercedRoot }> {
  const out: Array<{ element: Element; rootMeta: PiercedRoot }> = [];
  for (const rootMeta of roots) {
    try {
      const list = rootMeta.root.querySelectorAll(selector);
      for (const item of Array.from(list)) {
        if (isElementNode(item)) {
          out.push({ element: item, rootMeta });
        }
      }
    } catch {
      // Invalid selector or inaccessible root; skip safely.
    }
  }
  return out;
}

function findCandidateMatches(
  candidate: ReturnType<typeof buildSelectorCandidates>[number],
  roots: readonly PiercedRoot[],
): Array<{ element: Element; rootMeta: PiercedRoot }> {
  if (candidate.strategy === 'role-text') {
    const escapedRole = candidate.role ? escapeCssAttrValue(candidate.role) : '';
    const pool = escapedRole
      ? safeQuerySelectorAll(
          `[role="${escapedRole}"], button, a[href], input, textarea, select, label, [tabindex]`,
          roots,
        )
      : candidate.tag
        ? safeQuerySelectorAll(escapeCssIdentifier(candidate.tag), roots)
        : [];
    const matched: Array<{ element: Element; rootMeta: PiercedRoot }> = [];
    for (const entry of pool) {
      if (!isVisibleElement(entry.element)) continue;
      if (candidate.role && implicitRole(entry.element) !== candidate.role) continue;
      if (candidate.text) {
        const text = normalizeText(entry.element.textContent, 96);
        if (text !== candidate.text) continue;
      }
      matched.push(entry);
    }
    return matched;
  }

  if (candidate.selector) {
    const matches = safeQuerySelectorAll(candidate.selector, roots);
    const visible = matches.filter((m) => isVisibleElement(m.element));
    return visible.length > 0 ? visible : matches;
  }
  return [];
}

function sameIframePath(a: readonly number[] | undefined, b: readonly number[]): boolean {
  const aLen = a?.length ?? 0;
  if (aLen !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    if (a?.[i] !== b[i]) return false;
  }
  return true;
}

function buildFingerprint(
  el: Element,
  clientX?: number,
  clientY?: number,
  rawTarget?: EventTarget | null,
): ElementFingerprint {
  const tag = getTagName(el);
  const isCanvas = tag === 'canvas';
  const rect = el.getBoundingClientRect();
  const ctx = getElementFrameContext(el);
  const vw = Math.max(window.innerWidth, 1);
  const vh = Math.max(window.innerHeight, 1);

  const localCx = clientX ?? rect.left + rect.width / 2;
  const localCy = clientY ?? rect.top + rect.height / 2;
  const topCx = localCx + ctx.offsetX;
  const topCy = localCy + ctx.offsetY;

  const clickedSelfDirect = rawTarget !== undefined ? rawTarget === el : undefined;
  const elemRelX =
    rect.width > 0 ? Math.min(Math.max((localCx - rect.left) / rect.width, 0), 1) : 0.5;
  const elemRelY =
    rect.height > 0 ? Math.min(Math.max((localCy - rect.top) / rect.height, 0), 1) : 0.5;

  const roots = collectPiercedRoots();
  let canvasIndex: number | undefined;
  let normalizedX: number | undefined;
  let normalizedY: number | undefined;

  if (isCanvas) {
    const canvases = safeQuerySelectorAll('canvas', roots).map((r) => r.element);
    const idx = canvases.indexOf(el);
    canvasIndex = idx >= 0 ? idx : 0;
    if (rect.width > 0 && rect.height > 0) {
      normalizedX = elemRelX;
      normalizedY = elemRelY;
    }
  }

  const isSensitiveOrSelect =
    isCanvas ||
    (isInputElement(el) && el.type.toLowerCase() === 'password') ||
    isTextAreaElement(el) ||
    isSelectElement(el);

  const classTokens = isCanvas ? undefined : extractStableClassTokens(el.classList);
  const fp: ElementFingerprint = {
    testId: el.getAttribute('data-testid') || undefined,
    id: el.getAttribute('id') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    title: el.getAttribute('title') || undefined,
    name: el.getAttribute('name') || undefined,
    role: implicitRole(el) || undefined,
    text: isSensitiveOrSelect ? undefined : normalizeText(el.textContent, 80) || undefined,
    tag,
    classTokens: classTokens && classTokens.length > 0 ? classTokens : undefined,
    clickedSelfDirect,
    elemRelX,
    elemRelY,
    iframePath: ctx.iframePath.length > 0 ? ctx.iframePath : undefined,
    toggleState: extractElementToggleState(el),
    cssPath: buildCssPath(el),
    isCanvas,
    canvasIndex,
    normalizedX,
    normalizedY,
    relViewportX: Math.min(Math.max(topCx / vw, 0), 1),
    relViewportY: Math.min(Math.max(topCy / vh, 0), 1),
  };

  if (!isCanvas) {
    const candidates = buildSelectorCandidates(fp);
    for (const candidate of candidates) {
      const matches = findCandidateMatches(candidate, roots);
      const occIdx = matches.findIndex((m) => m.element === el);
      if (occIdx >= 0) {
        fp.occurrenceIndex = occIdx;
        break;
      }
    }
  }

  return fp;
}

function buildCaptureMeta(
  el: Element,
  clientX?: number,
  clientY?: number,
  pointerType?: string,
  toggleState?: Record<string, string | null>,
): {
  pointerType?: string;
  toggleState?: Record<string, string | null>;
  iframePath?: number[];
  topNormX?: number;
  topNormY?: number;
} {
  const ctx = getElementFrameContext(el);
  const rect = el.getBoundingClientRect();
  const localCx = clientX ?? rect.left + rect.width / 2;
  const localCy = clientY ?? rect.top + rect.height / 2;
  const topCx = localCx + ctx.offsetX;
  const topCy = localCy + ctx.offsetY;
  const vw = Math.max(window.innerWidth, 1);
  const vh = Math.max(window.innerHeight, 1);
  return {
    ...(pointerType ? { pointerType } : {}),
    ...(toggleState ? { toggleState } : {}),
    ...(ctx.iframePath.length > 0 ? { iframePath: ctx.iframePath } : {}),
    topNormX: Math.min(Math.max(topCx / vw, 0), 1),
    topNormY: Math.min(Math.max(topCy / vh, 0), 1),
  };
}

function getModifiers(ev: MouseEvent | KeyboardEvent): string[] {
  const mods: string[] = [];
  if (ev.shiftKey) mods.push('shift');
  if (ev.ctrlKey) mods.push('control');
  if (ev.altKey) mods.push('alt');
  if (ev.metaKey) mods.push('meta');
  return mods;
}

function mouseButtonName(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

function sendCapture(event: MirrorCaptureEvent): void {
  ipcRenderer.send('iron:mirror-capture', event);
}

function resolveElementFromFingerprint(
  fp: ElementFingerprint,
  explicitSelector?: string,
): ResolvedElement {
  const allRoots = collectPiercedRoots();
  const preferredRoots =
    fp.iframePath && fp.iframePath.length > 0
      ? allRoots.filter((r) => sameIframePath(fp.iframePath, r.iframePath))
      : [];
  const rootGroups = preferredRoots.length > 0 ? [preferredRoots, allRoots] : [allRoots];

  if (explicitSelector) {
    for (const roots of rootGroups) {
      const matches = safeQuerySelectorAll(explicitSelector, roots);
      const picked = matches.find((m) => isVisibleElement(m.element)) ?? matches[0] ?? null;
      if (picked) return { element: picked.element, tier: 2, rootMeta: picked.rootMeta };
    }
  }

  if (fp.isCanvas) {
    const canvases = safeQuerySelectorAll('canvas', allRoots);
    const byIndex = fp.canvasIndex !== undefined ? canvases[fp.canvasIndex] ?? null : null;
    if (byIndex && isVisibleElement(byIndex.element)) {
      return { element: byIndex.element, tier: 3, rootMeta: byIndex.rootMeta };
    }
    const firstVisible = canvases.find((c) => isVisibleElement(c.element)) ?? canvases[0] ?? null;
    if (firstVisible) {
      return { element: firstVisible.element, tier: 3, rootMeta: firstVisible.rootMeta };
    }
  }

  const candidates = buildSelectorCandidates(fp);
  const occIdx = fp.occurrenceIndex ?? 0;
  for (const roots of rootGroups) {
    for (const candidate of candidates) {
      const matches = findCandidateMatches(candidate, roots);
      if (matches.length > 0) {
        const picked = matches[occIdx] ?? matches[0] ?? null;
        if (picked) {
          return { element: picked.element, tier: 2, rootMeta: picked.rootMeta };
        }
      }
    }
  }

  return { element: null, tier: 3 };
}

const DIALOG_OVERLAY_SELECTOR =
  'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

function isActiveOverlayElement(el: Element): boolean {
  if (!isVisibleElement(el)) return false;
  if (
    el.hasAttribute('data-closed') ||
    el.getAttribute('data-state') === 'closed' ||
    el.getAttribute('aria-hidden') === 'true'
  ) {
    return false;
  }
  if (closestAcrossShadow(el, '[data-closed], [data-state="closed"], [aria-hidden="true"]')) {
    return false;
  }
  return true;
}

function getActiveOverlayElements(): Element[] {
  const nodes = safeQuerySelectorAll(DIALOG_OVERLAY_SELECTOR);
  const active: Element[] = [];
  for (const n of nodes) {
    if (isActiveOverlayElement(n.element)) active.push(n.element);
  }
  return active;
}

function countVisibleOverlays(): number {
  return getActiveOverlayElements().length;
}

/**
 * Returns true if the user clicked an interactive element or card content INSIDE a dialog
 * (as opposed to clicking a backdrop, native `<dialog>` `::backdrop` outside its rect,
 * or a full-screen `[role="dialog"]` wrapper directly).
 */
function isClickInsideDialogCard(
  el: Element,
  rawTarget: EventTarget | null,
  clientX: number,
  clientY: number,
): boolean {
  const dialogEl = closestAcrossShadow(el, DIALOG_OVERLAY_SELECTOR);
  if (!dialogEl) return false;
  const win = getWindowOf(dialogEl);
  const rect = dialogEl.getBoundingClientRect();
  if (rawTarget === dialogEl) {
    if (getTagName(dialogEl) === 'dialog') {
      const insideRect =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      return insideRect;
    }
    const vw = Math.max(win.innerWidth, 1);
    const vh = Math.max(win.innerHeight, 1);
    if (rect.width >= vw * 0.6 && rect.height >= vh * 0.6 && dialogEl.children.length > 0) {
      return false;
    }
  }
  return true;
}

function findPointOutsideDialogs(): { x: number; y: number } | null {
  const dialogs = getActiveOverlayElements();
  if (dialogs.length === 0) return null;
  const vw = Math.max(window.innerWidth, 1);
  const vh = Math.max(window.innerHeight, 1);
  const probes: Array<[number, number]> = [
    [4, 4],
    [vw - 4, 4],
    [4, vh - 4],
    [vw - 4, vh - 4],
    [Math.round(vw / 2), 4],
    [4, Math.round(vh / 2)],
    [vw - 4, Math.round(vh / 2)],
    [Math.round(vw / 2), vh - 4],
  ];
  for (const [px, py] of probes) {
    if (px < 0 || py < 0 || px >= vw || py >= vh) continue;
    const deep = inspectElementDeep(px, py);
    const hit = deep?.element ?? document.elementFromPoint(px, py);
    if (!hit) continue;
    const insideDialog = dialogs.some((d) => {
      if (d === hit) {
        const r = d.getBoundingClientRect();
        if (getTagName(d) === 'dialog') {
          return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
        }
        if (r.width >= vw * 0.6 && r.height >= vh * 0.6 && d.children.length > 0) {
          return false;
        }
        return true;
      }
      return d.contains(hit);
    });
    if (!insideDialog) {
      return { x: px, y: py };
    }
  }
  return null;
}

function elementFromRootAt(el: Element, px: number, py: number): Element | null {
  const root = el.getRootNode();
  if (isShadowRootNode(root) && typeof root.elementFromPoint === 'function') {
    return root.elementFromPoint(px, py);
  }
  const doc = el.ownerDocument ?? document;
  return doc.elementFromPoint(px, py);
}

/**
 * Finds an uncovered clickable point on `el` in `el`'s own frame coordinates.
 */
function findClickablePoint(
  el: Element,
  rect: DOMRect,
  fp?: ElementFingerprint,
): { x: number; y: number } {
  const win = getWindowOf(el);
  const vw = Math.max(win.innerWidth, 1);
  const vh = Math.max(win.innerHeight, 1);
  const clampX = (n: number) => Math.min(Math.max(Math.round(n), 2), Math.max(vw - 2, 2));
  const clampY = (n: number) => Math.min(Math.max(Math.round(n), 2), Math.max(vh - 2, 2));

  const cx = clampX(rect.left + rect.width / 2);
  const cy = clampY(rect.top + rect.height / 2);
  const isBackdropOverlay =
    rect.width >= vw * 0.6 && rect.height >= vh * 0.6 && el.children.length > 0;
  const requireSelfHit = Boolean(fp?.clickedSelfDirect || fp?.dismissedOverlay || isBackdropOverlay);

  const centerHit = elementFromRootAt(el, cx, cy);
  if (!requireSelfHit) {
    if (centerHit && (centerHit === el || el.contains(centerHit))) {
      return { x: cx, y: cy };
    }
  } else if (centerHit === el) {
    return { x: cx, y: cy };
  }

  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, vw);
  const bottom = Math.min(rect.bottom, vh);
  const padX = Math.min(10, Math.max(2, Math.floor((right - left) / 6)));
  const padY = Math.min(10, Math.max(2, Math.floor((bottom - top) / 6)));

  const probes: Array<[number, number]> = [];
  if (fp?.elemRelX !== undefined && fp?.elemRelY !== undefined) {
    probes.push([
      clampX(rect.left + fp.elemRelX * rect.width),
      clampY(rect.top + fp.elemRelY * rect.height),
    ]);
  }
  probes.push(
    [clampX(left + padX), clampY(top + padY)],
    [clampX(right - padX), clampY(top + padY)],
    [clampX(left + padX), clampY(bottom - padY)],
    [clampX(right - padX), clampY(bottom - padY)],
    [cx, clampY(top + padY)],
    [clampX(left + padX), cy],
    [clampX(right - padX), cy],
    [cx, clampY(bottom - padY)],
  );

  for (const [px, py] of probes) {
    const hit = elementFromRootAt(el, px, py);
    if (hit === el) {
      return { x: px, y: py };
    }
  }

  return { x: cx, y: cy };
}

function setupCaptureListeners(): void {
  const attachedWins = new WeakSet<Window>();
  const attachedDocs = new WeakSet<Document>();
  const observedRoots = new WeakSet<Node>();

  let pendingPointerDown: {
    el: Element;
    fingerprint: ElementFingerprint;
    button: 'left' | 'middle' | 'right';
    modifiers: string[];
    overlaysBefore: number;
    clickedInsideDialog: boolean;
    pointerType?: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  let activeDrag: {
    el: Element;
    pointerId: number;
    pointerType: string;
    win: Window;
    lastClientX: number;
    lastClientY: number;
    modifiers: string[];
    rafId: number | null;
    pendingMove: {
      clientX: number;
      clientY: number;
      modifiers: string[];
      pointerType: string;
    } | null;
  } | null = null;

  let suppressNextDragClick: { el: Element; expiresAt: number } | null = null;
  let suppressDismissedClickUntil = 0;

  const pendingClickMeta = new WeakMap<
    Event,
    {
      el: Element;
      fp: ElementFingerprint;
      preToggleState: ReturnType<typeof extractElementToggleState>;
      overlaysBeforeClick: number;
      clickedInsideDialog: boolean;
      dismissedDuringPointerDown: boolean;
      button: 'left' | 'middle' | 'right';
      rawDetail: number;
      modifiers: string[];
      meta: ReturnType<typeof buildCaptureMeta>;
    }
  >();
  const handledClickEvents = new WeakSet<Event>();

  const pendingPreventDefaultKey = new WeakMap<
    Event,
    {
      el: Element;
      fp: ElementFingerprint | null;
      meta: ReturnType<typeof buildCaptureMeta> | null;
      preIdent: Pick<
        ElementFingerprint,
        'testId' | 'id' | 'ariaLabel' | 'title' | 'name' | 'role'
      >;
      inEditable: boolean;
      sensitive: boolean;
      repeat: boolean;
      key: string;
      code: string;
      modifiers: string[];
    }
  >();
  const handledKeyEvents = new WeakSet<Event>();
  const pendingKeyEventsByCode = new Map<string, KeyboardEvent>();
  const relayedHeldKeys = new Map<
    string,
    {
      fp: ElementFingerprint;
      meta: ReturnType<typeof buildCaptureMeta>;
      key: string;
      code: string;
      sensitive: boolean;
    }
  >();

  let recentActivationKey: {
    el: Element;
    form: HTMLFormElement | null;
    key: string;
    expiresAt: number;
  } | null = null;

  const clearPendingPointerDown = () => {
    if (pendingPointerDown) {
      clearTimeout(pendingPointerDown.timer);
      pendingPointerDown = null;
    }
  };

  const releaseActiveDrag = (
    clientX?: number,
    clientY?: number,
    modifiers?: string[],
    sourceWin?: Window,
  ) => {
    if (!activeDrag) return;
    const drag = activeDrag;
    activeDrag = null;
    if (drag.rafId !== null) {
      drag.win.cancelAnimationFrame(drag.rafId);
    }
    const useOwnCoords = !sourceWin || sourceWin === drag.win;
    const cx = useOwnCoords && clientX !== undefined ? clientX : drag.lastClientX;
    const cy = useOwnCoords && clientY !== undefined ? clientY : drag.lastClientY;
    const mods = modifiers ?? drag.modifiers;
    sendCapture({
      kind: 'pointerup',
      fingerprint: buildFingerprint(drag.el, cx, cy, drag.el),
      button: 'left',
      clickCount: 1,
      modifiers: mods,
      ...buildCaptureMeta(drag.el, cx, cy, drag.pointerType),
    });
  };

  const attachWindowListeners = (win: Window, doc: Document, isTop: boolean) => {
    if (!attachedDocs.has(doc)) {
      attachedDocs.add(doc);
      doc.addEventListener(
        'load',
        (ev) => {
          if (isIframeElement(ev.target)) {
            attachPiercedFrames();
          }
        },
        { capture: true, passive: true },
      );
    }
    if (attachedWins.has(win)) return;
    attachedWins.add(win);

    win.addEventListener(
      'pointerdown',
      (ev) => {
        if (!ev.isTrusted || ev.button !== 0) return;
        const rawTarget = getEventRawTarget(ev);
        const dragEl = resolveDragSliderTarget(rawTarget);
        if (dragEl) {
          clearPendingPointerDown();
          if (activeDrag) {
            releaseActiveDrag();
          }
          const mods = getModifiers(ev);
          const dragWin = getWindowOf(dragEl);
          activeDrag = {
            el: dragEl,
            pointerId: ev.pointerId,
            pointerType: ev.pointerType || 'mouse',
            win: dragWin,
            lastClientX: ev.clientX,
            lastClientY: ev.clientY,
            modifiers: mods,
            rafId: null,
            pendingMove: null,
          };
          sendCapture({
            kind: 'pointerdown',
            fingerprint: buildFingerprint(dragEl, ev.clientX, ev.clientY, rawTarget),
            button: mouseButtonName(ev.button),
            clickCount: 1,
            modifiers: mods,
            ...buildCaptureMeta(dragEl, ev.clientX, ev.clientY, ev.pointerType),
          });
          return;
        }

        const el = interactiveElement(rawTarget);
        if (!el) return;
        if (isSelectElement(el) || getTagName(el) === 'option') {
          clearPendingPointerDown();
          return;
        }
        clearPendingPointerDown();
        suppressDismissedClickUntil = 0;
        const fp = buildFingerprint(el, ev.clientX, ev.clientY, rawTarget);
        const overlaysBefore = countVisibleOverlays();
        const button = mouseButtonName(ev.button);
        const modifiers = getModifiers(ev);
        const pointerType = ev.pointerType || undefined;

        const clickedInsideDialog = isClickInsideDialogCard(el, rawTarget, ev.clientX, ev.clientY);
        const timer = setTimeout(() => {
          if (!pendingPointerDown || pendingPointerDown.el !== el) return;
          const entry = pendingPointerDown;
          pendingPointerDown = null;
          if (entry.clickedInsideDialog || entry.overlaysBefore === 0) return;
          const overlaysAfter = countVisibleOverlays();
          const dismissed =
            !entry.el.isConnected ||
            !isVisibleElement(entry.el) ||
            overlaysAfter < entry.overlaysBefore;
          if (dismissed) {
            suppressDismissedClickUntil = performance.now() + 500;
            sendCapture({
              kind: 'click',
              fingerprint: { ...entry.fingerprint, dismissedOverlay: true },
              button: entry.button,
              clickCount: 1,
              modifiers: entry.modifiers,
              ...(entry.pointerType ? { pointerType: entry.pointerType } : {}),
            });
          }
        }, 60);

        pendingPointerDown = {
          el,
          fingerprint: fp,
          button,
          modifiers,
          overlaysBefore,
          clickedInsideDialog,
          pointerType,
          timer,
        };
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'pointermove',
      (ev) => {
        if (!activeDrag || !ev.isTrusted || ev.pointerId !== activeDrag.pointerId) return;
        if (win !== activeDrag.win) return;
        activeDrag.lastClientX = ev.clientX;
        activeDrag.lastClientY = ev.clientY;
        activeDrag.pendingMove = {
          clientX: ev.clientX,
          clientY: ev.clientY,
          modifiers: getModifiers(ev),
          pointerType: ev.pointerType || activeDrag.pointerType,
        };
        if (activeDrag.rafId !== null) return;
        const drag = activeDrag;
        drag.rafId = drag.win.requestAnimationFrame(() => {
          drag.rafId = null;
          if (activeDrag !== drag || !drag.pendingMove) return;
          const move = drag.pendingMove;
          drag.pendingMove = null;
          sendCapture({
            kind: 'hover',
            fingerprint: buildFingerprint(drag.el, move.clientX, move.clientY, drag.el),
            button: 'left',
            clickCount: 0,
            modifiers: move.modifiers,
            ...buildCaptureMeta(drag.el, move.clientX, move.clientY, move.pointerType),
          });
        });
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'pointerup',
      (ev) => {
        if (!activeDrag || !ev.isTrusted || ev.pointerId !== activeDrag.pointerId) return;
        const dragEl = activeDrag.el;
        releaseActiveDrag(ev.clientX, ev.clientY, getModifiers(ev), win);
        suppressNextDragClick = { el: dragEl, expiresAt: performance.now() + 250 };
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'pointercancel',
      (ev) => {
        clearPendingPointerDown();
        if (activeDrag && ev.pointerId === activeDrag.pointerId) {
          releaseActiveDrag();
        }
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'blur',
      () => {
        clearPendingPointerDown();
        if (activeDrag) {
          releaseActiveDrag();
        }
      },
      { capture: true, passive: true },
    );

    const finalizeClickCapture = (ev: MouseEvent) => {
      if (handledClickEvents.has(ev)) return;
      const entry = pendingClickMeta.get(ev);
      if (!entry) return;
      handledClickEvents.add(ev);
      pendingClickMeta.delete(ev);

      if (
        !entry.clickedInsideDialog &&
        !entry.fp.dismissedOverlay &&
        entry.overlaysBeforeClick > 0 &&
        countVisibleOverlays() < entry.overlaysBeforeClick
      ) {
        entry.fp.dismissedOverlay = true;
      }
      const postToggleState = entry.el.isConnected
        ? extractElementToggleState(entry.el)
        : entry.preToggleState;
      sendCapture({
        kind: 'click',
        fingerprint: entry.fp,
        button: entry.button,
        clickCount: entry.rawDetail,
        modifiers: entry.modifiers,
        ...entry.meta,
        ...(postToggleState ? { toggleState: postToggleState } : {}),
      });
    };

    win.addEventListener(
      'click',
      (ev) => {
        if (!ev.isTrusted) return;
        const pendingPd = pendingPointerDown;
        clearPendingPointerDown();
        if (suppressDismissedClickUntil > 0) {
          const until = suppressDismissedClickUntil;
          suppressDismissedClickUntil = 0;
          if (performance.now() <= until) {
            return;
          }
        }
        const overlaysBeforeClick = countVisibleOverlays();
        const dismissedDuringPointerDown = Boolean(
          pendingPd &&
            !pendingPd.clickedInsideDialog &&
            pendingPd.overlaysBefore > 0 &&
            (!pendingPd.el.isConnected ||
              !isVisibleElement(pendingPd.el) ||
              overlaysBeforeClick < pendingPd.overlaysBefore),
        );

        const rawTarget = getEventRawTarget(ev);
        const el = interactiveElement(rawTarget);
        if (!el) return;

        if (suppressNextDragClick) {
          const dragSuppress = suppressNextDragClick;
          suppressNextDragClick = null;
          if (dragSuppress.el === el && performance.now() <= dragSuppress.expiresAt) {
            return;
          }
        }

        // Preserve raw ev.detail before any normalization so synthetic keyboard clicks (detail === 0)
        // are accurately detected and suppressed when keydown already relayed Enter/Space.
        const rawDetail = ev.detail;
        if (rawDetail === 0 && recentActivationKey) {
          const rec = recentActivationKey;
          if (performance.now() > rec.expiresAt) {
            recentActivationKey = null;
          } else {
            const elForm = isElementNode(el)
              ? ((el as HTMLInputElement).form ?? null)
              : null;
            const sameTarget =
              rec.el === el ||
              (isElementNode(rawTarget) && rec.el === rawTarget) ||
              (rec.key === 'Enter' && rec.form !== null && elForm === rec.form);
            if (sameTarget) {
              recentActivationKey = null;
              return;
            }
          }
        }

        const clickedInsideDialog = isClickInsideDialogCard(el, rawTarget, ev.clientX, ev.clientY);
        const preToggleState = extractElementToggleState(el);
        const fp = buildFingerprint(el, ev.clientX, ev.clientY, rawTarget);
        if (preToggleState) {
          fp.toggleState = preToggleState;
        }
        if (!clickedInsideDialog && dismissedDuringPointerDown) {
          fp.dismissedOverlay = true;
        }
        const button = mouseButtonName(ev.button);
        const modifiers = getModifiers(ev);
        const pointerType = (ev as MouseEvent & { pointerType?: string }).pointerType || undefined;
        const meta = buildCaptureMeta(el, ev.clientX, ev.clientY, pointerType);

        pendingClickMeta.set(ev, {
          el,
          fp,
          preToggleState,
          overlaysBeforeClick,
          clickedInsideDialog,
          dismissedDuringPointerDown,
          button,
          rawDetail,
          modifiers,
          meta,
        });
        // Macrotask fallback in case a target listener calls ev.stopPropagation().
        setTimeout(() => finalizeClickCapture(ev), 0);
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'click',
      (ev) => {
        if (!ev.isTrusted) return;
        finalizeClickCapture(ev);
      },
      { capture: false, passive: true },
    );

    win.addEventListener(
      'input',
      (ev) => {
        if (!ev.isTrusted) return;
        const target = getEventRawTarget(ev);
        if (!isInputElement(target) && !isTextAreaElement(target) && !isSelectElement(target)) {
          return;
        }
        const rawEv = ev as Event & { inputType?: unknown; data?: unknown };
        const inputOp = typeof rawEv.inputType === 'string' ? rawEv.inputType : undefined;
        const insertedText = typeof rawEv.data === 'string' ? rawEv.data : undefined;
        const fp = buildFingerprint(target);
        sendCapture({
          kind: 'input',
          fingerprint: fp,
          value: target.value,
          checked: isInputElement(target) ? Boolean(target.checked) : undefined,
          inputType: isInputElement(target) ? target.type : getTagName(target),
          inputOp,
          insertedText,
          ...buildCaptureMeta(target),
        });
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'change',
      (ev) => {
        if (!ev.isTrusted) return;
        const target = getEventRawTarget(ev);
        if (!isSelectElement(target) && !isInputElement(target)) {
          return;
        }
        if (
          isInputElement(target) &&
          target.type !== 'checkbox' &&
          target.type !== 'radio' &&
          target.type !== 'range'
        ) {
          return;
        }
        sendCapture({
          kind: 'change',
          fingerprint: buildFingerprint(target),
          value: target.value,
          checked: isInputElement(target) ? Boolean(target.checked) : undefined,
          inputType: isInputElement(target) ? target.type : 'select',
          ...buildCaptureMeta(target),
        });
      },
      { capture: true, passive: true },
    );

    const rememberHeldKey = (
      codeKey: string,
      fp: ElementFingerprint,
      meta: ReturnType<typeof buildCaptureMeta>,
      key: string,
      code: string,
      sensitive: boolean,
    ) => {
      if (!codeKey) return;
      if (relayedHeldKeys.size >= 32 && !relayedHeldKeys.has(codeKey)) {
        const oldest = relayedHeldKeys.keys().next().value;
        if (oldest !== undefined) relayedHeldKeys.delete(oldest);
      }
      relayedHeldKeys.set(codeKey, { fp, meta, key, code, sensitive });
    };

    const releaseAllHeldKeys = () => {
      pendingKeyEventsByCode.clear();
      if (relayedHeldKeys.size === 0) return;
      const entries = Array.from(relayedHeldKeys.values());
      relayedHeldKeys.clear();
      for (const held of entries) {
        sendCapture({
          kind: 'keyup',
          fingerprint: held.fp,
          key: held.key,
          code: held.code,
          modifiers: [],
          sensitive: held.sensitive,
          ...held.meta,
        });
      }
    };

    const finalizePreventDefaultKey = (ev: KeyboardEvent) => {
      const normKey = ev.key === ' ' ? 'Space' : ev.key;
      const codeKey = ev.code || normKey;
      if (pendingKeyEventsByCode.get(codeKey) === ev) {
        pendingKeyEventsByCode.delete(codeKey);
      }
      if (pendingKeyEventsByCode.get(normKey) === ev) {
        pendingKeyEventsByCode.delete(normKey);
      }
      if (handledKeyEvents.has(ev)) return;
      const entry = pendingPreventDefaultKey.get(ev);
      if (!entry) return;
      handledKeyEvents.add(ev);
      pendingPreventDefaultKey.delete(ev);
      if (!ev.defaultPrevented && entry.inEditable) {
        // Observe on TabEventBus (redacted) via dedicated channel without emitting a mirror-capture!
        ipcRenderer.send('iron:key-observe', {
          kind: 'keydown',
          key: entry.key,
          code: entry.code,
          modifiers: entry.modifiers,
          repeat: entry.repeat,
          tag: getTagName(entry.el),
          sensitive: true,
        });
        return;
      }
      const fp: ElementFingerprint =
        entry.fp ?? { ...buildFingerprint(entry.el), ...entry.preIdent };
      const meta = entry.meta ?? buildCaptureMeta(entry.el);
      rememberHeldKey(entry.code || entry.key, fp, meta, entry.key, entry.code, entry.sensitive);
      sendCapture({
        kind: 'keydown',
        fingerprint: fp,
        key: entry.key,
        code: entry.code,
        modifiers: entry.modifiers,
        repeat: entry.repeat,
        holdUntilKeyup: true,
        sensitive: entry.sensitive,
        ...meta,
      });
    };

    win.addEventListener(
      'keydown',
      (ev) => {
        if (!ev.isTrusted || ev.isComposing) return;
        const relayKeys = new Set([
          'Enter',
          'Escape',
          'Tab',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Insert',
          'ContextMenu',
          'F1',
          'F2',
          'F3',
          'F4',
          'F5',
          'F6',
          'F7',
          'F8',
          'F9',
          'F10',
          'F11',
          'Space',
          ' ',
        ]);
        const bareModifiers = new Set([
          'Shift',
          'Control',
          'Alt',
          'Meta',
          'CapsLock',
          'NumLock',
          'ScrollLock',
          'Dead',
          'Process',
          'Unidentified',
        ]);
        const rawTarget = getEventRawTarget(ev);
        const activeDoc = win.document ?? doc;
        const targetNode = rawTarget ?? activeDoc.activeElement ?? document.activeElement;
        const isTextEditable = isEditableElement(targetNode);
        if (isTextEditable && (ev.key === ' ' || ev.key === 'Space')) {
          const spaceTag = isElementNode(targetNode) ? getTagName(targetNode) : 'input';
          ipcRenderer.send('iron:key-observe', {
            kind: 'keydown',
            key: 'Space',
            code: ev.code || 'Space',
            modifiers: getModifiers(ev),
            repeat: Boolean(ev.repeat),
            tag: spaceTag,
            sensitive: true,
          });
          return;
        }
        const inEditable = isTextEditable || isSelectElement(targetNode);
        const el = interactiveElement(targetNode);
        if (!el) return;
        const isPasswordField = isInputElement(el) && el.type.toLowerCase() === 'password';
        const sensitive = inEditable || isPasswordField;

        const isAlwaysRelayed = relayKeys.has(ev.key) || ev.ctrlKey || ev.metaKey || ev.altKey;
        if (!isAlwaysRelayed) {
          if (bareModifiers.has(ev.key)) return;
          // On trusted browser events, Blink drains microtasks right after the capture listener
          // (BEFORE target/bubble listeners like SolidJS Numpad's onKeyDown run). Inspect
          // ev.defaultPrevented in the bubble phase (+ macrotask fallback if stopPropagation()
          // was called). Pre-build full fingerprints only for non-editable or PIN/readOnly inputs
          // so ordinary text typing avoids DOM walks while pre-mutation identity is preserved.
          const shouldPrebuildFp =
            !inEditable ||
            el.getAttribute('inputmode') === 'none' ||
            (isInputElement(el) && el.readOnly);
          pendingPreventDefaultKey.set(ev, {
            el,
            fp: shouldPrebuildFp ? buildFingerprint(el) : null,
            meta: shouldPrebuildFp ? buildCaptureMeta(el) : null,
            preIdent: {
              testId: el.getAttribute('data-testid') || undefined,
              id: el.getAttribute('id') || undefined,
              ariaLabel: el.getAttribute('aria-label') || undefined,
              title: el.getAttribute('title') || undefined,
              name: el.getAttribute('name') || undefined,
              role: implicitRole(el) || undefined,
            },
            inEditable,
            sensitive,
            repeat: Boolean(ev.repeat),
            key: ev.key,
            code: ev.code,
            modifiers: getModifiers(ev),
          });
          const pendingCodeKey = ev.code || (ev.key === ' ' ? 'Space' : ev.key);
          pendingKeyEventsByCode.set(pendingCodeKey, ev);
          setTimeout(() => finalizePreventDefaultKey(ev), 0);
          return;
        }

        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Space') {
          recentActivationKey = {
            el,
            form: isElementNode(el) ? ((el as HTMLInputElement).form ?? null) : null,
            key: ev.key === ' ' ? 'Space' : ev.key,
            expiresAt: performance.now() + 800,
          };
        }
        const normalizedKey = ev.key === ' ' ? 'Space' : ev.key;
        const fp = buildFingerprint(el);
        const meta = buildCaptureMeta(el);
        rememberHeldKey(ev.code || normalizedKey, fp, meta, normalizedKey, ev.code, sensitive);
        sendCapture({
          kind: 'keydown',
          fingerprint: fp,
          key: normalizedKey,
          code: ev.code,
          modifiers: getModifiers(ev),
          repeat: Boolean(ev.repeat),
          holdUntilKeyup: true,
          sensitive,
          ...meta,
        });
      },
      { capture: true, passive: true },
    );

    win.addEventListener(
      'keydown',
      (ev) => {
        if (!ev.isTrusted) return;
        finalizePreventDefaultKey(ev);
      },
      { capture: false, passive: true },
    );

    win.addEventListener(
      'keyup',
      (ev) => {
        if (!ev.isTrusted) return;
        if ((ev.key === ' ' || ev.key === 'Space') && recentActivationKey) {
          recentActivationKey.expiresAt = performance.now() + 250;
        }
        const normalizedKey = ev.key === ' ' ? 'Space' : ev.key;
        const codeKey = ev.code || normalizedKey;
        const pendingDown =
          pendingKeyEventsByCode.get(codeKey) ?? pendingKeyEventsByCode.get(normalizedKey);
        if (pendingDown) {
          finalizePreventDefaultKey(pendingDown);
        }
        const held = relayedHeldKeys.get(codeKey) ?? relayedHeldKeys.get(normalizedKey);
        if (!held) return;
        relayedHeldKeys.delete(codeKey);
        relayedHeldKeys.delete(normalizedKey);
        sendCapture({
          kind: 'keyup',
          fingerprint: held.fp,
          key: normalizedKey,
          code: ev.code || held.code,
          modifiers: getModifiers(ev),
          sensitive: held.sensitive,
          ...held.meta,
        });
      },
      { capture: true, passive: true },
    );

    win.addEventListener('blur', releaseAllHeldKeys, { passive: true });
    doc.addEventListener(
      'visibilitychange',
      () => {
        if (doc.visibilityState === 'hidden') releaseAllHeldKeys();
      },
      { passive: true },
    );

    let wheelRafId: number | null = null;
    let pendingWheel: {
      el: Element;
      deltaX: number;
      deltaY: number;
      clientX: number;
      clientY: number;
    } | null = null;

    win.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.isTrusted) return;
        if (!Number.isFinite(ev.deltaX) || !Number.isFinite(ev.deltaY)) return;
        const rawTarget = getEventRawTarget(ev);
        const activeDoc = win.document ?? doc;
        const fallbackEl = activeDoc.documentElement ?? activeDoc.body ?? document.documentElement;
        const el = isElementNode(rawTarget) ? rawTarget : fallbackEl;
        if (!el) return;

        if (pendingWheel) {
          pendingWheel.el = el;
          pendingWheel.deltaX += ev.deltaX;
          pendingWheel.deltaY += ev.deltaY;
          pendingWheel.clientX = ev.clientX;
          pendingWheel.clientY = ev.clientY;
        } else {
          pendingWheel = {
            el,
            deltaX: ev.deltaX,
            deltaY: ev.deltaY,
            clientX: ev.clientX,
            clientY: ev.clientY,
          };
        }

        if (wheelRafId !== null) return;
        wheelRafId = win.requestAnimationFrame(() => {
          wheelRafId = null;
          const batch = pendingWheel;
          pendingWheel = null;
          if (!batch) return;
          sendCapture({
            kind: 'wheel',
            fingerprint: buildFingerprint(batch.el, batch.clientX, batch.clientY, batch.el),
            deltaX: batch.deltaX,
            deltaY: batch.deltaY,
            ...buildCaptureMeta(batch.el, batch.clientX, batch.clientY),
          });
        });
      },
      { capture: true, passive: true },
    );

    if (isTop) {
      let scrollPending = false;
      win.addEventListener(
        'scroll',
        (ev) => {
          // Only mirror top-level document scroll; ignore inner scrollable containers.
          if (
            ev.target !== document &&
            ev.target !== document.documentElement &&
            ev.target !== document.body
          ) {
            return;
          }
          if (suppressScrollCapture || scrollPending) return;
          scrollPending = true;
          win.requestAnimationFrame(() => {
            scrollPending = false;
            if (suppressScrollCapture) return;
            const docEl = document.documentElement;
            const maxScrollX = Math.max(0, docEl.scrollWidth - window.innerWidth);
            const maxScrollY = Math.max(0, docEl.scrollHeight - window.innerHeight);
            sendCapture({
              kind: 'scroll',
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              ratioX: maxScrollX > 0 ? window.scrollX / maxScrollX : 0,
              ratioY: maxScrollY > 0 ? window.scrollY / maxScrollY : 0,
            });
          });
        },
        { capture: true, passive: true },
      );
    }

  };

  const scanAddedForFramesOrShadow = (rootEl: Element): boolean => {
    let found = false;
    const stack: Element[] = [rootEl];
    let seen = 0;
    while (stack.length > 0 && seen < 200) {
      const cur = stack.pop()!;
      seen += 1;
      if (isIframeElement(cur)) found = true;
      const sr = (cur as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr && isShadowRootNode(sr)) {
        observeRootNode(sr);
        found = true;
      }
      const children = cur.children;
      if (children) {
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (child && isElementNode(child)) stack.push(child);
        }
      }
    }
    return found;
  };

  const rootObserver = new MutationObserver((mutations) => {
    let shouldAttach = false;
    for (const mut of mutations) {
      for (const added of Array.from(mut.addedNodes)) {
        if (!isElementNode(added)) continue;
        if (scanAddedForFramesOrShadow(added)) {
          shouldAttach = true;
        }
      }
    }
    if (shouldAttach) {
      attachPiercedFrames();
    }
  });

  const observeRootNode = (node: Node | null | undefined) => {
    if (!node || observedRoots.has(node)) return;
    observedRoots.add(node);
    try {
      rootObserver.observe(node, { childList: true, subtree: true });
    } catch {
      // Ignore if node is not observable yet.
    }
  };

  const attachPiercedFrames = () => {
    const roots = collectPiercedRoots(document);
    for (const r of roots) {
      attachWindowListeners(r.win, r.doc, r.doc === document);
      if (isShadowRootNode(r.root)) {
        observeRootNode(r.root);
      } else if (isDocumentNode(r.root)) {
        observeRootNode(r.root.documentElement ?? r.root);
      }
    }
  };

  attachWindowListeners(window, document, true);
  attachPiercedFrames();
  observeRootNode(document.documentElement ?? document);

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', attachPiercedFrames, { once: true });
  }
}

function setNativeRangeValue(el: HTMLInputElement, value: string): void {
  const win = getWindowOf(el) as Window & { HTMLInputElement?: typeof HTMLInputElement };
  const proto = win.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function inspectElementDeep(
  px: number,
  py: number,
): { element: Element; offsetX: number; offsetY: number } | null {
  let doc: Document = document;
  let localX = px;
  let localY = py;
  let offsetX = 0;
  let offsetY = 0;
  const visited = new WeakSet<Node>();

  for (let depth = 0; depth <= DOM_PIERCE_LIMITS.maxDepth; depth += 1) {
    const initialHit = doc.elementFromPoint(localX, localY);
    if (!initialHit) return null;
    let hit: Element = initialHit;

    // Drill into open Shadow DOMs at this point.
    let shadowDepth = depth;
    while (shadowDepth < DOM_PIERCE_LIMITS.maxDepth) {
      const sr: ShadowRoot | null | undefined = (
        hit as Element & { shadowRoot?: ShadowRoot | null }
      ).shadowRoot;
      if (!sr || visited.has(sr)) break;
      visited.add(sr);
      const inner: Element | null =
        typeof sr.elementFromPoint === 'function' ? sr.elementFromPoint(localX, localY) : null;
      if (!inner || inner === hit) break;
      hit = inner;
      shadowDepth += 1;
    }

    if (isIframeElement(hit)) {
      const childDoc = safeGetSameOriginIframeDoc(hit);
      if (childDoc && !visited.has(childDoc)) {
        visited.add(childDoc);
        const off = getIframeContentOffset(hit);
        offsetX += off.x;
        offsetY += off.y;
        localX -= off.x;
        localY -= off.y;
        doc = childDoc;
        continue;
      }
    }

    return { element: hit, offsetX, offsetY };
  }

  return null;
}

function setupDomQueryBridge(): void {
  ipcRenderer.on(
    'iron:dom-query',
    (
      _event,
      payload: {
        reqId: string;
        op: 'resolveTarget' | 'applyScroll' | 'focusInput' | 'layoutAudit' | 'inspectAtPoint';
        args: Record<string, unknown>;
      },
    ) => {
      const reply = (result: unknown) => {
        ipcRenderer.send('iron:dom-query-reply', { reqId: payload.reqId, result });
      };

      try {
        if (payload.op === 'resolveTarget') {
          const fp = payload.args.fingerprint as ElementFingerprint | undefined;
          const selector = payload.args.selector as string | undefined;
          const scrollIntoView = payload.args.scrollIntoView !== false;
          const focusTarget = payload.args.focusTarget === true;
          const useElementRel = payload.args.useElementRel === true;

          const resolved = fp
            ? resolveElementFromFingerprint(fp, selector)
            : (() => {
                const match = selector ? safeQuerySelectorAll(selector)[0] ?? null : null;
                return {
                  element: match?.element ?? null,
                  tier: 2 as const,
                  rootMeta: match?.rootMeta,
                };
              })();

          // If the source click dismissed a modal/dialog (e.g. Kobalte/Radix onPointerDownOutside
          // unmounting the backdrop so click landed on <body> or an animated portal), click an
          // uncovered point outside the paired viewport's active dialog. If the paired viewport
          // has no active dialog (already closed), return found:false instead of falling through
          // to click document.body / arbitrary page center UI.
          if (fp?.dismissedOverlay) {
            const outside = findPointOutsideDialogs();
            if (outside) {
              reply({
                found: true,
                tier: 2,
                x: outside.x,
                y: outside.y,
                isCanvas: false,
                tag: 'overlay-outside',
              });
              return;
            }
            reply({ found: false, tier: 2, x: 0, y: 0, isCanvas: false });
            return;
          }

          if (resolved.element) {
            if (scrollIntoView && !fp?.dismissedOverlay) {
              resolved.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            if (focusTarget) {
              try {
                (resolved.element as HTMLElement).focus?.();
              } catch {
                // Ignore non-focusable targets.
              }
            }

            const rect = resolved.element.getBoundingClientRect();
            const offsetX = resolved.rootMeta?.offsetX ?? 0;
            const offsetY = resolved.rootMeta?.offsetY ?? 0;
            const isCanvas = getTagName(resolved.element) === 'canvas';
            const isSlider = implicitRole(resolved.element) === 'slider';

            let pt: { x: number; y: number };
            if (isCanvas) {
              pt = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
            } else if (
              (useElementRel || isSlider) &&
              fp?.elemRelX !== undefined &&
              fp?.elemRelY !== undefined &&
              Number.isFinite(fp.elemRelX) &&
              Number.isFinite(fp.elemRelY)
            ) {
              const cx = Math.min(Math.max(fp.elemRelX, 0), 1);
              const cy = Math.min(Math.max(fp.elemRelY, 0), 1);
              pt = {
                x: Math.round(rect.left + cx * rect.width),
                y: Math.round(rect.top + cy * rect.height),
              };
            } else {
              pt = findClickablePoint(resolved.element, rect, fp);
            }

            let x = pt.x + offsetX;
            let y = pt.y + offsetY;

            if (isCanvas && fp?.normalizedX !== undefined && fp?.normalizedY !== undefined) {
              const mapped = mapNormalizedPoint(fp.normalizedX, fp.normalizedY, {
                x: rect.left + offsetX,
                y: rect.top + offsetY,
                width: rect.width,
                height: rect.height,
              });
              if (mapped) {
                x = mapped.x;
                y = mapped.y;
              }
            }

            reply({
              found: true,
              tier: resolved.tier,
              x,
              y,
              isCanvas,
              tag: getTagName(resolved.element),
              toggleState: extractElementToggleState(resolved.element),
              rect: {
                x: rect.left + offsetX,
                y: rect.top + offsetY,
                width: rect.width,
                height: rect.height,
              },
            });
            return;
          }

          if (fp && fp.isCanvas) {
            const fallback = mapNormalizedPoint(fp.relViewportX, fp.relViewportY, {
              x: 0,
              y: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            });
            reply({
              found: Boolean(fallback),
              tier: 3,
              x: fallback?.x ?? 0,
              y: fallback?.y ?? 0,
              isCanvas: true,
              tag: fp.tag,
            });
            return;
          }

          reply({ found: false, tier: 2, x: 0, y: 0, isCanvas: false });
          return;
        }

        if (payload.op === 'applyScroll') {
          const ratioX = Number(payload.args.ratioX ?? 0);
          const ratioY = Number(payload.args.ratioY ?? 0);
          const doc = document.documentElement;
          const maxX = Math.max(0, doc.scrollWidth - window.innerWidth);
          const maxY = Math.max(0, doc.scrollHeight - window.innerHeight);
          const targetX = computeProportionalScroll(ratioX, 1, maxX);
          const targetY = computeProportionalScroll(ratioY, 1, maxY);

          suppressScrollCapture = true;
          window.scrollTo({ left: targetX, top: targetY, behavior: 'instant' });
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              suppressScrollCapture = false;
            });
          });
          reply({ ok: true, x: targetX, y: targetY });
          return;
        }

        if (payload.op === 'focusInput') {
          const fp = payload.args.fingerprint as ElementFingerprint;
          const selectValue = payload.args.selectValue as string | undefined;
          const checked = payload.args.checked as boolean | undefined;
          const resolved = resolveElementFromFingerprint(fp);
          const el = resolved.element;
          const offsetX = resolved.rootMeta?.offsetX ?? 0;
          const offsetY = resolved.rootMeta?.offsetY ?? 0;

          if (isSelectElement(el)) {
            el.focus();
            if (selectValue !== undefined && el.value !== selectValue) {
              el.value = selectValue;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            reply({ ok: true, found: true, handledDirectly: true, tag: 'select' });
            return;
          }

          if (isInputElement(el) || isTextAreaElement(el)) {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            el.focus();
            const rect = el.getBoundingClientRect();
            const x = Math.round(rect.left + rect.width / 2 + offsetX);
            const y = Math.round(rect.top + rect.height / 2 + offsetY);

            if (isInputElement(el) && el.type.toLowerCase() === 'range') {
              if (selectValue !== undefined && el.value !== selectValue) {
                setNativeRangeValue(el, selectValue);
              }
              reply({ ok: true, found: true, handledDirectly: true, x, y, tag: 'input' });
              return;
            }

            if (
              isInputElement(el) &&
              (el.type.toLowerCase() === 'checkbox' || el.type.toLowerCase() === 'radio')
            ) {
              reply({
                ok: true,
                found: true,
                needsClick: checked !== undefined ? Boolean(el.checked) !== checked : true,
                x,
                y,
                tag: 'input',
              });
              return;
            }

            reply({
              ok: true,
              found: true,
              needsClick: false,
              currentValue: el.value,
              x,
              y,
              tag: getTagName(el),
            });
            return;
          }

          reply({ ok: false, found: false });
          return;
        }

        if (payload.op === 'inspectAtPoint') {
          const px = Number(payload.args.x ?? 0);
          const py = Number(payload.args.y ?? 0);
          const hit = inspectElementDeep(px, py);
          if (!hit) {
            reply({ found: false });
            return;
          }
          const raw = hit.element;
          const el = interactiveElement(raw) ?? raw;
          const ctx = getElementFrameContext(el);
          const fp = buildFingerprint(el, px - ctx.offsetX, py - ctx.offsetY, raw);
          const candidates = buildSelectorCandidates(fp);
          const bestSelector = candidates.find((c) => c.selector)?.selector ?? fp.cssPath;
          const safeHtml = redactOuterHtml(el.outerHTML);
          const outerHtml = safeHtml.length > 2000 ? `${safeHtml.slice(0, 2000)}…` : safeHtml;
          const rect = el.getBoundingClientRect();
          reply({
            found: true,
            selector: bestSelector,
            outerHtml,
            fingerprint: fp,
            x: Math.round(rect.left + rect.width / 2 + ctx.offsetX),
            y: Math.round(rect.top + rect.height / 2 + ctx.offsetY),
            tag: getTagName(el),
          });
          return;
        }

        if (payload.op === 'layoutAudit') {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const dpr = window.devicePixelRatio || 1;
          const doc = document.documentElement;
          const scrollWidth = doc.scrollWidth;
          const scrollHeight = doc.scrollHeight;
          const horizontalOverflow = scrollWidth > vw + 1;
          let clippedElements = 0;
          const clippedItems: Array<{
            selector: string;
            tag: string;
            text: string;
            bounds: { x: number; y: number; width: number; height: number };
            overflowPx: { left: number; right: number };
          }> = [];
          const roots = collectPiercedRoots(document);
          const candidates = safeQuerySelectorAll(
            'button, a[href], input, select, textarea, [role="button"], [role="slider"], [data-testid]',
            roots,
          );
          const seenElements = new Set<Element>();
          for (const entry of candidates.slice(0, 250)) {
            const el = entry.element;
            if (seenElements.has(el)) continue;
            if (el.id === '__iron_clipped_highlight_root__' || el.closest?.('#__iron_clipped_highlight_root__')) {
              continue;
            }
            seenElements.add(el);
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const left = r.left + entry.rootMeta.offsetX;
            const right = r.right + entry.rootMeta.offsetX;
            const top = r.top + entry.rootMeta.offsetY;
            if (right > vw + 2 || left < -2) {
              clippedElements += 1;
              if (clippedItems.length < 50) {
                const tag = getTagName(el);
                const fp = buildFingerprint(el);
                const bestCandidate = buildSelectorCandidates(fp).find((c) => Boolean(c.selector));
                const selector = bestCandidate?.selector ?? fp.cssPath;
                const sensitive =
                  tag === 'canvas' ||
                  isInputElement(el) ||
                  isTextAreaElement(el) ||
                  isSelectElement(el) ||
                  isEditableElement(el);
                const text = sensitive ? '' : normalizeText(el.textContent, 80);
                clippedItems.push({
                  selector,
                  tag,
                  text,
                  bounds: {
                    x: Math.round(left),
                    y: Math.round(top),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                  },
                  overflowPx: {
                    left: Math.max(0, Math.round(-left)),
                    right: Math.max(0, Math.round(right - vw)),
                  },
                });
              }
            }
          }
          reply({
            viewportWidth: vw,
            viewportHeight: vh,
            dpr,
            scrollWidth,
            scrollHeight,
            horizontalOverflow,
            clippedElements,
            clippedItems,
            canvasCount: safeQuerySelectorAll('canvas', roots).length,
          });
          return;
        }

        if (payload.op === 'setClippedHighlight') {
          const existing = document.getElementById('__iron_clipped_highlight_root__');
          if (existing) existing.remove();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const rawItems = Array.isArray(payload.args.items) ? payload.args.items : [];
          const container = document.createElement('div');
          container.id = '__iron_clipped_highlight_root__';
          container.setAttribute('aria-hidden', 'true');
          container.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
          let highlightedCount = 0;
          for (const rawItem of rawItems.slice(0, 50)) {
            if (!rawItem || typeof rawItem !== 'object') continue;
            const rec = rawItem as {
              selector?: string;
              bounds?: { x?: number; y?: number; width?: number; height?: number };
            };
            const b = rec.bounds;
            if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.width !== 'number' || typeof b.height !== 'number') {
              continue;
            }
            const clampedLeft = Math.max(0, Math.min(vw - 4, b.x));
            const clampedRight = Math.max(clampedLeft + 4, Math.min(vw, b.x + b.width));
            const clampedTop = Math.max(0, Math.min(vh - 4, b.y));
            const clampedBottom = Math.max(clampedTop + 4, Math.min(vh, b.y + b.height));
            const box = document.createElement('div');
            box.style.cssText = [
              'position:fixed',
              `left:${clampedLeft}px`,
              `top:${clampedTop}px`,
              `width:${Math.max(4, clampedRight - clampedLeft)}px`,
              `height:${Math.max(4, clampedBottom - clampedTop)}px`,
              'border:2px solid #ff2e63',
              'background:rgba(255,46,99,0.16)',
              'box-sizing:border-box',
              'pointer-events:none',
            ].join(';');
            container.appendChild(box);
            highlightedCount += 1;
          }
          (document.body ?? document.documentElement)?.appendChild(container);
          reply({ ok: true, highlightedCount });
          return;
        }

        if (payload.op === 'clearClippedHighlight') {
          const existing = document.getElementById('__iron_clipped_highlight_root__');
          if (existing) existing.remove();
          reply({ ok: true });
          return;
        }

        if (payload.op === 'traceStart') {
          reply(startActivePerfTrace(payload.args ?? {}));
          return;
        }

        if (payload.op === 'traceStop') {
          reply(stopActivePerfTrace());
          return;
        }

        reply({ ok: false, error: 'unknown op' });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}

function setupWsMuxBridge(): void {
  if (window !== window.top) return;

  const RETIRING_PORT_GRACE_MS = 500;
  let activePort: MessagePort | null = null;
  const retiringPorts = new Map<MessagePort, ReturnType<typeof setTimeout>>();

  const closePort = (port: MessagePort) => {
    const timer = retiringPorts.get(port);
    if (timer !== undefined) {
      clearTimeout(timer);
      retiringPorts.delete(port);
    }
    try {
      port.onmessage = null;
      port.close();
    } catch {
      // Ignore already-closed port.
    }
  };

  const flushRetiringPorts = () => {
    for (const port of Array.from(retiringPorts.keys())) {
      closePort(port);
    }
  };

  const retirePort = (port: MessagePort) => {
    if (retiringPorts.has(port)) return;
    const timer = setTimeout(() => {
      closePort(port);
    }, RETIRING_PORT_GRACE_MS);
    retiringPorts.set(port, timer);
  };

  const closeAllPorts = () => {
    flushRetiringPorts();
    if (!activePort) return;
    const cur = activePort;
    activePort = null;
    closePort(cur);
  };

  const issueMuxPort = () => {
    if (activePort) {
      retirePort(activePort);
    }
    const ch = new MessageChannel();
    const port = ch.port1;
    activePort = port;
    port.onmessage = (portEv) => {
      if (activePort === port) {
        flushRetiringPorts();
      }
      ipcRenderer.send('iron:ws-mux:to-main', portEv.data);
    };
    port.start?.();
    window.postMessage({ type: '__iron_ws_mux_init__' }, '*', [ch.port2]);
  };

  ipcRenderer.on('iron:ws-mux:to-renderer', (_ev, msg) => {
    if (!activePort) return;
    try {
      activePort.postMessage(msg);
    } catch {
      // Ignore closed/disposed port.
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || typeof ev.data !== 'object') return;
    if ((ev.data as { type?: unknown }).type === '__iron_ws_mux_ready__') {
      issueMuxPort();
    }
  });

  window.addEventListener('pagehide', closeAllPorts);
  window.addEventListener('unload', closeAllPorts);
  issueMuxPort();
}

function setupRafMonitor(): void {
  const BURST_INTERVAL_MS = 2000;
  const BURST_TARGET_SAMPLES = 15;
  const BURST_MIN_DURATION_MS = 250;
  const BURST_MAX_DURATION_MS = 550;
  const RING_MAX = 30;

  const ring: number[] = [];
  let lastTs = 0;
  let burstStartTs = 0;
  let burstSamples = 0;
  let rafId: number | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const clearBurstTimer = () => {
    if (burstTimer !== null) {
      clearTimeout(burstTimer);
      burstTimer = null;
    }
  };

  const stopBurst = () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    clearBurstTimer();
    lastTs = 0;
  };

  const emitStats = () => {
    if (ring.length === 0) return;
    const stats = computeFrameStats(ring);
    ipcRenderer.send('iron:raf-stats', {
      ...stats,
      recentFrameMs: ring.slice(-24).map((v) => Math.round(v * 10) / 10),
    });
  };

  const tick = (now: number) => {
    if (document.visibilityState !== 'visible') {
      stopBurst();
      return;
    }
    if (lastTs === 0) {
      lastTs = now;
      burstStartTs = now;
      rafId = window.requestAnimationFrame(tick);
      return;
    }
    const dt = now - lastTs;
    lastTs = now;
    if (dt > 0 && dt < 2000) {
      ring.push(dt);
      if (ring.length > RING_MAX) ring.shift();
      burstSamples += 1;
    }

    const elapsed = now - burstStartTs;
    if (
      (burstSamples >= BURST_TARGET_SAMPLES && elapsed >= BURST_MIN_DURATION_MS) ||
      elapsed >= BURST_MAX_DURATION_MS
    ) {
      rafId = null;
      lastTs = 0;
      emitStats();
      clearBurstTimer();
      burstTimer = setTimeout(startBurst, BURST_INTERVAL_MS);
      return;
    }

    rafId = window.requestAnimationFrame(tick);
  };

  const startBurst = () => {
    clearBurstTimer();
    if (document.visibilityState !== 'visible' || rafId !== null) return;
    lastTs = 0;
    burstSamples = 0;
    burstStartTs = 0;
    rafId = window.requestAnimationFrame(tick);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startBurst();
    } else {
      stopBurst();
    }
  });
  window.addEventListener('pagehide', stopBurst);
  window.addEventListener('pageshow', () => {
    if (document.visibilityState === 'visible') startBurst();
  });
  window.addEventListener('unload', stopBurst);

  if (document.readyState === 'loading') {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        if (document.visibilityState === 'visible') startBurst();
      },
      { once: true },
    );
  } else if (document.visibilityState === 'visible') {
    startBurst();
  }
}

interface ActivePerfTraceState {
  traceId: string;
  startPerfNow: number;
  maxFrames: number;
  maxMarks: number;
  samplingMode: 'raf' | 'timer-fallback';
  frames: Array<{ tMs: number; dtMs: number }>;
  marks: Array<{ entryType: 'mark' | 'measure'; name: string; startTimeMs: number; durationMs: number }>;
  seenMarkKeys: Set<string>;
  rafId: number | null;
  fallbackTimer: ReturnType<typeof setInterval> | null;
  autoStopTimer: ReturnType<typeof setTimeout> | null;
  observer: PerformanceObserver | null;
  stopped: boolean;
  stoppedAtPerfNow: number | null;
}

let activePerfTrace: ActivePerfTraceState | null = null;

function recordPerfEntry(
  st: ActivePerfTraceState,
  entryType: 'mark' | 'measure',
  name: string,
  startTime: number,
  duration: number,
): void {
  if (startTime < st.startPerfNow - 1) return;
  const relStart = Math.max(0, Math.round((startTime - st.startPerfNow) * 10) / 10);
  const relDur = Math.max(0, Math.round((duration || 0) * 10) / 10);
  const safeName = normalizeText(name, 120) || entryType;
  const dedupKey = `${entryType}:${safeName}:${relStart}:${relDur}`;
  if (st.seenMarkKeys.has(dedupKey)) return;
  st.seenMarkKeys.add(dedupKey);
  st.marks.push({
    entryType,
    name: safeName,
    startTimeMs: relStart,
    durationMs: relDur,
  });
  if (st.marks.length > st.maxMarks) {
    st.marks.shift();
  }
}

function cleanupPerfTraceHandles(st: ActivePerfTraceState): void {
  if (st.rafId !== null) {
    window.cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }
  if (st.fallbackTimer !== null) {
    clearInterval(st.fallbackTimer);
    st.fallbackTimer = null;
  }
  if (st.autoStopTimer !== null) {
    clearTimeout(st.autoStopTimer);
    st.autoStopTimer = null;
  }
  if (st.observer !== null) {
    try {
      st.observer.disconnect();
    } catch {
      // Ignore observer disconnect errors.
    }
    st.observer = null;
  }
}

function startActivePerfTrace(args: Record<string, unknown>): Record<string, unknown> {
  if (activePerfTrace) {
    cleanupPerfTraceHandles(activePerfTrace);
    activePerfTrace = null;
  }

  const traceId = typeof args.traceId === 'string' && args.traceId ? args.traceId : `trace-${Date.now()}`;
  const maxFrames = Math.min(Math.max(Number(args.maxFrames) || 1800, 60), 3600);
  const maxMarks = Math.min(Math.max(Number(args.maxMarks) || 256, 16), 512);
  const maxDurationMs = Math.min(Math.max(Number(args.maxDurationMs) || 30_000, 100), 30_000);
  const startPerfNow = performance.now();
  const isVisible = document.visibilityState === 'visible';

  const st: ActivePerfTraceState = {
    traceId,
    startPerfNow,
    maxFrames,
    maxMarks,
    samplingMode: isVisible ? 'raf' : 'timer-fallback',
    frames: [],
    marks: [],
    seenMarkKeys: new Set(),
    rafId: null,
    fallbackTimer: null,
    autoStopTimer: null,
    observer: null,
    stopped: false,
    stoppedAtPerfNow: null,
  };

  let lastFrameNow = startPerfNow;
  const pushFrame = (now: number) => {
    if (st.stopped) return;
    const dt = now - lastFrameNow;
    lastFrameNow = now;
    if (dt > 0 && dt < 5000) {
      st.frames.push({
        tMs: Math.max(0, Math.round((now - st.startPerfNow) * 10) / 10),
        dtMs: Math.round(dt * 10) / 10,
      });
      if (st.frames.length > st.maxFrames) {
        st.frames.shift();
      }
    }
  };

  const rafStep = (now: number) => {
    if (st.stopped) return;
    st.samplingMode = 'raf';
    pushFrame(now);
    st.rafId = window.requestAnimationFrame(rafStep);
  };
  st.rafId = window.requestAnimationFrame(rafStep);

  // If the window is hidden (e.g. --smoke headless testing where compositor pauses rAF),
  // maintain a 16ms timer fallback that yields automatically as soon as real rAF ticks arrive.
  let lastObservedCount = 0;
  st.fallbackTimer = setInterval(() => {
    if (st.stopped) return;
    if (st.frames.length > lastObservedCount && st.samplingMode === 'raf') {
      lastObservedCount = st.frames.length;
      return;
    }
    if (document.visibilityState !== 'visible' || st.frames.length === 0) {
      st.samplingMode = 'timer-fallback';
      pushFrame(performance.now());
      lastObservedCount = st.frames.length;
    }
  }, 16);

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'mark' || entry.entryType === 'measure') {
            recordPerfEntry(st, entry.entryType, entry.name, entry.startTime, entry.duration);
          }
        }
      });
      obs.observe({ entryTypes: ['mark', 'measure'] });
      st.observer = obs;
    } catch {
      // Fallback to performance.getEntriesByType on stop.
    }
  }

  st.autoStopTimer = setTimeout(() => {
    st.stopped = true;
    st.stoppedAtPerfNow = performance.now();
    cleanupPerfTraceHandles(st);
  }, maxDurationMs);

  activePerfTrace = st;
  return {
    ok: true,
    traceId,
    visibilityState: document.visibilityState,
    samplingMode: st.samplingMode,
  };
}

function stopActivePerfTrace(): Record<string, unknown> {
  const st = activePerfTrace;
  if (!st) {
    return { ok: false, error: 'no active performance trace on viewport' };
  }
  activePerfTrace = null;
  const endPerfNow = st.stoppedAtPerfNow ?? performance.now();
  st.stopped = true;
  cleanupPerfTraceHandles(st);

  try {
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.startTime <= endPerfNow + 1) {
        recordPerfEntry(st, 'mark', entry.name, entry.startTime, entry.duration);
      }
    }
    for (const entry of performance.getEntriesByType('measure')) {
      if (entry.startTime <= endPerfNow + 1) {
        recordPerfEntry(st, 'measure', entry.name, entry.startTime, entry.duration);
      }
    }
  } catch {
    // Ignore User Timing lookup errors.
  }

  const marksOnly = st.marks.filter((m) => m.entryType === 'mark');
  const measuresOnly = st.marks.filter((m) => m.entryType === 'measure');

  return {
    ok: true,
    traceId: st.traceId,
    durationMs: Math.max(0, Math.round((endPerfNow - st.startPerfNow) * 10) / 10),
    visibilityState: document.visibilityState,
    samplingMode: st.samplingMode,
    frames: st.frames,
    marks: marksOnly,
    measures: measuresOnly,
  };
}

if (window === window.top) {
  setupWsMuxBridge();
  setupCaptureListeners();
  setupDomQueryBridge();
  setupRafMonitor();
}
