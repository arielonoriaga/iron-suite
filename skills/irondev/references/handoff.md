# Canonical irondev handoff

The coordinator supplies this contract in bounded briefs; downstream roles read this file only when the contract is missing. Personas add domain fields instead of copying this schema. A caller using `repo_path`, `branch`, `commit` can be normalized to a commit subject only after checking the exact clean SHA. Infer available repository facts; missing evidence is not permission to invent a source identity.

`status: ok|partial|blocked|fail; source: {kind: commit|snapshot, repo, branch, sha|null, base_sha, snapshot_path|null, snapshot_id|null}; request; acceptance: [{id, expected}]; files_changed; tests_added; receipts: [{criterion_ids, source_id, command, exit_code, environment, output_path, observed}]; assumptions; questions; map_deltas; domain_evidence`.

A commit subject names the exact clean SHA, checked before and after execution. Before snapshot review, save an artifact directory outside shipping files with the base SHA, tracked binary patch, relevant added source files and a content manifest. Hash paths and contents, including deleted paths, to identify it; record index/worktree differences when they matter. Do not capture credentials or dependency caches. A snapshot subject captures the actual source used by the run: the tracked staged/unstaged state and relevant untracked source, with a manifest rooted at `base_sha`. Record pre-existing edits separately so reviewers judge the task diff without claiming them as their own. Read that state rather than `git diff base...HEAD` alone. Check its source manifest before and after execution; moved inputs invalidate the receipt. Snapshot passes apply only to local delivery. Once the user authorizes a commit, establish evidence for the resulting exact SHA before publication; patch-id or ancestry alone never carries a pass.

A receipt is raw evidence, not the implementer's reasoning. Relevant environment includes the build/test configuration, dependency state and external fixture needed to interpret the result; never record secrets. Missing evidence remains UNVERIFIED. A failed or absent reviewer is not a pass.

If an execution input cannot be captured, name it and its safe fingerprint in `environment`; if it cannot be checked, the affected criterion remains UNVERIFIED. Restore no user state as part of verification. The reviewer is independent of implementation and the verifier independently exercises real behavior.

## Committed-result ledger

The coordinator records each committed result immediately, before a repair loop, with `~/.claude/hooks/verdicts/ledger.sh record <repo> <branch> <sha> <kind> <result> "<receipt path or reason>"`:

| Kind | Results |
| --- | --- |
| review | PASS, NEEDS-FIXES |
| verify | VERIFIED, NOT-VERIFIED, SKIPPED |
| outcome | accepted, unresolved (note repair rounds) |

VERIFIED requires the exact clean SHA and complete acceptance evidence. A failed pin or missing criterion records NOT-VERIFIED with its reason; it does not claim the product is broken. A later failed verification must revoke the previous pass. SKIPPED is only for a change with no runnable surface, with the reason. Never insert a snapshot verdict under HEAD or another SHA.
