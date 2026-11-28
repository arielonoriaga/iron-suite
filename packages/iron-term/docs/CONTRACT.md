# IronTerm — Daemon & Protocol Contract (`CONTRACT.md`)

Shared source of truth between `iron-agentd` (backend daemon), `iron-cli` (hooks/adapters), `iron-gpui` (native frontend), and `web-mobile` (390px Tailscale companion).

---

## 1. Transport & Addressing

- **Local client ↔ `iron-agentd`:** Unix domain socket `$XDG_RUNTIME_DIR/iron-term/agentd.sock` (`0600`), length-prefixed JSON (v1) or MessagePack frames (`u32 LE` + payload).
- **Multi-PC client ↔ remote `iron-agentd`:** Multiplexed over existing authenticated `ssh -T <host> iron-termctl stdio-bridge` (zero extra open firewall ports, identical trust model to `iron mcp` in `iron-stack`).
- **Mobile `390px` Companion:** Loopback/Tailscale IPv4 HTTP/1.1 + WebSocket server (`--bind <tailscale-ip>:7430`), `Host`-allowlisted, CSRF/token-protected, strictly disabled unless enabled in config.

---

## 2. Core Data Types (`crates/iron-proto`)

```rust
pub enum AgentState {
    NeedsApproval, // structured prompt / guardrail waiting on owner
    ReviewReady,   // irondev-review / verification verdict ready
    Failed,        // non-zero or runq Exit 75 interruption
    Queued,        // waiting in runq build gate
    Running,       // active live PTY in agentd (headless unless attached)
    Hibernated,    // 0 live child PIDs, 0 MB PTY RAM, persisted in SQLite
}

pub struct SessionSummary {
    pub id: String,
    pub title: String,               // e.g. "ez-commerce · cash-shift-be"
    pub cli: String,                 // "claude" | "codex" | "agy" | "shell"
    pub host_id: String,             // "desktop" | "laptop" | ...
    pub project: String,
    pub worktree_path: String,
    pub git_branch: String,
    pub git_dirty: bool,
    pub git_behind_main: u32,
    pub state: AgentState,
    pub phase: String,               // "brief" | "build" | "review" | "verify"
    pub phases: Vec<String>,
    pub ram_mb: u32,                 // 0 when Hibernated
    pub pinned_host: Option<String>, // enforces --host invariant
    pub pin_reason: Option<String>,
    pub checkpoint: String,          // 1-line human summary ("where I left off")
    pub resume_cmd: Option<String>,  // e.g. "claude --resume <id>"
    pub prompt: Option<StructuredPrompt>,
    pub queue_job: Option<RunqJobRef>,
    pub updated_at_ms: i64,
}

pub struct StructuredPrompt {
    pub kind: PromptKind,            // Guardrail | Permission | Review | Exit75
    pub title: String,
    pub description: String,
    pub command: String,
    pub actions: Vec<PromptAction>,  // [1] Fix-Before-Destroy first, [2] Allow, [3] Deny
}

pub struct HostStatus {
    pub id: String,                  // "desktop" | "laptop"
    pub hostname: String,            // "workstation" | "laptop"
    pub mode: HostMode,              // Free | Shared | Off
    pub cpu_pct: u8,
    pub cap_pct: u8,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub active_slots: u8,
    pub max_slots: u8,
}
```

---

## 3. Client ↔ Daemon RPC Surface

### Commands (`ClientMsg`)
- `ListFleet` → returns `{ hosts: Vec<HostStatus>, sessions: Vec<SessionSummary>, overhead: OverheadStats }`
- `AttachPty { session_id, cols, rows }` → subscribes client to **rendered grid deltas** for that session ONLY (`rendered_ptys += 1`)
- `DetachPty { session_id }` → stops grid delta streaming immediately (session continues headless in `agentd`)
- `PtyInput { session_id, bytes: Vec<u8> }` → raw keystrokes directly into `portable-pty` master fd
- `PtyResize { session_id, cols, rows }`
- `ResolvePrompt { session_id, action_id, custom_reply: Option<String> }`
- `SpawnSession { host_id, project, worktree_path, cli, initial_prompt: Option<String> }`
- `HibernateSession { session_id, checkpoint: Option<String> }` → cleanly terminates PTY after persisting scrollback tail + `resume_cmd` to SQLite (`ram_mb = 0`)
- `WakeSession { session_id, rebase_onto_main: bool }`
- `MoveSessionHost { session_id, target_host_id }` → validates invariants first (`pinned_host`, `target.mode != Off`); fails closed with `MoveBlocked { reason }` (≤8 words)
- `SetHostMode { host_id, mode: HostMode }` → invokes `runq set <host> <mode>`
- `InspectSession { session_id }` → returns `{ todos, iron_memories, recent_journal, git_diff_stat }`

### Push Events (`DaemonEvent`)
- `FleetDelta { sessions_changed, hosts_changed, overhead }` (lightweight, `<2 KB`, zero ANSI spam)
- `GridDelta { session_id, seq, dirty_rows, cursor }` (sent ONLY to clients currently `AttachPty`'d to `session_id`)
- `PromptRaised { session_id, prompt }` (also triggers desktop notification + mobile push)
- `JournalAppended { entry }`

---

## 4. Tool-Agnostic Agent Adapter Protocol (Claude, Codex, Agy, Shells)

Any CLI tool integrates via either:
1. **Hook CLI (`iron-termctl`)** — drop-in replacement/bridge for existing `agent hook scripts ({task-title,todo-ctl,flow-ctl}.sh` and `runq hook`:
   - `iron-termctl state --session $IRON_SESSION_ID --state needs_approval --kind guardrail --title "..." --cmd "..." --fix "..."`
   - `iron-termctl todo --session $IRON_SESSION_ID set|next|done ...`
   - `iron-termctl flow --session $IRON_SESSION_ID start|step|done ...`
   - `iron-termctl checkpoint --session $IRON_SESSION_ID "Fixed blind_count 409 privacy"`
2. **Private OSC Escape Sequence (`OSC 7770`)** — zero-fork fallback for any child process writing to stdout:
   - `\x1b]7770;{"event":"checkpoint","text":"..."}\x07` intercepted inside `iron-agentd`'s `alacritty_terminal` parser before reaching the screen.

---

## 5. SQLite Durable Schema (`~/.local/share/iron-term/state.db`, WAL mode)

- `sessions (id PK, title, cli, host_id, project, worktree_path, git_branch, state, phase, phases_json, pinned_host, pin_reason, checkpoint, resume_cmd, resume_argv_json, prompt_json, created_at_ms, updated_at_ms, hibernated_at_ms)`
- `session_todos (session_id, idx, text, status)`
- `session_scrollback_tail (session_id PK, tail_text TEXT, updated_at_ms)` — bounded UTF-8 text capped at 500 lines / 64 KiB per hibernated session so SQLite stays compact across 200+ historical sessions with zero native C compression deps.
- `journal_events (id PK, ts_ms, session_id, agent_label, kind, message)`

---

## 6. Hard Resource & Invariant Guarantees

1. **Zero idle GPU cost:** Unattached sessions NEVER send `GridDelta` frames and NEVER trigger GPUI paint/layout passes.
2. **Zero dormant RAM cost:** `Hibernated` sessions hold `0` live child PIDs and `0` in-memory `alacritty_terminal::Term` grids; only a ~2 KB SQLite row + bounded scrollback tail remains.
3. **Fail-closed host policy:** `MoveSessionHost` refuses whenever `pinned_host != Some(target)` or `target.mode == Off`, returning the exact reason surfaced by `🔒` in the UI.
4. **Tailscale-only mobile bind:** `web-mobile` rejects non-Tailscale / non-loopback `Host` headers and requires an explicit bearer token.
