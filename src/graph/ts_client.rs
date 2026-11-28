use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::scan::{
    LineIndex, extract_why_ts, find_matching_delim, is_ident_byte, is_test_file, join_paths,
    matches_external_glob, normalize_path, qualify_under_root, read_ident, skip_angle_generics,
    skip_ascii_ws, sort_extracted_calls, split_top_level_args, ts_code_mask, under_root,
};
use super::{ExtractedCall, HttpMethod};

const FETCH_CALLEES: &[&str] = &["apiFetch", "apiFetchWithOpts", "apiFetchRaw", "fetch"];
const TS_EXTS: &[&str] = &[".ts", ".tsx", ".js", ".jsx"];
const POST_NO_RETRY: &str = "postNoRetry";

static METHOD_PROP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]"#).expect("valid method prop regex")
});

static API_OBJECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:export\s+)?const\s+api\s*(?::[^=]+)?=\s*\{").expect("valid api object regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperEndpoint {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
}

struct FileScanCtx<'a> {
    rel_file: &'a str,
    source: &'a str,
    mask: &'a [bool],
    lines: &'a LineIndex,
    wrapper_map: &'a HashMap<String, WrapperEndpoint>,
    base_ref: &'a str,
    base_prefix: Option<&'a str>,
    area: &'a str,
    external: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn extract_service(
    repo: &str,
    repo_dir: &Path,
    service_root: &str,
    client_rel: Option<&str>,
    base_service: Option<&str>,
    base_prefix: Option<&str>,
    external_globs: &[String],
    tracked_files: &[String],
) -> Result<Vec<ExtractedCall>> {
    let client_repo_rel = client_rel.map(|c| qualify_under_root(service_root, c));
    let wrapper_map = client_repo_rel
        .as_ref()
        .and_then(|cpath| fs::read_to_string(repo_dir.join(cpath)).ok())
        .map(|src| parse_client_wrappers(&src, base_prefix))
        .unwrap_or_default();
    let mut calls = Vec::new();
    for rel in tracked_files {
        if !is_ts_source(rel) || !under_root(rel, service_root) || is_test_file(rel) {
            continue;
        }
        if client_repo_rel.as_deref() == Some(rel.as_str()) {
            continue;
        }
        let Ok(src) = fs::read_to_string(repo_dir.join(rel)) else {
            continue;
        };
        let external = matches_external_glob(external_globs, repo, rel);
        let area = extract_area(rel, service_root);
        calls.extend(extract_calls_from_file(
            rel,
            &src,
            &wrapper_map,
            base_service.unwrap_or(""),
            base_prefix,
            &area,
            external,
        ));
    }
    sort_extracted_calls(&mut calls);
    Ok(calls)
}

pub fn parse_client_wrappers(
    source: &str,
    base_prefix: Option<&str>,
) -> HashMap<String, WrapperEndpoint> {
    let mut map = HashMap::new();
    let mask = ts_code_mask(source);
    let bytes = source.as_bytes();
    for m in API_OBJECT_RE.find_iter(source) {
        let brace_pos = m.end() - 1;
        if !mask[brace_pos] {
            continue;
        }
        if let Some(close_brace) = find_matching_delim(bytes, &mask, brace_pos, b'{', b'}') {
            parse_object_entries(
                source,
                bytes,
                &mask,
                brace_pos + 1,
                close_brace,
                "",
                base_prefix,
                &mut map,
            );
        }
    }
    map
}

#[allow(clippy::too_many_arguments)]
fn parse_object_entries(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    end: usize,
    namespace: &str,
    base_prefix: Option<&str>,
    out: &mut HashMap<String, WrapperEndpoint>,
) {
    for (entry_offset, entry_text) in split_top_level_args(source, mask, 0, start, end) {
        let Some((key, val_offset, val_text)) = split_property_kv(entry_text, entry_offset, mask)
        else {
            continue;
        };
        if val_text.starts_with('{') && namespace.is_empty() {
            if let Some(sub_close) = find_matching_delim(bytes, mask, val_offset, b'{', b'}') {
                parse_object_entries(source, bytes, mask, val_offset + 1, sub_close, key, base_prefix, out);
            }
            continue;
        }
        if let Some(ep) = extract_fetch_in_wrapper(
            source,
            bytes,
            mask,
            val_offset,
            val_offset + val_text.len(),
            base_prefix,
        ) {
            let full_key = if namespace.is_empty() {
                key.to_owned()
            } else {
                format!("{namespace}.{key}")
            };
            out.insert(full_key, ep);
        }
    }
}

fn split_property_kv<'a>(
    entry: &'a str,
    entry_offset: usize,
    mask: &[bool],
) -> Option<(&'a str, usize, &'a str)> {
    let bytes = entry.as_bytes();
    let key_start = skip_masked_ws(bytes, entry_offset, mask, 0);
    let mut pos = key_start;
    while pos < bytes.len() && is_ident_byte(bytes[pos]) {
        pos += 1;
    }
    if pos == key_start {
        return None;
    }
    let key = &entry[key_start..pos];
    pos = skip_masked_ws(bytes, entry_offset, mask, pos);
    if bytes.get(pos) != Some(&b':') {
        return None;
    }
    pos = skip_masked_ws(bytes, entry_offset, mask, pos + 1);
    Some((key, entry_offset + pos, entry[pos..].trim_end()))
}

fn skip_masked_ws(bytes: &[u8], base_offset: usize, mask: &[bool], mut pos: usize) -> usize {
    while pos < bytes.len() && (!mask[base_offset + pos] || bytes[pos].is_ascii_whitespace()) {
        pos += 1;
    }
    pos
}

fn extract_fetch_in_wrapper(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    end: usize,
    base_prefix: Option<&str>,
) -> Option<WrapperEndpoint> {
    let mut i = start;
    while i < end {
        if !mask[i] {
            i += 1;
            continue;
        }
        let Some((ident, next_i)) = read_ident(source, &bytes[..end], i) else {
            i += 1;
            continue;
        };
        i = next_i;
        if !FETCH_CALLEES.contains(&ident) {
            continue;
        }
        let Some(open_paren) = skip_ts_generics_to_paren(bytes, mask, i, end) else {
            continue;
        };
        let Some(close_paren) = find_matching_delim(bytes, mask, open_paren, b'(', b')') else {
            continue;
        };
        let args = split_top_level_args(source, mask, 0, open_paren + 1, close_paren);
        let raw_lit = extract_ts_path_literal(args.first()?.1)?;
        let full_raw = apply_base_prefix(&raw_lit, base_prefix);
        let path_norm = normalize_path(&full_raw);
        if path_norm.is_empty() {
            return None;
        }
        let method = METHOD_PROP_RE
            .captures(&source[open_paren + 1..close_paren])
            .and_then(|c| HttpMethod::parse(&c[1]))
            .unwrap_or(HttpMethod::Get);
        return Some(WrapperEndpoint {
            method,
            path_raw: full_raw,
            path_norm,
        });
    }
    None
}

pub fn extract_calls_from_file(
    rel_file: &str,
    source: &str,
    wrapper_map: &HashMap<String, WrapperEndpoint>,
    base_ref: &str,
    base_prefix: Option<&str>,
    area: &str,
    external: bool,
) -> Vec<ExtractedCall> {
    let mask = ts_code_mask(source);
    let lines = LineIndex::new(source);
    let ctx = FileScanCtx {
        rel_file,
        source,
        mask: &mask,
        lines: &lines,
        wrapper_map,
        base_ref,
        base_prefix,
        area,
        external,
    };
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 < bytes.len() {
        let at_api = mask[i]
            && bytes[i..].starts_with(b"api.")
            && (i == 0 || (!is_ident_byte(bytes[i - 1]) && bytes[i - 1] != b'.'));
        if !at_api {
            i += 1;
            continue;
        }
        let (next_i, maybe_call) = try_parse_api_call(&ctx, i);
        if let Some(call) = maybe_call {
            out.push(call);
        }
        i = next_i.max(i + 1);
    }
    out
}

fn try_parse_api_call(ctx: &FileScanCtx<'_>, start: usize) -> (usize, Option<ExtractedCall>) {
    let bytes = ctx.source.as_bytes();
    let Some((first_ident, after_first)) = read_ident(ctx.source, bytes, start + 4) else {
        return (start + 4, None);
    };
    if bytes.get(after_first) == Some(&b'.') && ctx.mask[after_first] {
        return parse_nested_wrapper_call(ctx, start, first_ident, after_first + 1);
    }
    parse_single_level_call(ctx, start, first_ident, after_first)
}

fn parse_nested_wrapper_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    first_ident: &str,
    second_start: usize,
) -> (usize, Option<ExtractedCall>) {
    let bytes = ctx.source.as_bytes();
    let Some((second_ident, after_second)) = read_ident(ctx.source, bytes, second_start) else {
        return (second_start, None);
    };
    if skip_ts_generics_to_paren(bytes, ctx.mask, after_second, bytes.len()).is_none() {
        return (after_second, None);
    }
    let key = format!("{first_ident}.{second_ident}");
    let call = ctx
        .wrapper_map
        .get(&key)
        .map(|ep| build_ts_call(ctx, call_start, ep.method, ep.path_raw.clone(), ep.path_norm.clone(), format!("api.{key}")));
    (after_second, call)
}

fn parse_single_level_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    first_ident: &str,
    after_first: usize,
) -> (usize, Option<ExtractedCall>) {
    let bytes = ctx.source.as_bytes();
    let Some(open_paren) = skip_ts_generics_to_paren(bytes, ctx.mask, after_first, bytes.len())
    else {
        return (after_first, None);
    };
    let Some(close_paren) = find_matching_delim(bytes, ctx.mask, open_paren, b'(', b')') else {
        return (open_paren + 1, None);
    };
    if let Some(direct_method) = parse_direct_ts_method(first_ident) {
        let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close_paren);
        let call = args
            .first()
            .and_then(|(_, arg0)| extract_ts_path_literal(arg0))
            .and_then(|raw_lit| {
                let full_raw = apply_base_prefix(&raw_lit, ctx.base_prefix);
                let path_norm = normalize_path(&full_raw);
                (!path_norm.is_empty()).then(|| {
                    build_ts_call(ctx, call_start, direct_method, full_raw, path_norm, format!("api.{first_ident}"))
                })
            });
        return (open_paren + 1, call);
    }
    let call = ctx
        .wrapper_map
        .get(first_ident)
        .map(|ep| build_ts_call(ctx, call_start, ep.method, ep.path_raw.clone(), ep.path_norm.clone(), format!("api.{first_ident}")));
    (open_paren + 1, call)
}

fn build_ts_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    method: HttpMethod,
    path_raw: String,
    path_norm: String,
    symbol: String,
) -> ExtractedCall {
    ExtractedCall {
        method,
        path_raw,
        path_norm,
        file: ctx.rel_file.to_owned(),
        line: ctx.lines.line_at(call_start),
        base_ref: ctx.base_ref.to_owned(),
        symbol,
        area: ctx.area.to_owned(),
        why: extract_why_ts(ctx.source, ctx.lines, call_start),
        external: ctx.external,
    }
}

fn skip_ts_generics_to_paren(
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    limit: usize,
) -> Option<usize> {
    let mut pos = skip_ascii_ws(bytes, start, limit);
    if pos < limit && bytes[pos] == b'<' && mask[pos] {
        pos = skip_angle_generics(bytes, mask, pos, limit, true)?;
        pos = skip_ascii_ws(bytes, pos, limit);
    }
    (pos < limit && bytes[pos] == b'(' && mask[pos]).then_some(pos)
}

fn parse_direct_ts_method(name: &str) -> Option<HttpMethod> {
    if name == POST_NO_RETRY {
        return Some(HttpMethod::Post);
    }
    HttpMethod::parse_crud(name)
}

fn extract_ts_path_literal(arg: &str) -> Option<String> {
    let trimmed = arg.trim();
    if trimmed.len() < 2 {
        return None;
    }
    let (first, last) = (trimmed.as_bytes()[0], trimmed.as_bytes()[trimmed.len() - 1]);
    let quoted = (first == b'"' && last == b'"')
        || (first == b'\'' && last == b'\'')
        || (first == b'`' && last == b'`');
    if !quoted {
        return None;
    }
    let stripped = strip_ts_base_expr(&trimmed[1..trimmed.len() - 1]);
    (stripped.starts_with('/') || stripped.starts_with("http://") || stripped.starts_with("https://"))
        .then(|| stripped.to_owned())
}

fn strip_ts_base_expr(inner: &str) -> &str {
    if let Some(rest) = inner.strip_prefix("${")
        && let Some(close) = rest.find('}')
        && rest[close + 1..].starts_with('/')
    {
        return &rest[close + 1..];
    }
    inner
}

fn apply_base_prefix(raw: &str, base_prefix: Option<&str>) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") || raw.starts_with("/api/") {
        return raw.to_owned();
    }
    let Some(prefix) = base_prefix.filter(|p| !p.is_empty()) else {
        return raw.to_owned();
    };
    if raw.starts_with(prefix) {
        return raw.to_owned();
    }
    join_paths(prefix, raw)
}

fn is_ts_source(rel: &str) -> bool {
    TS_EXTS.iter().any(|ext| rel.ends_with(ext))
}

fn extract_area(rel_file: &str, service_root: &str) -> String {
    let in_root = if service_root.is_empty() {
        rel_file
    } else {
        rel_file
            .strip_prefix(&format!("{service_root}/"))
            .unwrap_or(rel_file)
    };
    let Some(after_pages) = in_root.strip_prefix("src/pages/") else {
        return String::new();
    };
    if let Some((dir, _)) = after_pages.split_once('/') {
        dir.to_owned()
    } else {
        after_pages
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_owned())
            .unwrap_or_else(|| after_pages.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_ts_api_wrappers_skips_generics_and_extracts_page_calls() {
        let client_ts = r#"
export const api = {
  get: <T = unknown>(path: string) => apiFetch<T>(path),
  post: <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body }),
  voucherTypes: () => apiFetch<string[]>("/accountant/voucher-types"),
  sales: {
    list: (params?: QueryParams) => apiFetch<Sale[]>("/sales", { params }),
    create: (payload: unknown) => apiFetch<Sale>("/sales", { method: "POST", body: payload }),
    revise: (id: string, body: unknown) =>
      apiFetch<Sale>(`/sales/${id}/revisions`, {
        method: "POST",
        body,
      }),
  },
};
"#;
        let wrappers = parse_client_wrappers(client_ts, Some("/api/v1"));
        assert!(!wrappers.contains_key("get"));
        assert!(!wrappers.contains_key("post"));
        assert_eq!(
            wrappers.get("sales.list"),
            Some(&WrapperEndpoint {
                method: HttpMethod::Get,
                path_raw: "/api/v1/sales".to_owned(),
                path_norm: "/api/v1/sales".to_owned(),
            })
        );
        assert_eq!(wrappers.get("sales.create").map(|w| w.method), Some(HttpMethod::Post));
        assert_eq!(
            wrappers.get("sales.revise").map(|w| (w.method, w.path_norm.as_str())),
            Some((HttpMethod::Post, "/api/v1/sales/{}/revisions"))
        );
        assert_eq!(
            wrappers.get("voucherTypes").map(|w| w.path_norm.as_str()),
            Some("/api/v1/accountant/voucher-types")
        );

        let page_tsx = r#"
// Load recent sales for the cashier screen.
export async function loadSales(id: string) {
  const list = await api.sales.list();
  await api.sales.revise(id, {});
  await api.get<unknown>("/products");
  await api.postNoRetry<{ ok: boolean }>(`/sales/${id}/voids`, {});
}
"#;
        let calls = extract_calls_from_file(
            "frontend/src/pages/sales/SalesPage.tsx",
            page_tsx,
            &wrappers,
            "ez-commerce-api",
            Some("/api/v1"),
            &extract_area("frontend/src/pages/sales/SalesPage.tsx", "frontend"),
            false,
        );
        let pairs: Vec<(HttpMethod, &str, &str)> = calls
            .iter()
            .map(|c| (c.method, c.path_norm.as_str(), c.area.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (HttpMethod::Get, "/api/v1/sales", "sales"),
                (HttpMethod::Post, "/api/v1/sales/{}/revisions", "sales"),
                (HttpMethod::Get, "/api/v1/products", "sales"),
                (HttpMethod::Post, "/api/v1/sales/{}/voids", "sales"),
            ]
        );
        assert!(calls[0].why.starts_with("loadSales: Load recent sales"));
    }
}
