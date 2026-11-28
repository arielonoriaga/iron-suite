use std::ffi::OsString;
use std::fs::{File, OpenOptions, Permissions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

const DEFAULT_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Ensure `iron-agentd` is listening on `socket_path`.
///
/// If an euid-owned Unix socket is already accepting connections, returns immediately.
/// Otherwise acquires an exclusive `flock` inside the `0700` euid-owned socket directory,
/// re-checks the socket, spawns `iron-agentd` detached in the background (checking next to the
/// current executable first, then falling back to `PATH`), waits boundedly (failing fast if the
/// child exits early), and hands the live child handle to a background reaper thread so no
/// `<defunct>` zombie can accumulate.
pub fn ensure_daemon_running(socket_path: &Path) -> Result<()> {
    let candidates = daemon_binary_candidates(std::env::current_exe().ok().as_deref());
    ensure_daemon_running_with(socket_path, &candidates, DEFAULT_BOOTSTRAP_TIMEOUT)
}

/// Ordered candidate paths for `iron-agentd`: sibling of current executable first, then `PATH`.
pub fn daemon_binary_candidates(current_exe: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe) = current_exe
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("iron-agentd");
        if sibling.is_file() {
            candidates.push(sibling);
        }
    }
    candidates.push(PathBuf::from("iron-agentd"));
    candidates
}

pub fn ensure_daemon_running_with(
    socket_path: &Path,
    candidates: &[PathBuf],
    timeout: Duration,
) -> Result<()> {
    if probe_socket(socket_path).is_ok() {
        return Ok(());
    }

    let socket_dir = socket_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure_private_socket_dir(socket_dir)?;

    // Serialize concurrent `iron-term` launches trying to auto-start the same daemon.
    let _lock = acquire_bootstrap_lock(socket_dir)?;

    // Re-check after acquiring the lock in case a racing launch just finished bootstrapping.
    if probe_socket(socket_path).is_ok() {
        return Ok(());
    }

    let mut child = spawn_detached_daemon(socket_path, candidates)?;
    match wait_for_socket(socket_path, &mut child, timeout) {
        Ok(()) => {
            spawn_child_reaper(child);
            Ok(())
        }
        Err(err) => {
            // Reap if already exited, or hand to reaper so failed/slow startup never leaves zombies.
            if child.try_wait().ok().flatten().is_none() {
                spawn_child_reaper(child);
            }
            Err(err)
        }
    }
}

fn ensure_private_socket_dir(dir: &Path) -> Result<()> {
    if !dir.exists() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(dir)
            .with_context(|| format!("create private socket directory {}", dir.display()))?;
    }

    let meta = std::fs::symlink_metadata(dir)
        .with_context(|| format!("inspect socket directory {}", dir.display()))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
        bail!(
            "refusing unsafe socket directory {} (must be a non-symlink directory)",
            dir.display()
        );
    }

    // SAFETY: `geteuid()` is a read-only POSIX syscall.
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        bail!(
            "refusing socket directory {} owned by uid {} (expected euid {})",
            dir.display(),
            meta.uid(),
            euid
        );
    }

    std::fs::set_permissions(dir, Permissions::from_mode(0o700)).with_context(|| {
        format!(
            "enforce 0700 permissions on socket directory {}",
            dir.display()
        )
    })?;
    Ok(())
}

fn acquire_bootstrap_lock(socket_dir: &Path) -> Result<File> {
    let lock_path = socket_dir.join("bootstrap.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
        .with_context(|| format!("open bootstrap lock {}", lock_path.display()))?;

    let fd = file.as_raw_fd();
    loop {
        // SAFETY: `fd` is an open file descriptor owned by `file`.
        let rc = unsafe { libc::flock(fd, libc::LOCK_EX) };
        if rc == 0 {
            return Ok(file);
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(err).with_context(|| format!("flock {}", lock_path.display()));
    }
}

fn verify_owned_socket(socket_path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(socket_path)
        .with_context(|| format!("inspect socket {}", socket_path.display()))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_socket() {
        bail!(
            "refusing unsafe socket path {} (must be a non-symlink Unix socket)",
            socket_path.display()
        );
    }
    // SAFETY: `geteuid()` is a read-only POSIX syscall.
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        bail!(
            "refusing socket {} owned by uid {} (expected euid {})",
            socket_path.display(),
            meta.uid(),
            euid
        );
    }
    Ok(())
}

fn spawn_detached_daemon(socket_path: &Path, candidates: &[PathBuf]) -> Result<Child> {
    let mut last_err: Option<anyhow::Error> = None;
    let mut socket_flag = OsString::from("--socket=");
    socket_flag.push(socket_path.as_os_str());

    for bin in candidates {
        let mut cmd = Command::new(bin);
        cmd.arg(&socket_flag)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // Detach the daemon into its own session so closing iron-term never kills headless PTYs.
        // SAFETY: `setsid()` is async-signal-safe and called between fork and exec in the child.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(err) => {
                last_err = Some(anyhow::Error::new(err).context(format!(
                    "spawn detached iron-agentd using '{}'",
                    bin.display()
                )));
            }
        }
    }

    match last_err {
        Some(err) => Err(err),
        None => bail!("no iron-agentd binary candidates configured"),
    }
}

fn spawn_child_reaper(mut child: Child) {
    let _ = std::thread::Builder::new()
        .name("iron-agentd-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        });
}

fn wait_for_socket(socket_path: &Path, child: &mut Child, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if probe_socket(socket_path).is_ok() {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .context("poll detached iron-agentd startup status")?
        {
            // One final check in case the daemon bound the socket right before exiting/daemonizing.
            if probe_socket(socket_path).is_ok() {
                return Ok(());
            }
            bail!(
                "iron-agentd exited early ({status}) before binding {}",
                socket_path.display()
            );
        }
        let now = Instant::now();
        if now >= deadline {
            bail!(
                "timed out after {}ms waiting for iron-agentd socket at {}",
                timeout.as_millis(),
                socket_path.display()
            );
        }
        let sleep_for = POLL_INTERVAL.min(deadline.saturating_duration_since(now));
        std::thread::sleep(sleep_for);
    }
}

/// Verify non-symlink euid-owned Unix socket metadata before connecting.
pub fn probe_socket(socket_path: &Path) -> Result<()> {
    verify_owned_socket(socket_path)?;
    UnixStream::connect(socket_path)
        .with_context(|| format!("connect to iron-agentd at {}", socket_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;

    use super::*;

    #[test]
    fn prefers_sibling_daemon_binary_before_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_gui = tmp.path().join("iron-term");
        let fake_daemon = tmp.path().join("iron-agentd");
        std::fs::write(&fake_gui, b"").expect("write fake gui");
        std::fs::write(&fake_daemon, b"").expect("write fake daemon");

        let candidates = daemon_binary_candidates(Some(&fake_gui));
        assert_eq!(candidates[0], fake_daemon);
        assert_eq!(candidates[1], PathBuf::from("iron-agentd"));
    }

    #[test]
    fn connects_immediately_when_socket_already_listening() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("agentd.sock");
        let _listener = UnixListener::bind(&sock).expect("bind unix socket");

        // Even with nonexistent candidates, an existing live socket succeeds without spawning.
        let candidates = vec![PathBuf::from("/nonexistent/iron-agentd")];
        ensure_daemon_running_with(&sock, &candidates, Duration::from_millis(200))
            .expect("existing socket should connect immediately");
        probe_socket(&sock).expect("probe should succeed");
    }

    #[test]
    fn fails_fast_when_spawned_daemon_exits_early_without_binding() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("early-exit.sock");
        let candidates = vec![PathBuf::from("/bin/true")];

        let started = Instant::now();
        let err = ensure_daemon_running_with(&sock, &candidates, Duration::from_secs(3))
            .expect_err("early exit should fail fast");
        assert!(
            err.to_string().contains("exited early"),
            "unexpected error: {err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "should fail fast instead of waiting full timeout, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn times_out_boundedly_when_spawned_process_never_binds_socket() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("never-appears.sock");
        let sleeper = tmp.path().join("slow-daemon.sh");
        std::fs::write(&sleeper, "#!/bin/sh\nsleep 0.4\n").expect("write helper");
        std::fs::set_permissions(&sleeper, Permissions::from_mode(0o700)).expect("chmod");

        let candidates = vec![sleeper];
        let started = Instant::now();
        let err = ensure_daemon_running_with(&sock, &candidates, Duration::from_millis(120))
            .expect_err("should fail when socket is never created");
        assert!(
            err.to_string().contains("timed out"),
            "unexpected error: {err}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn rejects_symlink_socket_and_symlink_socket_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let real_dir = tmp.path().join("real");
        std::fs::create_dir(&real_dir).expect("mkdir");
        let real_sock = real_dir.join("agentd.sock");
        let _listener = UnixListener::bind(&real_sock).expect("bind real sock");

        let sym_sock = tmp.path().join("sym.sock");
        symlink(&real_sock, &sym_sock).expect("symlink sock");
        let err = probe_socket(&sym_sock).expect_err("symlink socket must be rejected");
        assert!(err.to_string().contains("non-symlink Unix socket"));

        let sym_dir = tmp.path().join("sym-dir");
        symlink(&real_dir, &sym_dir).expect("symlink dir");
        let sym_dir_sock = sym_dir.join("new.sock");
        let err = ensure_daemon_running_with(
            &sym_dir_sock,
            &[PathBuf::from("/bin/true")],
            Duration::from_millis(100),
        )
        .expect_err("symlink socket directory must be rejected");
        assert!(err.to_string().contains("non-symlink directory"));
    }

    #[test]
    fn reports_clear_error_when_no_binary_is_found() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("missing.sock");
        let candidates = vec![PathBuf::from("/definitely-missing/iron-agentd")];

        let err = ensure_daemon_running_with(&sock, &candidates, Duration::from_millis(100))
            .expect_err("missing binary must error");
        assert!(
            err.to_string().contains("spawn detached iron-agentd"),
            "unexpected error: {err}"
        );
    }
}
