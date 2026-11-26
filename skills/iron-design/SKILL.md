---
name: iron-design
description: Orchestrated UX & UI design/redesign skill in the iron-* suite. Replaces generic SaaS dashboards and plain admin-panel forms with effortless ("Don't Make Me Think"), tactile, quietly magical, mobile-first interfaces grounded in real code, backend invariants, and anonymized production data. Produces 3 structurally distinct designs, validates them live in an isolated clickable UX Lab (390px mobile + desktop), elevates the chosen direction via Plain-to-Magic patterns and optional Gen-2 genetic recombination, and hands a verified design brief + prototype to `irondev` for implementation.
---

# Iron-Design — Orchestrated Effortless UX & UI Design

Orchestrator. ⊥ edit shipping production source directly. Ground-truth scan (FE + BE + prod data) → `UX.md`/`DESIGN.md` brief → 3 structurally distinct mobile-first designs → isolated clickable UX Lab → Plain-to-Magic polish → punch-list gate → handoff brief to `irondev`.

**Flow:** `scope → 3-lens scan (FE + BE + prod) → brief (UX.md/DESIGN.md) → 3 distinct proposals → live UX Lab (390px + desktop) → Plain-to-Magic pass → punch-list gate → irondev handoff`

---

## §1 Scope & Mode

Pin one mode before starting:
- **Survey** *(default for existing modules)*: Full FE + BE + cross-module + read-only prod data/error audit → 3 distinct proposals → isolated live UX Lab → handoff to `irondev`.
- **Blueprint** *(greenfield screen/product)*: Interview owner 1 focused question at a time until User, Primary Outcome, Non-Goals, Real Content, and Visual System lock into `UX.md` + `DESIGN.md`.
- **Stress Test** *(high-risk flows: payments, billing/tax, shifts, inventory, permissions, cancelations)*: Push back on every assumption (*"What makes a busy user misconfigure this in 10 seconds?"*), prove every save-time invariant visually.

## §2 Ground-Truth Scan (Parallel — BEFORE Any Design)

For existing modules, dispatch parallel read-only scans FIRST:
1. **Frontend audit (`path:line`):** Every screen, tab, form field, dialog, modal, drawer, banner, alert, toast, empty state, validation message, mobile/touch trap (e.g. keyboard-only shortcuts), and onboarding entry point.
2. **Backend audit (`path:line`):** Every HTTP endpoint, payload asymmetry (create vs update), permission/scope asymmetry (e.g. restricted users hitting 403 or bypassing branch checks), missing live SSE/realtime broadcasts, feature flags, save-time invariants, and 4xx/5xx error codes.
3. **Cross-module & Design System audit (`path:line`):** Where users bounce blindly across settings/pages with zero cross-links, plus exact brand tokens, typography, AA contrast pairs, UI component primitives, and product voice.
4. **Production Reality (read-only SQL + 90d telemetry/error logs):** Real tenant shapes (counts, inactive/archived bloat, duplicate names, multi-branch chains, actual feature adoption vs 0%-used toggles, top real cancelation/abandon reasons, top real 409/422 errors). Never design from toy assumptions when real anonymized prod shapes are readable.

Check [references/learned-lessons.md](references/learned-lessons.md) before finalizing scope so past discoveries compound across modules.

## §3 Brief Lock (`UX.md` + `DESIGN.md`)

Use [references/ux-brief-template.md](references/ux-brief-template.md) to lock:
- **One named user & real-world environment** (never "everyone"), **mobile-first (`375px`–`390px`)** for phone/counter ergonomics, expanding gracefully to desktop.
- **The ONE mental question** the screen answers in `<3 seconds`.
- **Screen Archetype (Setup vs. Validation Law):**
  - *Setup / Configuration* (configure ONE entity carefully) → **Master-Detail Split Workbench** (left rail + calm canvas).
  - *Operational Validation / Monitoring* (validate the whole business in 3s + drill into any object) → **Big-Picture Spatial Desk + Living Pulse Radar + Chained Single-`<SideSheet>` Drill-Down Stack**.
- **Ranked jobs** (daily/common vs rare maintenance) and **Simple ↔ Advanced progressive disclosure** when ~80% of accounts share a lean core flow while ~20% need multi-location/lot/automation tooling.
- **Explicit Non-Goals** (anti-dashboard & anti-plain-form bans: zero decorative KPI cards, zero wasteful ~100px hero `PageHeader` banners on operational screens, zero stacked modals, zero split-save traps, zero false alarms).
- **Brand-faithful `DESIGN.md` tokens** (preserve the product's real palette, fonts, AA contrast, and real UI component library — never dark-SaaS neon AI slop).

## §4 Three Structurally Distinct Proposals + Isolated Live UX Lab

Never hand over 1 "statistical average" layout or 3 color skins of the same screen:
- Propose **3 genuinely different mental models / interaction architectures** (e.g., *Unified Single-Screen Desk* vs *Chronological Multi-Stage Flow* vs *Mobile-First Triage Copilot*).
- **Genetic Recombination (Gen-2 / Gen-3 Iteration):** When the owner responds to Gen-1 by combining traits of two directions (e.g., *"60% A + 30% C + mutations"*), breed **2 genuinely distinct offspring per pair** inside the same live UX Lab — never a single lukewarm blend — pairing the merged architecture with concrete structural mutations (e.g., *Fused Command Omnibox + 1-Tap Inline Action Drawer* vs *Collapsible Time-of-Day Lanes + Item-by-Item Checkoff*) so the owner can test evolutionary choices live.
- Map **100% of inventoried features, dialogs, alerts, and backend invariants** (proving zero functional regression, naming which modals collapse inline or unify).
- Serve the **isolated clickable HTTP UX Lab** (zero edits to the shipping repo; reachable from laptop, desktop, and real mobile phone on your local/Tailscale network) with:
  - Shared live state across all proposals
  - Real custom UI components & crisp vector icons (zero raw browser-default controls, zero missing CSS classes, zero cartoon emojis in chrome)
  - Real backend invariants enforced interactively (locks, permission/branch guards, reservation/overdraw checks, Undo toasts)
  - 3–5 anonymized **prod-shaped scenarios** (simple solo account, power/multi-location account, large multi-branch 0-supplier catalog stress case, read-only/basic-plan account, calm all-clear state)
  - Instant **`390px` Mobile / Desktop** preview toggle + automatic mobile layout on real phones (`<=640px`), **verified with automated class-coverage checks and real headless Chromium desktop + 390px screenshots before presenting**.

## §5 Plain-to-Magic Elevation Pass

Once the owner picks a direction (or hybrid), run a **Distill + Delight** pass using [references/magic-patterns.md](references/magic-patterns.md):
1. **Living Plain-Language Story:** 1 live sentence translating interacting rules or live totals into plain reality.
2. **Tactile Choice Cards over Switch Walls:** Replace mutually exclusive/interacting booleans with 2–3 crisp choice cards (impossible states become unrepresentable).
3. **Smart Natural-Language Command Omnibox:** Fuse Search + Quick-Add/Quick-Adjust into ONE elevated bar (`"+12 sku"`, `"-15000 courier"`, ID/tax-ID lookup) with live preview chips + Enter to execute + Undo toast.
4. **Direct Spatial Manipulation w/ Pre-Drop Guardrails:** Drag items onto targets with warm magnetic highlight when valid and red lock cue *before drop* when blocked, paired with Undo toasts + touch/keyboard alternative.
5. **Physical vs. Digital Split & Smart Anomaly Radar:** Visually separate physical containers + vault connectors from digital channels; surface clickable forensic pills (stale sessions, offsetting cross-container variances → candidate items, post-close drifts) that collapse to calm all-clear when clean.
6. **Time-Travel Header & Chained Single-`<SideSheet>` Stack:** Replay past days in the exact same spatial layout; drill `Object → Sub-object → Action` inside ONE `<SideSheet>` with a back-crumb (zero stacked modals).
7. **Fix-Before-Destroy & Express Batch Flows:** Put non-destructive 1-click fixes ABOVE destructive voids/cancelations; turn repetitive multi-item routines into a 1-thumb Express stepper.
8. **Zero Wasteful Chrome & Adaptive Progressive Disclosure:** Omit ~100px hero `PageHeader` banners on operational screens (fold primary controls into the functional toolbar), collapse inactive history by default, auto-adapt grouping/controls to actual tenant shape (e.g. show branch switcher whenever `branches > 1` even in Simple mode; switch grouping from *Supplier* to *Branch* when `suppliers === 0`).

## §6 Punch-List Gate & Handoff to `irondev`

Verify the final UX Lab prototype against EVERY item in [references/punch-list.md](references/punch-list.md).

Then hand off to `irondev` (or coordinated BE + FE worktrees with independent adversarial reviews per phase) with:
- **`BRIEF.md`:** Approved architecture, mobile-first specs, real UI library component mapping, all prod requirements, every cross-cutting FE + BE bug to fix, explicit Non-Goals, and Acceptance criteria (tests, i18n, living help guides, zero regressions).
- **Exact reference UX Lab folder** (so implementers see exact interactions, microcopy, and layout rhythm rather than guessing).
- **Shared `CONTRACT.md`** when FE & BE run in parallel or sequential phases so DTOs, error codes, and realtime events stay 100% aligned.

## §7 Continuous Skill Training Loop

After every redesign cycle where the user critiques, rejects, or elevates a pattern:
1. Extract the **reusable design law** (not one-off code).
2. Append it to [references/learned-lessons.md](references/learned-lessons.md) or [references/magic-patterns.md](references/magic-patterns.md).
3. Record key durable findings in `iron-memory` (`memory_remember`) so future sessions compound taste and prod lessons automatically.

---

## V-Rules

- **V1:** ∀ redesign → parallel FE + BE + cross-module + prod scan BEFORE proposing UI. Every factual claim cites `path:line` or query output.
- **V2:** ⊥ single "average" proposal. Always deliver 3 structurally distinct paradigms.
- **V3:** ⊥ skip the isolated live UX Lab on non-trivial screens. Test `390px` mobile + desktop with real invariants, custom vector components (0 missing CSS classes), and headless Chromium visual verification BEFORE presenting.
- **V4:** ∀ UI element → must answer *"What job does this do for the user right now?"* Cut decorative KPI cards, wasteful ~100px `PageHeader` hero banners on operational views, orphan pills, nested boxes, and filler copy.
- **V5:** Bare section → gets shorter, ⊥ fuller. Never invent stats or *lorem ipsum*.
- **V6:** ⊥ plain admin-panel flatness AND ⊥ neon/glassmorphism AI slop. Magic = comprehension, anticipation, and restrained tactile craft.
- **V7:** One surface = one save model. ⊥ stacked modals (chain inside ONE `<SideSheet>` with back-crumb). ⊥ split-save locks. Instant direct actions carry Undo.
- **V8:** Collapse historical/inactive bloat by default; ⊥ cry wolf on intentional domain states.
- **V9:** Adoption-aligned hierarchy: promote features real users actually use; demote 0%-used options behind `Advanced`; put non-destructive fixes above destructive voids when prod data proves it.
- **V10:** Surface save-time invariants *before* 409/422 errors and add direct deep-links (`↗`) across related settings — zero dead-end page bounces.
- **V11:** Disambiguate duplicate names across branches/scopes in every picker, badge, and simulator.
- **V12:** Honor real brand tokens, WCAG AA contrast, real product UI component primitives, local voice, keyboard accessibility, and `prefers-reduced-motion`.
- **V13:** Boundary: `iron-design` writes ONLY to isolated lab folders and handoff briefs (`⊥ edit shipping repo`). Implementation executes via `irondev` on isolated branches/worktrees.
- **V14:** Compound every round: distill new user taste & prod lessons into `references/learned-lessons.md` and `iron-memory`.
- **V15:** Mobile-first (`375px`–`390px`) ALWAYS: `>=40px` touch targets, sticky bottom thumb bar for top counter actions, bottom-docked `<SideSheet>`, scrollable tabs, zero horizontal overflow, zero keyboard-only traps.
- **V16:** Merge split sibling screens operating on the same entity into **ONE unified surface** with cross-axis facets and **remove redundant top tabs** to reclaim vertical space; keep legacy routes working as pre-filtered lenses. Fuse redundant Search + Quick-Add bars into ONE Omnibox, and prefer 1-tap inline micro-action drawers over opening modals for high-frequency loops.
- **V17:** Separate structural topology from power-user features: multi-branch chains with zero suppliers/lots still need branch selectors and cross-branch transfers in **Simple** mode without being flooded by unused Advanced modules. Adapt grouping axes dynamically to the tenant's real data.
