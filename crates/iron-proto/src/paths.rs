use std::ffi::CStr;
use std::path::PathBuf;

/// Returns the effective user ID of the current process.
pub fn effective_uid() -> u32 {
    // SAFETY: `geteuid()` is a trivial read-only POSIX syscall with no memory invariants.
    unsafe { libc::geteuid() }
}

/// Resolves the `iron-agentd` Unix socket path from the current process environment.
///
/// Precedence:
/// 1. `$IRON_TERM_SOCKET` (trimmed, non-empty)
/// 2. `$XDG_RUNTIME_DIR/iron-term/agentd.sock` (trimmed, non-empty)
/// 3. `/tmp/iron-term-{uid}/agentd.sock`
pub fn resolve_socket_path() -> PathBuf {
    let sock = std::env::var("IRON_TERM_SOCKET").ok();
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    resolve_socket_path_from(sock.as_deref(), xdg.as_deref(), effective_uid())
}

/// Pure helper for [`resolve_socket_path`].
pub fn resolve_socket_path_from(
    iron_term_socket: Option<&str>,
    xdg_runtime_dir: Option<&str>,
    uid: u32,
) -> PathBuf {
    if let Some(explicit) = iron_term_socket.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(explicit);
    }
    if let Some(dir) = xdg_runtime_dir.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(dir).join("iron-term/agentd.sock");
    }
    PathBuf::from(format!("/tmp/iron-term-{uid}")).join("agentd.sock")
}

/// Resolves the `iron-term` persistent data directory from the current process environment.
///
/// Precedence:
/// 1. `$XDG_DATA_HOME/iron-term` (trimmed, non-empty)
/// 2. `$HOME/.local/share/iron-term` (trimmed, non-empty)
/// 3. `/tmp/iron-term-{uid}`
pub fn resolve_data_dir() -> PathBuf {
    let xdg = std::env::var("XDG_DATA_HOME").ok();
    let home = std::env::var("HOME").ok();
    resolve_data_dir_from(xdg.as_deref(), home.as_deref(), effective_uid())
}

/// Pure helper for [`resolve_data_dir`].
pub fn resolve_data_dir_from(
    xdg_data_home: Option<&str>,
    home: Option<&str>,
    uid: u32,
) -> PathBuf {
    if let Some(dir) = xdg_data_home.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(dir).join("iron-term");
    }
    if let Some(home_dir) = home.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(home_dir).join(".local/share/iron-term");
    }
    PathBuf::from(format!("/tmp/iron-term-{uid}"))
}

/// Resolves the `iron-term` configuration directory from the current process environment.
///
/// Precedence:
/// 1. `$XDG_CONFIG_HOME/iron-term` (trimmed, non-empty)
/// 2. `$HOME/.config/iron-term` (trimmed, non-empty)
pub fn resolve_config_dir() -> Option<PathBuf> {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    resolve_config_dir_from(xdg.as_deref(), home.as_deref())
}

/// Pure helper for [`resolve_config_dir`].
pub fn resolve_config_dir_from(
    xdg_config_home: Option<&str>,
    home: Option<&str>,
) -> Option<PathBuf> {
    if let Some(dir) = xdg_config_home.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(dir).join("iron-term"));
    }
    if let Some(home_dir) = home.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(home_dir).join(".config/iron-term"));
    }
    None
}

fn sanitize_hostname(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "(none)" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_etc_hostname(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(valid) = sanitize_hostname(trimmed) {
            return Some(valid);
        }
    }
    None
}

fn system_gethostname() -> Option<String> {
    let mut buf = [0 as libc::c_char; 256];
    // SAFETY: `buf` is a valid writable buffer of `buf.len()` bytes for `libc::gethostname`.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr(), buf.len()) };
    if rc != 0 {
        return None;
    }
    buf[buf.len() - 1] = 0;
    // SAFETY: `buf` is guaranteed NUL-terminated within bounds.
    let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
    let text = cstr.to_str().ok()?;
    sanitize_hostname(text)
}

/// Resolves the local machine hostname without shelling out to external binaries.
///
/// Precedence:
/// 1. `libc::gethostname`
/// 2. `/proc/sys/kernel/hostname`
/// 3. `/etc/hostname` (first non-empty, non-`#` line)
/// 4. `$HOSTNAME`
/// 5. `"local"`
pub fn resolve_local_hostname() -> String {
    let gethost = system_gethostname();
    let proc_hostname = std::fs::read_to_string("/proc/sys/kernel/hostname").ok();
    let etc_hostname = std::fs::read_to_string("/etc/hostname").ok();
    let env_hostname = std::env::var("HOSTNAME").ok();
    resolve_local_hostname_from(
        gethost.as_deref(),
        proc_hostname.as_deref(),
        etc_hostname.as_deref(),
        env_hostname.as_deref(),
    )
}

/// Pure helper for [`resolve_local_hostname`].
pub fn resolve_local_hostname_from(
    gethostname_val: Option<&str>,
    proc_hostname: Option<&str>,
    etc_hostname: Option<&str>,
    env_hostname: Option<&str>,
) -> String {
    gethostname_val
        .and_then(sanitize_hostname)
        .or_else(|| proc_hostname.and_then(sanitize_hostname))
        .or_else(|| etc_hostname.and_then(parse_etc_hostname))
        .or_else(|| env_hostname.and_then(sanitize_hostname))
        .unwrap_or_else(|| "local".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_respects_precedence_and_trims_empty_values() {
        assert_eq!(
            resolve_socket_path_from(
                Some("  /custom/iron.sock  "),
                Some("/run/user/1000"),
                1000
            ),
            PathBuf::from("/custom/iron.sock")
        );
        assert_eq!(
            resolve_socket_path_from(Some("   "), Some(" /run/user/1000 "), 1000),
            PathBuf::from("/run/user/1000/iron-term/agentd.sock")
        );
        assert_eq!(
            resolve_socket_path_from(None, Some(""), 4242),
            PathBuf::from("/tmp/iron-term-4242/agentd.sock")
        );
        assert_eq!(
            resolve_socket_path_from(None, None, 1001),
            PathBuf::from("/tmp/iron-term-1001/agentd.sock")
        );
    }

    #[test]
    fn data_and_config_dirs_respect_xdg_and_uid_fallbacks() {
        assert_eq!(
            resolve_data_dir_from(Some("/var/lib/xdg"), Some("/home/alice"), 1000),
            PathBuf::from("/var/lib/xdg/iron-term")
        );
        assert_eq!(
            resolve_data_dir_from(Some("  "), Some("/home/alice"), 1000),
            PathBuf::from("/home/alice/.local/share/iron-term")
        );
        assert_eq!(
            resolve_data_dir_from(None, Some(""), 2000),
            PathBuf::from("/tmp/iron-term-2000")
        );

        assert_eq!(
            resolve_config_dir_from(Some("/etc/xdg-custom"), Some("/home/alice")),
            Some(PathBuf::from("/etc/xdg-custom/iron-term"))
        );
        assert_eq!(
            resolve_config_dir_from(Some(""), Some("/home/alice")),
            Some(PathBuf::from("/home/alice/.config/iron-term"))
        );
        assert_eq!(resolve_config_dir_from(None, Some("  ")), None);
    }

    #[test]
    fn hostname_resolution_follows_precedence_and_rejects_none_sentinel() {
        assert_eq!(
            resolve_local_hostname_from(
                Some("workstation\n"),
                Some("proc-host"),
                Some("etc-host"),
                Some("env-host"),
            ),
            "workstation"
        );
        assert_eq!(
            resolve_local_hostname_from(
                Some("(none)"),
                Some("fedora-box\n"),
                Some("etc-host"),
                Some("env-host"),
            ),
            "fedora-box"
        );
        assert_eq!(
            resolve_local_hostname_from(
                None,
                Some("  (none)  "),
                Some("# comment\n\n  arch-dev  \n"),
                Some("env-host"),
            ),
            "arch-dev"
        );
        assert_eq!(
            resolve_local_hostname_from(None, None, Some("# only comments\n(none)"), Some("env-box")),
            "env-box"
        );
        assert_eq!(
            resolve_local_hostname_from(Some(""), Some("(none)"), None, Some("  ")),
            "local"
        );
    }
}
