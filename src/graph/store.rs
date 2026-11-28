use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::ops::Deref;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};

use super::{
    Confidence, ExtractedCall, ExtractedEndpoint, HttpMethod, PrefixState, ServiceConfig, Stack,
};

const GRAPH_APPLICATION_ID: i64 = 0x4952_4750;
const GRAPH_SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT_SECS: u64 = 5;
const LOCK_TIMEOUT_SECS: u64 = 10;
const LOCK_POLL_MS: u64 = 20;

pub(crate) fn lock_graph_file(graph_db: &Path) -> Result<File> {
    let parent = graph_db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    super::ensure_private_dir(parent)?;
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

#[derive(Debug, Clone)]
pub struct RepoRow {
    pub repo: String,
    pub repo_path: String,
    pub head_sha: String,
    pub extractor_ver: i64,
    pub dirty: bool,
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
    PRIMARY KEY (call_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_endpoints_lookup ON endpoints(method, path_norm);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(path_norm);
CREATE INDEX IF NOT EXISTS idx_endpoints_file ON endpoints(repo, file);
CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(repo, file);
CREATE INDEX IF NOT EXISTS idx_calls_lookup ON calls(method, path_norm);
CREATE INDEX IF NOT EXISTS idx_edges_endpoint ON edges(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_edges_call ON edges(call_id);
";

impl GraphStore {
    pub fn open_writable(path: &Path) -> Result<Self> {
        ensure_not_symlink(path)?;
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            super::ensure_private_dir(parent)?;
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
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        conn.execute_batch(SCHEMA_SQL)?;
        conn.pragma_update(None, "application_id", GRAPH_APPLICATION_ID)?;
        conn.pragma_update(None, "user_version", GRAPH_SCHEMA_VERSION)?;
        Ok(Self { conn })
    }

    pub fn open_readonly(path: &Path) -> Result<Option<Self>> {
        match fs::symlink_metadata(path) {
            Ok(meta) => ensure!(
                !meta.file_type().is_symlink() && meta.is_file(),
                "graph db must be a regular non-symlink file: {}",
                path.display()
            ),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
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

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM graph_meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(Into::into)
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO graph_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
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
        let mut stmt = self
            .conn
            .prepare("SELECT repo, repo_path, head_sha, extractor_ver, dirty FROM repos ORDER BY repo")?;
        collect_rows(stmt.query_map([], map_repo_row)?)
    }

    pub fn prune_removed_repos(&mut self, active_repos: &HashSet<String>) -> Result<bool> {
        let removed: Vec<String> = self
            .list_repos()?
            .into_iter()
            .map(|r| r.repo)
            .filter(|r| !active_repos.contains(r))
            .collect();
        if removed.is_empty() {
            return Ok(false);
        }
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for repo in &removed {
            let env_key = format!("compose_env:{repo}");
            tx.execute("DELETE FROM endpoints WHERE repo = ?1", params![repo])?;
            tx.execute("DELETE FROM calls WHERE repo = ?1", params![repo])?;
            tx.execute("DELETE FROM services WHERE repo = ?1", params![repo])?;
            tx.execute("DELETE FROM repos WHERE repo = ?1", params![repo])?;
            tx.execute("DELETE FROM graph_meta WHERE key = ?1", params![env_key])?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn load_all_compose_env(&self, active_repos: &HashSet<String>) -> Result<BTreeMap<String, String>> {
        let mut merged = BTreeMap::new();
        for repo in active_repos {
            let key = format!("compose_env:{repo}");
            if let Some(raw) = self.get_meta(&key)?
                && let Ok(parsed) = serde_json::from_str::<BTreeMap<String, String>>(&raw)
            {
                merged.extend(parsed);
            }
        }
        Ok(merged)
    }

    pub fn sync_services(&mut self, services: &BTreeMap<String, ServiceConfig>) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM services", [])?;
        let mut stmt = tx.prepare(
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
        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    pub fn replace_repo_scan(
        &mut self,
        repo: &RepoRow,
        refreshed_at: i64,
        service_endpoints: &[(String, Vec<ExtractedEndpoint>)],
        service_calls: &[(String, Vec<ExtractedCall>)],
    ) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM endpoints WHERE repo = ?1", params![repo.repo])?;
        tx.execute("DELETE FROM calls WHERE repo = ?1", params![repo.repo])?;
        insert_endpoints(&tx, repo, service_endpoints)?;
        insert_calls(&tx, repo, service_calls)?;
        tx.execute(
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
        tx.commit()?;
        Ok(())
    }

    pub fn replace_edges(&mut self, edges: &[EdgeRow]) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM edges", [])?;
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO edges(call_id, endpoint_id, confidence) VALUES (?1, ?2, ?3)",
        )?;
        for edge in edges {
            stmt.execute(params![
                edge.call_id,
                edge.endpoint_id,
                edge.confidence.as_str(),
            ])?;
        }
        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    pub fn load_all_services(&self) -> Result<Vec<ServiceRow>> {
        let mut stmt = self.conn.prepare(
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

    pub fn load_all_endpoints(&self) -> Result<Vec<EndpointRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha
             FROM endpoints ORDER BY id",
        )?;
        collect_rows(stmt.query_map([], map_endpoint_row)?)
    }

    pub fn load_all_calls(&self) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha
             FROM calls ORDER BY id",
        )?;
        collect_rows(stmt.query_map([], map_call_row)?)
    }

    pub fn find_endpoints(
        &self,
        method: Option<HttpMethod>,
        path_norm: &str,
        repo: Option<&str>,
    ) -> Result<Vec<EndpointRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha
             FROM endpoints
             WHERE path_norm = ?1 AND (?2 IS NULL OR method = ?2) AND (?3 IS NULL OR repo = ?3)
             ORDER BY method, service, file, line",
        )?;
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
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha
             FROM endpoints WHERE file = ?1 AND (?2 IS NULL OR repo = ?2)
             ORDER BY repo, line, method",
        )?;
        collect_rows(stmt.query_map(params![file, repo], map_endpoint_row)?)
    }

    pub fn calls_in_file(&self, repo: Option<&str>, file: &str) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha
             FROM calls WHERE file = ?1 AND (?2 IS NULL OR repo = ?2)
             ORDER BY repo, line, method",
        )?;
        collect_rows(stmt.query_map(params![file, repo], map_call_row)?)
    }

    pub fn calls_for_service_or_repo(
        &self,
        target: &str,
        repo: Option<&str>,
    ) -> Result<Vec<CallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha
             FROM calls
             WHERE (?2 IS NULL OR repo = ?2) AND (service = ?1 OR repo = ?1 OR file = ?1)
             ORDER BY repo, file, line",
        )?;
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

fn insert_endpoints(
    tx: &rusqlite::Transaction<'_>,
    repo: &RepoRow,
    service_endpoints: &[(String, Vec<ExtractedEndpoint>)],
) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT INTO endpoints(service, repo, method, path_raw, path_norm, file, line, handler, prefix_state, verified_sha)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (service, endpoints) in service_endpoints {
        for ep in endpoints {
            stmt.execute(params![
                service,
                repo.repo,
                ep.method.as_str(),
                ep.path_raw,
                ep.path_norm,
                ep.file,
                ep.line as i64,
                ep.handler,
                ep.prefix_state.as_str(),
                repo.head_sha,
            ])?;
        }
    }
    Ok(())
}

fn insert_calls(
    tx: &rusqlite::Transaction<'_>,
    repo: &RepoRow,
    service_calls: &[(String, Vec<ExtractedCall>)],
) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT INTO calls(service, repo, method, path_raw, path_norm, file, line, base_ref, symbol, area, why, external, verified_sha)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )?;
    for (service, calls) in service_calls {
        for c in calls {
            stmt.execute(params![
                service,
                repo.repo,
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
                repo.head_sha,
            ])?;
        }
    }
    Ok(())
}

fn collect_rows<T>(rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>) -> Result<Vec<T>> {
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

fn map_endpoint_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointRow> {
    let method_raw: String = r.get(3)?;
    let prefix_raw: String = r.get(9)?;
    Ok(EndpointRow {
        id: r.get(0)?,
        service: r.get(1)?,
        repo: r.get(2)?,
        verified_sha: r.get(10)?,
        ep: ExtractedEndpoint {
            method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
            path_raw: r.get(4)?,
            path_norm: r.get(5)?,
            file: r.get(6)?,
            line: r.get::<_, i64>(7)?.max(0) as usize,
            handler: r.get(8)?,
            prefix_state: PrefixState::parse(&prefix_raw).unwrap_or(PrefixState::Partial),
        },
    })
}

fn map_call_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CallRow> {
    let method_raw: String = r.get(3)?;
    Ok(CallRow {
        id: r.get(0)?,
        service: r.get(1)?,
        repo: r.get(2)?,
        verified_sha: r.get(13)?,
        call: ExtractedCall {
            method: HttpMethod::parse(&method_raw).unwrap_or(HttpMethod::Any),
            path_raw: r.get(4)?,
            path_norm: r.get(5)?,
            file: r.get(6)?,
            line: r.get::<_, i64>(7)?.max(0) as usize,
            base_ref: r.get(8)?,
            symbol: r.get(9)?,
            area: r.get(10)?,
            why: r.get(11)?,
            external: r.get::<_, i64>(12)? != 0,
        },
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

    #[test]
    fn graph_store_persists_repos_endpoints_calls_and_edges_readonly() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.db");
        assert!(GraphStore::open_readonly(&db).unwrap().is_none());

        let mut store = GraphStore::open_writable(&db).unwrap();
        let repo = RepoRow {
            repo: "shop".to_owned(),
            repo_path: "/tmp/shop".to_owned(),
            head_sha: "abcdef123456".to_owned(),
            extractor_ver: 1,
            dirty: false,
        };
        store
            .replace_repo_scan(
                &repo,
                1000,
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
                &[(
                    "shop-client".to_owned(),
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
        let eps = store.load_all_endpoints().unwrap();
        let calls = store.load_all_calls().unwrap();
        store
            .replace_edges(&[EdgeRow {
                call_id: calls[0].id,
                endpoint_id: eps[0].id,
                confidence: Confidence::Configured,
            }])
            .unwrap();

        let ro = GraphStore::open_readonly(&db).unwrap().unwrap();
        let counts = ro.counts().unwrap();
        assert_eq!(counts.endpoints, 1);
        assert_eq!(counts.calls, 1);
        assert_eq!(counts.edges, 1);
        assert_eq!(counts.fog, 0);
    }
}
