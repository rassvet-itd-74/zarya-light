import { encodeFunctionData } from 'viem';
import type { GovernanceIntent } from '../../domain/intents/intent';
import { callsForIntent } from '../../domain/intents/intentCalls';
import type {
  CallSimulator,
  IntentSimulation,
  SimulationResult,
} from '../../domain/ports/CallSimulator';
import type { OrganResolver } from '../../domain/ports/OrganResolver';
import type { EvmAddress } from '../../domain/primitives';
import type { VotingId } from '../../domain/voting/voting';
import { callRaw } from './contractCall';
import type { ZaryaPublicClient } from './publicClient';
import { encodeWriteCall } from './writeCallData';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * Simulation over `eth_call`.
 *
 * There is no wallet client here and there is nothing to sign with — the
 * simulated sender is an address, not an account, which is all `eth_call` needs
 * and all this phase has. Nothing here can broadcast; the class has no path to a
 * transaction even if a caller asked for one.
 *
 * Every method encodes through the bundled ABI, so the deployment discriminator
 * applies to them too: `castVote` is the two-argument form, and pointing this at
 * the predecessor deployment produces malformed calldata rather than a wrong
 * answer.
 *
 * ## A multi-step simulation does not compose
 *
 * `eth_call` runs against the *current* state, so step 2 of a sequence is
 * simulated as though step 1 had not happened. For the one intent that expands
 * that is exact — the three threshold setters share `onlyChairman` and write
 * independent storage slots, so none of them is a precondition for another. It
 * would not be exact for a sequence whose steps depend on each other, and there
 * is no such intent; adding one means overriding state here, not trusting this.
 */
export class ZaryaCallSimulator implements CallSimulator {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
    /**
     * Needed only by {@link forIntent}, and required rather than optional: an
     * organ resolved by a fallback nobody configured is the failure this whole
     * client is built to prevent.
     */
    private readonly organs: OrganResolver,
  ) {}

  castVote(id: VotingId, support: boolean, from: EvmAddress): Promise<SimulationResult> {
    return this.simulate('castVote', [id, support], from);
  }

  executeVoting(id: VotingId, from: EvmAddress): Promise<SimulationResult> {
    return this.simulate('executeVoting', [id], from);
  }

  /**
   * Every call an intent expands to, in order, stopping at the first refusal.
   *
   * The steps are simulated **sequentially and not in parallel**, so that a
   * `FAILED` names the first step that would actually stop the sequence rather
   * than whichever request lost a race. For the three threshold setters that is
   * also the only order in which the answer means anything.
   */
  async forIntent(intent: GovernanceIntent, from: EvmAddress): Promise<IntentSimulation> {
    const calls = callsForIntent(intent);

    for (let step = 0; step < calls.length; step += 1) {
      const encoded = await encodeWriteCall(calls[step], this.organs);
      if (encoded.kind === 'UNAVAILABLE') {
        // Never asked, so never reported as something the contract decided.
        return { kind: 'NOT_ATTEMPTED', reason: encoded.reason, detail: encoded.detail };
      }
      const outcome = await callRaw(this.client, this.address, encoded.data, { from });
      if (outcome.kind === 'FAILURE') {
        return { kind: 'FAILED', calls, step, outcome: outcome.failure };
      }
    }

    return { kind: 'WOULD_SUCCEED', calls };
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
