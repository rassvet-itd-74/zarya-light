import type { CallOutcome } from '../chain/contractErrors';
import type { GovernanceIntent } from '../intents/intent';
import type { ZaryaWriteCall } from '../intents/intentCalls';
import type { EvmAddress } from '../primitives';
import type { VotingId } from '../voting/voting';

/**
 * Asking the contract what it would do, without asking it to do it.
 *
 * Simulation is the honest half of preflight. The client's own checks mirror the
 * contract's guards and can be wrong — a stale projection, an organ read that
 * raced a membership voting — while a simulation runs the actual bytecode
 * against the actual current state. It is still not authorization
 * (`INVARIANTS.md`): state can change between the simulation and the mining, so
 * a `WOULD_SUCCEED` is a well-founded expectation and never a guarantee.
 *
 * ## Why this port names calls instead of taking calldata
 *
 * A `simulate(to, data)` port would be smaller and would be the wrong shape. The
 * form pipeline's whole trust boundary is that a document maps to an
 * **allow-listed typed intent**, never to arbitrary calldata; a port that
 * accepted bytes would put a hole in that boundary one layer below where anyone
 * would look for it. So the port names the operations, and Phase 3 adds arms to
 * it as the intent union grows.
 *
 * The two named arms are the two Phase 2 needed: `castVote` for the vote
 * preflight, and `executeVoting` for the executor's decision to enqueue.
 * {@link CallSimulator.forIntent} is the general one, and it takes the **intent
 * union** — still not calldata, so the allow list holds one layer down too.
 */

export type SimulationResult =
  /** The call returned. Nothing was signed and nothing was broadcast. */
  | { readonly kind: 'WOULD_SUCCEED' }
  /**
   * The call did not return. `outcome` distinguishes a decoded revert from an
   * outage — the difference between "the contract refused" and "we could not
   * ask", which must never collapse.
   */
  | { readonly kind: 'FAILED'; readonly outcome: CallOutcome };

/**
 * Why a simulation was never made, as distinct from what the contract said.
 *
 * Every one of these means *this client* could not produce the call — the
 * contract was never asked, so nothing here is a statement about what it would
 * decide. They are separated because their retry behavior differs and a single
 * "could not simulate" would flatten it:
 *
 * - `ORGAN_UNREADABLE` — the `pure` organ helper did not answer. A transport
 *   failure, so reconcile and try again.
 * - `ORGAN_MISMATCH` — it answered and disagreed with the locally composed
 *   identifier. Retrying repeats it exactly; the region table or the deployment
 *   is wrong and a human has to look.
 * - `NOT_ENCODABLE` — the arguments would not encode against the ABI. A
 *   programming error or the wrong deployment, never a chain condition.
 */
export type CallUnavailableReason = 'ORGAN_UNREADABLE' | 'ORGAN_MISMATCH' | 'NOT_ENCODABLE';

/**
 * What simulating a whole intent produced.
 *
 * Three arms, because an intent is not always one call and "it failed" is not
 * always about the contract.
 *
 * `FAILED` names the **step** that failed and stops there: the sequence would
 * abort at that transaction anyway, and simulating what comes after a failure
 * answers a question about state that will not exist. For the one intent that
 * expands — the three threshold setters, which share `onlyChairman` and touch
 * independent storage — the later steps would fail identically, so nothing is
 * lost by not asking.
 */
export type IntentSimulation =
  /** Every step returned. Nothing was signed and nothing was broadcast. */
  | { readonly kind: 'WOULD_SUCCEED'; readonly calls: readonly ZaryaWriteCall[] }
  /** The contract refused at `step` (zero-based) of `calls`. */
  | {
      readonly kind: 'FAILED';
      readonly calls: readonly ZaryaWriteCall[];
      readonly step: number;
      readonly outcome: CallOutcome;
    }
  /** The contract was never asked. See {@link CallUnavailableReason}. */
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly reason: CallUnavailableReason;
      /** One line naming what could not be produced. Safe to log. */
      readonly detail: string;
    };

export interface CallSimulator {
  /**
   * `from` is not optional, and that is the point: every guard in Zarya tests
   * `msg.sender`, so a simulation without a sender answers a question about the
   * zero address and reports it as though it were about this wallet.
   */
  castVote(id: VotingId, support: boolean, from: EvmAddress): Promise<SimulationResult>;

  /**
   * Any allow-listed intent, expanded into its calls and simulated in order.
   *
   * A `WOULD_SUCCEED` here is not authorization and not a promise: state can
   * change between this and the mining, and for a multi-step intent it can
   * change *between the steps*. It is the strongest thing that can be said
   * without signing anything.
   */
  forIntent(intent: GovernanceIntent, from: EvmAddress): Promise<IntentSimulation>;

  /**
   * Mechanical only. `executeVoting` takes no policy arguments and is
   * permissionless, so `from` changes nothing about whether it succeeds — it is
   * still passed, because the executor's wallet is what would send it and a
   * simulation should differ from the real call in as little as possible.
   */
  executeVoting(id: VotingId, from: EvmAddress): Promise<SimulationResult>;
}
