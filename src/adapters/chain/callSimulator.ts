import { encodeFunctionData } from 'viem';
import type { CallSimulator, SimulationResult } from '../../domain/ports/CallSimulator';
import type { EvmAddress } from '../../domain/primitives';
import type { VotingId } from '../../domain/voting/voting';
import { callRaw } from './contractCall';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * Simulation over `eth_call`.
 *
 * There is no wallet client here and there is nothing to sign with — the
 * simulated sender is an address, not an account, which is all `eth_call` needs
 * and all this phase has. Nothing here can broadcast; the class has no path to a
 * transaction even if a caller asked for one.
 *
 * Both methods encode through the bundled ABI, so the deployment discriminator
 * applies to them too: `castVote` is the two-argument form, and pointing this at
 * the predecessor deployment produces malformed calldata rather than a wrong
 * answer.
 */
export class ZaryaCallSimulator implements CallSimulator {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {}

  castVote(id: VotingId, support: boolean, from: EvmAddress): Promise<SimulationResult> {
    return this.simulate('castVote', [id, support], from);
  }

  executeVoting(id: VotingId, from: EvmAddress): Promise<SimulationResult> {
    return this.simulate('executeVoting', [id], from);
  }

  /**
   * Raw rather than decoded. `castVote` returns nothing, so a successful call
   * comes back with empty returndata — which the decoding path reports as an
   * empty revert, because it genuinely cannot tell the two apart from the
   * response alone. Going around the decode is what keeps "succeeded" from
   * reading as "reverted for an unnameable reason".
   */
  private async simulate(
    functionName: string,
    args: readonly unknown[],
    from: EvmAddress,
  ): Promise<SimulationResult> {
    let data: `0x${string}`;
    try {
      data = encodeFunctionData({ abi: ZARYA_ABI, functionName, args: args as unknown[] });
    } catch {
      return { kind: 'FAILED', outcome: { kind: 'UNKNOWN', reason: 'NOT_A_REVERT' } };
    }

    const outcome = await callRaw(this.client, this.address, data, { from });
    return outcome.kind === 'SUCCESS'
      ? { kind: 'WOULD_SUCCEED' }
      : { kind: 'FAILED', outcome: outcome.failure };
  }
}
