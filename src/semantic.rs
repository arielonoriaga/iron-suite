use std::path::Path;

use anyhow::{Result, bail, ensure};

use crate::intelligence::{read_private_bytes, sidecar_path, write_private_atomic};
use crate::store::Store;

pub const SEMANTIC_DIM: usize = 512;
const MAGIC: &[u8; 8] = b"IRONSEM1";
const MAX_SEMANTIC_BYTES: u64 = 64 * 1024 * 1024;
const MIN_COSINE_SCORE: f32 = 0.16;

/// Generic bilingual (EN/ES) software-engineering concept clusters so conceptual
/// queries ("billing retry" / "reintento factura") share semantic dimensions
/// without external models or cloud APIs.
const CONCEPT_GROUPS: &[(&str, &[&str])] = &[
    ("concept:retry", &["retry", "retries", "backoff", "jitter", "reintento", "reintentar", "exponential", "idempotent", "idempotency"]),
    ("concept:auth", &["auth", "authentication", "authorization", "jwt", "oauth", "pkce", "jwks", "token", "login", "session", "sesion", "rbac", "permission", "permiso", "autenticacion"]),
    ("concept:lock", &["lock", "deadlock", "mutex", "advisory", "concurrency", "concurrent", "race", "contencion", "bloqueo", "flock"]),
    ("concept:billing", &["billing", "invoice", "invoicing", "payment", "payments", "checkout", "refund", "ledger", "settlement", "factura", "facturacion", "comprobante", "cobro", "pago"]),
    ("concept:cache", &["cache", "redis", "ttl", "evict", "eviction", "memoize", "invalidation", "stale"]),
    ("concept:deploy", &["deploy", "deployment", "rollout", "release", "systemd", "docker", "container", "vps", "nginx", "restart", "despliegue"]),
    ("concept:test", &["test", "tests", "testing", "flake", "flaky", "assert", "assertion", "mock", "stub", "fixture", "regression", "prueba"]),
    ("concept:db", &["database", "sql", "sqlite", "postgres", "postgresql", "fts", "fts5", "wal", "migration", "migracion", "schema", "query", "index", "vacuum", "checkpoint"]),
    ("concept:security", &["security", "csrf", "xss", "symlink", "toctou", "injection", "secret", "credential", "redact", "rebinding", "csp", "seguridad"]),
    ("concept:graph", &["graph", "node", "edge", "link", "anchor", "cluster", "bubble", "zone", "constellation", "grafo", "nodo"]),
    ("concept:perf", &["perf", "performance", "latency", "throughput", "flamegraph", "profile", "bottleneck", "memory", "oom", "cpu", "rendimiento", "latencia"]),
    ("concept:queue", &["queue", "worker", "outbox", "dlq", "webhook", "job", "async", "cola", "requeue"]),
    ("concept:tenant", &["tenant", "tenancy", "isolation", "company", "org", "scope", "aislamiento"]),
    ("concept:backup", &["backup", "snapshot", "restore", "archive", "respaldo", "copia"]),
];

fn fnv1a_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Splits `camelCase`, `PascalCase`, `snake_case`, and punctuation into lowercase sub-tokens.
pub fn split_identifier_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut prev_lower_or_digit = false;

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            let is_upper = ch.is_uppercase();
            if is_upper && prev_lower_or_digit && !current.is_empty() {
                if current.len() >= 2 {
                    out.push(current.to_lowercase());
                }
                current.clear();
            }
            current.push(ch);
            prev_lower_or_digit = ch.is_lowercase() || ch.is_ascii_digit();
        } else {
            if current.len() >= 2 {
                out.push(current.to_lowercase());
            }
            current.clear();
            prev_lower_or_digit = false;
        }
    }
    if current.len() >= 2 {
        out.push(current.to_lowercase());
    }
    out
}

fn fold_diacritic(ch: char) -> char {
    match ch {
        'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        other => other,
    }
}

fn normalize_word(w: &str) -> String {
    w.chars().map(fold_diacritic).collect()
}

fn add_feature(vec: &mut [f32; SEMANTIC_DIM], key: &str, weight: f32) {
    let h = fnv1a_hash(key.as_bytes());
    let bucket = (h as usize) % SEMANTIC_DIM;
    let sign = if (h >> 63) == 0 { 1.0 } else { -1.0 };
    vec[bucket] += sign * weight;
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has",
    "had", "not", "but", "into", "when", "where", "which", "while", "only", "also", "then",
    "than", "use", "using", "used", "all", "any", "each", "can", "will", "should", "must",
    "para", "como", "con", "los", "las", "que", "del", "una", "uno", "por", "sin", "sobre",
];

fn add_tokens(vec: &mut [f32; SEMANTIC_DIM], text: &str, base_weight: f32) {
    let tokens = split_identifier_tokens(text);
    let mut tf: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut concept_tf: std::collections::HashMap<&'static str, usize> =
        std::collections::HashMap::new();

    for raw in tokens.iter().take(800) {
        let word = normalize_word(raw);
        if word.len() < 2 || STOPWORDS.contains(&word.as_str()) {
            continue;
        }
        *tf.entry(word.clone()).or_insert(0) += 1;
        for (concept, members) in CONCEPT_GROUPS {
            if members.contains(&word.as_str()) {
                *concept_tf.entry(*concept).or_insert(0) += 1;
            }
        }
    }

    for (word, count) in &tf {
        let sublinear = 1.0 + (*count as f32).ln();
        let w = base_weight * sublinear;
        add_feature(vec, &format!("w:{word}"), w * 1.4);

        let chars: Vec<char> = word.chars().collect();
        if chars.len() >= 4 {
            for win in chars.windows(3).take(10) {
                let g: String = win.iter().collect();
                add_feature(vec, &format!("3:{g}"), w * 0.40);
            }
            for win in chars.windows(4).take(8) {
                let g: String = win.iter().collect();
                add_feature(vec, &format!("4:{g}"), w * 0.60);
            }
        }
    }

    for (concept, count) in &concept_tf {
        let sublinear = 1.0 + (*count as f32).ln();
        add_feature(vec, concept, base_weight * sublinear * 2.6);
    }
}

pub fn embed_text(title: &str, content: &str) -> [f32; SEMANTIC_DIM] {
    let mut vec = [0.0f32; SEMANTIC_DIM];
    add_tokens(&mut vec, title, 2.2);
    let sample_end = content
        .char_indices()
        .take_while(|(idx, _)| *idx < 12_288)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    add_tokens(&mut vec, &content[..sample_end], 1.0);

    let norm_sq: f32 = vec.iter().map(|x| x * x).sum();
    if norm_sq > 1e-12 {
        let inv = 1.0 / norm_sq.sqrt();
        for x in &mut vec {
            *x *= inv;
        }
    }
    vec
}

fn dot(a: &[f32; SEMANTIC_DIM], b: &[f32; SEMANTIC_DIM]) -> f32 {
    let mut s = 0.0f32;
    for i in 0..SEMANTIC_DIM {
        s += a[i] * b[i];
    }
    s
}

struct SemanticEntry {
    id: String,
    project: String,
    source_type: String,
    vector: [f32; SEMANTIC_DIM],
}

fn encode_source_type(s: &str) -> u8 {
    match s {
        "markdown" => 1,
        "iron" => 2,
        _ => 0,
    }
}

fn decode_source_type(b: u8) -> &'static str {
    match b {
        1 => "markdown",
        2 => "iron",
        _ => "other",
    }
}

pub fn rebuild_index(db: &Path, store: &Store) -> Result<usize> {
    let Some(path) = sidecar_path(db, "semantic.idx") else {
        return Ok(0);
    };
    let mut entries = Vec::new();
    for source_type in ["markdown", "iron"] {
        for rec in store.list_records(source_type, &[])? {
            let vector = embed_text(&rec.title, &rec.content);
            entries.push(SemanticEntry {
                id: rec.id,
                project: rec.project,
                source_type: rec.source_type,
                vector,
            });
        }
    }

    let count = entries.len();
    let mut buf = Vec::with_capacity(16 + count.min(30_000) * (64 + SEMANTIC_DIM * 4));
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&(SEMANTIC_DIM as u32).to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // patched with actual written count below
    let mut written = 0u32;
    for e in &entries {
        let id_b = e.id.as_bytes();
        let proj_b = e.project.as_bytes();
        ensure!(id_b.len() <= u16::MAX as usize && proj_b.len() <= u16::MAX as usize);
        let entry_len = 2 + id_b.len() + 2 + proj_b.len() + 1 + SEMANTIC_DIM * 4;
        if (buf.len() + entry_len) as u64 > MAX_SEMANTIC_BYTES {
            break;
        }
        buf.extend_from_slice(&(id_b.len() as u16).to_le_bytes());
        buf.extend_from_slice(id_b);
        buf.extend_from_slice(&(proj_b.len() as u16).to_le_bytes());
        buf.extend_from_slice(proj_b);
        buf.push(encode_source_type(&e.source_type));
        for &v in &e.vector {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        written += 1;
    }
    buf[12..16].copy_from_slice(&written.to_le_bytes());

    write_private_atomic(&path, &buf, "semantic index")?;
    Ok(written as usize)
}

fn load_entries(db: &Path) -> Result<Vec<SemanticEntry>> {
    let Some(path) = sidecar_path(db, "semantic.idx") else {
        return Ok(Vec::new());
    };
    let Some(bytes) = read_private_bytes(&path, MAX_SEMANTIC_BYTES, "semantic index")? else {
        return Ok(Vec::new());
    };
    if bytes.len() < 16 || &bytes[0..8] != MAGIC {
        bail!("corrupt semantic index header");
    }
    let dim = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    ensure!(dim == SEMANTIC_DIM, "unsupported semantic index dimension {dim}");
    let count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let min_entry_bytes = 2 + 2 + 1 + SEMANTIC_DIM * 4;
    let max_possible = (bytes.len() - 16) / min_entry_bytes;
    ensure!(
        count <= max_possible,
        "corrupt semantic index entry count {count} exceeds file capacity {max_possible}"
    );
    let mut pos = 16usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        ensure!(
            pos.checked_add(2).is_some_and(|end| end <= bytes.len()),
            "truncated semantic index"
        );
        let id_len = u16::from_le_bytes(bytes[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        ensure!(
            pos.checked_add(id_len)
                .and_then(|p| p.checked_add(2))
                .is_some_and(|end| end <= bytes.len()),
            "truncated semantic index id"
        );
        let id = std::str::from_utf8(&bytes[pos..pos + id_len])?.to_owned();
        pos += id_len;
        let proj_len = u16::from_le_bytes(bytes[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        let vec_bytes = SEMANTIC_DIM * 4;
        ensure!(
            pos.checked_add(proj_len)
                .and_then(|p| p.checked_add(1))
                .and_then(|p| p.checked_add(vec_bytes))
                .is_some_and(|end| end <= bytes.len()),
            "truncated semantic index entry"
        );
        let project = std::str::from_utf8(&bytes[pos..pos + proj_len])?.to_owned();
        pos += proj_len;
        let source_type = decode_source_type(bytes[pos]).to_owned();
        pos += 1;
        let mut vector = [0.0f32; SEMANTIC_DIM];
        for slot in &mut vector {
            *slot = f32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
            pos += 4;
        }
        out.push(SemanticEntry {
            id,
            project,
            source_type,
            vector,
        });
    }
    ensure!(pos == bytes.len(), "trailing bytes in semantic index");
    Ok(out)
}

pub fn search_semantic(
    db: &Path,
    query: &str,
    project: Option<&str>,
    include_global: bool,
    allowed_source_types: &[String],
    limit: usize,
) -> Result<Vec<(String, f32)>> {
    if limit == 0 || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries = load_entries(db)?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let qv = embed_text("", query);
    let q_norm: f32 = qv.iter().map(|x| x * x).sum();
    if q_norm <= 1e-12 {
        return Ok(Vec::new());
    }

    let mut scored = Vec::new();
    for e in &entries {
        if let Some(p) = project {
            let ok = e.project == p || (include_global && e.project == "*");
            if !ok {
                continue;
            }
        }
        if !allowed_source_types.is_empty()
            && !allowed_source_types.iter().any(|s| s == &e.source_type)
        {
            continue;
        }
        let sim = dot(&qv, &e.vector);
        if sim >= MIN_COSINE_SCORE {
            scored.push((e.id.clone(), sim));
        }
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scored.truncate(limit);
    Ok(scored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ImportBatch, MemoryRecord};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn semantic_index_matches_conceptual_bilingual_queries_and_enforces_filters() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");
        let mut store = Store::open(&db, true).unwrap();
        store
            .apply(&ImportBatch {
                groups: vec!["seed".into()],
                records: vec![
                    MemoryRecord {
                        id: "rec_retry".into(),
                        source_group: "seed".into(),
                        source_key: "r1".into(),
                        source_type: "markdown".into(),
                        kind: "curated".into(),
                        project: "acme".into(),
                        title: "Invoice backoff strategy".into(),
                        content: "Use exponential backoff with jitter on payment gateway 502s.".into(),
                        source_path: "/mem/r1.md".into(),
                        updated_at: 1_700_000_000_000,
                        metadata: json!({}),
                    },
                    MemoryRecord {
                        id: "rec_auth".into(),
                        source_group: "seed".into(),
                        source_key: "r2".into(),
                        source_type: "iron".into(),
                        kind: "decision".into(),
                        project: "acme".into(),
                        title: "JWT rotation window".into(),
                        content: "Keep old JWKS key active 15 minutes during token rotation.".into(),
                        source_path: "native://iron/r2".into(),
                        updated_at: 1_700_000_000_000,
                        metadata: json!({}),
                    },
                ],
                ..Default::default()
            })
            .unwrap();

        let n = rebuild_index(&db, &store).unwrap();
        assert_eq!(n, 2);

        // Conceptual bilingual query ("reintento facturacion") has ZERO exact keyword overlap
        // with "Invoice backoff strategy" yet ranks rec_retry #1 via concept + n-grams!
        let hits = search_semantic(&db, "reintento facturacion", Some("acme"), true, &[], 5).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].0, "rec_retry");

        // Reviewer role filter (`markdown` only) excludes native `iron` records
        let md_only = search_semantic(
            &db,
            "oauth login session",
            Some("acme"),
            true,
            &["markdown".into()],
            5,
        )
        .unwrap();
        assert!(md_only.iter().all(|(id, _)| id != "rec_auth"));

        // P1-1 regression: crafted 16-byte header claiming 100_000 entries fails fast without OOM
        let path = sidecar_path(&db, "semantic.idx").unwrap();
        let mut bad = Vec::new();
        bad.extend_from_slice(MAGIC);
        bad.extend_from_slice(&(SEMANTIC_DIM as u32).to_le_bytes());
        bad.extend_from_slice(&100_000u32.to_le_bytes());
        std::fs::write(&path, &bad).unwrap();
        assert!(load_entries(&db).is_err());
    }
}
