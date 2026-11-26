use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use anyhow::{Result, ensure};
use serde_json::{Value, json};

use crate::aliases;
use crate::drift;
use crate::intelligence::{Contradiction, build_review_queue, load_state, now_ms, save_state};
use crate::linker;
use crate::native::lock_native_writes;
use crate::semantic;
use crate::store::{Store, canonical_project_root};

const MAX_CONTRADICTIONS: usize = 30;
const MAX_ANCHOR_DF_FOR_CONFLICT: usize = 15;

const PROHIBITIVE_CUES: &[&str] = &[
    "never ",
    "do not ",
    "don't ",
    "avoid ",
    "deprecated",
    "replaced by",
    "instead of",
    "must not ",
    "forbid",
    "no longer ",
    "stop using",
];

const PRESCRIPTIVE_CUES: &[&str] = &[
    "always ",
    "must ",
    "use ",
    "prefer ",
    "require ",
    "enable ",
    "run ",
];

fn contains_word_cue(lower: &str, cues: &[&str]) -> bool {
    for cue in cues {
        let mut search_from = 0usize;
        while let Some(rel) = lower[search_from..].find(cue) {
            let abs = search_from + rel;
            let at_boundary = abs == 0
                || lower[..abs]
                    .chars()
                    .next_back()
                    .is_some_and(|c| !c.is_alphanumeric() && c != '_');
            if at_boundary {
                return true;
            }
            search_from = abs + cue.len();
        }
    }
    false
}

fn has_prohibitive_polarity(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    contains_word_cue(&lower, PROHIBITIVE_CUES)
}

fn has_prescriptive_polarity(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    contains_word_cue(&lower, PRESCRIPTIVE_CUES)
}

pub fn detect_contradictions(store: &Store) -> Result<Vec<Contradiction>> {
    struct ActiveDoc {
        id: String,
        title: String,
        root: String,
        anchors: Vec<String>,
        prohibitive: bool,
        prescriptive: bool,
    }

    let mut docs = Vec::new();
    let mut superseded_pairs: HashSet<(String, String)> = HashSet::new();

    for source_type in ["markdown", "iron"] {
        for rec in store.list_records(source_type, &[])? {
            let sig = store.record_signal(&rec.id)?;
            if sig
                .as_ref()
                .and_then(|v| v.get("status"))
                .and_then(Value::as_str)
                == Some("superseded")
            {
                if let Some(by) = sig
                    .as_ref()
                    .and_then(|v| v.get("superseded_by"))
                    .and_then(Value::as_str)
                {
                    superseded_pairs.insert((rec.id.clone(), by.to_owned()));
                    superseded_pairs.insert((by.to_owned(), rec.id.clone()));
                }
                continue;
            }
            let anchors = linker::extract_anchors(&rec.title, &rec.content);
            if anchors.is_empty() {
                continue;
            }
            let combined = format!("{}\n{}", rec.title, rec.content);
            docs.push(ActiveDoc {
                root: canonical_project_root(&rec.project),
                id: rec.id,
                title: rec.title,
                anchors,
                prohibitive: has_prohibitive_polarity(&combined),
                prescriptive: has_prescriptive_polarity(&combined),
            });
        }
    }

    // Group by (canonical_root, anchor) for fast high-IDF conflict discovery
    let mut by_root_anchor: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (idx, doc) in docs.iter().enumerate() {
        for anchor in &doc.anchors {
            by_root_anchor
                .entry((doc.root.clone(), anchor.clone()))
                .or_default()
                .push(idx);
        }
    }

    let mut pair_anchors: BTreeMap<(usize, usize), Vec<String>> = BTreeMap::new();
    for ((_, anchor), indices) in &by_root_anchor {
        if indices.len() < 2 || indices.len() > MAX_ANCHOR_DF_FOR_CONFLICT {
            continue;
        }
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                let a = indices[i].min(indices[j]);
                let b = indices[i].max(indices[j]);
                pair_anchors.entry((a, b)).or_default().push(anchor.clone());
            }
        }
    }

    let mut contradictions = Vec::new();
    for ((a_idx, b_idx), mut shared) in pair_anchors {
        let a = &docs[a_idx];
        let b = &docs[b_idx];
        if superseded_pairs.contains(&(a.id.clone(), b.id.clone())) {
            continue;
        }
        // Opposing polarity: one prohibits/deprecates while the other prescribes without prohibition
        let opposing = (a.prohibitive && b.prescriptive && !b.prohibitive)
            || (b.prohibitive && a.prescriptive && !a.prohibitive);
        if !opposing {
            continue;
        }
        shared.sort();
        shared.dedup();
        let preview = shared.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
        contradictions.push(Contradiction {
            a_id: a.id.clone(),
            a_title: a.title.clone(),
            b_id: b.id.clone(),
            b_title: b.title.clone(),
            project: a.root.clone(),
            shared_anchors: shared,
            reason: format!("Opposing directives sharing technical anchor(s): {preview}"),
        });
    }

    contradictions.sort_by(|x, y| {
        y.shared_anchors
            .len()
            .cmp(&x.shared_anchors.len())
            .then_with(|| x.a_id.cmp(&y.a_id))
    });
    contradictions.truncate(MAX_CONTRADICTIONS);
    Ok(contradictions)
}

pub fn run(db: &Path, repos_root: Option<&Path>) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "sleep consolidation requires a durable index path"
    );
    let started = now_ms();
    let _lock = lock_native_writes(db)?;
    let alias_map = aliases::load(db)?;
    let mut store = Store::open(db, true)?;

    let auto_links_built = store.rebuild_auto_links()?;
    let consolidated = store.consolidate(None, 3, 20)?;
    let consolidation_count = consolidated
        .get("clusters")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    let contradictions = detect_contradictions(&store)?;
    let (drift_entries, repo_audits) = if let Some(root) = repos_root {
        drift::audit_repos_root(&store, &alias_map, root)?
    } else {
        (BTreeMap::new(), Vec::new())
    };
    let semantic_records = semantic::rebuild_index(db, &store)?;

    let mut state = load_state(db)?;
    state.version = 1;
    state.sleep_ran_at = now_ms();
    state.consolidation_count = consolidation_count;
    state.semantic_records = semantic_records;
    state.contradictions = contradictions;
    if repos_root.is_some() {
        state.drift = drift_entries;
    }
    build_review_queue(&store, &mut state)?;
    save_state(db, &state)?;

    Ok(json!({
        "sleep_ran_at": state.sleep_ran_at,
        "elapsed_ms": (now_ms() - started).max(0),
        "auto_links_built": auto_links_built,
        "consolidation_candidates": state.consolidation_count,
        "contradictions_found": state.contradictions.len(),
        "drifted_records": state.drift.values().filter(|d| d.drifted).count(),
        "semantic_records_indexed": state.semantic_records,
        "review_queue_len": state.review_queue.len(),
        "repos_audited": repo_audits,
        "needs_review_flags": state.needs_review.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ImportBatch, MemoryRecord};
    use tempfile::TempDir;

    #[test]
    fn sleep_detects_contradictions_builds_semantic_index_and_populates_morning_queue() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");
        let mut store = Store::open(&db, true).unwrap();
        store
            .apply(&ImportBatch {
                groups: vec!["seed".into()],
                records: vec![
                    MemoryRecord {
                        id: "rec_a".into(),
                        source_group: "seed".into(),
                        source_key: "a".into(),
                        source_type: "markdown".into(),
                        kind: "curated".into(),
                        project: "acme".into(),
                        title: "Use polling for order_status_sync".into(),
                        content: "Always use polling inside `order_status_sync` worker.".into(),
                        source_path: "/mem/a.md".into(),
                        updated_at: 1_700_000_000_000,
                        metadata: json!({}),
                    },
                    MemoryRecord {
                        id: "rec_b".into(),
                        source_group: "seed".into(),
                        source_key: "b".into(),
                        source_type: "iron".into(),
                        kind: "correction".into(),
                        project: "acme".into(),
                        title: "Stop polling order_status_sync".into(),
                        content: "Never use polling in `order_status_sync`; it is deprecated and replaced by SSE.".into(),
                        source_path: "native://iron/b".into(),
                        updated_at: 1_700_000_005_000,
                        metadata: json!({}),
                    },
                ],
                ..Default::default()
            })
            .unwrap();

        let summary = run(&db, None).unwrap();
        assert_eq!(summary["contradictions_found"], 1);
        assert_eq!(summary["semantic_records_indexed"], 2);
        assert!(summary["review_queue_len"].as_u64().unwrap() >= 1);

        let state = load_state(&db).unwrap();
        assert_eq!(state.contradictions.len(), 1);
        assert_eq!(state.review_queue[0].kind, "contradiction");
    }
}
