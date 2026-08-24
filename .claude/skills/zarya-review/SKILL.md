---
name: zarya-review
description: Read-only pre-merge review of Zarya changes for correctness, governance semantics, eligibility snapshots, Chairman privilege boundaries, crash recovery, security, idempotency, and test coverage. Use when asked to review a diff or PR, or after a cross-cutting implementation. Reports findings; it does not apply fixes.
context: fork
agent: Explore
background: false
---

# Zarya implementation review

Review the current diff. Determine the scope yourself with `git diff` / `git status` — this runs in a forked context without the conversation history.

Read `__ai/references/CONTRACT.md` for the actual contract surface and `__ai/references/CONTRACT_DEFECTS.md` for the behaviors code most often gets wrong. Load other references only for the domains the diff touches.

Report findings in severity order. Focus on defects, not style.

## 1. Governance correctness

- Does any background path create proposals, cast votes, change quorum or approval, or transfer chairmanship?
- Does `executeVoting` stay mechanical and policy-free, with one argument?
- Are eligibility parameters read from the voting's snapshot rather than current organ configuration?
- Are the threshold setters treated as Chairman-only, and is the check `isMember` against the Chairperson organ rather than a comparison against a configured address?
- Does any code still call `castVote` with three arguments, or carry an organ on a vote intent or form? The organ argument was removed; the contract reads it from the voting.
- Is a threshold change submitted as one operation setting all three values? Setting quorum alone silently does nothing.
- Is an approval figure ever rendered without dividing by its own base? `5000` is 50%, not 5000%.
- **Is `InsufficientVotes` classified as terminal, and is the voting suppressed from future discovery?** A retryable classification hammers a settled political outcome forever. See "Quorum failure is permanent" in `CONTRACT_DEFECTS.md`.
- Is `region` an enum ordinal everywhere, including in anything a form supplies? A subject code silently addresses a different region.
- Does the error registry cover the four errors and three panics that are not in the ABI?
- Is the approval boundary tested at, one above, and one below the threshold? Is zero-vote behavior handled?
- Is an organ built from the structured triple via `getPartyOrgan`, not from a hashed label? Is the region encoding correct?

## 2. Irreversible-write safety

- Can a duplicate import, restart, or RPC ambiguity send a duplicate transaction?
- Is `PENDING` kept distinct from `FAILED`?
- Are same-wallet writes serialized or otherwise nonce-safe?
- Does manual recovery share the reconciliation path rather than reimplementing it?
- Could a stale ABI copy cause obsolete arguments to be submitted?

## 3. Trust boundaries

- Can a form produce arbitrary calldata, target, or method?
- Can a form reach a privileged setter without a dedicated intent variant?
- **Does any code read an app-authored field from a returned PDF for its value instead of recovering it via `operationRef`?** Highest-value question for any form-handling diff — `zarya.receipt.*` included.
- Can parsing execute PDF JavaScript or fetch a remote resource? Is XFA rejected rather than reconciled?
- **Is a receipt stamped from a broadcast rather than a confirmed transaction?** That produces a "sent" record that can become false after printing.
- Does an `executeVoting` receipt imply the proposal passed? It must not — a confirmed call is not an accepted proposal.
- Is a reverted transaction still stamped, and is absence of a receipt distinguishable from failure?
- Are IPC inputs validated at the receiving boundary, not just in the renderer?
- Are secrets or signers reachable from the renderer, logs, or the database?
- Are network and contract identity checked before writes?

## 4. Persistence and recovery

- Is chain state authoritative where it must be?
- Are uniqueness and idempotency keys correct — one execution job per `(chainId, contract, votingId)`?
- Are DB transactions scoped to local writes, never held across RPC calls?
- Is the event cursor restartable?

## 5. Tests

- Do tests cover the failure windows this change introduces?
- Are eligibility snapshot and Chairman authorization regressions covered?
- Are hostile PDFs and state races represented? Is there a form round-trip test?
- Does any test depend on live Sepolia? Ordinary checks must not.

## Output

Per finding: severity (`critical`/`high`/`medium`/`low`), exact file and line or function, a concrete failure scenario, why existing tests miss it, and the minimal remediation.

If nothing significant surfaces, say so and list residual untested risks rather than inventing issues.
