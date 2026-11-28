use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde::Serialize;
use serde_json::json;

use crate::aliases::{ensure_private_dir, read_private_file, write_private_file_atomic};
use crate::intelligence::now_ms;

use super::nginx::{self, NginxRoute};
use super::resolve::{self, ResolveInputs, canonical_token, match_service_by_hint};
use super::scan::{
    DYNAMIC_SEG, extract_url_host, is_rust_source, join_paths, matches_external_glob,
    normalize_path, strip_cfg_test, strip_comments,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestRuleKind {
    Prefix,
    Env,
    External,
}

impl SuggestRuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prefix => "prefix",
            Self::Env => "env",
            Self::External => "external",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LearningRule {
    pub kind: &'static str,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AcceptedRule {
    pub rule: LearningRule,
    pub fog_before: usize,
    pub fog_after: usize,
}

#[derive(Debug, Clone, Default)]
pub struct SafeFilterOutcome {
    pub accepted: GraphSuggestions,
    pub applied_rules: Vec<AcceptedRule>,
    pub rejected: usize,
    pub fog_before: usize,
    pub fog_after: usize,
}

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
    nginx_routes: &[NginxRoute],
) -> Result<GraphSuggestions> {
    let endpoints = store.load_all_endpoints()?;
    let fog_calls = store.unresolved_calls(None)?;
    let resolved_files = store.resolved_call_files()?;
    let repo_paths: HashMap<String, String> = store
        .list_repos()?
        .into_iter()
        .map(|r| (r.repo, r.repo_path))
        .collect();
    let nginx_hosts = nginx::known_nginx_hosts(nginx_routes);

    let external = suggest_external_files(
        config,
        &fog_calls,
        &resolved_files,
        &repo_paths,
        &nginx_hosts,
    );
    let external_set: HashSet<&str> = external.iter().map(String::as_str).collect();
    let prefixes = suggest_prefixes(config, &endpoints, &fog_calls, &external_set);
    let env = suggest_env_mappings(config, auto_env, &fog_calls, &repo_paths);
    Ok(GraphSuggestions {
        prefixes,
        env,
        external,
    })
}

struct CandidateRule {
    kind: SuggestRuleKind,
    key: String,
    value: String,
}

pub fn filter_safe_suggestions(
    inputs: &ResolveInputs<'_>,
    suggestions: &GraphSuggestions,
) -> SafeFilterOutcome {
    let mut working_cfg = inputs.config.clone();
    let mut working_calls = apply_external_flags(inputs.calls, &working_cfg.external);
    let mut base_targets = resolve_targets(
        &working_cfg,
        inputs,
        &working_calls,
    );
    let mut base_fog = unresolved_call_ids(&working_calls, &base_targets);
    let initial_fog = base_fog.len();
    let mut accepted = GraphSuggestions::default();
    let mut applied_rules = Vec::new();
    let mut rejected = 0usize;

    for cand in collect_candidate_rules(&working_cfg, suggestions) {
        let mut trial_cfg = working_cfg.clone();
        apply_rule_to_config(&mut trial_cfg, &cand);
        let trial_calls = if cand.kind == SuggestRuleKind::External {
            apply_external_flags(&working_calls, &trial_cfg.external)
        } else {
            working_calls.clone()
        };
        let trial_targets = resolve_targets(&trial_cfg, inputs, &trial_calls);
        let trial_fog = unresolved_call_ids(&trial_calls, &trial_targets);
        if is_safe_rule_improvement(cand.kind, &base_fog, &trial_fog, &base_targets, &trial_targets) {
            record_accepted_rule(&mut accepted, &mut applied_rules, cand, base_fog.len(), trial_fog.len());
            working_cfg = trial_cfg;
            working_calls = trial_calls;
            base_targets = trial_targets;
            base_fog = trial_fog;
        } else {
            rejected += 1;
        }
    }

    SafeFilterOutcome {
        accepted,
        applied_rules,
        rejected,
        fog_before: initial_fog,
        fog_after: base_fog.len(),
    }
}

fn resolve_targets(
    cfg: &GraphConfig,
    inputs: &ResolveInputs<'_>,
    calls: &[CallRow],
) -> HashMap<i64, BTreeSet<i64>> {
    edge_targets_by_call(&resolve::resolve_edges(&ResolveInputs {
        config: cfg,
        extra_env: inputs.extra_env,
        nginx_routes: inputs.nginx_routes,
        services: inputs.services,
        endpoints: inputs.endpoints,
        calls,
    }))
}

fn collect_candidate_rules(
    cfg: &GraphConfig,
    suggestions: &GraphSuggestions,
) -> Vec<CandidateRule> {
    let mut out = Vec::new();
    for (k, v) in &suggestions.prefixes {
        if !cfg.prefixes.contains_key(k) {
            out.push(CandidateRule {
                kind: SuggestRuleKind::Prefix,
                key: k.clone(),
                value: v.clone(),
            });
        }
    }
    for (k, v) in &suggestions.env {
        if !cfg.env.contains_key(k) {
            out.push(CandidateRule {
                kind: SuggestRuleKind::Env,
                key: k.clone(),
                value: v.clone(),
            });
        }
    }
    for entry in &suggestions.external {
        if !cfg.external.contains(entry) {
            out.push(CandidateRule {
                kind: SuggestRuleKind::External,
                key: entry.clone(),
                value: String::new(),
            });
        }
    }
    out
}

fn apply_rule_to_config(cfg: &mut GraphConfig, cand: &CandidateRule) {
    match cand.kind {
        SuggestRuleKind::Prefix => {
            cfg.prefixes.insert(cand.key.clone(), cand.value.clone());
        }
        SuggestRuleKind::Env => {
            cfg.env.insert(cand.key.clone(), cand.value.clone());
        }
        SuggestRuleKind::External => {
            cfg.external.push(cand.key.clone());
        }
    }
}

fn is_safe_rule_improvement(
    kind: SuggestRuleKind,
    base_fog: &HashSet<i64>,
    trial_fog: &HashSet<i64>,
    base_targets: &HashMap<i64, BTreeSet<i64>>,
    trial_targets: &HashMap<i64, BTreeSet<i64>>,
) -> bool {
    let resolves_fog = match kind {
        SuggestRuleKind::External => trial_fog.len() < base_fog.len(),
        SuggestRuleKind::Prefix | SuggestRuleKind::Env => {
            trial_fog.len() < base_fog.len()
                && base_fog.iter().any(|cid| trial_targets.contains_key(cid))
        }
    };
    resolves_fog && no_existing_edge_retargeted(base_targets, trial_targets)
}

fn record_accepted_rule(
    accepted: &mut GraphSuggestions,
    applied_rules: &mut Vec<AcceptedRule>,
    cand: CandidateRule,
    fog_before: usize,
    fog_after: usize,
) {
    applied_rules.push(AcceptedRule {
        rule: LearningRule {
            kind: cand.kind.as_str(),
            key: cand.key.clone(),
            value: cand.value.clone(),
        },
        fog_before,
        fog_after,
    });
    match cand.kind {
        SuggestRuleKind::Prefix => {
            accepted.prefixes.insert(cand.key, cand.value);
        }
        SuggestRuleKind::Env => {
            accepted.env.insert(cand.key, cand.value);
        }
        SuggestRuleKind::External => {
            accepted.external.push(cand.key);
        }
    }
}

pub fn backup_config_keep_last(
    cfg_path: &Path,
    backup_prefix: &str,
    max_config_bytes: u64,
    keep: usize,
) -> Result<PathBuf> {
    let raw = read_private_file(cfg_path, "system-graph config", max_config_bytes)?;
    let dir = cfg_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut ts = now_ms();
    let backup_path = loop {
        let candidate = dir.join(format!("{backup_prefix}{ts}"));
        if !candidate.exists() {
            break candidate;
        }
        ts += 1;
    };
    write_private_file_atomic(&backup_path, "system-graph config backup", &raw)?;

    let mut backups: Vec<(String, PathBuf)> = fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with(backup_prefix).then(|| (name, e.path()))
        })
        .collect();
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, old_path) in backups.into_iter().skip(keep) {
        let _ = fs::remove_file(old_path);
    }
    Ok(backup_path)
}

pub fn append_learning_log(log_path: &Path, ts: i64, rules: &[AcceptedRule]) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(log_path) {
        ensure!(
            !meta.file_type().is_symlink() && meta.is_file(),
            "refusing to append to non-regular learning log: {}",
            log_path.display()
        );
    }
    if let Some(parent) = log_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        ensure_private_dir(parent)?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(log_path)
        .with_context(|| format!("cannot open learning log {}", log_path.display()))?;
    for entry in rules {
        let line = serde_json::to_string(&json!({
            "ts": ts,
            "rule": entry.rule,
            "fog_before": entry.fog_before,
            "fog_after": entry.fog_after,
        }))?;
        writeln!(file, "{line}")?;
    }
    file.sync_all()?;
    Ok(())
}

fn no_existing_edge_retargeted(
    before: &HashMap<i64, BTreeSet<i64>>,
    after: &HashMap<i64, BTreeSet<i64>>,
) -> bool {
    before
        .iter()
        .all(|(call_id, old_targets)| after.get(call_id) == Some(old_targets))
}

fn apply_external_flags(calls: &[CallRow], external_globs: &[String]) -> Vec<CallRow> {
    calls
        .iter()
        .cloned()
        .map(|mut c| {
            c.call.external = matches_external_glob(external_globs, &c.repo, &c.file);
            c
        })
        .collect()
}

fn edge_targets_by_call(edges: &[super::store::EdgeRow]) -> HashMap<i64, BTreeSet<i64>> {
    let mut map: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for e in edges {
        map.entry(e.call_id).or_default().insert(e.endpoint_id);
    }
    map
}

fn unresolved_call_ids(
    calls: &[CallRow],
    targets: &HashMap<i64, BTreeSet<i64>>,
) -> HashSet<i64> {
    calls
        .iter()
        .filter(|c| !c.external && !targets.contains_key(&c.id))
        .map(|c| c.id)
        .collect()
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
        let env_part = call
            .base_ref
            .split_once('|')
            .map_or(call.base_ref.as_str(), |(e, _)| e);
        if is_env_var_name(env_part) {
            candidate_vars.insert(env_part.to_owned());
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
    nginx_hosts: &HashSet<String>,
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
            let host_part = call
                .base_ref
                .split_once('|')
                .map_or(call.base_ref.as_str(), |(_, h)| h);
            is_non_configured_host(host_part, &service_names, nginx_hosts)
                || extract_url_host(&call.path_raw)
                    .is_some_and(|h| is_non_configured_host(&h, &service_names, nginx_hosts))
        });
        let file_ext = !direct_ext
            && read_repo_file(config, repo_paths, &repo, &file).is_some_and(|content| {
                file_defines_external_base(&file, &content, &service_names, nginx_hosts)
            });
        if direct_ext || file_ext {
            out.insert(format!("{repo}:{file}"));
        }
    }
    out.into_iter().collect()
}

fn file_defines_external_base(
    rel_file: &str,
    content: &str,
    service_names: &[String],
    nginx_hosts: &HashSet<String>,
) -> bool {
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
                .any(|caps| is_non_configured_host(&caps[1], service_names, nginx_hosts))
    })
}

fn is_non_configured_host(
    raw: &str,
    service_names: &[String],
    nginx_hosts: &HashSet<String>,
) -> bool {
    let host = raw.split(':').next().unwrap_or(raw).trim().to_ascii_lowercase();
    if host.is_empty()
        || !host.contains('.')
        || host.contains('{')
        || host.contains(' ')
        || LOCAL_HOSTS.contains(&host.as_str())
        || nginx_hosts.contains(&host)
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
        ExtractedEndpoint::simple(method, path, file, 10, handler, PrefixState::Resolved)
    }

    fn fog_call(method: HttpMethod, path: &str, file: &str) -> ExtractedCall {
        ExtractedCall::simple(method, path, file, 10, "self.base_url", "call", "call")
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
        let config = GraphConfig::with_services(repos_root, services);

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

        let suggestions = compute_suggestions(&store, &config, &auto_env, &[]).unwrap();
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

    #[test]
    fn safe_filter_refuses_rule_that_would_retarget_existing_edge() {
        let mut services = BTreeMap::new();
        services.insert("svc-a".to_owned(), axum_svc("repo-a", None));
        services.insert("svc-b".to_owned(), axum_svc("repo-b", None));
        let config = GraphConfig::with_services(std::path::PathBuf::from("/tmp"), services);
        let endpoints = vec![
            EndpointRow {
                id: 1,
                service: "svc-a".to_owned(),
                repo: "repo-a".to_owned(),
                verified_sha: "aaaaaaa".to_owned(),
                ep: resolved_ep(HttpMethod::Get, "/api/v1/orders", "src/a.rs", "orders_a"),
            },
            EndpointRow {
                id: 2,
                service: "svc-b".to_owned(),
                repo: "repo-b".to_owned(),
                verified_sha: "bbbbbbb".to_owned(),
                ep: resolved_ep(HttpMethod::Get, "/pref/api/v1/orders", "src/b.rs", "orders_b"),
            },
            EndpointRow {
                id: 3,
                service: "svc-b".to_owned(),
                repo: "repo-b".to_owned(),
                verified_sha: "bbbbbbb".to_owned(),
                ep: resolved_ep(HttpMethod::Get, "/pref/v1/extra", "src/b.rs", "extra_b"),
            },
        ];
        let calls = vec![
            CallRow {
                id: 10,
                service: "svc-c".to_owned(),
                repo: "repo-c".to_owned(),
                verified_sha: "ccccccc".to_owned(),
                call: fog_call(HttpMethod::Get, "/api/v1/orders", "src/mixed.rs"),
            },
            CallRow {
                id: 11,
                service: "svc-c".to_owned(),
                repo: "repo-c".to_owned(),
                verified_sha: "ccccccc".to_owned(),
                call: fog_call(HttpMethod::Get, "/v1/extra", "src/mixed.rs"),
            },
        ];
        let mut suggestions = GraphSuggestions::default();
        suggestions
            .prefixes
            .insert("repo-c:src/mixed.rs".to_owned(), "/pref".to_owned());

        let empty_env = BTreeMap::new();
        let outcome = filter_safe_suggestions(
            &ResolveInputs {
                config: &config,
                extra_env: &empty_env,
                nginx_routes: &[],
                services: &[],
                endpoints: &endpoints,
                calls: &calls,
            },
            &suggestions,
        );
        assert!(outcome.accepted.prefixes.is_empty());
        assert_eq!(outcome.applied_rules.len(), 0);
        assert_eq!(outcome.rejected, 1);
        assert_eq!(outcome.fog_before, 1);
        assert_eq!(outcome.fog_after, 1);
    }

    #[test]
    fn backup_config_rotates_to_last_five() {
        let tmp = TempDir::new().unwrap();
        let cfg = tmp.path().join("system-graph.json");
        fs::write(&cfg, "{\"repos_root\":\"/tmp\",\"services\":{}}\n").unwrap();

        for _ in 0..7 {
            backup_config_keep_last(&cfg, "system-graph.json.bak.", 256 * 1024, 5).unwrap();
        }
        let count = fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("system-graph.json.bak.")
            })
            .count();
        assert_eq!(count, 5);
    }
}
