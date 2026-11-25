use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub source_group: String,
    pub source_key: String,
    pub source_type: String,
    pub kind: String,
    pub project: String,
    pub title: String,
    pub content: String,
    pub source_path: String,
    pub updated_at: i64,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryLink {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    #[serde(default = "default_link_origin")]
    pub origin: String,
    #[serde(default = "default_link_weight")]
    pub weight: f64,
    #[serde(default)]
    pub evidence: Vec<String>,
}

fn default_link_origin() -> String {
    "explicit".to_owned()
}

fn default_link_weight() -> f64 {
    1.0
}

impl MemoryLink {
    pub fn explicit(from_id: String, to_id: String, relation: String) -> Self {
        Self {
            from_id,
            to_id,
            relation,
            origin: "explicit".to_owned(),
            weight: 1.0,
            evidence: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ImportBatch {
    pub groups: Vec<String>,
    pub records: Vec<MemoryRecord>,
    pub links: Vec<MemoryLink>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub project: String,
    pub kind: String,
    pub source_type: String,
    pub source_path: String,
    pub updated_at: i64,
    pub snippet: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImportReport {
    pub inserted: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub links: usize,
    pub auto_links: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub project: Option<String>,
    pub include_global: bool,
    pub kinds: Vec<String>,
    pub source_types: Vec<String>,
    pub exclude_superseded: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BrowseOptions {
    pub project: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub query: Option<String>,
    pub sort: Option<String>,
    pub day: Option<String>,
    pub limit: usize,
    pub offset: usize,
}
