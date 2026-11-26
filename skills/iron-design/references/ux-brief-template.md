# UX & Anti-Dashboard Brief Template (`UX.md` + `DESIGN.md`)

Fill this out before proposing layouts or writing UI code. Keep it short, factual, and grounded in real user tasks and backend invariants.

---

## 1. One Named User & World Model
- **Primary user:** [Specific role, e.g., "Shop owner setting up 2 branches before opening" — never "everyone"]
- **Secondary user (if any):** [e.g., "Cashier switching shift at POS"]
- **Environment & device:** [Desktop back-office / tablet / phone at a noisy counter; frequency: once at setup vs. 50×/day]
- **Domain glossary:**
  - Users say: `[real operator term]` → Avoid internal jargon: `[dev/DB term]`

## 2. Core Jobs & Outcomes (Ranked by Frequency)
1. **Most common job:** [Verb + concrete outcome + target time/clicks]
2. **Second job:** [Verb + concrete outcome]
3. **Rare / maintenance job:** [Keep accessible behind `Advanced` or secondary drawer, never let it clutter the primary view]

## 3. Domain Invariants & Failure Modes (Non-Negotiable)
- **Must always be true at save time:** [e.g., cross-branch transfer requires entitlement, branch access on both legs, and available stock above online reservations]
- **Most expensive mistake a user can make today:** [Describe the real-world failure]
- **How the UI prevents it structurally:** [Inline guard / live preview / impossible state / explicit status pill]

## 4. Explicit Non-Goals (What We Refuse to Build)
- NO decorative KPI stat cards at the top of the screen
- NO wasteful ~100px hero `PageHeader` banners on operational screens when nav already names the section
- NO nested bordered cards where clean spacing/dividers communicate better
- NO modals for 1-click inline toggles or repetitive row actions
- NO *lorem ipsum*, fake numbers, raw native browser controls, or multi-sentence instructional walls
- NO [module-specific bloat]

## 5. Visual System & Component Mapping (`DESIGN.md` Seed)
- **Aesthetic direction (precise vocabulary):** [e.g., calm paper ledger, crisp utility workbench, high-contrast operational board]
- **Real UI component primitives:** [List exact existing UI primitives in the target repo — buttons, segmented controls, selects, side sheets, steppers, icons]
- **Color & visual-weight budget:**
  - Neutral surfaces carry structure.
  - Accent color = primary action / active selection ONLY.
  - Semantic amber/red = broken links, missing requirements, or destructive actions ONLY.
- **Voice & microcopy sample (verbatim):**
  - Good label: `"[short, plain, action-first label]"`
  - Good warning: `"[exact consequence + 1 clear fix, <18 words]"`
