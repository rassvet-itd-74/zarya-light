---
name: zarya-intents
description: Define and validate Zarya's allow-listed typed intent model mapping parsed PDF forms to explicit governance actions. Use when adding operation types, schema validation, semantic identity and dedup keys, fixed-point normalization, symbolic dependencies, Chairman-only configuration intents, or mapping form fields to contract calls. No signing or raw ABI dispatch here.
---

# Zarya intent model

A strict semantic firewall between untrusted forms and chain integration.

Read `__ai/references/CONTRACT.md` for exact signatures and access control, and `__ai/references/CONTRACT_DEFECTS.md` for behaviors the intent model must not paper over. Trust rules: `__ai/references/INVARIANTS.md`.

## Closed union

A discriminated union, allow-listed. Adapt names to repository conventions.

- `CreateMembershipVoting`, `CreateMembershipRevocationVoting`
- `CreateCategoryVoting`, `CreateDecimalsVoting`
- `CreateThemeVoting`, `CreateStatementVoting`
- `CreateCategoricalValueVoting`, `CreateNumericalValueVoting`
- `CastVote`
- privileged `SetMinimumQuorum`, `SetMinimumApprovalPercentage`, optionally `TransferChairmanship`

`ExecuteVoting` is **not** a form intent — it is derived from chain state.

Never model `CallContract`, `ContractMethod`, raw target or calldata, or an arbitrary ABI function name taken from a form field.

Each variant corresponds to one `zarya.meta.operationType` and one set of `zarya.input.*` fields. Adding an intent variant means versioning the form schema — see `zarya-pdf-forms`. The two cannot drift apart.

## Organ is a triple, not a string

The contract takes `bytes32`, derived from `getPartyOrgan(uint8 organType, uint8 region, uint256 number)`.

Represent an organ in the intent as the structured triple:

```ts
interface OrganRef {
  organType: PartyOrganType;   // enum, not free text
  region: Region;              // enum value — see the encoding warning below
  number: number;              // 0 for federal and region-level organs
}
```

Preserve the label shown on the form for audit, but never derive the `bytes32` from it. Resolution happens in the chain adapter via the `pure` helper.

For a bound form the triple comes from the operation record, not from the returned file.

> The organ triple's `region` is the **enum ordinal**, not the subject code the whitepaper annotates. They differ for 50 of 98 regions and a wrong one silently addresses a different real region. If a form asks a human for a region, map the answer through a table — never pass the number through, and never store a subject code in the intent. See "Region ordinals are not subject codes" in `CONTRACT_DEFECTS.md`.

Identifier grammar for parsing display labels: `[NN.[X.]]TYPE` — federal organs carry a bare suffix (`СЗД`, `ПРЛ`, `СОВ`), regional add a region prefix, local add region and number.

## Validation layers

Keep separate: form parsing → intent schema validation → deterministic normalization → chain-dependent preflight. Never put network reads in schema validation.

## Values

- Addresses: checksummed and normalized through the project's library.
- `uint*`: strict decimal parsing. Reject negative and fractional input unless the intent explicitly represents fixed-point.
- Vote direction: explicit enum values mapped deterministically to boolean. Never sentiment.
- Strings: length-bounded, normalized only by documented rules.
- Quorum: an exact vote count. Never reinterpret as a percentage.
- Approval percentage: preserve the contract's unit and base. Do not rewrite `51` into another unit.
- Fixed-point: make conversion explicit and test the rounding or rejection policy. Never silently round a governance value.

## Privileged intents

`SetMinimumQuorum`, `SetMinimumApprovalPercentage`, and `TransferChairmanship` require their own `operationType` and their own template. They never originate from executor logic. Schema validation confirms shape only — authorization is the contract's job.

There are now **three** threshold setters — quorum, approval percentage, and approval percentage base — and they are not independent. An organ whose base is zero ignores the other two entirely and falls back to `simpleMajority`. So model threshold configuration as **one intent carrying all three values**, not three intents. A form that sets only the quorum produces a transaction that succeeds and changes nothing. See "The approval base doubles as an enable flag" in `CONTRACT_DEFECTS.md`.

Carry the values in the contract's own units — basis points by default — and never convert to percent in the intent.

## `CastVote` authorization

Do not encode "signer must be a member of the target organ" as an intent-validation rule. Authorization belongs in preflight and Solidity.

**`CastVote` carries no organ at all.** The call is `castVote(votingId, support)`; the contract reads the organ from the voting itself. So the intent has no organ field, and a form must not ask for one — an organ on a vote form is a field that cannot be honoured and invites a user to believe they are choosing something. Membership is checked against the voting's own organ, the Chairman is exempt, and theme and statement votings accept anyone.

## Semantic identity

Independent of file bytes. For a vote:

```text
chainId + contract + signer + votingId + operationType
```

Store direction for conflict detection. If the same signer imports both `FOR` and `AGAINST` for one voting, surface a conflict — never pick one.

For proposal creation, derive a stable hash from operation type plus normalized arguments plus signer and network context. For privileged configuration, include chain, contract, signer, operation type, organ, and normalized value — never collapse two different threshold values into one operation.

## Dependencies

A later operation may depend on an earlier one producing a voting ID. Since the app owns the schema, symbolic references are a design choice rather than something to discover — but they need a field in the schema before they exist here. Model them explicitly rather than stuffing unresolved strings into `votingId`:

```ts
type VotingRef =
  | { kind: 'id'; votingId: bigint }
  | { kind: 'operation'; operationId: string };
```

Do not implement symbolic references before the form schema defines the field that carries them.

## Mapping

Intent-to-adapter mapping must be exhaustive, with a `never` check so a new variant cannot silently fall through. A new Solidity method is not automatically a new form intent — add one only after product semantics, authorization, and a template are explicit.
