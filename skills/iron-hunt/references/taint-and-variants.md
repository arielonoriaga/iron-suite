# Structural Taint & Variant Queries (`iron-hunt`)

Run only the scanners matching languages/files present in the target repository. Batch independent read-only scans in a single shell invocation.

## 1. Fast CLI Triage Batch

```sh
# Secrets (git-aware: skips .gitignore, target/, node_modules/; single path arg only)
gitleaks git --staged --no-banner --redact .
gitleaks git --no-banner --redact .
# Untracked / non-git dir only (cap blob size so build caches never stall the scan)
gitleaks dir --no-banner --redact --max-target-megabytes 2 <single_subdir>

# Dependency & lockfile advisories (Rust, JS/TS/Bun, Python, Go, Docker)
osv-scanner scan source -r .
[ -f Cargo.lock ] && cargo audit
[ -f deny.toml ] && cargo deny check advisories bans sources

# GitHub Actions & container misconfigurations
[ -d .github/workflows ] && { zizmor .github/workflows; actionlint; }
fd -g '*Dockerfile*' -X hadolint

# Targeted SAST (telemetry off; scope to touched/high-risk directories on large repos)
semgrep scan --metrics=off --config p/security-audit --config p/secrets --error --quiet <target_dir>
```

## 2. Rust / Axum / SQLx `ast-grep` Hunt Patterns

Use `ast-grep run -l rust -p '<PATTERN>' <dir>` to locate sinks and sweep variants:

| Hunt Target | Pattern / Search | What to Check |
|---|---|---|
| Raw SQL construction | `sqlx::query(&format!($$$))` / `QueryBuilder::new($$$)` | Dynamic column/ORDER BY/IN-clause concatenation without bind params (`push_bind`). |
| Unchecked numeric cast / wrap | `$X as u32` / `$X as usize` / `$A * $B` in handlers | Negative `i64`/`i32` wrapping to huge `usize` allocation or price overflow; require `try_into()` + `checked_mul`. |
| Subprocess shell/command | `Command::new($BIN)` | User-controlled args, missing `.env_clear()`, missing `timeout` / `prlimit` on untrusted file parsers. |
| Global permit before tenant gate | `$SEM.acquire()` / `$SEM.try_acquire()` | Check whether a single `company_id` can exhaust all global permits or leak permits on cancellation. |
| Sensitive `Debug` / log leak | `#[derive($$$, Debug, $$$)]` on structs with `token`/`secret`/`password`/`cuit`/`dni`/`api_key` | Custom redacted `Debug` or `secrecy::SecretString` required so tracing/error logs never dump secrets or PII. |
| Non-constant-time secret check | `$SECRET == $INPUT` / `$HASH == $EXPECTED` | Replace `==` on MACs, API keys, webhook signatures, or reset tokens with `subtle::ConstantTimeEq` / `ring::constant_time`. |
| Missing tenant predicate | `rg -n "UPDATE |DELETE FROM " -g '*.rs'` | Every multi-tenant write/delete `WHERE` clause must bind `company_id` / `tenant_id`, not primary `id` alone. |

## 3. TypeScript / SolidJS / Node / Bun `ast-grep` Hunt Patterns

Use `ast-grep run -l ts -p '<PATTERN>' <dir>` (and `-l tsx` for JSX components):

| Hunt Target | Pattern / Search | What to Check |
|---|---|---|
| DOM / HTML sink | `innerHTML = $X` / `outerHTML = $X` / `insertAdjacentHTML($$$)` | Untrusted merchant/customer/LLM markdown or SVG reaching raw DOM without strict sanitizer. |
| Open redirect / `javascript:` URL | `window.location.href = $URL` / `href={$URL}` | Validate `https?:` scheme and host allowlist on `returnTo` / `redirect` / external storefront links. |
| Token in URL query | `` `${$BASE}?token=${$TOK}` `` / `searchParams.set("token", $$$)` | Leaks via Referer, nginx access logs, browser history, and APM traces; move to `Authorization` header or POST body + short-lived opaque code. |
| Child process / eval | `Bun.spawn($$$)` / `exec($CMD)` / `new Function($$$)` | Shell string interpolation, untrusted filename flags (`--` separator missing). |
| Trusting client tenant/role | `req.body.companyId` / `req.query.tenantId` / `c.req.json()` | Compare against authenticated session/JWT claim; client-supplied org/role/price fields are hostile. |
| ReDoS on user regex/filter | `new RegExp($USER_INPUT)` | Unbounded backtracking or syntax throw; escape literals or enforce RE2 / length cap. |

## 4. Turning 1 Bug into a Variant Sweep

1. Strip variable names from the vulnerable snippet down to its structural AST shape (`$REQ`, `$ID`, `$POOL`).
2. Run `ast-grep run -l <lang> -p '<shape>'` across all workspace crates/packages.
3. Partition hits into **vulnerable** (missing the invariant) vs **safe** (already guarded — cite where the guard lives so the fix reuses the repo's own proven helper).
