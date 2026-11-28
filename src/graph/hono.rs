use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::scan::{
    LineIndex, ROOT_SLASH, find_matching_delim, for_each_dot_call, is_ident_byte, is_test_file,
    is_ts_source, join_paths, normalize_path, parallel_map, qualify_under_root,
    read_files_parallel, read_ident, resolve_ts_relative_import, skip_angle_generics,
    skip_ascii_ws, sort_extracted_endpoints, split_top_level_args, split_ts_import_clause,
    ts_code_mask, under_root, unquote_ts_string,
};
use super::types::{ExtractedEndpoint, HttpMethod, PrefixState};

const DEFAULT_HANDLER: &str = "hono_handler";
const ROUTE_METHOD: &str = "route";
static BASE_PATH_BIND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:new\s+Hono(?:<[^>]*>)?\s*\(\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*basePath\s*\(\s*["'`]([^"'`]+)["'`]\s*\)"#,
    )
    .expect("valid basePath bind regex")
});
const HONO_FALLBACK_RECEIVERS: &[&str] = &["app", "router"];
const MAX_MOUNT_DEPTH: usize = 6;
const MAX_CHAIN_HOPS: usize = 16;

static IMPORT_STMT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?ms)\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$][A-Za-z0-9_$]*))\s+from\s+["']([^"']+)["']"#)
        .expect("valid ts import regex")
});

static NEW_HONO_VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*new\s+Hono\b")
        .expect("valid new Hono regex")
});

static FACTORY_VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(")
        .expect("valid factory var regex")
});

static RETURN_CALL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\breturn\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(").expect("valid return call regex")
});

static FUNCTION_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(")
        .expect("valid ts function decl regex")
});

static ARROW_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(")
        .expect("valid ts arrow decl regex")
});

static HONO_PARAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:Hono|App)\b").expect("valid hono param regex")
});

#[derive(Debug, Clone)]
struct ImportedSymbol {
    file: String,
    exported_name: String,
}

#[derive(Debug, Clone)]
struct TsFnSpan {
    name: String,
    params: String,
    body_open: usize,
    body_close: usize,
}

#[derive(Debug, Clone)]
struct RawHonoRoute {
    method: HttpMethod,
    path_raw: String,
    file: String,
    line: usize,
    handler: String,
}

#[derive(Debug, Clone)]
struct RawHonoMount {
    prefix: String,
    target_expr: String,
    enclosing_fn: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedHonoFile {
    rel: String,
    imports: HashMap<String, ImportedSymbol>,
    var_to_callee: HashMap<String, String>,
    fn_return_callee: HashMap<String, String>,
    routes_by_fn: HashMap<String, Vec<RawHonoRoute>>,
    file_level_routes: Vec<RawHonoRoute>,
    mounts: Vec<RawHonoMount>,
    helper_calls: Vec<(String, String)>,
}

struct MountCollector<'a> {
    by_file: &'a HashMap<String, ParsedHonoFile>,
    visited: HashSet<(String, String, String)>,
    mounted_targets: HashSet<(String, String)>,
    dep_files: HashSet<String>,
    endpoints: Vec<ExtractedEndpoint>,
}

pub fn extract_service_with_deps(
    repo_dir: &Path,
    service_root: &str,
    entry_rel: Option<&str>,
    tracked_files: &[String],
) -> Result<(Vec<ExtractedEndpoint>, HashSet<String>)> {
    let candidates: Vec<String> = tracked_files
        .iter()
        .filter(|rel| is_ts_source(rel) && under_root(rel, service_root) && !is_test_file(rel))
        .cloned()
        .collect();
    let sources = read_files_parallel(repo_dir, &candidates);
    Ok(extract_from_sources(&sources, service_root, entry_rel))
}

pub fn extract_from_sources(
    sources: &[(String, String)],
    service_root: &str,
    entry_rel: Option<&str>,
) -> (Vec<ExtractedEndpoint>, HashSet<String>) {
    let known_files: HashSet<String> = sources.iter().map(|(f, _)| f.clone()).collect();
    let parsed_list: Vec<ParsedHonoFile> = parallel_map(sources, |(rel, src)| {
        parse_hono_file(rel, src, &known_files)
    });
    let by_file: HashMap<String, ParsedHonoFile> = parsed_list
        .into_iter()
        .map(|p| (p.rel.clone(), p))
        .collect();

    let mut collector = MountCollector {
        by_file: &by_file,
        visited: HashSet::new(),
        mounted_targets: HashSet::new(),
        dep_files: HashSet::new(),
        endpoints: Vec::new(),
    };

    if let Some(entry_file) = resolve_entry_file(service_root, entry_rel, &by_file) {
        collector.dep_files.insert(entry_file.clone());
        collector.walk_file(&entry_file, None, ROOT_SLASH, 0);
    }

    collect_unmounted_partials(&by_file, &mut collector);
    dedup_and_sort_endpoints(&mut collector.endpoints);
    (collector.endpoints, collector.dep_files)
}

fn collect_unmounted_partials(
    by_file: &HashMap<String, ParsedHonoFile>,
    collector: &mut MountCollector<'_>,
) {
    for parsed in by_file.values() {
        let mut has_routes = false;
        for (fn_name, routes) in &parsed.routes_by_fn {
            if routes.is_empty() {
                continue;
            }
            has_routes = true;
            if !collector
                .mounted_targets
                .contains(&(parsed.rel.clone(), fn_name.clone()))
            {
                for r in routes {
                    push_endpoint(&mut collector.endpoints, r, "", PrefixState::Partial);
                }
            }
        }
        if !parsed.file_level_routes.is_empty() {
            has_routes = true;
            if !collector
                .mounted_targets
                .contains(&(parsed.rel.clone(), String::new()))
            {
                for r in &parsed.file_level_routes {
                    push_endpoint(&mut collector.endpoints, r, "", PrefixState::Partial);
                }
            }
        }
        if has_routes || !parsed.mounts.is_empty() {
            collector.dep_files.insert(parsed.rel.clone());
        }
    }
}

fn resolve_entry_file(
    service_root: &str,
    entry_rel: Option<&str>,
    by_file: &HashMap<String, ParsedHonoFile>,
) -> Option<String> {
    if let Some(entry) = entry_rel {
        let qualified = qualify_under_root(service_root, entry);
        if by_file.contains_key(&qualified) {
            return Some(qualified);
        }
    }
    by_file
        .values()
        .filter(|p| !p.mounts.is_empty())
        .max_by_key(|p| p.mounts.len())
        .map(|p| p.rel.clone())
}

impl MountCollector<'_> {
    fn walk_file(&mut self, file: &str, only_fn: Option<&str>, base_prefix: &str, depth: usize) {
        if depth > MAX_MOUNT_DEPTH {
            return;
        }
        let key = (
            file.to_owned(),
            only_fn.unwrap_or("").to_owned(),
            base_prefix.to_owned(),
        );
        if !self.visited.insert(key) {
            return;
        }
        let Some(parsed) = self.by_file.get(file) else {
            return;
        };
        self.dep_files.insert(file.to_owned());
        self.emit_own_routes(parsed, only_fn, base_prefix);
        self.walk_mounts(parsed, only_fn, base_prefix, depth);
        self.walk_helpers(parsed, only_fn, base_prefix, depth);
    }

    fn emit_own_routes(&mut self, parsed: &ParsedHonoFile, only_fn: Option<&str>, base_prefix: &str) {
        if let Some(fn_name) = only_fn {
            if let Some(routes) = parsed.routes_by_fn.get(fn_name) {
                self.mounted_targets
                    .insert((parsed.rel.clone(), fn_name.to_owned()));
                for r in routes {
                    push_endpoint(&mut self.endpoints, r, base_prefix, PrefixState::Resolved);
                }
            }
            return;
        }
        for (fn_name, routes) in &parsed.routes_by_fn {
            self.mounted_targets
                .insert((parsed.rel.clone(), fn_name.clone()));
            for r in routes {
                push_endpoint(&mut self.endpoints, r, base_prefix, PrefixState::Resolved);
            }
        }
        if !parsed.file_level_routes.is_empty() {
            self.mounted_targets
                .insert((parsed.rel.clone(), String::new()));
            for r in &parsed.file_level_routes {
                push_endpoint(&mut self.endpoints, r, base_prefix, PrefixState::Resolved);
            }
        }
    }

    fn walk_mounts(
        &mut self,
        parsed: &ParsedHonoFile,
        only_fn: Option<&str>,
        base_prefix: &str,
        depth: usize,
    ) {
        for mount in &parsed.mounts {
            if only_fn.is_some_and(|scope| mount.enclosing_fn.as_deref() != Some(scope)) {
                continue;
            }
            let next_prefix = join_paths(base_prefix, &mount.prefix);
            if let Some((target_file, target_fn)) =
                resolve_mount_target(parsed, &mount.target_expr, self.by_file)
            {
                self.walk_file(&target_file, Some(&target_fn), &next_prefix, depth + 1);
            }
        }
    }

    fn walk_helpers(
        &mut self,
        parsed: &ParsedHonoFile,
        only_fn: Option<&str>,
        base_prefix: &str,
        depth: usize,
    ) {
        for (callee, caller_fn) in &parsed.helper_calls {
            if only_fn.is_some_and(|scope| caller_fn != scope) {
                continue;
            }
            if let Some(imp) = parsed.imports.get(callee) {
                self.walk_file(&imp.file, Some(&imp.exported_name), base_prefix, depth + 1);
            } else if parsed.routes_by_fn.contains_key(callee) {
                self.walk_file(&parsed.rel, Some(callee), base_prefix, depth + 1);
            }
        }
    }
}

fn resolve_mount_target(
    parsed: &ParsedHonoFile,
    target_expr: &str,
    by_file: &HashMap<String, ParsedHonoFile>,
) -> Option<(String, String)> {
    let mut name = extract_target_symbol(target_expr)?;
    for _ in 0..4 {
        if let Some(imp) = parsed.imports.get(&name) {
            return Some((imp.file.clone(), imp.exported_name.clone()));
        }
        if parsed.routes_by_fn.contains_key(&name) {
            return Some((parsed.rel.clone(), name));
        }
        if let Some(callee) = parsed.var_to_callee.get(&name) {
            name = callee.clone();
            continue;
        }
        if let Some(callee) = parsed.fn_return_callee.get(&name) {
            name = callee.clone();
            continue;
        }
        break;
    }
    if let Some((obj, _)) = target_expr.trim().split_once('.')
        && let Some(callee) = parsed.var_to_callee.get(obj.trim())
        && let Some(imp) = parsed.imports.get(callee)
        && by_file.contains_key(&imp.file)
    {
        return Some((imp.file.clone(), imp.exported_name.clone()));
    }
    None
}

fn extract_target_symbol(expr: &str) -> Option<String> {
    let trimmed = expr.trim();
    let bytes = trimmed.as_bytes();
    let mut pos = 0usize;
    while pos < bytes.len() && is_ts_ident_byte(bytes[pos]) {
        pos += 1;
    }
    if pos == 0 {
        return None;
    }
    let rest = trimmed[pos..].trim_start();
    (rest.is_empty() || rest.starts_with('(')).then(|| trimmed[..pos].to_owned())
}

fn push_endpoint(
    out: &mut Vec<ExtractedEndpoint>,
    route: &RawHonoRoute,
    mount_prefix: &str,
    prefix_state: PrefixState,
) {
    let full_raw = if mount_prefix.is_empty() || mount_prefix == ROOT_SLASH {
        route.path_raw.clone()
    } else {
        join_paths(mount_prefix, &route.path_raw)
    };
    let path_norm = normalize_path(&full_raw);
    if path_norm.is_empty() {
        return;
    }
    let prefix_state = if full_raw.starts_with("/api/") {
        PrefixState::Full
    } else {
        prefix_state
    };
    let endpoint = ExtractedEndpoint {
        file: route.file.clone(),
        line: route.line,
        handler: route.handler.clone(),
        prefix_state,
        method: route.method,
        path_raw: full_raw,
        path_norm,
    };
    out.push(endpoint);
}

fn dedup_and_sort_endpoints(endpoints: &mut Vec<ExtractedEndpoint>) {
    sort_extracted_endpoints(endpoints);
    endpoints.dedup_by(|a, b| {
        a.file == b.file
            && a.line == b.line
            && a.method == b.method
            && a.path_norm == b.path_norm
            && a.prefix_state == b.prefix_state
    });
}

fn parse_hono_file(rel: &str, source: &str, known_files: &HashSet<String>) -> ParsedHonoFile {
    let mask = ts_code_mask(source);
    let lines = LineIndex::new(source);
    let imports = parse_imports(rel, source, &mask, known_files);
    let fns = find_ts_functions(source, &mask);
    let var_to_callee = parse_factory_var_bindings(source, &mask);
    let fn_return_callee = parse_fn_return_callees(source, &mask, &fns);
    let mut routes_by_fn: HashMap<String, Vec<RawHonoRoute>> = HashMap::new();
    let mut file_level_routes = Vec::new();
    let mut mounts = Vec::new();
    let mut helper_calls = Vec::new();

    let local_fn_names: HashSet<&str> = fns.iter().map(|f| f.name.as_str()).collect();
    for f in &fns {
        let mut hono_vars = find_hono_vars_in_span(source, &mask, f.body_open, f.body_close);
        for caps in HONO_PARAM_RE.captures_iter(&f.params) {
            hono_vars.insert(caps[1].to_owned());
        }
        let base_paths =
            find_hono_base_paths(source, &mask, f.body_open, f.body_close, &mut hono_vars);
        let mut routes = Vec::new();
        scan_hono_calls_in_span(
            rel,
            source,
            &mask,
            &lines,
            f.body_open,
            f.body_close,
            Some(&f.name),
            &hono_vars,
            &base_paths,
            &mut routes,
            &mut mounts,
        );
        if !routes.is_empty() {
            routes_by_fn.entry(f.name.clone()).or_default().extend(routes);
        }
        collect_mount_helper_calls(
            source,
            &mask,
            f.body_open,
            f.body_close,
            &f.name,
            &imports,
            &local_fn_names,
            &mut helper_calls,
        );
    }

    let mut top_hono_vars = find_top_level_hono_vars(source, &mask, &fns);
    if !top_hono_vars.is_empty() {
        let base_paths = find_hono_base_paths(source, &mask, 0, source.len(), &mut top_hono_vars);
        scan_top_level_hono_calls(
            rel,
            source,
            &mask,
            &lines,
            &fns,
            &top_hono_vars,
            &base_paths,
            &mut file_level_routes,
            &mut mounts,
        );
    }

    ParsedHonoFile {
        rel: rel.to_owned(),
        imports,
        var_to_callee,
        fn_return_callee,
        routes_by_fn,
        file_level_routes,
        mounts,
        helper_calls,
    }
}

fn parse_imports(
    rel: &str,
    source: &str,
    mask: &[bool],
    known_files: &HashSet<String>,
) -> HashMap<String, ImportedSymbol> {
    let mut map = HashMap::new();
    for caps in IMPORT_STMT_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if !mask[m0.start()] {
            continue;
        }
        let Some(target_file) = resolve_ts_relative_import(rel, &caps[3], known_files) else {
            continue;
        };
        if let Some(named) = caps.get(1) {
            for (orig, local) in split_ts_import_clause(named.as_str()) {
                map.insert(
                    local,
                    ImportedSymbol {
                        file: target_file.clone(),
                        exported_name: orig,
                    },
                );
            }
        } else if let Some(def) = caps.get(2) {
            map.insert(
                def.as_str().to_owned(),
                ImportedSymbol {
                    file: target_file,
                    exported_name: def.as_str().to_owned(),
                },
            );
        }
    }
    map
}

fn parse_factory_var_bindings(source: &str, mask: &[bool]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for caps in FACTORY_VAR_RE.captures_iter(source) {
        if mask[caps.get(0).unwrap().start()] {
            map.insert(caps[1].to_owned(), caps[2].to_owned());
        }
    }
    map
}

fn parse_fn_return_callees(
    source: &str,
    mask: &[bool],
    fns: &[TsFnSpan],
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for f in fns {
        let slice = &source[f.body_open..f.body_close];
        for caps in RETURN_CALL_RE.captures_iter(slice) {
            if mask[f.body_open + caps.get(0).unwrap().start()] {
                map.insert(f.name.clone(), caps[1].to_owned());
                break;
            }
        }
    }
    map
}

fn find_ts_functions(source: &str, mask: &[bool]) -> Vec<TsFnSpan> {
    let mut spans = Vec::new();
    let mut seen_opens = HashSet::new();
    collect_ts_fn_matches(source, mask, &FUNCTION_DECL_RE, find_fn_body_open, &mut seen_opens, &mut spans);
    collect_ts_fn_matches(source, mask, &ARROW_DECL_RE, find_arrow_body_open, &mut seen_opens, &mut spans);
    spans.sort_by_key(|s| s.body_open);
    spans
}

fn collect_ts_fn_matches(
    source: &str,
    mask: &[bool],
    re: &Regex,
    locate_body: fn(&[u8], &[bool], usize) -> Option<usize>,
    seen_opens: &mut HashSet<usize>,
    spans: &mut Vec<TsFnSpan>,
) {
    let bytes = source.as_bytes();
    for caps in re.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if !mask[m0.start()] {
            continue;
        }
        let open_paren = m0.end() - 1;
        let Some(close_paren) = find_matching_delim(bytes, mask, open_paren, b'(', b')') else {
            continue;
        };
        let Some(body_open) = locate_body(bytes, mask, close_paren + 1) else {
            continue;
        };
        let Some(body_close) = find_matching_delim(bytes, mask, body_open, b'{', b'}') else {
            continue;
        };
        if seen_opens.insert(body_open) {
            spans.push(TsFnSpan {
                name: caps[1].to_owned(),
                params: source[open_paren + 1..close_paren].to_owned(),
                body_open,
                body_close,
            });
        }
    }
}

fn find_fn_body_open(bytes: &[u8], mask: &[bool], start: usize) -> Option<usize> {
    let mut pos = start;
    let mut angle = 0usize;
    let mut paren = 0usize;
    let mut brace = 0usize;
    let mut in_return_type = false;
    while pos < bytes.len() {
        let b = bytes[pos];
        let at_top = mask[pos] && angle == 0 && paren == 0 && brace == 0;
        if at_top && b == b';' {
            return None;
        }
        if at_top && b == b':' {
            in_return_type = true;
            pos += 1;
            continue;
        }
        if at_top && b == b'{' {
            match skip_return_type_brace(bytes, mask, pos, in_return_type) {
                Some(after) => {
                    pos = after;
                    continue;
                }
                None => return Some(pos),
            }
        }
        if mask[pos] {
            adjust_delim_counts(b, &mut angle, &mut paren, &mut brace);
        }
        pos += 1;
    }
    None
}

fn adjust_delim_counts(byte: u8, angle: &mut usize, paren: &mut usize, brace: &mut usize) {
    if byte == b'<' {
        *angle += 1;
    } else if byte == b'>' {
        *angle = angle.saturating_sub(1);
    } else if byte == b'(' {
        *paren += 1;
    } else if byte == b')' {
        *paren = paren.saturating_sub(1);
    } else if byte == b'{' {
        *brace += 1;
    } else if byte == b'}' {
        *brace = brace.saturating_sub(1);
    }
}

fn skip_return_type_brace(
    bytes: &[u8],
    mask: &[bool],
    pos: usize,
    in_return_type: bool,
) -> Option<usize> {
    if !in_return_type {
        return None;
    }
    let end = find_matching_delim(bytes, mask, pos, b'{', b'}')?;
    let next = skip_ascii_ws(bytes, end + 1, bytes.len());
    let continues_type = matches!(
        bytes.get(next),
        Some(b'|' | b'&' | b'[' | b'>' | b',' | b'{')
    );
    continues_type.then_some(end + 1)
}

fn find_arrow_body_open(bytes: &[u8], mask: &[bool], start: usize) -> Option<usize> {
    let mut pos = start;
    while pos + 1 < bytes.len() {
        if !mask[pos] {
            pos += 1;
            continue;
        }
        if bytes[pos] == b';' {
            return None;
        }
        if bytes.get(pos..pos + 2) == Some(b"=>") {
            let after = skip_ascii_ws(bytes, pos + 2, bytes.len());
            return (bytes.get(after) == Some(&b'{') && mask[after]).then_some(after);
        }
        pos += 1;
    }
    None
}

fn find_hono_vars_in_span(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> HashSet<String> {
    let mut vars = HashSet::new();
    for caps in NEW_HONO_VAR_RE.captures_iter(&source[start..end]) {
        if mask[start + caps.get(0).unwrap().start()] {
            vars.insert(caps[1].to_owned());
        }
    }
    vars
}

fn find_top_level_hono_vars(source: &str, mask: &[bool], fns: &[TsFnSpan]) -> HashSet<String> {
    let mut vars = HashSet::new();
    for caps in NEW_HONO_VAR_RE.captures_iter(source) {
        let abs = caps.get(0).unwrap().start();
        if mask[abs] && !inside_any_fn(abs, fns) {
            vars.insert(caps[1].to_owned());
        }
    }
    vars
}

fn inside_any_fn(pos: usize, fns: &[TsFnSpan]) -> bool {
    fns.iter().any(|f| pos >= f.body_open && pos <= f.body_close)
}

fn find_hono_base_paths(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
    hono_vars: &mut HashSet<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for caps in BASE_PATH_BIND_RE.captures_iter(&source[start..end]) {
        let abs = start + caps.get(0).unwrap().start();
        if mask[abs] && caps[2].starts_with('/') {
            hono_vars.insert(caps[1].to_owned());
            out.insert(caps[1].to_owned(), caps[2].to_owned());
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn scan_hono_calls_in_span(
    rel: &str,
    source: &str,
    mask: &[bool],
    lines: &LineIndex,
    start: usize,
    end: usize,
    enclosing_fn: Option<&str>,
    hono_vars: &HashSet<String>,
    base_paths: &HashMap<String, String>,
    routes: &mut Vec<RawHonoRoute>,
    mounts: &mut Vec<RawHonoMount>,
) {
    for_each_dot_call(source, mask, start, end, |name, dot_pos, open, close| {
        if name == ROUTE_METHOD {
            record_hono_mount(
                source,
                mask,
                dot_pos,
                open,
                close,
                enclosing_fn,
                hono_vars,
                base_paths,
                mounts,
            );
        } else if let Some(method) = HttpMethod::parse_hono(name) {
            record_hono_route(
                rel,
                source,
                mask,
                lines,
                dot_pos,
                open,
                close,
                method,
                enclosing_fn,
                hono_vars,
                base_paths,
                routes,
            );
        }
        Some(open + 1)
    });
}

#[allow(clippy::too_many_arguments)]
fn record_hono_mount(
    source: &str,
    mask: &[bool],
    dot_pos: usize,
    open: usize,
    close: usize,
    enclosing_fn: Option<&str>,
    hono_vars: &HashSet<String>,
    base_paths: &HashMap<String, String>,
    mounts: &mut Vec<RawHonoMount>,
) {
    let args = split_top_level_args(source, mask, 0, open + 1, close);
    if args.len() < 2 {
        return;
    }
    let Some(prefix) = unquote_ts_string(args[0].1) else {
        return;
    };
    if !prefix.starts_with('/') {
        return;
    }
    let Some(recv) = chain_root_receiver(source, mask, dot_pos) else {
        return;
    };
    let is_hono = hono_vars.contains(&recv) || HONO_FALLBACK_RECEIVERS.contains(&recv.as_str());
    if !is_hono {
        return;
    }
    let full_prefix = base_paths
        .get(&recv)
        .map_or(prefix.clone(), |bp| join_paths(bp, &prefix));
    mounts.push(RawHonoMount {
        prefix: full_prefix,
        target_expr: args[1].1.to_owned(),
        enclosing_fn: enclosing_fn.map(str::to_owned),
    });
}

#[allow(clippy::too_many_arguments)]
fn record_hono_route(
    rel: &str,
    source: &str,
    mask: &[bool],
    lines: &LineIndex,
    dot_pos: usize,
    open: usize,
    close: usize,
    method: HttpMethod,
    enclosing_fn: Option<&str>,
    hono_vars: &HashSet<String>,
    base_paths: &HashMap<String, String>,
    routes: &mut Vec<RawHonoRoute>,
) {
    let Some(recv) = chain_root_receiver(source, mask, dot_pos) else {
        return;
    };
    if !hono_vars.contains(&recv) {
        return;
    }
    let args = split_top_level_args(source, mask, 0, open + 1, close);
    let Some(raw_path) = args.first().and_then(|(_, a)| unquote_ts_string(a)) else {
        return;
    };
    if !raw_path.starts_with('/') {
        return;
    }
    let path_raw = base_paths
        .get(&recv)
        .map_or(raw_path.clone(), |bp| join_paths(bp, &raw_path));
    routes.push(RawHonoRoute {
        method,
        path_raw,
        file: rel.to_owned(),
        line: lines.line_at(dot_pos),
        handler: extract_handler_name(&args, enclosing_fn),
    });
}

#[allow(clippy::too_many_arguments)]
fn scan_top_level_hono_calls(
    rel: &str,
    source: &str,
    mask: &[bool],
    lines: &LineIndex,
    fns: &[TsFnSpan],
    hono_vars: &HashSet<String>,
    base_paths: &HashMap<String, String>,
    routes: &mut Vec<RawHonoRoute>,
    mounts: &mut Vec<RawHonoMount>,
) {
    let bytes = source.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if inside_any_fn(i, fns) || !mask[i] || bytes[i] != b'.' {
            i += 1;
            continue;
        }
        let next_fn_start = fns
            .iter()
            .find(|f| f.body_open > i)
            .map_or(bytes.len(), |f| f.body_open);
        scan_hono_calls_in_span(
            rel,
            source,
            mask,
            lines,
            i,
            next_fn_start,
            None,
            hono_vars,
            base_paths,
            routes,
            mounts,
        );
        i = next_fn_start;
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_mount_helper_calls(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
    enclosing_fn: &str,
    imports: &HashMap<String, ImportedSymbol>,
    local_fn_names: &HashSet<&str>,
    out: &mut Vec<(String, String)>,
) {
    let bytes = source.as_bytes();
    let mut i = start;
    while i < end {
        if !mask[i] {
            i += 1;
            continue;
        }
        let Some((ident, next)) = read_ident(source, &bytes[..end], i) else {
            i += 1;
            continue;
        };
        let is_mount_import = ident.starts_with("mount") && imports.contains_key(ident);
        let is_local_helper = ident != enclosing_fn && local_fn_names.contains(ident);
        if is_mount_import || is_local_helper {
            let pos = advance_past_generics(bytes, mask, next, end);
            if bytes.get(pos) == Some(&b'(') && mask[pos] {
                out.push((ident.to_owned(), enclosing_fn.to_owned()));
            }
        }
        i = next;
    }
}

fn advance_past_generics(bytes: &[u8], mask: &[bool], start: usize, end: usize) -> usize {
    let pos = skip_ascii_ws(bytes, start, end);
    if bytes.get(pos) == Some(&b'<')
        && mask[pos]
        && let Some(after) = skip_angle_generics(bytes, mask, pos, end, true)
    {
        return skip_ascii_ws(bytes, after, end);
    }
    pos
}

fn extract_handler_name(args: &[(usize, &str)], enclosing_fn: Option<&str>) -> String {
    if let Some((_, last)) = args.last() {
        let trimmed = last.trim();
        if !trimmed.is_empty() && trimmed.bytes().all(is_ts_ident_byte) {
            return trimmed.to_owned();
        }
    }
    enclosing_fn.unwrap_or(DEFAULT_HANDLER).to_owned()
}

fn chain_root_receiver(source: &str, mask: &[bool], dot_pos: usize) -> Option<String> {
    let bytes = source.as_bytes();
    let mut pos = dot_pos;
    for _ in 0..MAX_CHAIN_HOPS {
        pos = skip_ws_back(bytes, pos);
        if pos == 0 {
            return None;
        }
        if bytes[pos - 1] == b')' && mask[pos - 1] {
            let open = find_matching_open_paren(bytes, mask, pos - 1)?;
            let ident_start = skip_ident_back(bytes, skip_ws_back(bytes, open));
            let before_ident = skip_ws_back(bytes, ident_start);
            if before_ident > 0 && bytes[before_ident - 1] == b'.' && mask[before_ident - 1] {
                pos = before_ident - 1;
                continue;
            }
            return None;
        }
        let start = skip_ident_back(bytes, pos);
        return (start < pos).then(|| source[start..pos].to_owned());
    }
    None
}

fn find_matching_open_paren(bytes: &[u8], mask: &[bool], close_pos: usize) -> Option<usize> {
    let mut depth = 0usize;
    for i in (0..=close_pos).rev() {
        if !mask[i] {
            continue;
        }
        match bytes[i] {
            b')' => depth += 1,
            b'(' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn skip_ws_back(bytes: &[u8], mut pos: usize) -> usize {
    while pos > 0 && bytes[pos - 1].is_ascii_whitespace() {
        pos -= 1;
    }
    pos
}

fn skip_ident_back(bytes: &[u8], mut pos: usize) -> usize {
    while pos > 0 && is_ts_ident_byte(bytes[pos - 1]) {
        pos -= 1;
    }
    pos
}

fn is_ts_ident_byte(b: u8) -> bool {
    is_ident_byte(b) || b == b'$'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_hono_factory_import_variable_mount_and_double_mount() {
        const FORBIDDEN_PATHS: &[&str] = &["/admin/revenue/events", "/v1/revenue/coverage"];
        let server_ts = r#"
import { Hono } from 'hono';
import { createRevenueIngestRoutes, createRevenueAdminRoutes } from './contexts/revenue/infrastructure/revenue.routes';
import { createMerchantPaymentRoutes } from './contexts/payment-processing/infrastructure/merchant-payments.routes';

export function buildApp() {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/v1', createRevenueIngestRoutes({ revenue }));
  app.route('/admin', createRevenueAdminRoutes({ revenue }));
  const merchantPaymentRoutes = createMerchantPaymentRoutes({ repo });
  app.route('/v1', merchantPaymentRoutes);
  app.route('/api/v1', merchantPaymentRoutes);
  return app;
}
"#;
        let revenue_ts = r#"
import { Hono } from 'hono';

export function createRevenueIngestRoutes(deps: any) {
  const router = new Hono();
  router.post('/revenue/events', (c) => {
    const p = c.get('product');
    return c.json({ p });
  });
  return router;
}

export function createRevenueAdminRoutes(deps: any) {
  const router = new Hono();
  router.get('/revenue/coverage', (c) => c.json({}));
  return router;
}
"#;
        let merchant_ts = r#"
import { Hono } from 'hono';

export function createMerchantPaymentRoutes(deps: any) {
  const router = new Hono();
  router.post('/merchant-payments/:id/confirm', confirmHandler);
  router.all('/merchant-payments/webhook', (c) => c.text('ok'));
  return router;
}
"#;
        let sources = vec![
            ("services/core/src/server.ts".to_owned(), server_ts.to_owned()),
            (
                "services/core/src/contexts/revenue/infrastructure/revenue.routes.ts".to_owned(),
                revenue_ts.to_owned(),
            ),
            (
                "services/core/src/contexts/payment-processing/infrastructure/merchant-payments.routes.ts"
                    .to_owned(),
                merchant_ts.to_owned(),
            ),
        ];
        let (endpoints, deps) =
            extract_from_sources(&sources, "services/core", Some("src/server.ts"));
        let pairs: Vec<(HttpMethod, &str, PrefixState)> = endpoints
            .iter()
            .map(|e| (e.method, e.path_norm.as_str(), e.prefix_state))
            .collect();
        assert!(pairs.contains(&(HttpMethod::Get, "/health", PrefixState::Resolved)));
        assert!(pairs.contains(&(HttpMethod::Post, "/v1/revenue/events", PrefixState::Resolved)));
        assert!(pairs.contains(&(HttpMethod::Get, "/admin/revenue/coverage", PrefixState::Resolved)));
        assert!(!pairs.iter().any(|(_, p, _)| FORBIDDEN_PATHS.contains(p)));
        assert!(pairs.contains(&(
            HttpMethod::Post,
            "/v1/merchant-payments/{}/confirm",
            PrefixState::Resolved
        )));
        assert!(pairs.contains(&(
            HttpMethod::Post,
            "/api/v1/merchant-payments/{}/confirm",
            PrefixState::Full
        )));
        assert!(pairs.contains(&(
            HttpMethod::Any,
            "/v1/merchant-payments/webhook",
            PrefixState::Resolved
        )));
        assert!(pairs.contains(&(
            HttpMethod::Any,
            "/api/v1/merchant-payments/webhook",
            PrefixState::Full
        )));
        assert!(!pairs.iter().any(|(_, p, _)| p.contains("product")));
        assert!(deps.contains("services/core/src/server.ts"));
    }
}
