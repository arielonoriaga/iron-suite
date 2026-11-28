# Shared SSH Hub & Multi-Device Rollout

Iron Memory runs on a **single machine over stdio**, or as a **zero-cloud hub over SSH** for any number of devices: one hub host (called `iron-hub` below; use any SSH alias) keeps the authoritative SQLite FTS5 + WAL store, and every other device connects through `ssh stdio`. Nothing assumes a fixed number or kind of device.

## 1. Hub host setup

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

## 2. Every other device

Configure Claude Code, Codex, Cursor, or Antigravity on each device to invoke `iron mcp` on the hub over SSH:

```json
{
  "mcpServers": {
    "iron-memory": {
      "command": "ssh",
      "args": ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "iron-hub", ".local/bin/iron", "mcp"]
    }
  }
}
```

All `memory_remember` writes land immediately on the authoritative WAL database, and all `memory_search` / `memory_get` / `memory_related` queries observe the exact same committed state without vector servers, sync conflicts, or exposed HTTP ports.

With `install.sh --hooks`, set `IRON_REMOTE_HOST=iron-hub` in the Claude Code environment of devices without a local `memory.db`: memory files read on that device are credited on the hub. Paths under any user's `~/.claude/` are mapped onto the hub's own `~/.claude/`, so home directories and usernames may differ per device.

Optional history push: `integration/iron-sync-cavemem-to-hub.{sh,service,timer}` copies a consistent Cavemem snapshot to the hub (`IRON_HUB_HOST` is required; each device writes `sources/<hostname>-cavemem.db`).

## 3. System graph on N devices

The memory store is shared; the system graph is **per device**, built from that device's own checkouts so it reflects uncommitted work and works offline:

1. Copy `integration/system-graph.example.json` to `~/.local/share/iron/system-graph.json` on each device and set `repos_root` to where that device keeps its repositories. Service names and repo names stay the same everywhere.
2. Enable `integration/iron-graph-refresh.{service,timer}` on devices that are not the hub (the hub's memory refresh already refreshes its graph).
3. Point `verified_pairs_file` at a path that your existing file sync shares between devices (a git-synced dotfiles repo, Syncthing, …), e.g. `~/.claude/verdicts/graph-pairs.jsonl`. `iron memory graph verify` appends the verified (caller chunk, handler chunk, contract) pairs; every refresh on every device applies them. Pairs are content hashes, so they match across devices whenever the code is identical. The file is append-only; a union merge (`*.jsonl merge=union` in `.gitattributes`) never conflicts.
