---
name: iron-maintain
description: Use when asked to prune, clean, slim, deduplicate or audit agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md, subagent docs) or memory indexes (MEMORY.md) — "save tokens", "clean the claude.md", "extract knowledge into memories", "the memory index is too big", or after a burst of corrections. Inventories canonical files, classifies every section, moves knowledge to its right home (instruction file, routed doc, Iron Memory), prunes, and proves nothing load-bearing was lost. Caveman output.
---

# Iron-Maintain — Instruction & Memory Hygiene

Closes the Iron loop: `irondev` / `iron-debug` / reviews **write** lessons → Iron Memory ranks and decays them → **iron-maintain** folds the survivors back into lean instruction files and prunes the rest. Run on request, after a burst of corrections, or when an instruction file passes its budget.

Inline by default: reading + rewriting prose ≠ a reason to fan out subagents.

**Flow:** inventory → signals → classify → relocate → prune → prove → commit-local → report

## §1 Inventory

Find canonical files only. Skip, and report the skip count:
- Git worktrees and mirrors of a repo already in scope — fixing the primary checkout fixes them.
- Third-party text (plugin caches/marketplaces, `site-packages`, package registries, vendored deps).

∀ file record: path, bytes, lines, **who loads it** (every session | on demand | non-Claude agents: Codex/Antigravity/Cursor | scripts), git repo + branch + dirty state.

V1: ⊥ edit a file another live session has uncommitted hunks in without keeping those hunks byte-identical. `git diff <file>` first.

## §2 Signals (Iron Memory, when available)

Gather evidence before judging:
1st `iron memory audit-drift --project <p> --repo <path>` → memories/rules whose referenced paths drifted from HEAD = STALE candidates.
2nd `iron memory consolidate --project <p>` → lessons repeated ≥3× = promotion candidates (KEEP in the instruction file, one line).
3rd `iron memory search '<section topic>' --project <p> --max-bytes 2000` → existing memory already covering a section = DUP-in-memory.
4th Morning Review Queue / Trust Desk in `iron ui` → contradictions and superseded entries to resolve, not copy.
5th `iron memory graph who-calls|impact` → a hand-written "Links"/"who calls what" section the system graph already covers = DUP; replace it with a one-line pointer to the graph query.

No Iron Memory → do the same checks with `rg` over the memory dirs + `git log`.

## §3 Classify

Each section gets exactly one class:

| class | test | destination |
|---|---|---|
| KEEP | must hold every session; breaking it costs data, money, prod, history or secrets | stays, compressed |
| ROUTE | needed only for one task kind (deploy, release, a subsystem map) | routed doc beside the file (`docs/agents/<topic>.md`) + a pointer row |
| MEMORY | lesson/incident/preference, not derivable from code, relevant only sometimes | memory entry (dedup first) |
| DUP | already said by a file that always loads with it (global file, parent AGENTS.md) | delete |
| STALE | contradicted by current code/config or a newer dated rule | delete — evidence from code, not memory |
| ENFORCED | a hook/guardrail/test already blocks the violation | ≤1-line pointer naming the hook |

V2: hard rules (push/deploy/secrets/prod-data/history-rewrite) = KEEP, even when verbose — compress, ⊥ relocate to MEMORY. Memories load by relevance; non-Claude agents never see them.
V3: AGENTS.md / GEMINI.md serve non-Claude agents → ROUTE docs, ⊥ memory links as the only source.
V4: STALE needs evidence (`rg` miss, file gone, newer dated rule, `audit-drift` hit). Unsure → KEEP + flag.

## §4 Relocate

1st memories: update the entry that already covers it; else a new one-fact file (frontmatter name/description/type; body + **Why:** + **How to apply:**) + index pointer. Superseding an older lesson → `iron memory remember --kind correction --supersedes <old_id>` so ranking decays the old one.
2nd routed docs: move the section **verbatim** (constraint wording intact), add a pointer row in the source.
3rd only then delete from the source.

## §5 Prune & compress

- One rule per bullet. State the principle + its edge case; ⊥ spell out a detection mechanic someone can route around.
- Judgment rule → one worked example + one rationale line, ⊥ paragraphs of hedging.
- Ordered process → literal 1st/2nd/3rd.
- Drop narration and history ("we used to…"); keep at most one **Why** clause on non-obvious rules.
- Tables for lookups (paths, ports, commands). Exact commands, paths, flags, ids stay verbatim.

**Budgets** (targets): global instruction file ≤ 8 KB; project file ≤ 8–12 KB; MEMORY.md ≤ 200 lines and ≤ 6 KB; one pointer ≤ 150 chars.

### MEMORY.md indexes
- `- [Title](file.md) — hook`, hook ≤ ~100 chars. Content inside an index line → move into its file.
- Pointer to a missing file → fix or drop. Two entries, same fact → merge files, one pointer.
- Group under short headings only past ~40 lines.

## §6 Prove

∀ pruned file, before commit:
- **Ledger:** every removed line → {kept-compressed | routed:<path> | memory:<id/file> | dup-of:<path> | stale:<evidence> | enforced:<hook>}. A removed line with no destination = restore it.
- Every routed/memory path written exists (`rg`/`ls`).
- Fresh-session read: does the new file still say how to build, test, push, deploy, and what never to do?
- Bytes before → after. Re-run `iron memory import` so the index sees the moves.

## §7 Commit

- Repo files: one local commit per repo, `docs(agents): prune <file>` (Conventional Commits). Dirty primary checkout → worktree branch. ⊥ push without the user's say-so.
- Harness/memory dirs with their own sync job → leave uncommitted unless asked.
- File that exists only on a feature branch → edit there and say so.

## §8 Report

```
## Iron-Maintain — Done
file | before → after | KEEP/ROUTE/MEMORY/DUP/STALE/ENFORCED | commit
Memories: +N new, ~M updated, -K merged/superseded
Flagged (unsure, kept): …
Skipped: worktrees/mirrors/third-party (count)
```

## V-Rules
V1–V4 above.
V5: ⊥ delete a rule because it "looks obvious" — obvious rules exist because something broke.
V6: ⊥ rewrite from scratch; edit section by section so the diff is reviewable.
V7: newer dated rule beats older; delete the older, keep the date on the newer.
V8: ⊥ secrets, tokens or real customer data into memories or docs.
V9: memory recall is evidence, ⊥ authority — verify against the repo before acting on it.
