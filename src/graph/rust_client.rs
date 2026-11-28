use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::axum::crate_key_for;
use super::contracts::{CrateStructIndex, PayloadContract, extract_rust_call_payload};
use super::scan::{
    LineIndex, enclosing_fn_name, extract_why_rust, find_matching_delim, find_rust_functions,
    find_semicolon_at_depth_zero, for_each_dot_call, is_ident_byte, matches_external_glob,
    normalize_path, parallel_map, read_rust_service_files, rust_code_mask, skip_angle_generics,
    skip_ascii_ws, sort_extracted_calls, split_top_level_args, unquote_double_string,
};
use super::types::{ExtractedCall, HttpMethod};

const SELF_RECEIVERS: &[&str] = &["self", "&self", "&mut self", "mut self"];
const POSITIONAL_WRAPPER_FMTS: &[&str] = &["{}{}", "{}/{}"];
const BASE_HINTS: &[&str] = &["url", "base", "host", "origin", "endpoint", "api", "uri", "server"];
const KNOWN_API_PREFIXES: &[&str] = &[
    "/api/",
    "/v1/",
    "/v2/",
    "/internal/",
    "/ai/",
    "/billing/",
    "/catalog/",
    "/cochera/",
    "/fiscal/",
    "/images/",
    "/rails/",
    "/recommendations/",
    "/telemetry/",
];

static LET_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*(?::[^=]+)?=\s*")
        .expect("valid let url regex")
});

#[derive(Debug, Clone)]
struct WrapperDef {
    name: String,
    method: HttpMethod,
    path_param_idx: usize,
    base_ref: String,
    body_open: usize,
    body_close: usize,
    call_pos: usize,
}

pub fn extract_from_sources(
    repo: &str,
    external_globs: &[String],
    sources: &[(String, String)],
) -> Vec<ExtractedCall> {
    let structs = CrateStructIndex::from_sources(sources, |rel| crate_key_for(rel, ""));
    extract_from_sources_with_structs(repo, external_globs, sources, "", &structs)
}

pub fn extract_from_sources_with_structs(
    repo: &str,
    external_globs: &[String],
    sources: &[(String, String)],
    service_root: &str,
    structs: &CrateStructIndex,
) -> Vec<ExtractedCall> {
    let mut calls: Vec<ExtractedCall> = parallel_map(sources, |(rel, stripped)| {
        let external = matches_external_glob(external_globs, repo, rel);
        let crate_key = crate_key_for(rel, service_root);
        extract_file_with_structs(rel, stripped, external, &crate_key, structs)
    })
    .into_iter()
    .flatten()
    .collect();
    sort_extracted_calls(&mut calls);
    calls
}

pub fn extract_service(
    repo: &str,
    repo_dir: &Path,
    service_root: &str,
    external_globs: &[String],
    tracked_files: &[String],
) -> Result<Vec<ExtractedCall>> {
    let sources = read_rust_service_files(repo_dir, service_root, tracked_files);
    let structs = CrateStructIndex::from_sources(&sources, |rel| crate_key_for(rel, service_root));
    Ok(extract_from_sources_with_structs(
        repo,
        external_globs,
        &sources,
        service_root,
        &structs,
    ))
}

struct FileCtx<'a> {
    rel_file: &'a str,
    crate_key: &'a str,
    source: &'a str,
    mask: &'a [bool],
    lines: &'a LineIndex,
    fns: &'a [(String, usize, usize, usize)],
    structs: &'a CrateStructIndex,
    external: bool,
}

impl FileCtx<'_> {
    fn build_call_from_parens(
        &self,
        pos: usize,
        open_paren: usize,
        close_paren: usize,
        method: HttpMethod,
        req_contract: Option<PayloadContract>,
        resolve: impl FnOnce(&[(usize, &str)]) -> Option<(String, String, String)>,
    ) -> Option<ExtractedCall> {
        let args = split_top_level_args(self.source, self.mask, 0, open_paren + 1, close_paren);
        let (path_raw, base_ref, symbol) = resolve(&args)?;
        let path_norm = normalize_path(&path_raw);
        (!path_norm.is_empty()).then(|| ExtractedCall {
            method,
            path_raw,
            path_norm,
            file: self.rel_file.to_owned(),
            line: self.lines.line_at(pos),
            base_ref,
            symbol,
            area: String::new(),
            why: extract_why_rust(self.source, self.lines, self.fns, pos),
            external: self.external,
            req_contract,
        })
    }
}

pub fn extract_file(rel_file: &str, stripped_source: &str, external: bool) -> Vec<ExtractedCall> {
    let structs = CrateStructIndex::from_sources(
        &[(rel_file.to_owned(), stripped_source.to_owned())],
        |_| String::new(),
    );
    extract_file_with_structs(rel_file, stripped_source, external, "", &structs)
}

pub fn extract_file_with_structs(
    rel_file: &str,
    stripped_source: &str,
    external: bool,
    crate_key: &str,
    structs: &CrateStructIndex,
) -> Vec<ExtractedCall> {
    let mask = rust_code_mask(stripped_source);
    let lines = LineIndex::new(stripped_source);
    let fns = find_rust_functions(stripped_source, &mask);
    let wrappers = find_wrapper_fns(stripped_source, &mask, &fns);
    let wrapper_positions: Vec<usize> = wrappers.iter().map(|w| w.call_pos).collect();
    let ctx = FileCtx {
        rel_file,
        crate_key,
        source: stripped_source,
        mask: &mask,
        lines: &lines,
        fns: &fns,
        structs,
        external,
    };
    let mut out = scan_direct_reqwest_calls(&ctx, &wrapper_positions);
    for wrapper in &wrappers {
        out.extend(extract_wrapper_call_sites(&ctx, wrapper));
    }
    out
}

fn scan_direct_reqwest_calls(ctx: &FileCtx<'_>, wrapper_positions: &[usize]) -> Vec<ExtractedCall> {
    let mut out = Vec::new();
    for_each_dot_call(ctx.source, ctx.mask, 0, ctx.source.len(), |name, dot_pos, open, close| {
        if let Some(method) = HttpMethod::parse_crud(name)
            && !wrapper_positions.contains(&dot_pos)
        {
            let req_contract = extract_rust_call_payload(
                ctx.source,
                ctx.mask,
                ctx.fns,
                dot_pos,
                close,
                ctx.crate_key,
                ctx.rel_file,
                ctx.structs,
            );
            if let Some(call) =
                ctx.build_call_from_parens(dot_pos, open, close, method, req_contract, |args| {
                    if args.len() != 1 {
                        return None;
                    }
                    let (path_raw, base_ref) = parse_url_expr(args[0].1).or_else(|| {
                        resolve_local_url_var(ctx.source, ctx.mask, ctx.fns, dot_pos, args[0].1)
                    })?;
                    let symbol = enclosing_fn_name(ctx.fns, dot_pos).unwrap_or_default();
                    Some((path_raw, base_ref, symbol))
                })
            {
                out.push(call);
            }
        }
        Some(open + 1)
    });
    out
}

fn find_wrapper_fns(
    source: &str,
    mask: &[bool],
    fns: &[(String, usize, usize, usize)],
) -> Vec<WrapperDef> {
    let bytes = source.as_bytes();
    fns.iter()
        .filter_map(|(name, header_start, body_open, body_close)| {
            let params = parse_fn_param_indices(source, bytes, mask, *header_start, *body_open);
            (!params.is_empty())
                .then(|| scan_wrapper_body(source, mask, name, *body_open, *body_close, &params))
                .flatten()
        })
        .collect()
}

fn scan_wrapper_body(
    source: &str,
    mask: &[bool],
    name: &str,
    body_open: usize,
    body_close: usize,
    params: &HashMap<String, usize>,
) -> Option<WrapperDef> {
    let mut found = None;
    for_each_dot_call(source, mask, body_open, body_close, |mname, dot_pos, open, close| {
        if let Some(method) = HttpMethod::parse_crud(mname) {
            let args = split_top_level_args(source, mask, 0, open + 1, close);
            if args.len() == 1
                && let Some((param_idx, base_ref)) = detect_wrapper_format_arg(args[0].1, params)
            {
                found = Some(WrapperDef {
                    name: name.to_owned(),
                    method,
                    path_param_idx: param_idx,
                    base_ref,
                    body_open,
                    body_close,
                    call_pos: dot_pos,
                });
                return None;
            }
        }
        Some(open + 1)
    });
    found
}

fn parse_fn_param_indices(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    header_start: usize,
    body_open: usize,
) -> HashMap<String, usize> {
    let Some(open) = (header_start..body_open).find(|&p| mask[p] && bytes[p] == b'(') else {
        return HashMap::new();
    };
    let Some(close) = find_matching_delim(bytes, mask, open, b'(', b')') else {
        return HashMap::new();
    };
    let mut params = HashMap::new();
    let mut idx = 0usize;
    for (_, arg) in split_top_level_args(source, mask, 0, open + 1, close) {
        let trimmed = arg.trim();
        if SELF_RECEIVERS.contains(&trimmed) {
            continue;
        }
        if let Some((lhs, rhs)) = trimmed.split_once(':')
            && (rhs.contains("str") || rhs.contains("String"))
        {
            let pname = lhs.trim().trim_start_matches("mut ").trim().to_owned();
            params.insert(pname, idx);
        }
        idx += 1;
    }
    params
}

fn detect_wrapper_format_arg(
    expr: &str,
    params: &HashMap<String, usize>,
) -> Option<(usize, String)> {
    let (fmt, fmt_args) = parse_format_macro(expr)?;
    for (pname, &pidx) in params {
        let named = format!("{{{pname}}}");
        if (fmt == format!("{{}}{named}") || fmt == format!("{{}}/{named}"))
            && let Some(base) = fmt_args.first()
        {
            return Some((pidx, clean_base_ref(base)));
        }
        if POSITIONAL_WRAPPER_FMTS.contains(&fmt.as_str())
            && fmt_args.len() >= 2
            && fmt_args[1].trim().trim_start_matches('&') == pname
        {
            return Some((pidx, clean_base_ref(&fmt_args[0])));
        }
    }
    None
}

fn extract_wrapper_call_sites(ctx: &FileCtx<'_>, wrapper: &WrapperDef) -> Vec<ExtractedCall> {
    let bytes = ctx.source.as_bytes();
    let needle = wrapper.name.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + needle.len() < bytes.len() {
        if !ctx.mask[i] || !bytes[i..].starts_with(needle) {
            i += 1;
            continue;
        }
        let after_pos = i + needle.len();
        let prev_is_ident = i > 0 && is_ident_byte(bytes[i - 1]);
        let next_is_ident = is_ident_byte(bytes.get(after_pos).copied().unwrap_or(0));
        let in_body = (wrapper.body_open..=wrapper.body_close).contains(&i);
        if prev_is_ident || next_is_ident || in_body || is_fn_declaration_at(ctx.source, i) {
            i += 1;
            continue;
        }
        let Some(open_paren) = skip_optional_turbofish_to_paren(bytes, ctx.mask, after_pos) else {
            i = after_pos;
            continue;
        };
        if let Some(close_paren) = find_matching_delim(bytes, ctx.mask, open_paren, b'(', b')')
            && let Some(call) =
                ctx.build_call_from_parens(i, open_paren, close_paren, wrapper.method, None, |args| {
                    let path_raw = extract_path_argument(args.get(wrapper.path_param_idx)?.1)?;
                    Some((path_raw, wrapper.base_ref.clone(), wrapper.name.clone()))
                })
        {
            out.push(call);
        }
        i = open_paren + 1;
    }
    out
}

fn is_fn_declaration_at(source: &str, pos: usize) -> bool {
    let prefix = source[..pos].trim_end();
    prefix.ends_with("fn")
        && prefix
            .as_bytes()
            .get(prefix.len().saturating_sub(3))
            .is_none_or(|b| !is_ident_byte(*b))
}

fn skip_optional_turbofish_to_paren(bytes: &[u8], mask: &[bool], start: usize) -> Option<usize> {
    let mut pos = skip_ascii_ws(bytes, start, bytes.len());
    if bytes.get(pos..pos + 3) == Some(b"::<") {
        pos = skip_angle_generics(bytes, mask, pos + 2, bytes.len(), false)?;
        pos = skip_ascii_ws(bytes, pos, bytes.len());
    }
    (bytes.get(pos) == Some(&b'(') && mask[pos]).then_some(pos)
}

fn extract_path_argument(expr: &str) -> Option<String> {
    let trimmed = expr.trim().trim_start_matches('&').trim();
    if let Some(lit) = unquote_double_string(trimmed)
        && lit.starts_with('/')
    {
        return Some(lit);
    }
    parse_format_macro(trimmed).and_then(|(fmt, _)| fmt.starts_with('/').then_some(fmt))
}

fn resolve_local_url_var(
    source: &str,
    mask: &[bool],
    fns: &[(String, usize, usize, usize)],
    call_pos: usize,
    arg_expr: &str,
) -> Option<(String, String)> {
    let var_name = arg_expr.trim().trim_start_matches('&').trim();
    if var_name.is_empty() || !var_name.bytes().all(is_ident_byte) {
        return None;
    }
    let (_, _, open, _) = fns
        .iter()
        .filter(|(_, _, open, close)| call_pos >= *open && call_pos <= *close)
        .min_by_key(|(_, _, open, close)| close - open)?;
    let scope = &source[*open..call_pos];
    let mut best = None;
    for caps in LET_URL_RE.captures_iter(scope) {
        if &caps[1] != var_name {
            continue;
        }
        let abs_init = open + caps.get(0).unwrap().end();
        if !mask[abs_init.saturating_sub(1)] {
            continue;
        }
        let init_end = find_semicolon_at_depth_zero(source.as_bytes(), mask, abs_init, call_pos);
        if let Some(found) = parse_url_expr(source[abs_init..init_end].trim()) {
            best = Some(found);
        }
    }
    best
}

fn parse_url_expr(expr: &str) -> Option<(String, String)> {
    let trimmed = expr.trim().trim_start_matches('&').trim();
    if let Some(lit) = unquote_double_string(trimmed)
        && is_http_url(&lit)
    {
        return Some((lit.clone(), extract_host(&lit)));
    }
    let (fmt, args) = parse_format_macro(trimmed)?;
    if is_http_url(&fmt) {
        return Some((fmt.clone(), extract_host(&fmt)));
    }
    let (captured_base, rest) = strip_leading_placeholder(&fmt)?;
    if !rest.starts_with('/') {
        return None;
    }
    let base_ref = args
        .first()
        .map(|a| clean_base_ref(a))
        .unwrap_or_else(|| captured_base.to_owned());
    if looks_like_http_base(&base_ref) || looks_like_api_path(rest) {
        return Some((rest.to_owned(), base_ref));
    }
    None
}

fn is_http_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

fn strip_leading_placeholder(fmt: &str) -> Option<(&str, &str)> {
    fmt.strip_prefix('{')
        .and_then(|rest| rest.find('}').map(|close| (&rest[..close], &rest[close + 1..])))
}

fn looks_like_http_base(base_ref: &str) -> bool {
    let lower = base_ref.to_ascii_lowercase();
    BASE_HINTS.iter().any(|hint| lower.contains(hint))
}

fn looks_like_api_path(path: &str) -> bool {
    KNOWN_API_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

fn parse_format_macro(expr: &str) -> Option<(String, Vec<String>)> {
    let inner = expr
        .trim()
        .trim_start_matches('&')
        .trim()
        .strip_prefix("format!")?
        .trim_start()
        .strip_prefix('(')?
        .strip_suffix(')')?;
    let mask = rust_code_mask(inner);
    let args = split_top_level_args(inner, &mask, 0, 0, inner.len());
    let fmt = unquote_double_string(args.first()?.1)?;
    let rest = args.iter().skip(1).map(|(_, s)| (*s).to_owned()).collect();
    Some((fmt, rest))
}

fn clean_base_ref(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('&').trim();
    let cut = trimmed
        .find(".trim_end_matches")
        .or_else(|| trimmed.find(".as_str"))
        .unwrap_or(trimmed.len());
    trimmed[..cut].trim().to_owned()
}

fn extract_host(url: &str) -> String {
    url.find("://")
        .map(|idx| url[idx + 3..].split('/').next().unwrap_or("").to_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::scan::strip_cfg_test;
    use super::*;

    #[test]
    fn extracts_direct_reqwest_format_wrapper_and_local_url_and_skips_cfg_test() {
        const INVOICE_PATH: &str = "/api/internal/invoices";
        let src = strip_cfg_test(
            r#"
struct Client {
    base_url: String,
    http: reqwest::Client,
}

impl Client {
    async fn get_json<T>(&self, caller: &str, path: &str, what: &str) -> T {
        let _ = self.http.get(format!("{}{path}", self.base_url)).send().await;
        todo!()
    }

    /// Fetch active cajas for operator.
    async fn cajas(&self, caller: &str) {
        let _ = self.get_json::<Vec<u8>>(caller, "/api/v1/cajas", "cajas").await;
        let _ = self.get_json::<u8>(caller, &format!("/api/v1/cajas/{caller}"), "caja").await;
    }

    /// Issue agnostic invoice to ez-commerce.
    async fn issue(&self) {
        let _ = self
            .http
            .post(format!("{}/api/internal/invoices", self.base_url))
            .send()
            .await;
    }

    async fn messages(&self, id: &str) {
        let url = format!("{}/ai/v1/conversations/{id}/messages", self.base_url.trim_end_matches('/'));
        let _ = self.http.get(&url).send().await;
    }

    async fn external_ping(&self) {
        let _ = self.http.get("https://api.external.test/v1/ping").send().await;
    }
}

#[cfg(test)]
mod tests {
    async fn fake(c: &reqwest::Client) {
        let _ = c.post("https://example.com/api/v1/test-only").send().await;
    }
}
"#,
        );
        let calls = extract_file("src/modules/cochera/ez_commerce.rs", &src, false);
        let summary: Vec<(HttpMethod, &str, &str)> = calls
            .iter()
            .map(|c| (c.method, c.path_norm.as_str(), c.base_ref.as_str()))
            .collect();
        assert!(summary.contains(&(HttpMethod::Get, "/api/v1/cajas", "self.base_url")));
        assert!(summary.contains(&(HttpMethod::Get, "/api/v1/cajas/{}", "self.base_url")));
        assert!(summary.contains(&(HttpMethod::Post, INVOICE_PATH, "self.base_url")));
        assert!(summary.contains(&(HttpMethod::Get, "/ai/v1/conversations/{}/messages", "self.base_url")));
        assert!(summary.contains(&(HttpMethod::Get, "/v1/ping", "api.external.test")));
        assert!(!calls.iter().any(|c| c.path_norm.contains("test-only")));
        let inv = calls
            .iter()
            .find(|c| c.path_norm == INVOICE_PATH)
            .unwrap();
        assert!(inv.why.starts_with("issue: Issue agnostic invoice"));
    }
}
