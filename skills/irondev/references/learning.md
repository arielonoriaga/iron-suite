# Durable learning

Write only what future work can use. Global/shared memory lives across both owner machines.

1. A finding the dev could have avoided → `~/.claude/agent-memory/<dev-agent>/feedback_<slug>.md` (the rule, **Why**, **How to apply**) plus one index line in that directory's `MEMORY.md`.
2. A bug the review missed that surfaced later (failed check, user correction, production) → `pattern_<slug>.md` in the review agent's memory, same shape.
3. An existing entry already covers it → do not add a file; bump a `seen: N` line in that entry. Entries seen 3+ times are promoted into the agent's own prompt by the harness reflector (`/improve`), with the user's approval — memory is the staging area, the prompt is where a proven lesson lives.

4. The project map (Skill `map`, update): links and scenarios the cycle added or revealed — the dev's `map_deltas`, the verifier's observed results as `observed @<sha>`.
5. Cross-client decisions or security/ops gotchas worth immediate recall across Claude, Codex, and Antigravity → save via `iron-memory` `memory_remember` (`project`, `agent`, `kind: decision|gotcha`) alongside curated Markdown.

Nothing new learned → write nothing. A memory that restates the agent's prompt or the repo's CLAUDE.md is noise.
