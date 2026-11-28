import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import vm from 'node:vm';

/**
 * In-memory transpile of `src/preload/mirror-preload.ts` (zero coupling to `dist/`)
 * executed inside `node:vm` with Blink-accurate per-listener microtask checkpoints:
 * capture listeners run -> microtasks drain -> target handler runs -> bubble listeners run.
 */
async function loadPreloadInVm() {
  const entryPath = path.join(import.meta.dir, '..', 'src', 'preload', 'mirror-preload.ts');
  const build = await Bun.build({
    entrypoints: [entryPath],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (!build.success || build.outputs.length === 0) {
    throw new Error(`Failed to transpile mirror-preload.ts: ${build.logs.map(String).join('\n')}`);
  }
  const bundleCode = await build.outputs[0]!.text();

  const sent: Array<{ channel: string; payload: any }> = [];
  const domQueryHandlers: Array<(ev: unknown, payload: any) => void> = [];

  type ListenerEntry = { fn: (ev: any) => void; capture: boolean };
  const winListeners = new Map<string, ListenerEntry[]>();

  const makeElement = (opts: {
    tag: string;
    attrs?: Record<string, string>;
    rect?: { left: number; top: number; width: number; height: number };
    children?: any[];
    parent?: any;
    closestMatch?: (sel: string) => any;
    isConnected?: boolean;
  }) => {
    const attrs = new Map<string, string>(Object.entries(opts.attrs ?? {}));
    const rect = opts.rect ?? { left: 10, top: 10, width: 100, height: 40 };
    const el: any = {
      nodeType: 1,
      tagName: opts.tag.toUpperCase(),
      isConnected: opts.isConnected ?? true,
      children: opts.children ?? [],
      parentElement: opts.parent ?? null,
      classList: [],
      textContent: '',
      outerHTML: `<${opts.tag}/>`,
      value: '',
      type: attrs.get('type') ?? 'text',
      getAttribute: (k: string) => attrs.get(k) ?? null,
      hasAttribute: (k: string) => attrs.has(k),
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      getBoundingClientRect: () => ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
      }),
      getRootNode: () => fakeDocument,
      closest: (sel: string) => (opts.closestMatch ? opts.closestMatch(sel) : null),
      contains: (other: any) => other === el || (opts.children ?? []).includes(other),
      scrollIntoView: () => {},
      focus: () => {},
    };
    return el;
  };

  const pinInput = makeElement({
    tag: 'input',
    attrs: { 'aria-label': 'PIN', type: 'text', inputmode: 'none' },
    rect: { left: 0, top: 0, width: 1, height: 1 },
    closestMatch: (sel) => (sel.includes('input') ? pinInput : null),
  });

  const textInput = makeElement({
    tag: 'input',
    attrs: { 'aria-label': 'Order note', type: 'text' },
    rect: { left: 10, top: 40, width: 160, height: 32 },
    closestMatch: (sel) => (sel.includes('input') ? textInput : null),
  });

  const countrySelect = makeElement({
    tag: 'select',
    attrs: { id: 'country' },
    rect: { left: 10, top: 80, width: 160, height: 32 },
    closestMatch: (sel) => (sel.includes('select') ? countrySelect : null),
  });

  const dialogCard = makeElement({
    tag: 'div',
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    rect: { left: 100, top: 100, width: 300, height: 200 },
    closestMatch: (sel) => (sel.includes('role="dialog"') ? dialogCard : null),
  });

  const innerCloseBtn = makeElement({
    tag: 'button',
    attrs: { 'aria-label': 'Close' },
    rect: { left: 360, top: 110, width: 30, height: 30 },
    parent: dialogCard,
    closestMatch: (sel) => {
      if (sel.includes('role="dialog"')) return dialogCard;
      if (sel.includes('button')) return innerCloseBtn;
      return null;
    },
  });
  dialogCard.children = [innerCloseBtn];

  const nativeDialog = makeElement({
    tag: 'dialog',
    attrs: { open: '' },
    rect: { left: 200, top: 150, width: 320, height: 240 },
    closestMatch: (sel) => (sel.includes('dialog[open]') ? nativeDialog : null),
  });

  const backdrop = makeElement({
    tag: 'div',
    rect: { left: 0, top: 0, width: 1280, height: 720 },
    children: [dialogCard],
  });
  dialogCard.parentElement = backdrop;

  const fakeBody = makeElement({
    tag: 'body',
    rect: { left: 0, top: 0, width: 1280, height: 720 },
    children: [pinInput, textInput, countrySelect, backdrop, nativeDialog],
  });
  backdrop.parentElement = fakeBody;
  nativeDialog.parentElement = fakeBody;

  let activeDialogMode: 'none' | 'kobalte' | 'native' = 'kobalte';
  let querySelectorAllCount = 0;
  const fakeDocument: any = {
    nodeType: 9,
    readyState: 'complete',
    visibilityState: 'hidden',
    body: fakeBody,
    documentElement: fakeBody,
    activeElement: pinInput,
    children: [fakeBody],
    addEventListener: () => {},
    querySelectorAll: (sel: string) => {
      querySelectorAllCount += 1;
      if (sel.includes('role="dialog"') || sel.includes('dialog[open]')) {
        if (activeDialogMode === 'kobalte') return [dialogCard];
        if (activeDialogMode === 'native') return [nativeDialog];
        return [];
      }
      if (sel.includes('aria-label="PIN"')) return [pinInput];
      if (sel.includes('aria-label="Order note"')) return [textInput];
      if (sel === 'body') return [fakeBody];
      if (sel.includes('aria-label="Close"')) return activeDialogMode === 'kobalte' ? [innerCloseBtn] : [];
      return [];
    },
    elementFromPoint: (x: number, y: number) => {
      if (activeDialogMode === 'kobalte') {
        if (x >= 100 && x <= 400 && y >= 100 && y <= 300) return dialogCard;
        return backdrop;
      }
      if (activeDialogMode === 'native') {
        // Native <dialog open> showModal() targets <dialog> itself even on ::backdrop clicks!
        return nativeDialog;
      }
      return fakeBody;
    },
  };
  for (const el of [
    fakeBody,
    pinInput,
    textInput,
    countrySelect,
    dialogCard,
    innerCloseBtn,
    backdrop,
    nativeDialog,
  ]) {
    el.ownerDocument = fakeDocument;
  }

  let nowMs = 10_000;
  const scheduledTimers: Array<{ id: number; dueAt: number; fn: () => void; cleared: boolean }> = [];
  let nextTimerId = 1;

  const fakeWindow: any = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    document: fakeDocument,
    location: { origin: 'http://localhost:3000' },
    origin: 'http://localhost:3000',
    addEventListener: (type: string, fn: (ev: any) => void, opts?: boolean | { capture?: boolean }) => {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      const list = winListeners.get(type) ?? [];
      list.push({ fn, capture });
      winListeners.set(type, list);
    },
    postMessage: () => {},
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  fakeWindow.top = fakeWindow;
  fakeDocument.defaultView = fakeWindow;

  const fakeElectron = {
    ipcRenderer: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
      on: (channel: string, handler: (ev: unknown, payload: any) => void) => {
        if (channel === 'iron:dom-query') domQueryHandlers.push(handler);
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    window: fakeWindow,
    document: fakeDocument,
    MutationObserver: fakeWindow.MutationObserver,
    MessageChannel: class {
      port1 = { onmessage: null, start() {}, postMessage() {}, close() {} };
      port2 = {};
    },
    performance: { now: () => nowMs },
    queueMicrotask,
    setTimeout: (fn: () => void, ms = 0) => {
      const id = nextTimerId++;
      scheduledTimers.push({ id, dueAt: nowMs + Math.max(0, ms), fn, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const t = scheduledTimers.find((item) => item.id === id);
      if (t) t.cleared = true;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    URL,
    console,
    module: { exports: {} },
    exports: {},
    require: (id: string) => {
      if (id === 'electron') return fakeElectron;
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(bundleCode, ctx, { filename: 'mirror-preload.ts' });

  const drainMicrotasks = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  const advanceTime = async (ms: number) => {
    nowMs += ms;
    while (true) {
      const ready = scheduledTimers
        .filter((t) => !t.cleared && t.dueAt <= nowMs)
        .sort((a, b) => a.dueAt - b.dueAt);
      if (ready.length === 0) break;
      const next = ready[0]!;
      next.cleared = true;
      next.fn();
      await drainMicrotasks();
    }
  };

  /**
   * Dispatches a trusted browser event with Blink's real per-listener microtask checkpoint:
   * 1. Capture listeners run -> microtasks drain (BEFORE target handler!)
   * 2. Target handler runs (may call ev.preventDefault() / ev.stopPropagation()) -> microtasks drain
   * 3. Bubble listeners run (unless stopPropagation() was called) -> microtasks drain
   */
  const dispatchBlinkEvent = async (
    type: string,
    baseEv: Record<string, unknown>,
    targetHandler?: (ev: any) => void,
  ) => {
    let propagationStopped = false;
    const ev: any = {
      isTrusted: true,
      defaultPrevented: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        propagationStopped = true;
      },
      ...baseEv,
    };

    const listeners = winListeners.get(type) ?? [];
    for (const entry of listeners) {
      if (!entry.capture) continue;
      entry.fn(ev);
      await drainMicrotasks(); // Real Blink checkpoint right after capture listener!
    }
    if (targetHandler) {
      targetHandler(ev);
      await drainMicrotasks();
    }
    if (!propagationStopped) {
      for (const entry of listeners) {
        if (entry.capture) continue;
        entry.fn(ev);
        await drainMicrotasks();
      }
    }
  };

  return {
    sent,
    domQueryHandlers,
    pinInput,
    textInput,
    countrySelect,
    dialogCard,
    innerCloseBtn,
    nativeDialog,
    backdrop,
    fakeBody,
    fakeDocument,
    getQuerySelectorAllCount: () => querySelectorAllCount,
    resetQuerySelectorAllCount: () => {
      querySelectorAllCount = 0;
    },
    setDialogMode: (mode: 'none' | 'kobalte' | 'native') => {
      activeDialogMode = mode;
    },
    dispatchBlinkEvent,
    advanceTime,
  };
}

describe('mirror-preload PIN keydown & Kobalte/native dialog dismissal regressions', () => {
  test('captures preventDefault PIN digits/Backspace AFTER Blink capture-phase microtask checkpoint (both bubbling and stopPropagation)', async () => {
    const env = await loadPreloadInVm();

    // Bubbling Numpad handler (SolidJS delegated listener): sets preventDefault AFTER capture listener!
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '7', code: 'Digit7', target: env.pinInput },
      (ev) => ev.preventDefault(),
    );
    await env.dispatchBlinkEvent(
      'keydown',
      { key: 'Backspace', code: 'Backspace', target: env.pinInput },
      (ev) => ev.preventDefault(),
    );

    // Target handler calling BOTH preventDefault() AND stopPropagation() -> caught by macrotask fallback!
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '3', code: 'Digit3', target: env.pinInput },
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      },
    );
    await env.advanceTime(1);

    // Regular text typing (defaultPrevented stays false) and IME composing MUST NOT emit keydown
    // AND ordinary <input> typing must perform zero full-DOM querySelectorAll walks!
    env.resetQuerySelectorAllCount();
    await env.dispatchBlinkEvent('keydown', { key: 'a', code: 'KeyA', target: env.textInput });
    await env.dispatchBlinkEvent('keydown', { key: 'b', code: 'KeyB', target: env.textInput });
    expect(env.getQuerySelectorAllCount()).toBe(0);

    // <select> typeahead (defaultPrevented === false) and IME 'Process' must NOT emit duplicate keydown!
    await env.dispatchBlinkEvent('keydown', { key: 'u', code: 'KeyU', target: env.countrySelect });
    await env.dispatchBlinkEvent(
      'keydown',
      { key: 'Process', code: 'Digit5', target: env.pinInput },
      (ev) => ev.preventDefault(),
    );
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '5', code: 'Digit5', isComposing: true, target: env.pinInput },
      (ev) => ev.preventDefault(),
    );
    await env.advanceTime(1);

    // Synchronous attribute mutation inside preventDefault() handler (e.g. aria-label="PIN" -> "Verifying PIN...")
    // must preserve the pre-mutation fingerprint so the paired viewport can still resolve the target!
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '9', code: 'Digit9', target: env.pinInput },
      (ev) => {
        ev.preventDefault();
        env.pinInput.setAttribute('aria-label', 'Verifying PIN...');
      },
    );
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '8', code: 'Digit8', target: env.textInput },
      (ev) => {
        ev.preventDefault();
        env.textInput.setAttribute('aria-label', 'Mutated Note Label');
      },
    );
    await env.advanceTime(1);

    const keyCaptures = env.sent.filter(
      (s) => s.channel === 'iron:mirror-capture' && s.payload.kind === 'keydown',
    );
    expect(keyCaptures.map((c) => c.payload.key)).toEqual(['7', 'Backspace', '3', '9', '8']);
    expect(keyCaptures.map((c) => c.payload.code)).toEqual([
      'Digit7',
      'Backspace',
      'Digit3',
      'Digit9',
      'Digit8',
    ]);
    expect(keyCaptures[3]!.payload.fingerprint.ariaLabel).toBe('PIN');
    expect(keyCaptures[4]!.payload.fingerprint.ariaLabel).toBe('Order note');
  });

  test('normal >60ms click outside Kobalte dialog emits strictly 1 capture (no double-capture) and fast <60ms click also sets dismissedOverlay', async () => {
    const env = await loadPreloadInVm();

    // Case A: normal human >60ms click (pointerdown -> data-closed -> 60ms timer fires -> mouseup/click at 90ms)
    env.sent.length = 0;
    env.setDialogMode('kobalte');
    env.dialogCard.removeAttribute('data-closed');
    await env.dispatchBlinkEvent(
      'pointerdown',
      { button: 0, clientX: 10, clientY: 10, target: env.backdrop },
      () => env.dialogCard.setAttribute('data-closed', ''),
    );
    await env.advanceTime(70); // 60ms timer fires Capture #1
    await env.dispatchBlinkEvent('click', {
      button: 0,
      detail: 1,
      clientX: 10,
      clientY: 10,
      target: env.fakeBody,
    });
    await env.advanceTime(10);

    const slowCaptures = env.sent.filter(
      (s) => s.channel === 'iron:mirror-capture' && s.payload.kind === 'click',
    );
    expect(slowCaptures.length).toBe(1);
    expect(slowCaptures[0]!.payload.fingerprint.dismissedOverlay).toBe(true);

    // Case B: fast <60ms click where Kobalte unmounts before click lands on <body>
    env.sent.length = 0;
    env.setDialogMode('kobalte');
    env.dialogCard.removeAttribute('data-closed');
    await env.dispatchBlinkEvent(
      'pointerdown',
      { button: 0, clientX: 10, clientY: 10, target: env.backdrop },
      () => env.dialogCard.setAttribute('data-closed', ''),
    );
    await env.advanceTime(30); // < 60ms
    await env.dispatchBlinkEvent('click', {
      button: 0,
      detail: 1,
      clientX: 10,
      clientY: 10,
      target: env.fakeBody,
    });
    await env.advanceTime(10);

    const fastCaptures = env.sent.filter(
      (s) => s.channel === 'iron:mirror-capture' && s.payload.kind === 'click',
    );
    expect(fastCaptures.length).toBe(1);
    expect(fastCaptures[0]!.payload.fingerprint.dismissedOverlay).toBe(true);
  });

  test('resolveTarget with dismissedOverlay returns outside point when open, returns found:false when paired viewport has NO dialog (never clicks body center), and supports native <dialog open> backdrop', async () => {
    const env = await loadPreloadInVm();
    const domQuery = env.domQueryHandlers[env.domQueryHandlers.length - 1]!;

    // 1. Paired viewport has open Kobalte dialog -> returns outside point (4, 4)
    env.sent.length = 0;
    env.setDialogMode('kobalte');
    env.dialogCard.removeAttribute('data-closed');
    domQuery(null, {
      reqId: 'req-open',
      op: 'resolveTarget',
      args: {
        fingerprint: {
          tag: 'body',
          cssPath: 'body',
          isCanvas: false,
          dismissedOverlay: true,
          relViewportX: 0.01,
          relViewportY: 0.01,
        },
      },
    });
    expect(
      env.sent.find((s) => s.channel === 'iron:dom-query-reply' && s.payload.reqId === 'req-open')
        ?.payload.result,
    ).toMatchObject({ found: true, tag: 'overlay-outside', x: 4, y: 4 });

    // 2. Paired viewport has NO open dialog -> MUST return found:false instead of clicking body center!
    env.sent.length = 0;
    env.setDialogMode('none');
    domQuery(null, {
      reqId: 'req-none',
      op: 'resolveTarget',
      args: {
        fingerprint: {
          tag: 'body',
          cssPath: 'body',
          isCanvas: false,
          dismissedOverlay: true,
          relViewportX: 0.01,
          relViewportY: 0.01,
        },
      },
    });
    expect(
      env.sent.find((s) => s.channel === 'iron:dom-query-reply' && s.payload.reqId === 'req-none')
        ?.payload.result,
    ).toMatchObject({ found: false });

    // 3. Native <dialog open> ::backdrop click at (10, 10) (outside dialog rect [200..520, 150..390])
    env.sent.length = 0;
    env.setDialogMode('native');
    await env.dispatchBlinkEvent(
      'pointerdown',
      { button: 0, clientX: 10, clientY: 10, target: env.nativeDialog },
      () => env.setDialogMode('none'),
    );
    await env.advanceTime(25);
    await env.dispatchBlinkEvent('click', {
      button: 0,
      detail: 1,
      clientX: 10,
      clientY: 10,
      target: env.nativeDialog,
    });
    const nativeCaptures = env.sent.filter(
      (s) => s.channel === 'iron:mirror-capture' && s.payload.kind === 'click',
    );
    expect(nativeCaptures.length).toBe(1);
    expect(nativeCaptures[0]!.payload.fingerprint.dismissedOverlay).toBe(true);

    // Paired viewport with native <dialog open> resolves outside point (4, 4) cleanly
    env.sent.length = 0;
    env.setDialogMode('native');
    domQuery(null, {
      reqId: 'req-native',
      op: 'resolveTarget',
      args: { fingerprint: nativeCaptures[0]!.payload.fingerprint },
    });
    expect(
      env.sent.find((s) => s.channel === 'iron:dom-query-reply' && s.payload.reqId === 'req-native')
        ?.payload.result,
    ).toMatchObject({ found: true, tag: 'overlay-outside', x: 4, y: 4 });
  });

  test('inner dialog Close button on persistent dialog does NOT set dismissedOverlay', async () => {
    const env = await loadPreloadInVm();
    env.sent.length = 0;
    env.setDialogMode('kobalte');
    env.dialogCard.removeAttribute('data-closed');

    await env.dispatchBlinkEvent('pointerdown', {
      button: 0,
      clientX: 375,
      clientY: 125,
      target: env.innerCloseBtn,
    });
    await env.dispatchBlinkEvent(
      'click',
      { button: 0, detail: 1, clientX: 375, clientY: 125, target: env.innerCloseBtn },
      () => env.setDialogMode('none'),
    );
    await env.advanceTime(10);

    const clicks = env.sent.filter(
      (s) => s.channel === 'iron:mirror-capture' && s.payload.kind === 'click',
    );
    expect(clicks.length).toBe(1);
    expect(clicks[0]!.payload.fingerprint.dismissedOverlay).toBeUndefined();
    expect(clicks[0]!.payload.fingerprint.ariaLabel).toBe('Close');
  });

  test('F-29: preventDefault() + stopPropagation() keydown followed immediately by keyup flushes keydown -> keyup in order without stuck held key', async () => {
    const env = await loadPreloadInVm();
    env.sent.length = 0;

    // Target calls BOTH preventDefault() and stopPropagation() (bypassing window bubble listener),
    // and keyup arrives BEFORE setTimeout(..., 0) runs!
    await env.dispatchBlinkEvent(
      'keydown',
      { key: '3', code: 'Digit3', target: env.pinInput },
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      },
    );
    await env.dispatchBlinkEvent('keyup', {
      key: '3',
      code: 'Digit3',
      target: env.pinInput,
    });
    await env.advanceTime(20);

    const keyCaptures = env.sent.filter(
      (s) =>
        s.channel === 'iron:mirror-capture' &&
        (s.payload.kind === 'keydown' || s.payload.kind === 'keyup'),
    );
    expect(keyCaptures.map((c) => `${c.payload.kind}:${c.payload.key}`)).toEqual([
      'keydown:3',
      'keyup:3',
    ]);
  });
});
