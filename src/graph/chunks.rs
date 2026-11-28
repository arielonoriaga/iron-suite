use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::scan::{
    LineIndex, find_astro_blocks, find_matching_delim, find_matching_open,
    find_semicolon_at_depth_zero, is_ident_byte, is_ts_ident_byte, next_rust_literal_span,
    next_ts_literal_span, read_ident, rust_code_mask, skip_angle_generics, skip_ascii_ws,
    skip_flat_block_comment, skip_masked_ws, skip_masked_ws_range, skip_nested_block_comment,
    skip_to_newline, split_top_level_args, split_ts_object_kv, ts_code_mask, update_delim_depth,
};
use super::types::{ChunkKind, ExtractedChunk, Stack};

const CHUNK_HASH_LEN: usize = 16;
const ASTRO_EXT: &str = ".astro";
const KW_WHERE: &str = "where";
const KW_FOR: &str = "for";
const KW_PUB: &str = "pub";
const KW_EXTERN: &str = "extern";
const KW_ASYNC: &str = "async";
const KW_FUNCTION: &str = "function";
const KW_EXPORT: &str = "export";
const KW_IMPL: &str = "impl";
const KW_MOD: &str = "mod";
const KW_TRAIT: &str = "trait";
const KW_FN: &str = "fn";
const KW_STRUCT: &str = "struct";
const KW_ENUM: &str = "enum";
const KW_CONST: &str = "const";
const KW_CLASS: &str = "class";
const FRONTMATTER_NAME: &str = "frontmatter";
const RUST_MODIFIERS: &[&str] = &[KW_PUB, KW_ASYNC, "unsafe", KW_CONST, KW_EXTERN, "default"];
const RUST_TYPE_QUALIFIERS: &[&str] = &["dyn", "mut", KW_CONST, "ref"];
const RUST_CONST_FN_NEXT: &[&str] = &[KW_FN, "unsafe", KW_EXTERN];
const TS_DECL_MODIFIERS: &[&str] = &[KW_EXPORT, "default", KW_ASYNC, "declare"];
const TS_CLASS_MODIFIERS: &[&str] = &[
    "public",
    "private",
    "protected",
    "readonly",
    "static",
    KW_ASYNC,
    "override",
    "abstract",
    "get",
    "set",
    "declare",
];
const TS_STMT_STARTERS: &[&str] = &[
    KW_EXPORT,
    "import",
    KW_CONST,
    "let",
    "var",
    KW_FUNCTION,
    KW_CLASS,
    "interface",
    "type",
    KW_ENUM,
    KW_ASYNC,
];

pub fn normalize_code_text(slice: &str, is_rust: bool) -> String {
    let bytes = slice.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    let mut saw_sep = false;

    while i < bytes.len() {
        if let Some(next_i) = skip_comment_or_ws(bytes, i, is_rust) {
            i = next_i;
            saw_sep = true;
            continue;
        }
        if let Some(lit_end) = next_literal_end(bytes, i, is_rust) {
            maybe_emit_separator(&mut out, saw_sep, bytes[i]);
            out.extend_from_slice(&bytes[i..lit_end]);
            i = lit_end;
            saw_sep = false;
            continue;
        }
        maybe_emit_separator(&mut out, saw_sep, bytes[i]);
        out.push(bytes[i]);
        i += 1;
        saw_sep = false;
    }

    String::from_utf8(out).unwrap_or_else(|_| slice.to_owned())
}

fn skip_comment_or_ws(bytes: &[u8], i: usize, is_rust: bool) -> Option<usize> {
    if bytes.get(i..i + 2) == Some(b"//") {
        return Some(skip_to_newline(bytes, i + 2));
    }
    if bytes.get(i..i + 2) == Some(b"/*") {
        return Some(if is_rust {
            skip_nested_block_comment(bytes, i + 2)
        } else {
            skip_flat_block_comment(bytes, i + 2)
        });
    }
    bytes[i].is_ascii_whitespace().then_some(i + 1)
}

fn next_literal_end(bytes: &[u8], i: usize, is_rust: bool) -> Option<usize> {
    if is_rust {
        next_rust_literal_span(bytes, i)
    } else {
        next_ts_literal_span(bytes, i)
    }
}

fn maybe_emit_separator(out: &mut Vec<u8>, saw_sep: bool, next_byte: u8) {
    if saw_sep
        && let Some(&prev) = out.last()
        && is_ts_ident_byte(prev)
        && is_ts_ident_byte(next_byte)
    {
        out.push(b' ');
    }
}

fn finish_hash(hasher: Sha256) -> String {
    let digest = format!("{:x}", hasher.finalize());
    digest[..CHUNK_HASH_LEN].to_owned()
}

fn sha256_prefix(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    finish_hash(hasher)
}

pub fn hash_normalized(slice: &str, is_rust: bool) -> String {
    let norm = normalize_code_text(slice, is_rust);
    sha256_prefix(norm.as_bytes())
}

pub fn compute_pair_key(
    caller_chunk_hash: &str,
    handler_chunk_hash: &str,
    contract_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(caller_chunk_hash.as_bytes());
    hasher.update(b"|");
    hasher.update(handler_chunk_hash.as_bytes());
    hasher.update(b"|");
    hasher.update(contract_hash.as_bytes());
    finish_hash(hasher)
}

pub fn normalize_file_hash(rel: &str, source: &str, stack: Stack) -> String {
    match stack {
        Stack::Axum => hash_normalized(source, true),
        Stack::Spa | Stack::Hono | Stack::Express => hash_normalized(source, false),
        Stack::Web if rel.ends_with(ASTRO_EXT) => hash_astro_blocks(source),
        Stack::Web => hash_normalized(source, false),
        Stack::Nginx => sha256_prefix(source.as_bytes()),
    }
}

fn hash_astro_blocks(source: &str) -> String {
    let mut hasher = Sha256::new();
    for block in find_astro_blocks(source) {
        let norm = normalize_code_text(&source[block.start..block.end], false);
        hasher.update(if block.is_frontmatter { b"F:" } else { b"S:" });
        hasher.update(norm.as_bytes());
        hasher.update(b"\n");
    }
    finish_hash(hasher)
}

pub fn extract_chunks_for_stack(
    rel: &str,
    source: &str,
    stack: Stack,
    is_client_file: bool,
) -> Vec<ExtractedChunk> {
    match stack {
        Stack::Axum => extract_rust_chunks(source),
        Stack::Spa => extract_ts_chunks(source, is_client_file),
        Stack::Hono | Stack::Express => extract_ts_chunks(source, false),
        Stack::Web if rel.ends_with(ASTRO_EXT) => extract_astro_chunks(source),
        Stack::Web => extract_ts_chunks(source, false),
        Stack::Nginx => Vec::new(),
    }
}

struct ChunkScanCtx<'a> {
    source: &'a str,
    bytes: &'a [u8],
    mask: &'a [bool],
    lines: &'a LineIndex,
    is_rust: bool,
}

impl<'a> ChunkScanCtx<'a> {
    fn push_chunk(
        &self,
        out: &mut Vec<ExtractedChunk>,
        kind: ChunkKind,
        qualified_name: String,
        start_byte: usize,
        end_byte_inclusive: usize,
    ) {
        let end_excl = (end_byte_inclusive + 1).min(self.bytes.len());
        if start_byte >= end_excl {
            return;
        }
        let slice = &self.source[start_byte..end_excl];
        let last_idx = end_byte_inclusive.min(self.bytes.len().saturating_sub(1));
        out.push(ExtractedChunk {
            kind,
            qualified_name,
            start_line: self.lines.line_at(start_byte),
            end_line: self.lines.line_at(last_idx),
            norm_hash: hash_normalized(slice, self.is_rust),
        });
    }
}

fn skip_balanced_group(bytes: &[u8], mask: &[bool], pos: usize, limit: usize) -> Option<usize> {
    let close = match bytes.get(pos).copied()? {
        b'{' => b'}',
        b'(' => b')',
        b'[' => b']',
        _ => return None,
    };
    Some(find_matching_delim(bytes, mask, pos, bytes[pos], close).map_or(limit, |c| c + 1))
}

fn run_chunk_extraction(
    source: &str,
    mask: &[bool],
    is_rust: bool,
    scan: impl FnOnce(&ChunkScanCtx<'_>, &mut Vec<ExtractedChunk>),
) -> Vec<ExtractedChunk> {
    let lines = LineIndex::new(source);
    let ctx = ChunkScanCtx {
        source,
        bytes: source.as_bytes(),
        mask,
        lines: &lines,
        is_rust,
    };
    let mut out = Vec::new();
    scan(&ctx, &mut out);
    disambiguate_chunks(&mut out);
    out
}

pub fn extract_rust_chunks(source: &str) -> Vec<ExtractedChunk> {
    let mask = rust_code_mask(source);
    run_chunk_extraction(source, &mask, true, |ctx, out| {
        scan_rust_scope(ctx, 0, source.len(), None, out);
    })
}

fn scan_rust_scope(
    ctx: &ChunkScanCtx<'_>,
    start: usize,
    end: usize,
    impl_type: Option<&str>,
    out: &mut Vec<ExtractedChunk>,
) {
    let mut i = start;
    while i < end {
        if !ctx.mask[i] {
            i += 1;
            continue;
        }
        if let Some(after) = skip_balanced_group(ctx.bytes, ctx.mask, i, end) {
            i = after;
            continue;
        }
        let Some((ident, next_i)) = read_ident(ctx.source, &ctx.bytes[..end], i) else {
            i += 1;
            continue;
        };
        if i > start && is_ident_byte(ctx.bytes[i - 1]) {
            i = next_i;
            continue;
        }
        let site = RustItemSite {
            kw_pos: i,
            after_kw: next_i,
            scope_start: start,
            limit: end,
        };
        i = dispatch_rust_item(ctx, ident, site, impl_type, out);
    }
}

#[derive(Clone, Copy)]
struct RustItemSite {
    kw_pos: usize,
    after_kw: usize,
    scope_start: usize,
    limit: usize,
}

fn dispatch_rust_item(
    ctx: &ChunkScanCtx<'_>,
    ident: &str,
    site: RustItemSite,
    impl_type: Option<&str>,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    match ident {
        KW_IMPL => handle_rust_impl(ctx, site.after_kw, site.limit, out),
        KW_MOD => handle_rust_mod(ctx, site.after_kw, site.limit, out),
        KW_TRAIT => skip_rust_brace_or_semi(ctx, site.after_kw, site.limit),
        KW_FN => handle_rust_fn(ctx, site, impl_type, out),
        KW_STRUCT => emit_named_rust_item(
            ctx,
            site,
            ChunkKind::Struct,
            None,
            |name_end| find_rust_struct_end(ctx.bytes, ctx.mask, name_end, site.limit),
            out,
        ),
        KW_ENUM => emit_named_rust_item(
            ctx,
            site,
            ChunkKind::Enum,
            None,
            |name_end| {
                let open = find_rust_header_brace(ctx.bytes, ctx.mask, name_end, site.limit)?;
                find_matching_delim(ctx.bytes, ctx.mask, open, b'{', b'}')
            },
            out,
        ),
        KW_CONST => handle_rust_const(ctx, site, impl_type, out),
        _ => site.after_kw,
    }
}

fn handle_rust_impl(ctx: &ChunkScanCtx<'_>, after_kw: usize, limit: usize, out: &mut Vec<ExtractedChunk>) -> usize {
    let Some(open_brace) = find_rust_header_brace(ctx.bytes, ctx.mask, after_kw, limit) else {
        return after_kw;
    };
    let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, open_brace, b'{', b'}') else {
        return open_brace + 1;
    };
    let target = extract_impl_target_type(ctx, after_kw, open_brace);
    scan_rust_scope(ctx, open_brace + 1, close_brace, target.as_deref(), out);
    close_brace + 1
}

fn handle_rust_mod(ctx: &ChunkScanCtx<'_>, after_kw: usize, limit: usize, out: &mut Vec<ExtractedChunk>) -> usize {
    let pos = skip_masked_ws_range(ctx.bytes, ctx.mask, after_kw, limit);
    let Some((_, name_end)) = read_ident(ctx.source, &ctx.bytes[..limit], pos) else {
        return after_kw;
    };
    let after_name = skip_masked_ws_range(ctx.bytes, ctx.mask, name_end, limit);
    if ctx.bytes.get(after_name) == Some(&b'{') && ctx.mask[after_name] {
        let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, after_name, b'{', b'}')
        else {
            return after_name + 1;
        };
        scan_rust_scope(ctx, after_name + 1, close_brace, None, out);
        return close_brace + 1;
    }
    after_name
}

enum ByteScanStep {
    Advance(usize),
    Found(usize),
    Abort,
}

fn scan_masked_bytes(
    mask: &[bool],
    start: usize,
    limit: usize,
    mut step: impl FnMut(usize) -> ByteScanStep,
) -> Option<usize> {
    let mut pos = start;
    while pos < limit {
        if !mask[pos] {
            pos += 1;
            continue;
        }
        match step(pos) {
            ByteScanStep::Advance(next) => pos = next,
            ByteScanStep::Found(hit) => return Some(hit),
            ByteScanStep::Abort => return None,
        }
    }
    None
}

fn skip_rust_brace_or_semi(ctx: &ChunkScanCtx<'_>, start: usize, limit: usize) -> usize {
    scan_masked_bytes(ctx.mask, start, limit, |pos| match ctx.bytes[pos] {
        b';' => ByteScanStep::Found(pos + 1),
        b'{' => ByteScanStep::Found(
            find_matching_delim(ctx.bytes, ctx.mask, pos, b'{', b'}').map_or(limit, |c| c + 1),
        ),
        _ => ByteScanStep::Advance(pos + 1),
    })
    .unwrap_or(limit)
}

fn emit_named_rust_item(
    ctx: &ChunkScanCtx<'_>,
    site: RustItemSite,
    kind: ChunkKind,
    impl_type: Option<&str>,
    find_end: impl FnOnce(usize) -> Option<usize>,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    let pos = skip_masked_ws_range(ctx.bytes, ctx.mask, site.after_kw, site.limit);
    let Some((name, name_end)) = read_ident(ctx.source, &ctx.bytes[..site.limit], pos) else {
        return site.after_kw;
    };
    let Some(end_byte) = find_end(name_end) else {
        return name_end;
    };
    let item_start = backtrack_rust_item_start(ctx, site.kw_pos, site.scope_start);
    ctx.push_chunk(out, kind, qualify_rust_name(impl_type, name), item_start, end_byte);
    end_byte + 1
}

fn handle_rust_fn(ctx: &ChunkScanCtx<'_>, site: RustItemSite, impl_type: Option<&str>, out: &mut Vec<ExtractedChunk>) -> usize {
    let mut skipped_semi = None;
    let next = emit_named_rust_item(
        ctx,
        site,
        ChunkKind::Fn,
        impl_type,
        |name_end| {
            let term = find_rust_header_term(ctx.bytes, ctx.mask, name_end, site.limit, false)?;
            if ctx.bytes[term] == b';' {
                skipped_semi = Some(term + 1);
                return None;
            }
            find_matching_delim(ctx.bytes, ctx.mask, term, b'{', b'}')
        },
        out,
    );
    skipped_semi.unwrap_or(next)
}

fn handle_rust_const(ctx: &ChunkScanCtx<'_>, site: RustItemSite, impl_type: Option<&str>, out: &mut Vec<ExtractedChunk>) -> usize {
    let pos = skip_masked_ws_range(ctx.bytes, ctx.mask, site.after_kw, site.limit);
    let Some((name, _)) = read_ident(ctx.source, &ctx.bytes[..site.limit], pos) else {
        return site.after_kw;
    };
    if RUST_CONST_FN_NEXT.contains(&name) {
        return pos;
    }
    emit_named_rust_item(
        ctx,
        site,
        ChunkKind::Const,
        impl_type,
        |name_end| {
            let after_name = skip_masked_ws_range(ctx.bytes, ctx.mask, name_end, site.limit);
            if ctx.bytes.get(after_name) != Some(&b':') || !ctx.mask[after_name] {
                return None;
            }
            let semi = find_semicolon_at_depth_zero(ctx.bytes, ctx.mask, after_name, site.limit);
            (semi < site.limit).then_some(semi)
        },
        out,
    )
}

fn qualify_rust_name(impl_type: Option<&str>, name: &str) -> String {
    match impl_type {
        Some(ty) if !ty.is_empty() => format!("{ty}::{name}"),
        _ => name.to_owned(),
    }
}

fn find_rust_header_brace(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> Option<usize> {
    let term = find_rust_header_term(bytes, mask, start, limit, true)?;
    (bytes[term] == b'{').then_some(term)
}

fn find_rust_header_term(
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    limit: usize,
    skip_angles: bool,
) -> Option<usize> {
    scan_masked_bytes(mask, start, limit, |pos| match bytes[pos] {
        b';' | b'{' => ByteScanStep::Found(pos),
        b'<' if skip_angles => {
            ByteScanStep::Advance(skip_angle_generics(bytes, mask, pos, limit, true).unwrap_or(pos + 1))
        }
        b'(' | b'[' => {
            ByteScanStep::Advance(skip_balanced_group(bytes, mask, pos, limit).unwrap_or(pos + 1))
        }
        _ => ByteScanStep::Advance(pos + 1),
    })
}

fn find_rust_struct_end(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> Option<usize> {
    scan_masked_bytes(mask, start, limit, |pos| match bytes[pos] {
        b';' => ByteScanStep::Found(pos),
        b'{' => find_matching_delim(bytes, mask, pos, b'{', b'}')
            .map_or(ByteScanStep::Abort, ByteScanStep::Found),
        b'(' => match find_matching_delim(bytes, mask, pos, b'(', b')') {
            Some(close) => {
                let semi = find_semicolon_at_depth_zero(bytes, mask, close + 1, limit);
                if semi < limit {
                    ByteScanStep::Found(semi)
                } else {
                    ByteScanStep::Abort
                }
            }
            None => ByteScanStep::Abort,
        },
        b'<' => ByteScanStep::Advance(skip_angle_generics(bytes, mask, pos, limit, true).unwrap_or(pos + 1)),
        _ => ByteScanStep::Advance(pos + 1),
    })
}

fn extract_impl_target_type(ctx: &ChunkScanCtx<'_>, start: usize, end: usize) -> Option<String> {
    let mut pos = skip_masked_ws_range(ctx.bytes, ctx.mask, start, end);
    if ctx.bytes.get(pos) == Some(&b'<') && ctx.mask[pos] {
        pos = skip_angle_generics(ctx.bytes, ctx.mask, pos, end, true).unwrap_or(pos + 1);
    }
    let (ty_start, where_pos) = scan_impl_header_bounds(ctx, pos, end);
    extract_primary_type_ident(ctx, ty_start, where_pos)
}

fn scan_impl_header_bounds(ctx: &ChunkScanCtx<'_>, start: usize, end: usize) -> (usize, usize) {
    let mut depth = [0usize; 4];
    let mut for_after: Option<usize> = None;
    let mut scan = start;
    while scan < end {
        if !ctx.mask[scan] {
            scan += 1;
            continue;
        }
        if depth == [0, 0, 0, 0]
            && let Some((ident, next_s)) = read_ident(ctx.source, &ctx.bytes[..end], scan)
        {
            if ident == KW_WHERE {
                return (for_after.unwrap_or(start), scan);
            }
            if ident == KW_FOR {
                for_after = Some(next_s);
            }
            scan = next_s;
            continue;
        }
        let prev = if scan > 0 { ctx.bytes[scan - 1] } else { 0 };
        update_delim_depth(ctx.bytes[scan], prev, true, &mut depth);
        scan += 1;
    }
    (for_after.unwrap_or(start), end)
}

fn extract_primary_type_ident(ctx: &ChunkScanCtx<'_>, start: usize, end: usize) -> Option<String> {
    let mut pos = start;
    let mut last_ident: Option<String> = None;
    while pos < end {
        if !ctx.mask[pos] {
            pos += 1;
            continue;
        }
        if ctx.bytes[pos] == b'<' {
            pos = skip_angle_generics(ctx.bytes, ctx.mask, pos, end, true).unwrap_or(end);
            continue;
        }
        if ctx.bytes[pos] == b'(' {
            pos = skip_balanced_group(ctx.bytes, ctx.mask, pos, end).unwrap_or(end);
            continue;
        }
        if let Some((ident, next_p)) = read_ident(ctx.source, &ctx.bytes[..end], pos) {
            if !RUST_TYPE_QUALIFIERS.contains(&ident) {
                last_ident = Some(ident.to_owned());
            }
            pos = next_p;
        } else {
            pos += 1;
        }
    }
    last_ident
}

fn backtrack_rust_item_start(ctx: &ChunkScanCtx<'_>, kw_pos: usize, floor: usize) -> usize {
    let mut start = kw_pos;
    while let Some(prev_start) = step_rust_prefix_back(ctx, start, floor) {
        start = prev_start;
    }
    start
}

fn step_rust_prefix_back(ctx: &ChunkScanCtx<'_>, pos: usize, floor: usize) -> Option<usize> {
    let prev = skip_ws_and_comments_back(ctx.bytes, ctx.mask, pos, floor);
    if prev <= floor {
        return None;
    }
    match ctx.bytes[prev - 1] {
        b')' if ctx.mask[prev - 1] => {
            let open = find_matching_open(ctx.bytes, ctx.mask, prev - 1, b'(', b')')?;
            let before = skip_ws_and_comments_back(ctx.bytes, ctx.mask, open, floor);
            let (ws, word) = read_ident_back(ctx.source, ctx.bytes, before, floor)?;
            (open >= floor && word == KW_PUB).then_some(ws)
        }
        b']' if ctx.mask[prev - 1] => {
            let open = find_matching_open(ctx.bytes, ctx.mask, prev - 1, b'[', b']')?;
            (open > floor && ctx.bytes[open - 1] == b'#' && ctx.mask[open - 1])
                .then_some(open - 1)
        }
        _ => {
            let (ws, word) = read_ident_back(ctx.source, ctx.bytes, prev, floor)?;
            RUST_MODIFIERS.contains(&word).then_some(ws)
        }
    }
}

fn read_ident_back<'a>(
    source: &'a str,
    bytes: &[u8],
    end: usize,
    floor: usize,
) -> Option<(usize, &'a str)> {
    let mut pos = end;
    while pos > floor && is_ident_byte(bytes[pos - 1]) {
        pos -= 1;
    }
    (pos < end).then(|| (pos, &source[pos..end]))
}

fn skip_ws_and_comments_back(bytes: &[u8], mask: &[bool], mut pos: usize, floor: usize) -> usize {
    while pos > floor && (!mask[pos - 1] || bytes[pos - 1].is_ascii_whitespace()) {
        pos -= 1;
    }
    pos
}

pub fn extract_ts_chunks(source: &str, is_client_file: bool) -> Vec<ExtractedChunk> {
    let mask = ts_code_mask(source);
    run_chunk_extraction(source, &mask, false, |ctx, out| {
        scan_ts_top_level(ctx, is_client_file, out);
    })
}

fn scan_ts_top_level(ctx: &ChunkScanCtx<'_>, is_client_file: bool, out: &mut Vec<ExtractedChunk>) {
    let limit = ctx.bytes.len();
    let mut i = 0usize;
    while i < limit {
        if !ctx.mask[i] {
            i += 1;
            continue;
        }
        if ctx.bytes[i] == b'{' {
            i = find_matching_delim(ctx.bytes, ctx.mask, i, b'{', b'}').map_or(limit, |c| c + 1);
            continue;
        }
        let Some((ident, next_i)) = read_ts_ident_at(ctx.source, ctx.bytes, i, limit) else {
            i += 1;
            continue;
        };
        if i > 0 && (is_ts_ident_byte(ctx.bytes[i - 1]) || ctx.bytes[i - 1] == b'.') {
            i = next_i;
            continue;
        }
        i = match ident {
            KW_FUNCTION => handle_ts_function(ctx, i, next_i, out),
            KW_CLASS => handle_ts_class(ctx, next_i, out),
            KW_CONST => handle_ts_const(ctx, i, next_i, is_client_file, out),
            _ => next_i,
        };
    }
}

fn handle_ts_function(
    ctx: &ChunkScanCtx<'_>,
    kw_pos: usize,
    after_kw: usize,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    let limit = ctx.bytes.len();
    let mut pos = skip_masked_ws_range(ctx.bytes, ctx.mask, after_kw, limit);
    if ctx.bytes.get(pos) == Some(&b'*') && ctx.mask[pos] {
        pos = skip_masked_ws_range(ctx.bytes, ctx.mask, pos + 1, limit);
    }
    let Some((name, name_end)) = read_ts_ident_at(ctx.source, ctx.bytes, pos, limit) else {
        return after_kw;
    };
    let Some(open_brace) = find_ts_fn_brace(ctx.bytes, ctx.mask, name_end, limit) else {
        return name_end;
    };
    let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, open_brace, b'{', b'}') else {
        return open_brace + 1;
    };
    let start = backtrack_ts_modifiers(ctx, kw_pos);
    ctx.push_chunk(out, ChunkKind::Fn, name.to_owned(), start, close_brace);
    close_brace + 1
}

fn handle_ts_class(
    ctx: &ChunkScanCtx<'_>,
    after_kw: usize,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    let limit = ctx.bytes.len();
    let pos = skip_masked_ws_range(ctx.bytes, ctx.mask, after_kw, limit);
    let Some((class_name, name_end)) = read_ts_ident_at(ctx.source, ctx.bytes, pos, limit) else {
        return after_kw;
    };
    let Some(open_brace) = find_rust_header_brace(ctx.bytes, ctx.mask, name_end, limit) else {
        return name_end;
    };
    let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, open_brace, b'{', b'}') else {
        return open_brace + 1;
    };
    extract_ts_class_methods(ctx, class_name, open_brace + 1, close_brace, out);
    close_brace + 1
}

fn extract_ts_class_methods(
    ctx: &ChunkScanCtx<'_>,
    class_name: &str,
    start: usize,
    end: usize,
    out: &mut Vec<ExtractedChunk>,
) {
    let mut i = start;
    while i < end {
        i = skip_masked_ws_range(ctx.bytes, ctx.mask, i, end);
        if i >= end {
            break;
        }
        i = match ctx.bytes[i] {
            b';' => i + 1,
            b'@' => skip_ts_decorator(ctx.bytes, ctx.mask, i, end),
            _ => parse_ts_class_member(ctx, class_name, i, end, out),
        };
    }
}

fn parse_ts_class_member(
    ctx: &ChunkScanCtx<'_>,
    class_name: &str,
    member_start: usize,
    end: usize,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    let name_pos = skip_ts_class_modifiers(ctx, member_start, end);
    let Some((method_name, name_end)) = read_ts_ident_at(ctx.source, ctx.bytes, name_pos, end)
    else {
        return advance_past_ts_member(ctx.bytes, ctx.mask, member_start, end);
    };
    let scan = skip_optional_ts_member_sig_prefix(ctx.bytes, ctx.mask, name_end, end);
    let method_end = if scan < end && ctx.mask[scan] && ctx.bytes[scan] == b'(' {
        let Some(open_brace) = find_ts_fn_brace(ctx.bytes, ctx.mask, scan, end) else {
            return advance_past_ts_member(ctx.bytes, ctx.mask, scan, end);
        };
        let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, open_brace, b'{', b'}')
        else {
            return end;
        };
        Some(close_brace)
    } else if let Some(eq_pos) = find_ts_assign_eq(ctx.bytes, ctx.mask, scan, end) {
        let val_start = skip_masked_ws_range(ctx.bytes, ctx.mask, eq_pos + 1, end);
        parse_ts_arrow_end(ctx, val_start, end)
    } else {
        None
    };
    if let Some(end_byte) = method_end {
        ctx.push_chunk(
            out,
            ChunkKind::Method,
            format!("{class_name}.{method_name}"),
            member_start,
            end_byte,
        );
        return end_byte + 1;
    }
    advance_past_ts_member(ctx.bytes, ctx.mask, name_end, end)
}

fn skip_ts_class_modifiers(ctx: &ChunkScanCtx<'_>, start: usize, end: usize) -> usize {
    let mut pos = start;
    loop {
        let p = skip_masked_ws_range(ctx.bytes, ctx.mask, pos, end);
        let Some((tok, next_p)) = read_ts_ident_at(ctx.source, ctx.bytes, p, end) else {
            return p;
        };
        let after = skip_masked_ws_range(ctx.bytes, ctx.mask, next_p, end);
        if TS_CLASS_MODIFIERS.contains(&tok)
            && !matches!(ctx.bytes.get(after), Some(b'(' | b'<' | b'=' | b':' | b';'))
        {
            pos = next_p;
            continue;
        }
        return p;
    }
}

fn skip_optional_ts_member_sig_prefix(bytes: &[u8], mask: &[bool], start: usize, end: usize) -> usize {
    let mut scan = skip_masked_ws_range(bytes, mask, start, end);
    loop {
        match bytes.get(scan).copied().filter(|_| mask[scan]) {
            Some(b'?') => scan = skip_masked_ws_range(bytes, mask, scan + 1, end),
            Some(b'<') => {
                let after = skip_angle_generics(bytes, mask, scan, end, true).unwrap_or(scan + 1);
                scan = skip_masked_ws_range(bytes, mask, after, end);
            }
            _ => return scan,
        }
    }
}

fn skip_ts_decorator(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> usize {
    let mut pos = start + 1;
    while pos < limit && (is_ts_ident_byte(bytes[pos]) || bytes[pos] == b'.') {
        pos += 1;
    }
    pos = skip_masked_ws_range(bytes, mask, pos, limit);
    if bytes.get(pos) == Some(&b'(') && mask[pos] {
        return find_matching_delim(bytes, mask, pos, b'(', b')').map_or(limit, |c| c + 1);
    }
    pos
}

fn advance_past_ts_member(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> usize {
    scan_masked_bytes(mask, start, limit, |pos| match bytes[pos] {
        b';' | b'\n' => ByteScanStep::Found(pos + 1),
        b'{' => ByteScanStep::Found(
            find_matching_delim(bytes, mask, pos, b'{', b'}').map_or(limit, |c| c + 1),
        ),
        b'(' | b'[' => {
            ByteScanStep::Advance(skip_balanced_group(bytes, mask, pos, limit).unwrap_or(limit))
        }
        _ => ByteScanStep::Advance(pos + 1),
    })
    .unwrap_or(limit)
}

fn handle_ts_const(
    ctx: &ChunkScanCtx<'_>,
    kw_pos: usize,
    after_kw: usize,
    is_client_file: bool,
    out: &mut Vec<ExtractedChunk>,
) -> usize {
    let limit = ctx.bytes.len();
    let pos = skip_masked_ws_range(ctx.bytes, ctx.mask, after_kw, limit);
    let Some((name, name_end)) = read_ts_ident_at(ctx.source, ctx.bytes, pos, limit) else {
        return after_kw;
    };
    let Some(eq_pos) = find_ts_assign_eq(ctx.bytes, ctx.mask, name_end, limit) else {
        return name_end;
    };
    let val_start = skip_masked_ws_range(ctx.bytes, ctx.mask, eq_pos + 1, limit);
    if val_start >= limit {
        return limit;
    }
    let decl_start = backtrack_ts_modifiers(ctx, kw_pos);
    let is_exported = ctx.source[decl_start..kw_pos].contains(KW_EXPORT);

    if is_client_file && is_exported && ctx.bytes[val_start] == b'{' && ctx.mask[val_start] {
        if let Some(close_brace) = find_matching_delim(ctx.bytes, ctx.mask, val_start, b'{', b'}') {
            extract_ts_object_members(ctx, val_start + 1, close_brace, name, out);
            return close_brace + 1;
        }
        return val_start + 1;
    }

    if let Some((kind, end_byte)) = parse_ts_arrow_end(ctx, val_start, limit)
        .map(|e| (ChunkKind::Arrow, e))
        .or_else(|| parse_ts_fn_expr_end(ctx, val_start, limit).map(|e| (ChunkKind::Fn, e)))
    {
        ctx.push_chunk(out, kind, name.to_owned(), decl_start, end_byte);
        return end_byte + 1;
    }

    val_start
}

fn extract_ts_object_members(
    ctx: &ChunkScanCtx<'_>,
    start: usize,
    end: usize,
    prefix: &str,
    out: &mut Vec<ExtractedChunk>,
) {
    for (entry_offset, entry_text) in split_top_level_args(ctx.source, ctx.mask, 0, start, end) {
        let Some((key, val_offset, val_text)) = split_ts_object_kv(entry_text, entry_offset, ctx.mask)
        else {
            continue;
        };
        let full_key = format!("{prefix}.{key}");
        if val_text.starts_with('{')
            && ctx.mask.get(val_offset).copied().unwrap_or(false)
            && let Some(sub_close) = find_matching_delim(ctx.bytes, ctx.mask, val_offset, b'{', b'}')
        {
            extract_ts_object_members(ctx, val_offset + 1, sub_close, &full_key, out);
            continue;
        }
        let end_incl = entry_offset + entry_text.len().saturating_sub(1);
        let key_start = entry_offset + skip_masked_ws(entry_text.as_bytes(), entry_offset, ctx.mask, 0);
        ctx.push_chunk(out, ChunkKind::ObjectMember, full_key, key_start, end_incl);
    }
}

enum DepthZeroStep {
    Continue,
    Stop(Option<usize>),
}

fn scan_depth_zero(
    bytes: &[u8],
    mask: &[bool],
    start: usize,
    limit: usize,
    track_angles: bool,
    mut on_zero: impl FnMut(usize) -> DepthZeroStep,
) -> Option<usize> {
    let mut depth = [0usize; 4];
    for pos in start..limit {
        if !mask[pos] {
            continue;
        }
        if depth == [0, 0, 0, 0]
            && let DepthZeroStep::Stop(res) = on_zero(pos)
        {
            return res;
        }
        let prev = if pos > 0 { bytes[pos - 1] } else { 0 };
        update_delim_depth(bytes[pos], prev, track_angles, &mut depth);
    }
    None
}

fn find_ts_assign_eq(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> Option<usize> {
    scan_depth_zero(bytes, mask, start, limit, true, |pos| match bytes[pos] {
        b';' => DepthZeroStep::Stop(None),
        b'=' if !matches!(bytes.get(pos + 1), Some(b'=' | b'>')) => DepthZeroStep::Stop(Some(pos)),
        _ => DepthZeroStep::Continue,
    })
}

fn parse_ts_arrow_end(ctx: &ChunkScanCtx<'_>, val_start: usize, limit: usize) -> Option<usize> {
    let mut pos = skip_leading_ts_kw(ctx, val_start, limit, KW_ASYNC);
    if ctx.bytes.get(pos) == Some(&b'<') && ctx.mask[pos] {
        let after = skip_angle_generics(ctx.bytes, ctx.mask, pos, limit, true)?;
        pos = skip_masked_ws_range(ctx.bytes, ctx.mask, after, limit);
    }
    pos = match ctx.bytes.get(pos).copied().filter(|_| ctx.mask[pos]) {
        Some(b'(') => find_matching_delim(ctx.bytes, ctx.mask, pos, b'(', b')')? + 1,
        _ => read_ts_ident_at(ctx.source, ctx.bytes, pos, limit)?.1,
    };
    let arrow = find_ts_arrow_token(ctx.bytes, ctx.mask, pos, limit)?;
    let body_start = skip_masked_ws_range(ctx.bytes, ctx.mask, arrow + 2, limit);
    if body_start >= limit {
        return None;
    }
    if ctx.bytes[body_start] == b'{' && ctx.mask[body_start] {
        let close = find_matching_delim(ctx.bytes, ctx.mask, body_start, b'{', b'}')?;
        let after = skip_ascii_ws(ctx.bytes, close + 1, limit);
        return Some(if ctx.bytes.get(after) == Some(&b';') && ctx.mask[after] {
            after
        } else {
            close
        });
    }
    Some(find_ts_expr_stmt_end(ctx, body_start, limit))
}

fn skip_leading_ts_kw(ctx: &ChunkScanCtx<'_>, start: usize, limit: usize, kw: &str) -> usize {
    if let Some((tok, next_p)) = read_ts_ident_at(ctx.source, ctx.bytes, start, limit)
        && tok == kw
    {
        return skip_masked_ws_range(ctx.bytes, ctx.mask, next_p, limit);
    }
    start
}

fn find_ts_arrow_token(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> Option<usize> {
    scan_depth_zero(bytes, mask, start, limit.saturating_sub(1), false, |pos| match bytes[pos] {
        b';' => DepthZeroStep::Stop(None),
        b'=' => DepthZeroStep::Stop((bytes[pos + 1] == b'>' && mask[pos + 1]).then_some(pos)),
        _ => DepthZeroStep::Continue,
    })
}

fn find_ts_expr_stmt_end(ctx: &ChunkScanCtx<'_>, start: usize, limit: usize) -> usize {
    scan_depth_zero(ctx.bytes, ctx.mask, start, limit, false, |pos| match ctx.bytes[pos] {
        b';' => DepthZeroStep::Stop(Some(pos)),
        b'}' => DepthZeroStep::Stop(Some(pos.saturating_sub(1))),
        _ if is_ts_stmt_boundary_nl(ctx, pos, limit) => {
            DepthZeroStep::Stop(Some(pos.saturating_sub(1)))
        }
        _ => DepthZeroStep::Continue,
    })
    .unwrap_or_else(|| limit.saturating_sub(1))
}

fn is_ts_stmt_boundary_nl(ctx: &ChunkScanCtx<'_>, pos: usize, limit: usize) -> bool {
    if ctx.bytes[pos] != b'\n' {
        return false;
    }
    let next = skip_masked_ws_range(ctx.bytes, ctx.mask, pos + 1, limit);
    if next >= limit {
        return true;
    }
    read_ts_ident_at(ctx.source, ctx.bytes, next, limit)
        .is_some_and(|(tok, _)| TS_STMT_STARTERS.contains(&tok))
}

fn parse_ts_fn_expr_end(ctx: &ChunkScanCtx<'_>, val_start: usize, limit: usize) -> Option<usize> {
    let pos = skip_leading_ts_kw(ctx, val_start, limit, KW_ASYNC);
    let (tok, next_p) = read_ts_ident_at(ctx.source, ctx.bytes, pos, limit)?;
    if tok != KW_FUNCTION {
        return None;
    }
    let open = find_ts_fn_brace(ctx.bytes, ctx.mask, next_p, limit)?;
    find_matching_delim(ctx.bytes, ctx.mask, open, b'{', b'}')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TsFnSigPhase {
    BeforeParams,
    AfterParams,
    ReturnTypeAtom,
    ReturnTypeDone,
}

impl TsFnSigPhase {
    fn step_before(&mut self, bytes: &[u8], mask: &[bool], pos: usize, limit: usize) -> ByteScanStep {
        match bytes[pos] {
            b';' => ByteScanStep::Abort,
            b'(' => match find_matching_delim(bytes, mask, pos, b'(', b')') {
                Some(close) => {
                    *self = Self::AfterParams;
                    ByteScanStep::Advance(close + 1)
                }
                None => ByteScanStep::Abort,
            },
            b'<' => ByteScanStep::Advance(
                skip_angle_generics(bytes, mask, pos, limit, true).unwrap_or(pos + 1),
            ),
            b'{' => find_matching_delim(bytes, mask, pos, b'{', b'}')
                .map_or(ByteScanStep::Abort, |c| ByteScanStep::Advance(c + 1)),
            _ => ByteScanStep::Advance(pos + 1),
        }
    }

    fn step_after(&mut self, bytes: &[u8], mask: &[bool], pos: usize, limit: usize) -> ByteScanStep {
        match bytes[pos] {
            b';' => ByteScanStep::Abort,
            b'{' if *self != Self::ReturnTypeAtom => ByteScanStep::Found(pos),
            b'{' => {
                *self = Self::ReturnTypeDone;
                find_matching_delim(bytes, mask, pos, b'{', b'}')
                    .map_or(ByteScanStep::Abort, |c| ByteScanStep::Advance(c + 1))
            }
            b':' | b'|' | b'&' => {
                *self = Self::ReturnTypeAtom;
                ByteScanStep::Advance(pos + 1)
            }
            b'=' if bytes.get(pos + 1) == Some(&b'>') && mask.get(pos + 1) == Some(&true) => {
                *self = Self::ReturnTypeAtom;
                ByteScanStep::Advance(pos + 2)
            }
            b'<' => {
                *self = Self::ReturnTypeDone;
                ByteScanStep::Advance(
                    skip_angle_generics(bytes, mask, pos, limit, true).unwrap_or(pos + 1),
                )
            }
            b'(' | b'[' => {
                *self = Self::ReturnTypeDone;
                ByteScanStep::Advance(skip_balanced_group(bytes, mask, pos, limit).unwrap_or(pos + 1))
            }
            b if !b.is_ascii_whitespace() => {
                if *self == Self::ReturnTypeAtom {
                    *self = Self::ReturnTypeDone;
                }
                ByteScanStep::Advance(pos + 1)
            }
            _ => ByteScanStep::Advance(pos + 1),
        }
    }
}

fn find_ts_fn_brace(bytes: &[u8], mask: &[bool], start: usize, limit: usize) -> Option<usize> {
    let mut phase = TsFnSigPhase::BeforeParams;
    scan_masked_bytes(mask, start, limit, |pos| {
        if phase == TsFnSigPhase::BeforeParams {
            phase.step_before(bytes, mask, pos, limit)
        } else {
            phase.step_after(bytes, mask, pos, limit)
        }
    })
}

fn backtrack_ts_modifiers(ctx: &ChunkScanCtx<'_>, kw_pos: usize) -> usize {
    let mut start = kw_pos;
    loop {
        let prev = skip_ws_and_comments_back(ctx.bytes, ctx.mask, start, 0);
        if prev == 0 {
            break;
        }
        let mut ws = prev;
        while ws > 0 && is_ts_ident_byte(ctx.bytes[ws - 1]) {
            ws -= 1;
        }
        if ws < prev && TS_DECL_MODIFIERS.contains(&&ctx.source[ws..prev]) {
            start = ws;
            continue;
        }
        break;
    }
    start
}

fn read_ts_ident_at<'a>(
    source: &'a str,
    bytes: &[u8],
    start: usize,
    limit: usize,
) -> Option<(&'a str, usize)> {
    let mut pos = start;
    while pos < limit && is_ts_ident_byte(bytes[pos]) {
        pos += 1;
    }
    (pos > start).then(|| (&source[start..pos], pos))
}

pub fn extract_astro_chunks(source: &str) -> Vec<ExtractedChunk> {
    let lines = LineIndex::new(source);
    let blocks = find_astro_blocks(source);
    let mut out = Vec::with_capacity(blocks.len());
    let mut script_idx = 0usize;
    for block in blocks {
        let slice = &source[block.start..block.end];
        if slice.trim().is_empty() {
            continue;
        }
        let end_incl = block.end.saturating_sub(1);
        let (kind, name) = if block.is_frontmatter {
            (ChunkKind::Frontmatter, FRONTMATTER_NAME.to_owned())
        } else {
            script_idx += 1;
            (ChunkKind::Script, format!("script#{script_idx}"))
        };
        out.push(ExtractedChunk {
            kind,
            qualified_name: name,
            start_line: lines.line_at(block.start),
            end_line: lines.line_at(end_incl),
            norm_hash: hash_normalized(slice, false),
        });
    }
    out
}

fn disambiguate_chunks(chunks: &mut [ExtractedChunk]) {
    let mut counts: HashMap<(ChunkKind, String), usize> = HashMap::new();
    for chunk in chunks {
        let key = (chunk.kind, chunk.qualified_name.clone());
        let seen = counts.entry(key).or_insert(0);
        *seen += 1;
        if *seen > 1 {
            chunk.qualified_name = format!("{}#{}", chunk.qualified_name, *seen);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CONST: &str = "PREFIX_PATH";
    const SAMPLE_METHOD: &str = "Client::send";

    fn assert_chunk_summary(chunks: &[ExtractedChunk], expected: &[(ChunkKind, &str)]) {
        let actual: Vec<(ChunkKind, &str)> = chunks
            .iter()
            .map(|c| (c.kind, c.qualified_name.as_str()))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn rust_chunks_extract_impl_methods_structs_enums_consts_and_nested_string_braces() {
        let src = r####"
pub const PREFIX_PATH: &str = "/api/internal";

#[derive(Debug)]
pub struct InvoiceReq {
    pub id: String,
}

pub enum InvoiceState {
    Open,
    Closed,
}

pub struct Client {
    base: String,
}

impl<T: Send> Client {
    pub async fn send(&self) -> String {
        let fake_brace = "}}} /* not a comment */ // still literal";
        let raw = r#"fn fake_inside_raw() { let x = "}"; }"#;
        /* nested /* block { comment } */ */
        format!("{}{}", fake_brace, raw)
    }

    pub const TIMEOUT_MS: u64 = 5000;
}

impl Trait for Client {
    fn handle(&self) {
        let _ = 1;
    }
}

pub const fn helper_const_fn() -> usize {
    42
}
"####;
        let chunks = extract_rust_chunks(src);
        assert_chunk_summary(
            &chunks,
            &[
                (ChunkKind::Const, SAMPLE_CONST),
                (ChunkKind::Struct, "InvoiceReq"),
                (ChunkKind::Enum, "InvoiceState"),
                (ChunkKind::Struct, "Client"),
                (ChunkKind::Fn, SAMPLE_METHOD),
                (ChunkKind::Const, "Client::TIMEOUT_MS"),
                (ChunkKind::Fn, "Client::handle"),
                (ChunkKind::Fn, "helper_const_fn"),
            ],
        );
        let send_chunk = chunks.iter().find(|c| c.qualified_name == SAMPLE_METHOD).unwrap();
        assert!(send_chunk.start_line < send_chunk.end_line);
        assert!(chunks.iter().all(|c| c.norm_hash.len() == CHUNK_HASH_LEN));
    }

    #[test]
    fn ts_chunks_extract_functions_arrows_class_methods_and_client_object_members() {
        let src = r#"
export function topFn(x: number): number {
  const s = "}} // not a comment";
  return x + s.length;
}

export const arrowBlock = async (id: string): Promise<void> => {
  await fetch(`/api/${id}`);
};

export const arrowExpr = (n: number) => n * 2;

export class SalesService {
  private base: string;
  async list(page: number) {
    return page;
  }
  create = (name: string) => ({ name });
}

export const api = {
  sales: {
    list: () => apiFetch("/sales"),
    create: (body: unknown) => apiFetch("/sales", { method: "POST", body }),
  },
  health: () => apiFetch("/health"),
};
"#;
        let chunks = extract_ts_chunks(src, true);
        assert_chunk_summary(
            &chunks,
            &[
                (ChunkKind::Fn, "topFn"),
                (ChunkKind::Arrow, "arrowBlock"),
                (ChunkKind::Arrow, "arrowExpr"),
                (ChunkKind::Method, "SalesService.list"),
                (ChunkKind::Method, "SalesService.create"),
                (ChunkKind::ObjectMember, "api.sales.list"),
                (ChunkKind::ObjectMember, "api.sales.create"),
                (ChunkKind::ObjectMember, "api.health"),
            ],
        );
        let non_client = extract_ts_chunks(src, false);
        assert!(!non_client.iter().any(|c| c.kind == ChunkKind::ObjectMember));
    }

    #[test]
    fn astro_chunks_extract_frontmatter_and_script_blocks() {
        let src = r#"---
const res = await fetch("https://api.example.com/v1/items");
---
<html>
  <body>
    <script>
      const x = 1;
    </script>
    <script type="module">
      const y = 2;
    </script>
  </body>
</html>
"#;
        let chunks = extract_astro_chunks(src);
        assert_chunk_summary(
            &chunks,
            &[
                (ChunkKind::Frontmatter, FRONTMATTER_NAME),
                (ChunkKind::Script, "script#1"),
                (ChunkKind::Script, "script#2"),
            ],
        );
    }

    #[test]
    fn normalization_ignores_comments_and_whitespace_but_preserves_string_literals() {
        let base = "pub fn handle() {\n    let msg = \"hello   world\";\n    let x = 1 + 2;\n}\n";
        let with_comments = "\
pub   fn   handle ( ) {
    // leading comment
    let msg = \"hello   world\"; /* inline /* nested */ comment */
    let   x  =  1   +   2 ;
}
";
        let changed_literal =
            "pub fn handle() {\n    let msg = \"hello world\";\n    let x = 1 + 2;\n}\n";
        let changed_logic =
            "pub fn handle() {\n    let msg = \"hello   world\";\n    let x = 1 + 3;\n}\n";

        let h_base = hash_normalized(base, true);
        assert_eq!(h_base, hash_normalized(with_comments, true));
        assert_ne!(h_base, hash_normalized(changed_literal, true));
        assert_ne!(h_base, hash_normalized(changed_logic, true));
    }

    #[test]
    fn ts_fn_and_method_chunks_include_full_body_past_object_and_generic_return_types() {
        let src_v1 = r#"export async function fetchInvoices(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/internal/invoices", { method: "POST" });
  return res.json();
}

export function inlineObj(): { a: number } | { b: string } {
  return { a: 1 };
}

export class ApiClient {
  async send(): Promise<{ id: string }> {
    return { id: "v1" };
  }
}
"#;
        let src_v2 = src_v1
            .replace("return res.json();", "return { ok: Boolean(res.ok) };")
            .replace("return { a: 1 };", "return { a: 2 };")
            .replace("return { id: \"v1\" };", "return { id: \"v2\" };");

        let c1 = extract_ts_chunks(src_v1, false);
        let c2 = extract_ts_chunks(&src_v2, false);
        assert_chunk_summary(
            &c1,
            &[
                (ChunkKind::Fn, "fetchInvoices"),
                (ChunkKind::Fn, "inlineObj"),
                (ChunkKind::Method, "ApiClient.send"),
            ],
        );
        assert_eq!(c1[0].start_line, 1);
        assert_eq!(c1[0].end_line, 4);
        assert_eq!(c1[1].start_line, 6);
        assert_eq!(c1[1].end_line, 8);
        assert_eq!(c1[2].start_line, 11);
        assert_eq!(c1[2].end_line, 13);
        for (a, b) in c1.iter().zip(c2.iter()) {
            assert_ne!(a.norm_hash, b.norm_hash, "body edit must alter {}", a.qualified_name);
        }
    }
}
