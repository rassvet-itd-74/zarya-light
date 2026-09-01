import { describe, expect, it } from 'vitest';
import {
  PARTY_ORGANS_SOL,
  declaresUnicodeLiteral,
  enumMembers,
  hasSoliditySource,
} from '../../testing/soliditySource';
import { InvalidPrimitiveError } from '../primitives';
import {
  CHAIRPERSON_ORGAN,
  ORGAN_POSTFIX,
  PARTY_ORGAN_TYPES,
  type PartyOrganType,
  partyOrganIdentifier,
  partyOrganTriple,
  partyOrganTypeByOrdinal,
  partyOrganTypeOrdinal,
  samePartyOrgan,
  scopeOf,
} from './partyOrgan';
import { regionBySubjectCode } from './regions';

const ordinalOf = (code: string) => regionBySubjectCode(code).ordinal;

/** Skips once `temporal_docs/` leaves; the fork test then carries this. */
const withSource = describe.skipIf(!hasSoliditySource(PARTY_ORGANS_SOL));

withSource('the organ type ordinals match PartyOrgans.sol', () => {
  it('lists the enum members in declaration order', () => {
    expect([...PARTY_ORGAN_TYPES]).toEqual(enumMembers(PARTY_ORGANS_SOL, 'PartyOrganType'));
  });
});

describe('organ type ordinals', () => {
  it('derives the uint8 argument from declaration order', () => {
    expect(partyOrganTypeOrdinal('LocalSoviet')).toBe(0);
    expect(partyOrganTypeOrdinal('Chairperson')).toBe(5);
    expect(partyOrganTypeOrdinal('Congress')).toBe(7);
    for (const [index, name] of PARTY_ORGAN_TYPES.entries()) {
      expect(partyOrganTypeByOrdinal(index)).toBe(name);
    }
  });

  it('rejects an ordinal above 7', () => {
    expect(() => partyOrganTypeByOrdinal(8)).toThrow(InvalidPrimitiveError);
  });
});

withSource('the Cyrillic postfixes are byte-for-byte the contract’s', () => {
  it('appears verbatim in the source', () => {
    for (const postfix of Object.values(ORGAN_POSTFIX)) {
      expect(declaresUnicodeLiteral(PARTY_ORGANS_SOL, postfix), postfix).toBe(true);
    }
  });
});

describe('the Cyrillic postfixes', () => {
  it('are Cyrillic, not a Latin lookalike', () => {
    // "СОВ" in Latin C/O/B hashes to a completely different organ and reads
    // identically on screen. Pinned by code point.
    expect([...ORGAN_POSTFIX.soviet].map((c) => c.codePointAt(0))).toEqual([
      0x0421, 0x041e, 0x0412,
    ]);
    expect([...ORGAN_POSTFIX.chairperson].map((c) => c.codePointAt(0))).toEqual([
      0x041f, 0x0420, 0x041b,
    ]);
  });
});

describe('scope decides which fields are read', () => {
  it('classifies all eight types', () => {
    const scopes = Object.fromEntries(PARTY_ORGAN_TYPES.map((t) => [t, scopeOf(t)]));
    expect(scopes).toEqual({
      LocalSoviet: 'LOCAL',
      LocalGeneralAssembly: 'LOCAL',
      RegionalSoviet: 'REGIONAL',
      RegionalConference: 'REGIONAL',
      RegionalGeneralAssembly: 'REGIONAL',
      Chairperson: 'GLOBAL',
      CentralSoviet: 'GLOBAL',
      Congress: 'GLOBAL',
    });
  });

  it('normalizes away the fields a global organ ignores', () => {
    // PartyOrgans.sol:75-80 — the last three return a constant string, so a
    // Chairperson organ "in Chelyabinsk" is the same organ as any other.
    const withRegion = partyOrganTriple({
      organType: 'Chairperson',
      region: ordinalOf('74'),
      number: 3,
    });
    expect(samePartyOrgan(withRegion, CHAIRPERSON_ORGAN)).toBe(true);
    expect(withRegion).toEqual({ organType: 'Chairperson', region: 0, number: 0 });
  });

  it('normalizes away the number a regional organ ignores', () => {
    const a = partyOrganTriple({ organType: 'RegionalSoviet', region: 20, number: 7 });
    const b = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });
    expect(samePartyOrgan(a, b)).toBe(true);
  });

  it('requires a region for a region-scoped type', () => {
    expect(() => partyOrganTriple({ organType: 'RegionalSoviet' })).toThrow(
      InvalidPrimitiveError,
    );
    expect(() => partyOrganTriple({ organType: 'LocalSoviet', number: 1 })).toThrow(
      InvalidPrimitiveError,
    );
  });

  it('rejects a local number that is not a non-negative integer', () => {
    for (const number of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => partyOrganTriple({ organType: 'LocalSoviet', region: 0, number })).toThrow(
        InvalidPrimitiveError,
      );
    }
  });
});

describe('identifier composition mirrors getPartyOrganIdentifier', () => {
  const cases: ReadonlyArray<[PartyOrganType, string | undefined, number, string]> = [
    ['LocalSoviet', '74', 3, `74.3.${ORGAN_POSTFIX.soviet}`],
    ['LocalGeneralAssembly', '74', 0, `74.0.${ORGAN_POSTFIX.generalAssembly}`],
    ['RegionalSoviet', '74', 0, `74.${ORGAN_POSTFIX.soviet}`],
    ['RegionalConference', '74', 0, `74.${ORGAN_POSTFIX.conference}`],
    ['RegionalGeneralAssembly', '74', 0, `74.${ORGAN_POSTFIX.generalAssembly}`],
    ['Chairperson', undefined, 0, ORGAN_POSTFIX.chairperson],
    ['CentralSoviet', undefined, 0, ORGAN_POSTFIX.soviet],
    ['Congress', undefined, 0, ORGAN_POSTFIX.congress],
  ];

  it.each(cases)('renders %s', (organType, code, number, expected) => {
    const region = code === undefined ? undefined : ordinalOf(code);
    expect(partyOrganIdentifier(partyOrganTriple({ organType, region, number }))).toBe(expected);
  });

  it('renders the subject code, not the ordinal', () => {
    // The distinction the whole region module exists for: Chechnya is ordinal
    // 20 and its identifier says 95.
    const chechnya = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });
    expect(partyOrganIdentifier(chechnya)).toBe(`95.${ORGAN_POSTFIX.soviet}`);
    expect(partyOrganIdentifier(chechnya)).not.toContain('20');
  });

  it('renders the local number in decimal without padding', () => {
    // `number.toString()` in Solidity. A zero-padded "03" would be a different
    // string and therefore a different organ.
    expect(
      partyOrganIdentifier(partyOrganTriple({ organType: 'LocalSoviet', region: 0, number: 3 })),
    ).toBe(`00.3.${ORGAN_POSTFIX.soviet}`);
  });
});
