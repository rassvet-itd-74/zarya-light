import { describe, expect, it } from 'vitest';
import { InvalidPrimitiveError, bytes32 } from '../primitives';
import {
  MATRIX_KINDS,
  ZERO_ORGAN,
  attributeValue,
  axisLabel,
  axisValue,
  bindingAccepts,
  cellBinding,
  coordinateKey,
  isMatrixKind,
  matrixCoordinate,
  sameCoordinate,
} from './matrix';

const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const OTHER = bytes32(`0x${'ab'.repeat(32)}`);

describe('matrix kinds', () => {
  it('names both matrices and nothing else', () => {
    expect(MATRIX_KINDS).toEqual(['CATEGORICAL', 'NUMERICAL']);
    expect(isMatrixKind('CATEGORICAL')).toBe(true);
    expect(isMatrixKind('true')).toBe(false);
    // The contract's own key is a bool. Nothing in the domain accepts one.
    expect(isMatrixKind('1')).toBe(false);
  });
});

describe('coordinates', () => {
  it('accepts the whole uint256 range', () => {
    expect(axisValue(0n, 'x')).toBe(0n);
    expect(axisValue((1n << 256n) - 1n, 'y')).toBe((1n << 256n) - 1n);
  });

  it('refuses what cannot be encoded, and nothing else', () => {
    // No ceiling below uint256: nothing reports the matrix size, so a smaller
    // client bound would be an invention rather than a mirror.
    expect(() => axisValue(-1n, 'x')).toThrow(InvalidPrimitiveError);
    expect(() => axisValue(1n << 256n, 'y')).toThrow(InvalidPrimitiveError);
  });

  it('compares and keys by value, not identity', () => {
    const a = matrixCoordinate(3n, 7n);
    const b = matrixCoordinate(3n, 7n);

    expect(a === b).toBe(false);
    expect(sameCoordinate(a, b)).toBe(true);
    expect(coordinateKey(a)).toBe(coordinateKey(b));
    expect(coordinateKey(matrixCoordinate(3n, 7n))).not.toBe(
      coordinateKey(matrixCoordinate(7n, 3n)),
    );
  });
});

describe('cell binding', () => {
  it('reads the zero organ as unbound rather than as an organ', () => {
    expect(ZERO_ORGAN).toBe(`0x${'0'.repeat(64)}`);
    expect(cellBinding(ZERO_ORGAN)).toEqual({ kind: 'UNBOUND' });
    expect(cellBinding(ORGAN)).toEqual({ kind: 'BOUND', organ: ORGAN });
  });

  it('lets any organ take an unbound cell and only its own organ keep it', () => {
    // First-writer-wins and permanent (Matricies.sol:98-104).
    expect(bindingAccepts({ kind: 'UNBOUND' }, ORGAN)).toBe(true);
    expect(bindingAccepts({ kind: 'BOUND', organ: ORGAN }, ORGAN)).toBe(true);
    expect(bindingAccepts({ kind: 'BOUND', organ: OTHER }, ORGAN)).toBe(false);
  });
});

describe('axis labels', () => {
  it('treats the empty string as absence, because the contract does', () => {
    // `addValue` tests bytes(...).length == 0 — an empty theme is "no theme",
    // not a short one.
    expect(axisLabel('')).toEqual({ kind: 'UNSET' });
    expect(axisLabel('Housing')).toEqual({ kind: 'SET', text: 'Housing' });
    // A string of spaces is a set theme as far as the contract is concerned.
    expect(axisLabel(' ')).toEqual({ kind: 'SET', text: ' ' });
  });
});

describe('attributing a ValueAdded log to a matrix', () => {
  const bound = { kind: 'BOUND', organ: ORGAN } as const;
  const unbound = { kind: 'UNBOUND' } as const;

  it('names the matrix when exactly one cell is bound', () => {
    expect(attributeValue(bound, unbound)).toEqual({ kind: 'CATEGORICAL' });
    expect(attributeValue(unbound, bound)).toEqual({ kind: 'NUMERICAL' });
  });

  it('refuses to guess when both are bound', () => {
    // The two matrices are independent mappings over one coordinate space, so
    // this is reachable, and no read separates them.
    expect(attributeValue(bound, bound)).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('reports UNKNOWN when both read as unbound', () => {
    // addValue binds before it emits, so "neither" means the reads and the log
    // disagree — not that the value belongs nowhere.
    expect(attributeValue(unbound, unbound)).toEqual({ kind: 'UNKNOWN' });
  });

  it('will not name a matrix from one read, even a BOUND one', () => {
    // The unread side could have made this AMBIGUOUS. A confident NUMERICAL here
    // would be an answer built on a read that never happened.
    expect(attributeValue(undefined, bound)).toEqual({ kind: 'UNKNOWN' });
    expect(attributeValue(bound, undefined)).toEqual({ kind: 'UNKNOWN' });
    expect(attributeValue(undefined, undefined)).toEqual({ kind: 'UNKNOWN' });
  });
});
