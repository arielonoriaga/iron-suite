use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result};
use iron_proto::{GridSnapshot, OscEvent, OscScanner};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;

use crate::vt::HeadlessVt;

static PTY_ID_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum PtySignal {
    GridUpdated {
        session_id: String,
        pty_id: u64,
        snapshot: GridSnapshot,
    },
    OscReceived {
        session_id: String,
        pty_id: u64,
        event: OscEvent,
    },
    Exited {
        session_id: String,
        pty_id: u64,
    },
}

pub struct LivePty {
    pty_id: u64,
    session_id: String,
    vt: Arc<Mutex<HeadlessVt>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    attached_clients: Arc<AtomicUsize>,
    stop_flag: Arc<AtomicBool>,
    reader_done_rx: Mutex<Option<std_mpsc::Receiver<()>>>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
}

impl LivePty {
    pub fn spawn(
        session_id: String,
        worktree_path: &str,
        command: &[String],
        socket_path: &Path,
        cols: u16,
        rows: u16,
        signal_tx: mpsc::Sender<PtySignal>,
    ) -> Result<Self> {
        let pty_id = PTY_ID_SEQ.fetch_add(1, Ordering::Relaxed);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("open native PTY pair")?;

        let mut cmd = if let Some((prog, args)) = command.split_first() {
            let mut b = CommandBuilder::new(prog);
            b.args(args);
            b
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            CommandBuilder::new(shell)
        };

        if Path::new(worktree_path).is_dir() {
            cmd.cwd(worktree_path);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("IRON_SESSION_ID", &session_id);
        cmd.env("IRON_TERM_SOCKET", socket_path);

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn command in PTY slave")?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("clone PTY master reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("take PTY master writer")?;

        let vt = Arc::new(Mutex::new(HeadlessVt::new(cols, rows)));
        let attached_clients = Arc::new(AtomicUsize::new(0));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = std_mpsc::channel();

        let vt_bg = Arc::clone(&vt);
        let attached_bg = Arc::clone(&attached_clients);
        let stop_bg = Arc::clone(&stop_flag);
        let sid_bg = session_id.clone();

        let handle = std::thread::Builder::new()
            .name(format!("iron-pty-{pty_id}"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                let mut osc = OscScanner::new();
                while !stop_bg.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let (clean, events) = osc.push(&buf[..n]);
                            for event in events {
                                let _ = signal_tx.blocking_send(PtySignal::OscReceived {
                                    session_id: sid_bg.clone(),
                                    pty_id,
                                    event,
                                });
                            }
                            if !clean.is_empty() {
                                let snap_if_attached = {
                                    let mut guard = vt_bg.lock().unwrap_or_else(|e| e.into_inner());
                                    guard.feed(&clean);
                                    // Zero GPU / RPC overhead guarantee:
                                    // snapshot and push ONLY while >=1 client is attached.
                                    if attached_bg.load(Ordering::Acquire) > 0 {
                                        Some(guard.snapshot(&sid_bg))
                                    } else {
                                        None
                                    }
                                };
                                if let Some(snapshot) = snap_if_attached {
                                    // Coalesce burst grid snapshots when channel is saturated.
                                    let _ = signal_tx.try_send(PtySignal::GridUpdated {
                                        session_id: sid_bg.clone(),
                                        pty_id,
                                        snapshot,
                                    });
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                if !stop_bg.load(Ordering::Relaxed) {
                    let _ = signal_tx.blocking_send(PtySignal::Exited {
                        session_id: sid_bg,
                        pty_id,
                    });
                }
                let _ = done_tx.send(());
            })
            .context("spawn PTY reader thread")?;

        Ok(Self {
            pty_id,
            session_id,
            vt,
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(Some(pair.master)),
            child: Mutex::new(child),
            attached_clients,
            stop_flag,
            reader_done_rx: Mutex::new(Some(done_rx)),
            reader_thread: Mutex::new(Some(handle)),
        })
    }

    pub fn pty_id(&self) -> u64 {
        self.pty_id
    }

    pub fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process_id()
    }

    pub fn set_attached_count(&self, count: usize) {
        self.attached_clients.store(count, Ordering::Release);
    }

    pub fn attached_count(&self) -> usize {
        self.attached_clients.load(Ordering::Acquire)
    }

    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let Some(w) = guard.as_mut() else {
            anyhow::bail!("PTY writer closed");
        };
        w.write_all(bytes).context("write bytes to PTY")?;
        w.flush().context("flush PTY writer")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        {
            let guard = self.master.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(m) = guard.as_ref() {
                m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("resize PTY master")?;
            }
        }
        let mut vt = self.vt.lock().unwrap_or_else(|e| e.into_inner());
        vt.resize(cols, rows);
        Ok(())
    }

    pub fn snapshot(&self) -> GridSnapshot {
        self.vt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(&self.session_id)
    }

    pub fn extract_tail_lines(&self, max_lines: usize) -> Vec<String> {
        self.vt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extract_tail_lines(max_lines)
    }

    /// Terminates the entire PTY process group (child + grandchildren) and reaps the child
    /// so 0 orphaned PIDs remain. Uses a bounded wait on the reader thread so teardown never deadlocks.
    pub fn terminate_and_reap(&self) {
        self.stop_flag.store(true, Ordering::Release);
        self.attached_clients.store(0, Ordering::Release);

        // Close master/writer handles early so slave readers observe hangup.
        {
            let _ = self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
            let _ = self.master.lock().unwrap_or_else(|e| e.into_inner()).take();
        }

        {
            let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(pid) = child.process_id()
                && let Ok(pgid) = i32::try_from(pid)
                && pgid > 1
            {
                // `portable-pty` calls `setsid()`, so `pid` is the process group leader.
                // Signal the entire process group (-pgid) to eliminate orphaned grandchildren.
                // SAFETY: `pgid > 1` ensures we never signal PID 0, -1, or init.
                unsafe {
                    libc::kill(-pgid, libc::SIGHUP);
                }
                let mut exited = false;
                for _ in 0..8 {
                    if let Ok(Some(_)) = child.try_wait() {
                        exited = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !exited || unsafe { libc::kill(-pgid, 0) } == 0 {
                    unsafe {
                        libc::kill(-pgid, libc::SIGKILL);
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }

        // Bounded join so an exotic inherited fd can never deadlock the daemon.
        let done_rx = self
            .reader_done_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let handle = self
            .reader_thread
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let (Some(rx), Some(h)) = (done_rx, handle)
            && rx.recv_timeout(Duration::from_millis(500)).is_ok()
        {
            let _ = h.join();
        }
    }
}

impl Drop for LivePty {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}
