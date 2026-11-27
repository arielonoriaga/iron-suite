use std::time::Duration;

use iron_agentd::{DaemonConfig, start_daemon};
use iron_proto::{
    AgentState, ClientMsg, DaemonEvent, HostMode, MAX_FRAME_BYTES, PromptAction, PromptKind,
    RpcRequest, RpcResponse, ServerFrame, StructuredPrompt, TodoItem, TodoStatus, decode_frame,
    encode_frame,
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

struct TestClient {
    stream: UnixStream,
    next_id: u64,
    buffered_events: Vec<DaemonEvent>,
}

impl TestClient {
    async fn connect(socket: &std::path::Path) -> Self {
        let stream = timeout(Duration::from_secs(5), UnixStream::connect(socket))
            .await
            .expect("connect timeout")
            .expect("connect unix socket");
        Self {
            stream,
            next_id: 1,
            buffered_events: Vec::new(),
        }
    }

    async fn call(&mut self, msg: ClientMsg) -> RpcResponse {
        let id = self.next_id;
        self.next_id += 1;
        let encoded = encode_frame(&RpcRequest { id, msg }).expect("encode request");
        timeout(Duration::from_secs(5), self.stream.write_all(&encoded))
            .await
            .expect("write timeout")
            .expect("write request");

        timeout(Duration::from_secs(10), async {
            loop {
                match self.read_frame().await {
                    ServerFrame::Response {
                        id: resp_id,
                        response,
                    } if resp_id == id => return *response,
                    ServerFrame::Event { event } => self.buffered_events.push(event),
                    ServerFrame::Response { .. } => {}
                }
            }
        })
        .await
        .expect("rpc response timeout")
    }

    async fn read_frame(&mut self) -> ServerFrame {
        let mut len_buf = [0u8; 4];
        self.stream
            .read_exact(&mut len_buf)
            .await
            .expect("read frame len");
        let len = u32::from_le_bytes(len_buf) as usize;
        assert!(len > 0 && len <= MAX_FRAME_BYTES);
        let mut body = vec![0u8; len];
        self.stream
            .read_exact(&mut body)
            .await
            .expect("read frame body");
        decode_frame(&body).expect("decode server frame")
    }

    async fn wait_for_grid_containing(&mut self, session_id: &str, needle: &str) -> String {
        timeout(Duration::from_secs(10), async {
            for ev in self.buffered_events.drain(..) {
                if let DaemonEvent::GridDelta { snapshot } = ev
                    && snapshot.session_id == session_id
                {
                    let joined = snapshot
                        .lines
                        .iter()
                        .map(|r| r.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if joined.contains(needle) {
                        return joined;
                    }
                }
            }
            loop {
                if let ServerFrame::Event {
                    event: DaemonEvent::GridDelta { snapshot },
                } = self.read_frame().await
                    && snapshot.session_id == session_id
                {
                    let joined = snapshot
                        .lines
                        .iter()
                        .map(|r| r.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if joined.contains(needle) {
                        return joined;
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for '{needle}' in PTY {session_id}"))
    }
}

fn temp_config(dir: &TempDir) -> DaemonConfig {
    DaemonConfig {
        socket_path: dir.path().join("agentd.sock"),
        db_path: dir.path().join("state.db"),
        host_id: "desktop".into(),
        hostname: "desktop-exo".into(),
    }
}

#[tokio::test]
async fn twenty_sessions_hibernate_fifteen_zero_pids_and_wake_intact() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(temp_config(&dir)).await.unwrap();
    let mut client = TestClient::connect(&daemon.socket_path).await;

    let mut ids = Vec::new();
    for i in 0..20 {
        let resp = client
            .call(ClientMsg::SpawnSession {
                title: format!("proj · agent-{i}"),
                host_id: Some("desktop".into()),
                project: "iron-term".into(),
                worktree_path: dir.path().to_string_lossy().into_owned(),
                cli: "shell".into(),
                command: vec!["/bin/sh".into(), "-c".into(), "echo READY_SESSION; sleep 30".into()],
                pinned_host: None,
                pin_reason: None,
                resume_cmd: Some("echo RESUMED_OK; sleep 30".into()),
            })
            .await;
        match resp {
            RpcResponse::Session { session } => ids.push(session.id),
            other => panic!("unexpected spawn response: {other:?}"),
        }
    }

    assert_eq!(daemon.live_pty_pids().len(), 20);

    // Attach ONLY 1 session — the other 19 stay headless (0 GPU overhead).
    match client
        .call(ClientMsg::AttachPty {
            session_id: ids[0].clone(),
            cols: 80,
            rows: 24,
        })
        .await
    {
        RpcResponse::Attached { .. } => {}
        other => panic!("expected Attached, got {other:?}"),
    }

    match client.call(ClientMsg::ListFleet).await {
        RpcResponse::Fleet { overhead, .. } => {
            assert_eq!(overhead.rendered_ptys, 1);
            assert_eq!(overhead.headless_live, 19);
            assert_eq!(overhead.hibernated, 0);
        }
        other => panic!("expected Fleet, got {other:?}"),
    }

    // Hibernate 15 sessions -> must reap child PIDs immediately and persist checkpoints.
    for (idx, sid) in ids.iter().enumerate().skip(5) {
        match client
            .call(ClientMsg::HibernateSession {
                session_id: sid.clone(),
                checkpoint: Some(format!("hibernated checkpoint #{idx}")),
            })
            .await
        {
            RpcResponse::Session { session } => {
                assert_eq!(session.state, AgentState::Hibernated);
                assert_eq!(session.ram_mb, 0);
                assert_eq!(session.checkpoint, format!("hibernated checkpoint #{idx}"));
            }
            other => panic!("expected hibernated Session, got {other:?}"),
        }
    }

    assert_eq!(daemon.live_pty_pids().len(), 5);

    match client.call(ClientMsg::ListFleet).await {
        RpcResponse::Fleet { overhead, .. } => {
            assert_eq!(overhead.rendered_ptys, 1);
            assert_eq!(overhead.headless_live, 4);
            assert_eq!(overhead.hibernated, 15);
        }
        other => panic!("expected Fleet, got {other:?}"),
    }

    // Wake one hibernated session and confirm live PTY output via alacritty_terminal.
    let wake_id = ids[10].clone();
    match client
        .call(ClientMsg::WakeSession {
            session_id: wake_id.clone(),
            rebase_onto_main: true,
        })
        .await
    {
        RpcResponse::Session { session } => {
            assert_eq!(session.state, AgentState::Running);
            assert!(session.ram_mb > 0);
        }
        other => panic!("expected woken Session, got {other:?}"),
    }

    match client
        .call(ClientMsg::AttachPty {
            session_id: wake_id.clone(),
            cols: 80,
            rows: 24,
        })
        .await
    {
        RpcResponse::Attached { snapshot } => {
            let text = snapshot
                .lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !text.contains("RESUMED_OK") {
                let live_text = client.wait_for_grid_containing(&wake_id, "RESUMED_OK").await;
                assert!(live_text.contains("RESUMED_OK"));
            }
        }
        other => panic!("expected Attached after wake, got {other:?}"),
    }

    daemon.shutdown().await;
}

#[tokio::test]
async fn osc_7770_updates_checkpoint_without_leaking_to_terminal_grid() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(temp_config(&dir)).await.unwrap();
    let mut client = TestClient::connect(&daemon.socket_path).await;

    let cmd = r#"printf 'VISIBLE_START\033]7770;{"event":"checkpoint","text":"osc-verified"}\007VISIBLE_END\n'; sleep 30"#;
    let sid = match client
        .call(ClientMsg::SpawnSession {
            title: "iron-term · osc-test".into(),
            host_id: Some("desktop".into()),
            project: "iron-term".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            cli: "shell".into(),
            command: vec!["/bin/sh".into(), "-c".into(), cmd.into()],
            pinned_host: None,
            pin_reason: None,
            resume_cmd: None,
        })
        .await
    {
        RpcResponse::Session { session } => session.id,
        other => panic!("unexpected spawn: {other:?}"),
    };

    let attached = client
        .call(ClientMsg::AttachPty {
            session_id: sid.clone(),
            cols: 100,
            rows: 24,
        })
        .await;
    let initial = match attached {
        RpcResponse::Attached { snapshot } => snapshot
            .lines
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        other => panic!("expected Attached, got {other:?}"),
    };

    let rendered = if initial.contains("VISIBLE_END") {
        initial
    } else {
        client.wait_for_grid_containing(&sid, "VISIBLE_END").await
    };
    assert!(rendered.contains("VISIBLE_STARTVISIBLE_END"), "got: {rendered}");
    assert!(!rendered.contains("7770"), "OSC leaked into VT grid: {rendered}");

    // Poll bounded until daemon applies the OSC checkpoint to SQLite/session state.
    timeout(Duration::from_secs(5), async {
        loop {
            if let RpcResponse::Inspection { inspection } = client
                .call(ClientMsg::InspectSession {
                    session_id: sid.clone(),
                })
                .await
                && inspection.session.checkpoint == "osc-verified"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed out waiting for OSC 7770 checkpoint update");

    daemon.shutdown().await;
}

#[tokio::test]
async fn enforces_host_invariants_guardrail_resolution_and_restart_recovery() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let daemon = start_daemon(cfg.clone()).await.unwrap();
    let mut client = TestClient::connect(&daemon.socket_path).await;

    let pinned_id = match client
        .call(ClientMsg::SpawnSession {
            title: "ez-commerce · cash-shift-be".into(),
            host_id: Some("desktop".into()),
            project: "ez-commerce".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            cli: "agy".into(),
            command: vec!["/bin/sh".into(), "-c".into(), "cat".into()],
            pinned_host: Some("desktop".into()),
            pin_reason: Some("Needs local Postgres on desktop".into()),
            resume_cmd: None,
        })
        .await
    {
        RpcResponse::Session { session } => session.id,
        other => panic!("unexpected spawn: {other:?}"),
    };

    // Moving pinned session to laptop fails closed with exact reason.
    match client
        .call(ClientMsg::MoveSessionHost {
            session_id: pinned_id.clone(),
            target_host_id: "laptop".into(),
        })
        .await
    {
        RpcResponse::MoveBlocked { reason } => {
            assert_eq!(reason, "Needs local Postgres on desktop");
        }
        other => panic!("expected MoveBlocked, got {other:?}"),
    }

    // Spawn an unpinned session, switch laptop OFF -> move must be blocked; switch Shared -> allowed.
    let unpinned_id = match client
        .call(ClientMsg::SpawnSession {
            title: "iron-suite · alias-fix".into(),
            host_id: Some("desktop".into()),
            project: "iron-suite".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            cli: "claude".into(),
            command: vec!["/bin/sh".into(), "-c".into(), "echo ALIAS_TAIL; sleep 30".into()],
            pinned_host: None,
            pin_reason: None,
            resume_cmd: None,
        })
        .await
    {
        RpcResponse::Session { session } => session.id,
        other => panic!("unexpected spawn: {other:?}"),
    };

    client
        .call(ClientMsg::SetHostMode {
            host_id: "laptop".into(),
            mode: HostMode::Off,
        })
        .await;

    match client
        .call(ClientMsg::MoveSessionHost {
            session_id: unpinned_id.clone(),
            target_host_id: "laptop".into(),
        })
        .await
    {
        RpcResponse::MoveBlocked { reason } => assert!(reason.contains("OFF")),
        other => panic!("expected MoveBlocked when laptop OFF, got {other:?}"),
    }

    client
        .call(ClientMsg::SetHostMode {
            host_id: "laptop".into(),
            mode: HostMode::Shared,
        })
        .await;

    match client
        .call(ClientMsg::MoveSessionHost {
            session_id: unpinned_id.clone(),
            target_host_id: "laptop".into(),
        })
        .await
    {
        RpcResponse::Session { session } => assert_eq!(session.host_id, "laptop"),
        other => panic!("expected moved Session, got {other:?}"),
    }

    // Raise guardrail prompt & resolve with primary Fix-Before-Destroy action sending input into PTY.
    client
        .call(ClientMsg::AttachPty {
            session_id: pinned_id.clone(),
            cols: 80,
            rows: 24,
        })
        .await;

    client
        .call(ClientMsg::UpdateSessionState {
            session_id: pinned_id.clone(),
            state: AgentState::NeedsApproval,
            checkpoint: Some("Guardrail blocked raw cargo test".into()),
            prompt: Some(StructuredPrompt {
                kind: PromptKind::Guardrail,
                title: "Guardrail blocked raw cargo test".into(),
                description: "Route through runq".into(),
                command: "cargo test".into(),
                actions: vec![PromptAction {
                    id: "runq".into(),
                    label: "Run via runq".into(),
                    command_to_send: Some("RUNQ_ROUTED_OK".into()),
                    is_primary: true,
                    is_destructive: false,
                }],
            }),
        })
        .await;

    client
        .call(ClientMsg::UpdateTodos {
            session_id: pinned_id.clone(),
            todos: vec![TodoItem {
                text: "Verify runq fix".into(),
                status: TodoStatus::Active,
            }],
        })
        .await;

    match client
        .call(ClientMsg::ResolvePrompt {
            session_id: pinned_id.clone(),
            action_id: "runq".into(),
            custom_reply: None,
        })
        .await
    {
        RpcResponse::Session { session } => {
            assert_eq!(session.state, AgentState::Running);
            assert!(session.prompt.is_none());
        }
        other => panic!("expected Running after resolve, got {other:?}"),
    }

    let pty_text = client
        .wait_for_grid_containing(&pinned_id, "RUNQ_ROUTED_OK")
        .await;
    assert!(pty_text.contains("RUNQ_ROUTED_OK"));

    // Drop client -> verify detach cleanup and restart daemon on same SQLite DB.
    drop(client);
    daemon.shutdown().await;

    let daemon2 = start_daemon(cfg).await.unwrap();
    let mut client2 = TestClient::connect(&daemon2.socket_path).await;
    match client2.call(ClientMsg::ListFleet).await {
        RpcResponse::Fleet {
            sessions, overhead, ..
        } => {
            assert_eq!(sessions.len(), 2);
            assert_eq!(overhead.hibernated, 2);
            assert_eq!(overhead.rendered_ptys, 0);
            assert_eq!(overhead.total_live_ram_mb, 0);
        }
        other => panic!("expected Fleet after restart, got {other:?}"),
    }
    match client2
        .call(ClientMsg::InspectSession {
            session_id: pinned_id,
        })
        .await
    {
        RpcResponse::Inspection { inspection } => {
            assert_eq!(inspection.todos.len(), 1);
            assert!(
                inspection
                    .scrollback_tail
                    .iter()
                    .any(|l| l.contains("RUNQ_ROUTED_OK")),
                "expected persisted scrollback tail after shutdown, got {:?}",
                inspection.scrollback_tail
            );
        }
        other => panic!("expected Inspection after restart, got {other:?}"),
    }

    daemon2.shutdown().await;
}

#[tokio::test]
async fn hibernate_reaps_grandchild_process_group_without_deadlock() {
    let dir = TempDir::new().unwrap();
    let pid_file = dir.path().join("grandchild.pid");
    let daemon = start_daemon(temp_config(&dir)).await.unwrap();
    let mut client = TestClient::connect(&daemon.socket_path).await;

    let script = format!(
        "sleep 60 & echo $! > '{}'; echo GRANDCHILD_READY; wait",
        pid_file.display()
    );
    let sid = match client
        .call(ClientMsg::SpawnSession {
            title: "iron-term · pgid-reap".into(),
            host_id: Some("desktop".into()),
            project: "iron-term".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            cli: "shell".into(),
            command: vec!["/bin/sh".into(), "-c".into(), script],
            pinned_host: None,
            pin_reason: None,
            resume_cmd: None,
        })
        .await
    {
        RpcResponse::Session { session } => session.id,
        other => panic!("unexpected spawn: {other:?}"),
    };

    let grandchild_pid: i32 = timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(raw) = std::fs::read_to_string(&pid_file)
                && let Ok(pid) = raw.trim().parse::<i32>()
                && pid > 1
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("grandchild pid file written");

    // Verify grandchild is alive before hibernation.
    assert_eq!(unsafe { libc::kill(grandchild_pid, 0) }, 0);

    // Hibernating must kill the entire process group (-pgid) and return rapidly.
    let resp = timeout(
        Duration::from_secs(5),
        client.call(ClientMsg::HibernateSession {
            session_id: sid,
            checkpoint: Some("reaped".into()),
        }),
    )
    .await
    .expect("hibernate must not deadlock on grandchild holding slave fd");
    assert!(matches!(resp, RpcResponse::Session { .. }));

    // Confirm OS-level PID is gone (ESRCH) within brief kernel reap window.
    timeout(Duration::from_secs(3), async {
        loop {
            let rc = unsafe { libc::kill(grandchild_pid, 0) };
            if rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("grandchild PID still alive after hibernate");

    daemon.shutdown().await;
}

#[tokio::test]
async fn cancel_safe_partial_frame_survives_concurrent_events() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(temp_config(&dir)).await.unwrap();

    let mut raw_stream = UnixStream::connect(&daemon.socket_path).await.unwrap();
    let mut other = TestClient::connect(&daemon.socket_path).await;

    let frame = encode_frame(&RpcRequest {
        id: 77,
        msg: ClientMsg::Ping,
    })
    .unwrap();

    // Send only the first 2 bytes of the length header, then flood FleetDelta events from `other`.
    raw_stream.write_all(&frame[..2]).await.unwrap();
    for _ in 0..5 {
        other
            .call(ClientMsg::SetHostMode {
                host_id: "laptop".into(),
                mode: HostMode::Shared,
            })
            .await;
    }
    tokio::time::sleep(Duration::from_millis(60)).await;

    // Finish sending the split frame; daemon must decode id=77 cleanly without framing corruption.
    raw_stream.write_all(&frame[2..]).await.unwrap();

    let mut client = TestClient {
        stream: raw_stream,
        next_id: 78,
        buffered_events: Vec::new(),
    };
    timeout(Duration::from_secs(5), async {
        loop {
            match client.read_frame().await {
                ServerFrame::Response { id: 77, response } => {
                    assert!(matches!(*response, RpcResponse::Pong { .. }));
                    break;
                }
                _ => continue,
            }
        }
    })
    .await
    .expect("expected Pong for split frame");

    daemon.shutdown().await;
}

#[tokio::test]
async fn wake_preserves_structured_argv_and_rejects_unknown_action_and_live_socket_hijack() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let daemon = start_daemon(cfg.clone()).await.unwrap();

    // Verify 0700 parent dir and 0600 socket permissions + refusal to hijack live socket.
    let sock_mode = std::fs::symlink_metadata(&daemon.socket_path)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(sock_mode, 0o600);
    let dir_mode = std::fs::symlink_metadata(daemon.socket_path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir_mode, 0o700);
    assert!(start_daemon(cfg).await.is_err(), "must refuse to hijack live socket");

    let mut c1 = TestClient::connect(&daemon.socket_path).await;
    let mut c2 = TestClient::connect(&daemon.socket_path).await;

    // Structured argv containing shell metacharacters must never be shell-evaluated on wake.
    let sid = match c1
        .call(ClientMsg::SpawnSession {
            title: "iron-term · argv-safe".into(),
            host_id: Some("desktop".into()),
            project: "iron-term".into(),
            worktree_path: dir.path().to_string_lossy().into_owned(),
            cli: "shell".into(),
            command: vec![
                "/bin/sh".into(),
                "-c".into(),
                r#"printf 'ARG=[%s]\n' "$1"; sleep 30"#.into(),
                "_".into(),
                "safe; echo PWNED".into(),
            ],
            pinned_host: None,
            pin_reason: None,
            resume_cmd: None,
        })
        .await
    {
        RpcResponse::Session { session } => session.id,
        other => panic!("unexpected spawn: {other:?}"),
    };

    // Fail-closed ResolvePrompt on unknown action_id + UpdateSessionState(Hibernated).
    c1.call(ClientMsg::UpdateSessionState {
        session_id: sid.clone(),
        state: AgentState::NeedsApproval,
        checkpoint: None,
        prompt: Some(StructuredPrompt {
            kind: PromptKind::Guardrail,
            title: "blocked".into(),
            description: String::new(),
            command: "cargo test".into(),
            actions: vec![PromptAction {
                id: "runq".into(),
                label: "Run via runq".into(),
                command_to_send: None,
                is_primary: true,
                is_destructive: false,
            }],
        }),
    })
    .await;

    match c1
        .call(ClientMsg::ResolvePrompt {
            session_id: sid.clone(),
            action_id: "typo_deny".into(),
            custom_reply: None,
        })
        .await
    {
        RpcResponse::Error { code, .. } => assert_eq!(code, "INVALID_ACTION"),
        other => panic!("expected INVALID_ACTION, got {other:?}"),
    }

    match c1
        .call(ClientMsg::UpdateSessionState {
            session_id: sid.clone(),
            state: AgentState::Hibernated,
            checkpoint: None,
            prompt: None,
        })
        .await
    {
        RpcResponse::Error { code, .. } => assert_eq!(code, "USE_HIBERNATE"),
        other => panic!("expected USE_HIBERNATE, got {other:?}"),
    }

    // Attach c1 + c2, then Hibernate -> Wake -> Re-attach c1; dropping c2 must NOT break c1!
    c1.call(ClientMsg::AttachPty {
        session_id: sid.clone(),
        cols: 80,
        rows: 24,
    })
    .await;
    c2.call(ClientMsg::AttachPty {
        session_id: sid.clone(),
        cols: 80,
        rows: 24,
    })
    .await;
    c1.call(ClientMsg::HibernateSession {
        session_id: sid.clone(),
        checkpoint: None,
    })
    .await;
    c1.call(ClientMsg::WakeSession {
        session_id: sid.clone(),
        rebase_onto_main: false,
    })
    .await;
    let attached = c1
        .call(ClientMsg::AttachPty {
            session_id: sid.clone(),
            cols: 100,
            rows: 24,
        })
        .await;
    drop(c2); // Stale client disconnect must not decrement c1's attachment!

    let initial = match attached {
        RpcResponse::Attached { snapshot } => snapshot
            .lines
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        other => panic!("expected Attached, got {other:?}"),
    };
    let rendered = if initial.contains("ARG=[safe; echo PWNED]") {
        initial
    } else {
        c1.wait_for_grid_containing(&sid, "ARG=[safe; echo PWNED]")
            .await
    };
    assert!(rendered.contains("ARG=[safe; echo PWNED]"), "got: {rendered}");
    assert!(!rendered.lines().any(|l| l.trim() == "PWNED"), "shell injection occurred: {rendered}");

    match c1.call(ClientMsg::ListFleet).await {
        RpcResponse::Fleet { overhead, .. } => assert_eq!(overhead.rendered_ptys, 1),
        other => panic!("expected Fleet, got {other:?}"),
    }

    daemon.shutdown().await;
}
