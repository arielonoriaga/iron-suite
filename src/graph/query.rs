use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;

use crate::output;

use super::scan::normalize_path;
use super::store::{CallRow, CallerEdge, EndpointRow, GraphStore};
use super::{Confidence, HttpMethod, Stack};

const DEFAULT_LIMIT: usize = 50;
const IMPACT_CALLER_PREVIEW: usize = 3;
const SPA_AREA_PREVIEW: usize = 5;
const SPA_FILE_PREVIEW: usize = 3;
const SHORT_SHA_LEN: usize = 7;

enum QueryOutput {
    Empty(String),
    Lines(Vec<String>),
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
        QueryOutput::Lines(lines) => Ok(render_lines_within_budget(&lines, max_bytes)),
    }
}

pub fn who_calls(
    store: &GraphStore,
    raw_query: &str,
    repo: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
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
        for ep in &endpoints {
            lines.push(format_provider_line(ep));
            let callers = store.callers_for_endpoint(ep.id)?;
            if callers.is_empty() {
                lines.push("  (no callers)".to_owned());
                continue;
            }
            let formatted_callers = format_grouped_callers(&callers);
            push_capped_lines(&mut lines, formatted_callers, max_items, "  ");
        }
        Ok(QueryOutput::Lines(lines))
    })
}

pub fn impact(
    store: &GraphStore,
    file_arg: &Path,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
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
        append_defined_endpoints(store, &rel_file, &endpoints, max_items, &mut lines)?;
        if !calls.is_empty() {
            lines.push(format!("makes {} call(s) from {rel_file}:", calls.len()));
            append_call_provider_lines(store, &calls, max_items, &mut lines)?;
        }
        Ok(QueryOutput::Lines(lines))
    })
}

fn append_defined_endpoints(
    store: &GraphStore,
    rel_file: &str,
    endpoints: &[EndpointRow],
    max_items: usize,
    lines: &mut Vec<String>,
) -> Result<()> {
    if endpoints.is_empty() {
        return Ok(());
    }
    lines.push(format!("defines {} endpoint(s) in {rel_file}:", endpoints.len()));
    for ep in endpoints.iter().take(max_items) {
        lines.push(format!("  {}", format_provider_line(ep)));
        let callers = store.callers_for_endpoint(ep.id)?;
        if callers.is_empty() {
            lines.push("    (no callers)".to_owned());
        } else {
            let indented: Vec<String> = format_grouped_callers(&callers)
                .into_iter()
                .map(|cl| format!("  {cl}"))
                .collect();
            push_capped_lines(lines, indented, IMPACT_CALLER_PREVIEW, "    ");
        }
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
        Ok(QueryOutput::Lines(lines))
    })
}

pub fn fog(
    store: &GraphStore,
    repo_filter: Option<&str>,
    limit: Option<usize>,
    max_bytes: usize,
) -> Result<String> {
    output::validate_budget(max_bytes)?;
    let unresolved = store.unresolved_calls(repo_filter)?;
    if unresolved.is_empty() {
        let scope = repo_filter.unwrap_or("all repos");
        return Ok(truncate_to_budget(&format!("fog: 0 unresolved calls ({scope})\n"), max_bytes));
    }
    let mut by_repo: BTreeMap<&str, usize> = BTreeMap::new();
    for call in &unresolved {
        *by_repo.entry(call.repo.as_str()).or_insert(0) += 1;
    }
    let breakdown = by_repo
        .iter()
        .map(|(r, n)| format!("{r}={n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let header = format!("fog: {} unresolved ({breakdown})", unresolved.len());
    let max_items = limit.unwrap_or(unresolved.len()).max(1);
    let take = unresolved.len().min(max_items);
    let hidden_by_limit = unresolved.len().saturating_sub(take);
    let mut lines = vec![header];
    for call in unresolved.iter().take(take) {
        let base_part = if call.base_ref.is_empty() {
            String::new()
        } else {
            format!(" base={}", call.base_ref)
        };
        lines.push(format!(
            "  {} {}:{} {} {}{}{}",
            call.repo,
            call.file,
            call.line,
            call.method.as_str(),
            call.path_norm,
            base_part,
            why_dash(&call.why)
        ));
    }
    Ok(render_lines_within_budget_extra(&lines, hidden_by_limit, max_bytes))
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
    let take = calls.len().min(max_items);
    for call in calls.iter().take(take) {
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
            lines.push(format!(
                "{head} {} {}:{}@{} [{}]{why_part}",
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

fn format_grouped_callers(callers: &[CallerEdge]) -> Vec<String> {
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
            format!(
                "  <- {} {}:{} [{}]{}",
                edge.call.service,
                edge.call.file,
                edge.call.line,
                edge.confidence.as_str(),
                why_dash(&edge.call.why)
            )
        })
        .collect();
    for (svc, group) in spa_groups {
        out.push(format_spa_group(svc, &group));
    }
    out
}

fn format_spa_group(service: &str, group: &[&CallerEdge]) -> String {
    let mut unique_files = BTreeSet::new();
    let mut areas = BTreeSet::new();
    let mut first_files = Vec::new();
    let mut seen_first = BTreeSet::new();
    let mut best_conf = Confidence::Suffix;
    let mut sample_why = "";
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
        if seen_first.insert(edge.call.file.as_str()) && first_files.len() < SPA_FILE_PREVIEW {
            first_files.push(format!("{}:{}", edge.call.file, edge.call.line));
        }
    }
    let area_list: Vec<&str> = areas.iter().copied().take(SPA_AREA_PREVIEW).collect();
    let area_suffix = if areas.len() > SPA_AREA_PREVIEW { ", ..." } else { "" };
    let pages_text = if area_list.is_empty() {
        format!("{} files", unique_files.len())
    } else {
        format!(
            "{} files in pages: {}{}",
            unique_files.len(),
            area_list.join(", "),
            area_suffix
        )
    };
    format!(
        "  <- {service}: {pages_text} ({}) [{}]{}",
        first_files.join(", "),
        best_conf.as_str(),
        why_dash(sample_why)
    )
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
}
