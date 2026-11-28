use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::model::{ImportBatch, MemoryLink, MemoryRecord};
use crate::store::{HISTORY_SOURCE_TYPE, Store, canonical_source_type};

const BATCH_GROUPS_CHUNK: usize = 64;

pub fn migrate_store(
    source_db: &Path,
    hot_output: &Path,
    archive_output: Option<&Path>,
) -> Result<Value> {
    ensure!(source_db.is_file(), "migration source database does not exist");
    ensure!(
        !hot_output.exists(),
        "hot output path already exists: {}",
        hot_output.display()
    );
    if let Some(arch) = archive_output {
        ensure!(
            !arch.exists(),
            "archive output path already exists: {}",
            arch.display()
        );
        ensure!(
            arch != hot_output,
            "hot output and archive output paths must differ"
        );
    }

    let src = Connection::open_with_flags(
        source_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("cannot open source database {}", source_db.display()))?;
    src.pragma_update(None, "query_only", true)?;

    let app_id: i64 = src.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i64 = src.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(app_id == 0x4952_4f4e, "source is not an Iron Memory database");
    ensure!(
        matches!(version, 1 | 2),
        "unsupported source schema version {version}; expected 1 or 2"
    );

    let join_sql = if version == 1 {
        "SELECT r.id, r.source_group, r.source_key, r.source_type, r.kind, r.project,
                r.title, b.content, r.source_path, r.updated_at, r.metadata
         FROM records r JOIN bodies b ON b.hash = r.content_hash
         ORDER BY r.source_group ASC, r.rowid ASC"
    } else {
        "SELECT r.id, r.source_group, r.source_key, r.source_type, r.kind, r.project,
                r.title, b.content, r.source_path, r.updated_at, r.metadata
         FROM records r JOIN bodies b ON b.id = r.body_id
         ORDER BY r.source_group ASC, r.rowid ASC"
    };

    let mut hot_store = Store::open(hot_output, true)?;
    let arch_store = match archive_output {
        Some(path) => Some(Store::open(path, true)?),
        None => None,
    };

    let mut stmt = src.prepare(join_sql)?;
    let mut rows = stmt.query([])?;

    let mut hot_by_group: std::collections::BTreeMap<String, Vec<MemoryRecord>> =
        std::collections::BTreeMap::new();
    let mut arch_by_group: std::collections::BTreeMap<String, Vec<MemoryRecord>> =
        std::collections::BTreeMap::new();

    let mut hot_count = 0usize;
    let mut arch_count = 0usize;

    while let Some(row) = rows.next()? {
        let meta_str: String = row.get(10)?;
        let metadata: Value = serde_json::from_str(&meta_str)
            .context("invalid JSON metadata in source record")?;
        let rec = MemoryRecord {
            id: row.get(0)?,
            source_group: row.get(1)?,
            source_key: row.get(2)?,
            source_type: canonical_source_type(row.get(3)?),
            kind: row.get(4)?,
            project: row.get(5)?,
            title: row.get(6)?,
            content: row.get(7)?,
            source_path: row.get(8)?,
            updated_at: row.get(9)?,
            metadata,
        };
        let is_cold_obs =
            arch_store.is_some() && rec.source_type == HISTORY_SOURCE_TYPE && rec.kind == "observation";
        if is_cold_obs {
            arch_count += 1;
            arch_by_group
                .entry(format!("archive:{}", rec.source_group))
                .or_default()
                .push(MemoryRecord {
                    source_group: format!("archive:{}", rec.source_group),
                    ..rec
                });
        } else {
            hot_count += 1;
            hot_by_group
                .entry(rec.source_group.clone())
                .or_default()
                .push(rec);
        }
    }
    drop(rows);
    drop(stmt);

    // Load explicit links from source
    let link_sql = if version == 1 {
        "SELECT from_id, to_id, relation FROM memory_links"
    } else {
        "SELECT from_id, to_id, relation FROM memory_links WHERE origin = 'explicit'"
    };
    let mut link_stmt = src.prepare(link_sql)?;
    let all_links: Vec<MemoryLink> = link_stmt
        .query_map([], |r| {
            Ok(MemoryLink::explicit(r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Apply hot groups in bounded chunks, then attach explicit links + rebuild auto links
    let hot_groups: Vec<(String, Vec<MemoryRecord>)> = hot_by_group.into_iter().collect();
    for chunk in hot_groups.chunks(BATCH_GROUPS_CHUNK) {
        let mut batch = ImportBatch::default();
        for (g, recs) in chunk {
            batch.groups.push(g.clone());
            batch.records.extend(recs.iter().cloned());
        }
        hot_store.apply_without_autolink(&batch)?;
    }

    if !all_links.is_empty() {
        hot_store.restore_explicit_links(&all_links)?;
    }
    let auto_links = hot_store.rebuild_auto_links()?;
    hot_store.compact_and_checkpoint()?;

    let mut arch_bytes = 0u64;
    if let Some(mut astore) = arch_store {
        let arch_groups: Vec<(String, Vec<MemoryRecord>)> = arch_by_group.into_iter().collect();
        for chunk in arch_groups.chunks(BATCH_GROUPS_CHUNK) {
            let mut batch = ImportBatch::default();
            for (g, recs) in chunk {
                batch.groups.push(g.clone());
                batch.records.extend(recs.iter().cloned());
            }
            astore.apply_without_autolink(&batch)?;
        }
        astore.finalize_standalone_archive()?;
        drop(astore);
        if let Some(apath) = archive_output {
            arch_bytes = fs::metadata(apath)?.len();
        }
    }
    drop(hot_store);

    let source_total: i64 = src.query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0))?;
    if (hot_count + arch_count) as i64 != source_total {
        bail!(
            "migration count mismatch: hot({hot_count}) + archive({arch_count}) != source({source_total})"
        );
    }

    let hot_bytes = fs::metadata(hot_output)?.len();
    Ok(json!({
        "source_records": source_total,
        "hot_records": hot_count,
        "archive_records": arch_count,
        "auto_links_built": auto_links,
        "hot_bytes": hot_bytes,
        "archive_bytes": arch_bytes,
    }))
}
