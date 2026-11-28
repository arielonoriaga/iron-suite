import type { LayoutInput, LayoutResult, Rect } from './types';

export const TOP_BAR_HEIGHT = 40;
export const FIND_BAR_HEIGHT = 34;
export const ERROR_BANNER_HEIGHT = 34;
export const RAIL_WIDTH = 216;
export const VIEWPORT_HEADER_HEIGHT = 28;
export const DIVIDER_WIDTH = 6;
export const TELEMETRY_BAR_HEIGHT = 28;
export const DEVTOOLS_HEADER_HEIGHT = 28;
export const MIN_DOCK_HEIGHT = 140;
export const MAX_DOCK_RATIO = 0.65;
export const MIN_SPLIT_RATIO = 0.22;
export const MAX_SPLIT_RATIO = 0.68;
export const MIN_VIEWPORT_HEIGHT = 120;
export const MIN_VIEWPORT_WIDTH = 180;
export const DEFAULT_AGENT_DOCK_WIDTH = 360;
export const MIN_AGENT_DOCK_WIDTH = 280;
export const MAX_AGENT_DOCK_RATIO = 0.46;
export const MIN_AGENT_FLOAT_WIDTH = 260;
export const MIN_AGENT_FLOAT_HEIGHT = 180;
export const FLOAT_MARGIN_X = 8;
export const FLOAT_MARGIN_TOP = 4;
export const FLOAT_MARGIN_BOTTOM = 4;

export type FloatResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function clampFloatBounds(
  bounds: Partial<Rect> | undefined,
  windowWidth: number,
  windowHeight: number,
): Rect {
  const winW = Math.max(320, Math.floor(windowWidth));
  const winH = Math.max(320, Math.floor(windowHeight));
  const minX = FLOAT_MARGIN_X;
  const minY = TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP;
  const maxW = Math.max(MIN_AGENT_FLOAT_WIDTH, winW - FLOAT_MARGIN_X * 2);
  const maxH = Math.max(MIN_AGENT_FLOAT_HEIGHT, winH - minY - FLOAT_MARGIN_BOTTOM);

  const rawW =
    typeof bounds?.width === 'number' && Number.isFinite(bounds.width)
      ? Math.floor(bounds.width)
      : 400;
  const rawH =
    typeof bounds?.height === 'number' && Number.isFinite(bounds.height)
      ? Math.floor(bounds.height)
      : Math.min(540, winH - TOP_BAR_HEIGHT - 24);

  const width = clamp(rawW, MIN_AGENT_FLOAT_WIDTH, maxW);
  const height = clamp(rawH, MIN_AGENT_FLOAT_HEIGHT, maxH);

  const rawX =
    typeof bounds?.x === 'number' && Number.isFinite(bounds.x)
      ? Math.floor(bounds.x)
      : winW - width - 14;
  const rawY =
    typeof bounds?.y === 'number' && Number.isFinite(bounds.y)
      ? Math.floor(bounds.y)
      : TOP_BAR_HEIGHT + 12;

  const x = clamp(rawX, minX, Math.max(minX, winW - width - FLOAT_MARGIN_X));
  const y = clamp(rawY, minY, Math.max(minY, winH - height - FLOAT_MARGIN_BOTTOM));
  return { x, y, width, height };
}

export function computeResizedFloatBounds(
  origin: Rect,
  edge: FloatResizeEdge,
  dx: number,
  dy: number,
  windowWidth?: number,
  windowHeight?: number,
): Rect {
  const safeDx = Number.isFinite(dx) ? Math.round(dx) : 0;
  const safeDy = Number.isFinite(dy) ? Math.round(dy) : 0;
  const minX = FLOAT_MARGIN_X;
  const minY = TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP;
  const hasWin =
    typeof windowWidth === 'number' &&
    Number.isFinite(windowWidth) &&
    typeof windowHeight === 'number' &&
    Number.isFinite(windowHeight);
  const winW = hasWin ? Math.max(320, Math.floor(windowWidth!)) : 0;
  const winH = hasWin ? Math.max(320, Math.floor(windowHeight!)) : 0;

  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  let x = origin.x;
  let y = origin.y;
  let width = origin.width;
  let height = origin.height;

  if (edge.includes('w')) {
    const maxW = hasWin
      ? Math.max(MIN_AGENT_FLOAT_WIDTH, right - minX)
      : Number.POSITIVE_INFINITY;
    width = clamp(origin.width - safeDx, MIN_AGENT_FLOAT_WIDTH, maxW);
    x = right - width;
  } else if (edge.includes('e')) {
    const maxW = hasWin
      ? Math.max(MIN_AGENT_FLOAT_WIDTH, winW - FLOAT_MARGIN_X - origin.x)
      : Number.POSITIVE_INFINITY;
    width = clamp(origin.width + safeDx, MIN_AGENT_FLOAT_WIDTH, maxW);
  }

  if (edge.includes('n')) {
    const maxH = hasWin
      ? Math.max(MIN_AGENT_FLOAT_HEIGHT, bottom - minY)
      : Number.POSITIVE_INFINITY;
    height = clamp(origin.height - safeDy, MIN_AGENT_FLOAT_HEIGHT, maxH);
    y = bottom - height;
  } else if (edge.includes('s')) {
    const maxH = hasWin
      ? Math.max(MIN_AGENT_FLOAT_HEIGHT, winH - FLOAT_MARGIN_BOTTOM - origin.y)
      : Number.POSITIVE_INFINITY;
    height = clamp(origin.height + safeDy, MIN_AGENT_FLOAT_HEIGHT, maxH);
  }

  if (hasWin) {
    return clampFloatBounds({ x, y, width, height }, winW, winH);
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function clampAnchoredFloatBoundsUpdate(
  current: Rect,
  partial: Partial<Rect>,
  windowWidth: number,
  windowHeight: number,
): Rect {
  const winW = Math.max(320, Math.floor(windowWidth));
  const winH = Math.max(320, Math.floor(windowHeight));
  const minX = FLOAT_MARGIN_X;
  const maxRight = Math.max(minX + MIN_AGENT_FLOAT_WIDTH, winW - FLOAT_MARGIN_X);
  const minY = TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP;
  const maxBottom = Math.max(minY + MIN_AGENT_FLOAT_HEIGHT, winH - FLOAT_MARGIN_BOTTOM);

  const hasX = typeof partial.x === 'number' && Number.isFinite(partial.x);
  const hasY = typeof partial.y === 'number' && Number.isFinite(partial.y);
  const hasW = typeof partial.width === 'number' && Number.isFinite(partial.width);
  const hasH = typeof partial.height === 'number' && Number.isFinite(partial.height);

  const rawX = hasX ? Math.round(partial.x!) : current.x;
  const rawW = hasW ? Math.round(partial.width!) : current.width;
  let x: number;
  let width: number;
  if (hasW) {
    if (hasX && rawX < minX) {
      const anchoredRight = clamp(rawX + rawW, minX + MIN_AGENT_FLOAT_WIDTH, maxRight);
      x = minX;
      width = Math.max(MIN_AGENT_FLOAT_WIDTH, anchoredRight - minX);
    } else {
      x = clamp(rawX, minX, Math.max(minX, maxRight - MIN_AGENT_FLOAT_WIDTH));
      width = clamp(rawW, MIN_AGENT_FLOAT_WIDTH, Math.max(MIN_AGENT_FLOAT_WIDTH, maxRight - x));
    }
  } else {
    width = clamp(rawW, MIN_AGENT_FLOAT_WIDTH, Math.max(MIN_AGENT_FLOAT_WIDTH, maxRight - minX));
    x = clamp(rawX, minX, Math.max(minX, maxRight - width));
  }

  const rawY = hasY ? Math.round(partial.y!) : current.y;
  const rawH = hasH ? Math.round(partial.height!) : current.height;
  let y: number;
  let height: number;
  if (hasH) {
    if (hasY && rawY < minY) {
      const anchoredBottom = clamp(rawY + rawH, minY + MIN_AGENT_FLOAT_HEIGHT, maxBottom);
      y = minY;
      height = Math.max(MIN_AGENT_FLOAT_HEIGHT, anchoredBottom - minY);
    } else {
      y = clamp(rawY, minY, Math.max(minY, maxBottom - MIN_AGENT_FLOAT_HEIGHT));
      height = clamp(rawH, MIN_AGENT_FLOAT_HEIGHT, Math.max(MIN_AGENT_FLOAT_HEIGHT, maxBottom - y));
    }
  } else {
    height = clamp(
      rawH,
      MIN_AGENT_FLOAT_HEIGHT,
      Math.max(MIN_AGENT_FLOAT_HEIGHT, maxBottom - minY),
    );
    y = clamp(rawY, minY, Math.max(minY, maxBottom - height));
  }

  return clampFloatBounds({ x, y, width, height }, winW, winH);
}

export function computeFitScale(
  containerWidth: number,
  containerHeight: number,
  targetWidth: number,
  targetHeight: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return 1;
  }
  const scaleX = containerWidth / targetWidth;
  const scaleY = containerHeight / targetHeight;
  return clamp(Math.min(scaleX, scaleY, 1), 0.25, 1);
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const winW = Math.max(320, Math.floor(input.windowWidth));
  const winH = Math.max(320, Math.floor(input.windowHeight));

  const railWidth = input.railCollapsed ? 0 : Math.min(RAIL_WIDTH, Math.floor(winW * 0.28));
  const topBar = { x: 0, y: 0, width: winW, height: TOP_BAR_HEIGHT };
  const rail = railWidth > 0 ? { x: 0, y: TOP_BAR_HEIGHT, width: railWidth, height: winH - TOP_BAR_HEIGHT } : null;

  const contentX = railWidth;
  const availableAfterRail = Math.max(MIN_VIEWPORT_WIDTH, winW - railWidth);
  const agentMode = input.agentDockMode ?? 'minimized';

  let agentDock: LayoutResult['agentDock'] = null;
  let clampedAgentWidth = clamp(
    Math.floor(input.agentDockWidth ?? DEFAULT_AGENT_DOCK_WIDTH),
    MIN_AGENT_DOCK_WIDTH,
    Math.max(MIN_AGENT_DOCK_WIDTH, Math.floor(availableAfterRail * MAX_AGENT_DOCK_RATIO)),
  );

  let rightReservedW = 0;
  if (agentMode === 'docked' && availableAfterRail >= MIN_VIEWPORT_WIDTH + MIN_AGENT_DOCK_WIDTH) {
    rightReservedW = clampedAgentWidth;
    agentDock = {
      x: winW - rightReservedW,
      y: TOP_BAR_HEIGHT,
      width: rightReservedW,
      height: winH - TOP_BAR_HEIGHT,
    };
  } else if (agentMode === 'floating' || (agentMode === 'docked' && availableAfterRail < MIN_VIEWPORT_WIDTH + MIN_AGENT_DOCK_WIDTH)) {
    agentDock = clampFloatBounds(input.agentFloatBounds, winW, winH);
  }

  const contentW = Math.max(MIN_VIEWPORT_WIDTH, availableAfterRail - rightReservedW);

  let bannerOffset = 0;
  const errorBanner = input.errorBannerOpen
    ? {
        x: contentX,
        y: TOP_BAR_HEIGHT + bannerOffset,
        width: contentW,
        height: ERROR_BANNER_HEIGHT,
      }
    : null;
  if (errorBanner) {
    bannerOffset += ERROR_BANNER_HEIGHT;
  }

  const findBar = input.findBarOpen
    ? {
        x: contentX,
        y: TOP_BAR_HEIGHT + bannerOffset,
        width: contentW,
        height: FIND_BAR_HEIGHT,
      }
    : null;
  if (findBar) {
    bannerOffset += FIND_BAR_HEIGHT;
  }

  const availableH = Math.max(
    MIN_VIEWPORT_HEIGHT + TELEMETRY_BAR_HEIGHT,
    winH - TOP_BAR_HEIGHT - bannerOffset,
  );

  const maxDockH = Math.max(
    MIN_DOCK_HEIGHT,
    Math.min(
      Math.floor(availableH * MAX_DOCK_RATIO),
      availableH - VIEWPORT_HEADER_HEIGHT - MIN_VIEWPORT_HEIGHT,
    ),
  );

  const clampedDockHeight = input.dockOpen
    ? clamp(Math.floor(input.dockHeight), MIN_DOCK_HEIGHT, maxDockH)
    : TELEMETRY_BAR_HEIGHT;

  const dockTotalH = input.dockOpen ? clampedDockHeight : TELEMETRY_BAR_HEIGHT;
  const dockY = winH - dockTotalH;
  const headerY = TOP_BAR_HEIGHT + bannerOffset;
  const stageH = Math.max(VIEWPORT_HEADER_HEIGHT + 60, dockY - headerY);
  const viewY = headerY + VIEWPORT_HEADER_HEIGHT;
  const viewH = Math.max(60, stageH - VIEWPORT_HEADER_HEIGHT);

  const telemetryBar = {
    x: contentX,
    y: dockY,
    width: contentW,
    height: TELEMETRY_BAR_HEIGHT,
  };

  const devtoolsHeader = input.dockOpen
    ? {
        x: contentX,
        y: dockY + TELEMETRY_BAR_HEIGHT,
        width: contentW,
        height: DEVTOOLS_HEADER_HEIGHT,
      }
    : null;

  const devtoolsViewH = Math.max(0, dockTotalH - TELEMETRY_BAR_HEIGHT - DEVTOOLS_HEADER_HEIGHT);
  const devtoolsView =
    input.dockOpen && devtoolsViewH > 0
      ? {
          x: contentX,
          y: dockY + TELEMETRY_BAR_HEIGHT + DEVTOOLS_HEADER_HEIGHT,
          width: contentW,
          height: devtoolsViewH,
        }
      : null;

  const clampedSplitRatio = clamp(input.splitRatio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);

  if (input.mode === 'single') {
    return {
      topBar,
      rail,
      errorBanner,
      findBar,
      portraitHeader: null,
      portraitView: null,
      divider: null,
      landscapeHeader: {
        x: contentX,
        y: headerY,
        width: contentW,
        height: VIEWPORT_HEADER_HEIGHT,
      },
      landscapeView: {
        x: contentX,
        y: viewY,
        width: contentW,
        height: viewH,
      },
      telemetryBar,
      devtoolsHeader,
      devtoolsView,
      agentDock,
      clampedSplitRatio,
      clampedDockHeight,
      clampedAgentWidth,
    };
  }

  const usableSplitW = Math.max(200, contentW - DIVIDER_WIDTH);
  const minPaneW = Math.min(MIN_VIEWPORT_WIDTH, Math.floor(usableSplitW * 0.35));
  const portraitW = clamp(
    Math.floor(usableSplitW * clampedSplitRatio),
    minPaneW,
    usableSplitW - minPaneW,
  );
  const dividerX = contentX + portraitW;
  const landscapeX = dividerX + DIVIDER_WIDTH;
  const landscapeW = Math.max(minPaneW, contentX + contentW - landscapeX);

  return {
    topBar,
    rail,
    errorBanner,
    findBar,
    portraitHeader: {
      x: contentX,
      y: headerY,
      width: portraitW,
      height: VIEWPORT_HEADER_HEIGHT,
    },
    portraitView: {
      x: contentX,
      y: viewY,
      width: portraitW,
      height: viewH,
    },
    divider: {
      x: dividerX,
      y: headerY,
      width: DIVIDER_WIDTH,
      height: stageH,
    },
    landscapeHeader: {
      x: landscapeX,
      y: headerY,
      width: landscapeW,
      height: VIEWPORT_HEADER_HEIGHT,
    },
    landscapeView: {
      x: landscapeX,
      y: viewY,
      width: landscapeW,
      height: viewH,
    },
    telemetryBar,
    devtoolsHeader,
    devtoolsView,
    agentDock,
    clampedSplitRatio,
    clampedDockHeight,
    clampedAgentWidth,
  };
}
