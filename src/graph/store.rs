use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::ops::Deref;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::aliases::ensure_private_dir;

use super::chunks::compute_pair_key;
use super::contracts::{BreakingKind, PayloadContract};
use super::nginx::NginxRoute;
use super::scan::matches_external_glob;
use super::types::{
    ChunkKind, Confidence, ExtractedCall, ExtractedChunk, ExtractedEndpoint, HttpMethod,
    PrefixState, ServiceConfig, Stack,
};

const GRAPH_APPLICATION_ID: i64 = 0x4952_4750;
const GRAPH_SCHEMA_VERSION: i64 = 4;
const BUSY_TIMEOUT_SECS: u64 = 5;
const LOCK_TIMEOUT_SECS: u64 = 10;
const LOCK_POLL_MS: u64 = 20;
const SCHEMA_OBJECT_TABLE: &str = "table";
const TABLE_EDGE_HISTORY: &str = "edge_history";
const SERVICE_SCOPED_TABLES: &[&str] = &["endpoints", "calls", "file_hashes"];
const REPO_SCOPED_TABLES: &[&str] = &[
    "endpoints",
    "calls",
    "file_hashes",
    "chunks",
    "removed_chunks",
    "services",
    "repos",
];
const CROSS_REPO_SERVED_SQL: &str = "SELECT DISTINCT c.repo, c.service, ep.method, ep.path_norm,
            e.pair_key, e.verified_pair_key, e.verified_sha
     FROM endpoints ep
     JOIN edges e ON e.endpoint_id = ep.id
     JOIN calls c ON c.id = e.call_id
     WHERE ep.repo = ?1 AND ep.file = ?2 AND c.repo != ep.repo
     ORDER BY c.service, ep.method, ep.path_norm";
const CROSS_REPO_CALLED_SQL: &str = "SELECT DISTINCT ep.repo, ep.service, c.method, ep.path_norm,
            e.pair_key, e.verified_pair_key, e.verified_sha
     FROM calls c
     JOIN edges e ON e.call_id = c.id
     JOIN endpoints ep ON ep.id = e.endpoint_id
     WHERE c.repo = ?1 AND c.file = ?2 AND ep.repo != c.repo
     ORDER BY ep.service, c.method, ep.path_norm";

pub(crate) fn lock_graph_file(graph_db: &Path) -> Result<File> {
    let parent = graph_db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ensure_private_dir(parent)?;
    let canon_parent = parent.canonicalize()?;
    let lock_name = graph_db
        .file_name()
        .context("graph db must be a file path")?
        .to_string_lossy();
    let lock_path = canon_parent.join(format!(".{lock_name}.lock"));
    ensure_not_symlink(graph_db)?;
    ensure_not_symlink(&lock_path)?;
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(&lock_path)?;
    let deadline = Instant::now() + Duration::from_secs(LOCK_TIMEOUT_SECS);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(err) if err.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(LOCK_POLL_MS));
            }
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                bail!("another graph refresh is active; retry after it completes");
            }
            Err(err) => return Err(err.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeChangeKind {
    Added,
    Removed,
}

impl EdgeChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Removed => "removed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SiteKey {
    pub service: String,
    pub repo: String,
    pub file: String,
}

#[derive(Debug, Clone)]
pub struct SiteRef {
    pub service: String,
    pub repo: String,
    pub file: String,
    pub line: usize,
}

impl SiteRef {
    pub fn key(&self) -> SiteKey {
        SiteKey {
            service: self.service.clone(),
            repo: self.repo.clone(),
            file: self.file.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RepoRow {
    pub repo: String,
    pub repo_path: String,
    pub head_sha: String,
    pub extractor_ver: i64,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct FileHashRow {
    pub file: String,
    pub content_hash: String,
    pub service: String,
    pub has_router_deps: bool,
    pub norm_file_hash: String,
}

#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub id: i64,
    pub repo: String,
    pub file: String,
    pub kind: ChunkKind,
    pub qualified_name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub norm_hash: String,
    pub first_seen_hash: String,
    pub first_seen_at: i64,
    pub hash_changed_at: i64,
}

#[derive(Debug, Clone)]
pub struct RemovedChunkRow {
    pub repo: String,
    pub file: String,
    pub kind: ChunkKind,
    pub qualified_name: String,
    pub removed_at: i64,
}

#[derive(Debug, Clone)]
pub struct ServiceRow {
    pub name: String,
    pub repo: String,
    pub root: String,
    pub stack: Stack,
    pub base_service: Option<String>,
    pub base_prefix: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EndpointChunkIds {
    pub handler: Option<i64>,
    pub req_type: Option<i64>,
    pub res_type: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EdgeVerifyMeta {
    pub pair_key: String,
    pub verified_pair_key: String,
    pub verified_sha: String,
}

#[derive(Debug, Clone)]
pub struct EndpointRow {
    pub id: i64,
    pub service: String,
    pub repo: String,
    pub verified_sha: String,
    pub chunk_ids: EndpointChunkIds,
    pub ep: ExtractedEndpoint,
}

impl Deref for EndpointRow {
    type Target = ExtractedEndpoint;

    fn deref(&self) -> &Self::Target {
        &self.ep
    }
}

#[derive(Debug, Clone)]
pub struct CallRow {
    pub id: i64,
    pub service: String,
    pub repo: String,
    pub verified_sha: String,
    pub caller_chunk_id: Option<i64>,
    pub call: ExtractedCall,
}

impl Deref for CallRow {
    type Target = ExtractedCall;

    fn deref(&self) -> &Self::Target {
        &self.call
    }
}

#[derive(Debug, Clone)]
pub struct EdgeRow {
    pub call_id: i64,
    pub endpoint_id: i64,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EdgeLogicalKey {
    pub source: SiteKey,
    pub target: SiteKey,
    pub method: HttpMethod,
    pub path_norm: String,
}

#[derive(Debug, Clone)]
pub struct ExistingEdgeSnapshot {
    pub source: SiteRef,
    pub target: SiteRef,
    pub method: HttpMethod,
    pub call_method: HttpMethod,
    pub path_norm: String,
    pub call_path_norm: String,
    pub confidence: Confidence,
    pub first_seen_sha: String,
    pub last_seen_sha: String,
    pub seen_count: i64,
    pub first_seen_at: i64,
    pub verify: EdgeVerifyMeta,
    pub verified_at: i64,
    pub pair_changed_at: i64,
}

impl ExistingEdgeSnapshot {
    pub fn logical_key(&self) -> EdgeLogicalKey {
        EdgeLogicalKey {
            source: self.source.key(),
            target: self.target.key(),
            method: self.method,
            path_norm: self.path_norm.clone(),
        }
    }
}

pub struct EdgeUpdateBatch<'a> {
    pub full_replace: bool,
    pub replace_call_ids: &'a [i64],
    pub old_snapshots: &'a [ExistingEdgeSnapshot],
    pub new_edges: &'a [EdgeRow],
    pub calls_by_id: &'a HashMap<i64, &'a CallRow>,
    pub eps_by_id: &'a HashMap<i64, &'a EndpointRow>,
    pub changed_repos: &'a HashSet<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone)]
pub struct EdgeChangeRow {
    pub kind: EdgeChangeKind,
    pub source: SiteRef,
    pub target: SiteRef,
    pub method: HttpMethod,
    pub path_norm: String,
    pub sha: String,
    pub seen_count: i64,
    pub timestamp_ms: i64,
    pub breaking: bool,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct CrossRepoEdgeInfo {
    pub peer_repo: String,
    pub peer_service: String,
    pub method: HttpMethod,
    pub path_norm: String,
    pub verify: EdgeVerifyMeta,
}

#[derive(Debug, Clone)]
pub struct CallerEdge {
    pub call: CallRow,
    pub service_stack: Stack,
    pub confidence: Confidence,
    pub verify: EdgeVerifyMeta,
}

#[derive(Debug, Clone)]
pub struct ProviderEdge {
    pub endpoint: EndpointRow,
    pub confidence: Confidence,
    pub verify: EdgeVerifyMeta,
}

#[derive(Debug, Clone)]
pub struct UnverifiedEdgeRow {
    pub source: SiteRef,
    pub target: SiteRef,
    pub method: HttpMethod,
    pub path_norm: String,
    pub confidence: Confidence,
    pub verify: EdgeVerifyMeta,
    pub pair_changed_at: i64,
    pub caller_chunk: String,
    pub handler_chunk: String,
}

#[derive(Debug, Clone, Default)]
pub struct GraphCounts {
    pub endpoints: usize,
    pub calls: usize,
    pub edges: usize,
    pub fog: usize,
    pub fog_by_repo: BTreeMap<String, usize>,
    pub chunks: usize,
    pub chunks_by_repo: BTreeMap<String, usize>,
}

pub struct GraphStore {
    conn: Connection,
    has_contract_cols: bool,
    has_chunk_cols: bool,
}

pub struct GraphWriteTx<'a> {
    tx: Transaction<'a>,
}

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS graph_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
    repo TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    extractor_ver INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0,
    refreshed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_hashes (
    repo TEXT NOT NULL,
    file TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT '',
    has_router_deps INTEGER NOT NULL DEFAULT 0,
    norm_file_hash TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (repo, file)
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    file TEXT NOT NULL,
    kind TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    norm_hash TEXT NOT NULL,
    first_seen_hash TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL DEFAULT 0,
    hash_changed_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (repo, file, kind, qualified_name)
);
CREATE TABLE IF NOT EXISTS removed_chunks (
    repo TEXT NOT NULL,
    file TEXT NOT NULL,
    kind TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    removed_at INTEGER NOT NULL,
    PRIMARY KEY (repo, file, kind, qualified_name)
);
CREATE TABLE IF NOT EXISTS services (
    name TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    root TEXT NOT NULL,
    stack TEXT NOT NULL,
    base_service TEXT,
    base_prefix TEXT
);
CREATE TABLE IF NOT EXISTS endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    repo TEXT NOT NULL,
    method TEXT NOT NULL,
    path_raw TEXT NOT NULL,
    path_norm TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    handler TEXT NOT NULL,
    prefix_state TEXT NOT NULL,
    verified_sha TEXT NOT NULL,
    req_contract TEXT NOT NULL DEFAULT '',
    res_contract TEXT NOT NULL DEFAULT '',
    contract_hash TEXT NOT NULL DEFAULT '',
    handler_chunk_id INTEGER,
    req_type_chunk_id INTEGER,
    res_type_chunk_id INTEGER
);
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    repo TEXT NOT NULL,
    method TEXT NOT NULL,
    path_raw TEXT NOT NULL,
    path_norm TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    base_ref TEXT NOT NULL,
    symbol TEXT NOT NULL,
    area TEXT NOT NULL,
    why TEXT NOT NULL,
    external INTEGER NOT NULL DEFAULT 0,
    verified_sha TEXT NOT NULL,
    req_contract TEXT NOT NULL DEFAULT '',
    caller_chunk_id INTEGER
);
CREATE TABLE IF NOT EXISTS edges (
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    confidence TEXT NOT NULL,
    first_seen_sha TEXT NOT NULL DEFAULT '',
    last_seen_sha TEXT NOT NULL DEFAULT '',
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    pair_key TEXT NOT NULL DEFAULT '',
    verified_pair_key TEXT NOT NULL DEFAULT '',
    verified_sha TEXT NOT NULL DEFAULT '',
    verified_at INTEGER NOT NULL DEFAULT 0,
    pair_changed_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (call_id, endpoint_id)
);
CREATE TABLE IF NOT EXISTS edge_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_service TEXT NOT NULL,
    call_repo TEXT NOT NULL,
    call_file TEXT NOT NULL,
    call_line INTEGER NOT NULL,
    endpoint_service TEXT NOT NULL,
    endpoint_repo TEXT NOT NULL,
    endpoint_file TEXT NOT NULL,
    endpoint_line INTEGER NOT NULL,
    method TEXT NOT NULL,
    path_norm TEXT NOT NULL,
    confidence TEXT NOT NULL,
    first_seen_sha TEXT NOT NULL,
    last_seen_sha TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    removed_at INTEGER NOT NULL,
    breaking INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_file_hashes_service ON file_hashes(repo, service);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_file ON chunks(repo, file);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_name ON chunks(repo, qualified_name);
CREATE INDEX IF NOT EXISTS idx_removed_chunks_repo ON removed_chunks(repo);
CREATE INDEX IF NOT EXISTS idx_endpoints_lookup ON endpoints(method, path_norm);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(path_norm);
CREATE INDEX IF NOT EXISTS idx_endpoints_file ON endpoints(repo, file);
CREATE INDEX IF NOT EXISTS idx_endpoints_service ON endpoints(repo, service);
CREATE INDEX IF NOT EXISTS idx_endpoints_prefix_state ON endpoints(prefix_state);
CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(repo, file);
CREATE INDEX IF NOT EXISTS idx_calls_service ON calls(repo, service);
CREATE INDEX IF NOT EXISTS idx_calls_lookup ON calls(method, path_norm);
CREATE INDEX IF NOT EXISTS idx_edges_endpoint ON edges(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_edges_call ON edges(call_id);
CREATE INDEX IF NOT EXISTS idx_edge_history_removed ON edge_history(removed_at);
";

const POST_MIGRATION_INDEXES_SQL: &str = "
CREATE INDEX IF NOT EXISTS idx_endpoints_handler_chunk ON endpoints(handler_chunk_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_chunk ON calls(caller_chunk_id);
";

const FILE_HASH_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("norm_file_hash", "TEXT NOT NULL DEFAULT ''"),
];
const EDGE_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("first_seen_sha", "TEXT NOT NULL DEFAULT ''"),
    ("last_seen_sha", "TEXT NOT NULL DEFAULT ''"),
    ("seen_count", "INTEGER NOT NULL DEFAULT 1"),
    ("first_seen_at", "INTEGER NOT NULL DEFAULT 0"),
    ("last_seen_at", "INTEGER NOT NULL DEFAULT 0"),
    ("pair_key", "TEXT NOT NULL DEFAULT ''"),
    ("verified_pair_key", "TEXT NOT NULL DEFAULT ''"),
    ("verified_sha", "TEXT NOT NULL DEFAULT ''"),
    ("verified_at", "INTEGER NOT NULL DEFAULT 0"),
    ("pair_changed_at", "INTEGER NOT NULL DEFAULT 0"),
];
const ENDPOINT_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("req_contract", "TEXT NOT NULL DEFAULT ''"),
    ("res_contract", "TEXT NOT NULL DEFAULT ''"),
    ("contract_hash", "TEXT NOT NULL DEFAULT ''"),
    ("handler_chunk_id", "INTEGER"),
    ("req_type_chunk_id", "INTEGER"),
    ("res_type_chunk_id", "INTEGER"),
];
const CALL_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("req_contract", "TEXT NOT NULL DEFAULT ''"),
    ("caller_chunk_id", "INTEGER"),
];
const EDGE_HISTORY_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("breaking", "INTEGER NOT NULL DEFAULT 0"),
    ("reason", "TEXT NOT NULL DEFAULT ''"),
];

const EDGE_CHUNK_JOIN_SQL: &str = "
FROM edges e
JOIN calls c ON c.id = e.call_id
JOIN endpoints ep ON ep.id = e.endpoint_id
LEFT JOIN chunks cc ON cc.id = c.caller_chunk_id
LEFT JOIN chunks hc ON hc.id = ep.handler_chunk_id";
const CHUNK_SELECT: &str = "SELECT id, repo, file, kind, qualified_name, start_line, end_line, norm_hash, first_seen_hash, first_seen_at, hash_changed_at FROM chunks";
const ENDPOINT_SELECT: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha, req_contract, res_contract, contract_hash, handler_chunk_id, req_type_chunk_id, res_type_chunk_id FROM endpoints";
const ENDPOINT_SELECT_V3: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha, req_contract, res_contract, contract_hash, NULL AS handler_chunk_id, NULL AS req_type_chunk_id, NULL AS res_type_chunk_id FROM endpoints";
const ENDPOINT_SELECT_V2: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha, '' AS req_contract, '' AS res_contract, '' AS contract_hash, NULL AS handler_chunk_id, NULL AS req_type_chunk_id, NULL AS res_type_chunk_id FROM endpoints";
const CALL_SELECT: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha, req_contract, caller_chunk_id FROM calls";
const CALL_SELECT_V3: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha, req_contract, NULL AS caller_chunk_id FROM calls";
const CALL_SELECT_V2: &str = "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha, '' AS req_contract, NULL AS caller_chunk_id FROM calls";
const SNAPSHOT_SELECT_SQL: &str = "
SELECT c.service, c.repo, c.file, c.line,
       ep.service, ep.repo, ep.file, ep.line,
       ep.method, ep.path_norm, c.path_norm, e.confidence,
       e.first_seen_sha, e.last_seen_sha, e.seen_count, e.first_seen_at,
       c.method, e.pair_key, e.verified_pair_key, e.verified_sha, e.verified_at, e.pair_changed_at
FROM edges e
JOIN calls c ON c.id = e.call_id
JOIN endpoints ep ON ep.id = e.endpoint_id";
const INSERT_HISTORY_SQL: &str = "
INSERT INTO edge_history(
    call_service, call_repo, call_file, call_line,
    endpoint_service, endpoint_repo, endpoint_file, endpoint_line,
    method, path_norm, confidence, first_seen_sha, last_seen_sha, seen_count, removed_at,
    breaking, reason
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)";

impl GraphStore {
    pub fn open_writable(path: &Path) -> Result<Self> {
        ensure_not_symlink(path)?;
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            ensure_private_dir(parent)?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(path, flags)
            .with_context(|| format!("cannot open graph db {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        conn.busy_timeout(Duration::from_secs(BUSY_TIMEOUT_SECS))?;
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        let current_ver: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if current_ver < GRAPH_SCHEMA_VERSION {
            conn.execute_batch("PRAGMA journal_mode = WAL;")?;
            conn.execute_batch(SCHEMA_SQL)?;
            migrate_schema_columns(&conn)?;
            conn.execute_batch(POST_MIGRATION_INDEXES_SQL)?;
            conn.pragma_update(None, "application_id", GRAPH_APPLICATION_ID)?;
            conn.pragma_update(None, "user_version", GRAPH_SCHEMA_VERSION)?;
        }
        Ok(Self {
            conn,
            has_contract_cols: true,
            has_chunk_cols: true,
        })
    }

    pub fn open_readonly(path: &Path) -> Result<Option<Self>> {
        match fs::symlink_metadata(path) {
            Ok(meta) => ensure!(
                !meta.file_type().is_symlink() && meta.is_file(),
                "graph db must be a regular non-symlink file: {}",
                path.display()
            ),
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(err).with_context(|| format!("cannot inspect {}", path.display()));
            }
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(path, flags)
            .with_context(|| format!("cannot open graph db read-only {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(BUSY_TIMEOUT_SECS))?;
        conn.execute_batch("PRAGMA query_only = ON;")?;
        let has_contract_cols = table_has_column(&conn, "endpoints", "req_contract")?
            && table_has_column(&conn, "calls", "req_contract")?;
        let has_chunk_cols = table_exists(&conn, "chunks")?
            && table_has_column(&conn, "edges", "pair_key")?
            && table_has_column(&conn, "endpoints", "handler_chunk_id")?
            && table_has_column(&conn, "calls", "caller_chunk_id")?;
        Ok(Some(Self {
            conn,
            has_contract_cols,
            has_chunk_cols,
        }))
    }

    fn endpoint_select_sql(&self) -> &'static str {
        if self.has_chunk_cols {
            ENDPOINT_SELECT
        } else if self.has_contract_cols {
            ENDPOINT_SELECT_V3
        } else {
            ENDPOINT_SELECT_V2
        }
    }

    fn call_select_sql(&self) -> &'static str {
        if self.has_chunk_cols {
            CALL_SELECT
        } else if self.has_contract_cols {
            CALL_SELECT_V3
        } else {
            CALL_SELECT_V2
        }
    }

    pub fn begin_write(&mut self) -> Result<GraphWriteTx<'_>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Ok(GraphWriteTx { tx })
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        get_meta_conn(&self.conn, key)
    }

    pub fn get_repo(&self, repo: &str) -> Result<Option<RepoRow>> {
        self.conn
            .query_row(
                "SELECT repo, repo_path, head_sha, extractor_ver, dirty FROM repos WHERE repo = ?1",
                params![repo],
                map_repo_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_repos(&self) -> Result<Vec<RepoRow>> {
        list_repos_conn(&self.conn)
    }

    pub fn load_file_hashes(&self, repo: &str) -> Result<HashMap<String, FileHashRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT file, content_hash, service, has_router_deps, norm_file_hash FROM file_hashes WHERE repo = ?1",
        )?;
        let rows = collect_rows(stmt.query_map(params![repo], map_file_hash_row)?)?;
        Ok(rows.into_iter().map(|r| (r.file.clone(), r)).collect())
    }

    pub fn count_file_hashes(&self, repo: &str) -> Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM file_hashes WHERE repo = ?1",
            params![repo],
            |r| r.get(0),
        )?;
        Ok(count.max(0) as usize)
    }

    pub fn get_file_hash(&self, repo: &str, file: &str) -> Result<Option<FileHashRow>> {
        self.conn
            .query_row(
                "SELECT file, content_hash, service, has_router_deps, norm_file_hash
                 FROM file_hashes WHERE repo = ?1 AND file = ?2",
                params![repo, file],
                map_file_hash_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn load_chunks_for_file(&self, repo: &str, file: &str) -> Result<Vec<ChunkRow>> {
        if !self.has_chunk_cols {
            return Ok(Vec::new());
        }
        load_chunks_for_file_conn(&self.conn, repo, file)
    }

    pub fn load_chunks_for_repo(&self, repo: Option<&str>) -> Result<Vec<ChunkRow>> {
        if !self.has_chunk_cols {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(&format!(
            "{CHUNK_SELECT} WHERE (?1 IS NULL OR repo = ?1) ORDER BY repo, file, start_line"
        ))?;
        collect_rows(stmt.query_map(params![repo], map_chunk_row)?)
    }

    pub fn load_removed_chunks(&self, repo: Option<&str>) -> Result<Vec<RemovedChunkRow>> {
        if !self.has_chunk_cols || !table_exists(&self.conn, "removed_chunks")? {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT repo, file, kind, qualified_name, removed_at
             FROM removed_chunks
             WHERE (?1 IS NULL OR repo = ?1)
             ORDER BY removed_at DESC",
        )?;
        collect_rows(stmt.query_map(params![repo], |r| {
            let kind_raw: String = r.get(2)?;
            Ok(RemovedChunkRow {
                repo: r.get(0)?,
                file: r.get(1)?,
                kind: ChunkKind::parse(&kind_raw).unwrap_or(ChunkKind::Fn),
                qualified_name: r.get(3)?,
                removed_at: r.get(4)?,
            })
        })?)
    }

    pub fn chunk_names_by_ids(&self, ids: &[i64]) -> Result<Vec<(String, String, String)>> {
        if !self.has_chunk_cols || ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare("SELECT repo, file, qualified_name FROM chunks WHERE id = ?1")?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &id in ids {
            if !seen.insert(id) {
                continue;
            }
            if let Some(row) = stmt
                .query_row(params![id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .optional()?
            {
                out.push(row);
            }
        }
        Ok(out)
    }

    pub fn load_unverified_cross_repo_edges(
        &self,
        repo: Option<&str>,
    ) -> Result<Vec<UnverifiedEdgeRow>> {
        if !self.has_chunk_cols {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(&format!(
            "SELECT c.service, c.repo, c.file, c.line,
                    ep.service, ep.repo, ep.file, ep.line,
                    ep.method, ep.path_norm, e.confidence,
                    e.pair_key, e.verified_pair_key, e.verified_sha, e.pair_changed_at,
                    COALESCE(cc.qualified_name, ''), COALESCE(hc.qualified_name, '')
             {EDGE_CHUNK_JOIN_SQL}
             WHERE c.repo != ep.repo
               AND e.pair_key != ''
               AND e.pair_key != e.verified_pair_key
               AND (?1 IS NULL OR c.repo = ?1 OR ep.repo = ?1)
             ORDER BY
               CASE WHEN e.verified_pair_key != '' THEN 0 ELSE 1 END,
               e.pair_changed_at DESC,
               ep.repo, ep.method, ep.path_norm, c.repo, c.file, c.line"
        ))?;
        collect_rows(stmt.query_map(params![repo], |r| {
            let method_raw: String = r.get(8)?;
            let conf_raw: String = r.get(10)?;
            Ok(UnverifiedEdgeRow {
                source: map_site_ref(r, 0)?,
                target: map_site_ref(r, 4)?,
                method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
                path_norm: r.get(9)?,
                confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
                verify: map_verify_meta(r, 11)?,
                pair_changed_at: r.get(14)?,
                caller_chunk: r.get(15)?,
                handler_chunk: r.get(16)?,
            })
        })?)
    }

    pub fn load_all_compose_env(
        &self,
        active_repos: &HashSet<String>,
    ) -> Result<BTreeMap<String, String>> {
        load_all_compose_env_conn(&self.conn, active_repos)
    }

    pub fn load_all_nginx_routes(
        &self,
        active_services: &HashSet<String>,
    ) -> Result<Vec<NginxRoute>> {
        load_all_nginx_routes_conn(&self.conn, active_services)
    }

    pub fn load_all_services(&self) -> Result<Vec<ServiceRow>> {
        load_all_services_conn(&self.conn)
    }

    pub fn load_all_endpoints(&self) -> Result<Vec<EndpointRow>> {
        load_all_endpoints_with_sql(&self.conn, self.endpoint_select_sql())
    }

    pub fn load_all_calls(&self) -> Result<Vec<CallRow>> {
        load_all_calls_with_sql(&self.conn, self.call_select_sql())
    }

    pub fn find_endpoints(
        &self,
        method: Option<HttpMethod>,
        path_norm: &str,
        repo: Option<&str>,
    ) -> Result<Vec<EndpointRow>> {
        let ep_sel = self.endpoint_select_sql();
        let mut stmt = self.conn.prepare(&format!(
            "{ep_sel} WHERE path_norm = ?1 AND (?2 IS NULL OR method = ?2) AND (?3 IS NULL OR repo = ?3) ORDER BY method, service, file, line"
        ))?;
        collect_rows(stmt.query_map(
            params![path_norm, method.map(HttpMethod::as_str), repo],
            map_endpoint_row,
        )?)
    }

    pub fn callers_for_endpoint(&self, endpoint_id: i64) -> Result<Vec<CallerEdge>> {
        callers_for_endpoint_conn(
            &self.conn,
            endpoint_id,
            self.has_contract_cols,
            self.has_chunk_cols,
        )
    }

    pub fn providers_for_call(&self, call_id: i64) -> Result<Vec<ProviderEdge>> {
        let ep_contract_cols = ep_contract_cols_sql(self.has_contract_cols);
        let ep_chunk_cols = ep_chunk_cols_sql(self.has_chunk_cols);
        let edge_pair_cols = edge_pair_cols_sql(self.has_chunk_cols);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT ep.id, ep.service, ep.repo, ep.method, ep.path_raw, ep.path_norm, ep.file,
                    ep.line, ep.handler, ep.prefix_state, ep.verified_sha,
                    {ep_contract_cols}, {ep_chunk_cols}, e.confidence, {edge_pair_cols}
             FROM edges e
             JOIN endpoints ep ON ep.id = e.endpoint_id
             WHERE e.call_id = ?1
             ORDER BY ep.service, ep.file, ep.line"
        ))?;
        collect_rows(stmt.query_map(params![call_id], |r| {
            let endpoint = map_endpoint_row(r)?;
            let conf_raw: String = r.get(17)?;
            Ok(ProviderEdge {
                endpoint,
                confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
                verify: map_verify_meta(r, 18)?,
            })
        })?)
    }

    pub fn endpoints_in_file(&self, repo: Option<&str>, file: &str) -> Result<Vec<EndpointRow>> {
        let ep_sel = self.endpoint_select_sql();
        let mut stmt = self.conn.prepare(&format!(
            "{ep_sel} WHERE file = ?1 AND (?2 IS NULL OR repo = ?2) ORDER BY repo, line, method"
        ))?;
        collect_rows(stmt.query_map(params![file, repo], map_endpoint_row)?)
    }

    pub fn calls_in_file(&self, repo: Option<&str>, file: &str) -> Result<Vec<CallRow>> {
        let call_sel = self.call_select_sql();
        let mut stmt = self.conn.prepare(&format!(
            "{call_sel} WHERE file = ?1 AND (?2 IS NULL OR repo = ?2) ORDER BY repo, line, method"
        ))?;
        collect_rows(stmt.query_map(params![file, repo], map_call_row)?)
    }

    pub fn calls_for_service_or_repo(
        &self,
        target: &str,
        repo: Option<&str>,
    ) -> Result<Vec<CallRow>> {
        let call_sel = self.call_select_sql();
        let mut stmt = self.conn.prepare(&format!(
            "{call_sel} WHERE (?2 IS NULL OR repo = ?2) AND (service = ?1 OR repo = ?1 OR file = ?1) ORDER BY repo, file, line"
        ))?;
        collect_rows(stmt.query_map(params![target, repo], map_call_row)?)
    }

    pub fn unresolved_calls(&self, repo: Option<&str>) -> Result<Vec<CallRow>> {
        let call_contract_col = call_contract_col_sql(self.has_contract_cols);
        let call_chunk_col = call_chunk_col_sql(self.has_chunk_cols);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                    c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha, {call_contract_col}, {call_chunk_col}
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.external = 0 AND e.call_id IS NULL AND (?1 IS NULL OR c.repo = ?1)
             ORDER BY c.repo, c.file, c.line"
        ))?;
        collect_rows(stmt.query_map(params![repo], map_call_row)?)
    }

    pub fn load_endpoints_with_contracts(&self, repo: Option<&str>) -> Result<Vec<EndpointRow>> {
        if !self.has_contract_cols {
            return Ok(Vec::new());
        }
        let ep_sel = self.endpoint_select_sql();
        let mut stmt = self.conn.prepare(&format!(
            "{ep_sel} WHERE (req_contract != '' OR res_contract != '') AND (?1 IS NULL OR repo = ?1) ORDER BY repo, service, method, path_norm"
        ))?;
        collect_rows(stmt.query_map(params![repo], map_endpoint_row)?)
    }

    pub fn load_edge_pairs(&self, repo: Option<&str>) -> Result<Vec<(EndpointRow, CallRow)>> {
        if !self.has_contract_cols {
            return Ok(Vec::new());
        }
        let ep_chunk_cols = ep_chunk_cols_sql(self.has_chunk_cols);
        let call_chunk_col = call_chunk_col_sql(self.has_chunk_cols);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT ep.id, ep.service, ep.repo, ep.method, ep.path_raw, ep.path_norm, ep.file,
                    ep.line, ep.handler, ep.prefix_state, ep.verified_sha,
                    ep.req_contract, ep.res_contract, ep.contract_hash, {ep_chunk_cols},
                    c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                    c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha, c.req_contract, {call_chunk_col}
             FROM edges e
             JOIN endpoints ep ON ep.id = e.endpoint_id
             JOIN calls c ON c.id = e.call_id
             WHERE (?1 IS NULL OR ep.repo = ?1 OR c.repo = ?1)
             ORDER BY ep.repo, ep.method, ep.path_norm, c.repo, c.file, c.line"
        ))?;
        collect_rows(stmt.query_map(params![repo], |r| {
            let ep = map_endpoint_row_at(r, 0)?;
            let call = map_call_row_at(r, 17)?;
            Ok((ep, call))
        })?)
    }

    pub fn resolved_call_files(&self) -> Result<HashSet<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT c.repo, c.file FROM edges e JOIN calls c ON c.id = e.call_id",
        )?;
        let rows = collect_rows(stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?)?;
        Ok(rows.into_iter().collect())
    }

    pub fn cross_repo_edges_for_file(
        &self,
        repo: &str,
        file: &str,
    ) -> Result<(Vec<CrossRepoEdgeInfo>, Vec<CrossRepoEdgeInfo>)> {
        let served = self.query_cross_repo_edges(CROSS_REPO_SERVED_SQL, repo, file)?;
        let called = self.query_cross_repo_edges(CROSS_REPO_CALLED_SQL, repo, file)?;
        Ok((served, called))
    }

    pub fn cross_repo_edges_for_changed_chunks(
        &self,
        repo: &str,
        file: &str,
        changed_chunk_ids: &HashSet<i64>,
    ) -> Result<(Vec<CrossRepoEdgeInfo>, Vec<CrossRepoEdgeInfo>)> {
        if !self.has_chunk_cols || changed_chunk_ids.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let file_chunks = self.load_chunks_for_file(repo, file)?;
        let mut served_stmt = self.conn.prepare(
            "SELECT DISTINCT c.repo, c.service, ep.method, ep.path_norm,
                    e.pair_key, e.verified_pair_key, e.verified_sha,
                    ep.file, ep.line, ep.handler_chunk_id, ep.req_type_chunk_id, ep.res_type_chunk_id
             FROM endpoints ep
             JOIN edges e ON e.endpoint_id = ep.id
             JOIN calls c ON c.id = e.call_id
             WHERE ep.repo = ?1 AND c.repo != ep.repo
             ORDER BY c.service, ep.method, ep.path_norm",
        )?;
        let mut served = Vec::new();
        for row in served_stmt.query_map(params![repo], |r| {
            Ok((
                map_cross_repo_info(r)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?.max(0) as usize,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<i64>>(11)?,
            ))
        })? {
            let (info, ep_file, ep_line, h_id, req_id, res_id) = row?;
            let enclosing_id = if ep_file == file {
                enclosing_chunk_id(&file_chunks, ep_line)
            } else {
                None
            };
            let hit = [h_id, req_id, res_id, enclosing_id]
                .into_iter()
                .flatten()
                .any(|cid| changed_chunk_ids.contains(&cid));
            if hit {
                served.push(info);
            }
        }

        let mut called_stmt = self.conn.prepare(
            "SELECT DISTINCT ep.repo, ep.service, c.method, ep.path_norm,
                    e.pair_key, e.verified_pair_key, e.verified_sha,
                    c.caller_chunk_id
             FROM calls c
             JOIN edges e ON e.call_id = c.id
             JOIN endpoints ep ON ep.id = e.endpoint_id
             WHERE c.repo = ?1 AND c.file = ?2 AND ep.repo != c.repo
             ORDER BY ep.service, c.method, ep.path_norm",
        )?;
        let mut called = Vec::new();
        for row in called_stmt.query_map(params![repo, file], |r| {
            Ok((map_cross_repo_info(r)?, r.get::<_, Option<i64>>(7)?))
        })? {
            let (info, caller_id) = row?;
            if caller_id.is_some_and(|cid| changed_chunk_ids.contains(&cid)) {
                called.push(info);
            }
        }
        Ok((served, called))
    }

    fn query_cross_repo_edges(
        &self,
        sql: &str,
        repo: &str,
        file: &str,
    ) -> Result<Vec<CrossRepoEdgeInfo>> {
        let mut stmt = self.conn.prepare(sql)?;
        collect_rows(stmt.query_map(params![repo, file], map_cross_repo_info)?)
    }

    pub fn load_cross_repo_changes(
        &self,
        since_ms: i64,
        repo: Option<&str>,
    ) -> Result<Vec<EdgeChangeRow>> {
        let has_history_table: bool = self.conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = ?1 AND name = ?2",
            params![SCHEMA_OBJECT_TABLE, TABLE_EDGE_HISTORY],
            |r| r.get(0),
        )?;
        if !has_history_table {
            return Ok(Vec::new());
        }
        let mut added_stmt = self.conn.prepare(
            "SELECT c.service, c.repo, c.file, c.line,
                    ep.service, ep.repo, ep.file, ep.line,
                    ep.method, ep.path_norm, e.first_seen_sha, e.seen_count, e.first_seen_at,
                    0, ''
             FROM edges e
             JOIN calls c ON c.id = e.call_id
             JOIN endpoints ep ON ep.id = e.endpoint_id
             WHERE c.repo != ep.repo
               AND e.first_seen_at >= ?1
               AND (?2 IS NULL OR c.repo = ?2 OR ep.repo = ?2)",
        )?;
        let mut out = collect_rows(added_stmt.query_map(params![since_ms, repo], |r| {
            map_edge_change_row(r, EdgeChangeKind::Added)
        })?)?;

        let has_breaking_col = table_has_column(&self.conn, TABLE_EDGE_HISTORY, "breaking")?;
        let extra_cols = if has_breaking_col {
            "breaking, reason"
        } else {
            "0, ''"
        };
        let rem_sql = format!(
            "SELECT call_service, call_repo, call_file, call_line,
                    endpoint_service, endpoint_repo, endpoint_file, endpoint_line,
                    method, path_norm, last_seen_sha, seen_count, removed_at,
                    {extra_cols}
             FROM edge_history
             WHERE call_repo != endpoint_repo
               AND removed_at >= ?1
               AND (?2 IS NULL OR call_repo = ?2 OR endpoint_repo = ?2)"
        );
        let mut rem_stmt = self.conn.prepare(&rem_sql)?;
        out.extend(collect_rows(rem_stmt.query_map(params![since_ms, repo], |r| {
            map_edge_change_row(r, EdgeChangeKind::Removed)
        })?)?);

        out.sort_by(|a, b| {
            b.timestamp_ms
                .cmp(&a.timestamp_ms)
                .then_with(|| a.kind.as_str().cmp(b.kind.as_str()))
                .then_with(|| a.source.service.cmp(&b.source.service))
                .then_with(|| a.target.service.cmp(&b.target.service))
                .then_with(|| a.path_norm.cmp(&b.path_norm))
        });
        Ok(out)
    }

    pub fn counts(&self) -> Result<GraphCounts> {
        let endpoints: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM endpoints", [], |r| r.get(0))?;
        let calls: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM calls", [], |r| r.get(0))?;
        let edges: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))?;
        let (fog_total, fog_by_repo) = count_by_repo_conn(
            &self.conn,
            "SELECT c.repo, COUNT(*)
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.external = 0 AND e.call_id IS NULL
             GROUP BY c.repo
             ORDER BY c.repo",
        )?;
        let (chunks_total, chunks_by_repo) = if self.has_chunk_cols {
            count_by_repo_conn(
                &self.conn,
                "SELECT repo, COUNT(*) FROM chunks GROUP BY repo ORDER BY repo",
            )?
        } else {
            (0, BTreeMap::new())
        };
        Ok(GraphCounts {
            endpoints: endpoints.max(0) as usize,
            calls: calls.max(0) as usize,
            edges: edges.max(0) as usize,
            fog: fog_total,
            fog_by_repo,
            chunks: chunks_total,
            chunks_by_repo,
        })
    }
}

impl GraphWriteTx<'_> {
    pub fn commit(self) -> Result<()> {
        self.tx.commit()?;
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.tx.execute(
            "INSERT INTO graph_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        get_meta_conn(&self.tx, key)
    }

    pub fn prune_removed_repos(
        &self,
        active_repos: &HashSet<String>,
        now_ms: i64,
    ) -> Result<(bool, usize)> {
        let removed: Vec<String> = list_repos_conn(&self.tx)?
            .into_iter()
            .map(|r| r.repo)
            .filter(|r| !active_repos.contains(r))
            .collect();
        if removed.is_empty() {
            return Ok((false, 0));
        }
        let mut removed_edges = 0usize;
        let mut hist_stmt = self.tx.prepare(INSERT_HISTORY_SQL)?;
        for repo in &removed {
            let mut snap_stmt = self.tx.prepare(&format!(
                "{SNAPSHOT_SELECT_SQL} WHERE c.repo = ?1 OR ep.repo = ?1"
            ))?;
            let snaps = collect_rows(snap_stmt.query_map(params![repo], map_edge_snapshot)?)?;
            for snap in &snaps {
                insert_history_row(&mut hist_stmt, snap, now_ms, None)?;
                removed_edges += 1;
            }
            drop(snap_stmt);
            let mut svc_stmt = self
                .tx
                .prepare("SELECT name FROM services WHERE repo = ?1")?;
            let removed_svcs =
                collect_rows(svc_stmt.query_map(params![repo], |r| r.get::<_, String>(0))?)?;
            drop(svc_stmt);
            for svc in &removed_svcs {
                self.delete_service_meta(svc)?;
            }
            let env_key = format!("compose_env:{repo}");
            for table in REPO_SCOPED_TABLES {
                self.tx
                    .execute(&format!("DELETE FROM {table} WHERE repo = ?1"), params![repo])?;
            }
            self.tx
                .execute("DELETE FROM graph_meta WHERE key = ?1", params![env_key])?;
        }
        Ok((true, removed_edges))
    }

    pub fn sync_services(&self, services: &BTreeMap<String, ServiceConfig>) -> Result<()> {
        self.tx.execute("DELETE FROM services", [])?;
        let mut stmt = self.tx.prepare(
            "INSERT INTO services(name, repo, root, stack, base_service, base_prefix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (name, svc) in services {
            stmt.execute(params![
                name,
                svc.repo,
                svc.root,
                svc.stack.as_str(),
                svc.base.as_deref(),
                svc.base_prefix.as_deref(),
            ])?;
        }
        Ok(())
    }

    pub fn upsert_repo(&self, repo: &RepoRow, refreshed_at: i64) -> Result<()> {
        self.tx.execute(
            "INSERT INTO repos(repo, repo_path, head_sha, extractor_ver, dirty, refreshed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(repo) DO UPDATE SET
               repo_path = excluded.repo_path,
               head_sha = excluded.head_sha,
               extractor_ver = excluded.extractor_ver,
               dirty = excluded.dirty,
               refreshed_at = excluded.refreshed_at",
            params![
                repo.repo,
                repo.repo_path,
                repo.head_sha,
                repo.extractor_ver,
                i64::from(repo.dirty),
                refreshed_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_files(&self, repo: &str, files: &[String]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let mut del_ep = self
            .tx
            .prepare("DELETE FROM endpoints WHERE repo = ?1 AND file = ?2")?;
        let mut del_call = self
            .tx
            .prepare("DELETE FROM calls WHERE repo = ?1 AND file = ?2")?;
        let mut del_hash = self
            .tx
            .prepare("DELETE FROM file_hashes WHERE repo = ?1 AND file = ?2")?;
        for file in files {
            del_ep.execute(params![repo, file])?;
            del_call.execute(params![repo, file])?;
            del_hash.execute(params![repo, file])?;
        }
        Ok(())
    }

    pub fn delete_service_meta(&self, service: &str) -> Result<()> {
        for prefix in [
            "axum_ctx:",
            "ts_wrappers:",
            "web_exports:",
            "nginx_routes:",
            "svc_cfg_hash:",
        ] {
            let key = format!("{prefix}{service}");
            self.tx
                .execute("DELETE FROM graph_meta WHERE key = ?1", params![key])?;
        }
        Ok(())
    }

    pub fn delete_service(&self, repo: &str, service: &str) -> Result<()> {
        for table in SERVICE_SCOPED_TABLES {
            self.tx.execute(
                &format!("DELETE FROM {table} WHERE repo = ?1 AND service = ?2"),
                params![repo, service],
            )?;
        }
        Ok(())
    }

    pub fn delete_chunks_for_files(
        &self,
        repo: &str,
        files: &[String],
        now_ms: i64,
    ) -> Result<usize> {
        if files.is_empty() {
            return Ok(0);
        }
        let mut ins_rem = self.tx.prepare(
            "INSERT OR REPLACE INTO removed_chunks(repo, file, kind, qualified_name, removed_at)
             SELECT repo, file, kind, qualified_name, ?3 FROM chunks WHERE repo = ?1 AND file = ?2",
        )?;
        let mut del = self
            .tx
            .prepare("DELETE FROM chunks WHERE repo = ?1 AND file = ?2")?;
        let mut removed = 0usize;
        for file in files {
            ins_rem.execute(params![repo, file, now_ms])?;
            removed += del.execute(params![repo, file])?;
        }
        Ok(removed)
    }

    pub fn upsert_file_chunks(
        &self,
        repo: &str,
        file: &str,
        chunks: &[ExtractedChunk],
        now_ms: i64,
    ) -> Result<(usize, Vec<i64>)> {
        let old_rows = load_chunks_for_file_conn(&self.tx, repo, file)?;
        let mut old_by_key: HashMap<(ChunkKind, String), ChunkRow> = old_rows
            .into_iter()
            .map(|r| ((r.kind, r.qualified_name.clone()), r))
            .collect();

        let mut upsert_stmt = self.tx.prepare(
            "INSERT INTO chunks(
                repo, file, kind, qualified_name, start_line, end_line,
                norm_hash, first_seen_hash, first_seen_at, hash_changed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, 0)
             ON CONFLICT(repo, file, kind, qualified_name) DO UPDATE SET
               start_line = excluded.start_line,
               end_line = excluded.end_line,
               hash_changed_at = CASE
                 WHEN chunks.norm_hash != excluded.norm_hash THEN excluded.first_seen_at
                 ELSE chunks.hash_changed_at
               END,
               norm_hash = excluded.norm_hash",
        )?;
        let mut id_stmt = self.tx.prepare(
            "SELECT id FROM chunks WHERE repo = ?1 AND file = ?2 AND kind = ?3 AND qualified_name = ?4",
        )?;
        let mut clear_rem = self.tx.prepare(
            "DELETE FROM removed_chunks WHERE repo = ?1 AND file = ?2 AND kind = ?3 AND qualified_name = ?4",
        )?;

        let mut changed_count = 0usize;
        let mut changed_ids = Vec::new();
        for chunk in chunks {
            let key = (chunk.kind, chunk.qualified_name.clone());
            let prev = old_by_key.remove(&key);
            let hash_changed = prev
                .as_ref()
                .is_none_or(|p| p.norm_hash != chunk.norm_hash);
            let lines_changed = prev
                .as_ref()
                .is_none_or(|p| p.start_line != chunk.start_line || p.end_line != chunk.end_line);
            if hash_changed || lines_changed {
                upsert_stmt.execute(params![
                    repo,
                    file,
                    chunk.kind.as_str(),
                    chunk.qualified_name,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.norm_hash,
                    now_ms,
                ])?;
            }
            if hash_changed {
                changed_count += 1;
                if prev.is_none() {
                    clear_rem.execute(params![
                        repo,
                        file,
                        chunk.kind.as_str(),
                        chunk.qualified_name,
                    ])?;
                }
                let cid: i64 = id_stmt.query_row(
                    params![repo, file, chunk.kind.as_str(), chunk.qualified_name],
                    |r| r.get(0),
                )?;
                changed_ids.push(cid);
            }
        }
        drop(upsert_stmt);
        drop(id_stmt);
        drop(clear_rem);

        if !old_by_key.is_empty() {
            let mut del_stmt = self.tx.prepare("DELETE FROM chunks WHERE id = ?1")?;
            let mut rem_stmt = self.tx.prepare(
                "INSERT OR REPLACE INTO removed_chunks(repo, file, kind, qualified_name, removed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for ((kind, qname), old_row) in old_by_key {
                del_stmt.execute(params![old_row.id])?;
                rem_stmt.execute(params![repo, file, kind.as_str(), qname, now_ms])?;
                changed_count += 1;
            }
        }
        Ok((changed_count, changed_ids))
    }

    pub fn insert_endpoints(
        &self,
        repo: &str,
        head_sha: &str,
        service_endpoints: &[(String, Vec<ExtractedEndpoint>)],
    ) -> Result<()> {
        let mut chunk_cache: HashMap<String, Vec<ChunkRow>> = HashMap::new();
        let mut stmt = self.tx.prepare(
            "INSERT INTO endpoints(
                service, repo, method, path_raw, path_norm, file, line, handler, prefix_state,
                verified_sha, req_contract, res_contract, contract_hash,
                handler_chunk_id, req_type_chunk_id, res_type_chunk_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )?;
        for (service, endpoints) in service_endpoints {
            for ep in endpoints {
                let req_json = serialize_contract(ep.req_contract.as_ref());
                let res_json = serialize_contract(ep.res_contract.as_ref());
                let handler_chunk_id = resolve_endpoint_handler_chunk(
                    &self.tx,
                    repo,
                    ep,
                    &mut chunk_cache,
                )?;
                let req_type_chunk_id = resolve_chunk_ref_cached(
                    &self.tx,
                    repo,
                    ep.chunk_refs.req_type.as_ref(),
                    &mut chunk_cache,
                )?;
                let res_type_chunk_id = resolve_chunk_ref_cached(
                    &self.tx,
                    repo,
                    ep.chunk_refs.res_type.as_ref(),
                    &mut chunk_cache,
                )?;
                stmt.execute(params![
                    service,
                    repo,
                    ep.method.as_str(),
                    ep.path_raw,
                    ep.path_norm,
                    ep.file,
                    ep.line as i64,
                    ep.handler,
                    ep.prefix_state.as_str(),
                    head_sha,
                    req_json,
                    res_json,
                    ep.contract_hash,
                    handler_chunk_id,
                    req_type_chunk_id,
                    res_type_chunk_id,
                ])?;
            }
        }
        Ok(())
    }

    pub fn insert_calls(
        &self,
        repo: &str,
        head_sha: &str,
        service_calls: &[(String, Vec<ExtractedCall>)],
    ) -> Result<()> {
        let mut chunk_cache: HashMap<String, Vec<ChunkRow>> = HashMap::new();
        let mut stmt = self.tx.prepare(
            "INSERT INTO calls(
                service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area,
                why, external, verified_sha, req_contract, caller_chunk_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for (service, calls) in service_calls {
            for c in calls {
                let req_json = serialize_contract(c.req_contract.as_ref());
                let file_chunks = cached_file_chunks(&self.tx, repo, &c.file, &mut chunk_cache)?;
                let caller_chunk_id = enclosing_chunk_id(file_chunks, c.line);
                stmt.execute(params![
                    service,
                    repo,
                    c.method.as_str(),
                    c.path_raw,
                    c.path_norm,
                    c.file,
                    c.line as i64,
                    c.base_ref,
                    c.symbol,
                    c.area,
                    c.why,
                    i64::from(c.external),
                    head_sha,
                    req_json,
                    caller_chunk_id,
                ])?;
            }
        }
        Ok(())
    }

    pub fn upsert_file_hashes(&self, repo: &str, rows: &[FileHashRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut stmt = self.tx.prepare(
            "INSERT INTO file_hashes(repo, file, content_hash, service, has_router_deps, norm_file_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(repo, file) DO UPDATE SET
               content_hash = excluded.content_hash,
               service = excluded.service,
               has_router_deps = excluded.has_router_deps,
               norm_file_hash = excluded.norm_file_hash",
        )?;
        for row in rows {
            stmt.execute(params![
                repo,
                row.file,
                row.content_hash,
                row.service,
                i64::from(row.has_router_deps),
                row.norm_file_hash,
            ])?;
        }
        Ok(())
    }

    pub fn update_file_content_hash(&self, repo: &str, file: &str, content_hash: &str) -> Result<()> {
        self.tx.execute(
            "UPDATE file_hashes SET content_hash = ?1 WHERE repo = ?2 AND file = ?3",
            params![content_hash, repo, file],
        )?;
        Ok(())
    }

    pub fn load_all_compose_env(
        &self,
        active_repos: &HashSet<String>,
    ) -> Result<BTreeMap<String, String>> {
        load_all_compose_env_conn(&self.tx, active_repos)
    }

    pub fn load_all_nginx_routes(
        &self,
        active_services: &HashSet<String>,
    ) -> Result<Vec<NginxRoute>> {
        load_all_nginx_routes_conn(&self.tx, active_services)
    }

    pub fn load_all_services(&self) -> Result<Vec<ServiceRow>> {
        load_all_services_conn(&self.tx)
    }

    pub fn load_all_endpoints(&self) -> Result<Vec<EndpointRow>> {
        load_all_endpoints_conn(&self.tx)
    }

    pub fn load_all_calls(&self) -> Result<Vec<CallRow>> {
        load_all_calls_conn(&self.tx)
    }

    pub fn load_endpoints_for_files(
        &self,
        repo_files: &[(String, String)],
    ) -> Result<Vec<EndpointRow>> {
        query_for_repo_files(
            &self.tx,
            &format!("{ENDPOINT_SELECT} WHERE repo = ?1 AND file = ?2 ORDER BY id"),
            repo_files,
            map_endpoint_row,
        )
    }

    pub fn load_endpoints_for_service(&self, repo: &str, service: &str) -> Result<Vec<EndpointRow>> {
        let mut stmt = self
            .tx
            .prepare(&format!("{ENDPOINT_SELECT} WHERE repo = ?1 AND service = ?2 ORDER BY id"))?;
        collect_rows(stmt.query_map(params![repo, service], map_endpoint_row)?)
    }

    pub fn load_calls_for_files(&self, repo_files: &[(String, String)]) -> Result<Vec<CallRow>> {
        query_for_repo_files(
            &self.tx,
            &format!("{CALL_SELECT} WHERE repo = ?1 AND file = ?2 ORDER BY id"),
            repo_files,
            map_call_row,
        )
    }

    pub fn load_calls_for_service(&self, repo: &str, service: &str) -> Result<Vec<CallRow>> {
        let mut stmt = self
            .tx
            .prepare(&format!("{CALL_SELECT} WHERE repo = ?1 AND service = ?2 ORDER BY id"))?;
        collect_rows(stmt.query_map(params![repo, service], map_call_row)?)
    }

    pub fn load_endpoints_for_keys(
        &self,
        keys: &HashSet<(HttpMethod, String)>,
        include_partial: bool,
    ) -> Result<Vec<EndpointRow>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        if !keys.is_empty() {
            let mut stmt = self.tx.prepare(&format!(
                "{ENDPOINT_SELECT} WHERE method = ?1 AND path_norm = ?2 ORDER BY id"
            ))?;
            let mut query_keys: HashSet<(HttpMethod, &str)> = HashSet::new();
            for (method, path) in keys {
                query_keys.insert((*method, path.as_str()));
                if *method != HttpMethod::Any {
                    query_keys.insert((HttpMethod::Any, path.as_str()));
                }
            }
            for (method, path) in query_keys {
                for ep in collect_rows(stmt.query_map(params![method.as_str(), path], map_endpoint_row)?)? {
                    if seen.insert(ep.id) {
                        out.push(ep);
                    }
                }
            }
        }
        if include_partial {
            let mut stmt = self
                .tx
                .prepare(&format!("{ENDPOINT_SELECT} WHERE prefix_state = ?1 ORDER BY id"))?;
            for ep in collect_rows(
                stmt.query_map(params![PrefixState::Partial.as_str()], map_endpoint_row)?,
            )? {
                if seen.insert(ep.id) {
                    out.push(ep);
                }
            }
        }
        Ok(out)
    }

    pub fn load_calls_for_keys(&self, keys: &HashSet<(HttpMethod, String)>) -> Result<Vec<CallRow>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let mut by_method = self
            .tx
            .prepare(&format!("{CALL_SELECT} WHERE method = ?1 AND path_norm = ?2 ORDER BY id"))?;
        let mut any_method = self
            .tx
            .prepare(&format!("{CALL_SELECT} WHERE path_norm = ?1 ORDER BY id"))?;
        for (method, path) in keys {
            let rows = if *method == HttpMethod::Any {
                collect_rows(any_method.query_map(params![path], map_call_row)?)?
            } else {
                collect_rows(by_method.query_map(params![method.as_str(), path], map_call_row)?)?
            };
            for call in rows {
                if seen.insert(call.id) {
                    out.push(call);
                }
            }
        }
        Ok(out)
    }

    pub fn snapshot_all_edges(&self) -> Result<Vec<ExistingEdgeSnapshot>> {
        let mut stmt = self.tx.prepare(SNAPSHOT_SELECT_SQL)?;
        collect_rows(stmt.query_map([], map_edge_snapshot)?)
    }

    pub fn snapshot_edges_for_ids(
        &self,
        endpoint_ids: &[i64],
        call_ids: &[i64],
    ) -> Result<Vec<ExistingEdgeSnapshot>> {
        let mut by_key: HashMap<EdgeLogicalKey, ExistingEdgeSnapshot> = HashMap::new();
        collect_snapshots_by_column(&self.tx, "e.endpoint_id", endpoint_ids, &mut by_key)?;
        collect_snapshots_by_column(&self.tx, "e.call_id", call_ids, &mut by_key)?;
        Ok(by_key.into_values().collect())
    }

    pub fn callers_for_endpoint(&self, endpoint_id: i64) -> Result<Vec<CallerEdge>> {
        callers_for_endpoint_conn(&self.tx, endpoint_id, true, true)
    }

    pub fn endpoint_exists(
        &self,
        service: &str,
        file: &str,
        method: HttpMethod,
        path_norm: &str,
    ) -> Result<bool> {
        let count: i64 = self.tx.query_row(
            "SELECT COUNT(*) FROM endpoints
             WHERE service = ?1 AND file = ?2 AND method = ?3 AND path_norm = ?4",
            params![service, file, method.as_str(), path_norm],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn call_site_is_unresolved(
        &self,
        repo: &str,
        file: &str,
        method: HttpMethod,
        call_path_norm: &str,
    ) -> Result<bool> {
        let count: i64 = self.tx.query_row(
            "SELECT COUNT(*)
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.repo = ?1 AND c.file = ?2 AND c.method = ?3 AND c.path_norm = ?4
               AND c.external = 0 AND e.call_id IS NULL",
            params![repo, file, method.as_str(), call_path_norm],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn load_unresolved_calls_in_file(&self, repo: &str, file: &str) -> Result<Vec<CallRow>> {
        let mut stmt = self.tx.prepare(
            "SELECT c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                    c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha, c.req_contract,
                    c.caller_chunk_id
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.repo = ?1 AND c.file = ?2 AND c.external = 0 AND e.call_id IS NULL
             ORDER BY c.line, c.id",
        )?;
        collect_rows(stmt.query_map(params![repo, file], map_call_row)?)
    }

    pub fn load_unresolved_call_keys_for_scope(
        &self,
        repo_files: &[(String, String)],
        full_services: &[(String, String)],
    ) -> Result<HashSet<(String, String, HttpMethod, String)>> {
        let mut out = HashSet::new();
        for (repo, file) in repo_files {
            for c in self.load_unresolved_calls_in_file(repo, file)? {
                out.insert((c.repo, c.call.file, c.call.method, c.call.path_norm));
            }
        }
        if !full_services.is_empty() {
            let mut stmt = self.tx.prepare(
                "SELECT c.repo, c.file, c.method, c.path_norm
                 FROM calls c
                 LEFT JOIN edges e ON e.call_id = c.id
                 WHERE c.repo = ?1 AND c.service = ?2 AND c.external = 0 AND e.call_id IS NULL",
            )?;
            for (repo, svc) in full_services {
                let rows = collect_rows(stmt.query_map(params![repo, svc], |r| {
                    let m_raw: String = r.get(2)?;
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        HttpMethod::parse(&m_raw).unwrap_or(HttpMethod::Any),
                        r.get::<_, String>(3)?,
                    ))
                })?)?;
                out.extend(rows);
            }
        }
        Ok(out)
    }

    pub fn write_edges_and_collect_lost(
        &self,
        batch: &EdgeUpdateBatch<'_>,
    ) -> Result<(usize, Vec<ExistingEdgeSnapshot>)> {
        if batch.full_replace {
            self.tx.execute("DELETE FROM edges", [])?;
        } else if !batch.replace_call_ids.is_empty() {
            let mut del = self.tx.prepare("DELETE FROM edges WHERE call_id = ?1")?;
            for &cid in batch.replace_call_ids {
                del.execute(params![cid])?;
            }
        }

        let chunk_hashes = load_chunk_hashes_for_edges(&self.tx, batch.calls_by_id, batch.eps_by_id)?;
        let old_by_key: HashMap<EdgeLogicalKey, &ExistingEdgeSnapshot> = batch
            .old_snapshots
            .iter()
            .map(|s| (s.logical_key(), s))
            .collect();
        let mut surviving_keys: HashSet<EdgeLogicalKey> = HashSet::new();
        let mut added = 0usize;

        let mut ins_edge = self.tx.prepare(
            "INSERT OR REPLACE INTO edges(
                call_id, endpoint_id, confidence, first_seen_sha, last_seen_sha,
                seen_count, first_seen_at, last_seen_at,
                pair_key, verified_pair_key, verified_sha, verified_at, pair_changed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for edge in batch.new_edges {
            let (Some(call), Some(ep)) = (
                batch.calls_by_id.get(&edge.call_id),
                batch.eps_by_id.get(&edge.endpoint_id),
            ) else {
                continue;
            };
            let key = EdgeLogicalKey {
                source: SiteKey {
                    service: call.service.clone(),
                    repo: call.repo.clone(),
                    file: call.file.clone(),
                },
                target: SiteKey {
                    service: ep.service.clone(),
                    repo: ep.repo.clone(),
                    file: ep.file.clone(),
                },
                method: ep.method,
                path_norm: ep.path_norm.clone(),
            };
            let current_sha = if batch.changed_repos.contains(&call.repo) {
                call.verified_sha.as_str()
            } else {
                ep.verified_sha.as_str()
            };
            let prev = old_by_key.get(&key).copied();
            let (first_sha, seen_count, first_at) = resolve_history_fields(
                prev,
                current_sha,
                batch.now_ms,
                &mut added,
            );
            let caller_hash = call
                .caller_chunk_id
                .and_then(|id| chunk_hashes.get(&id))
                .map(String::as_str)
                .unwrap_or("");
            let handler_hash = ep
                .chunk_ids
                .handler
                .and_then(|id| chunk_hashes.get(&id))
                .map(String::as_str)
                .unwrap_or("");
            let pair_key = compute_pair_key(caller_hash, handler_hash, &ep.contract_hash);
            let (verified_pair_key, verified_sha, verified_at, pair_changed_at) = match prev {
                Some(p) => {
                    let changed_at = if !p.verify.pair_key.is_empty() && p.verify.pair_key != pair_key {
                        batch.now_ms
                    } else {
                        p.pair_changed_at
                    };
                    (
                        p.verify.verified_pair_key.as_str(),
                        p.verify.verified_sha.as_str(),
                        p.verified_at,
                        changed_at,
                    )
                }
                None => ("", "", 0, 0),
            };
            surviving_keys.insert(key);
            ins_edge.execute(params![
                edge.call_id,
                edge.endpoint_id,
                edge.confidence.as_str(),
                first_sha,
                current_sha,
                seen_count,
                first_at,
                batch.now_ms,
                pair_key,
                verified_pair_key,
                verified_sha,
                verified_at,
                pair_changed_at,
            ])?;
        }
        drop(ins_edge);

        let mut lost = Vec::new();
        for (key, snap) in &old_by_key {
            if !surviving_keys.contains(key) {
                lost.push((*snap).clone());
            }
        }
        Ok((added, lost))
    }

    pub fn refresh_pair_keys_for_chunks(
        &self,
        changed_chunk_ids: &[i64],
        now_ms: i64,
    ) -> Result<usize> {
        if changed_chunk_ids.is_empty() {
            return Ok(0);
        }
        let mut edge_stmt = self.tx.prepare(&format!(
            "SELECT e.call_id, e.endpoint_id, e.pair_key,
                    COALESCE(cc.norm_hash, ''), COALESCE(hc.norm_hash, ''), ep.contract_hash
             {EDGE_CHUNK_JOIN_SQL}
             WHERE c.caller_chunk_id = ?1 OR ep.handler_chunk_id = ?1"
        ))?;
        let mut updates = Vec::new();
        let mut seen = HashSet::new();
        for &cid in changed_chunk_ids {
            let rows = collect_rows(edge_stmt.query_map(params![cid], map_edge_quad_str)?)?;
            for (call_id, ep_id, old_pair, caller_h, handler_h, contract_h) in rows {
                if !seen.insert((call_id, ep_id)) {
                    continue;
                }
                let new_pair = compute_pair_key(&caller_h, &handler_h, &contract_h);
                if new_pair != old_pair {
                    updates.push((call_id, ep_id, new_pair));
                }
            }
        }
        drop(edge_stmt);
        let mut upd = self.tx.prepare(
            "UPDATE edges SET pair_key = ?1, pair_changed_at = ?2 WHERE call_id = ?3 AND endpoint_id = ?4",
        )?;
        for (call_id, ep_id, new_pair) in &updates {
            upd.execute(params![new_pair, now_ms, call_id, ep_id])?;
        }
        Ok(updates.len())
    }

    pub fn verify_repo_edges(&self, repo: &str, target_sha: &str, now_ms: i64) -> Result<usize> {
        let head_sha: Option<String> = self
            .tx
            .query_row(
                "SELECT head_sha FROM repos WHERE repo = ?1",
                params![repo],
                |r| r.get(0),
            )
            .optional()?;
        let Some(head_sha) = head_sha else {
            return Ok(0);
        };
        if !sha_matches(&head_sha, target_sha) {
            return Ok(0);
        }
        let updated = self.tx.execute(
            "UPDATE edges
             SET verified_pair_key = pair_key, verified_sha = ?1, verified_at = ?2
             WHERE pair_key != ''
               AND (
                   call_id IN (SELECT id FROM calls WHERE repo = ?3)
                   OR endpoint_id IN (SELECT id FROM endpoints WHERE repo = ?3)
               )",
            params![target_sha, now_ms, repo],
        )?;
        Ok(updated)
    }

    pub fn record_lost_edge_history(
        &self,
        lost: &[ExistingEdgeSnapshot],
        breaking_reasons: &HashMap<EdgeLogicalKey, BreakingKind>,
        now_ms: i64,
    ) -> Result<usize> {
        let mut ins_hist = self.tx.prepare(INSERT_HISTORY_SQL)?;
        for snap in lost {
            let reason = breaking_reasons.get(&snap.logical_key()).copied();
            insert_history_row(&mut ins_hist, snap, now_ms, reason)?;
        }
        Ok(lost.len())
    }

    pub fn apply_edge_updates(&self, batch: &EdgeUpdateBatch<'_>) -> Result<(usize, usize)> {
        let (added, lost) = self.write_edges_and_collect_lost(batch)?;
        let removed = self.record_lost_edge_history(&lost, &HashMap::new(), batch.now_ms)?;
        Ok((added, removed))
    }

    pub fn update_calls_external_flags(&self, external_globs: &[String]) -> Result<usize> {
        let calls = load_all_calls_conn(&self.tx)?;
        let mut stmt = self
            .tx
            .prepare("UPDATE calls SET external = ?1 WHERE id = ?2")?;
        let mut changed = 0usize;
        for call in &calls {
            let ext = matches_external_glob(external_globs, &call.repo, &call.file);
            if ext != call.external {
                stmt.execute(params![i64::from(ext), call.id])?;
                changed += 1;
            }
        }
        Ok(changed)
    }
}

fn query_for_repo_files<T>(
    tx: &Transaction<'_>,
    sql: &str,
    repo_files: &[(String, String)],
    mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    if repo_files.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = tx.prepare(sql)?;
    let mut out = Vec::new();
    for (repo, file) in repo_files {
        out.extend(collect_rows(stmt.query_map(params![repo, file], mapper)?)?);
    }
    Ok(out)
}

fn resolve_history_fields(
    prev: Option<&ExistingEdgeSnapshot>,
    current_sha: &str,
    now_ms: i64,
    added: &mut usize,
) -> (String, i64, i64) {
    let Some(prev) = prev else {
        *added += 1;
        return (current_sha.to_owned(), 1, now_ms);
    };
    let first_sha = if prev.first_seen_sha.is_empty() {
        current_sha.to_owned()
    } else {
        prev.first_seen_sha.clone()
    };
    let first_at = if prev.first_seen_at == 0 {
        now_ms
    } else {
        prev.first_seen_at
    };
    (first_sha, prev.seen_count + 1, first_at)
}

fn collect_snapshots_by_column(
    tx: &Transaction<'_>,
    column: &str,
    ids: &[i64],
    by_key: &mut HashMap<EdgeLogicalKey, ExistingEdgeSnapshot>,
) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut stmt = tx.prepare(&format!("{SNAPSHOT_SELECT_SQL} WHERE {column} = ?1"))?;
    for &id in ids {
        for snap in collect_rows(stmt.query_map(params![id], map_edge_snapshot)?)? {
            by_key.entry(snap.logical_key()).or_insert(snap);
        }
    }
    Ok(())
}

fn insert_history_row(
    stmt: &mut rusqlite::Statement<'_>,
    snap: &ExistingEdgeSnapshot,
    removed_at: i64,
    breaking_reason: Option<BreakingKind>,
) -> Result<()> {
    let breaking = i64::from(breaking_reason.is_some());
    let reason = breaking_reason.map_or("", BreakingKind::as_str);
    stmt.execute(params![
        snap.source.service,
        snap.source.repo,
        snap.source.file,
        snap.source.line as i64,
        snap.target.service,
        snap.target.repo,
        snap.target.file,
        snap.target.line as i64,
        snap.method.as_str(),
        snap.path_norm,
        snap.confidence.as_str(),
        snap.first_seen_sha,
        snap.last_seen_sha,
        snap.seen_count,
        removed_at,
        breaking,
        reason,
    ])?;
    Ok(())
}

fn migrate_schema_columns(conn: &Connection) -> Result<()> {
    migrate_table_columns(conn, "file_hashes", FILE_HASH_MIGRATION_COLUMNS)?;
    migrate_table_columns(conn, "edges", EDGE_MIGRATION_COLUMNS)?;
    migrate_table_columns(conn, "endpoints", ENDPOINT_MIGRATION_COLUMNS)?;
    migrate_table_columns(conn, "calls", CALL_MIGRATION_COLUMNS)?;
    migrate_table_columns(conn, TABLE_EDGE_HISTORY, EDGE_HISTORY_MIGRATION_COLUMNS)?;
    Ok(())
}

fn migrate_table_columns(conn: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let existing: HashSet<String> =
        collect_rows(stmt.query_map([], |r| r.get::<_, String>(1))?)?
            .into_iter()
            .collect();
    drop(stmt);
    for (col, spec) in columns {
        if !existing.contains(*col) {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {spec}"), [])?;
        }
    }
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = collect_rows(stmt.query_map([], |r| r.get::<_, String>(1))?)?;
    Ok(cols.iter().any(|c| c == col))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = ?1 AND name = ?2",
        params![SCHEMA_OBJECT_TABLE, table],
        |r| r.get(0),
    )?;
    Ok(exists)
}

fn load_chunks_for_file_conn(conn: &Connection, repo: &str, file: &str) -> Result<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(&format!(
        "{CHUNK_SELECT} WHERE repo = ?1 AND file = ?2 ORDER BY start_line, id"
    ))?;
    collect_rows(stmt.query_map(params![repo, file], map_chunk_row)?)
}

fn count_by_repo_conn(conn: &Connection, sql: &str) -> Result<(usize, BTreeMap<String, usize>)> {
    let mut by_repo = BTreeMap::new();
    let mut total = 0usize;
    let mut stmt = conn.prepare(sql)?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (repo, count) = row?;
        let count = count.max(0) as usize;
        total += count;
        by_repo.insert(repo, count);
    }
    Ok((total, by_repo))
}

fn cached_file_chunks<'a>(
    conn: &Connection,
    repo: &str,
    file: &str,
    cache: &'a mut HashMap<String, Vec<ChunkRow>>,
) -> Result<&'a [ChunkRow]> {
    if !cache.contains_key(file) {
        let rows = load_chunks_for_file_conn(conn, repo, file)?;
        cache.insert(file.to_owned(), rows);
    }
    Ok(cache.get(file).map(Vec::as_slice).unwrap_or(&[]))
}

fn enclosing_chunk_id(chunks: &[ChunkRow], line: usize) -> Option<i64> {
    chunks
        .iter()
        .filter(|c| line >= c.start_line && line <= c.end_line)
        .min_by_key(|c| c.end_line.saturating_sub(c.start_line))
        .map(|c| c.id)
}

fn match_chunk_by_name(chunks: &[ChunkRow], name: &str) -> Option<i64> {
    let tail = name
        .rsplit_once("::")
        .map_or(name, |(_, t)| t)
        .trim();
    if let Some(exact) = chunks.iter().find(|c| c.qualified_name == name) {
        return Some(exact.id);
    }
    let suffix_colons = format!("::{tail}");
    let suffix_dot = format!(".{tail}");
    chunks
        .iter()
        .find(|c| {
            c.qualified_name == tail
                || c.qualified_name.ends_with(&suffix_colons)
                || c.qualified_name.ends_with(&suffix_dot)
        })
        .map(|c| c.id)
}

fn resolve_chunk_ref_cached(
    conn: &Connection,
    repo: &str,
    chunk_ref: Option<&(String, String)>,
    cache: &mut HashMap<String, Vec<ChunkRow>>,
) -> Result<Option<i64>> {
    let Some((file, name)) = chunk_ref else {
        return Ok(None);
    };
    let rows = cached_file_chunks(conn, repo, file, cache)?;
    Ok(match_chunk_by_name(rows, name))
}

fn resolve_endpoint_handler_chunk(
    conn: &Connection,
    repo: &str,
    ep: &ExtractedEndpoint,
    cache: &mut HashMap<String, Vec<ChunkRow>>,
) -> Result<Option<i64>> {
    if let Some(id) = resolve_chunk_ref_cached(conn, repo, ep.chunk_refs.handler.as_ref(), cache)? {
        return Ok(Some(id));
    }
    let rows = cached_file_chunks(conn, repo, &ep.file, cache)?;
    if !ep.handler.is_empty()
        && !ep.handler.starts_with('<')
        && let Some(id) = match_chunk_by_name(rows, &ep.handler)
    {
        return Ok(Some(id));
    }
    Ok(enclosing_chunk_id(rows, ep.line))
}

fn load_chunk_hashes_for_edges(
    conn: &Connection,
    calls_by_id: &HashMap<i64, &CallRow>,
    eps_by_id: &HashMap<i64, &EndpointRow>,
) -> Result<HashMap<i64, String>> {
    let mut ids = HashSet::new();
    for call in calls_by_id.values() {
        if let Some(id) = call.caller_chunk_id {
            ids.insert(id);
        }
    }
    for ep in eps_by_id.values() {
        if let Some(id) = ep.chunk_ids.handler {
            ids.insert(id);
        }
    }
    let mut hashes = HashMap::with_capacity(ids.len());
    if ids.is_empty() {
        return Ok(hashes);
    }
    let mut stmt = conn.prepare("SELECT norm_hash FROM chunks WHERE id = ?1")?;
    for id in ids {
        if let Some(h) = stmt
            .query_row(params![id], |r| r.get::<_, String>(0))
            .optional()?
        {
            hashes.insert(id, h);
        }
    }
    Ok(hashes)
}

fn ep_contract_cols_sql(has_contract_cols: bool) -> &'static str {
    if has_contract_cols {
        "ep.req_contract, ep.res_contract, ep.contract_hash"
    } else {
        "'' AS req_contract, '' AS res_contract, '' AS contract_hash"
    }
}

fn ep_chunk_cols_sql(has_chunk_cols: bool) -> &'static str {
    if has_chunk_cols {
        "ep.handler_chunk_id, ep.req_type_chunk_id, ep.res_type_chunk_id"
    } else {
        "NULL AS handler_chunk_id, NULL AS req_type_chunk_id, NULL AS res_type_chunk_id"
    }
}

fn call_contract_col_sql(has_contract_cols: bool) -> &'static str {
    if has_contract_cols {
        "c.req_contract"
    } else {
        "'' AS req_contract"
    }
}

fn call_chunk_col_sql(has_chunk_cols: bool) -> &'static str {
    if has_chunk_cols {
        "c.caller_chunk_id"
    } else {
        "NULL AS caller_chunk_id"
    }
}

fn edge_pair_cols_sql(has_chunk_cols: bool) -> &'static str {
    if has_chunk_cols {
        "e.pair_key, e.verified_pair_key, e.verified_sha"
    } else {
        "'' AS pair_key, '' AS verified_pair_key, '' AS verified_sha"
    }
}

pub(crate) fn sha_matches(stored: &str, target: &str) -> bool {
    if stored.is_empty() || target.is_empty() {
        return false;
    }
    if stored == target {
        return true;
    }
    (target.len() >= 7 && stored.starts_with(target))
        || (stored.len() >= 7 && target.starts_with(stored))
}

fn callers_for_endpoint_conn(
    conn: &Connection,
    endpoint_id: i64,
    has_contract_cols: bool,
    has_chunk_cols: bool,
) -> Result<Vec<CallerEdge>> {
    let req_col = call_contract_col_sql(has_contract_cols);
    let caller_chunk_col = call_chunk_col_sql(has_chunk_cols);
    let edge_pair_cols = edge_pair_cols_sql(has_chunk_cols);
    let mut stmt = conn.prepare(&format!(
        "SELECT c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha, {req_col}, {caller_chunk_col},
                COALESCE(s.stack, ?2), e.confidence, {edge_pair_cols}
         FROM edges e
         JOIN calls c ON c.id = e.call_id
         LEFT JOIN services s ON s.name = c.service
         WHERE e.endpoint_id = ?1
         ORDER BY c.service, c.file, c.line"
    ))?;
    collect_rows(stmt.query_map(params![endpoint_id, Stack::Axum.as_str()], |r| {
        let call = map_call_row(r)?;
        let stack_raw: String = r.get(16)?;
        let conf_raw: String = r.get(17)?;
        Ok(CallerEdge {
            call,
            service_stack: Stack::parse(&stack_raw).unwrap_or(Stack::Axum),
            confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
            verify: map_verify_meta(r, 18)?,
        })
    })?)
}

fn serialize_contract(contract: Option<&PayloadContract>) -> String {
    contract
        .and_then(|c| serde_json::to_string(c).ok())
        .unwrap_or_default()
}

fn deserialize_contract(raw: &str) -> Option<PayloadContract> {
    if raw.is_empty() {
        return None;
    }
    serde_json::from_str(raw).ok()
}

fn get_meta_conn(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM graph_meta WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(Into::into)
}

fn list_repos_conn(conn: &Connection) -> Result<Vec<RepoRow>> {
    let mut stmt = conn
        .prepare("SELECT repo, repo_path, head_sha, extractor_ver, dirty FROM repos ORDER BY repo")?;
    collect_rows(stmt.query_map([], map_repo_row)?)
}

fn load_all_compose_env_conn(
    conn: &Connection,
    active_repos: &HashSet<String>,
) -> Result<BTreeMap<String, String>> {
    let mut merged = BTreeMap::new();
    for repo in active_repos {
        let key = format!("compose_env:{repo}");
        if let Some(raw) = get_meta_conn(conn, &key)?
            && let Ok(parsed) = serde_json::from_str::<BTreeMap<String, String>>(&raw)
        {
            merged.extend(parsed);
        }
    }
    Ok(merged)
}

fn load_all_nginx_routes_conn(
    conn: &Connection,
    active_services: &HashSet<String>,
) -> Result<Vec<NginxRoute>> {
    let mut routes = Vec::new();
    let mut names: Vec<&String> = active_services.iter().collect();
    names.sort();
    for svc in names {
        let key = format!("nginx_routes:{svc}");
        if let Some(raw) = get_meta_conn(conn, &key)?
            && let Ok(parsed) = serde_json::from_str::<Vec<NginxRoute>>(&raw)
        {
            routes.extend(parsed);
        }
    }
    Ok(routes)
}

fn load_all_services_conn(conn: &Connection) -> Result<Vec<ServiceRow>> {
    let mut stmt = conn.prepare(
        "SELECT name, repo, root, stack, base_service, base_prefix FROM services ORDER BY name",
    )?;
    collect_rows(stmt.query_map([], |r| {
        let stack_raw: String = r.get(3)?;
        Ok(ServiceRow {
            name: r.get(0)?,
            repo: r.get(1)?,
            root: r.get(2)?,
            stack: Stack::parse(&stack_raw).unwrap_or(Stack::Axum),
            base_service: r.get(4)?,
            base_prefix: r.get(5)?,
        })
    })?)
}

fn load_all_endpoints_conn(conn: &Connection) -> Result<Vec<EndpointRow>> {
    load_all_endpoints_with_sql(conn, ENDPOINT_SELECT)
}

fn load_all_endpoints_with_sql(conn: &Connection, select_sql: &str) -> Result<Vec<EndpointRow>> {
    let mut stmt = conn.prepare(&format!("{select_sql} ORDER BY id"))?;
    collect_rows(stmt.query_map([], map_endpoint_row)?)
}

fn load_all_calls_conn(conn: &Connection) -> Result<Vec<CallRow>> {
    load_all_calls_with_sql(conn, CALL_SELECT)
}

fn load_all_calls_with_sql(conn: &Connection, select_sql: &str) -> Result<Vec<CallRow>> {
    let mut stmt = conn.prepare(&format!("{select_sql} ORDER BY id"))?;
    collect_rows(stmt.query_map([], map_call_row)?)
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> Result<Vec<T>> {
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn map_repo_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RepoRow> {
    Ok(RepoRow {
        repo: r.get(0)?,
        repo_path: r.get(1)?,
        head_sha: r.get(2)?,
        extractor_ver: r.get(3)?,
        dirty: r.get::<_, i64>(4)? != 0,
    })
}

fn map_file_hash_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileHashRow> {
    Ok(FileHashRow {
        file: r.get(0)?,
        content_hash: r.get(1)?,
        service: r.get(2)?,
        has_router_deps: r.get::<_, i64>(3)? != 0,
        norm_file_hash: r.get(4)?,
    })
}

fn map_chunk_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkRow> {
    let kind_raw: String = r.get(3)?;
    Ok(ChunkRow {
        id: r.get(0)?,
        repo: r.get(1)?,
        file: r.get(2)?,
        kind: ChunkKind::parse(&kind_raw).unwrap_or(ChunkKind::Fn),
        qualified_name: r.get(4)?,
        start_line: r.get::<_, i64>(5)?.max(0) as usize,
        end_line: r.get::<_, i64>(6)?.max(0) as usize,
        norm_hash: r.get(7)?,
        first_seen_hash: r.get(8)?,
        first_seen_at: r.get(9)?,
        hash_changed_at: r.get(10)?,
    })
}

fn map_site_ref(r: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<SiteRef> {
    Ok(SiteRef {
        service: r.get(offset)?,
        repo: r.get(offset + 1)?,
        file: r.get(offset + 2)?,
        line: r.get::<_, i64>(offset + 3)?.max(0) as usize,
    })
}

fn map_route_common_at(
    r: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<(HttpMethod, String, String, String, usize)> {
    let method_raw: String = r.get(offset + 3)?;
    Ok((
        HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        r.get(offset + 4)?,
        r.get(offset + 5)?,
        r.get(offset + 6)?,
        r.get::<_, i64>(offset + 7)?.max(0) as usize,
    ))
}

fn map_endpoint_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointRow> {
    map_endpoint_row_at(r, 0)
}

fn map_edge_quad_str(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(i64, i64, String, String, String, String)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
}

fn map_verify_meta(r: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<EdgeVerifyMeta> {
    Ok(EdgeVerifyMeta {
        pair_key: r.get(offset)?,
        verified_pair_key: r.get(offset + 1)?,
        verified_sha: r.get(offset + 2)?,
    })
}

fn map_endpoint_row_at(r: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<EndpointRow> {
    let (method, path_raw, path_norm, file, line) = map_route_common_at(r, offset)?;
    let prefix_raw: String = r.get(offset + 9)?;
    let req_raw: String = r.get(offset + 11)?;
    let res_raw: String = r.get(offset + 12)?;
    Ok(EndpointRow {
        id: r.get(offset)?,
        service: r.get(offset + 1)?,
        repo: r.get(offset + 2)?,
        verified_sha: r.get(offset + 10)?,
        chunk_ids: EndpointChunkIds {
            handler: r.get(offset + 14)?,
            req_type: r.get(offset + 15)?,
            res_type: r.get(offset + 16)?,
        },
        ep: ExtractedEndpoint {
            method,
            path_raw,
            path_norm,
            file,
            line,
            handler: r.get(offset + 8)?,
            prefix_state: PrefixState::parse(&prefix_raw).unwrap_or(PrefixState::Partial),
            req_contract: deserialize_contract(&req_raw),
            res_contract: deserialize_contract(&res_raw),
            contract_hash: r.get(offset + 13)?,
            chunk_refs: super::types::EndpointChunkRefs::default(),
        },
    })
}

fn map_call_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CallRow> {
    map_call_row_at(r, 0)
}

fn map_call_row_at(r: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CallRow> {
    let (method, path_raw, path_norm, file, line) = map_route_common_at(r, offset)?;
    let req_raw: String = r.get(offset + 14)?;
    Ok(CallRow {
        id: r.get(offset)?,
        service: r.get(offset + 1)?,
        repo: r.get(offset + 2)?,
        verified_sha: r.get(offset + 13)?,
        caller_chunk_id: r.get(offset + 15)?,
        call: ExtractedCall {
            method,
            path_raw,
            path_norm,
            file,
            line,
            base_ref: r.get(offset + 8)?,
            symbol: r.get(offset + 9)?,
            area: r.get(offset + 10)?,
            why: r.get(offset + 11)?,
            external: r.get::<_, i64>(offset + 12)? != 0,
            req_contract: deserialize_contract(&req_raw),
        },
    })
}

fn map_edge_snapshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExistingEdgeSnapshot> {
    let method_raw: String = r.get(8)?;
    let conf_raw: String = r.get(11)?;
    let call_method_raw: String = r.get(16)?;
    Ok(ExistingEdgeSnapshot {
        source: map_site_ref(r, 0)?,
        target: map_site_ref(r, 4)?,
        method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        call_method: HttpMethod::parse(&call_method_raw).unwrap_or(HttpMethod::Any),
        path_norm: r.get(9)?,
        call_path_norm: r.get(10)?,
        confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
        first_seen_sha: r.get(12)?,
        last_seen_sha: r.get(13)?,
        seen_count: r.get(14)?,
        first_seen_at: r.get(15)?,
        verify: map_verify_meta(r, 17)?,
        verified_at: r.get(20)?,
        pair_changed_at: r.get(21)?,
    })
}

fn map_cross_repo_info(r: &rusqlite::Row<'_>) -> rusqlite::Result<CrossRepoEdgeInfo> {
    let method_raw: String = r.get(2)?;
    Ok(CrossRepoEdgeInfo {
        peer_repo: r.get(0)?,
        peer_service: r.get(1)?,
        method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        path_norm: r.get(3)?,
        verify: map_verify_meta(r, 4)?,
    })
}

fn map_edge_change_row(
    r: &rusqlite::Row<'_>,
    kind: EdgeChangeKind,
) -> rusqlite::Result<EdgeChangeRow> {
    let method_raw: String = r.get(8)?;
    Ok(EdgeChangeRow {
        kind,
        source: map_site_ref(r, 0)?,
        target: map_site_ref(r, 4)?,
        method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        path_norm: r.get(9)?,
        sha: r.get(10)?,
        seen_count: r.get(11)?,
        timestamp_ms: r.get(12)?,
        breaking: r.get::<_, i64>(13)? != 0,
        reason: r.get(14)?,
    })
}

fn ensure_not_symlink(path: &Path) -> Result<()> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        bail!("graph db path must not be a symbolic link: {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn apply_full_test_edges(
        tx: &GraphWriteTx<'_>,
        old_snapshots: &[ExistingEdgeSnapshot],
        new_edges: &[EdgeRow],
        calls: &[CallRow],
        eps: &[EndpointRow],
        now_ms: i64,
    ) -> (usize, usize) {
        let calls_map: HashMap<i64, &CallRow> = calls.iter().map(|c| (c.id, c)).collect();
        let eps_map: HashMap<i64, &EndpointRow> = eps.iter().map(|e| (e.id, e)).collect();
        let empty_repos = HashSet::new();
        tx.apply_edge_updates(&EdgeUpdateBatch {
            full_replace: true,
            replace_call_ids: &[],
            old_snapshots,
            new_edges,
            calls_by_id: &calls_map,
            eps_by_id: &eps_map,
            changed_repos: &empty_repos,
            now_ms,
        })
        .unwrap()
    }

    #[test]
    fn graph_store_persists_repos_endpoints_calls_edges_and_history() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.db");
        assert!(GraphStore::open_readonly(&db).unwrap().is_none());

        let mut store = GraphStore::open_writable(&db).unwrap();
        let repo = RepoRow {
            repo: "shop".to_owned(),
            repo_path: "/tmp/shop".to_owned(),
            head_sha: "abcdef123456".to_owned(),
            extractor_ver: 2,
            dirty: false,
        };
        let tx = store.begin_write().unwrap();
        tx.upsert_repo(&repo, 1000).unwrap();
        tx.insert_endpoints(
            &repo.repo,
            &repo.head_sha,
            &[(
                "shop-api".to_owned(),
                vec![ExtractedEndpoint::simple(
                    HttpMethod::Post,
                    "/api/internal/invoices",
                    "src/api.rs",
                    12,
                    "create",
                    PrefixState::Full,
                )],
            )],
        )
        .unwrap();
        tx.insert_calls(
            "billing",
            "111111222222",
            &[(
                "billing-svc".to_owned(),
                vec![ExtractedCall::simple(
                    HttpMethod::Post,
                    "/api/internal/invoices",
                    "src/client.rs",
                    40,
                    "self.url",
                    "issue",
                    "issue",
                )],
            )],
        )
        .unwrap();
        let eps = tx.load_all_endpoints().unwrap();
        let calls = tx.load_all_calls().unwrap();
        let (added, removed) = apply_full_test_edges(
            &tx,
            &[],
            &[EdgeRow {
                call_id: calls[0].id,
                endpoint_id: eps[0].id,
                confidence: Confidence::Configured,
            }],
            &calls,
            &eps,
            1000,
        );
        assert_eq!((added, removed), (1, 0));
        tx.commit().unwrap();

        let tx2 = store.begin_write().unwrap();
        let snaps = tx2.snapshot_all_edges().unwrap();
        let (added2, removed2) = apply_full_test_edges(&tx2, &snaps, &[], &[], &[], 2000);
        assert_eq!((added2, removed2), (0, 1));
        tx2.commit().unwrap();

        let ro = GraphStore::open_readonly(&db).unwrap().unwrap();
        let counts = ro.counts().unwrap();
        assert_eq!(counts.endpoints, 1);
        assert_eq!(counts.calls, 1);
        assert_eq!(counts.edges, 0);
        assert_eq!(counts.fog, 1);
        let changes = ro.load_cross_repo_changes(0, None).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, EdgeChangeKind::Removed);
        assert_eq!(changes[0].sha, "abcdef123456");
    }

    #[test]
    fn readonly_open_reads_v2_schema_without_contract_columns() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("graph-v2.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE repos (repo TEXT PRIMARY KEY, repo_path TEXT NOT NULL, head_sha TEXT NOT NULL, extractor_ver INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL);
             CREATE TABLE services (name TEXT PRIMARY KEY, repo TEXT NOT NULL, root TEXT NOT NULL, stack TEXT NOT NULL, base_service TEXT, base_prefix TEXT);
             CREATE TABLE endpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, repo TEXT NOT NULL, method TEXT NOT NULL, path_raw TEXT NOT NULL, path_norm TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, handler TEXT NOT NULL, prefix_state TEXT NOT NULL, verified_sha TEXT NOT NULL);
             CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, repo TEXT NOT NULL, method TEXT NOT NULL, path_raw TEXT NOT NULL, path_norm TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, base_ref TEXT NOT NULL, symbol TEXT NOT NULL, area TEXT NOT NULL, why TEXT NOT NULL, external INTEGER NOT NULL DEFAULT 0, verified_sha TEXT NOT NULL);
             CREATE TABLE edges (call_id INTEGER NOT NULL, endpoint_id INTEGER NOT NULL, confidence TEXT NOT NULL, first_seen_sha TEXT NOT NULL DEFAULT '', last_seen_sha TEXT NOT NULL DEFAULT '', seen_count INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (call_id, endpoint_id));
             CREATE TABLE edge_history (id INTEGER PRIMARY KEY AUTOINCREMENT, call_service TEXT NOT NULL, call_repo TEXT NOT NULL, call_file TEXT NOT NULL, call_line INTEGER NOT NULL, endpoint_service TEXT NOT NULL, endpoint_repo TEXT NOT NULL, endpoint_file TEXT NOT NULL, endpoint_line INTEGER NOT NULL, method TEXT NOT NULL, path_norm TEXT NOT NULL, confidence TEXT NOT NULL, first_seen_sha TEXT NOT NULL, last_seen_sha TEXT NOT NULL, seen_count INTEGER NOT NULL, removed_at INTEGER NOT NULL);
             PRAGMA user_version = 2;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO services VALUES (?1, ?2, '', ?3, NULL, NULL)",
            params!["api", "shop", Stack::Axum.as_str()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO endpoints VALUES (1, ?1, ?2, ?3, ?4, ?4, ?5, 10, ?6, ?7, ?8)",
            params!["api", "shop", HttpMethod::Get.as_str(), "/health", "src/api.rs", "health", PrefixState::Full.as_str(), "aaa"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO calls VALUES (1, ?1, ?2, ?3, ?4, ?4, ?5, 5, ?6, ?7, '', '', 0, ?8)",
            params!["cli", "addon", HttpMethod::Get.as_str(), "/health", "src/c.rs", "u", "get", "bbb"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO calls VALUES (2, ?1, ?2, ?3, ?4, ?4, ?5, 9, ?6, ?7, '', '', 0, ?8)",
            params!["cli", "addon", HttpMethod::Get.as_str(), "/miss", "src/c.rs", "u", "get", "bbb"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO edges VALUES (1, 1, ?1, ?2, ?2, 1, 100, 100)",
            params![Confidence::Unique.as_str(), "bbb"],
        )
        .unwrap();
        drop(conn);

        let ro = GraphStore::open_readonly(&db).unwrap().unwrap();
        let eps = ro.find_endpoints(Some(HttpMethod::Get), "/health", None).unwrap();
        assert_eq!(eps.len(), 1);
        assert!(eps[0].req_contract.is_none());
        assert_eq!(ro.callers_for_endpoint(1).unwrap().len(), 1);
        assert_eq!(ro.providers_for_call(1).unwrap().len(), 1);
        assert_eq!(ro.unresolved_calls(None).unwrap().len(), 1);
        assert!(ro.load_endpoints_with_contracts(None).unwrap().is_empty());
        assert!(ro.load_edge_pairs(None).unwrap().is_empty());
        assert_eq!(ro.load_cross_repo_changes(0, None).unwrap().len(), 1);
    }
}
