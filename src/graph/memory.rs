use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::aliases::{AliasMap, load as load_aliases, resolve as resolve_alias};
use crate::drift::extract_repo_paths;
use crate::intelligence::is_superseded;
use crate::model::MemoryRecord;
use crate::output;
use crate::store::{Store, canonical_project_root};

use super::types::HttpMethod;

const MAX_ATTACHED_MEMORIES: usize = 2;
const MAX_MEM_LINE_BYTES: usize = 120;
const CURATED_SOURCES: &[&str] = &["markdown", "iron"];

pub struct MemoryAttachmentContext {
    pub files: Vec<(String, String)>,
    pub endpoints: Vec<(HttpMethod, String)>,
}

struct RankedMemory {
    score: u8,
    updated_at: i64,
    id: String,
    title: String,
}

pub fn attach_memory_lines(db: &Path, ctx: &MemoryAttachmentContext) -> Vec<String> {
    if ctx.files.is_empty() && ctx.endpoints.is_empty() {
        return Vec::new();
    }
    let is_regular = fs::symlink_metadata(db)
        .is_ok_and(|m| !m.file_type().is_symlink() && m.is_file());
    if !is_regular {
        return Vec::new();
    }
    let Ok(store) = Store::open(db, false) else {
        return Vec::new();
    };
    let aliases = load_aliases(db).unwrap_or_default();
    find_matching_memory_lines(&store, &aliases, ctx)
}

pub fn find_matching_memory_lines(
    store: &Store,
    aliases: &AliasMap,
    ctx: &MemoryAttachmentContext,
) -> Vec<String> {
    let mut files_by_project: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut target_projects: HashSet<String> = HashSet::new();
    for (repo, file) in &ctx.files {
        let proj = canonical_repo_project(aliases, repo);
        target_projects.insert(proj.clone());
        files_by_project
            .entry(proj)
            .or_default()
            .insert(file.trim_start_matches("./").to_owned());
    }
    let ep_tokens: Vec<String> = ctx
        .endpoints
        .iter()
        .filter(|(_, p)| !p.is_empty())
        .map(|(m, p)| format!("{} {p}", m.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let mut ranked = Vec::new();
    let mut seen_ids = HashSet::new();
    for source_type in CURATED_SOURCES {
        let Ok(records) = store.list_records(source_type, &[]) else {
            continue;
        };
        for rec in records {
            if !seen_ids.insert(rec.id.clone()) || is_superseded(store, &rec.id) {
                continue;
            }
            let score = score_record(&rec, aliases, &files_by_project, &target_projects, &ep_tokens);
            if score > 0 {
                ranked.push(RankedMemory {
                    score,
                    updated_at: rec.updated_at,
                    id: rec.id,
                    title: rec.title,
                });
            }
        }
    }

    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    ranked
        .into_iter()
        .take(MAX_ATTACHED_MEMORIES)
        .map(|m| format_memory_line(&m.id, &m.title))
        .collect()
}

fn canonical_repo_project(aliases: &AliasMap, name: &str) -> String {
    canonical_project_root(&resolve_alias(aliases, name))
}

fn score_record(
    rec: &MemoryRecord,
    aliases: &AliasMap,
    files_by_project: &HashMap<String, BTreeSet<String>>,
    target_projects: &HashSet<String>,
    ep_tokens: &[String],
) -> u8 {
    let rec_proj = canonical_repo_project(aliases, &rec.project);
    let in_project = target_projects.contains(&rec_proj);

    let path_hit = if let Some(target_files) = files_by_project.get(&rec_proj) {
        let cited = extract_repo_paths(&rec.content);
        cited
            .iter()
            .any(|c| target_files.iter().any(|f| repo_paths_match(c, f)))
    } else {
        false
    };

    let token_hit = !ep_tokens.is_empty()
        && ep_tokens
            .iter()
            .any(|tok| contains_endpoint_token(&rec.title, tok) || contains_endpoint_token(&rec.content, tok));

    match (path_hit, token_hit, in_project) {
        (true, true, _) => 4,
        (true, false, _) => 3,
        (false, true, true) => 2,
        (false, true, false) => 1,
        (false, false, _) => 0,
    }
}

fn repo_paths_match(cited: &str, target: &str) -> bool {
    let c = cited.trim_start_matches("./");
    let t = target.trim_start_matches("./");
    c == t
        || t.ends_with(&format!("/{c}"))
        || c.ends_with(&format!("/{t}"))
}

fn contains_endpoint_token(text: &str, token: &str) -> bool {
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(token) {
        let abs = from + rel;
        let end = abs + token.len();
        let left_ok = abs == 0
            || !text.as_bytes()[abs - 1].is_ascii_alphanumeric();
        let right_ok = end == text.len()
            || matches!(
                text.as_bytes()[end],
                b' ' | b'\t' | b'\r' | b'\n' | b'`' | b'"' | b'\'' | b')' | b']' | b',' | b'.' | b';' | b':' | b'?'
            );
        if left_ok && right_ok {
            return true;
        }
        from = abs + 1;
    }
    false
}

pub fn format_memory_line(id: &str, title: &str) -> String {
    let clean_title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "'");
    let prefix = format!("mem: {id} \"");
    let overhead = prefix.len() + 1;
    if overhead >= MAX_MEM_LINE_BYTES {
        return output::prefix(&format!("mem: {id}"), MAX_MEM_LINE_BYTES).to_owned();
    }
    let avail = MAX_MEM_LINE_BYTES - overhead;
    let clipped = output::prefix(&clean_title, avail).trim_end();
    format!("{prefix}{clipped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::{RememberRequest, remember};
    use tempfile::TempDir;

    fn add_note(db: &Path, project: &str, title: &str, content: &str) -> String {
        let res = remember(
            db,
            RememberRequest {
                title: title.to_owned(),
                content: content.to_owned(),
                project: project.to_owned(),
                kind: Some("decision".to_owned()),
                agent: None,
                supersedes: Vec::new(),
            },
        )
        .unwrap();
        res["id"].as_str().unwrap().to_owned()
    }

    #[test]
    fn attaches_at_most_two_memories_via_alias_path_anchor_and_endpoint_token_under_120_bytes() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");
        let _ = Store::open(&db, true).unwrap();
        let id1 = add_note(
            &db,
            "ez-stock",
            "Invoice integration invariants with a deliberately very long descriptive title exceeding one hundred twenty bytes easily when formatted",
            "Handles `src/contexts/integrations/api_internal.rs` and POST /api/internal/invoices.",
        );
        let id2 = add_note(
            &db,
            "ez-addon",
            "Cochera calls ez-commerce for CAE",
            "Client lives in `src/modules/cochera/ez_commerce.rs`.",
        );
        let _id3 = add_note(
            &db,
            "other-proj",
            "Mentions POST /api/internal/invoices",
            "See POST /api/internal/invoices.",
        );

        let mut aliases = AliasMap::new();
        aliases.insert("ez-stock".to_owned(), "ez-commerce".to_owned());

        let store = Store::open(&db, false).unwrap();
        let ctx = MemoryAttachmentContext {
            files: vec![
                (
                    "ez-commerce".to_owned(),
                    "backend/src/contexts/integrations/api_internal.rs".to_owned(),
                ),
                (
                    "ez-addon".to_owned(),
                    "src/modules/cochera/ez_commerce.rs".to_owned(),
                ),
            ],
            endpoints: vec![(HttpMethod::Post, "/api/internal/invoices".to_owned())],
        };
        let lines = find_matching_memory_lines(&store, &aliases, &ctx);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with(&format!("mem: {id1} \"")), "line0={}", lines[0]);
        assert!(lines[1].starts_with(&format!("mem: {id2} \"")), "line1={}", lines[1]);
        for line in &lines {
            assert!(line.len() <= MAX_MEM_LINE_BYTES, "len={} line={line}", line.len());
        }
    }

    #[test]
    fn skips_silently_when_memory_db_absent() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("missing.db");
        let ctx = MemoryAttachmentContext {
            files: vec![("ez-addon".to_owned(), "src/a.rs".to_owned())],
            endpoints: vec![],
        };
        assert!(attach_memory_lines(&missing, &ctx).is_empty());
    }
}
