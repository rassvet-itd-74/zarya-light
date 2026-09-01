import { keccak256, stringToHex } from 'viem';
import {
  PARTY_ORGAN_TYPES,
  type PartyOrganTriple,
  partyOrganIdentifier,
  partyOrganTriple,
  scopeOf,
} from '../../domain/organs/partyOrgan';
import { REGION_COUNT } from '../../domain/organs/regions';
import { type Bytes32, bytes32 } from '../../domain/primitives';

/**
 * The reverse index: `bytes32` back to a readable organ.
 *
 * Every event and every cell getter returns an organ as a bare hash, and there
 * is no getter that inverts one. `PartyOrgans.from` is
 * `keccak256(abi.encodePacked(identifier))` over a plain string, so the only way
 * back is to hash candidate triples and look the answer up.
 *
 * This is the one place the client hashes an identifier itself. That is a
 * deliberate exception to "never hash a Cyrillic identifier string yourself",
 * which governs the *forward* direction — a triple heading for a call resolves
 * through the contract's own `getPartyOrgan`. Here there is no alternative, so
 * the table is treated as a guess until checked: `ZaryaOrganResolver` compares
 * the local hash against the contract's on every forward resolution, and the
 * fork test compares a sample of entries directly.
 *
 * ## The enumeration bound
 *
 * Global and regional organs are a **closed set** — 3 + 98 × 3 = 297 — because
 * their identifiers take no number. Local organs take a `uint256` with no
 * contract-side ceiling, so their share of the table is whatever range we
 * choose to enumerate.
 *
 * A hash outside the table resolves to `undefined`, and the caller shows the
 * hash. An organ we cannot name is a display gap; an organ we name wrongly is a
 * governance error, so the table never guesses.
 */

/**
 * Default ceiling for local organ numbers, inclusive. 98 regions × 100 numbers ×
 * 2 local types = 19 600 entries, plus the 297 closed ones. Raise it through
 * configuration rather than by editing this, and expect build cost and memory to
 * scale linearly.
 */
export const DEFAULT_MAX_LOCAL_ORGAN_NUMBER = 99;

/** Guards against a configured bound that would hash for minutes. */
export const MAX_SUPPORTED_LOCAL_ORGAN_NUMBER = 9_999;

export const organHashOf = (identifier: string): Bytes32 =>
  // abi.encodePacked of a single string is its UTF-8 bytes, unpadded — which is
  // exactly what stringToHex produces. The Cyrillic postfixes are two bytes per
  // character, and getting that encoding wrong would yield a plausible-looking
  // hash for a nonexistent organ.
  bytes32(keccak256(stringToHex(identifier)));

export interface OrganLabelTable {
  label(organ: Bytes32): string | undefined;
  tripleOf(organ: Bytes32): PartyOrganTriple | undefined;
  readonly size: number;
  readonly maxLocalOrganNumber: number;
}

interface Entry {
  readonly triple: PartyOrganTriple;
  readonly identifier: string;
}

export class OrganTableBoundError extends Error {
  constructor(received: number) {
    super(
      `the local organ number bound must be an integer in 0..${MAX_SUPPORTED_LOCAL_ORGAN_NUMBER}, received ${received}`,
    );
    this.name = 'OrganTableBoundError';
  }
}

/**
 * Enumerates every triple within the bound and keys them by hash.
 *
 * Built once and held for the process lifetime: the mapping is pure and can
 * never change for a given deployment, so there is nothing to invalidate.
 */
export function buildOrganLabelTable(
  maxLocalOrganNumber: number = DEFAULT_MAX_LOCAL_ORGAN_NUMBER,
): OrganLabelTable {
  if (
    !Number.isSafeInteger(maxLocalOrganNumber) ||
    maxLocalOrganNumber < 0 ||
    maxLocalOrganNumber > MAX_SUPPORTED_LOCAL_ORGAN_NUMBER
  ) {
    throw new OrganTableBoundError(maxLocalOrganNumber);
  }

  const byHash = new Map<string, Entry>();

  const add = (triple: PartyOrganTriple): void => {
    const identifier = partyOrganIdentifier(triple);
    // Collisions cannot happen — distinct identifiers, and keccak256 is not
    // going to oblige — but a duplicate key would mean the enumeration below
    // emitted the same triple twice, which is a bug worth not hiding.
    byHash.set(organHashOf(identifier), { triple, identifier });
  };

  for (const organType of PARTY_ORGAN_TYPES) {
    const scope = scopeOf(organType);
    if (scope === 'GLOBAL') {
      add(partyOrganTriple({ organType }));
      continue;
    }
    for (let region = 0; region < REGION_COUNT; region += 1) {
      if (scope === 'REGIONAL') {
        add(partyOrganTriple({ organType, region }));
        continue;
      }
      for (let number = 0; number <= maxLocalOrganNumber; number += 1) {
        add(partyOrganTriple({ organType, region, number }));
      }
    }
  }

  return {
    label: (organ) => byHash.get(organ)?.identifier,
    tripleOf: (organ) => byHash.get(organ)?.triple,
    size: byHash.size,
    maxLocalOrganNumber,
  };
}
