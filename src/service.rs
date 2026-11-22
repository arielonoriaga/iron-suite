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
    let requested = limit(req.limit)?;
    let source = req.source.as_deref().unwrap_or("all");
    let source_types = match source {
        "all" => Vec::new(),
        "curated" => vec!["markdown".to_owned(), "iron".to_owned()],
        "history" => vec!["cavemem".to_owned()],
        "native" => vec!["iron".to_owned()],
        _ => bail!("source must be all, curated, history, or native"),
    };
    if req.role.as_deref() == Some("reviewer") && matches!(source, "history" | "native") {
        bail!("reviewer context excludes history and native notes; use source all or curated");
    }
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
    identifier(&req.id)?;
    let budget = req.max_bytes.unwrap_or(output::DEFAULT_BUDGET);
    output::validate_budget(budget)?;
    match store.get(&req.id)? {
        None => Ok(json!({"found": false, "id": req.id})),
        Some(record) => {
            let content = record.content.clone();
            let mut value = serde_json::to_value(record)?;
            value["found"] = json!(true);
            output::body(value, &content, req.offset, budget)
        }
    }
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
