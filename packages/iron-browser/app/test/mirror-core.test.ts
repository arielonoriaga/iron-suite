import { describe, expect, test } from 'bun:test';
import {
  accumulateIframeOffset,
  areSameHttpOrigin,
  buildMirrorMissLabel,
  buildSelectorCandidates,
  compareToggleStates,
  computeFrameStats,
  computeProportionalScroll,
  DOM_PIERCE_LIMITS,
  EchoLoopGuard,
  extractToggleState,
  fingerprintsReferSameTarget,
  isActivationKey,
  isDragOrSliderTarget,
  isInteractiveFingerprint,
  isInteractiveTarget,
  isOpaqueOrigin,
  mapNormalizedPoint,
  parseHttpOrigin,
  redactMirrorDebugPayload,
  redactMirrorFingerprint,
  redactMirrorUrl,
  redactOuterHtml,
  sanitizeMirrorMissLabel,
  shouldSkipToggleClick,
  shouldSuppressSyntheticClick,
  toggleStatesEqual,
} from '../src/shared/mirror-core';
import type { ElementFingerprint } from '../src/shared/types';

describe('3-tier mirror-core', () => {
  test('orders Tier 2 selector candidates deterministically: data-testid -> id -> aria-label -> name -> role+text -> cssPath', () => {
    const fp: ElementFingerprint = {
      testId: 'checkout-submit',
      id: 'submit-btn',
      ariaLabel: 'Submit order',
      name: 'orderSubmit',
      role: 'button',
      text: 'Place Order',
      tag: 'button',
      cssPath: 'main > form > button:nth-of-type(1)',
      isCanvas: false,
      relViewportX: 0.8,
      relViewportY: 0.2,
    };

    const candidates = buildSelectorCandidates(fp);
    expect(candidates.map((c) => c.strategy)).toEqual([
      'data-testid',
      'id',
      'aria-label',
      'name',
      'role-text',
      'css-path',
    ]);
    expect(candidates[0]!.selector).toBe('[data-testid="checkout-submit"]');
    expect(candidates[1]!.selector).toBe('#submit-btn');
    expect(candidates[2]!.selector).toBe('[aria-label="Submit order"]');
    expect(candidates[3]!.selector).toBe('button[name="orderSubmit"]');
    expect(candidates[4]!.role).toBe('button');
    expect(candidates[4]!.text).toBe('Place Order');
    expect(candidates[5]!.selector).toBe('main > form > button:nth-of-type(1)');
  });

  test('escapes quotes, control chars, and numeric-leading IDs in CSS selectors', () => {
    const fp: ElementFingerprint = {
      testId: 'btn-"alpha"\nline2\r\fend',
      id: '123-item:1.2',
      tag: 'button',
      cssPath: 'body > button:nth-of-type(1)',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };

    const candidates = buildSelectorCandidates(fp);
    expect(candidates[0]!.selector).toBe('[data-testid="btn-\\"alpha\\"\\a line2\\d \\c end"]');
    expect(candidates[1]!.selector).toBe('#\\31 23-item\\:1\\.2');

    const negDigit = buildSelectorCandidates({
      id: '-9foo',
      tag: 'div',
      cssPath: 'div',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    });
    expect(negDigit[0]!.selector).toBe('#-\\39 foo');
  });

  test('maps Tier 3 normalized canvas coordinates accurately across different aspect rects', () => {
    const mapped = mapNormalizedPoint(0.25, 0.75, { x: 100, y: 40, width: 800, height: 400 });
    expect(mapped).toEqual({ x: 300, y: 340 });

    // Clamps out-of-bounds normalized coordinates safely
    const clamped = mapNormalizedPoint(-0.5, 1.8, { x: 10, y: 20, width: 200, height: 100 });
    expect(clamped).toEqual({ x: 10, y: 120 });

    // Rejects degenerate zero-area rect
    expect(mapNormalizedPoint(0.5, 0.5, { x: 0, y: 0, width: 0, height: 100 })).toBeNull();
  });

  test('computes Tier 1 proportional scroll cleanly without NaN on zero-scroll pages', () => {
    expect(computeProportionalScroll(500, 1000, 2400)).toBe(1200);
    expect(computeProportionalScroll(0, 0, 1000)).toBe(0);
    expect(computeProportionalScroll(300, 1000, 0)).toBe(0);
    expect(computeProportionalScroll(1500, 1000, 800)).toBe(800);
  });

  test('EchoLoopGuard blocks bounced events inside replay window and expires afterward', () => {
    let now = 10_000;
    const guard = new EchoLoopGuard(100, () => now);

    // Viewport A replays into Viewport B (landscape)
    guard.markReplaying('landscape');
    expect(guard.isEcho('landscape')).toBe(true);
    expect(guard.isEcho('portrait')).toBe(false);

    now += 80;
    expect(guard.isEcho('landscape')).toBe(true);

    now += 25; // total 105ms > 100ms window
    expect(guard.isEcho('landscape')).toBe(false);
  });

  test('computeFrameStats accurately calculates fps, p95, and >20ms jank count', () => {
    const frames = [16.5, 16.6, 16.7, 16.6, 16.8, 16.5, 16.6, 16.7, 25.0, 32.0];
    const stats = computeFrameStats(frames);
    expect(stats.jankCount).toBe(2);
    expect(stats.p95FrameMs).toBe(32);
    expect(stats.fps).toBeGreaterThan(45);
    expect(stats.fps).toBeLessThan(61);
  });
});

describe('R4 mirror-core helpers', () => {
  test('parseHttpOrigin, areSameHttpOrigin, and isOpaqueOrigin enforce strict http/https non-opaque parity', () => {
    expect(isOpaqueOrigin(null)).toBe(true);
    expect(isOpaqueOrigin('null')).toBe(true);
    expect(isOpaqueOrigin('https://example.com')).toBe(false);

    expect(parseHttpOrigin('https://example.com:8443/path?a=1')).toBe('https://example.com:8443');
    expect(parseHttpOrigin('http://localhost:3000/page')).toBe('http://localhost:3000');
    expect(parseHttpOrigin('null')).toBeNull();
    expect(parseHttpOrigin('about:blank')).toBeNull();
    expect(parseHttpOrigin('file:///etc/passwd')).toBeNull();
    expect(parseHttpOrigin('data:text/html,hi')).toBeNull();
    expect(parseHttpOrigin('javascript:alert(1)')).toBeNull();

    expect(areSameHttpOrigin('https://a.test/one', 'https://a.test/two')).toBe(true);
    expect(areSameHttpOrigin('https://a.test:443/one', 'https://a.test/two')).toBe(true);
    expect(areSameHttpOrigin('https://a.test/one', 'https://b.test/one')).toBe(false);
    expect(areSameHttpOrigin('https://a.test/one', 'http://a.test/one')).toBe(false);
    expect(areSameHttpOrigin('https://a.test:8080/one', 'https://a.test:8081/one')).toBe(false);
    expect(areSameHttpOrigin('null', 'https://a.test/one')).toBe(false);
  });

  test('DOM_PIERCE_LIMITS and accumulateIframeOffset enforce bounds and accumulate finite offsets', () => {
    expect(DOM_PIERCE_LIMITS).toEqual({ maxDepth: 8, maxRoots: 32, maxNodes: 2000 });
    expect(
      accumulateIframeOffset([
        { left: 10, top: 20 },
        { left: 5.5, top: -2 },
        { left: Number.NaN, top: Number.POSITIVE_INFINITY },
      ]),
    ).toEqual({ offsetX: 15.5, offsetY: 18 });
  });

  test('State-Aware Toggle Guard extracts, compares, and decides skip without affecting non-toggles', () => {
    expect(extractToggleState({ 'aria-pressed': null, 'data-state': null })).toBeUndefined();
    const pressed = extractToggleState({ 'aria-pressed': ' TRUE ', 'data-state': null });
    expect(pressed).toEqual({ 'aria-pressed': 'true' });

    const checked = extractToggleState({ 'aria-checked': 'false' }, false);
    expect(checked).toEqual({ 'aria-checked': 'false', checked: 'false' });

    expect(compareToggleStates(pressed, { 'aria-pressed': 'true' })).toBe('match');
    expect(compareToggleStates(pressed, { 'aria-pressed': 'false' })).toBe('mismatch');
    expect(compareToggleStates(pressed, undefined)).toBe('unknown');
    expect(toggleStatesEqual({ 'data-state': 'open' }, { 'data-state': 'OPEN' })).toBe(true);

    // Sync flip (false -> true): skip only if paired already has true.
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-pressed': 'false' },
        postState: { 'aria-pressed': 'true' },
        pairedState: { 'aria-pressed': 'false' },
      }),
    ).toBe(false);
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-pressed': 'false' },
        postState: { 'aria-pressed': 'true' },
        pairedState: { 'aria-pressed': 'true' },
      }),
    ).toBe(true);

    // Async/unchanged (false -> false): click if paired is false, skip if paired is already true.
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-selected': 'false' },
        postState: { 'aria-selected': 'false' },
        pairedState: { 'aria-selected': 'false' },
      }),
    ).toBe(false);
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-selected': 'false' },
        postState: { 'aria-selected': 'false' },
        pairedState: { 'aria-selected': 'true' },
      }),
    ).toBe(true);

    // Attribute removed on source (preState defined, postState={}): do NOT skip if paired still has it.
    expect(compareToggleStates({}, { 'aria-pressed': 'true' })).toBe('mismatch');
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-pressed': 'true' },
        postState: {},
        pairedState: { 'aria-pressed': 'true' },
      }),
    ).toBe(false);
    expect(
      shouldSkipToggleClick({
        preState: { 'aria-pressed': 'true' },
        postState: {},
        pairedState: undefined,
      }),
    ).toBe(false);

    // 2-arg fallback
    expect(shouldSkipToggleClick({ 'data-state': 'open' }, { 'data-state': 'open' })).toBe(true);
    expect(shouldSkipToggleClick({ 'data-state': 'open' }, { 'data-state': 'closed' })).toBe(false);
    expect(shouldSkipToggleClick(undefined, { 'data-state': 'open' })).toBe(false);
  });

  test('Enter/Space synthetic-click suppression matches window and target without breaking dblclick', () => {
    const btnFp: ElementFingerprint = {
      id: 'btn-inc',
      tag: 'button',
      role: 'button',
      cssPath: '#btn-inc',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    const otherFp: ElementFingerprint = {
      id: 'btn-other',
      tag: 'button',
      role: 'button',
      cssPath: '#btn-other',
      isCanvas: false,
      relViewportX: 0.2,
      relViewportY: 0.2,
    };

    expect(isActivationKey('Enter')).toBe(true);
    expect(isActivationKey(' ')).toBe(true);
    expect(isActivationKey('Space')).toBe(true);
    expect(isActivationKey('Escape')).toBe(false);
    expect(fingerprintsReferSameTarget(btnFp, { ...btnFp })).toBe(true);
    expect(fingerprintsReferSameTarget(btnFp, otherFp)).toBe(false);

    const keyRelay = { key: 'Enter', timestampMs: 1000, fingerprint: btnFp };
    // Synthetic keyboard click (clickCount === 0) MUST be suppressed.
    expect(
      shouldSuppressSyntheticClick({
        clickCount: 0,
        clickFingerprint: btnFp,
        recentKeyRelay: keyRelay,
        nowMs: 1120,
      }),
    ).toBe(true);
    // Real mouse single-click (clickCount === 1) 150ms after Enter on same target MUST NOT be suppressed.
    expect(
      shouldSuppressSyntheticClick({
        clickCount: 1,
        clickFingerprint: btnFp,
        recentKeyRelay: keyRelay,
        nowMs: 1150,
      }),
    ).toBe(false);
    // Real dblclick or different target or expired window must NOT be suppressed.
    expect(
      shouldSuppressSyntheticClick({
        clickCount: 2,
        clickFingerprint: btnFp,
        recentKeyRelay: keyRelay,
        nowMs: 1120,
      }),
    ).toBe(false);
    expect(
      shouldSuppressSyntheticClick({
        clickCount: 1,
        clickFingerprint: otherFp,
        recentKeyRelay: keyRelay,
        nowMs: 1120,
      }),
    ).toBe(false);
    expect(
      shouldSuppressSyntheticClick({
        clickCount: 0,
        clickFingerprint: btnFp,
        recentKeyRelay: keyRelay,
        nowMs: 1500,
      }),
    ).toBe(false);
  });

  test('isDragOrSliderTarget scopes strictly to canvas, range inputs, and role=slider', () => {
    expect(isDragOrSliderTarget({ tag: 'canvas', isCanvas: true })).toBe(true);
    expect(isDragOrSliderTarget({ tag: 'input', role: 'slider', isCanvas: false })).toBe(true);
    expect(isDragOrSliderTarget({ tag: 'input', inputType: 'range', isCanvas: false })).toBe(true);
    expect(isDragOrSliderTarget({ tag: 'div', role: 'slider', isCanvas: false })).toBe(true);

    expect(isDragOrSliderTarget({ tag: 'button', role: 'button', isCanvas: false })).toBe(false);
    expect(isDragOrSliderTarget({ tag: 'select', role: 'combobox', isCanvas: false })).toBe(false);
    expect(isDragOrSliderTarget({ tag: 'input', role: 'textbox', isCanvas: false })).toBe(false);
    expect(isDragOrSliderTarget({ tag: 'div', isCanvas: false })).toBe(false);
  });

  test('isInteractiveTarget and isInteractiveFingerprint classify interactive elements vs blank whitespace', () => {
    expect(isInteractiveTarget({ tag: 'button' })).toBe(true);
    expect(isInteractiveTarget({ tag: 'a', hasHref: true })).toBe(true);
    expect(isInteractiveTarget({ tag: 'a', hasHref: false })).toBe(false);
    expect(isInteractiveTarget({ tag: 'div', role: 'switch' })).toBe(true);
    expect(isInteractiveTarget({ tag: 'div', testId: 'card-action' })).toBe(true);
    expect(isInteractiveTarget({ tag: 'div', tabIndex: 0 })).toBe(true);
    expect(isInteractiveTarget({ tag: 'div', tabIndex: '-1' })).toBe(false);
    expect(isInteractiveTarget({ tag: 'div' })).toBe(false);

    const blankDiv: ElementFingerprint = {
      tag: 'div',
      classTokens: ['spacer'],
      cssPath: 'body > div.spacer:nth-of-type(1)',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    const focusableDiv: ElementFingerprint = {
      tag: 'div',
      cssPath: 'body > div[tabindex="0"]:nth-of-type(2)',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    const focusableWithId: ElementFingerprint = {
      id: 'card-1',
      tag: 'div',
      cssPath: '#card-1[tabindex="0"]',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    const nonFocusableWithId: ElementFingerprint = {
      id: 'card-2',
      tag: 'div',
      cssPath: '#card-2',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    expect(isInteractiveFingerprint(blankDiv)).toBe(false);
    expect(isInteractiveFingerprint(focusableDiv)).toBe(true);
    expect(isInteractiveFingerprint(focusableWithId)).toBe(true);
    expect(isInteractiveFingerprint(nonFocusableWithId)).toBe(false);
    expect(
      isInteractiveFingerprint({
        ...blankDiv,
        testId: 'missing-btn',
      }),
    ).toBe(true);
  });

  test('sanitizeMirrorMissLabel and buildMirrorMissLabel strip control/bidi chars and cap <= 32 chars', () => {
    const nasty = '\u0000\u202eHello\u200b   \u2066World\u0007   from   a very long button label';
    const sanitized = sanitizeMirrorMissLabel(nasty, 32);
    expect(sanitized.length).toBeLessThanOrEqual(32);
    expect(sanitized).toBe('Hello World from a very long but');
    expect(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(sanitized)).toBe(
      false,
    );

    const inputFp: ElementFingerprint = {
      id: 'secret-pass',
      tag: 'input',
      role: 'textbox',
      text: 'should-not-leak',
      cssPath: '#secret-pass',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    };
    expect(buildMirrorMissLabel(inputFp, 32)).toBe('secret-pass');
  });

  test('redactMirrorUrl, redactOuterHtml, redactMirrorFingerprint, and redactMirrorDebugPayload redact secrets safely', () => {
    expect(redactMirrorUrl('https://user:pass@example.com/login?token=secret123#access_token=xyz')).toBe(
      'https://example.com/login',
    );
    expect(redactMirrorUrl('http://user:pass@bad host/path?token=secret#frag')).toBe(
      'http://bad host/path',
    );
    expect(redactMirrorUrl('https://user@bad host/path?q=1')).toBe('https://bad host/path');
    expect(redactMirrorUrl('javascript:alert(1)')).toBeUndefined();

    const html = '<input id="secret-pass" type="password" value="hunter2"><textarea>my note</textarea>';
    const redactedHtml = redactOuterHtml(html);
    expect(redactedHtml).not.toContain('hunter2');
    expect(redactedHtml).not.toContain('my note');
    expect(redactedHtml).toContain('value="[REDACTED]"');

    const gtInAttr = redactOuterHtml('<input type="password" value="a>b" data-x="1">');
    expect(gtInAttr).toBe('<input type="password" value="[REDACTED]" data-x="1">');

    const textAndHidden = redactOuterHtml(
      '<input type="text" name="api_key" value="super-secret-value"><input type="hidden" value="csrf-secret"><textarea data-x="a>b">secret note</textarea>',
    );
    expect(textAndHidden).not.toContain('super-secret-value');
    expect(textAndHidden).not.toContain('csrf-secret');
    expect(textAndHidden).not.toContain('secret note');
    expect(textAndHidden).toContain('<textarea data-x="a>b">[REDACTED]</textarea>');

    const formFp = redactMirrorFingerprint({
      id: 'secret-pass',
      tag: 'input',
      text: 'raw-secret',
      cssPath: '#secret-pass',
      isCanvas: false,
      relViewportX: 0.5,
      relViewportY: 0.5,
    });
    expect(formFp.text).toBeUndefined();

    const cyclic: Record<string, unknown> = {
      url: 'https://example.com/page/password?token=secret123#hash=abc',
      outerHtml: '<input type="password" value="s3cr3t">',
      value: 'my-password',
      fingerprint: {
        tag: 'input',
        inputType: 'password',
        text: 'typed-secret',
      },
    };
    const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    Object.assign(payload, cyclic);
    payload.self = payload;

    const safe = redactMirrorDebugPayload(payload) as Record<string, unknown>;
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('secret123');
    expect(serialized).not.toContain('hash=abc');
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('my-password');
    expect(serialized).not.toContain('typed-secret');
    expect(safe.url).toBe('https://example.com/page/password');
    expect(safe.outerHtml).toBe('[REDACTED]');
    expect(safe.self).toBe('[Circular]');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
