import { type AbiParameter, encodeErrorResult, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { ZARYA_ERROR_NAMES } from '../../domain/chain/contractErrors';
import {
  MATRICIES_SOL,
  errorParameterTypes,
  hasSoliditySource,
} from '../../testing/soliditySource';
import {
  FULL_ERROR_ABI,
  UNPUBLISHED_ERROR_ABI,
  classifyCallFailure,
  decodeZaryaError,
} from './errorDecoder';
import { ZARYA_ERROR_ABI } from './zaryaAbi';

/**
 * Payloads are built with viem's encoder and read back with ours, so the tests
 * exercise real selectors and real ABI encoding rather than fixture strings.
 */

const signatureOf = (name: string, inputs: readonly AbiParameter[]): string =>
  `${name}(${inputs.map((input) => input.type).join(',')})`;

describe('the registry covers the whole error surface', () => {
  it('names every error the ABI declares', () => {
    for (const item of ZARYA_ERROR_ABI) {
      if (item.type !== 'error') continue;
      expect(ZARYA_ERROR_NAMES as readonly string[], item.name).toContain(item.name);
    }
  });

  it('still finds 16 errors in the ABI', () => {
    // Drift alarm: an ABI that gained or lost an error means the deployment
    // moved, and the taxonomy needs revisiting rather than silently decoding
    // less.
    expect(ZARYA_ERROR_ABI).toHaveLength(16);
  });

  it('adds five fragments the ABI cannot carry', () => {
    expect(UNPUBLISHED_ERROR_ABI.map((item) => item.name)).toEqual([
      'NoThemeSet',
      'NoStatementSet',
      'InvalidCategory',
      'Panic',
      'Error',
    ]);
    expect(FULL_ERROR_ABI).toHaveLength(21);
  });

  it('declares no name twice', () => {
    const names = FULL_ERROR_ABI.map((item) => (item as { name: string }).name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.skipIf(!hasSoliditySource(MATRICIES_SOL))(
  'the hand-written fragments match Matricies.sol',
  () => {
    // Skips once `temporal_docs/` leaves the tree. Nothing replaces this one:
    // these three errors are absent from the ABI by construction, and a
    // deployed contract cannot be asked what it *would* revert with. The
    // selectors below are the durable record.
    it.each(['NoThemeSet', 'NoStatementSet', 'InvalidCategory'])(
      'reproduces %s exactly',
      (name) => {
        const declaredTypes = errorParameterTypes(MATRICIES_SOL, name);
        expect(declaredTypes, `no declaration of ${name}`).toBeDefined();

        const fragment = UNPUBLISHED_ERROR_ABI.find((item) => item.name === name);
        expect(fragment?.inputs.map((input) => input.type)).toEqual(declaredTypes);
      },
    );
  },
);

describe('the unpublished selectors are pinned', () => {
  /**
   * Literal digests, so the fragments stay verifiable after `temporal_docs/`
   * leaves the tree. Derived from the declarations in `Matricies.sol` while it
   * was present; `Panic` and `Error` are Solidity's own and fixed for the
   * language. Any change to a fragment's parameter types changes its selector
   * and fails here — which matters because a wrong signature does not error,
   * it just silently stops decoding a revert that does occur.
   */
  const PINNED: Readonly<Record<string, `0x${string}`>> = {
    NoThemeSet: '0x618ebd74',
    NoStatementSet: '0xfc9b2e63',
    InvalidCategory: '0x5034df38',
    Panic: '0x4e487b71',
    Error: '0x08c379a0',
  };

  it.each(Object.keys(PINNED))('%s keeps its selector', (name) => {
    const fragment = UNPUBLISHED_ERROR_ABI.find((item) => item.name === name);
    expect(fragment, name).toBeDefined();
    expect(toFunctionSelector(signatureOf(name, fragment?.inputs ?? []))).toBe(PINNED[name]);
  });

  it('uses the selectors Solidity itself defines for Panic and Error', () => {
    // Well-known values, quoted in the Solidity docs. If these ever disagreed,
    // every plain revert string in the app would go undecoded.
    expect(PINNED.Panic).toBe('0x4e487b71');
    expect(PINNED.Error).toBe('0x08c379a0');
  });
});

describe('decoding', () => {
  it('decodes an error the ABI declares', () => {
    const data = encodeErrorResult({
      abi: FULL_ERROR_ABI,
      errorName: 'InsufficientVotes',
      args: [3n, 1n],
    });
    expect(decodeZaryaError(data)).toMatchObject({
      name: 'InsufficientVotes',
      args: [3n, 1n],
    });
  });

  it('decodes an error the ABI omits', () => {
    // Without the hand-written fragment this selector is undecodable, which is
    // the whole reason the fragment exists.
    const data = encodeErrorResult({
      abi: FULL_ERROR_ABI,
      errorName: 'NoThemeSet',
      args: [true, 4n],
    });
    expect(decodeZaryaError(data)).toMatchObject({ name: 'NoThemeSet', args: [true, 4n] });

    // And it is genuinely absent upstream.
    const inAbi = ZARYA_ERROR_ABI.some(
      (item) => (item as { name?: string }).name === 'NoThemeSet',
    );
    expect(inAbi).toBe(false);
  });

  it('decodes a panic and reports its code', () => {
    const data = encodeErrorResult({ abi: FULL_ERROR_ABI, errorName: 'Panic', args: [0x32n] });
    const decoded = decodeZaryaError(data);
    expect(decoded?.name).toBe('Panic');
    expect(decoded?.panicCode).toBe(0x32n);
  });

  it('decodes a plain revert string', () => {
    const data = encodeErrorResult({
      abi: FULL_ERROR_ABI,
      errorName: 'Error',
      args: ['nope'],
    });
    expect(decodeZaryaError(data)).toMatchObject({ name: 'Error', args: ['nope'] });
  });

  it('returns undefined for a selector from another contract', () => {
    const foreign = toFunctionSelector('SomeOtherError(uint256)');
    expect(decodeZaryaError(`${foreign}${'0'.repeat(64)}`)).toBeUndefined();
  });

  it('returns undefined rather than throwing on garbage', () => {
    expect(decodeZaryaError('0x')).toBeUndefined();
    expect(decodeZaryaError('0xdeadbeef')).toBeUndefined();
  });

  it('uses our Panic fragment, not one appended by the library', () => {
    // The fragments are first in FULL_ERROR_ABI on purpose, so decoding does
    // not depend on viem continuing to append its own.
    const ourPanic = UNPUBLISHED_ERROR_ABI.find((item) => item.name === 'Panic');
    expect(signatureOf('Panic', ourPanic?.inputs ?? [])).toBe('Panic(uint256)');
    expect(FULL_ERROR_ABI.indexOf(ourPanic as never)).toBeLessThan(ZARYA_ERROR_ABI.length);
  });
});

describe('classifying a thrown failure', () => {
  /** Shaped like the viem error chain `revertData.ts` reads. */
  const revertWith = (data: string) => ({
    name: 'CallExecutionError',
    cause: { name: 'RawContractError', data },
  });

  it('reports a decoded revert with its domain meaning', () => {
    const data = encodeErrorResult({
      abi: FULL_ERROR_ABI,
      errorName: 'InsufficientVotes',
      args: [0n, 0n],
    });
    expect(classifyCallFailure(revertWith(data))).toMatchObject({
      kind: 'REVERTED',
      name: 'InsufficientVotes',
      meaning: { disposition: 'TERMINAL' },
    });
  });

  it('separates a transport failure from every revert', () => {
    // The invariant: an RPC outage must never become a statement about what the
    // contract decided.
    expect(classifyCallFailure(new Error('fetch failed'))).toEqual({
      kind: 'UNKNOWN',
      reason: 'NOT_A_REVERT',
    });
  });

  it('separates an empty revert from an undecodable one', () => {
    expect(classifyCallFailure(revertWith('0x'))).toEqual({
      kind: 'UNKNOWN',
      reason: 'EMPTY_REVERT',
    });
    expect(
      classifyCallFailure(revertWith(`${toFunctionSelector('Nope(uint256)')}${'0'.repeat(64)}`)),
    ).toEqual({ kind: 'UNKNOWN', reason: 'UNDECODABLE' });
  });

  it('reports a panic with the code-specific summary', () => {
    const data = encodeErrorResult({ abi: FULL_ERROR_ABI, errorName: 'Panic', args: [0x11n] });
    const outcome = classifyCallFailure(revertWith(data));
    expect(outcome.kind === 'REVERTED' && outcome.meaning.summary).toMatch(/overflow/i);
  });
});
