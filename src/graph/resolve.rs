use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use super::scan::path_segment_count;
use super::store::{CallRow, EdgeRow, EndpointRow, ServiceRow};
use super::{Confidence, GraphConfig, HttpMethod, PrefixState};

const MIN_UNIQUE_SEGMENTS: usize = 3;
const MIN_SUFFIX_SEGMENTS: usize = 2;
const MIN_HINT_STEM_LEN: usize = 4;

static COMPOSE_ENV_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*-?\s*([A-Z][A-Z0-9_]+)\s*[:=]\s*["']?https?://([a-zA-Z0-9._-]+)(?::\d+)?"#)
        .expect("valid compose env regex")
});

struct ResolverIndex<'a> {
    config: &'a GraphConfig,
    env_map: BTreeMap<String, String>,
    service_base: HashMap<&'a str, &'a str>,
    by_method_path: HashMap<(HttpMethod, &'a str), Vec<&'a EndpointRow>>,
    by_svc_method_path: HashMap<(&'a str, HttpMethod, &'a str), Vec<&'a EndpointRow>>,
    partial_endpoints: Vec<&'a EndpointRow>,
}

pub fn collect_compose_env(
    repo_dir: &Path,
    tracked_files: &[String],
    services: &BTreeMap<String, super::ServiceConfig>,
) -> BTreeMap<String, String> {
    let mut discovered = BTreeMap::new();
    let known_names: Vec<String> = services.keys().cloned().collect();
    for rel in tracked_files {
        let lower = rel.to_ascii_lowercase();
        if !(lower.contains("compose") && (lower.ends_with(".yml") || lower.ends_with(".yaml"))) {
            continue;
        }
        let Ok(content) = fs::read_to_string(repo_dir.join(rel)) else {
            continue;
        };
        for line in content.lines() {
            let Some(caps) = COMPOSE_ENV_URL.captures(line) else {
                continue;
            };
            if let Some(svc) = match_service_by_hint(&caps[2], &known_names) {
                discovered.insert(caps[1].to_owned(), svc);
            }
        }
    }
    discovered
}

pub fn resolve_edges(
    config: &GraphConfig,
    extra_env: &BTreeMap<String, String>,
    services: &[ServiceRow],
    endpoints: &[EndpointRow],
    calls: &[CallRow],
) -> Vec<EdgeRow> {
    let index = build_index(config, extra_env, services, endpoints);
    let mut edges = Vec::new();
    for call in calls {
        if call.external || call.path_norm.is_empty() {
            continue;
        }
        if let Some((matched, confidence)) = resolve_single_call(&index, call) {
            for ep in matched {
                edges.push(EdgeRow {
                    call_id: call.id,
                    endpoint_id: ep.id,
                    confidence,
                });
            }
        }
    }
    edges
}

fn build_index<'a>(
    config: &'a GraphConfig,
    extra_env: &BTreeMap<String, String>,
    services: &'a [ServiceRow],
    endpoints: &'a [EndpointRow],
) -> ResolverIndex<'a> {
    let env_map = merge_env_maps(extra_env, &config.env);
    let service_base: HashMap<&str, &str> = services
        .iter()
        .filter_map(|s| s.base_service.as_deref().map(|b| (s.name.as_str(), b)))
        .collect();
    let mut by_method_path: HashMap<(HttpMethod, &str), Vec<&EndpointRow>> = HashMap::new();
    let mut by_svc_method_path: HashMap<(&str, HttpMethod, &str), Vec<&EndpointRow>> =
        HashMap::new();
    let mut partial_endpoints = Vec::new();
    for ep in endpoints {
        by_method_path
            .entry((ep.method, ep.path_norm.as_str()))
            .or_default()
            .push(ep);
        by_svc_method_path
            .entry((ep.service.as_str(), ep.method, ep.path_norm.as_str()))
            .or_default()
            .push(ep);
        if ep.prefix_state == PrefixState::Partial
            && path_segment_count(&ep.path_norm) >= MIN_SUFFIX_SEGMENTS
        {
            partial_endpoints.push(ep);
        }
    }
    ResolverIndex {
        config,
        env_map,
        service_base,
        by_method_path,
        by_svc_method_path,
        partial_endpoints,
    }
}

fn resolve_single_call<'a>(
    index: &ResolverIndex<'a>,
    call: &CallRow,
) -> Option<(Vec<&'a EndpointRow>, Confidence)> {
    if let Some(target_svc) = configured_service_for_call(call, index) {
        if let Some(eps) = lookup_service_endpoints(&index.by_svc_method_path, target_svc, call) {
            return Some((eps, Confidence::Configured));
        }
        return match_partial_suffix(call, Some(target_svc), &index.partial_endpoints)
            .map(|eps| (eps, Confidence::Suffix));
    }
    if let Some(eps) = match_unique_provider(call, &index.by_method_path) {
        return Some((eps, Confidence::Unique));
    }
    if let Some(eps) = match_name_hint(call, &index.by_method_path) {
        return Some((eps, Confidence::Name));
    }
    match_partial_suffix(call, None, &index.partial_endpoints).map(|eps| (eps, Confidence::Suffix))
}

fn merge_env_maps(
    auto_env: &BTreeMap<String, String>,
    explicit_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut merged = auto_env.clone();
    for (k, v) in explicit_env {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

fn configured_service_for_call<'a>(call: &CallRow, index: &'a ResolverIndex<'a>) -> Option<&'a str> {
    let key = format!("{}:{}", call.repo, call.file);
    if let Some(target) = index.config.clients.get(&key) {
        return Some(target.as_str());
    }
    if !call.base_ref.is_empty() {
        if let Some(target) = index.env_map.get(&call.base_ref) {
            return Some(target.as_str());
        }
        let base_norm = canonical_token(&call.base_ref);
        for (env_var, svc) in &index.env_map {
            let env_norm = canonical_token(env_var);
            if !base_norm.is_empty()
                && !env_norm.is_empty()
                && (base_norm == env_norm || base_norm.contains(&env_norm))
            {
                return Some(svc.as_str());
            }
        }
    }
    index.service_base.get(call.service.as_str()).copied()
}

fn lookup_service_endpoints<'a>(
    by_svc_method_path: &HashMap<(&'a str, HttpMethod, &'a str), Vec<&'a EndpointRow>>,
    target_svc: &str,
    call: &CallRow,
) -> Option<Vec<&'a EndpointRow>> {
    if let Some(eps) = by_svc_method_path.get(&(target_svc, call.method, call.path_norm.as_str())) {
        return Some(eps.clone());
    }
    if call.method != HttpMethod::Any
        && let Some(eps) =
            by_svc_method_path.get(&(target_svc, HttpMethod::Any, call.path_norm.as_str()))
    {
        return Some(eps.clone());
    }
    None
}

fn match_unique_provider<'a>(
    call: &CallRow,
    by_method_path: &HashMap<(HttpMethod, &'a str), Vec<&'a EndpointRow>>,
) -> Option<Vec<&'a EndpointRow>> {
    if path_segment_count(&call.path_norm) < MIN_UNIQUE_SEGMENTS {
        return None;
    }
    let eps = by_method_path.get(&(call.method, call.path_norm.as_str()))?;
    let services: HashSet<&str> = eps.iter().map(|e| e.service.as_str()).collect();
    (services.len() == 1).then(|| eps.clone())
}

fn match_name_hint<'a>(
    call: &CallRow,
    by_method_path: &HashMap<(HttpMethod, &'a str), Vec<&'a EndpointRow>>,
) -> Option<Vec<&'a EndpointRow>> {
    let eps = by_method_path.get(&(call.method, call.path_norm.as_str()))?;
    let candidates: Vec<String> = eps
        .iter()
        .map(|e| e.service.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let haystack = format!("{} {} {}", call.base_ref, call.file, call.symbol);
    let matched_svc = match_service_by_hint(&haystack, &candidates)?;
    let chosen: Vec<&EndpointRow> = eps
        .iter()
        .copied()
        .filter(|e| e.service == matched_svc)
        .collect();
    (!chosen.is_empty()).then_some(chosen)
}

fn match_partial_suffix<'a>(
    call: &CallRow,
    scoped_service: Option<&str>,
    partial_endpoints: &[&'a EndpointRow],
) -> Option<Vec<&'a EndpointRow>> {
    let mut matches: Vec<&EndpointRow> = Vec::new();
    let mut best_len = 0usize;
    for ep in partial_endpoints {
        if scoped_service.is_some_and(|svc| ep.service != svc) {
            continue;
        }
        if ep.method != call.method && ep.method != HttpMethod::Any {
            continue;
        }
        if !path_ends_with_segment_suffix(&call.path_norm, &ep.path_norm) {
            continue;
        }
        if ep.path_norm.len() > best_len {
            best_len = ep.path_norm.len();
            matches.clear();
            matches.push(*ep);
        } else if ep.path_norm.len() == best_len {
            matches.push(*ep);
        }
    }
    let services: HashSet<&str> = matches.iter().map(|e| e.service.as_str()).collect();
    (services.len() == 1).then_some(matches)
}

fn path_ends_with_segment_suffix(full: &str, suffix: &str) -> bool {
    if full == suffix {
        return true;
    }
    if !full.ends_with(suffix) || full.len() <= suffix.len() {
        return false;
    }
    full.as_bytes()[full.len() - suffix.len()] == b'/'
}

fn match_service_by_hint(haystack: &str, candidates: &[String]) -> Option<String> {
    let hay = canonical_token(haystack);
    if hay.is_empty() {
        return None;
    }
    let hits: Vec<String> = candidates
        .iter()
        .filter(|svc| {
            let full = canonical_token(svc);
            let stem = full
                .strip_suffix("api")
                .or_else(|| full.strip_suffix("web"))
                .unwrap_or(&full);
            (!full.is_empty() && hay.contains(&full))
                || (stem.len() >= MIN_HINT_STEM_LEN && hay.contains(stem))
        })
        .cloned()
        .collect();
    (hits.len() == 1).then(|| hits.into_iter().next()).flatten()
}

fn canonical_token(raw: &str) -> String {
    raw.bytes()
        .filter(|b| b.is_ascii_alphanumeric())
        .map(|b| b.to_ascii_lowercase() as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_endpoint(
        id: i64,
        service: &str,
        method: HttpMethod,
        path_norm: &str,
        prefix_state: PrefixState,
    ) -> EndpointRow {
        EndpointRow {
            id,
            service: service.to_owned(),
            repo: service.to_owned(),
            verified_sha: "abcdef123456".to_owned(),
            ep: super::super::ExtractedEndpoint {
                method,
                path_raw: path_norm.to_owned(),
                path_norm: path_norm.to_owned(),
                file: "src/api.rs".to_owned(),
                line: 10,
                handler: "handler".to_owned(),
                prefix_state,
            },
        }
    }

    fn sample_call(
        id: i64,
        service: &str,
        repo: &str,
        file: &str,
        method: HttpMethod,
        path_norm: &str,
        base_ref: &str,
    ) -> CallRow {
        CallRow {
            id,
            service: service.to_owned(),
            repo: repo.to_owned(),
            verified_sha: "123456abcdef".to_owned(),
            call: super::super::ExtractedCall {
                method,
                path_raw: path_norm.to_owned(),
                path_norm: path_norm.to_owned(),
                file: file.to_owned(),
                line: 20,
                base_ref: base_ref.to_owned(),
                symbol: "call".to_owned(),
                area: String::new(),
                why: "test".to_owned(),
                external: false,
            },
        }
    }

    fn empty_config() -> GraphConfig {
        GraphConfig {
            repos_root: PathBuf::from("/tmp"),
            services: BTreeMap::new(),
            env: BTreeMap::new(),
            clients: BTreeMap::new(),
            external: Vec::new(),
        }
    }

    #[test]
    fn health_served_by_two_services_produces_no_unique_edge() {
        let cfg = empty_config();
        let endpoints = vec![
            sample_endpoint(1, "svc-a", HttpMethod::Get, "/health", PrefixState::Full),
            sample_endpoint(2, "svc-b", HttpMethod::Get, "/health", PrefixState::Full),
            sample_endpoint(3, "svc-a", HttpMethod::Get, "/api/health", PrefixState::Full),
        ];
        let calls = vec![
            sample_call(10, "svc-c", "repo-c", "src/probe.rs", HttpMethod::Get, "/health", "self.url"),
            sample_call(11, "svc-c", "repo-c", "src/probe.rs", HttpMethod::Get, "/api/health", "self.url"),
        ];
        let edges = resolve_edges(&cfg, &BTreeMap::new(), &[], &endpoints, &calls);
        assert!(edges.is_empty(), "expected no edges for /health or <=2-segment /api/health: {edges:?}");
    }

    #[test]
    fn resolution_precedence_configured_then_unique_then_name_then_suffix() {
        let mut cfg = empty_config();
        cfg.clients
            .insert("repo-c:src/client.rs".to_owned(), "svc-a".to_owned());
        let endpoints = vec![
            sample_endpoint(1, "svc-a", HttpMethod::Post, "/api/internal/invoices", PrefixState::Full),
            sample_endpoint(2, "svc-b", HttpMethod::Post, "/api/internal/invoices", PrefixState::Full),
            sample_endpoint(3, "svc-a", HttpMethod::Get, "/api/v1/orders/{}", PrefixState::Full),
            sample_endpoint(4, "svc-b", HttpMethod::Get, "/v1/documents/status", PrefixState::Partial),
        ];
        let calls = vec![
            sample_call(10, "svc-c", "repo-c", "src/client.rs", HttpMethod::Post, "/api/internal/invoices", "self.base_url"),
            sample_call(11, "svc-c", "repo-c", "src/other.rs", HttpMethod::Get, "/api/v1/orders/{}", "self.url"),
            sample_call(12, "svc-c", "repo-c", "src/svc_b_caller.rs", HttpMethod::Post, "/api/internal/invoices", "self.svc_b_url"),
            sample_call(13, "svc-c", "repo-c", "src/docs.rs", HttpMethod::Get, "/ai/v1/documents/status", "self.url"),
        ];
        let edges = resolve_edges(&cfg, &BTreeMap::new(), &[], &endpoints, &calls);
        let by_call: HashMap<i64, (i64, Confidence)> =
            edges.into_iter().map(|e| (e.call_id, (e.endpoint_id, e.confidence))).collect();
        assert_eq!(by_call.get(&10), Some(&(1, Confidence::Configured)));
        assert_eq!(by_call.get(&11), Some(&(3, Confidence::Unique)));
        assert_eq!(by_call.get(&12), Some(&(2, Confidence::Name)));
        assert_eq!(by_call.get(&13), Some(&(4, Confidence::Suffix)));
    }
}
