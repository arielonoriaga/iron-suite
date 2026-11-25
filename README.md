<p align="center">
  <img src="assets/iron-suite-cover.png" alt="Iron Suite — Turn AI coding agents into a senior engineer you can trust" width="100%" />
</p>

# Iron Suite

**Zero-cloud SQLite FTS5 + stdio MCP memory hub (`iron`) and adversarial multi-agent engineering skills (`iron-*`) for Claude Code, Codex, Cursor, and Antigravity.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Iron Suite solves two recurring failures in agentic software engineering:

1. **Unbounded, noisy, cloud-locked agent memory:** `iron` indexes your curated Markdown memories and session history into a compact local SQLite FTS5 + WAL store (with integer-keyed 32-byte SHA-256 content deduplication and hot/cold archive tiering), serves **5 deterministic MCP tools** over `stdio` (locally or across machines via plain `ssh`), auto-links lessons across separate conversations via shared technical anchors, reinforces helpful memories while decaying superseded ones, enforces **hard UTF-8 byte budgets (`--max-bytes`)**, and scrubs credentials/private spans before indexing — with **zero vector databases, zero hosted APIs, and zero background daemons**.
2. **rubber-stamp "looks good" AI coding loops:** The bundled **7 `iron-*` skills** and **7 role-isolated subagents** enforce bounded ownership (`irondev`), fresh-context adversarial code & security review (`irondev-review`), offensive vulnerability hunting with `1 -> N` structural variant sweeps (`iron-hunt`), measurement-first performance profiling (`iron-perf`), systematic production forensics (`iron-debug`), and read-only architecture/security audits (`iron-audit`).

---

## Quick Install

### One-Command Install (Binary + Skills + Agents + Claude MCP)
```sh
curl -fsSL https://raw.githubusercontent.com/arielonoriaga/iron-suite/main/install.sh | bash
```

### Install Skills Only (`skills.sh` — Claude Code, Codex, Cursor, Antigravity)
```sh
npx skills add arielonoriaga/iron-suite
```

### Claude Code Plugin Marketplace
```text
/plugin marketplace add arielonoriaga/iron-suite
/plugin install iron-suite@iron-suite-marketplace
```

### Cargo / `cargo-binstall` (`iron` Memory CLI + MCP Server)
```sh
cargo binstall iron-suite
# or from source:
cargo install --git https://github.com/arielonoriaga/iron-suite --locked
```

---

## What's Inside

### 1. `iron` — Bounded-Byte SQLite FTS5 Memory CLI & MCP Hub

```sh
# Import curated Markdown memories (and optional Cavemem SQLite history) read-only
iron memory import --claude-root ~/.claude --cavemem-db ~/.cavemem/data.db

# Search with a strict serialized UTF-8 byte ceiling
iron memory search 'cargo target directory' --repo . --max-bytes 2000
iron memory search 'tenant isolation' --project commerce-core --strict-project

# Paginated byte-exact fetch & explicit Markdown graph traversal
iron memory get mem_ID --max-bytes 4000
iron memory related mem_ID --relation references
iron context 'migration rollback' --project commerce-core --role reviewer

# Save durable native notes or corrections (superseding outdated guidance & auto-linking past sessions)
iron memory remember --project iron-suite --agent claude --kind correction \
  --supersedes mem_OLD_ID \
  --title 'Shared memory hub' --content 'Desktop holds the authoritative Iron v2 store.'
iron memory feedback mem_ID --outcome helpful

# Cross-session anchor linking, pattern consolidation & hot/cold v2 archive split
iron memory consolidate --min-occurrences 3
iron memory merge-project --from legacy-shop --to commerce-core
iron memory migrate --from ~/.local/share/iron/memory.v1.db \
  --output ~/.local/share/iron/memory.db --archive-output ~/.local/share/iron/archive.db
iron memory backup --output ~/backups/iron-snapshot.db

# Launch the zero-dependency Second Brain & Memory Verification Web UI (loopback by default)
iron ui --port 7420
```

#### Second Brain & Verification Web UI (`iron ui`)

`iron ui` embeds a zero-dependency local HTTP/1.1 workbench directly inside the `iron` binary (pure Rust `std::net`, zero extra Cargo dependencies, `Host`-allowlisted and CSRF-protected) so you can visually inspect, verify, and curate the second brain your agents rely on:

![Iron Memory Second Brain UI](docs/iron-ui-second-brain.png)

- **Second Brain (Interactive Knowledge Graph):** Obsidian-style orbital knowledge bubbles grouped by **Project Zones**, **Link Clusters**, or **Trust Zones**, with explicit reference edges, cross-session auto-anchor bridges, search spotlighting, day-growth halos, and dark/light themes.
- **Today Pulse & 14-Day Evolution Rates:** Time-travel day selector (`◀ Today ▶`) and 14-day stacked activity chart tracking curated signal-to-noise lift, human verification coverage, native rule velocity, and self-correction rate.
- **Trust Desk (Strictly Read-Only Inspection):** Inspect full Markdown/native memory prose, exact trust multiplier (`2.0×`/`2.2×` vs `0.15×` superseded decay), supersession lineage, duplicate-body clusters, and recurring consolidation candidates without mutating `use_count` until you click **Still True**, **Update & Supersede**, **Contradicted**, or **Outdated**.
- **Agent Lens (Retrieval Simulator):** Run exact `developer`, `reviewer`, `verifier`, or side-by-side Dev-vs-Reviewer retrieval queries with live byte-budget rulers and truncation visibility.
- **Project Merge, Rename & Persistent Aliases (`aliases.json`):** Consolidate fragmented or renamed projects directly from the UI (`⇄ Merge / Rename`) or CLI (`iron memory merge-project --from <OLD> --to <NEW>`). Saving a permanent alias writes a private `0600` `aliases.json` sibling file next to `memory.db` (zero schema changes) so future imports, `memory_remember`, and searches transparently resolve old names and subpaths/worktrees to the canonical project.

#### MCP Server (`iron mcp`)
Exposes 5 tools over newline-delimited JSON-RPC `stdio` (`2025-06-18` / `2025-03-26` / `2024-11-05`):
- `memory_search` — tokenized FTS5 retrieval ranked by BM25, bounded Hebbian usage/confirmation boost, and supersession decay, with `project`, `strict_project`, `role`, `source` (`all|curated|history|native|archive`), and `max_bytes` (`256..65536`, default `4000`).
- `memory_get` — UTF-8 byte-paginated record retrieval (`offset` / `next_offset`) with supersession metadata, cold `archive.db` fallback, and per-session implicit usage reinforcement. Accepts record IDs only, never arbitrary file paths.
- `memory_related` — traverses explicit Markdown `references`, `supersedes` chains, and deterministic high-IDF cross-conversation `shares_anchor` edges (including matched file/path/symbol/CWE/CVE evidence).
- `memory_remember` — replay-safe native note & `correction` persistence (`supersedes: [...]`) with write-time cross-session `related_memories` discovery and `<private>`/credential redaction prior to hashing.
- `memory_feedback` — explicitly reinforces `helpful` memories or demotes `outdated`/`contradicted` memories (with optional `superseded_by` pointer).

#### Zero-Cloud Multi-Machine Shared Hub over SSH
Run one authoritative SQLite WAL store on your workstation (`desktop`) and point every AI client on your laptop or remote devboxes at it over authenticated SSH — no sync conflicts, no open ports, no third-party cloud:

```mermaid
flowchart LR
    Laptop["Laptop: Claude / Codex / Antigravity"] <-->|SSH stdio| Iron["iron mcp on desktop"]
    Desktop["Desktop AI clients"] <-->|local stdio| Iron
    More["Additional devboxes"] <-->|SSH stdio| Iron
    Iron <--> Store[("Authoritative SQLite FTS5 + WAL")]
    Sources["Curated Markdown & session snapshots"] -->|read-only import| Store
```

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

See [docs/ssh-hub-rollout.md](docs/ssh-hub-rollout.md) and `integration/` for `systemd --user` refresh and 3-2-1 `gitleaks`-gated backup timers.

---

### 2. Bundled `iron-*` Skills (`skills/`) & Subagents (`agents/`)

| Skill | Purpose |
| :--- | :--- |
| **`irondev`** | End-to-end feature/fix orchestrator: bounded implementer brief -> fresh-context review -> real-surface verification -> curated learning. |
| **`irondev-dev`** | Shared implementation discipline for backend, frontend, and security engineering roles with canonical handoff contracts. |
| **`irondev-review`** | Fresh-context adversarial code review selecting correctness, architecture, systems, and security lenses proportional to change risk. |
| **`iron-hunt`** | Proactive read-only/sandboxed offensive vulnerability hunter: attack-surface mapping, scanner triage (`gitleaks`, `osv-scanner`, `semgrep`, `zizmor`, `ast-grep`), source-to-sink taint tracing, safe local repro proof, and `1 -> N` structural variant sweeps. |
| **`iron-audit`** | Read-only multi-lens codebase health & pre-release sweep producing severity-ranked findings and remediation briefs. |
| **`iron-debug`** | Production-grade systematic debugging (`repro -> hypothesis -> instrument -> root cause -> fix -> invariant backprop`). |
| **`iron-perf`** | Measurement-first performance engineering: baseline flamegraphs, query plans, and RUM evidence before any optimization edit. |

Bundled subagents (`agents/iron-*.md`): `iron-backend-dev`, `iron-backend-review`, `iron-frontend-dev`, `iron-frontend-review`, `iron-security-dev`, `iron-security-review`, and `iron-verifier`.

---

## Design Contracts & Honest Non-Claims

- **Hard serialized UTF-8 byte budgets:** `--max-bytes` bounds the serialized JSON output (including escapes and trailing newline). Budget exhaustion sets `truncated: true` and is explicitly distinguished from `no_match: true`.
- **Evidence, not authority:** Recalled memories retain timestamps and source locators; historical notes can be stale and never override live repository verification or user authorization.
- **Best-effort redaction:** Derived-index import and `memory_remember` scrub `<private>` spans, PEM keys, bearer tokens, URL passwords, and common credential assignments, while leaving source files untouched. Heuristics do not replace secret management.
- **Independent evaluation (`eval/`):** Fixtures under `eval/` measure source recall within byte budgets, replay idempotency, and subprocess latency; they do not claim billed token or invoice savings without provider telemetry. See [docs/upstream-learnings.md](docs/upstream-learnings.md).

---

## Companion Projects in The Iron Stack

- **[claude-harness](https://github.com/arielonoriaga/claude-harness)** — Self-improving Claude Code harness: Rust `PreToolUse` command guardrail, cross-session JSONL journal bus, detached `test-agent`, auto-improve reflector, and ratatui build-queue TUI.
- **[entropy-hunter](https://github.com/arielonoriaga/entropy-hunter)** — Deterministic software-entropy analyzer CLI for Rust and TypeScript codebases.
- **[claude-statusline-bar](https://github.com/arielonoriaga/claude-statusline-bar)** — Information-dense terminal status line for Claude Code with live context, git, and rate-limit ramps.

---

## Build & Verify

```sh
cargo test --locked
python3 -m unittest discover -s eval -p test_runner.py -v
```

## License

MIT — Copyright (c) 2026 Ariel Onoriaga.
