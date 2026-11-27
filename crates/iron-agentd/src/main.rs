use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use iron_agentd::{DaemonConfig, start_daemon};

#[derive(Debug, Parser)]
#[command(name = "iron-agentd", about = "Headless IronTerm multi-agent PTY daemon")]
struct Args {
    /// Unix socket path (defaults to $XDG_RUNTIME_DIR/iron-term/agentd.sock)
    #[arg(long)]
    socket: Option<PathBuf>,

    /// SQLite state database path (defaults to ~/.local/share/iron-term/state.db)
    #[arg(long)]
    db: Option<PathBuf>,

    /// Logical host identifier (e.g. desktop, laptop)
    #[arg(long, default_value = "desktop")]
    host_id: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut cfg = DaemonConfig::default_paths();
    if let Some(sock) = args.socket {
        cfg.socket_path = sock;
    }
    if let Some(db) = args.db {
        cfg.db_path = db;
    }
    cfg.host_id = args.host_id;

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
