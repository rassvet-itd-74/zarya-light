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
| Documented `Zarya` address | `0x141eb27110329c82de3c95045c96f6ebf15fdc4b` |
| ABI (bundled) | `src/chain/abi/Zarya.abi.json` |
| Full build artifact | `contracts/Zarya.json` |

The address above is the documented deployment. Application code must read it from configuration, not from this file and not from a literal in domain code. Verify the configured address has code, and prefer an interface or version check where one is available.

`src/chain/abi/Zarya.abi.json` holds only the `abi` array (36 KB). The full artifact — `bytecode`, `deployedBytecode`, `metadata`, `methodIdentifiers` — stays in `contracts/Zarya.json`, outside the bundled tree. Import the trimmed file; deploy bytecode has no business in a renderer bundle.

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

The contract exposes **no** `getChairman()` getter. Chairman identity therefore comes from configuration (`CHAIRMAN`, per `temporal_docs/README.md:231`), not from a chain read. See `CONTRACT.md` for what this means for preflight.
