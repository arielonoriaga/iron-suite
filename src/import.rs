use crate::model::{ImportBatch, MemoryLink, MemoryRecord};
use crate::privacy::{is_secret_field, redact, redact_credential};
use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use rusqlite::{Connection, OpenFlags, Row, Transaction, limits::Limit, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

const MAX_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 512 * 1024 * 1024;
const MAX_RECORDS: usize = 1_000_000;
const MAX_ENTRIES: usize = 500_000;
const MAX_DEPTH: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 1024;
const MAX_TITLE_BYTES: usize = 512;
const MAX_PROJECT_BYTES: usize = 256;
const MAX_GIT_POINTER_BYTES: usize = 16 * 1024;
const MAX_SQLITE_ROW_BYTES: i32 = 10 * 1024 * 1024;

static INLINE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^\r\n]*?["'])?\s*\)"#)
        .unwrap()
});
static REFERENCE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s{0,3}\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]+)>|([^\s]+))").unwrap()
});
static WIKI_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]*)?(?:\|[^\]\r\n]*)?\]\]").unwrap()
});

#[derive(Default)]
struct Budget {
    records: usize,
    bytes: usize,
    entries: usize,
}

impl Budget {
    fn visit(&mut self) -> Result<()> {
        self.entries += 1;
        ensure!(
            self.entries <= MAX_ENTRIES,
            "Source traversal exceeds the entry limit"
        );
        Ok(())
    }

    fn add(&mut self, batch: &mut ImportBatch, record: MemoryRecord) -> Result<()> {
        self.records += 1;
        ensure!(
            self.records <= MAX_RECORDS,
            "Import exceeds the record limit"
        );
        ensure!(
            record.content.len() <= MAX_CONTENT_BYTES,
            "Indexed content exceeds the byte limit"
        );
        ensure!(
            record.title.len() <= MAX_TITLE_BYTES && record.project.len() <= MAX_PROJECT_BYTES,
            "Indexed title or project exceeds the byte limit"
        );
        ensure!(
            record.source_path.len() <= MAX_PATH_BYTES + MAX_ID_BYTES + 32,
            "Indexed source locator exceeds the byte limit"
        );
        ensure!(
            record.source_key.len() <= MAX_PATH_BYTES + 32
                && record.source_group.len() <= MAX_PATH_BYTES + 32,
            "Indexed source identity exceeds the byte limit"
        );
        let metadata_bytes = serde_json::to_vec(&record.metadata)?.len();
        ensure!(
            metadata_bytes <= MAX_METADATA_BYTES,
            "Record metadata exceeds the byte limit"
        );
        let bytes = record.content.len()
            + record.title.len()
            + record.project.len()
            + record.source_path.len()
            + record.source_key.len()
            + record.source_group.len()
            + metadata_bytes;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .context("Import byte count overflow")?;
        ensure!(
            self.bytes <= MAX_TOTAL_BYTES,
            "Import exceeds the total byte limit"
        );
        batch.records.push(record);
        Ok(())
    }
}

pub fn collect(claude_root: Option<&Path>, cavemem_db: Option<&Path>) -> Result<ImportBatch> {
    ensure!(
        claude_root.is_some() || cavemem_db.is_some(),
        "No import source was provided"
    );
    let mut batch = ImportBatch::default();
    let mut budget = Budget::default();
    if let Some(root) = claude_root {
        collect_markdown(root, &mut batch, &mut budget)?;
    }
    if let Some(db) = cavemem_db {
        collect_cavemem(db, &mut batch, &mut budget)?;
    }
    Ok(batch)
}

pub fn project_for_repo(path: &Path) -> Result<String> {
    resolved_project(path).map(|(project, _)| project)
}

fn resolved_project(path: &Path) -> Result<(String, &'static str)> {
    let canonical = fs::canonicalize(path)
        .with_context(|| format!("Cannot resolve project directory {}", path.display()))?;
    let directory = if canonical.is_dir() {
        canonical.as_path()
    } else {
        canonical
            .parent()
            .context("Project path has no parent directory")?
    };
    for ancestor in directory.ancestors().take(MAX_DEPTH) {
        let git = ancestor.join(".git");
        let Some(_) = optional_metadata(&git)? else {
            continue;
        };
        let metadata = fs::metadata(&git)?;
        let git_dir = if metadata.is_dir() {
            fs::canonicalize(&git)?
        } else {
            let pointer = read_text(&git, MAX_GIT_POINTER_BYTES, None)?;
            let target = pointer
                .trim()
                .strip_prefix("gitdir:")
                .context("Invalid Git directory pointer")?
                .trim();
            ensure!(!target.is_empty(), "Git directory pointer is empty");
            fs::canonicalize(ancestor.join(target)).context("Cannot resolve Git directory")?
        };
        let common_pointer = git_dir.join("commondir");
        let common = if optional_metadata(&common_pointer)?.is_some() {
            let pointer = read_text(&common_pointer, MAX_GIT_POINTER_BYTES, None)?;
            ensure!(
                !pointer.trim().is_empty(),
                "Git common directory pointer is empty"
            );
            fs::canonicalize(git_dir.join(pointer.trim()))
                .context("Cannot resolve Git common directory")?
        } else {
            git_dir
        };
        let repo = if common.file_name().is_some_and(|name| name == ".git") {
            common
                .parent()
                .context("Git common directory has no repository parent")?
        } else {
            common.as_path()
        };
        return Ok((scope_for_path(repo)?, "git_common_directory"));
    }
    Ok((scope_for_path(directory)?, "existing_directory_path"))
}

fn project_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Project name is not valid UTF-8")?;
    ensure!(
        !name.is_empty() && name.len() <= MAX_PROJECT_BYTES,
        "Project name exceeds the byte limit"
    );
    if redact(name) == name {
        Ok(name.to_owned())
    } else {
        Ok(format!(
            "redacted-project:{:x}",
            Sha256::digest(name.as_bytes())
        ))
    }
}

fn scope_for_path(path: &Path) -> Result<String> {
    let normalized = normalize_project_path(path);
    let path_string = path_text(&normalized)?;
    let components: Vec<_> = normalized
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect();
    if normalized.is_absolute()
        && components.len() >= 3
        && matches!(components[0], "home" | "Users")
    {
        if components.len() == 3 && components[2] == ".claude" {
            return Ok("dot-claude".into());
        }
        if components[2] == "Projects" && components.len() >= 4 {
            let start = if components.len() >= 5 && components[3] == "Personal" {
                4
            } else {
                3
            };
            let key = components[start..]
                .iter()
                .map(|component| escape_project_component(component))
                .collect::<Vec<_>>()
                .join("/");
            if key.len() <= MAX_PROJECT_BYTES && redact(&key) == key {
                return Ok(key);
            }
        }
    }
    let namespace = if normalized.is_absolute() {
        "path"
    } else {
        "relative"
    };
    let leaf = normalized
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("root");
    let readable = truncate_utf8(&escape_project_component(&redact(leaf)), 64);
    Ok(format!(
        "{namespace}:{readable}@{:x}",
        Sha256::digest(path_string.as_bytes())
    ))
}

fn normalize_project_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some_and(|name| name != "..") {
                    normalized.pop();
                } else if !path.is_absolute() {
                    normalized.push("..");
                }
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn escape_project_component(component: &str) -> String {
    let mut escaped = String::new();
    for character in component.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            escaped.push(character);
        } else {
            for byte in character.to_string().bytes() {
                escaped.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    escaped
}

fn optional_metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Cannot inspect {}", path.display())),
    }
}

fn path_text(path: &Path) -> Result<&str> {
    let value = path.to_str().context("Source path is not valid UTF-8")?;
    ensure!(
        value.len() <= MAX_PATH_BYTES,
        "Source path exceeds the byte limit"
    );
    Ok(value)
}

fn canonical_inside(path: &Path, root: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path)
        .with_context(|| format!("Cannot resolve source {}", path.display()))?;
    ensure!(
        canonical.starts_with(root),
        "Source path escapes the approved import root: {}",
        path.display()
    );
    path_text(&canonical)?;
    Ok(canonical)
}

fn read_text(path: &Path, limit: usize, approved_root: Option<&Path>) -> Result<String> {
    let file =
        File::open(path).with_context(|| format!("Cannot read source {}", path.display()))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "Source is not a regular file: {}",
        path.display()
    );
    ensure!(
        metadata.len() <= limit as u64,
        "Source exceeds its byte limit: {}",
        path.display()
    );
    if let Some(root) = approved_root {
        verify_open_file(&file, path, root)?;
    }
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut buffer)?;
    ensure!(
        buffer.len() <= limit,
        "Source grew beyond its byte limit: {}",
        path.display()
    );
    String::from_utf8(buffer)
        .with_context(|| format!("Source is not valid UTF-8: {}", path.display()))
}

#[cfg(target_os = "linux")]
fn verify_open_file(file: &File, _: &Path, root: &Path) -> Result<()> {
    use std::os::fd::AsRawFd;
    canonical_inside(
        &PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd())),
        root,
    )?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn verify_open_file(_: &File, path: &Path, root: &Path) -> Result<()> {
    canonical_inside(path, root)?;
    Ok(())
}

fn stable_id(group: &str, key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update((group.len() as u64).to_be_bytes());
    digest.update(group.as_bytes());
    digest.update((key.len() as u64).to_be_bytes());
    digest.update(key.as_bytes());
    format!("mem_{:x}", digest.finalize())
}

fn source_group(source_type: &str, canonical: &Path) -> Result<String> {
    Ok(format!(
        "{source_type}:{:x}",
        Sha256::digest(path_text(canonical)?.as_bytes())
    ))
}

fn safe_source_key(key: &str) -> String {
    if redact(key) == key {
        key.to_owned()
    } else {
        format!("redacted:{:x}", Sha256::digest(key.as_bytes()))
    }
}

fn collect_markdown(root: &Path, batch: &mut ImportBatch, budget: &mut Budget) -> Result<()> {
    let root = fs::canonicalize(root)
        .with_context(|| format!("Cannot resolve Claude root {}", root.display()))?;
    ensure!(root.is_dir(), "Claude import root is not a directory");
    let group = source_group("markdown", &root)?;
    let mut pending = Vec::new();
    for child in ["memory", "agent-memory"] {
        add_source_directory(&root.join(child), &root, &mut pending)?;
    }
    let projects = root.join("projects");
    if optional_metadata(&projects)?.is_some() {
        let projects = canonical_inside(&projects, &root)?;
        ensure!(
            projects.is_dir(),
            "Claude projects source is not a directory"
        );
        for entry in fs::read_dir(&projects).context("Cannot read Claude projects directory")? {
            budget.visit()?;
            let entry = entry?;
            if entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                add_source_directory(&entry.path().join("memory"), &root, &mut pending)?;
            }
        }
    }
    let mut visited = HashSet::new();
    let mut files = BTreeSet::new();
    while let Some((directory, depth)) = pending.pop() {
        ensure!(
            depth <= MAX_DEPTH,
            "Markdown source exceeds the directory depth limit"
        );
        let directory = canonical_inside(&directory, &root)?;
        if !visited.insert(directory.clone()) {
            continue;
        }
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("Cannot read source directory {}", directory.display()))?
        {
            budget.visit()?;
            let entry = entry?;
            let canonical = canonical_inside(&entry.path(), &root)?;
            let metadata = fs::metadata(&canonical)?;
            if metadata.is_dir() {
                pending.push((canonical, depth + 1));
            } else if metadata.is_file() && is_markdown(&canonical) {
                files.insert(canonical);
            }
        }
    }
    let first_record = batch.records.len();
    let mut ids = BTreeMap::new();
    for path in files {
        let relative = path.strip_prefix(&root)?;
        let key = path_text(relative)?.to_owned();
        let original = read_text(&path, MAX_CONTENT_BYTES, Some(&root))?;
        let content = redact(&original);
        let was_redacted = original != content;
        let metadata = fs::metadata(&path)?;
        let updated_at = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let (project, project_basis) = markdown_project(relative)?;
        let id = stable_id(&group, &key);
        let title = markdown_title(&content, &path);
        let record = MemoryRecord {
            id: id.clone(),
            source_group: group.clone(),
            source_key: safe_source_key(&key),
            source_type: "markdown".into(),
            kind: "curated".into(),
            project,
            title,
            content,
            source_path: redact(path_text(&path)?),
            updated_at,
            metadata: json!({
                "relative_path": redact(&key),
                "project_basis": project_basis,
                "source_bytes": original.len(),
                "redacted": was_redacted,
            }),
        };
        budget.add(batch, record)?;
        ids.insert(path, id);
    }
    let mut links = BTreeSet::new();
    let source_paths: HashMap<_, _> = ids.iter().map(|(path, id)| (id.as_str(), path)).collect();
    for record in &batch.records[first_record..] {
        let source = source_paths
            .get(record.id.as_str())
            .context("Missing Markdown source identity")?;
        for target in markdown_references(&record.content)? {
            if let Some(target_id) = resolve_reference(source, &target, &root, &ids)
                && target_id != record.id
            {
                links.insert((record.id.clone(), target_id));
                ensure!(
                    links.len() <= MAX_ENTRIES,
                    "Markdown references exceed the link limit"
                );
            }
        }
    }
    batch
        .links
        .extend(links.into_iter().map(|(from_id, to_id)| {
            MemoryLink::explicit(from_id, to_id, "references".into())
        }));
    batch.groups.push(group);
    Ok(())
}

fn add_source_directory(
    path: &Path,
    root: &Path,
    pending: &mut Vec<(PathBuf, usize)>,
) -> Result<()> {
    if optional_metadata(path)?.is_none() {
        return Ok(());
    }
    let canonical = canonical_inside(path, root)?;
    ensure!(
        canonical.is_dir(),
        "Markdown source is not a directory: {}",
        path.display()
    );
    pending.push((canonical, 0));
    Ok(())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn markdown_project(relative: &Path) -> Result<(String, &'static str)> {
    let parts: Vec<_> = relative
        .components()
        .filter_map(|part| match part {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    if parts.len() >= 4 && parts[0] == "memory" && parts[1] == "projects" {
        return Ok((
            project_name(Path::new(parts[2]))?,
            "curated_project_directory",
        ));
    }
    if parts.len() >= 4 && parts[0] == "projects" && parts[2] == "memory" {
        let slug = parts[1];
        let name = slug
            .split_once("-Projects-")
            .or_else(|| slug.split_once("-projects-"))
            .map(|(_, name)| name)
            .unwrap_or(slug.trim_start_matches('-'));
        return Ok((
            project_name(Path::new(name))?,
            "legacy_project_slug_inferred",
        ));
    }
    Ok(("*".into(), "global_memory_directory"))
}

fn markdown_title(content: &str, path: &Path) -> String {
    let heading = content.lines().find_map(|line| {
        let line = line.trim();
        let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
        if (1..=6).contains(&hashes) && line.as_bytes().get(hashes) == Some(&b' ') {
            Some(line[hashes + 1..].trim())
        } else {
            None
        }
    });
    truncate_utf8(
        &redact(heading.unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Memory")
        })),
        MAX_TITLE_BYTES,
    )
}

fn truncate_utf8(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn markdown_references(content: &str) -> Result<BTreeSet<String>> {
    let mut targets = BTreeSet::new();
    for pattern in [&*INLINE_LINK, &*REFERENCE_LINK] {
        for captures in pattern.captures_iter(content) {
            if let Some(target) = captures.get(1).or_else(|| captures.get(2))
                && target.as_str().len() <= MAX_PATH_BYTES
            {
                targets.insert(target.as_str().to_owned());
                ensure!(
                    targets.len() <= MAX_ENTRIES,
                    "Markdown references exceed the link limit"
                );
            }
        }
    }
    for captures in WIKI_LINK.captures_iter(content) {
        if captures[1].len() <= MAX_PATH_BYTES {
            targets.insert(captures[1].to_owned());
            ensure!(
                targets.len() <= MAX_ENTRIES,
                "Markdown references exceed the link limit"
            );
        }
    }
    Ok(targets)
}

fn resolve_reference(
    source: &Path,
    target: &str,
    root: &Path,
    ids: &BTreeMap<PathBuf, String>,
) -> Option<String> {
    let target = target.split('#').next()?.split('?').next()?.trim();
    if target.is_empty()
        || target.len() > MAX_PATH_BYTES
        || target.contains(':')
        || target.starts_with('~')
    {
        return None;
    }
    let decoded = percent_decode(target)?;
    let mut candidate = source.parent()?.join(decoded);
    if candidate.extension().is_none() {
        candidate.set_extension("md");
    }
    let canonical = fs::canonicalize(candidate).ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    ids.get(&canonical).cloned()
}

fn percent_decode(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let high = (*bytes.get(cursor + 1)? as char).to_digit(16)?;
            let low = (*bytes.get(cursor + 2)? as char).to_digit(16)?;
            output.push((high * 16 + low) as u8);
            cursor += 3;
        } else {
            output.push(bytes[cursor]);
            cursor += 1;
        }
    }
    if output.contains(&0) {
        return None;
    }
    String::from_utf8(output).ok()
}

#[derive(Clone)]
struct Session {
    project: String,
    record_id: String,
}

fn collect_cavemem(path: &Path, batch: &mut ImportBatch, budget: &mut Budget) -> Result<()> {
    let path = fs::canonicalize(path)
        .with_context(|| format!("Cannot resolve Cavemem database {}", path.display()))?;
    ensure!(path.is_file(), "Cavemem database is not a regular file");
    let locator = path_text(&path)?.to_owned();
    let group = source_group("cavemem", &path)?;
    let mut connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("Cannot open Cavemem database read-only")?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_SQLITE_ROW_BYTES)?;
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.pragma_update(None, "query_only", true)?;
    let transaction = connection.transaction()?;
    let sessions = collect_sessions(&transaction, &group, &locator, batch, budget)?;
    collect_events(
        &transaction,
        "summaries",
        &group,
        &locator,
        &sessions,
        batch,
        budget,
    )?;
    collect_events(
        &transaction,
        "observations",
        &group,
        &locator,
        &sessions,
        batch,
        budget,
    )?;
    transaction.commit()?;
    batch.groups.push(group);
    Ok(())
}

fn collect_sessions(
    transaction: &Transaction<'_>,
    group: &str,
    locator: &str,
    batch: &mut ImportBatch,
    budget: &mut Budget,
) -> Result<HashMap<String, Session>> {
    let mut statement = transaction
        .prepare("SELECT id, ide, cwd, started_at, ended_at, metadata FROM sessions ORDER BY id")
        .context("Cannot read Cavemem sessions")?;
    let mut rows = statement.query([])?;
    let mut sessions = HashMap::new();
    let mut projects = HashMap::new();
    while let Some(row) = rows.next()? {
        let id = row_text(row, 0, MAX_ID_BYTES)?;
        let ide = row_text(row, 1, MAX_TITLE_BYTES)?;
        let cwd = row_optional_text(row, 2, MAX_PATH_BYTES)?;
        let started_at: i64 = row.get(3)?;
        let ended_at: Option<i64> = row.get(4)?;
        let metadata = row_optional_text(row, 5, MAX_METADATA_BYTES)?;
        let (project, basis) = session_project(cwd.as_deref(), &mut projects)?;
        let provenance = json!({
            "id": redact(&id),
            "ide": redact(&ide),
            "cwd": cwd.as_deref().map(redact),
            "started_at": started_at,
            "ended_at": ended_at,
            "metadata": source_metadata(metadata),
            "project_basis": basis,
        });
        let key = format!("sessions:{id}");
        let record_id = stable_id(group, &key);
        budget.add(batch, MemoryRecord {
            id: record_id.clone(),
            source_group: group.to_owned(),
            source_key: safe_source_key(&key),
            source_type: "cavemem".into(),
            kind: "session".into(),
            project: project.clone(),
            title: "Session".into(),
            content: String::new(),
            source_path: redact(&format!("{locator}#{key}")),
            updated_at: ended_at.unwrap_or(started_at),
            metadata: json!({"source_table": "sessions", "source_id": redact(&id), "session": provenance}),
        })?;
        ensure!(
            !sessions.contains_key(&id),
            "Duplicate Cavemem session identity"
        );
        sessions.insert(id, Session { project, record_id });
    }
    Ok(sessions)
}

fn session_project(
    cwd: Option<&str>,
    cache: &mut HashMap<String, (String, &'static str)>,
) -> Result<(String, &'static str)> {
    let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) else {
        return Ok(("*".into(), "missing_session_cwd"));
    };
    if let Some(project) = cache.get(cwd) {
        return Ok(project.clone());
    }
    let path = Path::new(cwd);
    let project = if !path.is_absolute() {
        (scope_for_path(path)?, "relative_cwd_lexical_path")
    } else {
        match fs::metadata(path) {
            Ok(_) => resolved_project(path)?,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                (scope_for_path(path)?, "missing_cwd_lexical_path")
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Cannot inspect Cavemem session directory {cwd}"));
            }
        }
    };
    cache.insert(cwd.to_owned(), project.clone());
    Ok(project)
}

fn collect_events(
    transaction: &Transaction<'_>,
    table: &str,
    group: &str,
    locator: &str,
    sessions: &HashMap<String, Session>,
    batch: &mut ImportBatch,
    budget: &mut Budget,
) -> Result<()> {
    let sql = match table {
        "summaries" => {
            "SELECT id, session_id, scope, content, compressed, intensity, ts, NULL FROM summaries ORDER BY id"
        }
        "observations" => {
            "SELECT id, session_id, kind, content, compressed, intensity, ts, metadata FROM observations ORDER BY id"
        }
        _ => bail!("Unsupported Cavemem source table"),
    };
    let mut statement = transaction
        .prepare(sql)
        .with_context(|| format!("Cannot read Cavemem {table}"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let source_id: i64 = row.get(0)?;
        let session_id = row_text(row, 1, MAX_ID_BYTES)?;
        let source_kind = row_text(row, 2, MAX_TITLE_BYTES)?;
        let original = row_text(row, 3, MAX_CONTENT_BYTES)?;
        let compressed: i64 = row.get(4)?;
        let intensity = row_optional_text(row, 5, MAX_TITLE_BYTES)?;
        let updated_at: i64 = row.get(6)?;
        let metadata = row_optional_text(row, 7, MAX_METADATA_BYTES)?;
        let session = sessions
            .get(&session_id)
            .with_context(|| format!("Cavemem {table} row has no source session"))?;
        let key = format!("{table}:{source_id}");
        let content = redact(&original);
        let was_redacted = original != content;
        let title = if table == "summaries" {
            format!("{} summary", redact(&source_kind))
        } else {
            format!("{} observation", redact(&source_kind))
        };
        budget.add(
            batch,
            MemoryRecord {
                id: stable_id(group, &key),
                source_group: group.to_owned(),
                source_key: key.clone(),
                source_type: "cavemem".into(),
                kind: if table == "summaries" {
                    "summary"
                } else {
                    "observation"
                }
                .into(),
                project: session.project.clone(),
                title: truncate_utf8(&title, MAX_TITLE_BYTES),
                content,
                source_path: redact(&format!("{locator}#{key}")),
                updated_at,
                metadata: json!({
                    "source_table": table,
                    "source_id": source_id,
                    "session_id": redact(&session_id),
                    "session_record_id": session.record_id,
                    "source_kind": redact(&source_kind),
                    "compressed": compressed,
                    "intensity": intensity.as_deref().map(redact),
                    "metadata": source_metadata(metadata),
                    "redacted": was_redacted,
                    "source_bytes": original.len(),
                }),
            },
        )?;
    }
    Ok(())
}

fn row_text(row: &Row<'_>, index: usize, limit: usize) -> Result<String> {
    match row.get_ref(index)? {
        ValueRef::Text(value) => {
            ensure!(
                value.len() <= limit,
                "Cavemem text field exceeds its byte limit"
            );
            Ok(std::str::from_utf8(value)
                .context("Cavemem text is not valid UTF-8")?
                .to_owned())
        }
        _ => bail!("Cavemem source has an unexpected field type"),
    }
}

fn row_optional_text(row: &Row<'_>, index: usize, limit: usize) -> Result<Option<String>> {
    if row.get_ref(index)? == ValueRef::Null {
        Ok(None)
    } else {
        row_text(row, index, limit).map(Some)
    }
}

fn source_metadata(raw: Option<String>) -> Value {
    raw.map(|raw| {
        serde_json::from_str(&raw)
            .map(redact_metadata)
            .unwrap_or_else(|_| Value::String(redact(&raw)))
    })
    .unwrap_or(Value::Null)
}

fn redact_metadata(value: Value) -> Value {
    redact_metadata_in_context(value, false)
}

fn redact_metadata_in_context(value: Value, credential: bool) -> Value {
    match value {
        Value::String(text) => Value::String(if credential {
            redact_credential(&text)
        } else {
            redact(&text)
        }),
        Value::Number(_) if credential => Value::String("[REDACTED]".into()),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_metadata_in_context(value, credential))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value =
                        redact_metadata_in_context(value, credential || is_secret_field(&key));
                    (redact(&key), value)
                })
                .collect(),
        ),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn database(path: &Path) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, ide TEXT NOT NULL, cwd TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT);
             CREATE TABLE observations(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, compressed INTEGER NOT NULL, intensity TEXT, ts INTEGER NOT NULL, metadata TEXT);
             CREATE TABLE summaries(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL, compressed INTEGER NOT NULL, intensity TEXT, ts INTEGER NOT NULL);"
        ).unwrap();
        connection
    }

    fn referenced_session<'a>(batch: &'a ImportBatch, event: &MemoryRecord) -> &'a MemoryRecord {
        assert!(event.metadata.get("session").is_none());
        let id = event.metadata["session_record_id"].as_str().unwrap();
        let session = batch.records.iter().find(|record| record.id == id).unwrap();
        assert_eq!(session.kind, "session");
        assert_eq!(session.metadata["source_id"], event.metadata["session_id"]);
        session
    }

    #[test]
    fn desktop_and_laptop_personal_project_aliases_follow_the_shared_harness() {
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/commerce-core")).unwrap(),
            "commerce-core"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/alex/Projects/Personal/commerce-core")).unwrap(),
            "commerce-core"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/alex/Projects/studio/realtime-api")).unwrap(),
            "studio/realtime-api"
        );
        assert_ne!(
            scope_for_path(Path::new("/home/alex/Projects/org-a/shared-api")).unwrap(),
            scope_for_path(Path::new("/home/alex/Projects/org-b/shared-api")).unwrap()
        );
    }

    #[test]
    fn markdown_keeps_content_identity_and_human_project_scope() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path();
        let path = root.join("memory/projects/iron-suite/history.md");
        let content = "# 日本語 🧠\nFull historical evidence.\n\nCafé <private>hidden token</private> safe.\n";
        write(&path, content);
        write(
            &root.join("agent-memory/backend/MEMORY.md"),
            "# Global\nGlobal conventions",
        );
        let first = collect(Some(root), None).unwrap();
        let second = collect(Some(root), None).unwrap();
        assert_eq!(first.records.len(), 2);
        assert_eq!(
            serde_json::to_value(&first.records).unwrap(),
            serde_json::to_value(&second.records).unwrap()
        );
        let history = first
            .records
            .iter()
            .find(|record| record.project == "iron-suite")
            .unwrap();
        assert_eq!(history.title, "日本語 🧠");
        assert!(history.content.ends_with(" safe.\n"));
        assert!(!history.content.contains("hidden token"));
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        write(&path, "# Changed\nUpdated evidence");
        let changed = collect(Some(root), None).unwrap();
        assert!(
            changed.records.iter().any(
                |record| record.id == history.id && record.content.contains("Updated evidence")
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_aliases_have_one_record_and_keep_curated_scope() {
        use std::os::unix::fs::symlink;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("claude");
        write(
            &root.join("memory/projects/human-name/MEMORY.md"),
            "# Index\n[Notes](note.md)",
        );
        write(
            &root.join("memory/projects/human-name/note.md"),
            "# Notes\nlinked",
        );
        fs::create_dir_all(root.join("projects/-home-dev-Projects-other-name")).unwrap();
        symlink(
            root.join("memory/projects/human-name"),
            root.join("projects/-home-dev-Projects-other-name/memory"),
        )
        .unwrap();
        symlink(&root, temporary.path().join("alias")).unwrap();
        let first = collect(Some(&root), None).unwrap();
        let alias = collect(Some(&temporary.path().join("alias")), None).unwrap();
        assert_eq!(first.records.len(), 2);
        assert_eq!(first.links.len(), 1);
        assert!(
            first
                .records
                .iter()
                .all(|record| record.project == "human-name")
        );
        assert_eq!(first.groups, alias.groups);
        assert_eq!(
            serde_json::to_value(first.records).unwrap(),
            serde_json::to_value(alias.records).unwrap()
        );
    }

    #[test]
    fn explicit_links_only_connect_collected_local_sources() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("claude");
        write(
            &root.join("memory/index.md"),
            "# Index\n[local](local%20note.md#section) [outside](../../outside.md) [web](https://example.com)\n[missing](missing.md) [[local note]]\n<private>[private](hidden.md)</private>",
        );
        write(&root.join("memory/local note.md"), "# Target\nEvidence");
        write(&root.join("memory/hidden.md"), "# Hidden target");
        write(&temporary.path().join("outside.md"), "# Outside");
        let batch = collect(Some(&root), None).unwrap();
        assert_eq!(batch.links.len(), 1);
        let target = batch
            .records
            .iter()
            .find(|record| record.title == "Target")
            .unwrap();
        assert_eq!(batch.links[0].to_id, target.id);
        assert_eq!(batch.links[0].relation, "references");
    }

    #[test]
    fn missing_or_invalid_sources_fail_before_returning_a_batch() {
        let temporary = TempDir::new().unwrap();
        assert!(collect(Some(&temporary.path().join("missing")), None).is_err());
        assert!(collect(None, Some(&temporary.path().join("missing.db"))).is_err());
        assert!(!temporary.path().join("missing.db").exists());
        write(&temporary.path().join("memory/okay.md"), "# Fine");
        assert!(
            collect(
                Some(temporary.path()),
                Some(&temporary.path().join("missing.db"))
            )
            .is_err()
        );
        fs::write(temporary.path().join("memory/invalid.md"), [0xff, 0xfe]).unwrap();
        assert!(collect(Some(temporary.path()), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_fails_and_does_not_return_a_partial_scan() {
        use std::os::unix::fs::symlink;
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("claude");
        write(&root.join("memory/okay.md"), "# Fine");
        write(
            &temporary.path().join("outside.md"),
            "# Outside\nprivate data",
        );
        symlink(
            temporary.path().join("outside.md"),
            root.join("memory/escape.md"),
        )
        .unwrap();
        assert!(
            collect(Some(&root), None)
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
    }

    #[test]
    fn empty_root_is_a_complete_group_and_large_sources_fail() {
        let temporary = TempDir::new().unwrap();
        let batch = collect(Some(temporary.path()), None).unwrap();
        assert_eq!(batch.groups.len(), 1);
        assert!(batch.records.is_empty());
        fs::create_dir(temporary.path().join("memory")).unwrap();
        let file = File::create(temporary.path().join("memory/large.md")).unwrap();
        file.set_len(MAX_CONTENT_BYTES as u64 + 1).unwrap();
        assert!(collect(Some(temporary.path()), None).is_err());
    }

    #[test]
    fn summary_only_database_keeps_compression_and_session_provenance() {
        let temporary = TempDir::new().unwrap();
        let path = temporary.path().join("cavemem.db");
        let connection = database(&path);
        connection
            .execute(
                "INSERT INTO sessions VALUES ('session-1','claude',NULL,10,20,?1)",
                [concat!(r#"{"retained":"日本語","api_key":"abc12"#, r#"3456789"}"#)],
            )
            .unwrap();
        let content = "schema fixed ✓ <private>hidden</private>\ncompressed history";
        connection
            .execute(
                "INSERT INTO summaries VALUES (71,'session-1','turn',?1,1,'full',15)",
                [content],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        let batch = collect(None, Some(&path)).unwrap();
        let repeated = collect(None, Some(&path)).unwrap();
        assert_eq!(batch.records.len(), 2);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            serde_json::to_value(&batch.records).unwrap(),
            serde_json::to_value(&repeated.records).unwrap()
        );
        let summary = batch
            .records
            .iter()
            .find(|record| record.kind == "summary")
            .unwrap();
        assert_eq!(summary.project, "*");
        assert_eq!(summary.metadata["source_id"], 71);
        assert_eq!(summary.metadata["compressed"], 1);
        assert_eq!(summary.metadata["intensity"], "full");
        let session = referenced_session(&batch, summary);
        assert_eq!(session.metadata["session"]["ended_at"], 20);
        assert_eq!(
            session.metadata["session"]["metadata"]["retained"],
            "日本語"
        );
        assert_eq!(session.metadata["session"]["id"], "session-1");
        assert_eq!(session.metadata["session"]["ide"], "claude");
        assert_eq!(session.metadata["session"]["started_at"], 10);
        assert_eq!(session.metadata["session"]["cwd"], Value::Null);
        assert_eq!(
            session.metadata["session"]["metadata"]["api_key"],
            "[REDACTED]"
        );
        assert!(
            !serde_json::to_string(&batch.records)
                .unwrap()
                .contains("abc123456789")
        );
        assert!(!summary.content.contains("hidden"));
        assert!(summary.content.ends_with("compressed history"));
        let index = temporary.path().join("iron.db");
        let mut store = Store::open(&index, true).unwrap();
        store.apply(&batch).unwrap();
        let stored_summary = store.get(&summary.id).unwrap().unwrap();
        let stored_session = store
            .get(
                stored_summary.metadata["session_record_id"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(stored_session.metadata, session.metadata);
    }

    #[test]
    fn observations_keep_ids_and_metadata_and_infer_absent_cwd() {
        let temporary = TempDir::new().unwrap();
        let path = temporary.path().join("cavemem.db");
        let connection = database(&path);
        let cwd = temporary
            .path()
            .join("missing-project")
            .to_str()
            .unwrap()
            .to_owned();
        connection
            .execute(
                "INSERT INTO sessions VALUES ('s','claude',?1,10,NULL,NULL)",
                [&cwd],
            )
            .unwrap();
        connection.execute("INSERT INTO observations VALUES (17,'s','tool','Original Unicode café',0,NULL,11,'{\"tool\":\"read\"}')", []).unwrap();
        drop(connection);
        let batch = collect(None, Some(&path)).unwrap();
        let observation = batch
            .records
            .iter()
            .find(|record| record.kind == "observation")
            .unwrap();
        assert_eq!(
            observation.project,
            scope_for_path(Path::new(&cwd)).unwrap()
        );
        assert_eq!(
            referenced_session(&batch, observation).metadata["session"]["project_basis"],
            "missing_cwd_lexical_path"
        );
        assert_eq!(observation.metadata["source_id"], 17);
        assert_eq!(observation.metadata["source_kind"], "tool");
        assert_eq!(observation.metadata["compressed"], 0);
        assert_eq!(observation.metadata["metadata"]["tool"], "read");
        assert_eq!(observation.content, "Original Unicode café");
    }

    #[test]
    fn malformed_database_does_not_silently_import_partial_tables() {
        let temporary = TempDir::new().unwrap();
        let path = temporary.path().join("cavemem.db");
        let connection = database(&path);
        connection.execute_batch("DROP TABLE observations; INSERT INTO sessions VALUES ('s','claude',NULL,1,NULL,NULL);").unwrap();
        drop(connection);
        assert!(collect(None, Some(&path)).is_err());
    }

    #[test]
    fn metadata_decodes_private_markers_and_scrubs_numeric_credentials() {
        let metadata = source_metadata(Some(r#"{"nested":{"password":123456789,"token":"a1b2c3d4e5","token_count":123456789},"note":"\u003cprivate\u003ehidden\u003c/private\u003e keep","quoted_password":"abc12\"345678","ordinary":"日本語"}"#.into()));
        assert_eq!(metadata["nested"]["password"], "[REDACTED]");
        assert_eq!(metadata["nested"]["token"], "[REDACTED]");
        assert_eq!(metadata["nested"]["token_count"], 123456789);
        assert_eq!(metadata["note"], "[PRIVATE REDACTED] keep");
        assert_eq!(metadata["quoted_password"], "[REDACTED]");
        assert_eq!(metadata["ordinary"], "日本語");
    }

    #[test]
    fn credential_metadata_preserves_field_context_through_containers() {
        let metadata = source_metadata(Some(r#"{"password":"correcthorsebatterystaple","api_key":"ABCDEFGHIJKLMNOPQRSTUVWX","token":["abc1234567890xyz",{"value":"alphabeticsecret","nested":[1234,"tiny"]}],"ordinary":["correcthorsebatterystaple",{"note":"ABCDEFGHIJKLMNOPQRSTUVWX"}]}"#.into()));
        assert_eq!(metadata["password"], "[REDACTED]");
        assert_eq!(metadata["api_key"], "[REDACTED]");
        assert_eq!(metadata["token"][0], "[REDACTED]");
        assert_eq!(metadata["token"][1]["value"], "[REDACTED]");
        assert_eq!(
            metadata["token"][1]["nested"],
            json!(["[REDACTED]", "[REDACTED]"])
        );
        assert_eq!(metadata["ordinary"][0], "correcthorsebatterystaple");
        assert_eq!(metadata["ordinary"][1]["note"], "ABCDEFGHIJKLMNOPQRSTUVWX");
    }

    #[test]
    fn private_source_locators_keep_distinct_stable_identities() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("sk-1234567890abcdef1234");
        write(&root.join("memory/sk-abcdefghijklmnop1234.md"), "# First");
        write(&root.join("memory/sk-abcdefghijklmnop5678.md"), "# Second");
        let batch = collect(Some(&root), None).unwrap();
        let serialized = serde_json::to_string(&batch.records).unwrap();
        assert!(!serialized.contains("1234567890abcdef1234"));
        assert!(!serialized.contains("abcdefghijklmnop1234"));
        assert_eq!(batch.records.len(), 2);
        assert_ne!(batch.records[0].source_key, batch.records[1].source_key);
        assert_ne!(batch.records[0].id, batch.records[1].id);
        assert_eq!(batch.groups, collect(Some(&root), None).unwrap().groups);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_markdown_fails_under_effective_user_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = TempDir::new().unwrap();
        let path = temporary.path().join("memory/blocked.md");
        write(&path, "# Must not silently skip");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(
            File::open(&path).is_err(),
            "Unreadable-source fixture requires an effective user without file-read override; skip this fixture explicitly for privileged test runners"
        );
        let result = collect(Some(temporary.path()), None);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn worktrees_resolve_to_the_common_repository_identity() {
        let temporary = TempDir::new().unwrap();
        let repository = temporary.path().join("human-project");
        let worktree = temporary.path().join("temporary-feature-name");
        fs::create_dir_all(repository.join(".git/worktrees/feature")).unwrap();
        fs::create_dir_all(worktree.join("src")).unwrap();
        write(
            &repository.join(".git/worktrees/feature/commondir"),
            "../..\n",
        );
        write(
            &worktree.join(".git"),
            &format!(
                "gitdir: {}\n",
                repository.join(".git/worktrees/feature").display()
            ),
        );
        let expected = project_for_repo(&repository).unwrap();
        assert!(expected.starts_with("path:human-project@"));
        assert_eq!(project_for_repo(&worktree.join("src")).unwrap(), expected);
    }

    #[test]
    fn repositories_with_equal_basenames_keep_separate_import_scopes() {
        let temporary = TempDir::new().unwrap();
        let first = temporary.path().join("org-a/shared-api");
        let second = temporary.path().join("org-b/shared-api");
        fs::create_dir_all(first.join(".git")).unwrap();
        fs::create_dir_all(second.join(".git")).unwrap();
        fs::create_dir(first.join("src")).unwrap();
        let first_key = project_for_repo(&first).unwrap();
        let second_key = project_for_repo(&second).unwrap();
        assert_ne!(first_key, second_key);
        assert_eq!(project_for_repo(&first.join("src")).unwrap(), first_key);
        let path = temporary.path().join("cavemem.db");
        let connection = database(&path);
        for (id, cwd) in [("first", &first), ("second", &second)] {
            connection
                .execute(
                    "INSERT INTO sessions VALUES (?1,'claude',?2,1,NULL,NULL)",
                    [id, cwd.to_str().unwrap()],
                )
                .unwrap();
        }
        connection.execute_batch("INSERT INTO summaries VALUES (1,'first','turn','First organization',1,'full',2); INSERT INTO summaries VALUES (2,'second','turn','Second organization',1,'full',2);").unwrap();
        drop(connection);
        let batch = collect(None, Some(&path)).unwrap();
        for (id, expected) in [(1, first_key), (2, second_key)] {
            let record = batch
                .records
                .iter()
                .find(|record| record.kind == "summary" && record.metadata["source_id"] == id)
                .unwrap();
            assert_eq!(record.project, expected);
            assert_eq!(
                referenced_session(&batch, record).metadata["session"]["project_basis"],
                "git_common_directory"
            );
        }
    }

    #[test]
    fn project_hierarchy_escaping_and_curated_names_are_unambiguous() {
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/commerce-core")).unwrap(),
            "commerce-core"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/studio/realtime-api")).unwrap(),
            "studio/realtime-api"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/studio-realtime-api")).unwrap(),
            "studio-realtime-api"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/studio%2Frealtime-api")).unwrap(),
            "studio%252Frealtime-api"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/Personal/iron-suite")).unwrap(),
            "iron-suite"
        );
        assert_eq!(
            project_name(Path::new("service.git")).unwrap(),
            "service.git"
        );
        assert_eq!(
            project_name(Path::new(".explicit-name")).unwrap(),
            ".explicit-name"
        );
        assert_eq!(
            scope_for_path(Path::new("/home/dev/.claude")).unwrap(),
            "dot-claude"
        );
        assert_eq!(
            scope_for_path(Path::new("/Users/example/.claude")).unwrap(),
            "dot-claude"
        );
        let long = Path::new("/home/dev/Projects")
            .join("component/".repeat(40))
            .join("leaf");
        let key = scope_for_path(&long).unwrap();
        assert!(key.starts_with("path:leaf@"));
        assert!(key.len() <= MAX_PROJECT_BYTES);
    }

    #[test]
    fn missing_historical_cwd_normalizes_without_losing_namespace() {
        let temporary = TempDir::new().unwrap();
        let first = temporary.path().join("org-a/shared-api");
        let equivalent = temporary.path().join("org-a/./unused/../shared-api");
        let second = temporary.path().join("org-b/shared-api");
        let mut cache = HashMap::new();
        let first = session_project(first.to_str(), &mut cache).unwrap();
        let equivalent = session_project(equivalent.to_str(), &mut cache).unwrap();
        let second = session_project(second.to_str(), &mut cache).unwrap();
        assert_eq!(first, equivalent);
        assert_ne!(first.0, second.0);
        assert_eq!(first.1, "missing_cwd_lexical_path");
        let relative = session_project(Some("org-a/shared-api"), &mut cache).unwrap();
        assert!(relative.0.starts_with("relative:shared-api@"));
        assert_eq!(relative.1, "relative_cwd_lexical_path");
        assert_ne!(relative.0, first.0);
        assert_eq!(
            scope_for_path(Path::new("/home/dev/Projects/org-a/../org-b/shared-api")).unwrap(),
            "org-b/shared-api"
        );
    }
}
