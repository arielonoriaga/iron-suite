import type { ViewportDimensions, ViewportRole } from './types';

export interface PixelDimensions {
  width: number;
  height: number;
}

export interface ViewportSizingReport {
  role: ViewportRole;
  requestedSize: ViewportDimensions;
  effectiveCssSize: PixelDimensions | null;
  dpr: number | null;
  capturedPixels: PixelDimensions | null;
  exactSizeApplied?: boolean;
  sizeMismatch: boolean;
  mismatchReason?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads exact pixel width & height from a PNG buffer's IHDR chunk.
 */
export function readPngDimensions(pngBuf: Buffer): PixelDimensions | null {
  if (!Buffer.isBuffer(pngBuf) || pngBuf.length < 24) return null;
  if (!pngBuf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunkType = pngBuf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') return null;
  const width = pngBuf.readUInt32BE(16);
  const height = pngBuf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

export function buildViewportSizingReport(params: {
  role: ViewportRole;
  requestedSize: ViewportDimensions;
  effectiveCssSize: PixelDimensions | null;
  dpr: number | null;
  capturedPixels?: PixelDimensions | null;
  expectedCapturePixels?: PixelDimensions | null;
  exactSizeApplied?: boolean;
  tolerancePx?: number;
}): ViewportSizingReport {
  const tolerance = params.tolerancePx ?? 1;
  const { role, requestedSize, effectiveCssSize, dpr } = params;
  const capturedPixels = params.capturedPixels ?? null;

  const reasons: string[] = [];

  if (effectiveCssSize !== null) {
    const dw = Math.abs(effectiveCssSize.width - requestedSize.width);
    const dh = Math.abs(effectiveCssSize.height - requestedSize.height);
    if (dw > tolerance || dh > tolerance) {
      reasons.push(
        `effectiveCssSize ${effectiveCssSize.width}x${effectiveCssSize.height} != requestedSize ${requestedSize.width}x${requestedSize.height}`,
      );
    }
  }

  if (params.exactSizeApplied && capturedPixels !== null) {
    const effectiveDpr = dpr && Number.isFinite(dpr) && dpr > 0 ? dpr : requestedSize.dpr;
    const expW = params.expectedCapturePixels
      ? params.expectedCapturePixels.width
      : Math.round(requestedSize.width * effectiveDpr);
    const expH = params.expectedCapturePixels
      ? params.expectedCapturePixels.height
      : Math.round(requestedSize.height * effectiveDpr);
    const tolPx = Math.max(2, Math.ceil(effectiveDpr * 2));
    if (
      Math.abs(capturedPixels.width - expW) > tolPx ||
      Math.abs(capturedPixels.height - expH) > tolPx
    ) {
      reasons.push(
        `capturedPixels ${capturedPixels.width}x${capturedPixels.height} != expected ${expW}x${expH} (at dpr=${effectiveDpr})`,
      );
    }
  } else if (
    capturedPixels !== null &&
    effectiveCssSize === null &&
    !params.expectedCapturePixels &&
    (Math.abs(capturedPixels.width - requestedSize.width) > tolerance * 4 ||
      Math.abs(capturedPixels.height - requestedSize.height) > tolerance * 4)
  ) {
    reasons.push(
      `capturedPixels ${capturedPixels.width}x${capturedPixels.height} diverges from requestedSize ${requestedSize.width}x${requestedSize.height}`,
    );
  }

  const sizeMismatch = reasons.length > 0;
  return {
    role,
    requestedSize: {
      width: requestedSize.width,
      height: requestedSize.height,
      dpr: requestedSize.dpr,
    },
    effectiveCssSize,
    dpr,
    capturedPixels,
    ...(params.exactSizeApplied !== undefined ? { exactSizeApplied: params.exactSizeApplied } : {}),
    sizeMismatch,
    ...(sizeMismatch ? { mismatchReason: reasons.join('; ') } : {}),
  };
}
