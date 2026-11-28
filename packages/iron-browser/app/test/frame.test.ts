import { describe, expect, test } from 'bun:test';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, truncateUtf8 } from '../src/shared/frame';

describe('length-prefixed RPC framing & UTF-8 cap', () => {
  test('roundtrips framed messages across arbitrary chunk splits', () => {
    const a = { id: 1, method: 'browser_tabs', params: {} };
    const b = { id: 2, method: 'browser_metrics', params: { tab_id: 'tab-1' } };
    const wire = Buffer.concat([encodeFrame(a), encodeFrame(b)]);

    // Verify 4-byte LE header matches JSON byte length
    const expectedLenA = Buffer.byteLength(JSON.stringify(a), 'utf8');
    expect(wire.readUInt32LE(0)).toBe(expectedLenA);

    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < wire.length; i += 3) {
      out.push(...decoder.push(wire.subarray(i, i + 3)));
    }
    expect(out).toEqual([a, b]);
  });

  test('fails closed on zero-length or oversized frame headers', () => {
    const decoder = new FrameDecoder();
    const zero = Buffer.alloc(4);
    zero.writeUInt32LE(0, 0);
    expect(() => decoder.push(zero)).toThrow('invalid frame length');

    const tooBig = Buffer.alloc(4);
    tooBig.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(tooBig)).toThrow('invalid frame length');
  });

  test('truncateUtf8 respects multibyte UTF-8 boundaries', () => {
    const text = 'hello 🚀 mundo 日本語';
    const res = truncateUtf8(text, 8);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(8);
    expect(res.text).toBe('hello ');
  });
});
