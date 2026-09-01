import type { CallOutcome } from '../chain/contractErrors';
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
 * The two here are the two Phase 2 needs: `castVote` for the vote preflight, and
 * `executeVoting` for the executor's decision to enqueue.
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

export interface CallSimulator {
  /**
   * `from` is not optional, and that is the point: every guard in Zarya tests
   * `msg.sender`, so a simulation without a sender answers a question about the
   * zero address and reports it as though it were about this wallet.
   */
  castVote(id: VotingId, support: boolean, from: EvmAddress): Promise<SimulationResult>;

  /**
   * Mechanical only. `executeVoting` takes no policy arguments and is
   * permissionless, so `from` changes nothing about whether it succeeds — it is
   * still passed, because the executor's wallet is what would send it and a
   * simulation should differ from the real call in as little as possible.
   */
  executeVoting(id: VotingId, from: EvmAddress): Promise<SimulationResult>;
}
