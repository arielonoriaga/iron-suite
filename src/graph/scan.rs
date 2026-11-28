use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::output;

const MAX_WHY_BYTES: usize = 80;
const DYNAMIC_SEG: &str = "{}";
const ROOT_SLASH: &str = "/";
const CFG_TEST_NAME: &str = "test";
const TEST_DIRS: &[&str] = &[
    "tests",
    "test",
    "test_support",
    "__tests__",
    "__mocks__",
    "benches",
    "e2e",
];
const RUST_TEST_STEMS: &[&str] = &["tests", "test", "test_support"];
const TS_JS_EXTS: &[&str] = &[".tsx", ".ts", ".jsx", ".js", ".mts", ".cts"];

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

pub fn read_rust_service_files(
    repo_dir: &Path,
    service_root: &str,
    tracked_files: &[String],
) -> Vec<(String, String)> {
    tracked_files
        .iter()
        .filter(|rel| rel.ends_with(".rs") && under_root(rel, service_root) && !is_test_file(rel))
        .filter_map(|rel| {
            std::fs::read_to_string(repo_dir.join(rel))
                .ok()
                .map(|raw| (rel.clone(), strip_cfg_test(&raw)))
        })
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

fn build_code_mask(source: &str, next_span: fn(&[u8], usize) -> Option<usize>) -> Vec<bool> {
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

fn next_rust_non_code_span(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i..i + 2) == Some(b"//") {
        return Some(skip_to_newline(bytes, i + 2));
    }
    if bytes.get(i..i + 2) == Some(b"/*") {
        return Some(skip_nested_block_comment(bytes, i + 2));
    }
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

fn skip_to_newline(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i] != b'\n' {
        i += 1;
    }
    i
}

fn skip_nested_block_comment(bytes: &[u8], mut i: usize) -> usize {
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

fn skip_rust_raw_string(bytes: &[u8], start: usize) -> Option<usize> {
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

fn skip_rust_char_literal(bytes: &[u8], start: usize) -> Option<usize> {
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

fn skip_quoted_string(bytes: &[u8], start: usize, quote: u8) -> usize {
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

fn next_ts_non_code_span(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i..i + 2) == Some(b"//") {
        return Some(skip_to_newline(bytes, i + 2));
    }
    if bytes.get(i..i + 2) == Some(b"/*") {
        return Some(skip_flat_block_comment(bytes, i + 2));
    }
    if matches!(bytes[i], b'"' | b'\'') {
        return Some(skip_quoted_string(bytes, i, bytes[i]));
    }
    if bytes[i] == b'`' {
        return Some(skip_ts_template(bytes, i));
    }
    None
}

fn skip_flat_block_comment(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"*/") {
            return i + 2;
        }
        i += 1;
    }
    bytes.len()
}

fn skip_ts_template(bytes: &[u8], start: usize) -> usize {
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
    let bytes = source.as_bytes();
    let mut parts = Vec::new();
    let mut depth = (0usize, 0usize, 0usize);
    let mut seg_start = start;
    for i in start..end {
        if !mask[base_offset + i] {
            continue;
        }
        match bytes[i] {
            b'(' => depth.0 += 1,
            b')' => depth.0 = depth.0.saturating_sub(1),
            b'{' => depth.1 += 1,
            b'}' => depth.1 = depth.1.saturating_sub(1),
            b'[' => depth.2 += 1,
            b']' => depth.2 = depth.2.saturating_sub(1),
            b',' if depth == (0, 0, 0) => {
                push_trimmed_arg(&mut parts, source, seg_start, i);
                seg_start = i + 1;
            }
            _ => {}
        }
    }
    push_trimmed_arg(&mut parts, source, seg_start, end);
    parts
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

pub fn sort_extracted_calls(calls: &mut [super::ExtractedCall]) {
    calls.sort_by_key(|c| (c.file.clone(), c.line, c.method, c.path_norm.clone()));
}

pub fn sort_extracted_endpoints(endpoints: &mut [super::ExtractedEndpoint]) {
    endpoints.sort_by_key(|e| (e.file.clone(), e.line, e.method, e.path_norm.clone()));
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
        .map(|seg| if is_dynamic_segment(seg) { DYNAMIC_SEG } else { seg })
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
