pub mod axum;
pub mod query;
pub mod resolve;
pub mod rust_client;
pub mod scan;
pub mod store;
pub mod suggest;
pub mod sync;
pub mod ts_client;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::aliases::{read_private_file, sibling_path, write_private_file_atomic};
use crate::intelligence::now_ms;

use self::store::{CallRow, EdgeUpdateBatch, EndpointRow, GraphStore};
use self::sync::META_CONFIG_HASH;

pub use self::sync::TouchReport;
pub use self::types::{
    Confidence, DEFAULT_MAX_BYTES, Direction, EXTRACTOR_VERSION, ExtractedCall, ExtractedEndpoint,
    GraphConfig, HttpMethod, McpGraphRequest, PrefixState, RefreshStatus, ServiceConfig, Stack,
    TOUCH_MAX_BYTES,
};

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_MCP_QUERY_BYTES: usize = 512;
const MAX_MCP_LIMIT: usize = 50;
const MISSING_GRAPH_MESSAGE: &str =
    "System graph not built yet. Add system-graph.json beside memory.db and run `iron memory graph refresh`.\n";

pub fn config_path(db: &Path) -> Option<PathBuf> {
    sibling_path(db, "system-graph.json")
}

pub fn graph_db_path(db: &Path) -> Option<PathBuf> {
    sibling_path(db, "graph.db")
}

pub fn load_config(db: &Path) -> Result<(GraphConfig, String)> {
    let path = config_path(db).context("system-graph requires a durable index path")?;
    let raw = read_private_file(&path, "system-graph config", MAX_CONFIG_BYTES)?;
    let parsed: GraphConfig = serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in system-graph config {}", path.display()))?;
    let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    Ok((parsed, digest))
}

pub fn save_config(db: &Path, config: &GraphConfig) -> Result<String> {
    let path = config_path(db).context("system-graph requires a durable index path")?;
    let payload = serde_json::to_string_pretty(config)? + "\n";
    write_private_file_atomic(&path, "system-graph config", &payload)?;
    Ok(format!("{:x}", Sha256::digest(payload.as_bytes())))
}

pub fn refresh(db: &Path) -> Result<Value> {
    let (config, config_hash) = load_config(db)?;
    let graph_db = graph_db_path(db).context("system-graph requires a durable index path")?;
    sync::refresh_graph(&config, &config_hash, &graph_db)
}

pub fn touch(db: &Path, paths: &[PathBuf]) -> Result<TouchReport> {
    let (config, config_hash) = load_config(db)?;
    let graph_db = graph_db_path(db).context("system-graph requires a durable index path")?;
    sync::touch_paths(&config, &config_hash, &graph_db, paths)
}

pub fn run_suggest(db: &Path, apply: bool) -> Result<Value> {
    let graph_db = graph_db_path(db).context("system-graph requires a durable index path")?;
    if !apply {
        let (config, _) = load_config(db)?;
        let active_repos = active_repo_set(&config);
        let Some(store) = GraphStore::open_readonly(&graph_db)? else {
            bail!("{}", MISSING_GRAPH_MESSAGE.trim());
        };
        let auto_env = store.load_all_compose_env(&active_repos)?;
        let fog_before = store.counts()?.fog;
        let suggestions = suggest::compute_suggestions(&store, &config, &auto_env)?;
        return Ok(format_suggest_json(false, fog_before, fog_before, &suggestions));
    }

    if !graph_db.exists() {
        bail!("{}", MISSING_GRAPH_MESSAGE.trim());
    }
    let _lock = store::lock_graph_file(&graph_db)?;
    let (mut config, _) = load_config(db)?;
    let active_repos = active_repo_set(&config);
    let mut store = GraphStore::open_writable(&graph_db)?;
    let auto_env = store.load_all_compose_env(&active_repos)?;
    let fog_before = store.counts()?.fog;
    let suggestions = suggest::compute_suggestions(&store, &config, &auto_env)?;
    let merged = suggest::merge_suggestions(&mut config, &suggestions);
    if merged {
        let new_hash = save_config(db, &config)?;
        apply_config_re_resolve(&mut store, &config, &auto_env, &new_hash)?;
    }
    let fog_after = store.counts()?.fog;
    Ok(format_suggest_json(merged, fog_before, fog_after, &suggestions))
}

fn active_repo_set(config: &GraphConfig) -> HashSet<String> {
    config.services.values().map(|s| s.repo.clone()).collect()
}

fn format_suggest_json(
    applied: bool,
    fog_before: usize,
    fog_after: usize,
    suggestions: &suggest::GraphSuggestions,
) -> Value {
    json!({
        "applied": applied,
        "fog_before": fog_before,
        "fog_after": fog_after,
        "prefixes": suggestions.prefixes,
        "env": suggestions.env,
        "external": suggestions.external,
    })
}

fn apply_config_re_resolve(
    store: &mut GraphStore,
    config: &GraphConfig,
    auto_env: &std::collections::BTreeMap<String, String>,
    new_hash: &str,
) -> Result<()> {
    let now = now_ms();
    let tx = store.begin_write()?;
    tx.update_calls_external_flags(&config.external)?;
    let old_snaps = tx.snapshot_all_edges()?;
    let services = tx.load_all_services()?;
    let endpoints = tx.load_all_endpoints()?;
    let calls = tx.load_all_calls()?;
    let new_edges = resolve::resolve_edges(config, auto_env, &services, &endpoints, &calls);
    let calls_map: HashMap<i64, &CallRow> = calls.iter().map(|c| (c.id, c)).collect();
    let eps_map: HashMap<i64, &EndpointRow> = endpoints.iter().map(|e| (e.id, e)).collect();
    let empty_repos = HashSet::new();
    tx.apply_edge_updates(&EdgeUpdateBatch {
        full_replace: true,
        replace_call_ids: &[],
        old_snapshots: &old_snaps,
        new_edges: &new_edges,
        calls_by_id: &calls_map,
        eps_by_id: &eps_map,
        changed_repos: &empty_repos,
        now_ms: now,
    })?;
    tx.set_meta(META_CONFIG_HASH, new_hash)?;
    tx.commit()
}

fn with_readonly_graph(db: &Path, run: impl FnOnce(&GraphStore) -> Result<String>) -> Result<String> {
    let Some(store) = open_readonly_graph(db)? else {
        return Ok(MISSING_GRAPH_MESSAGE.to_owned());
    };
    run(&store)
}

pub fn query_who_calls(
    db: &Path,
    query: &str,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    with_readonly_graph(db, |store| query::who_calls(store, query, repo, limit, max_bytes))
}

pub fn query_impact(
    db: &Path,
    file: &Path,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    with_readonly_graph(db, |store| query::impact(store, file, repo, limit, max_bytes))
}

pub fn query_fog(
    db: &Path,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    with_readonly_graph(db, |store| query::fog(store, repo, limit, max_bytes))
}

pub fn query_changes(
    db: &Path,
    since_days: u64,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    with_readonly_graph(db, |store| {
        query::changes(store, since_days, repo, limit, max_bytes, now_ms())
    })
}

pub fn query_mcp(db: &Path, req: McpGraphRequest) -> Result<Value> {
    if req.query.trim().is_empty() || req.query.len() > MAX_MCP_QUERY_BYTES {
        bail!("query must contain between 1 and {MAX_MCP_QUERY_BYTES} UTF-8 bytes");
    }
    if req.limit.is_some_and(|l| !(1..=MAX_MCP_LIMIT).contains(&l)) {
        bail!("limit must be between 1 and {MAX_MCP_LIMIT}");
    }
    let max_bytes = req.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    crate::output::validate_budget(max_bytes)?;
    let text = with_readonly_graph(db, |store| match req.direction {
        Direction::Callers => {
            query::who_calls(store, &req.query, req.repo.as_deref(), req.limit, max_bytes)
        }
        Direction::Callees => {
            query::callees(store, &req.query, req.repo.as_deref(), req.limit, max_bytes)
        }
        Direction::Impact => {
            query::impact(store, Path::new(&req.query), req.repo.as_deref(), req.limit, max_bytes)
        }
    })?;
    Ok(Value::String(text))
}

fn open_readonly_graph(db: &Path) -> Result<Option<GraphStore>> {
    let path = graph_db_path(db).context("system-graph requires a durable index path")?;
    GraphStore::open_readonly(&path)
}
