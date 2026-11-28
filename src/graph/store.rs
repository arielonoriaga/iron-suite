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

use super::nginx::NginxRoute;
use super::scan::matches_external_glob;
use super::types::{
    Confidence, ExtractedCall, ExtractedEndpoint, HttpMethod, PrefixState, ServiceConfig, Stack,
};

const GRAPH_APPLICATION_ID: i64 = 0x4952_4750;
const GRAPH_SCHEMA_VERSION: i64 = 2;
const BUSY_TIMEOUT_SECS: u64 = 5;
const LOCK_TIMEOUT_SECS: u64 = 10;
const LOCK_POLL_MS: u64 = 20;
const SCHEMA_OBJECT_TABLE: &str = "table";
const TABLE_EDGE_HISTORY: &str = "edge_history";
const SERVICE_SCOPED_TABLES: &[&str] = &["endpoints", "calls", "file_hashes"];
const REPO_SCOPED_TABLES: &[&str] = &["endpoints", "calls", "file_hashes", "services", "repos"];
const CROSS_REPO_SERVED_SQL: &str = "SELECT DISTINCT c.repo, c.service, ep.method, ep.path_norm
     FROM endpoints ep
     JOIN edges e ON e.endpoint_id = ep.id
     JOIN calls c ON c.id = e.call_id
     WHERE ep.repo = ?1 AND ep.file = ?2 AND c.repo != ep.repo
     ORDER BY c.service, ep.method, ep.path_norm";
const CROSS_REPO_CALLED_SQL: &str = "SELECT DISTINCT ep.repo, ep.service, c.method, ep.path_norm
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

#[derive(Debug, Clone)]
pub struct EndpointRow {
    pub id: i64,
    pub service: String,
    pub repo: String,
    pub verified_sha: String,
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
    pub path_norm: String,
    pub confidence: Confidence,
    pub first_seen_sha: String,
    pub last_seen_sha: String,
    pub seen_count: i64,
    pub first_seen_at: i64,
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
}

#[derive(Debug, Clone)]
pub struct CrossRepoEdgeInfo {
    pub peer_repo: String,
    pub peer_service: String,
    pub method: HttpMethod,
    pub path_norm: String,
}

#[derive(Debug, Clone)]
pub struct CallerEdge {
    pub call: CallRow,
    pub service_stack: Stack,
    pub confidence: Confidence,
}

#[derive(Debug, Clone)]
pub struct ProviderEdge {
    pub endpoint: EndpointRow,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Default)]
pub struct GraphCounts {
    pub endpoints: usize,
    pub calls: usize,
    pub edges: usize,
    pub fog: usize,
    pub fog_by_repo: BTreeMap<String, usize>,
}

pub struct GraphStore {
    conn: Connection,
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
    PRIMARY KEY (repo, file)
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
    verified_sha TEXT NOT NULL
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
    verified_sha TEXT NOT NULL
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
    removed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_hashes_service ON file_hashes(repo, service);
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

const EDGE_MIGRATION_COLUMNS: &[(&str, &str)] = &[
    ("first_seen_sha", "TEXT NOT NULL DEFAULT ''"),
    ("last_seen_sha", "TEXT NOT NULL DEFAULT ''"),
    ("seen_count", "INTEGER NOT NULL DEFAULT 1"),
    ("first_seen_at", "INTEGER NOT NULL DEFAULT 0"),
    ("last_seen_at", "INTEGER NOT NULL DEFAULT 0"),
];

const ENDPOINT_SELECT: &str =
    "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha FROM endpoints";
const CALL_SELECT: &str =
    "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha FROM calls";
const SNAPSHOT_SELECT_SQL: &str = "
SELECT c.service, c.repo, c.file, c.line,
       ep.service, ep.repo, ep.file, ep.line,
       ep.method, ep.path_norm, e.confidence,
       e.first_seen_sha, e.last_seen_sha, e.seen_count, e.first_seen_at
FROM edges e
JOIN calls c ON c.id = e.call_id
JOIN endpoints ep ON ep.id = e.endpoint_id";
const INSERT_HISTORY_SQL: &str = "
INSERT INTO edge_history(
    call_service, call_repo, call_file, call_line,
    endpoint_service, endpoint_repo, endpoint_file, endpoint_line,
    method, path_norm, confidence, first_seen_sha, last_seen_sha, seen_count, removed_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)";

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
            migrate_edges_table(&conn)?;
            conn.pragma_update(None, "application_id", GRAPH_APPLICATION_ID)?;
            conn.pragma_update(None, "user_version", GRAPH_SCHEMA_VERSION)?;
        }
        Ok(Self { conn })
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
        Ok(Some(Self { conn }))
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
            "SELECT file, content_hash, service, has_router_deps FROM file_hashes WHERE repo = ?1",
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
                "SELECT file, content_hash, service, has_router_deps
                 FROM file_hashes WHERE repo = ?1 AND file = ?2",
                params![repo, file],
                map_file_hash_row,
            )
            .optional()
            .map_err(Into::into)
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
        load_all_endpoints_conn(&self.conn)
    }

    pub fn load_all_calls(&self) -> Result<Vec<CallRow>> {
        load_all_calls_conn(&self.conn)
    }

    pub fn find_endpoints(
        &self,
        method: Option<HttpMethod>,
        path_norm: &str,
        repo: Option<&str>,
    ) -> Result<Vec<EndpointRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "{ENDPOINT_SELECT} WHERE path_norm = ?1 AND (?2 IS NULL OR method = ?2) AND (?3 IS NULL OR repo = ?3) ORDER BY method, service, file, line"
        ))?;
        collect_rows(stmt.query_map(
            params![path_norm, method.map(HttpMethod::as_str), repo],
            map_endpoint_row,
        )?)
    }

    pub fn callers_for_endpoint(&self, endpoint_id: i64) -> Result<Vec<CallerEdge>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                    c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha,
                    COALESCE(s.stack, ?2), e.confidence
             FROM edges e
             JOIN calls c ON c.id = e.call_id
             LEFT JOIN services s ON s.name = c.service
             WHERE e.endpoint_id = ?1
             ORDER BY c.service, c.file, c.line",
        )?;
        collect_rows(stmt.query_map(params![endpoint_id, Stack::Axum.as_str()], |r| {
            let call = map_call_row(r)?;
            let stack_raw: String = r.get(14)?;
            let conf_raw: String = r.get(15)?;
            Ok(CallerEdge {
                call,
                service_stack: Stack::parse(&stack_raw).unwrap_or(Stack::Axum),
                confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
            })
        })?)
    }

    pub fn providers_for_call(&self, call_id: i64) -> Result<Vec<ProviderEdge>> {
        let mut stmt = self.conn.prepare(
            "SELECT ep.id, ep.service, ep.repo, ep.method, ep.path_raw, ep.path_norm, ep.file,
                    ep.line, ep.handler, ep.prefix_state, ep.verified_sha, e.confidence
             FROM edges e
             JOIN endpoints ep ON ep.id = e.endpoint_id
             WHERE e.call_id = ?1
             ORDER BY ep.service, ep.file, ep.line",
        )?;
        collect_rows(stmt.query_map(params![call_id], |r| {
            let endpoint = map_endpoint_row(r)?;
            let conf_raw: String = r.get(11)?;
            Ok(ProviderEdge {
                endpoint,
                confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
            })
        })?)
    }

    pub fn endpoints_in_file(&self, repo: Option<&str>, file: &str) -> Result<Vec<EndpointRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "{ENDPOINT_SELECT} WHERE file = ?1 AND (?2 IS NULL OR repo = ?2) ORDER BY repo, line, method"
        ))?;
        collect_rows(stmt.query_map(params![file, repo], map_endpoint_row)?)
    }

    pub fn calls_in_file(&self, repo: Option<&str>, file: &str) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "{CALL_SELECT} WHERE file = ?1 AND (?2 IS NULL OR repo = ?2) ORDER BY repo, line, method"
        ))?;
        collect_rows(stmt.query_map(params![file, repo], map_call_row)?)
    }

    pub fn calls_for_service_or_repo(
        &self,
        target: &str,
        repo: Option<&str>,
    ) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "{CALL_SELECT} WHERE (?2 IS NULL OR repo = ?2) AND (service = ?1 OR repo = ?1 OR file = ?1) ORDER BY repo, file, line"
        ))?;
        collect_rows(stmt.query_map(params![target, repo], map_call_row)?)
    }

    pub fn unresolved_calls(&self, repo: Option<&str>) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.service, c.repo, c.method, c.path_raw, c.path_norm, c.file, c.line,
                    c.base_ref, c.symbol, c.area, c.why, c.external, c.verified_sha
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.external = 0 AND e.call_id IS NULL AND (?1 IS NULL OR c.repo = ?1)
             ORDER BY c.repo, c.file, c.line",
        )?;
        collect_rows(stmt.query_map(params![repo], map_call_row)?)
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
                    ep.method, ep.path_norm, e.first_seen_sha, e.seen_count, e.first_seen_at
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

        let mut rem_stmt = self.conn.prepare(
            "SELECT call_service, call_repo, call_file, call_line,
                    endpoint_service, endpoint_repo, endpoint_file, endpoint_line,
                    method, path_norm, last_seen_sha, seen_count, removed_at
             FROM edge_history
             WHERE call_repo != endpoint_repo
               AND removed_at >= ?1
               AND (?2 IS NULL OR call_repo = ?2 OR endpoint_repo = ?2)",
        )?;
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
        let mut fog_by_repo = BTreeMap::new();
        let mut fog_total = 0usize;
        let mut stmt = self.conn.prepare(
            "SELECT c.repo, COUNT(*)
             FROM calls c
             LEFT JOIN edges e ON e.call_id = c.id
             WHERE c.external = 0 AND e.call_id IS NULL
             GROUP BY c.repo
             ORDER BY c.repo",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (repo, count) = row?;
            let count = count.max(0) as usize;
            fog_total += count;
            fog_by_repo.insert(repo, count);
        }
        Ok(GraphCounts {
            endpoints: endpoints.max(0) as usize,
            calls: calls.max(0) as usize,
            edges: edges.max(0) as usize,
            fog: fog_total,
            fog_by_repo,
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
                insert_history_row(&mut hist_stmt, snap, now_ms)?;
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

    pub fn insert_endpoints(
        &self,
        repo: &str,
        head_sha: &str,
        service_endpoints: &[(String, Vec<ExtractedEndpoint>)],
    ) -> Result<()> {
        let mut stmt = self.tx.prepare(
            "INSERT INTO endpoints(service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for (service, endpoints) in service_endpoints {
            for ep in endpoints {
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
        let mut stmt = self.tx.prepare(
            "INSERT INTO calls(service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for (service, calls) in service_calls {
            for c in calls {
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
            "INSERT INTO file_hashes(repo, file, content_hash, service, has_router_deps)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(repo, file) DO UPDATE SET
               content_hash = excluded.content_hash,
               service = excluded.service,
               has_router_deps = excluded.has_router_deps",
        )?;
        for row in rows {
            stmt.execute(params![
                repo,
                row.file,
                row.content_hash,
                row.service,
                i64::from(row.has_router_deps),
            ])?;
        }
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

    pub fn apply_edge_updates(&self, batch: &EdgeUpdateBatch<'_>) -> Result<(usize, usize)> {
        if batch.full_replace {
            self.tx.execute("DELETE FROM edges", [])?;
        } else if !batch.replace_call_ids.is_empty() {
            let mut del = self.tx.prepare("DELETE FROM edges WHERE call_id = ?1")?;
            for &cid in batch.replace_call_ids {
                del.execute(params![cid])?;
            }
        }

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
                seen_count, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
            let (first_sha, seen_count, first_at) = resolve_history_fields(
                old_by_key.get(&key).copied(),
                current_sha,
                batch.now_ms,
                &mut added,
            );
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
            ])?;
        }
        drop(ins_edge);

        let mut removed = 0usize;
        let mut ins_hist = self.tx.prepare(INSERT_HISTORY_SQL)?;
        for (key, snap) in &old_by_key {
            if !surviving_keys.contains(key) {
                insert_history_row(&mut ins_hist, snap, batch.now_ms)?;
                removed += 1;
            }
        }
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
) -> Result<()> {
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
    ])?;
    Ok(())
}

fn migrate_edges_table(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(edges)")?;
    let existing: HashSet<String> =
        collect_rows(stmt.query_map([], |r| r.get::<_, String>(1))?)?
            .into_iter()
            .collect();
    drop(stmt);
    for (col, spec) in EDGE_MIGRATION_COLUMNS {
        if !existing.contains(*col) {
            conn.execute(&format!("ALTER TABLE edges ADD COLUMN {col} {spec}"), [])?;
        }
    }
    Ok(())
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
    let mut stmt = conn.prepare(&format!("{ENDPOINT_SELECT} ORDER BY id"))?;
    collect_rows(stmt.query_map([], map_endpoint_row)?)
}

fn load_all_calls_conn(conn: &Connection) -> Result<Vec<CallRow>> {
    let mut stmt = conn.prepare(&format!("{CALL_SELECT} ORDER BY id"))?;
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

fn map_route_common(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(HttpMethod, String, String, String, usize)> {
    let method_raw: String = r.get(3)?;
    Ok((
        HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get::<_, i64>(7)?.max(0) as usize,
    ))
}

fn map_endpoint_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointRow> {
    let (method, path_raw, path_norm, file, line) = map_route_common(r)?;
    let prefix_raw: String = r.get(9)?;
    Ok(EndpointRow {
        id: r.get(0)?,
        service: r.get(1)?,
        repo: r.get(2)?,
        verified_sha: r.get(10)?,
        ep: ExtractedEndpoint {
            method,
            path_raw,
            path_norm,
            file,
            line,
            handler: r.get(8)?,
            prefix_state: PrefixState::parse(&prefix_raw).unwrap_or(PrefixState::Partial),
        },
    })
}

fn map_call_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CallRow> {
    let (method, path_raw, path_norm, file, line) = map_route_common(r)?;
    Ok(CallRow {
        id: r.get(0)?,
        service: r.get(1)?,
        repo: r.get(2)?,
        verified_sha: r.get(13)?,
        call: ExtractedCall {
            method,
            path_raw,
            path_norm,
            file,
            line,
            base_ref: r.get(8)?,
            symbol: r.get(9)?,
            area: r.get(10)?,
            why: r.get(11)?,
            external: r.get::<_, i64>(12)? != 0,
        },
    })
}

fn map_edge_snapshot(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExistingEdgeSnapshot> {
    let method_raw: String = r.get(8)?;
    let conf_raw: String = r.get(10)?;
    Ok(ExistingEdgeSnapshot {
        source: map_site_ref(r, 0)?,
        target: map_site_ref(r, 4)?,
        method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        path_norm: r.get(9)?,
        confidence: Confidence::parse(&conf_raw).unwrap_or(Confidence::Suffix),
        first_seen_sha: r.get(11)?,
        last_seen_sha: r.get(12)?,
        seen_count: r.get(13)?,
        first_seen_at: r.get(14)?,
    })
}

fn map_cross_repo_info(r: &rusqlite::Row<'_>) -> rusqlite::Result<CrossRepoEdgeInfo> {
    let method_raw: String = r.get(2)?;
    Ok(CrossRepoEdgeInfo {
        peer_repo: r.get(0)?,
        peer_service: r.get(1)?,
        method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
        path_norm: r.get(3)?,
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
                vec![ExtractedEndpoint {
                    method: HttpMethod::Post,
                    path_raw: "/api/internal/invoices".to_owned(),
                    path_norm: "/api/internal/invoices".to_owned(),
                    file: "src/api.rs".to_owned(),
                    line: 12,
                    handler: "create".to_owned(),
                    prefix_state: PrefixState::Full,
                }],
            )],
        )
        .unwrap();
        tx.insert_calls(
            "billing",
            "111111222222",
            &[(
                "billing-svc".to_owned(),
                vec![ExtractedCall {
                    method: HttpMethod::Post,
                    path_raw: "/api/internal/invoices".to_owned(),
                    path_norm: "/api/internal/invoices".to_owned(),
                    file: "src/client.rs".to_owned(),
                    line: 40,
                    base_ref: "self.url".to_owned(),
                    symbol: "issue".to_owned(),
                    area: String::new(),
                    why: "issue".to_owned(),
                    external: false,
                }],
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
}
