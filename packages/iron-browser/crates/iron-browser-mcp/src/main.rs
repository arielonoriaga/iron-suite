use std::{env, path::PathBuf};

use anyhow::{Context, Result, bail};
use iron_browser_mcp::{
    mcp::{DEFAULT_MAX_BYTES, HARD_MAX_BYTES_CAP, MIN_MAX_BYTES, serve_stdio},
    socket::{SocketClient, default_socket_path},
};
use serde_json::Value;

struct CliArgs {
    socket: PathBuf,
    max_bytes: usize,
    doctor: bool,
    doctor_lines: usize,
    doctor_json: bool,
}

fn parse_args() -> Result<Option<CliArgs>> {
    let mut socket = default_socket_path();
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut doctor = false;
    let mut doctor_lines = 50usize;
    let mut doctor_json = false;
    let mut args = env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!(
                    "iron-browser-mcp {}\n\
                     Native stdio MCP sidecar & health doctor for IronBrowser (0600 Unix control socket)\n\n\
                     USAGE:\n  iron-browser-mcp [--socket PATH] [--max-bytes N]\n  iron-browser-mcp --doctor [--lines N] [--json]\n\n\
                     OPTIONS:\n  --socket PATH     Path to IronBrowser ctl.sock (default: $XDG_RUNTIME_DIR/iron-browser/ctl.sock)\n  \
                     --max-bytes N     Hard UTF-8 byte ceiling for text/eval payloads ({MIN_MAX_BYTES}..={HARD_MAX_BYTES_CAP}, default: {DEFAULT_MAX_BYTES})\n  \
                     --doctor          Inspect live or post-mortem IronBrowser health, crash dumps, and main.log\n  \
                     --lines N         Number of recent main.log lines for --doctor (1..=500, default: 50)\n  \
                     --json            Print raw JSON output for --doctor\n  \
                     -V, --version     Print version",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("iron-browser-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--socket" => {
                let val = args.next().context("--socket requires a path")?;
                socket = PathBuf::from(val);
            }
            "--max-bytes" => {
                let raw = args.next().context("--max-bytes requires an integer")?;
                let parsed: usize = raw
                    .parse()
                    .with_context(|| format!("invalid --max-bytes value: {raw}"))?;
                if !(MIN_MAX_BYTES..=HARD_MAX_BYTES_CAP).contains(&parsed) {
                    bail!(
                        "--max-bytes must be between {MIN_MAX_BYTES} and {HARD_MAX_BYTES_CAP} (got {parsed})"
                    );
                }
                max_bytes = parsed;
            }
            "--doctor" => {
                doctor = true;
            }
            "--lines" => {
                let raw = args.next().context("--lines requires an integer")?;
                let parsed: usize = raw
                    .parse()
                    .with_context(|| format!("invalid --lines value: {raw}"))?;
                doctor_lines = parsed.clamp(1, 500);
            }
            "--json" => {
                doctor_json = true;
            }
            other => {
                bail!("unknown argument: {other} (try --help)");
            }
        }
    }

    Ok(Some(CliArgs {
        socket,
        max_bytes,
        doctor,
        doctor_lines,
        doctor_json,
    }))
}

fn print_doctor_human(report: &Value) {
    let reachable = report
        .get("socketReachable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!(
        "IronBrowser Doctor — status: {}",
        if reachable { "ONLINE" } else { "OFFLINE / UNRESPONSIVE" }
    );
    if let Some(sock) = report.get("socketPath").and_then(Value::as_str) {
        println!("  Socket:      {sock}");
    }
    if !reachable
        && let Some(err) = report.get("socketError").and_then(Value::as_str)
    {
        println!("  Socket err:  {err}");
    }
    if let Some(pid) = report.get("pid").and_then(Value::as_u64) {
        let uptime = report.get("uptimeMs").and_then(Value::as_u64).unwrap_or(0);
        println!("  PID:         {pid} (uptime: {}s)", uptime / 1000);
    }
    if let Some(log_path) = report.get("logPath").and_then(Value::as_str) {
        println!("  Log file:    {log_path}");
    }
    if let Some(crash_dir) = report.get("crashDumpsDir").and_then(Value::as_str) {
        println!("  Crash dir:   {crash_dir}");
    }
    if let Some(wd) = report.get("watchdog").and_then(Value::as_object) {
        println!(
            "  Watchdog:    running={} stalls={} beatAgeMs={} shuttingDown={}",
            wd.get("running").and_then(Value::as_bool).unwrap_or(false),
            wd.get("stallCount").and_then(Value::as_u64).unwrap_or(0),
            wd.get("lastHeartbeatAgeMs").and_then(Value::as_u64).unwrap_or(0),
            wd.get("shuttingDown").and_then(Value::as_bool).unwrap_or(false),
        );
    }
    if let Some(dump) = report.get("lastCrashDump")
        && !dump.is_null()
    {
        println!("  Latest dump: {dump}");
    } else {
        println!("  Latest dump: none");
    }
    if let Some(pending) = report.get("pendingRpcs").and_then(Value::as_array)
        && !pending.is_empty()
    {
        println!("  Pending RPCs ({}): {}", pending.len(), Value::Array(pending.clone()));
    }
    if let Some(vps) = report.get("viewports").and_then(Value::as_array)
        && !vps.is_empty()
    {
        println!("  Viewports ({}):", vps.len());
        for vp in vps {
            println!("    - {vp}");
        }
    }
    if let Some(logs) = report.get("recentLogs").and_then(Value::as_array) {
        println!("  Recent logs ({} lines):", logs.len());
        for line in logs {
            if let Some(s) = line.as_str() {
                println!("    {s}");
            }
        }
    }
}

fn main() -> Result<()> {
    let Some(cfg) = parse_args()? else {
        return Ok(());
    };
    let client = SocketClient::new(cfg.socket);
    if cfg.doctor {
        let report = client.query_health(cfg.doctor_lines);
        if cfg.doctor_json {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            print_doctor_human(&report);
        }
        return Ok(());
    }
    serve_stdio(&client, cfg.max_bytes)
}
