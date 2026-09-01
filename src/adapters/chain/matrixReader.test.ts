import { encodeAbiParameters, encodeFunctionResult } from 'viem';
import { describe, expect, it } from 'vitest';
import { ZERO_ORGAN } from '../../domain/matrix/matrix';
import { bytes32 } from '../../domain/primitives';
import { ZaryaMatrixReader, isCategoricalOf } from './matrixReader';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

const ADDRESS = '0x6b31cC58a7DC5919f460068cF68D16281F360d25' as never;
const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const AT = { x: 3n, y: 7n };

/**
 * Encodes a real return value through the ABI, so what the reader parses is what
 * a node would actually send rather than a shape invented alongside the parser.
 */
const returning = (functionName: string, result: unknown): ZaryaPublicClient =>
  ({
    call: async () => ({
      data: encodeFunctionResult({ abi: ZARYA_ABI, functionName, result: result as never }),
    }),
  }) as unknown as ZaryaPublicClient;

const failing = (error: unknown): ZaryaPublicClient =>
  ({
    call: async () => {
      throw error;
    },
  }) as unknown as ZaryaPublicClient;

describe('the isCategorical translation', () => {
  it('is the only place a matrix kind becomes a bool', () => {
    expect(isCategoricalOf('CATEGORICAL')).toBe(true);
    expect(isCategoricalOf('NUMERICAL')).toBe(false);
  });
});

describe('reading a categorical cell', () => {
  it('reads the zero organ as unbound rather than as an organ', async () => {
    // getCategoricalCellOrgan answers for every coordinate, bound or not. Left
    // as a hash, the unbound answer would flow into an isMember call.
    const reader = new ZaryaMatrixReader(
      returning('getCategoricalCellInfo', [ZERO_ORGAN, [], 0n]),
      ADDRESS,
    );

    expect(await reader.categoricalCell(AT)).toEqual({
      binding: { kind: 'UNBOUND' },
      allowedCategories: [],
      sampleLength: 0n,
    });
  });

  it('carries the binding, the whole category set, and the sample length', async () => {
    const reader = new ZaryaMatrixReader(
      returning('getCategoricalCellInfo', [ORGAN, [1n, 2n, 3n], 5n]),
      ADDRESS,
    );

    expect(await reader.categoricalCell(AT)).toEqual({
      binding: { kind: 'BOUND', organ: ORGAN },
      allowedCategories: [1n, 2n, 3n],
      sampleLength: 5n,
    });
  });

  it('returns undefined when the read did not answer', async () => {
    // Not an empty cell — an empty cell answers UNBOUND.
    const reader = new ZaryaMatrixReader(failing(new Error('socket hang up')), ADDRESS);
    expect(await reader.categoricalCell(AT)).toBeUndefined();
  });

  it('returns undefined rather than a half-built cell on a malformed response', async () => {
    const reader = new ZaryaMatrixReader(
      {
        call: async () => ({
          // A tuple of the right arity and the wrong types.
          data: encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
            [1n, 2n, 3n],
          ),
        }),
      } as unknown as ZaryaPublicClient,
      ADDRESS,
    );

    expect(await reader.categoricalCell(AT)).toBeUndefined();
  });
});

describe('reading a numerical cell', () => {
  it('carries decimals, which are meaningful only once the cell is bound', async () => {
    const bound = new ZaryaMatrixReader(
      returning('getNumericalCellInfo', [ORGAN, 2, 4n]),
      ADDRESS,
    );
    expect(await bound.numericalCell(AT)).toEqual({
      binding: { kind: 'BOUND', organ: ORGAN },
      decimals: 2,
      sampleLength: 4n,
    });

    // An untouched cell reads decimals 0, which is also a legitimate configured
    // value. The binding is what separates them.
    const untouched = new ZaryaMatrixReader(
      returning('getNumericalCellInfo', [ZERO_ORGAN, 0, 0n]),
      ADDRESS,
    );
    expect(await untouched.numericalCell(AT)).toMatchObject({
      binding: { kind: 'UNBOUND' },
      decimals: 0,
    });
  });
});

describe('reading axis labels', () => {
  it('reads the empty string as UNSET, because the contract does', async () => {
    const reader = new ZaryaMatrixReader(returning('getTheme', ''), ADDRESS);
    expect(await reader.theme('CATEGORICAL', 3n)).toEqual({ kind: 'UNSET' });
  });

  it('reads a label as SET, and a statement by its row alone', async () => {
    const reader = new ZaryaMatrixReader(returning('getStatement', 'Rents are rising'), ADDRESS);
    // The port takes `y` and no `x`: setStatement gates on the theme at `x` and
    // writes to `y` (Matricies.sol:168-181), so `x` is not part of the address.
    expect(await reader.statement('NUMERICAL', 7n)).toEqual({
      kind: 'SET',
      text: 'Rents are rising',
    });
  });

  it('returns undefined when the read did not answer', async () => {
    const reader = new ZaryaMatrixReader(failing(new Error('timeout')), ADDRESS);
    expect(await reader.theme('CATEGORICAL', 3n)).toBeUndefined();
    expect(await reader.statement('CATEGORICAL', 3n)).toBeUndefined();
  });
});
