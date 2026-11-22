---
name: iron-perf
description: Use when user asks to analyze perf, profile, find bottlenecks, measure baseline, or improve latency/throughput/Core Web Vitals. Measurement-first — produces evidence (flamegraphs, query plans, RUM data) BEFORE any change. Analyze-then-decide; execution of approved fixes goes to `irondev` w/ an optimization brief. Caveman output.
---

# Iron-Perf — Orchestrated Performance Analysis

Orchestrator. Measure first. Decide second. Optimize third (delegate to `irondev` w/ optimization brief).

**Flow:** scope → instrument → measure baseline → identify bottlenecks → cost-benefit → recommend (NOT execute)

## §1 Scope

! pin one of:
- **System-level:** host CPU, RAM, IO, network saturation
- **Service-level:** p50/p99 latency, throughput, error rate, sat
- **Endpoint-level:** specific route, specific query, specific component
- **Build/bundle:** JS/CSS size, code-split effectiveness, image weight
- **Cold-start:** time-to-first-byte, time-to-interactive, container boot

V1: ∀ analysis → primary metric ! chosen. "Make it fast" = reject.

## §2 Instrumentation

Pick tool by surface:

| Surface | Tool |
|---|---|
| host CPU | `top`, `vmstat`, `mpstat`, prometheus node-exporter |
| container CPU/mem | `docker stats`, cgroup metrics, cadvisor |
| backend hot paths | `perf record` + flamegraph, `pprof`, language profiler |
| SQL | `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_statements`, query log |
| HTTP latency | nginx access log p99, prom histogram, k6/wrk load |
| frontend RUM | Chrome DevTools, Lighthouse, web-vitals lib, RUM provider |
| bundle size | bundlephobia, source-map-explorer, webpack-bundle-analyzer |
| cold start | timed sequence: container start → healthy → first request 200 |

V2: ∀ baseline ≥3 samples. Single sample = noise.
V3: ∀ profile under representative load — empty traffic perf ≠ real perf.

## §3 Baseline

Record verbatim. Numbers + method + env.

```
metric: <name>
p50: <n>
p99: <n>
throughput: <n>/s
err_rate: <pct>
sat: cpu <pct> / mem <pct> / fd <pct>
sample_size: <n>
duration: <window>
env: <prod | staging | local — annotate diffs>
tool: <name + version + flags>
date: <iso>
```

V4: ! save baseline file (e.g. `perf/baseline-<surface>-<date>.md`) for future regression comparison.

## §4 Bottleneck Identification

Apply Amdahl. Rank candidates by time-share (not by gut-feel "looks slow").

```
rank | component | %time | bound-by | fix-class
1    | db_query_X | 62%   | cpu      | index | rewrite | cache
2    | json_ser   | 18%   | cpu      | swap lib | partial cache
3    | http_call  | 12%   | net      | parallelize | batch
```

V5: top-1 bottleneck < 30% of total time → optimization ceiling low; warn user, recommend defer.
V6: ⊥ recommend fix for bottleneck < 5% of total time. Noise.

## §5 Cost-Benefit

∀ candidate fix:

```
fix     | est gain    | effort | risk | net-recommended
index Y | -50ms p99   | S      | low  | YES
rewrite | -80ms p99   | XL     | high | LATER
cache   | -200ms p99  | M      | med  | YES
```

V7: ∀ fix → quantify gain BEFORE implementing. Speculative "should be faster" rejected.

## §6 Recommend (NOT Execute)

This skill ! orchestrator-only. Output = ranked recommendation list. User decides; on approval → hand brief to `irondev`.

**Optimization brief ! carry:** baseline (verbatim §3 block) + quantified budget (`≥X%` | `≤Y ms p99` | `≤Z MB` — ⊥ "faster") + regression guard + constraints (⊥ API change, ⊥ correctness regress). Post-change: ≥3 runs, median + p99, same env as baseline; gain <2% = noise floor → reject.

The budget + regression guard become irondev's Acceptance verbatim (e.g. `p99 /orders ≤ 120 ms over 3 runs, same env as baseline`), so `iron-verifier` re-measures on the reviewed commit, not the dev's word.

V8: ⊥ dispatch dev agent from this skill. Boundary: analysis here, optimization elsewhere.

## §7 Report

```
## Iron-Perf — Done
Scope: {system|service|endpoint|...}
Primary metric: {name + value}

Baseline:
  [verbatim block from §3]

Bottlenecks (Amdahl-ranked):
  [pipe table from §4]

Recommended fixes (top 3 by net-recommended):
  1. <fix> — gain X, effort Y, risk Z → dispatch via `irondev` w/ brief: ...
  2. ...
  3. ...

Out of scope / noticed:
  - <fix candidate that needs separate workstream>

Re-measurement plan: <when + how to verify after fix>
Regression guard: <metric + threshold + alert location>
```

## V-Rules

V1-V8 above.
V9: ⊥ optimization without baseline. ⊥ baseline without method + env.
V10: ∀ p99 claim → ! sample size declared.
V11: ⊥ confuse correlation w/ causation (CPU climbed AND we deployed X ≠ X caused climb; verify).
V12: ∀ frontend perf → measure on representative device profile, not dev laptop.
V13: cold-start metrics ! distinguish container boot vs app warm-up vs first-request latency.
V14: ∀ recommendation → tie to one ranked bottleneck. Floating "also we should..." = drop.
V15: name the limiter (CPU, memory, I/O, lock, network, an external quota) before any fix — a fix to a non-limiting resource gains nothing.
V16: limits arithmetic before promising a gain: removing X% of the work saves at most X% of the time (Amdahl); state the ceiling next to the estimate.
V17: ∀ benchmark → error/timeout count beside latency. A run that got faster by failing more = regression.
V18: before/after compared A/B/A/B, interleaved, ≥5 pairs on the same machine state — never two blocks measured minutes apart.
V19: confirm the work happened inside the timed region (rows written, requests served, cache misses) — an empty or short-circuited run times nothing.
