import zlib from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface FilmstripTileInput {
  labelLines: string[];
  pngBuffer: Buffer;
  crop?: { x: number; y: number; width: number; height: number } | null;
}

export interface FilmstripRowInput {
  tiles: FilmstripTileInput[];
}

export interface FilmstripComposeResult {
  pngBuffer: Buffer;
  width: number;
  height: number;
  rows: number;
  columns: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes standard non-interlaced 8-bit PNG buffers (RGB, RGBA, Grayscale, Grayscale+Alpha, Indexed)
 * produced by Chromium CDP `Page.captureScreenshot` and Electron `NativeImage.toPNG()`.
 */
export function decodePngToRgba(pngBuf: Buffer): RgbaImage {
  if (!Buffer.isBuffer(pngBuf) || pngBuf.length < 33 || !pngBuf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= pngBuf.length) {
    const length = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBuf.length) {
      throw new Error(`Truncated PNG chunk: ${type}`);
    }
    const chunkData = pngBuf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (chunkData.length < 13) {
        throw new Error('Invalid PNG IHDR chunk length');
      }
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
      interlace = chunkData[12] ?? 0;
    } else if (type === 'PLTE') {
      palette = chunkData;
    } else if (type === 'tRNS') {
      trns = chunkData;
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  const MAX_PNG_DIM = 8192;
  const MAX_PNG_PIXELS = 16_777_216;
  const MAX_INFLATE_BYTES = 64 * 1024 * 1024;
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_PNG_DIM ||
    height > MAX_PNG_DIM ||
    width * height > MAX_PNG_PIXELS
  ) {
    throw new Error(`Invalid or oversized PNG dimensions: ${width}x${height}`);
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth} (expected 8)`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNG is not supported');
  }

  const channels =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 0 || colorType === 3
            ? 1
            : 0;
  if (channels === 0) {
    throw new Error(`Unsupported PNG colorType=${colorType}`);
  }

  const compressed = Buffer.concat(idatChunks);
  const inflated = zlib.inflateSync(compressed, {
    maxOutputLength: Math.min(width * height * 4 + height + 1024, MAX_INFLATE_BYTES),
  });

  const bpp = channels;
  const stride = width * bpp;
  if (inflated.length < height * (1 + stride)) {
    throw new Error('Decoded PNG scanline data shorter than expected');
  }

  const recon = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const srcRowStart = y * (1 + stride);
    const filterType = inflated[srcRowStart] ?? 0;
    const dstRowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[srcRowStart + 1 + x] ?? 0;
      const left = x >= bpp ? (recon[dstRowStart + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (recon[prevRowStart + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (recon[prevRowStart + x - bpp] ?? 0) : 0;

      let val = raw;
      if (filterType === 1) {
        val = (raw + left) & 0xff;
      } else if (filterType === 2) {
        val = (raw + up) & 0xff;
      } else if (filterType === 3) {
        val = (raw + ((left + up) >> 1)) & 0xff;
      } else if (filterType === 4) {
        val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      }
      recon[dstRowStart + x] = val;
    }
  }

  if (colorType === 6) {
    return { width, height, data: recon };
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const dst = i * 4;
    if (colorType === 2) {
      const src = i * 3;
      rgba[dst] = recon[src] ?? 0;
      rgba[dst + 1] = recon[src + 1] ?? 0;
      rgba[dst + 2] = recon[src + 2] ?? 0;
      rgba[dst + 3] = 255;
    } else if (colorType === 0) {
      const g = recon[i] ?? 0;
      rgba[dst] = g;
      rgba[dst + 1] = g;
      rgba[dst + 2] = g;
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const g = recon[i * 2] ?? 0;
      rgba[dst] = g;
      rgba[dst + 1] = g;
      rgba[dst + 2] = g;
      rgba[dst + 3] = recon[i * 2 + 1] ?? 255;
    } else if (colorType === 3) {
      const idx = recon[i] ?? 0;
      const pOff = idx * 3;
      rgba[dst] = palette && pOff + 2 < palette.length ? palette[pOff]! : 0;
      rgba[dst + 1] = palette && pOff + 2 < palette.length ? palette[pOff + 1]! : 0;
      rgba[dst + 2] = palette && pOff + 2 < palette.length ? palette[pOff + 2]! : 0;
      rgba[dst + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    }
  }

  return { width, height, data: rgba };
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  const crcInput = Buffer.concat([header.subarray(4, 8), data]);
  const crc = zlib.crc32(crcInput) >>> 0;
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(crc, 0);
  return Buffer.concat([header, data, trailer]);
}

export function encodeRgbaToPng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new Error('Invalid RGBA image buffer');
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const rawScanlines = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const dstOff = y * (1 + stride);
    rawScanlines[dstOff] = 0; // filter type 0 (None)
    const srcOff = y * stride;
    rawScanlines.set(data.subarray(srcOff, srcOff + stride), dstOff + 1);
  }

  const idatData = zlib.deflateSync(rawScanlines, { level: 6 });
  return Buffer.concat([
    PNG_SIG,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idatData),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function cropRgba(
  img: RgbaImage,
  clip: { x: number; y: number; width: number; height: number },
): RgbaImage {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(clip.x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(clip.y)));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(clip.width)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(clip.height)));

  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) {
    return img;
  }

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcStart = ((y0 + y) * img.width + x0) * 4;
    const dstStart = y * w * 4;
    out.set(img.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return { width: w, height: h, data: out };
}

export function resizeRgbaMaxWidth(img: RgbaImage, maxWidth: number): RgbaImage {
  const safeMaxW = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.round(maxWidth) : 520;
  if (img.width <= safeMaxW) return img;
  const ratio = safeMaxW / img.width;
  const dstW = Math.max(1, Math.round(img.width * ratio));
  const dstH = Math.max(1, Math.round(img.height * ratio));
  const out = new Uint8Array(dstW * dstH * 4);

  for (let y = 0; y < dstH; y += 1) {
    const srcY = Math.min(img.height - 1, Math.floor(y / ratio));
    for (let x = 0; x < dstW; x += 1) {
      const srcX = Math.min(img.width - 1, Math.floor(x / ratio));
      const sOff = (srcY * img.width + srcX) * 4;
      const dOff = (y * dstW + x) * 4;
      out[dOff] = img.data[sOff]!;
      out[dOff + 1] = img.data[sOff + 1]!;
      out[dOff + 2] = img.data[sOff + 2]!;
      out[dOff + 3] = img.data[sOff + 3]!;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

// Compact 5x7 uppercase/ASCII bitmap glyphs (each row is a 5-bit mask from MSB 0x10 to LSB 0x01).
const GLYPHS_5X7: Record<string, readonly number[]> = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  ':': [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
  '<': [0x01, 0x02, 0x04, 0x08, 0x04, 0x02, 0x01],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '[': [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  ']': [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  '#': [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
  '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

function fillRect(
  img: RgbaImage,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  color: readonly [number, number, number, number],
): void {
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(img.width, rx + rw);
  const y1 = Math.min(img.height, ry + rh);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const off = (y * img.width + x) * 4;
      img.data[off] = color[0];
      img.data[off + 1] = color[1];
      img.data[off + 2] = color[2];
      img.data[off + 3] = color[3];
    }
  }
}

export function drawBitmapText(
  img: RgbaImage,
  text: string,
  startX: number,
  startY: number,
  scale = 1,
  color: readonly [number, number, number, number] = [232, 240, 250, 255],
): void {
  const normalized = text.replace(/×/g, 'X').toUpperCase();
  const s = Math.max(1, Math.floor(scale));
  let cursorX = startX;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    const glyph = GLYPHS_5X7[ch] ?? GLYPHS_5X7['?']!;
    if (cursorX + 5 * s > img.width - 2) break;

    for (let gy = 0; gy < 7; gy += 1) {
      const rowBits = glyph[gy] ?? 0;
      for (let gx = 0; gx < 5; gx += 1) {
        if ((rowBits & (1 << (4 - gx))) !== 0) {
          fillRect(img, cursorX + gx * s, startY + gy * s, s, s, color);
        }
      }
    }
    cursorX += 6 * s;
  }
}

function addLabelHeader(tile: RgbaImage, lines: readonly string[]): RgbaImage {
  const fontScale = tile.width >= 420 ? 2 : 1;
  const lineHeight = 7 * fontScale + 5;
  const padY = 6;
  const headerH = Math.max(20, padY * 2 + lines.length * lineHeight);
  const outH = tile.height + headerH;
  const out: RgbaImage = {
    width: tile.width,
    height: outH,
    data: new Uint8Array(tile.width * outH * 4),
  };

  // Dark header bar + cyan accent rule
  fillRect(out, 0, 0, out.width, headerH, [11, 18, 32, 255]);
  fillRect(out, 0, headerH - 2, out.width, 2, [56, 189, 248, 255]);

  lines.forEach((line, idx) => {
    const color: readonly [number, number, number, number] =
      idx === 0 ? [241, 245, 249, 255] : [148, 163, 184, 255];
    drawBitmapText(out, line, 8, padY + idx * lineHeight, fontScale, color);
  });

  out.data.set(tile.data, headerH * tile.width * 4);
  return out;
}

/**
 * Composes a multi-step dual-pane labelled filmstrip PNG where each tile is stamped
 * with frame, seed, multiplier, phase, and viewport dimensions.
 */
export function composeFilmstripPng(
  rows: readonly FilmstripRowInput[],
  opts: { maxTileWidth?: number; gapPx?: number } = {},
): FilmstripComposeResult {
  if (rows.length === 0) {
    throw new Error('Cannot compose filmstrip from 0 rows');
  }

  const rawMaxW = opts.maxTileWidth;
  const maxTileWidth =
    typeof rawMaxW === 'number' && Number.isFinite(rawMaxW)
      ? Math.min(Math.max(Math.round(rawMaxW), 120), 1920)
      : 520;
  const gap = opts.gapPx ?? 8;

  const preparedRows: RgbaImage[][] = [];
  let maxCols = 0;

  for (const row of rows) {
    const rowImgs: RgbaImage[] = [];
    for (const tile of row.tiles) {
      let decoded = decodePngToRgba(tile.pngBuffer);
      if (tile.crop) {
        decoded = cropRgba(decoded, tile.crop);
      }
      decoded = resizeRgbaMaxWidth(decoded, maxTileWidth);
      const labelled = addLabelHeader(
        decoded,
        tile.labelLines.length > 0 ? tile.labelLines : ['FRAME'],
      );
      rowImgs.push(labelled);
    }
    if (rowImgs.length > maxCols) maxCols = rowImgs.length;
    preparedRows.push(rowImgs);
  }

  const colWidths = new Array<number>(maxCols).fill(0);
  const rowHeights = new Array<number>(preparedRows.length).fill(0);

  preparedRows.forEach((rImgs, rIdx) => {
    rImgs.forEach((img, cIdx) => {
      if (img.width > (colWidths[cIdx] ?? 0)) colWidths[cIdx] = img.width;
      if (img.height > (rowHeights[rIdx] ?? 0)) rowHeights[rIdx] = img.height;
    });
  });

  const totalW =
    colWidths.reduce((acc, w) => acc + w, 0) + gap * Math.max(0, maxCols + 1);
  const totalH =
    rowHeights.reduce((acc, h) => acc + h, 0) + gap * Math.max(0, preparedRows.length + 1);

  const canvas: RgbaImage = {
    width: Math.max(1, totalW),
    height: Math.max(1, totalH),
    data: new Uint8Array(Math.max(1, totalW) * Math.max(1, totalH) * 4),
  };
  fillRect(canvas, 0, 0, canvas.width, canvas.height, [6, 11, 19, 255]);

  let curY = gap;
  for (let r = 0; r < preparedRows.length; r += 1) {
    const rImgs = preparedRows[r]!;
    let curX = gap;
    for (let c = 0; c < maxCols; c += 1) {
      const tile = rImgs[c];
      if (tile) {
        for (let ty = 0; ty < tile.height; ty += 1) {
          const srcOff = ty * tile.width * 4;
          const dstOff = ((curY + ty) * canvas.width + curX) * 4;
          canvas.data.set(tile.data.subarray(srcOff, srcOff + tile.width * 4), dstOff);
        }
      }
      curX += (colWidths[c] ?? 0) + gap;
    }
    curY += (rowHeights[r] ?? 0) + gap;
  }

  return {
    pngBuffer: encodeRgbaToPng(canvas),
    width: canvas.width,
    height: canvas.height,
    rows: preparedRows.length,
    columns: maxCols,
  };
}
