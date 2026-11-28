use std::collections::{HashMap, HashSet};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use iron_proto::{
    AgentState, ClientMsg, DaemonEvent, HostMode, HostStatus, MAX_FRAME_BYTES, OscEvent,
    OverheadStats, RpcRequest, RpcResponse, ServerFrame, SessionInspection, SessionSummary,
    decode_frame, encode_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};

use crate::invariants::validate_move_host;
use crate::pty::{LivePty, PtySignal};
use crate::store::{StateStore, now_ms};

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);
static CLIENT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PeerHostConfig {
    pub id: String,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub mode: Option<HostMode>,
    #[serde(default)]
    pub cap_pct: Option<u8>,
    #[serde(default)]
    pub max_slots: Option<u8>,
}

impl PeerHostConfig {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            hostname: None,
            mode: None,
            cap_pct: None,
            max_slots: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub socket_path: PathBuf,
    pub db_path: PathBuf,
    pub host_id: String,
    pub hostname: String,
    pub peer_hosts: Vec<PeerHostConfig>,
}

impl DaemonConfig {
    pub fn default_paths() -> Self {
        let socket_path = iron_proto::resolve_socket_path();
        let db_path = iron_proto::resolve_data_dir().join("state.db");
        let hostname = iron_proto::resolve_local_hostname();
        let host_id = std::env::var("IRON_TERM_HOST_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| hostname.clone());
        let peer_hosts = load_peer_hosts();
        Self {
            socket_path,
            db_path,
            host_id,
            hostname,
            peer_hosts,
        }
    }
}

fn merge_peer_hosts(target: &mut Vec<PeerHostConfig>, incoming: Vec<PeerHostConfig>) {
    for peer in incoming {
        let id = peer.id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let normalized = PeerHostConfig {
            id: id.clone(),
            hostname: peer
                .hostname
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            mode: peer.mode,
            cap_pct: peer.cap_pct,
            max_slots: peer.max_slots,
        };
        if let Some(existing) = target.iter_mut().find(|p| p.id == id) {
            *existing = normalized;
        } else {
            target.push(normalized);
        }
    }
}

/// Parses optional `$XDG_CONFIG_HOME/iron-term/hosts.json` contents.
/// Accepts either a JSON array of [`PeerHostConfig`] or `{ "hosts": [...] }`.
pub fn parse_peer_hosts_json(raw: &str) -> Result<Vec<PeerHostConfig>> {
    #[derive(serde::Deserialize)]
    struct HostsWrapper {
        hosts: Vec<PeerHostConfig>,
    }

    let parsed = if let Ok(list) = serde_json::from_str::<Vec<PeerHostConfig>>(raw) {
        list
    } else {
        serde_json::from_str::<HostsWrapper>(raw)
            .context("parse peer hosts JSON")?
            .hosts
    };
    let mut out = Vec::new();
    merge_peer_hosts(&mut out, parsed);
    Ok(out)
}

/// Parses `IRON_TERM_HOSTS` entries of the form `<id>[=<hostname>][:<free|shared|off>]`,
/// comma-separated and deduplicated by `id`.
pub fn parse_peer_hosts_env(raw: &str) -> Vec<PeerHostConfig> {
    let mut parsed = Vec::new();
    for entry in raw.split(',') {
        let item = entry.trim();
        if item.is_empty() {
            continue;
        }
        let (left, mode) = match item.rsplit_once(':') {
            Some((prefix, mode_str)) => {
                if let Some(m) = HostMode::parse(mode_str) {
                    (prefix.trim(), Some(m))
                } else {
                    (item, None)
                }
            }
            None => (item, None),
        };
        let (id_part, hostname) = match left.split_once('=') {
            Some((id_raw, host_raw)) => {
                let h = host_raw.trim();
                (
                    id_raw.trim(),
                    if h.is_empty() {
                        None
                    } else {
                        Some(h.to_string())
                    },
                )
            }
            None => (left.trim(), None),
        };
        if id_part.is_empty() {
            continue;
        }
        parsed.push(PeerHostConfig {
            id: id_part.to_string(),
            hostname,
            mode,
            cap_pct: None,
            max_slots: None,
        });
    }
    let mut out = Vec::new();
    merge_peer_hosts(&mut out, parsed);
    out
}

fn load_peer_hosts() -> Vec<PeerHostConfig> {
    let mut peers = Vec::new();
    if let Some(config_path) = iron_proto::resolve_config_dir().map(|d| d.join("hosts.json"))
        && let Ok(raw) = std::fs::read_to_string(&config_path)
    {
        match parse_peer_hosts_json(&raw) {
            Ok(from_file) => merge_peer_hosts(&mut peers, from_file),
            Err(e) => {
                eprintln!(
                    "iron-agentd: ignoring invalid {}: {e:#}",
                    config_path.display()
                );
            }
        }
    }
    if let Ok(raw_env) = std::env::var("IRON_TERM_HOSTS") {
        merge_peer_hosts(&mut peers, parse_peer_hosts_env(&raw_env));
    }
    peers
}

struct DaemonState {
    config: DaemonConfig,
    store: StateStore,
    hosts: HashMap<String, HostStatus>,
    sessions: HashMap<String, SessionSummary>,
    live_ptys: HashMap<String, Arc<LivePty>>,
    /// Exact attachment ownership: `pty_id -> set of client_ids`.
    /// Eliminates refcount corruption across PTY exit, hibernate, wake, and multi-client disconnect.
    attachments: HashMap<u64, HashSet<u64>>,
    signal_tx: mpsc::Sender<PtySignal>,
    events_tx: broadcast::Sender<DaemonEvent>,
}

impl DaemonState {
    fn new(
        mut config: DaemonConfig,
        store: StateStore,
        signal_tx: mpsc::Sender<PtySignal>,
        events_tx: broadcast::Sender<DaemonEvent>,
    ) -> Result<Self> {
        let _ = store.mark_orphaned_sessions_hibernated()?;
        let loaded = store.list_sessions()?;
        let mut sessions = HashMap::with_capacity(loaded.len());
        for s in loaded {
            sessions.insert(s.id.clone(), s);
        }

        if config.hostname.trim().is_empty() {
            config.hostname = iron_proto::resolve_local_hostname();
        }
        if config.host_id.trim().is_empty() {
            config.host_id = config.hostname.clone();
        }

        let mut hosts = HashMap::new();
        hosts.insert(
            config.host_id.clone(),
            HostStatus {
                id: config.host_id.clone(),
                hostname: config.hostname.clone(),
                mode: HostMode::Free,
                cpu_pct: 12,
                cap_pct: 95,
                ram_used_gb: 8.0,
                ram_total_gb: 32.0,
                active_slots: 0,
                max_slots: 2,
            },
        );

        for peer in &config.peer_hosts {
            let id = peer.id.trim();
            if id.is_empty() || id == config.host_id || hosts.contains_key(id) {
                continue;
            }
            let mode = peer.mode.unwrap_or(HostMode::Shared);
            let (default_cap, default_slots) = match mode {
                HostMode::Off => (0, 0),
                HostMode::Shared => (50, 1),
                HostMode::Free => (90, 1),
            };
            hosts.insert(
                id.to_string(),
                HostStatus {
                    id: id.to_string(),
                    hostname: peer
                        .hostname
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id)
                        .to_string(),
                    mode,
                    cpu_pct: 15,
                    cap_pct: peer.cap_pct.unwrap_or(default_cap),
                    ram_used_gb: 6.0,
                    ram_total_gb: 16.0,
                    active_slots: 0,
                    max_slots: peer.max_slots.unwrap_or(default_slots),
                },
            );
        }

        Ok(Self {
            config,
            store,
            hosts,
            sessions,
            live_ptys: HashMap::new(),
            attachments: HashMap::new(),
            signal_tx,
            events_tx,
        })
    }

    fn sorted_sessions(&self) -> Vec<SessionSummary> {
        let mut list: Vec<SessionSummary> = self.sessions.values().cloned().collect();
        list.sort_by(|a, b| {
            b.state
                .is_urgent()
                .cmp(&a.state.is_urgent())
                .then_with(|| b.state.is_live().cmp(&a.state.is_live()))
                .then_with(|| b.updated_at_ms.cmp(&a.updated_at_ms))
        });
        list
    }

    fn sorted_hosts(&self) -> Vec<HostStatus> {
        let mut list: Vec<HostStatus> = self.hosts.values().cloned().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    fn overhead_stats(&self) -> OverheadStats {
        let mut rendered_ptys = 0usize;
        let mut headless_live = 0usize;
        let mut hibernated = 0usize;
        let mut total_live_ram_mb = 0u32;

        for s in self.sessions.values() {
            if s.state == AgentState::Hibernated {
                hibernated += 1;
            } else {
                total_live_ram_mb = total_live_ram_mb.saturating_add(s.ram_mb);
                if self
                    .live_ptys
                    .get(&s.id)
                    .is_some_and(|p| p.attached_count() > 0)
                {
                    rendered_ptys += 1;
                } else {
                    headless_live += 1;
                }
            }
        }

        OverheadStats {
            rendered_ptys,
            headless_live,
            hibernated,
            total_live_ram_mb,
        }
    }

    fn broadcast_fleet(&self) {
        let _ = self.events_tx.send(DaemonEvent::FleetDelta {
            sessions: self.sorted_sessions(),
            hosts: self.sorted_hosts(),
            overhead: self.overhead_stats(),
        });
    }

    fn append_journal_and_emit(
        &self,
        session_id: Option<&str>,
        agent_label: &str,
        kind: &str,
        message: &str,
    ) {
        if let Ok(entry) = self
            .store
            .append_journal(session_id, agent_label, kind, message)
        {
            let _ = self.events_tx.send(DaemonEvent::JournalAppended { entry });
        }
    }

    fn attach_client(&mut self, client_id: u64, session_id: &str) -> Option<(u64, Arc<LivePty>)> {
        let pty = self.live_ptys.get(session_id)?.clone();
        let pty_id = pty.pty_id();
        let entry = self.attachments.entry(pty_id).or_default();
        entry.insert(client_id);
        pty.set_attached_count(entry.len());
        Some((pty_id, pty))
    }

    fn detach_client_from_session(&mut self, client_id: u64, session_id: &str) {
        if let Some(pty) = self.live_ptys.get(session_id) {
            let pty_id = pty.pty_id();
            if let Some(set) = self.attachments.get_mut(&pty_id) {
                set.remove(&client_id);
                pty.set_attached_count(set.len());
                if set.is_empty() {
                    self.attachments.remove(&pty_id);
                }
            }
        }
    }

    fn detach_client_all(&mut self, client_id: u64) -> bool {
        let mut changed = false;
        let pty_by_id: HashMap<u64, Arc<LivePty>> = self
            .live_ptys
            .values()
            .map(|p| (p.pty_id(), Arc::clone(p)))
            .collect();
        self.attachments.retain(|pty_id, clients| {
            if clients.remove(&client_id) {
                changed = true;
                if let Some(pty) = pty_by_id.get(pty_id) {
                    pty.set_attached_count(clients.len());
                }
            }
            !clients.is_empty()
        });
        changed
    }

    fn is_client_attached_to(&self, client_id: u64, session_id: &str) -> bool {
        self.live_ptys.get(session_id).is_some_and(|pty| {
            self.attachments
                .get(&pty.pty_id())
                .is_some_and(|set| set.contains(&client_id))
        })
    }

    fn handle_pty_signal(&mut self, sig: PtySignal) -> Option<Arc<LivePty>> {
        match sig {
            PtySignal::GridUpdated {
                session_id,
                pty_id,
                snapshot,
            } => {
                if self
                    .live_ptys
                    .get(&session_id)
                    .is_some_and(|p| p.pty_id() == pty_id)
                {
                    let _ = self.events_tx.send(DaemonEvent::GridDelta { snapshot });
                }
                None
            }
            PtySignal::OscReceived {
                session_id,
                pty_id,
                event,
            } => {
                if self
                    .live_ptys
                    .get(&session_id)
                    .is_none_or(|p| p.pty_id() != pty_id)
                {
                    return None; // Stale signal from a replaced PTY incarnation.
                }
                let mut updated = self.sessions.get(&session_id).cloned()?;
                let mut raised_prompt = None;
                match event {
                    OscEvent::Checkpoint { text } => updated.checkpoint = text,
                    OscEvent::Phase { phase } => updated.phase = phase,
                    OscEvent::State {
                        state,
                        checkpoint,
                        prompt,
                    } => {
                        // Never allow OSC to set Hibernated without actually reaping the PTY.
                        if state == AgentState::Hibernated {
                            return None;
                        }
                        updated.state = state;
                        if let Some(cp) = checkpoint {
                            updated.checkpoint = cp;
                        }
                        raised_prompt = prompt.clone();
                        updated.prompt = prompt;
                    }
                }
                updated.updated_at_ms = now_ms();
                if self.store.upsert_session(&updated).is_ok() {
                    self.sessions.insert(session_id.clone(), updated);
                    if let Some(prompt) = raised_prompt {
                        let _ = self.events_tx.send(DaemonEvent::PromptRaised {
                            session_id,
                            prompt,
                        });
                    }
                    self.broadcast_fleet();
                }
                None
            }
            PtySignal::Exited { session_id, pty_id } => {
                let matches = self
                    .live_ptys
                    .get(&session_id)
                    .is_some_and(|p| p.pty_id() == pty_id);
                if !matches {
                    return None; // Stale exit from a previous PTY incarnation.
                }
                self.attachments.remove(&pty_id);
                let removed = self.live_ptys.remove(&session_id);
                if let Some(ref pty) = removed {
                    let tail = pty.extract_tail_lines(500);
                    let _ = self.store.save_scrollback_tail(&session_id, &tail);
                }
                if let Some(mut updated) = self.sessions.get(&session_id).cloned()
                    && updated.state != AgentState::Hibernated
                {
                    updated.state = AgentState::Hibernated;
                    updated.ram_mb = 0;
                    updated.prompt = None;
                    updated.checkpoint = "Process exited — scrollback saved to SQLite".into();
                    updated.updated_at_ms = now_ms();
                    if self.store.upsert_session(&updated).is_ok() {
                        self.sessions.insert(session_id, updated);
                    }
                }
                self.broadcast_fleet();
                removed
            }
        }
    }

    fn drain_all_ptys(&mut self) -> Vec<(String, Arc<LivePty>)> {
        self.attachments.clear();
        self.live_ptys.drain().collect()
    }
}

/// Async RPC dispatcher that NEVER holds `Mutex<DaemonState>` across blocking PTY I/O,
/// `spawn`, `write_input`, or `terminate_and_reap`.
async fn dispatch_request(
    state: &Arc<Mutex<DaemonState>>,
    client_id: u64,
    msg: ClientMsg,
) -> RpcResponse {
    match msg {
        ClientMsg::Ping => RpcResponse::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        ClientMsg::ListFleet => {
            let guard = state.lock().unwrap_or_else(|e| e.into_inner());
            RpcResponse::Fleet {
                hosts: guard.sorted_hosts(),
                sessions: guard.sorted_sessions(),
                overhead: guard.overhead_stats(),
            }
        }
        ClientMsg::SpawnSession {
            title,
            host_id,
            project,
            worktree_path,
            cli,
            command,
            pinned_host,
            pin_reason,
            resume_cmd,
        } => {
            let (id, resolved_host, socket_path, signal_tx) = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let resolved = host_id.unwrap_or_else(|| guard.config.host_id.clone());
                if let Some(ref pinned) = pinned_host
                    && pinned != &resolved
                {
                    return RpcResponse::MoveBlocked {
                        reason: pin_reason
                            .clone()
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or_else(|| format!("Pinned to {pinned}")),
                    };
                }
                if let Some(h) = guard.hosts.get(&resolved)
                    && h.mode == HostMode::Off
                {
                    return RpcResponse::MoveBlocked {
                        reason: format!("{} is OFF — switch mode first", h.hostname),
                    };
                }
                let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
                let id = format!("sess-{}-{seq}", now_ms());
                (
                    id,
                    resolved,
                    guard.config.socket_path.clone(),
                    guard.signal_tx.clone(),
                )
            };

            let spawn_id = id.clone();
            let spawn_wt = worktree_path.clone();
            let spawn_cmd = command.clone();
            let pty_res = tokio::task::spawn_blocking(move || {
                LivePty::spawn(
                    spawn_id,
                    &spawn_wt,
                    &spawn_cmd,
                    &socket_path,
                    120,
                    36,
                    signal_tx,
                )
            })
            .await;

            let pty = match pty_res {
                Ok(Ok(p)) => Arc::new(p),
                Ok(Err(e)) => {
                    return RpcResponse::Error {
                        code: "SPAWN_FAILED".into(),
                        message: format!("{e:#}"),
                    };
                }
                Err(e) => {
                    return RpcResponse::Error {
                        code: "SPAWN_JOIN_ERROR".into(),
                        message: format!("{e}"),
                    };
                }
            };

            let git_branch = detect_git_branch(&worktree_path).unwrap_or_else(|| "main".into());
            let session = SessionSummary {
                id: id.clone(),
                title: title.clone(),
                cli,
                host_id: resolved_host,
                project,
                worktree_path,
                git_branch,
                git_dirty: false,
                git_behind_main: 0,
                state: AgentState::Running,
                phase: "brief".to_string(),
                phases: vec![
                    "brief".into(),
                    "build".into(),
                    "review".into(),
                    "verify".into(),
                ],
                ram_mb: 3,
                pinned_host,
                pin_reason,
                checkpoint: "Session started".to_string(),
                resume_cmd,
                resume_argv: if command.is_empty() {
                    None
                } else {
                    Some(command)
                },
                prompt: None,
                queue_job: None,
                updated_at_ms: now_ms(),
            };

            let persist_res = {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                match guard.store.upsert_session(&session) {
                    Ok(()) => {
                        guard.append_journal_and_emit(
                            Some(&id),
                            &title,
                            "note",
                            "Spawned live headless PTY session",
                        );
                        guard.live_ptys.insert(id, Arc::clone(&pty));
                        guard.sessions.insert(session.id.clone(), session.clone());
                        guard.broadcast_fleet();
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            };

            if let Err(e) = persist_res {
                let _ = tokio::task::spawn_blocking(move || pty.terminate_and_reap()).await;
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            RpcResponse::Session { session }
        }
        ClientMsg::AttachPty {
            session_id,
            cols,
            rows,
        } => {
            let pty = {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let Some((_, pty)) = guard.attach_client(client_id, &session_id) else {
                    return RpcResponse::Error {
                        code: "NOT_LIVE".into(),
                        message: format!("session {session_id} has no live PTY (wake it first)"),
                    };
                };
                guard.broadcast_fleet();
                pty
            };
            let snap = tokio::task::spawn_blocking(move || {
                if cols > 0 && rows > 0 {
                    let _ = pty.resize(cols, rows);
                }
                pty.snapshot()
            })
            .await;
            match snap {
                Ok(snapshot) => RpcResponse::Attached { snapshot },
                Err(e) => RpcResponse::Error {
                    code: "ATTACH_ERROR".into(),
                    message: format!("{e}"),
                },
            }
        }
        ClientMsg::DetachPty { session_id } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            guard.detach_client_from_session(client_id, &session_id);
            guard.broadcast_fleet();
            RpcResponse::Ok
        }
        ClientMsg::PtyInput { session_id, bytes } => {
            let pty = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.live_ptys.get(&session_id).cloned()
            };
            let Some(pty) = pty else {
                return RpcResponse::Error {
                    code: "NOT_LIVE".into(),
                    message: format!("session {session_id} is not live"),
                };
            };
            match tokio::task::spawn_blocking(move || pty.write_input(&bytes)).await {
                Ok(Ok(())) => RpcResponse::Ok,
                Ok(Err(e)) => RpcResponse::Error {
                    code: "PTY_WRITE_ERROR".into(),
                    message: format!("{e:#}"),
                },
                Err(e) => RpcResponse::Error {
                    code: "PTY_WRITE_ERROR".into(),
                    message: format!("{e}"),
                },
            }
        }
        ClientMsg::PtyResize {
            session_id,
            cols,
            rows,
        } => {
            let pty = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.live_ptys.get(&session_id).cloned()
            };
            if let Some(pty) = pty {
                let _ = tokio::task::spawn_blocking(move || pty.resize(cols, rows)).await;
            }
            RpcResponse::Ok
        }
        ClientMsg::HibernateSession {
            session_id,
            checkpoint,
        } => {
            let removed_pty = {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                if !guard.sessions.contains_key(&session_id) {
                    return RpcResponse::Error {
                        code: "NOT_FOUND".into(),
                        message: format!("session {session_id} not found"),
                    };
                }
                if let Some(pty) = guard.live_ptys.remove(&session_id) {
                    guard.attachments.remove(&pty.pty_id());
                    Some(pty)
                } else {
                    None
                }
            };

            let tail = if let Some(pty) = removed_pty {
                tokio::task::spawn_blocking(move || {
                    let lines = pty.extract_tail_lines(500);
                    pty.terminate_and_reap();
                    lines
                })
                .await
                .unwrap_or_default()
            } else {
                Vec::new()
            };

            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut updated) = guard.sessions.get(&session_id).cloned() else {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            };
            // If a concurrent WakeSession already spawned a fresh live PTY while we were
            // reaping the old one, do not clobber the newly woken session's state.
            if guard.live_ptys.contains_key(&session_id) {
                return RpcResponse::Session { session: updated };
            }
            if !tail.is_empty() {
                let _ = guard.store.save_scrollback_tail(&session_id, &tail);
            }
            updated.state = AgentState::Hibernated;
            updated.ram_mb = 0;
            updated.prompt = None;
            if let Some(cp) = checkpoint {
                updated.checkpoint = cp;
            }
            updated.updated_at_ms = now_ms();
            if let Err(e) = guard.store.upsert_session(&updated) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.sessions.insert(session_id.clone(), updated.clone());
            guard.append_journal_and_emit(
                Some(&session_id),
                &updated.title,
                "note",
                "Hibernated to SQLite (0 MB live RAM, 0 child PIDs)",
            );
            guard.broadcast_fleet();
            RpcResponse::Session { session: updated }
        }
        ClientMsg::WakeSession {
            session_id,
            rebase_onto_main,
        } => {
            let (existing, socket_path, signal_tx) = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(existing) = guard.sessions.get(&session_id).cloned() else {
                    return RpcResponse::Error {
                        code: "NOT_FOUND".into(),
                        message: format!("session {session_id} not found"),
                    };
                };
                if guard.live_ptys.contains_key(&session_id) {
                    return RpcResponse::Session { session: existing };
                }
                (
                    existing,
                    guard.config.socket_path.clone(),
                    guard.signal_tx.clone(),
                )
            };

            // Explicit `resume_cmd` (e.g. `claude --resume <id>`) takes precedence when provided;
            // otherwise replay structured `resume_argv` directly with zero shell interpolation.
            let command: Vec<String> = if let Some(ref cmd) = existing.resume_cmd
                && !cmd.trim().is_empty()
            {
                vec!["/bin/sh".into(), "-lc".into(), cmd.clone()]
            } else if let Some(ref argv) = existing.resume_argv
                && !argv.is_empty()
            {
                argv.clone()
            } else {
                Vec::new()
            };

            let wake_sid = session_id.clone();
            let wake_wt = existing.worktree_path.clone();
            let pty_res = tokio::task::spawn_blocking(move || {
                LivePty::spawn(wake_sid, &wake_wt, &command, &socket_path, 120, 36, signal_tx)
            })
            .await;

            let pty = match pty_res {
                Ok(Ok(p)) => Arc::new(p),
                Ok(Err(e)) => {
                    return RpcResponse::Error {
                        code: "WAKE_FAILED".into(),
                        message: format!("{e:#}"),
                    };
                }
                Err(e) => {
                    return RpcResponse::Error {
                        code: "WAKE_JOIN_ERROR".into(),
                        message: format!("{e}"),
                    };
                }
            };

            let mut updated = existing;
            updated.state = AgentState::Running;
            updated.ram_mb = 3;
            updated.prompt = None;
            updated.checkpoint = if rebase_onto_main {
                "Woke (rebase requested)".to_string()
            } else {
                "Woke from SQLite checkpoint".to_string()
            };
            updated.updated_at_ms = now_ms();

            let persist_res = {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                if guard.live_ptys.contains_key(&session_id) {
                    // Concurrent wake beat us — discard duplicate PTY cleanly.
                    Err(anyhow::anyhow!("ALREADY_LIVE"))
                } else {
                    match guard.store.upsert_session(&updated) {
                        Ok(()) => {
                            guard.live_ptys.insert(session_id.clone(), Arc::clone(&pty));
                            guard.sessions.insert(session_id.clone(), updated.clone());
                            guard.append_journal_and_emit(
                                Some(&session_id),
                                &updated.title,
                                "note",
                                "Woke session from SQLite checkpoint",
                            );
                            guard.broadcast_fleet();
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
            };

            if let Err(e) = persist_res {
                let _ = tokio::task::spawn_blocking(move || pty.terminate_and_reap()).await;
                if e.to_string() == "ALREADY_LIVE" {
                    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(s) = guard.sessions.get(&session_id).cloned() {
                        return RpcResponse::Session { session: s };
                    }
                }
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            RpcResponse::Session { session: updated }
        }
        ClientMsg::ResolvePrompt {
            session_id,
            action_id,
            custom_reply,
        } => {
            let (updated, pty_and_input) = {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(existing) = guard.sessions.get(&session_id).cloned() else {
                    return RpcResponse::Error {
                        code: "NOT_FOUND".into(),
                        message: format!("session {session_id} not found"),
                    };
                };
                if !existing.state.is_live() || !guard.live_ptys.contains_key(&session_id) {
                    return RpcResponse::Error {
                        code: "NOT_LIVE".into(),
                        message: format!("session {session_id} is not live"),
                    };
                }
                let Some(ref prompt) = existing.prompt else {
                    return RpcResponse::Error {
                        code: "NO_ACTIVE_PROMPT".into(),
                        message: format!("session {session_id} has no active prompt"),
                    };
                };
                // Fail closed: never silently fall back to action #0 on an unknown action_id.
                let Some(chosen) = prompt.actions.iter().find(|a| a.id == action_id).cloned()
                else {
                    return RpcResponse::Error {
                        code: "INVALID_ACTION".into(),
                        message: format!(
                            "unknown action_id '{action_id}' for session {session_id}"
                        ),
                    };
                };

                let input_line = custom_reply.or_else(|| chosen.command_to_send.clone());
                let mut updated = existing;
                updated.state = AgentState::Running;
                updated.prompt = None;
                updated.checkpoint = format!("Resolved prompt: {}", chosen.label);
                updated.updated_at_ms = now_ms();

                if let Err(e) = guard.store.upsert_session(&updated) {
                    return RpcResponse::Error {
                        code: "STORE_ERROR".into(),
                        message: format!("{e:#}"),
                    };
                }
                guard.sessions.insert(session_id.clone(), updated.clone());
                guard.append_journal_and_emit(
                    Some(&session_id),
                    &updated.title,
                    "decision",
                    &format!("Resolved prompt with action '{}'", chosen.label),
                );
                guard.broadcast_fleet();

                let pty_input = input_line.and_then(|line| {
                    guard.live_ptys.get(&session_id).cloned().map(|p| (p, line))
                });
                (updated, pty_input)
            };

            if let Some((pty, line)) = pty_and_input {
                let mut bytes = line.into_bytes();
                if !bytes.ends_with(b"\n") {
                    bytes.push(b'\n');
                }
                let _ = tokio::task::spawn_blocking(move || pty.write_input(&bytes)).await;
            }
            RpcResponse::Session { session: updated }
        }
        ClientMsg::MoveSessionHost {
            session_id,
            target_host_id,
        } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(session) = guard.sessions.get(&session_id).cloned() else {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            };
            let Some(target_host) = guard.hosts.get(&target_host_id) else {
                return RpcResponse::Error {
                    code: "HOST_NOT_FOUND".into(),
                    message: format!("host {target_host_id} not found"),
                };
            };
            if let Err(reason) = validate_move_host(&session, target_host) {
                return RpcResponse::MoveBlocked { reason };
            }

            let mut updated = session;
            updated.host_id = target_host_id.clone();
            updated.updated_at_ms = now_ms();
            if let Err(e) = guard.store.upsert_session(&updated) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.sessions.insert(session_id.clone(), updated.clone());
            guard.append_journal_and_emit(
                Some(&session_id),
                &updated.title,
                "decision",
                &format!("Moved session host to {target_host_id}"),
            );
            guard.broadcast_fleet();
            RpcResponse::Session { session: updated }
        }
        ClientMsg::SetHostMode { host_id, mode } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let is_local = host_id == guard.config.host_id;
            let Some(host) = guard.hosts.get_mut(&host_id) else {
                return RpcResponse::Error {
                    code: "HOST_NOT_FOUND".into(),
                    message: format!("host {host_id} not found"),
                };
            };
            host.mode = mode;
            match mode {
                HostMode::Off => {
                    host.cap_pct = 0;
                    host.max_slots = 0;
                }
                HostMode::Shared => {
                    host.cap_pct = 50;
                    host.max_slots = 1;
                }
                HostMode::Free => {
                    host.cap_pct = if is_local { 95 } else { 90 };
                    host.max_slots = if is_local { 2 } else { 1 };
                }
            }
            let updated = host.clone();
            guard.append_journal_and_emit(
                None,
                "runq coordinator",
                "decision",
                &format!("Set {} mode to {:?}", updated.hostname, updated.mode),
            );
            guard.broadcast_fleet();
            RpcResponse::Host { host: updated }
        }
        ClientMsg::InspectSession { session_id } => {
            let (session, todos, recent_journal, maybe_pty, stored_tail) = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(session) = guard.sessions.get(&session_id).cloned() else {
                    return RpcResponse::Error {
                        code: "NOT_FOUND".into(),
                        message: format!("session {session_id} not found"),
                    };
                };
                let todos = guard.store.list_todos(&session_id).unwrap_or_default();
                let recent_journal = guard
                    .store
                    .list_journal(Some(&session_id), 20)
                    .unwrap_or_default();
                let maybe_pty = guard.live_ptys.get(&session_id).cloned();
                let stored_tail = if maybe_pty.is_none() {
                    guard
                        .store
                        .load_scrollback_tail(&session_id)
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                (session, todos, recent_journal, maybe_pty, stored_tail)
            };

            let scrollback_tail = if let Some(pty) = maybe_pty {
                tokio::task::spawn_blocking(move || pty.extract_tail_lines(200))
                    .await
                    .unwrap_or_default()
            } else {
                stored_tail
            };

            RpcResponse::Inspection {
                inspection: SessionInspection {
                    session,
                    todos,
                    recent_journal,
                    scrollback_tail,
                },
            }
        }
        ClientMsg::UpdateSessionState {
            session_id,
            state: new_state,
            checkpoint,
            prompt,
        } => {
            if new_state == AgentState::Hibernated {
                return RpcResponse::Error {
                    code: "USE_HIBERNATE".into(),
                    message: "use HibernateSession to transition a session to Hibernated".into(),
                };
            }
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut updated) = guard.sessions.get(&session_id).cloned() else {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            };
            if !guard.live_ptys.contains_key(&session_id) {
                return RpcResponse::Error {
                    code: "NOT_LIVE".into(),
                    message: format!("cannot set live state on hibernated session {session_id}"),
                };
            }
            updated.state = new_state;
            if let Some(cp) = checkpoint {
                updated.checkpoint = cp;
            }
            updated.prompt = prompt.clone();
            updated.updated_at_ms = now_ms();
            if let Err(e) = guard.store.upsert_session(&updated) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.sessions.insert(session_id.clone(), updated.clone());
            if let Some(p) = prompt {
                let _ = guard.events_tx.send(DaemonEvent::PromptRaised {
                    session_id,
                    prompt: p,
                });
            }
            guard.broadcast_fleet();
            RpcResponse::Session { session: updated }
        }
        ClientMsg::UpdateTodos { session_id, todos } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            if !guard.sessions.contains_key(&session_id) {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            }
            if let Err(e) = guard.store.replace_todos(&session_id, &todos) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.broadcast_fleet();
            RpcResponse::Ok
        }
        ClientMsg::UpdateFlow {
            session_id,
            phase,
            phases,
        } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut updated) = guard.sessions.get(&session_id).cloned() else {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            };
            updated.phase = phase;
            if let Some(ps) = phases
                && !ps.is_empty()
            {
                updated.phases = ps;
            }
            updated.updated_at_ms = now_ms();
            if let Err(e) = guard.store.upsert_session(&updated) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.sessions.insert(session_id, updated.clone());
            guard.broadcast_fleet();
            RpcResponse::Session { session: updated }
        }
        ClientMsg::UpdateCheckpoint {
            session_id,
            checkpoint,
        } => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(mut updated) = guard.sessions.get(&session_id).cloned() else {
                return RpcResponse::Error {
                    code: "NOT_FOUND".into(),
                    message: format!("session {session_id} not found"),
                };
            };
            updated.checkpoint = checkpoint;
            updated.updated_at_ms = now_ms();
            if let Err(e) = guard.store.upsert_session(&updated) {
                return RpcResponse::Error {
                    code: "STORE_ERROR".into(),
                    message: format!("{e:#}"),
                };
            }
            guard.sessions.insert(session_id, updated.clone());
            guard.broadcast_fleet();
            RpcResponse::Session { session: updated }
        }
    }
}

pub struct DaemonHandle {
    pub socket_path: PathBuf,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
    state: Arc<Mutex<DaemonState>>,
}

impl DaemonHandle {
    pub fn live_pty_pids(&self) -> Vec<u32> {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.live_ptys.values().filter_map(|p| p.pid()).collect()
    }

    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(j) = self.join.take() {
            let _ = j.await;
        }
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Verifies parent directory is owned by current euid with strict `0700` permissions
/// (never a symlink) and refuses to unlink a live socket or non-socket file.
fn prepare_secure_socket_path(socket_path: &Path) -> Result<()> {
    let parent = socket_path
        .parent()
        .context("socket path must have a parent directory")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .with_context(|| format!("create socket dir {}", parent.display()))?;

    let meta = std::fs::symlink_metadata(parent)
        .with_context(|| format!("stat socket dir {}", parent.display()))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
        bail!("socket parent {} must be a real directory", parent.display());
    }
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        bail!(
            "socket parent {} is owned by uid {}, expected {}",
            parent.display(),
            meta.uid(),
            euid
        );
    }
    if (meta.mode() & 0o777) != 0o700 {
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("enforce 0700 on {}", parent.display()))?;
    }

    if let Ok(sock_meta) = std::fs::symlink_metadata(socket_path) {
        if !sock_meta.file_type().is_socket() {
            bail!(
                "refusing to unlink non-socket path {}",
                socket_path.display()
            );
        }
        if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
            bail!(
                "another iron-agentd is already listening on {}",
                socket_path.display()
            );
        }
        std::fs::remove_file(socket_path)
            .with_context(|| format!("remove stale socket {}", socket_path.display()))?;
    }
    Ok(())
}

pub async fn start_daemon(config: DaemonConfig) -> Result<DaemonHandle> {
    prepare_secure_socket_path(&config.socket_path)?;

    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("bind unix socket {}", config.socket_path.display()))?;
    std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 0600 {}", config.socket_path.display()))?;

    let store = StateStore::open(&config.db_path)?;
    let (signal_tx, mut signal_rx) = mpsc::channel(256);
    let (events_tx, _) = broadcast::channel(256);
    let shutdown_notify = Arc::new(Notify::new());

    let socket_path = config.socket_path.clone();
    let state = Arc::new(Mutex::new(DaemonState::new(
        config, store, signal_tx, events_tx,
    )?));

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let state_loop = Arc::clone(&state);
    let sock_cleanup = socket_path.clone();
    let notify_loop = Arc::clone(&shutdown_notify);

    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                Some(sig) = signal_rx.recv() => {
                    let removed_pty = {
                        let mut guard = state_loop.lock().unwrap_or_else(|e| e.into_inner());
                        guard.handle_pty_signal(sig)
                    };
                    if let Some(pty) = removed_pty {
                        tokio::task::spawn_blocking(move || pty.terminate_and_reap());
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let st = Arc::clone(&state_loop);
                            let sn = Arc::clone(&notify_loop);
                            tokio::spawn(async move {
                                let _ = serve_client(stream, st, sn).await;
                            });
                        }
                        Err(_) => {
                            // Transient accept errors (e.g. ECONNABORTED/EMFILE) must not kill live PTYs.
                            tokio::time::sleep(Duration::from_millis(25)).await;
                        }
                    }
                }
            }
        }
        drop(signal_rx);
        notify_loop.notify_waiters();
        let drained = {
            let mut guard = state_loop.lock().unwrap_or_else(|e| e.into_inner());
            guard.drain_all_ptys()
        };
        let tails = tokio::task::spawn_blocking(move || {
            let mut out = Vec::with_capacity(drained.len());
            for (sid, pty) in drained {
                let tail = pty.extract_tail_lines(500);
                pty.terminate_and_reap();
                out.push((sid, tail));
            }
            out
        })
        .await
        .unwrap_or_default();

        {
            let guard = state_loop.lock().unwrap_or_else(|e| e.into_inner());
            for (sid, tail) in tails {
                if !tail.is_empty() {
                    let _ = guard.store.save_scrollback_tail(&sid, &tail);
                }
            }
        }
        let _ = std::fs::remove_file(&sock_cleanup);
    });

    Ok(DaemonHandle {
        socket_path,
        shutdown_tx: Some(shutdown_tx),
        join: Some(join),
        state,
    })
}

fn try_pop_frame(buf: &mut Vec<u8>) -> Result<Option<RpcRequest>> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        bail!("invalid frame length {len}");
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let req: RpcRequest = decode_frame(&buf[4..4 + len])?;
    buf.drain(..4 + len);
    Ok(Some(req))
}

async fn write_frame_async(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    frame: &ServerFrame,
) -> Result<()> {
    let encoded = encode_frame(frame)?;
    writer.write_all(&encoded).await?;
    writer.flush().await?;
    Ok(())
}

async fn serve_client(
    stream: UnixStream,
    state: Arc<Mutex<DaemonState>>,
    shutdown_notify: Arc<Notify>,
) -> Result<()> {
    let client_id = CLIENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut events_rx = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.events_tx.subscribe()
    };
    let (mut reader, mut writer) = stream.into_split();
    let mut read_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut scratch = [0u8; 4096];

    let result = 'client_loop: loop {
        // Drain any already-buffered complete frames before waiting for more socket bytes.
        while let Some(rpc) = match try_pop_frame(&mut read_buf) {
            Ok(v) => v,
            Err(e) => {
                let _ = write_frame_async(
                    &mut writer,
                    &ServerFrame::Response {
                        id: 0,
                        response: Box::new(RpcResponse::Error {
                            code: "BAD_FRAME".into(),
                            message: format!("{e}"),
                        }),
                    },
                )
                .await;
                break 'client_loop Err(e);
            }
        } {
            let response = dispatch_request(&state, client_id, rpc.msg).await;
            if let Err(e) = write_frame_async(
                &mut writer,
                &ServerFrame::Response {
                    id: rpc.id,
                    response: Box::new(response),
                },
            )
            .await
            {
                break 'client_loop Err(e);
            }
        }

        tokio::select! {
            _ = shutdown_notify.notified() => break Ok(()),
            // Cancel-safe: `reader.read` either reads bytes into `scratch` or reads nothing.
            read_res = reader.read(&mut scratch) => {
                match read_res {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        read_buf.extend_from_slice(&scratch[..n]);
                        if read_buf.len() > MAX_FRAME_BYTES + 4 + scratch.len() {
                            break Err(anyhow::anyhow!("client exceeded MAX_FRAME_BYTES buffer"));
                        }
                    }
                    Err(e) => break Err(e.into()),
                }
            }
            ev = events_rx.recv() => {
                match ev {
                    Ok(event) => {
                        if let DaemonEvent::GridDelta { ref snapshot } = event {
                            let attached = {
                                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                                guard.is_client_attached_to(client_id, &snapshot.session_id)
                            };
                            if !attached {
                                continue;
                            }
                        }
                        if let Err(e) = write_frame_async(&mut writer, &ServerFrame::Event { event }).await {
                            break Err(e);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break Ok(()),
                }
            }
        }
    };

    let changed = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let changed = guard.detach_client_all(client_id);
        if changed {
            guard.broadcast_fleet();
        }
        changed
    };
    let _ = changed;

    result
}

/// Resolves branch name for both normal repositories (`.git/HEAD`) and git worktrees
/// (`.git` file pointing to `gitdir: <path>`).
fn detect_git_branch(dir: &str) -> Option<String> {
    let dot_git = PathBuf::from(dir).join(".git");
    let head_path = if dot_git.is_dir() {
        dot_git.join("HEAD")
    } else if dot_git.is_file() {
        let content = std::fs::read_to_string(&dot_git).ok()?;
        let gitdir = content.trim().strip_prefix("gitdir:")?.trim();
        let resolved = PathBuf::from(gitdir);
        let base = if resolved.is_absolute() {
            resolved
        } else {
            PathBuf::from(dir).join(resolved)
        };
        base.join("HEAD")
    } else {
        return None;
    };

    let head = std::fs::read_to_string(head_path).ok()?;
    let trimmed = head.trim();
    if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
        Some(rest.to_string())
    } else {
        Some(trimmed.chars().take(10).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn single_host_daemon_state_has_no_hardcoded_personal_hosts() {
        let dir = TempDir::new().unwrap();
        let store = StateStore::open(&dir.path().join("state.db")).unwrap();
        let (signal_tx, _signal_rx) = mpsc::channel(8);
        let (events_tx, _) = broadcast::channel(8);
        let cfg = DaemonConfig {
            socket_path: dir.path().join("agentd.sock"),
            db_path: dir.path().join("state.db"),
            host_id: "fedora-workstation".into(),
            hostname: "fedora-workstation".into(),
            peer_hosts: Vec::new(),
        };
        let state = DaemonState::new(cfg, store, signal_tx, events_tx).unwrap();
        assert_eq!(state.hosts.len(), 1);
        let host = state
            .hosts
            .get("fedora-workstation")
            .expect("local host present");
        assert_eq!(host.hostname, "fedora-workstation");
        assert_eq!(host.mode, HostMode::Free);
        assert_eq!(host.cap_pct, 95);
        assert_eq!(host.max_slots, 2);
        assert!(!state.hosts.contains_key("desktop"));
        assert!(!state.hosts.contains_key("laptop"));
        assert!(
            state
                .hosts
                .values()
                .all(|h| h.hostname != "desktop-exo" && h.hostname != "ariel")
        );
    }

    #[test]
    fn peer_hosts_env_and_json_parse_dedup_and_skip_local_host() {
        let env_peers = parse_peer_hosts_env(
            " node-b=build-02:free , node-c:off , node-b=override-02:shared , , =only-hostname ",
        );
        assert_eq!(env_peers.len(), 2);
        assert_eq!(env_peers[0].id, "node-b");
        assert_eq!(env_peers[0].hostname.as_deref(), Some("override-02"));
        assert_eq!(env_peers[0].mode, Some(HostMode::Shared));
        assert_eq!(env_peers[1].id, "node-c");
        assert_eq!(env_peers[1].hostname, None);
        assert_eq!(env_peers[1].mode, Some(HostMode::Off));

        let json_peers = parse_peer_hosts_json(
            r#"{
                "hosts": [
                    { "id": "desktop", "hostname": "desktop-exo", "mode": "free", "cap_pct": 95, "max_slots": 2 },
                    { "id": "laptop", "hostname": "ariel", "mode": "shared" }
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(json_peers.len(), 2);
        assert_eq!(json_peers[0].id, "desktop");
        assert_eq!(json_peers[1].id, "laptop");
        assert_eq!(json_peers[1].hostname.as_deref(), Some("ariel"));

        let dir = TempDir::new().unwrap();
        let store = StateStore::open(&dir.path().join("state.db")).unwrap();
        let (signal_tx, _signal_rx) = mpsc::channel(8);
        let (events_tx, _) = broadcast::channel(8);
        let cfg = DaemonConfig {
            socket_path: dir.path().join("agentd.sock"),
            db_path: dir.path().join("state.db"),
            host_id: "desktop".into(),
            hostname: "desktop-exo".into(),
            peer_hosts: json_peers,
        };
        let state = DaemonState::new(cfg, store, signal_tx, events_tx).unwrap();
        assert_eq!(state.hosts.len(), 2);
        assert_eq!(state.hosts["desktop"].hostname, "desktop-exo");
        assert_eq!(state.hosts["laptop"].hostname, "ariel");
        assert_eq!(state.hosts["laptop"].mode, HostMode::Shared);
        assert_eq!(state.hosts["laptop"].cap_pct, 50);
    }

    #[tokio::test]
    async fn set_host_mode_free_grants_primary_capacity_to_configured_local_host() {
        let dir = TempDir::new().unwrap();
        let cfg = DaemonConfig {
            socket_path: dir.path().join("agentd.sock"),
            db_path: dir.path().join("state.db"),
            host_id: "arch-dev".into(),
            hostname: "arch-dev".into(),
            peer_hosts: vec![PeerHostConfig::new("worker-02")],
        };
        let store = StateStore::open(&cfg.db_path).unwrap();
        let (signal_tx, _signal_rx) = mpsc::channel(8);
        let (events_tx, _) = broadcast::channel(8);
        let state = Arc::new(Mutex::new(
            DaemonState::new(cfg, store, signal_tx, events_tx).unwrap(),
        ));

        match dispatch_request(
            &state,
            1,
            ClientMsg::SetHostMode {
                host_id: "arch-dev".into(),
                mode: HostMode::Shared,
            },
        )
        .await
        {
            RpcResponse::Host { host } => {
                assert_eq!(host.cap_pct, 50);
                assert_eq!(host.max_slots, 1);
            }
            other => panic!("expected Host response, got {other:?}"),
        }

        match dispatch_request(
            &state,
            1,
            ClientMsg::SetHostMode {
                host_id: "arch-dev".into(),
                mode: HostMode::Free,
            },
        )
        .await
        {
            RpcResponse::Host { host } => {
                assert_eq!(host.cap_pct, 95);
                assert_eq!(host.max_slots, 2);
            }
            other => panic!("expected Host response, got {other:?}"),
        }

        match dispatch_request(
            &state,
            1,
            ClientMsg::SetHostMode {
                host_id: "worker-02".into(),
                mode: HostMode::Free,
            },
        )
        .await
        {
            RpcResponse::Host { host } => {
                assert_eq!(host.cap_pct, 90);
                assert_eq!(host.max_slots, 1);
            }
            other => panic!("expected Host response, got {other:?}"),
        }
    }
}
