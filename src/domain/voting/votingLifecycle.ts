import type { UnixSeconds } from '../primitives';
import type { VotingRecord } from './voting';

/**
 * Where a voting stands, decided from observations rather than from a getter.
 *
 * The contract exposes two booleans and they are not the two you would guess.
 * `isActive` is a **pure time window** that does not consult `finalized`
 * (`Votings.sol:146-148`):
 *
 * ```solidity
 * return block.timestamp >= self.startTime && block.timestamp <= self.endTime;
 * ```
 *
 * So the pair carries the state: past the deadline and not finalized is the
 * interesting case, and it is where a quorum-failed voting lives forever.
 *
 * Same rule as the network guard — **an unobserved fact is not a failed one.**
 * Either boolean may be absent, and absence yields `UNKNOWN`.
 */

export type VotingPhase =
  /** Inside its window. Votes may be cast; execution reverts `VotingStillActive`. */
  | 'ACTIVE'
  /**
   * Past `endTime` and not finalized. Either genuinely awaiting execution, or
   * permanently unexecutable because quorum was never met — the two are
   * indistinguishable from chain state alone, which is why the executor has to
   * remember `InsufficientVotes` locally.
   */
  | 'AWAITING_EXECUTION'
  /** `executeVoting` succeeded. Accepted or rejected is a separate question. */
  | 'FINALIZED'
  /** Not observed, or observed as something the contract cannot produce. */
  | 'UNKNOWN';

export interface VotingObservations {
  readonly active?: boolean;
  readonly finalized?: boolean;
}

export function classifyVotingPhase({ active, finalized }: VotingObservations): VotingPhase {
  if (finalized === undefined || active === undefined) return 'UNKNOWN';

  // Finalized wins. It is reachable only after the window closes, since
  // executeVoting reverts VotingStillActive while isActive holds — so an
  // "active and finalized" pair is not something this contract can produce.
  if (finalized) return active ? 'UNKNOWN' : 'FINALIZED';
  return active ? 'ACTIVE' : 'AWAITING_EXECUTION';
}

/**
 * Whether the deadline has passed, from **chain block time**.
 *
 * Strictly greater, and the strictness is the point: `isActive` compares
 * `block.timestamp <= endTime`, so at exactly `endTime` the voting is still
 * active and `executeVoting` reverts `VotingStillActive`. A `>=` here would
 * queue an execution that is guaranteed to revert once per poll.
 */
export const isExecutionDue = (record: VotingRecord, chainTime: UnixSeconds): boolean =>
  chainTime > record.endTime;

/**
 * Whether the voting has opened. Always true in practice — `startTime` is the
 * creating block's timestamp — but the contract's window is two-sided, so the
 * model is too rather than assuming the contract's own invariant.
 */
export const hasOpened = (record: VotingRecord, chainTime: UnixSeconds): boolean =>
  chainTime >= record.startTime;

/**
 * Seconds until the deadline passes, or `0` once it has. For display only:
 * a countdown must be rendered from chain time, never from the workstation
 * clock, or it will disagree with what the contract does.
 */
export const secondsUntilDeadline = (record: VotingRecord, chainTime: UnixSeconds): number =>
  chainTime > record.endTime ? 0 : record.endTime - chainTime + 1;

/**
 * What the executor should do about one voting, given everything known.
 *
 * Deliberately narrower than `STATE_MACHINES.md`'s executive job state: this
 * says only what *chain* evidence supports. Local memory of a terminal
 * `InsufficientVotes` is the executor's own (Phase 7), and it suppresses
 * `DUE` — which is the one place local state overrides what the chain keeps
 * offering.
 */
export type ExecutionReadiness =
  /** Past deadline, unfinalized: `executeVoting` is worth attempting. */
  | 'DUE'
  /** Still inside the window. */
  | 'NOT_DUE'
  /** Already finalized; nothing to do. */
  | 'SETTLED'
  /** Missing an observation. Reconcile, do not act. */
  | 'UNKNOWN';

export function executionReadiness(
  record: VotingRecord,
  observations: VotingObservations,
  chainTime: UnixSeconds | undefined,
): ExecutionReadiness {
  const phase = classifyVotingPhase(observations);
  if (phase === 'FINALIZED') return 'SETTLED';
  if (phase === 'UNKNOWN' || chainTime === undefined) return 'UNKNOWN';
  if (phase === 'ACTIVE') return 'NOT_DUE';

  // AWAITING_EXECUTION. The chain flags already imply the window closed, but the
  // record's endTime is checked too: the two come from different sources — a
  // read and a projection — and disagreement means one of them is stale rather
  // than that execution is due.
  return isExecutionDue(record, chainTime) ? 'DUE' : 'UNKNOWN';
}
