import { describe, expect, it } from 'vitest';
import {
  CHAIRPERSON_ORGAN,
  ORGAN_POSTFIX,
  partyOrganIdentifier,
  partyOrganTriple,
} from '../../domain/organs/partyOrgan';
import { REGION_COUNT, regionBySubjectCode } from '../../domain/organs/regions';
import { bytes32 } from '../../domain/primitives';
import {
  DEFAULT_MAX_LOCAL_ORGAN_NUMBER,
  MAX_SUPPORTED_LOCAL_ORGAN_NUMBER,
  OrganTableBoundError,
  buildOrganLabelTable,
  organHashOf,
} from './organLabelTable';

// Small bound: the enumeration logic is what is under test, and building the
// default 19 897-entry table in every case would only be slower.
const small = buildOrganLabelTable(2);

describe('hashing an identifier', () => {
  it('matches keccak256 of the UTF-8 bytes, Cyrillic included', () => {
    // Literal digests, so an encoding change — UTF-16, a padded encodePacked, a
    // postfix mangled by a console codepage — fails here rather than producing
    // a plausible hash for an organ that does not exist. The fork test checks
    // these same identifiers against the contract itself.
    expect(organHashOf('ПРЛ')).toBe(
      '0x7ff11b8f25aedbc00dc91730f8f0a956ea885ffb6a55c38f36ce033ccdf59eac',
    );
    expect(organHashOf('74.СОВ')).toBe(
      '0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5',
    );
    expect(organHashOf('74.12.СОВ')).toBe(
      '0x89ff187e220b8169bb8535e77c62e08a4a49b3e24555218af585cd695b7d8fad',
    );
  });

  it('distinguishes Cyrillic from its Latin lookalike', () => {
    // "СОВ" and "COB" are indistinguishable on screen and hash to unrelated
    // organs. Three Cyrillic characters are six UTF-8 bytes; three Latin are
    // three.
    expect(organHashOf('СОВ')).not.toBe(organHashOf('COB'));
    expect(ORGAN_POSTFIX.soviet).toBe('СОВ');
  });

  it('is lower-cased, so two spellings key the same entry', () => {
    const hash = organHashOf('74.СОВ');
    expect(hash).toBe(bytes32(hash.toUpperCase().replace('0X', '0x')));
  });
});

describe('the closed part of the table is exact', () => {
  it('contains every global and regional organ regardless of the bound', () => {
    const closedOnly = buildOrganLabelTable(0);
    // 3 global + 98 regions x 3 regional types = 297, plus the local organs at
    // number 0 that a zero bound still enumerates.
    expect(closedOnly.size).toBe(3 + REGION_COUNT * 3 + REGION_COUNT * 2);
  });

  it('names the Chairperson organ', () => {
    expect(small.label(organHashOf(partyOrganIdentifier(CHAIRPERSON_ORGAN)))).toBe(
      ORGAN_POSTFIX.chairperson,
    );
  });

  it('names a regional organ by its subject code, not its ordinal', () => {
    const chechnya = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });
    const hash = organHashOf(partyOrganIdentifier(chechnya));

    expect(small.label(hash)).toBe(`95.${ORGAN_POSTFIX.soviet}`);
    expect(small.tripleOf(hash)).toEqual({
      organType: 'RegionalSoviet',
      region: 20,
      number: 0,
    });
  });

  it('round-trips a triple through its hash', () => {
    const triple = partyOrganTriple({
      organType: 'LocalGeneralAssembly',
      region: regionBySubjectCode('59').ordinal,
      number: 2,
    });
    const hash = organHashOf(partyOrganIdentifier(triple));

    expect(small.tripleOf(hash)).toEqual(triple);
    expect(small.label(hash)).toBe(`59.2.${ORGAN_POSTFIX.generalAssembly}`);
  });

  it('gives one entry per enumerated triple, with no collisions', () => {
    // 3 global + 98 x 3 regional + 98 x 3 numbers x 2 local types.
    expect(small.size).toBe(3 + REGION_COUNT * 3 + REGION_COUNT * 3 * 2);
  });
});

describe('the bound', () => {
  it('resolves an organ inside it and refuses to guess outside it', () => {
    const inside = partyOrganTriple({ organType: 'LocalSoviet', region: 0, number: 2 });
    const outside = partyOrganTriple({ organType: 'LocalSoviet', region: 0, number: 3 });

    expect(small.label(organHashOf(partyOrganIdentifier(inside)))).toBeDefined();
    // The important half: an organ beyond the enumeration is unknown, never
    // mislabelled. The caller shows the hash.
    expect(small.label(organHashOf(partyOrganIdentifier(outside)))).toBeUndefined();
    expect(small.tripleOf(organHashOf(partyOrganIdentifier(outside)))).toBeUndefined();
  });

  it('returns undefined for a hash from another contract entirely', () => {
    expect(small.label(bytes32(`0x${'ab'.repeat(32)}`))).toBeUndefined();
  });

  it('reports the bound it was built with', () => {
    expect(small.maxLocalOrganNumber).toBe(2);
    expect(DEFAULT_MAX_LOCAL_ORGAN_NUMBER).toBe(99);
  });

  it('rejects a bound that would hash for minutes', () => {
    expect(() => buildOrganLabelTable(MAX_SUPPORTED_LOCAL_ORGAN_NUMBER + 1)).toThrow(
      OrganTableBoundError,
    );
    expect(() => buildOrganLabelTable(-1)).toThrow(OrganTableBoundError);
    expect(() => buildOrganLabelTable(1.5)).toThrow(OrganTableBoundError);
  });
});

describe('the default table', () => {
  const table = buildOrganLabelTable();

  it('holds 297 closed organs plus the enumerated local ones', () => {
    expect(table.size).toBe(
      3 + REGION_COUNT * 3 + REGION_COUNT * (DEFAULT_MAX_LOCAL_ORGAN_NUMBER + 1) * 2,
    );
    expect(table.size).toBe(19_897);
  });

  it('covers the project’s own region at a plausible local number', () => {
    const triple = partyOrganTriple({
      organType: 'LocalSoviet',
      region: regionBySubjectCode('74').ordinal,
      number: 12,
    });
    expect(table.label(organHashOf(partyOrganIdentifier(triple)))).toBe(
      `74.12.${ORGAN_POSTFIX.soviet}`,
    );
  });
});
