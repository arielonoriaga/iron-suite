import { describe, expect, test } from 'bun:test';
import {
  computeFitScale,
  computeLayout,
  DEVTOOLS_HEADER_HEIGHT,
  DIVIDER_WIDTH,
  ERROR_BANNER_HEIGHT,
  FIND_BAR_HEIGHT,
  MAX_SPLIT_RATIO,
  MIN_DOCK_HEIGHT,
  MIN_SPLIT_RATIO,
  RAIL_WIDTH,
  TELEMETRY_BAR_HEIGHT,
  TOP_BAR_HEIGHT,
  VIEWPORT_HEADER_HEIGHT,
} from '../src/shared/layout';

describe('computeLayout', () => {
  test('dual mode places portrait and landscape side-by-side without overlap', () => {
    const layout = computeLayout({
      windowWidth: 1440,
      windowHeight: 900,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: true,
      dockHeight: 280,
      splitRatio: 0.35,
    });

    expect(layout.topBar).toEqual({ x: 0, y: 0, width: 1440, height: TOP_BAR_HEIGHT });
    expect(layout.rail).toEqual({
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: RAIL_WIDTH,
      height: 900 - TOP_BAR_HEIGHT,
    });

    expect(layout.portraitView).not.toBeNull();
    expect(layout.divider).not.toBeNull();
    expect(layout.portraitHeader).not.toBeNull();
    expect(layout.devtoolsView).not.toBeNull();

    const pv = layout.portraitView!;
    const div = layout.divider!;
    const lv = layout.landscapeView;

    expect(pv.x).toBe(RAIL_WIDTH);
    expect(pv.y).toBe(TOP_BAR_HEIGHT + VIEWPORT_HEADER_HEIGHT);
    expect(div.x).toBe(pv.x + pv.width);
    expect(div.width).toBe(DIVIDER_WIDTH);
    expect(lv.x).toBe(div.x + div.width);
    expect(lv.x + lv.width).toBe(1440);
    expect(pv.height).toBe(lv.height);
    expect(pv.y + pv.height).toBe(layout.telemetryBar.y);

    expect(layout.telemetryBar.height).toBe(TELEMETRY_BAR_HEIGHT);
    expect(layout.devtoolsHeader!.height).toBe(DEVTOOLS_HEADER_HEIGHT);
    expect(layout.devtoolsView!.y).toBe(
      layout.telemetryBar.y + TELEMETRY_BAR_HEIGHT + DEVTOOLS_HEADER_HEIGHT,
    );
    expect(layout.devtoolsView!.y + layout.devtoolsView!.height).toBe(900);
  });

  test('single mode hides portrait view and fills entire content pane with landscape', () => {
    const layout = computeLayout({
      windowWidth: 1280,
      windowHeight: 800,
      mode: 'single',
      railCollapsed: true,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.4,
    });

    expect(layout.rail).toBeNull();
    expect(layout.portraitView).toBeNull();
    expect(layout.divider).toBeNull();
    expect(layout.devtoolsView).toBeNull();
    expect(layout.landscapeView).toEqual({
      x: 0,
      y: TOP_BAR_HEIGHT + VIEWPORT_HEADER_HEIGHT,
      width: 1280,
      height: 800 - TOP_BAR_HEIGHT - VIEWPORT_HEADER_HEIGHT - TELEMETRY_BAR_HEIGHT,
    });
    expect(layout.telemetryBar.y).toBe(800 - TELEMETRY_BAR_HEIGHT);
  });

  test('clamps extreme split ratios and dock heights safely', () => {
    const low = computeLayout({
      windowWidth: 1000,
      windowHeight: 700,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: true,
      dockHeight: 10,
      splitRatio: 0.01,
    });
    expect(low.clampedSplitRatio).toBe(MIN_SPLIT_RATIO);
    expect(low.clampedDockHeight).toBe(MIN_DOCK_HEIGHT);

    const high = computeLayout({
      windowWidth: 1000,
      windowHeight: 700,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: true,
      dockHeight: 9999,
      splitRatio: 0.99,
    });
    expect(high.clampedSplitRatio).toBe(MAX_SPLIT_RATIO);
    expect(high.portraitView!.height).toBeGreaterThanOrEqual(120);
  });

  test('computeFitScale fits oversized targets cleanly without exceeding 1x', () => {
    expect(computeFitScale(800, 900, 390, 844)).toBe(1);
    expect(computeFitScale(390, 422, 390, 844)).toBeCloseTo(0.5, 4);
    expect(computeFitScale(50, 50, 1280, 720)).toBe(0.25);
  });

  test('reserves non-occluding errorBanner and findBar slots above viewport headers when active', () => {
    const findOnly = computeLayout({
      windowWidth: 1280,
      windowHeight: 800,
      mode: 'single',
      railCollapsed: true,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.4,
      findBarOpen: true,
    });
    expect(findOnly.errorBanner).toBeNull();
    expect(findOnly.findBar).toEqual({
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: 1280,
      height: FIND_BAR_HEIGHT,
    });
    expect(findOnly.landscapeHeader.y).toBe(TOP_BAR_HEIGHT + FIND_BAR_HEIGHT);
    expect(findOnly.landscapeView.y).toBe(
      TOP_BAR_HEIGHT + FIND_BAR_HEIGHT + VIEWPORT_HEADER_HEIGHT,
    );
    expect(findOnly.landscapeView.y + findOnly.landscapeView.height).toBe(
      findOnly.telemetryBar.y,
    );

    const both = computeLayout({
      windowWidth: 1440,
      windowHeight: 900,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      findBarOpen: true,
      errorBannerOpen: true,
    });
    expect(both.errorBanner).toEqual({
      x: RAIL_WIDTH,
      y: TOP_BAR_HEIGHT,
      width: 1440 - RAIL_WIDTH,
      height: ERROR_BANNER_HEIGHT,
    });
    expect(both.findBar).toEqual({
      x: RAIL_WIDTH,
      y: TOP_BAR_HEIGHT + ERROR_BANNER_HEIGHT,
      width: 1440 - RAIL_WIDTH,
      height: FIND_BAR_HEIGHT,
    });
    const expectedHeaderY = TOP_BAR_HEIGHT + ERROR_BANNER_HEIGHT + FIND_BAR_HEIGHT;
    expect(both.portraitHeader!.y).toBe(expectedHeaderY);
    expect(both.landscapeHeader.y).toBe(expectedHeaderY);
    expect(both.divider!.y).toBe(expectedHeaderY);
    expect(both.portraitView!.y).toBe(expectedHeaderY + VIEWPORT_HEADER_HEIGHT);
    expect(both.landscapeView.y).toBe(expectedHeaderY + VIEWPORT_HEADER_HEIGHT);
    expect(both.portraitView!.y + both.portraitView!.height).toBe(both.telemetryBar.y);
  });
});
