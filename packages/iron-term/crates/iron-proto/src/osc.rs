use serde::{Deserialize, Serialize};

use crate::types::{AgentState, StructuredPrompt};

/// Private OSC 7770 payload emitted by child CLIs (`\x1b]7770;<json>\x07` or ST `\x1b\\`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum OscEvent {
    Checkpoint {
        text: String,
    },
    Phase {
        phase: String,
    },
    State {
        state: AgentState,
        checkpoint: Option<String>,
        prompt: Option<StructuredPrompt>,
    },
}

const OSC_PREFIX: &[u8] = b"\x1b]7770;";
pub const MAX_OSC_PAYLOAD: usize = 64 * 1024;

/// Stateful streaming scanner that extracts `OSC 7770` control sequences across arbitrary
/// PTY chunk boundaries while passing all normal terminal bytes untouched.
/// Oversized or unterminated `OSC 7770` sequences are discarded without leaking into the VT grid.
#[derive(Debug, Default)]
pub struct OscScanner {
    pending: Vec<u8>,
    discarding_osc: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw PTY bytes and return `(clean_terminal_bytes, extracted_events)`.
    pub fn push(&mut self, input: &[u8]) -> (Vec<u8>, Vec<OscEvent>) {
        if input.is_empty() {
            return (Vec::new(), Vec::new());
        }
        self.pending.extend_from_slice(input);
        let mut clean = Vec::with_capacity(self.pending.len());
        let mut events = Vec::new();
        let mut idx = 0;

        while idx < self.pending.len() {
            if self.discarding_osc {
                let rem = &self.pending[idx..];
                if let Some((term_pos, term_len)) = find_osc_terminator(rem) {
                    idx += term_pos + term_len;
                    self.discarding_osc = false;
                    continue;
                }
                // Keep a trailing 0x1b byte in case ST (`\x1b\\`) spans the next chunk.
                if rem.last() == Some(&0x1b) {
                    idx = self.pending.len() - 1;
                } else {
                    idx = self.pending.len();
                }
                break;
            }

            let rem = &self.pending[idx..];
            if let Some(esc_pos) = rem.iter().position(|&b| b == 0x1b) {
                clean.extend_from_slice(&rem[..esc_pos]);
                idx += esc_pos;
                let tail = &self.pending[idx..];

                if tail.len() < OSC_PREFIX.len() {
                    if OSC_PREFIX.starts_with(tail) {
                        break;
                    } else {
                        clean.push(tail[0]);
                        idx += 1;
                        continue;
                    }
                }

                if !tail.starts_with(OSC_PREFIX) {
                    clean.push(tail[0]);
                    idx += 1;
                    continue;
                }

                let payload_start = idx + OSC_PREFIX.len();
                let search_slice = &self.pending[payload_start..];
                match find_osc_terminator(search_slice) {
                    Some((payload_len, term_len)) => {
                        if payload_len <= MAX_OSC_PAYLOAD {
                            let payload = &self.pending[payload_start..payload_start + payload_len];
                            if let Ok(ev) = serde_json::from_slice::<OscEvent>(payload) {
                                events.push(ev);
                            }
                        }
                        idx = payload_start + payload_len + term_len;
                    }
                    None => {
                        if search_slice.len() > MAX_OSC_PAYLOAD {
                            // Oversized or unterminated OSC 7770: discard silently without leaking to VT.
                            self.discarding_osc = true;
                            if search_slice.last() == Some(&0x1b) {
                                idx = self.pending.len() - 1;
                            } else {
                                idx = self.pending.len();
                            }
                            break;
                        } else {
                            break;
                        }
                    }
                }
            } else {
                clean.extend_from_slice(rem);
                idx = self.pending.len();
            }
        }

        self.pending.drain(..idx);
        (clean, events)
    }
}

fn find_osc_terminator(slice: &[u8]) -> Option<(usize, usize)> {
    for (i, &b) in slice.iter().enumerate() {
        if b == 0x07 {
            return Some((i, 1));
        }
        if b == 0x1b && i + 1 < slice.len() && slice[i + 1] == b'\\' {
            return Some((i, 2));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bel_and_st_events_across_split_chunks() {
        let mut scanner = OscScanner::new();
        let raw = b"hello \x1b]7770;{\"event\":\"checkpoint\",\"text\":\"tests green\"}\x07 world \x1b]7770;{\"event\":\"phase\",\"phase\":\"verify\"}\x1b\\!";
        let mut all_clean = Vec::new();
        let mut all_events = Vec::new();
        for chunk in raw.chunks(5) {
            let (c, e) = scanner.push(chunk);
            all_clean.extend_from_slice(&c);
            all_events.extend(e);
        }
        assert_eq!(String::from_utf8(all_clean).unwrap(), "hello  world !");
        assert_eq!(all_events.len(), 2);
        assert_eq!(
            all_events[0],
            OscEvent::Checkpoint {
                text: "tests green".to_string()
            }
        );
        assert_eq!(
            all_events[1],
            OscEvent::Phase {
                phase: "verify".to_string()
            }
        );
    }

    #[test]
    fn preserves_regular_ansi_escapes() {
        let mut scanner = OscScanner::new();
        let ansi = b"\x1b[32mgreen\x1b[0m\x1b]0;window title\x07";
        let (clean, events) = scanner.push(ansi);
        assert_eq!(clean, ansi);
        assert!(events.is_empty());
    }

    #[test]
    fn discards_oversized_and_unterminated_osc_without_leaking_to_vt() {
        let mut scanner = OscScanner::new();
        let mut huge = Vec::new();
        huge.extend_from_slice(b"BEFORE");
        huge.extend_from_slice(b"\x1b]7770;{\"event\":\"checkpoint\",\"text\":\"");
        huge.extend(std::iter::repeat_n(b'A', MAX_OSC_PAYLOAD + 1024));
        huge.extend_from_slice(b"\"}\x07AFTER");

        // Test both single-chunk and split-chunk delivery.
        let (c1, e1) = scanner.push(&huge);
        assert_eq!(String::from_utf8(c1).unwrap(), "BEFOREAFTER");
        assert!(e1.is_empty());

        let mut scanner2 = OscScanner::new();
        let mut clean_all = Vec::new();
        let mut ev_all = Vec::new();
        for chunk in huge.chunks(4096) {
            let (c, e) = scanner2.push(chunk);
            clean_all.extend_from_slice(&c);
            ev_all.extend(e);
        }
        assert_eq!(String::from_utf8(clean_all).unwrap(), "BEFOREAFTER");
        assert!(ev_all.is_empty());
    }
}
