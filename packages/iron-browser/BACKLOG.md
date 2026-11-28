# IronBrowser Debugging & MCP Backlog

Field feedback captured from dual-viewport WebGL game & responsive SPA testing — implemented and verified across P1–P5.

---

## Fixed Immediately

- **PATH launcher symlink resolution (`bin/iron-browser`)**:
  - **Bug:** Invoking `~/.local/bin/iron-browser` (symlink -> `<repo>/bin/iron-browser`) resolved `ROOT_DIR` to `~/.local` and searched for Electron under `~/.local/app`.
  - **Fix:** Resolved `BASH_SOURCE[0]` with `readlink -f` before computing `ROOT_DIR`.
  - **Follow-up test:** Add a symlink-launch smoke test to the test suite.

---

## P1 — Effective Viewport Reporting & Exact-Size Capture

- **Observation:** Requesting `1050 × 660` landscape returned `473 × 916` in both CSS (`window.innerWidth/Height`) and captured PNG (exercising the mobile layout instead of landscape), while portrait matched `390 × 844`.
- **Root cause:** In Dual mode, Landscape clears `Emulation.setDeviceMetricsOverride` and relies on `wc.setZoomFactor(scale)` / raw `WebContentsView` bounds; on narrow windows or across origin navigations, effective CSS viewport diverges from requested size silently.
- **Requested behavior:**
  1. Report `{ requestedSize, effectiveCssSize, dpr, capturedPixels, sizeMismatch }` immediately when `browser_open` / `browser_tabs` / `browser_screenshot` runs.
  2. Offer an `exact_size: true` capture mode (applies exact `Emulation.setDeviceMetricsOverride` + clipped `Page.captureScreenshot` independent of shell window width, then restores visual fit scale).
- **Acceptance check:** On a narrow monitor, a `1050 × 660` request either yields `1050 × 660` CSS viewport or returns an explicit `sizeMismatch` before the run passes.

---

## P2 — Saved Reproduction Recipes, Paired Frame Stepping & Labelled Filmstrip Export

- **Observation:** Reproducing a floating island at `1.94×` required a separate Playwright harness controlling seed, time, and phase; live paired probes sampled slightly different multipliers across panes.
- **Requested behavior:**
  1. Saved reproduction recipe format (`url`, `seed`, `phase`, `frame`, viewport presets/sizes, optional canvas region).
  2. Optional dev-only app scene-driver hook to step both Portrait and Landscape panes to the exact same frame.
  3. Multi-step canvas-region capture and labelled filmstrip PNG export (each tile stamped with frame/seed/multiplier metadata).
- **Acceptance check:** Reopen a saved forest-to-sea case, capture both sizes at `1.94×`, then replay 1s on either side of the boundary with frame and seed accompanying every image.

---

## P3 — Cross-Pane Diagnostic Incident Grouping (Distinct from HTTP Dedup)

- **Observation:** One missing room-history endpoint (`401`) produced 2 network entries + 2 console errors across Portrait and Landscape while both games kept running.
- **Requested behavior:**
  1. Diagnostic grouping in `TelemetryService` / MCP (`browser_console`, `browser_network`, or new `browser_incidents`): group matching failures across viewports (`method + sanitizedPath + status`) and link related console errors to their failing network requests.
  2. Export `{ method, sanitizedPath, status, timestamps, affectedViewports, requests, consoleEntries }` while retaining individual raw entries expandable.
  3. Keep single-pane JS exceptions distinct (never falsely grouped).
  4. Explicitly separate from R2 HTTP request deduplication (diagnostic grouping observes both panes without suppressing requests).
- **Acceptance check:** History `401` appears as 1 incident affecting 2 viewports with both requests attached; a separate JS exception on 1 viewport stays distinct.

---

## P4 — Partial Dual Screenshots, Per-Pane Timeout Diagnostics & Clipped-Element Details

- **Observation:** A dual screenshot on a hidden window timed out at the Rust MCP sidecar socket without returning either image; `layoutAudit` counted 3 clipped portrait elements and 1 landscape element without identifying them.
- **Requested behavior:**
  1. Bound each pane's capture independently (`Page.captureScreenshot` / `capturePage`) inside the sidecar timeout budget and return **partial captures** plus `{ stage, viewport, error }` for any pane that stalls.
  2. Enrich `layoutAudit` in `mirror-preload.ts` to return per-element `{ selector, tag, text, bounds, overflowPx }` for every clipped element instead of just a count.
  3. Add optional `highlight_clipped: true` on `browser_screenshot` to visually outline clipped elements in the PNG.
- **Acceptance check:** If one pane stalls, the other PNG and its layout audit still return; a reviewer can jump directly to each clipped element by selector and bounds.

---

## P5 — Short MCP Performance Traces Around App Marks

- **Observation:** Point-in-time FPS/p95 snapshots (`60 fps / 16.8 ms`) cannot measure transient transitions like `fold`, `launch`, or `biome_crossing`.
- **Requested behavior:**
  1. Add `browser_trace_start` / `browser_trace_stop` MCP tools with a bounded rolling frame-time buffer.
  2. Capture optional app `performance.mark` / `performance.measure` events alongside per-frame durations for both viewports side-by-side.
  3. Label **GPU-process CPU %** (`app.getAppMetrics()` GPU process) clearly and separately from **GPU execution time** so reports never conflate the two.
- **Acceptance check:** A 2-second biome-crossing trace returns frame times before, during, and after the handoff for both panes with GPU-process CPU labeled separately from GPU execution time.
