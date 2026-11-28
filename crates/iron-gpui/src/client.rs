use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;

use anyhow::{Context, Result, bail};
use iron_proto::{
    ClientMsg, DaemonEvent, GridSnapshot, HostMode, HostStatus, MAX_FRAME_BYTES, OverheadStats,
    RpcRequest, RpcResponse, ServerFrame, SessionInspection, SessionSummary, StructuredPrompt,
    decode_frame, encode_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::cli::SpawnMetadata;

/// Commands dispatched from the GPUI main thread to the background daemon bridge.
/// All sends are non-blocking so the GPUI render loop never stalls on socket I/O.
#[derive(Debug)]
pub enum BridgeCommand {
    ListFleet,
    AttachPane {
        pane_slot: usize,
        detach_old: Option<String>,
        session_id: String,
        cols: u16,
        rows: u16,
    },
    DetachSession {
        session_id: String,
    },
    PtyInput {
        session_id: String,
        bytes: Vec<u8>,
    },
    PtyResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    SpawnAndAttach {
        pane_slot: usize,
        detach_old: Option<String>,
        title: String,
        host_id: Option<String>,
        project: String,
        worktree_path: String,
        cli: String,
        command: Vec<String>,
        cols: u16,
        rows: u16,
    },
    ResolvePrompt {
        session_id: String,
        action_id: String,
        custom_reply: Option<String>,
    },
    HibernateSession {
        session_id: String,
        checkpoint: Option<String>,
    },
    WakeAndAttach {
        pane_slot: usize,
        detach_old: Option<String>,
        session_id: String,
        rebase_onto_main: bool,
        cols: u16,
        rows: u16,
    },
    MoveSessionHost {
        session_id: String,
        target_host_id: String,
    },
    SetHostMode {
        host_id: String,
        mode: HostMode,
    },
    InspectSession {
        session_id: String,
    },
    Shutdown,
}

/// Asynchronous events streamed from `iron-agentd` back to the GPUI view.
#[derive(Debug, Clone)]
pub enum BridgeEvent {
    Connected,
    Disconnected(String),
    FleetUpdated {
        hosts: Vec<HostStatus>,
        sessions: Vec<SessionSummary>,
        overhead: OverheadStats,
    },
    GridUpdated(GridSnapshot),
    PaneAttached {
        pane_slot: usize,
        snapshot: GridSnapshot,
    },
    SessionSpawned {
        pane_slot: usize,
        session: SessionSummary,
    },
    PromptRaised {
        session_id: String,
        prompt: StructuredPrompt,
    },
    MoveBlocked {
        session_id: String,
        reason: String,
    },
    InspectionLoaded(SessionInspection),
    Toast {
        message: String,
        is_error: bool,
    },
}

/// Startup policy executed automatically once the first `ListFleet` completes.
#[derive(Debug, Clone)]
pub struct StartupIntent {
    pub force_spawn: bool,
    pub spawn: SpawnMetadata,
    pub initial_cols: u16,
    pub initial_rows: u16,
}

#[derive(Debug)]
enum PendingContext {
    InitialFleet,
    Attach {
        pane_slot: usize,
    },
    SpawnThenAttach {
        pane_slot: usize,
        detach_old: Option<String>,
        cols: u16,
        rows: u16,
    },
    WakeThenAttach {
        pane_slot: usize,
        detach_old: Option<String>,
        cols: u16,
        rows: u16,
    },
    MoveHost {
        session_id: String,
        target_host_id: String,
    },
    HostMode,
    ResolvePrompt,
    Hibernate,
    Inspect,
    Silent,
}

/// Non-blocking handle held by the GPUI root view to communicate with `iron-agentd`.
pub struct DaemonBridge {
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
}

impl DaemonBridge {
    pub fn spawn(
        socket_path: PathBuf,
        startup: StartupIntent,
    ) -> (Self, mpsc::UnboundedReceiver<BridgeEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();

        thread::Builder::new()
            .name("iron-gpui-bridge".to_string())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(err) => {
                        let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                            "failed to start async bridge runtime: {err}"
                        )));
                        return;
                    }
                };
                rt.block_on(run_bridge_loop(socket_path, startup, cmd_rx, ev_tx));
            })
            .expect("spawn iron-gpui-bridge thread");

        (Self { cmd_tx }, ev_rx)
    }

    pub fn send(&self, cmd: BridgeCommand) {
        let _ = self.cmd_tx.send(cmd);
    }
}

impl Drop for DaemonBridge {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(BridgeCommand::Shutdown);
    }
}

/// Cancel-safe frame decoder operating over a persistent byte buffer.
pub fn try_pop_server_frame(buf: &mut Vec<u8>) -> Result<Option<ServerFrame>> {
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
    let frame: ServerFrame = decode_frame(&buf[4..4 + len])?;
    buf.drain(..4 + len);
    Ok(Some(frame))
}

async fn run_bridge_loop(
    socket_path: PathBuf,
    startup: StartupIntent,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    ev_tx: mpsc::UnboundedSender<BridgeEvent>,
) {
    let stream = match UnixStream::connect(&socket_path).await {
        Ok(s) => s,
        Err(err) => {
            let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                "connect to {} failed: {err}",
                socket_path.display()
            )));
            return;
        }
    };

    let _ = ev_tx.send(BridgeEvent::Connected);
    let (mut reader, mut writer) = stream.into_split();

    let mut next_req_id: u64 = 1;
    let mut pending: HashMap<u64, PendingContext> = HashMap::new();
    let mut read_buf: Vec<u8> = Vec::with_capacity(8192);
    let mut scratch = [0u8; 4096];

    // Immediately query fleet state so we can attach or spawn a live prompt like Alacritty.
    if let Err(err) = send_rpc_frame(
        &mut writer,
        &mut next_req_id,
        &mut pending,
        ClientMsg::ListFleet,
        PendingContext::InitialFleet,
    )
    .await
    {
        let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
            "initial ListFleet failed: {err:#}"
        )));
        return;
    }

    'bridge_loop: loop {
        // Drain all complete frames buffered so far before waiting for more socket bytes.
        loop {
            match try_pop_server_frame(&mut read_buf) {
                Ok(Some(server_frame)) => {
                    if let Err(err) = handle_server_frame(
                        server_frame,
                        &startup,
                        &mut writer,
                        &mut next_req_id,
                        &mut pending,
                        &ev_tx,
                    )
                    .await
                    {
                        let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                            "daemon follow-up write failed: {err:#}"
                        )));
                        break 'bridge_loop;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                        "protocol frame error: {err:#}"
                    )));
                    break 'bridge_loop;
                }
            }
        }

        tokio::select! {
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else {
                    break 'bridge_loop;
                };
                if matches!(cmd, BridgeCommand::Shutdown) {
                    break 'bridge_loop;
                }
                if let Err(err) = handle_bridge_command(
                    cmd,
                    &mut writer,
                    &mut next_req_id,
                    &mut pending,
                ).await {
                    let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                        "daemon write failed: {err:#}"
                    )));
                    break 'bridge_loop;
                }
            }
            // Cancel-safe: `reader.read` either yields bytes into `scratch` or yields nothing.
            read_res = reader.read(&mut scratch) => {
                match read_res {
                    Ok(0) => {
                        let _ = ev_tx.send(BridgeEvent::Disconnected(
                            "daemon closed connection".to_string(),
                        ));
                        break 'bridge_loop;
                    }
                    Ok(n) => {
                        read_buf.extend_from_slice(&scratch[..n]);
                        if read_buf.len() > MAX_FRAME_BYTES + 4 + scratch.len() {
                            let _ = ev_tx.send(BridgeEvent::Disconnected(
                                "daemon exceeded MAX_FRAME_BYTES buffer".to_string(),
                            ));
                            break 'bridge_loop;
                        }
                    }
                    Err(err) => {
                        let _ = ev_tx.send(BridgeEvent::Disconnected(format!(
                            "socket read failed: {err}"
                        )));
                        break 'bridge_loop;
                    }
                }
            }
        }
    }
}

async fn send_rpc_frame(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    next_req_id: &mut u64,
    pending: &mut HashMap<u64, PendingContext>,
    msg: ClientMsg,
    ctx: PendingContext,
) -> Result<()> {
    let id = *next_req_id;
    *next_req_id = next_req_id.wrapping_add(1).max(1);
    let encoded = encode_frame(&RpcRequest { id, msg })?;
    writer
        .write_all(&encoded)
        .await
        .context("write RPC frame to UnixStream")?;
    pending.insert(id, ctx);
    Ok(())
}

async fn handle_bridge_command(
    cmd: BridgeCommand,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    next_req_id: &mut u64,
    pending: &mut HashMap<u64, PendingContext>,
) -> Result<()> {
    match cmd {
        BridgeCommand::ListFleet => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::ListFleet,
                PendingContext::Silent,
            )
            .await
        }
        BridgeCommand::AttachPane {
            pane_slot,
            detach_old,
            session_id,
            cols,
            rows,
        } => {
            if let Some(old_id) = detach_old
                && old_id != session_id
            {
                send_rpc_frame(
                    writer,
                    next_req_id,
                    pending,
                    ClientMsg::DetachPty { session_id: old_id },
                    PendingContext::Silent,
                )
                .await?;
            }
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::AttachPty {
                    session_id,
                    cols,
                    rows,
                },
                PendingContext::Attach { pane_slot },
            )
            .await
        }
        BridgeCommand::DetachSession { session_id } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::DetachPty { session_id },
                PendingContext::Silent,
            )
            .await
        }
        BridgeCommand::PtyInput { session_id, bytes } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::PtyInput { session_id, bytes },
                PendingContext::Silent,
            )
            .await
        }
        BridgeCommand::PtyResize {
            session_id,
            cols,
            rows,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::PtyResize {
                    session_id,
                    cols,
                    rows,
                },
                PendingContext::Silent,
            )
            .await
        }
        BridgeCommand::SpawnAndAttach {
            pane_slot,
            detach_old,
            title,
            host_id,
            project,
            worktree_path,
            cli,
            command,
            cols,
            rows,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::SpawnSession {
                    title,
                    host_id,
                    project,
                    worktree_path,
                    cli,
                    command,
                    pinned_host: None,
                    pin_reason: None,
                    resume_cmd: None,
                },
                PendingContext::SpawnThenAttach {
                    pane_slot,
                    detach_old,
                    cols,
                    rows,
                },
            )
            .await
        }
        BridgeCommand::ResolvePrompt {
            session_id,
            action_id,
            custom_reply,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::ResolvePrompt {
                    session_id,
                    action_id,
                    custom_reply,
                },
                PendingContext::ResolvePrompt,
            )
            .await
        }
        BridgeCommand::HibernateSession {
            session_id,
            checkpoint,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::HibernateSession {
                    session_id,
                    checkpoint,
                },
                PendingContext::Hibernate,
            )
            .await
        }
        BridgeCommand::WakeAndAttach {
            pane_slot,
            detach_old,
            session_id,
            rebase_onto_main,
            cols,
            rows,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::WakeSession {
                    session_id,
                    rebase_onto_main,
                },
                PendingContext::WakeThenAttach {
                    pane_slot,
                    detach_old,
                    cols,
                    rows,
                },
            )
            .await
        }
        BridgeCommand::MoveSessionHost {
            session_id,
            target_host_id,
        } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::MoveSessionHost {
                    session_id: session_id.clone(),
                    target_host_id: target_host_id.clone(),
                },
                PendingContext::MoveHost {
                    session_id,
                    target_host_id,
                },
            )
            .await
        }
        BridgeCommand::SetHostMode { host_id, mode } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::SetHostMode { host_id, mode },
                PendingContext::HostMode,
            )
            .await
        }
        BridgeCommand::InspectSession { session_id } => {
            send_rpc_frame(
                writer,
                next_req_id,
                pending,
                ClientMsg::InspectSession { session_id },
                PendingContext::Inspect,
            )
            .await
        }
        BridgeCommand::Shutdown => Ok(()),
    }
}

async fn handle_server_frame(
    frame: ServerFrame,
    startup: &StartupIntent,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    next_req_id: &mut u64,
    pending: &mut HashMap<u64, PendingContext>,
    ev_tx: &mpsc::UnboundedSender<BridgeEvent>,
) -> Result<()> {
    match frame {
        ServerFrame::Event { event } => {
            match event {
                DaemonEvent::FleetDelta {
                    sessions,
                    hosts,
                    overhead,
                } => {
                    let _ = ev_tx.send(BridgeEvent::FleetUpdated {
                        hosts,
                        sessions,
                        overhead,
                    });
                }
                DaemonEvent::GridDelta { snapshot } => {
                    let _ = ev_tx.send(BridgeEvent::GridUpdated(snapshot));
                }
                DaemonEvent::PromptRaised { session_id, prompt } => {
                    let _ = ev_tx.send(BridgeEvent::PromptRaised { session_id, prompt });
                }
                DaemonEvent::JournalAppended { .. } => {}
            }
            Ok(())
        }
        ServerFrame::Response { id, response } => {
            let ctx = pending.remove(&id).unwrap_or(PendingContext::Silent);
            match *response {
                RpcResponse::Fleet {
                    hosts,
                    sessions,
                    overhead,
                } => {
                    let first_live = sessions.iter().find(|s| s.state.is_live()).cloned();
                    let _ = ev_tx.send(BridgeEvent::FleetUpdated {
                        hosts,
                        sessions,
                        overhead,
                    });

                    if matches!(ctx, PendingContext::InitialFleet) {
                        if startup.force_spawn || first_live.is_none() {
                            send_rpc_frame(
                                writer,
                                next_req_id,
                                pending,
                                ClientMsg::SpawnSession {
                                    title: startup.spawn.title.clone(),
                                    host_id: None,
                                    project: startup.spawn.project.clone(),
                                    worktree_path: startup.spawn.worktree_path.clone(),
                                    cli: startup.spawn.cli.clone(),
                                    command: startup.spawn.command.clone(),
                                    pinned_host: None,
                                    pin_reason: None,
                                    resume_cmd: None,
                                },
                                PendingContext::SpawnThenAttach {
                                    pane_slot: 0,
                                    detach_old: None,
                                    cols: startup.initial_cols,
                                    rows: startup.initial_rows,
                                },
                            )
                            .await?;
                        } else if let Some(live) = first_live {
                            send_rpc_frame(
                                writer,
                                next_req_id,
                                pending,
                                ClientMsg::AttachPty {
                                    session_id: live.id,
                                    cols: startup.initial_cols,
                                    rows: startup.initial_rows,
                                },
                                PendingContext::Attach { pane_slot: 0 },
                            )
                            .await?;
                        }
                    }
                }
                RpcResponse::Session { session } => match ctx {
                    PendingContext::SpawnThenAttach {
                        pane_slot,
                        detach_old,
                        cols,
                        rows,
                    }
                    | PendingContext::WakeThenAttach {
                        pane_slot,
                        detach_old,
                        cols,
                        rows,
                    } => {
                        let sid = session.id.clone();
                        let _ = ev_tx.send(BridgeEvent::SessionSpawned { pane_slot, session });
                        if let Some(old_id) = detach_old
                            && old_id != sid
                        {
                            send_rpc_frame(
                                writer,
                                next_req_id,
                                pending,
                                ClientMsg::DetachPty { session_id: old_id },
                                PendingContext::Silent,
                            )
                            .await?;
                        }
                        send_rpc_frame(
                            writer,
                            next_req_id,
                            pending,
                            ClientMsg::AttachPty {
                                session_id: sid,
                                cols,
                                rows,
                            },
                            PendingContext::Attach { pane_slot },
                        )
                        .await?;
                    }
                    PendingContext::MoveHost { target_host_id, .. } => {
                        let _ = ev_tx.send(BridgeEvent::Toast {
                            message: format!("Moved '{}' to @{target_host_id}", session.title),
                            is_error: false,
                        });
                    }
                    PendingContext::ResolvePrompt => {
                        let _ = ev_tx.send(BridgeEvent::Toast {
                            message: format!("Resolved prompt on '{}'", session.title),
                            is_error: false,
                        });
                    }
                    PendingContext::Hibernate => {
                        let _ = ev_tx.send(BridgeEvent::Toast {
                            message: format!("Hibernated '{}' (0 MB RAM)", session.title),
                            is_error: false,
                        });
                    }
                    _ => {}
                },
                RpcResponse::Attached { snapshot } => {
                    let pane_slot = match ctx {
                        PendingContext::Attach { pane_slot } => pane_slot,
                        _ => 0,
                    };
                    let _ = ev_tx.send(BridgeEvent::PaneAttached {
                        pane_slot,
                        snapshot,
                    });
                }
                RpcResponse::MoveBlocked { reason } => {
                    let session_id = match ctx {
                        PendingContext::MoveHost { session_id, .. } => session_id,
                        _ => String::new(),
                    };
                    let _ = ev_tx.send(BridgeEvent::MoveBlocked { session_id, reason });
                }
                RpcResponse::Host { host } => {
                    if matches!(ctx, PendingContext::HostMode) {
                        let _ = ev_tx.send(BridgeEvent::Toast {
                            message: format!("{} mode -> {:?}", host.hostname, host.mode),
                            is_error: false,
                        });
                    }
                }
                RpcResponse::Inspection { inspection } => {
                    let _ = ev_tx.send(BridgeEvent::InspectionLoaded(inspection));
                }
                RpcResponse::Error { code, message } => {
                    if !matches!(ctx, PendingContext::Silent) {
                        let _ = ev_tx.send(BridgeEvent::Toast {
                            message: format!("[{code}] {message}"),
                            is_error: true,
                        });
                    }
                }
                RpcResponse::Pong { .. } | RpcResponse::Ok => {}
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use iron_agentd::{DaemonConfig, start_daemon};
    use iron_proto::{AgentState, GridRow};
    use tokio::net::UnixListener;

    use super::*;

    #[test]
    fn try_pop_server_frame_handles_partial_and_rejects_oversized() {
        let frame = ServerFrame::Response {
            id: 7,
            response: Box::new(RpcResponse::Ok),
        };
        let encoded = encode_frame(&frame).expect("encode");

        // Partial header (2 bytes) -> None without draining.
        let mut buf = encoded[..2].to_vec();
        assert!(try_pop_server_frame(&mut buf).expect("partial header").is_none());
        assert_eq!(buf.len(), 2);

        // Partial body -> None without draining.
        buf.extend_from_slice(&encoded[2..encoded.len() - 1]);
        assert!(try_pop_server_frame(&mut buf).expect("partial body").is_none());

        // Final byte completes frame and drains buffer cleanly.
        buf.push(*encoded.last().unwrap());
        let decoded = try_pop_server_frame(&mut buf)
            .expect("complete")
            .expect("some frame");
        assert!(matches!(decoded, ServerFrame::Response { id: 7, .. }));
        assert!(buf.is_empty());

        // Oversized header fails closed.
        let mut bad = ((MAX_FRAME_BYTES as u32) + 1).to_le_bytes().to_vec();
        assert!(try_pop_server_frame(&mut bad).is_err());
    }

    #[tokio::test]
    async fn cancel_safe_chunked_reads_survive_concurrent_pty_input() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("chunked.sock");
        let listener = UnixListener::bind(&sock).expect("bind mock listener");

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");

            // Read initial ListFleet request.
            let mut len_buf = [0u8; 4];
            stream.read_exact(&mut len_buf).await.expect("read req len");
            let len = u32::from_le_bytes(len_buf) as usize;
            let mut body = vec![0u8; len];
            stream.read_exact(&mut body).await.expect("read req body");
            let req: RpcRequest = decode_frame(&body).expect("decode initial req");
            assert!(matches!(req.msg, ClientMsg::ListFleet));

            // Send Fleet response split mid-header AND mid-body while client blasts PtyInput.
            let live_session = SessionSummary {
                id: "sess-chunk".into(),
                title: "chunk · sh".into(),
                cli: "sh".into(),
                host_id: "desktop".into(),
                project: "chunk".into(),
                worktree_path: "/tmp".into(),
                git_branch: "main".into(),
                git_dirty: false,
                git_behind_main: 0,
                state: AgentState::Running,
                phase: "build".into(),
                phases: vec!["build".into()],
                ram_mb: 3,
                pinned_host: None,
                pin_reason: None,
                checkpoint: "ok".into(),
                resume_cmd: None,
                resume_argv: None,
                prompt: None,
                queue_job: None,
                updated_at_ms: 1,
            };
            let fleet_bytes = encode_frame(&ServerFrame::Response {
                id: req.id,
                response: Box::new(RpcResponse::Fleet {
                    hosts: Vec::new(),
                    sessions: vec![live_session],
                    overhead: OverheadStats {
                        rendered_ptys: 1,
                        headless_live: 0,
                        hibernated: 0,
                        total_live_ram_mb: 3,
                    },
                }),
            })
            .expect("encode fleet");

            // Split mid-header (2 bytes), then rest of header + half body, then remainder.
            let mid = 4 + (fleet_bytes.len() - 4) / 2;
            stream.write_all(&fleet_bytes[..2]).await.expect("hdr1");
            stream.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(20)).await;
            stream.write_all(&fleet_bytes[2..mid]).await.expect("hdr2+body1");
            stream.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(20)).await;
            stream.write_all(&fleet_bytes[mid..]).await.expect("body2");
            stream.flush().await.expect("flush");

            // Also send a GridDelta split mid-header and mid-body.
            let grid_bytes = encode_frame(&ServerFrame::Event {
                event: DaemonEvent::GridDelta {
                    snapshot: GridSnapshot {
                        session_id: "sess-chunk".into(),
                        seq: 99,
                        cols: 80,
                        rows: 24,
                        cursor_col: 4,
                        cursor_row: 0,
                        lines: vec![GridRow {
                            row: 0,
                            text: "CHUNK_SAFE_OK".into(),
                        }],
                    },
                },
            })
            .expect("encode grid");

            let gmid = 4 + (grid_bytes.len() - 4) / 2;
            stream.write_all(&grid_bytes[..1]).await.expect("ghdr1");
            stream.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(15)).await;
            stream.write_all(&grid_bytes[1..gmid]).await.expect("ghdr2");
            stream.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(15)).await;
            stream.write_all(&grid_bytes[gmid..]).await.expect("gbody2");
            stream.flush().await.expect("flush");

            // Drain incoming PtyInput & AttachPty requests from the client to verify zero corruption.
            let mut pty_inputs = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            while pty_inputs < 20 && tokio::time::Instant::now() < deadline {
                let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
                match tokio::time::timeout(rem, stream.read_exact(&mut len_buf)).await {
                    Ok(Ok(_)) => {
                        let n = u32::from_le_bytes(len_buf) as usize;
                        let mut payload = vec![0u8; n];
                        stream.read_exact(&mut payload).await.expect("read client frame");
                        let rpc: RpcRequest = decode_frame(&payload).expect("decode client frame");
                        if matches!(rpc.msg, ClientMsg::PtyInput { .. }) {
                            pty_inputs += 1;
                        }
                    }
                    _ => break,
                }
            }
            pty_inputs
        });

        let startup = StartupIntent {
            force_spawn: false,
            spawn: SpawnMetadata {
                title: "chunk · sh".into(),
                project: "chunk".into(),
                worktree_path: "/tmp".into(),
                cli: "sh".into(),
                command: Vec::new(),
            },
            initial_cols: 80,
            initial_rows: 24,
        };
        let (bridge, mut ev_rx) = DaemonBridge::spawn(sock, startup);

        // Interleave 20 outbound PtyInput frames right while server is dripping partial frame bytes.
        for i in 0..20u8 {
            bridge.send(BridgeCommand::PtyInput {
                session_id: "sess-chunk".into(),
                bytes: vec![b'a' + (i % 26)],
            });
            tokio::time::sleep(Duration::from_millis(3)).await;
        }

        let mut saw_fleet = false;
        let mut saw_grid = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        while tokio::time::Instant::now() < deadline && !(saw_fleet && saw_grid) {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(rem, ev_rx.recv()).await {
                Ok(Some(BridgeEvent::FleetUpdated { sessions, .. })) => {
                    if sessions.iter().any(|s| s.id == "sess-chunk") {
                        saw_fleet = true;
                    }
                }
                Ok(Some(BridgeEvent::GridUpdated(snap))) => {
                    if snap.lines.iter().any(|r| r.text == "CHUNK_SAFE_OK") {
                        saw_grid = true;
                    }
                }
                Ok(Some(BridgeEvent::Disconnected(reason))) => {
                    panic!("bridge disconnected unexpectedly during chunked reads: {reason}");
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }

        let received_inputs = server_task.await.expect("server join");
        bridge.send(BridgeCommand::Shutdown);

        assert!(saw_fleet, "expected FleetUpdated from chunked frame");
        assert!(saw_grid, "expected GridUpdated from chunked frame");
        assert_eq!(received_inputs, 20, "expected all 20 interleaved PtyInput frames");
    }

    #[tokio::test]
    async fn bridge_auto_spawns_and_streams_live_pty_grid() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sock = tmp.path().join("agentd.sock");
        let db = tmp.path().join("state.db");
        let handle = start_daemon(DaemonConfig {
            socket_path: sock.clone(),
            db_path: db,
            host_id: "desktop".into(),
            hostname: "desktop-exo".into(),
            peer_hosts: Vec::new(),
        })
        .await
        .expect("start daemon");

        let startup = StartupIntent {
            force_spawn: true,
            spawn: SpawnMetadata {
                title: "test · sh".into(),
                project: "test".into(),
                worktree_path: tmp.path().to_string_lossy().into_owned(),
                cli: "sh".into(),
                command: vec!["/bin/sh".into(), "-lc".into(), "echo IRON_GPUI_OK; sleep 2".into()],
            },
            initial_cols: 80,
            initial_rows: 24,
        };

        let (bridge, mut ev_rx) = DaemonBridge::spawn(sock, startup);

        let mut saw_attached = false;
        let mut saw_output = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

        while tokio::time::Instant::now() < deadline && !(saw_attached && saw_output) {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, ev_rx.recv()).await {
                Ok(Some(BridgeEvent::PaneAttached { snapshot, .. })) => {
                    saw_attached = true;
                    if snapshot.lines.iter().any(|r| r.text.contains("IRON_GPUI_OK")) {
                        saw_output = true;
                    }
                }
                Ok(Some(BridgeEvent::GridUpdated(snapshot))) => {
                    if snapshot.lines.iter().any(|r| r.text.contains("IRON_GPUI_OK")) {
                        saw_output = true;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }

        bridge.send(BridgeCommand::Shutdown);
        handle.shutdown().await;

        assert!(saw_attached, "expected PaneAttached event on startup");
        assert!(saw_output, "expected live GridSnapshot containing IRON_GPUI_OK");
    }
}
