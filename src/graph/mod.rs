pub mod axum;
pub mod query;
pub mod resolve;
pub mod rust_client;
pub mod scan;
pub mod store;
pub mod ts_client;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::aliases::ensure_private_dir as crate_ensure_private_dir;
use crate::aliases::read_private_file;
use crate::aliases::sibling_path;
use crate::intelligence::now_ms;

use self::store::{GraphStore, RepoRow};

pub const EXTRACTOR_VERSION: i64 = 1;
pub const DEFAULT_MAX_BYTES: usize = 1200;
const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_MCP_QUERY_BYTES: usize = 512;
const MAX_MCP_LIMIT: usize = 50;
const META_CONFIG_HASH: &str = "config_hash";
const MISSING_GRAPH_MESSAGE: &str =
    "System graph not built yet. Add system-graph.json beside memory.db and run `iron memory graph refresh`.\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
    Any,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
            Self::Any => "ANY",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "PATCH" => Some(Self::Patch),
            "DELETE" => Some(Self::Delete),
            "HEAD" => Some(Self::Head),
            "OPTIONS" => Some(Self::Options),
            "ANY" => Some(Self::Any),
            _ => None,
        }
    }

    pub fn parse_crud(raw: &str) -> Option<Self> {
        match raw {
            "get" => Some(Self::Get),
            "post" => Some(Self::Post),
            "put" => Some(Self::Put),
            "patch" => Some(Self::Patch),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stack {
    Axum,
    Spa,
}

impl Stack {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Axum => "axum",
            Self::Spa => "spa",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "axum" => Some(Self::Axum),
            "spa" => Some(Self::Spa),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrefixState {
    Full,
    Resolved,
    Partial,
}

impl PrefixState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Resolved => "resolved",
            Self::Partial => "partial",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" => Some(Self::Full),
            "resolved" => Some(Self::Resolved),
            "partial" => Some(Self::Partial),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Configured,
    Unique,
    Name,
    Suffix,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Configured => "configured",
            Self::Unique => "unique",
            Self::Name => "name",
            Self::Suffix => "suffix",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "configured" => Some(Self::Configured),
            "unique" => Some(Self::Unique),
            "name" => Some(Self::Name),
            "suffix" => Some(Self::Suffix),
            _ => None,
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::Configured => 0,
            Self::Unique => 1,
            Self::Name => 2,
            Self::Suffix => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Callers,
    Callees,
    Impact,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Callers => "callers",
            Self::Callees => "callees",
            Self::Impact => "impact",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphConfig {
    pub repos_root: PathBuf,
    pub services: BTreeMap<String, ServiceConfig>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub clients: BTreeMap<String, String>,
    #[serde(default)]
    pub external: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceConfig {
    pub repo: String,
    #[serde(default)]
    pub root: String,
    pub stack: Stack,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub base_prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedEndpoint {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
    pub file: String,
    pub line: usize,
    pub handler: String,
    pub prefix_state: PrefixState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedCall {
    pub method: HttpMethod,
    pub path_raw: String,
    pub path_norm: String,
    pub file: String,
    pub line: usize,
    pub base_ref: String,
    pub symbol: String,
    pub area: String,
    pub why: String,
    pub external: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpGraphRequest {
    pub query: String,
    pub direction: Direction,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

pub(crate) fn ensure_private_dir(dir: &Path) -> Result<()> {
    crate_ensure_private_dir(dir)
}

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

pub fn refresh(db: &Path) -> Result<Value> {
    let started = Instant::now();
    let (config, config_hash) = load_config(db)?;
    let graph_db = graph_db_path(db).context("system-graph requires a durable index path")?;
    let _lock = store::lock_graph_file(&graph_db)?;
    let mut store = GraphStore::open_writable(&graph_db)?;

    let mut repos_services: BTreeMap<String, Vec<(String, ServiceConfig)>> = BTreeMap::new();
    for (svc_name, svc_cfg) in &config.services {
        repos_services
            .entry(svc_cfg.repo.clone())
            .or_default()
            .push((svc_name.clone(), svc_cfg.clone()));
    }
    let active_repos: HashSet<String> = repos_services.keys().cloned().collect();
    let pruned = store.prune_removed_repos(&active_repos)?;
    store.sync_services(&config.services)?;
    let config_changed = store.get_meta(META_CONFIG_HASH)?.as_deref() != Some(config_hash.as_str());

    let mut scanned = 0usize;
    let mut skipped = 0usize;
    let mut repo_status = BTreeMap::new();
    let refreshed_at = now_ms();

    for (repo_name, svcs) in &repos_services {
        let was_scanned = refresh_single_repo(
            &mut store,
            &config,
            repo_name,
            svcs,
            refreshed_at,
            &mut repo_status,
        )?;
        if was_scanned {
            scanned += 1;
        } else {
            skipped += 1;
        }
    }

    if scanned > 0 || pruned || config_changed {
        let auto_env = store.load_all_compose_env(&active_repos)?;
        let services = store.load_all_services()?;
        let endpoints = store.load_all_endpoints()?;
        let calls = store.load_all_calls()?;
        let edges = resolve::resolve_edges(&config, &auto_env, &services, &endpoints, &calls);
        store.replace_edges(&edges)?;
        store.set_meta(META_CONFIG_HASH, &config_hash)?;
    }

    let counts = store.counts()?;
    Ok(json!({
        "scanned": scanned,
        "skipped": skipped,
        "endpoints": counts.endpoints,
        "calls": counts.calls,
        "edges": counts.edges,
        "fog": counts.fog,
        "fog_by_repo": counts.fog_by_repo,
        "repos": repo_status,
        "elapsed_ms": started.elapsed().as_millis(),
    }))
}

fn refresh_single_repo(
    store: &mut GraphStore,
    config: &GraphConfig,
    repo_name: &str,
    svcs: &[(String, ServiceConfig)],
    refreshed_at: i64,
    repo_status: &mut BTreeMap<String, Value>,
) -> Result<bool> {
    let repo_dir = config.repos_root.join(repo_name);
    let canon_dir = repo_dir
        .canonicalize()
        .with_context(|| format!("repo directory missing: {}", repo_dir.display()))?;
    let head_sha = scan::git_head(&canon_dir)?;
    let dirty = scan::git_is_dirty(&canon_dir);
    let unchanged = store.get_repo(repo_name)?.is_some_and(|existing| {
        existing.head_sha == head_sha && existing.extractor_ver == EXTRACTOR_VERSION
    });
    if unchanged {
        repo_status.insert(
            repo_name.to_owned(),
            json!({"status": "skipped", "head_sha": head_sha, "dirty": dirty}),
        );
        return Ok(false);
    }
    let tracked = scan::git_ls_files(&canon_dir)?;
    let repo_compose_env = resolve::collect_compose_env(&canon_dir, &tracked, &config.services);
    store.set_meta(
        &format!("compose_env:{repo_name}"),
        &serde_json::to_string(&repo_compose_env)?,
    )?;
    let mut service_endpoints = Vec::new();
    let mut service_calls = Vec::new();
    for (svc_name, svc_cfg) in svcs {
        match svc_cfg.stack {
            Stack::Axum => {
                service_endpoints.push((
                    svc_name.clone(),
                    axum::extract_service(&canon_dir, &svc_cfg.root, svc_cfg.entry.as_deref(), &tracked)?,
                ));
                service_calls.push((
                    svc_name.clone(),
                    rust_client::extract_service(repo_name, &canon_dir, &svc_cfg.root, &config.external, &tracked)?,
                ));
            }
            Stack::Spa => {
                service_calls.push((
                    svc_name.clone(),
                    ts_client::extract_service(
                        repo_name,
                        &canon_dir,
                        &svc_cfg.root,
                        svc_cfg.client.as_deref(),
                        svc_cfg.base.as_deref(),
                        svc_cfg.base_prefix.as_deref(),
                        &config.external,
                        &tracked,
                    )?,
                ));
            }
        }
    }
    let repo_row = RepoRow {
        repo: repo_name.to_owned(),
        repo_path: canon_dir.to_string_lossy().into_owned(),
        head_sha: head_sha.clone(),
        extractor_ver: EXTRACTOR_VERSION,
        dirty,
    };
    store.replace_repo_scan(&repo_row, refreshed_at, &service_endpoints, &service_calls)?;
    repo_status.insert(
        repo_name.to_owned(),
        json!({"status": "scanned", "head_sha": head_sha, "dirty": dirty}),
    );
    Ok(true)
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
