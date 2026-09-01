import { describe, expect, it } from 'vitest';
import {
  REGIONS_SOL,
  enumMembers,
  hasSoliditySource,
  regionCommentedCodes,
  regionSubjectCodes,
} from '../../testing/soliditySource';
import { InvalidPrimitiveError } from '../primitives';
import {
  REGION_COUNT,
  REGIONS,
  UnknownRegionError,
  ordinalMatchesSubjectCode,
  regionByOrdinal,
  regionBySubjectCode,
  regionOrdinal,
  subjectCode,
  subjectCodeOf,
} from './regions';

/**
 * The committed table is derived from `Regions.sol`, so the first block
 * re-derives it and compares rather than restating the values a second time —
 * a test that repeated the table by hand would agree with a transcription
 * error.
 *
 * That block skips once `temporal_docs/` leaves the tree. Everything below it
 * does not depend on the source, and `organResolver.fork.test.ts` checks all 98
 * regions against the deployed contract, which is the better authority anyway.
 */

describe.skipIf(!hasSoliditySource(REGIONS_SOL))('the region table matches Regions.sol', () => {
  it('has one entry per enum member, in declaration order', () => {
    const names = enumMembers(REGIONS_SOL, 'Region');
    expect(REGIONS.map((entry) => entry.name)).toEqual(names);
    expect(REGION_COUNT).toBe(names.length);
    // The ordinal is the index. Stated separately because everything else in
    // this module depends on it.
    for (const [index, entry] of REGIONS.entries()) {
      expect(entry.ordinal).toBe(index);
    }
  });

  it('carries the subject code toString renders, for every member', () => {
    const codes = regionSubjectCodes();
    expect(codes.size).toBe(REGION_COUNT);
    for (const entry of REGIONS) {
      expect(codes.get(entry.name), `no toString branch for ${entry.name}`).toBe(
        entry.subjectCode,
      );
    }
  });

  it('agrees with the `// = NN` comments beside the enum', () => {
    // The comments are documentation and toString is behavior; they agree
    // today. If this fails, the table above is still right and the comment is
    // the thing to report.
    const commented = regionCommentedCodes();
    for (const entry of REGIONS) {
      const comment = commented.get(entry.name);
      if (comment === undefined) continue;
      expect(comment, `${entry.name} comment disagrees with toString`).toBe(entry.subjectCode);
    }
  });
});

describe('the table is internally consistent', () => {
  it('assigns each subject code to exactly one region', () => {
    const codes = REGIONS.map((entry) => entry.subjectCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('numbers the ordinals 0..97 with no gaps', () => {
    expect(REGIONS.map((entry) => entry.ordinal)).toEqual(
      Array.from({ length: REGION_COUNT }, (_, index) => index),
    );
  });

  it('gives every region a two-digit code and a name', () => {
    for (const entry of REGIONS) {
      expect(entry.subjectCode, entry.name).toMatch(/^\d{2}$/);
      expect(entry.name).toMatch(/^[A-Z0-9_]+$/);
    }
  });
});

describe('the ordinal and the subject code are different numbers', () => {
  it('diverges for 50 of the 98, as CONTRACT_DEFECTS.md records', () => {
    const divergent = REGIONS.filter((entry) => !ordinalMatchesSubjectCode(entry.ordinal));
    expect(divergent).toHaveLength(50);
    expect(REGION_COUNT).toBe(98);
  });

  it('resolves a subject code passed as an ordinal to a different real region', () => {
    // The three worked examples from CONTRACT_DEFECTS.md. Each is a silent
    // wrong write, not a revert — which is what makes the confusion expensive.
    const cases = [
      { name: 'CHECHEN_REPUBLIC', code: '95', mistakenlyAddresses: 'LUGANSK_PEOPLES_REPUBLIC' },
      { name: 'KRYM_REPUBLIC', code: '82', mistakenlyAddresses: 'MOSCOW_97' },
      { name: 'PERMSKY_KRAI', code: '59', mistakenlyAddresses: 'PSKOVSKAYA_OBLAST' },
    ];

    for (const { name, code, mistakenlyAddresses } of cases) {
      const intended = regionBySubjectCode(code);
      expect(intended.name).toBe(name);
      // Passing the code where the ordinal belongs:
      expect(regionByOrdinal(regionOrdinal(Number(code))).name).toBe(mistakenlyAddresses);
    }
  });

  it('leaves only codes 98 and 99 outside the enum bound', () => {
    // The two that would revert UnknownRegion rather than resolve wrongly.
    const beyond = REGIONS.filter((entry) => Number(entry.subjectCode) >= REGION_COUNT);
    expect(beyond.map((entry) => entry.subjectCode).sort()).toEqual(['98', '99']);
  });

  it('cannot be caught by a fixture keyed on Chelyabinsk', () => {
    // The project's own region is ordinal 74 and code "74". Recorded as a test
    // so nobody "simplifies" the region fixtures onto it later.
    const chelyabinsk = regionBySubjectCode('74');
    expect(chelyabinsk.ordinal).toBe(74);
    expect(ordinalMatchesSubjectCode(chelyabinsk.ordinal)).toBe(true);
  });
});

describe('constructors', () => {
  it('accepts an ordinal in range', () => {
    expect(regionOrdinal(0)).toBe(0);
    expect(regionOrdinal(97)).toBe(97);
  });

  it('rejects an ordinal at or beyond the enum bound', () => {
    expect(() => regionOrdinal(98)).toThrow(InvalidPrimitiveError);
    expect(() => regionOrdinal(-1)).toThrow(InvalidPrimitiveError);
    expect(() => regionOrdinal(1.5)).toThrow(InvalidPrimitiveError);
  });

  it('rejects an unknown subject code rather than inventing a region', () => {
    // "20" is a real-looking code that no region uses — Chechnya moved to 95.
    expect(() => subjectCode('20')).toThrow(UnknownRegionError);
    expect(() => regionBySubjectCode('20')).toThrow(UnknownRegionError);
    expect(() => regionBySubjectCode('74 ')).toThrow(UnknownRegionError);
  });

  it('renders an ordinal to the code the contract would', () => {
    expect(subjectCodeOf(regionOrdinal(20))).toBe('95');
    expect(subjectCodeOf(regionOrdinal(0))).toBe('00');
  });
});
