use std::io::{Read, Write};

use anyhow::{Context, Result, bail};
use serde::{Serialize, de::DeserializeOwned};

/// Hard cap on a single RPC frame (8 MiB), matching `iron-term` and `app/src/shared/frame.ts`.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(value).context("serialize RPC frame")?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        bail!(
            "frame size {} exceeds MAX_FRAME_BYTES ({})",
            body.len(),
            MAX_FRAME_BYTES
        );
    }
    let len = u32::try_from(body.len()).context("frame length fits u32")?;
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn decode_frame<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        bail!(
            "frame size {} exceeds MAX_FRAME_BYTES ({})",
            body.len(),
            MAX_FRAME_BYTES
        );
    }
    serde_json::from_slice(body).context("deserialize RPC frame")
}

pub fn write_frame_sync<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    let encoded = encode_frame(value)?;
    writer.write_all(&encoded).context("write framed bytes")?;
    writer.flush().context("flush framed writer")?;
    Ok(())
}

pub fn read_frame_sync<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .context("read 4-byte frame length")?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        bail!("invalid frame length: {len} (max {MAX_FRAME_BYTES})");
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).context("read frame body")?;
    decode_frame(&body)
}

/// Truncate `input` to at most `max_bytes` UTF-8 bytes without splitting any codepoint.
pub fn truncate_utf8(input: &str, max_bytes: usize) -> (&str, bool) {
    if input.len() <= max_bytes {
        return (input, false);
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    (&input[..end], true)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn roundtrips_framed_json_value() {
        let req = json!({"id": 7, "method": "ping", "params": {}});
        let mut buf = Vec::new();
        write_frame_sync(&mut buf, &req).expect("write");
        let decoded: Value = read_frame_sync(&mut Cursor::new(buf)).expect("read");
        assert_eq!(decoded, req);
    }

    #[test]
    fn rejects_zero_and_oversized_frame_headers() {
        let zero = 0u32.to_le_bytes();
        let err_zero = read_frame_sync::<_, Value>(&mut Cursor::new(zero)).unwrap_err();
        assert!(err_zero.to_string().contains("invalid frame length"));

        let oversized = (MAX_FRAME_BYTES as u32 + 1).to_le_bytes();
        let err_big = read_frame_sync::<_, Value>(&mut Cursor::new(oversized)).unwrap_err();
        assert!(err_big.to_string().contains("invalid frame length"));
    }

    #[test]
    fn truncate_utf8_never_splits_multibyte_chars() {
        let s = "hi 🚀 日本語";
        let (prefix, truncated) = truncate_utf8(s, 5);
        assert!(truncated);
        assert!(prefix.len() <= 5);
        assert_eq!(prefix, "hi ");
    }
}
