use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use iron_proto::{
    AgentState, ClientMsg, HostMode, PromptAction, PromptKind, RpcRequest, RpcResponse,
    ServerFrame, StructuredPrompt, TodoItem, TodoStatus, read_frame_sync, resolve_socket_path,
    write_frame_sync,
};

#[derive(Debug, Parser)]
#[command(name = "iron-termctl", about = "Control plane & hook CLI for iron-agentd")]
struct Cli {
    /// Path to the iron-agentd Unix socket
    #[arg(long, env = "IRON_TERM_SOCKET")]
    socket: Option<String>,

    /// Emit raw JSON responses
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Check daemon liveness
    Ping,
    /// Show fleet sessions, host headroom, and GPU/headless/hibernated overhead
    Status,
    /// Spawn a new headless agent session
    Spawn {
        #[arg(long)]
        title: String,
        #[arg(long)]
        host: Option<String>,
        #[arg(long, default_value = "default")]
        project: String,
        #[arg(long)]
        worktree: Option<String>,
        #[arg(long, default_value = "shell")]
        cli: String,
        #[arg(long)]
        pinned_host: Option<String>,
        #[arg(long)]
        pin_reason: Option<String>,
        #[arg(long)]
        resume_cmd: Option<String>,
        /// Command + args to run inside PTY (defaults to $SHELL)
        #[arg(last = true)]
        cmd: Vec<String>,
    },
    /// Hibernate a live session to 0 MB RAM + SQLite checkpoint
    Hibernate {
        session_id: String,
        #[arg(long)]
        checkpoint: Option<String>,
    },
    /// Wake a hibernated session from SQLite
    Wake {
        session_id: String,
        #[arg(long)]
        rebase: bool,
    },
    /// Update session attention state & optional structured guardrail/approval prompt
    State {
        #[arg(long, env = "IRON_SESSION_ID")]
        session: String,
        #[arg(long)]
        state: String,
        #[arg(long)]
        checkpoint: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        desc: Option<String>,
        #[arg(long)]
        cmd: Option<String>,
        #[arg(long)]
        fix_label: Option<String>,
        #[arg(long)]
        fix_cmd: Option<String>,
    },
    /// Record a 1-line "where I left off" checkpoint
    Checkpoint {
        #[arg(long, env = "IRON_SESSION_ID")]
        session: String,
        text: String,
    },
    /// Update active workflow phase (e.g. brief -> build -> review -> verify)
    Flow {
        #[arg(long, env = "IRON_SESSION_ID")]
        session: String,
        #[arg(long)]
        phase: String,
        #[arg(long, value_delimiter = ',')]
        phases: Option<Vec<String>>,
    },
    /// Replace live todo checklist for a session
    Todo {
        #[arg(long, env = "IRON_SESSION_ID")]
        session: String,
        items: Vec<String>,
    },
    /// Resolve a waiting prompt on a session (defaults to primary action)
    Approve {
        session_id: String,
        #[arg(long, default_value = "primary")]
        action: String,
        #[arg(long)]
        reply: Option<String>,
    },
    /// Move session to another host (enforces host pin & OFF invariants)
    Move {
        session_id: String,
        #[arg(long)]
        host: String,
    },
    /// Switch host runq policy mode (free | shared | off)
    HostMode {
        host_id: String,
        mode: String,
    },
    /// Inspect session metadata, todos, journal, and scrollback tail
    Inspect {
        session_id: String,
    },
}

fn send_rpc(socket: &Path, msg: ClientMsg) -> Result<RpcResponse> {
    let mut stream = UnixStream::connect(socket)
        .with_context(|| format!("connect to iron-agentd at {}", socket.display()))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(15)));
    let req = RpcRequest { id: 1, msg };
    write_frame_sync(&mut stream, &req)?;

    loop {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            bail!("timed out waiting for iron-agentd RPC response");
        };
        let _ = stream.set_read_timeout(Some(remaining));
        let frame: ServerFrame = read_frame_sync(&mut stream)?;
        match frame {
            ServerFrame::Response { id: 1, response } => return Ok(*response),
            ServerFrame::Response { .. } | ServerFrame::Event { .. } => continue,
        }
    }
}

fn resolve_cli_socket(socket_arg: Option<String>) -> PathBuf {
    socket_arg
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(resolve_socket_path)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let socket = resolve_cli_socket(cli.socket);

    let msg = match cli.command {
        Commands::Ping => ClientMsg::Ping,
        Commands::Status => ClientMsg::ListFleet,
        Commands::Spawn {
            title,
            host,
            project,
            worktree,
            cli: cli_name,
            pinned_host,
            pin_reason,
            resume_cmd,
            cmd,
        } => {
            let worktree_path = worktree.unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| ".".to_string())
            });
            ClientMsg::SpawnSession {
                title,
                host_id: host,
                project,
                worktree_path,
                cli: cli_name,
                command: cmd,
                pinned_host,
                pin_reason,
                resume_cmd,
            }
        }
        Commands::Hibernate {
            session_id,
            checkpoint,
        } => ClientMsg::HibernateSession {
            session_id,
            checkpoint,
        },
        Commands::Wake { session_id, rebase } => ClientMsg::WakeSession {
            session_id,
            rebase_onto_main: rebase,
        },
        Commands::State {
            session,
            state,
            checkpoint,
            kind,
            title,
            desc,
            cmd,
            fix_label,
            fix_cmd,
        } => {
            let parsed_state = AgentState::parse(&state)
                .with_context(|| format!("invalid state '{state}'"))?;
            let prompt = if let Some(kind_str) = kind {
                let pk = PromptKind::parse(&kind_str)
                    .with_context(|| format!("invalid prompt kind '{kind_str}'"))?;
                let mut actions = vec![PromptAction {
                    id: "primary".into(),
                    label: fix_label.unwrap_or_else(|| "Approve".into()),
                    command_to_send: fix_cmd,
                    is_primary: true,
                    is_destructive: false,
                }];
                actions.push(PromptAction {
                    id: "deny".into(),
                    label: "Deny".into(),
                    command_to_send: None,
                    is_primary: false,
                    is_destructive: true,
                });
                Some(StructuredPrompt {
                    kind: pk,
                    title: title.unwrap_or_else(|| "Action required".into()),
                    description: desc.unwrap_or_default(),
                    command: cmd.unwrap_or_default(),
                    actions,
                })
            } else {
                None
            };
            ClientMsg::UpdateSessionState {
                session_id: session,
                state: parsed_state,
                checkpoint,
                prompt,
            }
        }
        Commands::Checkpoint { session, text } => ClientMsg::UpdateCheckpoint {
            session_id: session,
            checkpoint: text,
        },
        Commands::Flow {
            session,
            phase,
            phases,
        } => ClientMsg::UpdateFlow {
            session_id: session,
            phase,
            phases,
        },
        Commands::Todo { session, items } => {
            let todos = items
                .into_iter()
                .enumerate()
                .map(|(i, text)| TodoItem {
                    text,
                    status: if i == 0 {
                        TodoStatus::Active
                    } else {
                        TodoStatus::Pending
                    },
                })
                .collect();
            ClientMsg::UpdateTodos {
                session_id: session,
                todos,
            }
        }
        Commands::Approve {
            session_id,
            action,
            reply,
        } => ClientMsg::ResolvePrompt {
            session_id,
            action_id: action,
            custom_reply: reply,
        },
        Commands::Move { session_id, host } => ClientMsg::MoveSessionHost {
            session_id,
            target_host_id: host,
        },
        Commands::HostMode { host_id, mode } => {
            let parsed =
                HostMode::parse(&mode).with_context(|| format!("invalid host mode '{mode}'"))?;
            ClientMsg::SetHostMode {
                host_id,
                mode: parsed,
            }
        }
        Commands::Inspect { session_id } => ClientMsg::InspectSession { session_id },
    };

    let resp = send_rpc(&socket, msg)?;
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&resp)?);
    } else {
        match &resp {
            RpcResponse::Pong { version } => println!("pong iron-agentd v{version}"),
            RpcResponse::Fleet {
                hosts,
                sessions,
                overhead,
            } => {
                println!(
                    "overhead: {} GPU | {} headless | {} hibernated | {} MB live",
                    overhead.rendered_ptys,
                    overhead.headless_live,
                    overhead.hibernated,
                    overhead.total_live_ram_mb
                );
                for h in hosts {
                    println!(
                        "host {:<8} ({:<12}) mode={:?} cpu={}%/{}% slots={}/{}",
                        h.id, h.hostname, h.mode, h.cpu_pct, h.cap_pct, h.active_slots, h.max_slots
                    );
                }
                for s in sessions {
                    println!(
                        "{}  {:<14} {:<8} {:<8} {:>3}MB  {} — {}",
                        s.id,
                        format!("{:?}", s.state),
                        s.host_id,
                        s.phase,
                        s.ram_mb,
                        s.title,
                        s.checkpoint
                    );
                }
            }
            RpcResponse::Session { session } => {
                println!(
                    "{}  {:?}  host={}  phase={}  {}",
                    session.id, session.state, session.host_id, session.phase, session.checkpoint
                );
            }
            RpcResponse::Host { host } => {
                println!(
                    "host {} ({}) -> {:?} ({}% cap, {} slots)",
                    host.id, host.hostname, host.mode, host.cap_pct, host.max_slots
                );
            }
            RpcResponse::Inspection { inspection } => {
                println!(
                    "{} ({:?}) todos={} journal={} tail_lines={}",
                    inspection.session.id,
                    inspection.session.state,
                    inspection.todos.len(),
                    inspection.recent_journal.len(),
                    inspection.scrollback_tail.len()
                );
            }
            RpcResponse::MoveBlocked { reason } => {
                bail!("move blocked: {reason}");
            }
            RpcResponse::Error { code, message } => {
                bail!("daemon error [{code}]: {message}");
            }
            RpcResponse::Ok => println!("ok"),
            RpcResponse::Attached { snapshot } => {
                println!(
                    "attached {} ({}x{}, seq={})",
                    snapshot.session_id, snapshot.cols, snapshot.rows, snapshot.seq
                );
            }
        }
    }

    if let RpcResponse::MoveBlocked { reason } = resp {
        bail!("move blocked: {reason}");
    }
    if let RpcResponse::Error { code, message } = resp {
        bail!("daemon error [{code}]: {message}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_whitespace_socket_args_parse_and_fall_back_to_default() {
        let default_sock = resolve_socket_path();

        for raw in ["", "   "] {
            let cli = Cli::try_parse_from(["iron-termctl", "--socket", raw, "ping"])
                .expect("empty --socket must parse cleanly");
            assert_eq!(resolve_cli_socket(cli.socket), default_sock);
        }
    }
}
