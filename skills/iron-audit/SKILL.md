---
name: iron-audit
description: Use when user requests a code audit, pre-release sweep, security/perf/arch health check, post-incident retrospective, or "is this codebase safe / fast / sane". Read-only orchestrator — dispatches review agents (no dev, no edits). Produces ranked findings w/ severity + remediation. Caveman output.
---

# Iron-Audit — Orchestrated Code Audit

Orchestrator. ⊥ write code. ⊥ commit. Read-only sweep across 4 lenses → ranked findings.

**Flow:** scope → 4-lens dispatch (parallel) → dedupe + rank → report

## §1 Scope

! quantify what's audited:
- **Surface:** repo | module | service | PR diff | branch
- **Lenses (any subset of 4):** `security` | `perf` | `arch` | `correctness` (! ≥2 selected)
- **Depth:** quick (top-of-file scan) | medium (deep on hot paths) | deep (every file)
- **Constraint:** time-box (≤30 min | ≤2 h | ≤1 day)

**History first:** `jq -c 'select(.kind=="escaped" or .result=="NOT-VERIFIED")' ~/.claude/verdicts/ledger.jsonl` filtered to this repo → bugs that shipped past verification and changes that failed it. Their files are the first hot paths for every lens; name them in the Report. Also run `memory_search` (`project`, `source: "curated"`, `max_bytes: 2000`) when `iron-memory` is available to pull prior open security/perf debt.

V1: ∀ audit → scope frozen up front. Drift = abort.

## §2 Dispatch (Parallel)

∀ selected lens → ONE message w/ multiple Agent tool calls, run in parallel.

| Lens | Agent | Brief focus |
|---|---|---|
| security | `iron-security-review` | authn/authz, crypto, secrets, input/output, deps |
| perf | `iron-backend-review` OR `iron-frontend-review` | hot paths, queries, allocations, bundle, Web Vitals |
| arch | `iron-backend-review` | boundaries, layering, DDD violations, coupling, dead code |
| correctness | `iron-backend-review` | invariants, error handling, idempotency, race conditions |

∀ agent → pass scope + constraint + lens-specific checklist.

V2: ⊥ sequential dispatch when ≥2 lenses — burns wall clock.

## §3 Dedupe + Rank

Combine findings. Drop duplicates (same file:line × same issue). Rank by:

```
severity: P0 | P1 | P2 | P3
P0: prod-impacting (data loss, RCE, OOM, SLO breach)
P1: latent prod risk (auth bypass, perf cliff, race)
P2: maintainability (arch debt, dead code, smell)
P3: stylistic / nit
```

∀ finding row:
```
id | severity | lens | file:line | issue | remediation | effort
A1 | P0 | sec | api/auth.rs:42 | JWT alg=none accepted | enforce HS256 whitelist | S
A2 | P1 | perf | api/db.rs:117 | N+1 in /orders | batch via IN clause | M
```

Effort: S (≤2h) | M (≤1d) | L (≤1wk) | XL (≥1wk)

V3: ⊥ P-anything w/o file:line cite. Hand-wave finding = drop it.

## §4 Report

```
## Iron-Audit — Done
Scope: {repo|module|branch}
Lenses: [{selected}]
Depth: {quick|medium|deep}
Time: {actual}

Findings: N total (P0: a, P1: b, P2: c, P3: d)

P0 (act NOW):
  [pipe table of A* rows]

P1 (act this week):
  [pipe table]

P2/P3:
  [collapsed, just IDs + one-liners]

Strengths observed: [non-trivial things the codebase does well]
Quick wins: [top 3 by impact/effort ratio]
Out of scope but noticed: [parking lot]
```

## V-Rules

V1: ⊥ write code or commit. Read-only.
V2: ⊥ single-lens audit if user asked for general health. Force ≥2.
V3: ∀ finding ! cite file:line. Hand-wave = drop.
V4: ∀ P0 → remediation feasibility checked (not "rewrite from scratch").
V5: ∀ audit → "Strengths observed" section ! present. Pure negativity = lazy review.
V6: dedupe BEFORE rank. Same issue counted ×3 by different lenses ≠ 3 issues.
V7: time-box ! enforced. Over-budget audit = stop + report partial.
V8: ⊥ act on findings from this skill. User decides what to fix.
V9: ⊥ silently drop a candidate finding for being half-believed rather than certain — flag it with a confidence note instead of dropping it. Self-censored candidates, not misjudgment, are the dominant cause of missed findings.
V10: depth setting narrows coverage, not the report — state in §4 what a quick/medium depth skipped (e.g. "quick scan: hot paths only, N files not opened"), ⊥ a silent subset presented as if it were the whole surface.
