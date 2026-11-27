---
name: iron-browser
description: "Dual-viewport (390x844 Portrait + 1280x720 Landscape) Chromium developer browser & 19-tool Rust MCP server (`iron-browser` / `iron-browser-mcp`) with 3-tier mirrored pointer/keyboard input, HTTP/WS/SSE/SFS2X deduplication, native Rust `TabEventBus` (`browser_events` causal `gestureSeq`), WebGL draw-call & rendering-order inspection (`browser_webgl`), POS/slow-device emulation (`browser_emulate`), off-thread V8 CPU profiling (`browser_profile`), crash/hang diagnostics (`browser_health` / `iron-browser doctor`), embedded multi-CLI Agent Chat Dock, deterministic `browser_repro`/`browser_filmstrip`, `browser_trace_start`/`stop`, and silent `--smoke` offscreen verification. Use whenever testing responsive mobile+desktop UI parity, WebGL draw calls/render order, slow Android/POS hardware, live multiplayer/WebSocket/RGS apps, UX Labs, clipped overflow, or multi-viewport regressions."
---

# IronBrowser (`iron-browser` & `iron-browser-mcp`)

Site-agnostic dual-viewport Chromium developer browser (`https://github.com/arielonoriaga/iron-browser`, installed at `~/.local/bin/iron-browser` and `~/.local/bin/iron-browser-mcp`).

## When to Use `iron-browser` vs Other Browser Tools

| Tool | Best For |
| :--- | :--- |
| **`iron-browser` / `iron-browser-mcp`** | Simultaneous **Portrait (`390×844`) + Landscape (`1280×720`)** parity, UX Lab validation, mirrored click/type/key/scroll/canvas testing, **HTTP + WebSocket + SSE + SFS2X binary deduplication**, cross-viewport `sessionStorage` sync, `sunmi-v2-pro` / slow-device CPU & network emulation (`browser_emulate`), off-thread `.cpuprofile` hotspot profiling (`browser_profile`), `browser_incidents` cross-pane error grouping, `browser_events` causal `gestureSeq` forensics, `browser_repro`/`browser_filmstrip` frame-stepping, `browser_trace_start`/`stop` mark windows, `browser_health` / `iron-browser doctor` diagnostics, and silent `--smoke` headless checks. |
| **`browser-use`** | Single-tab automation inside the user's daily Chrome profile (existing SSO cookies) or stealth/multi-IP scraping via Browser Use Cloud. |

## Display & Focus Safety (`--smoke`)

When running automated verification, E2E scripts, or background probes while the user is working, ALWAYS pass `--smoke` (or `launchElectronSession({ smoke: true })` in `app/test/e2e/lib/electron-harness.ts`).
- `--smoke` launches IronBrowser hidden offscreen (`--class=iron-browser-e2e`, `show: false`) and uses compositor `ForceRedraw` + Aura bounds-nudge capture (`~50–390ms`) so **zero windows pop onto the user's active monitor**.

## Architecture & Synchronization Guarantees (`Dual + Mirror + Shared + Dedup`)

1. **Native Rust Node-API `TabEventBus` (`crates/iron-browser-bus` → `app/dist/native/iron_browser_bus.node`, `~878 ns/op`):**
   - Per-tab ring buffer (`2048` events/tab) across 13 domains: `gesture`, `navigation`, `http_dedup`, `ws_mux`, `storage`, `download`, `popup`, `callback`, `console`, `network`, `trace`, `mirror`, `lifecycle`.
   - **Causal `gestureSeq` (`1000ms` window):** Every mirrored interaction (`MirrorRelay` or `browser_interact`) opens a `gestureSeq` automatically attached to downstream HTTP replays, WS/SFS2X frames, `sessionStorage` writes, downloads, popups, and SPA route syncs.
   - **Atomic consume-once effect claims (`claimEffect`):** Suppresses duplicate mirrored file downloads (`will-download`, hardened with `reserveSafeDownloadPath`) and duplicate `window.open` popups across Portrait + Landscape.
   - **Token redaction:** All URL summaries on the bus scrub sensitive query and hash-route parameters (`token`, `jwt`, `secret`, `code`, `session`, etc.).
2. **Cross-Viewport `sessionStorage` Sync + Partition Isolation:**
   - In `session: "shared"` Dual tabs, a pre-script `Proxy` shim replicates `sessionStorage.setItem`/`removeItem`/`clear` live across Portrait and Landscape (`512 KB`/origin quota, strict `http`/`https` same-origin gate) and hydrates `sessionStorage` across reloads/same-origin navigations.
   - In `session: "isolated"` tabs (`iron-iso-<tabId>`), storage, cookies, mux, and dedup are strictly isolated between panes.
3. **Network & Real-Time Deduplication:**
   - **HTTP Mutations (`RequestDedupMiddleware`):** Deduplicates concurrent identical `POST`/`PUT`/`PATCH`/`DELETE` XHR/Fetch calls across panes, stripping 12 volatile correlation keys (`requestId`, `traceId`, `id`, `clientRequestId`, etc.) for matching and remapping the follower's correlation IDs into the replayed JSON body; decompresses `gzip`/`br`/`deflate`; fails open on `3xx`/`4xx`/`5xx`/streaming.
   - **WebSocket, SSE & SFS2X Binary Multiplexer (`WsSseMux`):** Shares one upstream `WebSocket` or `EventSource` per `(tab, origin, url, protocols)`, omits non-CORS-safelisted SSE headers on cross-origin streams, deduplicates outbound frames within `1500ms`, parses **SmartFoxServer 2X (`SFS2X`)** uncompressed & zlib-compressed binary packets (synthesizing follower Handshake/Login responses, deduplicating binary `Bet`/`Cashout` ExtensionRequests, and promoting slow owners across numbered cluster shards), and fails over cleanly on `1012` owner teardown.
4. **Navigation Convergence, Zero-Reload SPA Sync & Auth Route Reconciliation (`handleNavSync`):**
   - **One-shot 302 launch convergence:** Converges initial 302 session-token redirects (`?user=...&token=...`) from Landscape onto Portrait once per programmatic navigation without mobile/desktop redirect ping-pong.
   - **Main-frame SPA `spa_sync` & `spa_auth_reconcile`:** Ignores subframe `did-navigate-in-page` (`isMainFrame === false`), transitions main-frame `pushState`/`replaceState` routes in-page without dropping WebSockets/SSE, and reconciles diverged routes when one pane unlocks via `sessionStorage` auth or hits an interactive `target-not-found` miss on a stale route.

## Complete 19-Tool MCP Surface (`iron-browser mcp`)

| Tool | Purpose & Key Arguments |
| :--- | :--- |
| `browser_tabs` | List tabs, URLs, `mode` (`single`/`dual`), `mirror`, `dedup`, `session`, `dedupCount`, `loading`, and `viewportReport` (`requestedSize`, `effectiveCssSize`, `dpr`, `capturedPixels`, `sizeMismatch`). |
| `browser_open` | Open URL (`mode: "dual"\|"single"`, `session: "shared"\|"isolated"`, `portrait_preset`, `landscape_preset`, `portrait_size`, `landscape_size`). |
| `browser_navigate` | Navigate `tab_id` (syncs both panes in dual mode; `waitForTabReady` tracks `wcLoadStates` + `pendingReloads`). |
| `browser_screenshot` | Capture `portrait`, `landscape`, or `both` PNGs with `layoutAudit` (`clippedItems` selectors/bounds/`overflowPx`), `exact_size: true`, `highlight_clipped: true`, `clip`, and partial per-pane timeout recovery. |
| `browser_metrics` | Live telemetry: `gpuProcessCpuPercent` (separated from `gpuExecutionTimeMs`), per-pane CPU%/RAM MB, `rAF` FPS/p95/jank, CDP JS heap & DOM nodes, `mirrorMiss`, `dedupCount`, and active `emulation`. |
| `browser_interact` | Trusted Chromium `click` \| `type` \| `scroll` \| `key` \| `hover` via `selector` or normalized `(x, y)` with `mirror: true\|false` (opens causal `gestureSeq`). |
| `browser_console` | Bounded console entries (`viewport`, `level`, `limit`, `include_incidents`). |
| `browser_network` | Recent HTTP/WS entries (`filter: "all"\|"failed"\|"4xx"\|"5xx"`, `include_incidents`). |
| `browser_eval` | Evaluate JS in `portrait` or `landscape` with hard UTF-8 byte ceiling (`max_bytes: 256..262144`). |
| `browser_incidents` | Observational cross-pane failure grouping (`method + sanitizedPath + status` + linked console errors; keeps single-pane JS exceptions distinct). |
| `browser_repro` | `save` \| `load` \| `list` \| `delete` \| `open` \| `step` deterministic reproduction recipes (`seed`, `phase`, `frame`, `delta_frames`, `multiplier`) via `window.__ironSceneDriver`. |
| `browser_filmstrip` | Step across frames/recipe on both panes (`canvas_only`, `exact_size`) and export a metadata-stamped PNG filmstrip. |
| `browser_trace_start` | Start bounded rolling `rAF` frame-time + User Timing (`performance.mark`/`measure`) trace (`max_duration_ms`, `max_frames`). |
| `browser_trace_stop` | Stop trace and return `before`/`during`/`after` mark windows + separated `gpuProcessCpuPercent` vs `gpuExecutionTimeMs` + `emulation`. |
| `browser_events` | Query the native Rust `TabEventBus` (`domain`, `viewport`, `since_seq`, `gesture_seq`, `limit`) for causal end-to-end verification. |
| `browser_emulate` | Apply/reset `sunmi-v2-pro`, `low-end-android`, or custom `cpu_rate` (`1..20`), `network` (`slow-4g`, `3g`, `offline`, custom), UA, cores, RAM, `reduced_motion`, `save_data`, and `calibrate`. |
| `browser_profile` | Non-blocking V8 CPU profiler (`action: "start"\|"stop"`) returning off-thread bottom-up `selfMs`/`totalMs` hotspots, per-script breakdown, and a `0600` `.cpuprofile` path. |
| `browser_health` | Live main-thread event-loop lag, renderer crash/unresponsive flags, watchdog stalls, recent `main.log` tail, and offline Crashpad `.dmp` inspection. |
| `browser_webgl` | WebGL/WebGL2 draw calls, triangles/vertices, instanced draws, shader switches, texture binds, FBO render passes, GPU resource counts, 1-frame chronological draw-call log (`action: "capture_frame"`), and CSS/Canvas paint & stacking-context rendering order (`rendering_order`). |

## CLI & MCP Configuration

```bash
# Launch GUI, invisible smoke session, or offline-capable doctor check
iron-browser https://localhost:5173
iron-browser --smoke
iron-browser doctor

# Stdio MCP server (connects to $IRON_BROWSER_SOCKET or $XDG_RUNTIME_DIR/iron-browser/ctl.sock)
iron-browser mcp
```

```json
{
  "mcpServers": {
    "iron-browser": {
      "type": "stdio",
      "command": "iron-browser-mcp",
      "args": []
    }
  }
}
```
