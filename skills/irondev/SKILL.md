---
name: irondev
description: Implement non-trivial features, fixes and refactors with bounded ownership, independent review and observable acceptance evidence. Use a single implementer unless separate work benefits from delegation.
---

# Irondev

Own the outcome and integration. Implement directly when the task fits one context; delegate independent domains only when their interface and owned paths are settled. A specialist can challenge the brief or return blocked. Trivial tasks use the global exemption.

1st. **Brief.** Record outcome, user's request, repository/worktree and branch, task paths/baseline, relevant patterns/map/lessons, acceptance criteria, and explicit authorization. Each acceptance criterion names observable behavior, including stored state where relevant. Use existing plans; run scoped design review only when its trigger applies. For a critical vulnerability, agree a private branch/embargo path before any public disclosure.

2nd. **State.** Honor the user's branch and preserve unrelated edits. Use a worktree for non-trivial branch work. Dirty user state, an existing branch or a diverged base is not permission to stash, reset, overwrite or invent a sibling; resolve the conflict before dependent writes. When a new branch is needed, resolve the repository default branch first and update only with a safe fast-forward. Backend/frontend/security branches follow project conventions (`{type}/be-`, `fe-`, `sec-` where applicable).

3rd. **Build.** Use the matching iron dev role if delegated. Give it the brief, relevant lesson pointers and exact ownership, not conversation history. Shared files have one owner. Return the canonical handoff plus relevant domain evidence: migrations/query behavior, UI/a11y/bundle effects, or threats/abuse tests. Do not invent measurements for untouched concerns.

4th. **Review.** Dispatch one independent matching reviewer with user request, acceptance, source identity, complete task diff/file manifest and raw receipts. Omit the implementer's explanation and claimed verdict. Additional reviewers each need a distinct risk (for example tenant isolation or migration rollback), not another copy of the same checklist. A reviewer never edits implementation. A blocking finding needs reproducible evidence; verify it before sending a fix request. Preserve unproven concerns as questions. Each reviewer ends with PASS or NEEDS FIXES; a missing/invalid verdict is not a pass. Independent review is required after a dev dispatch; the implementer never serves as that reviewer.

5th. **Verify.** After review passes, dispatch `iron-verifier` with source identity, acceptance and check receipts. It exercises unproven real-surface behavior and relevant regression journeys. Reuse an existing suite receipt only at the same exact SHA and relevant command/environment; repeat only invalidated or missing checks. For an uncommitted local task, verify the captured snapshot and report LOCAL VERIFIED, never a release verdict. Docs-only work with no runnable surface may be SKIPPED with a reason.

6th. **Repair.** Return confirmed findings to the owner. Re-review changed risk areas and establish receipts for the new exact SHA/snapshot. Retain old receipts as context, never as a pass for changed source. At most two repair re-dispatches. When the same assumption failed twice, name and test it directly before another attempt. Stop the dependent path if unresolved; continue authorized independent work.

7th. **Record and deliver.** For committed subjects, record every review/verification result as it arrives, including failures, against the requested exact SHA using the canonical ledger instructions. VERIFIED requires the matching clean state; include the raw receipt path or pin-failure reason in the note. Never record a local snapshot as VERIFIED for HEAD. For local subjects, keep receipts outside shipping files and name the snapshot in the report. Report behavior changed, source identity, checks/results, gaps and authorization still owed. Add a lesson/map update only for new durable knowledge; deduplicate existing entries. Read the [learning convention](references/learning.md) when recording a new or recurring lesson. Record accepted/unresolved outcomes and repair rounds for committed cycles.

## Handoff

Use the single [canonical handoff](references/handoff.md) for implementation and downstream briefs. Include it once in each dispatch; persona prompts add domain evidence without copying the schema. The source may be an exact clean commit or a captured local snapshot; snapshot verification never authorizes publication of HEAD.

## Unattended work

Record decisions and evidence in the task's artifact directory. Continue independent authorized work when one path is blocked. Check progress against acceptance until done or blocked; do not add a timer-driven review loop. Use a fresh worktree from the authorized base and keep a decision log. Being unattended grants no additional commit, push, merge, deploy, paid-call or outward-action authority.
