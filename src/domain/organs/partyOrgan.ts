import { InvalidPrimitiveError } from '../primitives';
import { type RegionOrdinal, regionOrdinal, subjectCodeOf } from './regions';

/**
 * A party organ as the domain carries it: the structured triple, never a label
 * and never a hash.
 *
 * `PartyOrgans.from` builds an identifier string and hashes it. The client
 * carries the inputs to that, because the hash is one-way and the label is a
 * rendering. `zarya-chain`: never store an organ as a display label.
 *
 * The scope distinction is load-bearing. Three of the eight types ignore
 * `region` and `number` entirely (`PartyOrgans.sol:75-80`), so
 * `getPartyOrgan(Chairperson, 74, 3)` and `getPartyOrgan(Chairperson, 0, 0)`
 * are the *same organ*. Normalizing on construction is what makes structural
 * equality and dedup keys correct — otherwise a Chairperson organ carrying a
 * stray region compares unequal to itself.
 */

/** In `PartyOrgans.PartyOrganType` declaration order — the index is the argument. */
export const PARTY_ORGAN_TYPES = [
  'LocalSoviet',
  'LocalGeneralAssembly',
  'RegionalSoviet',
  'RegionalConference',
  'RegionalGeneralAssembly',
  'Chairperson',
  'CentralSoviet',
  'Congress',
] as const;

export type PartyOrganType = (typeof PARTY_ORGAN_TYPES)[number];

/**
 * Which of `region` and `number` an organ type actually reads.
 *
 * - `LOCAL` — both.
 * - `REGIONAL` — region only; `number` is ignored.
 * - `GLOBAL` — neither. A single organ for the whole party.
 */
export type OrganScope = 'LOCAL' | 'REGIONAL' | 'GLOBAL';

const SCOPES: Readonly<Record<PartyOrganType, OrganScope>> = {
  LocalSoviet: 'LOCAL',
  LocalGeneralAssembly: 'LOCAL',
  RegionalSoviet: 'REGIONAL',
  RegionalConference: 'REGIONAL',
  RegionalGeneralAssembly: 'REGIONAL',
  Chairperson: 'GLOBAL',
  CentralSoviet: 'GLOBAL',
  Congress: 'GLOBAL',
};

export const scopeOf = (organType: PartyOrganType): OrganScope => SCOPES[organType];

/** The `uint8` the ABI takes. Derived from declaration order, never written twice. */
export function partyOrganTypeOrdinal(organType: PartyOrganType): number {
  return PARTY_ORGAN_TYPES.indexOf(organType);
}

export function partyOrganTypeByOrdinal(ordinal: number): PartyOrganType {
  const found = PARTY_ORGAN_TYPES[ordinal];
  if (found === undefined) {
    throw new InvalidPrimitiveError(
      `an organ type ordinal must be in 0..${PARTY_ORGAN_TYPES.length - 1}`,
      ordinal,
    );
  }
  return found;
}

export interface PartyOrganTriple {
  readonly organType: PartyOrganType;
  /** Ignored by `REGIONAL`-scope types' `number` and by `GLOBAL` types entirely. */
  readonly region: RegionOrdinal;
  readonly number: number;
}

export interface PartyOrganTripleInput {
  readonly organType: PartyOrganType;
  readonly region?: number;
  readonly number?: number;
}

/**
 * `number` is `uint256` in Solidity and has no contract-side bound. Bounded here
 * to the safe-integer range because it is rendered decimally into the identifier
 * and must round-trip exactly; a value that lost precision would hash to a
 * different organ than the one displayed.
 */
const MAX_ORGAN_NUMBER = Number.MAX_SAFE_INTEGER;

/**
 * Validates and **normalizes**: fields the contract ignores are forced to zero,
 * so two triples naming the same organ are the same object shape.
 */
export function partyOrganTriple(input: PartyOrganTripleInput): PartyOrganTriple {
  const scope = scopeOf(input.organType);

  if (scope === 'GLOBAL') {
    return { organType: input.organType, region: regionOrdinal(0), number: 0 };
  }

  if (input.region === undefined) {
    throw new InvalidPrimitiveError(
      `${input.organType} is region-scoped and needs a region ordinal`,
      input.region,
    );
  }
  const region = regionOrdinal(input.region);

  if (scope === 'REGIONAL') {
    return { organType: input.organType, region, number: 0 };
  }

  const number = input.number ?? 0;
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_ORGAN_NUMBER) {
    throw new InvalidPrimitiveError(
      'a local organ number must be a non-negative safe integer',
      input.number,
    );
  }
  return { organType: input.organType, region, number };
}

export const samePartyOrgan = (a: PartyOrganTriple, b: PartyOrganTriple): boolean =>
  a.organType === b.organType && a.region === b.region && a.number === b.number;

/**
 * The Cyrillic postfixes from `PartyOrgans.sol:42-46`, byte-for-byte. They are
 * hashed, so a lookalike Latin `C` or `O` would silently produce a different
 * organ; `partyOrgan.test.ts` pins their code points.
 */
export const ORGAN_POSTFIX = {
  congress: 'СЗД',
  soviet: 'СОВ',
  chairperson: 'ПРЛ',
  generalAssembly: 'ОБС',
  conference: 'КОН',
} as const;

/**
 * Mirrors `PartyOrgans.getPartyOrganIdentifier` exactly.
 *
 * A local mirror is needed because the reverse direction — `bytes32` to label —
 * has no getter and can only be built by hashing candidates. It is a mirror, not
 * an authority: every resolution used for a call checks this string against the
 * contract's own `getPartyOrganIdentifier`, which is `pure` and therefore free.
 */
export function partyOrganIdentifier(triple: PartyOrganTriple): string {
  const code = subjectCodeOf(triple.region);
  switch (triple.organType) {
    case 'LocalSoviet':
      return `${code}.${triple.number}.${ORGAN_POSTFIX.soviet}`;
    case 'LocalGeneralAssembly':
      return `${code}.${triple.number}.${ORGAN_POSTFIX.generalAssembly}`;
    case 'RegionalSoviet':
      return `${code}.${ORGAN_POSTFIX.soviet}`;
    case 'RegionalConference':
      return `${code}.${ORGAN_POSTFIX.conference}`;
    case 'RegionalGeneralAssembly':
      return `${code}.${ORGAN_POSTFIX.generalAssembly}`;
    case 'Chairperson':
      return ORGAN_POSTFIX.chairperson;
    case 'CentralSoviet':
      return ORGAN_POSTFIX.soviet;
    case 'Congress':
      return ORGAN_POSTFIX.congress;
  }
}

/**
 * The Chairperson organ, which is how a Chairman check is expressed: there is no
 * `getChairman()`, but the Chairman is stored as a member of this organ
 * (`Zarya.sol:53-54`), so `isMember(CHAIRPERSON_ORGAN, candidate)` answers it.
 */
export const CHAIRPERSON_ORGAN: PartyOrganTriple = partyOrganTriple({
  organType: 'Chairperson',
});
