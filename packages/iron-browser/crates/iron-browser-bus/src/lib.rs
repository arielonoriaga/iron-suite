pub mod napi;
pub mod pty;

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_EVENTS_PER_TAB: usize = 2048;
pub const MIN_EVENTS_PER_TAB: usize = 64;
pub const MAX_EVENTS_PER_TAB_CAP: usize = 16_384;
pub const MAX_TRACKED_TABS: usize = 64;
pub const MAX_CLAIMS_PER_TAB: usize = 256;
pub const MAX_SUMMARY_BYTES: usize = 1024;
pub const MAX_DETAIL_BYTES: usize = 4096;
pub const MAX_STORAGE_ORIGINS_PER_TAB: usize = 16;
pub const MAX_STORAGE_KEYS_PER_ORIGIN: usize = 256;
pub const MAX_STORAGE_BYTES_PER_ORIGIN: usize = 512 * 1024;
pub const GESTURE_CAUSAL_WINDOW_MS: u64 = 1000;

const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "sessiontoken",
    "session_token",
    "session",
    "auth",
    "key",
    "apikey",
    "api_key",
    "secret",
    "ticket",
    "code",
    "password",
    "passwd",
    "sig",
    "signature",
];

pub fn truncate_utf8_safe(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    input[..end].to_string()
}

pub fn is_valid_http_origin(origin: &str) -> bool {
    if origin.is_empty() || origin.len() > 512 || origin == "null" {
        return false;
    }
    let rest = if let Some(r) = origin.strip_prefix("https://") {
        r
    } else if let Some(r) = origin.strip_prefix("http://") {
        r
    } else {
        return false;
    };
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.bytes().any(|b| b <= 0x20 || b == 0x7f)
    {
        return false;
    }
    true
}

pub fn redact_sensitive_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'?' || b == b'&' || b == b'#' {
            out.push(b as char);
            i += 1;
            let key_start = i;
            while i < bytes.len()
                && bytes[i] != b'='
                && bytes[i] != b'&'
                && bytes[i] != b'?'
                && bytes[i] != b'#'
                && bytes[i] != b'/'
                && bytes[i] != b'"'
                && bytes[i] != b'\''
                && !bytes[i].is_ascii_whitespace()
            {
                i += 1;
            }
            let key = &text[key_start..i];
            out.push_str(key);
            if i < bytes.len() && bytes[i] == b'=' {
                out.push('=');
                i += 1;
                let val_start = i;
                while i < bytes.len()
                    && bytes[i] != b'&'
                    && bytes[i] != b'#'
                    && bytes[i] != b'"'
                    && bytes[i] != b'\''
                    && !bytes[i].is_ascii_whitespace()
                {
                    i += 1;
                }
                let key_lower = key.to_ascii_lowercase();
                if SENSITIVE_QUERY_KEYS.iter().any(|k| *k == key_lower) {
                    out.push_str("[REDACTED]");
                } else {
                    out.push_str(&text[val_start..i]);
                }
            }
        } else {
            let ch = text[i..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BusEvent {
    pub seq: u64,
    pub ts_ms: u64,
    pub tab_id: String,
    pub viewport: String,
    pub domain: String,
    pub kind: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gesture_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishInput {
    pub tab_id: String,
    #[serde(default = "default_viewport")]
    pub viewport: String,
    pub domain: String,
    pub kind: String,
    pub summary: String,
    pub ts_ms: u64,
    #[serde(default)]
    pub gesture_seq: Option<u64>,
    #[serde(default)]
    pub detail: Option<String>,
}

fn default_viewport() -> String {
    "both".to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub allowed: bool,
    pub seq: u64,
    pub owner_seq: u64,
    pub gesture_seq: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorageOpInput {
    pub op: String,
    pub tab_id: String,
    pub origin: String,
    #[serde(default = "default_viewport")]
    pub viewport: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    pub ts_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorageOpResult {
    pub ok: bool,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryFilter {
    pub tab_id: Option<String>,
    pub domain: Option<String>,
    pub viewport: Option<String>,
    pub since_seq: Option<u64>,
    pub gesture_seq: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub backend: &'static str,
    pub latest_seq: u64,
    pub total_published: u64,
    pub total_suppressed: u64,
    pub count: usize,
    pub events: Vec<BusEvent>,
}

#[derive(Debug, Clone)]
struct ActiveGesture {
    seq: u64,
    ts_ms: u64,
}

#[derive(Debug, Clone)]
struct EffectClaim {
    seq: u64,
    source_role: String,
    ts_ms: u64,
    window_ms: u64,
    gesture_seq: Option<u64>,
}

#[derive(Debug, Default)]
struct OriginStorageBucket {
    entries: BTreeMap<String, String>,
    used_bytes: usize,
}

#[derive(Debug)]
struct TabBusState {
    last_touched_seq: u64,
    active_gesture: Option<ActiveGesture>,
    events: VecDeque<BusEvent>,
    claims: HashMap<String, EffectClaim>,
    session_storage: HashMap<String, OriginStorageBucket>,
}

impl TabBusState {
    fn new(seq: u64, cap: usize) -> Self {
        Self {
            last_touched_seq: seq,
            active_gesture: None,
            events: VecDeque::with_capacity(cap.min(512)),
            claims: HashMap::new(),
            session_storage: HashMap::new(),
        }
    }
}

pub struct TabEventBusCore {
    max_events_per_tab: usize,
    next_seq: u64,
    total_published: u64,
    total_suppressed: u64,
    tabs: HashMap<String, TabBusState>,
}

impl TabEventBusCore {
    pub fn new(max_events_per_tab: usize) -> Self {
        Self {
            max_events_per_tab: max_events_per_tab.clamp(MIN_EVENTS_PER_TAB, MAX_EVENTS_PER_TAB_CAP),
            next_seq: 1,
            total_published: 0,
            total_suppressed: 0,
            tabs: HashMap::new(),
        }
    }

    fn alloc_seq(&mut self) -> u64 {
        let s = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        s
    }

    fn ensure_tab_mut(&mut self, tab_id: &str, touch_seq: u64) -> &mut TabBusState {
        let safe_id = truncate_utf8_safe(tab_id, 64);
        if !self.tabs.contains_key(&safe_id) {
            if self.tabs.len() >= MAX_TRACKED_TABS
                && let Some(oldest_key) = self
                    .tabs
                    .iter()
                    .min_by_key(|(_, st)| st.last_touched_seq)
                    .map(|(k, _)| k.clone())
            {
                self.tabs.remove(&oldest_key);
            }
            let cap = self.max_events_per_tab;
            self.tabs
                .insert(safe_id.clone(), TabBusState::new(touch_seq, cap));
            return self.tabs.get_mut(&safe_id).expect("inserted tab");
        }
        let st = self.tabs.get_mut(&safe_id).expect("existing tab");
        st.last_touched_seq = touch_seq;
        st
    }

    fn resolve_causal_gesture(tab: &TabBusState, now_ms: u64) -> Option<u64> {
        let g = tab.active_gesture.as_ref()?;
        if now_ms.saturating_sub(g.ts_ms) <= GESTURE_CAUSAL_WINDOW_MS {
            Some(g.seq)
        } else {
            None
        }
    }

    fn push_tab_event(&mut self, event: BusEvent) {
        let max_cap = self.max_events_per_tab;
        let seq = event.seq;
        let tab_id = event.tab_id.clone();
        let tab = self.ensure_tab_mut(&tab_id, seq);
        if tab.events.len() >= max_cap {
            tab.events.pop_front();
        }
        tab.events.push_back(event);
        self.total_published = self.total_published.saturating_add(1);
    }

    pub fn begin_gesture(
        &mut self,
        tab_id: &str,
        source_role: &str,
        action: &str,
        now_ms: u64,
    ) -> u64 {
        let seq = self.alloc_seq();
        let safe_tab = truncate_utf8_safe(tab_id, 64);
        let safe_role = truncate_utf8_safe(source_role, 16);
        let safe_action = truncate_utf8_safe(action, 64);
        {
            let tab = self.ensure_tab_mut(&safe_tab, seq);
            tab.active_gesture = Some(ActiveGesture { seq, ts_ms: now_ms });
        }
        self.push_tab_event(BusEvent {
            seq,
            ts_ms: now_ms,
            tab_id: safe_tab,
            viewport: safe_role.clone(),
            domain: "gesture".to_string(),
            kind: safe_action.clone(),
            summary: format!("gesture:{safe_action} on {safe_role}"),
            gesture_seq: Some(seq),
            detail: None,
        });
        seq
    }

    pub fn publish(&mut self, input: PublishInput) -> u64 {
        let seq = self.alloc_seq();
        let safe_tab = truncate_utf8_safe(&input.tab_id, 64);
        let inferred_gesture = input.gesture_seq.or_else(|| {
            self.tabs
                .get(&safe_tab)
                .and_then(|t| Self::resolve_causal_gesture(t, input.ts_ms))
        });

        let redacted_summary = redact_sensitive_tokens(&input.summary);
        let safe_summary = truncate_utf8_safe(&redacted_summary, MAX_SUMMARY_BYTES);
        let safe_detail = input.detail.as_deref().map(|d| {
            let red = redact_sensitive_tokens(d);
            truncate_utf8_safe(&red, MAX_DETAIL_BYTES)
        });

        self.push_tab_event(BusEvent {
            seq,
            ts_ms: input.ts_ms,
            tab_id: safe_tab,
            viewport: truncate_utf8_safe(&input.viewport, 16),
            domain: truncate_utf8_safe(&input.domain, 32),
            kind: truncate_utf8_safe(&input.kind, 64),
            summary: safe_summary,
            gesture_seq: inferred_gesture,
            detail: safe_detail,
        });
        seq
    }

    pub fn claim_effect(
        &mut self,
        tab_id: &str,
        role: &str,
        category: &str,
        effect_key: &str,
        window_ms: u64,
        now_ms: u64,
    ) -> ClaimOutcome {
        let seq = self.alloc_seq();
        let safe_tab = truncate_utf8_safe(tab_id, 64);
        let safe_role = truncate_utf8_safe(role, 16);
        let safe_cat = truncate_utf8_safe(category, 32);
        let safe_key = truncate_utf8_safe(effect_key, 512);
        let composite_key = format!("{safe_cat}|{safe_key}");
        let effective_window = window_ms.clamp(1, 30_000);

        let (matched_owner, gesture_seq) = {
            let tab = self.ensure_tab_mut(&safe_tab, seq);
            tab.claims
                .retain(|_, c| now_ms.saturating_sub(c.ts_ms) <= c.window_ms);
            let current_gesture = Self::resolve_causal_gesture(tab, now_ms);

            if let Some(existing) = tab.claims.get(&composite_key)
                && existing.source_role != safe_role
                && now_ms.saturating_sub(existing.ts_ms) <= existing.window_ms
            {
                let owner_seq = existing.seq;
                let g_seq = existing.gesture_seq.or(current_gesture);
                tab.claims.remove(&composite_key);
                (Some(owner_seq), g_seq)
            } else {
                if tab.claims.len() >= MAX_CLAIMS_PER_TAB
                    && let Some(oldest_k) = tab
                        .claims
                        .iter()
                        .min_by_key(|(_, c)| c.seq)
                        .map(|(k, _)| k.clone())
                {
                    tab.claims.remove(&oldest_k);
                }
                tab.claims.insert(
                    composite_key,
                    EffectClaim {
                        seq,
                        source_role: safe_role.clone(),
                        ts_ms: now_ms,
                        window_ms: effective_window,
                        gesture_seq: current_gesture,
                    },
                );
                (None, current_gesture)
            }
        };

        let redacted_key = truncate_utf8_safe(&redact_sensitive_tokens(&safe_key), 240);
        if let Some(owner_seq) = matched_owner {
            self.total_suppressed = self.total_suppressed.saturating_add(1);
            self.push_tab_event(BusEvent {
                seq,
                ts_ms: now_ms,
                tab_id: safe_tab,
                viewport: safe_role,
                domain: safe_cat.clone(),
                kind: "dedup_suppressed".to_string(),
                summary: format!("suppressed duplicate {safe_cat} ({redacted_key}) -> owner #{owner_seq}"),
                gesture_seq,
                detail: None,
            });
            ClaimOutcome {
                allowed: false,
                seq,
                owner_seq,
                gesture_seq,
            }
        } else {
            self.push_tab_event(BusEvent {
                seq,
                ts_ms: now_ms,
                tab_id: safe_tab,
                viewport: safe_role,
                domain: safe_cat.clone(),
                kind: "effect_claimed".to_string(),
                summary: format!("claimed {safe_cat} ({redacted_key})"),
                gesture_seq,
                detail: None,
            });
            ClaimOutcome {
                allowed: true,
                seq,
                owner_seq: seq,
                gesture_seq,
            }
        }
    }

    pub fn session_storage_op(&mut self, input: SessionStorageOpInput) -> SessionStorageOpResult {
        let safe_tab = truncate_utf8_safe(&input.tab_id, 64);
        if input.op == "clear_tab" {
            let mut cleared = false;
            if let Some(tab) = self.tabs.get_mut(&safe_tab)
                && !tab.session_storage.is_empty()
            {
                tab.session_storage.clear();
                cleared = true;
            }
            return SessionStorageOpResult {
                ok: true,
                changed: cleared,
                entries: None,
                error: None,
            };
        }
        if !is_valid_http_origin(&input.origin) {
            return SessionStorageOpResult {
                ok: false,
                changed: false,
                entries: None,
                error: Some("invalid http/https origin".to_string()),
            };
        }
        let safe_vp = truncate_utf8_safe(&input.viewport, 16);

        match input.op.as_str() {
            "snapshot" => {
                let entries = self
                    .tabs
                    .get(&safe_tab)
                    .and_then(|t| t.session_storage.get(&input.origin))
                    .map(|b| b.entries.clone())
                    .unwrap_or_default();
                SessionStorageOpResult {
                    ok: true,
                    changed: false,
                    entries: Some(entries),
                    error: None,
                }
            }
            "set" => {
                let Some(key) = input.key else {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("key is required".to_string()),
                    };
                };
                let val = input.value.unwrap_or_default();
                let item_bytes = key.len().saturating_add(val.len());
                if item_bytes > MAX_STORAGE_BYTES_PER_ORIGIN {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("sessionStorage quota exceeded".to_string()),
                    };
                }

                let seq = self.alloc_seq();
                let gesture_seq = self
                    .tabs
                    .get(&safe_tab)
                    .and_then(|t| Self::resolve_causal_gesture(t, input.ts_ms));

                let tab = self.ensure_tab_mut(&safe_tab, seq);
                if !tab.session_storage.contains_key(&input.origin)
                    && tab.session_storage.len() >= MAX_STORAGE_ORIGINS_PER_TAB
                {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("max origins per tab exceeded".to_string()),
                    };
                }
                let bucket = tab
                    .session_storage
                    .entry(input.origin.clone())
                    .or_default();

                let existing_bytes = bucket
                    .entries
                    .get(&key)
                    .map(|old| key.len() + old.len())
                    .unwrap_or(0);
                if !bucket.entries.contains_key(&key)
                    && bucket.entries.len() >= MAX_STORAGE_KEYS_PER_ORIGIN
                {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("max keys per origin exceeded".to_string()),
                    };
                }
                let next_used = bucket.used_bytes.saturating_sub(existing_bytes) + item_bytes;
                if next_used > MAX_STORAGE_BYTES_PER_ORIGIN {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("sessionStorage quota exceeded".to_string()),
                    };
                }

                let changed = bucket.entries.get(&key) != Some(&val);
                if changed {
                    bucket.used_bytes = next_used;
                    bucket.entries.insert(key.clone(), val.clone());
                }

                if changed {
                    let safe_key_preview = truncate_utf8_safe(&key, 96);
                    let val_len = val.len();
                    self.push_tab_event(BusEvent {
                        seq,
                        ts_ms: input.ts_ms,
                        tab_id: safe_tab,
                        viewport: safe_vp,
                        domain: "storage".to_string(),
                        kind: "session_set".to_string(),
                        summary: format!("sessionStorage.setItem({safe_key_preview}, {val_len}B)"),
                        gesture_seq,
                        detail: None,
                    });
                }

                SessionStorageOpResult {
                    ok: true,
                    changed,
                    entries: None,
                    error: None,
                }
            }
            "remove" => {
                let Some(key) = input.key else {
                    return SessionStorageOpResult {
                        ok: false,
                        changed: false,
                        entries: None,
                        error: Some("key is required".to_string()),
                    };
                };
                let seq = self.alloc_seq();
                let gesture_seq = self
                    .tabs
                    .get(&safe_tab)
                    .and_then(|t| Self::resolve_causal_gesture(t, input.ts_ms));
                let mut removed = false;
                if let Some(tab) = self.tabs.get_mut(&safe_tab)
                    && let Some(bucket) = tab.session_storage.get_mut(&input.origin)
                    && let Some(old_val) = bucket.entries.remove(&key)
                {
                    bucket.used_bytes = bucket
                        .used_bytes
                        .saturating_sub(key.len() + old_val.len());
                    removed = true;
                }
                if removed {
                    let safe_key_preview = truncate_utf8_safe(&key, 96);
                    self.push_tab_event(BusEvent {
                        seq,
                        ts_ms: input.ts_ms,
                        tab_id: safe_tab,
                        viewport: safe_vp,
                        domain: "storage".to_string(),
                        kind: "session_remove".to_string(),
                        summary: format!("sessionStorage.removeItem({safe_key_preview})"),
                        gesture_seq,
                        detail: None,
                    });
                }
                SessionStorageOpResult {
                    ok: true,
                    changed: removed,
                    entries: None,
                    error: None,
                }
            }
            "clear" => {
                let seq = self.alloc_seq();
                let gesture_seq = self
                    .tabs
                    .get(&safe_tab)
                    .and_then(|t| Self::resolve_causal_gesture(t, input.ts_ms));
                let mut cleared = false;
                if let Some(tab) = self.tabs.get_mut(&safe_tab)
                    && let Some(bucket) = tab.session_storage.get_mut(&input.origin)
                    && !bucket.entries.is_empty()
                {
                    bucket.entries.clear();
                    bucket.used_bytes = 0;
                    cleared = true;
                }
                if cleared {
                    self.push_tab_event(BusEvent {
                        seq,
                        ts_ms: input.ts_ms,
                        tab_id: safe_tab,
                        viewport: safe_vp,
                        domain: "storage".to_string(),
                        kind: "session_clear".to_string(),
                        summary: format!("sessionStorage.clear({})", input.origin),
                        gesture_seq,
                        detail: None,
                    });
                }
                SessionStorageOpResult {
                    ok: true,
                    changed: cleared,
                    entries: None,
                    error: None,
                }
            }
            _ => SessionStorageOpResult {
                ok: false,
                changed: false,
                entries: None,
                error: Some("unsupported storage op".to_string()),
            },
        }
    }

    pub fn query(&self, filter: &QueryFilter) -> QueryResult {
        let limit = filter.limit.unwrap_or(50).clamp(1, 500);
        let since = filter.since_seq.unwrap_or(0);

        let mut matched: Vec<BusEvent> = Vec::new();
        let collect_from_tab = |tab: &TabBusState, out: &mut Vec<BusEvent>| {
            for ev in &tab.events {
                if ev.seq <= since {
                    continue;
                }
                if let Some(ref d) = filter.domain
                    && d != "all"
                    && &ev.domain != d
                {
                    continue;
                }
                if let Some(ref vp) = filter.viewport
                    && vp != "both"
                    && &ev.viewport != vp
                    && ev.viewport != "both"
                {
                    continue;
                }
                if let Some(g_seq) = filter.gesture_seq
                    && ev.gesture_seq != Some(g_seq)
                {
                    continue;
                }
                out.push(ev.clone());
            }
        };

        if let Some(ref tab_id) = filter.tab_id {
            let safe_id = truncate_utf8_safe(tab_id, 64);
            if let Some(tab) = self.tabs.get(&safe_id) {
                collect_from_tab(tab, &mut matched);
            }
        } else {
            for tab in self.tabs.values() {
                collect_from_tab(tab, &mut matched);
            }
            matched.sort_by_key(|e| e.seq);
        }

        if matched.len() > limit {
            let drain_count = matched.len() - limit;
            matched.drain(0..drain_count);
        }

        QueryResult {
            backend: "rust-napi",
            latest_seq: self.next_seq.saturating_sub(1),
            total_published: self.total_published,
            total_suppressed: self.total_suppressed,
            count: matched.len(),
            events: matched,
        }
    }

    pub fn clear_tab(&mut self, tab_id: &str) -> bool {
        let safe_id = truncate_utf8_safe(tab_id, 64);
        self.tabs.remove(&safe_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn causal_gesture_links_downstream_events_and_expires_after_window() {
        let mut bus = TabEventBusCore::new(128);
        let g_seq = bus.begin_gesture("tab-1", "portrait", "click", 1000);
        assert_eq!(g_seq, 1);

        let e_seq = bus.publish(PublishInput {
            tab_id: "tab-1".into(),
            viewport: "landscape".into(),
            domain: "ws_mux".into(),
            kind: "outbound_dedup".into(),
            summary: "wss://game.example.com/ws?token=SECRET_123&lang=en".into(),
            ts_ms: 1450,
            gesture_seq: None,
            detail: None,
        });
        assert_eq!(e_seq, 2);

        // Event after 1000ms causal window does NOT inherit stale gesture_seq
        bus.publish(PublishInput {
            tab_id: "tab-1".into(),
            viewport: "portrait".into(),
            domain: "console".into(),
            kind: "error".into(),
            summary: "late independent log".into(),
            ts_ms: 2500,
            gesture_seq: None,
            detail: None,
        });

        let res = bus.query(&QueryFilter {
            tab_id: Some("tab-1".into()),
            ..Default::default()
        });
        assert_eq!(res.count, 3);
        assert_eq!(res.events[1].gesture_seq, Some(1));
        assert!(res.events[1].summary.contains("token=[REDACTED]&lang=en"));
        assert!(!res.events[1].summary.contains("SECRET_123"));
        assert_eq!(res.events[2].gesture_seq, None);

        // F-13 regression: hash-router SPA URLs and flag-before-fragment URLs must redact secrets
        let red_hash = redact_sensitive_tokens(
            "https://casino.example.com/#/launch?token=HASH_ROUTE_SECRET_123&lang=EN",
        );
        assert_eq!(
            red_hash,
            "https://casino.example.com/#/launch?token=[REDACTED]&lang=EN"
        );
        let red_flag =
            redact_sensitive_tokens("https://app.example.com/?debug#access_token=FRAG_SECRET_456");
        assert_eq!(
            red_flag,
            "https://app.example.com/?debug#access_token=[REDACTED]"
        );
    }

    #[test]
    fn claim_effect_deduplicates_cross_viewport_popups_and_downloads_consume_once() {
        let mut bus = TabEventBusCore::new(128);
        let g = bus.begin_gesture("tab-1", "portrait", "click", 5000);

        // Portrait claims download first -> allowed
        let c1 = bus.claim_effect(
            "tab-1",
            "portrait",
            "download",
            "https://cdn.example.com/report.csv|report.csv",
            1500,
            5010,
        );
        assert!(c1.allowed);
        assert_eq!(c1.gesture_seq, Some(g));

        // Landscape mirrored click 12ms later -> suppressed consume-once!
        let c2 = bus.claim_effect(
            "tab-1",
            "landscape",
            "download",
            "https://cdn.example.com/report.csv|report.csv",
            1500,
            5022,
        );
        assert!(!c2.allowed);
        assert_eq!(c2.owner_seq, c1.seq);
        assert_eq!(bus.total_suppressed, 1);

        // Subsequent click on Landscape after consume-once -> allowed again!
        let c3 = bus.claim_effect(
            "tab-1",
            "landscape",
            "download",
            "https://cdn.example.com/report.csv|report.csv",
            1500,
            5100,
        );
        assert!(c3.allowed);
    }

    #[test]
    fn session_storage_enforces_strict_origin_isolation_and_byte_caps_without_leaking_values_to_log() {
        let mut bus = TabEventBusCore::new(128);
        assert!(!bus
            .session_storage_op(SessionStorageOpInput {
                op: "set".into(),
                tab_id: "tab-1".into(),
                origin: "javascript:alert(1)".into(),
                viewport: "portrait".into(),
                key: Some("k".into()),
                value: Some("v".into()),
                ts_ms: 100,
            })
            .ok);

        let set_res = bus.session_storage_op(SessionStorageOpInput {
            op: "set".into(),
            tab_id: "tab-1".into(),
            origin: "https://aviator-demo.spribegaming.com".into(),
            viewport: "portrait".into(),
            key: Some("__sp_stk".into()),
            value: Some("SUPER_SECRET_SESSION_HEX".into()),
            ts_ms: 200,
        });
        assert!(set_res.ok && set_res.changed);

        // Same origin snapshot sees key; cross-origin snapshot sees empty!
        let snap_same = bus.session_storage_op(SessionStorageOpInput {
            op: "snapshot".into(),
            tab_id: "tab-1".into(),
            origin: "https://aviator-demo.spribegaming.com".into(),
            viewport: "landscape".into(),
            key: None,
            value: None,
            ts_ms: 210,
        });
        assert_eq!(
            snap_same.entries.unwrap().get("__sp_stk").map(String::as_str),
            Some("SUPER_SECRET_SESSION_HEX")
        );

        let snap_other = bus.session_storage_op(SessionStorageOpInput {
            op: "snapshot".into(),
            tab_id: "tab-1".into(),
            origin: "https://evil.example.com".into(),
            viewport: "landscape".into(),
            key: None,
            value: None,
            ts_ms: 210,
        });
        assert!(snap_other.entries.unwrap().is_empty());

        // Event log records key name + byte length, NEVER the secret storage value!
        let events = bus.query(&QueryFilter::default());
        assert_eq!(events.count, 1);
        assert!(events.events[0].summary.contains("__sp_stk"));
        assert!(!events.events[0].summary.contains("SUPER_SECRET_SESSION_HEX"));
    }
}
