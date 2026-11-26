# Iron-Design — Compounding Real-World Design Lessons

Living log of verified production UX patterns and engineering-grounded design laws distilled from real redesign rounds. Read this during §2 of every `iron-design` run so past discoveries compound across modules.

---

## 1. Ground-Truth Production Data Beats Intuition
1. **Users model real-world containers, not database schemas:** Organize configuration around real-world destinations (physical cash drawers, vaults, digital channels, delivery apps) rather than mirroring foreign keys.
2. **Historical inactive bloat explodes on mature accounts:** Real production tenants routinely accumulate 5–10× more archived/inactive records than active ones. **Rule:** Collapse inactive/historical rows behind `▸ Inactive (N)` by default.
3. **Never cry wolf on intentional domain states:** Legitimate configurations (e.g., credit methods with no physical drawer, 0-method reserve vaults, zero pending deliveries) must render calmly, never as red/amber alerts.
4. **Adoption-aligned hierarchy:** Audit actual production usage before granting top-level screen space. Promote high-adoption flows that were buried; demote 0%-used toggles behind `Advanced`.
5. **Multi-branch duplicate names break naive pickers:** Branches routinely share identical names (`Cash`, `Main`, `QR`). **Rule:** Whenever names collide, automatically disambiguate `name · branch` in every dropdown, badge, and simulator.
6. **Top production 409/422 errors reveal missing UI affordances:** Inspect 90-day error telemetry before sketching. Surface prerequisites, locks, expected values, and available limits *before* the user hits a server rejection.

## 2. Screen Archetype Law (Setup vs. Validation vs. High-Volume Desk)
- **Setup / Configuration screens** (configuring ONE entity carefully) → **Master-Detail Split Workbench** (or **Living Mini-Artifact Hero + Actionable 1-Tap Radar + Tactile Domain Tiles** for public/storefront settings).
- **Operational Validation / Monitoring screens** (validating the big picture in `<3s` + drilling into any item) → **Big-Picture Spatial Desk + Living Pulse Radar + Chained Single-`<SideSheet>` Drill-Down Stack**.
- **High-Frequency Operational Desks** (hundreds to 10,000+ entities like Customers or Inventory) → **Unified Single-Screen Workspace + Fused Command Omnibox + Interactive Health Thermometer + 1-Tap Inline Action Drawer + Adaptive Collapsible Routine Lanes**.

## 3. Vertical Space & Tab Discipline
1. **Merge split sibling entity views & remove redundant top tabs:** When 2–6 sibling tabs slice the same entity (e.g. Customers + Credit Accounts; Restock + Purchases + Movements + Batches + Locations), unify them into 1 cohesive workspace with combinable facets and keep legacy URLs working as pre-filtered lenses.
2. **Eliminate wasteful ~100px hero `PageHeader` banners on operational pages:** When the sidebar/navigation already identifies the current section, a large title + subtitle + accent divider wastes prime above-the-fold space. Omit the hero banner and fold compact counters or primary action buttons directly into the functional toolbar.
3. **Fuse Search + Quick-Create / Quick-Command into ONE Omnibox:** Never stack a separate quick-add bar above a search input. Parse intent live (`"+12 sku"`, `"-15000 courier"`, ID lookup) and reveal an inline Enter-to-execute preview strip only when matched.

## 4. Progressive Disclosure & Adaptive Topology
1. **Simple ↔ Advanced toggle beats one-size-fits-all bloat:** When ~80% of accounts operate a lean single-location workflow (and abandon complex multi-step wizards at 70%+) while ~20% rely on sub-locations, expiry lots, or OCR, ship a persistent `Simple` | `Advanced` segmented toggle auto-defaulted from tenant signals.
2. **Multi-branch ≠ `Advanced`:** A large multi-branch retail chain (e.g., 8 branches, 9,000+ SKUs) may still have 0 suppliers, 0 formal purchases, 0 expiry lots, and 0 custom sub-stands. **Rule:** Always expose branch selectors, visual branch-coverage dots, and cross-branch `⇄` transfer triggers whenever `branches > 1` (even in `Simple` mode), and dynamically adapt grouping (`By Supplier` when suppliers exist → `By Branch` when `suppliers === 0`).
3. **Auto-collapse empty routine lanes:** Show box-by-box delivery checkoff or pending-action rails ONLY when pending records exist; collapse cleanly to a quiet 1-line status strip when empty so 0-purchase tenants suffer zero dead chrome.

## 5. Evolutionary Iteration & UX Lab Quality Gates
1. **Genetic Recombination accelerates convergence:** When an owner likes traits from two proposals (e.g., *"60% A + 30% C + mutations"*), breed **2 structurally distinct offspring per pair** inside the same live UX Lab with concrete mutations rather than one lukewarm average.
2. **Fix-Before-Destroy:** When telemetry shows most voids/deletions happen to fix a minor input error (e.g. wrong payment method), put the 1-click non-destructive swap *above* destructive voiding, and transition smoothly into legal paths (e.g. Credit Note) instead of dead disabled buttons.
3. **Zero raw browser chrome — verify real rendered pixels:** Every UX Lab MUST pass an automated 0-missing-CSS-class check across all proposal × mode × scenario × viewport states, use crisp vector icons instead of raw emojis in UI controls, auto-adapt on real phone viewports (`<=640px`), and undergo real headless Chromium desktop + `390px` mobile screenshot inspection before being shown to the user.
4. **Always map to the target repo's real UI component stack:** Inspect the actual frontend framework and UI primitive directory before handoff so the implementation brief references exact real components, not imagined ones.
