# IronTerm — Design System (`DESIGN.md`)

> **Brand Continuity:** Extends Iron Stack's verified **Celestial Dual-Theme System** from `iron-stack`, tuned for long-duration native GPUI terminal work and `390px` mobile triage.

---

## 1. Aesthetic Direction & Reference Board

- **Vocabulary:** *Precision instrument cockpit* — deep celestial void surfaces, razor-thin structural hairlines, crisp monospace telemetry, zero decorative glow, calm when healthy, unmistakably legible when an agent needs you.
- **Reference Board:**
  - **Zed (GPUI)** → Borrow: zero-chrome pane headers, instant keyboard-driven command palette, crisp GPU typography.
  - **Linear** → Borrow: urgency-first inbox triage, single-line scannable rows, fast `J/K` + `Enter` navigation, quiet muted metadata.
  - **Iron Stack (`iron ui`)** → Borrow: Celestial dark/light token harmony, honest Trust/Evidence badges, Time-Travel / history calmness.

---

## 2. Color & Semantic Signal Budget

| Role | Dark Token (Default) | Light Token | Usage Rule |
| :--- | :--- | :--- | :--- |
| **Void Canvas** | `#060b13` | `#f5f7fb` | Outer shell & terminal backdrop |
| **Deep Rail** | `#0b1320` | `#ebf0f6` | Navigation rail, side sheet, host trays |
| **Raised Surface** | `#111c2d` | `#ffffff` | Active cards, omnibox, inline approval bars |
| **Hairline Border** | `rgba(114, 150, 194, 0.20)` | `rgba(45, 72, 108, 0.16)` | Structural dividers (never loud boxes) |
| **Primary Text** | `#edf2f8` | `#111827` | Agent titles, PTY output, primary copy |
| **Muted Metadata** | `#7086a3` | `#64748b` | Branch names, age, token/RAM counters |
| **Accent Blue** | `#3B82F6` | `#1D4ED8` | Active selection & primary action ONLY |
| **Attention Coral** | `#E8622C` | `#C2410C` | Approval required / guardrail action |
| **Caution Gold** | `#F7BF2E` | `#B45309` | Queued in `runq`, stale worktree, work-hours cap |
| **Healthy Emerald** | `#34D399` | `#047857` | Running cleanly, review passed, all clear |
| **Review Violet** | `#A78BFA` | `#6D28D9` | `irondev-review` ready / verification verdict |
| **Host / Stream Teal** | `#2DD4BF` | `#0F766E` | Remote host (`workstation` / `laptop`), `iron` memory links |
| **Error Red** | `#F87171` | `#B91C1C` | Failed command, blocked invariant lock (`🔒`) |

**Strict rule:** Neutral surfaces carry 90% of pixels. Color appears ONLY for live state signals or the single active selection — never decorative gradients.

---

## 3. Typography & Density

- **UI Sans:** `Inter`, `-apple-system`, `Segoe UI`, `sans-serif` (13px dense desktop / 14px mobile body; 11–12px metadata).
- **Terminal & Telemetry Mono:** `JetBrains Mono`, `ui-monospace`, `monospace` (13px PTY grid, tabular numerals `font-variant-numeric: tabular-nums` for RAM, CPU%, queue ETA, and ages).
- **Zero raw emojis:** Every status, host, phase, lock, and action uses a crisp 14–16px stroke SVG icon (`1.75px` stroke width, aligned to pixel grid).

---

## 4. GPUI & Mobile-First Ergonomic Mapping

- **Desktop GPUI (`>=1024px`):**
  - 36px slim top bar (brand mark + Living Plain-Language Story + Omnibox trigger + Host headroom pills + Theme toggle). No bloated 100px page hero banner.
  - Full keyboard parity (`J/K` navigate, `Enter` focus PTY, `A` approve, `H` hibernate, `⌘K` omnibox, `⌘.` Express Triage, `Esc` pop sheet / exit zoom).
  - Live **Overhead Telemetry Pill** (`1 GPU · 7 headless · 14 hibernated · 46 MB`) always proving zero wasted work.
- **Mobile Companion (`390px` over Tailscale):**
  - Single-column triage stack (`>=44px` tap targets, zero horizontal overflow).
  - Sticky bottom thumb bar (`Needs You (N)`, `Hosts`, `⌘K Quick`, `⚡ Triage`).
  - Bottom-docked chained `<SideSheet>` (`90vh`, rounded top corners, sticky thumb-reachable action footer).
  - Compact read/send PTY drawer for checking last 30 lines or sending a quick instruction from the phone.

---

## 5. Voice & Microcopy Standard

- **Action-first labels:** `Run via runq`, `Approve once`, `Wake & rebase`, `Hibernate (0 MB)`, `Open PTY`.
- **Invariant lock messages (`≤8 words`):** `Pinned to desktop: needs local Postgres`, `Laptop is OFF — switch mode first`.
- **Calm healthy state:** `All clear · 4 active · 0 blocked · 14 hibernated (0 MB)`.
