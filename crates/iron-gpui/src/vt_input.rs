use gpui::Keystroke;

/// Translate a GPUI `Keystroke` into raw VT/ANSI bytes suitable for `ClientMsg::PtyInput`.
///
/// Returns `None` for non-emitting modifier keys, OS/platform chords (`Super`/`Cmd`),
/// and terminal clipboard chords (`Ctrl+Shift+C` / `Ctrl+Shift+V`) so copy/paste never
/// leaks `SIGINT` (`0x03`) or `SYN` (`0x16`) into the PTY.
pub fn keystroke_to_vt_bytes(ks: &Keystroke) -> Option<Vec<u8>> {
    encode_key_to_vt(
        &ks.key,
        ks.key_char.as_deref(),
        ks.modifiers.control,
        ks.modifiers.alt,
        ks.modifiers.shift,
        ks.modifiers.platform,
    )
}

/// Pure, platform-independent VT byte encoder for terminal keyboard forwarding.
pub fn encode_key_to_vt(
    key: &str,
    key_char: Option<&str>,
    ctrl: bool,
    alt: bool,
    shift: bool,
    platform: bool,
) -> Option<Vec<u8>> {
    if platform {
        return None;
    }

    let key_lower = key.to_ascii_lowercase();

    // Special named keys take priority over printable text.
    if let Some(seq) = encode_special_key(&key_lower, ctrl, alt, shift) {
        return Some(seq);
    }

    // Control chords (Ctrl+A .. Ctrl+Z, Ctrl+[, Ctrl+\, Ctrl+], Ctrl+^, Ctrl+_, Ctrl+Space).
    // Never emit SIGINT (0x03) on Ctrl+Shift+C or 0x16 on Ctrl+Shift+V (clipboard chords).
    if ctrl {
        if shift && matches!(key_lower.as_str(), "c" | "v") {
            return None;
        }
        if let Some(byte) = encode_ctrl_byte(&key_lower) {
            return Some(if alt { vec![0x1b, byte] } else { vec![byte] });
        }
        return None;
    }

    // Printable UTF-8 character input.
    let text = if let Some(ch) = key_char
        && !ch.is_empty()
        && !ch.chars().all(char::is_control)
    {
        ch.to_string()
    } else if key.chars().count() == 1 {
        let mut ch = key.chars().next()?;
        if shift && ch.is_ascii_lowercase() {
            ch = ch.to_ascii_uppercase();
        }
        ch.to_string()
    } else {
        return None;
    };

    let mut out = Vec::with_capacity(text.len() + usize::from(alt));
    if alt {
        out.push(0x1b);
    }
    out.extend_from_slice(text.as_bytes());
    Some(out)
}

fn encode_ctrl_byte(key_lower: &str) -> Option<u8> {
    if key_lower == "space" || key_lower == "@" || key_lower == "2" {
        return Some(0x00);
    }
    if key_lower.len() != 1 {
        return None;
    }
    let b = key_lower.as_bytes()[0];
    match b {
        b'a'..=b'z' => Some((b - b'a') + 1),
        b'[' | b'3' => Some(0x1b),
        b'\\' | b'4' => Some(0x1c),
        b']' | b'5' => Some(0x1d),
        b'^' | b'6' => Some(0x1e),
        b'_' | b'-' | b'7' => Some(0x1f),
        b'?' | b'8' => Some(0x7f),
        _ => None,
    }
}

fn encode_special_key(key_lower: &str, ctrl: bool, alt: bool, shift: bool) -> Option<Vec<u8>> {
    let modifier_code = xterm_modifier_code(ctrl, alt, shift);

    let bytes: Vec<u8> = match key_lower {
        "enter" | "return" => {
            if alt {
                vec![0x1b, b'\r']
            } else {
                vec![b'\r']
            }
        }
        "backspace" => {
            if alt {
                vec![0x1b, 0x7f]
            } else if ctrl {
                vec![0x08]
            } else {
                vec![0x7f]
            }
        }
        "tab" => {
            if shift {
                b"\x1b[Z".to_vec()
            } else {
                vec![b'\t']
            }
        }
        "escape" => vec![0x1b],
        "space" => {
            if ctrl {
                vec![0x00]
            } else if alt {
                vec![0x1b, b' ']
            } else {
                vec![b' ']
            }
        }
        "up" => csi_cursor(b'A', modifier_code),
        "down" => csi_cursor(b'B', modifier_code),
        "right" => csi_cursor(b'C', modifier_code),
        "left" => csi_cursor(b'D', modifier_code),
        "home" => csi_cursor(b'H', modifier_code),
        "end" => csi_cursor(b'F', modifier_code),
        "insert" => csi_tilde(2, modifier_code),
        "delete" => csi_tilde(3, modifier_code),
        "pageup" => csi_tilde(5, modifier_code),
        "pagedown" => csi_tilde(6, modifier_code),
        "f1" => b"\x1bOP".to_vec(),
        "f2" => b"\x1bOQ".to_vec(),
        "f3" => b"\x1bOR".to_vec(),
        "f4" => b"\x1bOS".to_vec(),
        "f5" => csi_tilde(15, modifier_code),
        "f6" => csi_tilde(17, modifier_code),
        "f7" => csi_tilde(18, modifier_code),
        "f8" => csi_tilde(19, modifier_code),
        "f9" => csi_tilde(20, modifier_code),
        "f10" => csi_tilde(21, modifier_code),
        "f11" => csi_tilde(23, modifier_code),
        "f12" => csi_tilde(24, modifier_code),
        _ => return None,
    };

    Some(bytes)
}

fn xterm_modifier_code(ctrl: bool, alt: bool, shift: bool) -> Option<u8> {
    let mut code = 1u8;
    if shift {
        code += 1;
    }
    if alt {
        code += 2;
    }
    if ctrl {
        code += 4;
    }
    (code > 1).then_some(code)
}

fn csi_cursor(final_byte: u8, modifier: Option<u8>) -> Vec<u8> {
    match modifier {
        Some(m) => format!("\x1b[1;{m}{}", final_byte as char).into_bytes(),
        None => vec![0x1b, b'[', final_byte],
    }
}

fn csi_tilde(code: u8, modifier: Option<u8>) -> Vec<u8> {
    match modifier {
        Some(m) => format!("\x1b[{code};{m}~").into_bytes(),
        None => format!("\x1b[{code}~").into_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_printable_utf8_and_shifted_ascii() {
        assert_eq!(
            encode_key_to_vt("a", Some("a"), false, false, false, false),
            Some(b"a".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("a", Some("A"), false, false, true, false),
            Some(b"A".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("n", Some("ñ"), false, false, false, false),
            Some("ñ".as_bytes().to_vec())
        );
        assert_eq!(
            encode_key_to_vt("b", Some("b"), false, true, false, false),
            Some(b"\x1bb".to_vec())
        );
    }

    #[test]
    fn encodes_navigation_and_editing_keys() {
        assert_eq!(
            encode_key_to_vt("enter", None, false, false, false, false),
            Some(b"\r".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("backspace", None, false, false, false, false),
            Some(vec![0x7f])
        );
        assert_eq!(
            encode_key_to_vt("tab", None, false, false, false, false),
            Some(b"\t".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("tab", None, false, false, true, false),
            Some(b"\x1b[Z".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("escape", None, false, false, false, false),
            Some(vec![0x1b])
        );
        assert_eq!(
            encode_key_to_vt("up", None, false, false, false, false),
            Some(b"\x1b[A".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("down", None, false, false, false, false),
            Some(b"\x1b[B".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("right", None, false, false, false, false),
            Some(b"\x1b[C".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("left", None, false, false, false, false),
            Some(b"\x1b[D".to_vec())
        );
        assert_eq!(
            encode_key_to_vt("delete", None, false, false, false, false),
            Some(b"\x1b[3~".to_vec())
        );
    }

    #[test]
    fn encodes_control_chords() {
        assert_eq!(
            encode_key_to_vt("c", None, true, false, false, false),
            Some(vec![0x03])
        );
        assert_eq!(
            encode_key_to_vt("d", None, true, false, false, false),
            Some(vec![0x04])
        );
        assert_eq!(
            encode_key_to_vt("l", None, true, false, false, false),
            Some(vec![0x0c])
        );
        assert_eq!(
            encode_key_to_vt("z", None, true, false, false, false),
            Some(vec![0x1a])
        );
        assert_eq!(
            encode_key_to_vt("a", None, true, false, false, false),
            Some(vec![0x01])
        );
    }

    #[test]
    fn ctrl_shift_c_and_v_do_not_emit_control_bytes() {
        assert_eq!(
            encode_key_to_vt("c", None, true, false, true, false),
            None,
            "Ctrl+Shift+C must never emit SIGINT (0x03)"
        );
        assert_eq!(
            encode_key_to_vt("C", Some("C"), true, false, true, false),
            None,
            "Ctrl+Shift+C must never emit SIGINT (0x03)"
        );
        assert_eq!(
            encode_key_to_vt("v", None, true, false, true, false),
            None,
            "Ctrl+Shift+V must not emit raw 0x16"
        );
    }

    #[test]
    fn ignores_platform_shortcuts() {
        assert_eq!(
            encode_key_to_vt("c", Some("c"), false, false, false, true),
            None
        );
    }
}
