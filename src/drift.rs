use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;

use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde_json::{Value, json};

use crate::aliases::{AliasMap, resolve};
use crate::intelligence::{DriftEntry, now_ms};
use crate::store::{Store, canonical_project_root};

const MAX_WALK_FILES: usize = 60_000;
const MAX_WALK_DEPTH: usize = 12;

static REPO_REL_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[\s`(\x22'])((?:src|apps|packages|backend|frontend|crates|services|libs|tests|scripts|migrations|config|cmd|internal|pkg|server|client|web|api|docs)/[A-Za-z0-9_./-]+\.(?:rs|ts|tsx|js|jsx|py|go|sql|toml|yml|yaml|json|sh|css|html|md))\b",
    )
    .expect("valid repo path regex")
});

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".turbo",
    ".cache",
];

pub fn extract_repo_paths(content: &str) -> Vec<String> {
    let mut paths = BTreeSet::new();
    let sample_end = content
        .char_indices()
        .take_while(|(idx, _)| *idx < 24_576)
        .last()
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    for cap in REPO_REL_PATH.captures_iter(&content[..sample_end]) {
        let Some(m) = cap.get(1) else { continue };
        let raw = m.as_str().trim_matches(|c: char| c == '.' || c == '/');
        if raw.is_empty()
            || raw.len() > 160
            || raw.contains("..")
            || raw.contains('*')
            || raw.contains('{')
        {
            continue;
        }
        paths.insert(raw.to_owned());
    }
    paths.into_iter().collect()
}

pub struct RepoFileIndex {
    exact: HashSet<String>,
    suffixes: HashSet<String>,
}

impl RepoFileIndex {
    pub fn contains_cited(&self, cited: &str) -> bool {
        let norm = cited.trim_start_matches("./");
        if self.exact.contains(norm) || self.suffixes.contains(norm) {
            return true;
        }
        false
    }
}

pub fn collect_repo_files(repo: &Path) -> Result<RepoFileIndex> {
    let canon = fs::canonicalize(repo)
        .with_context(|| format!("cannot resolve repository path {}", repo.display()))?;
    ensure!(canon.is_dir(), "repository path is not a directory");

    let mut files = Vec::new();
    if canon.join(".git").exists()
        && let Ok(out) = Command::new("git")
            .arg("-C")
            .arg(&canon)
            .args(["-c", "core.fsmonitor=false", "ls-files", "-z"])
            .output()
        && out.status.success()
    {
        for raw in out.stdout.split(|b| *b == 0) {
            if raw.is_empty() {
                continue;
            }
            if let Ok(s) = std::str::from_utf8(raw) {
                files.push(s.to_owned());
                if files.len() >= MAX_WALK_FILES {
                    break;
                }
            }
        }
    }

    if files.is_empty() {
        walk_dir_bounded(&canon, &canon, 0, &mut files)?;
    }

    let mut exact = HashSet::with_capacity(files.len());
    let mut suffixes = HashSet::with_capacity(files.len() * 2);
    for f in files {
        let parts: Vec<&str> = f.split('/').collect();
        if parts.len() >= 2 {
            for start in 1..parts.len().saturating_sub(1) {
                suffixes.insert(parts[start..].join("/"));
            }
            suffixes.insert(parts[parts.len() - 2..].join("/"));
        }
        exact.insert(f);
    }
    Ok(RepoFileIndex { exact, suffixes })
}

fn walk_dir_bounded(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<String>,
) -> Result<()> {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_WALK_FILES {
        return Ok(());
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_WALK_FILES {
            break;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if meta.is_dir() {
            if SKIP_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            walk_dir_bounded(root, &path, depth + 1, out)?;
        } else if meta.is_file()
            && let Ok(rel) = path.strip_prefix(root)
            && let Some(s) = rel.to_str()
        {
            out.push(s.replace('\\', "/"));
        }
    }
    Ok(())
}

pub fn audit_project_drift(
    store: &Store,
    project: &str,
    repo_path: &Path,
) -> Result<(BTreeMap<String, DriftEntry>, Value)> {
    let index = collect_repo_files(repo_path)?;
    let target_root = canonical_project_root(project);
    let mut checked = 0usize;
    let mut drifted_count = 0usize;
    let mut entries = BTreeMap::new();
    let ts = now_ms();

    for source_type in ["markdown", "iron"] {
        for rec in store.list_records(source_type, &[])? {
            let rec_root = canonical_project_root(&rec.project);
            if rec.project != project && rec_root != target_root {
                continue;
            }
            let sig = store.record_signal(&rec.id)?;
            if sig
                .as_ref()
                .and_then(|v| v.get("status"))
                .and_then(Value::as_str)
                == Some("superseded")
            {
                continue;
            }
            let cited = extract_repo_paths(&rec.content);
            if cited.is_empty() {
                continue;
            }
            checked += 1;
            let mut verified = Vec::new();
            let mut missing = Vec::new();
            for p in cited {
                if index.contains_cited(&p) {
                    verified.push(p);
                } else {
                    missing.push(p);
                }
            }
            let total = verified.len() + missing.len();
            let missing_ratio = if total == 0 {
                0.0
            } else {
                missing.len() as f64 / total as f64
            };
            let is_drifted = !missing.is_empty() && missing_ratio >= 0.6;
            if is_drifted {
                drifted_count += 1;
                entries.insert(
                    rec.id.clone(),
                    DriftEntry {
                        project: rec.project,
                        missing_paths: missing,
                        verified_paths: verified,
                        missing_ratio: (missing_ratio * 100.0).round() / 100.0,
                        drifted: true,
                        checked_at: ts,
                    },
                );
            }
        }
    }

    let summary = json!({
        "project": project,
        "repo": repo_path.display().to_string(),
        "records_with_paths": checked,
        "drifted_records": drifted_count,
    });
    Ok((entries, summary))
}

pub fn audit_repos_root(
    store: &Store,
    aliases: &AliasMap,
    repos_root: &Path,
) -> Result<(BTreeMap<String, DriftEntry>, Vec<Value>)> {
    let mut all_entries = BTreeMap::new();
    let mut summaries = Vec::new();
    if !repos_root.is_dir() {
        return Ok((all_entries, summaries));
    }

    let mut candidate_repos = Vec::new();
    for entry in fs::read_dir(repos_root)?.flatten() {
        let p = entry.path();
        if fs::symlink_metadata(&p).is_ok_and(|m| !m.file_type().is_symlink() && m.is_dir()) {
            if p.join(".git").exists() {
                candidate_repos.push(p);
            } else if let Ok(sub) = fs::read_dir(&p) {
                for sub_entry in sub.flatten() {
                    let sp = sub_entry.path();
                    if fs::symlink_metadata(&sp)
                        .is_ok_and(|m| !m.file_type().is_symlink() && m.is_dir())
                        && sp.join(".git").exists()
                    {
                        candidate_repos.push(sp);
                    }
                }
            }
        }
    }

    // Prioritize canonical-named directories (name == resolved) before aliased dirs,
    // and sort deterministically by path so read_dir order never causes alias drift false positives.
    candidate_repos.sort_by(|a, b| {
        let a_name = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let b_name = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let a_canon = resolve(aliases, a_name) == a_name;
        let b_canon = resolve(aliases, b_name) == b_name;
        b_canon.cmp(&a_canon).then_with(|| a.cmp(b))
    });

    let mut audited_projects = HashSet::new();
    for repo in candidate_repos {
        let Some(name) = repo.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let resolved = resolve(aliases, name);
        if !audited_projects.insert(resolved.clone()) {
            continue;
        }
        if let Ok((entries, summary)) = audit_project_drift(store, &resolved, &repo) {
            if summary["records_with_paths"].as_u64().unwrap_or(0) > 0 {
                summaries.push(summary);
            }
            all_entries.extend(entries);
        }
    }

    Ok((all_entries, summaries))
}

pub fn audit_and_save_drift(db: &Path, project: &str, repo: &Path) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "audit-drift requires a durable index path"
    );
    let _lock = crate::native::lock_native_writes(db)?;
    let alias_map = crate::aliases::load(db)?;
    let resolved = resolve(&alias_map, project);
    let target_root = canonical_project_root(&resolved);
    let store = Store::open(db, false)
        .context("cannot open Iron index; run memory import first")?;
    let (entries, summary) = audit_project_drift(&store, &resolved, repo)?;
    let mut state = crate::intelligence::load_state(db)?;
    state.drift.retain(|_, v| {
        v.project != resolved && canonical_project_root(&v.project) != target_root
    });
    state.drift.extend(entries);
    crate::intelligence::build_review_queue(&store, &mut state)?;
    crate::intelligence::save_state(db, &state)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ImportBatch, MemoryRecord};
    use tempfile::TempDir;

    #[test]
    fn drift_detector_flags_missing_cited_files_and_keeps_live_files_clean() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("acme-app");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/live_handler.rs"), "pub fn ok() {}\n").unwrap();

        let db = tmp.path().join("memory.db");
        let mut store = Store::open(&db, true).unwrap();
        store
            .apply(&ImportBatch {
                groups: vec!["seed".into()],
                records: vec![
                    MemoryRecord {
                        id: "rec_live".into(),
                        source_group: "seed".into(),
                        source_key: "live".into(),
                        source_type: "markdown".into(),
                        kind: "curated".into(),
                        project: "acme-app".into(),
                        title: "Live rule".into(),
                        content: "Always check `src/live_handler.rs` before deploying.".into(),
                        source_path: "/mem/live.md".into(),
                        updated_at: 1_700_000_000_000,
                        metadata: json!({}),
                    },
                    MemoryRecord {
                        id: "rec_stale".into(),
                        source_group: "seed".into(),
                        source_key: "stale".into(),
                        source_type: "iron".into(),
                        kind: "decision".into(),
                        project: "acme-app".into(),
                        title: "Deleted file rule".into(),
                        content: "Update `src/old_removed_worker.rs` and `src/legacy_queue.rs`.".into(),
                        source_path: "native://iron/stale".into(),
                        updated_at: 1_700_000_000_000,
                        metadata: json!({}),
                    },
                ],
                ..Default::default()
            })
            .unwrap();

        let (entries, summary) = audit_project_drift(&store, "acme-app", &repo).unwrap();
        assert_eq!(summary["records_with_paths"], 2);
        assert_eq!(summary["drifted_records"], 1);
        assert!(!entries.contains_key("rec_live"));
        let stale = entries.get("rec_stale").expect("stale entry");
        assert!(stale.drifted);
        assert_eq!(stale.missing_paths.len(), 2);
    }
}
