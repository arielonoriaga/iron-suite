# IronTerm — UX Blueprint (`UX.md`)

> **Mode:** `iron-design` Blueprint (greenfield product grounded in real Iron Stack usage)
> **Target Stack:** Headless Rust `agentd` (`alacritty_terminal` + SQLite + `runq` resource gate + SSH/Tailscale mesh) + **Native GPUI** desktop client + **`390px` Mobile Triage** web companion over Tailscale.

---

## 1. One Named User & World Model

- **Primary user:** Solo senior/staff engineer running **10–25+ concurrent AI coding agents** (Claude Code, Codex, Antigravity `agy`, `irondev` subagents/swarms) across sibling git worktrees, **multiple days**, and **2+ machines** (`workstation`, `laptop`, optional VPS).
- **Environments & devices:**
  1. **Desktop / 14" Laptop (Native GPUI):** Primary keyboard-driven coding cockpit (50+ switches/hour, deep PTY inspection, multi-agent review & orchestration).
  2. **Phone (`390px` Tailscale companion):** Away-from-desk 15-second check-in to unblock permission prompts, inspect a review verdict, pause a host, or wake a hibernated agent.
- **The ONE mental question answered in `<3 seconds`:**
  > *"Which agents actually need me right now, which hosts have headroom, and where did I leave off yesterday?"*
- **Domain glossary:**
  - Users think in: **Agent Session** (task + repo/worktree + host + phase), **Needs You** (approval / question / review ready / failed), **Build Gate** (`runq` host headroom), **Hibernated** (0 MB dormant work from past days).
  - Avoid leaking raw plumbing as top-level clutter: PTY file descriptors, raw cgroup slices, 50k-line ANSI scrollbacks, tmux window indices.

---

## 2. Core Jobs & Outcomes (Ranked by Frequency)

1. **Unblock waiting agents in `<5 seconds` (50×/day):** See structured approval requests, guardrail interceptions (e.g., `cargo test` bypassing `runq`), or `irondev-review` verdicts without scrolling raw ANSI; act with 1 keystroke (`Approve`, `Run via runq`, `Reply`, `Deny`).
2. **Switch focus cleanly across 20+ agents without cognitive or GPU overhead (100×/day):** Jump via Omnibox (`⌘K`) or attention rail into **1–2 live GPU-rendered PTYs** while the other 18+ stay headless in `agentd` (`0` GPU frames) or hibernated on disk (`0 MB` live RAM).
3. **Resume multi-day work effortlessly (5–10×/day):** Wake a 3-day-old agent with a 1-line *"where I left off"* checkpoint, git worktree freshness check (`dirty` / `behind origin/main`), and linked `iron` memory context — zero dead-process clutter.
4. **Prevent thermal/RAM overload across PCs (5×/day):** See live `workstation` + `laptop` (`shared 50%` work-hours cap `11:30–18:00`, `free`, `off`) headroom and `runq` build queue at a glance; switch host mode or re-queue jobs without killing running agents.
5. **Audit & orchestrate `iron-*` loops (10×/day):** Track `brief → build → review → verify` phase progress, live todo checklists, cross-session journal notes, and `iron` memory lookups inside one chained `<SideSheet>` — never stacked modals.

---

## 3. Domain Invariants & Failure Modes (Non-Negotiable)

Grounded in the build-queue coordinator, host policy config, and `iron-suite`:

| Invariant / Failure Mode | How IronTerm Enforces It Structurally |
| :--- | :--- |
| **Off-screen PTY & multi-day RAM/GPU bloat** | Only visible panes (`1–2`) attach GPU surfaces. Background active agents run headless in `agentd`; dormant agents (`>idle threshold` or manual hibernate) drop to `0 MB` live RAM while keeping SQLite summary + `--resume` token. |
| **Bypassing `runq` melts CPU / OOMs builds** | Guardrail interceptions surface a **Fix-Before-Destroy** primary button (`Run via runq instead`) above `Deny` — never forcing manual command retyping. |
| **Host policy & local-DB pinning (`policy.json`)** | Moving or launching a job on a host that is `off` or violates a `--host desktop` local-DB pin shows a pre-action lock cue (`🔒`) explaining *why* in ≤8 words before execution. |
| **Stale multi-day worktree traps** | Waking a hibernated agent checks git status upfront and surfaces `behind origin/main` / `dirty worktree` cleanly in the wake bar before resuming. |
| **Zero false alarms on calm states** | Hibernated agents collapse behind `▸ Hibernated (N)` by default. When 0 agents need attention and hosts have headroom, the Pulse Strip collapses to one calm green pill (`✓ All clear · 0 blocked`). |
| **Single save/action model & Undo** | Instant non-destructive actions (`Hibernate`, `Snooze`, `Switch host mode`) execute immediately with an **Undo** toast. Deep inspection (`Agent → Diff → Memory → Host`) chains inside ONE `<SideSheet>` with `← Back` crumbs. |

---

## 4. Explicit Non-Goals

- **NO decorative KPI stat cards** (no giant "22 TOTAL AGENTS" / "94% PRODUCTIVITY" boxes eating above-the-fold vertical space).
- **NO 20-tile miniature ANSI wall** burning GPU frames on unreadable 4px terminal text.
- **NO raw-terminal-first mindset** where you must scroll 300 lines of ANSI to find a Y/N prompt.
- **NO stacked modals** or floating popups over popups.
- **NO neon/glassmorphism AI slop** — every surface follows Iron Suite's crisp Celestial contrast hierarchy.

---

## 5. Evolutionary Proposals (UX Lab)

### Gen-1 (Baseline Exploration)
1. **Proposal A — Attention Workbench:** Left urgency rail + Hero PTY Split.
2. **Proposal B — Spatial Fleet Desk:** Host zones (`workstation` + `laptop`) + `runq` build gate + zoom-in PTY.
3. **Proposal C — Command Stream + Express Triage:** Full-bleed PTY + `⌘.` decision deck.

### Gen-2 (Owner Critique: *"A + B, Terminal-First like Alacritty"*)
Eliminated all web-app top headers, card bloat, and artificial bottom composer forms. Terminal pixels own **90–98%** of the viewport with direct inline PTY typing, native `⌘D` split panes, 1-line Ghost Action Bars (`[1]/[2]/[3]` hotkeys), and a 27px `claude-statusline-bar`-style bottom telemetry hairline:

- **Option D · Alacritty Blade (Whisper Rail + Pure PTY + `⌘B` Fleet Overlay):**
  Ultra-slim 236px collapsible monospace Whisper Rail (`⌘\` collapses to 100% pure Alacritty glass) for perpetual peripheral urgency awareness, plus `⌘B` to summon Proposal B's multi-PC `workstation`/`laptop` + `runq` + Dormant Shelf overlay on demand.
- **Option E · Pure Slate (Zero-Sidebar Alacritty + `⌘G` Spatial Fleet Overlay):**
  Zero permanent sidebar — 100% full-width Alacritty with a single 30px tmux-style active-session hairline (`1: cash-shift-be [!]`, `2: cartera-viva [✓]`) and instant `⌘G` flip into the multi-PC Spatial Fleet Overlay (`Esc` returns immediately to raw terminal).
