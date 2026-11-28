use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use iron_agentd::{DaemonConfig, start_daemon};

#[derive(Debug, Parser)]
#[command(name = "iron-agentd", about = "Headless IronTerm multi-agent PTY daemon")]
struct Args {
    /// Unix socket path (defaults to $IRON_TERM_SOCKET, $XDG_RUNTIME_DIR/iron-term/agentd.sock, or /tmp/iron-term-$UID/agentd.sock)
    #[arg(long, env = "IRON_TERM_SOCKET")]
    socket: Option<String>,

    /// SQLite state database path (defaults to $XDG_DATA_HOME/iron-term/state.db)
    #[arg(long)]
    db: Option<PathBuf>,

    /// Logical host identifier (defaults to IRON_TERM_HOST_ID or local hostname)
    #[arg(long, env = "IRON_TERM_HOST_ID")]
    host_id: Option<String>,
}

fn resolve_daemon_config(args: Args) -> DaemonConfig {
    let mut cfg = DaemonConfig::default_paths();
    if let Some(sock) = args
        .socket
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        cfg.socket_path = PathBuf::from(sock);
    }
    if let Some(db) = args
        .db
        .filter(|p| !p.to_string_lossy().trim().is_empty())
    {
        cfg.db_path = db;
    }
    if let Some(host_id) = args
        .host_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        cfg.host_id = host_id;
    }
    cfg
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let cfg = resolve_daemon_config(args);

    let handle = start_daemon(cfg).await?;
    eprintln!("iron-agentd listening on {}", handle.socket_path.display());

    let mut sigterm =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }

    eprintln!("iron-agentd shutting down cleanly...");
    handle.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_whitespace_socket_args_parse_and_fall_back_to_default() {
        let default_sock = DaemonConfig::default_paths().socket_path;

        for raw in ["", "   "] {
            let args = Args::try_parse_from(["iron-agentd", "--socket", raw])
                .expect("empty --socket must parse cleanly");
            let cfg = resolve_daemon_config(args);
            assert_eq!(cfg.socket_path, default_sock);
        }
    }
}
