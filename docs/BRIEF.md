# IronTerm — Implementation Brief (`BRIEF.md`)

> **Approved Design:** **Gen-2 Option D · Alacritty Blade** (verified live in `~/.cache/iron-term-ux-lab`, served on `http://127.0.0.1:4180`)
> **Related Docs:** `docs/UX.md` · `docs/DESIGN.md` · `docs/CONTRACT.md`

---

## 1. Product Architecture (Workspace Layout)

```text
iron-term/
├── Cargo.toml                  # Rust workspace (edition 2024 / pinned MSRV)
├── crates/
│   ├── iron-proto/             # Shared typed RPC frames, Session/Host/Prompt DTOs, OSC parser
│   ├── iron-agentd/            # Headless daemon: portable-pty + alacritty_terminal + SQLite + runq bridge + Tailscale HTTP/WS mobile endpoint
│   ├── iron-cli/               # Thin CLI (`iron-termctl`) for hooks (Claude/Codex/Agy), status, spawn, hibernate, attach
│   └── iron-gpui/              # Native GPUI desktop terminal client (Option D · Alacritty Blade)
├── web-mobile/                 # Zero-dependency 390px Tailscale Mobile Companion (embedded into iron-agentd via include_str!)
└── docs/                       # UX.md, DESIGN.md, CONTRACT.md
```

**Hard Architectural Boundary:**
- `iron-agentd` has **zero GPUI / GUI dependencies**. It compiles as a small static binary deployable on `workstation`, `laptop`, or any Linux/macOS VPS.
- `iron-gpui` owns **zero PTY processes** and **zero SQLite files** — it renders ONLY the 1–2 currently focused PTY grids (`alacritty_terminal::Grid` snapshots/deltas over Unix socket locally or SSH/Tailscale stream remotely).

---

## 2. Approved UI Specification — Option D (*Alacritty Blade*)

### Desktop GPUI Shell (`crates/iron-gpui`)
1. **Default Screen = Raw Terminal (90–98% pixels):**
   - **Zero** web-app top header, **zero** card walls, **zero** artificial bottom form input. Keystrokes go straight to the active PTY.
   - **24px pane hairline:** `[dot] <project · task> @<host> · <cli> · brief→build→[verify]` on the left; `branch · RAM · info · sleep` on the right.
   - **Native Split Panes (`⌘D`):** 1-pane ↔ 2-pane split (strictly max 2–4 visible GPU PTYs; all other sessions remain headless in `agentd`).
2. **Collapsible Whisper Rail (`236px`, toggle `⌘\`):**
   - Monospace 1-line entries grouped strictly by urgency:
     1. `NEEDS YOU (N)` (`!app`, `!75`, `rev✓`)
     2. `ACTIVE · <X>MB (N)` (`desk`, `lap`, `runq`)
     3. `▸ DORMANT (0MB) (N)` — **collapsed by default** so 12–40 past-day agents never create visual overhead.
   - Top inline filter/spawn bar (`/ filter or spawn…`).
3. **1-Line Ghost Action Bar (bottom edge of focused pane, visible ONLY when agent needs action or is hibernated/queued):**
   - Guardrail / Approval: `[1] Run via runq (--host desktop)` (primary Fix-Before-Destroy) · `[2] Run anyway` · `[3] Deny`.
   - Review Ready: `[1] Approve & queue verify` · `[2] Accept & hibernate`.
   - Hibernated: `[1] Wake & rebase` (shown when `behind_main > 0`) · `[2] Wake PTY`.
   - Single-key resolution (`1`/`2`/`3` when focus is on bar, or `⌘1`/`⌘2`/`⌘3` from PTY).
4. **27px Alacritty / `claude-statusline-bar` Bottom Statusline:**
   - Left: `[▾ rail ⌘\]` · `[N urgent · Fleet ⌘B]` · `[split ⌘D]` · active session + git branch.
   - Right: live overhead proof (`● 1 GPU · 7 bg · 12☾ · 56MB`) · clickable host pills (`desk 64%`, `lap shared`) · `⌘K`.
5. **On-Demand Multi-PC Fleet & `runq` Overlay (`⌘B`, `Esc` returns to PTY):**
   - Compact monospace `NEEDS YOU` fast-jump strip.
   - Live `runq` build queue bar.
   - Side-by-side host boxes (`workstation`, `laptop`) with live CPU/RAM/slots telemetry and tactile `free | shared | off` mode toggles.
   - Per-session compact rows (`attach`, `approve`/`sign-off`, `move host` with pre-action `🔒` lock cue when pinned or host is `OFF`, `hibernate`).
   - Collapsible `▸ DORMANT MULTI-DAY SHELF (N · 0 MB RAM)` with `wake` / `wake+rebase`.
6. **Fused Omnibox (`⌘K`) & Chained Single `<SideSheet>` (`info` / host pill / journal):**
   - `⌘K`: fuzzy-jump across all 20+ sessions (live + hibernated) OR type natural language (`claude desktop ez-commerce fix-pos`) + `Enter` to spawn.
   - `<SideSheet>`: `Agent Detail (todos + iron memory + host invariants) → Host Policy → Shared Journal` with `← Back` crumb (zero stacked modals).
   - Non-destructive instant actions (`Hibernate`, `Move host`, `Set host mode`) carry a 5-second **Undo** toast.

### `390px` Mobile Companion (`web-mobile/` embedded in `iron-agentd`)
- Served strictly on Tailscale IPv4 (`100.x.x.x`, never `0.0.0.0` by default) with bearer/cookie auth token.
- Single-column triage cards (`>=44px` tap targets, `0px` horizontal overflow), 1-tap `Run via runq` / `Approve` / `Wake & rebase`, sticky bottom thumb bar (`Needs`, `Dormant`, `Hosts`, `Spawn`), and bottom-docked `<SideSheet>` with live PTY tail + quick instruction send.

---

## 3. Non-Goals (Refused Scope for v1)

- No cloud relay or SaaS account (Tailscale / SSH only, matching `iron-suite`).
- No 20-pane simultaneous GPU terminal wall.
- No custom editor / IDE features (stays a fast terminal emulator + agent control plane).
- No scraping ANSI output to guess approval state when hooks/CLI events exist (structured `iron-termctl` / OSC 7770 protocol first, passive idle-prompt detection as fallback only).

---

## 4. Phased Implementation Milestones (Ready for `irondev`)

| Milestone | Scope | Acceptance Proof |
| :--- | :--- | :--- |
| **M1 · `iron-proto` + `iron-agentd` Core** | Local Unix-socket daemon, `portable-pty` + `alacritty_terminal` headless grids, SQLite WAL session store, hibernate (`0 MB`) & `--resume` wake, `iron-termctl` hook CLI (`state`, `todo`, `flow`, `prompt`). | Integration tests: spawn 20 headless sessions (<80 MB RSS), hibernate 15 → confirm 0 live child PIDs + SQLite checkpoint persisted, wake + reattach intact. |
| **M2 · Multi-PC Mesh + `runq` & `iron` Integration** | SSH/Tailscale remote `agentd` multiplexer, live `runq status` / `runq set` bridge (`policy.json` invariants + `--host` pin lock), `iron mcp` memory lookup & shared JSONL journal reader. | Multi-daemon loopback/SSH test: 2 simulated hosts (`desktop` + `laptop`), `laptop=off` blocks move with exact lock reason, `Exit 75` re-route succeeds. |
| **M3 · Native GPUI Client (Option D · Alacritty Blade)** | GPUI window, GPU text/grid renderer bound to `alacritty_terminal` deltas, Whisper Rail (`⌘\`), `⌘D` 2-pane split, Ghost Action Bar (`[1]/[2]/[3]`), 27px statusline, `⌘B` Fleet Overlay, `⌘K` Omnibox, Celestial Dark/Light tokens. | Real GUI verification: 120fps typing latency, 0 paint calls for unfocused headless agents, full keyboard workflow verified across all 4 stress scenarios. |
| **M4 · `390px` Tailscale Mobile Companion** | Embedded HTTP/WS server in `iron-agentd` bound to Tailscale IPv4 serving mobile triage UI with real-time state push + PTY tail + 1-tap approval/wake. | Headless `390px` E2E test: approve blocked guardrail from mobile → desktop GPUI pane immediately transitions to `running`. |
