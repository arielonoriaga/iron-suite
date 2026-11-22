# Security Review & Implementation Playbooks (LS13–LS14 + Proof Gates)

Read only when a change or review touches multi-tenant boundaries, admission/breaker controls, untrusted file/document parsers, LLM/tool bridges, or fiscal/monetary math.

## LS13 — Multi-Tenant, Admission & Breaker Isolation

- **Server-derived tenant binding:** Every DB query (`SELECT`/`UPDATE`/`DELETE`), cache key, storage prefix, and realtime topic (SSE/WS) binds `company_id`/`tenant_id` from verified server auth context. Child-resource mutations (`variants`, `items`, `attachments`) join or filter by both parent ID and `company_id`, never child PK alone.
- **Proxy & wildcard service keys:** When a downstream service (`ez-addon`, `ez-images`, internal workers) authenticates callers via a shared/wildcard key, the upstream proxy is the sole tenancy boundary: reject `null`/empty tenant or scope claims before forwarding; never fall back to global scope.
- **Per-tenant fairness before global permits:** Check per-tenant in-flight caps *before* acquiring process-wide semaphores so one tenant cannot hold all global worker slots. Hold permits in RAII guards so cancelled, panicked, or timed-out tasks always release capacity.
- **Timeout & circuit-breaker hierarchy:** Enforce `caller_timeout > gateway_timeout > worker_timeout` (or exclude expected slow-input/client-cancellation timeouts from shared circuit-breaker trip counters) so adversarial slow documents cannot trip a shared breaker across tenants.
- **Unauthenticated fan-out caps:** Public feeds, storefront endpoints, and webhooks bound recursion depth, recipe/combo expansion, and batch line counts before hitting DB/CPU work.

## LS14 — Untrusted Parsers, LLM/Tool Bridges & Fiscal Integrity

- **Hostile document & archive firewall:** Parse untrusted PDFs, ZIPs, XML, spreadsheets, and images inside timeout + memory/CPU-bounded workers (`rlimit` / isolated child). Reject structural evasions: negative `/Count` or untyped intermediate `/Kids` nodes in PDFs, ZIP central-directory ratio spoofing, magic-byte vs Content-Type mismatches.
- **Indirect prompt injection & agentic tools:** Treat any text extracted from documents, emails, chats, webhooks, or scraped pages as attacker-controlled prompt injection. Deterministic code — never prompt wording — enforces tenant scope, role authorization, outbound URL allowlists (with DNS-rebinding IP pin), and spend/row budgets on every tool call.
- **Zero secret/PII leakage in telemetry & URLs:** Structs carrying credentials, tokens, tax IDs, or extracted customer documents implement redacted `Debug`/`Display` (or wrap fields in secret types). Tokens, magic links, and OAuth verifiers never ride in URL query strings where Referer, proxy logs, and APM traces capture them; consume single-use tokens atomically (`UPDATE ... WHERE used_at IS NULL RETURNING` or `DELETE ... RETURNING`) *before* executing privileged writes.
- **Checked arithmetic & fiscal reconciliation:** Use `checked_add`/`checked_mul`/`try_from` on user-influenced counts, dimensions, and multipliers (`i32`/`u32` wrap → OOM or panic). Prove credit-note, discount, and surcharge math reconciles `SUM(line_subtotal)` against header totals without rounding drift.

## Security Proof Gates (Required on Security Fixes & Reviews)

1. **Deterministic scanner receipts:** Where applicable to touched files, run installed CLI checks (`gitleaks`, `osv-scanner`, `cargo audit` / `cargo deny`, `zizmor` / `actionlint`, `ast-grep` / `semgrep`) and record raw command output in `receipts` rather than relying on eyeball regexes alone.
2. **Variant sweep (`1 → N`):** Before closing a confirmed vulnerability, sweep the repository with `ast-grep` / `rg` for sibling occurrences of the same structural pattern and state siblings fixed or filed.
3. **Non-vacuous abuse test (mutation check):** Every security regression test must fail for the expected security reason when the guard is inverted or removed (proving the test exercises the real constraint — e.g. real PG `23505`, `403`, or rejected token — not a tautological mock).
