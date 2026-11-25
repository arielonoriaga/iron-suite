use std::path::Path;

use crate::{model::SearchOptions, output, store::Store};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    if req.query.trim().is_empty() || req.query.len() > 2048 {
        bail!("query must contain between 1 and 2048 UTF-8 bytes");
    }
    if req
        .project
        .as_ref()
        .is_some_and(|p| p.is_empty() || p.len() > 256)
    {
        bail!("project must contain between 1 and 256 UTF-8 bytes");
    }
    if req.strict_project && req.project.is_none() {
        bail!("strict-project requires a project or repository");
    }
    if req
        .role
        .as_ref()
        .is_some_and(|r| !matches!(r.as_str(), "developer" | "reviewer" | "verifier"))
    {
        bail!("role must be developer, reviewer, or verifier");
    }
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
    let hits = store.search(
        &req.query,
        &SearchOptions {
            project: req.project,
            include_global: !req.strict_project,
            kinds: Vec::new(),
            source_types: if req.role.as_deref() == Some("reviewer") {
                vec!["markdown".to_owned()]
            } else {
                source_types
            },
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
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    if let Some(record) = store.get(&req.id)? {
        let content = record.content.clone();
        let signal = store.record_signal(&req.id)?;
        let mut value = serde_json::to_value(record)?;
        value["found"] = json!(true);
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
