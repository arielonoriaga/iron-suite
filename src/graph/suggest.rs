use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use serde::Serialize;

use super::resolve::{canonical_token, match_service_by_hint};
use super::scan::{
    DYNAMIC_SEG, is_rust_source, join_paths, matches_external_glob, normalize_path, strip_cfg_test,
    strip_comments,
};
use super::store::{CallRow, EndpointRow, GraphStore};
use super::types::{GraphConfig, HttpMethod, PrefixState};

const ENV_URL_HINTS: &[&str] = &["URL", "BASE", "HOST", "API", "ADDR", "ENDPOINT", "ORIGIN", "SERVER"];
const URL_BINDING_HINTS: &[&str] = &["url", "base", "host", "origin", "endpoint", "api", "server"];
const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "0.0.0.0", "::1"];
const MIN_ENV_NAME_LEN: usize = 3;
const MIN_TLD_LEN: usize = 2;

static ENV_VAR_CALL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b(?:env::var|option_env!|var_os)\s*\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)"#)
        .expect("valid env var regex")
});

static HTTP_URL_HOST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"https?://([a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})(?:[:/"'\s]|$)"#)
        .expect("valid url host regex")
});

#[derive(Debug, Clone, Default, Serialize)]
pub struct GraphSuggestions {
    pub prefixes: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
    pub external: Vec<String>,
}

pub fn compute_suggestions(
    store: &GraphStore,
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
) -> Result<GraphSuggestions> {
    let endpoints = store.load_all_endpoints()?;
    let fog_calls = store.unresolved_calls(None)?;
    let resolved_files = store.resolved_call_files()?;
    let repo_paths: HashMap<String, String> = store
        .list_repos()?
        .into_iter()
        .map(|r| (r.repo, r.repo_path))
        .collect();

    let external = suggest_external_files(config, &fog_calls, &resolved_files, &repo_paths);
    let external_set: HashSet<&str> = external.iter().map(String::as_str).collect();
    let prefixes = suggest_prefixes(config, &endpoints, &fog_calls, &external_set);
    let env = suggest_env_mappings(config, auto_env, &fog_calls, &repo_paths);
    Ok(GraphSuggestions {
        prefixes,
        env,
        external,
    })
}

fn suggest_prefixes(
    config: &GraphConfig,
    endpoints: &[EndpointRow],
    fog_calls: &[CallRow],
    external_files: &HashSet<&str>,
) -> BTreeMap<String, String> {
    let mut direct_providers: HashSet<(HttpMethod, &str)> = HashSet::new();
    let mut by_svc_method_path: HashMap<(&str, HttpMethod, &str), usize> = HashMap::new();
    let mut service_mounts: HashMap<&str, BTreeSet<String>> = HashMap::new();

    for ep in endpoints {
        direct_providers.insert((ep.method, ep.path_norm.as_str()));
        *by_svc_method_path
            .entry((ep.service.as_str(), ep.method, ep.path_norm.as_str()))
            .or_insert(0) += 1;
        if ep.prefix_state != PrefixState::Partial {
            for mount in extract_mount_prefixes(&ep.path_norm) {
                service_mounts
                    .entry(ep.service.as_str())
                    .or_default()
                    .insert(mount);
            }
        }
    }

    let mut calls_by_client: BTreeMap<String, Vec<&CallRow>> = BTreeMap::new();
    for call in fog_calls {
        let key = format!("{}:{}", call.repo, call.file);
        if !config.prefixes.contains_key(&key) && !external_files.contains(key.as_str()) {
            calls_by_client.entry(key).or_default().push(call);
        }
    }

    let mut suggested = BTreeMap::new();
    for (client_key, calls) in calls_by_client {
        let pinned_service = config.clients.get(&client_key).map(String::as_str);
        let mut matched_prefixes: BTreeSet<String> = BTreeSet::new();
        for call in calls {
            if direct_providers.contains(&(call.method, call.path_norm.as_str()))
                || direct_providers.contains(&(HttpMethod::Any, call.path_norm.as_str()))
            {
                continue;
            }
            if let Some(prefix) = find_unique_mount_prefix(
                call,
                pinned_service,
                &service_mounts,
                &by_svc_method_path,
            ) {
                matched_prefixes.insert(prefix);
            }
        }
        if matched_prefixes.len() == 1
            && let Some(prefix) = matched_prefixes.into_iter().next()
        {
            suggested.insert(client_key, prefix);
        }
    }
    suggested
}

fn find_unique_mount_prefix(
    call: &CallRow,
    pinned_service: Option<&str>,
    service_mounts: &HashMap<&str, BTreeSet<String>>,
    by_svc_method_path: &HashMap<(&str, HttpMethod, &str), usize>,
) -> Option<String> {
    let candidate_mounts: BTreeSet<&str> = service_mounts
        .iter()
        .filter(|(svc, _)| pinned_service.is_none_or(|p| **svc == p))
        .flat_map(|(_, mounts)| mounts.iter().map(String::as_str))
        .collect();
    let mut hits: Vec<String> = Vec::new();
    for mount in candidate_mounts {
        if call.path_norm == mount || call.path_norm.starts_with(&format!("{mount}/")) {
            continue;
        }
        let candidate = normalize_path(&join_paths(mount, &call.path_norm));
        let total_matches: usize = service_mounts
            .keys()
            .filter(|svc| pinned_service.is_none_or(|p| **svc == p))
            .map(|svc| count_matching_endpoints(by_svc_method_path, svc, call.method, &candidate))
            .sum();
        if total_matches == 1 {
            hits.push(mount.to_owned());
        }
    }
    (hits.len() == 1).then(|| hits.into_iter().next()).flatten()
}

fn count_matching_endpoints(
    by_svc_method_path: &HashMap<(&str, HttpMethod, &str), usize>,
    svc: &str,
    method: HttpMethod,
    path: &str,
) -> usize {
    let exact = by_svc_method_path.get(&(svc, method, path)).copied().unwrap_or(0);
    let any = if method != HttpMethod::Any {
        by_svc_method_path
            .get(&(svc, HttpMethod::Any, path))
            .copied()
            .unwrap_or(0)
    } else {
        0
    };
    exact + any
}

fn extract_mount_prefixes(path_norm: &str) -> Vec<String> {
    let segs: Vec<&str> = path_norm.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefixes = Vec::new();
    if segs.len() >= 2 && segs[0] != DYNAMIC_SEG {
        prefixes.push(format!("/{}", segs[0]));
    }
    if segs.len() >= 3 && segs[0] != DYNAMIC_SEG && segs[1] != DYNAMIC_SEG {
        prefixes.push(format!("/{}/{}", segs[0], segs[1]));
    }
    prefixes
}

fn suggest_env_mappings(
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
    fog_calls: &[CallRow],
    repo_paths: &HashMap<String, String>,
) -> BTreeMap<String, String> {
    let mut suggested = BTreeMap::new();
    for (var, svc) in auto_env {
        if !config.env.contains_key(var) {
            suggested.insert(var.clone(), svc.clone());
        }
    }
    let service_names: Vec<String> = config.services.keys().cloned().collect();
    let candidate_vars = collect_candidate_env_vars(config, fog_calls, repo_paths);
    for var in candidate_vars {
        if config.env.contains_key(&var) || suggested.contains_key(&var) {
            continue;
        }
        if ENV_URL_HINTS.iter().any(|hint| var.contains(hint))
            && let Some(svc) = match_service_by_hint(&var, &service_names)
        {
            suggested.insert(var, svc);
        }
    }
    suggested
}

fn collect_candidate_env_vars(
    config: &GraphConfig,
    fog_calls: &[CallRow],
    repo_paths: &HashMap<String, String>,
) -> BTreeSet<String> {
    let mut candidate_vars = BTreeSet::new();
    let mut visited_files: HashSet<(&str, &str)> = HashSet::new();
    for call in fog_calls {
        if is_env_var_name(&call.base_ref) {
            candidate_vars.insert(call.base_ref.clone());
        }
        if visited_files.insert((call.repo.as_str(), call.file.as_str()))
            && let Some(content) = read_repo_file(config, repo_paths, &call.repo, &call.file)
        {
            for caps in ENV_VAR_CALL_RE.captures_iter(&content) {
                candidate_vars.insert(caps[1].to_owned());
            }
        }
    }
    candidate_vars
}

fn is_env_var_name(raw: &str) -> bool {
    raw.len() >= MIN_ENV_NAME_LEN
        && raw
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && raw.bytes().any(|b| b.is_ascii_uppercase())
}

fn suggest_external_files(
    config: &GraphConfig,
    fog_calls: &[CallRow],
    resolved_files: &HashSet<(String, String)>,
    repo_paths: &HashMap<String, String>,
) -> Vec<String> {
    let service_names: Vec<String> = config.services.keys().cloned().collect();
    let mut calls_by_file: BTreeMap<(String, String), Vec<&CallRow>> = BTreeMap::new();
    for call in fog_calls {
        if matches_external_glob(&config.external, &call.repo, &call.file)
            || resolved_files.contains(&(call.repo.clone(), call.file.clone()))
        {
            continue;
        }
        calls_by_file
            .entry((call.repo.clone(), call.file.clone()))
            .or_default()
            .push(call);
    }

    let mut out = BTreeSet::new();
    for ((repo, file), calls) in calls_by_file {
        let direct_ext = calls.iter().any(|call| {
            is_non_configured_host(&call.base_ref, &service_names)
                || extract_url_host(&call.path_raw)
                    .is_some_and(|h| is_non_configured_host(&h, &service_names))
        });
        let file_ext = !direct_ext
            && read_repo_file(config, repo_paths, &repo, &file)
                .is_some_and(|content| file_defines_external_base(&file, &content, &service_names));
        if direct_ext || file_ext {
            out.insert(format!("{repo}:{file}"));
        }
    }
    out.into_iter().collect()
}

fn file_defines_external_base(rel_file: &str, content: &str, service_names: &[String]) -> bool {
    let is_rust = is_rust_source(rel_file);
    let prod = if is_rust {
        strip_cfg_test(content)
    } else {
        content.to_owned()
    };
    let code_only = strip_comments(&prod, is_rust);
    code_only.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        URL_BINDING_HINTS.iter().any(|h| lower.contains(h))
            && HTTP_URL_HOST_RE
                .captures_iter(line)
                .any(|caps| is_non_configured_host(&caps[1], service_names))
    })
}

fn extract_url_host(raw: &str) -> Option<String> {
    let idx = raw.find("://")?;
    let host_port = raw[idx + 3..].split('/').next()?;
    let host = host_port.split(':').next()?.trim();
    (!host.is_empty()).then(|| host.to_owned())
}

fn is_non_configured_host(raw: &str, service_names: &[String]) -> bool {
    let host = raw.split(':').next().unwrap_or(raw).trim().to_ascii_lowercase();
    if host.is_empty()
        || !host.contains('.')
        || host.contains('{')
        || host.contains(' ')
        || LOCAL_HOSTS.contains(&host.as_str())
    {
        return false;
    }
    if ["self.", "state.", "this."]
        .iter()
        .any(|p| host.starts_with(p))
    {
        return false;
    }
    let last_label = host.rsplit('.').next().unwrap_or("");
    if last_label.len() < MIN_TLD_LEN || !last_label.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    if host
        .bytes()
        .any(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')))
    {
        return false;
    }
    let host_token = canonical_token(&host);
    !service_names.iter().any(|svc| {
        let svc_tok = canonical_token(svc);
        !svc_tok.is_empty() && host_token.contains(&svc_tok)
    }) && match_service_by_hint(&host, service_names).is_none()
}

fn read_repo_file(
    config: &GraphConfig,
    repo_paths: &HashMap<String, String>,
    repo: &str,
    rel_file: &str,
) -> Option<String> {
    let base = repo_paths
        .get(repo)
        .map(Path::new)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| config.repos_root.join(repo));
    fs::read_to_string(base.join(rel_file)).ok()
}

pub fn merge_suggestions(config: &mut GraphConfig, suggestions: &GraphSuggestions) -> bool {
    let mut changed = false;
    for (k, v) in &suggestions.prefixes {
        if !config.prefixes.contains_key(k) {
            config.prefixes.insert(k.clone(), v.clone());
            changed = true;
        }
    }
    for (k, v) in &suggestions.env {
        if !config.env.contains_key(k) {
            config.env.insert(k.clone(), v.clone());
            changed = true;
        }
    }
    let mut existing_ext: BTreeSet<String> = config.external.iter().cloned().collect();
    for entry in &suggestions.external {
        if existing_ext.insert(entry.clone()) {
            changed = true;
        }
    }
    if changed {
        config.external = existing_ext.into_iter().collect();
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::super::types::{ExtractedCall, ExtractedEndpoint, ServiceConfig, Stack};
    use super::*;
    use tempfile::TempDir;

    const TEST_ENV_ADDON: &str = "EZ_ADDON_URL";
    const TEST_ENV_COMMERCE: &str = "EZ_COMMERCE_API_URL";

    fn axum_svc(repo: &str, entry: Option<&str>) -> ServiceConfig {
        ServiceConfig {
            repo: repo.to_owned(),
            root: String::new(),
            stack: Stack::Axum,
            entry: entry.map(str::to_owned),
            client: None,
            base: None,
            base_prefix: None,
        }
    }

    fn resolved_ep(method: HttpMethod, path: &str, file: &str, handler: &str) -> ExtractedEndpoint {
        ExtractedEndpoint {
            method,
            path_raw: path.to_owned(),
            path_norm: path.to_owned(),
            file: file.to_owned(),
            line: 10,
            handler: handler.to_owned(),
            prefix_state: PrefixState::Resolved,
        }
    }

    fn fog_call(method: HttpMethod, path: &str, file: &str) -> ExtractedCall {
        ExtractedCall {
            method,
            path_raw: path.to_owned(),
            path_norm: path.to_owned(),
            file: file.to_owned(),
            line: 10,
            base_ref: "self.base_url".to_owned(),
            symbol: "call".to_owned(),
            area: String::new(),
            why: "call".to_owned(),
            external: false,
        }
    }

    #[test]
    fn suggest_detects_prefix_env_and_external_hosts() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.db");
        let repos_root = tmp.path().join("repos");
        fs::create_dir_all(repos_root.join("ez-commerce/src")).unwrap();
        fs::write(
            repos_root.join("ez-commerce/src/catalog_client.rs"),
            format!(
                "// See https://docs.rs/reqwest for details.\nfn new() {{ let _ = std::env::var(\"{TEST_ENV_ADDON}\"); }}\n#[cfg(test)]\nmod tests {{ const TEST_URL: &str = \"https://example.com\"; }}\n"
            ),
        )
        .unwrap();
        fs::write(
            repos_root.join("ez-commerce/src/stripe.rs"),
            "const BASE: &str = \"https://api.stripe.com\";\n",
        )
        .unwrap();

        let mut services = BTreeMap::new();
        services.insert("ez-addon-api".to_owned(), axum_svc("ez-addon", Some("src/bin/api.rs")));
        services.insert("ez-commerce-api".to_owned(), axum_svc("ez-commerce", None));
        let config = GraphConfig {
            repos_root,
            services,
            env: BTreeMap::new(),
            clients: BTreeMap::new(),
            prefixes: BTreeMap::new(),
            external: Vec::new(),
        };

        let mut store = GraphStore::open_writable(&db).unwrap();
        let tx = store.begin_write().unwrap();
        tx.sync_services(&config.services).unwrap();
        tx.insert_endpoints(
            "ez-addon",
            "aaaaaaa",
            &[
                (
                    "ez-addon-api".to_owned(),
                    vec![
                        resolved_ep(HttpMethod::Get, "/catalog/v1/brands", "src/modules/catalog/mod.rs", "list_brands"),
                        resolved_ep(HttpMethod::Post, "/billing/v1/charges", "src/modules/billing/mod.rs", "create_charge"),
                        resolved_ep(HttpMethod::Get, "/shared/v1/items", "src/modules/shared/a.rs", "items_a"),
                    ],
                ),
                (
                    "ez-commerce-api".to_owned(),
                    vec![
                        resolved_ep(HttpMethod::Get, "/shared/v1/items", "src/shared/b1.rs", "items_b1"),
                        resolved_ep(HttpMethod::Get, "/shared/v1/items", "src/shared/b2.rs", "items_b2"),
                    ],
                ),
            ],
        )
        .unwrap();
        tx.insert_calls(
            "ez-commerce",
            "bbbbbbb",
            &[(
                "ez-commerce-api".to_owned(),
                vec![
                    fog_call(HttpMethod::Get, "/v1/brands", "src/catalog_client.rs"),
                    fog_call(HttpMethod::Post, "/v1/charges", "src/stripe.rs"),
                    fog_call(HttpMethod::Get, "/v1/items", "src/ambiguous.rs"),
                ],
            )],
        )
        .unwrap();
        tx.commit().unwrap();

        let mut auto_env = BTreeMap::new();
        auto_env.insert(TEST_ENV_COMMERCE.to_owned(), "ez-commerce-api".to_owned());

        let suggestions = compute_suggestions(&store, &config, &auto_env).unwrap();
        assert_eq!(
            suggestions
                .prefixes
                .get("ez-commerce:src/catalog_client.rs")
                .map(String::as_str),
            Some("/catalog")
        );
        assert_eq!(
            suggestions.env.get(TEST_ENV_ADDON).map(String::as_str),
            Some("ez-addon-api")
        );
        assert_eq!(
            suggestions.env.get(TEST_ENV_COMMERCE).map(String::as_str),
            Some("ez-commerce-api")
        );
        assert_eq!(
            suggestions.external,
            vec!["ez-commerce:src/stripe.rs".to_owned()]
        );
        assert!(!suggestions.prefixes.contains_key("ez-commerce:src/stripe.rs"));
        assert!(!suggestions.prefixes.contains_key("ez-commerce:src/ambiguous.rs"));
    }
}
