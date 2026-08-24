import { type ChainId, type EvmAddress } from '../primitives';
import { PERMITTED_CHAIN_ID, isPermittedNetwork } from './networkPolicy';

/**
 * Deciding whether the thing we are connected to is the contract we mean.
 *
 * The adapter observes; this module decides. Reading a chain id over RPC and
 * catching a revert are translation. Concluding "this is the wrong deployment"
 * is a product rule, and it lives here so it can be tested without a node.
 *
 * The rule that shapes the whole type: **an unobserved fact is not a failed
 * one.** Every observation is allowed to be `undefined`, and the verdict for a
 * missing observation is `UNREACHABLE`, never a confirmed rejection
 * (INVARIANTS.md, "Chain safety").
 */

/** What `simpleMajority()` reports on the deployment we mean. */
export interface EligibilityFingerprint {
  readonly quorum: bigint;
  readonly approvalPercentage: bigint;
  readonly approvalPercentageBase: bigint;
}

/**
 * `Zarya.sol:27-28` initialises `simpleMajority` inline and assigns it nowhere
 * else, so it is constant for a given deployment and makes a cheap, non-reverting
 * identity check — much stronger evidence than "the address has code".
 *
 * **Basis points**, not percent: 5000 of a 10000 base. Nothing renders this as
 * "50%".
 */
export const SIMPLE_MAJORITY_FINGERPRINT: EligibilityFingerprint = {
  quorum: 1n,
  approvalPercentage: 5000n,
  approvalPercentageBase: 10_000n,
};

/**
 * What an `eth_call` of the two-argument `castVote` produced.
 *
 * On the deployment we mean, `castVote(0, false)` hits the `votingExists` guard
 * (`Zarya.sol:566`) and reverts `VotingNotFound(0)` before any membership logic,
 * so it needs no signer and changes nothing. A deployment without that selector
 * has no matching function and — there is no `fallback` or `receive` in
 * `Zarya.sol` — reverts with no data at all.
 */
export type CastVoteProbe =
  /** Reverted with a decodable Zarya error: the selector exists. */
  | 'CONTRACT_ERROR'
  /** Reverted with no returndata: no such function on this contract. */
  | 'EMPTY_REVERT'
  /** Reverted with data we could not decode: something else lives here. */
  | 'UNDECODABLE_REVERT'
  /** Did not revert at all, which this call must always do. */
  | 'NO_REVERT';

/** Facts gathered by the adapter. `undefined` means "not observed". */
export interface NetworkObservations {
  readonly chainId?: ChainId;
  readonly address: EvmAddress;
  readonly hasContractCode?: boolean;
  readonly eligibility?: EligibilityFingerprint;
  readonly castVoteProbe?: CastVoteProbe;
  readonly blockNumber?: bigint;
}

export type NetworkVerdict =
  | { readonly status: 'OK'; readonly chainId: ChainId; readonly blockNumber: bigint }
  | { readonly status: 'WRONG_NETWORK'; readonly observed: ChainId; readonly permitted: ChainId }
  | { readonly status: 'NO_CONTRACT_CODE'; readonly address: EvmAddress }
  | {
      readonly status: 'NOT_ZARYA';
      readonly address: EvmAddress;
      readonly reason: 'ELIGIBILITY_FINGERPRINT_MISMATCH' | 'CASTVOTE_DID_NOT_REVERT';
    }
  | {
      readonly status: 'WRONG_DEPLOYMENT';
      readonly address: EvmAddress;
      readonly reason: 'CASTVOTE_ARITY';
    }
  | { readonly status: 'UNREACHABLE'; readonly missing: readonly string[] };

const sameFingerprint = (a: EligibilityFingerprint, b: EligibilityFingerprint): boolean =>
  a.quorum === b.quorum &&
  a.approvalPercentage === b.approvalPercentage &&
  a.approvalPercentageBase === b.approvalPercentageBase;

/**
 * Checks run in the order that produces the most useful answer first: there is
 * no point reporting a fingerprint mismatch at an address that holds no code, or
 * a wrong deployment on a chain we are not allowed to talk to at all.
 */
export function classifyNetwork(observations: NetworkObservations): NetworkVerdict {
  const { chainId, address, hasContractCode, eligibility, castVoteProbe, blockNumber } =
    observations;

  if (chainId === undefined) {
    return { status: 'UNREACHABLE', missing: ['chainId'] };
  }
  if (!isPermittedNetwork(chainId)) {
    return { status: 'WRONG_NETWORK', observed: chainId, permitted: PERMITTED_CHAIN_ID };
  }

  if (hasContractCode === undefined) {
    return { status: 'UNREACHABLE', missing: ['contractCode'] };
  }
  if (!hasContractCode) {
    return { status: 'NO_CONTRACT_CODE', address };
  }

  if (eligibility === undefined) {
    return { status: 'UNREACHABLE', missing: ['simpleMajority'] };
  }
  if (!sameFingerprint(eligibility, SIMPLE_MAJORITY_FINGERPRINT)) {
    return { status: 'NOT_ZARYA', address, reason: 'ELIGIBILITY_FINGERPRINT_MISMATCH' };
  }

  if (castVoteProbe === undefined) {
    return { status: 'UNREACHABLE', missing: ['castVoteProbe'] };
  }
  switch (castVoteProbe) {
    case 'EMPTY_REVERT':
      // No such selector. DEPLOYMENT.md: the predecessor takes a three-argument
      // castVote, and pointing a current client at it surfaces as a failed vote
      // rather than a startup error — which is exactly what this prevents.
      return { status: 'WRONG_DEPLOYMENT', address, reason: 'CASTVOTE_ARITY' };
    case 'UNDECODABLE_REVERT':
      return { status: 'WRONG_DEPLOYMENT', address, reason: 'CASTVOTE_ARITY' };
    case 'NO_REVERT':
      // votingId 0 must always revert VotingNotFound. Something else is here.
      return { status: 'NOT_ZARYA', address, reason: 'CASTVOTE_DID_NOT_REVERT' };
    case 'CONTRACT_ERROR':
      break;
  }

  if (blockNumber === undefined) {
    return { status: 'UNREACHABLE', missing: ['blockNumber'] };
  }
  return { status: 'OK', chainId, blockNumber };
}

/** A verdict that is not OK and not merely unreachable must block writes. */
export function isUsableNetwork(verdict: NetworkVerdict): boolean {
  return verdict.status === 'OK';
}

/**
 * Whether re-checking could plausibly change the answer. An outage is
 * reconcile-later; a wrong deployment is not going to fix itself.
 */
export function isTransientVerdict(verdict: NetworkVerdict): boolean {
  return verdict.status === 'UNREACHABLE';
}
