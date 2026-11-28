use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;

use crate::output;

use super::contracts::{
    BreakingAlert, ContractChangeAlert, PayloadContract, PayloadState, check_request_mismatch,
    format_breaking_alert, format_contract_change_alert, format_last_verified_suffix,
};
use super::memory::{self, MemoryAttachmentContext};
use super::scan::normalize_path;
use super::store::{
    CallRow, CallerEdge, CrossRepoEdgeInfo, EdgeChangeKind, EdgeVerifyMeta, EndpointRow,
    GraphStore, UnverifiedEdgeRow,
};
use super::types::{Confidence, HttpMethod, PairVerifyState, Stack};

const DEFAULT_LIMIT: usize = 50;
const IMPACT_CALLER_PREVIEW: usize = 3;
const SPA_AREA_PREVIEW: usize = 5;
const SPA_FILE_PREVIEW: usize = 3;
const SHORT_SHA_LEN: usize = 7;
const MS_PER_DAY: i64 = 86_400_000;
const TOUCH_ROUTE_PREVIEW: usize = 3;
const MIN_BODY_BUDGET_WITH_MEM: usize = 128;

enum QueryOutput {
    Empty(String),
    Lines {
        body: Vec<String>,
        footer: Vec<String>,
    },
}

fn run_budgeted_query(
    limit: Option<usize>,
    max_bytes: usize,
    build: impl FnOnce(usize) -> Result<QueryOutput>,
) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let max_items = limit.unwrap_or(DEFAULT_LIMIT).max(1);
    match build(max_items)? {
        QueryOutput::Empty(msg) => Ok(truncate_to_budget(&msg, max_bytes)),
        QueryOutput::Lines { body, footer } => {
            Ok(render_lines_with_footer(&body, &footer, max_bytes))
        }
    }
}

fn render_lines_with_footer(body: &[String], footer: &[String], max_bytes: usize) -> String {
    if footer.is_empty() {
        return render_lines_within_budget(body, max_bytes);
    }
    let mut kept_footer = Vec::new();
    let mut footer_bytes = 0usize;
    for line in footer {
        let need = line.len() + 1;
        if footer_bytes + need + MIN_BODY_BUDGET_WITH_MEM <= max_bytes {
            kept_footer.push(line.as_str());
            footer_bytes += need;
        }
    }
    if kept_footer.is_empty() {
        return render_lines_within_budget(body, max_bytes);
    }
    let body_budget = max_bytes.saturating_sub(footer_bytes);
    let mut out = render_lines_within_budget(body, body_budget);
    for line in kept_footer {
        if out.len() + line.len() < max_bytes {
            out.push_str(line);
            out.push('\n');
        }
    }
    truncate_to_budget(&out, max_bytes)
}

#[derive(Default)]
struct MemCollector {
    files: Vec<(String, String)>,
    endpoints: Vec<(HttpMethod, String)>,
    chunk_ids: Vec<i64>,
}

impl MemCollector {
    fn add_endpoint(&mut self, ep: &EndpointRow) {
        self.files.push((ep.repo.clone(), ep.file.clone()));
        self.endpoints.push((ep.method, ep.path_norm.clone()));
        for id in [ep.chunk_ids.handler, ep.chunk_ids.req_type, ep.chunk_ids.res_type]
            .into_iter()
            .flatten()
        {
            self.chunk_ids.push(id);
        }
    }

    fn add_call(&mut self, call: &CallRow) {
        self.files.push((call.repo.clone(), call.file.clone()));
        self.endpoints.push((call.method, call.path_norm.clone()));
        if let Some(cid) = call.caller_chunk_id {
            self.chunk_ids.push(cid);
        }
    }

    fn add_callers(&mut self, callers: &[CallerEdge]) {
        for c in callers {
            self.files.push((c.call.repo.clone(), c.call.file.clone()));
            if let Some(cid) = c.call.caller_chunk_id {
                self.chunk_ids.push(cid);
            }
        }
    }

    fn finish(
        self,
        store: &GraphStore,
        memory_db: Option<&Path>,
        body: Vec<String>,
    ) -> Result<QueryOutput> {
        let chunks = store.chunk_names_by_ids(&self.chunk_ids)?;
        let footer = collect_attached_memories(memory_db, self.files, self.endpoints, chunks);
        Ok(QueryOutput::Lines { body, footer })
    }
}

pub fn who_calls(
    store: &GraphStore,
    raw_query: &str,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
    memory_db: Option<&Path>,
) -> Result<String> {
    run_budgeted_query(limit, max_bytes, |max_items| {
        let (method, path_norm) = parse_endpoint_query(raw_query);
        let endpoints = store.find_endpoints(method, &path_norm, repo)?;
        if endpoints.is_empty() {
            return Ok(QueryOutput::Empty(format!(
                "no provider found for {}\n",
                format_query_label(method, &path_norm)
            )));
        }
        let mut lines = Vec::new();
        let mut mem = MemCollector::default();
        for ep in &endpoints {
            append_endpoint_with_callers(store, ep, "", max_items, &mut lines, &mut mem)?;
        }
        mem.finish(store, memory_db, lines)
    })
}

pub fn impact(
    store: &GraphStore,
    file_arg: &Path,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
    memory_db: Option<&Path>,
) -> Result<String> {
    run_budgeted_query(limit, max_bytes, |max_items| {
        let (resolved_repo, rel_file) = resolve_file_target(store, file_arg, repo_filter)?;
        let endpoints = store.endpoints_in_file(resolved_repo.as_deref(), &rel_file)?;
        let calls = store.calls_in_file(resolved_repo.as_deref(), &rel_file)?;
        if endpoints.is_empty() && calls.is_empty() {
            let scope = resolved_repo.as_deref().unwrap_or("*");
            return Ok(QueryOutput::Empty(format!(
                "no endpoints or calls in {scope} {rel_file}\n"
            )));
        }
        let mut lines = Vec::new();
        let mut mem = MemCollector::default();
        append_defined_endpoints(store, &rel_file, &endpoints, max_items, &mut lines, &mut mem)?;
        if !calls.is_empty() {
            lines.push(format!("makes {} call(s) from {rel_file}:", calls.len()));
            append_call_provider_lines_tracked(store, &calls, max_items, &mut lines, Some(&mut mem))?;
        }
        mem.finish(store, memory_db, lines)
    })
}

fn collect_attached_memories(
    memory_db: Option<&Path>,
    files: Vec<(String, String)>,
    endpoints: Vec<(HttpMethod, String)>,
    chunks: Vec<(String, String, String)>,
) -> Vec<String> {
    let Some(db) = memory_db else {
        return Vec::new();
    };
    let ctx = MemoryAttachmentContext {
        files,
        endpoints,
        chunks,
    };
    memory::attach_memory_lines(db, &ctx)
}

fn append_endpoint_with_callers(
    store: &GraphStore,
    ep: &EndpointRow,
    indent: &str,
    max_callers: usize,
    lines: &mut Vec<String>,
    mem: &mut MemCollector,
) -> Result<()> {
    lines.push(format!("{indent}{}", format_provider_line(ep)));
    mem.add_endpoint(ep);
    let callers = store.callers_for_endpoint(ep.id)?;
    let child_indent = format!("{indent}  ");
    if callers.is_empty() {
        lines.push(format!("{child_indent}(no callers)"));
        return Ok(());
    }
    mem.add_callers(&callers);
    let formatted: Vec<String> = format_grouped_callers(ep.req_contract.as_ref(), &callers)
        .into_iter()
        .map(|cl| format!("{indent}{cl}"))
        .collect();
    push_capped_lines(lines, formatted, max_callers, &child_indent);
    Ok(())
}

fn append_defined_endpoints(
    store: &GraphStore,
    rel_file: &str,
    endpoints: &[EndpointRow],
    max_items: usize,
    lines: &mut Vec<String>,
    mem: &mut MemCollector,
) -> Result<()> {
    if endpoints.is_empty() {
        return Ok(());
    }
    lines.push(format!("defines {} endpoint(s) in {rel_file}:", endpoints.len()));
    for ep in endpoints.iter().take(max_items) {
        append_endpoint_with_callers(store, ep, "  ", IMPACT_CALLER_PREVIEW, lines, mem)?;
    }
    if endpoints.len() > max_items {
        lines.push(format!("  +{} more", endpoints.len() - max_items));
    }
    Ok(())
}

pub fn callees(
    store: &GraphStore,
    raw_query: &str,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    run_budgeted_query(limit, max_bytes, |max_items| {
        let trimmed = raw_query.trim();
        let (resolved_repo, target) = resolve_file_target(store, Path::new(trimmed), repo_filter)?;
        let mut calls = store.calls_for_service_or_repo(&target, resolved_repo.as_deref())?;
        if calls.is_empty() && target != trimmed {
            calls = store.calls_for_service_or_repo(trimmed, repo_filter)?;
        }
        if calls.is_empty() {
            return Ok(QueryOutput::Empty(format!(
                "no outbound calls found for {trimmed}\n"
            )));
        }
        let mut lines = vec![format!("outbound calls for {trimmed} ({}):", calls.len())];
        append_call_provider_lines(store, &calls, max_items, &mut lines)?;
        Ok(QueryOutput::Lines {
            body: lines,
            footer: Vec::new(),
        })
    })
}

pub fn fog(store: &GraphStore, repo_filter: Option<&str>, limit: Option<usize>, max_bytes: usize) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let unresolved = store.unresolved_calls(repo_filter)?;
    if unresolved.is_empty() {
        return Ok(empty_scoped_budget("fog: 0 unresolved calls", repo_filter, max_bytes));
    }
    let breakdown = format_repo_breakdown(unresolved.iter().map(|c| c.repo.as_str()));
    let header = format!("fog: {} unresolved ({breakdown})", unresolved.len());
    let items: Vec<String> = unresolved.iter().map(format_fog_line).collect();
    Ok(render_contracts_list(header, items, limit, max_bytes))
}

fn format_fog_line(call: &CallRow) -> String {
    let base_part = if call.base_ref.is_empty() {
        String::new()
    } else {
        format!(" base={}", call.base_ref)
    };
    format!(
        "  {} {}:{} {} {}{}{}",
        call.repo,
        call.file,
        call.line,
        call.method.as_str(),
        call.path_norm,
        base_part,
        why_dash(&call.why)
    )
}

fn empty_scoped_budget(prefix: &str, repo_filter: Option<&str>, max_bytes: usize) -> String {
    let scope = repo_filter.unwrap_or("all repos");
    truncate_to_budget(&format!("{prefix} ({scope})\n"), max_bytes)
}

fn format_repo_breakdown<'a>(repos: impl Iterator<Item = &'a str>) -> String {
    let mut by_repo: BTreeMap<&'a str, usize> = BTreeMap::new();
    for repo in repos {
        *by_repo.entry(repo).or_insert(0) += 1;
    }
    by_repo
        .iter()
        .map(|(r, n)| format!("{r}={n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn changes(
    store: &GraphStore,
    since_days: u64,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
    now_ms: i64,
) -> Result<String> {
    run_budgeted_query(limit, max_bytes, |max_items| {
        let cutoff = if since_days == 0 {
            0
        } else {
            let days_i64 = i64::try_from(since_days).unwrap_or(i64::MAX);
            now_ms.saturating_sub(days_i64.saturating_mul(MS_PER_DAY))
        };
        let rows = store.load_cross_repo_changes(cutoff, repo_filter)?;
        if rows.is_empty() {
            return Ok(QueryOutput::Empty(format!(
                "no cross-repo edge changes in last {since_days}d\n"
            )));
        }
        let added = rows
            .iter()
            .filter(|r| r.kind == EdgeChangeKind::Added)
            .count();
        let removed = rows.len() - added;
        let mut lines = vec![format!(
            "changes (last {since_days}d): +{added} -{removed} cross-repo edges"
        )];
        let formatted: Vec<String> = rows
            .iter()
            .map(|r| {
                let sign = match r.kind {
                    EdgeChangeKind::Added => "+",
                    EdgeChangeKind::Removed => "-",
                };
                let breaking_tag = if r.breaking { " [BREAKING]" } else { "" };
                let (src, dst) = (&r.source, &r.target);
                format!(
                    "  {sign} {} {}:{} -> {} {} {} @{}{breaking_tag}",
                    src.service, src.file, src.line, dst.service, r.method.as_str(), r.path_norm, short_sha(&r.sha)
                )
            })
            .collect();
        push_capped_lines(&mut lines, formatted, max_items, "  ");
        Ok(QueryOutput::Lines {
            body: lines,
            footer: Vec::new(),
        })
    })
}

pub fn contracts(
    store: &GraphStore,
    repo_filter: Option<&str>,
    mismatches_only: bool,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let edge_pairs = store.load_edge_pairs(repo_filter)?;
    let mut mismatch_lines = Vec::new();
    for (ep, call) in &edge_pairs {
        if let Some(m) =
            check_request_mismatch(ep.req_contract.as_ref(), call.req_contract.as_ref())
        {
            mismatch_lines.push(format!(
                "  {} {} ({} <- {} {}:{}): {}",
                ep.method.as_str(),
                ep.path_norm,
                ep.service,
                call.service,
                call.file,
                call.line,
                m.format_compact()
            ));
        }
    }
    if mismatches_only {
        if mismatch_lines.is_empty() {
            return Ok(empty_scoped_budget("contracts: 0 mismatches", repo_filter, max_bytes));
        }
        let header = format!("contracts: {} mismatch(es)", mismatch_lines.len());
        return Ok(render_contracts_list(header, mismatch_lines, limit, max_bytes));
    }

    let eps = store.load_endpoints_with_contracts(repo_filter)?;
    if eps.is_empty() && mismatch_lines.is_empty() {
        return Ok(empty_scoped_budget(
            "contracts: 0 endpoints with payload contracts",
            repo_filter,
            max_bytes,
        ));
    }
    let resolved = eps
        .iter()
        .filter(|e| {
            e.req_contract
                .as_ref()
                .is_some_and(|c| c.state == PayloadState::Resolved)
                || e.res_contract
                    .as_ref()
                    .is_some_and(|c| c.state == PayloadState::Resolved)
        })
        .count();
    let opaque = eps.len().saturating_sub(resolved);
    let header = format!(
        "contracts: {} endpoints ({resolved} resolved, {opaque} opaque, {} mismatches)",
        eps.len(),
        mismatch_lines.len()
    );
    let mut items = mismatch_lines;
    for ep in &eps {
        items.push(format_endpoint_contract_line(ep));
    }
    Ok(render_contracts_list(header, items, limit, max_bytes))
}

pub fn unverified(store: &GraphStore, repo_filter: Option<&str>, limit: Option<usize>, max_bytes: usize) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let rows = store.load_unverified_cross_repo_edges(repo_filter)?;
    if rows.is_empty() {
        return Ok(empty_scoped_budget("unverified: 0 cross-repo edges", repo_filter, max_bytes));
    }
    let changed = rows
        .iter()
        .filter(|r| {
            PairVerifyState::from_keys(&r.verify.pair_key, &r.verify.verified_pair_key)
                == PairVerifyState::UnverifiedSinceChange
        })
        .count();
    let header = format!(
        "unverified: {} cross-repo edge(s) ({changed} changed since verified, {} never verified)",
        rows.len(),
        rows.len().saturating_sub(changed)
    );
    let items: Vec<String> = rows.iter().map(format_unverified_line).collect();
    Ok(render_contracts_list(header, items, limit, max_bytes))
}

fn format_unverified_line(r: &UnverifiedEdgeRow) -> String {
    let badge = match PairVerifyState::from_keys(&r.verify.pair_key, &r.verify.verified_pair_key) {
        PairVerifyState::UnverifiedSinceChange => {
            format!("changed since verified @{}", short_sha(&r.verify.verified_sha))
        }
        PairVerifyState::NeverVerified => PairVerifyState::NeverVerified.as_str().to_owned(),
        PairVerifyState::Verified => PairVerifyState::Verified.as_str().to_owned(),
    };
    let (src, dst) = (&r.source, &r.target);
    format!(
        "  {} {}:{}{} -> {} {} {}{} [{badge}]",
        src.service, src.file, src.line, why_parens(&r.caller_chunk),
        dst.service, r.method.as_str(), r.path_norm, why_parens(&r.handler_chunk),
    )
}

pub fn stale_memories(
    store: &GraphStore,
    memory_db: &Path,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let entries = memory::find_stale_memories(store, memory_db, repo_filter);
    if entries.is_empty() {
        return Ok(empty_scoped_budget("stale-memories: 0 stale memories", repo_filter, max_bytes));
    }
    let breakdown = format_repo_breakdown(entries.iter().map(|e| e.repo.as_str()));
    let header = format!("stale-memories: {} stale ({breakdown})", entries.len());
    let items: Vec<String> = entries.iter().map(format_stale_memory_line).collect();
    Ok(render_contracts_list(header, items, limit, max_bytes))
}

fn format_stale_memory_line(e: &memory::StaleMemoryEntry) -> String {
    let clean_title = e
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "'");
    format!(
        "  {} \"{}\" [{}: {}]",
        e.id,
        output::prefix(&clean_title, 48).trim_end(),
        e.reason.as_str(),
        e.anchor,
    )
}

fn render_contracts_list(
    header: String,
    items: Vec<String>,
    limit: Option<usize>,
    max_bytes: usize,
) -> String {
    let max_items = limit.unwrap_or(items.len()).max(1);
    let take = items.len().min(max_items);
    let hidden = items.len().saturating_sub(take);
    let mut lines = Vec::with_capacity(take + 1);
    lines.push(header);
    lines.extend(items.into_iter().take(take));
    render_lines_within_budget_extra(&lines, hidden, max_bytes)
}

fn format_endpoint_contract_line(ep: &EndpointRow) -> String {
    let mut parts = Vec::new();
    if let Some(req) = &ep.req_contract {
        parts.push(format!("req={}({})", req.kind.as_str(), summarize_payload(req)));
    }
    if let Some(res) = &ep.res_contract {
        parts.push(format!("res={}", summarize_payload(res)));
    }
    format!(
        "  {} {} ({}) {}",
        ep.method.as_str(),
        ep.path_norm,
        ep.service,
        parts.join("; ")
    )
}

fn summarize_payload(p: &PayloadContract) -> String {
    if p.state == PayloadState::Opaque && p.fields.is_empty() {
        return format!("opaque:{}", p.type_name);
    }
    let fields: Vec<String> = p
        .fields
        .iter()
        .map(|f| {
            if f.required {
                f.name.clone()
            } else {
                format!("{}?", f.name)
            }
        })
        .collect();
    if p.state == PayloadState::Opaque {
        format!("{}, ..opaque", fields.join(", "))
    } else {
        fields.join(", ")
    }
}

pub fn format_touch_output(
    breaking: &[BreakingAlert],
    contract_changes: &[ContractChangeAlert],
    items: &[(String, String, Vec<CrossRepoEdgeInfo>, Vec<CrossRepoEdgeInfo>)],
    max_bytes: usize,
) -> String {
    let mut lines = Vec::new();
    for alert in breaking {
        lines.push(format_breaking_alert(alert));
    }
    for alert in contract_changes {
        lines.push(format_contract_change_alert(alert));
    }
    append_touch_impact_lines(items, &mut lines);
    if lines.is_empty() {
        return String::new();
    }
    render_lines_within_budget(&lines, max_bytes)
}

pub fn format_touch_impact(
    items: &[(String, String, Vec<CrossRepoEdgeInfo>, Vec<CrossRepoEdgeInfo>)],
    max_bytes: usize,
) -> String {
    format_touch_output(&[], &[], items, max_bytes)
}

fn append_touch_impact_lines(
    items: &[(String, String, Vec<CrossRepoEdgeInfo>, Vec<CrossRepoEdgeInfo>)],
    lines: &mut Vec<String>,
) {
    for (repo, file, served, called) in items {
        if served.is_empty() && called.is_empty() {
            continue;
        }
        let mut parts = Vec::new();
        if !served.is_empty() {
            parts.push(format_cross_repo_group("served<-", served));
        }
        if !called.is_empty() {
            parts.push(format_cross_repo_group("calls->", called));
        }
        lines.push(format!("{repo}:{file} {}", parts.join("; ")));
    }
}

fn format_cross_repo_group(label: &str, edges: &[CrossRepoEdgeInfo]) -> String {
    let mut peers = BTreeSet::new();
    let mut routes = Vec::new();
    let mut seen_routes = BTreeSet::new();
    let mut last_verified_sha: Option<&str> = None;
    for e in edges {
        peers.insert(e.peer_service.as_str());
        if last_verified_sha.is_none() && !e.verify.verified_sha.is_empty() {
            last_verified_sha = Some(e.verify.verified_sha.as_str());
        }
        let route = format!("{} {}", e.method.as_str(), e.path_norm);
        if seen_routes.insert(route.clone()) && routes.len() < TOUCH_ROUTE_PREVIEW {
            routes.push(route);
        }
    }
    let extra = seen_routes.len().saturating_sub(routes.len());
    let peer_list: Vec<&str> = peers.into_iter().collect();
    let suffix = if extra > 0 {
        format!(", +{extra}")
    } else {
        String::new()
    };
    let verified_suffix = format_last_verified_suffix(last_verified_sha);
    format!(
        "{label}{} ({}{}){verified_suffix}",
        peer_list.join(","),
        routes.join(", "),
        suffix
    )
}

fn push_capped_lines(out: &mut Vec<String>, items: Vec<String>, max_items: usize, indent: &str) {
    let total = items.len();
    let take = total.min(max_items);
    out.extend(items.into_iter().take(take));
    if total > take {
        out.push(format!("{indent}+{} more", total - take));
    }
}

fn append_call_provider_lines(
    store: &GraphStore,
    calls: &[CallRow],
    max_items: usize,
    lines: &mut Vec<String>,
) -> Result<()> {
    append_call_provider_lines_tracked(store, calls, max_items, lines, None)
}

fn append_call_provider_lines_tracked(
    store: &GraphStore,
    calls: &[CallRow],
    max_items: usize,
    lines: &mut Vec<String>,
    mut mem_track: Option<&mut MemCollector>,
) -> Result<()> {
    let take = calls.len().min(max_items);
    for call in calls.iter().take(take) {
        if let Some(mem) = mem_track.as_mut() {
            mem.add_call(call);
        }
        let why_part = why_parens(&call.why);
        let head = format!(
            "  {}:{} {} {} ->",
            call.file,
            call.line,
            call.method.as_str(),
            call.path_norm
        );
        if call.external {
            lines.push(format!("{head} [external]{why_part}"));
            continue;
        }
        let providers = store.providers_for_call(call.id)?;
        if providers.is_empty() {
            lines.push(format!("{head} [fog]{why_part}"));
            continue;
        }
        for prov in providers {
            if let Some(mem) = mem_track.as_mut() {
                mem.add_endpoint(&prov.endpoint);
            }
            let mismatch_tag = check_request_mismatch(
                prov.endpoint.req_contract.as_ref(),
                call.req_contract.as_ref(),
            )
            .map(|m| format!(" [{}]", m.format_compact()))
            .unwrap_or_default();
            let verify_tag = format_verify_badge(&prov.verify);
            lines.push(format!(
                "{head} {} {}:{}@{} [{}]{verify_tag}{mismatch_tag}{why_part}",
                prov.endpoint.service,
                prov.endpoint.file,
                prov.endpoint.line,
                short_sha(&prov.endpoint.verified_sha),
                prov.confidence.as_str()
            ));
        }
    }
    if calls.len() > take {
        lines.push(format!("  +{} more", calls.len() - take));
    }
    Ok(())
}

fn format_verify_badge(meta: &EdgeVerifyMeta) -> String {
    match PairVerifyState::from_keys(&meta.pair_key, &meta.verified_pair_key) {
        PairVerifyState::Verified if !meta.verified_sha.is_empty() => {
            format!(" [verified @{}]", short_sha(&meta.verified_sha))
        }
        PairVerifyState::UnverifiedSinceChange if !meta.verified_sha.is_empty() => {
            format!(" [changed since verified @{}]", short_sha(&meta.verified_sha))
        }
        _ => String::new(),
    }
}

fn wrap_why(why: &str, prefix: &str, suffix: &str) -> String {
    if why.is_empty() {
        String::new()
    } else {
        format!("{prefix}{why}{suffix}")
    }
}

fn why_dash(why: &str) -> String {
    wrap_why(why, " — ", "")
}

fn why_parens(why: &str) -> String {
    wrap_why(why, " (", ")")
}

fn format_provider_line(ep: &EndpointRow) -> String {
    format!(
        "{} {} <- {} {}:{}@{} ({}, {})",
        ep.method.as_str(),
        ep.path_norm,
        ep.service,
        ep.file,
        ep.line,
        short_sha(&ep.verified_sha),
        ep.handler,
        ep.prefix_state.as_str()
    )
}

fn format_grouped_callers(
    provider_req: Option<&PayloadContract>,
    callers: &[CallerEdge],
) -> Vec<String> {
    let mut direct: Vec<&CallerEdge> = Vec::new();
    let mut spa_groups: BTreeMap<&str, Vec<&CallerEdge>> = BTreeMap::new();
    for edge in callers {
        if edge.service_stack == Stack::Spa {
            spa_groups
                .entry(edge.call.service.as_str())
                .or_default()
                .push(edge);
        } else {
            direct.push(edge);
        }
    }
    direct.sort_by(|a, b| {
        a.confidence
            .rank()
            .cmp(&b.confidence.rank())
            .then_with(|| a.call.service.cmp(&b.call.service))
            .then_with(|| a.call.file.cmp(&b.call.file))
            .then_with(|| a.call.line.cmp(&b.call.line))
    });
    let mut out: Vec<String> = direct
        .into_iter()
        .map(|edge| {
            let mismatch_tag = check_request_mismatch(provider_req, edge.call.req_contract.as_ref())
                .map(|m| format!(" [{}]", m.format_compact()))
                .unwrap_or_default();
            let verify_tag = format_verify_badge(&edge.verify);
            format!(
                "  <- {} {}:{} [{}]{verify_tag}{mismatch_tag}{}",
                edge.call.service,
                edge.call.file,
                edge.call.line,
                edge.confidence.as_str(),
                why_dash(&edge.call.why)
            )
        })
        .collect();
    for (svc, group) in spa_groups {
        out.push(format_spa_group(svc, provider_req, &group));
    }
    out
}

fn format_spa_group(
    service: &str,
    provider_req: Option<&PayloadContract>,
    group: &[&CallerEdge],
) -> String {
    let mut unique_files = BTreeSet::new();
    let mut areas = BTreeSet::new();
    let mut first_files = Vec::new();
    let mut seen_first = BTreeSet::new();
    let mut best_conf = Confidence::Suffix;
    let mut sample_why = "";
    let mut verify_tag = String::new();
    for edge in group {
        unique_files.insert(edge.call.file.as_str());
        if !edge.call.area.is_empty() {
            areas.insert(edge.call.area.as_str());
        }
        if edge.confidence.rank() < best_conf.rank() {
            best_conf = edge.confidence;
        }
        if sample_why.is_empty() && !edge.call.why.is_empty() {
            sample_why = edge.call.why.as_str();
        }
        let edge_badge = format_verify_badge(&edge.verify);
        if edge_badge.contains("changed since") || (verify_tag.is_empty() && !edge_badge.is_empty()) {
            verify_tag = edge_badge;
        }
        if seen_first.insert(edge.call.file.as_str()) && first_files.len() < SPA_FILE_PREVIEW {
            first_files.push(format!("{}:{}", edge.call.file, edge.call.line));
        }
    }
    let pages_text = format_spa_pages_text(unique_files.len(), &areas);
    let mismatch_tag = format_spa_mismatch_tag(provider_req, group);
    format!(
        "  <- {service}: {pages_text} ({}) [{}]{verify_tag}{mismatch_tag}{}",
        first_files.join(", "),
        best_conf.as_str(),
        why_dash(sample_why)
    )
}

fn format_spa_pages_text(file_count: usize, areas: &BTreeSet<&str>) -> String {
    let area_list: Vec<&str> = areas.iter().copied().take(SPA_AREA_PREVIEW).collect();
    if area_list.is_empty() {
        return format!("{file_count} files");
    }
    let suffix = if areas.len() > SPA_AREA_PREVIEW { ", ..." } else { "" };
    format!("{file_count} files in pages: {}{suffix}", area_list.join(", "))
}

fn format_spa_mismatch_tag(
    provider_req: Option<&PayloadContract>,
    group: &[&CallerEdge],
) -> String {
    let mut first: Option<String> = None;
    let mut count = 0usize;
    for edge in group {
        if let Some(m) = check_request_mismatch(provider_req, edge.call.req_contract.as_ref()) {
            count += 1;
            if first.is_none() {
                first = Some(m.format_compact());
            }
        }
    }
    match first {
        Some(m) if count > 1 => format!(" [{m}, +{} more]", count - 1),
        Some(m) => format!(" [{m}]"),
        None => String::new(),
    }
}

fn parse_endpoint_query(raw: &str) -> (Option<HttpMethod>, String) {
    let trimmed = raw.trim();
    if let Some((first, rest)) = trimmed.split_once(char::is_whitespace)
        && let Some(method) = HttpMethod::parse(first)
    {
        return (Some(method), normalize_path(rest));
    }
    (None, normalize_path(trimmed))
}

fn format_query_label(method: Option<HttpMethod>, path_norm: &str) -> String {
    match method {
        Some(m) => format!("{} {path_norm}", m.as_str()),
        None => path_norm.to_owned(),
    }
}

fn resolve_file_target(
    store: &GraphStore,
    file_arg: &Path,
    repo_filter: Option<&str>,
) -> Result<(Option<String>, String)> {
    let repos = store.list_repos()?;
    let raw = file_arg.to_string_lossy().replace('\\', "/");
    let canonical = file_arg
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    let candidate = canonical.as_deref().unwrap_or(raw.as_str());
    for repo in &repos {
        if repo_filter.is_some_and(|filter| repo.repo != filter) {
            continue;
        }
        let base = repo.repo_path.trim_end_matches('/');
        if !base.is_empty()
            && let Some(rel) = candidate.strip_prefix(base).and_then(|r| r.strip_prefix('/'))
        {
            return Ok((Some(repo.repo.clone()), rel.to_owned()));
        }
        if let Some(rel) = raw.strip_prefix(&format!("{}/", repo.repo)) {
            return Ok((Some(repo.repo.clone()), rel.to_owned()));
        }
    }
    Ok((repo_filter.map(str::to_owned), raw.trim_start_matches("./").to_owned()))
}

fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(SHORT_SHA_LEN)]
}

pub fn render_lines_within_budget(lines: &[String], max_bytes: usize) -> String {
    render_lines_within_budget_extra(lines, 0, max_bytes)
}

fn render_lines_within_budget_extra(
    lines: &[String],
    extra_omitted: usize,
    max_bytes: usize,
) -> String {
    let mut out = String::new();
    let total = lines.len();
    for (idx, line) in lines.iter().enumerate() {
        let remaining_after = total - idx - 1 + extra_omitted;
        let footer_reserve = if remaining_after > 0 {
            format!("+{remaining_after} more\n").len()
        } else {
            0
        };
        if out.len() + line.len() + 1 + footer_reserve <= max_bytes {
            out.push_str(line);
            out.push('\n');
        } else if out.is_empty() {
            let avail = max_bytes.saturating_sub(footer_reserve + 1);
            if avail > 0 {
                out.push_str(output::prefix(line, avail));
                out.push('\n');
            }
            if remaining_after > 0 {
                append_more_footer(&mut out, remaining_after, max_bytes);
            }
            return truncate_to_budget(&out, max_bytes);
        } else {
            append_more_footer(&mut out, total - idx + extra_omitted, max_bytes);
            return truncate_to_budget(&out, max_bytes);
        }
    }
    if extra_omitted > 0 {
        append_more_footer(&mut out, extra_omitted, max_bytes);
    }
    truncate_to_budget(&out, max_bytes)
}

fn append_more_footer(out: &mut String, omitted: usize, max_bytes: usize) {
    let footer = format!("+{omitted} more\n");
    if out.len() + footer.len() <= max_bytes {
        out.push_str(&footer);
    }
}

fn truncate_to_budget(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    format!("{}\n", output::prefix(text, max_bytes.saturating_sub(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_renderer_enforces_byte_cap_and_appends_more_counter() {
        let lines: Vec<String> = (0..30)
            .map(|i| format!("  <- svc-{i} src/file_{i}.rs:{i} [unique] call_{i}"))
            .collect();
        let rendered = render_lines_within_budget(&lines, 256);
        assert!(rendered.len() <= 256, "len={}", rendered.len());
        assert!(rendered.contains("more\n"), "rendered={rendered}");
    }

    #[test]
    fn touch_impact_enforces_300_byte_cap_and_omits_empty_files() {
        assert_eq!(format_touch_impact(&[], 300), "");
        let edges: Vec<CrossRepoEdgeInfo> = (0..10)
            .map(|i| CrossRepoEdgeInfo {
                peer_repo: format!("repo-{i}"),
                peer_service: format!("service-{i}"),
                method: HttpMethod::Post,
                path_norm: format!("/api/v1/very/long/resource/path/segment/{i}"),
                verify: EdgeVerifyMeta::default(),
            })
            .collect();
        let text = format_touch_impact(
            &[("ez-addon".to_owned(), "src/client.rs".to_owned(), vec![], edges)],
            300,
        );
        assert!(!text.is_empty());
        assert!(text.len() <= 300, "len={}", text.len());
        assert!(text.contains("ez-addon:src/client.rs"), "text={text}");

        let long_path = format!("src/{}/client.rs", "deep_nested_module/".repeat(12));
        let long_text = format_touch_impact(
            &[(
                "ez-addon".to_owned(),
                long_path,
                vec![],
                vec![CrossRepoEdgeInfo {
                    peer_repo: "ez-commerce".to_owned(),
                    peer_service: "ez-commerce-api".to_owned(),
                    method: HttpMethod::Post,
                    path_norm: "/api/internal/invoices".to_owned(),
                    verify: EdgeVerifyMeta::default(),
                }],
            )],
            300,
        );
        assert!(long_text.len() <= 300, "len={}", long_text.len());
        assert!(long_text.starts_with("ez-addon:src/"), "long_text={long_text}");
    }
}
