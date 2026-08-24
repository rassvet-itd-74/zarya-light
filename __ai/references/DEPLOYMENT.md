# Deployment and configuration

Single source for network, address, and artifact paths. Do not restate these values in other references, skills, or business logic — read them from runtime configuration.

## Network

```text
Sepolia
chainId = 11155111
```

Sepolia is the only permitted live network for this demo unless the user explicitly changes that requirement. Verify chainId before every write session and after every provider reconnect.

## Contract

| Item | Value |
| --- | --- |
| `Zarya` address | `0x6b31cC58a7DC5919f460068cF68D16281F360d25` |
| ABI (bundled) | `src/chain/abi/Zarya.abi.json` |
| Full build artifact | `contracts/Zarya.json` |
| Solidity source | `temporal_docs/Zarya.sol`, `temporal_docs/libraries/*.sol` |

Redeployed on 2026-08-24 to carry the contract fixes of that date. The previous deployment at `0x141eb271…` predates them and expects the **three-argument** `castVote`; do not point a current client at it.

Application code must read the address from configuration, not from this file and not from a literal in domain code. Verify the configured address has code, and — because two incompatible deployments now exist — verify the interface before writing. The cheapest discriminator is a `castVote` arity check: simulate the two-argument form and treat a decode failure as "wrong deployment", rather than discovering it on a real vote.

`src/chain/abi/Zarya.abi.json` holds only the `abi` array (36 KB). The full artifact — `bytecode`, `deployedBytecode`, `metadata`, `methodIdentifiers` — stays in `contracts/Zarya.json`, outside the bundled tree. Import the trimmed file; deploy bytecode has no business in a renderer bundle.

## Linked libraries

`contracts/Zarya.json`'s `metadata.settings.libraries` records the library addresses the deployed bytecode was linked against:

```text
Matricies    0xf26048871e3db76ae39a2be973152776906c3908
Votings      0x30c0c2968eb2b5b87e782b8aa3ce6c71fea0ac36
PartyOrgans  0x3ae769f099a191cac9b5783ce46e7568b55ccdb6
Regions      0x0ed66a9051c5ccff71a825e3588a98d65fb2ddbb
```

This matters for one reason beyond block-explorer verification: `Matricies` has `external` functions, so calls into it are `DELEGATECALL`s and Solidity leaves its events and errors out of Zarya's ABI. The logs still surface at the **Zarya** address, because a `DELEGATECALL` keeps the caller's context — which is why `ValueAdded` is subscribable despite being absent from the ABI. See "Symbols the ABI does not carry" in `CONTRACT.md`.

The same metadata lists `src/Zarya.sol` and the four libraries as the compilation sources, which is the evidence that `temporal_docs/` holds the source this artifact was built from.

## Brand assets

| File | Used for | Constraint |
| --- | --- | --- |
| `src/assets/logo.png` | Drawn onto form templates and receipts; Electron window icon | 120×120 RGBA. Inlined as a data URL via `?inline`, so no runtime path lookup. At print size it lands near 76 DPI — a larger or vector source is worth requesting |
| `src/assets/favicon.ico` | HTML favicon, `packagerConfig.icon`, Squirrel `setupIcon` | Single 32×32 image. **Cannot be embedded in a PDF** — PDF takes PNG and JPEG. Windows only; `.icns` and `.png` are absent, so macOS and Linux packaging fall back to the default Electron icon |

## Signers

| Role | Purpose |
| --- | --- |
| Member wallet | Document-driven proposal creation, `castVote`, privileged configuration |
| Executor wallet | `executeVoting` only |

`executeVoting` is permissionless in the ABI, so the executor wallet should hold no governance privileges. Keep it separate from the member wallet so a compromised executor key cannot cast votes or change eligibility policy.

## Chairman identity

The contract exposes no `getChairman()` getter, but Chairman identity **is** readable: the Chairman is stored as a member of the Chairperson organ, so `isMember(getPartyOrgan(Chairperson, 0, 0), candidate)` answers it. The configured `CHAIRMAN` value (`temporal_docs/README.md:231`) is which key we hold, not who the Chairman is — verify it against chain rather than trusting it. See `CONTRACT.md`.
