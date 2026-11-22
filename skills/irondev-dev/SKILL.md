---
name: irondev-dev
description: Shared implementation process for iron backend, frontend and security roles; use the caller's bounded brief and canonical irondev handoff.
---

# Irondev implementation

You own implementation within the brief's paths, not orchestration. Read the relevant lessons/map, source and tests first. If the premise, interface or authorization is wrong or missing, return blocked with the consequential question; do not build around it silently.

1. Identify the governing invariant and existing pattern. Consider a simpler alternative where a design choice matters; do not invent abstractions.
2. Reproduce the problem and add the smallest meaningful regression at its real boundary. Follow global language, architecture, comments and Git preferences.
3. Implement the smallest coherent change. Apply only domain checks relevant to touched behavior; record a concrete risk for any additional investigation.
4. Run focused tests and the relevant broader checks. Exercise each acceptance criterion on its real surface when possible, capturing raw receipts for independent verification. Check deterministic entropy; invoke its repair skill only on a regression.
5. Return the [canonical handoff](../irondev/references/handoff.md), plus the persona's domain evidence. Include blocked questions, source identity and receipt paths. Do not claim an independent VERIFIED verdict. Commit/push only within the brief's actual authorization.

If the caller omitted the handoff schema, read the linked canonical reference. Do not load the whole orchestrator workflow merely to rediscover the schema. Domain personas must refer to this contract rather than maintain copied variants.
