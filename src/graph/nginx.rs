use std::{collections::{BTreeMap, HashMap, HashSet}, fs, path::Path, sync::LazyLock};

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::scan::{
    ROOT_SLASH, build_code_mask, find_matching_delim, is_nginx_conf, join_paths, normalize_path,
    skip_quoted_string, under_root,
};

const REQUEST_URI_VAR: &str = "$request_uri";
const URI_VAR: &str = "$uri";
const NGINX_PREFIX_ETC: &str = "/etc/nginx/";
const WILDCARD_SERVER: &str = "_";

static SERVER_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*server_name\s+([^;]+);").expect("valid server_name regex")
});

static SET_VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*set\s+\$([A-Za-z0-9_]+)\s+["']?([^;"'\s]+)["']?\s*;"#)
        .expect("valid set var regex")
});

static PROXY_PASS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*proxy_pass\s+https?://([^;\s]+)\s*;"#).expect("valid proxy_pass regex")
});

static INCLUDE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*include\s+([^;\s]+)\s*;"#).expect("valid include regex")
});

static LOCATION_HEAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\blocation\s+(?:(=|\^~|~\*|~)\s+)?([^\s{]+)\s*\{")
        .expect("valid location head regex")
});

static SERVER_HEAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bserver\s*\{").expect("valid server head regex")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NginxLocationKind {
    Exact,
    Prefix,
    Regex,
}

impl NginxLocationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Prefix => "prefix",
            Self::Regex => "regex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NginxRoute {
    pub host: String,
    pub location: String,
    pub kind: NginxLocationKind,
    pub container: String,
    pub rewrite_prefix: String,
    pub fixed_path: Option<String>,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NginxResolvedTarget {
    pub service: String,
    pub path_norm: String,
}

pub fn extract_service(
    repo_dir: &Path,
    service_root: &str,
    tracked_files: &[String],
) -> Result<Vec<NginxRoute>> {
    let mut routes = Vec::new();
    for rel in tracked_files {
        if !is_nginx_conf(rel) || !under_root(rel, service_root) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(repo_dir.join(rel)) else {
            continue;
        };
        routes.extend(parse_nginx_conf(rel, &raw, |inc| {
            read_nginx_include(repo_dir, service_root, inc)
        }));
    }
    routes.sort_by(|a, b| {
        a.host
            .cmp(&b.host)
            .then_with(|| a.location.cmp(&b.location))
            .then_with(|| a.container.cmp(&b.container))
    });
    routes.dedup();
    Ok(routes)
}

fn read_nginx_include(repo_dir: &Path, service_root: &str, include_target: &str) -> Option<String> {
    let rel_under_nginx = include_target.strip_prefix(NGINX_PREFIX_ETC)?;
    let root_path = Path::new(service_root);
    let nginx_base = root_path.parent().unwrap_or(root_path);
    let candidate = repo_dir.join(nginx_base).join(rel_under_nginx);
    let canon_repo = repo_dir.canonicalize().ok()?;
    let canon_file = candidate.canonicalize().ok()?;
    if !canon_file.starts_with(&canon_repo) {
        return None;
    }
    fs::read_to_string(canon_file).ok()
}

pub fn parse_nginx_conf(
    rel_file: &str,
    source: &str,
    read_include: impl Fn(&str) -> Option<String>,
) -> Vec<NginxRoute> {
    let clean = strip_nginx_comments(source);
    let mask = nginx_code_mask(&clean);
    let bytes = clean.as_bytes();
    let mut routes = Vec::new();

    for m in SERVER_HEAD_RE.find_iter(&clean) {
        let open = m.end() - 1;
        if !mask[m.start()] || !mask[open] {
            continue;
        }
        let Some(close) = find_matching_delim(bytes, &mask, open, b'{', b'}') else {
            continue;
        };
        let block = &clean[open + 1..close];
        let hosts = parse_server_names(block);
        if hosts.is_empty() {
            continue;
        }
        let server_vars = parse_top_level_sets(block);
        parse_server_locations(
            rel_file,
            &clean,
            &mask,
            open + 1,
            close,
            &hosts,
            &server_vars,
            &read_include,
            &mut routes,
        );
    }
    routes
}

#[allow(clippy::too_many_arguments)]
fn parse_server_locations(
    rel_file: &str,
    clean: &str,
    mask: &[bool],
    start: usize,
    end: usize,
    hosts: &[String],
    server_vars: &HashMap<String, String>,
    read_include: &impl Fn(&str) -> Option<String>,
    out: &mut Vec<NginxRoute>,
) {
    let bytes = clean.as_bytes();
    let slice = &clean[start..end];
    for caps in LOCATION_HEAD_RE.captures_iter(slice) {
        let m0 = caps.get(0).unwrap();
        let abs_start = start + m0.start();
        let abs_open = start + m0.end() - 1;
        if !mask[abs_start] || !mask[abs_open] {
            continue;
        }
        let Some(abs_close) = find_matching_delim(bytes, mask, abs_open, b'{', b'}') else {
            continue;
        };
        let modifier = caps.get(1).map(|m| m.as_str());
        let loc_pattern = caps[2].trim();
        let kind = match modifier {
            Some("=") => NginxLocationKind::Exact,
            Some("~") | Some("~*") => NginxLocationKind::Regex,
            _ => NginxLocationKind::Prefix,
        };
        let body = expand_includes(&clean[abs_open + 1..abs_close], read_include);
        let mut vars = server_vars.clone();
        for scaps in SET_VAR_RE.captures_iter(&body) {
            vars.insert(scaps[1].to_owned(), scaps[2].to_owned());
        }
        let proxy_parsed = PROXY_PASS_RE
            .captures(&body)
            .and_then(|pcaps| parse_proxy_target(&pcaps[1], &vars, loc_pattern));

        let (container, rewrite_prefix, fixed_path) = match (kind, proxy_parsed) {
            (NginxLocationKind::Regex, parsed) => {
                parsed.unwrap_or_else(|| (String::new(), String::new(), None))
            }
            (_, Some(parsed)) if !parsed.0.is_empty() => parsed,
            _ => continue,
        };
        push_host_routes(
            hosts,
            loc_pattern,
            kind,
            &container,
            &rewrite_prefix,
            fixed_path.as_deref(),
            rel_file,
            out,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn push_host_routes(
    hosts: &[String],
    location: &str,
    kind: NginxLocationKind,
    container: &str,
    rewrite_prefix: &str,
    fixed_path: Option<&str>,
    file: &str,
    out: &mut Vec<NginxRoute>,
) {
    for host in hosts {
        out.push(NginxRoute {
            host: host.clone(),
            location: location.to_owned(),
            kind,
            container: container.to_owned(),
            rewrite_prefix: rewrite_prefix.to_owned(),
            fixed_path: fixed_path.map(str::to_owned),
            file: file.to_owned(),
        });
    }
}

fn expand_includes(body: &str, read_include: &impl Fn(&str) -> Option<String>) -> String {
    let mut expanded = body.to_owned();
    for caps in INCLUDE_RE.captures_iter(body) {
        if let Some(inc_src) = read_include(&caps[1]) {
            expanded.push('\n');
            expanded.push_str(&strip_nginx_comments(&inc_src));
        }
    }
    expanded
}

fn parse_proxy_target(
    raw_target: &str,
    vars: &HashMap<String, String>,
    location: &str,
) -> Option<(String, String, Option<String>)> {
    let resolved = substitute_nginx_vars(raw_target, vars);
    let split_idx = resolved.find(['/', '$']).unwrap_or(resolved.len());
    let host_port = &resolved[..split_idx];
    let remainder = &resolved[split_idx..];
    let container = host_port.split(':').next().unwrap_or("").trim();
    if container.is_empty() || container.starts_with('$') {
        return None;
    }
    let container = container.to_owned();
    if remainder.is_empty()
        || remainder == REQUEST_URI_VAR
        || remainder == URI_VAR
        || remainder == format!("/{REQUEST_URI_VAR}")
    {
        return Some((container, String::new(), None));
    }
    if let Some(prefix_raw) = remainder
        .strip_suffix(REQUEST_URI_VAR)
        .or_else(|| remainder.strip_suffix(URI_VAR))
    {
        let prefix = normalize_path(prefix_raw);
        let rewrite = if prefix == ROOT_SLASH { String::new() } else { prefix };
        return Some((container, rewrite, None));
    }
    let fixed = normalize_path(remainder);
    if fixed.is_empty() {
        return Some((container, String::new(), None));
    }
    let loc_norm = normalize_path(location);
    let rewrite = if !loc_norm.is_empty()
        && loc_norm != ROOT_SLASH
        && fixed.ends_with(&loc_norm)
        && fixed.len() > loc_norm.len()
    {
        normalize_path(&fixed[..fixed.len() - loc_norm.len()])
    } else {
        String::new()
    };
    Some((container, rewrite, Some(fixed)))
}

fn substitute_nginx_vars(raw: &str, vars: &HashMap<String, String>) -> String {
    let mut sorted: Vec<(&String, &String)> = vars.iter().collect();
    sorted.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
    let mut out = raw.to_owned();
    for (name, val) in sorted {
        let token = format!("${name}");
        let braced = format!("${{{name}}}");
        out = out.replace(&braced, val).replace(&token, val);
    }
    out
}

fn parse_server_names(block: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for caps in SERVER_NAME_RE.captures_iter(block) {
        for raw in caps[1].split_whitespace() {
            let h = raw.trim().to_ascii_lowercase();
            if !h.is_empty() && h != WILDCARD_SERVER && !h.starts_with('*') && !h.starts_with('~') {
                hosts.push(h);
            }
        }
    }
    hosts
}

fn parse_top_level_sets(block: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    let mut depth = 0usize;
    for line in block.lines() {
        if depth == 0
            && let Some(caps) = SET_VAR_RE.captures(line)
        {
            vars.insert(caps[1].to_owned(), caps[2].to_owned());
        }
        for b in line.bytes() {
            match b {
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    vars
}

fn strip_nginx_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for line in source.lines() {
        let bytes = line.as_bytes();
        let mut quote: Option<u8> = None;
        let mut cut = bytes.len();
        let mut i = 0usize;
        while i < bytes.len() {
            let b = bytes[i];
            if let Some(q) = quote {
                if b == b'\\' {
                    i += 2;
                    continue;
                }
                if b == q {
                    quote = None;
                }
            } else if b == b'"' || b == b'\'' {
                quote = Some(b);
            } else if b == b'#' {
                cut = i;
                break;
            }
            i += 1;
        }
        out.push_str(&line[..cut]);
        out.push('\n');
    }
    out
}

fn nginx_code_mask(source: &str) -> Vec<bool> {
    build_code_mask(source, next_nginx_non_code_span)
}

fn next_nginx_non_code_span(bytes: &[u8], i: usize) -> Option<usize> {
    matches!(bytes[i], b'"' | b'\'').then(|| skip_quoted_string(bytes, i, bytes[i]))
}

pub fn resolve_host_route(
    routes: &[NginxRoute],
    containers: &BTreeMap<String, String>,
    host: &str,
    path_norm: &str,
) -> Option<NginxResolvedTarget> {
    let target_host = host.trim().to_ascii_lowercase();
    if target_host.is_empty() {
        return None;
    }
    let mut best_prefix: Option<(&NginxRoute, usize)> = None;
    let mut exact_hit: Option<&NginxRoute> = None;

    for route in routes {
        if route.host != target_host || route.kind == NginxLocationKind::Regex {
            continue;
        }
        let loc_norm = normalize_path(&route.location);
        match route.kind {
            NginxLocationKind::Exact => {
                if path_norm == loc_norm {
                    exact_hit = Some(route);
                    break;
                }
            }
            NginxLocationKind::Prefix => {
                if prefix_matches(path_norm, &route.location, &loc_norm) {
                    let score = route.location.len();
                    if best_prefix.is_none_or(|(_, best)| score > best) {
                        best_prefix = Some((route, score));
                    }
                }
            }
            NginxLocationKind::Regex => {}
        }
    }

    let chosen = exact_hit.or_else(|| best_prefix.map(|(r, _)| r))?;
    let service = containers.get(&chosen.container)?.clone();
    let rewritten = apply_nginx_rewrite(chosen, path_norm);
    Some(NginxResolvedTarget {
        service,
        path_norm: rewritten,
    })
}

fn prefix_matches(path_norm: &str, raw_location: &str, loc_norm: &str) -> bool {
    if loc_norm == ROOT_SLASH {
        return path_norm.starts_with('/');
    }
    if path_norm == loc_norm {
        return true;
    }
    if path_norm.starts_with(&format!("{loc_norm}/")) {
        return true;
    }
    !raw_location.ends_with('/') && path_norm.starts_with(loc_norm)
}

fn apply_nginx_rewrite(route: &NginxRoute, path_norm: &str) -> String {
    if !route.rewrite_prefix.is_empty() {
        if path_norm == route.rewrite_prefix
            || path_norm.starts_with(&format!("{}/", route.rewrite_prefix))
        {
            return path_norm.to_owned();
        }
        return normalize_path(&join_paths(&route.rewrite_prefix, path_norm));
    }
    if let Some(fixed) = &route.fixed_path {
        let loc_norm = normalize_path(&route.location);
        if path_norm == loc_norm {
            return fixed.clone();
        }
        if !loc_norm.is_empty()
            && loc_norm != ROOT_SLASH
            && let Some(rest) = path_norm.strip_prefix(&loc_norm)
            && rest.starts_with('/')
        {
            return normalize_path(&join_paths(fixed, rest));
        }
    }
    path_norm.to_owned()
}

pub fn known_nginx_hosts(routes: &[NginxRoute]) -> HashSet<String> {
    routes.iter().map(|r| r.host.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nginx_set_proxy_pass_prefix_rewrite_and_records_regex_as_fog_only() {
        let conf = r#"
server {
    listen 80;
    server_name api.ez-catalog.huggian.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.ez-catalog.huggian.com;

    location ~ ^/legacy/[0-9]+$ {
        set $upstream legacy-svc:9000;
        proxy_pass http://$upstream;
    }

    location /health {
        set $upstream ez-addon-api:8080;
        proxy_pass http://$upstream/catalog/health;
    }

    location / {
        set $upstream ez-addon-api:8080;
        proxy_pass http://$upstream/catalog$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name api.huggian.com;

    location ^~ /cochera/ {
        set $upstream ez-addon-api:8080;
        proxy_pass http://$upstream$request_uri;
    }

    location / {
        set $upstream huggian-core:3010;
        proxy_pass http://$upstream;
    }
}
"#;
        let routes = parse_nginx_conf("nginx/conf.d/test.conf", conf, |_| None);
        let regex_route = routes
            .iter()
            .find(|r| r.kind == NginxLocationKind::Regex)
            .expect("regex location recorded");
        assert_eq!(regex_route.location, "^/legacy/[0-9]+$");
        assert_eq!(regex_route.container, "legacy-svc");

        let mut containers = BTreeMap::new();
        containers.insert("ez-addon-api".to_owned(), "ez-addon-api".to_owned());
        containers.insert("huggian-core".to_owned(), "huggian-core".to_owned());
        containers.insert("legacy-svc".to_owned(), "legacy-svc".to_owned());

        let cat = resolve_host_route(
            &routes,
            &containers,
            "api.ez-catalog.huggian.com",
            "/v1/brands",
        )
        .expect("catalog route");
        assert_eq!(cat.service, "ez-addon-api");
        assert_eq!(cat.path_norm, "/catalog/v1/brands");

        let health = resolve_host_route(
            &routes,
            &containers,
            "api.ez-catalog.huggian.com",
            "/health",
        )
        .expect("catalog health");
        assert_eq!(health.service, "ez-addon-api");
        assert_eq!(health.path_norm, "/catalog/health");

        let cochera = resolve_host_route(
            &routes,
            &containers,
            "api.huggian.com",
            "/cochera/v1/sessions",
        )
        .expect("cochera prefix wins over /");
        assert_eq!(cochera.service, "ez-addon-api");
        assert_eq!(cochera.path_norm, "/cochera/v1/sessions");

        let core = resolve_host_route(
            &routes,
            &containers,
            "api.huggian.com",
            "/v1/public/signup",
        )
        .expect("core catch-all");
        assert_eq!(core.service, "huggian-core");
        assert_eq!(core.path_norm, "/v1/public/signup");

        let regex_only = vec![regex_route.clone()];
        assert!(
            resolve_host_route(
                &regex_only,
                &containers,
                "api.ez-catalog.huggian.com",
                "/legacy/42"
            )
            .is_none()
        );
    }
}
