use std::fs::{self, File, Metadata, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::store::Store;

const PAGES_PER_STEP: i32 = 256;
const BACKUP_TIMEOUT: Duration = Duration::from_secs(30);
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(100);
const RETRY_PAUSE: Duration = Duration::from_millis(25);
const STAGING_ATTEMPTS: usize = 32;
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct StagingFile {
    directory: PathBuf,
    database: PathBuf,
    directory_identity: Metadata,
    file: File,
}

pub fn run(db: &Path, output: &Path) -> Result<Value> {
    let deadline = Instant::now() + BACKUP_TIMEOUT;
    ensure_absent(output)?;
    let source = open_snapshot(db)?;
    let output = prepare_output_path(output)?;
    ensure_absent(&output)?;
    let staging = create_staging(output.parent().context("backup output has no parent")?)?;
    let result = finish_backup(&source, &staging, &output, deadline);
    match result {
        Ok(bytes) => {
            let mut report = json!({"path": output.to_string_lossy(), "bytes": bytes});
            if !cleanup_staging(&staging) {
                report["retained_staging"] = json!(staging.directory.to_string_lossy());
            }
            Ok(report)
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "backup failed; incomplete staging retained at {}",
                staging.directory.display()
            )
        }),
    }
}

fn ensure_absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => bail!("backup output already exists: {}", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("cannot inspect backup output {}", path.display()))
        }
    }
}

fn open_snapshot(db: &Path) -> Result<Connection> {
    Store::open(db, false).context("backup source is not a readable Iron Memory index")?;
    let source = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("cannot open backup source read-only")?;
    source.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    source.pragma_update(None, "query_only", true)?;
    source.execute_batch("BEGIN DEFERRED")?;
    let _: i64 = source.query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| row.get(0))?;
    Ok(source)
}

fn private_directory_builder() -> fs::DirBuilder {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
}

fn prepare_output_path(output: &Path) -> Result<PathBuf> {
    let filename = output
        .file_name()
        .context("backup output needs a filename")?;
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    private_directory_builder()
        .recursive(true)
        .create(parent)
        .with_context(|| format!("cannot create backup directory {}", parent.display()))?;
    Ok(fs::canonicalize(parent)?.join(filename))
}

fn create_staging(parent: &Path) -> Result<StagingFile> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system time precedes the Unix epoch")?
        .as_nanos();
    for _ in 0..STAGING_ATTEMPTS {
        let sequence = STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = parent.join(format!(
            ".iron-backup-{}-{timestamp}-{sequence}.partial",
            std::process::id()
        ));
        match private_directory_builder().create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("cannot create private backup staging"),
        }
        let database = directory.join("snapshot.db");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&database).with_context(|| {
            format!(
                "cannot create backup file; incomplete staging retained at {}",
                directory.display()
            )
        })?;
        let directory_identity = fs::symlink_metadata(&directory)?;
        return Ok(StagingFile {
            directory,
            database,
            directory_identity,
            file,
        });
    }
    bail!("cannot reserve a unique backup staging directory")
}

fn finish_backup(
    source: &Connection,
    staging: &StagingFile,
    output: &Path,
    deadline: Instant,
) -> Result<u64> {
    let mut destination = Connection::open_with_flags(
        &staging.database,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    destination.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    copy_snapshot(source, &mut destination, deadline)?;
    let journal_mode: String =
        destination.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
    ensure!(
        journal_mode == "delete",
        "backup is not a standalone database"
    );
    destination.close().map_err(|(_, error)| error)?;
    Store::open(&staging.database, false).context("completed backup failed schema validation")?;
    ensure!(Instant::now() < deadline, "backup exceeded its time limit");
    staging.file.sync_all()?;
    let bytes = staging.file.metadata()?.len();
    ensure!(bytes > 0, "completed backup is empty");
    publish(staging, output)?;
    Ok(bytes)
}

fn copy_snapshot(
    source: &Connection,
    destination: &mut Connection,
    deadline: Instant,
) -> Result<()> {
    let backup = Backup::new(source, destination)?;
    loop {
        ensure!(Instant::now() < deadline, "backup exceeded its time limit");
        match backup.step(PAGES_PER_STEP)? {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => thread::sleep(RETRY_PAUSE),
            _ => bail!("SQLite returned an unsupported backup state"),
        }
    }
}

fn publish(staging: &StagingFile, output: &Path) -> Result<()> {
    ensure!(
        has_created_identity(&staging.directory, &staging.directory_identity)
            && has_created_identity(&staging.database, &staging.file.metadata()?),
        "backup staging was replaced before publication"
    );
    fs::hard_link(&staging.database, output).with_context(|| {
        format!(
            "cannot publish backup without replacing an existing path: {}",
            output.display()
        )
    })?;
    #[cfg(unix)]
    File::open(output.parent().context("backup output has no parent")?)?
        .sync_all()
        .with_context(|| {
            format!(
                "backup exists at {} but directory synchronization failed",
                output.display()
            )
        })?;
    Ok(())
}

fn has_created_identity(path: &Path, expected: &Metadata) -> bool {
    let Ok(actual) = fs::symlink_metadata(path) else {
        return false;
    };
    if actual.file_type().is_symlink() || actual.file_type() != expected.file_type() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        actual.dev() == expected.dev() && actual.ino() == expected.ino()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn cleanup_staging(staging: &StagingFile) -> bool {
    let Ok(identity) = staging.file.metadata() else {
        return false;
    };
    if !has_created_identity(&staging.directory, &staging.directory_identity)
        || !has_created_identity(&staging.database, &identity)
    {
        return false;
    }
    fs::remove_file(&staging.database).is_ok() && fs::remove_dir(&staging.directory).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SearchOptions;
    use crate::native::{RememberRequest, remember};
    use tempfile::TempDir;

    fn remember_note(db: &Path, content: &str) -> String {
        remember(
            db,
            RememberRequest {
                title: "Shared evidence".into(),
                content: content.into(),
                project: "iron-suite".into(),
                kind: Some("decision".into()),
                agent: Some("backup-test".into()),
            },
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn active_wal_backup_restores_native_memory_and_searchable_provenance() {
        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        let keeper = Store::open(&db, true).unwrap();
        let wal_reader = Connection::open_with_flags(
            &db,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        wal_reader.execute_batch("BEGIN DEFERRED").unwrap();
        let before_write: i64 = wal_reader
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before_write, 0);
        let id = remember_note(&db, "WALonlytoken shared native memory");
        let original = keeper.get(&id).unwrap().unwrap();
        assert!(
            fs::metadata(directory.path().join("memory.db-wal"))
                .unwrap()
                .len()
                > 0
        );
        let source_bytes = fs::read(&db).unwrap();
        let wal_bytes = fs::read(directory.path().join("memory.db-wal")).unwrap();
        let main_file_only = directory.path().join("main-file-only.db");
        fs::write(&main_file_only, &source_bytes).unwrap();
        assert!(
            Store::open(&main_file_only, false)
                .unwrap()
                .get(&id)
                .unwrap()
                .is_none()
        );
        let output = directory.path().join("backups").join("snapshot.db");
        let report = run(&db, &output).unwrap();
        assert_eq!(report["bytes"], fs::metadata(&output).unwrap().len());
        assert_eq!(report["path"], output.to_string_lossy().as_ref());
        let restored = Store::open(&output, false).unwrap();
        let recovered = restored.get(&id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(recovered).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let hits = restored
            .search(
                "WALonlytoken",
                &SearchOptions {
                    project: Some("iron-suite".into()),
                    limit: 5,
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, id);
        assert_eq!(hits[0].source_type, "iron");
        assert!(!output.with_file_name("snapshot.db-wal").exists());
        assert_eq!(fs::read(&db).unwrap(), source_bytes);
        assert_eq!(
            fs::read(directory.path().join("memory.db-wal")).unwrap(),
            wal_bytes
        );
        let pinned_count: i64 = wal_reader
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pinned_count, before_write);
        #[cfg(unix)]
        assert!(!report.as_object().unwrap().contains_key("retained_staging"));
    }

    #[test]
    fn pinned_wal_snapshot_excludes_a_later_native_write() {
        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        let keeper = Store::open(&db, true).unwrap();
        let first = remember_note(&db, "before snapshot");
        let source = open_snapshot(&db).unwrap();
        let second = remember_note(&db, "after snapshot");
        let staging = create_staging(directory.path()).unwrap();
        let output = directory.path().join("snapshot.db");
        finish_backup(&source, &staging, &output, Instant::now() + BACKUP_TIMEOUT).unwrap();
        let restored = Store::open(&output, false).unwrap();
        assert!(restored.get(&first).unwrap().is_some());
        assert!(restored.get(&second).unwrap().is_none());
        assert!(keeper.get(&second).unwrap().is_some());
        assert!(cleanup_staging(&staging));
    }

    #[test]
    fn repeated_output_and_source_collision_are_refused_without_mutation() {
        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        let id = remember_note(&db, "original source content");
        let source_bytes = fs::read(&db).unwrap();
        let output = directory.path().join("snapshot.db");
        run(&db, &output).unwrap();
        let output_bytes = fs::read(&output).unwrap();
        assert!(run(&db, &output).is_err());
        assert!(run(&db, &db).is_err());
        assert_eq!(fs::read(&output).unwrap(), output_bytes);
        assert_eq!(fs::read(&db).unwrap(), source_bytes);
        assert!(Store::open(&db, false).unwrap().get(&id).unwrap().is_some());
    }

    #[test]
    fn foreign_or_missing_sources_leave_no_output_or_parent_directories() {
        let directory = TempDir::new().unwrap();
        let foreign = directory.path().join("foreign.db");
        Connection::open(&foreign)
            .unwrap()
            .execute("CREATE TABLE foreign_data(value TEXT)", [])
            .unwrap();
        let before = fs::read(&foreign).unwrap();
        let output = directory.path().join("new-parent").join("snapshot.db");
        assert!(run(&foreign, &output).is_err());
        assert_eq!(fs::read(&foreign).unwrap(), before);
        assert!(!output.parent().unwrap().exists());
        assert!(run(&directory.path().join("missing.db"), &output).is_err());
        assert!(!output.parent().unwrap().exists());
    }

    #[test]
    fn deadline_failure_retains_marked_partial_without_publishing() {
        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        remember_note(&db, "deadline evidence");
        let source = open_snapshot(&db).unwrap();
        let staging = create_staging(directory.path()).unwrap();
        let output = directory.path().join("snapshot.db");
        let error = finish_backup(&source, &staging, &output, Instant::now()).unwrap_err();
        assert!(error.to_string().contains("time limit"));
        assert!(!output.exists());
        assert!(staging.directory.is_dir());
        assert!(
            staging
                .directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(".partial")
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_symlinks_hardlinks_and_late_collisions_are_never_overwritten() {
        use std::os::unix::fs::symlink;

        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        remember_note(&db, "source evidence");
        let source_bytes = fs::read(&db).unwrap();
        let alias = directory.path().join("alias.db");
        symlink(&db, &alias).unwrap();
        assert!(run(&db, &alias).is_err());
        let hardlink = directory.path().join("hardlink.db");
        fs::hard_link(&db, &hardlink).unwrap();
        assert!(run(&db, &hardlink).is_err());
        let absent = directory.path().join("absent.db");
        let dangling = directory.path().join("dangling.db");
        symlink(&absent, &dangling).unwrap();
        assert!(run(&db, &dangling).is_err());
        assert!(!absent.exists());
        let staging = create_staging(directory.path()).unwrap();
        let raced_output = directory.path().join("raced.db");
        fs::write(&raced_output, b"other writer owns this").unwrap();
        assert!(publish(&staging, &raced_output).is_err());
        assert_eq!(fs::read(&raced_output).unwrap(), b"other writer owns this");
        assert_eq!(fs::read(&db).unwrap(), source_bytes);
        assert!(cleanup_staging(&staging));
    }

    #[cfg(unix)]
    #[test]
    fn backup_outputs_are_private_without_changing_existing_parent_modes() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = TempDir::new().unwrap();
        let db = directory.path().join("memory.db");
        remember_note(&db, "permission evidence");
        let shared = directory.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o750)).unwrap();
        let output = shared.join("private").join("nested").join("snapshot.db");
        run(&db, &output).unwrap();
        assert_eq!(fs::metadata(&shared).unwrap().mode() & 0o777, 0o750);
        for path in [
            shared.join("private"),
            shared.join("private/nested"),
            output.clone(),
        ] {
            assert_eq!(fs::metadata(path).unwrap().mode() & 0o077, 0);
        }
        assert_eq!(fs::metadata(&output).unwrap().nlink(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn replaced_staging_is_neither_published_nor_deleted() {
        let directory = TempDir::new().unwrap();
        let staging = create_staging(directory.path()).unwrap();
        fs::rename(&staging.database, staging.directory.join("original.db")).unwrap();
        fs::write(&staging.database, b"replacement belongs to another writer").unwrap();
        assert!(publish(&staging, &directory.path().join("snapshot.db")).is_err());
        assert!(!cleanup_staging(&staging));
        assert_eq!(
            fs::read(&staging.database).unwrap(),
            b"replacement belongs to another writer"
        );
    }
}
