use std::{collections::HashMap, fs, path::Path, sync::LazyLock};

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::contracts::{
    PROP_BODY, PayloadContract, extract_ts_body_contract, extract_ts_call_opts,
    extract_ts_opts_body_contract,
};
use super::scan::{
    LineIndex, collect_local_path_consts, extract_ts_area, extract_ts_method_opt,
    extract_ts_path_with_consts, extract_why_ts, find_matching_delim, for_each_masked_ident,
    is_ident_byte, is_test_file, is_ts_source, join_paths, matches_external_glob, normalize_path,
    parallel_map, qualify_under_root, read_ident, skip_angle_generics, skip_ascii_ws,
    sort_extracted_calls, split_top_level_args, ts_code_mask, under_root, unquote_ts_string,
};
use super::types::{ExtractedCall, HttpMethod};

const FETCH_CALLEES: &[&str] = &["apiFetch", "apiFetchWithOpts", "apiFetchRaw", "fetch"];
const POST_NO_RETRY: &str = "postNoRetry";

static API_OBJECT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:export\s+)?const\s+api\s*(?::[^=]+)?=\s*\{").expect("valid api object regex")
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrapperEndpoint {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_param_idx: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal_body: Option<PayloadContract>,
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

pub struct TsServiceSpec<'a> {
    pub repo: &'a str,
    pub repo_dir: &'a Path,
    pub service_root: &'a str,
    pub client_rel: Option<&'a str>,
    pub base_service: Option<&'a str>,
    pub base_prefix: Option<&'a str>,
    pub external_globs: &'a [String],
}

pub fn load_service_wrappers(spec: &TsServiceSpec<'_>) -> HashMap<String, WrapperEndpoint> {
    spec.client_rel
        .map(|c| qualify_under_root(spec.service_root, c))
        .and_then(|cpath| fs::read_to_string(spec.repo_dir.join(cpath)).ok())
        .map(|src| parse_client_wrappers(&src, spec.base_prefix))
        .unwrap_or_default()
}

pub fn extract_files_with_wrappers(
    spec: &TsServiceSpec<'_>,
    files: &[String],
    wrapper_map: &HashMap<String, WrapperEndpoint>,
) -> Vec<ExtractedCall> {
    let client_repo_rel = spec
        .client_rel
        .map(|c| qualify_under_root(spec.service_root, c));
    let candidates: Vec<&String> = files
        .iter()
        .filter(|rel| {
            is_ts_source(rel)
                && under_root(rel, spec.service_root)
                && !is_test_file(rel)
                && client_repo_rel.as_deref() != Some(rel.as_str())
        })
        .collect();
    let mut calls: Vec<ExtractedCall> = parallel_map(&candidates, |rel| {
        let Ok(src) = fs::read_to_string(spec.repo_dir.join(rel)) else {
            return Vec::new();
        };
        let external = matches_external_glob(spec.external_globs, spec.repo, rel);
        let area = extract_ts_area(rel, spec.service_root);
        extract_calls_from_file(
            rel,
            &src,
            wrapper_map,
            spec.base_service.unwrap_or(""),
            spec.base_prefix,
            &area,
            external,
        )
    })
    .into_iter()
    .flatten()
    .collect();
    sort_extracted_calls(&mut calls);
    calls
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
    let spec = TsServiceSpec {
        repo,
        repo_dir,
        service_root,
        client_rel,
        base_service,
        base_prefix,
        external_globs,
    };
    let wrapper_map = load_service_wrappers(&spec);
    Ok(extract_files_with_wrappers(&spec, tracked_files, &wrapper_map))
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
    let param_indices = parse_wrapper_arrow_params(source, bytes, mask, start, end);
    let mut found = None;
    for_each_masked_ident(source, mask, start, end, |ident, next_i| {
        if !FETCH_CALLEES.contains(&ident) {
            return Some(next_i);
        }
        let Some(open_paren) = skip_ts_generics_to_paren(bytes, mask, next_i, end) else {
            return Some(next_i);
        };
        let Some(close_paren) = find_matching_delim(bytes, mask, open_paren, b'(', b')') else {
            return Some(next_i);
        };
        found = build_wrapper_endpoint(
            source,
            mask,
            open_paren,
            close_paren,
            base_prefix,
            &param_indices,
        );
        None
    });
    found
}

fn parse_wrapper_arrow_params(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    end: usize,
) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    let mut pos = skip_ascii_ws(bytes, start, end);
    if source[pos..end].starts_with("async")
        && !is_ident_byte(bytes.get(pos + 5).copied().unwrap_or(0))
    {
        pos = skip_ascii_ws(bytes, pos + 5, end);
    }
    if bytes.get(pos) != Some(&b'(') || !mask[pos] {
        return map;
    }
    let Some(close) = find_matching_delim(bytes, mask, pos, b'(', b')') else {
        return map;
    };
    for (idx, (_, arg)) in split_top_level_args(source, mask, 0, pos + 1, close)
        .into_iter()
        .enumerate()
    {
        let pname = arg
            .split([':', '=', '?'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches("...");
        if !pname.is_empty() && pname.bytes().all(is_ident_byte) {
            map.insert(pname.to_owned(), idx);
        }
    }
    map
}

fn build_wrapper_endpoint(
    source: &str,
    mask: &[bool],
    open_paren: usize,
    close_paren: usize,
    base_prefix: Option<&str>,
    param_indices: &HashMap<String, usize>,
) -> Option<WrapperEndpoint> {
    let args = split_top_level_args(source, mask, 0, open_paren + 1, close_paren);
    let raw_lit = extract_ts_path_literal(args.first()?.1)?;
    let full_raw = apply_base_prefix(&raw_lit, base_prefix);
    let path_norm = normalize_path(&full_raw);
    if path_norm.is_empty() {
        return None;
    }
    let method = extract_ts_method_opt(&source[open_paren + 1..close_paren]);
    let (body_param_idx, literal_body) = args
        .get(1)
        .map(|(_, opts)| inspect_wrapper_opts_body(opts, param_indices))
        .unwrap_or((None, None));
    Some(WrapperEndpoint {
        method,
        path_raw: full_raw,
        path_norm,
        body_param_idx,
        literal_body,
    })
}

fn inspect_wrapper_opts_body(
    opts: &str,
    param_indices: &HashMap<String, usize>,
) -> (Option<usize>, Option<PayloadContract>) {
    if let Some(lit) = extract_ts_opts_body_contract(opts) {
        return (None, Some(lit));
    }
    let Some(inner) = opts.trim().strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
        return (None, None);
    };
    let mask = ts_code_mask(inner);
    for (_, entry) in split_top_level_args(inner, &mask, 0, 0, inner.len()) {
        let trimmed = entry.trim();
        let val = if trimmed == PROP_BODY {
            PROP_BODY
        } else if let Some((k, v)) = trimmed.split_once(':')
            && k.trim() == PROP_BODY
        {
            v.trim()
        } else {
            continue;
        };
        let unwrapped = val
            .strip_prefix("JSON.stringify")
            .and_then(|r| r.trim().strip_prefix('('))
            .and_then(|r| r.strip_suffix(')'))
            .map(str::trim)
            .unwrap_or(val);
        if let Some(&idx) = param_indices.get(unwrapped) {
            return (Some(idx), None);
        }
    }
    (None, None)
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
    let local_paths = collect_local_path_consts(source, &mask);
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
    while i + 3 < bytes.len() {
        let is_api_ident = mask[i]
            && bytes[i..].starts_with(b"api")
            && (i == 0 || (!is_ident_byte(bytes[i - 1]) && bytes[i - 1] != b'.'));
        if !is_api_ident {
            i += 1;
            continue;
        }
        if bytes.get(i + 3) == Some(&b'.') && mask[i + 3] {
            let (next_i, maybe_call) = try_parse_api_call(&ctx, i);
            if let Some(call) = maybe_call {
                out.push(call);
            }
            i = next_i.max(i + 1);
            continue;
        }
        if !bytes.get(i + 3).copied().is_some_and(is_ident_byte)
            && !is_ts_fn_declaration_at(source, i)
            && let Some((next_i, maybe_call)) = try_parse_direct_api_fn_call(&ctx, i, &local_paths)
        {
            if let Some(call) = maybe_call {
                out.push(call);
            }
            i = next_i.max(i + 1);
            continue;
        }
        i += 1;
    }
    out
}

fn is_ts_fn_declaration_at(source: &str, pos: usize) -> bool {
    const KW_LEN: usize = 8;
    let prefix = source[..pos].trim_end();
    prefix.ends_with("function")
        && (prefix.len() == KW_LEN || !is_ident_byte(prefix.as_bytes()[prefix.len() - KW_LEN - 1]))
}

fn try_parse_direct_api_fn_call(
    ctx: &FileScanCtx<'_>,
    start: usize,
    local_paths: &HashMap<String, String>,
) -> Option<(usize, Option<ExtractedCall>)> {
    let bytes = ctx.source.as_bytes();
    let open_paren = skip_ts_generics_to_paren(bytes, ctx.mask, start + 3, bytes.len())?;
    let close_paren = find_matching_delim(bytes, ctx.mask, open_paren, b'(', b')')?;
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close_paren);
    let raw_lit = args
        .first()
        .and_then(|(_, arg0)| extract_ts_path_with_consts(arg0, local_paths));
    let call = raw_lit.and_then(|lit| {
        let (method, req_contract) = extract_ts_call_opts(&args);
        build_direct_ts_call(ctx, start, method, &lit, "api".to_owned(), req_contract)
    });
    Some((open_paren + 1, call))
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
    let Some(open_paren) = skip_ts_generics_to_paren(bytes, ctx.mask, after_second, bytes.len())
    else {
        return (after_second, None);
    };
    let close_paren = find_matching_delim(bytes, ctx.mask, open_paren, b'(', b')');
    let key = format!("{first_ident}.{second_ident}");
    let call = build_wrapper_call(ctx, call_start, &key, open_paren, close_paren);
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
        let req_contract = args.get(1).and_then(|(_, b)| extract_ts_body_contract(b));
        let call = args
            .first()
            .and_then(|(_, arg0)| extract_ts_path_literal(arg0))
            .and_then(|lit| {
                build_direct_ts_call(
                    ctx,
                    call_start,
                    direct_method,
                    &lit,
                    format!("api.{first_ident}"),
                    req_contract,
                )
            });
        return (open_paren + 1, call);
    }
    let call = build_wrapper_call(ctx, call_start, first_ident, open_paren, Some(close_paren));
    (open_paren + 1, call)
}

fn build_direct_ts_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    method: HttpMethod,
    raw_lit: &str,
    symbol: String,
    req_contract: Option<PayloadContract>,
) -> Option<ExtractedCall> {
    let full_raw = apply_base_prefix(raw_lit, ctx.base_prefix);
    let path_norm = normalize_path(&full_raw);
    (!path_norm.is_empty()).then(|| {
        build_ts_call(
            ctx,
            call_start,
            method,
            full_raw,
            path_norm,
            symbol,
            req_contract,
        )
    })
}

fn build_wrapper_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    key: &str,
    open_paren: usize,
    close_paren: Option<usize>,
) -> Option<ExtractedCall> {
    let ep = ctx.wrapper_map.get(key)?;
    let req_contract = resolve_wrapper_call_body(ctx, open_paren, close_paren, ep);
    Some(build_ts_call(
        ctx,
        call_start,
        ep.method,
        ep.path_raw.clone(),
        ep.path_norm.clone(),
        format!("api.{key}"),
        req_contract,
    ))
}

fn resolve_wrapper_call_body(
    ctx: &FileScanCtx<'_>,
    open_paren: usize,
    close_paren: Option<usize>,
    ep: &WrapperEndpoint,
) -> Option<PayloadContract> {
    if let Some(lit) = &ep.literal_body {
        return Some(lit.clone());
    }
    let (Some(idx), Some(close)) = (ep.body_param_idx, close_paren) else {
        return None;
    };
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close);
    args.get(idx).and_then(|(_, arg)| extract_ts_body_contract(arg))
}

fn build_ts_call(
    ctx: &FileScanCtx<'_>,
    call_start: usize,
    method: HttpMethod,
    path_raw: String,
    path_norm: String,
    symbol: String,
    req_contract: Option<PayloadContract>,
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
        req_contract,
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
    let inner = unquote_ts_string(arg)?;
    let stripped = strip_ts_base_expr(&inner);
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
                body_param_idx: None,
                literal_body: None,
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
            &extract_ts_area("frontend/src/pages/sales/SalesPage.tsx", "frontend"),
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

    #[test]
    fn extracts_direct_generic_api_fn_calls_with_local_base_const() {
        let admin_ts = r#"
import { api } from '../stores/auth';
const BASE = '/admin/growth';

export const listClients = () => api<unknown>(`${BASE}/clients`);
export const createClient = (body: unknown) =>
  api<unknown>(`${BASE}/clients`, { method: 'POST', body: JSON.stringify(body) });
export const getCoverage = () => api<unknown>('/admin/revenue/coverage');
"#;
        let calls = extract_calls_from_file(
            "packages/admin-web/src/lib/growth-api.ts",
            admin_ts,
            &HashMap::new(),
            "huggian-core",
            None,
            "",
            false,
        );
        let pairs: Vec<(HttpMethod, &str)> = calls
            .iter()
            .map(|c| (c.method, c.path_norm.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (HttpMethod::Get, "/admin/growth/clients"),
                (HttpMethod::Post, "/admin/growth/clients"),
                (HttpMethod::Get, "/admin/revenue/coverage"),
            ]
        );
    }
}
