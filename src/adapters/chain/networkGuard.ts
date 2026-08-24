import { decodeErrorResult, decodeFunctionResult, encodeFunctionData } from 'viem';
import {
  type CastVoteProbe,
  type EligibilityFingerprint,
  type NetworkObservations,
  type NetworkVerdict,
  classifyNetwork,
} from '../../domain/network/networkIdentity';
import type { NetworkGuard } from '../../domain/ports/NetworkGuard';
import { type ChainId, type EvmAddress, chainId } from '../../domain/primitives';
import type { ZaryaPublicClient } from './publicClient';
import { readRevert } from './revertData';
import { ZARYA_ABI, ZARYA_ERROR_ABI, assertAbiContract } from './zaryaAbi';

/**
 * Observes the network and asks the domain what it means.
 *
 * Every observation is individually guarded: a failure yields "not observed"
 * rather than a thrown error, so one unreachable call cannot be mistaken for a
 * contract that answered wrongly. `verify()` never throws for a network
 * condition — that is the port's contract.
 */

/** `castVote(0, false)`: rejected by the votingExists guard before anything else. */
const PROBE_VOTING_ID = 0n;
const PROBE_SUPPORT = false;

export class ZaryaNetworkGuard implements NetworkGuard {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {
    // A drifted ABI is a programming error, not a network condition, so it
    // throws here at construction rather than becoming a verdict.
    assertAbiContract();
  }

  async verify(): Promise<NetworkVerdict> {
    return classifyNetwork(await this.observe());
  }

  private async observe(): Promise<NetworkObservations> {
    const observedChainId = await this.readChainId();

    // Short-circuit deliberately: probing a contract on a chain we may not talk
    // to is both pointless and a request we should not be making.
    if (observedChainId === undefined) {
      return { address: this.address };
    }

    const [hasContractCode, eligibility, castVoteProbe, blockNumber] = await Promise.all([
      this.readHasCode(),
      this.readEligibility(),
      this.probeCastVote(),
      this.readBlockNumber(),
    ]);

    return {
      chainId: observedChainId,
      address: this.address,
      hasContractCode,
      eligibility,
      castVoteProbe,
      blockNumber,
    };
  }

  private async readChainId(): Promise<ChainId | undefined> {
    try {
      return chainId(await this.client.getChainId());
    } catch {
      return undefined;
    }
  }

  private async readHasCode(): Promise<boolean | undefined> {
    try {
      const code = await this.client.getCode({ address: this.address });
      return code !== undefined && code !== '0x';
    } catch {
      return undefined;
    }
  }

  private async readEligibility(): Promise<EligibilityFingerprint | undefined> {
    try {
      // encode/call/decode rather than readContract: with an ABI imported as
      // JSON the type is widened to `Abi`, and readContract's generics do not
      // survive that. The wire behavior is identical.
      const { data } = await this.client.call({
        to: this.address,
        data: encodeFunctionData({ abi: ZARYA_ABI, functionName: 'simpleMajority' }),
      });
      if (data === undefined) return undefined;

      const result = decodeFunctionResult({
        abi: ZARYA_ABI,
        functionName: 'simpleMajority',
        data,
      });

      // Three outputs come back as a tuple. Validated rather than trusted: this
      // is the check that decides whether we are talking to Zarya at all.
      if (!Array.isArray(result) || result.length !== 3) return undefined;
      const [quorum, approvalPercentage, approvalPercentageBase] = result;
      if (
        typeof quorum !== 'bigint' ||
        typeof approvalPercentage !== 'bigint' ||
        typeof approvalPercentageBase !== 'bigint'
      ) {
        return undefined;
      }
      return { quorum, approvalPercentage, approvalPercentageBase };
    } catch {
      return undefined;
    }
  }

  /**
   * Simulates the two-argument `castVote`. Read-only: `eth_call` with no signer,
   * no `from`, and a voting id the contract always rejects, so nothing is
   * broadcast and no state is touched.
   */
  private async probeCastVote(): Promise<CastVoteProbe | undefined> {
    let data: `0x${string}`;
    try {
      data = encodeFunctionData({
        abi: ZARYA_ABI,
        functionName: 'castVote',
        args: [PROBE_VOTING_ID, PROBE_SUPPORT],
      });
    } catch {
      // Encoding is local; failing here means the ABI lacks the two-argument
      // form, which assertAbiContract should already have caught.
      return undefined;
    }

    try {
      await this.client.call({ to: this.address, data });
      return 'NO_REVERT';
    } catch (error) {
      const revert = readRevert(error);
      if (revert === undefined) {
        // Transport failure, not a verdict.
        return undefined;
      }
      if (revert.data === undefined) {
        return 'EMPTY_REVERT';
      }
      try {
        decodeErrorResult({ abi: ZARYA_ERROR_ABI, data: revert.data });
        return 'CONTRACT_ERROR';
      } catch {
        return 'UNDECODABLE_REVERT';
      }
    }
  }

  private async readBlockNumber(): Promise<bigint | undefined> {
    try {
      return await this.client.getBlockNumber();
    } catch {
      return undefined;
    }
  }
}
