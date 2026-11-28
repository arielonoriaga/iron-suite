/**
 * Length-prefixed JSON framing (4-byte little-endian u32 length + UTF-8 JSON body).
 * Mirrors `crates/iron-browser-mcp/src/frame.rs` and `iron-term`'s `iron-proto/src/frame.rs`.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error(
      `frame size ${body.length} exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`invalid frame length: ${length} (max ${MAX_FRAME_BYTES})`);
      }
      if (this.buffer.length < 4 + length) {
        break;
      }
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(body.toString('utf8')));
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Truncate a UTF-8 string so its encoded byte length never exceeds `maxBytes`,
 * strictly respecting UTF-8 codepoint boundaries (never splits multi-byte chars).
 */
export function truncateUtf8(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBuf = Buffer.from(input, 'utf8');
  const originalBytes = originalBuf.length;
  if (maxBytes <= 0) {
    return { text: '', truncated: originalBytes > 0, originalBytes };
  }
  if (originalBytes <= maxBytes) {
    return { text: input, truncated: false, originalBytes };
  }
  // Walk back from maxBytes so we never slice in the middle of a UTF-8 continuation byte (10xxxxxx).
  let end = maxBytes;
  while (end > 0 && (originalBuf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: originalBuf.subarray(0, end).toString('utf8'),
    truncated: true,
    originalBytes,
  };
}
