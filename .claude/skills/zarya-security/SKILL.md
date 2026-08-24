---
name: zarya-security
description: Threat-model a Zarya change touching untrusted PDF forms, Electron IPC and process isolation, wallet secrets, Chairman privilege separation, network guards, logging, or privileged automation. Use for any change that handles files, IPC, signing, external content, or irreversible chain effects.
---

# Zarya security

The controls themselves are in `__ai/references/INVARIANTS.md` — form trust boundary, Electron boundary, secrets, chain safety, writes and recovery, agent safety. Read that first. This skill is the procedure for applying them to a specific change.

## Threat-model the change

Name each of these for the diff at hand:

- untrusted inputs it accepts
- privileged process or tool it runs in
- secret material it can reach
- external network boundary it crosses
- durable data it writes
- irreversible chain effect it can cause
- governance privilege it requires

Then enforce the narrowest boundary that still works, and state which invariant each control implements.

## High-privilege operations

Treat these as requiring explicit justification in the change description:

- `setMinimumQuorum`, `setMinimumApprovalPercentage`, `transferChairmanship`
- anything that signs with the member wallet
- anything that widens the preload surface
- anything that persists or logs transaction payloads

Each needs: an explicit form intent, a clear preview and audit trail, the member signing path rather than the executor path, contract-enforced authorization, and a test proving an ordinary signer cannot perform it.

There is no `getChairman()`, but Chairman identity is readable via `isMember` against the Chairperson organ. Use that for UX and still simulate before writing — the answer can change between preflight and mining, and the contract is the authorization boundary either way. Never substitute a comparison against a configured address for either.

## Executor key blast radius

The executor wallet exists specifically to limit damage. Verify for any executor-path change that a compromised executor key still cannot cast a vote, create a proposal, change eligibility policy, or transfer chairmanship. `executeVoting` is permissionless, so the executor needs no governance privilege at all.

## Review questions

Answer these before finishing:

1. Can the renderer cause an operation outside the allow-listed API?
2. Can a malicious form select an arbitrary target, method, or calldata?
3. **Does any code path read an app-authored field for its value from a returned form, rather than recovering it via `operationRef`?** That is the defect this format invites.
4. Can a form cause PDF JavaScript to run, or a remote resource to be fetched, during parsing?
5. Can a restart or RPC ambiguity duplicate an irreversible write?
6. Can an RPC outage be mistaken for a confirmed failure?
7. Can a compromised executor key influence a governance outcome?
8. Can a non-Chairman form path reach a Chairman-only setter?
9. Can the client target a network other than Sepolia?
10. Are any secrets persisted or logged in plaintext?
11. Does a wrong region encoding silently address the wrong organ rather than failing loudly?
