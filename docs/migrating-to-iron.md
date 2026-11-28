# Migrating to Iron Memory

> **ZERO-CLOUD · READ-ONLY SOURCES · REPLAY-SAFE**

Move your existing agent memory into Iron Memory (`iron`): one local SQLite FTS5 store at `~/.local/share/iron/memory.db` that every CLI agent reads over stdio MCP. Sources are only ever read; nothing below modifies or deletes your old memory store.

| Coming from | Path into Iron | Lands as |
| :--- | :--- | :--- |
| Markdown memory (`MEMORY.md`, Claude Code auto-memory, notes folders, basic-memory vaults) | `iron memory import --claude-root <dir>` | curated `markdown` records, re-synced on every import |
| Official MCP memory server (`@modelcontextprotocol/server-memory`, `memory.jsonl` knowledge graph) | `jq` → `iron memory remember` | native `iron` notes |
| Any JSON export (mem0 / OpenMemory, custom stores, spreadsheets) | `jq` → `iron memory remember` | native `iron` notes |
| Cavemem (`~/.cavemem/data.db`) | `iron memory import --cavemem-db <db>` | session `history` records |

Install `iron` first (see the [README](../README.md#install-locally-mit)), and `jq` for the scripted recipes.

---

## 1. Markdown memories

Iron reads Markdown from a root directory with this layout:

```text
<root>/
├── memory/                      # global memories (*.md)
│   └── projects/<project>/      # memories scoped to one project
├── agent-memory/<role>/         # per-agent / per-role memories
└── projects/<project>/memory/   # Claude Code auto-memory layout
```

Claude Code's `~/.claude` already matches it:

```sh
iron memory import --claude-root ~/.claude
```

For any other Markdown store (a notes folder, a basic-memory vault, a repo of `MEMORY.md` files), copy or symlink its files into the same shape under a directory of your choice and import that root:

```sh
mkdir -p ~/iron-sources/memory/projects/my-service
cp ~/notes/my-service/*.md ~/iron-sources/memory/projects/my-service/
iron memory import --claude-root ~/iron-sources
```

Markdown imports are a **live mirror**: re-running the import updates changed files and drops records whose files were removed. Keep the root around (the `integration/iron-memory-refresh.service` timer re-imports it), or use recipe 3 to turn the notes into permanent native memories.

## 2. Official MCP memory server (knowledge graph)

The reference memory server stores one JSON object per line in `memory.jsonl` (or the path in `MEMORY_FILE_PATH`): entities with `observations`, and relations between them. Each entity becomes one Iron note; its relations are folded into the note body so they stay searchable:

```sh
SRC=~/path/to/memory.jsonl
PROJECT=my-project

jq -c -s '
  (map(select(.type == "relation"))) as $rels
  | .[] | select(.type == "entity")
  | . as $e
  | {
      title: (.name + " (" + .entityType + ")"),
      content: ((.observations | map("- " + .) | join("\n"))
        + ([$rels[] | select(.from == $e.name or .to == $e.name)
            | "\n- " + .from + " " + .relationType + " " + .to] | join("")))
    }' "$SRC" |
while IFS= read -r row; do
  iron memory remember \
    --project "$PROJECT" --agent migration --kind note \
    --title="$(jq -r .title <<<"$row")" \
    --content="$(jq -r .content <<<"$row")"
done
```

## 3. Any JSON export (mem0, OpenMemory, custom stores)

Export your memories to a JSON array, then map its fields to `title` and `content`. The example assumes items shaped like `{"memory": "...", "metadata": {"project": "..."}}`; adjust the `jq` paths to whatever your export contains:

```sh
jq -c '.[] | {
  title: (.memory | .[0:80]),
  content: .memory,
  project: (.metadata.project // "global")
}' export.json |
while IFS= read -r row; do
  iron memory remember \
    --project="$(jq -r .project <<<"$row")" --agent migration --kind note \
    --title="$(jq -r .title <<<"$row")" \
    --content="$(jq -r .content <<<"$row")"
done
```

`iron memory remember` accepts `--kind` `note`, `decision`, `preference`, `gotcha` or `correction` (corrections rank highest), a title up to 200 bytes and content up to 64 KiB. It redacts credentials and `<private>` blocks before storage and is replay-safe: running the same migration twice does not create duplicates.

## 4. Cavemem

Iron reads a Cavemem database directly, read-only:

```sh
iron memory import --cavemem-db ~/.cavemem/data.db
```

Sessions and summaries land in the **session history** layer (`--source history`). They are evidence of what happened, not curated rules: reviewer contexts exclude them, and only summaries join the cross-session link graph. Raw observations can be moved to a cold `archive.db` with `iron memory migrate --archive-output`.

Stores imported by older Iron versions labelled these records `cavemem`. They are relabelled `history` in place, keeping their ids, the first time `iron mcp`, `iron ui` or any writing command opens `memory.db` (and `archive.db`). Upgrade every machine that writes to a shared hub together, so an older binary does not re-import the old label.

---

## Verify, then switch over

```sh
# Spot-check that migrated memories are findable under a byte budget
iron memory search 'a phrase you know is in there' --max-bytes 2000

# Browse, verify and merge projects visually
iron ui --port 7420
```

Then point your agents at Iron and remove the old memory server from the same config:

```sh
claude mcp add-json iron-memory '{"type":"stdio","command":"'"$HOME"'/.local/bin/iron","args":["mcp"]}' --scope user
claude mcp remove memory --scope user    # the old server's name in your config
```

For other MCP clients (Codex, Cursor, Antigravity, OpenCode), register the same stdio command, `iron mcp`. To share one store across machines, see [ssh-hub-rollout.md](ssh-hub-rollout.md).
