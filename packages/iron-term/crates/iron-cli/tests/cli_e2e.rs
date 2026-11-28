use std::time::Duration;

use iron_agentd::{DaemonConfig, PeerHostConfig, start_daemon};
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

async fn run_ctl_isolated(
    home: &std::path::Path,
    socket: &std::path::Path,
    args: &[&str],
) -> std::process::Output {
    timeout(
        Duration::from_secs(10),
        Command::new(env!("CARGO_BIN_EXE_iron-termctl"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home)
            .env("IRON_TERM_SOCKET", socket)
            .args(args)
            .output(),
    )
    .await
    .unwrap_or_else(|_| panic!("isolated iron-termctl timed out for args {args:?}"))
    .expect("execute isolated iron-termctl")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_end_to_end_lifecycle_and_guardrail_approval() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(DaemonConfig {
        socket_path: dir.path().join("agentd.sock"),
        db_path: dir.path().join("state.db"),
        host_id: "desktop".into(),
        hostname: "desktop-exo".into(),
        peer_hosts: vec![PeerHostConfig::new("laptop")],
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_works_in_isolated_env_via_iron_term_socket_without_personal_hosts() {
    let dir = TempDir::new().unwrap();
    let local_host = iron_proto::resolve_local_hostname();
    let daemon = start_daemon(DaemonConfig {
        socket_path: dir.path().join("agentd.sock"),
        db_path: dir.path().join("state.db"),
        host_id: local_host.clone(),
        hostname: local_host.clone(),
        peer_hosts: Vec::new(),
    })
    .await
    .unwrap();

    // Verify IRON_TERM_SOCKET works without --socket in an env-cleared Linux environment
    // (no XDG_RUNTIME_DIR, HOSTNAME, tmux, alacritty, or HYPRLAND_INSTANCE_SIGNATURE).
    let ping = run_ctl_isolated(dir.path(), &daemon.socket_path, &["ping"]).await;
    assert!(
        ping.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&ping.stderr)
    );

    let status = run_ctl_isolated(dir.path(), &daemon.socket_path, &["status", "--json"]).await;
    assert!(
        status.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    let fleet: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    let hosts = fleet["hosts"].as_array().expect("hosts array");
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0]["id"].as_str(), Some(local_host.as_str()));
    assert_eq!(hosts[0]["hostname"].as_str(), Some(local_host.as_str()));
    assert!(hosts
        .iter()
        .all(|h| h["id"].as_str() == Some(local_host.as_str())
            && h["hostname"].as_str() == Some(local_host.as_str())));

    // Full spawn -> hibernate -> wake lifecycle under isolated env.
    let spawn = run_ctl_isolated(
        dir.path(),
        &daemon.socket_path,
        &[
            "--json",
            "spawn",
            "--title",
            "generic · shell",
            "--project",
            "generic",
            "--cli",
            "shell",
            "--",
            "/bin/sh",
            "-c",
            "echo ISOLATED_OK; sleep 30",
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
    assert_eq!(
        spawn_json["session"]["host_id"].as_str(),
        Some(local_host.as_str())
    );

    let hib = run_ctl_isolated(dir.path(), &daemon.socket_path, &["hibernate", &sid]).await;
    assert!(hib.status.success());
    let wake = run_ctl_isolated(dir.path(), &daemon.socket_path, &["wake", &sid]).await;
    assert!(wake.status.success());

    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_supports_explicitly_configured_fleet_hosts() {
    let dir = TempDir::new().unwrap();
    let daemon = start_daemon(DaemonConfig {
        socket_path: dir.path().join("agentd.sock"),
        db_path: dir.path().join("state.db"),
        host_id: "desktop".into(),
        hostname: "desktop-exo".into(),
        peer_hosts: vec![PeerHostConfig {
            id: "laptop".into(),
            hostname: Some("ariel".into()),
            mode: Some(iron_proto::HostMode::Shared),
            cap_pct: None,
            max_slots: None,
        }],
    })
    .await
    .unwrap();

    let status = run_ctl_isolated(dir.path(), &daemon.socket_path, &["status", "--json"]).await;
    assert!(status.status.success());
    let fleet: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    let hosts = fleet["hosts"].as_array().expect("hosts array");
    assert_eq!(hosts.len(), 2);
    assert_eq!(hosts[0]["id"].as_str(), Some("desktop"));
    assert_eq!(hosts[1]["id"].as_str(), Some("laptop"));
    assert_eq!(hosts[1]["hostname"].as_str(), Some("ariel"));
    assert_eq!(hosts[1]["mode"].as_str(), Some("shared"));

    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_falls_back_to_default_socket_when_iron_term_socket_or_flag_is_empty() {
    let dir = TempDir::new().unwrap();
    let xdg_runtime = dir.path().join("xdg_runtime");
    let sock_dir = xdg_runtime.join("iron-term");
    std::fs::create_dir_all(&sock_dir).unwrap();
    let sock_path = sock_dir.join("agentd.sock");

    let local_host = iron_proto::resolve_local_hostname();
    let daemon = start_daemon(DaemonConfig {
        socket_path: sock_path,
        db_path: dir.path().join("state.db"),
        host_id: local_host.clone(),
        hostname: local_host,
        peer_hosts: Vec::new(),
    })
    .await
    .unwrap();

    // 1. Empty IRON_TERM_SOCKET="" falls back to $XDG_RUNTIME_DIR/iron-term/agentd.sock
    let env_out = timeout(
        Duration::from_secs(10),
        Command::new(env!("CARGO_BIN_EXE_iron-termctl"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", dir.path())
            .env("XDG_RUNTIME_DIR", &xdg_runtime)
            .env("IRON_TERM_SOCKET", "")
            .arg("ping")
            .output(),
    )
    .await
    .expect("iron-termctl timed out")
    .expect("execute iron-termctl");
    assert!(
        env_out.status.success(),
        "empty IRON_TERM_SOCKET failed (status {:?}): {}",
        env_out.status.code(),
        String::from_utf8_lossy(&env_out.stderr)
    );
    assert!(String::from_utf8_lossy(&env_out.stdout).contains("pong iron-agentd"));

    // 2. Empty --socket "" falls back to $XDG_RUNTIME_DIR/iron-term/agentd.sock
    let flag_out = timeout(
        Duration::from_secs(10),
        Command::new(env!("CARGO_BIN_EXE_iron-termctl"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", dir.path())
            .env("XDG_RUNTIME_DIR", &xdg_runtime)
            .args(["--socket", "", "ping"])
            .output(),
    )
    .await
    .expect("iron-termctl timed out")
    .expect("execute iron-termctl");
    assert!(
        flag_out.status.success(),
        "empty --socket failed (status {:?}): {}",
        flag_out.status.code(),
        String::from_utf8_lossy(&flag_out.stderr)
    );
    assert!(String::from_utf8_lossy(&flag_out.stdout).contains("pong iron-agentd"));

    daemon.shutdown().await;
}
