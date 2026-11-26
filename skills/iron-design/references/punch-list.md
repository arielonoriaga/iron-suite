# Anti-Dashboard, Plain-to-Magic & Anti-AI-Slop Punch List

Run this audit on every redesign proposal, UX Lab prototype, and production screen. Every item must pass or have a logged fix.

## 1. Steve Krug — "Don't Make Me Think" Checks
- [ ] **3-Second Trunk Test:** A stranger can immediately answer: *Where am I? What does this screen manage? What is the ONE primary action?*
- [ ] **Self-Evident Controls:** Clickable items look clickable; linked relationships and active rules are visible without opening a modal to inspect them.
- [ ] **Word Diet:** Cut 50% of explanatory paragraphs. If a control needs a 3-sentence tooltip to explain itself, redesign the control.
- [ ] **Matches User Mental Model:** Grouped the way operators run their business (e.g., physical containers vs digital channels; order → receive → audit), not mirrored 1:1 from database foreign keys.

## 2. Plain-to-Magic, Custom Controls & Delight Checks
- [ ] **Zero Raw Browser Chrome & Zero Emoji UI:** Every input, select, segmented toggle, checkbox, and button uses real custom design-system components and crisp vector icons (0 missing CSS classes; visually inspected in headless Chromium desktop + 390px screenshots).
- [ ] **Zero Wasteful Hero Banners on Operational Views:** No redundant ~100px `PageHeader` title+subtitle+divider banner eating vertical space when navigation already identifies the section; fold primary controls cleanly into the top functional toolbar.
- [ ] **Zero "Plain Admin Form" Flatness:** No clunky idle `<input>` borders for headings, no walls of 8+ raw switches where 3 tactile choice cards fit.
- [ ] **Living Comprehension:** Complex interacting rules or live totals summarize themselves in 1 live plain-language sentence.
- [ ] **Anticipatory Speed:** Common repetitive creation/logging has a smart omnibox command or 1-tap inline path alongside full `<SideSheet>` editing; multi-item routines have an Express 1-thumb stepper.
- [ ] **Zero Stacked Modals & Unified Save Model:** Deep drill-downs chain inside ONE `<SideSheet>` with a `← Back to ...` back-crumb. One surface = one clear Save contract; instant actions carry Undo toasts.
- [ ] **Fix-Before-Destroy:** Non-destructive 1-click repairs sit above destructive voids; legal/compliance constraints flow seamlessly into the right action (e.g., Credit Note) instead of dead disabled buttons.

## 3. NN/g — Anti-Vague-Prompt & Prod-Data Checks
- [ ] **Grounded in Real Prod Shapes:** Tested against real tenant scales (solo 1-branch shop, power/multi-stand stress case, large multi-branch 0-supplier catalog, 35+ collapsed inactive historical items, read-only/basic plan, calm all-clear state).
- [ ] **Zero False Alarms:** Legitimate domain states (credit without register, 0-method vaults, 0 pending deliveries) display calmly, never flagged as red/amber errors.
- [ ] **Adoption-Aligned Hierarchy & Adaptive Simple/Advanced:** Features real users rely on sit upfront; unused options tuck behind `Advanced`; branch pickers and grouping adapt dynamically to tenant topology (`branches > 1`, `suppliers === 0`).
- [ ] **No Visual Clutter / Repeated Controls / Loud Low-Density Cards:** Zero decorative KPI cards, zero duplicate controls, zero redundant top tabs for the same entity.

## 4. Domain Integrity, Cross-Links & Backend Symmetry
- [ ] **Save-Time Invariants Surfaced Early:** Broken or locked states (missing prerequisites, open-session locks, blind-count protections, reservation/overdraw guards) appear *before* the user hits a 409/422 wall.
- [ ] **Privacy & Permission Symmetry Verified:** Blind-count screens and backend 409 payloads NEVER leak protected figures; branch/tenant access checks apply symmetrically across list, detail, write, and share routes; mutations broadcast live realtime updates.
- [ ] **Zero Dead-End Bounces:** Every cross-module dependency shows live status AND a direct deep-link (`↗`) to its settings page.
- [ ] **No Dead Controls:** Every visible button works or is removed; disabled controls explain *why* in ≤8 words.

## 5. Mobile-First Ergonomics & Accessibility (`375px`–`390px` Primary)
- [ ] **Mobile-First Layout Verified at `390px`:** Clean single-column rhythm, zero horizontal page scroll, auto-responsive on real mobile viewports (`<=640px`), horizontally scrollable chips without clipped labels.
- [ ] **Thumb-Reachable Touch Ergonomics:** Primary buttons & touch targets `>=40px` tall; top daily counter actions reachable via sticky mobile thumb bar or floating basket dock; zero keyboard-only shortcuts with no visible tap trigger.
- [ ] **Bottom-Docked Mobile `<SideSheet>`:** Sheets slide cleanly from the bottom on `<640px` viewports with sticky thumb-reachable footers.
- [ ] **Accessible & Localized:** WCAG AA contrast on all text/soft surfaces, keyboard accessible (`Escape` pops sheet stack), `prefers-reduced-motion` honored, natural product voice with zero mixed-language leaks in UI or validation errors.
