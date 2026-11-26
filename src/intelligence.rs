use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::native::lock_native_writes;
use crate::privacy::redact;
use crate::store::Store;

const MAX_INTELLIGENCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LEDGER_BYTES: u64 = 512 * 1024;
const MAX_LEDGER_SESSIONS: usize = 50;
const MAX_IDS_PER_SESSION: usize = 16;
const MAX_REVIEW_QUEUE: usize = 15;
const RECENT_SESSION_WINDOW_MS: i64 = 6 * 3_600 * 1_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DriftEntry {
    pub project: String,
    pub missing_paths: Vec<String>,
    pub verified_paths: Vec<String>,
    pub missing_ratio: f64,
    pub drifted: bool,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contradiction {
    pub a_id: String,
    pub a_title: String,
    pub b_id: String,
    pub b_title: String,
    pub project: String,
    pub shared_anchors: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFlag {
    pub record_id: String,
    pub project: String,
    pub reason: String,
    pub note: String,
    pub flagged_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewItem {
    pub kind: String,
    pub priority: u8,
    pub record_id: String,
    pub peer_id: Option<String>,
    pub title: String,
    pub project: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntelligenceState {
    pub version: u32,
    pub sleep_ran_at: i64,
    pub consolidation_count: usize,
    pub semantic_records: usize,
    #[serde(default)]
    pub drift: BTreeMap<String, DriftEntry>,
    #[serde(default)]
    pub contradictions: Vec<Contradiction>,
    #[serde(default)]
    pub needs_review: BTreeMap<String, ReviewFlag>,
    #[serde(default)]
    pub review_queue: Vec<ReviewItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub session_id: String,
    pub project: String,
    pub record_ids: Vec<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionLedger {
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub fn sidecar_path(db: &Path, filename: &str) -> Option<PathBuf> {
    if db == Path::new(":memory:") {
        return None;
    }
    let parent = db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Some(parent.join(filename))
}

fn ensure_private_dir(dir: &Path) -> Result<()> {
    if dir.exists() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .with_context(|| format!("cannot create directory {}", dir.display()))?;
    Ok(())
}

pub fn read_private_bytes(path: &Path, max_bytes: u64, label: &str) -> Result<Option<Vec<u8>>> {
    let pre = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("cannot inspect {label}")),
    };
    ensure!(
        !pre.file_type().is_symlink() && pre.is_file(),
        "{label} must be a regular non-symlink file: {}",
        path.display()
    );
    ensure!(
        pre.len() <= max_bytes,
        "{label} exceeds size limit ({max_bytes} bytes): {}",
        path.display()
    );
    let file = File::open(path).with_context(|| format!("cannot open {label}"))?;
    let post = file
        .metadata()
        .with_context(|| format!("cannot stat opened {label}"))?;
    ensure!(
        post.file_type().is_file(),
        "{label} changed to non-regular file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            pre.dev() == post.dev() && pre.ino() == post.ino(),
            "{label} changed while opening: {}",
            path.display()
        );
    }
    let mut buf = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut buf)
        .with_context(|| format!("cannot read {label}"))?;
    ensure!(
        buf.len() as u64 <= max_bytes,
        "{label} exceeds size limit ({max_bytes} bytes): {}",
        path.display()
    );
    Ok(Some(buf))
}

pub fn write_private_atomic(path: &Path, payload: &[u8], label: &str) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        ensure!(
            !meta.file_type().is_symlink() && meta.is_file(),
            "refusing to write through non-regular {label}: {}",
            path.display()
        );
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure_private_dir(parent)?;
    let canon_parent = fs::canonicalize(parent)
        .with_context(|| format!("cannot canonicalize {}", parent.display()))?;
    let name = path
        .file_name()
        .context("sidecar path has no filename")?
        .to_string_lossy();
    let final_path = canon_parent.join(name.as_ref());

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut tmp_path = None;
    let mut file = None;
    for attempt in 0..16u32 {
        let candidate = canon_parent.join(format!(
            ".{name}.{}.{}.{}.tmp",
            std::process::id(),
            nanos,
            attempt
        ));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&candidate) {
            Ok(f) => {
                tmp_path = Some(candidate);
                file = Some(f);
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(err).with_context(|| format!("cannot stage {label}"));
            }
        }
    }
    let (tmp_path, mut file) = match (tmp_path, file) {
        (Some(p), Some(f)) => (p, f),
        _ => bail!("unable to allocate temporary file for {label}"),
    };

    let write_res = (|| -> Result<()> {
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::symlink_metadata(&final_path) {
            ensure!(
                !meta.file_type().is_symlink() && meta.is_file(),
                "refusing to replace non-regular {label}: {}",
                final_path.display()
            );
        }
        fs::rename(&tmp_path, &final_path)?;
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_res
}

pub fn load_state(db: &Path) -> Result<IntelligenceState> {
    let Some(path) = sidecar_path(db, "intelligence.json") else {
        return Ok(IntelligenceState::default());
    };
    let Some(bytes) = read_private_bytes(&path, MAX_INTELLIGENCE_BYTES, "intelligence state")?
    else {
        return Ok(IntelligenceState::default());
    };
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid JSON in intelligence state {}", path.display()))
}

pub fn save_state(db: &Path, state: &IntelligenceState) -> Result<()> {
    let Some(path) = sidecar_path(db, "intelligence.json") else {
        bail!("intelligence state requires a durable index path");
    };
    let mut payload = serde_json::to_vec_pretty(state)?;
    payload.push(b'\n');
    write_private_atomic(&path, &payload, "intelligence state")
}

pub fn load_ledger(db: &Path) -> Result<SessionLedger> {
    let Some(path) = sidecar_path(db, "session-ledger.json") else {
        return Ok(SessionLedger::default());
    };
    let Some(bytes) = read_private_bytes(&path, MAX_LEDGER_BYTES, "session ledger")? else {
        return Ok(SessionLedger::default());
    };
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid JSON in session ledger {}", path.display()))
}

pub fn save_ledger(db: &Path, ledger: &SessionLedger) -> Result<()> {
    let Some(path) = sidecar_path(db, "session-ledger.json") else {
        return Ok(());
    };
    let mut payload = serde_json::to_vec_pretty(ledger)?;
    payload.push(b'\n');
    write_private_atomic(&path, &payload, "session ledger")
}

pub fn record_session_recall(
    db: &Path,
    session_id: &str,
    project: &str,
    record_id: &str,
) -> Result<()> {
    if db == Path::new(":memory:") || session_id.is_empty() || record_id.is_empty() {
        return Ok(());
    }
    let _lock = lock_native_writes(db)?;
    let mut ledger = load_ledger(db)?;
    let ts = now_ms();
    if let Some(entry) = ledger
        .sessions
        .iter_mut()
        .find(|s| s.session_id == session_id)
    {
        if !entry.record_ids.iter().any(|id| id == record_id)
            && entry.record_ids.len() < MAX_IDS_PER_SESSION
        {
            entry.record_ids.push(record_id.to_owned());
        }
        if entry.project == "*" && !project.is_empty() {
            entry.project = project.to_owned();
        }
        entry.updated_at = ts;
    } else {
        ledger.sessions.push(SessionEntry {
            session_id: session_id.to_owned(),
            project: if project.is_empty() {
                "*".to_owned()
            } else {
                project.to_owned()
            },
            record_ids: vec![record_id.to_owned()],
            updated_at: ts,
        });
    }
    ledger
        .sessions
        .sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    ledger.sessions.truncate(MAX_LEDGER_SESSIONS);
    save_ledger(db, &ledger)
}

pub fn link_session_co_used(db: &Path, new_id: &str, prior_ids: &[String]) -> Result<usize> {
    if db == Path::new(":memory:") || prior_ids.is_empty() {
        return Ok(0);
    }
    let _lock = lock_native_writes(db)?;
    let mut store = Store::open(db, true)?;
    store.link_co_used_against(new_id, prior_ids)
}

fn is_superseded(store: &Store, id: &str) -> bool {
    store
        .record_signal(id)
        .ok()
        .flatten()
        .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("superseded")
}

pub fn build_review_queue(store: &Store, state: &mut IntelligenceState) -> Result<()> {
    let mut queue = Vec::new();
    let mut seen_ids = BTreeSet::new();

    // 1. Flagged by outcome/correction (priority = 1), skipping superseded records
    let mut flags: Vec<&ReviewFlag> = state.needs_review.values().collect();
    flags.sort_by_key(|a| std::cmp::Reverse(a.flagged_at));
    for flag in flags {
        if queue.len() >= MAX_REVIEW_QUEUE {
            break;
        }
        if is_superseded(store, &flag.record_id) {
            continue;
        }
        if let Ok(Some(rec)) = store.get(&flag.record_id)
            && seen_ids.insert(flag.record_id.clone())
        {
            queue.push(ReviewItem {
                kind: "correction_flag".to_owned(),
                priority: 1,
                record_id: rec.id,
                peer_id: None,
                title: rec.title,
                project: rec.project,
                reason: if flag.note.is_empty() {
                    flag.reason.clone()
                } else {
                    format!("{}: {}", flag.reason, flag.note)
                },
            });
        }
    }

    // 2. Potential contradictions (priority = 2), skipping pairs where either side is superseded
    for c in &state.contradictions {
        if queue.len() >= MAX_REVIEW_QUEUE {
            break;
        }
        if is_superseded(store, &c.a_id) || is_superseded(store, &c.b_id) {
            continue;
        }
        if seen_ids.insert(c.a_id.clone()) {
            queue.push(ReviewItem {
                kind: "contradiction".to_owned(),
                priority: 2,
                record_id: c.a_id.clone(),
                peer_id: Some(c.b_id.clone()),
                title: format!("{} ⇄ {}", c.a_title, c.b_title),
                project: c.project.clone(),
                reason: c.reason.clone(),
            });
        }
    }

    // 3. Drifted from HEAD (priority = 3), skipping superseded records
    let mut drifted: Vec<(&String, &DriftEntry)> = state
        .drift
        .iter()
        .filter(|(_, d)| d.drifted)
        .collect();
    drifted.sort_by(|a, b| {
        b.1.missing_ratio
            .total_cmp(&a.1.missing_ratio)
            .then_with(|| b.1.missing_paths.len().cmp(&a.1.missing_paths.len()))
    });
    for (rid, d) in drifted {
        if queue.len() >= MAX_REVIEW_QUEUE {
            break;
        }
        if is_superseded(store, rid) {
            continue;
        }
        if let Ok(Some(rec)) = store.get(rid)
            && seen_ids.insert(rid.clone())
        {
            let sample = d
                .missing_paths
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            queue.push(ReviewItem {
                kind: "code_drift".to_owned(),
                priority: 3,
                record_id: rec.id,
                peer_id: None,
                title: rec.title,
                project: rec.project,
                reason: format!(
                    "Missing {} cited path(s) in repo HEAD: {}",
                    d.missing_paths.len(),
                    sample
                ),
            });
        }
    }

    // 4. High-use unverified curated memories (priority = 4)
    if queue.len() < MAX_REVIEW_QUEUE
        && let Ok(browsed) = store.browse(&crate::model::BrowseOptions {
            source: Some("curated".into()),
            status: Some("unverified".into()),
            sort: Some("use_count".into()),
            limit: MAX_REVIEW_QUEUE,
            ..Default::default()
        })
        && let Some(items) = browsed.get("items").and_then(Value::as_array)
    {
        for it in items {
            if queue.len() >= MAX_REVIEW_QUEUE {
                break;
            }
            let use_count = it.get("use_count").and_then(Value::as_i64).unwrap_or(0);
            let link_count = it.get("link_count").and_then(Value::as_i64).unwrap_or(0);
            if use_count == 0 && link_count < 3 {
                continue;
            }
            let Some(rid) = it.get("id").and_then(Value::as_str) else {
                continue;
            };
            if seen_ids.insert(rid.to_owned()) {
                queue.push(ReviewItem {
                    kind: "unverified_hub".to_owned(),
                    priority: 4,
                    record_id: rid.to_owned(),
                    peer_id: None,
                    title: it
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(rid)
                        .to_owned(),
                    project: it
                        .get("project")
                        .and_then(Value::as_str)
                        .unwrap_or("*")
                        .to_owned(),
                    reason: format!(
                        "Active unverified curated hub (used {use_count}×, {link_count} links)"
                    ),
                });
            }
        }
    }

    state.review_queue = queue;
    Ok(())
}

pub fn record_outcome(
    db: &Path,
    outcome: &str,
    project: Option<&str>,
    explicit_ids: &[String],
    note: Option<&str>,
) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "outcome requires a durable index path"
    );
    ensure!(
        matches!(outcome, "pass" | "fail" | "correction"),
        "outcome must be pass, fail, or correction"
    );
    let _lock = lock_native_writes(db)?;
    let alias_map = crate::aliases::load(db)?;
    let resolved_project = project
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| crate::aliases::resolve(&alias_map, p));

    let mut target_ids: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for id in explicit_ids {
        let trimmed = id.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
            target_ids.push(trimmed.to_owned());
        }
    }
    if target_ids.is_empty() {
        let ledger = load_ledger(db)?;
        let cutoff = now_ms() - RECENT_SESSION_WINDOW_MS;
        for sess in &ledger.sessions {
            if sess.updated_at < cutoff {
                continue;
            }
            let proj_matches = match &resolved_project {
                Some(p) => sess.project == *p || sess.project == "*",
                None => true,
            };
            if !proj_matches {
                continue;
            }
            for id in &sess.record_ids {
                if seen.insert(id.clone()) {
                    target_ids.push(id.clone());
                }
            }
            if target_ids.len() >= MAX_IDS_PER_SESSION {
                break;
            }
        }
    }

    let ts = now_ms();
    let clean_note = note
        .map(|n| {
            let r = redact(n.trim());
            r.chars().take(240).collect::<String>()
        })
        .unwrap_or_default();

    let mut reinforced = 0usize;
    let mut co_links = 0usize;
    let mut flagged = 0usize;

    if outcome == "pass" {
        if !target_ids.is_empty() {
            let mut store = Store::open(db, true)?;
            let (u, l) = store.reinforce_co_used(&target_ids, true)?;
            reinforced = u;
            co_links = l;
        }
    } else {
        let store = Store::open(db, false)?;
        let mut state = load_state(db)?;
        for id in &target_ids {
            if let Ok(Some(rec)) = store.get(id) {
                state.needs_review.insert(
                    id.clone(),
                    ReviewFlag {
                        record_id: id.clone(),
                        project: rec.project,
                        reason: format!("Flagged after {outcome} outcome"),
                        note: clean_note.clone(),
                        flagged_at: ts,
                    },
                );
                flagged += 1;
            }
        }
        build_review_queue(&store, &mut state)?;
        save_state(db, &state)?;
    }

    Ok(json!({
        "outcome": outcome,
        "project": resolved_project,
        "target_ids": target_ids,
        "reinforced": reinforced,
        "co_used_links": co_links,
        "flagged_for_review": flagged,
    }))
}

pub fn dismiss_review_flag(db: &Path, record_id: &str) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "dismiss requires a durable index path"
    );
    let id = record_id.trim();
    ensure!(!id.is_empty(), "record id cannot be empty");
    let _lock = lock_native_writes(db)?;
    let store = Store::open(db, false)?;
    let mut state = load_state(db)?;
    let removed = state.needs_review.remove(id).is_some();
    build_review_queue(&store, &mut state)?;
    save_state(db, &state)?;
    Ok(json!({
        "dismissed": removed,
        "record_id": id,
        "review_queue_len": state.review_queue.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn intelligence_sidecars_enforce_private_modes_and_refuse_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("nested").join("memory.db");
        let state = IntelligenceState {
            version: 1,
            sleep_ran_at: 123,
            ..Default::default()
        };
        save_state(&db, &state).unwrap();
        let path = sidecar_path(&db, "intelligence.json").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let victim = tmp.path().join("victim.json");
        fs::write(&victim, "{}").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&victim, &path).unwrap();
        assert!(load_state(&db).is_err());
        assert!(save_state(&db, &state).is_err());
    }
}
