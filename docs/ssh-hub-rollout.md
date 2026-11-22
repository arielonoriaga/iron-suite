# Shared SSH Hub & Multi-Agent Rollout

Iron Memory supports both **single-machine stdio** and a **zero-cloud multi-machine hub over SSH** where one workstation (`desktop`) holds the authoritative SQLite FTS5 + WAL store and secondary laptops/devboxes connect via `ssh stdio`.

## 1. Authoritative Host Setup (`desktop`)

```sh
# Import existing Markdown memories (and optional Cavemem SQLite history)
iron memory import --claude-root "$HOME/.claude"

# Register with Claude Code
claude mcp add-json iron-memory '{"type":"stdio","command":"iron","args":["mcp"]}' --scope user
```

Enable the periodic 5-minute refresh and nightly rolling backup timers:

```sh
mkdir -p ~/.config/systemd/user
cp integration/iron-memory-refresh.{service,timer} ~/.config/systemd/user/
cp integration/iron-memory-backup.{service,timer} ~/.config/systemd/user/
install -m 0755 integration/iron-memory-backup.sh ~/.local/bin/iron-memory-backup
systemctl --user daemon-reload
systemctl --user enable --now iron-memory-refresh.timer iron-memory-backup.timer
```

## 2. Remote Client Setup (`laptop` -> `desktop` over SSH)

Configure Claude Code, Codex, Cursor, or Antigravity on any secondary machine to invoke `iron mcp` over SSH:

```json
{
  "mcpServers": {
    "iron-memory": {
      "command": "ssh",
      "args": ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "desktop", ".local/bin/iron", "mcp"]
    }
  }
}
```

All `memory_remember` writes land immediately on the authoritative WAL database, and all `memory_search` / `memory_get` / `memory_related` queries observe the exact same committed state without vector servers, sync conflicts, or exposed HTTP ports.
