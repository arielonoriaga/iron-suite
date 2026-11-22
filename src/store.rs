use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use rusqlite::types::{Type, Value as SqlValue};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, params,
    params_from_iter,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::linker;
use crate::model::{ImportBatch, ImportReport, MemoryLink, MemoryRecord, SearchHit, SearchOptions};

pub const SCHEMA_VERSION: i64 = 2;
pub const APPLICATION_ID: i64 = 0x4952_4f4e;
const MAX_RESULTS: usize = 50;
const MAX_CANDIDATES: usize = 200;
const MAX_QUERY_BYTES: usize = 8192;
const MAX_QUERY_TERMS: usize = 32;
const MAX_TERM_BYTES: usize = 128;
const MAX_FILTER_VALUES: usize = 32;
const SNIPPET_BYTES: usize = 640;

static QUERY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}\p{M}]+").expect("valid query token expression"));

const SCHEMA: &[(&str, &str, &str)] = &[
    (
        "table",
        "bodies",
        "CREATE TABLE bodies (
            id INTEGER PRIMARY KEY,
            hash BLOB NOT NULL UNIQUE CHECK(typeof(hash) = 'blob' AND length(hash) = 32),
            content TEXT NOT NULL
        )",
    ),
    (
        "table",
        "records",
        "CREATE TABLE records (
            rowid INTEGER PRIMARY KEY,
            id TEXT NOT NULL UNIQUE,
            source_group TEXT NOT NULL,
            source_key TEXT NOT NULL,
            source_type TEXT NOT NULL,
            kind TEXT NOT NULL,
            project TEXT NOT NULL,
            title TEXT NOT NULL,
            body_id INTEGER NOT NULL REFERENCES bodies(id),
            source_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT NOT NULL CHECK(json_valid(metadata)),
            UNIQUE(source_group, source_key)
        )",
    ),
    (
        "index",
        "records_scope",
        "CREATE INDEX records_scope ON records(project, kind, updated_at DESC)",
    ),
    (
        "index",
        "records_source_group",
        "CREATE INDEX records_source_group ON records(source_group)",
    ),
    (
        "index",
        "records_body_id",
        "CREATE INDEX records_body_id ON records(body_id)",
    ),
    (
        "table",
        "memory_links",
        "CREATE TABLE memory_links (
            from_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
            to_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
            relation TEXT NOT NULL,
            origin TEXT NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit', 'auto', 'feedback')),
            weight REAL NOT NULL DEFAULT 1.0,
            evidence TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence)),
            PRIMARY KEY(from_id, to_id, relation)
        ) WITHOUT ROWID",
    ),
    (
        "index",
        "memory_links_target",
        "CREATE INDEX memory_links_target ON memory_links(to_id)",
    ),
    (
        "table",
        "record_stats",
        "CREATE TABLE record_stats (
            record_id TEXT PRIMARY KEY NOT NULL REFERENCES records(id) ON DELETE CASCADE,
            use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
            confirm_count INTEGER NOT NULL DEFAULT 0 CHECK(confirm_count >= 0),
            contradict_count INTEGER NOT NULL DEFAULT 0 CHECK(contradict_count >= 0),
            last_used_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
            superseded_by TEXT REFERENCES records(id) ON DELETE SET NULL
        ) WITHOUT ROWID",
    ),
    (
        "view",
        "record_text",
        "CREATE VIEW record_text AS
            SELECT r.rowid AS rowid, r.title, b.content
            FROM records r JOIN bodies b ON b.id = r.body_id",
    ),
    (
        "table",
        "record_fts",
        "CREATE VIRTUAL TABLE record_fts USING fts5(
            title, content, content='record_text', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )",
    ),
    (
        "trigger",
        "records_insert_fts",
        "CREATE TRIGGER records_insert_fts AFTER INSERT ON records BEGIN
            INSERT INTO record_fts(rowid, title, content)
            VALUES(new.rowid, new.title, (SELECT content FROM bodies WHERE id = new.body_id));
        END",
    ),
    (
        "trigger",
        "records_delete_fts",
        "CREATE TRIGGER records_delete_fts AFTER DELETE ON records BEGIN
            INSERT INTO record_fts(record_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, (SELECT content FROM bodies WHERE id = old.body_id));
        END",
    ),
    (
        "trigger",
        "records_update_fts",
        "CREATE TRIGGER records_update_fts AFTER UPDATE OF title, body_id ON records
        WHEN old.title IS NOT new.title OR old.body_id IS NOT new.body_id BEGIN
            INSERT INTO record_fts(record_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, (SELECT content FROM bodies WHERE id = old.body_id));
            INSERT INTO record_fts(rowid, title, content)
            VALUES(new.rowid, new.title, (SELECT content FROM bodies WHERE id = new.body_id));
        END",
    ),
];

const RECORD_COLUMNS: &str = "r.id, r.source_group, r.source_key, r.source_type, r.kind, r.project,
     r.title, b.content, r.source_path, r.updated_at, r.metadata";

pub struct Store {
    connection: Connection,
    writable: bool,
}

impl Store {
    pub fn open(path: &Path, write: bool) -> Result<Self> {
        let open_path = if write && path != Path::new(":memory:") {
            prepare_database_file(path)?;
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            fs::canonicalize(parent)?.join(
                path.file_name()
                    .context("memory index path has no filename")?,
            )
        } else {
            path.to_path_buf()
        };
        let access = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let mut connection =
            Connection::open_with_flags(&open_path, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)
                .with_context(|| format!("cannot open memory index {}", path.display()))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let behavior = if write {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        };
        let transaction = connection.transaction_with_behavior(behavior)?;
        if write {
            initialize_empty_schema(&transaction)?;
        }
        validate_schema(&transaction)?;
        transaction.commit()?;
        if write {
            let _: String =
                connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            connection.pragma_update(None, "synchronous", "FULL")?;
        } else {
            connection.pragma_update(None, "query_only", true)?;
        }
        Ok(Self {
            connection,
            writable: write,
        })
    }

    pub fn apply(&mut self, batch: &ImportBatch) -> Result<ImportReport> {
        self.apply_inner(batch, true)
    }

    pub fn apply_without_autolink(&mut self, batch: &ImportBatch) -> Result<ImportReport> {
        self.apply_inner(batch, false)
    }

    fn apply_inner(&mut self, batch: &ImportBatch, rebuild_auto: bool) -> Result<ImportReport> {
        ensure!(self.writable, "memory index was opened read-only");
        validate_batch(batch)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        stage_refresh(&transaction, batch)?;
        let mut report = ImportReport {
            warnings: batch.warnings.clone(),
            ..ImportReport::default()
        };
        for record in &batch.records {
            upsert_record(&transaction, record, &mut report)?;
        }
        report.removed = transaction.execute(
            "DELETE FROM records
             WHERE source_group IN (SELECT source_group FROM refresh_groups)
               AND id NOT IN (SELECT id FROM refresh_records)",
            [],
        )?;
        report.links = refresh_links(&transaction)?;
        transaction.execute(
            "DELETE FROM bodies
             WHERE NOT EXISTS (SELECT 1 FROM records WHERE body_id = bodies.id)",
            [],
        )?;
        transaction.execute_batch(
            "DROP TABLE temp.refresh_links;
             DROP TABLE temp.refresh_records;
             DROP TABLE temp.refresh_groups;",
        )?;
        let touched = report.inserted + report.updated + report.removed;
        if rebuild_auto && touched > 0 {
            let has_curated_or_summary = batch.records.iter().any(|r| {
                r.source_type != "cavemem" || r.kind == "summary"
            }) || report.removed > 0;
            if has_curated_or_summary {
                report.auto_links = linker::rebuild_auto_links(&transaction)?;
            }
        }
        transaction.commit()?;
        Ok(report)
    }

    pub fn insert_native_and_autolink(
        &mut self,
        record: &MemoryRecord,
        supersedes: &[String],
    ) -> Result<(bool, Vec<String>, Vec<Value>)> {
        ensure!(self.writable, "memory index was opened read-only");
        let batch = ImportBatch {
            groups: vec![record.source_group.clone()],
            records: vec![record.clone()],
            ..ImportBatch::default()
        };
        validate_batch(&batch)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        stage_refresh(&transaction, &batch)?;
        let mut report = ImportReport::default();
        upsert_record(&transaction, record, &mut report)?;
        transaction.execute_batch(
            "DROP TABLE temp.refresh_links;
             DROP TABLE temp.refresh_records;
             DROP TABLE temp.refresh_groups;",
        )?;

        let mut marked_superseded = Vec::new();
        for old_id in supersedes {
            if old_id == &record.id {
                continue;
            }
            let exists: Option<String> = transaction
                .query_row("SELECT id FROM records WHERE id = ?", [old_id], |r| r.get(0))
                .optional()?;
            if exists.is_some() {
                apply_supersession_tx(&transaction, old_id, &record.id, record.updated_at)?;
                marked_superseded.push(old_id.clone());
            }
        }
        let discovered = linker::link_single_record(&transaction, &record.id)?;
        transaction.commit()?;
        Ok((report.inserted == 0, marked_superseded, discovered))
    }

    pub fn restore_explicit_links(&mut self, links: &[MemoryLink]) -> Result<usize> {
        ensure!(self.writable, "memory index was opened read-only");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut stmt = tx.prepare(
            "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
             SELECT ?1, ?2, ?3, 'explicit', 1.0, '[]'
             WHERE EXISTS (SELECT 1 FROM records WHERE id = ?1)
               AND EXISTS (SELECT 1 FROM records WHERE id = ?2)
             ON CONFLICT(from_id, to_id, relation) DO NOTHING",
        )?;
        let mut inserted = 0usize;
        for l in links {
            inserted += stmt.execute(params![l.from_id, l.to_id, l.relation])?;
        }
        drop(stmt);
        tx.commit()?;
        Ok(inserted)
    }

    pub fn rebuild_auto_links(&mut self) -> Result<usize> {
        ensure!(self.writable, "memory index was opened read-only");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let built = linker::rebuild_auto_links(&tx)?;
        tx.commit()?;
        Ok(built)
    }

    pub fn record_feedback(
        &mut self,
        id: &str,
        outcome: &str,
        superseded_by: Option<&str>,
    ) -> Result<Value> {
        ensure!(self.writable, "memory index was opened read-only");
        ensure!(
            matches!(outcome, "helpful" | "outdated" | "contradicted"),
            "outcome must be helpful, outdated, or contradicted"
        );
        let now = now_millis()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: Option<String> = tx
            .query_row("SELECT id FROM records WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        ensure!(exists.is_some(), "memory ID not found: {id}");

        if let Some(replacement) = superseded_by {
            ensure!(replacement != id, "record cannot supersede itself");
            let rep_exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM records WHERE id = ?",
                    [replacement],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                rep_exists.is_some(),
                "replacement memory ID not found: {replacement}"
            );
            apply_supersession_tx(&tx, id, replacement, now)?;
        }

        match outcome {
            "helpful" => {
                tx.execute(
                    "INSERT INTO record_stats(record_id, use_count, confirm_count, last_used_at)
                     VALUES (?1, 1, 1, ?2)
                     ON CONFLICT(record_id) DO UPDATE SET
                        confirm_count = record_stats.confirm_count + 1,
                        use_count = record_stats.use_count + 1,
                        last_used_at = excluded.last_used_at",
                    params![id, now],
                )?;
            }
            "outdated" => {
                tx.execute(
                    "INSERT INTO record_stats(record_id, contradict_count, status, last_used_at)
                     VALUES (?1, 1, 'superseded', ?2)
                     ON CONFLICT(record_id) DO UPDATE SET
                        contradict_count = record_stats.contradict_count + 1,
                        status = 'superseded',
                        last_used_at = excluded.last_used_at",
                    params![id, now],
                )?;
            }
            "contradicted" => {
                tx.execute(
                    "INSERT INTO record_stats(record_id, contradict_count, last_used_at)
                     VALUES (?1, 1, ?2)
                     ON CONFLICT(record_id) DO UPDATE SET
                        contradict_count = record_stats.contradict_count + 1,
                        status = CASE WHEN ?3 IS NOT NULL THEN 'superseded' ELSE record_stats.status END,
                        last_used_at = excluded.last_used_at",
                    params![id, now, superseded_by],
                )?;
            }
            _ => unreachable!(),
        }

        let stats = query_stats_tx(&tx, id)?.unwrap_or_else(|| json!({}));
        tx.commit()?;
        Ok(json!({
            "id": id,
            "outcome": outcome,
            "stats": stats,
        }))
    }

    pub fn reinforce_use(&mut self, id: &str) -> Result<bool> {
        ensure!(self.writable, "memory index was opened read-only");
        let now = now_millis()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: Option<String> = tx
            .query_row("SELECT id FROM records WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        let Some(_) = exists else {
            return Ok(false);
        };
        tx.execute(
            "INSERT INTO record_stats(record_id, use_count, last_used_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(record_id) DO UPDATE SET
                use_count = record_stats.use_count + 1,
                last_used_at = excluded.last_used_at",
            params![id, now],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn record_signal(&self, id: &str) -> Result<Option<Value>> {
        query_stats_conn(&self.connection, id)
    }

    pub fn consolidate(
        &self,
        project: Option<&str>,
        min_occurrences: usize,
        limit: usize,
    ) -> Result<Value> {
        linker::consolidate_patterns(&self.connection, project, min_occurrences, limit)
    }

    pub fn compact_and_checkpoint(&mut self) -> Result<()> {
        ensure!(self.writable, "memory index was opened read-only");
        self.connection
            .execute_batch("INSERT INTO record_fts(record_fts) VALUES('optimize');")?;
        let _: (i64, i64, i64) =
            self.connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
        self.connection.execute_batch("VACUUM;")?;
        let _: String = self
            .connection
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        self.connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(())
    }

    pub fn finalize_standalone_archive(&mut self) -> Result<()> {
        ensure!(self.writable, "memory index was opened read-only");
        self.connection
            .execute_batch("INSERT INTO record_fts(record_fts) VALUES('optimize');")?;
        let _: String = self
            .connection
            .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
        self.connection.execute_batch("VACUUM;")?;
        Ok(())
    }

    pub fn search(&self, query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>> {
        let limit = opts.limit.min(MAX_RESULTS);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let Some(expression) = search_expression(query) else {
            return Ok(Vec::new());
        };
        let mut sql = String::from(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                    r.updated_at,
                    substr(snippet(record_fts, 1, '', '', ' … ', 32), 1, 640),
                    -bm25(record_fts, 4.0, 1.0)
                        * CASE
                            WHEN r.kind = 'correction' THEN 2.2
                            WHEN r.source_type IN ('markdown', 'iron') THEN 2.0
                            ELSE 1.0
                          END
                        * (1.0 + 0.45 * (
                            (COALESCE(s.use_count, 0) + 2.0 * COALESCE(s.confirm_count, 0))
                            / (4.0 + COALESCE(s.use_count, 0) + 2.0 * COALESCE(s.confirm_count, 0))
                          ))
                        * CASE WHEN COALESCE(s.status, 'active') = 'superseded' THEN 0.15 ELSE 1.0 END
                        * (1.0 / (1.0 + 0.4 * COALESCE(s.contradict_count, 0))) AS score,
                    NULL AS relation,
                    '[]' AS evidence,
                    CASE WHEN s.status = 'superseded' THEN s.status ELSE NULL END AS status,
                    s.superseded_by
             FROM record_fts
             JOIN records r ON r.rowid = record_fts.rowid
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE record_fts MATCH ?",
        );
        let mut arguments = vec![SqlValue::Text(expression)];
        if opts.exclude_superseded {
            sql.push_str(" AND COALESCE(s.status, 'active') != 'superseded'");
        }
        if let Some(project) = &opts.project {
            if opts.include_global {
                sql.push_str(" AND (r.project = ? OR r.project = '*')");
            } else {
                sql.push_str(" AND r.project = ?");
            }
            arguments.push(SqlValue::Text(project.clone()));
        }
        for (column, filters) in [("kind", &opts.kinds), ("source_type", &opts.source_types)] {
            ensure!(
                filters.len() <= MAX_FILTER_VALUES,
                "too many memory {column} filters"
            );
            if !filters.is_empty() {
                sql.push_str(&format!(" AND r.{column} IN ("));
                sql.push_str(&vec!["?"; filters.len()].join(","));
                sql.push(')');
                arguments.extend(filters.iter().cloned().map(SqlValue::Text));
            }
        }
        sql.push_str(" ORDER BY score DESC, r.updated_at DESC, r.id LIMIT ?");
        let candidates = limit.saturating_mul(4).min(MAX_CANDIDATES);
        arguments.push(SqlValue::Integer(candidates as i64));
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(arguments), hit_from_row)?;
        let mut hits = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn list_records(&self, source_type: &str, kinds: &[&str]) -> Result<Vec<MemoryRecord>> {
        let mut sql = format!(
            "SELECT {RECORD_COLUMNS}
             FROM records r JOIN bodies b ON b.id = r.body_id
             WHERE r.source_type = ?"
        );
        let mut arguments = vec![SqlValue::Text(source_type.to_owned())];
        if !kinds.is_empty() {
            sql.push_str(" AND r.kind IN (");
            sql.push_str(&vec!["?"; kinds.len()].join(","));
            sql.push(')');
            arguments.extend(kinds.iter().map(|kind| SqlValue::Text((*kind).to_owned())));
        }
        sql.push_str(" ORDER BY r.id ASC");
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(arguments), record_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: &str) -> Result<Option<MemoryRecord>> {
        let sql = format!(
            "SELECT {RECORD_COLUMNS}
             FROM records r JOIN bodies b ON b.id = r.body_id WHERE r.id = ?"
        );
        Ok(self
            .connection
            .query_row(&sql, [id], record_from_row)
            .optional()?)
    }

    pub fn related(
        &self,
        id: &str,
        relation: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let limit = limit.min(MAX_RESULTS);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut sql = String::from(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                    r.updated_at, substr(b.content, 1, 640), MAX(l.weight) AS score,
                    MIN(l.relation) AS relation,
                    MAX(l.evidence) AS evidence,
                    CASE WHEN s.status = 'superseded' THEN s.status ELSE NULL END AS status,
                    s.superseded_by
             FROM memory_links l
             JOIN records r ON r.id = l.to_id
             JOIN bodies b ON b.id = r.body_id
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE l.from_id = ?",
        );
        let mut arguments = vec![SqlValue::Text(id.to_owned())];
        if let Some(relation) = relation {
            sql.push_str(" AND l.relation = ?");
            arguments.push(SqlValue::Text(relation.to_owned()));
        }
        sql.push_str(" GROUP BY r.id ORDER BY score DESC, r.updated_at DESC, r.id LIMIT ?");
        arguments.push(SqlValue::Integer(limit as i64));
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(arguments), hit_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn stats(&self) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut statistics = transaction.query_row(
            "SELECT
                (SELECT COUNT(*) FROM records),
                (SELECT COUNT(*) FROM bodies),
                (SELECT COUNT(*) FROM memory_links),
                (SELECT COUNT(*) FROM memory_links WHERE origin = 'auto'),
                (SELECT COUNT(*) FROM record_stats WHERE use_count > 0 OR confirm_count > 0),
                (SELECT COUNT(*) FROM record_stats WHERE status = 'superseded'),
                (SELECT COALESCE(SUM(length(CAST(b.content AS BLOB))), 0)
                    FROM records r JOIN bodies b ON b.id = r.body_id),
                (SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM bodies)",
            [],
            |row| {
                Ok(json!({
                    "schema_version": SCHEMA_VERSION,
                    "records": row.get::<_, i64>(0)?,
                    "bodies": row.get::<_, i64>(1)?,
                    "links": row.get::<_, i64>(2)?,
                    "auto_links": row.get::<_, i64>(3)?,
                    "reinforced_records": row.get::<_, i64>(4)?,
                    "superseded_records": row.get::<_, i64>(5)?,
                    "content_bytes": row.get::<_, i64>(6)?,
                    "unique_content_bytes": row.get::<_, i64>(7)?,
                }))
            },
        )?;
        statistics["by_source_type"] = grouped_counts(
            &transaction,
            "SELECT source_type, COUNT(*) FROM records GROUP BY source_type ORDER BY source_type",
        )?;
        statistics["by_link_origin"] = grouped_counts(
            &transaction,
            "SELECT origin, COUNT(*) FROM memory_links GROUP BY origin ORDER BY origin",
        )?;
        statistics["by_project"] = grouped_counts(
            &transaction,
            "SELECT project, COUNT(*) FROM records GROUP BY project ORDER BY project",
        )?;
        transaction.commit()?;
        Ok(statistics)
    }
}

fn now_millis() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system time precedes the Unix epoch")?
            .as_millis(),
    )
    .context("system time exceeds timestamp range")
}

fn apply_supersession_tx(
    tx: &Transaction<'_>,
    old_id: &str,
    new_id: &str,
    ts: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO record_stats(record_id, status, superseded_by, last_used_at)
         VALUES (?1, 'superseded', ?2, ?3)
         ON CONFLICT(record_id) DO UPDATE SET
            status = 'superseded',
            superseded_by = excluded.superseded_by,
            last_used_at = excluded.last_used_at",
        params![old_id, new_id, ts],
    )?;
    tx.execute(
        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
         VALUES (?1, ?2, 'supersedes', 'feedback', 2.0, '[\"supersedes\"]')
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET origin = 'feedback', weight = 2.0",
        params![new_id, old_id],
    )?;
    tx.execute(
        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
         VALUES (?1, ?2, 'superseded_by', 'feedback', 2.0, '[\"superseded_by\"]')
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET origin = 'feedback', weight = 2.0",
        params![old_id, new_id],
    )?;
    Ok(())
}

fn query_stats_tx(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    query_stats_conn(tx, id)
}

fn query_stats_conn(conn: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(conn
        .query_row(
            "SELECT use_count, confirm_count, contradict_count, last_used_at, status, superseded_by
             FROM record_stats WHERE record_id = ?",
            [id],
            |row| {
                Ok(json!({
                    "use_count": row.get::<_, i64>(0)?,
                    "confirm_count": row.get::<_, i64>(1)?,
                    "contradict_count": row.get::<_, i64>(2)?,
                    "last_used_at": row.get::<_, i64>(3)?,
                    "status": row.get::<_, String>(4)?,
                    "superseded_by": row.get::<_, Option<String>>(5)?,
                }))
            },
        )
        .optional()?)
}

fn prepare_database_file(path: &Path) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        let mut directory = fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(parent).with_context(|| {
            format!("cannot create memory index directory {}", parent.display())
        })?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                !fs::symlink_metadata(path)?.file_type().is_symlink(),
                "refusing to write through a memory index symlink: {}",
                path.display()
            );
            Ok(())
        }
        Err(error) => {
            Err(error).with_context(|| format!("cannot create memory index {}", path.display()))
        }
    }
}

fn initialize_empty_schema(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if version != 0 || application_id != 0 {
        return Ok(());
    }
    let objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        objects == 0,
        "refusing to initialize an unrecognized database"
    );
    for (_, _, sql) in SCHEMA {
        connection.execute_batch(sql)?;
    }
    connection.pragma_update(None, "application_id", APPLICATION_ID)?;
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    ensure!(
        version == SCHEMA_VERSION,
        "unsupported memory schema version {version}; expected {SCHEMA_VERSION} (run `iron memory migrate`)"
    );
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    ensure!(
        application_id == APPLICATION_ID,
        "database is not an Iron Memory index"
    );
    let mut statement = connection.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?")?;
    for (kind, name, expected) in SCHEMA {
        let actual: Option<(String, String)> = statement
            .query_row([name], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let Some((actual_kind, actual_sql)) = actual else {
            bail!("memory index is missing schema object {name}");
        };
        ensure!(
            actual_kind == *kind && normalize_sql(&actual_sql) == normalize_sql(expected),
            "memory index has incompatible schema object {name}"
        );
    }
    connection.prepare("SELECT rowid, title, content FROM record_fts LIMIT 0")?;
    Ok(())
}

fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn validate_batch(batch: &ImportBatch) -> Result<()> {
    let mut groups = HashSet::new();
    for group in &batch.groups {
        ensure!(!group.is_empty(), "source group cannot be empty");
        ensure!(
            groups.insert(group.as_str()),
            "duplicate source group in import batch"
        );
    }
    let mut ids = HashSet::new();
    let mut source_keys = HashSet::new();
    for record in &batch.records {
        ensure!(
            groups.contains(record.source_group.as_str()),
            "record source group is not declared complete: {}",
            record.id
        );
        ensure!(
            ids.insert(record.id.as_str()),
            "duplicate record ID in import batch: {}",
            record.id
        );
        ensure!(
            source_keys.insert((record.source_group.as_str(), record.source_key.as_str())),
            "duplicate source key in import batch: {}",
            record.source_key
        );
        ensure!(
            [
                record.id.as_str(),
                record.source_key.as_str(),
                record.source_type.as_str(),
                record.kind.as_str(),
                record.project.as_str(),
                record.source_path.as_str(),
            ]
            .iter()
            .all(|value| !value.is_empty()),
            "record provenance fields cannot be empty: {}",
            record.id
        );
    }
    for link in &batch.links {
        ensure!(
            ids.contains(link.from_id.as_str()),
            "link origin is not in refreshed records: {}",
            link.from_id
        );
        ensure!(
            !link.to_id.is_empty() && !link.relation.is_empty(),
            "link target and relation cannot be empty"
        );
    }
    Ok(())
}

fn stage_refresh(transaction: &Transaction<'_>, batch: &ImportBatch) -> Result<()> {
    transaction.execute_batch(
        "CREATE TEMP TABLE refresh_groups (source_group TEXT PRIMARY KEY) WITHOUT ROWID;
         CREATE TEMP TABLE refresh_records (id TEXT PRIMARY KEY) WITHOUT ROWID;
         CREATE TEMP TABLE refresh_links (
            from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL,
            PRIMARY KEY(from_id, to_id, relation)
         ) WITHOUT ROWID;",
    )?;
    let mut groups = transaction.prepare("INSERT INTO refresh_groups(source_group) VALUES (?)")?;
    for group in &batch.groups {
        groups.execute([group])?;
    }
    let mut records = transaction.prepare("INSERT INTO refresh_records(id) VALUES (?)")?;
    for record in &batch.records {
        records.execute([&record.id])?;
    }
    let mut links = transaction.prepare(
        "INSERT OR IGNORE INTO refresh_links(from_id, to_id, relation) VALUES (?, ?, ?)",
    )?;
    for link in &batch.links {
        links.execute(params![link.from_id, link.to_id, link.relation])?;
    }
    Ok(())
}

fn upsert_record(
    transaction: &Transaction<'_>,
    record: &MemoryRecord,
    report: &mut ImportReport,
) -> Result<()> {
    let identity: Option<(String, String)> = transaction
        .prepare_cached("SELECT source_group, source_key FROM records WHERE id = ?")?
        .query_row([&record.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((group, key)) = &identity {
        ensure!(
            group == &record.source_group && key == &record.source_key,
            "record ID collides with another source identity: {}",
            record.id
        );
    }
    let digest = Sha256::digest(record.content.as_bytes());
    let hash_bytes: &[u8] = digest.as_slice();
    let metadata = serde_json::to_string(&record.metadata)?;
    transaction
        .prepare_cached("INSERT OR IGNORE INTO bodies(hash, content) VALUES (?, ?)")?
        .execute(params![hash_bytes, record.content])?;
    let body_id: i64 = transaction
        .prepare_cached("SELECT id FROM bodies WHERE hash = ?")?
        .query_row([hash_bytes], |row| row.get(0))?;

    let changed = transaction
        .prepare_cached(
            "INSERT INTO records (
            id, source_group, source_key, source_type, kind, project, title,
            body_id, source_path, updated_at, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            source_type = excluded.source_type, kind = excluded.kind,
            project = excluded.project, title = excluded.title,
            body_id = excluded.body_id, source_path = excluded.source_path,
            updated_at = excluded.updated_at, metadata = excluded.metadata
         WHERE records.source_type IS NOT excluded.source_type
            OR records.kind IS NOT excluded.kind
            OR records.project IS NOT excluded.project
            OR records.title IS NOT excluded.title
            OR records.body_id IS NOT excluded.body_id
            OR records.source_path IS NOT excluded.source_path
            OR records.updated_at IS NOT excluded.updated_at
            OR records.metadata IS NOT excluded.metadata",
        )?
        .execute(params![
            record.id,
            record.source_group,
            record.source_key,
            record.source_type,
            record.kind,
            record.project,
            record.title,
            body_id,
            record.source_path,
            record.updated_at,
            metadata
        ])
        .with_context(|| format!("cannot index record {}", record.id))?;
    if identity.is_none() {
        report.inserted += 1;
    } else if changed == 0 {
        report.unchanged += 1;
    } else {
        report.updated += 1;
    }
    Ok(())
}

fn refresh_links(transaction: &Transaction<'_>) -> Result<usize> {
    let missing: Option<(String, String)> = transaction
        .query_row(
            "SELECT l.from_id, l.to_id FROM refresh_links l
         LEFT JOIN records origin ON origin.id = l.from_id
         LEFT JOIN records target ON target.id = l.to_id
         WHERE origin.id IS NULL OR target.id IS NULL LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((from, to)) = missing {
        bail!("link references a missing record: {from} -> {to}");
    }
    transaction.execute(
        "DELETE FROM memory_links
         WHERE origin = 'explicit'
           AND from_id IN (
            SELECT id FROM records WHERE source_group IN (SELECT source_group FROM refresh_groups)
         ) AND NOT EXISTS (
            SELECT 1 FROM refresh_links l WHERE l.from_id = memory_links.from_id
                AND l.to_id = memory_links.to_id AND l.relation = memory_links.relation
         )",
        [],
    )?;
    transaction.execute(
        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
         SELECT from_id, to_id, relation, 'explicit', 1.0, '[]' FROM refresh_links WHERE true
         ON CONFLICT(from_id, to_id, relation) DO NOTHING",
        [],
    )?;
    Ok(usize::try_from(transaction.query_row(
        "SELECT COUNT(*) FROM refresh_links",
        [],
        |row| row.get::<_, i64>(0),
    )?)?)
}

fn search_expression(query: &str) -> Option<String> {
    let end = utf8_boundary(query, MAX_QUERY_BYTES);
    let mut seen = HashSet::new();
    let terms: Vec<String> = QUERY_TOKEN
        .find_iter(&query[..end])
        .filter_map(|capture| {
            let token = capture.as_str();
            if token.len() > MAX_TERM_BYTES {
                return None;
            }
            let token = token.to_lowercase();
            seen.insert(token.clone()).then(|| format!("\"{token}\""))
        })
        .take(MAX_QUERY_TERMS)
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

fn utf8_boundary(text: &str, max_bytes: usize) -> usize {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn bounded_snippet(text: String) -> String {
    if text.len() <= SNIPPET_BYTES {
        return text;
    }
    let end = utf8_boundary(&text, SNIPPET_BYTES - '…'.len_utf8());
    format!("{}…", &text[..end])
}

fn hit_from_row(row: &Row<'_>) -> rusqlite::Result<SearchHit> {
    let evidence_raw: String = row.get(10)?;
    let evidence: Vec<String> = serde_json::from_str(&evidence_raw).unwrap_or_default();
    Ok(SearchHit {
        id: row.get(0)?,
        title: row.get(1)?,
        project: row.get(2)?,
        kind: row.get(3)?,
        source_type: row.get(4)?,
        source_path: row.get(5)?,
        updated_at: row.get(6)?,
        snippet: bounded_snippet(row.get(7)?),
        score: row.get(8)?,
        relation: row.get(9)?,
        evidence,
        status: row.get(11)?,
        superseded_by: row.get(12)?,
    })
}

fn record_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let metadata: String = row.get(10)?;
    let metadata = serde_json::from_str(&metadata).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, Type::Text, Box::new(error))
    })?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        source_group: row.get(1)?,
        source_key: row.get(2)?,
        source_type: row.get(3)?,
        kind: row.get(4)?,
        project: row.get(5)?,
        title: row.get(6)?,
        content: row.get(7)?,
        source_path: row.get(8)?,
        updated_at: row.get(9)?,
        metadata,
    })
}

fn grouped_counts(connection: &Connection, sql: &str) -> Result<Value> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = Map::new();
    for row in rows {
        let (key, count) = row?;
        counts.insert(key, json!(count));
    }
    Ok(Value::Object(counts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MemoryLink;
    use tempfile::TempDir;

    #[test]
    fn writable_connections_require_full_synchronous_commits() {
        let temporary = TempDir::new().unwrap();
        let store = Store::open(&temporary.path().join("iron.db"), true).unwrap();
        let synchronous: i64 = store
            .connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 2);
    }

    #[test]
    fn durable_notes_receive_a_bounded_preference_without_hiding_history() {
        let temporary = TempDir::new().unwrap();
        let mut store = Store::open(&temporary.path().join("iron.db"), true).unwrap();
        let mut history = record(
            "history",
            "source",
            "alpha",
            "nebularsignal shared evidence",
        );
        history.title = "Same title".into();
        history.source_type = "cavemem".into();
        history.updated_at = 100;
        let mut curated = record(
            "curated",
            "source",
            "alpha",
            "nebularsignal shared evidence",
        );
        curated.title = "Same title".into();
        curated.updated_at = 1;
        store
            .apply(&ImportBatch {
                groups: vec!["source".into()],
                records: vec![history, curated],
                ..Default::default()
            })
            .unwrap();
        let hits = store
            .search("nebularsignal", &options(Some("alpha")))
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "curated");
        assert!((hits[0].score - hits[1].score * 2.0).abs() < 1e-9);
        let mut request = options(Some("alpha"));
        request.source_types = vec!["cavemem".into()];
        let history = store.search("nebularsignal", &request).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "history");
    }

    #[test]
    fn hebbian_reinforcement_and_supersession_reorder_equal_matches_and_link_across_sessions() {
        let (_dir, mut store) = fixture();
        let mut old_rec = record(
            "old_rule",
            "g1",
            "alpha",
            "Check variant_images_repo.rs with CWE-639 using legacy_guard_fn",
        );
        old_rec.metadata = json!({"session_id": "sess-1"});
        let mut reinforced_rec = record(
            "proven_rule",
            "g1",
            "alpha",
            "Check variant_images_repo.rs with CWE-639 using legacy_guard_fn",
        );
        reinforced_rec.metadata = json!({"session_id": "sess-2"});
        store
            .apply(&batch(&["g1"], vec![old_rec, reinforced_rec]))
            .unwrap();

        // Cross-session auto-link must connect old_rule <-> proven_rule via shared anchors
        let rel = store.related("old_rule", Some("shares_anchor"), 10).unwrap();
        assert_eq!(rel.len(), 1);
        assert_eq!(rel[0].id, "proven_rule");
        assert!(!rel[0].evidence.is_empty());

        // Reinforce proven_rule and supersede old_rule with a correction
        store.record_feedback("proven_rule", "helpful", None).unwrap();
        store.reinforce_use("proven_rule").unwrap();

        let mut corr = record(
            "new_correction",
            "native:new_correction",
            "alpha",
            "Always join product_brand_variants in variant_images_repo.rs to prevent CWE-639",
        );
        corr.source_type = "iron".into();
        corr.kind = "correction".into();
        corr.metadata = json!({"agent": "reviewer"});
        let (_, sup, discovered) = store
            .insert_native_and_autolink(&corr, &["old_rule".to_owned()])
            .unwrap();
        assert_eq!(sup, vec!["old_rule".to_owned()]);
        assert!(!discovered.is_empty());

        let hits = store.search("CWE-639", &options(Some("alpha"))).unwrap();
        assert_eq!(hits.len(), 3);
        // Superseded record must sink to the bottom and expose superseded_by pointer
        let last = hits.last().unwrap();
        assert_eq!(last.id, "old_rule");
        assert_eq!(last.status.as_deref(), Some("superseded"));
        assert_eq!(last.superseded_by.as_deref(), Some("new_correction"));
        assert!(hits[0].score > last.score * 5.0);

        // Consolidate must surface the recurring CWE-639 / variant_images_repo.rs cluster
        let consolidated = store.consolidate(Some("alpha"), 2, 10).unwrap();
        assert!(consolidated["count"].as_u64().unwrap() >= 1);
    }

    fn record(id: &str, group: &str, project: &str, content: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.to_owned(),
            source_group: group.to_owned(),
            source_key: format!("source/{id}"),
            source_type: "markdown".to_owned(),
            kind: "curated".to_owned(),
            project: project.to_owned(),
            title: format!("Memory {id}"),
            content: content.to_owned(),
            source_path: format!("/fixture/{id}.md"),
            updated_at: 1730000000000,
            metadata: json!({"session_id": "original-session", "compressed": true, "source_id": id}),
        }
    }

    fn batch(groups: &[&str], records: Vec<MemoryRecord>) -> ImportBatch {
        ImportBatch {
            groups: groups.iter().map(|group| (*group).to_owned()).collect(),
            records,
            ..ImportBatch::default()
        }
    }

    fn fixture() -> (TempDir, Store) {
        let directory = TempDir::new().unwrap();
        let store = Store::open(&directory.path().join("memory.db"), true).unwrap();
        (directory, store)
    }

    fn options(project: Option<&str>) -> SearchOptions {
        SearchOptions {
            project: project.map(str::to_owned),
            limit: 10,
            ..SearchOptions::default()
        }
    }

    fn hit_ids(hits: Vec<SearchHit>) -> Vec<String> {
        let mut ids: Vec<_> = hits.into_iter().map(|hit| hit.id).collect();
        ids.sort();
        ids
    }

    fn assert_fts_consistent(store: &Store) {
        store
            .connection
            .execute(
                "INSERT INTO record_fts(record_fts, rank) VALUES ('integrity-check', 1)",
                [],
            )
            .unwrap();
    }

    #[test]
    fn replay_deduplicates_content_without_losing_provenance() {
        let (_directory, mut store) = fixture();
        let mut second = record("two", "cavemem", "beta", "shared café evidence");
        second.source_type = "cavemem".to_owned();
        let input = batch(
            &["markdown", "cavemem"],
            vec![
                record("one", "markdown", "alpha", "shared café evidence"),
                second.clone(),
            ],
        );
        let first = store.apply(&input).unwrap();
        assert_eq!(first.inserted, 2);
        let replay = store.apply(&input).unwrap();
        assert_eq!(
            (
                replay.inserted,
                replay.updated,
                replay.removed,
                replay.unchanged
            ),
            (0, 0, 0, 2)
        );
        let stats = store.stats().unwrap();
        assert_eq!(stats["records"], 2);
        assert_eq!(stats["bodies"], 1);
        assert_eq!(stats["content_bytes"], "shared café evidence".len() * 2);
        assert_eq!(stats["unique_content_bytes"], "shared café evidence".len());
        assert_eq!(stats["by_project"]["alpha"], 1);
        assert_eq!(stats["by_source_type"]["cavemem"], 1);
        let loaded = store.get("two").unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(loaded).unwrap(),
            serde_json::to_value(second).unwrap()
        );
        assert_eq!(
            hit_ids(store.search("cafe", &options(None)).unwrap()),
            ["one", "two"]
        );
        assert_fts_consistent(&store);
    }

    #[test]
    fn changed_and_removed_records_replace_fts_and_preserve_other_groups() {
        let (_directory, mut store) = fixture();
        store
            .apply(&batch(
                &["a", "b"],
                vec![
                    record("keep", "a", "alpha", "obsoleteplanet"),
                    record("remove", "a", "alpha", "vanishedmoon"),
                    record("other", "b", "beta", "independentstar"),
                ],
            ))
            .unwrap();
        let mut changed = record("keep", "a", "alpha", "replacementcomet");
        changed.title = "Fresh nebula".to_owned();
        changed.metadata["source_revision"] = json!(2);
        let report = store.apply(&batch(&["a"], vec![changed])).unwrap();
        assert_eq!((report.updated, report.removed), (1, 1));
        assert!(store.get("remove").unwrap().is_none());
        assert!(store.get("other").unwrap().is_some());
        assert!(
            store
                .search("obsoleteplanet vanishedmoon", &options(None))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            hit_ids(store.search("replacementcomet", &options(None)).unwrap()),
            ["keep"]
        );
        assert_eq!(
            hit_ids(store.search("nebula", &options(None)).unwrap()),
            ["keep"]
        );
        assert_eq!(store.stats().unwrap()["bodies"], 2);
        assert_fts_consistent(&store);
        let removed = store.apply(&batch(&["a"], Vec::new())).unwrap();
        assert_eq!(removed.removed, 1);
        assert_eq!(store.stats().unwrap()["records"], 1);
        assert!(
            store
                .search("replacementcomet", &options(None))
                .unwrap()
                .is_empty()
        );
        assert_fts_consistent(&store);
    }

    #[test]
    fn failed_refresh_rolls_back_updates_pruning_bodies_links_and_fts() {
        let (_directory, mut store) = fixture();
        let mut original = batch(
            &["a", "b"],
            vec![
                record("one", "a", "alpha", "originalcorpus"),
                record("two", "a", "alpha", "retainedhistory"),
                record("remote", "b", "beta", "externalreference"),
            ],
        );
        original
            .links
            .push(MemoryLink::explicit("one".into(), "two".into(), "reference".into()));
        store.apply(&original).unwrap();
        let before = store.stats().unwrap();
        let mut invalid = batch(
            &["a"],
            vec![record("one", "a", "alpha", "uncommittedphrase")],
        );
        invalid.links.push(MemoryLink::explicit(
            "one".into(),
            "missing".into(),
            "reference".into(),
        ));
        assert!(store.apply(&invalid).is_err());
        assert_eq!(store.stats().unwrap(), before);
        assert_eq!(store.get("one").unwrap().unwrap().content, "originalcorpus");
        assert!(store.get("two").unwrap().is_some());
        assert_eq!(hit_ids(store.related("one", None, 10).unwrap()), ["two"]);
        assert!(
            store
                .search("uncommittedphrase", &options(None))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            hit_ids(store.search("originalcorpus", &options(None)).unwrap()),
            ["one"]
        );
        assert_fts_consistent(&store);
        assert_eq!(store.apply(&original).unwrap().unchanged, 3);
    }

    #[test]
    fn duplicate_or_incomplete_batches_cannot_prune_existing_records() {
        let (_directory, mut store) = fixture();
        let original = record("one", "a", "alpha", "retainedrecord");
        store.apply(&batch(&["a"], vec![original.clone()])).unwrap();
        let mut changed = original.clone();
        changed.content = "differentbody".to_owned();
        assert!(
            store
                .apply(&batch(&["a"], vec![original.clone(), changed]))
                .is_err()
        );
        assert!(store.apply(&batch(&[], vec![original.clone()])).is_err());
        let mut conflicting = original.clone();
        conflicting.id = "different-id".to_owned();
        assert!(store.apply(&batch(&["a"], vec![conflicting])).is_err());
        let mut moved = original.clone();
        moved.source_group = "b".to_owned();
        assert!(
            store
                .apply(&batch(
                    &["b"],
                    vec![record("new", "b", "beta", "temporarybody"), moved]
                ))
                .is_err()
        );
        assert_eq!(store.get("one").unwrap().unwrap().content, original.content);
        assert!(store.get("new").unwrap().is_none());
        assert_eq!(store.stats().unwrap()["bodies"], 1);
        assert_fts_consistent(&store);
    }

    #[test]
    fn project_scope_kind_and_source_filters_apply_before_candidate_limits() {
        let (_directory, mut store) = fixture();
        let mut records: Vec<_> = (0..300)
            .map(|index| record(&format!("beta{index}"), "a", "beta", "scopetoken"))
            .collect();
        records.extend([
            record("alpha", "a", "alpha", "scopetoken"),
            record("global", "a", "*", "scopetoken"),
        ]);
        let mut summary = record("summary", "a", "alpha", "scopetoken");
        summary.kind = "summary".to_owned();
        summary.source_type = "cavemem".to_owned();
        records.push(summary);
        store.apply(&batch(&["a"], records)).unwrap();
        let mut opts = options(Some("alpha"));
        assert_eq!(
            hit_ids(store.search("scopetoken", &opts).unwrap()),
            ["alpha", "summary"]
        );
        opts.include_global = true;
        assert_eq!(
            hit_ids(store.search("scopetoken", &opts).unwrap()),
            ["alpha", "global", "summary"]
        );
        opts.kinds.push("summary".to_owned());
        assert_eq!(
            hit_ids(store.search("scopetoken", &opts).unwrap()),
            ["summary"]
        );
        assert!(
            store
                .search("scopetoken", &options(Some("unknown")))
                .unwrap()
                .is_empty()
        );
        opts = options(None);
        opts.source_types.push("cavemem".to_owned());
        assert_eq!(
            hit_ids(store.search("scopetoken", &opts).unwrap()),
            ["summary"]
        );
        opts.source_types.clear();
        opts.limit = usize::MAX;
        assert_eq!(
            store.search("scopetoken", &opts).unwrap().len(),
            MAX_RESULTS
        );
        opts.limit = 0;
        assert!(store.search("scopetoken", &opts).unwrap().is_empty());
    }

    #[test]
    fn queries_are_literal_unicode_tokens_with_bounded_work_and_snippets() {
        let (_directory, mut store) = fixture();
        let body = format!("café 日本語 sensitiveword {}", "航".repeat(2000));
        store
            .apply(&batch(&["a"], vec![record("one", "a", "alpha", &body)]))
            .unwrap();
        for query in [
            "\"café\" OR *",
            "content:café",
            "NEAR(café)",
            "café; DROP TABLE records; --",
            "\"\" café NOT absent",
            "日本語",
        ] {
            let hits = store.search(query, &options(None)).unwrap();
            assert_eq!(hit_ids(hits.clone()), ["one"], "{query}");
            assert!(hits[0].snippet.len() <= SNIPPET_BYTES);
            assert!(hits[0].score.is_finite());
        }
        assert!(
            store
                .search("* () \" : ; --", &options(None))
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .search("notpresentanywhere", &options(None))
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .search(&"x".repeat(100_000), &options(None))
                .unwrap()
                .is_empty()
        );
        assert_eq!(search_expression("A a B b").unwrap(), "\"a\" OR \"b\"");
        assert_eq!(search_expression("cafe\u{301}").unwrap(), "\"cafe\u{301}\"");
        let tokens = (0..100)
            .map(|index| format!("term{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            search_expression(&tokens).unwrap().split(" OR ").count(),
            MAX_QUERY_TERMS
        );
        let bounded = bounded_snippet("航".repeat(1000));
        assert!(bounded.len() <= SNIPPET_BYTES);
        assert!(bounded.ends_with('…'));
        assert_eq!(store.stats().unwrap()["records"], 1);
    }

    #[test]
    fn links_are_explicit_outgoing_deduplicated_and_refreshed_per_group() {
        let (_directory, mut store) = fixture();
        let mut input = batch(
            &["a", "b"],
            vec![
                record("one", "a", "alpha", "origin"),
                record("two", "a", "alpha", "target"),
                record("other", "b", "beta", "external"),
            ],
        );
        let reference = MemoryLink::explicit("one".into(), "two".into(), "reference".into());
        input.links.extend([
            reference.clone(),
            reference,
            MemoryLink::explicit("one".into(), "two".into(), "citation".into()),
            MemoryLink::explicit("other".into(), "one".into(), "reference".into()),
        ]);
        assert_eq!(store.apply(&input).unwrap().links, 3);
        assert_eq!(hit_ids(store.related("one", None, 10).unwrap()), ["two"]);
        assert_eq!(
            hit_ids(store.related("one", Some("citation"), 10).unwrap()),
            ["two"]
        );
        assert!(
            store
                .related("one", Some("invented"), 10)
                .unwrap()
                .is_empty()
        );
        assert!(store.related("two", None, 10).unwrap().is_empty());
        assert!(store.related("one", None, 0).unwrap().is_empty());
        store
            .apply(&batch(&["a"], input.records[..2].to_vec()))
            .unwrap();
        assert!(store.related("one", None, 10).unwrap().is_empty());
        assert_eq!(hit_ids(store.related("other", None, 10).unwrap()), ["one"]);
        store.apply(&batch(&["a"], Vec::new())).unwrap();
        assert!(store.related("other", None, 10).unwrap().is_empty());
        assert_eq!(store.stats().unwrap()["links"], 0);
        assert_fts_consistent(&store);
    }

    #[test]
    fn readonly_open_does_not_create_or_initialize_and_rejects_apply() {
        let directory = TempDir::new().unwrap();
        let missing = directory.path().join("missing").join("memory.db");
        assert!(Store::open(&missing, false).is_err());
        assert!(!missing.parent().unwrap().exists());
        let empty = directory.path().join("empty.db");
        fs::write(&empty, []).unwrap();
        assert!(Store::open(&empty, false).is_err());
        assert_eq!(fs::metadata(&empty).unwrap().len(), 0);
        let path = directory.path().join("memory.db");
        let mut writable = Store::open(&path, true).unwrap();
        writable
            .apply(&batch(
                &["a"],
                vec![record("one", "a", "alpha", "readonlytoken")],
            ))
            .unwrap();
        drop(writable);
        let before = fs::read(&path).unwrap();
        let mut readonly = Store::open(&path, false).unwrap();
        assert_eq!(
            hit_ids(readonly.search("readonlytoken", &options(None)).unwrap()),
            ["one"]
        );
        assert!(readonly.apply(&batch(&["a"], Vec::new())).is_err());
        drop(readonly);
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn future_foreign_and_tampered_schemas_are_rejected_without_replacement() {
        let (directory, store) = fixture();
        store
            .connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(store);
        let path = directory.path().join("memory.db");
        let before = fs::read(&path).unwrap();
        assert!(Store::open(&path, false).is_err());
        assert!(Store::open(&path, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let other_path = directory.path().join("foreign.db");
        let foreign = Connection::open(&other_path).unwrap();
        foreign
            .execute("CREATE TABLE unrelated(value TEXT)", [])
            .unwrap();
        drop(foreign);
        let foreign_bytes = fs::read(&other_path).unwrap();
        assert!(Store::open(&other_path, true).is_err());
        assert_eq!(fs::read(&other_path).unwrap(), foreign_bytes);
        let original = Connection::open(&other_path).unwrap();
        let journal_mode: String = original
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode, "delete");
        assert_eq!(
            original
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'unrelated'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let tampered_path = directory.path().join("tampered.db");
        let tampered = Store::open(&tampered_path, true).unwrap();
        tampered
            .connection
            .execute_batch(
                "DROP TRIGGER records_insert_fts;
             CREATE TRIGGER records_insert_fts AFTER INSERT ON records BEGIN SELECT 1; END;",
            )
            .unwrap();
        drop(tampered);
        assert!(Store::open(&tampered_path, false).is_err());
        assert!(Store::open(&tampered_path, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn new_database_and_directories_are_private_without_changing_existing_parents() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new().unwrap();
        let shared = directory.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o750)).unwrap();
        let path = shared.join("private").join("nested").join("memory.db");
        let _store = Store::open(&path, true).unwrap();
        assert_eq!(
            fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o750
        );
        let private_parent = shared.join("private");
        for private in [
            private_parent.as_path(),
            path.parent().unwrap(),
            path.as_path(),
        ] {
            assert_eq!(
                fs::metadata(private).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_database_symlinks_but_allows_canonical_parent_aliases() {
        use std::os::unix::fs::symlink;

        let (directory, mut store) = fixture();
        store
            .apply(&batch(
                &["a"],
                vec![record("one", "a", "alpha", "untouched")],
            ))
            .unwrap();
        drop(store);
        let target = directory.path().join("memory.db");
        let alias = directory.path().join("alias.db");
        let before = fs::read(&target).unwrap();
        symlink(&target, &alias).unwrap();
        assert!(Store::open(&alias, true).is_err());
        assert_eq!(
            Store::open(&alias, false)
                .unwrap()
                .get("one")
                .unwrap()
                .unwrap()
                .content,
            "untouched"
        );
        assert_eq!(fs::read(&target).unwrap(), before);
        let missing = directory.path().join("missing.db");
        let dangling = directory.path().join("dangling.db");
        symlink(&missing, &dangling).unwrap();
        assert!(Store::open(&dangling, true).is_err());
        assert!(!missing.exists());
        let real_parent = directory.path().join("real-parent");
        fs::create_dir(&real_parent).unwrap();
        let parent_alias = directory.path().join("parent-alias");
        symlink(&real_parent, &parent_alias).unwrap();
        let _store = Store::open(&parent_alias.join("other.db"), true).unwrap();
        assert!(real_parent.join("other.db").is_file());
    }
}
