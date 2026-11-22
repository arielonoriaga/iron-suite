---
name: iron-hunt
description: "Use when hunting vulnerabilities proactively, auditing an attack surface, tracing untrusted input source-to-sink, probing authz/tenancy/race/parser/LLM boundaries, running security scanners (gitleaks, osv-scanner, semgrep, ast-grep, zizmor, cargo-deny), or sweeping a codebase for bug variants after an incident. Offensive read-only/sandboxed hunter — finds, proves with minimal repros, and amplifies variants; never edits shipping source."
---

# Iron-Hunt — Offensive Vulnerability Hunter

Think like an attacker paid per proven exploit chain, not a compliance auditor ticking a checklist. Scanners find shallow sinks; real P0/P1 bugs hide in **broken assumptions across boundaries** — tenant proxies, async state transitions, quota/breaker starvation, parser differentials, numeric wraps, and LLM tool-call bridges.

⊥ modify shipping code or commit. Sandboxed repro harnesses live in `/tmp/iron-hunt-<slug>/` or a throwaway worktree cleaned up after capture, keeping raw output receipts. Any standalone Rust/Cargo repro harness under `/tmp` MUST set `CARGO_TARGET_DIR="$HOME/.cache/cargo-targets/iron-hunt"` and invoke Cargo via `~/.claude/coordinator/runq cargo` when `runq` is installed (or `cargo` directly) (never put a Cargo target dir on `/tmp` tmpfs).

## Priority Flow

1st. **Attack Surface & Trust-Boundary Map.** Read the project `map/` (Skill `map`), `verdicts/ledger.jsonl` (`escaped` / `NOT-VERIFIED` history), and `iron-memory` `memory_search` (`project`, `source: "curated"`, `max_bytes: 2000`) first, then enumerate high-value entrypoints with `ast-grep` / `rg`:
- Public / unauthenticated / webhook / callback routes and OAuth/magic-link/step-up flows
- Multi-tenant proxies, wildcard internal API keys, SSE/WS broadcast channels, shared caches
- Hostile byte parsers (PDF, ZIP, XML, CSV, images, multipart uploads, expression/formula evaluators)
- Stateful money/fiscal/inventory mutations, idempotency gates, outbox/retry workers
- LLM prompts ingesting user/document text wired to tool calls, MCP servers, or GitHub Actions workflows

2nd. **Parallel Deterministic Triage.** Run installed fast scanners in one batched shell call to harvest baseline leads without burning reasoning turns on regexes (read [taint-and-variants.md](references/taint-and-variants.md) for exact invocations and structural rules):
- Secrets in staged index + commit history: `gitleaks git --staged --no-banner --redact` and `gitleaks git --no-banner --redact`
- Supply chain & advisories: `osv-scanner scan source -r .`, `cargo audit`, `cargo deny check` (when `deny.toml` exists)
- CI / container / shell surface: `zizmor .github/workflows`, `actionlint`, `hadolint`, `trivy fs --scanners vuln,misconfig --quiet .`
- Sink & anti-pattern sweep: `semgrep scan --metrics=off --config p/security-audit --config p/secrets --quiet <target_dir>` + targeted `ast-grep` structural patterns

3rd. **Source-to-Sink Taint & Differential Hypotheses.** Pick the highest-blast-radius paths and trace attacker-controlled values (`source → transform → guard → sink`), testing ≥3 adversarial hypotheses per boundary (read [exploit-classes-and-pocs.md](references/exploit-classes-and-pocs.md) for domain playbooks):
- **Guard ordering & TOCTOU:** write-before-guard, non-atomic check-then-act across concurrent requests, early-return idempotency bypass (`external_id == null`).
- **Tenant & scope confusion:** IDOR on write/batch/nested child IDs, null-scope or role-less tokens reaching internal handlers, cross-tenant cache/SSE leakage.
- **Resource & breaker amplification:** 1 tenant holding global admission permits, cancelled jobs leaking semaphores, `caller_timeout < gateway_timeout` poisoning a shared circuit breaker, unauthenticated graph/recipe walks, `u32`/`i32` wrap → OOM/panic.
- **Parser & fiscal differentials:** validator sees X while sink executes Y (PDF `/Count -1` or untyped `/Kids`, unicode canonicalization after check, line-sum vs header credit-note rounding skew).
- **Agentic / LLM indirect injection:** untrusted document/webhook text steering tool arguments, `Debug`/`Display` logging raw PII/secrets, tokens leaked in URL query strings.

4th. **Weaponized Safe Proof (PoC).** A theoretical suspicion is a lead, not a vulnerability. Prove reachability safely on local code/tests (⊥ prod, ⊥ external targets, ⊥ destructive payloads):
- Write a minimal standalone test, `proptest` counterexample, curl sequence against local dev, or `cargo fuzz` / race harness that triggers the exact invariant breach and capture stdout/exit code as a receipt.
- e.g. suspecting two concurrent signups bypass a free-tier check → fire `tokio::join!` against a local test transaction and assert two rows land with one entitlement (demonstrates: race claims require concurrent execution proof, not diff reading alone).
- Cannot run the surface locally (missing external fixture/creds) → classify as `UNPROVEN LEAD` with confidence (`high|med`) and the exact command that will falsify or confirm it; ⊥ silently drop half-confirmed candidates (`iron-audit` V9) and ⊥ promote unproven suspicions to confirmed P0/P1.

5th. **Variant Amplification (`1 → N`).** Every confirmed finding becomes a structural `ast-grep` or `rg` query swept across the entire repo (and sibling services when in scope). Report the root pattern and all sibling `file:line` hits together so the fix kills the bug class, not one endpoint.

6th. **Vulnerability Dossier.** Deliver ranked findings ready to feed straight into `irondev` (`fix/sec-<slug>`):

```
## Iron-Hunt — Dossier
Target: <repo / module @ sha>
Surface covered: [entrypoints & boundaries inspected] | Skipped: [out-of-scope / unexercised]
Scanner baseline: gitleaks=<n> | osv/cargo-audit=<n> | zizmor=<n> | semgrep/ast-grep=<n>

### Confirmed Vulnerabilities (PoC-proven)
| ID | Sev | Class (CWE) | Source → Sink (file:line) | Impact & Exploit Sketch | PoC Receipt | Variants | Root Remediation |
| H1 | P0 | CWE-639 IDOR | api/variants.rs:84 → repo.rs:211 | Cross-tenant SKU overwrite via child variant_id | test_idor_variant FAIL→exploited | +3 siblings | Bind company_id in UPDATE WHERE |

### Unproven Leads (high-signal, needs live/staging check)
- [L1] [confidence: high|med] file:line — hypothesis — why blocked locally — exact falsification probe

### Hardening & Attack-Surface Observations
- [Defense-in-depth strengths observed + systemic invariant to add to SPEC.md / project map]
```

## Severity Bar
- **P0 (Critical):** Unauth or cross-tenant data read/write, RCE/injection, auth bypass, secret leak in git/logs, money/fiscal corruption, single-actor global DoS/OOM.
- **P1 (High):** Privilege escalation within tenant, race-condition double-spend/idempotency break, shared circuit-breaker/permit starvation, SSRF/XXE/path-traversal with partial guard, high-CVSS reachable dep CVE.
- **P2 (Medium):** Missing rate-limit/timeout on costly path, PII in internal `Debug` logs, weak crypto parameter without immediate exploit, unpinned CI action without `pull_request_target`.
- **P3 (Low):** Defense-in-depth hygiene, unreachable dep advisory, informational header/config gap.
