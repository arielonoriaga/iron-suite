use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;
use std::thread;

use anyhow::{Context, Result, bail};
use regex::Regex;

use crate::output;

const MAX_CHAIN_HOPS: usize = 16;

static TS_LOCAL_PATH_CONST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*["'`](/[^"'`\s]*)["'`]"#,
    )
    .expect("valid local path const regex")
});

static TS_IMPORT_STMT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?ms)\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$][A-Za-z0-9_$]*))\s+from\s+["']([^"']+)["']"#,
    )
    .expect("valid ts import regex")
});

static TS_METHOD_PROP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]"#).expect("valid ts method prop regex")
});

static ASTRO_SCRIPT_OPEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<script\b[^>]*>").expect("valid script open regex")
});

static ASTRO_SCRIPT_CLOSE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</script>").expect("valid script close regex")
});

const ASTRO_FRONTMATTER_FENCE: &str = "---";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AstroBlock {
    pub is_frontmatter: bool,
    pub start: usize,
    pub end: usize,
}

pub fn find_astro_blocks(raw: &str) -> Vec<AstroBlock> {
    let mut blocks = Vec::new();
    let mut search_from = 0usize;
    if let Some((fm_start, fm_end)) = find_astro_frontmatter(raw) {
        blocks.push(AstroBlock {
            is_frontmatter: true,
            start: fm_start,
            end: fm_end,
        });
        search_from = fm_end;
    }
    while let Some(open_m) = ASTRO_SCRIPT_OPEN_RE.find(&raw[search_from..]) {
        let body_start = search_from + open_m.end();
        let Some(close_m) = ASTRO_SCRIPT_CLOSE_RE.find(&raw[body_start..]) else {
            break;
        };
        let body_end = body_start + close_m.start();
        blocks.push(AstroBlock {
            is_frontmatter: false,
            start: body_start,
            end: body_end,
        });
        search_from = body_start + close_m.end();
    }
    blocks
}

fn find_astro_frontmatter(raw: &str) -> Option<(usize, usize)> {
    let trimmed_start = raw.len() - raw.trim_start().len();
    let after_open = raw[trimmed_start..].strip_prefix(ASTRO_FRONTMATTER_FENCE)?;
    let nl = after_open.find('\n')?;
    let fm_start = trimmed_start + ASTRO_FRONTMATTER_FENCE.len() + nl + 1;
    let mut pos = fm_start;
    while pos < raw.len() {
        let line_end = raw[pos..].find('\n').map_or(raw.len(), |n| pos + n);
        if raw[pos..line_end].trim() == ASTRO_FRONTMATTER_FENCE {
            return Some((fm_start, pos));
        }
        pos = (line_end + 1).min(raw.len());
    }
    None
}

pub fn split_ts_object_kv<'a>(
    entry: &'a str,
    entry_offset: usize,
    mask: &[bool],
) -> Option<(&'a str, usize, &'a str)> {
    let bytes = entry.as_bytes();
    let key_start = skip_masked_ws(bytes, entry_offset, mask, 0);
    let mut pos = key_start;
    while pos < bytes.len() && is_ts_ident_byte(bytes[pos]) {
        pos += 1;
    }
    if pos == key_start {
        return None;
    }
    let key = &entry[key_start..pos];
    pos = skip_masked_ws(bytes, entry_offset, mask, pos);
    if bytes.get(pos) != Some(&b':') {
        return None;
    }
    pos = skip_masked_ws(bytes, entry_offset, mask, pos + 1);
    Some((key, entry_offset + pos, entry[pos..].trim_end()))
}

pub fn skip_masked_ws(bytes: &[u8], base_offset: usize, mask: &[bool], mut pos: usize) -> usize {
    while pos < bytes.len() && (!mask[base_offset + pos] || bytes[pos].is_ascii_whitespace()) {
        pos += 1;
    }
    pos
}

pub fn skip_masked_ws_range(bytes: &[u8], mask: &[bool], pos: usize, limit: usize) -> usize {
    skip_masked_ws(&bytes[..limit], 0, mask, pos)
}

#[derive(Debug, Clone)]
pub struct TsImportedSymbol {
    pub file: String,
    pub exported_name: String,
}

const MAX_WHY_BYTES: usize = 80;
pub(crate) const DYNAMIC_SEG: &str = "{}";
pub(crate) const ROOT_SLASH: &str = "/";
const CFG_TEST_NAME: &str = "test";
const STAGE_NORMAL: &str = "0";
const HASH_OBJECT_CHUNK: usize = 256;
const PARALLEL_MIN_ITEMS: usize = 4;
const REGULAR_FILE_MODES: &[&str] = &["100644", "100755"];
const TEST_DIRS: &[&str] = &[
    "tests",
    "test",
    "test_support",
    "test-support",
    "__tests__",
    "__mocks__",
    "benches",
    "e2e",
];
const RUST_TEST_STEMS: &[&str] = &["tests", "test", "test_support"];
const TS_JS_EXTS: &[&str] = &[".tsx", ".ts", ".jsx", ".js", ".mts", ".cts", ".mjs"];
const TS_SCAN_EXTS: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
const WEB_SCAN_EXTS: &[&str] = &[".astro", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
const NGINX_EXT: &str = ".conf";
const TS_IMPORT_EXTS: &[&str] = &[
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".js",
    ".jsx",
    ".mjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
];

pub struct LineIndex {
    line_starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut line_starts = vec![0usize];
        for (idx, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_starts.push(idx + 1);
            }
        }
        Self { line_starts }
    }

    pub fn line_at(&self, byte_pos: usize) -> usize {
        match self.line_starts.binary_search(&byte_pos) {
            Ok(idx) => idx + 1,
            Err(idx) => idx,
        }
    }
}

fn run_git_stdout(repo_dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .output()
        .with_context(|| format!("cannot run git {:?} in {}", args, repo_dir.display()))?;
    if !out.status.success() {
        bail!(
            "git {:?} failed in {}: {}",
            args,
            repo_dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(out.stdout)
}

pub fn git_head(repo_dir: &Path) -> Result<String> {
    let stdout = run_git_stdout(repo_dir, &["rev-parse", "HEAD"])?;
    let sha = String::from_utf8_lossy(&stdout).trim().to_owned();
    if sha.is_empty() {
        bail!("empty git HEAD in {}", repo_dir.display());
    }
    Ok(sha)
}

pub fn git_is_dirty(repo_dir: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["status", "--porcelain"])
        .output()
        .is_ok_and(|out| out.status.success() && !out.stdout.is_empty())
}

#[derive(Debug, Clone, Default)]
pub struct GitWorkingTreeStatus {
    pub dirty: bool,
    pub modified_or_untracked: Vec<String>,
    pub deleted: Vec<String>,
}

pub fn git_status_porcelain(repo_dir: &Path) -> Result<GitWorkingTreeStatus> {
    let stdout = run_git_stdout(repo_dir, &["status", "--porcelain=v1", "-z", "-uall"])?;
    if stdout.is_empty() {
        return Ok(GitWorkingTreeStatus::default());
    }
    let mut status = GitWorkingTreeStatus {
        dirty: true,
        modified_or_untracked: Vec::new(),
        deleted: Vec::new(),
    };
    let entries: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    let mut idx = 0usize;
    while idx < entries.len() {
        let entry = entries[idx];
        idx += 1;
        if entry.len() < 4 {
            continue;
        }
        let x = entry[0];
        let y = entry[1];
        let Ok(path) = std::str::from_utf8(&entry[3..]) else {
            continue;
        };
        if matches!(x, b'R' | b'C') {
            idx += 1;
        }
        if y == b'D' {
            status.deleted.push(path.to_owned());
        } else if (x == b'?' && y == b'?') || matches!(y, b'M' | b'T' | b'A' | b'U') {
            status.modified_or_untracked.push(path.to_owned());
        }
    }
    Ok(status)
}

pub fn git_ls_files_hashed(repo_dir: &Path) -> Result<BTreeMap<String, String>> {
    let stdout = run_git_stdout(repo_dir, &["ls-files", "-s", "-z"])?;
    let mut map = BTreeMap::new();
    for entry in stdout.split(|&b| b == 0) {
        if entry.is_empty() {
            continue;
        }
        let Some(tab) = entry.iter().position(|&b| b == b'\t') else {
            continue;
        };
        let Ok(meta) = std::str::from_utf8(&entry[..tab]) else {
            continue;
        };
        let Ok(rel) = std::str::from_utf8(&entry[tab + 1..]) else {
            continue;
        };
        let mut parts = meta.split_whitespace();
        let (Some(mode), Some(sha), Some(stage)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if !REGULAR_FILE_MODES.contains(&mode) {
            continue;
        }
        if stage == STAGE_NORMAL || !map.contains_key(rel) {
            map.insert(rel.to_owned(), sha.to_owned());
        }
    }
    Ok(map)
}

pub fn git_hash_objects(repo_dir: &Path, rel_paths: &[String]) -> Result<BTreeMap<String, String>> {
    let existing: Vec<&String> = rel_paths
        .iter()
        .filter(|rel| {
            fs::symlink_metadata(repo_dir.join(rel))
                .is_ok_and(|m| !m.file_type().is_symlink() && m.is_file())
        })
        .collect();
    let mut hashes = BTreeMap::new();
    for chunk in existing.chunks(HASH_OBJECT_CHUNK) {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo_dir).args(["hash-object", "--"]);
        for rel in chunk {
            cmd.arg(rel);
        }
        let out = cmd
            .output()
            .with_context(|| format!("cannot run git hash-object in {}", repo_dir.display()))?;
        if !out.status.success() {
            bail!(
                "git hash-object failed in {}: {}",
                repo_dir.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        for (rel, line) in chunk.iter().zip(stdout.lines()) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                hashes.insert((*rel).clone(), trimmed.to_owned());
            }
        }
    }
    Ok(hashes)
}

pub fn git_file_hashes_with_status(
    repo_dir: &Path,
    status: &GitWorkingTreeStatus,
) -> Result<BTreeMap<String, String>> {
    let mut map = git_ls_files_hashed(repo_dir)?;
    for rel in &status.deleted {
        map.remove(rel);
    }
    if !status.modified_or_untracked.is_empty() {
        let wt_hashes = git_hash_objects(repo_dir, &status.modified_or_untracked)?;
        for rel in &status.modified_or_untracked {
            if let Some(sha) = wt_hashes.get(rel) {
                map.insert(rel.clone(), sha.clone());
            } else {
                map.remove(rel);
            }
        }
    }
    Ok(map)
}

pub fn strip_comments(source: &str, nested_blocks: bool) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"//") {
            let end = skip_to_newline(bytes, i + 2);
            blank_preserving_newlines(&mut out, i, end);
            i = end;
        } else if bytes.get(i..i + 2) == Some(b"/*") {
            let end = if nested_blocks {
                skip_nested_block_comment(bytes, i + 2)
            } else {
                skip_flat_block_comment(bytes, i + 2)
            };
            blank_preserving_newlines(&mut out, i, end);
            i = end;
        } else if nested_blocks && let Some(end) = skip_rust_raw_string(bytes, i) {
            i = end;
        } else if bytes[i] == b'"' {
            i = skip_quoted_string(bytes, i, b'"');
        } else if !nested_blocks && bytes[i] == b'\'' {
            i = skip_quoted_string(bytes, i, b'\'');
        } else if !nested_blocks && bytes[i] == b'`' {
            i = skip_ts_template(bytes, i);
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| source.to_owned())
}

pub fn git_ls_files(repo_dir: &Path) -> Result<Vec<String>> {
    let stdout = run_git_stdout(repo_dir, &["ls-files", "-z"])?;
    let mut files: Vec<String> = stdout
        .split(|&b| b == 0)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| std::str::from_utf8(entry).ok().map(str::to_owned))
        .collect();
    files.sort();
    Ok(files)
}

pub fn parallel_map<T, R, F>(items: &[T], work: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let threads = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(items.len())
        .max(1);
    if threads <= 1 || items.len() < PARALLEL_MIN_ITEMS {
        return items.iter().map(work).collect();
    }
    let chunk_size = items.len().div_ceil(threads);
    let mut out = Vec::with_capacity(items.len());
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(threads);
        for chunk in items.chunks(chunk_size) {
            let work_ref = &work;
            handles.push(scope.spawn(move || {
                chunk.iter().map(work_ref).collect::<Vec<R>>()
            }));
        }
        for handle in handles {
            out.extend(handle.join().expect("worker thread panicked"));
        }
    });
    out
}

pub fn is_ts_source(rel: &str) -> bool {
    TS_SCAN_EXTS.iter().any(|ext| rel.ends_with(ext))
}

pub fn is_web_source(rel: &str) -> bool {
    WEB_SCAN_EXTS.iter().any(|ext| rel.ends_with(ext))
}

pub fn is_nginx_conf(rel: &str) -> bool {
    rel.ends_with(NGINX_EXT)
}

pub fn is_rust_source(rel: &str) -> bool {
    rel.ends_with(".rs")
}

pub fn unquote_ts_string(expr: &str) -> Option<String> {
    let trimmed = expr.trim();
    if trimmed.len() < 2 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let (first, last) = (bytes[0], bytes[trimmed.len() - 1]);
    let matched = (first == b'"' && last == b'"')
        || (first == b'\'' && last == b'\'')
        || (first == b'`' && last == b'`');
    matched.then(|| trimmed[1..trimmed.len() - 1].to_owned())
}

pub fn extract_url_host(raw: &str) -> Option<String> {
    let idx = raw.find("://")?;
    let host_port = raw[idx + 3..].split(['/', '?', '#']).next()?;
    let host = host_port.split(':').next()?.trim();
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

pub fn extract_ts_area(rel_file: &str, service_root: &str) -> String {
    let in_root = if service_root.is_empty() {
        rel_file
    } else {
        rel_file
            .strip_prefix(&format!("{service_root}/"))
            .unwrap_or(rel_file)
    };
    let Some(after_pages) = in_root.strip_prefix("src/pages/") else {
        return String::new();
    };
    if let Some((dir, _)) = after_pages.split_once('/') {
        dir.to_owned()
    } else {
        after_pages
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_owned())
            .unwrap_or_else(|| after_pages.to_owned())
    }
}

pub fn resolve_ts_relative_import(
    from_file: &str,
    specifier: &str,
    known_files: &std::collections::HashSet<String>,
) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let parent = from_file.rsplit_once('/').map_or("", |(dir, _)| dir);
    let mut parts: Vec<&str> = if parent.is_empty() {
        Vec::new()
    } else {
        parent.split('/').collect()
    };
    for seg in specifier.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let base = parts.join("/");
    let trimmed = base
        .strip_suffix(".js")
        .or_else(|| base.strip_suffix(".mjs"))
        .unwrap_or(&base);
    for ext in TS_IMPORT_EXTS {
        let candidate = format!("{trimmed}{ext}");
        if known_files.contains(&candidate) {
            return Some(candidate);
        }
    }
    if known_files.contains(&base) {
        return Some(base);
    }
    None
}

pub fn is_compose_file(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.contains("compose") && (lower.ends_with(".yml") || lower.ends_with(".yaml"))
}

pub fn read_files_parallel(repo_dir: &Path, files: &[String]) -> Vec<(String, String)> {
    parallel_map(files, |rel| {
        fs::read_to_string(repo_dir.join(rel))
            .ok()
            .map(|raw| (rel.clone(), raw))
    })
    .into_iter()
    .flatten()
    .collect()
}

pub fn split_ts_import_clause(clause: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for item in clause.split(',') {
        let cleaned = item.trim().trim_start_matches("type ").trim();
        if cleaned.is_empty() {
            continue;
        }
        let (orig, local) = cleaned
            .split_once(" as ")
            .map_or((cleaned, cleaned), |(o, a)| (o.trim(), a.trim()));
        if !orig.is_empty() && !local.is_empty() {
            out.push((orig.to_owned(), local.to_owned()));
        }
    }
    out
}

pub fn read_rust_service_files(
    repo_dir: &Path,
    service_root: &str,
    tracked_files: &[String],
) -> Vec<(String, String)> {
    let candidates: Vec<&String> = tracked_files
        .iter()
        .filter(|rel| is_rust_source(rel) && under_root(rel, service_root) && !is_test_file(rel))
        .collect();
    parallel_map(&candidates, |rel| {
        fs::read_to_string(repo_dir.join(rel))
            .ok()
            .map(|raw| ((*rel).clone(), strip_cfg_test(&raw)))
    })
    .into_iter()
    .flatten()
    .collect()
}

pub fn under_root(rel: &str, root: &str) -> bool {
    root.is_empty() || rel == root || rel.starts_with(&format!("{root}/"))
}

pub fn qualify_under_root(root: &str, path: &str) -> String {
    if root.is_empty() || path.starts_with(&format!("{root}/")) {
        path.to_owned()
    } else {
        format!("{root}/{path}")
    }
}

pub fn for_each_dot_call(
    source: &str,
    mask: &[bool],
    range_start: usize,
    range_end: usize,
    mut on_call: impl FnMut(&str, usize, usize, usize) -> Option<usize>,
) {
    let bytes = source.as_bytes();
    let limit = range_end.min(bytes.len());
    let mut i = range_start;
    while i < limit {
        if !mask[i] || bytes[i] != b'.' {
            i += 1;
            continue;
        }
        let Some((name, open_paren)) = read_dot_call(source, bytes, mask, i) else {
            i += 1;
            continue;
        };
        let Some(close_paren) = find_matching_delim(bytes, mask, open_paren, b'(', b')') else {
            i += 1;
            continue;
        };
        match on_call(name, i, open_paren, close_paren) {
            Some(next) => i = next.max(i + 1),
            None => break,
        }
    }
}

pub fn for_each_masked_ident(
    source: &str,
    mask: &[bool],
    range_start: usize,
    range_end: usize,
    mut on_ident: impl FnMut(&str, usize) -> Option<usize>,
) {
    let bytes = source.as_bytes();
    let limit = range_end.min(bytes.len());
    let mut i = range_start;
    while i < limit {
        if mask[i]
            && let Some((ident, next_i)) = read_ident(source, &bytes[..limit], i)
        {
            let Some(next) = on_ident(ident, next_i) else {
                break;
            };
            i = next.max(next_i);
        } else {
            i += 1;
        }
    }
}

pub fn is_test_file(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    if segments
        .iter()
        .take(segments.len().saturating_sub(1))
        .any(|seg| TEST_DIRS.contains(seg))
    {
        return true;
    }
    let file_name = segments.last().copied().unwrap_or("");
    if let Some(stem) = file_name.strip_suffix(".rs") {
        return RUST_TEST_STEMS.contains(&stem)
            || stem.ends_with("_test")
            || stem.ends_with("_tests");
    }
    if let Some(stem) = TS_JS_EXTS.iter().find_map(|ext| file_name.strip_suffix(ext)) {
        return stem.ends_with(".test")
            || stem.ends_with(".spec")
            || stem.ends_with("_test")
            || stem.ends_with("_spec");
    }
    false
}

pub fn build_code_mask(source: &str, next_span: fn(&[u8], usize) -> Option<usize>) -> Vec<bool> {
    let bytes = source.as_bytes();
    let mut mask = vec![true; bytes.len()];
    let mut i = 0usize;
    while i < bytes.len() {
        if let Some(end) = next_span(bytes, i) {
            mask[i..end].fill(false);
            i = end;
        } else {
            i += 1;
        }
    }
    mask
}

pub fn rust_code_mask(source: &str) -> Vec<bool> {
    build_code_mask(source, next_rust_non_code_span)
}

pub(crate) fn next_rust_literal_span(bytes: &[u8], i: usize) -> Option<usize> {
    if let Some(end) = skip_rust_raw_string(bytes, i) {
        return Some(end);
    }
    if bytes[i] == b'"' {
        return Some(skip_quoted_string(bytes, i, b'"'));
    }
    if bytes[i] == b'\'' {
        return skip_rust_char_literal(bytes, i);
    }
    None
}

fn next_rust_non_code_span(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i..i + 2) == Some(b"//") {
        return Some(skip_to_newline(bytes, i + 2));
    }
    if bytes.get(i..i + 2) == Some(b"/*") {
        return Some(skip_nested_block_comment(bytes, i + 2));
    }
    next_rust_literal_span(bytes, i)
}

pub(crate) fn skip_to_newline(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

pub(crate) fn skip_nested_block_comment(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 1usize;
    while i < bytes.len() && depth > 0 {
        if bytes.get(i..i + 2) == Some(b"/*") {
            depth += 1;
            i += 2;
        } else if bytes.get(i..i + 2) == Some(b"*/") {
            depth -= 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    i
}

pub(crate) fn skip_rust_raw_string(bytes: &[u8], start: usize) -> Option<usize> {
    if start > 0 && is_ident_byte(bytes[start - 1]) {
        return None;
    }
    let mut pos = start + usize::from(bytes.get(start) == Some(&b'b'));
    if bytes.get(pos) != Some(&b'r') {
        return None;
    }
    pos += 1;
    let mut hashes = 0usize;
    while bytes.get(pos) == Some(&b'#') {
        hashes += 1;
        pos += 1;
    }
    if bytes.get(pos) != Some(&b'"') {
        return None;
    }
    pos += 1;
    while pos < bytes.len() {
        if bytes[pos] == b'"' && count_hashes(bytes, pos + 1, hashes) == hashes {
            return Some(pos + 1 + hashes);
        }
        pos += 1;
    }
    Some(bytes.len())
}

fn count_hashes(bytes: &[u8], start: usize, limit: usize) -> usize {
    let mut matched = 0usize;
    while matched < limit && bytes.get(start + matched) == Some(&b'#') {
        matched += 1;
    }
    matched
}

pub(crate) fn skip_rust_char_literal(bytes: &[u8], start: usize) -> Option<usize> {
    let next = *bytes.get(start + 1)?;
    if next == b'\\' {
        let max_end = (start + 11).min(bytes.len());
        return (start + 3..max_end)
            .find(|&pos| bytes[pos] == b'\'')
            .map(|pos| pos + 1);
    }
    let ch_len = utf8_char_width(next);
    (bytes.get(start + 1 + ch_len) == Some(&b'\'')).then_some(start + 2 + ch_len)
}

fn utf8_char_width(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0x80..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

pub fn skip_quoted_string(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i = (i + 2).min(bytes.len());
            continue;
        }
        if bytes[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

pub fn ts_code_mask(source: &str) -> Vec<bool> {
    build_code_mask(source, next_ts_non_code_span)
}

pub(crate) fn next_ts_literal_span(bytes: &[u8], i: usize) -> Option<usize> {
    if matches!(bytes[i], b'"' | b'\'') {
        return Some(skip_quoted_string(bytes, i, bytes[i]));
    }
    if bytes[i] == b'`' {
        return Some(skip_ts_template(bytes, i));
    }
    None
}

fn next_ts_non_code_span(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i..i + 2) == Some(b"//") {
        return Some(skip_to_newline(bytes, i + 2));
    }
    if bytes.get(i..i + 2) == Some(b"/*") {
        return Some(skip_flat_block_comment(bytes, i + 2));
    }
    next_ts_literal_span(bytes, i)
}

pub(crate) fn skip_flat_block_comment(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"*/") {
            return i + 2;
        }
        i += 1;
    }
    bytes.len()
}

pub(crate) fn skip_ts_template(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    let mut brace_depth = 0usize;
    while i < bytes.len() {
        if brace_depth == 0 {
            if bytes[i] == b'\\' {
                i = (i + 2).min(bytes.len());
            } else if bytes[i] == b'`' {
                return i + 1;
            } else if bytes.get(i..i + 2) == Some(b"${") {
                brace_depth = 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        i = advance_template_expr(bytes, i, &mut brace_depth);
    }
    bytes.len()
}

fn advance_template_expr(bytes: &[u8], i: usize, brace_depth: &mut usize) -> usize {
    if matches!(bytes[i], b'"' | b'\'') {
        return skip_quoted_string(bytes, i, bytes[i]);
    }
    if bytes[i] == b'`' {
        return skip_ts_template(bytes, i);
    }
    if bytes[i] == b'{' {
        *brace_depth += 1;
    } else if bytes[i] == b'}' {
        *brace_depth -= 1;
    }
    i + 1
}

pub fn strip_cfg_test(source: &str) -> String {
    let mask = rust_code_mask(source);
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        if mask[i]
            && bytes.get(i..i + 2) == Some(b"#[")
            && let Some(attr_end) = find_matching_delim(bytes, &mask, i + 1, b'[', b']')
            && is_cfg_test_attr(&source[i..=attr_end])
        {
            let item_end = find_cfg_item_end(bytes, &mask, attr_end + 1);
            blank_preserving_newlines(&mut out, i, item_end);
            i = item_end;
            continue;
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| source.to_owned())
}

fn is_cfg_test_attr(attr: &str) -> bool {
    let compact: String = attr.chars().filter(|c| !c.is_whitespace()).collect();
    let Some(inner) = compact
        .strip_prefix("#[cfg(")
        .and_then(|s| s.strip_suffix(")]"))
    else {
        return false;
    };
    inner == CFG_TEST_NAME
        || inner.starts_with("all(test,")
        || inner.contains(",test)")
        || inner.contains(",test,")
}

fn find_cfg_item_end(bytes: &[u8], mask: &[bool], mut pos: usize) -> usize {
    while pos < bytes.len() {
        if !mask[pos] {
            pos += 1;
            continue;
        }
        if bytes.get(pos..pos + 2) == Some(b"#[")
            && let Some(end) = find_matching_delim(bytes, mask, pos + 1, b'[', b']')
        {
            pos = end + 1;
            continue;
        }
        if bytes[pos] == b';' {
            return pos + 1;
        }
        if bytes[pos] == b'{' {
            return find_matching_delim(bytes, mask, pos, b'{', b'}')
                .map_or(bytes.len(), |end| end + 1);
        }
        pos += 1;
    }
    bytes.len()
}

fn blank_preserving_newlines(buf: &mut [u8], start: usize, end: usize) {
    let limit = end.min(buf.len());
    for byte in &mut buf[start..limit] {
        if *byte != b'\n' {
            *byte = b' ';
        }
    }
}

pub fn find_matching_delim(
    bytes: &[u8],
    mask: &[bool],
    open_pos: usize,
    open: u8,
    close: u8,
) -> Option<usize> {
    if bytes.get(open_pos) != Some(&open) || !mask.get(open_pos).copied().unwrap_or(false) {
        return None;
    }
    let mut depth = 0usize;
    for i in open_pos..bytes.len() {
        if !mask[i] {
            continue;
        }
        if bytes[i] == open {
            depth += 1;
        } else if bytes[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

pub fn split_top_level_args<'a>(
    source: &'a str,
    mask: &[bool],
    base_offset: usize,
    start: usize,
    end: usize,
) -> Vec<(usize, &'a str)> {
    split_top_level_delimited(source, mask, base_offset, start, end, false)
}

pub fn split_top_level_delimited<'a>(
    source: &'a str,
    mask: &[bool],
    base_offset: usize,
    start: usize,
    end: usize,
    track_angles: bool,
) -> Vec<(usize, &'a str)> {
    let bytes = source.as_bytes();
    let mut parts = Vec::new();
    let mut depth = [0usize; 4];
    let mut seg_start = start;
    for i in start..end {
        if !mask[base_offset + i] {
            continue;
        }
        let prev = if i > 0 { bytes[i - 1] } else { 0 };
        if bytes[i] == b',' && depth == [0, 0, 0, 0] {
            push_trimmed_arg(&mut parts, source, seg_start, i);
            seg_start = i + 1;
        } else {
            update_delim_depth(bytes[i], prev, track_angles, &mut depth);
        }
    }
    push_trimmed_arg(&mut parts, source, seg_start, end);
    parts
}

pub(crate) fn update_delim_depth(byte: u8, prev: u8, track_angles: bool, depth: &mut [usize; 4]) {
    match byte {
        b'(' => depth[0] += 1,
        b')' => depth[0] = depth[0].saturating_sub(1),
        b'{' => depth[1] += 1,
        b'}' => depth[1] = depth[1].saturating_sub(1),
        b'[' => depth[2] += 1,
        b']' => depth[2] = depth[2].saturating_sub(1),
        b'<' if track_angles => depth[3] += 1,
        b'>' if track_angles && !matches!(prev, b'-' | b'=') => {
            depth[3] = depth[3].saturating_sub(1);
        }
        _ => {}
    }
}

fn push_trimmed_arg<'a>(
    parts: &mut Vec<(usize, &'a str)>,
    source: &'a str,
    start: usize,
    end: usize,
) {
    let slice = &source[start..end];
    let lead = slice.len() - slice.trim_start().len();
    let trimmed = slice.trim();
    if !trimmed.is_empty() {
        parts.push((start + lead, trimmed));
    }
}

pub fn read_dot_call<'a>(
    source: &'a str,
    bytes: &[u8],
    mask: &[bool],
    dot_pos: usize,
) -> Option<(&'a str, usize)> {
    let mut pos = dot_pos + 1;
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    let start = pos;
    while pos < bytes.len() && is_ident_byte(bytes[pos]) {
        pos += 1;
    }
    if pos == start {
        return None;
    }
    let name = &source[start..pos];
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    (bytes.get(pos) == Some(&b'(') && mask[pos]).then_some((name, pos))
}

pub fn unquote_double_string(expr: &str) -> Option<String> {
    expr.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .map(str::to_owned)
}

pub fn sort_extracted_calls(calls: &mut [super::types::ExtractedCall]) {
    calls.sort_by_key(|c| (c.file.clone(), c.line, c.method, c.path_norm.clone()));
}

pub fn sort_extracted_endpoints(endpoints: &mut [super::types::ExtractedEndpoint]) {
    endpoints.sort_by_key(|e| (e.file.clone(), e.line, e.method, e.path_norm.clone()));
}

pub fn dedup_and_sort_endpoints(endpoints: &mut Vec<super::types::ExtractedEndpoint>) {
    sort_extracted_endpoints(endpoints);
    endpoints.dedup_by(|a, b| {
        a.file == b.file
            && a.line == b.line
            && a.method == b.method
            && a.path_norm == b.path_norm
            && a.prefix_state == b.prefix_state
    });
}

pub fn read_ts_service_sources(
    repo_dir: &Path,
    service_root: &str,
    tracked_files: &[String],
) -> Vec<(String, String)> {
    let candidates: Vec<String> = tracked_files
        .iter()
        .filter(|rel| is_ts_source(rel) && under_root(rel, service_root) && !is_test_file(rel))
        .cloned()
        .collect();
    read_files_parallel(repo_dir, &candidates)
}

pub fn extract_ts_method_opt(opts: &str) -> super::types::HttpMethod {
    TS_METHOD_PROP_RE
        .captures(opts)
        .and_then(|c| super::types::HttpMethod::parse(&c[1]))
        .unwrap_or(super::types::HttpMethod::Get)
}

pub fn extract_ts_handler_name(args: &[(usize, &str)], fallback: &str) -> String {
    if let Some((_, last)) = args.last() {
        let trimmed = last.trim();
        if !trimmed.is_empty() && trimmed.bytes().all(is_ts_ident_byte) {
            return trimmed.to_owned();
        }
    }
    fallback.to_owned()
}

pub fn read_ts_ident_prefix(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut pos = 0usize;
    while pos < bytes.len() && is_ts_ident_byte(bytes[pos]) {
        pos += 1;
    }
    (pos > 0).then(|| (&text[..pos], &text[pos..]))
}

#[derive(Debug, Clone)]
pub struct RawTsRoute {
    pub method: super::types::HttpMethod,
    pub path_raw: String,
    pub file: String,
    pub line: usize,
    pub handler: String,
    pub is_root_app: bool,
}

pub fn parse_ts_source_map<T, F, K>(
    sources: &[(String, String)],
    parse_one: F,
    key_of: K,
) -> HashMap<String, T>
where
    T: Send,
    F: Fn(&str, &str, &HashSet<String>) -> T + Sync,
    K: Fn(&T) -> String,
{
    let known_files: HashSet<String> = sources.iter().map(|(f, _)| f.clone()).collect();
    let parsed_list = parallel_map(sources, |(rel, src)| parse_one(rel, src, &known_files));
    parsed_list
        .into_iter()
        .map(|p| (key_of(&p), p))
        .collect()
}

pub fn first_ts_route_path(
    args: &[(usize, &str)],
    local_paths: &HashMap<String, String>,
) -> Option<String> {
    args.first()
        .and_then(|(_, a)| extract_ts_path_with_consts(a, local_paths))
        .filter(|p| p.starts_with('/'))
}

pub fn push_ts_route(
    out: &mut Vec<super::types::ExtractedEndpoint>,
    route: &RawTsRoute,
    mount_prefix: &str,
    prefix_state: super::types::PrefixState,
    upgrade_api_prefix: bool,
) {
    let full_raw = if mount_prefix.is_empty() || mount_prefix == ROOT_SLASH {
        route.path_raw.clone()
    } else {
        join_paths(mount_prefix, &route.path_raw)
    };
    let path_norm = normalize_path(&full_raw);
    if path_norm.is_empty() {
        return;
    }
    let state = if upgrade_api_prefix && full_raw.starts_with("/api/") {
        super::types::PrefixState::Full
    } else {
        prefix_state
    };
    let mut ep = super::types::ExtractedEndpoint::simple(
        route.method,
        &path_norm,
        &route.file,
        route.line,
        &route.handler,
        state,
    );
    ep.path_raw = full_raw;
    out.push(ep);
}

pub fn find_semicolon_at_depth_zero(
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    limit: usize,
) -> usize {
    let mut depth = 0usize;
    for i in start..limit {
        if !mask[i] {
            continue;
        }
        match bytes[i] {
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => return i,
            _ => {}
        }
    }
    limit
}

pub fn read_ident<'a>(source: &'a str, bytes: &[u8], start: usize) -> Option<(&'a str, usize)> {
    let mut pos = start;
    while pos < bytes.len() && is_ident_byte(bytes[pos]) {
        pos += 1;
    }
    (pos > start).then(|| (&source[start..pos], pos))
}

pub fn skip_ascii_ws(bytes: &[u8], mut pos: usize, limit: usize) -> usize {
    while pos < limit && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    pos
}

pub fn skip_angle_generics(
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    limit: usize,
    skip_arrow: bool,
) -> Option<usize> {
    let mut depth = 0usize;
    for pos in start..limit {
        if !mask[pos] {
            continue;
        }
        if bytes[pos] == b'<' {
            depth += 1;
        } else if bytes[pos] == b'>' && (!skip_arrow || pos == 0 || bytes[pos - 1] != b'=') {
            depth -= 1;
            if depth == 0 {
                return Some(pos + 1);
            }
        }
    }
    None
}

pub fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

pub fn is_ts_ident_byte(b: u8) -> bool {
    is_ident_byte(b) || b == b'$'
}

pub fn collect_local_path_consts(source: &str, mask: &[bool]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for caps in TS_LOCAL_PATH_CONST_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if mask[m0.start()] {
            map.insert(caps[1].to_owned(), caps[2].to_owned());
        }
    }
    map
}

pub fn extract_ts_path_with_consts(
    arg: &str,
    local_paths: &HashMap<String, String>,
) -> Option<String> {
    let inner = unquote_ts_string(arg)?;
    if let Some(rest) = inner.strip_prefix("${")
        && let Some(close) = rest.find('}')
    {
        let var_name = rest[..close].trim();
        let suffix = &rest[close + 1..];
        if let Some(prefix) = local_paths.get(var_name) {
            if suffix.is_empty() || suffix.starts_with('?') {
                return Some(prefix.clone());
            }
            if suffix.starts_with('/') {
                return Some(join_paths(prefix, suffix));
            }
        }
        if suffix.starts_with('/') {
            return Some(suffix.to_owned());
        }
        return None;
    }
    (inner.starts_with('/') || inner.starts_with("http://") || inner.starts_with("https://"))
        .then_some(inner)
}

pub fn parse_ts_imports(
    rel: &str,
    source: &str,
    mask: &[bool],
    known_files: &HashSet<String>,
) -> HashMap<String, TsImportedSymbol> {
    let mut map = HashMap::new();
    for caps in TS_IMPORT_STMT_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if !mask[m0.start()] {
            continue;
        }
        let Some(target_file) = resolve_ts_relative_import(rel, &caps[3], known_files) else {
            continue;
        };
        if let Some(named) = caps.get(1) {
            for (orig, local) in split_ts_import_clause(named.as_str()) {
                map.insert(
                    local,
                    TsImportedSymbol {
                        file: target_file.clone(),
                        exported_name: orig,
                    },
                );
            }
        } else if let Some(def) = caps.get(2) {
            map.insert(
                def.as_str().to_owned(),
                TsImportedSymbol {
                    file: target_file,
                    exported_name: def.as_str().to_owned(),
                },
            );
        }
    }
    map
}

pub fn chain_root_receiver(source: &str, mask: &[bool], dot_pos: usize) -> Option<String> {
    let bytes = source.as_bytes();
    let mut pos = dot_pos;
    for _ in 0..MAX_CHAIN_HOPS {
        pos = skip_ws_back(bytes, pos);
        if pos == 0 {
            return None;
        }
        if bytes[pos - 1] == b')' && mask[pos - 1] {
            let open = find_matching_open(bytes, mask, pos - 1, b'(', b')')?;
            let ident_start = skip_ts_ident_back(bytes, skip_ws_back(bytes, open));
            let before_ident = skip_ws_back(bytes, ident_start);
            if before_ident > 0 && bytes[before_ident - 1] == b'.' && mask[before_ident - 1] {
                pos = before_ident - 1;
                continue;
            }
            return None;
        }
        let start = skip_ts_ident_back(bytes, pos);
        return (start < pos).then(|| source[start..pos].to_owned());
    }
    None
}

pub fn find_matching_open(
    bytes: &[u8],
    mask: &[bool],
    close_pos: usize,
    open: u8,
    close: u8,
) -> Option<usize> {
    let mut depth = 0usize;
    for i in (0..=close_pos).rev() {
        if !mask[i] {
            continue;
        }
        if bytes[i] == close {
            depth += 1;
        } else if bytes[i] == open {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn skip_ws_back(bytes: &[u8], mut pos: usize) -> usize {
    while pos > 0 && bytes[pos - 1].is_ascii_whitespace() {
        pos -= 1;
    }
    pos
}

fn skip_ts_ident_back(bytes: &[u8], mut pos: usize) -> usize {
    while pos > 0 && is_ts_ident_byte(bytes[pos - 1]) {
        pos -= 1;
    }
    pos
}

pub fn normalize_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_scheme = strip_scheme_and_host(trimmed);
    let without_query = without_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or(without_scheme);
    let collapsed = replace_template_exprs(without_query);
    let segments: Vec<&str> = collapsed
        .split('/')
        .filter(|seg| !seg.is_empty())
        .map(normalize_segment)
        .filter(|seg| !seg.is_empty())
        .collect();
    if segments.is_empty() {
        return if collapsed.contains('/') {
            ROOT_SLASH.to_owned()
        } else {
            String::new()
        };
    }
    format!("/{}", segments.join("/"))
}

fn strip_scheme_and_host(raw: &str) -> &str {
    let Some(idx) = raw.find("://") else {
        return raw;
    };
    let rest = &raw[idx + 3..];
    rest.find('/').map_or(ROOT_SLASH, |slash| &rest[slash..])
}

fn replace_template_exprs(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"${") {
            i = skip_braced_expr(bytes, i + 2);
            out.push_str(DYNAMIC_SEG);
            continue;
        }
        if bytes[i] == b'{' {
            i = skip_braced_expr(bytes, i + 1);
            out.push_str(DYNAMIC_SEG);
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn skip_braced_expr(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 1usize;
    while i < bytes.len() && depth > 0 {
        if bytes[i] == b'{' {
            depth += 1;
        } else if bytes[i] == b'}' {
            depth -= 1;
        }
        i += 1;
    }
    i
}

fn normalize_segment(seg: &str) -> &str {
    if is_dynamic_segment(seg) {
        return DYNAMIC_SEG;
    }
    if let Some(stem) = seg.strip_suffix(DYNAMIC_SEG)
        && !stem.is_empty()
    {
        return stem;
    }
    seg
}

fn is_dynamic_segment(seg: &str) -> bool {
    seg == DYNAMIC_SEG
        || seg.starts_with(':')
        || seg.starts_with('*')
        || (seg.starts_with('{') && seg.ends_with('}'))
}

pub fn path_segment_count(path_norm: &str) -> usize {
    path_norm.split('/').filter(|s| !s.is_empty()).count()
}

pub fn join_paths(prefix: &str, suffix: &str) -> String {
    let p = prefix.trim().trim_end_matches('/');
    let s = suffix.trim();
    if p.is_empty() {
        return s.to_owned();
    }
    let p_lead = if p.starts_with('/') {
        p.to_owned()
    } else {
        format!("/{p}")
    };
    if s.is_empty() || s == ROOT_SLASH {
        return p_lead;
    }
    format!("{p_lead}/{}", s.trim_start_matches('/'))
}

pub fn glob_matches(pattern: &str, text: &str) -> bool {
    let pat_segs: Vec<&str> = pattern.split('/').collect();
    let txt_segs: Vec<&str> = text.split('/').collect();
    glob_match_segments(&pat_segs, &txt_segs)
}

fn glob_match_segments(pat: &[&str], txt: &[&str]) -> bool {
    match (pat.first(), txt.first()) {
        (None, None) => true,
        (Some(&"**"), _) => {
            glob_match_segments(&pat[1..], txt)
                || (!txt.is_empty() && glob_match_segments(pat, &txt[1..]))
        }
        (Some(p), Some(t)) => {
            segment_wildcard_match(p, t) && glob_match_segments(&pat[1..], &txt[1..])
        }
        _ => false,
    }
}

fn segment_wildcard_match(pat: &str, txt: &str) -> bool {
    let (p, t) = (pat.as_bytes(), txt.as_bytes());
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, ti));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn matches_external_glob(external: &[String], repo: &str, rel_file: &str) -> bool {
    external.iter().any(|entry| match entry.split_once(':') {
        Some((pat_repo, pat_glob)) => pat_repo == repo && glob_matches(pat_glob, rel_file),
        None => glob_matches(entry, rel_file),
    })
}

pub fn find_rust_functions(source: &str, mask: &[bool]) -> Vec<(String, usize, usize, usize)> {
    let bytes = source.as_bytes();
    let mut fns = Vec::new();
    let mut i = 0usize;
    while i + 3 < bytes.len() {
        let is_fn_kw = mask[i]
            && bytes.get(i..i + 2) == Some(b"fn")
            && !is_ident_byte(bytes.get(i + 2).copied().unwrap_or(0))
            && (i == 0 || !is_ident_byte(bytes[i - 1]));
        if is_fn_kw
            && let Some(span) = parse_rust_fn_span(source, bytes, mask, i)
        {
            i = span.2 + 1;
            fns.push(span);
            continue;
        }
        i += 1;
    }
    fns
}

pub fn enclosing_fn_name(fns: &[(String, usize, usize, usize)], pos: usize) -> Option<String> {
    fns.iter()
        .filter(|(_, _, open, close)| pos >= *open && pos <= *close)
        .min_by_key(|(_, _, open, close)| close - open)
        .map(|(n, _, _, _)| n.clone())
}

fn parse_rust_fn_span(
    source: &str,
    bytes: &[u8],
    mask: &[bool],
    fn_kw: usize,
) -> Option<(String, usize, usize, usize)> {
    let mut pos = fn_kw + 2;
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    let name_start = pos;
    while pos < bytes.len() && is_ident_byte(bytes[pos]) {
        pos += 1;
    }
    if pos == name_start {
        return None;
    }
    let name = source[name_start..pos].to_owned();
    for scan in pos..bytes.len() {
        if !mask[scan] {
            continue;
        }
        if bytes[scan] == b';' {
            return None;
        }
        if bytes[scan] == b'{' {
            let close = find_matching_delim(bytes, mask, scan, b'{', b'}')?;
            return Some((name, fn_kw, scan, close));
        }
    }
    None
}

pub fn extract_why_rust(
    source: &str,
    lines: &LineIndex,
    fns: &[(String, usize, usize, usize)],
    byte_pos: usize,
) -> String {
    let Some((fn_name, header_pos, _, _)) = fns
        .iter()
        .filter(|(_, _, open, close)| byte_pos >= *open && byte_pos <= *close)
        .min_by_key(|(_, _, open, close)| close - open)
    else {
        return String::new();
    };
    let comment = first_comment_above(source, lines.line_at(*header_pos));
    format_why(fn_name, comment.as_deref())
}

pub fn extract_why_ts(source: &str, lines: &LineIndex, byte_pos: usize) -> String {
    let call_line = lines.line_at(byte_pos);
    let all_lines: Vec<&str> = source.lines().collect();
    let start_idx = call_line.saturating_sub(1).min(all_lines.len().saturating_sub(1));
    let min_idx = start_idx.saturating_sub(120);
    let found = (min_idx..=start_idx)
        .rev()
        .find_map(|idx| parse_ts_enclosing_name(all_lines[idx]).map(|n| (n, idx + 1)));
    let Some((name, fn_line_one)) = found else {
        return String::new();
    };
    let comment = first_comment_above(source, fn_line_one);
    format_why(&name, comment.as_deref())
}

fn parse_ts_enclosing_name(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
        return None;
    }
    let stripped = trimmed
        .strip_prefix("export default ")
        .or_else(|| trimmed.strip_prefix("export "))
        .unwrap_or(trimmed);
    let stripped = stripped.strip_prefix("async ").unwrap_or(stripped);
    if let Some(rest) = stripped.strip_prefix("function ") {
        return take_ts_ident(rest);
    }
    let rest = stripped
        .strip_prefix("const ")
        .or_else(|| stripped.strip_prefix("let "))?;
    let name = take_ts_ident(rest)?;
    let after = rest[name.len()..].trim_start();
    let is_callable = (after.starts_with('=') || after.starts_with(':'))
        && (line.contains("=>") || line.contains("function"));
    is_callable.then_some(name)
}

fn take_ts_ident(rest: &str) -> Option<String> {
    let name: String = rest
        .chars()
        .take_while(|c| matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '$'))
        .collect();
    (!name.is_empty()).then_some(name)
}

fn first_comment_above(source: &str, target_line: usize) -> Option<String> {
    if target_line <= 1 {
        return None;
    }
    let all_lines: Vec<&str> = source.lines().collect();
    let mut idx = target_line - 2;
    while let Some(raw) = all_lines.get(idx) {
        let t = raw.trim();
        if !t.starts_with("#[") && !t.starts_with('@') {
            break;
        }
        if idx == 0 {
            return None;
        }
        idx -= 1;
    }
    let mut comments = Vec::new();
    while let Some(raw) = all_lines.get(idx) {
        let Some(text) = strip_comment_prefix(raw.trim()) else {
            break;
        };
        if !text.is_empty() {
            comments.push(text.to_owned());
        }
        if idx == 0 {
            break;
        }
        idx -= 1;
    }
    comments.into_iter().last()
}

fn strip_comment_prefix(trimmed: &str) -> Option<&str> {
    for prefix in ["///", "//!", "//", "/**", "/*", "*"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(rest.trim_end_matches("*/").trim());
        }
    }
    None
}

fn format_why(fn_name: &str, comment: Option<&str>) -> String {
    let raw = match comment {
        Some(c) if !c.is_empty() => format!("{fn_name}: {c}"),
        _ => fn_name.to_owned(),
    };
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    output::prefix(&clean, MAX_WHY_BYTES).trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_table_handles_params_templates_wildcards_queries_and_slashes() {
        let cases = [
            ("/api/v1/sales", "/api/v1/sales"),
            ("/api/v1/sales/", "/api/v1/sales"),
            ("//api//v1//sales//", "/api/v1/sales"),
            ("/api/v1/sales/:id", "/api/v1/sales/{}"),
            ("/api/v1/sales/{sale_id}", "/api/v1/sales/{}"),
            ("/api/v1/sales/{}", "/api/v1/sales/{}"),
            ("/api/v1/products/${productId}/items", "/api/v1/products/{}/items"),
            ("/api/v1/files/*rest", "/api/v1/files/{}"),
            ("/api/v1/sales/:id?expand=items#top", "/api/v1/sales/{}"),
            ("https://api.example.com/api/v1/invoices/", "/api/v1/invoices"),
            ("http://localhost:8080/health?ok=1", "/health"),
            ("/", "/"),
            ("", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_path(input), expected, "input={input}");
        }
    }

    #[test]
    fn strip_cfg_test_preserves_line_numbers_and_removes_test_routes() {
        let src = "\
pub fn live() {
    let _ = \"/api/v1/live\";
}

#[cfg(test)]
mod tests {
    fn helper() {
        let brace = \"}\";
        let _ = \"/api/v1/fake\";
    }
}

pub fn after() {
    let _ = \"/api/v1/after\";
}
";
        let stripped = strip_cfg_test(src);
        assert_eq!(stripped.lines().count(), src.lines().count());
        assert!(stripped.contains("/api/v1/live"));
        assert!(!stripped.contains("/api/v1/fake"));
        assert!(stripped.contains("/api/v1/after"));
        let idx = LineIndex::new(&stripped);
        let pos = stripped.find("/api/v1/after").unwrap();
        assert_eq!(idx.line_at(pos), 14);
    }

    #[test]
    fn external_glob_matches_nested_provider_paths() {
        let globs = vec!["ez-addon:src/modules/catalog/**/providers/**".to_owned()];
        assert!(matches_external_glob(
            &globs,
            "ez-addon",
            "src/modules/catalog/contexts/catalog/infrastructure/providers/off.rs"
        ));
        assert!(!matches_external_glob(
            &globs,
            "ez-addon",
            "src/modules/cochera/ez_commerce.rs"
        ));
        assert!(!matches_external_glob(
            &globs,
            "ez-commerce",
            "src/modules/catalog/contexts/catalog/infrastructure/providers/off.rs"
        ));
    }

    #[test]
    fn test_file_filter_catches_rust_and_ts_test_conventions() {
        assert!(is_test_file("backend/crates/ez-sales/src/api_tests.rs"));
        assert!(is_test_file("backend/src/test_support/http.rs"));
        assert!(is_test_file("tests/cli.rs"));
        assert!(is_test_file("frontend/src/lib/api.get-cache.test.ts"));
        assert!(is_test_file("src/pages/Recategorizacion.test.tsx"));
        assert!(!is_test_file("backend/crates/ez-sales/src/api.rs"));
        assert!(!is_test_file("src/modules/cochera/ez_commerce.rs"));
        assert!(!is_test_file("frontend/src/pages/sales/SalesPage.tsx"));
    }

    #[test]
    fn extract_why_rust_reads_enclosing_fn_and_first_doc_line_within_80_bytes() {
        let src = "\
/// Issues an agnostic invoice via ez-commerce with idempotency key and long explanation that exceeds eighty bytes easily.
/// Second line ignored.
#[allow(dead_code)]
async fn issue() {
    let x = 1;
}
";
        let mask = rust_code_mask(src);
        let fns = find_rust_functions(src, &mask);
        let lines = LineIndex::new(src);
        let pos = src.find("let x = 1").unwrap();
        let why = extract_why_rust(src, &lines, &fns, pos);
        assert!(why.starts_with("issue: Issues an agnostic invoice"));
        assert!(why.len() <= 80);
    }
}
