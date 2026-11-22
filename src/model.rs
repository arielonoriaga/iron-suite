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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImportReport {
    pub inserted: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub links: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub project: Option<String>,
    pub include_global: bool,
    pub kinds: Vec<String>,
    pub source_types: Vec<String>,
    pub limit: usize,
}
