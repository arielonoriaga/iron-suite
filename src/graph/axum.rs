use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::scan::{
    LineIndex, enclosing_fn_name, find_matching_delim, find_rust_functions,
    find_semicolon_at_depth_zero, for_each_dot_call, is_ident_byte, join_paths, normalize_path,
    qualify_under_root, read_ident, read_rust_service_files, rust_code_mask,
    sort_extracted_endpoints, split_top_level_args, unquote_double_string,
};
use super::{ExtractedEndpoint, HttpMethod, PrefixState};

const METHOD_MERGE: &str = "merge";
const LAYER_METHODS: &[&str] = &["layer", "route_layer", "with_state"];
const SKIP_CALLEE_FNS: &[&str] = &["Router", "new"];
const API_PREFIX: &str = "/api/";

static CONST_STR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"\s*;"#)
        .expect("valid const str regex")
});

static USE_ALIAS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([a-z_][a-z0-9_]*)\s+as\s+([a-z_][a-z0-9_]*)\b")
        .expect("valid use alias regex")
});

static LET_BINDING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*(?::[^=]+)?=").expect("valid let regex")
});

type ConstTables = (HashMap<(String, String), String>, HashMap<String, String>);
type VarParentMap = HashMap<(String, String), Vec<(Option<String>, String)>>;

#[derive(Debug, Clone)]
struct RawRoute {
    file: String,
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    method: HttpMethod,
    path_raw: String,
    line: usize,
    handler: String,
}

#[derive(Debug, Clone)]
struct RawNest {
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    prefix: String,
    callee_expr: String,
}

#[derive(Debug, Clone)]
struct RawMerge {
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    callee_expr: String,
}

#[derive(Debug, Clone)]
struct FileParse {
    rel_file: String,
    crate_key: String,
    aliases: HashMap<String, String>,
    fn_names: HashSet<String>,
    var_names_by_fn: HashMap<String, HashSet<String>>,
    routes: Vec<RawRoute>,
    nests: Vec<RawNest>,
    merges: Vec<RawMerge>,
}

struct ParseCtx<'a> {
    rel_file: &'a str,
    crate_key: &'a str,
    source: &'a str,
    mask: &'a [bool],
    lines: &'a LineIndex,
    consts: &'a ConstTables,
}

pub fn extract_service(
    repo_dir: &Path,
    service_root: &str,
    entry: Option<&str>,
    tracked_files: &[String],
) -> Result<Vec<ExtractedEndpoint>> {
    let sources = read_rust_service_files(repo_dir, service_root, tracked_files);
    extract_from_sources(&sources, service_root, entry)
}

pub fn extract_from_sources(
    sources: &[(String, String)],
    service_root: &str,
    entry: Option<&str>,
) -> Result<Vec<ExtractedEndpoint>> {
    let consts = collect_const_strings(sources, service_root);
    let parsed_files: Vec<FileParse> = sources
        .iter()
        .map(|(rel_file, src)| parse_file(rel_file, &crate_key_for(rel_file, service_root), src, &consts))
        .collect();
    let entry_rel = entry.map(|e| qualify_under_root(service_root, e));
    Ok(resolve_service_routes(&parsed_files, entry_rel.as_deref()))
}

fn crate_key_for(rel: &str, service_root: &str) -> String {
    if let Some(pos) = rel.find("crates/") {
        let after = &rel[pos + 7..];
        if let Some(slash) = after.find('/') {
            return rel[..pos + 7 + slash].to_owned();
        }
    }
    service_root.to_owned()
}

fn collect_const_strings(sources: &[(String, String)], service_root: &str) -> ConstTables {
    let mut scoped = HashMap::new();
    let mut global = HashMap::new();
    for (rel, src) in sources {
        let ck = crate_key_for(rel, service_root);
        for caps in CONST_STR_RE.captures_iter(src) {
            let name = caps[1].to_owned();
            let val = caps[2].to_owned();
            scoped.insert((ck.clone(), name.clone()), val.clone());
            global.insert(name, val);
        }
    }
    (scoped, global)
}

fn parse_file(rel_file: &str, crate_key: &str, source: &str, consts: &ConstTables) -> FileParse {
    let mask = rust_code_mask(source);
    let lines = LineIndex::new(source);
    let fns = find_rust_functions(source, &mask);
    let let_spans = collect_let_spans(source, &mask, &fns);
    let mut var_names_by_fn: HashMap<String, HashSet<String>> = HashMap::new();
    for (fn_name, var_name, _, _) in &let_spans {
        var_names_by_fn
            .entry(fn_name.clone())
            .or_default()
            .insert(var_name.clone());
    }
    let ctx = ParseCtx {
        rel_file,
        crate_key,
        source,
        mask: &mask,
        lines: &lines,
        consts,
    };
    let mut parse = FileParse {
        rel_file: rel_file.to_owned(),
        crate_key: crate_key.to_owned(),
        aliases: collect_aliases(source),
        fn_names: fns.iter().map(|(n, _, _, _)| n.clone()).collect(),
        var_names_by_fn,
        routes: Vec::new(),
        nests: Vec::new(),
        merges: Vec::new(),
    };
    scan_router_calls(&ctx, &fns, &let_spans, &mut parse);
    parse
}

fn scan_router_calls(
    ctx: &ParseCtx<'_>,
    fns: &[(String, usize, usize, usize)],
    let_spans: &[(String, String, usize, usize)],
    parse: &mut FileParse,
) {
    for_each_dot_call(ctx.source, ctx.mask, 0, ctx.source.len(), |name, dot_pos, open, close| {
        let enclosing = enclosing_fn_name(fns, dot_pos);
        let owner = owner_var_name(let_spans, enclosing.as_deref(), dot_pos);
        Some(dispatch_router_call(ctx, name, (dot_pos, open, close), (enclosing, owner), parse))
    });
}

fn dispatch_router_call(
    ctx: &ParseCtx<'_>,
    method_name: &str,
    span: (usize, usize, usize),
    scope: (Option<String>, Option<String>),
    parse: &mut FileParse,
) -> usize {
    let (dot_pos, open_paren, close_paren) = span;
    let (enclosing_fn, owner_var) = scope;
    match method_name {
        "route" => {
            record_route_call(ctx, open_paren, close_paren, enclosing_fn, owner_var, &mut parse.routes);
            close_paren + 1
        }
        "nest" => {
            record_nest_call(ctx, open_paren, close_paren, enclosing_fn, owner_var, &mut parse.nests);
            open_paren + 1
        }
        METHOD_MERGE => {
            record_merge_call(ctx, dot_pos, open_paren, close_paren, enclosing_fn, owner_var, &mut parse.merges);
            open_paren + 1
        }
        _ => dot_pos + 1,
    }
}

fn record_route_call(
    ctx: &ParseCtx<'_>,
    open_paren: usize,
    close_paren: usize,
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    routes: &mut Vec<RawRoute>,
) {
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close_paren);
    if args.len() < 2 {
        return;
    }
    let Some(path_raw) = resolve_path_expr(args[0].1, ctx.crate_key, ctx.consts) else {
        return;
    };
    let line = ctx.lines.line_at(args[0].0);
    for (method, handler) in extract_route_methods(ctx.source, ctx.mask, args[1].0, close_paren) {
        routes.push(RawRoute {
            file: ctx.rel_file.to_owned(),
            enclosing_fn: enclosing_fn.clone(),
            owner_var: owner_var.clone(),
            method,
            path_raw: path_raw.clone(),
            line,
            handler,
        });
    }
}

fn record_nest_call(
    ctx: &ParseCtx<'_>,
    open_paren: usize,
    close_paren: usize,
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    nests: &mut Vec<RawNest>,
) {
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close_paren);
    if args.len() < 2 {
        return;
    }
    if let Some(prefix) = resolve_path_expr(args[0].1, ctx.crate_key, ctx.consts) {
        nests.push(RawNest {
            enclosing_fn,
            owner_var,
            prefix,
            callee_expr: args[1].1.to_owned(),
        });
    }
}

fn record_merge_call(
    ctx: &ParseCtx<'_>,
    dot_pos: usize,
    open_paren: usize,
    close_paren: usize,
    enclosing_fn: Option<String>,
    owner_var: Option<String>,
    merges: &mut Vec<RawMerge>,
) {
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open_paren + 1, close_paren);
    let Some((_, arg0)) = args.first() else {
        return;
    };
    if let Some(rec) = preceding_ident(ctx.source, ctx.source.as_bytes(), dot_pos) {
        merges.push(RawMerge {
            enclosing_fn: enclosing_fn.clone(),
            owner_var: owner_var.clone(),
            callee_expr: rec,
        });
    }
    merges.push(RawMerge {
        enclosing_fn,
        owner_var,
        callee_expr: (*arg0).to_owned(),
    });
}

fn collect_aliases(source: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("use ") && !trimmed.contains(" as ") {
            continue;
        }
        for caps in USE_ALIAS_RE.captures_iter(trimmed) {
            map.insert(caps[2].to_owned(), caps[1].to_owned());
        }
    }
    map
}

fn collect_let_spans(
    source: &str,
    mask: &[bool],
    fns: &[(String, usize, usize, usize)],
) -> Vec<(String, String, usize, usize)> {
    let bytes = source.as_bytes();
    let mut spans = Vec::new();
    for (fn_name, _, open, close) in fns {
        let slice = &source[*open..*close];
        for caps in LET_BINDING_RE.captures_iter(slice) {
            let m = caps.get(0).unwrap();
            if !mask[open + m.start()] {
                continue;
            }
            let stmt_end = find_semicolon_at_depth_zero(bytes, mask, open + m.end(), *close);
            spans.push((fn_name.clone(), caps[1].to_owned(), open + m.end(), stmt_end));
        }
    }
    spans
}

fn owner_var_name(
    spans: &[(String, String, usize, usize)],
    enclosing_fn: Option<&str>,
    pos: usize,
) -> Option<String> {
    let fn_name = enclosing_fn?;
    spans
        .iter()
        .filter(|(f, _, start, end)| f == fn_name && pos >= *start && pos <= *end)
        .min_by_key(|(_, _, start, end)| end - start)
        .map(|(_, var, _, _)| var.clone())
}

fn preceding_ident(source: &str, bytes: &[u8], dot_pos: usize) -> Option<String> {
    let mut end = dot_pos;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    (start < end).then(|| source[start..end].to_owned())
}

fn resolve_path_expr(expr: &str, crate_key: &str, consts: &ConstTables) -> Option<String> {
    let trimmed = expr.trim();
    if let Some(lit) = unquote_double_string(trimmed) {
        return Some(lit);
    }
    let ident = trimmed.rsplit("::").next().unwrap_or(trimmed).trim();
    let is_const = !ident.is_empty()
        && ident
            .chars()
            .all(|c| matches!(c, 'A'..='Z' | '0'..='9' | '_'));
    if !is_const {
        return None;
    }
    consts
        .0
        .get(&(crate_key.to_owned(), ident.to_owned()))
        .or_else(|| consts.1.get(ident))
        .cloned()
}

fn extract_route_methods(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> Vec<(HttpMethod, String)> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
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
        let mut ws = i;
        while ws < end && bytes[ws].is_ascii_whitespace() {
            ws += 1;
        }
        if ws >= end || bytes[ws] != b'(' || !mask[ws] {
            continue;
        }
        let Some(arg_close) = find_matching_delim(bytes, mask, ws, b'(', b')') else {
            continue;
        };
        if LAYER_METHODS.contains(&ident) {
            i = arg_close + 1;
            continue;
        }
        if ident == METHOD_MERGE {
            i = ws + 1;
            continue;
        }
        if let Some(method) = HttpMethod::parse(ident) {
            out.push((method, summarize_handler(source[ws + 1..arg_close].trim())));
            i = arg_close + 1;
            continue;
        }
        i = ws + 1;
    }
    out
}

fn summarize_handler(trimmed: &str) -> String {
    if trimmed.is_empty() {
        return "<unknown>".to_owned();
    }
    if trimmed.starts_with('|')
        || trimmed.starts_with("move |")
        || trimmed.starts_with("async ")
        || trimmed.starts_with("move async")
    {
        return "<closure>".to_owned();
    }
    let end = trimmed
        .find(|c: char| !matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | ':'))
        .unwrap_or(trimmed.len());
    let ident = trimmed[..end].trim();
    if ident.is_empty() {
        "<expr>".to_owned()
    } else {
        ident.to_owned()
    }
}

fn resolve_service_routes(files: &[FileParse], entry_rel: Option<&str>) -> Vec<ExtractedEndpoint> {
    let entry_module_prefixes = collect_entry_module_prefixes(files, entry_rel);
    let fn_prefixes = collect_inter_fn_prefixes(files, entry_rel);
    let mut endpoints = Vec::new();
    for file in files {
        let local_prefixes = compute_local_var_prefixes(file);
        let module_prefix = module_prefix_for_file(&file.rel_file, &entry_module_prefixes);
        let is_entry = entry_rel == Some(file.rel_file.as_str());
        for route in &file.routes {
            let local_p = route
                .enclosing_fn
                .as_ref()
                .and_then(|f| {
                    route
                        .owner_var
                        .as_ref()
                        .and_then(|v| local_prefixes.get(&(f.clone(), v.clone())))
                })
                .map(String::as_str)
                .unwrap_or("");
            let fn_p = route.enclosing_fn.as_ref().and_then(|f| {
                fn_prefixes
                    .get(&(file.rel_file.clone(), f.clone()))
                    .or_else(|| fn_prefixes.get(&(file.crate_key.clone(), f.clone())))
            });
            let (full_raw, prefix_state) = assemble_route_path(
                &route.path_raw,
                is_entry,
                module_prefix.as_deref(),
                fn_p.map(|(p, r)| (p.as_str(), *r)),
                local_p,
            );
            let path_norm = normalize_path(&full_raw);
            if !path_norm.is_empty() {
                endpoints.push(ExtractedEndpoint {
                    method: route.method,
                    path_raw: full_raw,
                    path_norm,
                    file: route.file.clone(),
                    line: route.line,
                    handler: route.handler.clone(),
                    prefix_state,
                });
            }
        }
    }
    sort_extracted_endpoints(&mut endpoints);
    endpoints
}

fn collect_entry_module_prefixes(
    files: &[FileParse],
    entry_rel: Option<&str>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(file) = entry_rel.and_then(|entry| files.iter().find(|f| f.rel_file == entry)) else {
        return map;
    };
    for nest in &file.nests {
        if let Some((mod_seg, _)) = extract_callee_module_and_fn(&nest.callee_expr) {
            let resolved_mod = file.aliases.get(&mod_seg).cloned().unwrap_or(mod_seg);
            map.insert(resolved_mod, nest.prefix.clone());
        }
    }
    map
}

fn collect_inter_fn_prefixes(
    files: &[FileParse],
    entry_rel: Option<&str>,
) -> HashMap<(String, String), (String, bool)> {
    let mut out: HashMap<(String, String), (String, bool)> = HashMap::new();
    for file in files {
        let is_entry = entry_rel == Some(file.rel_file.as_str());
        for nest in &file.nests {
            if extract_callee_module_and_fn(&nest.callee_expr).is_some() {
                continue;
            }
            let Some(fn_name) = extract_callee_fn_name(&nest.callee_expr) else {
                continue;
            };
            let rooted = is_entry || nest.prefix.starts_with(API_PREFIX);
            if file.fn_names.contains(&fn_name) {
                out.insert((file.rel_file.clone(), fn_name), (nest.prefix.clone(), rooted));
            } else if files
                .iter()
                .any(|f| f.crate_key == file.crate_key && f.fn_names.contains(&fn_name))
            {
                let key = (file.crate_key.clone(), fn_name);
                if out.get(&key).is_none_or(|(_, r)| !*r && rooted) {
                    out.insert(key, (nest.prefix.clone(), rooted));
                }
            }
        }
    }
    out
}

fn compute_local_var_prefixes(file: &FileParse) -> HashMap<(String, String), String> {
    let mut parents: VarParentMap = HashMap::new();
    for nest in &file.nests {
        let Some(ref fn_name) = nest.enclosing_fn else {
            continue;
        };
        let Some(vars) = file.var_names_by_fn.get(fn_name) else {
            continue;
        };
        for var in extract_referenced_vars(&nest.callee_expr, vars) {
            parents
                .entry((fn_name.clone(), var))
                .or_default()
                .push((nest.owner_var.clone(), nest.prefix.clone()));
        }
    }
    for merge in &file.merges {
        let Some(ref fn_name) = merge.enclosing_fn else {
            continue;
        };
        let Some(vars) = file.var_names_by_fn.get(fn_name) else {
            continue;
        };
        for var in extract_referenced_vars(&merge.callee_expr, vars) {
            if merge.owner_var.as_deref() != Some(var.as_str()) {
                parents
                    .entry((fn_name.clone(), var))
                    .or_default()
                    .push((merge.owner_var.clone(), String::new()));
            }
        }
    }
    let mut resolved = HashMap::new();
    for key in parents.keys() {
        let mut visited = HashSet::new();
        let prefix = resolve_var_chain(key, &parents, &mut visited);
        if !prefix.is_empty() {
            resolved.insert(key.clone(), prefix);
        }
    }
    resolved
}

fn resolve_var_chain(
    key: &(String, String),
    parents: &VarParentMap,
    visited: &mut HashSet<(String, String)>,
) -> String {
    if !visited.insert(key.clone()) {
        return String::new();
    }
    let Some(edges) = parents.get(key) else {
        return String::new();
    };
    let mut best = String::new();
    for (parent_var, seg) in edges {
        let parent_prefix = match parent_var {
            Some(pv) => resolve_var_chain(&(key.0.clone(), pv.clone()), parents, visited),
            None => String::new(),
        };
        let combined = join_paths(&parent_prefix, seg);
        if combined.len() > best.len() {
            best = combined;
        }
    }
    visited.remove(key);
    best
}

fn extract_referenced_vars(expr: &str, known_vars: &HashSet<String>) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = expr.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if !is_ident_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_ident_byte(bytes[i]) {
            i += 1;
        }
        let prev = if start > 0 { bytes[start - 1] } else { 0 };
        let next = bytes.get(i).copied().unwrap_or(0);
        if matches!(prev, b'.' | b':') || next == b'(' {
            continue;
        }
        let ident = &expr[start..i];
        if known_vars.contains(ident) && !found.iter().any(|v| v == ident) {
            found.push(ident.to_owned());
        }
    }
    found
}

fn extract_callee_module_and_fn(expr: &str) -> Option<(String, String)> {
    let head = expr.trim().split('(').next()?.trim();
    let mut parts = head.rsplit("::");
    let fn_name = parts.next()?.trim();
    let mod_name = parts.next()?.trim();
    (!fn_name.is_empty() && !mod_name.is_empty())
        .then(|| (mod_name.to_owned(), fn_name.to_owned()))
}

fn extract_callee_fn_name(expr: &str) -> Option<String> {
    let head = expr.trim().split('(').next()?.trim();
    let fn_name = head.rsplit("::").next()?.trim();
    (!fn_name.is_empty() && !SKIP_CALLEE_FNS.contains(&fn_name)).then(|| fn_name.to_owned())
}

fn module_prefix_for_file(
    rel_file: &str,
    entry_module_prefixes: &BTreeMap<String, String>,
) -> Option<String> {
    for (mod_name, prefix) in entry_module_prefixes {
        let matches_mod = rel_file.contains(&format!("/modules/{mod_name}/"))
            || rel_file.ends_with(&format!("/modules/{mod_name}.rs"))
            || rel_file.starts_with(&format!("src/modules/{mod_name}/"))
            || rel_file == format!("src/modules/{mod_name}.rs");
        if matches_mod {
            return Some(prefix.clone());
        }
    }
    None
}

fn assemble_route_path(
    raw_path: &str,
    is_entry: bool,
    module_prefix: Option<&str>,
    fn_prefix: Option<(&str, bool)>,
    local_prefix: &str,
) -> (String, PrefixState) {
    if raw_path.starts_with(API_PREFIX) {
        return (raw_path.to_owned(), PrefixState::Full);
    }
    if is_entry {
        return (join_paths(local_prefix, raw_path), PrefixState::Full);
    }
    let with_local = join_paths(local_prefix, raw_path);
    match (module_prefix, fn_prefix) {
        (Some(mp), Some((fp, _))) => {
            let combined = if fp.starts_with(mp) || fp.starts_with(API_PREFIX) {
                join_paths(fp, &with_local)
            } else {
                join_paths(&join_paths(mp, fp), &with_local)
            };
            (combined, PrefixState::Resolved)
        }
        (Some(mp), None) => (join_paths(mp, &with_local), PrefixState::Resolved),
        (None, Some((fp, rooted))) => {
            let combined = join_paths(fp, &with_local);
            let state = if rooted || combined.starts_with(API_PREFIX) {
                PrefixState::Resolved
            } else {
                PrefixState::Partial
            };
            (combined, state)
        }
        (None, None) => {
            let state = if with_local.starts_with(API_PREFIX) {
                PrefixState::Resolved
            } else {
                PrefixState::Partial
            };
            (with_local, state)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::scan::strip_cfg_test;
    use super::*;

    #[test]
    fn extracts_multiline_route_merge_methods_nest_const_and_skips_cfg_test() {
        let sources = vec![
            (
                "backend/crates/ez-accountant/src/module.rs".to_owned(),
                strip_cfg_test(
                    r#"
const ACCOUNTANT_API_PREFIX: &str = "/api/v1/accountant";

pub fn public_routes() -> Router {
    Router::new().nest(ACCOUNTANT_API_PREFIX, accountant_router())
}
"#,
                ),
            ),
            (
                "backend/crates/ez-accountant/src/api/mod.rs".to_owned(),
                strip_cfg_test(
                    r#"
pub fn accountant_router() -> Router {
    let scoped = Router::new()
        .route("/sales", get(list_sales))
        .route(
            "/settings",
            get(settings).merge(put(update_settings).layer(gate.clone())),
        );
    Router::new()
        .route(
            "/api/internal/invoices",
            post(create_agnostic_invoice_idempotent),
        )
        .nest("/commerces/:company_id", scoped)
}

#[cfg(test)]
mod tests {
    fn test_router() -> Router {
        Router::new().route("/api/v1/only-in-tests", get(fake_handler))
    }
}
"#,
                ),
            ),
        ];
        let eps = extract_from_sources(&sources, "backend", None).unwrap();
        let summary: Vec<(HttpMethod, &str, PrefixState, &str)> = eps
            .iter()
            .map(|e| (e.method, e.path_norm.as_str(), e.prefix_state, e.handler.as_str()))
            .collect();
        assert!(summary.contains(&(
            HttpMethod::Post,
            "/api/internal/invoices",
            PrefixState::Full,
            "create_agnostic_invoice_idempotent"
        )));
        assert!(summary.contains(&(
            HttpMethod::Get,
            "/api/v1/accountant/commerces/{}/sales",
            PrefixState::Resolved,
            "list_sales"
        )));
        assert!(summary.contains(&(
            HttpMethod::Get,
            "/api/v1/accountant/commerces/{}/settings",
            PrefixState::Resolved,
            "settings"
        )));
        assert!(summary.contains(&(
            HttpMethod::Put,
            "/api/v1/accountant/commerces/{}/settings",
            PrefixState::Resolved,
            "update_settings"
        )));
        assert!(!eps.iter().any(|e| e.path_norm.contains("only-in-tests")));
    }

    #[test]
    fn entry_nest_prefixes_propagate_to_module_files_and_local_var_nests() {
        let sources = vec![
            (
                "src/bin/api.rs".to_owned(),
                strip_cfg_test(
                    r#"
use ez_addon::modules::{billing, telemetry as telemetry_module};

fn app() -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/billing", billing::router())
        .nest("/telemetry", telemetry_module::router())
}
"#,
                ),
            ),
            (
                "src/modules/billing/router.rs".to_owned(),
                strip_cfg_test(
                    r#"
pub fn router() -> Router {
    let admin = Router::new().route("/api-keys", get(list_keys));
    let v1 = Router::new().nest("/admin", admin);
    Router::new().nest("/v1", v1)
}
"#,
                ),
            ),
            (
                "src/modules/telemetry/mod.rs".to_owned(),
                strip_cfg_test(
                    r#"
pub fn router() -> Router {
    Router::new().route("/v1/events", post(ingest))
}
"#,
                ),
            ),
        ];
        let eps = extract_from_sources(&sources, "", Some("src/bin/api.rs")).unwrap();
        let pairs: Vec<(HttpMethod, &str, PrefixState)> = eps
            .iter()
            .map(|e| (e.method, e.path_norm.as_str(), e.prefix_state))
            .collect();
        assert!(pairs.contains(&(HttpMethod::Get, "/health", PrefixState::Full)));
        assert!(pairs.contains(&(
            HttpMethod::Get,
            "/billing/v1/admin/api-keys",
            PrefixState::Resolved
        )));
        assert!(pairs.contains(&(
            HttpMethod::Post,
            "/telemetry/v1/events",
            PrefixState::Resolved
        )));
    }
}
