# IronBrowser — Architectural & Implementation Plan

> **Goal:** A **site-agnostic**, Zen-inspired Chromium developer browser aligned with **The Iron Stack** (`iron-suite`, `iron-term`) that launches any URL you want with simultaneous **Portrait + Landscape viewports**, **mirrored interaction**, **live CPU/GPU/FPS/Memory telemetry + real docked Chrome DevTools**, and a **native MCP server** for Claude Code, Codex, OpenCode, and Antigravity.

---

## 1. Engine & Stack Decision

| Requirement | WebKitGTK (Tauri) | Pure Rust + CEF (`cef-rs`) | **Electron (`WebContentsView`) + Rust MCP (`iron-browser-mcp`)** |
| :--- | :--- | :--- | :--- |
| **Real Chrome DevTools (docked inside bottom panel)** | No (WebKit Inspector only) | Hard (custom C++/Wayland wiring) | **Yes — native `setDevToolsWebContents()` docks real Chrome DevTools** |
| **Side-by-side 60–120fps WebGL/Canvas viewports** | Weaker WebGL2/WebGPU parity | Yes | **Yes — native multi-`WebContentsView` Chromium compositor** |
| **Per-process OS CPU / GPU / RAM metrics** | Manual `/proc` only | Manual | **Yes — built-in `app.getAppMetrics()` (GPU + Portrait + Landscape PIDs) + CDP `Performance.getMetrics`** |
| **Trusted mirrored input (`isTrusted: true`)** | Limited | Possible | **Yes — native `webContents.sendInputEvent` + CDP `Input.dispatch*`** |
| **Zen-style multi-tab UI iteration speed** | Fast | Very slow | **Fast (SolidJS/TS shell, Celestial Dual-Theme matching Iron Suite)** |
| **Native Iron Stack MCP (`stdio` + `0600` socket)** | Separate binary | Same binary | **Clean tiny Rust `iron-browser-mcp` binary (zero-cloud, identical pattern to `iron mcp` & `iron-term`)** |

**Chosen Stack:**
- **Browser Shell (`~/Projects/iron-browser/app`):** Electron (Chromium + V8 + Blink + real Chrome DevTools) + TypeScript + SolidJS (for the thin Zen-inspired vertical tab rail, URL bar, and live telemetry dock). Managed with **Bun**.
- **Native MCP & Control Bridge (`~/Projects/iron-browser/crates/iron-browser-mcp`):** Tiny Rust binary speaking `stdio` MCP to AI agents and length-prefixed JSON-RPC over `$XDG_RUNTIME_DIR/iron-browser/ctl.sock` (`0600`) to the running Electron browser.

---

## 2. Layout & UX (Zen Minimalism + Sketch Fidelity)

```text
┌──────────┬───────────────────────┬──────────────────────────────────────────────┐
│ Zen Rail │  Portrait (390×844)   │           Landscape (1280×720)               │
│ (⌘\ hide)│  [iPhone 15 ▾] 60fps  │           [Desktop 16:9 ▾] 60fps             │
│          │                       │                                              │
│ ◉ Tabs   │   Live WebContents    │            Live WebContents                  │
│ + New    │   (Touch Emulated)    │            (Desktop Pointer)                 │
│          │                       │                                              │
│ ── Sync  │                       │                                              │
│ ⇄ Mirror │                       │                                              │
│ ⛨ Shared │                       │                                              │
├──────────┴───────────────────────┴──────────────────────────────────────────────┤
│ [Telemetry: GPU 14% · Port 9% · Land 11% · 60fps (p95 16.4ms) · Heap 84MB · 0 Err]│
│ [Target: Portrait | Landscape] [Chrome DevTools: Elements|Console|Network|Perf] │
│                         Real Docked Chrome DevTools                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **Zen-Inspired Multi-Tab Chrome:**
  - Collapsible vertical tab rail (`⌘\`), pinned "Essentials" strip, workspace groups, compact `⌘L` floating/inline URL bar.
  - Every tab supports **1-click Dual Mode (`⌘⇧D`)**: browse normally in Single View, or split *any* URL instantly into **Portrait + Landscape** side-by-side.
  - Device preset pickers per viewport (`375×667`, `390×844`, `430×932`, `768×1024`, `1280×720`, `1440×900`, custom `W×H`, DPR `1x/2x/3x`).
  - Celestial Dark/Light tokens inherited from [iron-suite](https://github.com/arielonoriaga/iron-suite) and `iron-term`.

---

## 3. Site-Agnostic Mirrored Interaction Engine (3-Tier Relay)

Works on **any site** (plain HTML, React/SolidJS SPAs, dashboards, maps, or HTML5/WebGL canvases) with zero site-specific code:

1. **Tier 1 — Navigation & Scroll Sync:**
   - URL bar changes, back/forward, reload, and proportional scroll (`scrollY / maxScrollY`) sync automatically across both viewports.
2. **Tier 2 — Semantic DOM Mirror (HTML / SPA UI):**
   - Preload script attaches passive capture listeners (`pointerdown/up`, `click`, `input`, `change`, `keydown`, `wheel`) in both viewports.
   - Builds a deterministic element fingerprint in priority order:
     1. `[data-testid="..."]`
     2. `#id`
     3. `[aria-label="..."]` / `[name="..."]`
     4. Accessible role + trimmed text content
     5. Structural CSS path fallback
   - Main process queries the paired viewport for the matching element's live bounding box and dispatches a **trusted Chromium event** (`sendInputEvent` / CDP `Input.dispatchMouseEvent` / `Input.insertText` → `event.isTrusted === true`) — so clicking a button that lives at the top-right on Desktop accurately clicks the same button docked at the bottom bar on Portrait!
3. **Tier 3 — Normalized Canvas / Coordinate Mirror (`<canvas>`, WebGL, unmatched targets):**
   - When the clicked element is a `<canvas>` (or has no DOM match in the paired viewport), maps normalized `(nx, ny)` relative to the `<canvas>` bounding box into the paired viewport's `<canvas>` rect and dispatches a trusted mouse/touch event.
4. **Anti-Loop & Session Isolation Controls:**
   - **Echo Guard:** Every replayed action carries an active `replaying_in_viewport` lock (~80ms) so Viewport B's synthetic reception never bounces back to Viewport A.
   - **Per-Tab Session Partition Toggle (Site-Agnostic):**
     - **Shared Partition (default):** Both viewports share one Chromium `Session` (cookies, auth, `localStorage`) — log in once, see both views immediately.
     - **Isolated Partition:** Secondary viewport uses an isolated in-memory partition (`iron-mirror-iso-<tabId>`) + optional URL query override (e.g. rewriting any query parameter cleanly) for apps/WebSockets that reject duplicate concurrent sessions.

---

## 4. Live CPU / GPU / FPS Telemetry + Docked Chrome DevTools

- **Always-Visible 28px Telemetry Strip (top of bottom dock):**
  - **OS CPU% & RAM (from Electron `app.getAppMetrics()` sampled at 1 Hz):** `GPU %`, `Portrait % / MB`, `Landscape % / MB`, `Total MB`.
  - **Frame Pacing (lightweight `rAF` ring buffer per viewport):** live `FPS`, `p95 frame ms`, `jank count (>20ms)` with tiny sparkline.
  - **CDP `Performance.getMetrics` (sampled at 1 Hz):** `JSHeapUsedSize`, `Nodes`, `LayoutCount`, `RecalcStyleCount`.
  - **Instant Anomaly Pills:** `Console Errors (N)` and `Failed Network (N)` across *both* viewports (clicking focuses the exact viewport's DevTools Console/Network tab!).
- **Real Docked Chrome DevTools:**
  - Embedded natively inside the bottom dock via `secondaryView` + `targetWebContents.setDevToolsWebContents(devtoolsView.webContents)`.
  - 1-click target switcher (`[Inspect: Portrait] | [Inspect: Landscape]`) swaps the docked Chrome DevTools cleanly between the two viewports, or pops out to a separate window on demand.

---

## 5. Native MCP Integration for AI Agents (`iron-browser mcp`)

Connects directly to Claude Code, Codex, Antigravity (`agy`), and Cursor over zero-cloud `stdio` MCP (registerable in `~/.claude/settings.json` & Antigravity MCP config just like `iron-memory`):

| MCP Tool | Purpose |
| :--- | :--- |
| `browser_tabs` | List open tabs, URLs, view modes (`single`/`dual`), and active tab ID. |
| `browser_open` | Open a new tab (`url`, `mode: single|dual`, `session: shared|isolated`, `portrait_size`, `landscape_size`). |
| `browser_navigate` | Navigate a tab's URL (syncing both viewports in dual mode). |
| `browser_screenshot` | Capture `portrait`, `landscape`, or `both` (paired PNGs) + automatic layout audit (`horizontalOverflow`, `clippedElements`, viewport dimensions). |
| `browser_metrics` | Return structured JSON telemetry: GPU/Portrait/Landscape CPU% & RAM MB, FPS, p95 frame time, JS heap, DOM nodes, console error count, failed requests. |
| `browser_interact` | Execute trusted `click`, `type`, `scroll`, `key`, or `hover` via selector or normalized canvas coords, with `mirror: true|false`. |
| `browser_console` | Read recent bounded console logs/errors from `portrait`, `landscape`, or `both`. |
| `browser_network` | Inspect recent HTTP/WS requests filtered by status (`4xx`/`5xx`/failed/all) with timing & payload size. |
| `browser_eval` | Evaluate a read-only or debug JS expression inside `portrait` or `landscape` with a hard serialized UTF-8 byte cap (`--max-bytes`). |

---

## 6. Phased Implementation Milestones (Parallel to `iron-term`)

Completely isolated repository at **`~/Projects/iron-browser`** so work on `iron-term` (GPUI native terminal) and `iron-browser` never collides:

| Milestone | Deliverable | Acceptance Criteria |
| :--- | :--- | :--- |
| **B1 · Multi-Viewport Shell + Docked Chrome DevTools** | Electron + SolidJS shell (`WebContentsView` Portrait + Landscape, Zen vertical tab rail `⌘\`, URL bar `⌘L`, Single↔Dual toggle `⌘⇧D`, real docked Chrome DevTools with Portrait/Landscape target switch). | Open any local or public URL (`http://127.0.0.1:...`, `https://...`), see Portrait + Landscape side-by-side at 60fps, inspect DOM/Network/Performance in real docked Chrome DevTools, zero console errors. |
| **B2 · Site-Agnostic Mirrored Interaction Engine** | Tier 1 (nav/scroll) + Tier 2 (semantic DOM selector replay) + Tier 3 (normalized `<canvas>` replay) + echo loop guard + Shared/Isolated session partition toggle. | Automated E2E test on both an HTML SPA (with responsive moving buttons) and an HTML5 `<canvas>` page: click/type/scroll in Portrait replicates cleanly to Landscape and vice versa with `isTrusted === true` and 0 echo loops. |
| **B3 · Live CPU / GPU / FPS Telemetry Dock** | 1 Hz `app.getAppMetrics()` (GPU + per-viewport CPU/RAM), CDP `Performance.getMetrics` (JS heap, DOM nodes), `rAF` FPS/p95 jank sparkline, unified Console/Network error pills. | Verified under synthetic CPU/canvas load: telemetry strip accurately reports elevated renderer/GPU CPU%, dropped FPS, and failed XHR/console errors in real time. |
| **B4 · Native Rust `iron-browser-mcp` + `.desktop` Launcher** | Rust `crates/iron-browser-mcp` (`0600` Unix socket RPC bridge + `stdio` MCP server implementing all 9 tools with hard UTF-8 byte caps) + `iron-browser` desktop launcher. | End-to-end MCP test: external agent calls `browser_open` → `browser_interact(mirror=true)` → `browser_metrics` → `browser_screenshot(both)` and receives verified PNGs + real telemetry JSON. |
