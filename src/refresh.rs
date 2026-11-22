use crate::{import, store::Store};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn lock(db: &Path) -> Result<File> {
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
    let parent = parent.canonicalize()?;
    let name = db
        .file_name()
        .context("index must be a file path")?
        .to_string_lossy();
    let path = parent.join(format!(".{name}.import.lock"));
    if db
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
        || path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
    {
        bail!("writable index and import lock must not be symbolic links");
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if started.elapsed() >= Duration::from_secs(10) {
                    bail!("another import is active; retry after it completes");
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub fn run(
    db: &Path,
    claude_root: Option<&Path>,
    cavemem_db: Option<&Path>,
    native_jsonl: Option<&Path>,
) -> Result<Value> {
    if claude_root.is_none() && cavemem_db.is_none() && native_jsonl.is_none() {
        bail!("supply --claude-root, --cavemem-db, and/or --native-jsonl; sources are read-only");
    }
    if let Some(source) = cavemem_db
        && db.exists()
        && source.canonicalize()? == db.canonicalize()?
    {
        bail!("source and index databases must differ");
    }
    let started = Instant::now();
    let mut result = if claude_root.is_some() || cavemem_db.is_some() {
        let _lock = lock(db)?;
        let batch = import::collect(claude_root, cavemem_db)?;
        let mut store = Store::open(db, true)?;
        serde_json::to_value(store.apply(&batch)?)?
    } else {
        json!({})
    };
    if let Some(jsonl_path) = native_jsonl {
        result["native_jsonl"] = crate::native::import_jsonl(db, jsonl_path)?;
    }
    result["elapsed_ms"] = json!(started.elapsed().as_millis());
    Ok(result)
}
