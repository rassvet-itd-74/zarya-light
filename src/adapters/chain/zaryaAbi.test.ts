import type { Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  AbiContractError,
  REQUIRED_FUNCTIONS,
  ZARYA_ABI,
  ZARYA_ERROR_ABI,
  assertAbiContract,
  requireFunction,
} from './zaryaAbi';

describe('the bundled ABI', () => {
  it('satisfies everything this adapter assumes', () => {
    expect(() => assertAbiContract()).not.toThrow();
  });

  // The check that would have caught the deployment change: castVote lost an
  // argument between deployments, and every generated call site got it wrong.
  it('declares the two-argument castVote and no other', () => {
    const castVote = requireFunction('castVote', 2);
    expect(castVote.inputs.map((input) => input.type)).toEqual(['uint256', 'bool']);
  });

  it('carries the 16 custom errors the ABI is known to hold', () => {
    // CONTRACT.md records 16. The four raised from externally-linked libraries
    // are deliberately absent and get registered by hand in a later slice.
    expect(ZARYA_ERROR_ABI).toHaveLength(16);
    const names = ZARYA_ERROR_ABI.map((item) => ('name' in item ? item.name : undefined));
    expect(names).toContain('VotingNotFound');
    expect(names).not.toContain('NoThemeSet');
  });
});

describe('requireFunction', () => {
  const fn = (name: string, inputs: number) => ({
    type: 'function' as const,
    name,
    inputs: Array.from({ length: inputs }, (_, i) => ({ name: `a${i}`, type: 'uint256' })),
    outputs: [] as { name: string; type: string }[],
    stateMutability: 'nonpayable' as const,
  });

  it('rejects an ABI missing the function', () => {
    expect(() => requireFunction('castVote', 2, [] as unknown as Abi)).toThrow(AbiContractError);
  });

  it('rejects the wrong arity, naming both counts', () => {
    expect(() => requireFunction('castVote', 2, [fn('castVote', 3)] as unknown as Abi)).toThrow(
      /takes 3 argument\(s\) in the ABI, this adapter expects 2/,
    );
  });

  // An ABI carrying both forms would let a call site pick either, which is worse
  // than carrying the wrong one — it would work until it did not.
  it('rejects an overloaded function', () => {
    expect(() =>
      requireFunction('castVote', 2, [fn('castVote', 2), fn('castVote', 3)] as unknown as Abi),
    ).toThrow(/overloads/);
  });

  it('accepts the exact match', () => {
    expect(requireFunction('castVote', 2, [fn('castVote', 2)] as unknown as Abi).name).toBe(
      'castVote',
    );
  });
});

describe('assertAbiContract', () => {
  it('rejects an empty ABI rather than passing vacuously', () => {
    expect(() => assertAbiContract([] as unknown as Abi)).toThrow(AbiContractError);
  });

  it('names the file in its message, since that is what has to be fixed', () => {
    expect(() => assertAbiContract([] as unknown as Abi)).toThrow(
      /src\/adapters\/chain\/abi\/Zarya\.abi\.json/,
    );
  });

  it('checks every function the adapter depends on', () => {
    expect(REQUIRED_FUNCTIONS.map(([name]) => name)).toEqual(['castVote', 'simpleMajority']);
    for (const [name, arity] of REQUIRED_FUNCTIONS) {
      expect(() => requireFunction(name, arity, ZARYA_ABI)).not.toThrow();
    }
  });
});
