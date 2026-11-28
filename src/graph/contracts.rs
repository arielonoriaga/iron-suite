use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::scan::{
    extract_ts_method_opt, find_matching_delim, find_matching_open, find_rust_functions,
    find_semicolon_at_depth_zero, for_each_dot_call, is_ident_byte, is_ts_ident_byte, read_ident,
    read_ts_ident_prefix, rust_code_mask, skip_angle_generics, skip_ascii_ws, split_top_level_args,
    split_top_level_delimited, ts_code_mask, unquote_double_string, unquote_ts_string,
};
use super::types::HttpMethod;

const CONTRACT_HASH_LEN: usize = 16;
const MAX_FLATTEN_DEPTH: usize = 6;
const KW_PUB: &str = "pub";
const OPAQUE_VALUE_TYPE: &str = "Value";
const METHOD_JSON: &str = "json";
const METHOD_SEND: &str = "send";
pub(crate) const PROP_BODY: &str = "body";
const RULE_SCREAMING_SNAKE: &str = "SCREAMING_SNAKE_CASE";

static SERDE_RENAME_ALL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\brename_all\s*=\s*"([^"]+)""#).expect("valid serde rename_all regex")
});

static SERDE_RENAME_DIRECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\brename\s*=\s*"([^"]+)""#).expect("valid serde rename regex")
});

static SERDE_RENAME_DE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bdeserialize\s*=\s*"([^"]+)""#).expect("valid serde deserialize rename regex")
});

static SERDE_RENAME_SER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bserialize\s*=\s*"([^"]+)""#).expect("valid serde serialize rename regex")
});

static FROM_JSON_TYPED_LET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\blet\s+(?:mut\s+)?[a-z_][a-z0-9_]*\s*:\s*([A-Za-z_][A-Za-z0-9_:<>]*)\s*=\s*[^;]{0,160}\bserde_json::from_(?:slice|bytes|str)\b",
    )
    .expect("valid typed from_slice regex")
});

static FROM_JSON_TURBOFISH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bserde_json::from_(?:slice|bytes|str)::<([A-Za-z_][A-Za-z0-9_:<>]*)>\s*\(")
        .expect("valid turbofish from_slice regex")
});

static JSON_STRUCT_LIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bJson\s*\(\s*([A-Z][A-Za-z0-9_:]*)\s*\{")
        .expect("valid Json struct literal regex")
});

static LET_BIND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*(?::\s*([^=;]+))?=\s*")
        .expect("valid let bind regex")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayloadKind {
    Json,
    Query,
    Form,
}

impl PayloadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Query => "query",
            Self::Form => "form",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "json" => Some(Self::Json),
            "query" => Some(Self::Query),
            "form" => Some(Self::Form),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayloadState {
    Resolved,
    Opaque,
}

impl PayloadState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resolved => "resolved",
            Self::Opaque => "opaque",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "resolved" => Some(Self::Resolved),
            "opaque" => Some(Self::Opaque),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SerdeRenameRule {
    Lower,
    Upper,
    Pascal,
    Camel,
    Snake,
    ScreamingSnake,
    Kebab,
    ScreamingKebab,
}

impl SerdeRenameRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lower => "lowercase",
            Self::Upper => "UPPERCASE",
            Self::Pascal => "PascalCase",
            Self::Camel => "camelCase",
            Self::Snake => "snake_case",
            Self::ScreamingSnake => RULE_SCREAMING_SNAKE,
            Self::Kebab => "kebab-case",
            Self::ScreamingKebab => "SCREAMING-KEBAB-CASE",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "lowercase" => Some(Self::Lower),
            "UPPERCASE" => Some(Self::Upper),
            "PascalCase" => Some(Self::Pascal),
            "camelCase" => Some(Self::Camel),
            "snake_case" => Some(Self::Snake),
            RULE_SCREAMING_SNAKE => Some(Self::ScreamingSnake),
            "kebab-case" => Some(Self::Kebab),
            "SCREAMING-KEBAB-CASE" => Some(Self::ScreamingKebab),
            _ => None,
        }
    }

    pub fn apply(self, ident: &str) -> String {
        let clean = ident.strip_prefix("r#").unwrap_or(ident);
        match self {
            Self::Lower => clean.to_ascii_lowercase(),
            Self::Upper => clean.to_ascii_uppercase(),
            Self::Snake => clean.to_owned(),
            Self::ScreamingSnake => clean.to_ascii_uppercase(),
            Self::Kebab => clean.replace('_', "-"),
            Self::ScreamingKebab => clean.replace('_', "-").to_ascii_uppercase(),
            Self::Pascal => to_pascal_case(clean),
            Self::Camel => to_camel_case(clean),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BreakingKind {
    EndpointRemoved,
    EndpointRenamed,
    CallUnresolved,
}

impl BreakingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EndpointRemoved => "endpoint_removed",
            Self::EndpointRenamed => "endpoint_renamed",
            Self::CallUnresolved => "call_unresolved",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "endpoint_removed" => Some(Self::EndpointRemoved),
            "endpoint_renamed" => Some(Self::EndpointRenamed),
            "call_unresolved" => Some(Self::CallUnresolved),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractField {
    pub name: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayloadContract {
    pub kind: PayloadKind,
    pub type_name: String,
    pub state: PayloadState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<ContractField>,
}

impl PayloadContract {
    pub fn opaque(kind: PayloadKind, type_name: String) -> Self {
        Self {
            kind,
            type_name,
            state: PayloadState::Opaque,
            fields: Vec::new(),
        }
    }

    pub fn resolved(kind: PayloadKind, type_name: String, mut fields: Vec<ContractField>) -> Self {
        normalize_fields(&mut fields);
        Self {
            kind,
            type_name,
            state: PayloadState::Resolved,
            fields,
        }
    }
}

const FLAG_SKIP: u8 = 1 << 0;
const FLAG_SKIP_DE: u8 = 1 << 1;
const FLAG_SKIP_SER: u8 = 1 << 2;
const FLAG_DEFAULT: u8 = 1 << 3;
const FLAG_FLATTEN: u8 = 1 << 4;
const FLAG_SKIP_SER_IF: u8 = 1 << 5;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldRename {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub de: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ser: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldFlags(pub u8);

impl FieldFlags {
    fn set(&mut self, bit: u8, active: bool) {
        if active {
            self.0 |= bit;
        }
    }

    fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }

    fn is_skipped(self, is_request: bool) -> bool {
        self.has(FLAG_SKIP)
            || (is_request && self.has(FLAG_SKIP_DE))
            || (!is_request && self.has(FLAG_SKIP_SER))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawFieldDef {
    pub name: String,
    pub ty: String,
    #[serde(default)]
    pub rename: FieldRename,
    #[serde(default)]
    pub flags: FieldFlags,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawStructDef {
    pub name: String,
    pub file: String,
    pub crate_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_all: Option<SerdeRenameRule>,
    #[serde(default)]
    pub has_default: bool,
    pub fields: Vec<RawFieldDef>,
}

#[derive(Clone, Copy)]
struct FieldResolveMode {
    is_request: bool,
    force_optional: bool,
    depth: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrateStructIndex {
    pub defs: Vec<RawStructDef>,
}

fn collect_from_sources<T>(
    sources: &[(String, String)],
    crate_key_fn: impl Fn(&str) -> String,
    parse_one: impl Fn(&str, &str, &str) -> Vec<T>,
) -> Vec<T> {
    let mut items = Vec::new();
    for (rel, src) in sources {
        let ck = crate_key_fn(rel);
        items.extend(parse_one(rel, &ck, src));
    }
    items
}

fn override_file_items<T: Clone>(
    existing: &[T],
    rel: &str,
    crate_key: &str,
    source: &str,
    file_of: impl Fn(&T) -> &str,
    parse_one: impl Fn(&str, &str, &str) -> Vec<T>,
) -> Vec<T> {
    let mut items: Vec<T> = existing
        .iter()
        .filter(|it| file_of(it) != rel)
        .cloned()
        .collect();
    items.extend(parse_one(rel, crate_key, source));
    items
}

impl CrateStructIndex {
    pub fn from_sources(sources: &[(String, String)], crate_key_fn: impl Fn(&str) -> String) -> Self {
        Self { defs: collect_from_sources(sources, crate_key_fn, parse_rust_structs_in_file) }
    }

    pub fn with_file_override(&self, rel: &str, crate_key: &str, source: &str) -> Self {
        let defs = override_file_items(&self.defs, rel, crate_key, source, |d| &d.file, parse_rust_structs_in_file);
        Self { defs }
    }

    pub fn resolve_struct_contract(
        &self,
        crate_key: &str,
        file: &str,
        raw_type: &str,
        kind: PayloadKind,
        is_request: bool,
    ) -> PayloadContract {
        let cleaned = clean_rust_type_name(raw_type);
        let mut visited = HashSet::new();
        let mut fields = Vec::new();
        let mode = FieldResolveMode {
            is_request,
            force_optional: false,
            depth: 0,
        };
        let resolved =
            self.collect_struct_fields(crate_key, file, &cleaned, mode, &mut visited, &mut fields);
        normalize_fields(&mut fields);
        PayloadContract {
            kind,
            type_name: cleaned,
            state: if resolved {
                PayloadState::Resolved
            } else {
                PayloadState::Opaque
            },
            fields,
        }
    }

    pub fn resolve_json_serialize(&self, crate_key: &str, file: &str, raw_type: &str) -> PayloadContract {
        self.resolve_struct_contract(crate_key, file, raw_type, PayloadKind::Json, false)
    }

    pub fn find_struct_file(&self, crate_key: &str, file: &str, raw_type: &str) -> Option<&str> {
        let cleaned = clean_rust_type_name(raw_type);
        self.lookup_struct(crate_key, file, &cleaned)
            .map(|d| d.file.as_str())
    }

    fn collect_struct_fields(
        &self,
        crate_key: &str,
        file: &str,
        type_path: &str,
        ctx: FieldResolveMode,
        visited: &mut HashSet<(String, String)>,
        out: &mut Vec<ContractField>,
    ) -> bool {
        if ctx.depth > MAX_FLATTEN_DEPTH {
            return false;
        }
        let Some(def) = self.lookup_struct(crate_key, file, type_path) else {
            return false;
        };
        let key = (def.file.clone(), def.name.clone());
        if !visited.insert(key.clone()) {
            return false;
        }
        let mut all_resolved = true;
        for field in &def.fields {
            if !self.process_struct_field(def, field, ctx, visited, out) {
                all_resolved = false;
            }
        }
        visited.remove(&key);
        all_resolved
    }

    fn process_struct_field(
        &self,
        def: &RawStructDef,
        field: &RawFieldDef,
        mode: FieldResolveMode,
        visited: &mut HashSet<(String, String)>,
        out: &mut Vec<ContractField>,
    ) -> bool {
        if field.flags.is_skipped(mode.is_request) {
            return true;
        }
        let is_opt = mode.force_optional
            || def.has_default
            || field.flags.has(FLAG_DEFAULT)
            || is_option_type(&field.ty)
            || (!mode.is_request && field.flags.has(FLAG_SKIP_SER_IF));
        if field.flags.has(FLAG_FLATTEN) {
            let inner = unwrap_option_or_box(&field.ty);
            let nested = FieldResolveMode {
                is_request: mode.is_request,
                force_optional: is_opt,
                depth: mode.depth + 1,
            };
            return self.collect_struct_fields(
                &def.crate_key,
                &def.file,
                &clean_rust_type_name(inner),
                nested,
                visited,
                out,
            );
        }
        let wire_name = resolve_field_wire_name(field, def.rename_all, mode.is_request);
        out.push(ContractField {
            name: wire_name,
            required: !is_opt,
        });
        true
    }

    fn lookup_struct(&self, crate_key: &str, file: &str, type_path: &str) -> Option<&RawStructDef> {
        let base_type = strip_generics(type_path).trim();
        if base_type.is_empty() {
            return None;
        }
        lookup_by_rust_path(
            &self.defs,
            crate_key,
            file,
            base_type,
            true,
            |d| (d.crate_key.as_str(), d.file.as_str(), d.name.as_str()),
        )
    }
}

fn lookup_by_rust_path<'a, T>(
    items: &'a [T],
    crate_key: &str,
    file: &str,
    rust_path: &str,
    fallback_global: bool,
    meta: impl Fn(&T) -> (&str, &str, &str),
) -> Option<&'a T> {
    let (mod_hint, name) = match rust_path.rsplit_once("::") {
        Some((prefix, tail)) => (prefix.rsplit("::").next(), tail.trim()),
        None => (None, rust_path),
    };
    if let Some(same_file) = items.iter().find(|it| {
        let (_, f, n) = meta(it);
        f == file && n == name
    }) {
        return Some(same_file);
    }
    let in_crate: Vec<&T> = items
        .iter()
        .filter(|it| {
            let (ck, _, n) = meta(it);
            ck == crate_key && n == name
        })
        .collect();
    if let Some(found) = pick_file_candidate(&in_crate, mod_hint, |it| meta(it).1) {
        return Some(found);
    }
    if !fallback_global {
        return None;
    }
    let global: Vec<&T> = items.iter().filter(|it| meta(it).2 == name).collect();
    pick_file_candidate(&global, mod_hint, |it| meta(it).1)
}

fn pick_file_candidate<'a, T>(
    candidates: &[&'a T],
    mod_hint: Option<&str>,
    file_of: impl Fn(&T) -> &str,
) -> Option<&'a T> {
    if candidates.len() == 1 {
        return Some(candidates[0]);
    }
    let hint = mod_hint.filter(|h| !matches!(*h, "self" | "super" | "crate"))?;
    let hinted: Vec<&T> = candidates
        .iter()
        .copied()
        .filter(|item| {
            let f = file_of(item);
            f.contains(&format!("/{hint}/"))
                || f.ends_with(&format!("/{hint}.rs"))
                || f == format!("{hint}.rs")
        })
        .collect();
    (hinted.len() == 1).then(|| hinted[0])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandlerSignature {
    pub file: String,
    pub crate_key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub req: Option<(PayloadKind, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub res: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HandlerIndex {
    pub handlers: Vec<HandlerSignature>,
}

impl HandlerIndex {
    pub fn from_sources(sources: &[(String, String)], crate_key_fn: impl Fn(&str) -> String) -> Self {
        Self { handlers: collect_from_sources(sources, crate_key_fn, extract_rust_handlers_in_file) }
    }

    pub fn with_file_override(&self, rel: &str, crate_key: &str, source: &str) -> Self {
        let handlers = override_file_items(&self.handlers, rel, crate_key, source, |h| &h.file, extract_rust_handlers_in_file);
        Self { handlers }
    }

    pub fn lookup(&self, crate_key: &str, file: &str, handler_expr: &str) -> Option<&HandlerSignature> {
        let trimmed = handler_expr.trim();
        if trimmed.is_empty() || trimmed.starts_with('<') {
            return None;
        }
        lookup_by_rust_path(
            &self.handlers,
            crate_key,
            file,
            trimmed,
            false,
            |h| (h.crate_key.as_str(), h.file.as_str(), h.name.as_str()),
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractDiff {
    pub removed: Vec<String>,
    pub added: Vec<String>,
    pub changed: Vec<String>,
}

impl ContractDiff {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.added.is_empty() && self.changed.is_empty()
    }

    pub fn format_compact(&self) -> String {
        let mut parts = Vec::new();
        for name in &self.removed {
            parts.push(format!("-{name}"));
        }
        for name in &self.added {
            parts.push(format!("+{name}"));
        }
        for item in &self.changed {
            parts.push(item.clone());
        }
        parts.join(" ")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractMismatch {
    pub missing_required: Vec<String>,
    pub unknown_sent: Vec<String>,
}

impl ContractMismatch {
    pub fn format_compact(&self) -> String {
        let mut parts = Vec::new();
        if !self.missing_required.is_empty() {
            parts.push(format!("missing: {}", self.missing_required.join(", ")));
        }
        if !self.unknown_sent.is_empty() {
            parts.push(format!("unknown: {}", self.unknown_sent.join(", ")));
        }
        format!("mismatch({})", parts.join("; "))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallerSite {
    pub repo: String,
    pub service: String,
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertTarget {
    pub cross_repo: bool,
    pub method: HttpMethod,
    pub path_norm: String,
    pub provider_repo: String,
    pub provider_service: String,
    pub provider_file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreakingAlert {
    pub kind: BreakingKind,
    #[serde(flatten)]
    pub target: AlertTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_call_method: Option<HttpMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_call_path: Option<String>,
    pub callers: Vec<CallerSite>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractChangeAlert {
    #[serde(flatten)]
    pub target: AlertTarget,
    pub request_diff: ContractDiff,
    pub response_diff: ContractDiff,
    pub callers: Vec<CallerSite>,
}

pub fn format_breaking_alert(alert: &BreakingAlert) -> String {
    match alert.kind {
        BreakingKind::EndpointRemoved | BreakingKind::EndpointRenamed => {
            let rename_part = alert
                .renamed_to
                .as_deref()
                .map(|r| format!(" (renamed to {r}?)"))
                .unwrap_or_default();
            let callers = format_callers_clause(&alert.callers, " now unresolved");
            format!(
                "⚠ BREAKING {} {} removed here{rename_part}; {callers}",
                alert.target.method.as_str(),
                alert.target.path_norm,
            )
        }
        BreakingKind::CallUnresolved => {
            let site = alert
                .callers
                .first()
                .map(|c| format!("{} {}:{}", c.repo, c.file, c.line))
                .unwrap_or_default();
            let current_method = alert.new_call_method.unwrap_or(alert.target.method);
            let current = alert
                .new_call_path
                .as_deref()
                .unwrap_or(alert.target.path_norm.as_str());
            format!(
                "⚠ BREAKING {} {current} no longer resolves at {site} (was {} {} -> {})",
                current_method.as_str(),
                alert.target.method.as_str(),
                alert.target.path_norm,
                alert.target.provider_service,
            )
        }
    }
}

pub fn format_contract_change_alert(alert: &ContractChangeAlert) -> String {
    let mut diffs = Vec::new();
    if !alert.request_diff.is_empty() {
        diffs.push(format!("request: {}", alert.request_diff.format_compact()));
    }
    if !alert.response_diff.is_empty() {
        diffs.push(format!("response: {}", alert.response_diff.format_compact()));
    }
    let callers = format_callers_clause(&alert.callers, "");
    format!(
        "⚠ CONTRACT {} {} {}; {callers}",
        alert.target.method.as_str(),
        alert.target.path_norm,
        diffs.join("; "),
    )
}

fn format_callers_clause(callers: &[CallerSite], qualifier: &str) -> String {
    let count = callers.len();
    let noun = if count == 1 { "caller" } else { "callers" };
    format!("{count} {noun}{qualifier}: {}", format_caller_summary(callers))
}

fn format_caller_summary(callers: &[CallerSite]) -> String {
    let Some(first) = callers.first() else {
        return String::new();
    };
    let head = format!("{} {}:{}", first.repo, first.file, first.line);
    if callers.len() <= 1 {
        head
    } else {
        format!("{head}, +{} more", callers.len() - 1)
    }
}

pub fn compute_contract_hash(
    req: Option<&PayloadContract>,
    res: Option<&PayloadContract>,
) -> String {
    if req.is_none() && res.is_none() {
        return String::new();
    }
    let mut hasher = Sha256::new();
    hash_payload_into(&mut hasher, "req", req);
    hash_payload_into(&mut hasher, "res", res);
    let digest = format!("{:x}", hasher.finalize());
    digest[..CONTRACT_HASH_LEN].to_owned()
}

fn hash_payload_into(hasher: &mut Sha256, label: &str, payload: Option<&PayloadContract>) {
    hasher.update(label.as_bytes());
    hasher.update(b":");
    if let Some(p) = payload {
        hasher.update(p.kind.as_str().as_bytes());
        hasher.update(b"|");
        hasher.update(p.state.as_str().as_bytes());
        hasher.update(b"|");
        if p.fields.is_empty() {
            hasher.update(p.type_name.as_bytes());
        } else {
            for f in &p.fields {
                hasher.update(f.name.as_bytes());
                hasher.update(if f.required { b":1," } else { b":0," });
            }
        }
    }
    hasher.update(b"\n");
}

pub fn diff_payload_contracts(
    old: Option<&PayloadContract>,
    new: Option<&PayloadContract>,
) -> ContractDiff {
    let (Some(old_p), Some(new_p)) = (old, new) else {
        return ContractDiff::default();
    };
    if old_p.fields.is_empty() && new_p.fields.is_empty() {
        return ContractDiff::default();
    }
    let old_map: BTreeMap<&str, bool> = old_p
        .fields
        .iter()
        .map(|f| (f.name.as_str(), f.required))
        .collect();
    let new_map: BTreeMap<&str, bool> = new_p
        .fields
        .iter()
        .map(|f| (f.name.as_str(), f.required))
        .collect();
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for (name, old_req) in &old_map {
        match new_map.get(name) {
            None => removed.push((*name).to_owned()),
            Some(new_req) if old_req != new_req => {
                let dir = if *new_req { "opt->req" } else { "req->opt" };
                changed.push(format!("{name}:{dir}"));
            }
            Some(_) => {}
        }
    }
    for name in new_map.keys() {
        if !old_map.contains_key(name) {
            added.push((*name).to_owned());
        }
    }
    ContractDiff {
        removed,
        added,
        changed,
    }
}

pub fn check_request_mismatch(
    provider: Option<&PayloadContract>,
    caller: Option<&PayloadContract>,
) -> Option<ContractMismatch> {
    let (Some(p), Some(c)) = (provider, caller) else {
        return None;
    };
    if p.state != PayloadState::Resolved || c.state != PayloadState::Resolved || p.kind != c.kind {
        return None;
    }
    let provider_names: HashSet<&str> = p.fields.iter().map(|f| f.name.as_str()).collect();
    let caller_names: HashSet<&str> = c.fields.iter().map(|f| f.name.as_str()).collect();
    let missing_required: Vec<String> = p
        .fields
        .iter()
        .filter(|f| f.required && !caller_names.contains(f.name.as_str()))
        .map(|f| f.name.clone())
        .collect();
    let unknown_sent: Vec<String> = c
        .fields
        .iter()
        .filter(|f| !provider_names.contains(f.name.as_str()))
        .map(|f| f.name.clone())
        .collect();
    if missing_required.is_empty() && unknown_sent.is_empty() {
        None
    } else {
        Some(ContractMismatch {
            missing_required,
            unknown_sent,
        })
    }
}

pub fn parse_rust_structs_in_file(rel_file: &str, crate_key: &str, source: &str) -> Vec<RawStructDef> {
    let mask = rust_code_mask(source);
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 6 < bytes.len() {
        let is_struct_kw = mask[i]
            && bytes.get(i..i + 6) == Some(b"struct")
            && (i == 0 || !is_ident_byte(bytes[i - 1]))
            && !is_ident_byte(bytes.get(i + 6).copied().unwrap_or(0));
        if !is_struct_kw {
            i += 1;
            continue;
        }
        let name_start = skip_ascii_ws(bytes, i + 6, bytes.len());
        let Some((name, after_name)) = read_ident(source, bytes, name_start) else {
            i += 6;
            continue;
        };
        let Some((body_open, body_close)) = find_struct_brace_body(bytes, &mask, after_name) else {
            i = after_name;
            continue;
        };
        let attrs = collect_preceding_attrs(source, bytes, &mask, i);
        let (rename_all, has_default) = parse_struct_serde_attrs(&attrs);
        let fields = parse_struct_fields(source, &mask, body_open + 1, body_close);
        out.push(RawStructDef {
            name: name.to_owned(),
            file: rel_file.to_owned(),
            crate_key: crate_key.to_owned(),
            rename_all,
            has_default,
            fields,
        });
        i = body_close + 1;
    }
    out
}

fn find_struct_brace_body(bytes: &[u8], mask: &[bool], start: usize) -> Option<(usize, usize)> {
    let mut pos = skip_ascii_ws(bytes, start, bytes.len());
    if bytes.get(pos) == Some(&b'<') && mask[pos] {
        pos = skip_angle_generics(bytes, mask, pos, bytes.len(), false)?;
    }
    while pos < bytes.len() {
        if !mask[pos] {
            pos += 1;
            continue;
        }
        match bytes[pos] {
            b'{' => {
                let close = find_matching_delim(bytes, mask, pos, b'{', b'}')?;
                return Some((pos, close));
            }
            b';' | b'(' => return None,
            _ => pos += 1,
        }
    }
    None
}

fn collect_preceding_attrs(source: &str, bytes: &[u8], mask: &[bool], kw_pos: usize) -> Vec<String> {
    let pos = skip_preceding_pub(source, bytes, mask, kw_pos);
    collect_attr_blocks(source, bytes, mask, pos)
}

fn skip_preceding_pub(source: &str, bytes: &[u8], mask: &[bool], kw_pos: usize) -> usize {
    let mut pos = kw_pos;
    loop {
        pos = skip_back_ws_and_comments(bytes, mask, pos);
        if pos == 0 {
            return 0;
        }
        if bytes[pos - 1] == b')' && mask[pos - 1] {
            let Some(open) = find_matching_open(bytes, mask, pos - 1, b'(', b')') else {
                return pos;
            };
            let before = skip_back_ws_and_comments(bytes, mask, open);
            if before >= KW_PUB.len() && &source[before - KW_PUB.len()..before] == KW_PUB {
                pos = before - KW_PUB.len();
                continue;
            }
            return pos;
        }
        let end = pos;
        while pos > 0 && is_ident_byte(bytes[pos - 1]) {
            pos -= 1;
        }
        if &source[pos..end] == KW_PUB {
            continue;
        }
        return end;
    }
}

fn collect_attr_blocks(source: &str, bytes: &[u8], mask: &[bool], mut pos: usize) -> Vec<String> {
    let mut attrs = Vec::new();
    loop {
        pos = skip_back_ws_and_comments(bytes, mask, pos);
        if pos == 0 || bytes[pos - 1] != b']' || !mask[pos - 1] {
            break;
        }
        let Some(open) = find_matching_open(bytes, mask, pos - 1, b'[', b']') else {
            break;
        };
        if open > 0 && bytes[open - 1] == b'#' && mask[open - 1] {
            attrs.push(source[open - 1..pos].to_owned());
            pos = open - 1;
        } else {
            break;
        }
    }
    attrs.reverse();
    attrs
}

fn skip_back_ws_and_comments(bytes: &[u8], mask: &[bool], mut pos: usize) -> usize {
    while pos > 0 && (bytes[pos - 1].is_ascii_whitespace() || !mask[pos - 1]) {
        pos -= 1;
    }
    pos
}

fn parse_struct_serde_attrs(attrs: &[String]) -> (Option<SerdeRenameRule>, bool) {
    let mut rename_all = None;
    let mut has_default = false;
    for attr in attrs {
        let Some(inner) = extract_serde_attr_inner(attr) else {
            continue;
        };
        if let Some(caps) = SERDE_RENAME_ALL_RE.captures(inner) {
            rename_all = SerdeRenameRule::parse(&caps[1]);
        }
        if has_serde_token(inner, "default") {
            has_default = true;
        }
    }
    (rename_all, has_default)
}

fn parse_struct_fields(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> Vec<RawFieldDef> {
    let mut fields = Vec::new();
    for (seg_start, seg_text) in split_rust_top_level(source, mask, start, end) {
        if let Some(field) = parse_single_struct_field(source, mask, seg_start, seg_text) {
            fields.push(field);
        }
    }
    fields
}

fn parse_single_struct_field(
    source: &str,
    mask: &[bool],
    seg_start: usize,
    seg_text: &str,
) -> Option<RawFieldDef> {
    let seg_end = seg_start + seg_text.len();
    let bytes = source.as_bytes();
    let mut pos = seg_start;
    let mut attrs = Vec::new();
    while pos < seg_end {
        if !mask[pos] || bytes[pos].is_ascii_whitespace() {
            pos += 1;
            continue;
        }
        if bytes.get(pos..pos + 2) == Some(b"#[")
            && let Some(close) = find_matching_delim(bytes, mask, pos + 1, b'[', b']')
        {
            attrs.push(source[pos..=close].to_owned());
            pos = close + 1;
            continue;
        }
        break;
    }
    pos = skip_rust_visibility(source, bytes, mask, pos, seg_end);
    let colon = find_top_level_colon(bytes, mask, pos, seg_end)?;
    let raw_name = source[pos..colon].trim();
    let name = raw_name.strip_prefix("r#").unwrap_or(raw_name).trim();
    if name.is_empty() || !name.bytes().all(is_ident_byte) {
        return None;
    }
    let ty = source[colon + 1..seg_end].trim().to_owned();
    if ty.is_empty() {
        return None;
    }
    let mut field = RawFieldDef {
        name: name.to_owned(),
        ty,
        rename: FieldRename::default(),
        flags: FieldFlags::default(),
    };
    apply_field_serde_attrs(&attrs, &mut field);
    Some(field)
}

fn skip_rust_visibility(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    mut pos: usize,
    limit: usize,
) -> usize {
    while pos < limit && (!mask[pos] || bytes[pos].is_ascii_whitespace()) {
        pos += 1;
    }
    if source[pos..limit].starts_with("pub")
        && !is_ident_byte(bytes.get(pos + 3).copied().unwrap_or(0))
    {
        pos += 3;
        while pos < limit && (!mask[pos] || bytes[pos].is_ascii_whitespace()) {
            pos += 1;
        }
        if bytes.get(pos) == Some(&b'(')
            && mask[pos]
            && let Some(close) = find_matching_delim(bytes, mask, pos, b'(', b')')
        {
            pos = close + 1;
            while pos < limit && (!mask[pos] || bytes[pos].is_ascii_whitespace()) {
                pos += 1;
            }
        }
    }
    pos
}

fn find_top_level_colon(bytes: &[u8], mask: &[bool], start: usize, end: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = start;
    while i < end {
        if !mask[i] {
            i += 1;
            continue;
        }
        match bytes[i] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' => depth = depth.saturating_sub(1),
            b':' if depth == 0 && bytes.get(i + 1) != Some(&b':') => return Some(i),
            b':' if bytes.get(i + 1) == Some(&b':') => {
                i += 2;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn apply_field_serde_attrs(attrs: &[String], field: &mut RawFieldDef) {
    for attr in attrs {
        let Some(inner) = extract_serde_attr_inner(attr) else {
            continue;
        };
        if let Some(caps) = SERDE_RENAME_DIRECT_RE.captures(inner) {
            field.rename.direct = Some(caps[1].to_owned());
        }
        if inner.contains("rename(") {
            if let Some(caps) = SERDE_RENAME_DE_RE.captures(inner) {
                field.rename.de = Some(caps[1].to_owned());
            }
            if let Some(caps) = SERDE_RENAME_SER_RE.captures(inner) {
                field.rename.ser = Some(caps[1].to_owned());
            }
        }
        field.flags.set(FLAG_SKIP, has_serde_token(inner, "skip"));
        field.flags.set(FLAG_SKIP_DE, has_serde_token(inner, "skip_deserializing"));
        field.flags.set(FLAG_SKIP_SER, has_serde_token(inner, "skip_serializing"));
        field.flags.set(FLAG_DEFAULT, has_serde_token(inner, "default"));
        field.flags.set(FLAG_FLATTEN, has_serde_token(inner, "flatten"));
        field.flags.set(FLAG_SKIP_SER_IF, has_serde_token(inner, "skip_serializing_if"));
    }
}

fn extract_serde_attr_inner(attr: &str) -> Option<&str> {
    let trimmed = attr.trim();
    let inside = trimmed.strip_prefix("#[")?.strip_suffix(']')?.trim();
    inside
        .strip_prefix("serde(")
        .and_then(|s| s.strip_suffix(')'))
}

fn has_serde_token(inner: &str, token: &str) -> bool {
    let bytes = inner.as_bytes();
    let needle = token.as_bytes();
    let mut i = 0usize;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let left_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let right = bytes.get(i + needle.len()).copied().unwrap_or(0);
            let right_ok = !is_ident_byte(right);
            if left_ok && right_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn resolve_field_wire_name(
    field: &RawFieldDef,
    rename_all: Option<SerdeRenameRule>,
    is_request: bool,
) -> String {
    let explicit = if is_request {
        field.rename.de.as_deref().or(field.rename.direct.as_deref())
    } else {
        field.rename.ser.as_deref().or(field.rename.direct.as_deref())
    };
    if let Some(name) = explicit {
        return name.to_owned();
    }
    match rename_all {
        Some(rule) => rule.apply(&field.name),
        None => field.name.clone(),
    }
}

pub fn extract_rust_handlers_in_file(
    rel_file: &str,
    crate_key: &str,
    source: &str,
) -> Vec<HandlerSignature> {
    let mask = rust_code_mask(source);
    let bytes = source.as_bytes();
    let fns = find_rust_functions(source, &mask);
    let mut raw_list = Vec::with_capacity(fns.len());
    for (name, header_start, body_open, body_close) in &fns {
        let hdr = FnHeaderSpan {
            source,
            bytes,
            mask: &mask,
            header_start: *header_start,
            body_open: *body_open,
        };
        let mut req = extract_handler_req_from_params(&hdr);
        if req.is_none() {
            req = extract_handler_req_from_body(&source[*body_open..*body_close]);
        }
        let res = extract_handler_res_from_sig(&hdr);
        raw_list.push((
            HandlerSignature {
                file: rel_file.to_owned(),
                crate_key: crate_key.to_owned(),
                name: name.clone(),
                req,
                res,
            },
            *body_open,
            *body_close,
        ));
    }
    let res_by_fn: BTreeMap<String, String> = raw_list
        .iter()
        .filter_map(|(sig, _, _)| sig.res.as_ref().map(|r| (sig.name.clone(), r.clone())))
        .collect();
    for (sig, body_open, body_close) in &mut raw_list {
        if sig.res.is_none() {
            sig.res = infer_delegated_res_type(&source[*body_open..*body_close], &sig.name, &res_by_fn);
        }
    }
    raw_list.into_iter().map(|(sig, _, _)| sig).collect()
}

struct FnHeaderSpan<'a> {
    source: &'a str,
    bytes: &'a [u8],
    mask: &'a [bool],
    header_start: usize,
    body_open: usize,
}

fn find_in_rust_fn_params<T>(
    hdr: &FnHeaderSpan<'_>,
    mut visit: impl FnMut(&str, &str) -> Option<T>,
) -> Option<T> {
    let open = (hdr.header_start..hdr.body_open)
        .find(|&p| hdr.mask[p] && hdr.bytes[p] == b'(')?;
    let close = find_matching_delim(hdr.bytes, hdr.mask, open, b'(', b')')?;
    for (arg_start, arg_text) in split_rust_top_level(hdr.source, hdr.mask, open + 1, close) {
        let arg_end = arg_start + arg_text.len();
        let Some(colon) = find_top_level_colon(hdr.bytes, hdr.mask, arg_start, arg_end) else {
            continue;
        };
        let lhs = hdr.source[arg_start..colon].trim();
        let ty = hdr.source[colon + 1..arg_end].trim();
        if let Some(found) = visit(lhs, ty) {
            return Some(found);
        }
    }
    None
}

fn extract_handler_req_from_params(hdr: &FnHeaderSpan<'_>) -> Option<(PayloadKind, String)> {
    find_in_rust_fn_params(hdr, |_, ty| extract_axum_req_extractor_type(ty))
}

fn extract_axum_req_extractor_type(ty: &str) -> Option<(PayloadKind, String)> {
    let unwrapped = unwrap_option_or_result_ok(ty);
    for (wrapper, kind) in [
        ("Json", PayloadKind::Json),
        ("Query", PayloadKind::Query),
        ("Form", PayloadKind::Form),
    ] {
        if let Some(inner) = unwrap_named_generic(unwrapped, wrapper) {
            let cleaned = clean_rust_type_name(inner);
            if !cleaned.is_empty() {
                return Some((kind, cleaned));
            }
        }
    }
    None
}

fn extract_handler_req_from_body(body: &str) -> Option<(PayloadKind, String)> {
    let raw = FROM_JSON_TYPED_LET_RE
        .captures(body)
        .or_else(|| FROM_JSON_TURBOFISH_RE.captures(body))?;
    let ty = clean_rust_type_name(&raw[1]);
    (!ty.is_empty() && ty != OPAQUE_VALUE_TYPE).then_some((PayloadKind::Json, ty))
}

fn extract_handler_res_from_sig(hdr: &FnHeaderSpan<'_>) -> Option<String> {
    let open = (hdr.header_start..hdr.body_open)
        .find(|&p| hdr.mask[p] && hdr.bytes[p] == b'(')?;
    let close = find_matching_delim(hdr.bytes, hdr.mask, open, b'(', b')')?;
    let mut pos = close + 1;
    let arrow = loop {
        if pos + 1 >= hdr.body_open {
            return None;
        }
        if hdr.mask[pos] && hdr.bytes.get(pos..pos + 2) == Some(b"->") {
            break pos + 2;
        }
        pos += 1;
    };
    let ret_slice = hdr.source[arrow..hdr.body_open].trim();
    let ret_ty = ret_slice
        .split_once("where")
        .map_or(ret_slice, |(before, _)| before)
        .trim();
    extract_axum_res_type(ret_ty)
}

pub fn extract_axum_res_type(ret_ty: &str) -> Option<String> {
    let unwrapped = unwrap_result_ok(ret_ty);
    if let Some(inner) = unwrap_named_generic(unwrapped, "Json") {
        let cleaned = clean_rust_type_name(inner);
        return (!cleaned.is_empty()).then_some(cleaned);
    }
    let trimmed = unwrapped.trim();
    if let Some(tuple_inner) = trimmed.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        let tuple_mask = rust_code_mask(tuple_inner);
        for (_, part) in split_rust_top_level(tuple_inner, &tuple_mask, 0, tuple_inner.len()) {
            if let Some(inner) = unwrap_named_generic(part.trim(), "Json") {
                let cleaned = clean_rust_type_name(inner);
                if !cleaned.is_empty() {
                    return Some(cleaned);
                }
            }
        }
    }
    None
}

fn infer_delegated_res_type(
    body: &str,
    self_name: &str,
    res_by_fn: &BTreeMap<String, String>,
) -> Option<String> {
    for (callee, res_ty) in res_by_fn {
        if callee == self_name {
            continue;
        }
        let pat = format!("{callee}(");
        if let Some(idx) = body.find(&pat) {
            let left_ok = idx == 0 || !is_ident_byte(body.as_bytes()[idx - 1]);
            if left_ok {
                return Some(res_ty.clone());
            }
        }
    }
    if let Some(caps) = JSON_STRUCT_LIT_RE.captures(body) {
        let ty = clean_rust_type_name(&caps[1]);
        if !ty.is_empty() {
            return Some(ty);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub fn extract_rust_call_payload(
    source: &str,
    mask: &[bool],
    fns: &[(String, usize, usize, usize)],
    dot_pos: usize,
    close_paren: usize,
    crate_key: &str,
    rel_file: &str,
    structs: &CrateStructIndex,
) -> Option<PayloadContract> {
    let bytes = source.as_bytes();
    let stmt_end = find_semicolon_at_depth_zero(bytes, mask, close_paren + 1, bytes.len());
    let mut found_arg: Option<String> = None;
    for_each_dot_call(source, mask, close_paren + 1, stmt_end, |name, _, open, close| {
        if name == METHOD_JSON {
            let args = split_top_level_args(source, mask, 0, open + 1, close);
            if args.len() == 1 {
                found_arg = Some(args[0].1.to_owned());
            }
            return None;
        }
        if name == METHOD_SEND {
            return None;
        }
        Some(close + 1)
    });
    let arg = found_arg?;
    let ctx = RustPayloadCtx {
        source,
        mask,
        fns,
        dot_pos,
        crate_key,
        rel_file,
        structs,
    };
    resolve_rust_json_arg(&ctx, &arg)
}

struct RustPayloadCtx<'a> {
    source: &'a str,
    mask: &'a [bool],
    fns: &'a [(String, usize, usize, usize)],
    dot_pos: usize,
    crate_key: &'a str,
    rel_file: &'a str,
    structs: &'a CrateStructIndex,
}

fn resolve_rust_json_arg(ctx: &RustPayloadCtx<'_>, raw_arg: &str) -> Option<PayloadContract> {
    let expr = raw_arg
        .trim()
        .trim_start_matches("&mut ")
        .trim_start_matches('&')
        .trim();
    if let Some(contract) = parse_json_macro_contract(expr) {
        return Some(contract);
    }
    if let Some(ty) = extract_struct_literal_type(expr) {
        return Some(ctx.structs.resolve_json_serialize(ctx.crate_key, ctx.rel_file, &ty));
    }
    if !expr.is_empty() && expr.bytes().all(is_ident_byte) {
        return resolve_rust_var_payload(ctx, expr);
    }
    Some(PayloadContract::opaque(PayloadKind::Json, expr.to_owned()))
}

fn resolve_rust_var_payload(ctx: &RustPayloadCtx<'_>, var_name: &str) -> Option<PayloadContract> {
    let (_, header_start, body_open, _) = ctx
        .fns
        .iter()
        .filter(|(_, _, open, close)| ctx.dot_pos >= *open && ctx.dot_pos <= *close)
        .min_by_key(|(_, _, open, close)| close - open)?;
    let scope = &ctx.source[*body_open..ctx.dot_pos];
    let mut best_init: Option<(Option<String>, String)> = None;
    for caps in LET_BIND_RE.captures_iter(scope) {
        if &caps[1] != var_name {
            continue;
        }
        let abs_init = body_open + caps.get(0).unwrap().end();
        if !ctx.mask[abs_init.saturating_sub(1)] {
            continue;
        }
        let init_end =
            find_semicolon_at_depth_zero(ctx.source.as_bytes(), ctx.mask, abs_init, ctx.dot_pos);
        let ty = caps.get(2).map(|m| m.as_str().trim().to_owned());
        let init = ctx.source[abs_init..init_end].trim().to_owned();
        best_init = Some((ty, init));
    }
    if let Some((annotated_ty, init_expr)) = best_init {
        if let Some(contract) = parse_json_macro_contract(&init_expr) {
            return Some(contract);
        }
        if let Some(ty) = annotated_ty
            .filter(|t| !t.is_empty())
            .or_else(|| extract_struct_literal_type(&init_expr))
            .or_else(|| extract_ctor_type(&init_expr))
        {
            return Some(ctx.structs.resolve_json_serialize(ctx.crate_key, ctx.rel_file, &ty));
        }
    }
    let hdr = FnHeaderSpan {
        source: ctx.source,
        bytes: ctx.source.as_bytes(),
        mask: ctx.mask,
        header_start: *header_start,
        body_open: *body_open,
    };
    if let Some(param_ty) = find_rust_fn_param_type(&hdr, var_name) {
        return Some(ctx.structs.resolve_json_serialize(ctx.crate_key, ctx.rel_file, &param_ty));
    }
    Some(PayloadContract::opaque(PayloadKind::Json, var_name.to_owned()))
}

fn find_rust_fn_param_type(hdr: &FnHeaderSpan<'_>, var_name: &str) -> Option<String> {
    find_in_rust_fn_params(hdr, |lhs, ty| {
        (lhs.trim_start_matches("mut ").trim() == var_name).then(|| ty.to_owned())
    })
}

pub fn parse_json_macro_contract(expr: &str) -> Option<PayloadContract> {
    let trimmed = expr.trim();
    let rest = trimmed
        .strip_prefix("serde_json::json!")
        .or_else(|| trimmed.strip_prefix("json!"))?
        .trim();
    let inner = rest
        .strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))
        .or_else(|| rest.strip_prefix('{').and_then(|s| s.strip_suffix('}')).map(|_| rest))?
        .trim();
    let obj_inner = inner.strip_prefix('{')?.strip_suffix('}')?;
    let mask = rust_code_mask(obj_inner);
    let mut keys = Vec::new();
    for (_, entry) in split_top_level_args(obj_inner, &mask, 0, 0, obj_inner.len()) {
        let Some((lhs, _)) = entry.split_once(':') else {
            return Some(PayloadContract::opaque(PayloadKind::Json, "json!".to_owned()));
        };
        let Some(key) = unquote_double_string(lhs.trim()) else {
            return Some(PayloadContract::opaque(PayloadKind::Json, "json!".to_owned()));
        };
        keys.push(key);
    }
    Some(resolved_literal_keys("json!", keys))
}

fn resolved_literal_keys(type_name: &str, keys: Vec<String>) -> PayloadContract {
    let fields = keys
        .into_iter()
        .map(|name| ContractField { name, required: true })
        .collect();
    PayloadContract::resolved(PayloadKind::Json, type_name.to_owned(), fields)
}

pub fn extract_ts_call_opts(args: &[(usize, &str)]) -> (HttpMethod, Option<PayloadContract>) {
    let Some((_, opts)) = args.get(1) else {
        return (HttpMethod::Get, None);
    };
    (extract_ts_method_opt(opts), extract_ts_opts_body_contract(opts))
}

fn is_rust_type_path(head: &str) -> bool {
    let Some(last_seg) = head.rsplit("::").next() else {
        return false;
    };
    last_seg.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
        && head.bytes().all(|b| is_ident_byte(b) || b == b':')
}

fn extract_struct_literal_type(expr: &str) -> Option<String> {
    let trimmed = expr.trim();
    let brace = trimmed.find('{')?;
    let head = trimmed[..brace].trim();
    is_rust_type_path(head).then(|| head.to_owned())
}

fn extract_ctor_type(expr: &str) -> Option<String> {
    let trimmed = expr.trim();
    let paren = trimmed.find('(')?;
    let (ty_part, _) = trimmed[..paren].trim().rsplit_once("::")?;
    is_rust_type_path(ty_part).then(|| ty_part.to_owned())
}

pub fn extract_ts_opts_body_contract(opts_expr: &str) -> Option<PayloadContract> {
    let trimmed = opts_expr.trim();
    let inner = trimmed.strip_prefix('{')?.strip_suffix('}')?;
    let mask = ts_code_mask(inner);
    for (_, entry) in split_top_level_args(inner, &mask, 0, 0, inner.len()) {
        let Some((key, val)) = split_ts_obj_entry(entry) else {
            continue;
        };
        if key == PROP_BODY {
            return extract_ts_body_contract(val);
        }
    }
    None
}

pub fn extract_ts_body_contract(expr: &str) -> Option<PayloadContract> {
    let trimmed = expr.trim();
    let target = if let Some(rest) = trimmed.strip_prefix("JSON.stringify") {
        let rest = rest.trim();
        let inner = rest.strip_prefix('(')?.strip_suffix(')')?.trim();
        let mask = ts_code_mask(inner);
        let args = split_top_level_args(inner, &mask, 0, 0, inner.len());
        args.first()?.1.trim()
    } else {
        trimmed
    };
    let obj_inner = target.strip_prefix('{')?.strip_suffix('}')?;
    let mask = ts_code_mask(obj_inner);
    let mut keys = Vec::new();
    for (_, entry) in split_top_level_args(obj_inner, &mask, 0, 0, obj_inner.len()) {
        let t = entry.trim();
        if t.starts_with("...") || t.starts_with('[') {
            return Some(PayloadContract::opaque(PayloadKind::Json, "literal".to_owned()));
        }
        let key = if let Some((k, _)) = split_ts_obj_entry(t) {
            k
        } else if !t.is_empty() && t.bytes().all(is_ts_ident_byte) {
            t.to_owned()
        } else {
            return Some(PayloadContract::opaque(PayloadKind::Json, "literal".to_owned()));
        };
        keys.push(key);
    }
    Some(resolved_literal_keys("literal", keys))
}

fn split_ts_obj_entry(entry: &str) -> Option<(String, &str)> {
    let trimmed = entry.trim();
    let bytes = trimmed.as_bytes();
    let first = *bytes.first()?;
    if matches!(first, b'"' | b'\'' | b'`') {
        let mask = ts_code_mask(trimmed);
        let colon = (0..bytes.len()).find(|&i| mask[i] && bytes[i] == b':')?;
        let key = unquote_ts_string(&trimmed[..colon])?;
        return Some((key, trimmed[colon + 1..].trim()));
    }
    let (key, rest) = read_ts_ident_prefix(trimmed)?;
    let val = rest.trim_start().strip_prefix(':')?.trim();
    Some((key.to_owned(), val))
}

fn split_rust_top_level<'a>(
    source: &'a str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> Vec<(usize, &'a str)> {
    split_top_level_delimited(source, mask, 0, start, end, true)
}

fn unwrap_option_or_result_ok(ty: &str) -> &str {
    let t = ty.trim();
    if let Some(inner) = unwrap_named_generic(t, "Option") {
        return inner.trim();
    }
    unwrap_result_ok(t)
}

fn unwrap_result_ok(ty: &str) -> &str {
    let trimmed = ty.trim();
    for wrapper in ["Result", "AppResult", "ApiResult"] {
        if let Some(inner) = unwrap_named_generic(trimmed, wrapper) {
            let inner_mask = rust_code_mask(inner);
            let args = split_rust_top_level(inner, &inner_mask, 0, inner.len());
            if let Some((_, first)) = args.first() {
                return first.trim();
            }
        }
    }
    trimmed
}

fn unwrap_option_or_box(ty: &str) -> &str {
    let t = ty.trim();
    if let Some(inner) = unwrap_named_generic(t, "Option") {
        return unwrap_option_or_box(inner);
    }
    if let Some(inner) = unwrap_named_generic(t, "Box") {
        return unwrap_option_or_box(inner);
    }
    t
}

fn unwrap_named_generic<'a>(ty: &'a str, wrapper: &str) -> Option<&'a str> {
    let trimmed = ty.trim();
    let open = trimmed.find('<')?;
    let head = trimmed[..open].trim();
    let last_seg = head.rsplit("::").next()?.trim();
    if last_seg != wrapper {
        return None;
    }
    let close = trimmed.rfind('>')?;
    (close > open).then(|| trimmed[open + 1..close].trim())
}

fn is_option_type(ty: &str) -> bool {
    unwrap_named_generic(ty, "Option").is_some()
}

fn clean_rust_type_name(raw: &str) -> String {
    let mut s = raw.trim();
    while let Some(rest) = s
        .strip_prefix("&mut ")
        .or_else(|| s.strip_prefix('&'))
    {
        s = rest.trim();
        if s.starts_with('\'') {
            s = s
                .split_once(char::is_whitespace)
                .map_or("", |(_, after)| after.trim());
        }
    }
    if let Some(inner) = unwrap_named_generic(s, "Box")
        .or_else(|| unwrap_named_generic(s, "Arc"))
    {
        return clean_rust_type_name(inner);
    }
    strip_generics(s).trim().to_owned()
}

fn strip_generics(ty: &str) -> &str {
    ty.split('<').next().unwrap_or(ty)
}

fn normalize_fields(fields: &mut Vec<ContractField>) {
    let mut merged: BTreeMap<String, bool> = BTreeMap::new();
    for f in fields.drain(..) {
        merged
            .entry(f.name)
            .and_modify(|req| *req = *req || f.required)
            .or_insert(f.required);
    }
    *fields = merged
        .into_iter()
        .map(|(name, required)| ContractField { name, required })
        .collect();
}

fn to_pascal_case(ident: &str) -> String {
    let mut out = String::with_capacity(ident.len());
    for part in ident.split('_') {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

fn to_camel_case(ident: &str) -> String {
    let pascal = to_pascal_case(ident);
    let mut chars = pascal.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_lowercase(), chars.as_str()),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_resolution_handles_rename_all_rename_skip_option_default_and_flatten() {
        let src = r#"
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseMeta {
    pub tenant_id: String,
    #[serde(default)]
    pub trace_tag: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrderRequest {
    pub customer_id: String,
    #[serde(rename = "total_cents")]
    pub amount: i64,
    #[serde(skip)]
    pub internal_cache: String,
    #[serde(skip_deserializing)]
    pub computed: i32,
    pub note: Option<String>,
    #[serde(flatten)]
    pub meta: BaseMeta,
}

#[derive(Deserialize)]
pub struct WithOpaqueFlatten {
    pub id: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}
"#;
        let index = CrateStructIndex::from_sources(
            &[("src/orders.rs".to_owned(), src.to_owned())],
            |_| "svc".to_owned(),
        );
        let resolve_req = |ty: &str| {
            index.resolve_struct_contract("svc", "src/orders.rs", ty, PayloadKind::Json, true)
        };
        let resolved = resolve_req("CreateOrderRequest");
        assert_eq!(resolved.state, PayloadState::Resolved);
        assert_eq!(
            resolved.fields,
            vec![
                field("customerId", true),
                field("note", false),
                field("tenantId", true),
                field("total_cents", true),
                field("traceTag", false),
            ]
        );

        let opaque = resolve_req("WithOpaqueFlatten");
        assert_eq!(opaque.state, PayloadState::Opaque);
        assert_eq!(opaque.fields, vec![field("id", true)]);

        let missing = resolve_req("ExternalDto");
        assert_eq!(missing.state, PayloadState::Opaque);
        assert!(missing.fields.is_empty());
    }

    #[test]
    fn extracts_json_query_form_and_return_types_from_axum_handlers() {
        let src = r#"
async fn create_order(
    State(state): State<AppState>,
    Json(req): Json<CreateOrderReq>,
) -> Result<(StatusCode, Json<OrderRes>), AppError> {
    todo!()
}

async fn list_orders(Query(q): Query<ListOrdersQuery>) -> Json<OrderListRes> {
    todo!()
}

async fn submit_form(Form(f): Form<LoginForm>) -> Result<Json<LoginRes>, AppError> {
    todo!()
}

async fn create_invoice_idempotent(State(s): State<AppState>, body: Bytes) -> Response {
    let req: InvoiceReq = serde_json::from_slice(&body).unwrap();
    create_invoice_inner(s, req).await.into_response()
}

async fn create_invoice_inner(s: AppState, req: InvoiceReq) -> Result<Json<InvoiceRes>, AppError> {
    todo!()
}
"#;
        let handlers = extract_rust_handlers_in_file("src/api.rs", "svc", src);
        let by_name: BTreeMap<&str, &HandlerSignature> =
            handlers.iter().map(|h| (h.name.as_str(), h)).collect();
        assert_eq!(
            by_name["create_order"].req,
            Some((PayloadKind::Json, "CreateOrderReq".to_owned()))
        );
        assert_eq!(by_name["create_order"].res.as_deref(), Some("OrderRes"));
        assert_eq!(
            by_name["list_orders"].req,
            Some((PayloadKind::Query, "ListOrdersQuery".to_owned()))
        );
        assert_eq!(by_name["list_orders"].res.as_deref(), Some("OrderListRes"));
        assert_eq!(
            by_name["submit_form"].req,
            Some((PayloadKind::Form, "LoginForm".to_owned()))
        );
        assert_eq!(by_name["submit_form"].res.as_deref(), Some("LoginRes"));
        assert_eq!(
            by_name["create_invoice_idempotent"].req,
            Some((PayloadKind::Json, "InvoiceReq".to_owned()))
        );
        assert_eq!(
            by_name["create_invoice_idempotent"].res.as_deref(),
            Some("InvoiceRes")
        );
    }

    fn field(name: &str, required: bool) -> ContractField {
        ContractField { name: name.to_owned(), required }
    }

    #[test]
    fn contract_diff_and_mismatch_detect_renames_missing_required_and_unknown_keys() {
        let old = PayloadContract::resolved(
            PayloadKind::Json,
            "Req".to_owned(),
            vec![field("customerId", true), field("total", true)],
        );
        let new = PayloadContract::resolved(
            PayloadKind::Json,
            "Req".to_owned(),
            vec![field("customer_id", true), field("total", false)],
        );
        let diff = diff_payload_contracts(Some(&old), Some(&new));
        assert_eq!(diff.removed, vec!["customerId"]);
        assert_eq!(diff.added, vec!["customer_id"]);
        assert_eq!(diff.changed, vec!["total:req->opt"]);
        assert_eq!(diff.format_compact(), "-customerId +customer_id total:req->opt");
        assert_ne!(
            compute_contract_hash(Some(&old), None),
            compute_contract_hash(Some(&new), None)
        );

        let caller = PayloadContract::resolved(
            PayloadKind::Json,
            "literal".to_owned(),
            vec![field("customerId", true), field("total", true)],
        );
        let mismatch = check_request_mismatch(Some(&new), Some(&caller)).unwrap();
        assert_eq!(mismatch.missing_required, vec!["customer_id"]);
        assert_eq!(mismatch.unknown_sent, vec!["customerId"]);

        let opaque_caller = PayloadContract::opaque(PayloadKind::Json, "dyn".to_owned());
        assert_eq!(check_request_mismatch(Some(&new), Some(&opaque_caller)), None);
    }

    #[test]
    fn extracts_json_macro_and_ts_literal_body_keys_and_marks_spread_opaque() {
        let rust_lit = parse_json_macro_contract(r#"serde_json::json!({ "to": to, "text": text })"#).unwrap();
        assert_eq!(rust_lit.state, PayloadState::Resolved);
        assert_eq!(
            rust_lit.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["text", "to"]
        );

        let ts_lit = extract_ts_opts_body_contract(
            r#"{ method: 'POST', body: JSON.stringify({ token, code: 'abc' }) }"#,
        )
        .unwrap();
        assert_eq!(ts_lit.state, PayloadState::Resolved);
        assert_eq!(
            ts_lit.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["code", "token"]
        );

        let ts_spread = extract_ts_body_contract(r#"{ ...base, id: 1 }"#).unwrap();
        assert_eq!(ts_spread.state, PayloadState::Opaque);
    }

    #[test]
    fn contract_enums_roundtrip_as_str() {
        for k in [PayloadKind::Json, PayloadKind::Query, PayloadKind::Form] {
            assert_eq!(PayloadKind::parse(k.as_str()), Some(k));
        }
        for s in [PayloadState::Resolved, PayloadState::Opaque] {
            assert_eq!(PayloadState::parse(s.as_str()), Some(s));
        }
        for r in [
            SerdeRenameRule::Lower,
            SerdeRenameRule::Upper,
            SerdeRenameRule::Pascal,
            SerdeRenameRule::Camel,
            SerdeRenameRule::Snake,
            SerdeRenameRule::ScreamingSnake,
            SerdeRenameRule::Kebab,
            SerdeRenameRule::ScreamingKebab,
        ] {
            assert_eq!(SerdeRenameRule::parse(r.as_str()), Some(r));
        }
        for b in [
            BreakingKind::EndpointRemoved,
            BreakingKind::EndpointRenamed,
            BreakingKind::CallUnresolved,
        ] {
            assert_eq!(BreakingKind::parse(b.as_str()), Some(b));
        }
    }
}
