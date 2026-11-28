use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

use super::scan::{
    self, LineIndex, RawTsRoute, TsImportedSymbol, ROOT_SLASH,
};
use super::types::{ExtractedEndpoint, HttpMethod, PrefixState};

const DEFAULT_HANDLER: &str = "express_handler";
const USE_METHOD: &str = "use";
const MAX_MOUNT_DEPTH: usize = 6;

fn compile_re(pat: &str) -> Regex {
    Regex::new(pat).expect("valid express regex")
}

static EXPRESS_APP_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile_re(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*express\s*\(")
});
static EXPRESS_ROUTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile_re(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*Router|Router)\s*\(")
});
static EXPRESS_IMPORT_ROUTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile_re(r#"\bRouter\b[^;\n]*["']express["']|require\s*\(\s*["']express["']\s*\)"#)
});
static FACTORY_VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    compile_re(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(")
});

#[derive(Debug, Clone)]
struct RawExpressMount {
    prefix: String,
    target_expr: String,
}

#[derive(Debug, Clone)]
struct ParsedExpressFile {
    rel: String,
    imports: HashMap<String, TsImportedSymbol>,
    var_to_callee: HashMap<String, String>,
    routes: Vec<RawTsRoute>,
    mounts: Vec<RawExpressMount>,
}

pub fn extract_service_with_deps(
    repo_dir: &Path,
    service_root: &str,
    tracked_files: &[String],
) -> Result<(Vec<ExtractedEndpoint>, HashSet<String>)> {
    let sources = scan::read_ts_service_sources(repo_dir, service_root, tracked_files);
    Ok(extract_from_sources(&sources))
}

pub fn extract_from_sources(
    sources: &[(String, String)],
) -> (Vec<ExtractedEndpoint>, HashSet<String>) {
    let by_file = scan::parse_ts_source_map(sources, parse_express_file, |p| p.rel.clone());

    let mut endpoints = Vec::new();
    let mut dep_files = HashSet::new();
    let mut mounted_files = HashSet::new();
    let mut visited = HashSet::new();

    for parsed in by_file.values() {
        let has_root_app = parsed.routes.iter().any(|r| r.is_root_app) || !parsed.mounts.is_empty();
        if has_root_app {
            walk_express_file(
                &by_file,
                &parsed.rel,
                ROOT_SLASH,
                true,
                0,
                &mut visited,
                &mut mounted_files,
                &mut dep_files,
                &mut endpoints,
            );
        }
    }

    for parsed in by_file.values() {
        if !parsed.routes.is_empty() && !mounted_files.contains(&parsed.rel) {
            dep_files.insert(parsed.rel.clone());
            for r in &parsed.routes {
                let state = if r.is_root_app {
                    PrefixState::Full
                } else {
                    PrefixState::Partial
                };
                scan::push_ts_route(&mut endpoints, r, "", state, false);
            }
        }
    }

    scan::dedup_and_sort_endpoints(&mut endpoints);
    (endpoints, dep_files)
}

#[allow(clippy::too_many_arguments)]
fn walk_express_file(
    by_file: &HashMap<String, ParsedExpressFile>,
    file: &str,
    base_prefix: &str,
    from_root: bool,
    depth: usize,
    visited: &mut HashSet<(String, String)>,
    mounted_files: &mut HashSet<String>,
    dep_files: &mut HashSet<String>,
    endpoints: &mut Vec<ExtractedEndpoint>,
) {
    if depth > MAX_MOUNT_DEPTH || !visited.insert((file.to_owned(), base_prefix.to_owned())) {
        return;
    }
    let Some(parsed) = by_file.get(file) else {
        return;
    };
    dep_files.insert(file.to_owned());
    mounted_files.insert(file.to_owned());
    for r in &parsed.routes {
        let state = if from_root && (base_prefix.is_empty() || base_prefix == ROOT_SLASH) {
            PrefixState::Full
        } else {
            PrefixState::Resolved
        };
        scan::push_ts_route(endpoints, r, base_prefix, state, false);
    }
    for mount in &parsed.mounts {
        let next_prefix = scan::join_paths(base_prefix, &mount.prefix);
        if let Some(target_file) = resolve_express_mount_target(parsed, &mount.target_expr) {
            walk_express_file(
                by_file,
                &target_file,
                &next_prefix,
                false,
                depth + 1,
                visited,
                mounted_files,
                dep_files,
                endpoints,
            );
        }
    }
}

fn resolve_express_mount_target(parsed: &ParsedExpressFile, expr: &str) -> Option<String> {
    let (ident, _) = scan::read_ts_ident_prefix(expr.trim())?;
    if let Some(imp) = parsed.imports.get(ident) {
        return Some(imp.file.clone());
    }
    parsed
        .var_to_callee
        .get(ident)
        .and_then(|callee| parsed.imports.get(callee))
        .map(|imp| imp.file.clone())
}

struct ExpressScanCtx<'a> {
    rel: &'a str,
    source: &'a str,
    mask: &'a [bool],
    lines: &'a LineIndex,
    app_vars: &'a HashSet<String>,
    router_vars: &'a HashSet<String>,
    local_paths: &'a HashMap<String, String>,
}

fn parse_express_file(
    rel: &str,
    source: &str,
    known_files: &HashSet<String>,
) -> ParsedExpressFile {
    let mask = scan::ts_code_mask(source);
    let lines = LineIndex::new(source);
    let imports = scan::parse_ts_imports(rel, source, &mask, known_files);
    let local_paths = scan::collect_local_path_consts(source, &mask);
    let (app_vars, router_vars, var_to_callee) = collect_express_bindings(source, &mask);
    let mut routes = Vec::new();
    let mut mounts = Vec::new();
    if !app_vars.is_empty() || !router_vars.is_empty() {
        let ctx = ExpressScanCtx {
            rel,
            source,
            mask: &mask,
            lines: &lines,
            app_vars: &app_vars,
            router_vars: &router_vars,
            local_paths: &local_paths,
        };
        scan_express_calls(&ctx, &mut routes, &mut mounts);
    }
    ParsedExpressFile {
        rel: rel.to_owned(),
        imports,
        var_to_callee,
        routes,
        mounts,
    }
}

fn collect_express_bindings(
    source: &str,
    mask: &[bool],
) -> (HashSet<String>, HashSet<String>, HashMap<String, String>) {
    let mut app_vars = HashSet::new();
    for caps in EXPRESS_APP_RE.captures_iter(source) {
        if mask[caps.get(0).unwrap().start()] {
            app_vars.insert(caps[1].to_owned());
        }
    }
    let mut router_vars = HashSet::new();
    let imports_express = EXPRESS_IMPORT_ROUTER_RE.is_match(source) || !app_vars.is_empty();
    for caps in EXPRESS_ROUTER_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if mask[m0.start()] && (m0.as_str().contains("express") || imports_express) {
            router_vars.insert(caps[1].to_owned());
        }
    }
    let mut var_to_callee = HashMap::new();
    for caps in FACTORY_VAR_RE.captures_iter(source) {
        if mask[caps.get(0).unwrap().start()] {
            var_to_callee.insert(caps[1].to_owned(), caps[2].to_owned());
        }
    }
    (app_vars, router_vars, var_to_callee)
}

fn scan_express_calls(
    ctx: &ExpressScanCtx<'_>,
    routes: &mut Vec<RawTsRoute>,
    mounts: &mut Vec<RawExpressMount>,
) {
    scan::for_each_dot_call(ctx.source, ctx.mask, 0, ctx.source.len(), |name, dot_pos, open, close| {
        let Some(recv) = scan::chain_root_receiver(ctx.source, ctx.mask, dot_pos) else {
            return Some(open + 1);
        };
        let is_app = ctx.app_vars.contains(&recv);
        if !is_app && !ctx.router_vars.contains(&recv) {
            return Some(open + 1);
        }
        let args = scan::split_top_level_args(ctx.source, ctx.mask, 0, open + 1, close);
        dispatch_express_call(ctx, name, dot_pos, is_app, &args, routes, mounts);
        Some(open + 1)
    });
}

fn dispatch_express_call(
    ctx: &ExpressScanCtx<'_>,
    name: &str,
    dot_pos: usize,
    is_app: bool,
    args: &[(usize, &str)],
    routes: &mut Vec<RawTsRoute>,
    mounts: &mut Vec<RawExpressMount>,
) {
    let Some(raw_path) = scan::first_ts_route_path(args, ctx.local_paths) else {
        return;
    };
    if name == USE_METHOD {
        for (_, target) in args.iter().skip(1) {
            mounts.push(RawExpressMount {
                prefix: raw_path.clone(),
                target_expr: (*target).to_owned(),
            });
        }
    } else if let Some(method) = HttpMethod::parse_hono(name) {
        routes.push(RawTsRoute {
            method,
            path_raw: raw_path,
            file: ctx.rel.to_owned(),
            line: ctx.lines.line_at(dot_pos),
            handler: scan::extract_ts_handler_name(args, DEFAULT_HANDLER),
            is_root_app: is_app,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_express_app_and_mounted_router_routes() {
        let app_js = r#"
import express from 'express';
import { adminRouter } from './admin.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/send', auth, async (req, res) => res.json({ ok: true }));
  app.use('/admin', adminRouter);
  return app;
}
"#;
        let admin_js = r#"
import express from 'express';

export const adminRouter = express.Router();
adminRouter.put('/users/:id', updateUser);
adminRouter.delete('/sessions/:id', revokeSession);
"#;
        let sources = vec![
            ("src/app.js".to_owned(), app_js.to_owned()),
            ("src/admin.js".to_owned(), admin_js.to_owned()),
        ];
        let (endpoints, deps) = extract_from_sources(&sources);
        let has = |m: HttpMethod, p: &str, s: PrefixState| {
            endpoints.iter().any(|e| e.method == m && e.path_norm == p && e.prefix_state == s)
        };
        assert!(has(HttpMethod::Get, "/health", PrefixState::Full));
        assert!(has(HttpMethod::Post, "/send", PrefixState::Full));
        assert!(has(HttpMethod::Put, "/admin/users/{}", PrefixState::Resolved));
        assert!(has(HttpMethod::Delete, "/admin/sessions/{}", PrefixState::Resolved));
        assert!(deps.contains("src/app.js"));
        assert!(deps.contains("src/admin.js"));
    }
}
