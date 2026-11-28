use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::intelligence::now_ms;

use super::axum::{self, AxumServiceContext};
use super::chunks;
use super::contracts::{
    AlertTarget, BreakingAlert, BreakingKind, CallerSite, ContractChangeAlert,
    diff_payload_contracts,
};
use super::express;
use super::hono;
use super::nginx::{self, NginxRoute};
use super::query;
use super::resolve;
use super::rust_client;
use super::scan;
use super::store::{
    CallRow, EdgeLogicalKey, EdgeUpdateBatch, EndpointRow, ExistingEdgeSnapshot, FileHashRow,
    GraphStore, GraphWriteTx, RepoRow, ServiceRow, lock_graph_file,
};
use super::ts_client::{self, TsServiceSpec, WrapperEndpoint};
use super::types::{
    EXTRACTOR_VERSION, ExtractedCall, ExtractedChunk, ExtractedEndpoint, GraphConfig, HttpMethod,
    PrefixState, RefreshStatus, ServiceConfig, Stack, TOUCH_MAX_BYTES,
};
use super::web_client;

pub(crate) const META_CONFIG_HASH: &str = "config_hash";

type TouchTargets = (BTreeMap<String, BTreeSet<String>>, Vec<(String, String)>);
type HashDiff = (Vec<(String, String, String)>, Vec<(String, String)>, usize);
type AxumFileExtract = (
    String,
    String,
    String,
    Vec<ExtractedChunk>,
    Vec<ExtractedEndpoint>,
    bool,
    Vec<ExtractedCall>,
);

const GENERIC_HANDLERS: &[&str] = &[
    "",
    "<closure>",
    "<unknown>",
    "<expr>",
    "hono_handler",
    "express_handler",
];

#[derive(Debug, Clone, Default)]
struct SyncDelta {
    edges_added: usize,
    edges_removed: usize,
    chunks_changed: usize,
    changed_chunk_ids_by_file: HashMap<(String, String), HashSet<i64>>,
    breaking: Vec<BreakingAlert>,
    contract_changes: Vec<ContractChangeAlert>,
}

struct PreWriteSnapshot {
    old_endpoints: Vec<EndpointRow>,
    old_snapshots: Vec<ExistingEdgeSnapshot>,
    old_unresolved: HashSet<(String, String, HttpMethod, String)>,
}

#[derive(Debug, Clone)]
pub struct TouchReport {
    pub impact_text: String,
    pub json_value: Value,
}

struct RepoPlan {
    repo_row: RepoRow,
    status: RefreshStatus,
    files_scanned: usize,
    files_skipped: usize,
    full_services: Vec<String>,
    removed_services: Vec<String>,
    rescanned_services: Vec<String>,
    deleted_files: Vec<String>,
    removed_files: Vec<String>,
    changed_files: Vec<String>,
    service_endpoints: Vec<(String, Vec<ExtractedEndpoint>)>,
    service_calls: Vec<(String, Vec<ExtractedCall>)>,
    file_chunks: Vec<(String, Vec<ExtractedChunk>)>,
    file_hashes: Vec<FileHashRow>,
    content_only_hash_updates: Vec<(String, String)>,
    edited_touch_files: HashSet<String>,
    meta_updates: Vec<(String, String)>,
    compose_env_changed: bool,
    nginx_routes_changed: bool,
    is_initial_scan: bool,
}

impl RepoPlan {
    fn new(
        repo_row: RepoRow,
        status: RefreshStatus,
        is_initial_scan: bool,
        files_skipped: usize,
    ) -> Self {
        Self {
            repo_row,
            status,
            files_scanned: 0,
            files_skipped,
            full_services: Vec::new(),
            removed_services: Vec::new(),
            rescanned_services: Vec::new(),
            deleted_files: Vec::new(),
            removed_files: Vec::new(),
            changed_files: Vec::new(),
            service_endpoints: Vec::new(),
            service_calls: Vec::new(),
            file_chunks: Vec::new(),
            file_hashes: Vec::new(),
            content_only_hash_updates: Vec::new(),
            edited_touch_files: HashSet::new(),
            meta_updates: Vec::new(),
            compose_env_changed: false,
            nginx_routes_changed: false,
            is_initial_scan,
        }
    }

    fn skipped(repo_row: RepoRow, files_skipped: usize) -> Self {
        Self::new(repo_row, RefreshStatus::Skipped, false, files_skipped)
    }

    fn active(repo_row: RepoRow, is_initial: bool, files_skipped: usize) -> Self {
        let status = if is_initial {
            RefreshStatus::Full
        } else {
            RefreshStatus::Incremental
        };
        Self::new(repo_row, status, is_initial, files_skipped)
    }

    fn push_file_hash(
        &mut self,
        file: String,
        content_hash: String,
        service: String,
        has_router_deps: bool,
        norm_file_hash: String,
    ) {
        self.file_hashes.push(FileHashRow {
            file,
            content_hash,
            service,
            has_router_deps,
            norm_file_hash,
        });
    }
}

struct RefreshSummary {
    scanned: usize,
    skipped: usize,
    files_scanned: usize,
    files_skipped: usize,
    services_rescanned: Vec<String>,
    repo_status: BTreeMap<String, Value>,
    any_work: bool,
}

struct ServiceWork<'a> {
    repo_name: &'a str,
    canon_dir: &'a Path,
    svc_name: &'a str,
    svc_cfg: &'a ServiceConfig,
    changed: &'a [(String, String)],
    removed: &'a [String],
    mark_rescanned: bool,
}

pub fn refresh_graph(
    config: &GraphConfig,
    config_hash: &str,
    graph_db: &Path,
) -> Result<Value> {
    let started = Instant::now();
    let _lock = lock_graph_file(graph_db)?;
    let mut store = GraphStore::open_writable(graph_db)?;

    let repos_services = group_services_by_repo(config);
    let active_repos: HashSet<String> = repos_services.keys().cloned().collect();
    let config_changed =
        store.get_meta(META_CONFIG_HASH)?.as_deref() != Some(config_hash);
    let refreshed_at = now_ms();

    let (plans, repo_meta_changed) =
        build_refresh_plans(&store, config, &repos_services, config_changed)?;
    let summary = summarize_plans(&plans);
    let has_removed_repos = store
        .list_repos()?
        .iter()
        .any(|r| !active_repos.contains(&r.repo));

    let delta = if summary.any_work || config_changed || has_removed_repos || repo_meta_changed {
        commit_refresh_plans(
            &mut store,
            config,
            config_hash,
            &active_repos,
            &plans,
            summary.any_work,
            config_changed,
            refreshed_at,
        )?
    } else {
        SyncDelta::default()
    };

    let counts = store.counts()?;
    Ok(json!({
        "scanned": summary.scanned,
        "skipped": summary.skipped,
        "files_scanned": summary.files_scanned,
        "files_skipped": summary.files_skipped,
        "services_rescanned": summary.services_rescanned,
        "endpoints": counts.endpoints,
        "calls": counts.calls,
        "edges": counts.edges,
        "chunks": counts.chunks,
        "chunks_by_repo": counts.chunks_by_repo,
        "chunks_changed": delta.chunks_changed,
        "fog": counts.fog,
        "fog_by_repo": counts.fog_by_repo,
        "breaking": delta.breaking,
        "contract_changes": delta.contract_changes,
        "repos": summary.repo_status,
        "elapsed_ms": started.elapsed().as_millis(),
    }))
}

fn build_refresh_plans(
    store: &GraphStore,
    config: &GraphConfig,
    repos_services: &BTreeMap<String, Vec<(String, ServiceConfig)>>,
    config_changed: bool,
) -> Result<(Vec<RepoPlan>, bool)> {
    let mut probe_inputs = Vec::with_capacity(repos_services.len());
    for (repo_name, svcs) in repos_services {
        probe_inputs.push(RepoProbeInput {
            repo_name: repo_name.clone(),
            repo_dir: config.repos_root.join(repo_name),
            existing: store.get_repo(repo_name)?,
            stored_count: store.count_file_hashes(repo_name)?,
            removed_services: find_removed_repo_services(store, repo_name, svcs)?,
        });
    }
    let probes = probe_repos_parallel(&probe_inputs, config_changed)?;
    let mut plans = Vec::with_capacity(repos_services.len());
    let mut repo_meta_changed = false;
    for (input, probe) in probe_inputs.into_iter().zip(probes) {
        let svcs = &repos_services[&input.repo_name];
        let plan = plan_repo_refresh(store, config, input, probe, svcs, config_changed)?;
        if plan_repo_meta_changed(&plan, store)? {
            repo_meta_changed = true;
        }
        plans.push(plan);
    }
    Ok((plans, repo_meta_changed))
}

#[allow(clippy::too_many_arguments)]
fn commit_refresh_plans(
    store: &mut GraphStore,
    config: &GraphConfig,
    config_hash: &str,
    active_repos: &HashSet<String>,
    plans: &[RepoPlan],
    any_work: bool,
    config_changed: bool,
    refreshed_at: i64,
) -> Result<SyncDelta> {
    let tx = store.begin_write()?;
    let (pruned, _) = tx.prune_removed_repos(active_repos, refreshed_at)?;
    if config_changed || pruned || any_work {
        tx.sync_services(&config.services)?;
    }
    let full_resolve = needs_full_resolve(plans, config_changed, pruned);
    let delta = if any_work || config_changed || pruned {
        let active_plans: Vec<&RepoPlan> = plans
            .iter()
            .filter(|p| p.status != RefreshStatus::Skipped)
            .collect();
        let d = apply_plans_and_resolve(
            &tx,
            config,
            active_repos,
            &active_plans,
            full_resolve,
            config_changed,
            refreshed_at,
        )?;
        for plan in plans {
            if plan.status == RefreshStatus::Skipped {
                tx.upsert_repo(&plan.repo_row, refreshed_at)?;
            }
        }
        tx.set_meta(META_CONFIG_HASH, config_hash)?;
        d
    } else {
        for plan in plans {
            tx.upsert_repo(&plan.repo_row, refreshed_at)?;
        }
        SyncDelta::default()
    };
    tx.commit()?;
    Ok(delta)
}

pub fn verify_repo(
    config: &GraphConfig,
    graph_db: &Path,
    repo: &str,
    sha_override: Option<&str>,
) -> Result<Value> {
    let _lock = lock_graph_file(graph_db)?;
    let mut store = GraphStore::open_writable(graph_db)?;
    let Some(repo_row) = store.get_repo(repo)? else {
        anyhow::bail!("repo not indexed in system graph: {repo}");
    };
    let repo_dir = config.repos_root.join(repo);
    let target_sha = match sha_override {
        Some(raw) => resolve_sha_arg(&repo_dir, raw),
        None => scan::git_head(&repo_dir).unwrap_or_else(|_| repo_row.head_sha.clone()),
    };
    let verified_at = now_ms();
    let tx = store.begin_write()?;
    let verified_edges = tx.verify_repo_edges(repo, &target_sha, verified_at)?;
    tx.commit()?;
    Ok(json!({
        "repo": repo,
        "sha": target_sha,
        "verified_edges": verified_edges,
        "verified_at": verified_at,
    }))
}

fn resolve_sha_arg(repo_dir: &Path, raw: &str) -> String {
    let trimmed = raw.trim();
    if repo_dir.is_dir()
        && let Ok(out) = std::process::Command::new("git")
            .arg("-C")
            .arg(repo_dir)
            .args(["rev-parse", "--verify", trimmed])
            .output()
        && out.status.success()
    {
        let resolved = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if !resolved.is_empty() {
            return resolved;
        }
    }
    trimmed.to_owned()
}

pub fn touch_paths(
    config: &GraphConfig,
    config_hash: &str,
    graph_db: &Path,
    paths: &[PathBuf],
) -> Result<TouchReport> {
    let started = Instant::now();
    let _lock = lock_graph_file(graph_db)?;
    let mut store = GraphStore::open_writable(graph_db)?;

    let repos_services = group_services_by_repo(config);
    let active_repos: HashSet<String> = repos_services.keys().cloned().collect();
    let repo_roots = canonical_repo_roots(config, &repos_services);
    let (targets_by_repo, touched_pairs) = collect_touch_targets(paths, config, &repo_roots);

    if targets_by_repo.is_empty() {
        return Ok(empty_touch_report(started.elapsed().as_millis()));
    }

    let refreshed_at = now_ms();
    let mut plans = Vec::new();
    for (repo_name, rel_set) in &targets_by_repo {
        if let (Some(svcs), Some(canon_dir)) =
            (repos_services.get(repo_name), repo_roots.get(repo_name))
        {
            let rel_list: Vec<String> = rel_set.iter().cloned().collect();
            plans.push(plan_repo_touch(
                &store, config, repo_name, canon_dir, svcs, &rel_list,
            )?);
        }
    }

    let files_scanned: usize = plans.iter().map(|p| p.files_scanned).sum();
    let services_rescanned = collect_rescanned_services(&plans);
    let plan_refs: Vec<&RepoPlan> = plans
        .iter()
        .filter(|p| p.status != RefreshStatus::Skipped)
        .collect();
    let full_resolve = plan_refs
        .iter()
        .any(|p| p.compose_env_changed || p.nginx_routes_changed || p.is_initial_scan);

    let delta = if !plan_refs.is_empty() {
        let tx = store.begin_write()?;
        if tx.load_all_services()?.is_empty() {
            tx.sync_services(&config.services)?;
        }
        let d = apply_plans_and_resolve(
            &tx,
            config,
            &active_repos,
            &plan_refs,
            full_resolve,
            false,
            refreshed_at,
        )?;
        if tx.get_meta(META_CONFIG_HASH)?.is_none() {
            tx.set_meta(META_CONFIG_HASH, config_hash)?;
        }
        tx.commit()?;
        d
    } else {
        SyncDelta::default()
    };

    let edited_touch_files: HashSet<(String, String)> = plans
        .iter()
        .flat_map(|p| {
            p.edited_touch_files
                .iter()
                .map(|f| (p.repo_row.repo.clone(), f.clone()))
        })
        .collect();
    let (impact_text, cross_repo_edges) = build_touch_impact(
        &store,
        &touched_pairs,
        &edited_touch_files,
        &delta.changed_chunk_ids_by_file,
        &delta.breaking,
        &delta.contract_changes,
    )?;
    let elapsed_ms = started.elapsed().as_millis();
    Ok(TouchReport {
        impact_text: impact_text.clone(),
        json_value: json!({
            "files_scanned": files_scanned,
            "services_rescanned": services_rescanned,
            "chunks_changed": delta.chunks_changed,
            "edges_added": delta.edges_added,
            "edges_removed": delta.edges_removed,
            "cross_repo_edges": cross_repo_edges,
            "breaking": delta.breaking,
            "contract_changes": delta.contract_changes,
            "impact": impact_text,
            "elapsed_ms": elapsed_ms,
        }),
    })
}

fn needs_full_resolve(plans: &[RepoPlan], config_changed: bool, pruned: bool) -> bool {
    config_changed
        || pruned
        || plans.iter().any(|p| {
            p.compose_env_changed
                || p.nginx_routes_changed
                || p.is_initial_scan
                || !p.removed_services.is_empty()
        })
}

fn empty_touch_report(elapsed_ms: u128) -> TouchReport {
    TouchReport {
        impact_text: String::new(),
        json_value: json!({
            "files_scanned": 0,
            "services_rescanned": [],
            "chunks_changed": 0,
            "edges_added": 0,
            "edges_removed": 0,
            "cross_repo_edges": 0,
            "breaking": [],
            "contract_changes": [],
            "impact": "",
            "elapsed_ms": elapsed_ms,
        }),
    }
}

fn canonical_repo_roots(
    config: &GraphConfig,
    repos_services: &BTreeMap<String, Vec<(String, ServiceConfig)>>,
) -> BTreeMap<String, PathBuf> {
    let mut map = BTreeMap::new();
    for repo in repos_services.keys() {
        if let Ok(canon) = config.repos_root.join(repo).canonicalize() {
            map.insert(repo.clone(), canon);
        }
    }
    map
}

fn collect_touch_targets(
    paths: &[PathBuf],
    config: &GraphConfig,
    repo_roots: &BTreeMap<String, PathBuf>,
) -> TouchTargets {
    let mut by_repo: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut pairs = Vec::new();
    for raw_path in paths {
        if let Some((repo, rel)) = map_path_to_repo(raw_path, config, repo_roots)
            && by_repo
                .entry(repo.clone())
                .or_default()
                .insert(rel.clone())
        {
            pairs.push((repo, rel));
        }
    }
    (by_repo, pairs)
}

fn build_touch_impact(
    store: &GraphStore,
    touched_pairs: &[(String, String)],
    edited_touch_files: &HashSet<(String, String)>,
    changed_chunk_ids_by_file: &HashMap<(String, String), HashSet<i64>>,
    breaking: &[BreakingAlert],
    contract_changes: &[ContractChangeAlert],
) -> Result<(String, usize)> {
    let mut impact_items = Vec::new();
    let mut cross_repo_edges = 0usize;
    let empty_ids = HashSet::new();
    for (repo, file) in touched_pairs {
        let key = (repo.clone(), file.clone());
        let (served, called) = if edited_touch_files.contains(&key) {
            let ids = changed_chunk_ids_by_file.get(&key).unwrap_or(&empty_ids);
            store.cross_repo_edges_for_changed_chunks(repo, file, ids)?
        } else {
            store.cross_repo_edges_for_file(repo, file)?
        };
        cross_repo_edges += served.len() + called.len();
        if !served.is_empty() || !called.is_empty() {
            impact_items.push((repo.clone(), file.clone(), served, called));
        }
    }
    Ok((
        query::format_touch_output(breaking, contract_changes, &impact_items, TOUCH_MAX_BYTES),
        cross_repo_edges,
    ))
}

fn summarize_plans(plans: &[RepoPlan]) -> RefreshSummary {
    let mut scanned = 0usize;
    let mut skipped = 0usize;
    let mut files_scanned = 0usize;
    let mut files_skipped = 0usize;
    let mut repo_status = BTreeMap::new();
    let mut any_work = false;
    for plan in plans {
        files_scanned += plan.files_scanned;
        files_skipped += plan.files_skipped;
        if plan.status == RefreshStatus::Skipped {
            skipped += 1;
        } else {
            scanned += 1;
            any_work = true;
        }
        repo_status.insert(
            plan.repo_row.repo.clone(),
            json!({
                "status": plan.status.as_str(),
                "head_sha": plan.repo_row.head_sha,
                "dirty": plan.repo_row.dirty,
                "files_scanned": plan.files_scanned,
                "files_skipped": plan.files_skipped,
                "services_rescanned": plan.rescanned_services,
            }),
        );
    }
    RefreshSummary {
        scanned,
        skipped,
        files_scanned,
        files_skipped,
        services_rescanned: collect_rescanned_services(plans),
        repo_status,
        any_work,
    }
}

fn collect_rescanned_services(plans: &[RepoPlan]) -> Vec<String> {
    plans
        .iter()
        .flat_map(|p| p.rescanned_services.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn group_services_by_repo(config: &GraphConfig) -> BTreeMap<String, Vec<(String, ServiceConfig)>> {
    let mut map: BTreeMap<String, Vec<(String, ServiceConfig)>> = BTreeMap::new();
    for (svc_name, svc_cfg) in &config.services {
        map.entry(svc_cfg.repo.clone())
            .or_default()
            .push((svc_name.clone(), svc_cfg.clone()));
    }
    map
}

fn map_path_to_repo(
    path: &Path,
    config: &GraphConfig,
    repo_roots: &BTreeMap<String, PathBuf>,
) -> Option<(String, String)> {
    let raw = path.to_string_lossy().replace('\\', "/");
    if let Some((repo, rel)) = raw.split_once(':')
        && repo_roots.contains_key(repo)
    {
        return Some((repo.to_owned(), rel.trim_start_matches('/').to_owned()));
    }
    if !path.is_absolute() {
        for repo in repo_roots.keys() {
            if let Some(rel) = raw.strip_prefix(&format!("{repo}/")) {
                return Some((repo.clone(), rel.to_owned()));
            }
        }
    }
    let resolved = canonicalize_or_parent(path);
    if let Some(hit) = match_against_roots(&resolved, repo_roots) {
        return Some(hit);
    }
    let under_root = canonicalize_or_parent(&config.repos_root.join(path));
    match_against_roots(&under_root, repo_roots)
}

fn match_against_roots(
    resolved: &Path,
    repo_roots: &BTreeMap<String, PathBuf>,
) -> Option<(String, String)> {
    for (repo, canon_root) in repo_roots {
        if let Ok(rel) = resolved.strip_prefix(canon_root) {
            return Some((repo.clone(), rel.to_string_lossy().replace('\\', "/")));
        }
    }
    None
}

fn canonicalize_or_parent(path: &Path) -> PathBuf {
    if let Ok(canon) = path.canonicalize() {
        return canon;
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    if let (Some(parent), Some(name)) = (abs.parent(), abs.file_name())
        && let Ok(canon_parent) = parent.canonicalize()
    {
        return canon_parent.join(name);
    }
    abs
}

fn service_for_file<'a>(
    rel: &str,
    svcs: &'a [(String, ServiceConfig)],
) -> Option<(&'a str, &'a ServiceConfig)> {
    if scan::is_test_file(rel) {
        return None;
    }
    svcs.iter()
        .filter(|(_, cfg)| {
            scan::under_root(rel, &cfg.root)
                && match cfg.stack {
                    Stack::Axum => scan::is_rust_source(rel),
                    Stack::Spa | Stack::Hono | Stack::Express => scan::is_ts_source(rel),
                    Stack::Nginx => scan::is_nginx_conf(rel),
                    Stack::Web => scan::is_web_source(rel),
                }
        })
        .max_by_key(|(_, cfg)| cfg.root.len())
        .map(|(name, cfg)| (name.as_str(), cfg))
}

fn is_service_special_file(rel: &str, svc: &ServiceConfig) -> bool {
    match svc.stack {
        Stack::Axum | Stack::Hono | Stack::Express => svc
            .entry
            .as_deref()
            .is_some_and(|e| scan::qualify_under_root(&svc.root, e) == rel),
        Stack::Spa => svc
            .client
            .as_deref()
            .is_some_and(|c| scan::qualify_under_root(&svc.root, c) == rel),
        Stack::Nginx => true,
        Stack::Web => false,
    }
}

fn can_fast_skip(
    existing: Option<&RepoRow>,
    head_sha: &str,
    dirty: bool,
    stored_count: usize,
) -> bool {
    existing.is_some_and(|ex| {
        ex.head_sha == head_sha
            && ex.extractor_ver == EXTRACTOR_VERSION
            && !ex.dirty
            && !dirty
            && stored_count > 0
    })
}

fn classify_scannable_files(
    all_hashes: &BTreeMap<String, String>,
    svcs: &[(String, ServiceConfig)],
) -> (BTreeMap<String, (String, String)>, Vec<String>) {
    let mut scannable = BTreeMap::new();
    let mut compose_files = Vec::new();
    for (rel, hash) in all_hashes {
        if scan::is_compose_file(rel) {
            compose_files.push(rel.clone());
            scannable.insert(rel.clone(), (hash.clone(), String::new()));
        } else if let Some((svc_name, _)) = service_for_file(rel, svcs) {
            scannable.insert(rel.clone(), (hash.clone(), svc_name.to_owned()));
        }
    }
    (scannable, compose_files)
}

fn diff_scannable_hashes(
    scannable: &BTreeMap<String, (String, String)>,
    stored: &HashMap<String, FileHashRow>,
) -> HashDiff {
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut unchanged = 0usize;
    for (rel, (hash, svc)) in scannable {
        let same = stored
            .get(rel)
            .is_some_and(|old| old.content_hash == *hash && old.service == *svc);
        if same {
            unchanged += 1;
        } else {
            changed.push((rel.clone(), hash.clone(), svc.clone()));
        }
    }
    for (rel, old) in stored {
        if !scannable.contains_key(rel) {
            removed.push((rel.clone(), old.service.clone()));
        }
    }
    (changed, removed, unchanged)
}

fn service_config_digest(svc: &ServiceConfig) -> String {
    let payload = format!(
        "{}|{}|{}|{:?}|{:?}|{:?}",
        svc.repo,
        svc.root,
        svc.stack.as_str(),
        svc.entry,
        svc.client,
        svc.base_prefix
    );
    format!("{:x}", Sha256::digest(payload.as_bytes()))
}

fn find_removed_repo_services(
    store: &GraphStore,
    repo_name: &str,
    svcs: &[(String, ServiceConfig)],
) -> Result<Vec<String>> {
    let active: HashSet<&str> = svcs.iter().map(|(n, _)| n.as_str()).collect();
    Ok(store
        .load_all_services()?
        .into_iter()
        .filter(|s| s.repo == repo_name && !active.contains(s.name.as_str()))
        .map(|s| s.name)
        .collect())
}

fn service_config_changed(
    store: &GraphStore,
    svc_name: &str,
    svc_cfg: &ServiceConfig,
) -> Result<bool> {
    let expected = service_config_digest(svc_cfg);
    Ok(store
        .get_meta(&format!("svc_cfg_hash:{svc_name}"))?
        .as_deref()
        != Some(expected.as_str()))
}

struct RepoDiffCtx<'a> {
    store: &'a GraphStore,
    config: &'a GraphConfig,
    repo_name: &'a str,
    canon_dir: &'a Path,
    changed: &'a [(String, String, String)],
    removed: &'a [(String, String)],
    is_initial: bool,
}

struct RepoProbeInput {
    repo_name: String,
    repo_dir: PathBuf,
    existing: Option<RepoRow>,
    stored_count: usize,
    removed_services: Vec<String>,
}

struct RepoGitProbe {
    canon_dir: PathBuf,
    head_sha: String,
    wt_status: scan::GitWorkingTreeStatus,
    all_hashes: Option<BTreeMap<String, String>>,
}

fn probe_single_repo(input: &RepoProbeInput, config_changed: bool) -> Result<RepoGitProbe> {
    let canon_dir = input
        .repo_dir
        .canonicalize()
        .with_context(|| format!("repo directory missing: {}", input.repo_dir.display()))?;
    let head_sha = scan::git_head(&canon_dir)?;
    let wt_status = scan::git_status_porcelain(&canon_dir)?;
    let fast_skip = !config_changed
        && input.removed_services.is_empty()
        && can_fast_skip(input.existing.as_ref(), &head_sha, wt_status.dirty, input.stored_count);
    let all_hashes = if fast_skip {
        None
    } else {
        Some(scan::git_file_hashes_with_status(&canon_dir, &wt_status)?)
    };
    Ok(RepoGitProbe {
        canon_dir,
        head_sha,
        wt_status,
        all_hashes,
    })
}

fn probe_repos_parallel(
    inputs: &[RepoProbeInput],
    config_changed: bool,
) -> Result<Vec<RepoGitProbe>> {
    if inputs.len() <= 1 {
        return inputs
            .iter()
            .map(|inp| probe_single_repo(inp, config_changed))
            .collect();
    }
    thread::scope(|scope| {
        let handles: Vec<_> = inputs
            .iter()
            .map(|inp| scope.spawn(move || probe_single_repo(inp, config_changed)))
            .collect();
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            let res = handle
                .join()
                .map_err(|_| anyhow::anyhow!("repo probe thread panicked"))??;
            out.push(res);
        }
        Ok(out)
    })
}

fn plan_repo_meta_changed(plan: &RepoPlan, store: &GraphStore) -> Result<bool> {
    let Some(existing) = store.get_repo(&plan.repo_row.repo)? else {
        return Ok(true);
    };
    Ok(existing.head_sha != plan.repo_row.head_sha
        || existing.dirty != plan.repo_row.dirty
        || existing.extractor_ver != plan.repo_row.extractor_ver
        || existing.repo_path != plan.repo_row.repo_path)
}

fn plan_repo_refresh(
    store: &GraphStore,
    config: &GraphConfig,
    input: RepoProbeInput,
    probe: RepoGitProbe,
    svcs: &[(String, ServiceConfig)],
    config_changed: bool,
) -> Result<RepoPlan> {
    let RepoProbeInput {
        repo_name,
        existing,
        stored_count,
        removed_services,
        ..
    } = input;
    let RepoGitProbe {
        canon_dir,
        head_sha,
        wt_status,
        all_hashes,
    } = probe;

    let repo_row = RepoRow {
        repo: repo_name.clone(),
        repo_path: canon_dir.to_string_lossy().into_owned(),
        head_sha: head_sha.clone(),
        extractor_ver: EXTRACTOR_VERSION,
        dirty: wt_status.dirty,
    };

    let Some(all_hashes) = all_hashes else {
        return Ok(RepoPlan::skipped(repo_row, stored_count));
    };

    let is_initial = existing.is_none()
        || existing
            .as_ref()
            .is_some_and(|e| e.extractor_ver != EXTRACTOR_VERSION)
        || stored_count == 0;
    let stored_hashes = if is_initial {
        HashMap::new()
    } else {
        store.load_file_hashes(&repo_name)?
    };
    let (scannable, compose_files) = classify_scannable_files(&all_hashes, svcs);
    let (changed, removed, unchanged) = diff_scannable_hashes(&scannable, &stored_hashes);
    let changed_cfg_svcs = find_changed_cfg_services(store, svcs, config_changed && !is_initial)?;

    if !is_initial
        && changed.is_empty()
        && removed.is_empty()
        && removed_services.is_empty()
        && changed_cfg_svcs.is_empty()
    {
        return Ok(RepoPlan::skipped(repo_row, unchanged));
    }

    let mut plan = RepoPlan::active(repo_row, is_initial, unchanged);
    plan.removed_services = removed_services;
    let ctx = RepoDiffCtx {
        store,
        config,
        repo_name: &repo_name,
        canon_dir: &canon_dir,
        changed: &changed,
        removed: &removed,
        is_initial,
    };
    apply_compose_refresh(&ctx, &compose_files, &mut plan)?;
    plan_repo_services(&ctx, svcs, &scannable, &stored_hashes, &changed_cfg_svcs, &mut plan)?;
    Ok(plan)
}

fn plan_repo_services(
    ctx: &RepoDiffCtx<'_>,
    svcs: &[(String, ServiceConfig)],
    scannable: &BTreeMap<String, (String, String)>,
    stored_hashes: &HashMap<String, FileHashRow>,
    changed_cfg_svcs: &HashSet<String>,
    plan: &mut RepoPlan,
) -> Result<()> {
    if !plan.removed_services.is_empty() {
        for (rel, old_svc) in ctx.removed {
            if plan.removed_services.contains(old_svc) {
                plan.removed_files.push(rel.clone());
            }
        }
    }
    for (svc_name, svc_cfg) in svcs {
        let svc_changed: Vec<(String, String)> = ctx
            .changed
            .iter()
            .filter(|(_, _, s)| s == svc_name)
            .map(|(f, h, _)| (f.clone(), h.clone()))
            .collect();
        let svc_removed: Vec<String> = ctx
            .removed
            .iter()
            .filter(|(_, s)| s == svc_name)
            .map(|(f, _)| f.clone())
            .collect();
        let svc_cfg_dirty = changed_cfg_svcs.contains(svc_name);
        let incremental_eligible = !ctx.is_initial && !svc_cfg_dirty;
        let real_changed = if incremental_eligible {
            if svc_changed.is_empty() && svc_removed.is_empty() {
                continue;
            }
            let filtered = filter_meaningful_file_changes(
                ctx.store,
                ctx.repo_name,
                ctx.canon_dir,
                svc_cfg,
                &svc_changed,
                |f| stored_hashes.get(f).cloned(),
                plan,
            )?;
            if filtered.is_empty() && svc_removed.is_empty() {
                continue;
            }
            filtered
        } else {
            svc_changed
        };
        let work = ServiceWork {
            repo_name: ctx.repo_name,
            canon_dir: ctx.canon_dir,
            svc_name,
            svc_cfg,
            changed: &real_changed,
            removed: &svc_removed,
            mark_rescanned: !ctx.is_initial,
        };
        let force_full = ctx.is_initial
            || svc_cfg_dirty
            || triggers_rescan_from_stored(
                &real_changed,
                &svc_removed,
                svc_cfg,
                |f| stored_hashes.get(f).is_some_and(|r| r.has_router_deps),
            );
        process_service_work(ctx.store, ctx.config, &work, force_full, plan, || {
            let all_files: Vec<(String, String)> = scannable
                .iter()
                .filter(|(_, (_, s))| s == svc_name)
                .map(|(f, (h, _))| (f.clone(), h.clone()))
                .collect();
            let deduct = all_files.len().saturating_sub(real_changed.len());
            Ok((all_files, deduct))
        })?;
    }
    Ok(())
}

fn filter_meaningful_file_changes(
    store: &GraphStore,
    repo_name: &str,
    canon_dir: &Path,
    svc_cfg: &ServiceConfig,
    changed: &[(String, String)],
    get_stored: impl Fn(&str) -> Option<FileHashRow>,
    plan: &mut RepoPlan,
) -> Result<Vec<(String, String)>> {
    let mut meaningful = Vec::with_capacity(changed.len());
    for (rel, blob_hash) in changed {
        let Some(stored) = get_stored(rel) else {
            meaningful.push((rel.clone(), blob_hash.clone()));
            continue;
        };
        if stored.norm_file_hash.is_empty() {
            meaningful.push((rel.clone(), blob_hash.clone()));
            continue;
        }
        let Some(content) = read_service_file_text(canon_dir, rel, svc_cfg.stack) else {
            meaningful.push((rel.clone(), blob_hash.clone()));
            continue;
        };
        let norm_hash = chunks::normalize_file_hash(rel, &content, svc_cfg.stack);
        if norm_hash != stored.norm_file_hash {
            meaningful.push((rel.clone(), blob_hash.clone()));
            continue;
        }
        let is_client = is_spa_client_file(rel, svc_cfg);
        let new_chunks = chunks::extract_chunks_for_stack(rel, &content, svc_cfg.stack, is_client);
        let old_chunks = store.load_chunks_for_file(repo_name, rel)?;
        if chunks_hashes_equal(&old_chunks, &new_chunks) {
            plan.content_only_hash_updates
                .push((rel.clone(), blob_hash.clone()));
            plan.file_chunks.push((rel.clone(), new_chunks));
            plan.files_scanned += 1;
        } else {
            meaningful.push((rel.clone(), blob_hash.clone()));
        }
    }
    Ok(meaningful)
}

fn read_service_file_text(canon_dir: &Path, rel: &str, stack: Stack) -> Option<String> {
    let raw = fs::read_to_string(canon_dir.join(rel)).ok()?;
    Some(if stack == Stack::Axum {
        scan::strip_cfg_test(&raw)
    } else {
        raw
    })
}

fn is_spa_client_file(rel: &str, svc_cfg: &ServiceConfig) -> bool {
    svc_cfg.stack == Stack::Spa
        && svc_cfg
            .client
            .as_deref()
            .is_some_and(|c| scan::qualify_under_root(&svc_cfg.root, c) == rel)
}

fn chunks_hashes_equal(old: &[super::store::ChunkRow], new: &[ExtractedChunk]) -> bool {
    if old.len() != new.len() {
        return false;
    }
    let old_map: HashMap<(super::types::ChunkKind, &str), &str> = old
        .iter()
        .map(|c| ((c.kind, c.qualified_name.as_str()), c.norm_hash.as_str()))
        .collect();
    new.iter()
        .all(|c| old_map.get(&(c.kind, c.qualified_name.as_str())) == Some(&c.norm_hash.as_str()))
}

fn find_changed_cfg_services(
    store: &GraphStore,
    svcs: &[(String, ServiceConfig)],
    check: bool,
) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    if !check {
        return Ok(out);
    }
    for (svc_name, svc_cfg) in svcs {
        if service_config_changed(store, svc_name, svc_cfg)? {
            out.insert(svc_name.clone());
        }
    }
    Ok(out)
}

fn apply_compose_refresh(
    ctx: &RepoDiffCtx<'_>,
    compose_files: &[String],
    plan: &mut RepoPlan,
) -> Result<()> {
    let compose_touched = ctx.is_initial
        || ctx.changed.iter().any(|(f, _, _)| scan::is_compose_file(f))
        || ctx.removed.iter().any(|(f, _)| scan::is_compose_file(f));
    if !compose_touched {
        return Ok(());
    }
    let repo_compose_env = resolve::collect_compose_env(
        ctx.canon_dir,
        compose_files,
        &ctx.config.services,
        &ctx.config.containers,
    );
    let serialized = serde_json::to_string(&repo_compose_env)?;
    let env_key = format!("compose_env:{}", ctx.repo_name);
    if ctx.store.get_meta(&env_key)?.as_deref() != Some(serialized.as_str()) {
        plan.compose_env_changed = true;
    }
    plan.meta_updates.push((env_key, serialized));
    for (rel, hash, svc) in ctx.changed {
        if svc.is_empty() {
            plan.push_file_hash(rel.clone(), hash.clone(), String::new(), false, String::new());
            plan.files_scanned += 1;
        }
    }
    for (rel, svc) in ctx.removed {
        if svc.is_empty() {
            plan.deleted_files.push(rel.clone());
            plan.removed_files.push(rel.clone());
        }
    }
    Ok(())
}

fn plan_repo_touch(
    store: &GraphStore,
    config: &GraphConfig,
    repo_name: &str,
    canon_dir: &Path,
    svcs: &[(String, ServiceConfig)],
    rel_files: &[String],
) -> Result<RepoPlan> {
    let existing_repo = store.get_repo(repo_name)?;
    let head_sha = match &existing_repo {
        Some(row) => row.head_sha.clone(),
        None => scan::git_head(canon_dir)?,
    };
    let repo_row = RepoRow {
        repo: repo_name.to_owned(),
        repo_path: canon_dir.to_string_lossy().into_owned(),
        head_sha,
        extractor_ver: EXTRACTOR_VERSION,
        dirty: true,
    };
    let mut plan = RepoPlan::active(repo_row, existing_repo.is_none(), 0);
    let wt_hashes = scan::git_hash_objects(canon_dir, rel_files)?;
    let (mut by_changed, mut by_removed, touched_compose) =
        partition_touch_files(rel_files, &wt_hashes, svcs, &mut plan);

    if plan.compose_env_changed {
        let all_compose = merge_repo_compose_files(store, repo_name, &touched_compose, &plan.deleted_files)?;
        let env_map = resolve::collect_compose_env(
            canon_dir,
            &all_compose,
            &config.services,
            &config.containers,
        );
        plan.meta_updates.push((
            format!("compose_env:{repo_name}"),
            serde_json::to_string(&env_map)?,
        ));
    }

    let mut lazy_all_hashes: Option<BTreeMap<String, String>> = None;
    for (svc_name, svc_cfg) in svcs {
        let svc_changed = by_changed.remove(svc_name).unwrap_or_default();
        let svc_removed = by_removed.remove(svc_name).unwrap_or_default();
        if svc_changed.is_empty() && svc_removed.is_empty() {
            continue;
        }
        plan_touch_service(
            store,
            config,
            repo_name,
            canon_dir,
            svcs,
            (svc_name, svc_cfg),
            (&svc_changed, &svc_removed),
            existing_repo.is_some(),
            &mut lazy_all_hashes,
            &mut plan,
        )?;
    }
    if plan.files_scanned == 0
        && plan.deleted_files.is_empty()
        && plan.full_services.is_empty()
        && plan.content_only_hash_updates.is_empty()
        && !plan.compose_env_changed
        && !plan.nginx_routes_changed
    {
        plan.status = RefreshStatus::Skipped;
    }
    Ok(plan)
}

#[allow(clippy::too_many_arguments)]
fn plan_touch_service(
    store: &GraphStore,
    config: &GraphConfig,
    repo_name: &str,
    canon_dir: &Path,
    svcs: &[(String, ServiceConfig)],
    svc: (&str, &ServiceConfig),
    changes: (&[(String, String)], &[String]),
    has_existing_repo: bool,
    lazy_all_hashes: &mut Option<BTreeMap<String, String>>,
    plan: &mut RepoPlan,
) -> Result<()> {
    let (svc_name, svc_cfg) = svc;
    let (svc_changed, svc_removed) = changes;
    let stored_map = load_touch_stored_hashes(store, repo_name, svc_changed, plan)?;
    let real_changed = if has_existing_repo {
        filter_meaningful_file_changes(
            store,
            repo_name,
            canon_dir,
            svc_cfg,
            svc_changed,
            |f| stored_map.get(f).cloned(),
            plan,
        )?
    } else {
        svc_changed.to_vec()
    };
    if real_changed.is_empty() && svc_removed.is_empty() {
        return Ok(());
    }
    let work = ServiceWork {
        repo_name,
        canon_dir,
        svc_name,
        svc_cfg,
        changed: &real_changed,
        removed: svc_removed,
        mark_rescanned: has_existing_repo,
    };
    let force_full = triggers_rescan_from_stored(
        &real_changed,
        svc_removed,
        svc_cfg,
        |f| stored_map.get(f).is_some_and(|r| r.has_router_deps),
    );
    process_service_work(store, config, &work, force_full, plan, || {
        if lazy_all_hashes.is_none() {
            let st = scan::git_status_porcelain(canon_dir)?;
            *lazy_all_hashes = Some(scan::git_file_hashes_with_status(canon_dir, &st)?);
        }
        let all_files: Vec<(String, String)> = lazy_all_hashes
            .as_ref()
            .unwrap()
            .iter()
            .filter(|(rel, _)| service_for_file(rel, svcs).is_some_and(|(s, _)| s == svc_name))
            .map(|(f, h)| (f.clone(), h.clone()))
            .collect();
        Ok((all_files, 0))
    })
}

fn load_touch_stored_hashes(
    store: &GraphStore,
    repo_name: &str,
    svc_changed: &[(String, String)],
    plan: &mut RepoPlan,
) -> Result<HashMap<String, FileHashRow>> {
    let mut stored_map = HashMap::new();
    for (rel, hash) in svc_changed {
        if let Some(old) = store.get_file_hash(repo_name, rel)? {
            if old.content_hash != *hash {
                plan.edited_touch_files.insert(rel.clone());
            }
            stored_map.insert(rel.clone(), old);
        } else {
            plan.edited_touch_files.insert(rel.clone());
        }
    }
    Ok(stored_map)
}

fn merge_repo_compose_files(
    store: &GraphStore,
    repo_name: &str,
    touched_compose: &[String],
    deleted_files: &[String],
) -> Result<Vec<String>> {
    let deleted: HashSet<&str> = deleted_files.iter().map(String::as_str).collect();
    let mut compose_set: BTreeSet<String> = store
        .load_file_hashes(repo_name)?
        .into_iter()
        .filter(|(f, row)| row.service.is_empty() && !deleted.contains(f.as_str()))
        .map(|(f, _)| f)
        .collect();
    for f in touched_compose {
        compose_set.insert(f.clone());
    }
    Ok(compose_set.into_iter().collect())
}

#[allow(clippy::type_complexity)]
fn partition_touch_files(
    rel_files: &[String],
    wt_hashes: &BTreeMap<String, String>,
    svcs: &[(String, ServiceConfig)],
    plan: &mut RepoPlan,
) -> (
    BTreeMap<String, Vec<(String, String)>>,
    BTreeMap<String, Vec<String>>,
    Vec<String>,
) {
    let mut by_changed: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut by_removed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut touched_compose = Vec::new();
    for rel in rel_files {
        if scan::is_compose_file(rel) {
            if let Some(hash) = wt_hashes.get(rel) {
                touched_compose.push(rel.clone());
                plan.push_file_hash(rel.clone(), hash.clone(), String::new(), false, String::new());
                plan.files_scanned += 1;
            } else {
                plan.deleted_files.push(rel.clone());
                plan.removed_files.push(rel.clone());
            }
            plan.compose_env_changed = true;
            continue;
        }
        if let Some((svc_name, _)) = service_for_file(rel, svcs) {
            if let Some(hash) = wt_hashes.get(rel) {
                by_changed
                    .entry(svc_name.to_owned())
                    .or_default()
                    .push((rel.clone(), hash.clone()));
            } else {
                by_removed
                    .entry(svc_name.to_owned())
                    .or_default()
                    .push(rel.clone());
            }
        }
    }
    (by_changed, by_removed, touched_compose)
}

fn triggers_rescan_from_stored(
    changed: &[(String, String)],
    removed: &[String],
    svc_cfg: &ServiceConfig,
    had_router_deps: impl Fn(&str) -> bool,
) -> bool {
    changed
        .iter()
        .any(|(f, _)| is_service_special_file(f, svc_cfg) || had_router_deps(f))
        || removed
            .iter()
            .any(|f| is_service_special_file(f, svc_cfg) || had_router_deps(f))
}

fn process_service_work(
    store: &GraphStore,
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    force_full: bool,
    plan: &mut RepoPlan,
    load_all_svc_files: impl FnOnce() -> Result<(Vec<(String, String)>, usize)>,
) -> Result<()> {
    let need_full = force_full || !try_incremental_service_extract(store, config, work, plan)?;
    if need_full {
        let (all_svc_files, deduct_skipped) = load_all_svc_files()?;
        plan.files_skipped = plan.files_skipped.saturating_sub(deduct_skipped);
        extract_full_service(config, work, &all_svc_files, plan)?;
    }
    Ok(())
}

fn try_incremental_service_extract(
    store: &GraphStore,
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    plan: &mut RepoPlan,
) -> Result<bool> {
    match work.svc_cfg.stack {
        Stack::Axum => try_incremental_axum(store, config, work, plan),
        Stack::Spa => try_incremental_spa(store, config, work, plan),
        Stack::Web => try_incremental_web(store, config, work, plan),
        Stack::Hono | Stack::Nginx | Stack::Express => Ok(false),
    }
}

fn try_incremental_web(
    store: &GraphStore,
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    plan: &mut RepoPlan,
) -> Result<bool> {
    let Some(raw_exports) = store.get_meta(&format!("web_exports:{}", work.svc_name))? else {
        return Ok(false);
    };
    let Ok(exports_map) = serde_json::from_str::<web_client::WebExportsMap>(&raw_exports) else {
        return Ok(false);
    };
    let mut known: HashSet<String> = store
        .load_file_hashes(work.repo_name)?
        .into_iter()
        .filter(|(_, r)| r.service == work.svc_name)
        .map(|(f, _)| f)
        .collect();
    for (rel, _) in work.changed {
        known.insert(rel.clone());
    }
    let rel_list: Vec<String> = work.changed.iter().map(|(f, _)| f.clone()).collect();
    let (_, sources) = web_client::read_web_sources(work.canon_dir, &rel_list, &work.svc_cfg.root);
    let (calls, has_exports) = web_client::extract_sources_incremental(
        work.repo_name,
        &work.svc_cfg.root,
        work.svc_cfg.base.as_deref(),
        &config.external,
        &sources,
        &known,
        &exports_map,
    );
    if has_exports {
        return Ok(false);
    }
    let norm_hashes = record_source_chunks(plan, &sources, work.svc_cfg);
    commit_incremental_calls(plan, work, calls, &norm_hashes);
    Ok(true)
}

fn try_incremental_axum(
    store: &GraphStore,
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    plan: &mut RepoPlan,
) -> Result<bool> {
    let Some(raw_ctx) = store.get_meta(&format!("axum_ctx:{}", work.svc_name))? else {
        return Ok(false);
    };
    let Ok(axum_ctx) = serde_json::from_str::<AxumServiceContext>(&raw_ctx) else {
        return Ok(false);
    };
    let sources: Vec<(String, String, String)> =
        scan::parallel_map(work.changed, |(rel, hash)| {
            let raw = fs::read_to_string(work.canon_dir.join(rel)).unwrap_or_default();
            (rel.clone(), hash.clone(), scan::strip_cfg_test(&raw))
        });
    let extracted: Vec<AxumFileExtract> =
        scan::parallel_map(&sources, |(rel, hash, stripped)| {
            let (eps, has_deps) = axum::extract_single_file(
                rel,
                stripped,
                &work.svc_cfg.root,
                work.svc_cfg.entry.as_deref(),
                &axum_ctx,
            );
            let crate_key = axum::crate_key_for(rel, &work.svc_cfg.root);
            let local_structs = axum_ctx.structs.with_file_override(rel, &crate_key, stripped);
            let external = scan::matches_external_glob(&config.external, work.repo_name, rel);
            let calls = rust_client::extract_file_with_structs(
                rel,
                stripped,
                external,
                &crate_key,
                &local_structs,
            );
            let norm_hash = chunks::normalize_file_hash(rel, stripped, Stack::Axum);
            let file_chunks = chunks::extract_rust_chunks(stripped);
            (
                rel.clone(),
                hash.clone(),
                norm_hash,
                file_chunks,
                eps,
                has_deps,
                calls,
            )
        });
    if extracted.iter().any(|(_, _, _, _, _, has_deps, _)| *has_deps) {
        return Ok(false);
    }
    let mut eps_all = Vec::new();
    let mut calls_all = Vec::new();
    for (rel, hash, norm_hash, file_chunks, eps, _, calls) in extracted {
        eps_all.extend(eps);
        calls_all.extend(calls);
        plan.file_chunks.push((rel.clone(), file_chunks));
        record_incremental_file(plan, rel, hash, norm_hash, work.svc_name);
    }
    record_removed_files(plan, work.removed, work.changed.len());
    if !eps_all.is_empty() {
        plan.service_endpoints
            .push((work.svc_name.to_owned(), eps_all));
    }
    if !calls_all.is_empty() {
        plan.service_calls
            .push((work.svc_name.to_owned(), calls_all));
    }
    Ok(true)
}

fn try_incremental_spa(
    store: &GraphStore,
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    plan: &mut RepoPlan,
) -> Result<bool> {
    let Some(raw_wrap) = store.get_meta(&format!("ts_wrappers:{}", work.svc_name))? else {
        return Ok(false);
    };
    let Ok(wrapper_map) = serde_json::from_str::<HashMap<String, WrapperEndpoint>>(&raw_wrap)
    else {
        return Ok(false);
    };
    let rel_list: Vec<String> = work.changed.iter().map(|(f, _)| f.clone()).collect();
    let sources = scan::read_files_parallel(work.canon_dir, &rel_list);
    let spec = ts_spec(config, work);
    let calls = ts_client::extract_from_sources_with_wrappers(&spec, &sources, &wrapper_map);
    let norm_hashes = record_source_chunks(plan, &sources, work.svc_cfg);
    commit_incremental_calls(plan, work, calls, &norm_hashes);
    Ok(true)
}

fn record_source_chunks(
    plan: &mut RepoPlan,
    sources: &[(String, String)],
    svc_cfg: &ServiceConfig,
) -> HashMap<String, String> {
    let extracted: Vec<(String, String, Vec<ExtractedChunk>)> =
        scan::parallel_map(sources, |(rel, src)| {
            let is_client = is_spa_client_file(rel, svc_cfg);
            let norm = chunks::normalize_file_hash(rel, src, svc_cfg.stack);
            let file_chunks = chunks::extract_chunks_for_stack(rel, src, svc_cfg.stack, is_client);
            (rel.clone(), norm, file_chunks)
        });
    let mut norm_map = HashMap::with_capacity(extracted.len());
    for (rel, norm, file_chunks) in extracted {
        norm_map.insert(rel.clone(), norm);
        plan.file_chunks.push((rel, file_chunks));
    }
    norm_map
}

fn commit_incremental_calls(
    plan: &mut RepoPlan,
    work: &ServiceWork<'_>,
    calls: Vec<ExtractedCall>,
    norm_hashes: &HashMap<String, String>,
) {
    for (rel, hash) in work.changed {
        let norm = norm_hashes.get(rel).cloned().unwrap_or_default();
        record_incremental_file(plan, rel.clone(), hash.clone(), norm, work.svc_name);
    }
    record_removed_files(plan, work.removed, work.changed.len());
    if !calls.is_empty() {
        plan.service_calls.push((work.svc_name.to_owned(), calls));
    }
}

fn record_incremental_file(
    plan: &mut RepoPlan,
    rel: String,
    hash: String,
    norm_hash: String,
    svc_name: &str,
) {
    plan.changed_files.push(rel.clone());
    plan.deleted_files.push(rel.clone());
    plan.push_file_hash(rel, hash, svc_name.to_owned(), false, norm_hash);
}

fn record_removed_files(plan: &mut RepoPlan, removed: &[String], scanned_count: usize) {
    for rem in removed {
        plan.deleted_files.push(rem.clone());
        plan.removed_files.push(rem.clone());
    }
    plan.files_scanned += scanned_count;
}

fn ts_spec<'a>(config: &'a GraphConfig, work: &ServiceWork<'a>) -> TsServiceSpec<'a> {
    TsServiceSpec {
        repo: work.repo_name,
        repo_dir: work.canon_dir,
        service_root: &work.svc_cfg.root,
        client_rel: work.svc_cfg.client.as_deref(),
        base_service: work.svc_cfg.base.as_deref(),
        base_prefix: work.svc_cfg.base_prefix.as_deref(),
        external_globs: &config.external,
    }
}

fn extract_full_service(
    config: &GraphConfig,
    work: &ServiceWork<'_>,
    all_svc_files: &[(String, String)],
    plan: &mut RepoPlan,
) -> Result<()> {
    plan.full_services.push(work.svc_name.to_owned());
    if work.mark_rescanned {
        plan.rescanned_services.push(work.svc_name.to_owned());
    }
    let rel_paths: Vec<String> = all_svc_files.iter().map(|(f, _)| f.clone()).collect();
    let (dep_files, norm_hashes) = match work.svc_cfg.stack {
        Stack::Axum => {
            let sources =
                scan::read_rust_service_files(work.canon_dir, &work.svc_cfg.root, &rel_paths);
            let (endpoints, ctx, deps) = axum::extract_service_with_context(
                &sources,
                &work.svc_cfg.root,
                work.svc_cfg.entry.as_deref(),
            );
            let calls = rust_client::extract_from_sources_with_structs(
                work.repo_name,
                &config.external,
                &sources,
                &work.svc_cfg.root,
                &ctx.structs,
            );
            let norms = record_source_chunks(plan, &sources, work.svc_cfg);
            plan.meta_updates.push((
                format!("axum_ctx:{}", work.svc_name),
                serde_json::to_string(&ctx)?,
            ));
            plan.service_endpoints
                .push((work.svc_name.to_owned(), endpoints));
            plan.service_calls.push((work.svc_name.to_owned(), calls));
            (deps, norms)
        }
        Stack::Spa => {
            let spec = ts_spec(config, work);
            let sources =
                scan::read_ts_service_sources(work.canon_dir, &work.svc_cfg.root, &rel_paths);
            let client_rel_full = spec
                .client_rel
                .map(|c| scan::qualify_under_root(spec.service_root, c));
            let wrappers = client_rel_full
                .as_deref()
                .and_then(|c| sources.iter().find(|(rel, _)| rel == c).map(|(_, s)| s.as_str()))
                .map(|src| ts_client::parse_client_wrappers(src, spec.base_prefix))
                .unwrap_or_else(|| ts_client::load_service_wrappers(&spec));
            let calls = ts_client::extract_from_sources_with_wrappers(&spec, &sources, &wrappers);
            let norms = record_source_chunks(plan, &sources, work.svc_cfg);
            plan.meta_updates.push((
                format!("ts_wrappers:{}", work.svc_name),
                serde_json::to_string(&wrappers)?,
            ));
            plan.service_calls.push((work.svc_name.to_owned(), calls));
            (HashSet::new(), norms)
        }
        Stack::Hono => {
            let sources =
                scan::read_ts_service_sources(work.canon_dir, &work.svc_cfg.root, &rel_paths);
            let (endpoints, deps) = hono::extract_from_sources(
                &sources,
                &work.svc_cfg.root,
                work.svc_cfg.entry.as_deref(),
            );
            let norms = record_source_chunks(plan, &sources, work.svc_cfg);
            plan.service_endpoints
                .push((work.svc_name.to_owned(), endpoints));
            (deps, norms)
        }
        Stack::Nginx => {
            let routes = nginx::extract_service(work.canon_dir, &work.svc_cfg.root, &rel_paths)?;
            let serialized = serde_json::to_string(&routes)?;
            plan.meta_updates
                .push((format!("nginx_routes:{}", work.svc_name), serialized));
            plan.nginx_routes_changed = true;
            (rel_paths.iter().cloned().collect(), HashMap::new())
        }
        Stack::Web => {
            let (candidates, sources) =
                web_client::read_web_sources(work.canon_dir, &rel_paths, &work.svc_cfg.root);
            let (calls, exports_map, deps) = web_client::extract_from_sources_with_exports(
                work.repo_name,
                &work.svc_cfg.root,
                work.svc_cfg.base.as_deref(),
                &config.external,
                candidates,
                &sources,
            );
            let norms = record_source_chunks(plan, &sources, work.svc_cfg);
            plan.meta_updates.push((
                format!("web_exports:{}", work.svc_name),
                serde_json::to_string(&exports_map)?,
            ));
            plan.service_calls.push((work.svc_name.to_owned(), calls));
            (deps, norms)
        }
        Stack::Express => {
            let sources =
                scan::read_ts_service_sources(work.canon_dir, &work.svc_cfg.root, &rel_paths);
            let (endpoints, deps) = express::extract_from_sources(&sources);
            let norms = record_source_chunks(plan, &sources, work.svc_cfg);
            plan.service_endpoints
                .push((work.svc_name.to_owned(), endpoints));
            (deps, norms)
        }
    };
    for rem in work.removed {
        plan.removed_files.push(rem.clone());
    }
    plan.meta_updates.push((
        format!("svc_cfg_hash:{}", work.svc_name),
        service_config_digest(work.svc_cfg),
    ));
    for (rel, hash) in all_svc_files {
        plan.push_file_hash(
            rel.clone(),
            hash.clone(),
            work.svc_name.to_owned(),
            dep_files.contains(rel),
            norm_hashes.get(rel).cloned().unwrap_or_default(),
        );
    }
    plan.files_scanned += all_svc_files.len();
    Ok(())
}

fn apply_plans_and_resolve(
    tx: &GraphWriteTx<'_>,
    config: &GraphConfig,
    active_repos: &HashSet<String>,
    plans: &[&RepoPlan],
    full_resolve: bool,
    config_changed: bool,
    now_ms: i64,
) -> Result<SyncDelta> {
    let (changed_repos, affected_files, full_services) = collect_plan_scopes(plans);
    let mut pre = snapshot_before_write(tx, full_resolve, &affected_files, &full_services)?;

    let (chunks_changed, changed_chunk_ids_by_file) = write_plans_to_tx(tx, plans, now_ms)?;
    if config_changed {
        tx.update_calls_external_flags(&config.external)?;
    }

    let auto_env = tx.load_all_compose_env(active_repos)?;
    let active_services: HashSet<String> = config.services.keys().cloned().collect();
    let nginx_routes = tx.load_all_nginx_routes(&active_services)?;
    let services = tx.load_all_services()?;
    let (edges_added, lost_snapshots, new_endpoints) = if full_resolve {
        let (added, lost) = run_full_resolve(
            tx,
            config,
            &auto_env,
            &nginx_routes,
            &services,
            &pre.old_snapshots,
            &changed_repos,
            now_ms,
        )?;
        let new_eps = load_new_endpoints_for_scope(tx, plans, &full_services)?;
        (added, lost, new_eps)
    } else {
        run_incremental_resolve(
            tx,
            config,
            &auto_env,
            &nginx_routes,
            &services,
            plans,
            &full_services,
            &pre.old_endpoints,
            &mut pre.old_snapshots,
            &changed_repos,
            now_ms,
        )?
    };
    let all_changed_chunk_ids: Vec<i64> = changed_chunk_ids_by_file
        .values()
        .flat_map(|s| s.iter().copied())
        .collect();
    tx.refresh_pair_keys_for_chunks(&all_changed_chunk_ids, now_ms)?;

    let modified_files: HashSet<(String, String)> = affected_files.into_iter().collect();
    let rescanned_svcs: HashSet<(String, String)> = full_services.into_iter().collect();
    let (breaking, breaking_reasons) = detect_breaking_changes(
        tx,
        &lost_snapshots,
        &pre.old_endpoints,
        &new_endpoints,
        &pre.old_unresolved,
        &modified_files,
        &rescanned_svcs,
    )?;
    let edges_removed = tx.record_lost_edge_history(&lost_snapshots, &breaking_reasons, now_ms)?;
    let contract_changes = detect_contract_changes(tx, &pre.old_endpoints, &new_endpoints)?;
    Ok(SyncDelta {
        edges_added,
        edges_removed,
        chunks_changed,
        changed_chunk_ids_by_file,
        breaking,
        contract_changes,
    })
}

fn collect_changed_file_pairs(plans: &[&RepoPlan]) -> Vec<(String, String)> {
    plans
        .iter()
        .flat_map(|p| {
            p.changed_files
                .iter()
                .map(|f| (p.repo_row.repo.clone(), f.clone()))
        })
        .collect()
}

fn load_new_endpoints_for_scope(
    tx: &GraphWriteTx<'_>,
    plans: &[&RepoPlan],
    full_services: &[(String, String)],
) -> Result<Vec<EndpointRow>> {
    let changed_files = collect_changed_file_pairs(plans);
    let mut out = tx.load_endpoints_for_files(&changed_files)?;
    for (repo, svc) in full_services {
        out.extend(tx.load_endpoints_for_service(repo, svc)?);
    }
    Ok(out)
}

#[allow(clippy::type_complexity)]
fn collect_plan_scopes(
    plans: &[&RepoPlan],
) -> (HashSet<String>, Vec<(String, String)>, Vec<(String, String)>) {
    let mut changed_repos = HashSet::new();
    let mut affected_files = Vec::new();
    let mut full_services = Vec::new();
    for plan in plans {
        if plan.status != RefreshStatus::Skipped {
            changed_repos.insert(plan.repo_row.repo.clone());
        }
        for svc in &plan.full_services {
            full_services.push((plan.repo_row.repo.clone(), svc.clone()));
        }
        for file in &plan.deleted_files {
            affected_files.push((plan.repo_row.repo.clone(), file.clone()));
        }
    }
    (changed_repos, affected_files, full_services)
}

fn snapshot_before_write(
    tx: &GraphWriteTx<'_>,
    full_resolve: bool,
    affected_files: &[(String, String)],
    full_services: &[(String, String)],
) -> Result<PreWriteSnapshot> {
    let mut old_endpoints = tx.load_endpoints_for_files(affected_files)?;
    let mut old_calls = tx.load_calls_for_files(affected_files)?;
    for (repo, svc) in full_services {
        old_endpoints.extend(tx.load_endpoints_for_service(repo, svc)?);
        old_calls.extend(tx.load_calls_for_service(repo, svc)?);
    }
    let old_unresolved = tx.load_unresolved_call_keys_for_scope(affected_files, full_services)?;
    let old_snapshots = if full_resolve {
        tx.snapshot_all_edges()?
    } else {
        let ep_ids: Vec<i64> = old_endpoints.iter().map(|e| e.id).collect();
        let call_ids: Vec<i64> = old_calls.iter().map(|c| c.id).collect();
        tx.snapshot_edges_for_ids(&ep_ids, &call_ids)?
    };
    Ok(PreWriteSnapshot {
        old_endpoints,
        old_snapshots,
        old_unresolved,
    })
}

#[allow(clippy::type_complexity)]
fn write_plans_to_tx(
    tx: &GraphWriteTx<'_>,
    plans: &[&RepoPlan],
    now_ms: i64,
) -> Result<(usize, HashMap<(String, String), HashSet<i64>>)> {
    let mut chunks_changed = 0usize;
    let mut changed_ids_by_file: HashMap<(String, String), HashSet<i64>> = HashMap::new();
    for plan in plans {
        let repo = &plan.repo_row.repo;
        for svc in &plan.removed_services {
            tx.delete_service(repo, svc)?;
            tx.delete_service_meta(svc)?;
        }
        for svc in &plan.full_services {
            tx.delete_service(repo, svc)?;
        }
        tx.delete_files(repo, &plan.deleted_files)?;
        chunks_changed += tx.delete_chunks_for_files(repo, &plan.removed_files, now_ms)?;
        for (file, file_chunks) in &plan.file_chunks {
            let (changed, ids) = tx.upsert_file_chunks(repo, file, file_chunks, now_ms)?;
            chunks_changed += changed;
            if !ids.is_empty() {
                changed_ids_by_file
                    .entry((repo.clone(), file.clone()))
                    .or_default()
                    .extend(ids);
            }
        }
        tx.insert_endpoints(repo, &plan.repo_row.head_sha, &plan.service_endpoints)?;
        tx.insert_calls(repo, &plan.repo_row.head_sha, &plan.service_calls)?;
        tx.upsert_file_hashes(repo, &plan.file_hashes)?;
        for (file, blob_hash) in &plan.content_only_hash_updates {
            tx.update_file_content_hash(repo, file, blob_hash)?;
        }
        for (k, v) in &plan.meta_updates {
            tx.set_meta(k, v)?;
        }
        tx.upsert_repo(&plan.repo_row, now_ms)?;
    }
    Ok((chunks_changed, changed_ids_by_file))
}

#[allow(clippy::too_many_arguments)]
fn resolve_and_write_edges(
    tx: &GraphWriteTx<'_>,
    inputs: &resolve::ResolveInputs<'_>,
    full_replace: bool,
    replace_call_ids: &[i64],
    old_snapshots: &[ExistingEdgeSnapshot],
    changed_repos: &HashSet<String>,
    now_ms: i64,
) -> Result<(usize, Vec<ExistingEdgeSnapshot>)> {
    let new_edges = resolve::resolve_edges(inputs);
    let calls_map: HashMap<i64, &CallRow> = inputs.calls.iter().map(|c| (c.id, c)).collect();
    let eps_map: HashMap<i64, &EndpointRow> = inputs.endpoints.iter().map(|e| (e.id, e)).collect();
    tx.write_edges_and_collect_lost(&EdgeUpdateBatch {
        full_replace,
        replace_call_ids,
        old_snapshots,
        new_edges: &new_edges,
        calls_by_id: &calls_map,
        eps_by_id: &eps_map,
        changed_repos,
        now_ms,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_full_resolve(
    tx: &GraphWriteTx<'_>,
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
    nginx_routes: &[NginxRoute],
    services: &[ServiceRow],
    old_snapshots: &[ExistingEdgeSnapshot],
    changed_repos: &HashSet<String>,
    now_ms: i64,
) -> Result<(usize, Vec<ExistingEdgeSnapshot>)> {
    let endpoints = tx.load_all_endpoints()?;
    let calls = tx.load_all_calls()?;
    let inputs = resolve::ResolveInputs {
        config,
        extra_env: auto_env,
        nginx_routes,
        services,
        endpoints: &endpoints,
        calls: &calls,
    };
    resolve_and_write_edges(tx, &inputs, true, &[], old_snapshots, changed_repos, now_ms)
}

#[allow(clippy::too_many_arguments)]
fn run_incremental_resolve(
    tx: &GraphWriteTx<'_>,
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
    nginx_routes: &[NginxRoute],
    services: &[ServiceRow],
    plans: &[&RepoPlan],
    full_services: &[(String, String)],
    old_endpoints: &[EndpointRow],
    old_snapshots: &mut Vec<ExistingEdgeSnapshot>,
    changed_repos: &HashSet<String>,
    now_ms: i64,
) -> Result<(usize, Vec<ExistingEdgeSnapshot>, Vec<EndpointRow>)> {
    let changed_files = collect_changed_file_pairs(plans);
    let mut new_endpoints = tx.load_endpoints_for_files(&changed_files)?;
    let mut affected_calls = tx.load_calls_for_files(&changed_files)?;
    for (repo, svc) in full_services {
        new_endpoints.extend(tx.load_endpoints_for_service(repo, svc)?);
        affected_calls.extend(tx.load_calls_for_service(repo, svc)?);
    }

    expand_affected_calls_for_endpoints(
        tx,
        config,
        auto_env,
        nginx_routes,
        services,
        old_endpoints,
        &new_endpoints,
        &mut affected_calls,
        old_snapshots,
    )?;

    if affected_calls.is_empty() && old_snapshots.is_empty() {
        return Ok((0, Vec::new(), new_endpoints));
    }

    let needed_ep_keys = collect_needed_endpoint_keys(config, nginx_routes, &affected_calls);
    let needed_endpoints = tx.load_endpoints_for_keys(&needed_ep_keys, true)?;
    let replace_call_ids: Vec<i64> = affected_calls.iter().map(|c| c.id).collect();
    let inputs = resolve::ResolveInputs {
        config,
        extra_env: auto_env,
        nginx_routes,
        services,
        endpoints: &needed_endpoints,
        calls: &affected_calls,
    };
    let (added, lost) = resolve_and_write_edges(
        tx,
        &inputs,
        false,
        &replace_call_ids,
        old_snapshots,
        changed_repos,
        now_ms,
    )?;
    Ok((added, lost, new_endpoints))
}

type ProviderBreakKey = (String, String, String, HttpMethod, String);
type ProviderBreakVal = (BreakingKind, Option<String>, Vec<CallerSite>, Option<String>);

struct BreakAnalysisCtx<'a> {
    old_ep_keys: HashSet<(&'a str, &'a str, HttpMethod, &'a str)>,
    old_handlers: HashMap<(&'a str, &'a str, HttpMethod, &'a str), &'a str>,
    new_endpoints: &'a [EndpointRow],
    old_unresolved: &'a HashSet<(String, String, HttpMethod, String)>,
    modified_files: &'a HashSet<(String, String)>,
    rescanned_services: &'a HashSet<(String, String)>,
}

impl<'a> BreakAnalysisCtx<'a> {
    fn site_touched(&self, site: &super::store::SiteRef) -> bool {
        self.modified_files
            .contains(&(site.repo.clone(), site.file.clone()))
            || self
                .rescanned_services
                .contains(&(site.repo.clone(), site.service.clone()))
    }
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn detect_breaking_changes(
    tx: &GraphWriteTx<'_>,
    lost_snapshots: &[ExistingEdgeSnapshot],
    old_endpoints: &[EndpointRow],
    new_endpoints: &[EndpointRow],
    old_unresolved: &HashSet<(String, String, HttpMethod, String)>,
    modified_files: &HashSet<(String, String)>,
    rescanned_services: &HashSet<(String, String)>,
) -> Result<(Vec<BreakingAlert>, HashMap<EdgeLogicalKey, BreakingKind>)> {
    if lost_snapshots.is_empty() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let ctx = BreakAnalysisCtx {
        old_ep_keys: old_endpoints
            .iter()
            .map(|e| (e.repo.as_str(), e.file.as_str(), e.method, e.path_norm.as_str()))
            .collect(),
        old_handlers: old_endpoints
            .iter()
            .map(|e| {
                (
                    (e.service.as_str(), e.file.as_str(), e.method, e.path_norm.as_str()),
                    e.handler.as_str(),
                )
            })
            .collect(),
        new_endpoints,
        old_unresolved,
        modified_files,
        rescanned_services,
    };

    let mut provider_groups: BTreeMap<ProviderBreakKey, ProviderBreakVal> = BTreeMap::new();
    let mut caller_alerts = Vec::new();
    let mut breaking_reasons = HashMap::new();
    let mut unresolved_cache: HashMap<(String, String), Vec<CallRow>> = HashMap::new();

    for snap in lost_snapshots {
        if record_provider_break(tx, &ctx, snap, &mut provider_groups, &mut breaking_reasons)? {
            continue;
        }
        record_caller_break(
            tx,
            &ctx,
            snap,
            &mut unresolved_cache,
            &mut caller_alerts,
            &mut breaking_reasons,
        )?;
    }

    let alerts = assemble_breaking_alerts(provider_groups, caller_alerts);
    Ok((alerts, breaking_reasons))
}

fn record_provider_break(
    tx: &GraphWriteTx<'_>,
    ctx: &BreakAnalysisCtx<'_>,
    snap: &ExistingEdgeSnapshot,
    provider_groups: &mut BTreeMap<ProviderBreakKey, ProviderBreakVal>,
    breaking_reasons: &mut HashMap<EdgeLogicalKey, BreakingKind>,
) -> Result<bool> {
    if !ctx.site_touched(&snap.target)
        || tx.endpoint_exists(
            &snap.target.service,
            &snap.target.file,
            snap.method,
            &snap.path_norm,
        )?
        || !tx.call_site_is_unresolved(
            &snap.source.repo,
            &snap.source.file,
            snap.call_method,
            &snap.call_path_norm,
        )?
    {
        return Ok(false);
    }
    let old_handler = ctx
        .old_handlers
        .get(&(
            snap.target.service.as_str(),
            snap.target.file.as_str(),
            snap.method,
            snap.path_norm.as_str(),
        ))
        .copied();
    let renamed_to = detect_likely_rename(snap, old_handler, ctx.new_endpoints, &ctx.old_ep_keys);
    let kind = if renamed_to.is_some() {
        BreakingKind::EndpointRenamed
    } else {
        BreakingKind::EndpointRemoved
    };
    breaking_reasons.insert(snap.logical_key(), kind);
    let group_key = (
        snap.target.service.clone(),
        snap.target.repo.clone(),
        snap.target.file.clone(),
        snap.method,
        snap.path_norm.clone(),
    );
    let entry = provider_groups
        .entry(group_key)
        .or_insert_with(|| (kind, renamed_to, Vec::new(), None));
    if entry.3.is_none() && !snap.verify.verified_sha.is_empty() {
        entry.3 = Some(snap.verify.verified_sha.clone());
    }
    entry.2.push(CallerSite {
        repo: snap.source.repo.clone(),
        service: snap.source.service.clone(),
        file: snap.source.file.clone(),
        line: snap.source.line,
    });
    Ok(true)
}

fn record_caller_break(
    tx: &GraphWriteTx<'_>,
    ctx: &BreakAnalysisCtx<'_>,
    snap: &ExistingEdgeSnapshot,
    unresolved_cache: &mut HashMap<(String, String), Vec<CallRow>>,
    caller_alerts: &mut Vec<BreakingAlert>,
    breaking_reasons: &mut HashMap<EdgeLogicalKey, BreakingKind>,
) -> Result<()> {
    if !ctx.site_touched(&snap.source) {
        return Ok(());
    }
    let file_key = (snap.source.repo.clone(), snap.source.file.clone());
    if !unresolved_cache.contains_key(&file_key) {
        let rows = tx.load_unresolved_calls_in_file(&snap.source.repo, &snap.source.file)?;
        unresolved_cache.insert(file_key.clone(), rows);
    }
    let Some(new_unres) = unresolved_cache
        .get(&file_key)
        .and_then(|rows| find_newly_unresolved_call(rows, snap, ctx.old_unresolved))
    else {
        return Ok(());
    };
    breaking_reasons.insert(snap.logical_key(), BreakingKind::CallUnresolved);
    caller_alerts.push(BreakingAlert {
        kind: BreakingKind::CallUnresolved,
        target: AlertTarget {
            cross_repo: snap.source.repo != snap.target.repo,
            method: snap.call_method,
            path_norm: snap.path_norm.clone(),
            provider_repo: snap.target.repo.clone(),
            provider_service: snap.target.service.clone(),
            provider_file: snap.target.file.clone(),
        },
        renamed_to: None,
        new_call_method: Some(new_unres.method),
        new_call_path: Some(new_unres.path_norm.clone()),
        callers: vec![CallerSite {
            repo: snap.source.repo.clone(),
            service: snap.source.service.clone(),
            file: snap.source.file.clone(),
            line: new_unres.line,
        }],
        last_verified_sha: (!snap.verify.verified_sha.is_empty())
            .then(|| snap.verify.verified_sha.clone()),
    });
    Ok(())
}

fn assemble_breaking_alerts(
    provider_groups: BTreeMap<ProviderBreakKey, ProviderBreakVal>,
    caller_alerts: Vec<BreakingAlert>,
) -> Vec<BreakingAlert> {
    let mut alerts = Vec::with_capacity(provider_groups.len() + caller_alerts.len());
    for (
        (provider_service, provider_repo, provider_file, method, path_norm),
        (kind, renamed_to, mut callers, last_verified_sha),
    ) in provider_groups
    {
        sort_and_dedup_callers(&mut callers, &provider_repo);
        let cross_repo = callers.iter().any(|c| c.repo != provider_repo);
        alerts.push(BreakingAlert {
            kind,
            target: AlertTarget {
                cross_repo,
                method,
                path_norm,
                provider_repo,
                provider_service,
                provider_file,
            },
            renamed_to,
            new_call_method: None,
            new_call_path: None,
            callers,
            last_verified_sha,
        });
    }
    alerts.extend(caller_alerts);
    sort_by_alert_target(&mut alerts, |a| &a.target);
    alerts
}

fn sort_by_alert_target<T>(items: &mut [T], target_of: impl Fn(&T) -> &AlertTarget) {
    items.sort_by(|a, b| {
        let ta = target_of(a);
        let tb = target_of(b);
        tb.cross_repo
            .cmp(&ta.cross_repo)
            .then_with(|| ta.provider_repo.cmp(&tb.provider_repo))
            .then_with(|| ta.method.cmp(&tb.method))
            .then_with(|| ta.path_norm.cmp(&tb.path_norm))
    });
}

fn detect_likely_rename(
    snap: &ExistingEdgeSnapshot,
    old_handler: Option<&str>,
    new_endpoints: &[EndpointRow],
    old_ep_keys: &HashSet<(&str, &str, HttpMethod, &str)>,
) -> Option<String> {
    let handler = old_handler?;
    if GENERIC_HANDLERS.contains(&handler) {
        return None;
    }
    let candidate = new_endpoints.iter().find(|ep| {
        ep.repo == snap.target.repo
            && ep.file == snap.target.file
            && ep.handler == handler
            && !old_ep_keys.contains(&(
                ep.repo.as_str(),
                ep.file.as_str(),
                ep.method,
                ep.path_norm.as_str(),
            ))
    })?;
    if candidate.method == snap.method {
        Some(candidate.path_norm.clone())
    } else {
        Some(format!("{} {}", candidate.method.as_str(), candidate.path_norm))
    }
}

fn find_newly_unresolved_call<'a>(
    unresolved_rows: &'a [CallRow],
    snap: &ExistingEdgeSnapshot,
    old_unresolved: &HashSet<(String, String, HttpMethod, String)>,
) -> Option<&'a CallRow> {
    let fresh: Vec<&CallRow> = unresolved_rows
        .iter()
        .filter(|c| {
            !old_unresolved.contains(&(
                c.repo.clone(),
                c.file.clone(),
                c.method,
                c.path_norm.clone(),
            ))
        })
        .collect();
    fresh
        .iter()
        .copied()
        .min_by_key(|c| {
            (
                usize::from(c.method != snap.call_method),
                c.line.abs_diff(snap.source.line),
            )
        })
}

fn detect_contract_changes(
    tx: &GraphWriteTx<'_>,
    old_endpoints: &[EndpointRow],
    new_endpoints: &[EndpointRow],
) -> Result<Vec<ContractChangeAlert>> {
    if old_endpoints.is_empty() || new_endpoints.is_empty() {
        return Ok(Vec::new());
    }
    let old_by_key: HashMap<(&str, &str, &str, HttpMethod, &str), &EndpointRow> = old_endpoints
        .iter()
        .map(|e| {
            (
                (
                    e.service.as_str(),
                    e.repo.as_str(),
                    e.file.as_str(),
                    e.method,
                    e.path_norm.as_str(),
                ),
                e,
            )
        })
        .collect();
    let mut alerts = Vec::new();
    for new_ep in new_endpoints {
        let Some(old_ep) = old_by_key.get(&(
            new_ep.service.as_str(),
            new_ep.repo.as_str(),
            new_ep.file.as_str(),
            new_ep.method,
            new_ep.path_norm.as_str(),
        )) else {
            continue;
        };
        if old_ep.contract_hash == new_ep.contract_hash {
            continue;
        }
        let req_diff =
            diff_payload_contracts(old_ep.req_contract.as_ref(), new_ep.req_contract.as_ref());
        let res_diff =
            diff_payload_contracts(old_ep.res_contract.as_ref(), new_ep.res_contract.as_ref());
        if req_diff.is_empty() && res_diff.is_empty() {
            continue;
        }
        let edges = tx.callers_for_endpoint(new_ep.id)?;
        if edges.is_empty() {
            continue;
        }
        let last_verified_sha = edges
            .iter()
            .filter(|e| e.call.repo != new_ep.repo && !e.verify.verified_sha.is_empty())
            .chain(edges.iter().filter(|e| !e.verify.verified_sha.is_empty()))
            .map(|e| e.verify.verified_sha.clone())
            .next();
        let mut callers: Vec<CallerSite> = edges
            .into_iter()
            .map(|e| CallerSite {
                repo: e.call.repo,
                service: e.call.service,
                file: e.call.call.file,
                line: e.call.call.line,
            })
            .collect();
        sort_and_dedup_callers(&mut callers, &new_ep.repo);
        let cross_repo = callers.iter().any(|c| c.repo != new_ep.repo);
        alerts.push(ContractChangeAlert {
            target: AlertTarget {
                cross_repo,
                method: new_ep.method,
                path_norm: new_ep.path_norm.clone(),
                provider_repo: new_ep.repo.clone(),
                provider_service: new_ep.service.clone(),
                provider_file: new_ep.file.clone(),
            },
            request_diff: req_diff,
            response_diff: res_diff,
            callers,
            last_verified_sha,
        });
    }
    sort_by_alert_target(&mut alerts, |a| &a.target);
    Ok(alerts)
}

fn sort_and_dedup_callers(callers: &mut Vec<CallerSite>, provider_repo: &str) {
    callers.sort_by(|a, b| {
        let a_cross = a.repo != provider_repo;
        let b_cross = b.repo != provider_repo;
        b_cross
            .cmp(&a_cross)
            .then_with(|| a.repo.cmp(&b.repo))
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });
    callers.dedup_by(|a, b| a.repo == b.repo && a.file == b.file && a.line == b.line);
}

#[allow(clippy::too_many_arguments)]
fn expand_affected_calls_for_endpoints(
    tx: &GraphWriteTx<'_>,
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
    nginx_routes: &[NginxRoute],
    services: &[ServiceRow],
    old_endpoints: &[EndpointRow],
    new_endpoints: &[EndpointRow],
    affected_calls: &mut Vec<CallRow>,
    old_snapshots: &mut Vec<ExistingEdgeSnapshot>,
) -> Result<()> {
    let mut affected_keys = HashSet::new();
    let mut affected_services = HashSet::new();
    let mut affected_partials: Vec<&EndpointRow> = Vec::new();
    for ep in old_endpoints.iter().chain(new_endpoints.iter()) {
        affected_keys.insert((ep.method, ep.path_norm.clone()));
        affected_services.insert(ep.service.clone());
        if ep.prefix_state == PrefixState::Partial {
            affected_partials.push(ep);
        }
    }
    if affected_keys.is_empty() {
        return Ok(());
    }

    let call_keys = expand_prefixed_call_keys(&affected_keys, config, nginx_routes);
    let mut extra_calls = tx.load_calls_for_keys(&call_keys)?;
    if !affected_partials.is_empty() {
        append_partial_target_calls(
            tx,
            config,
            auto_env,
            services,
            &affected_services,
            &affected_partials,
            &mut extra_calls,
        )?;
    }
    let mut seen_ids: HashSet<i64> = affected_calls.iter().map(|c| c.id).collect();
    let extra_ids: Vec<i64> = extra_calls
        .iter()
        .filter(|c| !seen_ids.contains(&c.id))
        .map(|c| c.id)
        .collect();
    if !extra_ids.is_empty() {
        old_snapshots.extend(tx.snapshot_edges_for_ids(&[], &extra_ids)?);
        for call in extra_calls {
            if seen_ids.insert(call.id) {
                affected_calls.push(call);
            }
        }
    }
    Ok(())
}

fn expand_prefixed_call_keys(
    affected_keys: &HashSet<(HttpMethod, String)>,
    config: &GraphConfig,
    nginx_routes: &[NginxRoute],
) -> HashSet<(HttpMethod, String)> {
    let mut out = affected_keys.clone();
    let mut all_prefixes: Vec<&str> = config.prefixes.values().map(String::as_str).collect();
    for route in nginx_routes {
        if !route.rewrite_prefix.is_empty() {
            all_prefixes.push(route.rewrite_prefix.as_str());
        }
    }
    for (method, ep_path) in affected_keys {
        for prefix in &all_prefixes {
            let norm_p = scan::normalize_path(prefix);
            if *ep_path == norm_p {
                out.insert((*method, "/".to_owned()));
            } else if let Some(rest) = ep_path.strip_prefix(&norm_p)
                && rest.starts_with('/')
            {
                out.insert((*method, rest.to_owned()));
            }
        }
    }
    out
}

fn append_partial_target_calls(
    tx: &GraphWriteTx<'_>,
    config: &GraphConfig,
    auto_env: &BTreeMap<String, String>,
    services: &[ServiceRow],
    affected_services: &HashSet<String>,
    affected_partials: &[&EndpointRow],
    extra_calls: &mut Vec<CallRow>,
) -> Result<()> {
    let env_map = resolve::merge_env_maps(auto_env, &config.env);
    let svc_base: HashMap<&str, &str> = services
        .iter()
        .filter_map(|s| s.base_service.as_deref().map(|b| (s.name.as_str(), b)))
        .collect();
    for call in tx.load_all_calls()? {
        let targets_affected = resolve::configured_service_for_call_with_maps(
            config, &env_map, &svc_base, &call,
        )
        .is_none_or(|svc| affected_services.contains(svc));
        if !targets_affected {
            continue;
        }
        let (eff_path, _) = resolve::effective_call_path(config, &call);
        let matches_partial = affected_partials.iter().any(|ep| {
            (ep.method == call.method || ep.method == HttpMethod::Any)
                && (resolve::path_ends_with_segment_suffix(&eff_path, &ep.path_norm)
                    || resolve::path_ends_with_segment_suffix(&call.path_norm, &ep.path_norm))
        });
        if matches_partial {
            extra_calls.push(call);
        }
    }
    Ok(())
}

fn collect_needed_endpoint_keys(
    config: &GraphConfig,
    nginx_routes: &[NginxRoute],
    affected_calls: &[CallRow],
) -> HashSet<(HttpMethod, String)> {
    let mut keys = HashSet::new();
    for call in affected_calls {
        let (eff, applied) = resolve::effective_call_path(config, call);
        keys.insert((call.method, eff.clone().into_owned()));
        if applied {
            keys.insert((call.method, call.path_norm.clone()));
        }
        if let Some(hit) = resolve::resolve_nginx_for_call(config, nginx_routes, call, &eff) {
            keys.insert((call.method, hit.path_norm));
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_prefixed_call_keys_handles_root_and_nested_paths() {
        let mut prefixes = BTreeMap::new();
        prefixes.insert("repo:src/c.rs".to_owned(), "/catalog".to_owned());
        let config = GraphConfig {
            repos_root: PathBuf::from("/tmp"),
            services: BTreeMap::new(),
            env: BTreeMap::new(),
            clients: BTreeMap::new(),
            prefixes,
            containers: BTreeMap::new(),
            external: Vec::new(),
        };
        let mut affected = HashSet::new();
        affected.insert((HttpMethod::Get, "/catalog".to_owned()));
        affected.insert((HttpMethod::Post, "/catalog/v1/items".to_owned()));
        let expanded = expand_prefixed_call_keys(&affected, &config, &[]);
        assert!(expanded.contains(&(HttpMethod::Get, "/".to_owned())));
        assert!(expanded.contains(&(HttpMethod::Post, "/v1/items".to_owned())));
    }

    #[test]
    fn breaking_detection_catches_provider_rename_and_caller_side_unresolved() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = tmp.path().join("graph.db");
        let mut store = GraphStore::open_writable(&db).unwrap();
        let tx = store.begin_write().unwrap();
        tx.insert_endpoints(
            "shop",
            "aaaaaaa",
            &[(
                "shop-api".to_owned(),
                vec![ExtractedEndpoint::simple(
                    HttpMethod::Post,
                    "/api/internal/invoices-v2",
                    "src/api.rs",
                    10,
                    "create_invoice",
                    PrefixState::Full,
                )],
            )],
        )
        .unwrap();
        tx.insert_calls(
            "addon",
            "bbbbbbb",
            &[(
                "addon-api".to_owned(),
                vec![
                    ExtractedCall::simple(
                        HttpMethod::Post,
                        "/api/internal/invoices",
                        "src/client.rs",
                        42,
                        "self.url",
                        "issue",
                        "",
                    ),
                    ExtractedCall::simple(
                        HttpMethod::Get,
                        "/api/v1/broken-call",
                        "src/edited_client.rs",
                        15,
                        "self.url",
                        "fetch",
                        "",
                    ),
                ],
            )],
        )
        .unwrap();

        let new_eps = tx.load_all_endpoints().unwrap();
        let old_eps = vec![EndpointRow {
            id: 99,
            service: "shop-api".to_owned(),
            repo: "shop".to_owned(),
            verified_sha: "aaaaaaa".to_owned(),
            chunk_ids: Default::default(),
            ep: ExtractedEndpoint::simple(
                HttpMethod::Post,
                "/api/internal/invoices",
                "src/api.rs",
                10,
                "create_invoice",
                PrefixState::Full,
            ),
        }];
        let make_snap = |src_file: &str, src_line: usize, dst_file: &str, dst_line: usize, ep_method: HttpMethod, call_method: HttpMethod, path: &str| {
            ExistingEdgeSnapshot {
                source: super::super::store::SiteRef {
                    service: "addon-api".to_owned(),
                    repo: "addon".to_owned(),
                    file: src_file.to_owned(),
                    line: src_line,
                },
                target: super::super::store::SiteRef {
                    service: "shop-api".to_owned(),
                    repo: "shop".to_owned(),
                    file: dst_file.to_owned(),
                    line: dst_line,
                },
                method: ep_method,
                call_method,
                path_norm: path.to_owned(),
                call_path_norm: path.to_owned(),
                confidence: super::super::types::Confidence::Configured,
                first_seen_sha: "aaaaaaa".to_owned(),
                last_seen_sha: "aaaaaaa".to_owned(),
                seen_count: 1,
                first_seen_at: 1000,
                verify: Default::default(),
                verified_at: 0,
                pair_changed_at: 0,
            }
        };
        let lost = vec![
            make_snap("src/client.rs", 42, "src/api.rs", 10, HttpMethod::Post, HttpMethod::Post, "/api/internal/invoices"),
            make_snap("src/edited_client.rs", 15, "src/other.rs", 5, HttpMethod::Get, HttpMethod::Get, "/api/v1/working-call"),
        ];
        let modified_files: HashSet<(String, String)> = [
            ("shop".to_owned(), "src/api.rs".to_owned()),
            ("addon".to_owned(), "src/edited_client.rs".to_owned()),
        ]
        .into_iter()
        .collect();
        let (alerts, reasons) = detect_breaking_changes(
            &tx,
            &lost,
            &old_eps,
            &new_eps,
            &HashSet::new(),
            &modified_files,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(alerts.len(), 2, "alerts={alerts:?}");
        assert_eq!(reasons.len(), 2);
        let rename_alert = alerts
            .iter()
            .find(|a| a.kind == BreakingKind::EndpointRenamed)
            .unwrap();
        assert_eq!(rename_alert.renamed_to.as_deref(), Some("/api/internal/invoices-v2"));
        let caller_alert = alerts
            .iter()
            .find(|a| a.kind == BreakingKind::CallUnresolved)
            .unwrap();
        assert_eq!(caller_alert.new_call_path.as_deref(), Some("/api/v1/broken-call"));

        const FULL_SVC_FILE: &str = "src/full_svc.rs";
        const WEBHOOK_ANY_PATH: &str = "/webhooks/any";
        tx.insert_calls(
            "addon",
            "bbbbbbb",
            &[(
                "addon-api".to_owned(),
                vec![
                    ExtractedCall::simple(HttpMethod::Post, WEBHOOK_ANY_PATH, "src/any_client.rs", 20, "u", "hook", ""),
                    ExtractedCall::simple(HttpMethod::Put, "/api/v1/method-edit", "src/method_client.rs", 30, "u", "put", ""),
                    ExtractedCall::simple(HttpMethod::Get, "/preexisting/fog", FULL_SVC_FILE, 5, "u", "fog", ""),
                ],
            )],
        )
        .unwrap();
        let any_and_method_lost = vec![
            make_snap("src/any_client.rs", 20, "src/api.rs", 99, HttpMethod::Any, HttpMethod::Post, WEBHOOK_ANY_PATH),
            make_snap("src/method_client.rs", 30, "src/other.rs", 8, HttpMethod::Post, HttpMethod::Post, "/api/v1/method-edit"),
            make_snap(FULL_SVC_FILE, 12, "src/other.rs", 9, HttpMethod::Get, HttpMethod::Get, "/intentionally/deleted"),
        ];
        let full_svcs: HashSet<(String, String)> =
            [("addon".to_owned(), "addon-api".to_owned())].into_iter().collect();
        let old_unres = tx
            .load_unresolved_call_keys_for_scope(&[], &[("addon".to_owned(), "addon-api".to_owned())])
            .unwrap();
        let old_unres_only_fog: HashSet<_> = old_unres
            .into_iter()
            .filter(|(_, f, _, _)| f == FULL_SVC_FILE)
            .collect();
        let (edge_alerts, _) = detect_breaking_changes(
            &tx,
            &any_and_method_lost,
            &[],
            &[],
            &old_unres_only_fog,
            &modified_files,
            &full_svcs,
        )
        .unwrap();
        assert_eq!(edge_alerts.len(), 2, "edge_alerts={edge_alerts:?}");
        assert!(edge_alerts.iter().any(|a| a.kind == BreakingKind::EndpointRemoved && a.target.path_norm == WEBHOOK_ANY_PATH));
        let method_alert = edge_alerts
            .iter()
            .find(|a| a.kind == BreakingKind::CallUnresolved)
            .unwrap();
        let formatted = super::super::contracts::format_breaking_alert(method_alert);
        assert!(formatted.contains("PUT /api/v1/method-edit no longer resolves"), "formatted={formatted}");
        assert!(formatted.contains("(was POST /api/v1/method-edit -> shop-api)"), "formatted={formatted}");
    }
}
