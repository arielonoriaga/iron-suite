use std::collections::{BTreeMap, HashSet};
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
use crate::model::{
    BrowseOptions, ImportBatch, ImportReport, MemoryLink, MemoryRecord, SearchHit, SearchOptions,
};

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

    pub fn merge_projects(
        &mut self,
        from_project: &str,
        to_project: &str,
        include_subpaths: bool,
    ) -> Result<usize> {
        ensure!(self.writable, "memory index was opened read-only");
        ensure!(from_project != to_project, "source and target project names must differ");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = if include_subpaths {
            let slash_prefix = format!("{from_project}/");
            let wt_prefix = format!("{from_project}-worktrees/");
            tx.execute(
                "UPDATE records
                  SET project = ?1
                  WHERE project = ?2
                     OR substr(project, 1, length(?3)) = ?3
                     OR substr(project, 1, length(?4)) = ?4",
                params![to_project, from_project, slash_prefix, wt_prefix],
            )?
        } else {
            tx.execute(
                "UPDATE records SET project = ?1 WHERE project = ?2",
                params![to_project, from_project],
            )?
        };
        tx.commit()?;
        Ok(updated)
    }

    pub fn reinforce_co_used(
        &mut self,
        ids: &[String],
        increment_use: bool,
    ) -> Result<(usize, usize)> {
        ensure!(self.writable, "memory index was opened read-only");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0);
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut valid_ids = Vec::new();
        for id in ids.iter().take(16) {
            let exists: Option<i64> = tx
                .query_row("SELECT 1 FROM records WHERE id = ?1", [id], |r| r.get(0))
                .optional()?;
            if exists.is_some() && !valid_ids.iter().any(|x| x == id) {
                valid_ids.push(id.clone());
            }
        }
        let mut used = 0usize;
        if increment_use {
            for id in &valid_ids {
                tx.execute(
                    "INSERT INTO record_stats(record_id, use_count, last_used_at)
                     VALUES(?1, 1, ?2)
                     ON CONFLICT(record_id) DO UPDATE SET
                       use_count = use_count + 1,
                       last_used_at = MAX(last_used_at, excluded.last_used_at)",
                    params![id, now],
                )?;
                used += 1;
            }
        }
        let mut links = 0usize;
        for i in 0..valid_ids.len() {
            for j in (i + 1)..valid_ids.len() {
                let a = &valid_ids[i];
                let b = &valid_ids[j];
                for (from, to) in [(a, b), (b, a)] {
                    tx.execute(
                        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
                         VALUES(?1, ?2, 'co_used', 'feedback', 1.0, '[\"co_retrieved\"]')
                         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
                           weight = MIN(5.0, weight + 0.5)",
                        params![from, to],
                    )?;
                    links += 1;
                }
            }
        }
        tx.commit()?;
        Ok((used, links))
    }

    pub fn fetch_hits_by_ids(
        &self,
        ids: &[String],
        opts: &SearchOptions,
    ) -> Result<std::collections::HashMap<String, SearchHit>> {
        let mut out = std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let capped: Vec<&String> = ids.iter().take(MAX_RESULTS).collect();
        let placeholders = vec!["?"; capped.len()].join(",");
        let mut sql = format!(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                    r.updated_at, substr(b.content, 1, 640),
                    CASE
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
             FROM records r
             JOIN bodies b ON b.id = r.body_id
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE r.id IN ({placeholders})"
        );
        let mut arguments: Vec<SqlValue> = capped
            .iter()
            .map(|id| SqlValue::Text((*id).clone()))
            .collect();
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
        let mut stmt = self.connection.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(arguments), hit_from_row)?;
        for hit in rows {
            let h = hit?;
            out.insert(h.id.clone(), h);
        }
        Ok(out)
    }

    pub fn expand_graph_neighbors(
        &self,
        seed_hits: &[SearchHit],
        opts: &SearchOptions,
        max_neighbors: usize,
    ) -> Result<Vec<SearchHit>> {
        if seed_hits.is_empty() || max_neighbors == 0 {
            return Ok(Vec::new());
        }
        let seed_ids: HashSet<&str> = seed_hits.iter().map(|h| h.id.as_str()).collect();
        let top_seeds: Vec<&SearchHit> = seed_hits.iter().take(3).collect();
        let mut best_by_id: std::collections::HashMap<String, SearchHit> =
            std::collections::HashMap::new();

        for seed in top_seeds {
            let mut sql = String::from(
                "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                        r.updated_at, substr(b.content, 1, 640),
                        l.weight
                            * CASE
                                WHEN r.kind = 'correction' THEN 2.2
                                WHEN r.source_type IN ('markdown', 'iron') THEN 2.0
                                ELSE 1.0
                              END
                            * CASE WHEN COALESCE(s.status, 'active') = 'superseded' THEN 0.15 ELSE 1.0 END
                            * (1.0 / (1.0 + 0.4 * COALESCE(s.contradict_count, 0))) AS edge_score,
                        l.relation,
                        l.evidence,
                        CASE WHEN s.status = 'superseded' THEN s.status ELSE NULL END AS status,
                        s.superseded_by
                 FROM memory_links l
                 JOIN records r ON r.id = CASE WHEN l.from_id = ?1 THEN l.to_id ELSE l.from_id END
                 JOIN bodies b ON b.id = r.body_id
                 LEFT JOIN record_stats s ON s.record_id = r.id
                 WHERE (l.from_id = ?1 OR l.to_id = ?1)
                   AND l.relation IN ('references', 'co_used', 'shares_anchor', 'supersedes')
                   AND COALESCE(s.status, 'active') != 'superseded'",
            );
            let mut arguments = vec![SqlValue::Text(seed.id.clone())];
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
            sql.push_str(" ORDER BY edge_score DESC, r.updated_at DESC LIMIT 6");
            let mut stmt = self.connection.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(arguments), hit_from_row)?;
            for row in rows {
                let mut h = row?;
                if seed_ids.contains(h.id.as_str()) {
                    continue;
                }
                // Propagated score bounded below parent hit so exact matches stay ahead
                let edge_boost = (h.score / 4.0).clamp(0.2, 1.0);
                h.score = seed.score * 0.52 * edge_boost;
                h.relation = Some(format!(
                    "graph_neighbor:{}",
                    h.relation.as_deref().unwrap_or("linked")
                ));
                match best_by_id.get(&h.id) {
                    Some(prev) if prev.score >= h.score => {}
                    _ => {
                        best_by_id.insert(h.id.clone(), h);
                    }
                }
            }
        }

        let mut neighbors: Vec<SearchHit> = best_by_id.into_values().collect();
        neighbors.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        neighbors.truncate(max_neighbors);
        Ok(neighbors)
    }

    pub fn link_co_used_against(
        &mut self,
        new_id: &str,
        prior_ids: &[String],
    ) -> Result<usize> {
        ensure!(self.writable, "memory index was opened read-only");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM records WHERE id = ?1", [new_id], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            return Ok(0);
        }
        let mut links = 0usize;
        let mut seen = HashSet::new();
        for peer in prior_ids.iter().take(16) {
            if peer == new_id || !seen.insert(peer.as_str()) {
                continue;
            }
            let peer_exists: Option<i64> = tx
                .query_row("SELECT 1 FROM records WHERE id = ?1", [peer], |r| r.get(0))
                .optional()?;
            if peer_exists.is_none() {
                continue;
            }
            for (from, to) in [(new_id, peer.as_str()), (peer.as_str(), new_id)] {
                tx.execute(
                    "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
                     VALUES(?1, ?2, 'co_used', 'feedback', 1.0, '[\"co_retrieved\"]')
                     ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
                       weight = MIN(5.0, weight + 0.5)",
                    params![from, to],
                )?;
                links += 1;
            }
        }
        tx.commit()?;
        Ok(links)
    }

    pub fn record_stats_map(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, (i64, i64)>> {
        let mut out = std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        for chunk in ids.chunks(200) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT record_id, confirm_count, last_used_at FROM record_stats WHERE record_id IN ({placeholders})"
            );
            let args: Vec<SqlValue> = chunk
                .iter()
                .map(|id| SqlValue::Text(id.clone()))
                .collect();
            let mut stmt = self.connection.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(args), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            })?;
            for row in rows {
                let (id, conf, last_used) = row?;
                out.insert(id, (conf, last_used));
            }
        }
        Ok(out)
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
        for hit in &mut hits {
            if matches!(hit.source_type.as_str(), "markdown" | "iron")
                && let Ok(Some(rec)) = self.get(&hit.id)
                && let Some((_, sec_snippet)) = extract_best_section(&rec.content, query)
            {
                hit.snippet = sec_snippet;
            }
        }
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

    pub fn facets(&self) -> Result<Value> {
        let tx = self.connection.unchecked_transaction()?;
        let mut projects_stmt = tx.prepare(
            "SELECT project,
                    COUNT(*) AS total,
                    SUM(CASE WHEN source_type IN ('markdown', 'iron') THEN 1 ELSE 0 END) AS curated
             FROM records
             GROUP BY project
             ORDER BY total DESC, project ASC",
        )?;
        let projects: Vec<Value> = projects_stmt
            .query_map([], |row| {
                let project: String = row.get(0)?;
                let canonical = canonical_project_root(&project);
                Ok(json!({
                    "project": project,
                    "canonical_root": canonical,
                    "total": row.get::<_, i64>(1)?,
                    "curated": row.get::<_, i64>(2)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(projects_stmt);

        let by_kind = grouped_counts(
            &tx,
            "SELECT kind, COUNT(*) FROM records GROUP BY kind ORDER BY COUNT(*) DESC, kind ASC",
        )?;
        let by_source_type = grouped_counts(
            &tx,
            "SELECT source_type, COUNT(*) FROM records GROUP BY source_type ORDER BY source_type",
        )?;
        let by_link_origin = grouped_counts(
            &tx,
            "SELECT origin, COUNT(*) FROM memory_links GROUP BY origin ORDER BY origin",
        )?;
        tx.commit()?;
        Ok(json!({
            "projects": projects,
            "by_kind": by_kind,
            "by_source_type": by_source_type,
            "by_link_origin": by_link_origin,
        }))
    }

    pub fn browse(&self, opts: &BrowseOptions) -> Result<Value> {
        let limit = if opts.limit == 0 {
            30
        } else {
            opts.limit.min(100)
        };
        let offset_i64 = i64::try_from(opts.offset).context("invalid offset: exceeds range")?;
        let tx = self.connection.unchecked_transaction()?;

        let mut where_clauses: Vec<String> = Vec::new();
        let mut args: Vec<SqlValue> = Vec::new();

        if let Some(project) = opts.project.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            where_clauses.push("r.project = ?".to_owned());
            args.push(SqlValue::Text(project.to_owned()));
        }

        if let Some(source) = opts.source.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            match source {
                "all" => {}
                "curated" => where_clauses.push("r.source_type IN ('markdown', 'iron')".to_owned()),
                "markdown" | "iron" | "cavemem" => {
                    where_clauses.push("r.source_type = ?".to_owned());
                    args.push(SqlValue::Text(source.to_owned()));
                }
                "history" => where_clauses.push("r.source_type = 'cavemem'".to_owned()),
                "native" => where_clauses.push("r.source_type = 'iron'".to_owned()),
                _ => bail!("invalid source filter: {source}"),
            }
        }

        if let Some(kind) = opts.kind.as_deref().map(str::trim).filter(|s| !s.is_empty())
            && kind != "all"
        {
            where_clauses.push("r.kind = ?".to_owned());
            args.push(SqlValue::Text(kind.to_owned()));
        }

        if let Some(day) = opts.day.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            ensure!(is_valid_iso_day(day), "invalid day filter: expected YYYY-MM-DD");
            where_clauses.push(
                "date(CASE WHEN r.updated_at > 1000000000000 THEN r.updated_at / 1000 ELSE r.updated_at END, 'unixepoch', 'localtime') = ?"
                    .to_owned(),
            );
            args.push(SqlValue::Text(day.to_owned()));
        }

        if let Some(status) = opts.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            match status {
                "all" => {}
                "active" => where_clauses.push("COALESCE(s.status, 'active') = 'active'".to_owned()),
                "superseded" => where_clauses.push("s.status = 'superseded'".to_owned()),
                "unverified" => where_clauses.push(
                    "COALESCE(s.confirm_count, 0) = 0 AND COALESCE(s.status, 'active') = 'active'"
                        .to_owned(),
                ),
                "verified" => where_clauses.push("COALESCE(s.confirm_count, 0) > 0".to_owned()),
                "reinforced" => where_clauses
                    .push("(COALESCE(s.use_count, 0) > 0 OR COALESCE(s.confirm_count, 0) > 0)".to_owned()),
                "contested" => where_clauses.push("COALESCE(s.contradict_count, 0) > 0".to_owned()),
                _ => bail!("invalid status filter: {status}"),
            }
        }

        if let Some(query) = opts.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            ensure!(query.len() <= 2048, "query exceeds 2048 bytes");
            let exact_id_exists = query.len() <= 128
                && query.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && tx
                    .query_row("SELECT 1 FROM records WHERE id = ?", [query], |_| Ok(()))
                    .optional()?
                    .is_some();
            if exact_id_exists {
                where_clauses.push("r.id = ?".to_owned());
                args.push(SqlValue::Text(query.to_owned()));
            } else if let Some(expr) = search_expression(query) {
                where_clauses.push(
                    "r.rowid IN (SELECT rowid FROM record_fts WHERE record_fts MATCH ?)"
                        .to_owned(),
                );
                args.push(SqlValue::Text(expr));
            } else {
                let escaped = escape_like(query);
                where_clauses.push(
                    r"(r.title LIKE ? ESCAPE '\' OR r.source_path LIKE ? ESCAPE '\')".to_owned(),
                );
                let pattern = format!("%{escaped}%");
                args.push(SqlValue::Text(pattern.clone()));
                args.push(SqlValue::Text(pattern));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_clauses.join(" AND "))
        };

        let sort_key = opts.sort.as_deref().unwrap_or("updated");
        let (inner_order_sql, outer_order_sql) = match sort_key {
            "updated" => (
                "r.updated_at DESC, r.id ASC",
                "page.updated_at DESC, page.id ASC",
            ),
            "use_count" => (
                "COALESCE(s.use_count, 0) DESC, COALESCE(s.confirm_count, 0) DESC, r.updated_at DESC, r.id ASC",
                "page.use_count DESC, page.confirm_count DESC, page.updated_at DESC, page.id ASC",
            ),
            "confirm_count" => (
                "COALESCE(s.confirm_count, 0) DESC, COALESCE(s.use_count, 0) DESC, r.updated_at DESC, r.id ASC",
                "page.confirm_count DESC, page.use_count DESC, page.updated_at DESC, page.id ASC",
            ),
            "contradict_count" => (
                "COALESCE(s.contradict_count, 0) DESC, r.updated_at DESC, r.id ASC",
                "page.contradict_count DESC, page.updated_at DESC, page.id ASC",
            ),
            "links" => (
                "link_count DESC, r.updated_at DESC, r.id ASC",
                "page.link_count DESC, page.updated_at DESC, page.id ASC",
            ),
            "title" => (
                "r.title COLLATE NOCASE ASC, r.id ASC",
                "page.title COLLATE NOCASE ASC, page.id ASC",
            ),
            _ => bail!("invalid sort key: {sort_key}"),
        };

        let count_sql = format!(
            "SELECT COUNT(*)
             FROM records r
             LEFT JOIN record_stats s ON s.record_id = r.id
             {where_sql}"
        );
        let total: i64 = tx.query_row(&count_sql, params_from_iter(args.iter().cloned()), |row| {
            row.get(0)
        })?;

        let list_sql = if sort_key == "links" {
            format!(
                "SELECT page.id, page.title, page.project, page.kind, page.source_type, page.source_path,
                        page.updated_at, substr(b.content, 1, 320), length(CAST(b.content AS BLOB)),
                        page.use_count, page.confirm_count, page.contradict_count, page.last_used_at,
                        page.status, page.superseded_by, page.link_count
                 FROM (
                    SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                           r.updated_at, r.body_id,
                           COALESCE(s.use_count, 0) AS use_count,
                           COALESCE(s.confirm_count, 0) AS confirm_count,
                           COALESCE(s.contradict_count, 0) AS contradict_count,
                           COALESCE(s.last_used_at, 0) AS last_used_at,
                           COALESCE(s.status, 'active') AS status,
                           s.superseded_by,
                           (SELECT COUNT(*) FROM memory_links l WHERE l.from_id = r.id) AS link_count
                    FROM records r
                    LEFT JOIN record_stats s ON s.record_id = r.id
                    {where_sql}
                    ORDER BY {inner_order_sql}
                    LIMIT ? OFFSET ?
                 ) page
                 JOIN bodies b ON b.id = page.body_id
                 ORDER BY {outer_order_sql}"
            )
        } else {
            format!(
                "SELECT page.id, page.title, page.project, page.kind, page.source_type, page.source_path,
                        page.updated_at, substr(b.content, 1, 320), length(CAST(b.content AS BLOB)),
                        page.use_count, page.confirm_count, page.contradict_count, page.last_used_at,
                        page.status, page.superseded_by,
                        (SELECT COUNT(*) FROM memory_links l WHERE l.from_id = page.id) AS link_count
                 FROM (
                    SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path,
                           r.updated_at, r.body_id,
                           COALESCE(s.use_count, 0) AS use_count,
                           COALESCE(s.confirm_count, 0) AS confirm_count,
                           COALESCE(s.contradict_count, 0) AS contradict_count,
                           COALESCE(s.last_used_at, 0) AS last_used_at,
                           COALESCE(s.status, 'active') AS status,
                           s.superseded_by
                    FROM records r
                    LEFT JOIN record_stats s ON s.record_id = r.id
                    {where_sql}
                    ORDER BY {inner_order_sql}
                    LIMIT ? OFFSET ?
                 ) page
                 JOIN bodies b ON b.id = page.body_id
                 ORDER BY {outer_order_sql}"
            )
        };

        let mut list_args = args;
        list_args.push(SqlValue::Integer(limit as i64));
        list_args.push(SqlValue::Integer(offset_i64));

        let mut stmt = tx.prepare(&list_sql)?;
        let items: Vec<Value> = stmt
            .query_map(params_from_iter(list_args), |row| {
                let project: String = row.get(2)?;
                let canonical = canonical_project_root(&project);
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": project,
                    "canonical_root": canonical,
                    "kind": row.get::<_, String>(3)?,
                    "source_type": row.get::<_, String>(4)?,
                    "source_path": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, i64>(6)?,
                    "snippet": bounded_snippet(row.get::<_, String>(7)?),
                    "body_bytes": row.get::<_, i64>(8)?,
                    "use_count": row.get::<_, i64>(9)?,
                    "confirm_count": row.get::<_, i64>(10)?,
                    "contradict_count": row.get::<_, i64>(11)?,
                    "last_used_at": row.get::<_, i64>(12)?,
                    "status": row.get::<_, String>(13)?,
                    "superseded_by": row.get::<_, Option<String>>(14)?,
                    "link_count": row.get::<_, i64>(15)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        tx.commit()?;

        Ok(json!({
            "total": total,
            "offset": opts.offset,
            "limit": limit,
            "items": items,
        }))
    }

    pub fn inspect(&self, id: &str) -> Result<Option<Value>> {
        let tx = self.connection.unchecked_transaction()?;
        let sql = format!(
            "SELECT {RECORD_COLUMNS}, r.body_id, length(CAST(b.content AS BLOB))
             FROM records r JOIN bodies b ON b.id = r.body_id WHERE r.id = ?"
        );
        let found: Option<(MemoryRecord, i64, i64)> = tx
            .query_row(&sql, [id], |row| {
                let record = record_from_row(row)?;
                let body_id: i64 = row.get(11)?;
                let body_bytes: i64 = row.get(12)?;
                Ok((record, body_id, body_bytes))
            })
            .optional()?;
        let Some((record, body_id, body_bytes)) = found else {
            tx.commit()?;
            return Ok(None);
        };

        let stats = query_stats_conn(&tx, id)?.unwrap_or_else(|| {
            json!({
                "use_count": 0,
                "confirm_count": 0,
                "contradict_count": 0,
                "last_used_at": 0,
                "status": "active",
                "superseded_by": Value::Null,
            })
        });

        let superseded_by_record = match stats.get("superseded_by").and_then(Value::as_str) {
            Some(rep_id) => tx
                .query_row(
                    "SELECT r.id, r.title, r.project, r.kind, r.source_type, COALESCE(s.status, 'active')
                     FROM records r LEFT JOIN record_stats s ON s.record_id = r.id
                     WHERE r.id = ?",
                    [rep_id],
                    |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "project": row.get::<_, String>(2)?,
                            "kind": row.get::<_, String>(3)?,
                            "source_type": row.get::<_, String>(4)?,
                            "status": row.get::<_, String>(5)?,
                        }))
                    },
                )
                .optional()?,
            None => None,
        };

        let mut supersedes_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.updated_at
             FROM record_stats s
             JOIN records r ON r.id = s.record_id
             WHERE s.superseded_by = ?
             ORDER BY r.updated_at DESC, r.id ASC
             LIMIT 25",
        )?;
        let supersedes: Vec<Value> = supersedes_stmt
            .query_map([id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": row.get::<_, String>(2)?,
                    "kind": row.get::<_, String>(3)?,
                    "source_type": row.get::<_, String>(4)?,
                    "updated_at": row.get::<_, i64>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(supersedes_stmt);

        let mut dup_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.source_path, r.updated_at
             FROM records r
             WHERE r.body_id = ?1 AND r.id != ?2
             ORDER BY r.updated_at DESC, r.id ASC
             LIMIT 10",
        )?;
        let duplicate_bodies: Vec<Value> = dup_stmt
            .query_map(params![body_id, id], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": row.get::<_, String>(2)?,
                    "kind": row.get::<_, String>(3)?,
                    "source_type": row.get::<_, String>(4)?,
                    "source_path": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, i64>(6)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(dup_stmt);

        let outgoing_total: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memory_links WHERE from_id = ?",
            [id],
            |row| row.get(0),
        )?;
        let incoming_total: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memory_links WHERE to_id = ?",
            [id],
            |row| row.get(0),
        )?;

        let mut out_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, COALESCE(s.status, 'active'),
                    l.relation, l.origin, l.weight, l.evidence
             FROM memory_links l
             JOIN records r ON r.id = l.to_id
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE l.from_id = ?
             ORDER BY l.weight DESC, l.origin DESC, l.relation ASC, r.updated_at DESC
             LIMIT 60",
        )?;
        let outgoing_links: Vec<Value> = out_stmt
            .query_map([id], link_peer_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(out_stmt);

        let mut in_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, COALESCE(s.status, 'active'),
                    l.relation, l.origin, l.weight, l.evidence
             FROM memory_links l
             JOIN records r ON r.id = l.from_id
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE l.to_id = ?
             ORDER BY l.weight DESC, l.origin DESC, l.relation ASC, r.updated_at DESC
             LIMIT 60",
        )?;
        let incoming_links: Vec<Value> = in_stmt
            .query_map([id], link_peer_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(in_stmt);

        tx.commit()?;

        let canonical = canonical_project_root(&record.project);
        let mut val = serde_json::to_value(record)?;
        val["canonical_root"] = json!(canonical);
        val["body_bytes"] = json!(body_bytes);
        val["stats"] = stats;
        val["superseded_by_record"] = match superseded_by_record {
            Some(v) => v,
            None => Value::Null,
        };
        val["supersedes"] = json!(supersedes);
        val["duplicate_bodies"] = json!(duplicate_bodies);
        val["outgoing_link_count"] = json!(outgoing_total);
        val["incoming_link_count"] = json!(incoming_total);
        val["outgoing_links"] = json!(outgoing_links);
        val["incoming_links"] = json!(incoming_links);
        Ok(Some(val))
    }

    pub fn audit_health(&self) -> Result<Value> {
        let tx = self.connection.unchecked_transaction()?;
        let mut summary = tx.query_row(
            "SELECT
                (SELECT COUNT(*) FROM records),
                (SELECT COUNT(*) FROM bodies),
                (SELECT COALESCE(SUM(length(CAST(b.content AS BLOB))), 0)
                    FROM records r JOIN bodies b ON b.id = r.body_id),
                (SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM bodies),
                (SELECT COUNT(*) FROM records WHERE source_type IN ('markdown', 'iron')),
                (SELECT COUNT(*) FROM records r
                    JOIN record_stats s ON s.record_id = r.id
                    WHERE r.source_type IN ('markdown', 'iron') AND s.confirm_count > 0),
                (SELECT COUNT(*) FROM records r
                    LEFT JOIN record_stats s ON s.record_id = r.id
                    WHERE r.source_type IN ('markdown', 'iron')
                      AND COALESCE(s.confirm_count, 0) = 0
                      AND COALESCE(s.status, 'active') = 'active'),
                (SELECT COUNT(*) FROM records r
                    JOIN record_stats s ON s.record_id = r.id
                    WHERE r.source_type IN ('markdown', 'iron') AND s.status = 'superseded'),
                (SELECT COUNT(*) FROM record_stats WHERE confirm_count > 0),
                (SELECT COUNT(*) FROM record_stats WHERE use_count > 0 OR confirm_count > 0),
                (SELECT COUNT(*) FROM record_stats WHERE contradict_count > 0),
                (SELECT COUNT(*) FROM record_stats WHERE status = 'superseded'),
                (SELECT COUNT(*) FROM memory_links)",
            [],
            |row| {
                let records = row.get::<_, i64>(0)?;
                let unique_bodies = row.get::<_, i64>(1)?;
                let content_bytes = row.get::<_, i64>(2)?;
                let unique_content_bytes = row.get::<_, i64>(3)?;
                Ok(json!({
                    "schema_version": SCHEMA_VERSION,
                    "records": records,
                    "unique_bodies": unique_bodies,
                    "duplicate_body_records": (records - unique_bodies).max(0),
                    "content_bytes": content_bytes,
                    "unique_content_bytes": unique_content_bytes,
                    "dedup_saved_bytes": (content_bytes - unique_content_bytes).max(0),
                    "curated_total": row.get::<_, i64>(4)?,
                    "curated_verified": row.get::<_, i64>(5)?,
                    "curated_unverified": row.get::<_, i64>(6)?,
                    "curated_superseded": row.get::<_, i64>(7)?,
                    "all_verified": row.get::<_, i64>(8)?,
                    "reinforced": row.get::<_, i64>(9)?,
                    "contested": row.get::<_, i64>(10)?,
                    "superseded": row.get::<_, i64>(11)?,
                    "links_total": row.get::<_, i64>(12)?,
                }))
            },
        )?;
        summary["by_source_type"] = grouped_counts(
            &tx,
            "SELECT source_type, COUNT(*) FROM records GROUP BY source_type ORDER BY source_type",
        )?;
        summary["by_kind"] = grouped_counts(
            &tx,
            "SELECT kind, COUNT(*) FROM records GROUP BY kind ORDER BY COUNT(*) DESC, kind ASC",
        )?;
        summary["by_link_origin"] = grouped_counts(
            &tx,
            "SELECT origin, COUNT(*) FROM memory_links GROUP BY origin ORDER BY origin",
        )?;

        let mut proj_stmt = tx.prepare(
            "SELECT project,
                    COUNT(*) AS total,
                    SUM(CASE WHEN source_type IN ('markdown', 'iron') THEN 1 ELSE 0 END) AS curated
             FROM records
             GROUP BY project",
        )?;
        let raw_projects: Vec<(String, i64, i64)> = proj_stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(proj_stmt);

        let total_project_names = raw_projects.len();
        let mut grouped: BTreeMap<String, Vec<(String, i64, i64)>> = BTreeMap::new();
        for (project, total, curated) in raw_projects {
            let root = canonical_project_root(&project);
            grouped.entry(root).or_default().push((project, total, curated));
        }
        let canonical_root_count = grouped.len();
        let mut fragmented: Vec<(i64, Value)> = Vec::new();
        for (root, mut variants) in grouped {
            if variants.len() <= 1 {
                continue;
            }
            variants.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let total_records: i64 = variants.iter().map(|v| v.1).sum();
            let curated_records: i64 = variants.iter().map(|v| v.2).sum();
            let variant_json: Vec<Value> = variants
                .into_iter()
                .map(|(project, records, curated)| {
                    json!({
                        "project": project,
                        "records": records,
                        "curated": curated,
                    })
                })
                .collect();
            fragmented.push((
                total_records,
                json!({
                    "canonical_root": root,
                    "total_records": total_records,
                    "curated_records": curated_records,
                    "variant_count": variant_json.len(),
                    "variants": variant_json,
                }),
            ));
        }
        let fragmented_roots = fragmented.len();
        fragmented.sort_by_key(|b| std::cmp::Reverse(b.0));
        let fragmented_groups: Vec<Value> = fragmented.into_iter().take(30).map(|(_, v)| v).collect();

        let mut unverified_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.updated_at,
                    COALESCE(s.use_count, 0) AS use_count,
                    COALESCE(s.contradict_count, 0) AS contradict_count,
                    (SELECT COUNT(*) FROM memory_links l WHERE l.from_id = r.id) AS link_count
             FROM records r
             LEFT JOIN record_stats s ON s.record_id = r.id
             WHERE r.source_type IN ('markdown', 'iron')
               AND COALESCE(s.confirm_count, 0) = 0
               AND COALESCE(s.status, 'active') = 'active'
             ORDER BY use_count DESC, link_count DESC, r.updated_at DESC, r.id ASC
             LIMIT 25",
        )?;
        let unverified_high_leverage: Vec<Value> = unverified_stmt
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": row.get::<_, String>(2)?,
                    "kind": row.get::<_, String>(3)?,
                    "source_type": row.get::<_, String>(4)?,
                    "updated_at": row.get::<_, i64>(5)?,
                    "use_count": row.get::<_, i64>(6)?,
                    "contradict_count": row.get::<_, i64>(7)?,
                    "link_count": row.get::<_, i64>(8)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(unverified_stmt);

        let mut contested_stmt = tx.prepare(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.updated_at,
                    s.use_count, s.confirm_count, s.contradict_count, s.status, s.superseded_by
             FROM record_stats s
             JOIN records r ON r.id = s.record_id
             WHERE s.contradict_count > 0 OR s.status = 'superseded'
             ORDER BY s.contradict_count DESC, s.last_used_at DESC, r.id ASC
             LIMIT 50",
        )?;
        let contested_and_superseded: Vec<Value> = contested_stmt
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": row.get::<_, String>(2)?,
                    "kind": row.get::<_, String>(3)?,
                    "source_type": row.get::<_, String>(4)?,
                    "updated_at": row.get::<_, i64>(5)?,
                    "use_count": row.get::<_, i64>(6)?,
                    "confirm_count": row.get::<_, i64>(7)?,
                    "contradict_count": row.get::<_, i64>(8)?,
                    "status": row.get::<_, String>(9)?,
                    "superseded_by": row.get::<_, Option<String>>(10)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(contested_stmt);

        // Group duplicate body_ids via index first before joining bodies
        let mut dup_bodies_stmt = tx.prepare(
            "SELECT d.body_id, d.cnt, length(CAST(b.content AS BLOB)) AS bytes,
                    substr(b.content, 1, 200) AS preview
             FROM (
                SELECT body_id, COUNT(*) AS cnt
                FROM records
                GROUP BY body_id
                HAVING cnt > 1
                ORDER BY cnt DESC
                LIMIT 20
             ) d
             JOIN bodies b ON b.id = d.body_id
             ORDER BY d.cnt DESC, bytes DESC",
        )?;
        let raw_dups: Vec<(i64, i64, i64, String)> = dup_bodies_stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(dup_bodies_stmt);

        let mut sample_stmt = tx.prepare(
            "SELECT id, title, project, source_type, kind
             FROM records
             WHERE body_id = ?
             ORDER BY updated_at DESC, id ASC
             LIMIT 5",
        )?;
        let mut duplicate_bodies = Vec::with_capacity(raw_dups.len());
        for (body_id, count, bytes, preview) in raw_dups {
            let samples: Vec<Value> = sample_stmt
                .query_map([body_id], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "project": row.get::<_, String>(2)?,
                        "source_type": row.get::<_, String>(3)?,
                        "kind": row.get::<_, String>(4)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            duplicate_bodies.push(json!({
                "count": count,
                "bytes": bytes,
                "preview": bounded_snippet(preview),
                "records": samples,
            }));
        }
        drop(sample_stmt);
        tx.commit()?;

        Ok(json!({
            "summary": summary,
            "project_fragmentation": {
                "total_project_names": total_project_names,
                "canonical_roots": canonical_root_count,
                "fragmented_roots": fragmented_roots,
                "groups": fragmented_groups,
            },
            "unverified_high_leverage": unverified_high_leverage,
            "contested_and_superseded": contested_and_superseded,
            "duplicate_bodies": duplicate_bodies,
        }))
    }

    pub fn knowledge_graph(
        &self,
        source: Option<&str>,
        project: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        let cap = if limit == 0 { 180 } else { limit.clamp(20, 400) };
        let src = source.unwrap_or("curated");
        let tx = self.connection.unchecked_transaction()?;

        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<SqlValue> = Vec::new();
        match src {
            "curated" => clauses.push("r.source_type IN ('markdown', 'iron')".to_owned()),
            "all" => clauses.push("(r.source_type IN ('markdown', 'iron') OR r.kind = 'summary')".to_owned()),
            "markdown" | "iron" | "cavemem" => {
                clauses.push("r.source_type = ?".to_owned());
                args.push(SqlValue::Text(src.to_owned()));
            }
            _ => bail!("invalid graph source filter: {src}"),
        }
        if let Some(proj) = project.map(str::trim).filter(|s| !s.is_empty()) {
            clauses.push("r.project = ?".to_owned());
            args.push(SqlValue::Text(proj.to_owned()));
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };

        let total_matching: i64 = tx.query_row(
            &format!("SELECT COUNT(*) FROM records r {where_sql}"),
            params_from_iter(args.iter().cloned()),
            |row| row.get(0),
        )?;

        let node_sql = format!(
            "SELECT r.id, r.title, r.project, r.kind, r.source_type, r.updated_at,
                    date(CASE WHEN r.updated_at > 1000000000000 THEN r.updated_at / 1000 ELSE r.updated_at END, 'unixepoch', 'localtime') AS updated_day,
                    COALESCE(s.use_count, 0), COALESCE(s.confirm_count, 0),
                    COALESCE(s.contradict_count, 0), COALESCE(s.status, 'active'),
                    s.superseded_by,
                    (SELECT COUNT(*) FROM memory_links l WHERE l.from_id = r.id) AS out_deg
             FROM records r
             LEFT JOIN record_stats s ON s.record_id = r.id
             {where_sql}
             ORDER BY
                CASE WHEN COALESCE(s.contradict_count, 0) > 0 THEN 0
                     WHEN COALESCE(s.confirm_count, 0) > 0 OR COALESCE(s.use_count, 0) > 0 THEN 1
                     WHEN r.source_type = 'iron' THEN 2
                     ELSE 3 END ASC,
                out_deg DESC,
                r.updated_at DESC,
                r.id ASC
             LIMIT ?"
        );
        let mut node_args = args;
        node_args.push(SqlValue::Integer(cap as i64));

        struct RawNode {
            id: String,
            title: String,
            project: String,
            canonical_root: String,
            kind: String,
            source_type: String,
            updated_at: i64,
            updated_day: String,
            use_count: i64,
            confirm_count: i64,
            contradict_count: i64,
            status: String,
            superseded_by: Option<String>,
            out_deg: i64,
        }

        let mut stmt = tx.prepare(&node_sql)?;
        let raw_nodes: Vec<RawNode> = stmt
            .query_map(params_from_iter(node_args), |row| {
                let project: String = row.get(2)?;
                let canonical_root = canonical_project_root(&project);
                Ok(RawNode {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    project,
                    canonical_root,
                    kind: row.get(3)?,
                    source_type: row.get(4)?,
                    updated_at: row.get(5)?,
                    updated_day: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    use_count: row.get(7)?,
                    confirm_count: row.get(8)?,
                    contradict_count: row.get(9)?,
                    status: row.get(10)?,
                    superseded_by: row.get(11)?,
                    out_deg: row.get(12)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let id_to_idx: BTreeMap<String, usize> = raw_nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();

        // Collect bounded high-signal edges between included nodes
        struct RawEdge {
            from: String,
            to: String,
            relation: String,
            origin: String,
            weight: f64,
            evidence: Vec<String>,
        }
        let mut edges: Vec<RawEdge> = Vec::new();
        let mut seen_undirected: HashSet<(usize, usize, String)> = HashSet::new();
        let mut edge_stmt = tx.prepare(
            "SELECT to_id, relation, origin, weight, evidence
             FROM memory_links
             WHERE from_id = ?
             ORDER BY CASE origin WHEN 'feedback' THEN 0 WHEN 'explicit' THEN 1 ELSE 2 END ASC,
                      weight DESC
             LIMIT 24",
        )?;
        for (from_idx, node) in raw_nodes.iter().enumerate() {
            let rows = edge_stmt.query_map([&node.id], |row| {
                let ev_raw: String = row.get(4)?;
                let evidence: Vec<String> = serde_json::from_str(&ev_raw).unwrap_or_default();
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    evidence,
                ))
            })?;
            for row in rows {
                let (to_id, relation, origin, weight, evidence) = row?;
                let Some(&to_idx) = id_to_idx.get(&to_id) else {
                    continue;
                };
                if from_idx == to_idx {
                    continue;
                }
                let key = if origin == "feedback" {
                    (from_idx, to_idx, relation.clone())
                } else {
                    let (a, b) = if from_idx < to_idx {
                        (from_idx, to_idx)
                    } else {
                        (to_idx, from_idx)
                    };
                    (a, b, origin.clone())
                };
                if seen_undirected.insert(key) {
                    edges.push(RawEdge {
                        from: node.id.clone(),
                        to: to_id,
                        relation,
                        origin,
                        weight,
                        evidence,
                    });
                }
            }
        }
        drop(edge_stmt);

        edges.sort_by(|a, b| {
            let rank = |o: &str| match o {
                "feedback" => 0,
                "explicit" => 1,
                _ => 2,
            };
            rank(&a.origin)
                .cmp(&rank(&b.origin))
                .then_with(|| b.weight.total_cmp(&a.weight))
        });
        edges.truncate(750);

        // Union-find community clustering over included edges for "Link Clusters" zone mode
        let mut parent: Vec<usize> = (0..raw_nodes.len()).collect();
        fn find_root(parent: &mut [usize], mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        }
        let mut node_degree: Vec<usize> = vec![0; raw_nodes.len()];
        let mut comp_anchors: BTreeMap<usize, BTreeMap<String, usize>> = BTreeMap::new();
        for e in &edges {
            if let (Some(&ia), Some(&ib)) = (id_to_idx.get(&e.from), id_to_idx.get(&e.to)) {
                node_degree[ia] += 1;
                node_degree[ib] += 1;
                let ra = find_root(&mut parent, ia);
                let rb = find_root(&mut parent, ib);
                if ra != rb {
                    parent[ra] = rb;
                }
            }
        }
        for e in &edges {
            if let Some(&ia) = id_to_idx.get(&e.from) {
                let root = find_root(&mut parent, ia);
                let map = comp_anchors.entry(root).or_default();
                for ev in &e.evidence {
                    if ev != "supersedes" && ev != "superseded_by" {
                        *map.entry(ev.clone()).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut comp_counts: BTreeMap<usize, usize> = BTreeMap::new();
        let mut comp_roots: Vec<usize> = Vec::with_capacity(raw_nodes.len());
        for i in 0..raw_nodes.len() {
            let r = find_root(&mut parent, i);
            comp_roots.push(r);
            *comp_counts.entry(r).or_insert(0) += 1;
        }

        let mut comp_label: BTreeMap<usize, String> = BTreeMap::new();
        for (&root, &count) in &comp_counts {
            if count <= 1 {
                comp_label.insert(root, format!("Solo · {}", raw_nodes[root].canonical_root));
                continue;
            }
            let top_anchor = comp_anchors
                .get(&root)
                .and_then(|m| m.iter().max_by_key(|(_, c)| *c).map(|(k, _)| k.clone()));
            let label = match top_anchor {
                Some(a) => a,
                None => raw_nodes[root].canonical_root.clone(),
            };
            comp_label.insert(root, label);
        }

        let nodes_json: Vec<Value> = raw_nodes
            .into_iter()
            .enumerate()
            .map(|(i, n)| {
                let cluster = comp_label
                    .get(&comp_roots[i])
                    .cloned()
                    .unwrap_or_else(|| n.canonical_root.clone());
                json!({
                    "id": n.id,
                    "title": n.title,
                    "project": n.project,
                    "canonical_root": n.canonical_root,
                    "cluster": cluster,
                    "kind": n.kind,
                    "source_type": n.source_type,
                    "updated_at": n.updated_at,
                    "updated_day": n.updated_day,
                    "use_count": n.use_count,
                    "confirm_count": n.confirm_count,
                    "contradict_count": n.contradict_count,
                    "status": n.status,
                    "superseded_by": n.superseded_by,
                    "degree": node_degree[i],
                    "total_out_links": n.out_deg,
                })
            })
            .collect();

        let edges_json: Vec<Value> = edges
            .into_iter()
            .map(|e| {
                json!({
                    "from": e.from,
                    "to": e.to,
                    "relation": e.relation,
                    "origin": e.origin,
                    "weight": e.weight,
                    "evidence": e.evidence,
                })
            })
            .collect();

        tx.commit()?;
        Ok(json!({
            "total_matching": total_matching,
            "capped": (nodes_json.len() as i64) < total_matching,
            "nodes": nodes_json,
            "edges": edges_json,
        }))
    }

    pub fn evolution(&self, days: usize) -> Result<Value> {
        let span = days.clamp(7, 90) as i64;
        let tx = self.connection.unchecked_transaction()?;

        // Generate contiguous local calendar days up to today via recursive CTE
        let mut day_stmt = tx.prepare(
            "WITH RECURSIVE dates(d) AS (
                SELECT date('now', 'localtime', printf('-%d days', ?1 - 1))
                UNION ALL
                SELECT date(d, '+1 day') FROM dates WHERE d < date('now', 'localtime')
             ),
             rec_daily AS (
                SELECT date(CASE WHEN updated_at > 1000000000000 THEN updated_at / 1000 ELSE updated_at END, 'unixepoch', 'localtime') AS day,
                       SUM(CASE WHEN source_type = 'markdown' THEN 1 ELSE 0 END) AS md,
                       SUM(CASE WHEN source_type = 'iron' THEN 1 ELSE 0 END) AS iron,
                       SUM(CASE WHEN source_type = 'cavemem' THEN 1 ELSE 0 END) AS cavemem,
                       SUM(CASE WHEN kind = 'correction' THEN 1 ELSE 0 END) AS corrections
                FROM records
                GROUP BY day
             ),
             stat_daily AS (
                SELECT date(CASE WHEN last_used_at > 1000000000000 THEN last_used_at / 1000 ELSE last_used_at END, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS touched,
                       SUM(use_count) AS uses,
                       SUM(confirm_count) AS confirms,
                       SUM(contradict_count) AS contradicts,
                       SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded
                FROM record_stats
                WHERE last_used_at > 0
                GROUP BY day
             )
             SELECT dates.d,
                    COALESCE(r.md, 0),
                    COALESCE(r.iron, 0),
                    COALESCE(r.cavemem, 0),
                    COALESCE(r.corrections, 0),
                    COALESCE(s.touched, 0),
                    COALESCE(s.uses, 0),
                    COALESCE(s.confirms, 0),
                    COALESCE(s.contradicts, 0),
                    COALESCE(s.superseded, 0)
             FROM dates
             LEFT JOIN rec_daily r ON r.day = dates.d
             LEFT JOIN stat_daily s ON s.day = dates.d
             ORDER BY dates.d ASC",
        )?;

        struct DayRow {
            day: String,
            md: i64,
            iron: i64,
            cavemem: i64,
            corrections: i64,
            touched: i64,
            uses: i64,
            confirms: i64,
            contradicts: i64,
            superseded: i64,
        }
        let rows: Vec<DayRow> = day_stmt
            .query_map([span], |row| {
                Ok(DayRow {
                    day: row.get(0)?,
                    md: row.get(1)?,
                    iron: row.get(2)?,
                    cavemem: row.get(3)?,
                    corrections: row.get(4)?,
                    touched: row.get(5)?,
                    uses: row.get(6)?,
                    confirms: row.get(7)?,
                    contradicts: row.get(8)?,
                    superseded: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(day_stmt);

        let (active_curated, verified_active_curated, total_curated_links): (i64, i64, i64) = tx
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM records r LEFT JOIN record_stats s ON s.record_id = r.id
                        WHERE r.source_type IN ('markdown', 'iron') AND COALESCE(s.status, 'active') = 'active'),
                    (SELECT COUNT(*) FROM records r JOIN record_stats s ON s.record_id = r.id
                        WHERE r.source_type IN ('markdown', 'iron') AND COALESCE(s.status, 'active') = 'active' AND s.confirm_count > 0),
                    (SELECT COUNT(*) FROM memory_links l JOIN records r ON r.id = l.from_id
                        WHERE r.source_type IN ('markdown', 'iron'))",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        tx.commit()?;

        let n = rows.len();
        let last7 = &rows[n.saturating_sub(7)..];
        let prev7 = if n >= 14 {
            &rows[n - 14..n - 7]
        } else {
            &rows[..n.saturating_sub(7)]
        };

        let last7_cur: i64 = last7.iter().map(|d| d.md + d.iron).sum();
        let prev7_cur: i64 = prev7.iter().map(|d| d.md + d.iron).sum();
        let last7_raw: i64 = last7.iter().map(|d| d.cavemem).sum();
        let prev7_raw: i64 = prev7.iter().map(|d| d.cavemem).sum();
        let last7_iron: i64 = last7.iter().map(|d| d.iron).sum();
        let prev7_iron: i64 = prev7.iter().map(|d| d.iron).sum();
        let last7_confirms: i64 = last7.iter().map(|d| d.confirms).sum();
        let last7_refined: i64 = last7.iter().map(|d| d.superseded + d.corrections).sum();

        let signal_pct = |cur: i64, raw: i64| -> i64 {
            let tot = cur + raw;
            if tot <= 0 { 0 } else { (cur * 100) / tot }
        };
        let last7_signal_pct = signal_pct(last7_cur, last7_raw);
        let prev7_signal_pct = signal_pct(prev7_cur, prev7_raw);
        let verify_coverage_pct = if active_curated > 0 {
            (verified_active_curated * 100) / active_curated
        } else {
            0
        };
        let avg_links_per_curated = if active_curated > 0 {
            (total_curated_links as f64) / (active_curated as f64)
        } else {
            0.0
        };

        let today = rows.last().map(|d| {
            json!({
                "day": d.day,
                "markdown": d.md,
                "iron": d.iron,
                "curated": d.md + d.iron,
                "cavemem": d.cavemem,
                "corrections": d.corrections,
                "touched": d.touched,
                "uses": d.uses,
                "confirms": d.confirms,
                "contradicts": d.contradicts,
                "superseded": d.superseded,
            })
        }).unwrap_or_else(|| json!({}));

        let timeline: Vec<Value> = rows
            .into_iter()
            .map(|d| {
                json!({
                    "day": d.day,
                    "markdown": d.md,
                    "iron": d.iron,
                    "curated": d.md + d.iron,
                    "cavemem": d.cavemem,
                    "corrections": d.corrections,
                    "touched": d.touched,
                    "uses": d.uses,
                    "confirms": d.confirms,
                    "contradicts": d.contradicts,
                    "superseded": d.superseded,
                })
            })
            .collect();

        Ok(json!({
            "today": today,
            "timeline": timeline,
            "rates": {
                "signal_pct_7d": last7_signal_pct,
                "signal_pct_prev_7d": prev7_signal_pct,
                "signal_lift_pp": last7_signal_pct - prev7_signal_pct,
                "curated_7d": last7_cur,
                "curated_prev_7d": prev7_cur,
                "native_7d": last7_iron,
                "native_prev_7d": prev7_iron,
                "confirms_7d": last7_confirms,
                "refined_7d": last7_refined,
                "active_curated": active_curated,
                "verified_active_curated": verified_active_curated,
                "verification_coverage_pct": verify_coverage_pct,
                "avg_links_per_curated": (avg_links_per_curated * 10.0).round() / 10.0,
            }
        }))
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

fn split_camel_subtokens(token: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for ch in token.chars() {
        if ch.is_uppercase() && prev_lower && !current.is_empty() {
            if current.chars().count() >= 2 {
                parts.push(current.to_lowercase());
            }
            current.clear();
        }
        current.push(ch);
        prev_lower = ch.is_lowercase();
    }
    if parts.is_empty() {
        return Vec::new();
    }
    if current.chars().count() >= 2 {
        parts.push(current.to_lowercase());
    }
    parts
}

fn search_expression(query: &str) -> Option<String> {
    let end = utf8_boundary(query, MAX_QUERY_BYTES);
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for capture in QUERY_TOKEN.find_iter(&query[..end]) {
        if terms.len() >= MAX_QUERY_TERMS {
            break;
        }
        let raw = capture.as_str();
        if raw.len() > MAX_TERM_BYTES {
            continue;
        }
        let lower = raw.to_lowercase();
        if seen.insert(lower.clone()) {
            terms.push(format!("\"{lower}\""));
        }
        for sub in split_camel_subtokens(raw) {
            if terms.len() >= MAX_QUERY_TERMS {
                break;
            }
            if sub.len() <= MAX_TERM_BYTES && seen.insert(sub.clone()) {
                terms.push(format!("\"{sub}\""));
            }
        }
    }
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

fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn link_peer_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let evidence_raw: String = row.get(9)?;
    let evidence: Vec<String> = serde_json::from_str(&evidence_raw).unwrap_or_default();
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "project": row.get::<_, String>(2)?,
        "kind": row.get::<_, String>(3)?,
        "source_type": row.get::<_, String>(4)?,
        "status": row.get::<_, String>(5)?,
        "relation": row.get::<_, String>(6)?,
        "origin": row.get::<_, String>(7)?,
        "weight": row.get::<_, f64>(8)?,
        "evidence": evidence,
    }))
}

fn is_valid_iso_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

pub fn split_markdown_sections(content: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_heading = String::new();
    let mut current_body = String::new();

    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("## ") || trimmed.starts_with("### ") {
            if !current_body.trim().is_empty() || !current_heading.is_empty() {
                sections.push((current_heading.clone(), current_body.trim().to_owned()));
            }
            current_heading = trimmed.trim_start_matches('#').trim().to_owned();
            current_body.clear();
            current_body.push_str(line);
            current_body.push('\n');
        } else {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    if !current_body.trim().is_empty() || !current_heading.is_empty() {
        sections.push((current_heading, current_body.trim().to_owned()));
    }
    sections
}

pub fn extract_best_section(content: &str, query: &str) -> Option<(String, String)> {
    if content.len() < 1_200 {
        return None;
    }
    let sections = split_markdown_sections(content);
    if sections.len() < 2 {
        return None;
    }
    let query_tokens = crate::semantic::split_identifier_tokens(query);
    if query_tokens.is_empty() {
        return None;
    }
    let mut best: Option<(usize, String, String)> = None;
    for (heading, body) in sections {
        if heading.is_empty() {
            continue;
        }
        let lower_h = heading.to_lowercase();
        let lower_b = body.to_lowercase();
        let mut score = 0usize;
        for tok in &query_tokens {
            if lower_h.contains(tok) {
                score += 3;
            }
            if lower_b.contains(tok) {
                score += 1;
            }
        }
        if score > 0 && best.as_ref().is_none_or(|(s, _, _)| score > *s) {
            best = Some((score, heading, body));
        }
    }
    best.map(|(_, h, b)| { let snip = bounded_snippet(format!("[## {h}] {b}")); (h, snip) })
}

pub fn extract_named_section(content: &str, heading_query: &str) -> Option<(String, String)> {
    let needle = heading_query.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    let sections = split_markdown_sections(content);
    for (heading, body) in &sections {
        if heading.to_lowercase() == needle {
            return Some((heading.clone(), body.clone()));
        }
    }
    for (heading, body) in sections {
        if !heading.is_empty() && heading.to_lowercase().contains(&needle) {
            return Some((heading, body));
        }
    }
    None
}

pub fn canonical_project_root(project: &str) -> String {
    let trimmed = project.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return trimmed.to_owned();
    }
    if let Some(rest) = trimmed.strip_prefix("path:") {
        let label = rest.split('@').next().unwrap_or(rest);
        return format!("path:{label}");
    }
    let mut base = trimmed;
    for marker in ["/.claude/worktrees/", "/.worktrees/", "/worktrees/"] {
        if let Some((before, _)) = base.split_once(marker) {
            base = before;
            break;
        }
    }
    if base.starts_with('/') {
        return base
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(trimmed)
            .to_owned();
    }
    let mut parts = base.split('/').filter(|p| !p.is_empty());
    let Some(first) = parts.next() else {
        return trimmed.to_owned();
    };
    first.to_owned()
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
    #[test]
    fn inspect_is_strictly_read_only_and_browse_filters_accurately() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        let mut store = Store::open(&db, true).unwrap();
        let mut r1 = record("rec_curated", "src", "acme-app", "shared content body alpha");
        r1.source_type = "markdown".into();
        r1.kind = "curated".into();
        r1.updated_at = 200;
        let mut r2 = record(
            "rec_worktree",
            "src",
            "acme-app/.claude/worktrees/feat-x",
            "shared content body alpha",
        );
        r2.source_type = "iron".into();
        r2.kind = "decision".into();
        r2.updated_at = 300;
        let mut r3 = record("rec_history", "src", "other-app", "session log details beta");
        r3.source_type = "cavemem".into();
        r3.kind = "summary".into();
        r3.updated_at = 400;
        store
            .apply(&ImportBatch {
                groups: vec!["src".into()],
                records: vec![r1, r2, r3],
                links: vec![MemoryLink::explicit(
                    "rec_curated".into(),
                    "rec_worktree".into(),
                    "references".into(),
                )],
                ..Default::default()
            })
            .unwrap();
        store.record_feedback("rec_worktree", "helpful", None).unwrap();

        let ro = Store::open(&db, false).unwrap();
        let inspected = ro.inspect("rec_curated").unwrap().unwrap();
        assert_eq!(inspected["stats"]["use_count"], 0);
        assert_eq!(inspected["stats"]["confirm_count"], 0);
        assert_eq!(inspected["outgoing_link_count"], 1);
        assert_eq!(inspected["duplicate_bodies"].as_array().unwrap().len(), 1);
        let inspected_again = ro.inspect("rec_curated").unwrap().unwrap();
        assert_eq!(inspected_again["stats"]["use_count"], 0);

        let unverified = ro
            .browse(&BrowseOptions {
                source: Some("curated".into()),
                status: Some("unverified".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(unverified["total"], 1);
        assert_eq!(unverified["items"][0]["id"], "rec_curated");

        let verified = ro
            .browse(&BrowseOptions {
                status: Some("verified".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(verified["total"], 1);
        assert_eq!(verified["items"][0]["id"], "rec_worktree");

        let audit = ro.audit_health().unwrap();
        assert_eq!(audit["summary"]["curated_total"], 2);
        assert_eq!(audit["summary"]["curated_verified"], 1);
        assert_eq!(audit["summary"]["curated_unverified"], 1);
        assert_eq!(audit["summary"]["duplicate_body_records"], 1);
        let groups = audit["project_fragmentation"]["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["canonical_root"], "acme-app");
        assert_eq!(groups[0]["variant_count"], 2);
    }

    #[test]
    fn canonical_project_root_groups_worktrees_and_subdirs() {
        assert_eq!(
            canonical_project_root("acme-app/.claude/worktrees/first-run"),
            "acme-app"
        );
        assert_eq!(canonical_project_root("acme-app/frontend"), "acme-app");
        assert_eq!(
            canonical_project_root("org-service/app/sites/site-wrapper"),
            "org-service"
        );
        assert_eq!(canonical_project_root("path:Projects@abc123"), "path:Projects");
        assert_eq!(canonical_project_root("*"), "*");
    }


    #[test]
    fn merge_projects_is_case_sensitive_for_subpaths_and_worktrees() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");
        let mut store = Store::open(&db, true).unwrap();
        let mk = |id: &str, project: &str| MemoryRecord {
            id: id.into(),
            source_group: "seed".into(),
            source_key: id.into(),
            source_type: "markdown".into(),
            kind: "curated".into(),
            project: project.into(),
            title: id.into(),
            content: "content".into(),
            source_path: format!("/mem/{id}.md"),
            updated_at: 1_700_000_000_000,
            metadata: json!({}),
        };
        store
            .apply(&ImportBatch {
                groups: vec!["seed".into()],
                records: vec![
                    mk("r1", "app"),
                    mk("r2", "app/sub"),
                    mk("r3", "app-worktrees/wt1"),
                    mk("r4", "App"),
                    mk("r5", "App/sub"),
                    mk("r6", "app_other"),
                ],
                ..Default::default()
            })
            .unwrap();

        let updated = store.merge_projects("app", "new-app", true).unwrap();
        assert_eq!(updated, 3);
        assert_eq!(store.inspect("r1").unwrap().unwrap()["project"], "new-app");
        assert_eq!(store.inspect("r2").unwrap().unwrap()["project"], "new-app");
        assert_eq!(store.inspect("r3").unwrap().unwrap()["project"], "new-app");
        assert_eq!(store.inspect("r4").unwrap().unwrap()["project"], "App");
        assert_eq!(store.inspect("r5").unwrap().unwrap()["project"], "App/sub");
        assert_eq!(store.inspect("r6").unwrap().unwrap()["project"], "app_other");
    }
}
