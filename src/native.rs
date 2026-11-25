use crate::model::{ImportBatch, MemoryRecord};
use crate::privacy::redact;
use crate::store::Store;
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RememberRequest {
    pub title: String,
    pub content: String,
    pub project: String,
    pub kind: Option<String>,
    pub agent: Option<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackRequest {
    pub id: String,
    pub outcome: String,
    pub superseded_by: Option<String>,
}


fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MergeProjectsRequest {
    pub from: String,
    pub to: String,
    #[serde(default = "default_true")]
    pub include_subpaths: bool,
    #[serde(default = "default_true")]
    pub save_alias: bool,
}

pub fn merge_projects(db: &Path, req: MergeProjectsRequest) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "merge_projects requires a durable index path"
    );
    let from = crate::aliases::validate_project_name("from project", &req.from)?;
    let to = crate::aliases::validate_project_name("to project", &req.to)?;
    ensure!(from != to, "source and target project names must differ");

    let _lock = lock_native_writes(db)?;
    let existing = crate::aliases::load(db)?;
    let (target_project, planned_aliases) = if req.save_alias {
        let (_, resolved_to, next) = crate::aliases::plan_alias(&existing, &from, &to)?;
        (resolved_to, Some(next))
    } else {
        (to, None)
    };
    let mut store = Store::open(db, true)?;
    let updated = store.merge_projects(&from, &target_project, req.include_subpaths)?;
    let aliases = if let Some(next) = planned_aliases {
        crate::aliases::save_atomic(db, &next)?;
        next
    } else {
        existing
    };
    Ok(json!({
        "from": from,
        "to": target_project,
        "include_subpaths": req.include_subpaths,
        "save_alias": req.save_alias,
        "updated_records": updated,
        "aliases": aliases,
    }))
}

pub fn remove_project_alias(db: &Path, from: &str) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "remove_project_alias requires a durable index path"
    );
    let _lock = lock_native_writes(db)?;
    let aliases = crate::aliases::remove_alias(db, from)?;
    Ok(json!({ "aliases": aliases }))
}

pub fn feedback(db: &Path, req: FeedbackRequest) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "feedback requires a durable index path"
    );
    validate_id(&req.id)?;
    if let Some(rep) = &req.superseded_by {
        validate_id(rep)?;
    }
    let mut store = Store::open(db, true)?;
    let _lock = lock_native_writes(db)?;
    store.record_feedback(&req.id, &req.outcome, req.superseded_by.as_deref())
}

pub fn reinforce_once(db: &Path, id: &str) -> Result<bool> {
    if db == Path::new(":memory:") {
        return Ok(false);
    }
    validate_id(id)?;
    let mut store = Store::open(db, true)?;
    let _lock = lock_native_writes(db)?;
    store.reinforce_use(id)
}

fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "invalid memory ID"
    );
    Ok(())
}

pub fn remember(db: &Path, req: RememberRequest) -> Result<Value> {
    ensure!(
        db != Path::new(":memory:"),
        "remember requires a durable index path"
    );
    validate_text("title", &req.title, 200)?;
    validate_text("content", &req.content, 65_536)?;
    validate_text("project", &req.project, 256)?;
    let alias_map = crate::aliases::load(db)?;
    let req_project = crate::aliases::resolve(&alias_map, &req.project);
    ensure!(
        req.supersedes.len() <= 16,
        "supersedes must not exceed 16 target IDs"
    );
    for old_id in &req.supersedes {
        validate_id(old_id)?;
    }
    let kind = req.kind.unwrap_or_else(|| "note".into());
    ensure!(
        matches!(
            kind.as_str(),
            "note" | "decision" | "preference" | "gotcha" | "correction"
        ),
        "kind must be note, decision, preference, gotcha, or correction"
    );
    let agent = req.agent.unwrap_or_else(|| "unknown".into());
    ensure!(agent.len() <= 64, "agent must not exceed 64 UTF-8 bytes");
    let title = redact(&req.title);
    let content = redact(&req.content);
    let project = redact(&req_project);
    let agent = redact(&agent);
    let agent = if agent.trim().is_empty() {
        "unknown".into()
    } else {
        agent
    };
    validate_text("redacted title", &title, 200)?;
    validate_text("redacted content", &content, 65_536)?;
    validate_text("redacted project", &project, 256)?;
    ensure!(
        agent.len() <= 64,
        "redacted agent must not exceed 64 UTF-8 bytes"
    );
    let identity =
        serde_json::to_vec(&("iron-native-v1", &project, &kind, &title, &content, &agent))?;
    let id = format!("mem_{:x}", Sha256::digest(identity));
    let group = format!("native:{id}");
    let metadata =
        json!({"agent": agent, "capture": "manual", "explicit": true, "identity_version": 1});
    let mut store = Store::open(db, true)?;
    let _lock = lock_native_writes(db)?;
    if let Some(existing) = store.get(&id)? {
        ensure!(
            existing.source_type == "iron"
                && existing.source_group == group
                && existing.source_key == id
                && existing.title == title
                && existing.content == content
                && existing.project == project
                && existing.kind == kind
                && existing.metadata == metadata,
            "native memory identity conflicts with an existing record"
        );
        if !req.supersedes.is_empty() {
            for old_id in &req.supersedes {
                let _ = store.record_feedback(old_id, "outdated", Some(&id));
            }
        }
        return Ok(json!({"id": id, "saved": true, "duplicate": true}));
    }
    let updated_at = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system time precedes the Unix epoch")?
            .as_millis(),
    )
    .context("system time exceeds the supported timestamp range")?;
    let record = MemoryRecord {
        id: id.clone(),
        source_group: group,
        source_key: id.clone(),
        source_type: "iron".into(),
        kind,
        project,
        title,
        content,
        source_path: format!("iron://{id}"),
        updated_at,
        metadata,
    };
    let (duplicate, superseded, related_memories) =
        store.insert_native_and_autolink(&record, &req.supersedes)?;
    let mut out = json!({"id": id, "saved": true, "duplicate": duplicate});
    if !superseded.is_empty() {
        out["superseded"] = json!(superseded);
    }
    if !related_memories.is_empty() {
        out["related_memories"] = json!(related_memories);
    }
    Ok(out)
}

const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TIMESTAMP_MS: i64 = 4_102_444_800_000;

fn redact_json_strings(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_json_strings).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), redact_json_strings(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn canonical_native_record(mut record: MemoryRecord) -> Result<MemoryRecord> {
    record.title = redact(&record.title);
    record.content = redact(&record.content);
    record.project = redact(&record.project);
    validate_text("redacted title", &record.title, 200)?;
    validate_text("redacted content", &record.content, 65_536)?;
    validate_text("redacted project", &record.project, 256)?;
    let raw_agent = record
        .metadata
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let redacted_agent = redact(raw_agent);
    let agent = if redacted_agent.trim().is_empty() {
        "unknown".to_string()
    } else {
        redacted_agent
    };
    ensure!(agent.len() <= 64, "redacted agent must not exceed 64 UTF-8 bytes");
    let identity = serde_json::to_vec(&(
        "iron-native-v1",
        &record.project,
        &record.kind,
        &record.title,
        &record.content,
        &agent,
    ))?;
    let id = format!("mem_{:x}", Sha256::digest(identity));
    record.id = id.clone();
    record.source_group = format!("native:{id}");
    record.source_key = id.clone();
    record.source_type = "iron".into();
    record.source_path = format!("iron://{id}");
    record.metadata =
        json!({"agent": agent, "capture": "manual", "explicit": true, "identity_version": 1});
    Ok(record)
}

pub fn export_jsonl(store: &Store, output_path: &Path, scope: &str) -> Result<Value> {
    let raw_records = match scope {
        "native" => store.list_records("iron", &[])?,
        "summaries" => store.list_records("cavemem", &["session", "summary"])?,
        _ => bail!("export scope must be native or summaries"),
    };
    if let Ok(meta) = fs::symlink_metadata(output_path) {
        ensure!(
            !meta.file_type().is_symlink() && !meta.is_dir(),
            "export output must be a non-symlink file path"
        );
    }
    let parent = output_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    let parent = parent.canonicalize()?;
    let filename = output_path
        .file_name()
        .context("export output requires a filename")?;
    let final_path = parent.join(filename);
    if let Ok(meta) = fs::symlink_metadata(&final_path) {
        ensure!(
            !meta.file_type().is_symlink() && !meta.is_dir(),
            "export output must be a non-symlink file path"
        );
    }

    let mut prepared: Vec<MemoryRecord> = Vec::with_capacity(raw_records.len());
    if scope == "native" {
        let mut by_id: std::collections::BTreeMap<String, MemoryRecord> =
            std::collections::BTreeMap::new();
        for rec in raw_records {
            let canonical = canonical_native_record(rec)?;
            by_id
                .entry(canonical.id.clone())
                .and_modify(|existing| {
                    if canonical.updated_at > existing.updated_at {
                        existing.updated_at = canonical.updated_at;
                    }
                })
                .or_insert(canonical);
        }
        prepared.extend(by_id.into_values());
    } else {
        for mut rec in raw_records {
            rec.title = redact(&rec.title);
            rec.content = redact(&rec.content);
            rec.project = redact(&rec.project);
            rec.metadata = redact_json_strings(&rec.metadata);
            prepared.push(rec);
        }
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system time precedes the Unix epoch")?
        .as_nanos();
    let temp_path = parent.join(format!(".iron-export-{}-{stamp}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&temp_path)?;
    let write_and_publish = || -> Result<u64> {
        let mut file = file;
        let mut bytes = 0u64;
        for record in &prepared {
            let mut line = serde_json::to_vec(record)?;
            line.push(b'\n');
            file.write_all(&line)?;
            bytes += line.len() as u64;
        }
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::symlink_metadata(&final_path) {
            ensure!(
                !meta.file_type().is_symlink() && !meta.is_dir(),
                "export destination changed to symlink or directory"
            );
        }
        fs::rename(&temp_path, &final_path)?;
        Ok(bytes)
    };
    let bytes = match write_and_publish() {
        Ok(b) => b,
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            return Err(err);
        }
    };
    Ok(json!({
        "path": final_path.to_string_lossy(),
        "scope": scope,
        "records": prepared.len(),
        "bytes": bytes,
    }))
}

pub fn import_jsonl(db: &Path, input_path: &Path) -> Result<Value> {
    use std::io::Read;
    ensure!(
        db != Path::new(":memory:"),
        "import_jsonl requires a durable index path"
    );
    let pre = fs::symlink_metadata(input_path)
        .with_context(|| format!("cannot inspect native JSONL {}", input_path.display()))?;
    ensure!(
        pre.file_type().is_file(),
        "native JSONL input must be a regular file (not a symlink or special file)"
    );
    ensure!(
        pre.len() <= MAX_IMPORT_BYTES,
        "native JSONL exceeds 64 MiB limit"
    );
    let file = File::open(input_path)?;
    let post = file.metadata()?;
    ensure!(post.file_type().is_file(), "opened input is not a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            pre.dev() == post.dev() && pre.ino() == post.ino(),
            "native JSONL file changed during open"
        );
    }
    ensure!(
        post.len() <= MAX_IMPORT_BYTES,
        "native JSONL exceeds 64 MiB limit"
    );
    let reader = BufReader::new(file.take(MAX_IMPORT_BYTES + 1));
    let mut by_id: std::collections::BTreeMap<String, MemoryRecord> =
        std::collections::BTreeMap::new();
    let mut total_bytes = 0u64;
    for (idx, line) in reader.lines().enumerate() {
        let line = line?;
        total_bytes += line.len() as u64 + 1;
        ensure!(total_bytes <= MAX_IMPORT_BYTES, "native JSONL stream exceeds 64 MiB limit");
        if line.trim().is_empty() {
            continue;
        }
        let record: MemoryRecord = serde_json::from_str(&line)
            .with_context(|| format!("invalid native MemoryRecord at line {}", idx + 1))?;
        ensure!(
            record.source_type == "iron",
            "line {}: source_type must be iron",
            idx + 1
        );
        ensure!(
            matches!(
                record.kind.as_str(),
                "note" | "decision" | "preference" | "gotcha" | "correction"
            ),
            "line {}: unsupported native kind",
            idx + 1
        );
        ensure!(
            (0..=MAX_TIMESTAMP_MS).contains(&record.updated_at),
            "line {}: updated_at out of supported range",
            idx + 1
        );
        validate_text("title", &record.title, 200)?;
        validate_text("content", &record.content, 65_536)?;
        validate_text("project", &record.project, 256)?;
        ensure!(
            redact(&record.title) == record.title
                && redact(&record.content) == record.content
                && redact(&record.project) == record.project,
            "line {}: native record contains unredacted sensitive content",
            idx + 1
        );
        let agent = record
            .metadata
            .get("agent")
            .and_then(Value::as_str)
            .context("native record metadata.agent is required")?;
        ensure!(
            !agent.trim().is_empty() && agent.len() <= 64 && redact(agent) == agent,
            "line {}: invalid or unredacted metadata.agent",
            idx + 1
        );
        let canonical_meta =
            json!({"agent": agent, "capture": "manual", "explicit": true, "identity_version": 1});
        ensure!(
            record.metadata == canonical_meta,
            "line {}: non-canonical native metadata",
            idx + 1
        );
        let expected_identity = serde_json::to_vec(&(
            "iron-native-v1",
            &record.project,
            &record.kind,
            &record.title,
            &record.content,
            agent,
        ))?;
        let expected_id = format!("mem_{:x}", Sha256::digest(expected_identity));
        let expected_group = format!("native:{expected_id}");
        ensure!(
            record.id == expected_id
                && record.source_group == expected_group
                && record.source_key == expected_id
                && record.source_path == format!("iron://{expected_id}"),
            "line {}: native memory SHA-256 identity mismatch",
            idx + 1
        );
        if let Some(prev) = by_id.get(&record.id) {
            ensure!(
                prev.content == record.content && prev.title == record.title,
                "line {}: conflicting duplicate record ID",
                idx + 1
            );
        } else {
            by_id.insert(record.id.clone(), record);
        }
    }
    let parent = db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    let _lock = lock_native_writes(db)?;
    let mut store = Store::open(db, true)?;
    let mut groups = Vec::new();
    let mut to_insert = Vec::new();
    let mut unchanged = 0usize;
    for record in by_id.into_values() {
        if let Some(existing) = store.get(&record.id)? {
            ensure!(
                existing.source_type == "iron"
                    && existing.title == record.title
                    && existing.content == record.content
                    && existing.project == record.project
                    && existing.kind == record.kind
                    && existing.metadata == record.metadata,
                "existing record conflicts with imported native memory {}",
                record.id
            );
            unchanged += 1;
            continue;
        }
        groups.push(record.source_group.clone());
        to_insert.push(record);
    }
    let inserted = if to_insert.is_empty() {
        0
    } else {
        store
            .apply(&ImportBatch {
                groups,
                records: to_insert,
                ..ImportBatch::default()
            })?
            .inserted
    };
    Ok(json!({
        "imported": inserted,
        "unchanged": unchanged,
        "total": inserted + unchanged,
    }))
}

fn validate_text(field: &str, text: &str, max_bytes: usize) -> Result<()> {
    ensure!(
        !text.trim().is_empty() && text.len() <= max_bytes,
        "{field} must contain 1 to {max_bytes} UTF-8 bytes and must not be blank"
    );
    Ok(())
}

fn lock_native_writes(db: &Path) -> Result<File> {
    let parent = db
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()?;
    let name = db
        .file_name()
        .context("index must be a file path")?
        .to_string_lossy();
    let path = parent.join(format!(".{name}.native.lock"));
    match fs::symlink_metadata(&path) {
        Ok(metadata) => ensure!(
            !metadata.file_type().is_symlink(),
            "native memory lock must not be a symbolic link"
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("cannot inspect the native memory write lock"),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .context("cannot open the native memory write lock")?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if started.elapsed() >= Duration::from_secs(10) {
                    bail!("another native memory write is active; retry after it completes");
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error).context("cannot lock native memory writes"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SearchOptions;
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;

    fn request() -> RememberRequest {
        RememberRequest {
            title: "Shared capture policy".into(),
            content: "Native memories are retained with an explicit author.".into(),
            project: "iron-suite".into(),
            kind: None,
            agent: None,
            supersedes: Vec::new(),
        }
    }

    #[test]
    fn export_and_import_jsonl_roundtrip_verifies_hash_and_rejects_tampering() {
        let temporary = TempDir::new().unwrap();
        let src_db = temporary.path().join("src.db");
        let created = remember(&src_db, request()).unwrap();
        let src_store = Store::open(&src_db, false).unwrap();
        let orig = src_store.get(created["id"].as_str().unwrap()).unwrap().unwrap();
        let jsonl = temporary.path().join("export/memories.jsonl");
        let exp = export_jsonl(&src_store, &jsonl, "native").unwrap();
        assert_eq!(exp["records"], 1);

        let dst_db = temporary.path().join("dst.db");
        let imp1 = import_jsonl(&dst_db, &jsonl).unwrap();
        assert_eq!(imp1["imported"], 1);
        assert_eq!(imp1["unchanged"], 0);
        let imp2 = import_jsonl(&dst_db, &jsonl).unwrap();
        assert_eq!(imp2["imported"], 0);
        assert_eq!(imp2["unchanged"], 1);
        let restored = Store::open(&dst_db, false)
            .unwrap()
            .get(&orig.id)
            .unwrap()
            .unwrap();
        assert_eq!(restored.updated_at, orig.updated_at);
        assert_eq!(restored.content, orig.content);

        let tampered = temporary.path().join("tampered.jsonl");
        let mut mutated: Value = serde_json::from_str(fs::read_to_string(&jsonl).unwrap().trim()).unwrap();
        mutated["content"] = json!("Tampered content without recomputing mem_ sha256");
        let raw = format!("{}\n", serde_json::to_string(&mutated).unwrap());
        fs::write(&tampered, raw).unwrap();
        assert!(
            import_jsonl(&dst_db, &tampered)
                .unwrap_err()
                .to_string()
                .contains("SHA-256 identity mismatch")
        );
    }

    #[test]
    fn persists_native_memory_and_replay_preserves_the_capture_time() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        let first = remember(&db, request()).unwrap();
        assert_eq!(first["saved"], true);
        assert_eq!(first["duplicate"], false);
        let id = first["id"].as_str().unwrap();
        let mut store = Store::open(&db, true).unwrap();
        let mut saved = store.get(id).unwrap().unwrap();
        assert_eq!(saved.source_type, "iron");
        assert_eq!(saved.source_path, format!("iron://{id}"));
        assert_eq!(saved.source_group, format!("native:{id}"));
        assert_eq!(saved.source_key, id);
        assert_eq!(saved.kind, "note");
        assert_eq!(saved.metadata["agent"], "unknown");
        assert_eq!(saved.metadata["capture"], "manual");
        assert_eq!(saved.metadata["explicit"], true);
        assert!(saved.updated_at > 0);
        saved.updated_at = 123;
        store
            .apply(&ImportBatch {
                groups: vec![saved.source_group.clone()],
                records: vec![saved],
                ..ImportBatch::default()
            })
            .unwrap();
        drop(store);
        let replay = remember(&db, request()).unwrap();
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["duplicate"], true);
        let reopened = Store::open(&db, false).unwrap();
        assert_eq!(reopened.get(id).unwrap().unwrap().updated_at, 123);
        assert_eq!(reopened.stats().unwrap()["records"], 1);
    }

    #[test]
    fn additional_memories_and_different_authors_survive_replay() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        let first = remember(&db, request()).unwrap();
        let mut second = request();
        second.content = "A second independent memory remains in the shared store.".into();
        let second = remember(&db, second).unwrap();
        let mut other_author = request();
        other_author.agent = Some("codex".into());
        let other_author = remember(&db, other_author).unwrap();
        assert_ne!(first["id"], second["id"]);
        assert_ne!(first["id"], other_author["id"]);
        assert_eq!(remember(&db, request()).unwrap()["duplicate"], true);
        let store = Store::open(&db, false).unwrap();
        for result in [&first, &second, &other_author] {
            assert!(store.get(result["id"].as_str().unwrap()).unwrap().is_some());
        }
        assert_eq!(store.stats().unwrap()["records"], 3);
        assert_eq!(store.stats().unwrap()["bodies"], 2);
    }

    #[test]
    fn native_capture_redacts_every_user_text_field_before_storage() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        let capture = RememberRequest {
            title: "Credential note <private>hidden-title</private>".into(),
            content: "DATABASE_PASSWORD=\"correcthorsebatterystaple\"\n<private>hidden-content</private>\nOrdinary retained evidence.".into(),
            project: "sk-abcdefghijklmnop1234".into(),
            kind: Some("gotcha".into()),
            agent: Some("ghp_abcdefghijklmnopqrstuvwxyz1234".into()),
            supersedes: Vec::new(),
        };
        let result = remember(&db, capture).unwrap();
        let store = Store::open(&db, false).unwrap();
        let saved = store.get(result["id"].as_str().unwrap()).unwrap().unwrap();
        let serialized = serde_json::to_string(&saved).unwrap();
        for secret in [
            "hidden-title",
            "correcthorsebatterystaple",
            "hidden-content",
            "abcdefghijklmnop1234",
            "abcdefghijklmnopqrstuvwxyz1234",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert!(saved.content.contains("Ordinary retained evidence."));
        assert_eq!(saved.project, "[REDACTED]");
        assert_eq!(saved.metadata["agent"], "[REDACTED]");
        assert!(
            store
                .search(
                    "correcthorsebatterystaple",
                    &SearchOptions {
                        limit: 10,
                        ..SearchOptions::default()
                    }
                )
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_bounds_and_unknown_fields_fail_before_storage_creation() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        for (field, value) in [
            ("title", String::new()),
            ("title", " ".into()),
            ("title", "é".repeat(101)),
            ("title", format!("{}<private>", "a".repeat(191))),
            ("content", String::new()),
            ("content", "a".repeat(65_537)),
            ("project", String::new()),
            ("project", "p".repeat(257)),
            ("agent", "a".repeat(65)),
            ("kind", "unsupported".into()),
        ] {
            let mut value_request =
                json!({"title":"Valid", "content":"Valid content", "project":"iron-suite"});
            value_request[field] = Value::String(value);
            let request = serde_json::from_value(value_request).unwrap();
            assert!(remember(&db, request).is_err(), "invalid {field} accepted");
            assert!(!db.exists());
        }
        assert!(serde_json::from_value::<RememberRequest>(json!({"title":"Valid","content":"Valid content","project":"iron-suite","path":"/unrequested/path"})).is_err());
        assert!(remember(Path::new(":memory:"), request()).is_err());
    }

    #[test]
    fn concurrent_exact_requests_save_once_and_report_duplicate_accurately() {
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        drop(Store::open(&db, true).unwrap());
        let barrier = Arc::new(Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let db = db.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    remember(&db, request()).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| result["duplicate"] == false)
                .count(),
            1
        );
        assert!(
            results
                .iter()
                .all(|result| result["id"] == results[0]["id"])
        );
        assert_eq!(
            Store::open(&db, false).unwrap().stats().unwrap()["records"],
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_lock_is_private_and_refuses_symbolic_links() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temporary = TempDir::new().unwrap();
        let db = temporary.path().join("iron.db");
        remember(&db, request()).unwrap();
        let lock = temporary.path().join(".iron.db.native.lock");
        assert_eq!(
            fs::metadata(&lock).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let target = temporary.path().join("untouched.txt");
        fs::write(&target, "must remain unchanged").unwrap();
        let blocked_db = temporary.path().join("blocked.db");
        symlink(&target, temporary.path().join(".blocked.db.native.lock")).unwrap();
        assert!(
            remember(&blocked_db, request())
                .unwrap_err()
                .to_string()
                .contains("symbolic link")
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "must remain unchanged"
        );
        assert_eq!(
            Store::open(&blocked_db, false).unwrap().stats().unwrap()["records"],
            0
        );
    }
}
