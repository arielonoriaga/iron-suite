use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use rusqlite::{Connection, Transaction, params};
use serde_json::{Value, json};

const MIN_DOC_FREQ: usize = 2;
const MAX_DOC_FREQ: usize = 20;
const MAX_ANCHORS_PER_DOC: usize = 48;
const MAX_NEIGHBORS_PER_DOC: usize = 8;

static CODE_SPAN_OR_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|\b[A-Za-z0-9_-]{3,}\.(?:rs|ts|tsx|js|py|go|sql|toml|yml|yaml|sh)\b")
        .expect("valid file path regex")
});

static ADVISORY_OR_CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:CWE-\d{1,5}|RUSTSEC-\d{4}-\d{4}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|CVE-\d{4}-\d{4,7}|REQ-\d{1,5}|SQLSTATE\s+[0-9A-Z]{5}|[0-9]{2}P[0-9]{2}|GS_[A-Z0-9_]{2,})\b")
        .expect("valid advisory code regex")
});

static TECH_IDENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_:]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]{2,}_[a-z0-9_]{3,}|[A-Z]{2,}_[A-Z0-9_]{3,})\b")
        .expect("valid identifier regex")
});

const GENERIC_FILES: &[&str] = &[
    "mod.rs",
    "lib.rs",
    "main.rs",
    "index.ts",
    "index.tsx",
    "index.js",
    "cargo.toml",
    "package.json",
    "tsconfig.json",
    "readme.md",
    "skill.md",
    "memory.md",
    "claude.md",
    "spec.md",
    "settings.json",
    "config.rs",
    "config.toml",
    "router.rs",
    "api.rs",
    "service.rs",
    "store.rs",
    "model.rs",
    "types.ts",
    "utils.ts",
];

const GENERIC_IDENTS: &[&str] = &[
    "private_redacted",
    "session_id",
    "company_id",
    "user_id",
    "created_at",
    "updated_at",
    "source_path",
    "source_type",
    "source_group",
    "memory_search",
    "memory_get",
    "memory_remember",
    "memory_related",
    "status_code",
    "app_error",
    "hash_map",
    "serde_json",
    "tokio_test",
    "async_trait",
];

pub fn extract_anchors(title: &str, content: &str) -> Vec<String> {
    let mut anchors = BTreeSet::new();
    let sample_end = content
        .char_indices()
        .take_while(|(idx, _)| *idx < 16_384)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    let combined = format!("{title}\n{}", &content[..sample_end]);

    for m in ADVISORY_OR_CODE.find_iter(&combined) {
        let token = m.as_str();
        if token.len() <= 64 {
            anchors.insert(format!("code:{}", token.to_uppercase()));
        }
    }

    for m in CODE_SPAN_OR_PATH.find_iter(&combined) {
        let raw = m.as_str().trim_matches(|c: char| c == '.' || c == '/');
        let lower = raw.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        if GENERIC_FILES.contains(&base) {
            let parts: Vec<&str> = lower.split('/').collect();
            if parts.len() >= 2 {
                let tail = format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]);
                if tail.len() >= 7 && tail.len() <= 80 {
                    anchors.insert(format!("path:{tail}"));
                }
            }
        } else if base.len() >= 5 && base.len() <= 64 {
            anchors.insert(format!("file:{base}"));
        }
    }

    for m in TECH_IDENT.find_iter(&combined) {
        let raw = m.as_str();
        if !(6..=64).contains(&raw.len()) {
            continue;
        }
        let norm = raw.to_ascii_lowercase();
        if GENERIC_IDENTS.contains(&norm.as_str())
            || norm.starts_with("mem_")
            || norm.starts_with("http_")
            || norm.chars().all(|c| c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        anchors.insert(format!("sym:{norm}"));
        if anchors.len() >= MAX_ANCHORS_PER_DOC {
            break;
        }
    }

    anchors.into_iter().take(MAX_ANCHORS_PER_DOC).collect()
}

struct DocMeta {
    id: String,
    project: String,
    source_type: String,
    conversation_key: String,
    anchors: Vec<String>,
}

fn conversation_key(source_type: &str, source_path: &str, metadata_json: &str) -> String {
    if let Ok(meta) = serde_json::from_str::<Value>(metadata_json)
        && let Some(sid) = meta
            .get("session_id")
            .or_else(|| meta.get("session_record_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        return format!("session:{sid}");
    }
    if source_type == "markdown" {
        return format!("md:{source_path}");
    }
    format!("rec:{source_path}")
}

pub fn rebuild_auto_links(transaction: &Transaction<'_>) -> Result<usize> {
    let docs = load_eligible_docs(transaction)?;
    transaction.execute("DELETE FROM memory_links WHERE origin = 'auto'", [])?;
    if docs.len() < 2 {
        return Ok(0);
    }

    let n_docs = docs.len() as f64;
    let mut inverted: HashMap<&str, Vec<usize>> = HashMap::new();
    for (idx, doc) in docs.iter().enumerate() {
        for anchor in &doc.anchors {
            inverted.entry(anchor.as_str()).or_default().push(idx);
        }
    }

    // Keep only discriminative anchors (2 <= df <= MAX_DOC_FREQ)
    inverted.retain(|_, postings| (MIN_DOC_FREQ..=MAX_DOC_FREQ).contains(&postings.len()));

    let mut pair_shared: HashMap<(usize, usize), Vec<(&str, f64)>> = HashMap::new();
    for (anchor, postings) in &inverted {
        let idf = (n_docs / postings.len() as f64).ln().max(0.5);
        for i in 0..postings.len() {
            for j in (i + 1)..postings.len() {
                let a = postings[i];
                let b = postings[j];
                // Never auto-link records from the exact same conversation/file
                if docs[a].conversation_key == docs[b].conversation_key {
                    continue;
                }
                let key = if a < b { (a, b) } else { (b, a) };
                pair_shared.entry(key).or_default().push((anchor, idf));
            }
        }
    }

    let mut per_doc: HashMap<usize, Vec<(usize, f64, Vec<String>)>> = HashMap::new();
    for ((a, b), mut shared) in pair_shared {
        shared.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
        let total_idf: f64 = shared.iter().map(|(_, w)| *w).sum();
        let high_specificity_single = shared.len() == 1
            && (shared[0].0.starts_with("code:") || shared[0].0.starts_with("path:") || shared[0].0.len() >= 16)
            && shared[0].1 >= 3.2;
        if shared.len() < 2 && !high_specificity_single {
            continue;
        }
        // Slight boost when connecting curated/native lessons or sibling projects
        let cross_bonus = if docs[a].source_type != docs[b].source_type || docs[a].project != docs[b].project {
            1.15
        } else {
            1.0
        };
        let weight = ((total_idf * cross_bonus) * 100.0).round() / 100.0;
        let evidence: Vec<String> = shared
            .into_iter()
            .take(6)
            .map(|(s, _)| strip_prefix(s).to_owned())
            .collect();
        per_doc.entry(a).or_default().push((b, weight, evidence.clone()));
        per_doc.entry(b).or_default().push((a, weight, evidence));
    }

    let mut insert = transaction.prepare(
        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
         VALUES (?, ?, 'shares_anchor', 'auto', ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
            weight = excluded.weight,
            evidence = excluded.evidence
         WHERE memory_links.origin = 'auto'",
    )?;

    let mut count = 0usize;
    for (doc_idx, mut neighbors) in per_doc {
        neighbors.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
        for (target_idx, weight, evidence) in neighbors.into_iter().take(MAX_NEIGHBORS_PER_DOC) {
            let ev_json = serde_json::to_string(&evidence)?;
            count += insert.execute(params![
                docs[doc_idx].id,
                docs[target_idx].id,
                weight,
                ev_json
            ])?;
        }
    }
    Ok(count)
}

pub fn link_single_record(transaction: &Transaction<'_>, record_id: &str) -> Result<Vec<Value>> {
    let Some((rec_project, rec_conv, rec_anchors)) = load_single_doc(transaction, record_id)? else {
        return Ok(Vec::new());
    };
    if rec_anchors.is_empty() {
        return Ok(Vec::new());
    }
    let anchor_set: BTreeSet<&str> = rec_anchors.iter().map(String::as_str).collect();
    let docs = load_eligible_docs(transaction)?;
    let n_docs = docs.len().max(2) as f64;

    let mut df: HashMap<&str, usize> = HashMap::new();
    for doc in &docs {
        for a in &doc.anchors {
            if let Some(&needle) = anchor_set.get(a.as_str()) {
                *df.entry(needle).or_insert(0) += 1;
            }
        }
    }

    let mut candidates: Vec<(String, f64, Vec<String>)> = Vec::new();
    for doc in &docs {
        if doc.id == record_id || doc.conversation_key == rec_conv {
            continue;
        }
        let mut shared: Vec<(&str, f64)> = doc
            .anchors
            .iter()
            .filter_map(|a| {
                let freq = *df.get(a.as_str())?;
                (freq <= MAX_DOC_FREQ).then(|| (a.as_str(), (n_docs / freq as f64).ln().max(0.5)))
            })
            .collect();
        if shared.is_empty() {
            continue;
        }
        shared.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
        let total_idf: f64 = shared.iter().map(|(_, w)| *w).sum();
        let single_ok = shared.len() == 1
            && (shared[0].0.starts_with("code:") || shared[0].0.starts_with("path:") || shared[0].0.len() >= 16)
            && shared[0].1 >= 2.0;
        if shared.len() < 2 && !single_ok {
            continue;
        }
        let bonus = if doc.project != rec_project { 1.15 } else { 1.0 };
        let weight = ((total_idf * bonus) * 100.0).round() / 100.0;
        let evidence: Vec<String> = shared
            .into_iter()
            .take(6)
            .map(|(s, _)| strip_prefix(s).to_owned())
            .collect();
        candidates.push((doc.id.clone(), weight, evidence));
    }

    candidates.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(MAX_NEIGHBORS_PER_DOC);

    let mut insert = transaction.prepare(
        "INSERT INTO memory_links(from_id, to_id, relation, origin, weight, evidence)
         VALUES (?, ?, 'shares_anchor', 'auto', ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
            weight = excluded.weight,
            evidence = excluded.evidence
         WHERE memory_links.origin = 'auto'",
    )?;

    let mut discovered = Vec::with_capacity(candidates.len());
    for (other_id, weight, evidence) in candidates {
        let ev_json = serde_json::to_string(&evidence)?;
        insert.execute(params![record_id, other_id, weight, ev_json])?;
        insert.execute(params![other_id, record_id, weight, ev_json])?;
        let (title, project, kind): (String, String, String) = transaction.query_row(
            "SELECT title, project, kind FROM records WHERE id = ?",
            [&other_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        discovered.push(json!({
            "id": other_id,
            "title": title,
            "project": project,
            "kind": kind,
            "relation": "shares_anchor",
            "weight": weight,
            "shared_anchors": evidence,
        }));
    }
    Ok(discovered)
}

pub fn consolidate_patterns(
    connection: &Connection,
    project: Option<&str>,
    min_occurrences: usize,
    limit: usize,
) -> Result<Value> {
    let min_occ = min_occurrences.max(2);
    let mut sql = String::from(
        "SELECT r.id, r.project, r.kind, r.source_type, r.source_path, r.title, b.content, r.metadata
         FROM records r
         JOIN bodies b ON b.id = r.body_id
         LEFT JOIN record_stats s ON s.record_id = r.id
         WHERE COALESCE(s.status, 'active') = 'active'
           AND (r.source_type IN ('markdown', 'iron') OR (r.source_type = 'cavemem' AND r.kind = 'summary'))",
    );
    let mut stmt;
    let rows = if let Some(proj) = project {
        sql.push_str(" AND (r.project = ? OR r.project = '*')");
        stmt = connection.prepare(&sql)?;
        stmt.query_map([proj], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt = connection.prepare(&sql)?;
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    type AnchorEntry = (String, String, String, String, String);
    let mut anchor_hits: BTreeMap<String, Vec<AnchorEntry>> = BTreeMap::new();
    for (id, proj, kind, stype, spath, title, content, meta) in rows {
        let conv = conversation_key(&stype, &spath, &meta);
        for anchor in extract_anchors(&title, &content) {
            anchor_hits
                .entry(anchor)
                .or_default()
                .push((id.clone(), proj.clone(), kind.clone(), title.clone(), conv.clone()));
        }
    }

    let mut clusters = Vec::new();
    for (anchor, entries) in anchor_hits {
        if entries.len() > MAX_DOC_FREQ {
            continue;
        }
        let distinct_convs: BTreeSet<&str> = entries.iter().map(|e| e.4.as_str()).collect();
        if distinct_convs.len() < min_occ {
            continue;
        }
        let high_signal_count = entries
            .iter()
            .filter(|e| matches!(e.2.as_str(), "correction" | "gotcha" | "decision" | "curated"))
            .count();
        let projects: BTreeSet<&str> = entries.iter().map(|e| e.1.as_str()).collect();
        let sample_records: Vec<Value> = entries
            .iter()
            .take(5)
            .map(|e| json!({"id": e.0, "project": e.1, "kind": e.2, "title": e.3}))
            .collect();
        clusters.push((
            distinct_convs.len() * 2 + high_signal_count * 3,
            json!({
                "anchor": strip_prefix(&anchor),
                "anchor_kind": anchor.split(':').next().unwrap_or("sym"),
                "distinct_conversations": distinct_convs.len(),
                "high_signal_records": high_signal_count,
                "projects": projects.into_iter().collect::<Vec<_>>(),
                "records": sample_records,
            }),
        ));
    }

    clusters.sort_by_key(|a| std::cmp::Reverse(a.0));
    let items: Vec<Value> = clusters.into_iter().take(limit.clamp(1, 50)).map(|(_, v)| v).collect();
    Ok(json!({
        "clusters": items,
        "count": items.len(),
    }))
}

fn strip_prefix(anchor: &str) -> &str {
    anchor.split_once(':').map(|(_, rest)| rest).unwrap_or(anchor)
}

fn load_single_doc(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<Option<(String, String, Vec<String>)>> {
    let mut stmt = transaction.prepare(
        "SELECT r.project, r.source_type, r.source_path, r.title, b.content, r.metadata
         FROM records r JOIN bodies b ON b.id = r.body_id
         WHERE r.id = ?",
    )?;
    let mut rows = stmt.query([record_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let project: String = row.get(0)?;
    let stype: String = row.get(1)?;
    let spath: String = row.get(2)?;
    let title: String = row.get(3)?;
    let content: String = row.get(4)?;
    let meta: String = row.get(5)?;
    Ok(Some((
        project,
        conversation_key(&stype, &spath, &meta),
        extract_anchors(&title, &content),
    )))
}

fn load_eligible_docs(transaction: &Transaction<'_>) -> Result<Vec<DocMeta>> {
    let mut stmt = transaction.prepare(
        "SELECT r.id, r.project, r.source_type, r.source_path, r.title, b.content, r.metadata
         FROM records r
         JOIN bodies b ON b.id = r.body_id
         LEFT JOIN record_stats s ON s.record_id = r.id
         WHERE COALESCE(s.status, 'active') = 'active'
           AND (r.source_type IN ('markdown', 'iron') OR (r.source_type = 'cavemem' AND r.kind = 'summary'))
         ORDER BY r.rowid ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let project: String = row.get(1)?;
        let source_type: String = row.get(2)?;
        let source_path: String = row.get(3)?;
        let title: String = row.get(4)?;
        let content: String = row.get(5)?;
        let metadata: String = row.get(6)?;
        Ok(DocMeta {
            id,
            project,
            conversation_key: conversation_key(&source_type, &source_path, &metadata),
            source_type,
            anchors: extract_anchors(&title, &content),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
