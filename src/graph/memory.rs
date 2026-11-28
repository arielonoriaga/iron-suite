use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::aliases::{AliasMap, load as load_aliases, resolve as resolve_alias};
use crate::drift::extract_repo_paths;
use crate::intelligence::is_superseded;
use crate::model::MemoryRecord;
use crate::output;
use crate::store::{Store, canonical_project_root};

use super::store::{ChunkRow, GraphStore, RemovedChunkRow};
use super::types::{ChunkKind, HttpMethod, StaleReason};

const MAX_ATTACHED_MEMORIES: usize = 2;
const MAX_MEM_LINE_BYTES: usize = 120;
const CURATED_SOURCES: &[&str] = &["markdown", "iron"];
const MIN_BARE_SYMBOL_LEN: usize = 6;
const TRIM_PATH_CHARS: &[char] = &['.', '/'];
const TRIM_SYM_CHARS: &[char] = &['.', ':', '-'];
const GENERIC_SYMBOLS: &[&str] = &[
    "create",
    "update",
    "delete",
    "remove",
    "insert",
    "select",
    "default",
    "handler",
    "router",
    "routes",
    "client",
    "server",
    "config",
    "result",
    "status",
    "health",
    "format",
    "render",
    "validate",
    "handle",
    "process",
    "execute",
    "frontmatter",
];

static PATH_SYMBOL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[\s`(\x22'])([A-Za-z0-9_./-]+\.(?:rs|ts|tsx|js|jsx|mjs|mts|astro))::([A-Za-z_$][A-Za-z0-9_$:.-]*)",
    )
    .expect("valid path symbol regex")
});

static TYPE_METHOD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"`([A-Z][A-Za-z0-9_]*)::([a-z_][A-Za-z0-9_]*)`")
        .expect("valid type method regex")
});

static BACKTICK_IDENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"`([A-Za-z_$][A-Za-z0-9_$:.-]{2,80})(?:\(\))?`")
        .expect("valid backtick ident regex")
});

pub struct MemoryAttachmentContext {
    pub files: Vec<(String, String)>,
    pub endpoints: Vec<(HttpMethod, String)>,
    pub chunks: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleMemoryEntry {
    pub id: String,
    pub repo: String,
    pub title: String,
    pub reason: StaleReason,
    pub anchor: String,
}

struct RankedMemory {
    score: u8,
    updated_at: i64,
    id: String,
    title: String,
}

pub fn attach_memory_lines(db: &Path, ctx: &MemoryAttachmentContext) -> Vec<String> {
    if ctx.files.is_empty() && ctx.endpoints.is_empty() && ctx.chunks.is_empty() {
        return Vec::new();
    }
    let Some((store, aliases)) = open_memory_readonly(db) else {
        return Vec::new();
    };
    find_matching_memory_lines(&store, &aliases, ctx)
}

pub fn find_stale_memories(
    graph: &GraphStore,
    memory_db: &Path,
    repo_filter: Option<&str>,
) -> Vec<StaleMemoryEntry> {
    let Some((mem_store, aliases)) = open_memory_readonly(memory_db) else {
        return Vec::new();
    };
    let Ok(repos) = graph.list_repos() else {
        return Vec::new();
    };
    let indexed_repos: Vec<String> = repos
        .into_iter()
        .map(|r| r.repo)
        .filter(|r| repo_filter.is_none_or(|f| f == r))
        .collect();
    if indexed_repos.is_empty() {
        return Vec::new();
    }
    let Ok(active_chunks) = graph.load_chunks_for_repo(repo_filter) else {
        return Vec::new();
    };
    let Ok(removed_chunks) = graph.load_removed_chunks(repo_filter) else {
        return Vec::new();
    };
    compute_stale_memories(
        &mem_store,
        &aliases,
        &indexed_repos,
        &active_chunks,
        &removed_chunks,
    )
}

fn open_memory_readonly(db: &Path) -> Option<(Store, AliasMap)> {
    let is_regular = fs::symlink_metadata(db)
        .is_ok_and(|m| !m.file_type().is_symlink() && m.is_file());
    if !is_regular {
        return None;
    }
    let store = Store::open(db, false).ok()?;
    let aliases = load_aliases(db).unwrap_or_default();
    Some((store, aliases))
}

pub fn find_matching_memory_lines(
    store: &Store,
    aliases: &AliasMap,
    ctx: &MemoryAttachmentContext,
) -> Vec<String> {
    let mut files_by_project: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut chunks_by_project: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut target_projects: HashSet<String> = HashSet::new();
    for (repo, file) in &ctx.files {
        let proj = canonical_repo_project(aliases, repo);
        target_projects.insert(proj.clone());
        files_by_project
            .entry(proj)
            .or_default()
            .insert(file.trim_start_matches("./").to_owned());
    }
    for (repo, file, symbol) in &ctx.chunks {
        let proj = canonical_repo_project(aliases, repo);
        target_projects.insert(proj.clone());
        chunks_by_project
            .entry(proj)
            .or_default()
            .push((file.trim_start_matches("./").to_owned(), symbol.clone()));
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
    for rec in load_curated_records(store) {
        let score = score_record(
            &rec,
            aliases,
            &files_by_project,
            &chunks_by_project,
            &target_projects,
            &ep_tokens,
        );
        if score > 0 {
            ranked.push(RankedMemory {
                score,
                updated_at: rec.updated_at,
                id: rec.id,
                title: rec.title,
            });
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

fn load_curated_records(store: &Store) -> Vec<MemoryRecord> {
    let mut out = Vec::new();
    let mut seen_ids = HashSet::new();
    for source_type in CURATED_SOURCES {
        let Ok(records) = store.list_records(source_type, &[]) else {
            continue;
        };
        for rec in records {
            if seen_ids.insert(rec.id.clone()) && !is_superseded(store, &rec.id) {
                out.push(rec);
            }
        }
    }
    out
}

struct RepoChunkIndex<'a> {
    chunks: Vec<&'a ChunkRow>,
    by_exact: HashMap<&'a str, Vec<&'a ChunkRow>>,
    by_bare: HashMap<&'a str, Vec<&'a ChunkRow>>,
    known_types: HashSet<&'a str>,
    removed_by_name: HashMap<&'a str, &'a RemovedChunkRow>,
}

impl<'a> RepoChunkIndex<'a> {
    fn build(active: &'a [ChunkRow], removed: &'a [RemovedChunkRow]) -> HashMap<String, Self> {
        let mut map: HashMap<String, Self> = HashMap::new();
        for chunk in active {
            let entry = map.entry(chunk.repo.clone()).or_insert_with(Self::empty);
            entry.chunks.push(chunk);
            entry
                .by_exact
                .entry(chunk.qualified_name.as_str())
                .or_default()
                .push(chunk);
            let bare = bare_symbol(&chunk.qualified_name);
            entry.by_bare.entry(bare).or_default().push(chunk);
            if matches!(chunk.kind, ChunkKind::Struct | ChunkKind::Enum) {
                entry.known_types.insert(chunk.qualified_name.as_str());
            }
            if let Some((ty, _)) = chunk.qualified_name.split_once("::") {
                entry.known_types.insert(ty);
            }
        }
        for rem in removed {
            let entry = map.entry(rem.repo.clone()).or_insert_with(Self::empty);
            entry
                .removed_by_name
                .entry(rem.qualified_name.as_str())
                .or_insert(rem);
            let bare = bare_symbol(&rem.qualified_name);
            entry.removed_by_name.entry(bare).or_insert(rem);
        }
        map
    }

    fn empty() -> Self {
        Self {
            chunks: Vec::new(),
            by_exact: HashMap::new(),
            by_bare: HashMap::new(),
            known_types: HashSet::new(),
            removed_by_name: HashMap::new(),
        }
    }

    fn find_for_file_and_symbol(&self, cited_file: &str, symbol: &str) -> Vec<&'a ChunkRow> {
        self.chunks
            .iter()
            .copied()
            .filter(|c| repo_paths_match(cited_file, &c.file) && symbol_matches_chunk(symbol, &c.qualified_name))
            .collect()
    }

    fn find_by_symbol(&self, symbol: &str) -> Vec<&'a ChunkRow> {
        if let Some(exact) = self.by_exact.get(symbol) {
            return exact.clone();
        }
        self.by_bare.get(symbol).cloned().unwrap_or_default()
    }
}

pub fn compute_stale_memories(
    store: &Store,
    aliases: &AliasMap,
    indexed_repos: &[String],
    active_chunks: &[ChunkRow],
    removed_chunks: &[RemovedChunkRow],
) -> Vec<StaleMemoryEntry> {
    let proj_to_repo: HashMap<String, String> = indexed_repos
        .iter()
        .map(|r| (canonical_repo_project(aliases, r), r.clone()))
        .collect();
    let index_by_repo = RepoChunkIndex::build(active_chunks, removed_chunks);
    let mut entries = Vec::new();

    for rec in load_curated_records(store) {
        let rec_proj = canonical_repo_project(aliases, &rec.project);
        let Some(repo) = proj_to_repo.get(&rec_proj) else {
            continue;
        };
        let Some(idx) = index_by_repo.get(repo) else {
            continue;
        };
        if let Some((reason, anchor)) = check_record_staleness(&rec, idx) {
            entries.push(StaleMemoryEntry {
                id: rec.id,
                repo: repo.clone(),
                title: rec.title,
                reason,
                anchor,
            });
        }
    }

    entries.sort_by(|a, b| {
        let rank = |r: StaleReason| match r {
            StaleReason::SymbolMissing => 0,
            StaleReason::ChunkChanged => 1,
        };
        rank(a.reason)
            .cmp(&rank(b.reason))
            .then_with(|| a.repo.cmp(&b.repo))
            .then_with(|| a.id.cmp(&b.id))
    });
    entries
}

fn check_record_staleness(
    rec: &MemoryRecord,
    idx: &RepoChunkIndex<'_>,
) -> Option<(StaleReason, String)> {
    let mut changed_hit: Option<String> = None;
    if let Some(missing) = check_path_symbol_anchors(rec, idx, &mut changed_hit) {
        return Some(missing);
    }
    if let Some(missing) = check_type_method_anchors(rec, idx, &mut changed_hit) {
        return Some(missing);
    }
    if let Some(missing) = check_backtick_anchors(rec, idx, &mut changed_hit) {
        return Some(missing);
    }
    changed_hit.map(|anchor| (StaleReason::ChunkChanged, anchor))
}

fn first_changed_anchor(matches: &[&ChunkRow], updated_at: i64) -> Option<String> {
    matches
        .iter()
        .find(|c| c.hash_changed_at > 0 && c.hash_changed_at > updated_at)
        .map(|c| format!("{}::{}", c.file, c.qualified_name))
}

fn check_path_symbol_anchors(
    rec: &MemoryRecord,
    idx: &RepoChunkIndex<'_>,
    changed_hit: &mut Option<String>,
) -> Option<(StaleReason, String)> {
    let mentions = extract_path_symbol_mentions(&rec.title)
        .into_iter()
        .chain(extract_path_symbol_mentions(&rec.content));
    for (cited_file, sym) in mentions {
        let matches = idx.find_for_file_and_symbol(&cited_file, &sym);
        if matches.is_empty() {
            return Some((StaleReason::SymbolMissing, format!("{cited_file}::{sym}")));
        }
        if changed_hit.is_none() {
            *changed_hit = first_changed_anchor(&matches, rec.updated_at);
        }
    }
    None
}

fn check_type_method_anchors(
    rec: &MemoryRecord,
    idx: &RepoChunkIndex<'_>,
    changed_hit: &mut Option<String>,
) -> Option<(StaleReason, String)> {
    let mentions = extract_type_method_mentions(&rec.title)
        .into_iter()
        .chain(extract_type_method_mentions(&rec.content));
    for (ty, method) in mentions {
        if !idx.known_types.contains(ty.as_str()) {
            continue;
        }
        let qname = format!("{ty}::{method}");
        let matches = idx.find_by_symbol(&qname);
        if matches.is_empty() {
            return Some((StaleReason::SymbolMissing, qname));
        }
        if changed_hit.is_none() {
            *changed_hit = first_changed_anchor(&matches, rec.updated_at);
        }
    }
    None
}

fn check_backtick_anchors(
    rec: &MemoryRecord,
    idx: &RepoChunkIndex<'_>,
    changed_hit: &mut Option<String>,
) -> Option<(StaleReason, String)> {
    let cited_files = extract_repo_paths(&rec.content);
    let mentions = extract_backtick_symbols(&rec.title)
        .into_iter()
        .chain(extract_backtick_symbols(&rec.content));
    for tok in mentions {
        if !is_distinctive_symbol(&tok) {
            continue;
        }
        let matches = idx.find_by_symbol(&tok);
        if !matches.is_empty() {
            let scoped = scope_chunks_to_cited(&matches, &cited_files);
            if changed_hit.is_none() {
                *changed_hit = first_changed_anchor(&scoped, rec.updated_at);
            }
        } else if let Some(rem) = idx.removed_by_name.get(tok.as_str()) {
            return Some((
                StaleReason::SymbolMissing,
                format!("{}::{}", rem.file, rem.qualified_name),
            ));
        }
    }
    None
}

fn scope_chunks_to_cited<'a>(matches: &[&'a ChunkRow], cited_files: &[String]) -> Vec<&'a ChunkRow> {
    if cited_files.is_empty() {
        return matches.to_vec();
    }
    let in_cited: Vec<&ChunkRow> = matches
        .iter()
        .copied()
        .filter(|c| cited_files.iter().any(|f| repo_paths_match(f, &c.file)))
        .collect();
    if in_cited.is_empty() {
        matches.to_vec()
    } else {
        in_cited
    }
}

fn extract_path_symbol_mentions(text: &str) -> Vec<(String, String)> {
    let mut seen = BTreeSet::new();
    let sample = bounded_sample(text);
    for caps in PATH_SYMBOL_RE.captures_iter(sample) {
        let file = caps[1].trim_matches(TRIM_PATH_CHARS);
        let sym = caps[2].trim_end_matches(TRIM_SYM_CHARS);
        if !file.is_empty() && !sym.is_empty() && !file.contains("..") {
            seen.insert((file.to_owned(), sym.to_owned()));
        }
    }
    seen.into_iter().collect()
}

fn extract_type_method_mentions(text: &str) -> Vec<(String, String)> {
    let mut seen = BTreeSet::new();
    for caps in TYPE_METHOD_RE.captures_iter(bounded_sample(text)) {
        seen.insert((caps[1].to_owned(), caps[2].to_owned()));
    }
    seen.into_iter().collect()
}

fn extract_backtick_symbols(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for caps in BACKTICK_IDENT_RE.captures_iter(bounded_sample(text)) {
        let raw = caps[1].trim_end_matches('.');
        if !raw.is_empty() && !raw.contains('/') && !raw.contains(' ') {
            seen.insert(raw.to_owned());
        }
    }
    seen.into_iter().collect()
}

fn bounded_sample(text: &str) -> &str {
    let end = text
        .char_indices()
        .take_while(|(idx, _)| *idx < 24_576)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    &text[..end]
}

fn bare_symbol(qualified: &str) -> &str {
    qualified
        .rsplit_once("::")
        .or_else(|| qualified.rsplit_once('.'))
        .map_or(qualified, |(_, tail)| tail)
}

fn symbol_matches_chunk(mentioned: &str, qualified_name: &str) -> bool {
    mentioned == qualified_name
        || bare_symbol(qualified_name) == mentioned
        || qualified_name.ends_with(&format!("::{mentioned}"))
        || qualified_name.ends_with(&format!(".{mentioned}"))
}

fn is_distinctive_symbol(sym: &str) -> bool {
    if sym.contains("::") || sym.contains('.') {
        return sym.len() >= 5;
    }
    if sym.len() < MIN_BARE_SYMBOL_LEN {
        return false;
    }
    let lower = sym.to_ascii_lowercase();
    if GENERIC_SYMBOLS.contains(&lower.as_str()) {
        return false;
    }
    sym.contains('_')
        || (sym.bytes().any(|b| b.is_ascii_uppercase()) && sym.bytes().any(|b| b.is_ascii_lowercase()))
}

fn canonical_repo_project(aliases: &AliasMap, name: &str) -> String {
    canonical_project_root(&resolve_alias(aliases, name))
}

fn score_record(
    rec: &MemoryRecord,
    aliases: &AliasMap,
    files_by_project: &HashMap<String, BTreeSet<String>>,
    chunks_by_project: &HashMap<String, Vec<(String, String)>>,
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

    let (path_sym_hit, sym_hit) = match chunks_by_project.get(&rec_proj) {
        Some(target_chunks) if !target_chunks.is_empty() => {
            let mut ps_mentions = extract_path_symbol_mentions(&rec.title);
            ps_mentions.extend(extract_path_symbol_mentions(&rec.content));
            let ps_hit = ps_mentions.iter().any(|(pf, sym)| {
                target_chunks
                    .iter()
                    .any(|(cf, cq)| repo_paths_match(pf, cf) && symbol_matches_chunk(sym, cq))
            });
            let s_hit = target_chunks.iter().any(|(_, cq)| {
                contains_symbol_mention(&rec.title, &rec.content, cq)
            });
            (ps_hit, s_hit)
        }
        _ => (false, false),
    };

    let token_hit = !ep_tokens.is_empty()
        && ep_tokens
            .iter()
            .any(|tok| contains_endpoint_token(&rec.title, tok) || contains_endpoint_token(&rec.content, tok));

    if path_sym_hit {
        return 5;
    }
    match (path_hit, token_hit || sym_hit, in_project) {
        (true, true, _) => 4,
        (true, false, _) => 3,
        (false, true, true) => 2,
        (false, true, false) => 1,
        (false, false, _) => 0,
    }
}

fn contains_symbol_mention(title: &str, content: &str, qualified_name: &str) -> bool {
    if is_distinctive_symbol(qualified_name)
        && (contains_ident_token(title, qualified_name) || contains_ident_token(content, qualified_name))
    {
        return true;
    }
    let bare = bare_symbol(qualified_name);
    bare != qualified_name
        && is_distinctive_symbol(bare)
        && (contains_ident_token(title, bare) || contains_ident_token(content, bare))
}

fn contains_ident_token(text: &str, token: &str) -> bool {
    let bytes = text.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(token) {
        let abs = from + rel;
        let end = abs + token.len();
        let left_ok = abs == 0 || !is_ident_boundary_byte(bytes[abs - 1]);
        let right_ok = end == bytes.len() || !is_ident_boundary_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        from = abs + 1;
    }
    false
}

fn is_ident_boundary_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
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
            chunks: Vec::new(),
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
    fn attaches_via_path_symbol_and_detects_stale_memories() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");
        let _ = Store::open(&db, true).unwrap();
        let id_changed = add_note(
            &db,
            "ez-commerce",
            "Idempotency rules for invoice handler",
            "See `src/contexts/integrations/api_internal.rs::create_agnostic_invoice_idempotent`.",
        );
        let id_missing = add_note(
            &db,
            "ez-commerce",
            "Old handler note",
            "Relies on `src/contexts/integrations/api_internal.rs::deleted_invoice_fn`.",
        );
        let id_fresh = add_note(
            &db,
            "ez-commerce",
            "Unchanged struct note",
            "Uses `AgnosticInvoiceRequest`.",
        );

        let store = Store::open(&db, false).unwrap();
        let aliases = AliasMap::new();
        let ctx = MemoryAttachmentContext {
            files: Vec::new(),
            endpoints: Vec::new(),
            chunks: vec![(
                "ez-commerce".to_owned(),
                "backend/src/contexts/integrations/api_internal.rs".to_owned(),
                "create_agnostic_invoice_idempotent".to_owned(),
            )],
        };
        let attached = find_matching_memory_lines(&store, &aliases, &ctx);
        assert_eq!(attached.len(), 1);
        assert!(attached[0].contains(&id_changed), "attached={attached:?}");

        let future_ts = crate::intelligence::now_ms() + 10_000;
        let active = vec![
            ChunkRow {
                id: 1,
                repo: "ez-commerce".to_owned(),
                file: "backend/src/contexts/integrations/api_internal.rs".to_owned(),
                kind: ChunkKind::Fn,
                qualified_name: "create_agnostic_invoice_idempotent".to_owned(),
                start_line: 85,
                end_line: 110,
                norm_hash: "2222222222222222".to_owned(),
                first_seen_hash: "1111111111111111".to_owned(),
                first_seen_at: 1000,
                hash_changed_at: future_ts,
            },
            ChunkRow {
                id: 2,
                repo: "ez-commerce".to_owned(),
                file: "backend/src/contexts/integrations/api_internal.rs".to_owned(),
                kind: ChunkKind::Struct,
                qualified_name: "AgnosticInvoiceRequest".to_owned(),
                start_line: 50,
                end_line: 65,
                norm_hash: "aaaaaaaaaaaaaaaa".to_owned(),
                first_seen_hash: "aaaaaaaaaaaaaaaa".to_owned(),
                first_seen_at: 1000,
                hash_changed_at: 0,
            },
        ];
        let stale = compute_stale_memories(
            &store,
            &aliases,
            &["ez-commerce".to_owned()],
            &active,
            &[],
        );
        assert_eq!(stale.len(), 2, "stale={stale:?}");
        assert!(stale.iter().any(|s| s.id == id_missing && s.reason == StaleReason::SymbolMissing));
        assert!(stale.iter().any(|s| s.id == id_changed && s.reason == StaleReason::ChunkChanged));
        assert!(!stale.iter().any(|s| s.id == id_fresh));
    }

    #[test]
    fn skips_silently_when_memory_db_absent() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("missing.db");
        let ctx = MemoryAttachmentContext {
            files: vec![("ez-addon".to_owned(), "src/a.rs".to_owned())],
            endpoints: vec![],
            chunks: vec![],
        };
        assert!(attach_memory_lines(&missing, &ctx).is_empty());
    }
}
