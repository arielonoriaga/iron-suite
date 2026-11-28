use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

pub const MAX_ACTIVE_PTYS: usize = 8;
pub const MAX_PTY_BUFFER_BYTES: usize = 1024 * 1024;
pub const MAX_PTY_WRITE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnInput {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyPollResult {
    pub ok: bool,
    pub data_b64: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub dropped_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyWriteResult {
    pub ok: bool,
    pub bytes_written: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const B64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(B64_ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 6) & 63) as usize] as char);
        out.push(B64_ALPHABET[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(B64_ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(B64_ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    if !clean.len().is_multiple_of(4) {
        return Err("invalid base64 length".to_string());
    }
    let val = |b: u8| -> Result<u8, String> {
        match b {
            b'A'..=b'Z' => Ok(b - b'A'),
            b'a'..=b'z' => Ok(b - b'a' + 26),
            b'0'..=b'9' => Ok(b - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("invalid base64 byte".to_string()),
        }
    };
    let mut out = Vec::with_capacity((clean.len() / 4) * 3);
    let mut i = 0;
    while i < clean.len() {
        let a = val(clean[i])?;
        let b = val(clean[i + 1])?;
        let c = if clean[i + 2] == b'=' {
            if i + 4 != clean.len() || clean[i + 3] != b'=' {
                return Err("invalid base64 padding".to_string());
            }
            out.push((a << 2) | (b >> 4));
            break;
        } else {
            val(clean[i + 2])?
        };
        if clean[i + 3] == b'=' {
            if i + 4 != clean.len() {
                return Err("invalid base64 padding".to_string());
            }
            out.push((a << 2) | (b >> 4));
            out.push((b << 4) | (c >> 2));
            break;
        }
        let d = val(clean[i + 3])?;
        out.push((a << 2) | (b >> 4));
        out.push((b << 4) | (c >> 2));
        out.push((c << 6) | d);
        i += 4;
    }
    Ok(out)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        fs::File,
        io::Read,
        os::fd::{FromRawFd, RawFd},
        os::unix::process::{CommandExt, ExitStatusExt},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct SharedReadBuffer {
        buf: VecDeque<u8>,
        dropped_bytes: usize,
        eof: bool,
    }

    struct PtyEntry {
        master_fd: RawFd,
        pid: u32,
        child: Child,
        exited: bool,
        exited_at: Option<Instant>,
        exit_code: Option<i32>,
        shared: Arc<Mutex<SharedReadBuffer>>,
    }

    static PTY_REGISTRY: OnceLock<Mutex<(u32, HashMap<u32, PtyEntry>)>> = OnceLock::new();

    fn registry() -> &'static Mutex<(u32, HashMap<u32, PtyEntry>)> {
        PTY_REGISTRY.get_or_init(|| Mutex::new((1, HashMap::new())))
    }

    unsafe fn resolve_pts_path(master_fd: RawFd) -> Result<CString, String> {
        #[cfg(target_os = "linux")]
        {
            let mut buf = [0 as libc::c_char; 256];
            let rc = unsafe { libc::ptsname_r(master_fd, buf.as_mut_ptr(), buf.len()) };
            if rc != 0 {
                return Err(format!("ptsname_r failed: {}", std::io::Error::last_os_error()));
            }
            let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
            Ok(cstr.to_owned())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let ptr = unsafe { libc::ptsname(master_fd) };
            if ptr.is_null() {
                return Err(format!("ptsname failed: {}", std::io::Error::last_os_error()));
            }
            let cstr = unsafe { CStr::from_ptr(ptr) };
            Ok(cstr.to_owned())
        }
    }

    pub fn pty_spawn(input: PtySpawnInput) -> PtySpawnResult {
        let program = input.program.trim();
        if program.is_empty() || program.len() > 512 {
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some("invalid PTY program".to_string()),
            };
        }
        if input.args.len() > 64 || input.env.len() > 128 {
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some("too many PTY arguments or env vars".to_string()),
            };
        }

        let cols = input.cols.unwrap_or(96).clamp(20, 400);
        let rows = input.rows.unwrap_or(28).clamp(8, 200);

        {
            let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            if guard.1.len() >= MAX_ACTIVE_PTYS {
                return PtySpawnResult {
                    ok: false,
                    id: None,
                    pid: None,
                    error: Some(format!("maximum active PTY sessions ({MAX_ACTIVE_PTYS}) reached")),
                };
            }
        }

        let master_fd = unsafe {
            libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC)
        };
        if master_fd < 0 {
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some(format!("posix_openpt failed: {}", std::io::Error::last_os_error())),
            };
        }

        if unsafe { libc::grantpt(master_fd) } != 0 || unsafe { libc::unlockpt(master_fd) } != 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                libc::close(master_fd);
            }
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some(format!("grantpt/unlockpt failed: {err}")),
            };
        }

        let pts_path = match unsafe { resolve_pts_path(master_fd) } {
            Ok(p) => p,
            Err(e) => {
                unsafe {
                    libc::close(master_fd);
                }
                return PtySpawnResult {
                    ok: false,
                    id: None,
                    pid: None,
                    error: Some(e),
                };
            }
        };

        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        unsafe {
            let _ = libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws);
        }

        let slave_fd = unsafe {
            libc::open(
                pts_path.as_ptr(),
                libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
            )
        };
        if slave_fd < 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                libc::close(master_fd);
            }
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some(format!("open slave pts failed: {err}")),
            };
        }

        let slave_out = unsafe { libc::dup(slave_fd) };
        let slave_err = unsafe { libc::dup(slave_fd) };
        let reader_fd = unsafe { libc::dup(master_fd) };
        if slave_out < 0 || slave_err < 0 || reader_fd < 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                if slave_out >= 0 {
                    libc::close(slave_out);
                }
                if slave_err >= 0 {
                    libc::close(slave_err);
                }
                if reader_fd >= 0 {
                    libc::close(reader_fd);
                }
                libc::close(slave_fd);
                libc::close(master_fd);
            }
            return PtySpawnResult {
                ok: false,
                id: None,
                pid: None,
                error: Some(format!("dup pts fd failed: {err}")),
            };
        }
        unsafe {
            let _ = libc::fcntl(reader_fd, libc::F_SETFD, libc::FD_CLOEXEC);
            let _ = libc::fcntl(master_fd, libc::F_SETFD, libc::FD_CLOEXEC);
            let fl = libc::fcntl(master_fd, libc::F_GETFL);
            if fl >= 0 {
                let _ = libc::fcntl(master_fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
            }
        }

        let mut cmd = Command::new(program);
        cmd.args(&input.args);
        if let Some(ref cwd) = input.cwd
            && !cwd.trim().is_empty()
        {
            cmd.current_dir(cwd.trim());
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &input.env {
            if !k.is_empty() && !k.contains('=') && !k.contains('\0') && !v.contains('\0') {
                cmd.env(k, v);
            }
        }

        unsafe {
            cmd.stdin(Stdio::from_raw_fd(slave_fd));
            cmd.stdout(Stdio::from_raw_fd(slave_out));
            cmd.stderr(Stdio::from_raw_fd(slave_err));
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let _ = libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                Ok(())
            });
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                unsafe {
                    libc::close(reader_fd);
                    libc::close(master_fd);
                }
                return PtySpawnResult {
                    ok: false,
                    id: None,
                    pid: None,
                    error: Some(format!("spawn '{program}' failed: {err}")),
                };
            }
        };

        let pid = child.id();
        let shared = Arc::new(Mutex::new(SharedReadBuffer {
            buf: VecDeque::with_capacity(16 * 1024),
            dropped_bytes: 0,
            eof: false,
        }));
        let shared_reader = Arc::clone(&shared);

        let _ = std::thread::Builder::new()
            .name(format!("iron-pty-{pid}"))
            .spawn(move || {
                let mut reader = unsafe { File::from_raw_fd(reader_fd) };
                let mut chunk = [0u8; 8192];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) => {
                            let mut st = shared_reader.lock().unwrap_or_else(|e| e.into_inner());
                            st.eof = true;
                            break;
                        }
                        Ok(n) => {
                            let mut st = shared_reader.lock().unwrap_or_else(|e| e.into_inner());
                            if st.buf.len() + n > MAX_PTY_BUFFER_BYTES {
                                let overflow = (st.buf.len() + n) - MAX_PTY_BUFFER_BYTES;
                                let drain = overflow.min(st.buf.len());
                                st.buf.drain(..drain);
                                st.dropped_bytes = st.dropped_bytes.saturating_add(drain);
                            }
                            st.buf.extend(&chunk[..n]);
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            let mut pfd = libc::pollfd {
                                fd: reader_fd,
                                events: libc::POLLIN,
                                revents: 0,
                            };
                            let rc = unsafe { libc::poll(&mut pfd, 1, -1) };
                            if rc < 0 {
                                let perr = std::io::Error::last_os_error();
                                if perr.kind() == std::io::ErrorKind::Interrupted {
                                    continue;
                                }
                                let mut st =
                                    shared_reader.lock().unwrap_or_else(|e| e.into_inner());
                                st.eof = true;
                                break;
                            }
                        }
                        Err(_) => {
                            let mut st = shared_reader.lock().unwrap_or_else(|e| e.into_inner());
                            st.eof = true;
                            break;
                        }
                    }
                }
            });

        let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
        let id = guard.0;
        guard.0 = guard.0.wrapping_add(1).max(1);
        guard.1.insert(
            id,
            PtyEntry {
                master_fd,
                pid,
                child,
                exited: false,
                exited_at: None,
                exit_code: None,
                shared,
            },
        );

        PtySpawnResult {
            ok: true,
            id: Some(id),
            pid: Some(pid),
            error: None,
        }
    }

    pub fn pty_write(id: u32, data_b64: &str) -> PtyWriteResult {
        let bytes = match base64_decode(data_b64) {
            Ok(b) => b,
            Err(e) => {
                return PtyWriteResult {
                    ok: false,
                    bytes_written: 0,
                    error: Some(e),
                };
            }
        };
        if bytes.len() > MAX_PTY_WRITE_BYTES {
            return PtyWriteResult {
                ok: false,
                bytes_written: 0,
                error: Some(format!("write exceeds {MAX_PTY_WRITE_BYTES} bytes")),
            };
        }
        if bytes.is_empty() {
            return PtyWriteResult {
                ok: true,
                bytes_written: 0,
                error: None,
            };
        }

        let master_fd = {
            let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(entry) = guard.1.get(&id) else {
                return PtyWriteResult {
                    ok: false,
                    bytes_written: 0,
                    error: Some("unknown PTY session id".to_string()),
                };
            };
            entry.master_fd
        };

        let mut offset = 0usize;
        let mut poll_waits = 0u32;
        while offset < bytes.len() {
            let slice = &bytes[offset..];
            let rc = unsafe {
                libc::write(master_fd, slice.as_ptr().cast::<libc::c_void>(), slice.len())
            };
            if rc > 0 {
                offset += rc as usize;
                poll_waits = 0;
            } else {
                let err = std::io::Error::last_os_error();
                if err.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if err.kind() == std::io::ErrorKind::WouldBlock {
                    if poll_waits < 3 {
                        poll_waits += 1;
                        let mut pfd = libc::pollfd {
                            fd: master_fd,
                            events: libc::POLLOUT,
                            revents: 0,
                        };
                        let _ = unsafe { libc::poll(&mut pfd, 1, 3) };
                        continue;
                    }
                    return PtyWriteResult {
                        ok: true,
                        bytes_written: offset,
                        error: None,
                    };
                }
                return PtyWriteResult {
                    ok: false,
                    bytes_written: offset,
                    error: Some(format!("pty write failed: {err}")),
                };
            }
        }

        PtyWriteResult {
            ok: true,
            bytes_written: offset,
            error: None,
        }
    }

    pub fn pty_resize(id: u32, cols: u16, rows: u16) -> bool {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(8, 200);
        let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = guard.1.get(&id) else {
            return false;
        };
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        unsafe { libc::ioctl(entry.master_fd, libc::TIOCSWINSZ, &ws) == 0 }
    }

    pub fn pty_poll(id: u32) -> PtyPollResult {
        let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = guard.1.get_mut(&id) else {
            return PtyPollResult {
                ok: false,
                data_b64: String::new(),
                exited: true,
                exit_code: None,
                dropped_bytes: 0,
                error: Some("unknown PTY session id".to_string()),
            };
        };

        if !entry.exited
            && let Ok(Some(status)) = entry.child.try_wait()
        {
            entry.exited = true;
            entry.exited_at = Some(Instant::now());
            entry.exit_code = status
                .code()
                .or_else(|| status.signal().map(|sig| 128 + sig));
        }

        let (drained, dropped, eof_seen) = {
            let mut st = entry.shared.lock().unwrap_or_else(|e| e.into_inner());
            let mut out = Vec::with_capacity(st.buf.len());
            out.extend(st.buf.drain(..));
            let dropped = st.dropped_bytes;
            st.dropped_bytes = 0;
            if st.eof
                && !entry.exited
                && let Ok(Some(status)) = entry.child.try_wait()
            {
                entry.exited = true;
                entry.exited_at = Some(Instant::now());
                entry.exit_code = status
                    .code()
                    .or_else(|| status.signal().map(|sig| 128 + sig));
            }
            (out, dropped, st.eof)
        };

        let report_exited = entry.exited
            && (eof_seen
                || entry
                    .exited_at
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(200)));

        PtyPollResult {
            ok: true,
            data_b64: base64_encode(&drained),
            exited: report_exited,
            exit_code: if report_exited { entry.exit_code } else { None },
            dropped_bytes: dropped,
            error: None,
        }
    }

    pub fn pty_kill(id: u32) -> bool {
        let removed = {
            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            guard.1.remove(&id)
        };
        let Some(mut entry) = removed else {
            return false;
        };
        unsafe {
            libc::close(entry.master_fd);
        }
        let still_running = !entry.exited && matches!(entry.child.try_wait(), Ok(None));
        if still_running {
            let pgid = -(entry.pid as i32);
            unsafe {
                let _ = libc::kill(pgid, libc::SIGHUP);
                let _ = libc::kill(pgid, libc::SIGTERM);
            }
            let _ = std::thread::Builder::new()
                .name(format!("iron-pty-reap-{}", entry.pid))
                .spawn(move || {
                    for _ in 0..25 {
                        if let Ok(Some(_)) = entry.child.try_wait() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    unsafe {
                        let _ = libc::kill(pgid, libc::SIGKILL);
                    }
                    let _ = entry.child.kill();
                    let _ = entry.child.wait();
                });
        }
        true
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;

    pub fn pty_spawn(_input: PtySpawnInput) -> PtySpawnResult {
        PtySpawnResult {
            ok: false,
            id: None,
            pid: None,
            error: Some("native PTY only supported on Unix".to_string()),
        }
    }
    pub fn pty_write(_id: u32, _data_b64: &str) -> PtyWriteResult {
        PtyWriteResult {
            ok: false,
            bytes_written: 0,
            error: Some("native PTY only supported on Unix".to_string()),
        }
    }
    pub fn pty_resize(_id: u32, _cols: u16, _rows: u16) -> bool {
        false
    }
    pub fn pty_poll(_id: u32) -> PtyPollResult {
        PtyPollResult {
            ok: false,
            data_b64: String::new(),
            exited: true,
            exit_code: None,
            dropped_bytes: 0,
            error: Some("native PTY only supported on Unix".to_string()),
        }
    }
    pub fn pty_kill(_id: u32) -> bool {
        false
    }
}

pub use imp::{pty_kill, pty_poll, pty_resize, pty_spawn, pty_write};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn posix_pty_spawns_echoes_resizes_and_reaps_cleanly() {
        let mut env = BTreeMap::new();
        env.insert("IRON_TEST_SOCKET".to_string(), "/tmp/iron-test.sock".to_string());

        let spawned = pty_spawn(PtySpawnInput {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "printf 'BOOT:%s\\n' \"$IRON_TEST_SOCKET\"; IFS= read -r line; printf 'GOT:%s\\n' \"$line\"".to_string(),
            ],
            cwd: None,
            env,
            cols: Some(100),
            rows: Some(30),
        });
        assert!(spawned.ok, "pty_spawn failed: {:?}", spawned.error);
        let id = spawned.id.expect("pty id");

        assert!(pty_resize(id, 120, 40));

        let wr = pty_write(id, &base64_encode(b"hello-agent\n"));
        assert!(wr.ok, "pty_write failed: {:?}", wr.error);

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut collected = Vec::new();
        let mut saw_exit = false;
        while Instant::now() < deadline {
            let polled = pty_poll(id);
            assert!(polled.ok);
            if !polled.data_b64.is_empty() {
                collected.extend(base64_decode(&polled.data_b64).expect("decode b64"));
            }
            let text = String::from_utf8_lossy(&collected);
            if text.contains("BOOT:/tmp/iron-test.sock")
                && text.contains("GOT:hello-agent")
                && polled.exited
            {
                saw_exit = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }

        let final_text = String::from_utf8_lossy(&collected);
        assert!(
            final_text.contains("BOOT:/tmp/iron-test.sock"),
            "missing BOOT in {final_text:?}"
        );
        assert!(
            final_text.contains("GOT:hello-agent"),
            "missing GOT in {final_text:?}"
        );
        assert!(saw_exit, "expected child shell to exit cleanly");
        assert!(pty_kill(id));
    }

    #[test]
    fn raw_mode_nonblocking_write_and_fast_exit_drain_regressions() {
        // 1. F-26: >16KB write to a raw-mode PTY whose slave hasn't read stdin yet must NEVER block!
        let spawned = pty_spawn(PtySpawnInput {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "stty raw -echo; printf 'READY'; sleep 0.25".to_string(),
            ],
            cwd: None,
            env: BTreeMap::new(),
            cols: Some(80),
            rows: Some(24),
        });
        assert!(spawned.ok);
        let id = spawned.id.unwrap();

        let wait_ready = Instant::now() + Duration::from_secs(2);
        let mut ready_buf = Vec::new();
        while Instant::now() < wait_ready {
            let p = pty_poll(id);
            if !p.data_b64.is_empty() {
                ready_buf.extend(base64_decode(&p.data_b64).unwrap());
            }
            if String::from_utf8_lossy(&ready_buf).contains("READY") {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        let t0 = Instant::now();
        let big_payload = vec![b'A'; 16_384];
        let wr = pty_write(id, &base64_encode(&big_payload));
        let elapsed = t0.elapsed();
        assert!(wr.ok, "non-blocking pty_write failed: {:?}", wr.error);
        assert!(
            elapsed < Duration::from_millis(100),
            "pty_write blocked for {elapsed:?} on raw-mode slave!"
        );
        assert!(pty_kill(id));

        // 2. F-28: 25 rapid /bin/echo spawns must retain 100% of stdout before reporting exited=true
        //    and release MAX_ACTIVE_PTYS (8) slots cleanly.
        for round in 0..25 {
            let s = pty_spawn(PtySpawnInput {
                program: "/bin/echo".to_string(),
                args: vec![format!("FAST_BANNER_{round}")],
                cwd: None,
                env: BTreeMap::new(),
                cols: Some(80),
                rows: Some(24),
            });
            assert!(s.ok, "round {round} spawn failed: {:?}", s.error);
            let sid = s.id.unwrap();
            let mut text = String::new();
            let dl = Instant::now() + Duration::from_secs(2);
            while Instant::now() < dl {
                let p = pty_poll(sid);
                if !p.data_b64.is_empty() {
                    let bytes = base64_decode(&p.data_b64).unwrap();
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
                if p.exited {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(
                text.contains(&format!("FAST_BANNER_{round}")),
                "round {round} lost fast-exit output: {text:?}"
            );
            assert!(pty_kill(sid));
        }
    }
}
