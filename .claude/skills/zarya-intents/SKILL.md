---
name: zarya-intents
description: Define and validate Zarya's allow-listed typed intent model mapping parsed PDF forms to explicit governance actions. Use when adding operation types, schema validation, semantic identity and dedup keys, fixed-point normalization, symbolic dependencies, Chairman-only configuration intents, or mapping form fields to contract calls. No signing or raw ABI dispatch here.
---

# Zarya intent model

A strict semantic firewall between untrusted forms and chain integration.

Read `__ai/references/CONTRACT.md` for exact signatures and `__ai/references/DOCUMENTATION_STATUS.md` for what is unverified. Trust rules: `__ai/references/INVARIANTS.md`.

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

> The `Region` enum value probably differs from the subject code the whitepaper annotates (`74`, `77`). Resolve this before implementing organ mapping — `DOCUMENTATION_STATUS.md` #4.

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

`SetMinimumQuorum`, `SetMinimumApprovalPercentage`, and `TransferChairmanship` require their own `operationType` and their own template. They never originate from executor logic. Schema validation confirms shape only — authorization is the contract's job, discovered by simulation since no `getChairman()` exists.

## `CastVote` authorization

Do not encode "signer must be a member of the target organ" as an intent-validation rule. The Chairman may be allowed to vote in any organ; that rule is unverified and is chain-dependent either way. Authorization belongs in preflight and Solidity.

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
