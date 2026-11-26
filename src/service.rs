use std::collections::HashMap;
use std::path::Path;

use crate::{
    intelligence::{self, now_ms},
    model::{SearchHit, SearchOptions},
    output, semantic,
    store::{Store, extract_best_section, extract_named_section},
};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RRF_K: f64 = 60.0;
const NINETY_DAYS_MS: i64 = 90 * 86_400 * 1_000;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SearchRequest {
    pub query: String,
    pub project: Option<String>,
    #[serde(default)]
    pub strict_project: bool,
    pub limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub role: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetRequest {
    pub id: String,
    #[serde(default)]
    pub offset: usize,
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub section: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelatedRequest {
    pub id: String,
    pub relation: Option<String>,
    pub limit: Option<usize>,
    pub max_bytes: Option<usize>,
}

fn limit(value: Option<usize>) -> Result<usize> {
    let value = value.unwrap_or(10);
    if !(1..=50).contains(&value) {
        bail!("limit must be between 1 and 50");
    }
    Ok(value)
}

fn identifier(id: &str) -> Result<()> {
    if id.len() > 128
        || id.is_empty()
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        bail!("invalid memory ID");
    }
    Ok(())
}

pub fn search(store: &Store, req: SearchRequest) -> Result<Value> {
    search_with_archive(store, None, req)
}

pub fn search_with_archive(
    store: &Store,
    db_path: Option<&Path>,
    req: SearchRequest,
) -> Result<Value> {
    if req.query.trim().is_empty() || req.query.len() > 2048 {
        bail!("query must contain between 1 and 2048 UTF-8 bytes");
    }
    if req.project.as_ref().is_some_and(|p| p.is_empty() || p.len() > 256) {
        bail!("project must contain between 1 and 256 UTF-8 bytes");
    }
    if req.strict_project && req.project.is_none() {
        bail!("strict_project requires a project or repository scope");
    }
    if req
        .role
        .as_ref()
        .is_some_and(|r| !matches!(r.as_str(), "developer" | "reviewer" | "verifier"))
    {
        bail!("role must be developer, reviewer, or verifier");
    }
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    let req = if let Some(db) = db_path {
        let alias_map = crate::aliases::load(db).unwrap_or_default();
        SearchRequest {
            project: req.project.map(|p| crate::aliases::resolve(&alias_map, &p)),
            ..req
        }
    } else {
        req
    };
    let requested = limit(req.limit)?;
    let source = req.source.as_deref().unwrap_or("all");
    if req.role.as_deref() == Some("reviewer") && matches!(source, "history" | "native" | "archive") {
        bail!("reviewer context excludes history, archive, and native notes; use source all or curated");
    }
    if source == "archive" {
        let Some(archive_path) = db_path.map(|p| p.with_file_name("archive.db")) else {
            return output::items(Vec::new(), budget);
        };
        if !archive_path.is_file() {
            return output::items(Vec::new(), budget);
        }
        let archive_store = Store::open(&archive_path, false)?;
        let hits = archive_store.search(
            &req.query,
            &SearchOptions {
                project: req.project,
                include_global: !req.strict_project,
                kinds: Vec::new(),
                source_types: Vec::new(),
                exclude_superseded: false,
                limit: requested,
            },
        )?;
        let values = hits
            .into_iter()
            .map(|mut hit| {
                hit.title = output::prefix(&hit.title, 200).to_owned();
                hit.snippet = output::prefix(&hit.snippet, 480).to_owned();
                serde_json::to_value(hit)
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        return output::items(values, budget);
    }

    let source_types = match source {
        "all" => Vec::new(),
        "curated" => vec!["markdown".to_owned(), "iron".to_owned()],
        "history" => vec!["cavemem".to_owned()],
        "native" => vec!["iron".to_owned()],
        _ => bail!("source must be all, curated, history, native, or archive"),
    };
    let effective_source_types = if req.role.as_deref() == Some("reviewer") {
        vec!["markdown".to_owned()]
    } else {
        source_types
    };
    let search_opts = SearchOptions {
        project: req.project.clone(),
        include_global: !req.strict_project,
        kinds: Vec::new(),
        source_types: effective_source_types.clone(),
        exclude_superseded: false,
        limit: requested,
    };

    let fts_hits = store.search(&req.query, &search_opts)?;
    let mut fused: HashMap<String, SearchHit> = HashMap::new();
    let mut fts_ranks: HashMap<String, usize> = HashMap::new();
    let mut max_fts_score: f64 = 1.0;

    for (idx, hit) in fts_hits.iter().enumerate() {
        if hit.score > max_fts_score {
            max_fts_score = hit.score;
        }
        fts_ranks.insert(hit.id.clone(), idx + 1);
        fused.insert(hit.id.clone(), hit.clone());
    }

    // 1. Optional Hybrid Semantic RRF on curated records (strictly honoring role/project/source)
    let mut sem_ranks: HashMap<String, (usize, f32)> = HashMap::new();
    if let Some(db) = db_path
        && source != "history"
        && let Ok(sem_hits) = semantic::search_semantic(
            db,
            &req.query,
            search_opts.project.as_deref(),
            search_opts.include_global,
            &effective_source_types,
            requested.min(20),
        )
        && !sem_hits.is_empty()
    {
        let missing_ids: Vec<String> = sem_hits
            .iter()
            .filter(|(id, _)| !fused.contains_key(id))
            .map(|(id, _)| id.clone())
            .collect();
        let fetched = if missing_ids.is_empty() {
            HashMap::new()
        } else {
            store.fetch_hits_by_ids(&missing_ids, &search_opts)?
        };
        for (idx, (id, sim)) in sem_hits.into_iter().enumerate() {
            sem_ranks.insert(id.clone(), (idx + 1, sim));
            if !fused.contains_key(&id)
                && let Some(mut hit) = fetched.get(&id).cloned()
            {
                if let Ok(Some(rec)) = store.get(&id)
                    && let Some((_, sec_snip)) = extract_best_section(&rec.content, &req.query)
                {
                    hit.snippet = sec_snip;
                }
                hit.score *= sim as f64;
                hit.relation = Some("semantic_rrf".to_owned());
                hit.evidence = vec![format!("cosine:{sim:.2}")];
                fused.insert(id, hit);
            }
        }
    }

    // 2. 1-Hop Graph Expansion from top FTS hits (respecting exact role & scope filters)
    if !fts_hits.is_empty() && fused.len() < requested.saturating_mul(2) {
        let graph_budget = requested.min(4);
        if let Ok(neighbors) = store.expand_graph_neighbors(&fts_hits, &search_opts, graph_budget) {
            for nb in neighbors {
                fused.entry(nb.id.clone()).or_insert(nb);
            }
        }
    }

    // 3. Apply Reciprocal Rank Fusion boost when both FTS and Semantic agree,
    //    plus deterministic Code-Drift (0.5x) & gentle Unverified Staleness (0.85x floor)
    let intel = db_path
        .and_then(|db| intelligence::load_state(db).ok())
        .unwrap_or_default();
    let all_ids: Vec<String> = fused.keys().cloned().collect();
    let stats_map = store.record_stats_map(&all_ids).unwrap_or_default();
    let now = now_ms();

    let max_sem_only_score = fused
        .iter()
        .filter(|(id, _)| !fts_ranks.contains_key(*id) && sem_ranks.contains_key(*id))
        .map(|(id, h)| {
            let rs = sem_ranks[id].0;
            h.score * (RRF_K / (RRF_K + rs as f64))
        })
        .fold(0.0f64, f64::max);
    let sem_cap = if !fts_hits.is_empty() && max_sem_only_score > max_fts_score * 0.78 {
        Some((max_fts_score * 0.78) / max_sem_only_score)
    } else {
        None
    };

    for (id, hit) in &mut fused {
        if let (Some(&rf), Some(&(rs, sim))) = (fts_ranks.get(id), sem_ranks.get(id)) {
            let rrf_lift =
                1.0 + 0.35 * ((RRF_K / (RRF_K + rf as f64)) + (RRF_K / (RRF_K + rs as f64))) * 0.5;
            hit.score *= rrf_lift;
            if hit.evidence.is_empty() {
                hit.evidence.push(format!("semantic:{sim:.2}"));
            }
        } else if let Some(&(rs, _)) = sem_ranks.get(id)
            && !fts_ranks.contains_key(id)
        {
            // Preserve exact cosine rank order; smoothly scale below FTS only when FTS matched.
            let raw_sem = hit.score * (RRF_K / (RRF_K + rs as f64));
            hit.score = match sem_cap {
                Some(factor) => raw_sem * factor,
                None => raw_sem,
            };
        }

        // Code-drift decay (0.5x) when cited repo paths vanished from HEAD
        if let Some(d) = intel.drift.get(id)
            && d.drifted
        {
            hit.score *= 0.5;
            hit.evidence.push("drifted:0.5x".to_owned());
        }

        // Gentle staleness decay (down to 0.85x after 90d idle) ONLY for unverified memories;
        // human-confirmed memories (confirm_count > 0) remain 1.0x evergreen.
        let (confirm_count, last_used_at) = stats_map.get(id).copied().unwrap_or((0, 0));
        if confirm_count == 0 {
            let last_touch = hit.updated_at.max(last_used_at);
            if last_touch > 0 && now > last_touch {
                let age_ms = now - last_touch;
                if age_ms > NINETY_DAYS_MS {
                    let excess = ((age_ms - NINETY_DAYS_MS) as f64 / NINETY_DAYS_MS as f64).min(1.0);
                    hit.score *= 1.0 - 0.15 * excess;
                }
            }
        }
    }

    let mut ranked: Vec<SearchHit> = fused.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    ranked.truncate(requested);

    let values = ranked
        .into_iter()
        .map(|mut hit| {
            hit.title = output::prefix(&hit.title, 200).to_owned();
            hit.snippet = output::prefix(&hit.snippet, 480).to_owned();
            serde_json::to_value(hit)
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    output::items(values, budget)
}

pub fn get(store: &Store, req: GetRequest) -> Result<Value> {
    get_with_archive(store, None, req)
}

pub fn get_with_archive(
    store: &Store,
    db_path: Option<&Path>,
    req: GetRequest,
) -> Result<Value> {
    identifier(&req.id)?;
    if req.section.as_ref().is_some_and(|s| s.len() > 256) {
        bail!("section heading query must not exceed 256 UTF-8 bytes");
    }
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    if let Some(record) = store.get(&req.id)? {
        let (content, matched_section) = if let Some(sec_q) = req.section.as_deref() {
            if let Some((heading, body)) = extract_named_section(&record.content, sec_q) {
                (body, Some(heading))
            } else {
                (record.content.clone(), None)
            }
        } else {
            (record.content.clone(), None)
        };
        let signal = store.record_signal(&req.id)?;
        let mut value = serde_json::to_value(record)?;
        value["found"] = json!(true);
        if let Some(heading) = matched_section {
            value["section"] = json!(heading);
        }
        if let Some(sig) = signal
            && sig.get("status").and_then(Value::as_str) == Some("superseded")
        {
            value["metadata"]["status"] = json!("superseded");
            if let Some(rep) = sig.get("superseded_by") {
                value["metadata"]["superseded_by"] = rep.clone();
            }
        }
        return output::body(value, &content, req.offset, budget);
    }
    if let Some(archive_path) = db_path.map(|p| p.with_file_name("archive.db"))
        && archive_path.is_file()
    {
        let archive_store = Store::open(&archive_path, false)?;
        if let Some(record) = archive_store.get(&req.id)? {
            let content = record.content.clone();
            let mut value = serde_json::to_value(record)?;
            value["found"] = json!(true);
            return output::body(value, &content, req.offset, budget);
        }
    }
    Ok(json!({"found": false, "id": req.id}))
}

pub fn related(store: &Store, req: RelatedRequest) -> Result<Value> {
    identifier(&req.id)?;
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    if req.relation.as_ref().is_some_and(|r| r.len() > 64) {
        bail!("relation is too long");
    }
    let hits = store.related(&req.id, req.relation.as_deref(), limit(req.limit)?)?;
    output::items(
        hits.into_iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()?,
        budget,
    )
}
