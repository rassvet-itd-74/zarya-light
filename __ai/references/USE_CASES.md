# Use cases and acceptance criteria

Observable behavior the client must exhibit. Each row is a test target. Sections are referenced by name and rows numbered within their section, so inserting a section never renumbers another.

## Template issuance

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Click a form button | Produces a pre-filled AcroForm PDF. No signer involved, no chain write |
| 2 | Pre-fill from context | Chain-derived context is written into `zarya.context.*` as read-only display fields |
| 3 | Operation recorded first | `operationRef` is persisted before the file reaches the user. A crash mid-issue leaves no unrecorded reference |
| 4 | Reproducible output | Same operation and schema version produce a byte-comparable form, so a fixture can pin it |
| 5 | Clean template | Generated file contains no scripts, actions, embedded files, or external references — it passes the app's own ingestion checks |
| 6 | Unavailable context | If a required chain read fails, issuance fails with a clear message rather than emitting a form with blank context |

## Matrix reference report

The printable coordinate index a voter consults to learn which `(x, y)` to write on a form.

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Click the matrix report button | Produces a read-only PDF with **no** AcroForm fields. No signer, no chain write |
| 2 | Coordinate index | Cells, themes, and statements are projected from coordinate-bearing events, gated on `VotingFinalized(success = true)` |
| 3 | Cursor reuse | The projection consumes the cursor voting discovery already maintains — no independent chain sweep |
| 4 | Per-cell detail | Coordinates, axis labels, categorical or numerical, owning organ, allowed categories with names, decimals, current value with author and timestamp |
| 5 | Axis inventory | Themes by `x` and statements by `y` listed separately, so a voter proposing a new value can find the row and column before a cell exists |
| 6 | Unresolved organ | A `bytes32` with no label renders verbatim; the cell is still listed. Never guessed, never omitted |
| 7 | Staleness stamp | Block number and chain timestamp on every page, from chain time not the workstation clock |
| 8 | Staleness disclosure | The page states that contents change and that coordinates are validated at submission |
| 9 | Partial read failure | A row that failed to load says so; a failed read fails the report rather than printing a plausible partial matrix |
| 10 | Cyrillic labels | Organ identifiers render correctly — the embedded font covers the range |
| 11 | Not ingestible | Feeding the report to form intake is rejected; it carries no `schemaVersion` |
| 12 | Stale coordinates used | A coordinate transcribed from an outdated report fails preflight with a clear message, never producing a wrong transaction |

## Form intake

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Import one filled form | Parses without sending a transaction; yields allow-listed intents or a clear validation error |
| 2 | Import many files or a folder | Creates a persisted batch; all files parsed and validated before any write |
| 3 | Invalid item in batch | Isolated; independent valid items still submittable; batch may end `PARTIAL` |
| 4 | Duplicate file | Detected by content hash; shown as already processed, not resubmitted |
| 5 | Semantic duplicate | Different files, same logical operation — detected by operation identity plus chain preflight. `hasVoted` is the final protection |
| 6 | Unknown schema version | Rejected with a clear message. Never parsed on a best-effort basis |
| 7 | Unknown or misspelled field name | Rejected. Never fuzzy-matched to the nearest known field |
| 8 | Tampered app-authored field | The file's `votingId`/`contract`/`organ` disagree with the record for its `operationRef`. Surfaced as a tamper warning; the database values are used and the file's are never read for value |
| 9 | Missing `operationRef` | Treated as unbound: full schema validation plus chain preflight, with no tamper check available |
| 10 | `operationRef` unknown or already completed | Rejected or shown as already processed. Never submitted blindly |
| 11 | Hostile PDF | Embedded JavaScript, launch or URI action, embedded file, external reference, compression bomb, or corrupted xref — rejected without executing or fetching anything |
| 12 | XFA present | Rejected. Never choose between XFA and AcroForm values |
| 13 | Flattened form | Detected and reported as flattened, not as an empty form |
| 14 | Encrypted form | Rejected with a clear message |
| 15 | Round trip | Issue a template, fill it programmatically, ingest it — the recovered intent matches the operation that produced it |

## Form-driven governance

Each maps one validated intent to one transaction, after preflight.

| # | Case | Call |
| --- | --- | --- |
| 1–2 | Membership / revocation proposal | `createMembershipVoting`, `createMembershipRevocationVoting` |
| 3–4 | Category / decimals proposal | `createCategoryVoting`, `createDecimalsVoting` |
| 5–6 | Theme / statement proposal | `createThemeVoting`, `createStatementVoting` — `simpleMajority` eligibility |
| 7–8 | Categorical / numerical value proposal | Preflight allowed category and cell organ; normalize fixed-point deterministically |
| 9–10 | Cast `FOR` / `AGAINST` | `castVote(votingId, support)` |
| 11 | Transfer chairmanship | Explicitly privileged; never routine or automatic |
| 12–13 | Configure organ thresholds | **One** operation carrying all three values, expanding to `setMinimumQuorum`, `setMinimumApprovalPercentage`, `setMinimumApprovalPercentageBase` |

Additional criteria:
- Row 2: preflight the Chairman-removal restriction (`CannotRemoveChairman`).
- Row 8: never silently round a governance value. Rounding or rejection policy is explicit and tested.
- Rows 9–10: `castVote` takes no organ argument, so no form supplies one. Authorization follows the access-control table in `CONTRACT.md`.
- Rows 12–13: **not three independent settings.** An organ whose `approvalPercentageBase` is zero ignores the other two and falls back to `simpleMajority`, so a form that sets only a quorum produces a transaction that succeeds and changes nothing — and no getter exists to notice. One intent carries all three, and a quorum or approval submitted with a zero base is refused by intent validation before any chain read. A base of zero *alone* is allowed: that is the deliberate reset. Signer verified as Chairman where possible, never generated by the executor, and a later threshold change does not retroactively alter an existing voting. Values are basis points; unit and base come from the contract.

## Bulk execution

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Bulk voting | Many `castVote` intents; one intent per transaction |
| 2 | Mixed batch | Proposals, votes, and privileged configuration together |
| 3 | Dependency | A later operation may need an earlier voting's ID. Symbolic references only if the form schema defines them |
| 4 | Failed dependency | Dependents blocked; unrelated items still processable |
| 5 | Long-lived dependency | May wait days. `WAITING_FOR_ONCHAIN_CONDITION` survives restarts |
| 6 | Partial submission | Confirmed items are never rolled back |
| 7 | Cancel | Stops only unsent work; mined transactions remain final |
| 8 | Resume | Restart or re-import reconciles and continues rather than replaying |

## Preflight and write failures

Each maps to a decoded custom error where the contract provides one.

| # | Case | Expected handling |
| --- | --- | --- |
| 1 | Not authorized for organ | `NotActiveMember`. Do not apply a member-only rule to a Chairman vote |
| 2 | Voting expired | `VotingNotActive` — do not cast; the executor may later finalize |
| 3 | Already voted | `AlreadyVoted` — idempotent completion, not a catastrophic error |
| 4 | Wrong network | Block all writes if chainId is not Sepolia |
| 5 | Wrong or missing contract | Block writes if the code or version check fails |
| 6 | Insufficient gas funds | Blocked or retryable; batch state stays coherent |
| 7 | RPC unavailable | Never convert unknown pending state into failed. Reconcile after recovery |
| 8 | State changed after preflight | Decode the revert and re-read chain state |
| 9 | Not Chairman | `NotChairman`. Checkable ahead of time via `isMember` against the Chairperson organ, and confirmed by simulation |
| 10 | Wrong organ encoding | `InvalidOrgan` / `UnknownRegion` — suspect the region-enum trap before anything else |

## Transaction recovery

| # | Crash window | Expected repair |
| --- | --- | --- |
| 1 | Before broadcast | Item remains retryable |
| 2 | After signing | Rebroadcast the identical raw transaction if an outbox exists; otherwise do not claim exactly-once |
| 3 | After broadcast or mining | Startup repairs local status from receipt and domain state |
| 4 | Pending | Never send a fresh higher nonce as a naive retry |
| 5 | Stuck | Surface `STUCK` and re-check. Replacement-by-fee is a separate feature using the same nonce |

## Receipts

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Transaction confirms | The returned form is stamped: `zarya.receipt.*` filled from the transaction record, then flattened |
| 2 | Transaction reverts | Still stamped, with `status = REVERTED` rendered as prominently as `CONFIRMED` |
| 3 | Broadcast but unconfirmed | No final receipt. Any provisional artifact says `PENDING` and is superseded on confirmation |
| 4 | Outcome unprovable | No receipt. Absence means "unknown", never "failed" |
| 5 | User pre-filled a receipt field | Overwritten unconditionally from the transaction record |
| 6 | Receipt re-imported | Rejected by the `txHash` marker; rejected again by the flattened-form check if the marker is stripped |
| 7 | `executeVoting` receipt | States the transaction outcome; does not claim the proposal passed |
| 8 | Receipt lost | Regenerated from the stored form plus transaction record, with no chain write |
| 9 | Batch of receipts | Written to one per-batch directory, named from `operationRef` and transaction hash — no dialog per form |
| 10 | Logo and identity | The Zarya logo appears on templates, receipts, and reports; no key material appears anywhere in the output |

## Automatic executive operations

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Discover overdue voting | Via `VotingCreated` cursor; `endTime <= chainTime && !finalized` |
| 2 | Execute | `executeVoting(votingId)` only. Never supplies policy |
| 3 | Accepted | Reconcile the applied mutation from `VotingFinalized(success = true)` plus domain reads. `ValueAdded` may be used for value cells — it does fire, though it is not in the ABI |
| 4 | Rejected, quorum met | `VotingFinalized(success = false)`. Terminal. Report as the chain's decision, never as a technical failure |
| 5 | Zero votes, or quorum not met | `InsufficientVotes`. **Terminal and never retryable** — the voting never finalizes, so it must be suppressed from later discovery passes |
| 6 | Nothing to execute | Healthy no-op; no transaction sent |
| 7 | Manual `Run now` | Runs the same full reconciliation loop |
| 8 | Worker restart | Reconciles rather than relying on lost timers |
| 9–10 | Another client executed first, or a race | `VotingAlreadyFinalized` — re-read and classify as completed |
| 11 | Eligibility changed after creation | Execution uses the voting's snapshot, never today's organ configuration |
| 12 | `votingId` 0 supplied | Rejected in domain validation rather than spending a call; the contract also rejects it |

## UI and audit

| # | Case | Acceptance |
| --- | --- | --- |
| 1 | Form buttons | One button per supported operation, each issuing a pre-filled template |
| 2 | Matrix report button | Prints the coordinate reference, alongside the form buttons since it is what a voter reads first |
| 3 | Batch overview | Ready, processing, confirmed, failed, blocked, skipped counts plus per-form status |
| 4 | Executive status | Health plus waiting/ready/pending/failed counts and one `Run now` |
| 5 | Transaction detail | Form identity and hash, `operationRef`, normalized intent, signer, contract, chain, tx hash, receipt, decoded error |
| 6 | Audit trace | `issued template → returned form → intent → transaction → chain result → receipt` |
| 7 | Tamper disclosure | A form whose app-authored fields diverge from its record shows the divergence plainly before submission |
| 8 | Receipt access | A confirmed item exposes its receipt, and can regenerate it if the file is gone |
| 9 | Configuration audit | Normalized organ and value plus tx hash. Effective thresholds cannot be shown — no getter exists |

## Read-only domain features

The app may read matrix themes, statements, categories, and history for validation, status, aggregation, template pre-fill, and the matrix report. These are read-only and must not be coupled to form parsing. Do not build UI that assumes a getter the ABI lacks — see the "Not exposed" table in `CONTRACT.md`.
