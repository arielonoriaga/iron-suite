use std::time::Duration;

use iron_agentd::{DaemonConfig, start_daemon};
use tempfile::TempDir;
use tokio::process::Command;
use tokio::time::timeout;

async fn run_ctl(socket: &std::path::Path, args: &[&str]) -> std::process::Output {
    timeout(
        Duration::from_secs(10),
        Command::new(env!("CARGO_BIN_EXE_iron-termctl"))
            .arg("--socket")
            .arg(socket)
            .args(args)
            .output(),
    )
    .await
    .unwrap_or_else(|_| panic!("iron-termctl timed out for args {args:?}"))
    .expect("execute iron-termctl")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_end_to_end_lifecycle_and_guardrail_approval() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(DaemonConfig {
        socket_path: dir.path().join("agentd.sock"),
        db_path: dir.path().join("state.db"),
        host_id: "desktop".into(),
        hostname: "desktop-exo".into(),
    })
    .await
    .unwrap();

    // 1. Ping
    let ping = run_ctl(&daemon.socket_path, &["ping"]).await;
    assert!(
        ping.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&ping.stderr)
    );
    assert!(String::from_utf8_lossy(&ping.stdout).contains("pong iron-agentd"));

    // 2. Spawn pinned session
    let spawn = run_ctl(
        &daemon.socket_path,
        &[
            "--json",
            "spawn",
            "--title",
            "ez-commerce · cash-shift-be",
            "--project",
            "ez-commerce",
            "--cli",
            "agy",
            "--pinned-host",
            "desktop",
            "--pin-reason",
            "Needs local Postgres on desktop",
            "--",
            "/bin/sh",
            "-c",
            "echo CLI_OK; sleep 30",
        ],
    )
    .await;
    assert!(
        spawn.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&spawn.stderr)
    );
    let spawn_json: serde_json::Value = serde_json::from_slice(&spawn.stdout).unwrap();
    let sid = spawn_json["session"]["id"].as_str().unwrap().to_string();

    // 3. Raise guardrail prompt via CLI hook command
    let st = run_ctl(
        &daemon.socket_path,
        &[
            "state",
            "--session",
            &sid,
            "--state",
            "needs_approval",
            "--kind",
            "guardrail",
            "--title",
            "Guardrail blocked raw cargo test",
            "--cmd",
            "cargo test",
            "--fix-label",
            "Run via runq",
        ],
    )
    .await;
    assert!(
        st.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&st.stderr)
    );

    // 4. Attempting to move pinned session to laptop fails closed with non-zero exit
    let mv = run_ctl(&daemon.socket_path, &["move", &sid, "--host", "laptop"]).await;
    assert!(!mv.status.success());
    assert!(
        String::from_utf8_lossy(&mv.stderr).contains("Needs local Postgres on desktop"),
        "stderr: {}",
        String::from_utf8_lossy(&mv.stderr)
    );

    // 5. Approve prompt + hibernate + wake + status
    let approve = run_ctl(&daemon.socket_path, &["approve", &sid]).await;
    assert!(
        approve.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&approve.stderr)
    );

    let hib = run_ctl(
        &daemon.socket_path,
        &["hibernate", &sid, "--checkpoint", "paused for lunch"],
    )
    .await;
    assert!(
        hib.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&hib.stderr)
    );
    assert_eq!(daemon.live_pty_pids().len(), 0);

    let wake = run_ctl(&daemon.socket_path, &["wake", &sid]).await;
    assert!(
        wake.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&wake.stderr)
    );
    assert_eq!(daemon.live_pty_pids().len(), 1);

    let status = run_ctl(&daemon.socket_path, &["status"]).await;
    assert!(status.status.success());
    let out = String::from_utf8_lossy(&status.stdout);
    assert!(out.contains("ez-commerce · cash-shift-be"), "got: {out}");

    daemon.shutdown().await;
}
