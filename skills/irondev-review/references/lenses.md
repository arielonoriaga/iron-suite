# Review lens reference

Read only the sections needed for the risk assigned to this review. These retain the domain reasoning aids; they are not six mandatory passes. Global policy governs conflicts.

## L0 — Devil's Advocate (adversarial pass)

Use when a premise or design choice needs a deeper challenge. Assess the relevant question, not every item by rote.

- **Attack premise:** why this approach at all? simpler exists? steelman a credible alternative when the choice is material.
- **Invert:** if this code wrong, where would bug hide? assume malice/incompetence in caller.
- **Yagni audit:** ∀ abstraction → "what concrete need today?" speculative → cut.
- **Hyrum's Law check:** ∀ observable behavior = contract someone depends on. removing/changing = break.
- **Chesterton's Fence:** ∀ existing pattern this PR removes/bypasses → why was it there? proven obsolete?
- **Reversibility:** decision one-way door? if so, ! extra scrutiny. two-way → cheaper to ship.
- **Cost of being wrong:** worst case if this lands broken? rollback path exists?

Challenge questions ∀ finding:
1. Could opposite be true?
2. What expert disagrees & why?
3. Is critique actually style preference disguised as principle?
4. Author's constraint I don't see?

Flags: unjustified novelty, "best practice" cargo cult, premature abstraction, irreversible change w/o ADR, removed safeguard w/o replacement

## L1 — Correctness (AoPS)

- Decompose cleanly. ∀ code path preserve invariants.
- Boundaries: empty, null, zero, max, overflow, concurrent, negative, unicode, timezone, leap.
- Prove algo correct. Edge cases = theorems, ⊥ afterthoughts.

Failure modes: off-by-one, integer overflow/underflow, float precision (`0.1+0.2≠0.3`), TOCTOU, race conditions, partial writes, double-free, ABA, signed/unsigned mix, locale-dependent compare, NaN propagation, silent truncation.

Heuristics: prove postcondition from precondition + body. ∃ counterexample? loop variant decreases? recursion has base case + progress?

Devil challenge: "input that breaks this?" before accepting. Property-test mentally.

Flags: off-by-one, `doX(true)` bool param, magic number, ⊥ base case, deep if-else (⊥ guard clauses), unchecked arithmetic, missing await, swallowed Promise rejection

## L2 — Abstraction (SICP + Hickey + Ousterhout)

- ⊥ barrier leaks. Fns = one nameable idea. Complexity ∝ problem.
- Repeated structure → map/filter/fold. Mutable state minimal & co-located.
- **Simple ≠ easy** (Hickey): untangled > familiar. complect = sin.
- **Deep modules** (Ousterhout): small interface, big functionality. shallow module = liability.
- **Knowledge DRY** (Pragmatic): coincidental duplication ⊥ real duplication. extract at the second proven duplicate, as global policy requires.

Failure modes: leaky abstraction, premature DRY (coupling unrelated callers), god object, anemic domain, primitive obsession, feature envy, shotgun surgery, divergent change.

Heuristics: name fn aloud — "and"/"or" in name → split. param count > 3 → likely missing object. bool param → likely 2 fns. abstraction's user must know impl → leaky.

Devil challenge: "would inlining this be clearer?" ∀ wrapper. "does this abstraction earn its keep?" 

Flags: "and then also" fns, bool-flag selectors, raw data passing, setup+process+cleanup as 1 fn, repeated variants (⊥ higher-order), shallow wrapper, speculative generics

## L3 — Debuggability (Agans 9 Rules)

- Fresh reader reconstructs intent. ∀ implicit assumption = future bug.
- Errors surface w/ context. State changes observable. One change ⊥ 5 silent breaks.
- Agans: understand system | make it fail | quit thinking & look | divide & conquer | change one thing | audit trail | check plug | fresh view | if you didn't fix it, it ain't fixed.

Failure modes: silent failure, lost stack trace, error w/o context (`Error: failed`), nondeterministic repro, hidden side effect, time-dependent test, "works on my machine," log-and-continue, masking errors as defaults.

Heuristics: production failure → can I locate cause from logs alone? ⊥ → add context. ∀ try/catch → does catch decide or hide?

Devil challenge: "3am page — could oncall debug from this?" "stack trace lies — what does code actually do?"

Flags: `catch (e) {}`, `setTimeout` for sync ops, magic state changes, `console.log` debug residue, error → default value silently, mutex w/o timeout

## L4 — Systems (Unix + Postel + CAP)

- ∀ open must close (`using`/`defer`/`with`). ⊥ hidden global state.
- Errors propagate. Success → defined shape. Idempotent where relevant.
- **Postel:** liberal in accept, conservative in send (carefully — too liberal accept = security hole).
- **CAP:** under partition, pick C or A. ⊥ both. document choice.
- **End-to-end principle:** validate at boundary, trust within.
- **Fail fast** at startup, **fail safe** at runtime.

Failure modes: resource leak, connection pool exhaustion, unbounded queue, retry storm, thundering herd, cache stampede, split-brain, clock skew, network partition assumption, fsync missing, at-most-once vs at-least-once confusion.

Heuristics: ∀ external call → timeout? retry? backoff? circuit breaker? ∀ allocation → owner clear? ∀ shared state → sync primitive correct? lock order documented?

Devil challenge: "network drops mid-call — state consistent?" "process crashes here — recoverable?" "100x load — first thing breaks?"

Flags: global mutation, unclosed resources, error swallowing, shared global coupling, retry w/o backoff, timeout missing on I/O, unsynchronized shared state

## L5 — Design (Canon)

| Ref | Check |
|-----|-------|
| Clean Code | names reveal intent. fns ≤ 20 lines. ⊥ output args |
| GoF | pattern solves real problem, ⊥ decoration |
| DDD (Evans) | ubiquitous lang. bounded context. ⊥ cross-domain imports. aggregate roots enforce invariants |
| DDIA (Kleppmann) | consistency guarantees match req. ⊥ accidental eventual consistency. backpressure |
| EIP (Hohpe) | right messaging pattern. ⊥ polling where events fit. idempotent consumer |
| Pragmatic | DRY on knowledge. orthogonal. ⊥ broken windows |
| Refactoring (Fowler) | smell → named refactoring. ⊥ ad-hoc rewrite |
| PoEAA | data mapper vs active record matches need. unit of work explicit |
| Domain Modeling Made Functional (Wlaschin) | make illegal states unrepresentable. type as proof |

Failure modes: anemic model, transaction script masquerading as domain, leaky ORM, distributed monolith, shared DB across services, sync coupling where async needed, framework leaking into domain.

Heuristics: domain expert read aloud → recognize words? swap framework → domain survives? remove 1 class → what cascades?

Devil challenge: "pattern earning keep, or resume-driven?" "DDD vocabulary or DDD substance?" "would a junior find this?"
