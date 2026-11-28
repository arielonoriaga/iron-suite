use std::{
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::frame::{read_frame_sync, write_frame_sync};

pub const DEFAULT_SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(15);
pub const LONG_SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(35);
pub const HEAP_SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(50);
pub const HEALTH_SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtlRpcResponse {
    pub id: Value,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<CtlRpcError>,
}

/// Resolves the IronBrowser control socket path with exact parity to `app/src/main/ctl-socket.ts`:
/// 1. `IRON_BROWSER_SOCKET` override (if non-empty)
/// 2. `$XDG_RUNTIME_DIR/iron-browser/ctl.sock` (if non-empty)
/// 3. `<temp_dir>/iron-browser-<euid>/ctl.sock`
pub fn default_socket_path() -> PathBuf {
    if let Ok(explicit) = env::var("IRON_BROWSER_SOCKET")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit.trim());
    }
    if let Ok(runtime_dir) = env::var("XDG_RUNTIME_DIR")
        && !runtime_dir.trim().is_empty()
    {
        return PathBuf::from(runtime_dir)
            .join("iron-browser")
            .join("ctl.sock");
    }
    let uid = unsafe { libc::geteuid() };
    env::temp_dir()
        .join(format!("iron-browser-{uid}"))
        .join("ctl.sock")
}

pub fn default_log_path() -> PathBuf {
    if let Ok(explicit) = env::var("IRON_BROWSER_LOG_DIR")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit.trim()).join("main.log");
    }
    if let Ok(user_data) = env::var("IRON_BROWSER_USER_DATA")
        && !user_data.trim().is_empty()
    {
        return PathBuf::from(user_data.trim())
            .join("logs")
            .join("main.log");
    }
    if let Ok(xdg_state) = env::var("XDG_STATE_HOME")
        && !xdg_state.trim().is_empty()
    {
        return PathBuf::from(xdg_state.trim())
            .join("iron-browser")
            .join("main.log");
    }
    let home = env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("iron-browser")
        .join("main.log")
}

pub fn default_crash_dumps_dir() -> PathBuf {
    if let Ok(explicit) = env::var("IRON_BROWSER_CRASH_DIR")
        && !explicit.trim().is_empty()
    {
        return PathBuf::from(explicit.trim());
    }
    if let Ok(user_data) = env::var("IRON_BROWSER_USER_DATA")
        && !user_data.trim().is_empty()
    {
        return PathBuf::from(user_data.trim()).join("Crashpad");
    }
    let cfg = env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
        let home = env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        format!("{home}/.config")
    });
    PathBuf::from(cfg)
        .join("iron-browser-app")
        .join("Crashpad")
}

pub fn tail_log_file(log_path: &Path, limit: usize) -> Vec<String> {
    let safe_limit = limit.clamp(1, 500);
    let Ok(meta) = fs::symlink_metadata(log_path) else {
        return Vec::new();
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() == 0 {
        return Vec::new();
    }
    let Ok(mut file) = File::open(log_path) else {
        return Vec::new();
    };
    let max_read = meta.len().min(256 * 1024);
    let offset = meta.len().saturating_sub(max_read);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::with_capacity(max_read as usize);
    if file.take(max_read).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(ToString::to_string)
        .collect();
    if offset > 0 && lines.len() > 1 {
        lines.remove(0);
    }
    if lines.len() > safe_limit {
        lines.drain(0..(lines.len() - safe_limit));
    }
    lines
}

pub fn scan_latest_crash_dump(crash_dir: &Path) -> Value {
    let Ok(root_meta) = fs::symlink_metadata(crash_dir) else {
        return Value::Null;
    };
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        return Value::Null;
    }

    let subdirs = [
        crash_dir.to_path_buf(),
        crash_dir.join("completed"),
        crash_dir.join("pending"),
        crash_dir.join("reports"),
    ];
    let mut latest: Option<(PathBuf, u64, u64)> = None;
    let mut total_dumps: u64 = 0;

    for dir in subdirs {
        let Ok(dir_meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".dmp")
                && !name.ends_with(".dmp.gz")
                && !name.ends_with(".minidump")
            {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() || !meta.is_file() {
                continue;
            }
            total_dumps += 1;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default())
                .as_millis() as u64;
            let replace = match &latest {
                None => true,
                Some((_, prev_ms, _)) => mtime_ms > *prev_ms,
            };
            if replace {
                latest = Some((path, mtime_ms, meta.len()));
            }
        }
    }

    match latest {
        None => Value::Null,
        Some((path, mtime_ms, size_bytes)) => json!({
            "path": path.display().to_string(),
            "mtimeMs": mtime_ms,
            "sizeBytes": size_bytes,
            "totalDumps": total_dumps,
        }),
    }
}

pub fn collect_offline_health(socket_path: &Path, socket_error: &str, lines: usize) -> Value {
    let log_path = default_log_path();
    let crash_dir = default_crash_dumps_dir();
    json!({
        "ok": false,
        "socketReachable": false,
        "socketPath": socket_path.display().to_string(),
        "socketError": socket_error,
        "logPath": log_path.display().to_string(),
        "crashDumpsDir": crash_dir.display().to_string(),
        "lastCrashDump": scan_latest_crash_dump(&crash_dir),
        "recentLogs": tail_log_file(&log_path, lines),
    })
}

pub struct SocketClient {
    socket_path: PathBuf,
    next_id: AtomicU64,
}

impl SocketClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            next_id: AtomicU64::new(1),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(method, params, DEFAULT_SOCKET_IO_TIMEOUT)
    }

    pub fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        let mut stream = UnixStream::connect(&self.socket_path).with_context(|| {
            format!(
                "cannot connect to IronBrowser control socket at {} (is IronBrowser running?)",
                self.socket_path.display()
            )
        })?;

        let write_rem = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .context("IronBrowser RPC timed out before write")?;
        stream
            .set_write_timeout(Some(write_rem))
            .context("set socket write timeout")?;

        let req_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = CtlRpcRequest {
            id: req_id,
            method: method.to_string(),
            params,
        };
        write_frame_sync(&mut stream, &req)?;

        let read_rem = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .context("IronBrowser RPC timed out before read")?;
        stream
            .set_read_timeout(Some(read_rem))
            .context("set socket read timeout")?;

        let resp: CtlRpcResponse = read_frame_sync(&mut stream)?;
        if resp.id != json!(req_id) {
            bail!(
                "IronBrowser RPC response id mismatch: expected {}, got {}",
                req_id,
                resp.id
            );
        }

        if resp.ok {
            Ok(resp.result.unwrap_or(Value::Null))
        } else {
            let err = resp.error.unwrap_or(CtlRpcError {
                code: -32000,
                message: "unknown IronBrowser RPC error".to_string(),
            });
            bail!("IronBrowser RPC error ({}): {}", err.code, err.message);
        }
    }

    pub fn query_health(&self, lines: usize) -> Value {
        let safe_lines = lines.clamp(1, 500);
        match self.call_with_timeout(
            "browser_health",
            json!({"lines": safe_lines}),
            HEALTH_SOCKET_IO_TIMEOUT,
        ) {
            Ok(val) => val,
            Err(err) => collect_offline_health(&self.socket_path, &format!("{err:#}"), safe_lines),
        }
    }
}
