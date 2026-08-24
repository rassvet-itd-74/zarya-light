import { describe, expect, it } from 'vitest';
import { chainId, evmAddress } from '../primitives';
import {
  type NetworkObservations,
  SIMPLE_MAJORITY_FINGERPRINT,
  classifyNetwork,
  isTransientVerdict,
  isUsableNetwork,
} from './networkIdentity';

const ADDRESS = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');

/** Everything observed, everything correct. */
const healthy: NetworkObservations = {
  chainId: chainId(11155111),
  address: ADDRESS,
  hasContractCode: true,
  eligibility: SIMPLE_MAJORITY_FINGERPRINT,
  castVoteProbe: 'CONTRACT_ERROR',
  blockNumber: 9_000_000n,
};

describe('classifyNetwork', () => {
  it('accepts the deployment we mean', () => {
    const verdict = classifyNetwork(healthy);
    expect(verdict).toEqual({ status: 'OK', chainId: 11155111, blockNumber: 9_000_000n });
    expect(isUsableNetwork(verdict)).toBe(true);
  });

  it('rejects a network that is not Sepolia', () => {
    const verdict = classifyNetwork({ ...healthy, chainId: chainId(1) });
    expect(verdict).toMatchObject({ status: 'WRONG_NETWORK', observed: 1, permitted: 11155111 });
    expect(isUsableNetwork(verdict)).toBe(false);
  });

  it('rejects an address with no code', () => {
    expect(classifyNetwork({ ...healthy, hasContractCode: false })).toMatchObject({
      status: 'NO_CONTRACT_CODE',
      address: ADDRESS,
    });
  });

  // This is the case the Sepolia fork cannot produce, since the predecessor is
  // out of scope: an empty revert means the selector does not exist there.
  it('rejects a deployment whose castVote has a different arity', () => {
    expect(classifyNetwork({ ...healthy, castVoteProbe: 'EMPTY_REVERT' })).toMatchObject({
      status: 'WRONG_DEPLOYMENT',
      reason: 'CASTVOTE_ARITY',
    });
    expect(classifyNetwork({ ...healthy, castVoteProbe: 'UNDECODABLE_REVERT' })).toMatchObject({
      status: 'WRONG_DEPLOYMENT',
      reason: 'CASTVOTE_ARITY',
    });
  });

  it('rejects a contract whose eligibility fingerprint differs', () => {
    expect(
      classifyNetwork({
        ...healthy,
        // Percent instead of basis points — a plausible-looking wrong contract.
        eligibility: { quorum: 1n, approvalPercentage: 50n, approvalPercentageBase: 100n },
      }),
    ).toMatchObject({ status: 'NOT_ZARYA', reason: 'ELIGIBILITY_FINGERPRINT_MISMATCH' });
  });

  it('rejects a castVote(0) that does not revert at all', () => {
    // votingExists rejects id 0 unconditionally, so a success means this is not
    // the contract we think it is.
    expect(classifyNetwork({ ...healthy, castVoteProbe: 'NO_REVERT' })).toMatchObject({
      status: 'NOT_ZARYA',
      reason: 'CASTVOTE_DID_NOT_REVERT',
    });
  });

  describe('an unobserved fact is never a confirmed failure', () => {
    it.each([
      ['chainId', 'chainId'],
      ['contractCode', 'hasContractCode'],
      ['simpleMajority', 'eligibility'],
      ['castVoteProbe', 'castVoteProbe'],
      ['blockNumber', 'blockNumber'],
    ])('reports %s as unreachable rather than rejected', (missing, key) => {
      const verdict = classifyNetwork({ ...healthy, [key]: undefined });
      expect(verdict).toEqual({ status: 'UNREACHABLE', missing: [missing] });
      expect(isUsableNetwork(verdict)).toBe(false);
      // The distinction that matters: retry later, do not condemn.
      expect(isTransientVerdict(verdict)).toBe(true);
    });

    it('does not treat a settled rejection as retryable', () => {
      for (const observations of [
        { ...healthy, chainId: chainId(1) },
        { ...healthy, hasContractCode: false },
        { ...healthy, castVoteProbe: 'EMPTY_REVERT' as const },
      ]) {
        expect(isTransientVerdict(classifyNetwork(observations))).toBe(false);
      }
    });
  });

  it('reports the most useful failure first', () => {
    // No point naming a fingerprint mismatch at an address holding no code, or
    // any contract fact on a chain we may not talk to.
    expect(
      classifyNetwork({
        ...healthy,
        chainId: chainId(1),
        hasContractCode: false,
        eligibility: undefined,
        castVoteProbe: 'EMPTY_REVERT',
      }),
    ).toMatchObject({ status: 'WRONG_NETWORK' });

    expect(
      classifyNetwork({ ...healthy, hasContractCode: false, castVoteProbe: 'EMPTY_REVERT' }),
    ).toMatchObject({ status: 'NO_CONTRACT_CODE' });
  });
});

describe('SIMPLE_MAJORITY_FINGERPRINT', () => {
  it('is basis points, exactly as Zarya.sol declares it', () => {
    // Zarya.sol:27-28. A test that hardcoded 50 would pass against a contract
    // that does not exist.
    expect(SIMPLE_MAJORITY_FINGERPRINT).toEqual({
      quorum: 1n,
      approvalPercentage: 5000n,
      approvalPercentageBase: 10_000n,
    });
  });
});
