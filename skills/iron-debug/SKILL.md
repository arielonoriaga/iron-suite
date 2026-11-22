---
name: iron-debug
description: Use when user reports a bug, prod incident, OOM, crash loop, mysterious latency, or "it's slow/broken/weird". Production-grade systematic debugging — repro → hypothesis → instrument → root cause → fix → backprop invariant. Caveman output. Different from superpowers:systematic-debugging — adds infra/Docker/DB/queue/perf forensics + iron-* agent orchestration.
---

# Iron-Debug — Orchestrated Debug Cycle

Orchestrator. ⊥ guess. ⊥ patch symptom. Every fix ! ties to evidence.

**Flow:** triage → repro → hypothesis tree → instrument → root cause → fix → backprop → report

## §1 Triage

Classify:
- **Severity:** S0 (prod-down) | S1 (degraded) | S2 (correctness) | S3 (latent)
- **Surface:** infra | backend | frontend | db | queue | network | cron | external-dep
- **Symptom-vs-cause:** what user sees ≠ what's broken. Record both columns.

V1: ∀ S0 → preserve evidence FIRST (logs, dumps, metrics snapshot) before touching anything.
V2: ⊥ apply fix until cause identified. "Try restart and see" = forbidden until §5.

## §2 Repro

Minimal repro recipe. Record:
```
trigger: <exact action>
env: <prod | staging | local>
freq: deterministic | intermittent (X/N) | one-off
window: <when first seen, last seen>
```

If intermittent → ! determine the variable (load, time-of-day, specific input, race).

V3: ⊥ "couldn't reproduce" → instrument further; bugs don't fix themselves.

## §3 Hypothesis Tree

Read the project map first (Skill `map`): the symptom's area Links and flows give the call path to walk, its invalid scenarios what should have refused this.

≥3 candidate causes. ∀ → falsifiable test. Rank by:
- prior probability (recent deploys, similar past bugs)
- cost-to-falsify (read logs < add instrumentation < re-deploy w/ trace)

```
H1: <cause> — falsify: <test> — cost: <low|med|high>
H2: ...
H3: ...
```

V4: single-hypothesis debugging = forbidden. Always ≥3 (one ! "something unexpected we haven't thought of").

## §4 Instrument

Add observability ! to discriminate between Hi. Examples:
- log line at suspect branch w/ correlation ID
- query plan: `EXPLAIN (ANALYZE, BUFFERS)` on suspected slow SQL
- `strace -p <pid> -c` 30s on hung worker
- `docker stats --no-stream` × N samples to confirm CPU/mem pattern
- prometheus query if observability stack exists
- `pprof` / `flamegraph` for CPU-bound

V5: ∀ instrumentation → remove after fix OR convert to permanent observability (metric/alert).

## §5 Root Cause

State in one sentence: `<file:line> does X under <condition> → <observable>`. ⊥ "race condition somewhere". ⊥ "memory leak in app".

Two fixes sharing one premise both failed the same check → name the premise, falsify it directly, then continue. ⊥ third fix on an untested premise.

If can't pinpoint → return to §3 w/ refined tree. Cap = 2 rounds (∴ ≤3 hypothesis trees total). Still no root cause after cap → surface the full investigation (repro recipe §2, every H tried + falsification results, instrumentation output §4) to the user, stop.

Escaped check: find the commit that introduced the root cause (`git log -L`/blame on the cited line) and run `~/.claude/hooks/verdicts/ledger.sh find-sha <repo> <commit>`. A hit means a verified change shipped this bug → `ledger.sh record <repo> <branch> <commit> escaped "<root cause one-liner>"` and, in §7, add a `pattern_<slug>.md` to `~/.claude/agent-memory/iron-verifier/` naming the check that would have caught it.

V6: ⊥ fix until root cause is one sentence + cited.

## §6 Fix

Dispatch matching `iron-*-dev` agent w/:
```
task: fix <root-cause one-liner>
repro: <recipe from §2>
constraint: ! reproduce should fail after fix; ! existing tests still pass; ! new regression test covering this exact path
```

Wait. Then dispatch matching `*-review` agent — special brief: "verify fix matches root cause; verify regression test fails without fix".

Review PASS → dispatch `iron-verifier` with `repo_path`, `branch`, the reviewed `commit`, and acceptance = "the §2 repro no longer reproduces on the running system" + the symptom's user journey. Record both verdicts with `~/.claude/hooks/verdicts/ledger.sh` as irondev's 5th step says; `NOT VERIFIED` goes back to the dev like a failed review.

## §7 Backprop

! invoke `backprop` skill — append §B row to SPEC.md (if exists) and consider new §V invariant.

```
B<n>: <date> | <cause> | <fix> | <V citation if any>
```

V7: ∀ S0/S1 bug → ! §V invariant amendment OR documented rejection. ⊥ silent fix.

Map: root cause sat on a link or path the map lacked or got wrong → fix the area (Skill `map`, update) and add the bug as an invalid scenario with `observed @<fix sha>`.

## §8 Report

```
## Iron-Debug — Done
Severity: S{0-3}
Symptom: <user-visible>
Root cause: <one sentence + file:line>
Hypotheses falsified: [H1 why, H2 why, ...]
Fix branch: {branch_name}
Regression test: <file:test_name>
Verified: <sha> — repro gone + journey ok | not verified: <why>
Escaped from verified change: <sha> | no
Backprop: B<n> appended | §V<n> added | rejected (reason)
Time-to-resolve: <hh:mm>
Telemetry added: [metric/alert names]
```

## V-Rules

V1-V7 above.
V8: orchestrator ⊥ write fix code itself — always via dev agent.
V9: ⊥ skip backprop on S0/S1.
V10: "fix" w/o regression test → NEEDS FIXES.
V11: revert ≠ fix. Revert preserves bug for next deploy.
V12: ∀ multi-system bug → identify which boundary owns the cause; fix there, not at the symptom layer.
