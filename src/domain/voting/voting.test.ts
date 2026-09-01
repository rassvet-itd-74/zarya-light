import { describe, expect, it } from 'vitest';
import {
  PARTY_ORGANS_SOL,
  VOTINGS_SOL,
  enumMembers,
  hasSoliditySource,
} from '../../testing/soliditySource';
import { InvalidPrimitiveError, bytes32 } from '../primitives';
import {
  SUGGESTION_TYPES,
  governingOrganFrom,
  isOrganGoverned,
  suggestionTypeByOrdinal,
  suggestionTypeOrdinal,
  votingId,
} from './voting';

const ORGAN = bytes32(`0x${'ab'.repeat(32)}`);

describe.skipIf(!hasSoliditySource(VOTINGS_SOL))('suggestion types match Votings.sol', () => {
  it('lists the enum members in declaration order', () => {
    expect([...SUGGESTION_TYPES]).toEqual(enumMembers(VOTINGS_SOL, 'SuggestionType'));
  });
});

describe('suggestion type ordinals', () => {
  it('round-trips through the ordinal the event carries', () => {
    for (const [index, name] of SUGGESTION_TYPES.entries()) {
      expect(suggestionTypeByOrdinal(index)).toBe(name);
      expect(suggestionTypeOrdinal(name)).toBe(index);
    }
  });

  it('rejects an ordinal outside the enum', () => {
    // A log carrying 8 is not a suggestion type we can name, and guessing one
    // would attach a wrong organ expectation to the voting.
    expect(() => suggestionTypeByOrdinal(8)).toThrow(InvalidPrimitiveError);
    expect(() => suggestionTypeByOrdinal(-1)).toThrow(InvalidPrimitiveError);
  });
});

describe('voting ids', () => {
  it('rejects zero, which the contract refuses anyway', () => {
    // votingExists rejects 0 before any logic (Zarya.sol:565-567), so a call
    // carrying it can only revert. Refusing locally saves the round trip.
    expect(() => votingId(0n)).toThrow(InvalidPrimitiveError);
    expect(() => votingId(-1n)).toThrow(InvalidPrimitiveError);
  });

  it('accepts the first real id', () => {
    expect(votingId(1n)).toBe(1n);
  });
});

describe('which votings have an organ', () => {
  it('is every type except Theme and Statement', () => {
    const governed = SUGGESTION_TYPES.filter(isOrganGoverned);
    expect(governed).toEqual([
      'Membership',
      'MembershipRevocation',
      'Category',
      'Decimals',
      'CategoricalValue',
      'NumericalValue',
    ]);
  });

  it('reports NONE for a theme or statement voting even with no detail log', () => {
    // Those events genuinely carry no organ, and "no organ" means anyone may
    // vote. This is the one case where absence is an answer.
    expect(governingOrganFrom('Theme', undefined)).toEqual({ kind: 'NONE' });
    expect(governingOrganFrom('Statement', undefined)).toEqual({ kind: 'NONE' });
  });

  it('reports UNKNOWN — never NONE — when an organ-governed detail log is missing', () => {
    // The failure this guards: NONE would tell a non-member they may vote, and
    // they would sign a transaction that reverts NotActiveMember.
    for (const type of SUGGESTION_TYPES.filter(isOrganGoverned)) {
      expect(governingOrganFrom(type, undefined), type).toEqual({ kind: 'UNKNOWN' });
    }
  });

  it('reports the organ when the detail log is present', () => {
    expect(governingOrganFrom('Membership', ORGAN)).toEqual({ kind: 'ORGAN', organ: ORGAN });
  });

  it('ignores an organ offered for a type that cannot have one', () => {
    // A theme voting with an organ in hand is a projection bug, not a governed
    // voting. Trusting it would invent an eligibility rule the contract has not.
    expect(governingOrganFrom('Theme', ORGAN)).toEqual({ kind: 'NONE' });
  });
});

describe.skipIf(!hasSoliditySource(PARTY_ORGANS_SOL))('the two enums stay distinct', () => {
  it('does not confuse suggestion types with organ types', () => {
    // Both are uint8 arguments of similar size, and swapping them would encode
    // silently. Named unions on both sides make that a compile error; this
    // records that they are genuinely different lists.
    expect([...SUGGESTION_TYPES]).not.toEqual(enumMembers(PARTY_ORGANS_SOL, 'PartyOrganType'));
  });
});
