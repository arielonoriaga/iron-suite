use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};

use crate::model::ImportBatch;
use crate::privacy::redact;

pub type AliasMap = BTreeMap<String, String>;

const MAX_PROJECT_BYTES: usize = 256;
const MAX_ALIASES_BYTES: u64 = 256 * 1024;
const MAX_ALIAS_HOPS: usize = 8;

pub(crate) fn sibling_path(db: &Path, filename: &str) -> Option<PathBuf> {
    if db == Path::new(":memory:") {
        return None;
    }
    let parent = db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Some(parent.join(filename))
}

pub fn aliases_path(db: &Path) -> Option<PathBuf> {
    sibling_path(db, "aliases.json")
}

pub(crate) fn read_private_file(path: &Path, label: &str, max_bytes: u64) -> Result<String> {
    let pre = fs::symlink_metadata(path)
        .with_context(|| format!("cannot inspect {label} at {}", path.display()))?;
    ensure!(
        !pre.file_type().is_symlink() && pre.is_file(),
        "{label} must be a regular non-symlink file: {}",
        path.display()
    );
    ensure!(
        pre.len() <= max_bytes,
        "{label} exceeds {} KiB limit: {}",
        max_bytes / 1024,
        path.display()
    );
    let file = File::open(path)
        .with_context(|| format!("cannot open {label} {}", path.display()))?;
    let post = file
        .metadata()
        .with_context(|| format!("cannot stat opened {label} {}", path.display()))?;
    ensure!(
        post.file_type().is_file(),
        "{label} path changed to non-regular file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            pre.dev() == post.dev() && pre.ino() == post.ino(),
            "{label} file changed while opening: {}",
            path.display()
        );
    }
    let mut raw = String::new();
    file.take(max_bytes + 1)
        .read_to_string(&mut raw)
        .with_context(|| format!("cannot read {label} {}", path.display()))?;
    ensure!(
        raw.len() as u64 <= max_bytes,
        "{label} exceeds {} KiB limit: {}",
        max_bytes / 1024,
        path.display()
    );
    Ok(raw)
}

pub fn load(db: &Path) -> Result<AliasMap> {
    let Some(path) = aliases_path(db) else {
        return Ok(AliasMap::new());
    };
    let raw = match read_private_file(&path, "project aliases file", MAX_ALIASES_BYTES) {
        Ok(raw) => raw,
        Err(err)
            if err
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(AliasMap::new());
        }
        Err(err) => return Err(err),
    };
    let parsed: AliasMap = serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in project aliases {}", path.display()))?;
    let mut cleaned = AliasMap::new();
    for (k, v) in parsed {
        let from = validate_project_name("alias source", &k)?;
        let to = validate_project_name("alias target", &v)?;
        ensure!(from != to, "alias source and target must differ: `{from}`");
        cleaned.insert(from, to);
    }
    Ok(cleaned)
}

pub(crate) fn ensure_private_dir(dir: &Path) -> Result<()> {
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

pub fn save_atomic(db: &Path, aliases: &AliasMap) -> Result<()> {
    let Some(path) = aliases_path(db) else {
        bail!("project aliases require a durable index path");
    };
    if let Ok(meta) = fs::symlink_metadata(&path) {
        ensure!(
            !meta.file_type().is_symlink() && meta.is_file(),
            "refusing to write through non-regular aliases path: {}",
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
    let final_path = canon_parent.join("aliases.json");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let payload = serde_json::to_string_pretty(aliases)? + "\n";

    let mut tmp_path = None;
    let mut file = None;
    for attempt in 0..16u32 {
        let candidate = canon_parent.join(format!(
            ".aliases.{}.{}.{}.tmp",
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
                return Err(err)
                    .with_context(|| format!("cannot stage aliases file {}", candidate.display()));
            }
        }
    }
    let (tmp_path, mut file) = match (tmp_path, file) {
        (Some(p), Some(f)) => (p, f),
        _ => bail!("unable to allocate unique temporary aliases file"),
    };

    let write_result = (|| -> Result<()> {
        file.write_all(payload.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::symlink_metadata(&final_path) {
            ensure!(
                !meta.file_type().is_symlink() && meta.is_file(),
                "refusing to replace non-regular aliases path: {}",
                final_path.display()
            );
        }
        fs::rename(&tmp_path, &final_path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

pub fn validate_project_name(label: &str, value: &str) -> Result<String> {
    let trimmed = value.trim();
    ensure!(
        !trimmed.is_empty() && trimmed.len() <= MAX_PROJECT_BYTES,
        "{label} must contain between 1 and {MAX_PROJECT_BYTES} UTF-8 bytes"
    );
    ensure!(trimmed != "*", "{label} cannot be the global `*` scope");
    ensure!(
        !trimmed.bytes().any(|b| b.is_ascii_control()),
        "{label} must not contain control characters"
    );
    ensure!(
        redact(trimmed) == trimmed,
        "{label} must not contain redacted secrets or private markers"
    );
    Ok(trimmed.to_owned())
}

pub fn resolve(aliases: &AliasMap, project: &str) -> String {
    if aliases.is_empty() || project.is_empty() || project == "*" {
        return project.to_owned();
    }
    let mut current = project.to_owned();
    let mut seen = HashSet::new();
    for _ in 0..MAX_ALIAS_HOPS {
        if !seen.insert(current.clone()) {
            break;
        }
        if let Some(target) = aliases.get(&current) {
            current = target.clone();
            continue;
        }
        // Longest-prefix match for `<from>/*` or `<from>-worktrees/*` flattens to `<to>`,
        // matching `Store::merge_projects(..., include_subpaths = true)`.
        let mut best: Option<(usize, String)> = None;
        for (from, to) in aliases {
            let matches_prefix = current.starts_with(&format!("{from}/"))
                || current.starts_with(&format!("{from}-worktrees/"));
            if matches_prefix && best.as_ref().is_none_or(|(len, _)| from.len() > *len) {
                best = Some((from.len(), to.clone()));
            }
        }
        if let Some((_, next)) = best {
            current = next;
        } else {
            break;
        }
    }
    current
}

pub fn plan_alias(existing: &AliasMap, from: &str, to: &str) -> Result<(String, String, AliasMap)> {
    let from = validate_project_name("from project", from)?;
    let to = validate_project_name("to project", to)?;
    ensure!(from != to, "source and target project names must differ");

    let resolved_to = resolve(existing, &to);
    ensure!(
        resolved_to != from
            && !resolved_to.starts_with(&format!("{from}/"))
            && !resolved_to.starts_with(&format!("{from}-worktrees/")),
        "alias cycle detected: `{to}` already resolves to `{resolved_to}`"
    );

    let mut next = existing.clone();
    next.insert(from.clone(), resolved_to.clone());
    let snapshot = next.clone();
    for target in next.values_mut() {
        *target = resolve(&snapshot, target);
    }
    for (k, v) in &next {
        ensure!(k != v, "alias cycle detected involving `{k}`");
    }
    Ok((from, resolved_to, next))
}

pub fn set_alias(db: &Path, from: &str, to: &str) -> Result<AliasMap> {
    let existing = load(db)?;
    let (_, _, next) = plan_alias(&existing, from, to)?;
    save_atomic(db, &next)?;
    Ok(next)
}

pub fn remove_alias(db: &Path, from: &str) -> Result<AliasMap> {
    let from = from.trim();
    ensure!(!from.is_empty(), "alias key cannot be empty");
    let mut map = load(db)?;
    map.remove(from);
    save_atomic(db, &map)?;
    Ok(map)
}

pub fn apply_to_batch(aliases: &AliasMap, batch: &mut ImportBatch) {
    if aliases.is_empty() {
        return;
    }
    for record in &mut batch.records {
        record.project = resolve(aliases, &record.project);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn aliases_flatten_chains_resolve_subpaths_and_reject_cycles() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("memory.db");

        let map = set_alias(&db, "old-app", "mid-app").unwrap();
        assert_eq!(resolve(&map, "old-app"), "mid-app");
        assert_eq!(resolve(&map, "old-app/frontend"), "mid-app");
        assert_eq!(resolve(&map, "old-app-worktrees/feat-1"), "mid-app");

        // More-specific subpath alias takes precedence over root alias
        let map = set_alias(&db, "old-app/docs", "docs-hub").unwrap();
        assert_eq!(resolve(&map, "old-app/docs"), "docs-hub");
        assert_eq!(resolve(&map, "old-app/docs/guide"), "docs-hub");
        assert_eq!(resolve(&map, "old-app/frontend"), "mid-app");

        let map = set_alias(&db, "mid-app", "new-app").unwrap();
        assert_eq!(map.get("old-app").map(String::as_str), Some("new-app"));
        assert_eq!(map.get("mid-app").map(String::as_str), Some("new-app"));
        assert_eq!(resolve(&map, "old-app/backend"), "new-app");

        // Direct and prefix cycles must be rejected
        assert!(set_alias(&db, "new-app", "old-app").is_err());
        assert!(set_alias(&db, "new-app", "old-app/sub").is_err());

        // Remove works cleanly
        let map = remove_alias(&db, "old-app").unwrap();
        assert_eq!(resolve(&map, "old-app"), "old-app");
        assert_eq!(resolve(&map, "mid-app"), "new-app");
    }

    #[cfg(unix)]
    #[test]
    fn aliases_file_enforces_private_mode_and_refuses_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("nested").join("memory.db");
        set_alias(&db, "alpha", "beta").unwrap();

        let alias_file = aliases_path(&db).unwrap();
        let mode = fs::metadata(&alias_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(alias_file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);

        // Symlink must be refused for both load and save
        let victim = tmp.path().join("victim.json");
        fs::write(&victim, "{}").unwrap();
        fs::remove_file(&alias_file).unwrap();
        symlink(&victim, &alias_file).unwrap();
        assert!(load(&db).is_err());
        assert!(set_alias(&db, "gamma", "delta").is_err());
    }
}
