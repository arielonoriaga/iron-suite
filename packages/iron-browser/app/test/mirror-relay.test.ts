import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMainEvent, WebContents } from 'electron';
import {
  MirrorRelay,
  type IpcMainLike,
  type MirrorViewportLookup,
} from '../src/main/mirror-relay';
import type { ElementFingerprint, MirrorCaptureEvent, MirrorMissInfo } from '../src/shared/types';

class FakeIpcMain extends EventEmitter implements IpcMainLike {}

class FakeDebugger {
  attached = true;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];

  isAttached(): boolean {
    return this.attached;
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params });
    return {};
  }
}

class FakeWebContents {
  readonly debugger = new FakeDebugger();
  readonly sentQueries: Array<{ reqId: string; op: string; args: Record<string, unknown> }> = [];
  readonly inputEvents: Array<Record<string, unknown>> = [];
  destroyed = false;
  url: string;
  mainFrame: { origin: string } | null;

  constructor(
    public readonly id: number,
    url = 'https://app.test/page',
    mainFrameOrigin: string | null = 'https://app.test',
  ) {
    this.url = url;
    this.mainFrame = mainFrameOrigin === null ? null : { origin: mainFrameOrigin };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.url;
  }

  send(channel: string, payload: unknown): void {
    if (channel === 'iron:dom-query' && payload && typeof payload === 'object') {
      this.sentQueries.push(payload as { reqId: string; op: string; args: Record<string, unknown> });
    }
  }

  sendInputEvent(ev: Record<string, unknown>): void {
    this.inputEvents.push(ev);
  }
}

function makeIpcEvent(sender: FakeWebContents, senderFrame: unknown = sender.mainFrame): IpcMainEvent {
  return {
    sender: sender as unknown as WebContents,
    senderFrame,
  } as unknown as IpcMainEvent;
}

function makeButtonFp(overrides: Partial<ElementFingerprint> = {}): ElementFingerprint {
  return {
    id: 'btn-1',
    testId: 'btn-1',
    tag: 'button',
    role: 'button',
    text: 'Click',
    cssPath: '#btn-1',
    isCanvas: false,
    relViewportX: 0.5,
    relViewportY: 0.5,
    ...overrides,
  };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let m = 0; m < 4; m += 1) {
    for (let i = 0; i < turns; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const relaysToDispose: MirrorRelay[] = [];

function createRelay(
  lookup: MirrorViewportLookup,
  nowFn: () => number = () => 10_000,
): { relay: MirrorRelay; ipc: FakeIpcMain } {
  const ipc = new FakeIpcMain();
  const relay = new MirrorRelay(lookup, ipc, nowFn);
  relaysToDispose.push(relay);
  return { relay, ipc };
}

afterEach(() => {
  while (relaysToDispose.length > 0) {
    relaysToDispose.pop()!.dispose();
  }
});

describe('MirrorRelay M4A security & replication', () => {
  test('enforces mainFrame and strict non-opaque same-origin gate with optional lookup defaults', async () => {
    const portrait = new FakeWebContents(1, 'https://app.test/a', 'https://app.test');
    const landscape = new FakeWebContents(2, 'https://app.test/b', 'https://app.test');

    const lookup: MirrorViewportLookup = {
      findByWebContentsId: (id) => {
        if (id === portrait.id) {
          return {
            tabId: 'tab-1',
            role: 'portrait',
            mirrorEnabled: true,
            pairedWebContents: landscape as unknown as WebContents,
            pairedScale: 1,
          };
        }
        return null;
      },
    };

    const { ipc } = createRelay(lookup);
    const clickEvt: MirrorCaptureEvent = {
      kind: 'click',
      fingerprint: makeButtonFp(),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    };

    // 1. Subframe capture is rejected.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait, { origin: 'https://app.test' }), clickEvt);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    // 2. Mismatched origin is rejected.
    landscape.url = 'https://evil.test/b';
    landscape.mainFrame = { origin: 'https://evil.test' };
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), clickEvt);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    // 3. Opaque 'null' mainFrame origin (CSP sandbox) is rejected even if getURL() is https.
    landscape.url = 'https://app.test/b';
    landscape.mainFrame = { origin: 'null' };
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), clickEvt);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    // 4. Non-HTTP scheme (about:blank / file://) is rejected.
    landscape.url = 'about:blank';
    landscape.mainFrame = { origin: 'null' };
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), clickEvt);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    // 5. Same origin + mainFrame passes; subframe dom-query-reply is rejected while mainFrame reply succeeds.
    landscape.url = 'https://app.test/b';
    landscape.mainFrame = { origin: 'https://app.test' };
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), clickEvt);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(1);
    const reqId = landscape.sentQueries[0]!.reqId;

    // Spoofed subframe reply must be ignored.
    ipc.emit(
      'iron:dom-query-reply',
      makeIpcEvent(landscape, { origin: 'https://app.test' }),
      { reqId, result: { found: true, x: 50, y: 60 } },
    );
    await flushMicrotasks();
    expect(landscape.debugger.commands.length).toBe(0);

    // Authentic mainFrame reply dispatches click.
    ipc.emit(
      'iron:dom-query-reply',
      makeIpcEvent(landscape, landscape.mainFrame),
      { reqId, result: { found: true, x: 50, y: 60 } },
    );
    await flushMicrotasks();
    expect(landscape.debugger.commands.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  test('per-tab FIFO serialization orders events, isolates errors, and re-checks origin after await', async () => {
    const portrait = new FakeWebContents(10, 'https://app.test/p', 'https://app.test');
    const landscape = new FakeWebContents(20, 'https://app.test/l', 'https://app.test');

    const { relay, ipc } = createRelay({
      findByWebContentsId: (id) =>
        id === portrait.id
          ? {
              tabId: 'tab-fifo',
              role: 'portrait',
              mirrorEnabled: true,
              pairedWebContents: landscape as unknown as WebContents,
              pairedScale: 1,
            }
          : null,
    });

    // Event 1 and Event 2 queued back-to-back: Event 2 must NOT send queryDom until Event 1 resolves.
    const ev1: MirrorCaptureEvent = {
      kind: 'click',
      fingerprint: makeButtonFp({ id: 'first', testId: 'first' }),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    };
    const ev2: MirrorCaptureEvent = {
      kind: 'click',
      fingerprint: makeButtonFp({ id: 'second', testId: 'second' }),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    };

    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), ev1);
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), ev2);
    await flushMicrotasks();

    expect(landscape.sentQueries.length).toBe(1);
    expect((landscape.sentQueries[0]!.args.fingerprint as ElementFingerprint).id).toBe('first');

    // Cross-origin navigation happens WHILE Event 1 is awaiting queryDom!
    landscape.url = 'https://other.test/navigated';
    landscape.mainFrame = { origin: 'https://other.test' };

    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: true, x: 10, y: 20 },
    });
    await flushMicrotasks();

    // Event 1 must NOT dispatch after cross-origin navigation, and Event 2 fails pre-check too.
    expect(landscape.debugger.commands.length).toBe(0);
    expect(landscape.sentQueries.length).toBe(1);

    // Restore same origin and verify clearTab invalidates queued tasks.
    landscape.url = 'https://app.test/l';
    landscape.mainFrame = { origin: 'https://app.test' };

    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), ev1);
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), ev2);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(2);

    relay.clearTab('tab-fifo');
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: true, x: 10, y: 20 },
    });
    await flushMicrotasks();

    // Because clearTab incremented epoch, neither Event 1 nor queued Event 2 dispatches.
    expect(landscape.debugger.commands.length).toBe(0);
    expect(landscape.sentQueries.length).toBe(2);
  });

  test('State-Aware Toggle Guard skips already-synced toggles and preserves dblclick clickCount=2', async () => {
    const portrait = new FakeWebContents(11);
    const landscape = new FakeWebContents(21);
    const { ipc } = createRelay({
      findByWebContentsId: (id) =>
        id === portrait.id
          ? {
              tabId: 'tab-toggle',
              role: 'portrait',
              mirrorEnabled: true,
              pairedWebContents: landscape as unknown as WebContents,
              pairedScale: 1,
            }
          : null,
    });

    // Case 1: Sync flip false -> true while paired is already true -> SKIP click.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp({ toggleState: { 'aria-pressed': 'false' } }),
      toggleState: { 'aria-pressed': 'true' },
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: true, x: 40, y: 40, toggleState: { 'aria-pressed': 'true' } },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands.length).toBe(0);

    // Case 2: Sync flip false -> true while paired is false -> DISPATCH click.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp({ toggleState: { 'data-state': 'closed' } }),
      toggleState: { 'data-state': 'open' },
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: true, x: 40, y: 40, toggleState: { 'data-state': 'closed' } },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands.length).toBe(3);

    // Case 3: dblclick preserves clickCount: 2.
    landscape.debugger.commands.length = 0;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp(),
      button: 'left',
      clickCount: 2,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[2]!.reqId,
      result: { found: true, x: 55, y: 65 },
    });
    await flushMicrotasks();
    const pressed = landscape.debugger.commands.find((c) => c.params?.type === 'mousePressed');
    expect(pressed?.params?.clickCount).toBe(2);

    // Case 4: Toggle attribute removed on source (preState defined, capture.toggleState undefined)
    // while paired still has the attribute -> MUST dispatch click (not fall back to preState).
    landscape.debugger.commands.length = 0;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp({ toggleState: { 'aria-pressed': 'true' } }),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[3]!.reqId,
      result: { found: true, x: 55, y: 65, toggleState: { 'aria-pressed': 'true' } },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands.length).toBe(3);
  });

  test('Enter/Space synthetic click suppression prevents double-increment and handles keyup cleanly', async () => {
    let now = 5000;
    const portrait = new FakeWebContents(12);
    const landscape = new FakeWebContents(22);
    const { ipc } = createRelay(
      {
        findByWebContentsId: (id) =>
          id === portrait.id
            ? {
                tabId: 'tab-key',
                role: 'portrait',
                mirrorEnabled: true,
                pairedWebContents: landscape as unknown as WebContents,
                pairedScale: 1,
              }
            : null,
      },
      () => now,
    );

    const btnFp = makeButtonFp({ id: 'btn-inc', testId: 'btn-inc' });

    // Keydown Enter
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'keydown',
      fingerprint: btnFp,
      key: 'Enter',
      code: 'Enter',
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: true, x: 30, y: 30 },
    });
    await flushMicrotasks();
    const enterCmds1 = landscape.debugger.commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(enterCmds1.length).toBe(2);
    expect(enterCmds1[0]!.params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
    });
    expect(enterCmds1[1]!.params).toMatchObject({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
    });

    // Synthetic click (clickCount: 0) 40ms later must be suppressed without even querying DOM!
    now += 40;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: btnFp,
      button: 'left',
      clickCount: 0,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(1);

    // keyup is a safe no-op.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'keyup',
      fingerprint: btnFp,
      key: 'Enter',
      code: 'Enter',
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(1);

    // Real subsequent click works normally.
    now += 20;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: btnFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(2);
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: true, x: 30, y: 30 },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands.some((c) => c.params?.type === 'mousePressed')).toBe(true);

    // Bug 1 regression: Enter keydown relayed -> preload suppressed detail=0 locally (no clickCount=0
    // reaches MirrorRelay) -> real mouse click (clickCount=1) 150ms later on SAME target MUST NOT
    // be suppressed!
    landscape.debugger.commands.length = 0;
    now += 500;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'keydown',
      fingerprint: btnFp,
      key: 'Enter',
      code: 'Enter',
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[2]!.reqId,
      result: { found: true, x: 30, y: 30 },
    });
    await flushMicrotasks();
    const enterCmds2 = landscape.debugger.commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(enterCmds2.length).toBe(2);
    expect(enterCmds2[0]!.params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
    });
    expect(enterCmds2[1]!.params).toMatchObject({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
    });

    now += 150;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: btnFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(4);
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[3]!.reqId,
      result: { found: true, x: 30, y: 30 },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands.some((c) => c.params?.type === 'mousePressed')).toBe(true);
  });

  test('scoped drag/slider, wheel sign, and non-drag pointerdown ignoring work cleanly', async () => {
    const portrait = new FakeWebContents(13);
    const landscape = new FakeWebContents(23);
    const { ipc } = createRelay({
      findByWebContentsId: (id) =>
        id === portrait.id
          ? {
              tabId: 'tab-drag',
              role: 'portrait',
              mirrorEnabled: true,
              pairedWebContents: landscape as unknown as WebContents,
              pairedScale: 1,
            }
          : null,
    });

    // 1. pointerdown on <button> or <select> is ignored.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'pointerdown',
      fingerprint: makeButtonFp(),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    // 2. Scoped drag on <canvas>: pointerdown -> hover -> pointerup (even if pointerup target disappears).
    const canvasFp: ElementFingerprint = {
      tag: 'canvas',
      cssPath: '#draw-canvas',
      isCanvas: true,
      canvasIndex: 0,
      normalizedX: 0.25,
      normalizedY: 0.5,
      relViewportX: 0.25,
      relViewportY: 0.5,
    };

    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'pointerdown',
      fingerprint: canvasFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: true, x: 100, y: 80, isCanvas: true },
    });
    await flushMicrotasks();

    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'hover',
      fingerprint: { ...canvasFp, normalizedX: 0.75 },
      button: 'left',
      clickCount: 0,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: true, x: 180, y: 80, isCanvas: true },
    });
    await flushMicrotasks();

    // Even if target unmounts before pointerup, drag lock releases at lastX/lastY!
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'pointerup',
      fingerprint: canvasFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[2]!.reqId,
      result: { found: false },
    });
    await flushMicrotasks();

    const mouseTypes = landscape.debugger.commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params?.type);
    expect(mouseTypes).toEqual(['mousePressed', 'mouseMoved', 'mouseReleased']);
    const releaseCmd = landscape.debugger.commands[2]!;
    expect(releaseCmd.params?.x).toBe(180);
    expect(releaseCmd.params?.y).toBe(80);

    // 3. Wheel dispatches CDP mouseWheel and negated Electron mouseWheel fallback.
    landscape.debugger.commands.length = 0;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'wheel',
      fingerprint: makeButtonFp(),
      deltaX: 10,
      deltaY: 120,
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[3]!.reqId,
      result: { found: true, x: 200, y: 300 },
    });
    await flushMicrotasks();
    expect(landscape.debugger.commands[0]!.params).toEqual({
      type: 'mouseWheel',
      x: 200,
      y: 300,
      deltaX: 10,
      deltaY: 120,
    });

    landscape.debugger.attached = false;
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'wheel',
      fingerprint: makeButtonFp(),
      deltaX: 10,
      deltaY: 120,
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[4]!.reqId,
      result: { found: true, x: 200, y: 300 },
    });
    await flushMicrotasks();
    expect(landscape.inputEvents[0]).toEqual({
      type: 'mouseWheel',
      x: 200,
      y: 300,
      deltaX: -10,
      deltaY: -120,
    });
  });

  test('interactive-only Mirror Miss emits sanitized <=32-char label and redacted URL; ignores blank whitespace & hover', async () => {
    const portrait = new FakeWebContents(
      14,
      'https://app.test/page/password?token=secret123#access_token=xyz',
      'https://app.test',
    );
    const landscape = new FakeWebContents(
      24,
      'https://app.test/page/password',
      'https://app.test',
    );

    const misses: Array<{ tabId: string; info: MirrorMissInfo }> = [];
    const { relay, ipc } = createRelay(
      {
        findByWebContentsId: (id) =>
          id === portrait.id
            ? {
                tabId: 'tab-miss',
                role: 'portrait',
                mirrorEnabled: true,
                pairedWebContents: landscape as unknown as WebContents,
                pairedScale: 1,
              }
            : null,
        onMirrorMiss: (tabId, info) => misses.push({ tabId, info }),
      },
      () => 77_000,
    );

    // 1. Blank spacer div click fails to resolve -> must NOT emit Mirror Miss.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: {
        tag: 'div',
        classTokens: ['spacer'],
        cssPath: 'body > div.spacer:nth-of-type(1)',
        isCanvas: false,
        relViewportX: 0.5,
        relViewportY: 0.5,
      },
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: false },
    });
    await flushMicrotasks();
    expect(misses.length).toBe(0);

    // 2. Unresolved hover on interactive button -> must NOT emit Mirror Miss.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'hover',
      fingerprint: makeButtonFp(),
      button: 'left',
      clickCount: 0,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: false },
    });
    await flushMicrotasks();
    expect(misses.length).toBe(0);

    // 3. Unresolved click on interactive button -> emits sanitized <=32 char label & redacted URL.
    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp({
        ariaLabel: '\u0007\u202eSubmit\u200b   Order   Button With Extra Long Text',
      }),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[2]!.reqId,
      result: { found: false },
    });
    await flushMicrotasks();

    expect(misses.length).toBe(1);
    const miss = misses[0]!;
    expect(miss.tabId).toBe('tab-miss');
    expect(miss.info.reason).toBe('click:target-not-found');
    expect(miss.info.timestamp).toBe(77_000);
    expect(miss.info.targetLabel.length).toBeLessThanOrEqual(32);
    expect(miss.info.targetLabel).toBe('Submit Order Button With Extra L');
    expect(miss.info.url).toBe('https://app.test/page/password');
    expect(miss.info.url).not.toContain('secret123');
    expect(miss.info.url).not.toContain('access_token');

    // 4. dispose() clears listeners and resolves pending queries cleanly.
    const pendingPromise = relay.queryDom(landscape as unknown as WebContents, 'resolveTarget', {});
    relay.dispose();
    const disposedResult = await pendingPromise;
    expect(disposedResult.found).toBe(false);
    expect(disposedResult.error).toBe('mirror relay disposed');
  });

  test('clearTab() during pending queryDom cancels Epoch 0 timers and preserves Epoch 1 tabQueueDepths', async () => {
    const portrait = new FakeWebContents(15);
    const landscape = new FakeWebContents(25);
    const { relay, ipc } = createRelay({
      findByWebContentsId: (id) => {
        if (id === portrait.id) {
          return {
            tabId: 'tab-clear',
            role: 'portrait',
            mirrorEnabled: true,
            pairedWebContents: landscape as unknown as WebContents,
            pairedScale: 1,
          };
        }
        if (id === landscape.id) {
          return {
            tabId: 'tab-clear',
            role: 'landscape',
            mirrorEnabled: true,
            pairedWebContents: portrait as unknown as WebContents,
            pairedScale: 1,
          };
        }
        return null;
      },
    });

    // Enqueue 5 Epoch 0 events + a direct queryDom on the same tab.
    for (let i = 0; i < 5; i += 1) {
      ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
        kind: 'click',
        fingerprint: makeButtonFp({ id: `e0-${i}`, testId: `e0-${i}` }),
        button: 'left',
        clickCount: 1,
        modifiers: [],
      } satisfies MirrorCaptureEvent);
    }
    const directPending = relay.queryDom(
      landscape as unknown as WebContents,
      'layoutAudit',
      {},
      60_000,
    );
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(2); // 1 from e0-0 + 1 direct layoutAudit

    // Clear tab while Epoch 0 is still awaiting reply, then immediately enqueue 65 Epoch 1 events.
    relay.clearTab('tab-clear');

    // Direct Epoch 0 queryDom must settle immediately without waiting 60s.
    const clearedResult = await directPending;
    expect(clearedResult).toEqual({ found: false, ok: false, error: 'tab cleared' });

    for (let i = 0; i < 65; i += 1) {
      ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
        kind: 'click',
        fingerprint: makeButtonFp({ id: `e1-${i}`, testId: `e1-${i}` }),
        button: 'left',
        clickCount: 1,
        modifiers: [],
      } satisfies MirrorCaptureEvent);
    }

    await flushMicrotasks();

    // Epoch 0 queued tasks 1..4 must have drained without decrementing Epoch 1's queue depth (64)
    // and without issuing queries; Epoch 1's 65th event was capped at MAX_TAB_QUEUE_DEPTH = 64.
    const depths = (relay as unknown as { tabQueueDepths: Map<string, number> }).tabQueueDepths;
    const pendingMap = (relay as unknown as { pendingQueries: Map<string, unknown> }).pendingQueries;
    expect(depths.get('tab-clear')).toBe(64);
    expect(pendingMap.size).toBe(1);
    expect(landscape.sentQueries.length).toBe(3); // Only e1-0 started after Epoch 0 cleared.
    expect((landscape.sentQueries[2]!.args.fingerprint as ElementFingerprint).id).toBe('e1-0');

    // Drain all 64 Epoch 1 events sequentially.
    for (let i = 0; i < 64; i += 1) {
      const q = landscape.sentQueries[2 + i]!;
      expect((q.args.fingerprint as ElementFingerprint).id).toBe(`e1-${i}`);
      ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
        reqId: q.reqId,
        result: { found: true, x: 10, y: 20 },
      });
      await flushMicrotasks(12);
    }

    expect(depths.get('tab-clear')).toBeUndefined();
    expect(pendingMap.size).toBe(0);
    expect(landscape.sentQueries.length).toBe(66);
    expect(landscape.debugger.commands.filter((c) => c.params?.type === 'mousePressed').length).toBe(
      64,
    );
  });

  test('dispatchTrustedClick invokes beforeMouseDispatch and still sends mousePressed/Released if mouseMoved rejects', async () => {
    const wc = new FakeWebContents(99);
    const hookedIds: number[] = [];
    wc.debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      wc.debugger.commands.push({ method, params });
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved') {
        throw new Error('compositor ACK timeout');
      }
      return {};
    };

    const { relay } = createRelay({
      findByWebContentsId: () => null,
      beforeMouseDispatch: async (targetWc) => {
        hookedIds.push(targetWc.id);
      },
    });

    await relay.dispatchTrustedClick(wc as unknown as WebContents, 40, 80, 'left', 1, [], 0.5);
    expect(hookedIds).toEqual([99]);
    const mouseTypes = wc.debugger.commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params?.type);
    expect(mouseTypes).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(wc.debugger.commands[1]!.params).toMatchObject({ type: 'mousePressed', x: 20, y: 40 });
    expect(wc.debugger.commands[2]!.params).toMatchObject({ type: 'mouseReleased', x: 20, y: 40 });
    expect(wc.inputEvents.length).toBe(0);
  });

  test('EchoLoopGuard beginReplaying keeps isEcho=true across >140ms async dispatch until endReplaying', async () => {
    let now = 1000;
    const portrait = new FakeWebContents(71);
    const landscape = new FakeWebContents(72);
    const { relay, ipc } = createRelay(
      {
        findByWebContentsId: (id) =>
          id === portrait.id
            ? {
                tabId: 'tab-echo-async',
                role: 'portrait',
                mirrorEnabled: true,
                pairedWebContents: landscape as unknown as WebContents,
                pairedScale: 1,
              }
            : null,
      },
      () => now,
    );

    const guard = relay.getGuard('tab-echo-async');
    guard.beginReplaying('portrait');
    now += 500; // Far past 140ms fixed window while async dispatch is still in-flight.
    expect(guard.isEcho('portrait', now)).toBe(true);

    ipc.emit('iron:mirror-capture', makeIpcEvent(portrait), {
      kind: 'click',
      fingerprint: makeButtonFp(),
      button: 'left',
      clickCount: 1,
      modifiers: [],
    } satisfies MirrorCaptureEvent);
    await flushMicrotasks();
    expect(landscape.sentQueries.length).toBe(0);

    guard.endReplaying('portrait', now);
    expect(guard.isEcho('portrait', now + 100)).toBe(true);
    expect(guard.isEcho('portrait', now + 141)).toBe(false);
  });

  test('all 7 non-click active replayEvent branches hold beginReplaying across >140ms slow queryDom/beforeMouseDispatch and failing CDP dispatch without echo bounce', async () => {
    let now = 2000;
    const portrait = new FakeWebContents(81);
    const landscape = new FakeWebContents(82);

    let failNextMouseReleased = false;
    landscape.debugger.sendCommand = async (method: string, params?: Record<string, unknown>) => {
      landscape.debugger.commands.push({ method, params });
      if (failNextMouseReleased && method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        throw new Error('simulated mouseReleased failure');
      }
      return {};
    };

    const { relay, ipc } = createRelay(
      {
        findByWebContentsId: (id) => {
          if (id === portrait.id) {
            return {
              tabId: 'tab-nonclick-guard',
              role: 'portrait',
              mirrorEnabled: true,
              pairedWebContents: landscape as unknown as WebContents,
              pairedScale: 1,
            };
          }
          if (id === landscape.id) {
            return {
              tabId: 'tab-nonclick-guard',
              role: 'landscape',
              mirrorEnabled: true,
              pairedWebContents: portrait as unknown as WebContents,
              pairedScale: 1,
            };
          }
          return null;
        },
        beforeMouseDispatch: async () => {
          // Simulate slow surface priming > 140ms window.
          now += 250;
          await Promise.resolve();
          // While beforeMouseDispatch is running, an echo capture from landscape must be suppressed.
          expect(relay.getGuard('tab-nonclick-guard').isEcho('landscape')).toBe(true);
        },
      },
      () => now,
    );

    const guard = relay.getGuard('tab-nonclick-guard');
    const sliderFp: ElementFingerprint = {
      tag: 'input',
      role: 'slider',
      id: 'slider-1',
      cssPath: '#slider-1',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    const btnFp = makeButtonFp({ id: 'btn-nc', testId: 'btn-nc' });

    const triggerEchoCheck = (): void => {
      ipc.emit('iron:mirror-capture', makeIpcEvent(landscape), {
        kind: 'click',
        fingerprint: btnFp,
        button: 'left',
        clickCount: 1,
        modifiers: [],
      } satisfies MirrorCaptureEvent);
    };

    // 1. scroll (slow queryDom >140ms)
    const scrollP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'scroll',
      ratioX: 0,
      ratioY: 0.5,
      scrollX: 0,
      scrollY: 120,
    });
    await flushMicrotasks();
    now += 250;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[0]!.reqId,
      result: { found: true, ok: true },
    });
    await scrollP;
    expect(portrait.sentQueries.length).toBe(0);
    expect(guard.isEcho('landscape')).toBe(true);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 2. wheel (slow queryDom >140ms)
    const wheelP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'wheel',
      fingerprint: btnFp,
      deltaX: 0,
      deltaY: 60,
    });
    await flushMicrotasks();
    now += 250;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[1]!.reqId,
      result: { found: true, x: 50, y: 60 },
    });
    await wheelP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 3. input.needsClick (slow queryDom + slow beforeMouseDispatch >140ms)
    const inputP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'input',
      fingerprint: makeButtonFp({ tag: 'input', role: 'checkbox', id: 'chk-1', cssPath: '#chk-1' }),
      inputType: 'checkbox',
      value: 'on',
      checked: true,
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[2]!.reqId,
      result: { found: true, needsClick: true, x: 70, y: 80 },
    });
    await inputP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 4. keydown (slow queryDom >140ms)
    const keyP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'keydown',
      fingerprint: btnFp,
      key: 'Enter',
      code: 'Enter',
      modifiers: [],
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[3]!.reqId,
      result: { found: true, x: 30, y: 30 },
    });
    await keyP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 5. hover (non-drag, slow queryDom + slow beforeMouseDispatch >140ms)
    const hoverNonDragP = relay.replayEvent(
      'tab-nonclick-guard',
      'landscape',
      landscape as unknown as WebContents,
      {
        kind: 'hover',
        fingerprint: btnFp,
        button: 'left',
        clickCount: 0,
        modifiers: [],
      },
    );
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[4]!.reqId,
      result: { found: true, x: 45, y: 55 },
    });
    await hoverNonDragP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 6. pointerdown -> active-drag hover -> pointerup (with slow beforeMouseDispatch + rejecting CDP mouseReleased)
    const pDownP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'pointerdown',
      fingerprint: sliderFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[5]!.reqId,
      result: { found: true, x: 100, y: 20 },
    });
    await pDownP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    const dragHoverP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'hover',
      fingerprint: sliderFp,
      button: 'left',
      clickCount: 0,
      modifiers: [],
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[6]!.reqId,
      result: { found: true, x: 140, y: 20 },
    });
    await dragHoverP;
    expect(portrait.sentQueries.length).toBe(0);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    failNextMouseReleased = true;
    const pUpP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'pointerup',
      fingerprint: sliderFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    triggerEchoCheck();
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[7]!.reqId,
      result: { found: true, x: 140, y: 20 },
    });
    await pUpP;
    // Even after CDP failure (falling back to sendInputEvent), endReplaying ran cleanly and sets the 140ms post-replay window.
    expect(landscape.inputEvents.some((e) => e.type === 'mouseUp')).toBe(true);
    expect(portrait.sentQueries.length).toBe(0);
    expect(guard.isEcho('landscape')).toBe(true);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);

    // 7. click must not double-count inFlightCounts (exits guard cleanly in finally)
    const clickP = relay.replayEvent('tab-nonclick-guard', 'landscape', landscape as unknown as WebContents, {
      kind: 'click',
      fingerprint: btnFp,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    });
    await flushMicrotasks();
    now += 200;
    expect(guard.isEcho('landscape')).toBe(true);
    ipc.emit('iron:dom-query-reply', makeIpcEvent(landscape), {
      reqId: landscape.sentQueries[8]!.reqId,
      result: { found: true, x: 40, y: 40 },
    });
    await clickP;
    expect(guard.isEcho('landscape')).toBe(true);
    now += 141;
    expect(guard.isEcho('landscape')).toBe(false);
  });

  test('dispatchTrustedKey preserves Digit code and text for preventDefault PIN keydown relay', async () => {
    const portrait = new FakeWebContents(91);
    const landscape = new FakeWebContents(92);
    const { relay, ipc } = createRelay({
      findByWebContentsId: (id) =>
        id === landscape.id
          ? {
              tabId: 'tab-pin',
              role: 'landscape',
              mirrorEnabled: true,
              pairedWebContents: portrait as unknown as WebContents,
              pairedScale: 1,
            }
          : null,
    });

    const pinFp: ElementFingerprint = {
      tag: 'input',
      role: 'textbox',
      ariaLabel: 'PIN',
      cssPath: 'input:nth-of-type(1)',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };

    const replayP = relay.replayEvent('tab-pin', 'portrait', portrait as unknown as WebContents, {
      kind: 'keydown',
      fingerprint: pinFp,
      key: '4',
      code: 'Digit4',
      modifiers: [],
    });
    await flushMicrotasks();
    expect(portrait.sentQueries.length).toBe(1);
    expect(portrait.sentQueries[0]!.args).toMatchObject({ focusTarget: true, scrollIntoView: false });
    ipc.emit('iron:dom-query-reply', makeIpcEvent(portrait), {
      reqId: portrait.sentQueries[0]!.reqId,
      result: { found: true, x: 10, y: 10 },
    });
    await replayP;

    const keyCmds = portrait.debugger.commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keyCmds.length).toBe(2);
    expect(keyCmds[0]!.params).toMatchObject({
      type: 'keyDown',
      key: '4',
      code: 'Digit4',
      text: '4',
      unmodifiedText: '4',
      windowsVirtualKeyCode: 52,
    });
    expect(keyCmds[1]!.params).toMatchObject({
      type: 'keyUp',
      key: '4',
      code: 'Digit4',
    });

    // Punctuation & Shift+digit must NOT collide with navigation VK codes (e.g. '.' != VK_DELETE 46, '!' != VK_PRIOR 33).
    portrait.debugger.commands.length = 0;
    await relay.dispatchTrustedKey(portrait as unknown as WebContents, '.', [], 'Period');
    await relay.dispatchTrustedKey(portrait as unknown as WebContents, '!', ['shift'], 'Digit1');
    const punctCmds = portrait.debugger.commands.filter(
      (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyDown',
    );
    expect(punctCmds.length).toBe(2);
    expect(punctCmds[0]!.params).toMatchObject({
      key: '.',
      code: 'Period',
      text: '.',
      windowsVirtualKeyCode: 0,
    });
    expect(punctCmds[1]!.params).toMatchObject({
      key: '!',
      code: 'Digit1',
      text: '!',
      modifiers: 8,
      windowsVirtualKeyCode: 0,
    });
  });
});
