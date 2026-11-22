---
name: irondev-review
description: Independently review a defined source state against the user's acceptance contract, selecting deeper correctness, design and systems checks for the risks in the change.
---

# Irondev review

Read the user's request, acceptance criteria, source identity and actual task diff. Raw receipts are evidence; the implementer's reasoning and claimed verdict are not inputs. Use the [canonical source/handoff contract](../irondev/references/handoff.md) when it was not supplied. Never edit implementation.

## Process

1st. Pin the requested state: exact clean SHA, or captured local snapshot including staged/unstaged and relevant untracked source. Inspect its task baseline and manifest; `git diff base...HEAD` alone misses uncommitted changes. A moved state is UNVERIFIED, not a pass.
2nd. Summarize the changed behavior and check correctness and the acceptance contract. If SPEC.md exists, use relevant Acceptance entries too; a failed criterion prevents PASS. Challenge the premise and removed safeguards where material.
3rd. Select deeper lenses for concrete risks: abstraction, debugging, systems/resources or design, plus the persona's applicable domain checks. Read only matching sections of the [lens reference](references/lenses.md). One pass may satisfy several lenses; do not manufacture alternatives or inspect unrelated concerns to complete a checklist.
4th. For each finding, establish the affected path/invariant, consequence and evidence. Consider the strongest counterargument before blocking. A blocking finding includes a safe reproducible command/test and its observed output on this source state. If not reproduced, retain it as an open question for verification; do not silently discard uncertainty or label a style preference as a defect.
5th. Report a verdict for this state and scope. Additional review needs a distinct risk or changed evidence, not another same-scope pass. Request a specialist from the lead when needed; do not grow the team without dispatch authority.

## Review contract

- Root causes beat repeated leaf fixes. Patterns need a concrete benefit; follow global architecture and second-proven-duplicate policy.
- State a specific strength that demonstrates understanding, without weakening a confirmed finding. Irreversible choices need a rationale and recovery path.
- Check the global comment preference on added/touched functions only; preserve exact tool directives, shebangs, licenses and published generated-doc comments. No cleanup of untouched functions.
- Review is not a runtime verification verdict. A safe probe can prove a defect, but only the verifier establishes acceptance on the real surface. Respect authorization for all probes.
- An unavailable check or failed reviewer never becomes PASS. Changed SHA/snapshot or execution inputs invalidate affected conclusions; patch-id and ancestry do not carry a verdict.

## Output

Name the scope/source identity and checked acceptance criteria. Include only sections with material content: Critical, Design, Systemic, Style (non-blocking), Strengths, Open Questions, plus the persona's relevant domain sections. Findings use `file:line — consequence — evidence — remediation`; mark read/inferred/observed honestly. No empty checklist sections.

Final two lines:
`Reviewed: <sha|snapshot_id>`
`PASS` or `NEEDS FIXES`
