use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;

pub type WebExportsMap = BTreeMap<String, BTreeMap<String, String>>;

use super::contracts::extract_ts_call_opts;
use super::scan::{
    LineIndex, ROOT_SLASH, extract_ts_area, extract_url_host, extract_why_ts, find_astro_blocks,
    find_matching_delim, for_each_masked_ident, is_ident_byte, is_test_file, is_web_source,
    join_paths, matches_external_glob, normalize_path, parallel_map, read_files_parallel,
    resolve_ts_relative_import, skip_ascii_ws, sort_extracted_calls, split_top_level_args,
    split_ts_import_clause, ts_code_mask, under_root, unquote_ts_string,
};
use super::types::ExtractedCall;

const FETCH_FN: &str = "fetch";
const FETCH_IMPL_SUFFIX: &str = "typeof fetch = fetch";
const ASTRO_EXT: &str = ".astro";

static ENV_FALLBACK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]*)(?:\s*(?:\?\?|\|\|)\s*["'`]([^"'`]*)["'`])?"#,
    )
    .expect("valid env fallback regex")
});

static LITERAL_URL_CONST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*["'`](https?://[^"'`\s]+)["'`]"#,
    )
    .expect("valid literal url const regex")
});

static IMPORT_NAMED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?ms)\bimport\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']"#)
        .expect("valid web import regex")
});

static FETCH_PARAM_ALIAS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*typeof\s+fetch\s*=\s*fetch")
        .expect("valid fetch alias regex")
});

#[derive(Debug, Clone, Default)]
struct BaseBinding {
    env_var: Option<String>,
    literal_url: Option<String>,
}

pub fn read_web_sources(
    repo_dir: &Path,
    files: &[String],
    service_root: &str,
) -> (Vec<String>, Vec<(String, String)>) {
    let candidates: Vec<String> = files
        .iter()
        .filter(|rel| is_web_source(rel) && under_root(rel, service_root) && !is_test_file(rel))
        .cloned()
        .collect();
    let sources = read_files_parallel(repo_dir, &candidates);
    (candidates, sources)
}

pub fn extract_from_sources_with_exports(
    repo: &str,
    service_root: &str,
    base_service: Option<&str>,
    external_globs: &[String],
    candidates: Vec<String>,
    sources: &[(String, String)],
) -> (Vec<ExtractedCall>, WebExportsMap, HashSet<String>) {
    let known_files: HashSet<String> = candidates.into_iter().collect();
    let exports_map = collect_exported_url_consts(sources);
    let dep_files: HashSet<String> = exports_map.keys().cloned().collect();
    let calls = extract_sources_calls(
        repo, service_root, base_service, external_globs, sources, &known_files, &exports_map,
    );
    (calls, exports_map, dep_files)
}

pub fn extract_service_with_exports(
    repo: &str,
    repo_dir: &Path,
    service_root: &str,
    base_service: Option<&str>,
    external_globs: &[String],
    tracked_files: &[String],
) -> Result<(Vec<ExtractedCall>, WebExportsMap, HashSet<String>)> {
    let (candidates, sources) = read_web_sources(repo_dir, tracked_files, service_root);
    Ok(extract_from_sources_with_exports(
        repo, service_root, base_service, external_globs, candidates, &sources,
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn extract_sources_incremental(
    repo: &str,
    service_root: &str,
    base_service: Option<&str>,
    external_globs: &[String],
    sources: &[(String, String)],
    all_known_files: &HashSet<String>,
    exports_map: &WebExportsMap,
) -> (Vec<ExtractedCall>, bool) {
    if !collect_exported_url_consts(sources).is_empty() {
        return (Vec::new(), true);
    }
    let calls = extract_sources_calls(
        repo, service_root, base_service, external_globs, sources, all_known_files, exports_map,
    );
    (calls, false)
}

#[allow(clippy::too_many_arguments)]
pub fn extract_files_incremental(
    repo: &str,
    repo_dir: &Path,
    service_root: &str,
    base_service: Option<&str>,
    external_globs: &[String],
    changed_files: &[String],
    all_known_files: &HashSet<String>,
    exports_map: &WebExportsMap,
) -> (Vec<ExtractedCall>, bool) {
    let (_, sources) = read_web_sources(repo_dir, changed_files, service_root);
    extract_sources_incremental(
        repo, service_root, base_service, external_globs, &sources, all_known_files, exports_map,
    )
}

fn extract_sources_calls(
    repo: &str,
    service_root: &str,
    base_service: Option<&str>,
    external_globs: &[String],
    sources: &[(String, String)],
    known_files: &HashSet<String>,
    exports_map: &WebExportsMap,
) -> Vec<ExtractedCall> {
    let flat_exports = flatten_exports(exports_map);
    let mut calls: Vec<ExtractedCall> = parallel_map(sources, |(rel, raw)| {
        let external = matches_external_glob(external_globs, repo, rel);
        let area = extract_ts_area(rel, service_root);
        extract_calls_from_file(
            rel,
            raw,
            base_service.unwrap_or(""),
            &area,
            external,
            known_files,
            &flat_exports,
        )
    })
    .into_iter()
    .flatten()
    .collect();
    sort_extracted_calls(&mut calls);
    calls
}

fn flatten_exports(exports_map: &WebExportsMap) -> HashMap<(String, String), String> {
    let mut flat = HashMap::new();
    for (file, consts) in exports_map {
        for (name, url) in consts {
            flat.insert((file.clone(), name.clone()), url.clone());
        }
    }
    flat
}

fn collect_exported_url_consts(sources: &[(String, String)]) -> WebExportsMap {
    let mut map: WebExportsMap = BTreeMap::new();
    for (rel, raw) in sources {
        if rel.ends_with(ASTRO_EXT) {
            continue;
        }
        let mask = ts_code_mask(raw);
        for caps in LITERAL_URL_CONST_RE.captures_iter(raw) {
            let m0 = caps.get(0).unwrap();
            if mask[m0.start()] && m0.as_str().contains("export") {
                map.entry(rel.clone())
                    .or_default()
                    .insert(caps[1].to_owned(), caps[2].to_owned());
            }
        }
    }
    map
}

pub fn extract_calls_from_file(
    rel_file: &str,
    raw_source: &str,
    default_base: &str,
    area: &str,
    external: bool,
    known_files: &HashSet<String>,
    exported_urls: &HashMap<(String, String), String>,
) -> Vec<ExtractedCall> {
    let source = if rel_file.ends_with(ASTRO_EXT) {
        extract_astro_script_mask_source(raw_source)
    } else {
        raw_source.to_owned()
    };
    let mask = ts_code_mask(&source);
    let lines = LineIndex::new(&source);
    let bindings = collect_file_bindings(rel_file, &source, &mask, known_files, exported_urls);
    let fetch_names = collect_fetch_aliases(&source, &mask);
    let bytes = source.as_bytes();
    let mut out = Vec::new();

    for_each_masked_ident(&source, &mask, 0, source.len(), |ident, next_i| {
        if !fetch_names.contains(ident) {
            return Some(next_i);
        }
        let start = next_i - ident.len();
        if start > 0 && (bytes[start - 1] == b'.' || is_ident_byte(bytes[start - 1])) {
            return Some(next_i);
        }
        let pos = skip_ascii_ws(bytes, next_i, bytes.len());
        if bytes.get(pos) != Some(&b'(') || !mask[pos] {
            return Some(next_i);
        }
        let Some(close) = find_matching_delim(bytes, &mask, pos, b'(', b')') else {
            return Some(pos + 1);
        };
        let args = split_top_level_args(&source, &mask, 0, pos + 1, close);
        if let Some((_, arg0)) = args.first()
            && let Some((path_raw, base_ref)) =
                resolve_fetch_url_arg(arg0, &bindings, default_base)
        {
            let path_norm = normalize_path(&path_raw);
            if !path_norm.is_empty() {
                let (method, req_contract) = extract_ts_call_opts(&args);
                out.push(ExtractedCall {
                    method,
                    path_raw,
                    path_norm,
                    file: rel_file.to_owned(),
                    line: lines.line_at(start),
                    base_ref,
                    symbol: ident.to_owned(),
                    area: area.to_owned(),
                    why: extract_why_ts(&source, &lines, start),
                    external,
                    req_contract,
                });
            }
        }
        Some(pos + 1)
    });
    out
}

fn collect_fetch_aliases(source: &str, mask: &[bool]) -> HashSet<String> {
    let mut names = HashSet::new();
    names.insert(FETCH_FN.to_owned());
    if source.contains(FETCH_IMPL_SUFFIX) {
        for caps in FETCH_PARAM_ALIAS_RE.captures_iter(source) {
            let m0 = caps.get(0).unwrap();
            if mask[m0.start()] {
                names.insert(caps[1].to_owned());
            }
        }
    }
    names
}

fn collect_file_bindings(
    rel_file: &str,
    source: &str,
    mask: &[bool],
    known_files: &HashSet<String>,
    exported_urls: &HashMap<(String, String), String>,
) -> HashMap<String, BaseBinding> {
    let mut map: HashMap<String, BaseBinding> = HashMap::new();
    for caps in LITERAL_URL_CONST_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if mask[m0.start()] {
            map.insert(
                caps[1].to_owned(),
                BaseBinding {
                    env_var: None,
                    literal_url: Some(caps[2].to_owned()),
                },
            );
        }
    }
    for caps in ENV_FALLBACK_RE.captures_iter(source) {
        let m0 = caps.get(0).unwrap();
        if !mask[m0.start()] {
            continue;
        }
        let fallback = caps
            .get(3)
            .map(|m| m.as_str().trim())
            .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
            .map(str::to_owned);
        map.insert(
            caps[1].to_owned(),
            BaseBinding {
                env_var: Some(caps[2].to_owned()),
                literal_url: fallback,
            },
        );
    }
    if !exported_urls.is_empty() {
        for caps in IMPORT_NAMED_RE.captures_iter(source) {
            let m0 = caps.get(0).unwrap();
            if !mask[m0.start()] {
                continue;
            }
            let Some(target) = resolve_ts_relative_import(rel_file, &caps[2], known_files) else {
                continue;
            };
            for (orig, local) in split_ts_import_clause(&caps[1]) {
                if let Some(url) = exported_urls.get(&(target.clone(), orig)) {
                    map.insert(
                        local,
                        BaseBinding {
                            env_var: None,
                            literal_url: Some(url.clone()),
                        },
                    );
                }
            }
        }
    }
    map
}

fn resolve_fetch_url_arg(
    arg: &str,
    bindings: &HashMap<String, BaseBinding>,
    default_base: &str,
) -> Option<(String, String)> {
    let trimmed = arg.trim();
    if let Some(inner) = unquote_ts_string(trimmed) {
        if inner.starts_with("http://") || inner.starts_with("https://") {
            let host = extract_url_host(&inner).unwrap_or_default();
            return Some((inner, host));
        }
        if let Some(rest) = inner.strip_prefix("${")
            && let Some(close) = rest.find('}')
        {
            let var_expr = rest[..close].trim();
            let suffix = &rest[close + 1..];
            if !suffix.starts_with('/') {
                return None;
            }
            if let Some(binding) = bindings.get(var_expr) {
                return build_bound_call(binding, suffix);
            }
            return None;
        }
        if inner.starts_with('/') {
            return Some((inner, default_base.to_owned()));
        }
        return None;
    }
    if trimmed.bytes().all(|b| is_ident_byte(b) || b == b'$')
        && let Some(binding) = bindings.get(trimmed)
        && let Some(url) = &binding.literal_url
    {
        let host = extract_url_host(url).unwrap_or_default();
        let base_ref = format_base_ref(binding.env_var.as_deref(), (!host.is_empty()).then_some(host.as_str()));
        return Some((url.clone(), base_ref));
    }
    None
}

fn build_bound_call(binding: &BaseBinding, suffix: &str) -> Option<(String, String)> {
    let host = binding
        .literal_url
        .as_deref()
        .and_then(extract_url_host);
    let path_raw = match &binding.literal_url {
        Some(url) => {
            let base_path = extract_url_path_prefix(url);
            if base_path.is_empty() {
                format!("{}{}", url.trim_end_matches('/'), suffix)
            } else {
                let joined = join_paths(&base_path, suffix);
                let origin = url
                    .find("://")
                    .map(|idx| {
                        let rest = &url[idx + 3..];
                        let end = rest.find('/').map_or(url.len(), |s| idx + 3 + s);
                        &url[..end]
                    })
                    .unwrap_or(url);
                format!("{origin}{joined}")
            }
        }
        None => suffix.to_owned(),
    };
    let base_ref = format_base_ref(binding.env_var.as_deref(), host.as_deref());
    Some((path_raw, base_ref))
}

fn extract_url_path_prefix(url: &str) -> String {
    let Some(idx) = url.find("://") else {
        return String::new();
    };
    let rest = &url[idx + 3..];
    let Some(slash) = rest.find('/') else {
        return String::new();
    };
    let p = rest[slash..].trim_end_matches('/');
    if p.is_empty() || p == ROOT_SLASH {
        String::new()
    } else {
        p.to_owned()
    }
}

fn format_base_ref(env_var: Option<&str>, host: Option<&str>) -> String {
    match (env_var, host) {
        (Some(e), Some(h)) if !e.is_empty() && !h.is_empty() => format!("{e}|{h}"),
        (Some(e), _) if !e.is_empty() => e.to_owned(),
        (_, Some(h)) if !h.is_empty() => h.to_owned(),
        _ => String::new(),
    }
}

fn extract_astro_script_mask_source(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut keep = vec![false; bytes.len()];
    for block in find_astro_blocks(raw) {
        keep[block.start..block.end].fill(true);
    }
    let mut out = bytes.to_vec();
    for i in 0..out.len() {
        if !keep[i] && out[i] != b'\n' {
            out[i] = b' ';
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::super::types::HttpMethod;
    use super::*;

    #[test]
    fn extracts_astro_env_fallback_and_direct_fetch_preserving_lines() {
        let astro = r#"---
const API_URL = import.meta.env.PUBLIC_API_URL ?? 'https://api.huggian.com';
const title = "Don't break quotes";
---
<main>
  <p>It's a landing page with apostrophes!</p>
</main>
<script>
  async function submitSignup(slug: string) {
    const r1 = await fetch(`${API_URL}/v1/public/plans/${slug}`);
    const r2 = await fetch(`${API_URL}/v1/public/signup`, {
      method: 'POST',
      body: JSON.stringify({ slug }),
    });
    const r3 = await fetch('https://formsubmit.co/ajax/test', { method: 'POST' });
    return [r1, r2, r3];
  }
</script>
"#;
        let calls = extract_calls_from_file(
            "apps/huggian/src/pages/signup.astro",
            astro,
            "",
            "signup",
            false,
            &HashSet::new(),
            &HashMap::new(),
        );
        let summary: Vec<(HttpMethod, &str, &str, usize)> = calls
            .iter()
            .map(|c| (c.method, c.path_norm.as_str(), c.base_ref.as_str(), c.line))
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    HttpMethod::Get,
                    "/v1/public/plans/{}",
                    "PUBLIC_API_URL|api.huggian.com",
                    10
                ),
                (
                    HttpMethod::Post,
                    "/v1/public/signup",
                    "PUBLIC_API_URL|api.huggian.com",
                    11
                ),
                (HttpMethod::Post, "/ajax/test", "formsubmit.co", 15),
            ]
        );
        assert_eq!(calls[0].area, "signup");
    }

    #[test]
    fn incremental_web_extract_preserves_imported_url_constants() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("apps/huggian/src/data")).unwrap();
        std::fs::create_dir_all(tmp.path().join("apps/huggian/src/scripts")).unwrap();
        let data_rel = "apps/huggian/src/data/demo.ts".to_owned();
        let script_rel = "apps/huggian/src/scripts/demo.ts".to_owned();
        std::fs::write(
            tmp.path().join(&data_rel),
            "export const DEMO_ENDPOINT = 'https://api.ez-rails.huggian.com/rails/v1/demo/match';\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join(&script_rel),
            "import { DEMO_ENDPOINT } from '../data/demo';\nexport async function run() { await fetch(DEMO_ENDPOINT, { method: 'POST' }); }\n",
        )
        .unwrap();
        let tracked = vec![data_rel.clone(), script_rel.clone()];
        let (full_calls, exports_map, deps) = extract_service_with_exports(
            "huggian-landings",
            tmp.path(),
            "apps/huggian",
            None,
            &[],
            &tracked,
        )
        .unwrap();
        assert_eq!(full_calls.len(), 1);
        assert!(deps.contains(&data_rel));

        let known: HashSet<String> = tracked.into_iter().collect();
        let (inc_calls, has_exports) = extract_files_incremental(
            "huggian-landings",
            tmp.path(),
            "apps/huggian",
            None,
            &[],
            &[script_rel],
            &known,
            &exports_map,
        );
        assert!(!has_exports);
        assert_eq!(inc_calls, full_calls);
    }
}
