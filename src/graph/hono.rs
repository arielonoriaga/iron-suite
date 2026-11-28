use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::scan::{
    LineIndex, ROOT_SLASH, RawTsRoute, TsImportedSymbol, chain_root_receiver,
    collect_local_path_consts, dedup_and_sort_endpoints, extract_ts_handler_name,
    find_matching_delim, find_semicolon_at_depth_zero, first_ts_route_path, for_each_dot_call,
    is_ts_ident_byte, join_paths, parse_ts_imports, parse_ts_source_map, push_ts_route,
    qualify_under_root, read_ident, read_ts_ident_prefix, read_ts_service_sources,
    skip_angle_generics, skip_ascii_ws, split_top_level_args, ts_code_mask, unquote_ts_string,
};
use super::types::{ExtractedEndpoint, HttpMethod, PrefixState};

const DEFAULT_HANDLER: &str = "hono_handler";
const ROUTE_METHOD: &str = "route";
const HONO_FALLBACK_RECEIVERS: &[&str] = &["app", "router"];
const MAX_MOUNT_DEPTH: usize = 8;
const MAX_EVAL_DEPTH: usize = 6;

static BASE_PATH_BIND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:new\s+Hono(?:<[^>]*>)?\s*\(\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*basePath\s*\(\s*["'`]([^"'`]+)["'`]\s*\)"#,
    )
    .expect("valid basePath bind regex")
});

static NEW_HONO_VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*new\s+Hono\b")
        .expect("valid new Hono regex")
});

static DECL_ASSIGN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*")
        .expect("valid ts decl assign regex")
});

static RETURN_KW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\breturn\s+").expect("valid return kw regex")
});

static FUNCTION_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(",
    )
    .expect("valid ts function decl regex")
});

static ARROW_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(",
    )
    .expect("valid ts arrow decl regex")
});

static HONO_TYPE_ALIAS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*Hono\b")
        .expect("valid hono type alias regex")
});

static HONO_PARAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\b")
        .expect("valid hono param regex")
});

#[derive(Debug, Clone)]
enum ValueExpr {
    Ident(String),
    Prop(String, String),
    Call(String, Vec<Option<ValueExpr>>),
    Object(Vec<(String, ValueExpr)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HonoValue {
    Router { file: String, fn_name: String },
    Bag(BTreeMap<String, HonoValue>),
}

impl HonoValue {
    fn fingerprint(&self) -> String {
        match self {
            Self::Router { file, fn_name } => format!("R:{file}:{fn_name}"),
            Self::Bag(map) => {
                let inner: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("{k}={}", v.fingerprint()))
                    .collect();
                format!("B:{{{}}}", inner.join(","))
            }
        }
    }
}

type HonoEnv = BTreeMap<String, HonoValue>;

#[derive(Debug, Clone)]
struct TsFnSpan {
    name: String,
    params: String,
    param_names: Vec<String>,
    body_open: usize,
    body_close: usize,
}

#[derive(Debug, Clone)]
struct RawHonoMount {
    prefix: String,
    target_expr: Option<ValueExpr>,
    enclosing_fn: Option<String>,
}

#[derive(Debug, Clone)]
struct RawHelperCall {
    callee: String,
    caller_fn: String,
    args: Vec<Option<ValueExpr>>,
}

#[derive(Debug, Clone)]
struct ParsedHonoFile {
    rel: String,
    imports: HashMap<String, TsImportedSymbol>,
    fn_params: HashMap<String, Vec<String>>,
    local_exprs_by_fn: HashMap<String, Vec<(String, ValueExpr)>>,
    fn_return: HashMap<String, ValueExpr>,
    routes_by_fn: HashMap<String, Vec<RawTsRoute>>,
    file_level_routes: Vec<RawTsRoute>,
    mounts: Vec<RawHonoMount>,
    helper_calls: Vec<RawHelperCall>,
}

struct MountCollector<'a> {
    by_file: &'a HashMap<String, ParsedHonoFile>,
    visited: HashSet<(String, String, String, String)>,
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
    let sources = read_ts_service_sources(repo_dir, service_root, tracked_files);
    Ok(extract_from_sources(&sources, service_root, entry_rel))
}

pub fn extract_from_sources(
    sources: &[(String, String)],
    service_root: &str,
    entry_rel: Option<&str>,
) -> (Vec<ExtractedEndpoint>, HashSet<String>) {
    let by_file = parse_ts_source_map(sources, parse_hono_file, |p| p.rel.clone());

    let mut collector = MountCollector {
        by_file: &by_file,
        visited: HashSet::new(),
        mounted_targets: HashSet::new(),
        dep_files: HashSet::new(),
        endpoints: Vec::new(),
    };

    if let Some(entry_file) = resolve_entry_file(service_root, entry_rel, &by_file) {
        collector.dep_files.insert(entry_file.clone());
        let empty_env = HonoEnv::new();
        collector.walk_file(&entry_file, None, ROOT_SLASH, &empty_env, 0);
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
                    push_ts_route(&mut collector.endpoints, r, "", PrefixState::Partial, true);
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
                    push_ts_route(&mut collector.endpoints, r, "", PrefixState::Partial, true);
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
        .max_by(|a, b| a.mounts.len().cmp(&b.mounts.len()).then_with(|| b.rel.cmp(&a.rel)))
        .map(|p| p.rel.clone())
}

fn env_fingerprint(env: &HonoEnv) -> String {
    env.iter()
        .map(|(k, v)| format!("{k}={}", v.fingerprint()))
        .collect::<Vec<_>>()
        .join(";")
}

impl MountCollector<'_> {
    fn walk_file(
        &mut self,
        file: &str,
        only_fn: Option<&str>,
        base_prefix: &str,
        env: &HonoEnv,
        depth: usize,
    ) {
        if depth > MAX_MOUNT_DEPTH {
            return;
        }
        let key = (
            file.to_owned(),
            only_fn.unwrap_or("").to_owned(),
            base_prefix.to_owned(),
            env_fingerprint(env),
        );
        if !self.visited.insert(key) {
            return;
        }
        let Some(parsed) = self.by_file.get(file) else {
            return;
        };
        self.dep_files.insert(file.to_owned());
        self.emit_own_routes(parsed, only_fn, base_prefix);

        let local_env = self.build_scope_env(parsed, only_fn, env, 0);
        let frame = WalkFrame {
            parsed,
            only_fn,
            base_prefix,
            local_env: &local_env,
            depth,
        };
        self.walk_mounts(&frame);
        self.walk_helpers(&frame);
    }

    fn build_scope_env(
        &self,
        parsed: &ParsedHonoFile,
        only_fn: Option<&str>,
        incoming: &HonoEnv,
        eval_depth: usize,
    ) -> HonoEnv {
        let mut env = incoming.clone();
        if let Some(top_exprs) = parsed.local_exprs_by_fn.get("") {
            self.eval_local_exprs(parsed, top_exprs, &mut env, eval_depth);
        }
        if let Some(fn_name) = only_fn.filter(|s| !s.is_empty())
            && let Some(fn_exprs) = parsed.local_exprs_by_fn.get(fn_name)
        {
            self.eval_local_exprs(parsed, fn_exprs, &mut env, eval_depth);
        }
        env
    }

    fn scope_env_for<'a>(
        &self,
        frame: &'a WalkFrame<'a>,
        enclosing_fn: Option<&str>,
    ) -> Cow<'a, HonoEnv> {
        if frame.only_fn.is_some() {
            return Cow::Borrowed(frame.local_env);
        }
        match enclosing_fn.filter(|s| !s.is_empty()) {
            Some(name) => Cow::Owned(self.build_scope_env(frame.parsed, Some(name), frame.local_env, 0)),
            None => Cow::Borrowed(frame.local_env),
        }
    }

    fn eval_local_exprs(
        &self,
        parsed: &ParsedHonoFile,
        exprs: &[(String, ValueExpr)],
        env: &mut HonoEnv,
        eval_depth: usize,
    ) {
        for (name, expr) in exprs {
            if let Some(val) = self.eval_expr(parsed, expr, env, eval_depth) {
                env.insert(name.clone(), val);
            }
        }
    }

    fn eval_expr(
        &self,
        parsed: &ParsedHonoFile,
        expr: &ValueExpr,
        env: &HonoEnv,
        eval_depth: usize,
    ) -> Option<HonoValue> {
        if eval_depth > MAX_EVAL_DEPTH {
            return None;
        }
        match expr {
            ValueExpr::Ident(name) => self.eval_ident(parsed, name, env),
            ValueExpr::Prop(obj, prop) => match env.get(obj) {
                Some(HonoValue::Bag(map)) => map.get(prop).cloned(),
                _ => None,
            },
            ValueExpr::Object(entries) => self.eval_object(parsed, entries, env, eval_depth),
            ValueExpr::Call(callee, args) => self.eval_call(parsed, callee, args, env, eval_depth),
        }
    }

    fn eval_ident(&self, parsed: &ParsedHonoFile, name: &str, env: &HonoEnv) -> Option<HonoValue> {
        if let Some(v) = env.get(name) {
            return Some(v.clone());
        }
        if let Some(imp) = parsed.imports.get(name) {
            return Some(HonoValue::Router {
                file: imp.file.clone(),
                fn_name: imp.exported_name.clone(),
            });
        }
        parsed
            .routes_by_fn
            .contains_key(name)
            .then(|| HonoValue::Router {
                file: parsed.rel.clone(),
                fn_name: name.to_owned(),
            })
    }

    fn eval_object(
        &self,
        parsed: &ParsedHonoFile,
        entries: &[(String, ValueExpr)],
        env: &HonoEnv,
        eval_depth: usize,
    ) -> Option<HonoValue> {
        let mut bag = BTreeMap::new();
        for (k, v_expr) in entries {
            if let Some(v) = self.eval_expr(parsed, v_expr, env, eval_depth + 1) {
                bag.insert(k.clone(), v);
            }
        }
        (!bag.is_empty()).then_some(HonoValue::Bag(bag))
    }

    fn eval_call(
        &self,
        parsed: &ParsedHonoFile,
        callee: &str,
        args: &[Option<ValueExpr>],
        env: &HonoEnv,
        eval_depth: usize,
    ) -> Option<HonoValue> {
        let (target_file, target_fn) = self.resolve_callee(parsed, callee)?;
        let target_parsed = self.by_file.get(&target_file)?;
        let child_env =
            self.bind_call_args(parsed, target_parsed, &target_fn, args, env, eval_depth);
        let has_own = fn_has_own_routes_or_mounts(target_parsed, &target_fn);
        if let Some(ret_expr) = target_parsed.fn_return.get(&target_fn) {
            let ret_scope =
                self.build_scope_env(target_parsed, Some(&target_fn), &child_env, eval_depth + 1);
            if let Some(ret_val) =
                self.eval_expr(target_parsed, ret_expr, &ret_scope, eval_depth + 1)
                && (!has_own || matches!(ret_val, HonoValue::Bag(_)))
            {
                return Some(ret_val);
            }
        }
        Some(HonoValue::Router {
            file: target_file,
            fn_name: target_fn,
        })
    }

    fn resolve_callee(&self, parsed: &ParsedHonoFile, callee: &str) -> Option<(String, String)> {
        if let Some(imp) = parsed.imports.get(callee) {
            return Some((imp.file.clone(), imp.exported_name.clone()));
        }
        if parsed.fn_params.contains_key(callee) || parsed.routes_by_fn.contains_key(callee) {
            return Some((parsed.rel.clone(), callee.to_owned()));
        }
        None
    }

    fn bind_call_args(
        &self,
        caller: &ParsedHonoFile,
        callee: &ParsedHonoFile,
        callee_fn: &str,
        args: &[Option<ValueExpr>],
        caller_env: &HonoEnv,
        eval_depth: usize,
    ) -> HonoEnv {
        let mut child_env = HonoEnv::new();
        let Some(param_names) = callee.fn_params.get(callee_fn) else {
            return child_env;
        };
        for (pname, arg_opt) in param_names.iter().zip(args.iter()) {
            if let Some(arg_expr) = arg_opt
                && let Some(val) = self.eval_expr(caller, arg_expr, caller_env, eval_depth + 1)
            {
                child_env.insert(pname.clone(), val);
            }
        }
        child_env
    }

    fn emit_own_routes(&mut self, parsed: &ParsedHonoFile, only_fn: Option<&str>, base_prefix: &str) {
        if let Some(fn_name) = only_fn {
            if let Some(routes) = parsed.routes_by_fn.get(fn_name) {
                self.mounted_targets
                    .insert((parsed.rel.clone(), fn_name.to_owned()));
                for r in routes {
                    push_ts_route(&mut self.endpoints, r, base_prefix, PrefixState::Resolved, true);
                }
            }
            return;
        }
        for (fn_name, routes) in &parsed.routes_by_fn {
            self.mounted_targets
                .insert((parsed.rel.clone(), fn_name.clone()));
            for r in routes {
                push_ts_route(&mut self.endpoints, r, base_prefix, PrefixState::Resolved, true);
            }
        }
        if !parsed.file_level_routes.is_empty() {
            self.mounted_targets
                .insert((parsed.rel.clone(), String::new()));
            for r in &parsed.file_level_routes {
                push_ts_route(&mut self.endpoints, r, base_prefix, PrefixState::Resolved, true);
            }
        }
    }

    fn walk_mounts(&mut self, frame: &WalkFrame<'_>) {
        for mount in &frame.parsed.mounts {
            if frame.only_fn.is_some_and(|scope| mount.enclosing_fn.as_deref() != Some(scope)) {
                continue;
            }
            let Some(ref target_expr) = mount.target_expr else {
                continue;
            };
            let mount_env = self.scope_env_for(frame, mount.enclosing_fn.as_deref());
            let next_prefix = join_paths(frame.base_prefix, &mount.prefix);
            if let ValueExpr::Call(callee, args) = target_expr
                && self.walk_call_mount(
                    frame.parsed,
                    callee,
                    args,
                    &next_prefix,
                    mount_env.as_ref(),
                    frame.depth,
                )
            {
                continue;
            }
            if let Some(HonoValue::Router { file, fn_name }) =
                self.eval_expr(frame.parsed, target_expr, mount_env.as_ref(), 0)
            {
                self.walk_file(
                    &file,
                    Some(&fn_name),
                    &next_prefix,
                    &HonoEnv::new(),
                    frame.depth + 1,
                );
            }
        }
    }

    fn walk_call_mount(
        &mut self,
        parsed: &ParsedHonoFile,
        callee: &str,
        args: &[Option<ValueExpr>],
        next_prefix: &str,
        local_env: &HonoEnv,
        depth: usize,
    ) -> bool {
        let Some((target_file, target_fn)) = self.resolve_callee(parsed, callee) else {
            return false;
        };
        let Some(target_parsed) = self.by_file.get(&target_file) else {
            return false;
        };
        let child_env =
            self.bind_call_args(parsed, target_parsed, &target_fn, args, local_env, 0);
        if !fn_has_own_routes_or_mounts(target_parsed, &target_fn)
            && let Some(ret_expr) = target_parsed.fn_return.get(&target_fn)
        {
            let ret_scope =
                self.build_scope_env(target_parsed, Some(&target_fn), &child_env, 1);
            if let Some(HonoValue::Router { file, fn_name }) =
                self.eval_expr(target_parsed, ret_expr, &ret_scope, 1)
            {
                self.dep_files.insert(target_file);
                self.walk_file(&file, Some(&fn_name), next_prefix, &HonoEnv::new(), depth + 1);
                return true;
            }
        }
        self.walk_file(&target_file, Some(&target_fn), next_prefix, &child_env, depth + 1);
        true
    }

    fn walk_helpers(&mut self, frame: &WalkFrame<'_>) {
        for helper in &frame.parsed.helper_calls {
            if frame.only_fn.is_some_and(|scope| helper.caller_fn != scope) {
                continue;
            }
            let Some((target_file, target_fn)) = self.resolve_callee(frame.parsed, &helper.callee)
            else {
                continue;
            };
            let Some(target_parsed) = self.by_file.get(&target_file) else {
                continue;
            };
            let caller_env = self.scope_env_for(frame, Some(helper.caller_fn.as_str()));
            let child_env = self.bind_call_args(
                frame.parsed,
                target_parsed,
                &target_fn,
                &helper.args,
                caller_env.as_ref(),
                0,
            );
            self.walk_file(
                &target_file,
                Some(&target_fn),
                frame.base_prefix,
                &child_env,
                frame.depth + 1,
            );
        }
    }
}

struct WalkFrame<'a> {
    parsed: &'a ParsedHonoFile,
    only_fn: Option<&'a str>,
    base_prefix: &'a str,
    local_env: &'a HonoEnv,
    depth: usize,
}

fn fn_has_own_routes_or_mounts(parsed: &ParsedHonoFile, fn_name: &str) -> bool {
    parsed.routes_by_fn.contains_key(fn_name)
        || parsed
            .mounts
            .iter()
            .any(|m| m.enclosing_fn.as_deref() == Some(fn_name))
}

fn parse_hono_file(rel: &str, source: &str, known_files: &HashSet<String>) -> ParsedHonoFile {
    let mask = ts_code_mask(source);
    let lines = LineIndex::new(source);
    let imports = parse_ts_imports(rel, source, &mask, known_files);
    let local_paths = collect_local_path_consts(source, &mask);
    let fns = find_ts_functions(source, &mask);
    let mut hono_type_names: HashSet<String> = ["Hono", "App"].into_iter().map(str::to_owned).collect();
    for caps in HONO_TYPE_ALIAS_RE.captures_iter(source) {
        if mask[caps.get(0).unwrap().start()] {
            hono_type_names.insert(caps[1].to_owned());
        }
    }
    let mut fn_params = HashMap::new();
    let mut local_exprs_by_fn: HashMap<String, Vec<(String, ValueExpr)>> = HashMap::new();
    let mut fn_return = HashMap::new();
    let mut routes_by_fn: HashMap<String, Vec<RawTsRoute>> = HashMap::new();
    let mut file_level_routes = Vec::new();
    let mut mounts = Vec::new();
    let mut helper_calls = Vec::new();

    let local_fn_names: HashSet<&str> = fns.iter().map(|f| f.name.as_str()).collect();
    for f in &fns {
        fn_params.insert(f.name.clone(), f.param_names.clone());
        let exprs = parse_local_value_exprs(source, &mask, f.body_open + 1, f.body_close);
        if !exprs.is_empty() {
            local_exprs_by_fn.insert(f.name.clone(), exprs);
        }
        if let Some(ret) = parse_fn_return_expr(source, &mask, f.body_open + 1, f.body_close) {
            fn_return.insert(f.name.clone(), ret);
        }
        let mut hono_vars = find_hono_vars_in_span(source, &mask, f.body_open, f.body_close);
        for caps in HONO_PARAM_RE.captures_iter(&f.params) {
            if hono_type_names.contains(&caps[2]) {
                hono_vars.insert(caps[1].to_owned());
            }
        }
        let base_paths =
            find_hono_base_paths(source, &mask, f.body_open, f.body_close, &mut hono_vars);
        let mut routes = Vec::new();
        let fn_ctx = HonoScanCtx {
            rel,
            source,
            mask: &mask,
            lines: &lines,
            enclosing_fn: Some(&f.name),
            hono_vars: &hono_vars,
            base_paths: &base_paths,
            local_paths: &local_paths,
        };
        scan_hono_calls_in_span(&fn_ctx, f.body_open, f.body_close, &mut routes, &mut mounts);
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

    let top_exprs = parse_top_level_value_exprs(source, &mask, &fns);
    if !top_exprs.is_empty() {
        local_exprs_by_fn.insert(String::new(), top_exprs);
    }

    let mut top_hono_vars = find_top_level_hono_vars(source, &mask, &fns);
    if !top_hono_vars.is_empty() {
        let base_paths = find_hono_base_paths(source, &mask, 0, source.len(), &mut top_hono_vars);
        let top_ctx = HonoScanCtx {
            rel,
            source,
            mask: &mask,
            lines: &lines,
            enclosing_fn: None,
            hono_vars: &top_hono_vars,
            base_paths: &base_paths,
            local_paths: &local_paths,
        };
        scan_top_level_hono_calls(&top_ctx, &fns, &mut file_level_routes, &mut mounts);
    }

    ParsedHonoFile {
        rel: rel.to_owned(),
        imports,
        fn_params,
        local_exprs_by_fn,
        fn_return,
        routes_by_fn,
        file_level_routes,
        mounts,
        helper_calls,
    }
}

fn parse_top_level_value_exprs(
    source: &str,
    mask: &[bool],
    fns: &[TsFnSpan],
) -> Vec<(String, ValueExpr)> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    for caps in DECL_ASSIGN_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if !mask[m0.start()] || inside_any_fn(m0.start(), fns) {
            continue;
        }
        let rhs_end = find_semicolon_at_depth_zero(bytes, mask, m0.end(), source.len());
        record_decl_binding(&caps[1], source[m0.end()..rhs_end].trim(), &mut out);
    }
    out
}

fn parse_local_value_exprs(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> Vec<(String, ValueExpr)> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    for caps in DECL_ASSIGN_RE.captures_iter(&source[start..end]) {
        let m0 = caps.get(0).unwrap();
        let abs_start = start + m0.start();
        let abs_end = start + m0.end();
        if !mask[abs_start] {
            continue;
        }
        let rhs_end = find_semicolon_at_depth_zero(bytes, mask, abs_end, end);
        record_decl_binding(&caps[1], source[abs_end..rhs_end].trim(), &mut out);
    }
    out
}

fn record_decl_binding(lhs: &str, rhs_raw: &str, out: &mut Vec<(String, ValueExpr)>) {
    let Some(rhs_expr) = parse_value_expr(rhs_raw) else {
        return;
    };
    let lhs_trimmed = lhs.trim();
    if let Some(inner) = lhs_trimmed.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        let obj_ident = match &rhs_expr {
            ValueExpr::Ident(id) => id.clone(),
            _ => {
                let tmp = format!("__destr_{}", out.len());
                out.push((tmp.clone(), rhs_expr));
                tmp
            }
        };
        for item in inner.split(',') {
            let clean = item.trim();
            if clean.is_empty() || clean.starts_with("...") {
                continue;
            }
            let (prop, local) = match clean.split_once(':') {
                Some((p, l)) => (
                    p.trim(),
                    l.split('=').next().unwrap_or(l).trim(),
                ),
                None => {
                    let p = clean.split('=').next().unwrap_or(clean).trim();
                    (p, p)
                }
            };
            if !prop.is_empty()
                && !local.is_empty()
                && prop.bytes().all(is_ts_ident_byte)
                && local.bytes().all(is_ts_ident_byte)
            {
                out.push((local.to_owned(), ValueExpr::Prop(obj_ident.clone(), prop.to_owned())));
            }
        }
    } else if !lhs_trimmed.is_empty() && lhs_trimmed.bytes().all(is_ts_ident_byte) {
        out.push((lhs_trimmed.to_owned(), rhs_expr));
    }
}

fn parse_fn_return_expr(
    source: &str,
    mask: &[bool],
    start: usize,
    end: usize,
) -> Option<ValueExpr> {
    let bytes = source.as_bytes();
    let mut best = None;
    for m in RETURN_KW_RE.find_iter(&source[start..end]) {
        let abs_start = start + m.start();
        if !mask[abs_start] || brace_depth_between(bytes, mask, start, abs_start) != 0 {
            continue;
        }
        let abs_rhs = start + m.end();
        let rhs_end = find_semicolon_at_depth_zero(bytes, mask, abs_rhs, end);
        if let Some(expr) = parse_value_expr(source[abs_rhs..rhs_end].trim()) {
            best = Some(expr);
        }
    }
    best
}

fn brace_depth_between(bytes: &[u8], mask: &[bool], start: usize, end: usize) -> usize {
    let mut depth = 0usize;
    for i in start..end {
        if !mask[i] {
            continue;
        }
        if bytes[i] == b'{' {
            depth += 1;
        } else if bytes[i] == b'}' {
            depth = depth.saturating_sub(1);
        }
    }
    depth
}

fn parse_value_expr(raw: &str) -> Option<ValueExpr> {
    let trimmed = raw.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.as_bytes()[0] == b'{' {
        return parse_object_value_expr(trimmed);
    }
    parse_ident_or_call_expr(trimmed)
}

fn parse_object_value_expr(trimmed: &str) -> Option<ValueExpr> {
    let mask = ts_code_mask(trimmed);
    let close = find_matching_delim(trimmed.as_bytes(), &mask, 0, b'{', b'}')?;
    let mut entries = Vec::new();
    for (_, item) in split_top_level_args(trimmed, &mask, 0, 1, close) {
        let t = item.trim();
        if t.is_empty() || t.starts_with("...") {
            continue;
        }
        if let Some((key, val_str)) = split_ts_prop(t) {
            if let Some(val_expr) = parse_value_expr(val_str) {
                entries.push((key, val_expr));
            }
        } else if t.bytes().all(is_ts_ident_byte) {
            entries.push((t.to_owned(), ValueExpr::Ident(t.to_owned())));
        }
    }
    (!entries.is_empty()).then_some(ValueExpr::Object(entries))
}

fn parse_ident_or_call_expr(trimmed: &str) -> Option<ValueExpr> {
    let (head, rest_raw) = read_ts_ident_prefix(trimmed)?;
    if matches!(head, "new" | "async" | "function" | "class" | "await") {
        return None;
    }
    let rest = rest_raw.trim_start();
    if rest.is_empty() {
        return Some(ValueExpr::Ident(head.to_owned()));
    }
    if let Some(after_dot) = rest.strip_prefix('.') {
        let (prop, tail) = read_ts_ident_prefix(after_dot)?;
        return tail
            .trim()
            .is_empty()
            .then(|| ValueExpr::Prop(head.to_owned(), prop.to_owned()));
    }
    if rest.starts_with('(') || rest.starts_with('<') {
        return parse_call_suffix(trimmed, trimmed.as_bytes(), head, head.len());
    }
    None
}

fn parse_call_suffix(trimmed: &str, bytes: &[u8], head: &str, pos: usize) -> Option<ValueExpr> {
    let mask = ts_code_mask(trimmed);
    let open = advance_past_generics(bytes, &mask, pos, bytes.len());
    if bytes.get(open) != Some(&b'(') || !mask[open] {
        return None;
    }
    let close = find_matching_delim(bytes, &mask, open, b'(', b')')?;
    let args: Vec<Option<ValueExpr>> = split_top_level_args(trimmed, &mask, 0, open + 1, close)
        .into_iter()
        .map(|(_, a)| parse_value_expr(a))
        .collect();
    Some(ValueExpr::Call(head.to_owned(), args))
}

fn split_ts_prop(item: &str) -> Option<(String, &str)> {
    let (key, after) = read_ts_ident_prefix(item)?;
    let val = after.trim_start().strip_prefix(':')?.trim();
    Some((key.to_owned(), val))
}

fn find_ts_functions(source: &str, mask: &[bool]) -> Vec<TsFnSpan> {
    let mut spans = Vec::new();
    let mut seen_opens = HashSet::new();
    collect_ts_fn_matches(
        source,
        mask,
        &FUNCTION_DECL_RE,
        find_fn_body_open,
        &mut seen_opens,
        &mut spans,
    );
    collect_ts_fn_matches(
        source,
        mask,
        &ARROW_DECL_RE,
        find_arrow_body_open,
        &mut seen_opens,
        &mut spans,
    );
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
            let params_raw = &source[open_paren + 1..close_paren];
            let param_names = parse_ts_param_names(source, mask, open_paren + 1, close_paren);
            spans.push(TsFnSpan {
                name: caps[1].to_owned(),
                params: params_raw.to_owned(),
                param_names,
                body_open,
                body_close,
            });
        }
    }
}

fn parse_ts_param_names(source: &str, mask: &[bool], start: usize, end: usize) -> Vec<String> {
    split_top_level_args(source, mask, 0, start, end)
        .into_iter()
        .map(|(_, arg)| {
            let trimmed = arg.trim().trim_start_matches("...");
            read_ts_ident_prefix(trimmed)
                .map_or_else(String::new, |(id, _)| id.to_owned())
        })
        .collect()
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

struct HonoScanCtx<'a> {
    rel: &'a str,
    source: &'a str,
    mask: &'a [bool],
    lines: &'a LineIndex,
    enclosing_fn: Option<&'a str>,
    hono_vars: &'a HashSet<String>,
    base_paths: &'a HashMap<String, String>,
    local_paths: &'a HashMap<String, String>,
}

fn scan_hono_calls_in_span(
    ctx: &HonoScanCtx<'_>,
    start: usize,
    end: usize,
    routes: &mut Vec<RawTsRoute>,
    mounts: &mut Vec<RawHonoMount>,
) {
    for_each_dot_call(ctx.source, ctx.mask, start, end, |name, dot_pos, open, close| {
        if name == ROUTE_METHOD {
            record_hono_mount(ctx, dot_pos, open, close, mounts);
        } else if let Some(method) = HttpMethod::parse_hono(name) {
            record_hono_route(ctx, dot_pos, open, close, method, routes);
        }
        Some(open + 1)
    });
}

fn record_hono_mount(
    ctx: &HonoScanCtx<'_>,
    dot_pos: usize,
    open: usize,
    close: usize,
    mounts: &mut Vec<RawHonoMount>,
) {
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open + 1, close);
    if args.len() < 2 {
        return;
    }
    let Some(prefix) = unquote_ts_string(args[0].1) else {
        return;
    };
    if !prefix.starts_with('/') {
        return;
    }
    let Some(recv) = chain_root_receiver(ctx.source, ctx.mask, dot_pos) else {
        return;
    };
    let is_hono = ctx.hono_vars.contains(&recv) || HONO_FALLBACK_RECEIVERS.contains(&recv.as_str());
    if !is_hono {
        return;
    }
    let full_prefix = ctx
        .base_paths
        .get(&recv)
        .map_or(prefix.clone(), |bp| join_paths(bp, &prefix));
    mounts.push(RawHonoMount {
        prefix: full_prefix,
        target_expr: parse_value_expr(args[1].1),
        enclosing_fn: ctx.enclosing_fn.map(str::to_owned),
    });
}

fn record_hono_route(
    ctx: &HonoScanCtx<'_>,
    dot_pos: usize,
    open: usize,
    close: usize,
    method: HttpMethod,
    routes: &mut Vec<RawTsRoute>,
) {
    let Some(recv) = chain_root_receiver(ctx.source, ctx.mask, dot_pos) else {
        return;
    };
    if !ctx.hono_vars.contains(&recv) {
        return;
    }
    let args = split_top_level_args(ctx.source, ctx.mask, 0, open + 1, close);
    let Some(raw_path) = first_ts_route_path(&args, ctx.local_paths) else {
        return;
    };
    let path_raw = ctx
        .base_paths
        .get(&recv)
        .map_or(raw_path.clone(), |bp| join_paths(bp, &raw_path));
    routes.push(RawTsRoute {
        method,
        path_raw,
        file: ctx.rel.to_owned(),
        line: ctx.lines.line_at(dot_pos),
        handler: extract_ts_handler_name(&args, ctx.enclosing_fn.unwrap_or(DEFAULT_HANDLER)),
        is_root_app: false,
    });
}

fn scan_top_level_hono_calls(
    ctx: &HonoScanCtx<'_>,
    fns: &[TsFnSpan],
    routes: &mut Vec<RawTsRoute>,
    mounts: &mut Vec<RawHonoMount>,
) {
    let bytes = ctx.source.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if inside_any_fn(i, fns) || !ctx.mask[i] || bytes[i] != b'.' {
            i += 1;
            continue;
        }
        let next_fn_start = fns
            .iter()
            .find(|f| f.body_open > i)
            .map_or(bytes.len(), |f| f.body_open);
        scan_hono_calls_in_span(ctx, i, next_fn_start, routes, mounts);
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
    imports: &HashMap<String, TsImportedSymbol>,
    local_fn_names: &HashSet<&str>,
    out: &mut Vec<RawHelperCall>,
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
            if bytes.get(pos) == Some(&b'(')
                && mask[pos]
                && let Some(close) = find_matching_delim(bytes, mask, pos, b'(', b')')
            {
                let args = split_top_level_args(source, mask, 0, pos + 1, close)
                    .into_iter()
                    .map(|(_, a)| parse_value_expr(a))
                    .collect();
                out.push(RawHelperCall {
                    callee: ident.to_owned(),
                    caller_fn: enclosing_fn.to_owned(),
                    args,
                });
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

    #[test]
    fn resolves_di_injected_hono_routers_and_module_object_bags() {
        let server_ts = r#"
import { Hono } from 'hono';
import { createAdminRoutes } from './admin.routes';
import { createAdminAIRoutes } from './ai.routes';
import { createFinanceRoutes } from './finance.routes';
import { createSupportModule } from './support.module';

export function createApp() {
  const aiAdminRouter = buildAdminAi();
  const finance = buildFinance();
  const app = new Hono();
  mountAdmin(app, { aiAdminRouter, financeRouter: finance.financeRouter });
  const support = createSupportModule();
  app.route('/admin', support.adminRoutes);
  app.route('/', support.runnerRoutes);
  return app;
}

function buildAdminAi() {
  return createAdminAIRoutes();
}

function buildFinance() {
  const financeRouter = createFinanceRoutes();
  return { financeRouter };
}

function mountAdmin(app: App, deps: any) {
  app.route('/admin', createAdminRoutes({
    aiAdminRouter: deps.aiAdminRouter,
    financeRouter: deps.financeRouter,
  }));
}
"#;
        let admin_ts = r#"
import { Hono } from 'hono';
export function createAdminRoutes(deps: any) {
  const app = new Hono();
  app.route('/ai', deps.aiAdminRouter);
  app.route('/finance', deps.financeRouter);
  return app;
}
"#;
        let ai_ts = r#"
import { Hono } from 'hono';
export function createAdminAIRoutes() {
  const router = new Hono();
  router.get('/providers', (c) => c.json([]));
  return router;
}
"#;
        let finance_ts = r#"
import { Hono } from 'hono';
type FinanceRouter = Hono<any>;
function registerFinanceExtra(router: FinanceRouter) {
  router.get('/summary', (c) => c.json({}));
}
export function createFinanceRoutes() {
  const router: FinanceRouter = new Hono();
  router.get('/kpis', (c) => c.json({}));
  registerFinanceExtra(router);
  return router;
}
"#;
        let support_mod_ts = r#"
import { createSupportAdminRoutes, createSupportRunnerRoutes } from './support.routes';
export function createSupportModule() {
  return {
    adminRoutes: createSupportAdminRoutes(),
    runnerRoutes: createSupportRunnerRoutes(),
  };
}
"#;
        let support_routes_ts = r#"
import { Hono } from 'hono';
const RUNNER_PREFIX = '/v1/support';
export function createSupportAdminRoutes() {
  const router = new Hono();
  router.get('/support/issues', (c) => c.json([]));
  return router;
}
export function createSupportRunnerRoutes() {
  const router = new Hono();
  router.post(`${RUNNER_PREFIX}/claim`, (c) => c.json({}));
  return router;
}
"#;
        let sources = vec![
            ("services/core/src/server.ts".to_owned(), server_ts.to_owned()),
            ("services/core/src/admin.routes.ts".to_owned(), admin_ts.to_owned()),
            ("services/core/src/ai.routes.ts".to_owned(), ai_ts.to_owned()),
            ("services/core/src/finance.routes.ts".to_owned(), finance_ts.to_owned()),
            ("services/core/src/support.module.ts".to_owned(), support_mod_ts.to_owned()),
            ("services/core/src/support.routes.ts".to_owned(), support_routes_ts.to_owned()),
        ];
        let (endpoints, _) =
            extract_from_sources(&sources, "services/core", Some("src/server.ts"));
        let pairs: Vec<(HttpMethod, &str, PrefixState)> = endpoints
            .iter()
            .map(|e| (e.method, e.path_norm.as_str(), e.prefix_state))
            .collect();
        assert!(pairs.contains(&(HttpMethod::Get, "/admin/ai/providers", PrefixState::Resolved)), "{pairs:?}");
        assert!(pairs.contains(&(HttpMethod::Get, "/admin/finance/kpis", PrefixState::Resolved)), "{pairs:?}");
        assert!(pairs.contains(&(HttpMethod::Get, "/admin/finance/summary", PrefixState::Resolved)), "{pairs:?}");
        assert!(pairs.contains(&(HttpMethod::Get, "/admin/support/issues", PrefixState::Resolved)), "{pairs:?}");
        assert!(pairs.contains(&(HttpMethod::Post, "/v1/support/claim", PrefixState::Resolved)), "{pairs:?}");
        assert!(!pairs.iter().any(|(_, _, s)| *s == PrefixState::Partial), "{pairs:?}");
    }

    #[test]
    fn entry_file_isolates_same_named_local_routers_across_functions() {
        let server_ts = r#"
import { Hono } from 'hono';
import { createAlphaRoutes } from './alpha.routes';
import { createBetaRoutes } from './beta.routes';

export function mountAlpha(app: App) {
  const router = createAlphaRoutes();
  app.route('/alpha', router);
}

export function mountBeta(app: App) {
  const router = createBetaRoutes();
  app.route('/beta', router);
}
"#;
        let alpha_ts = "import { Hono } from 'hono';\nexport function createAlphaRoutes() { const r = new Hono(); r.get('/one', (c) => c.json({})); return r; }";
        let beta_ts = "import { Hono } from 'hono';\nexport function createBetaRoutes() { const r = new Hono(); r.get('/two', (c) => c.json({})); return r; }";
        let sources = vec![
            ("services/core/src/server.ts".to_owned(), server_ts.to_owned()),
            ("services/core/src/alpha.routes.ts".to_owned(), alpha_ts.to_owned()),
            ("services/core/src/beta.routes.ts".to_owned(), beta_ts.to_owned()),
        ];
        let (endpoints, _) = extract_from_sources(&sources, "services/core", Some("src/server.ts"));
        let paths: Vec<&str> = endpoints.iter().map(|e| e.path_norm.as_str()).collect();
        assert_eq!(paths, vec!["/alpha/one", "/beta/two"]);
    }
}
