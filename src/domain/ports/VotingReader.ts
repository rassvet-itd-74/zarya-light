import type { Bytes32, EvmAddress } from '../primitives';
import type { VotingId } from '../voting/voting';
import type { VotingObservations } from '../voting/votingLifecycle';

/**
 * Reads of voting and membership state.
 *
 * Every method here is `view` on chain and cheap. What is *not* here matters as
 * much: there is no read for a voting's organ, its eligibility thresholds, or
 * its `endTime`. Those are absent from the contract, and inventing a port method
 * for them would push the absence one layer down instead of confronting it. See
 * "Not exposed" in `CONTRACT.md`.
 */

export interface VoteResults {
  readonly forVotes: bigint;
  readonly againstVotes: bigint;
  readonly totalVotes: bigint;
}

export interface VotingReader {
  /**
   * One round trip for both flags, since they are only meaningful together —
   * `isActive` does not consult `finalized`, so either alone is ambiguous.
   *
   * A voting the contract does not have reverts `VotingNotFound`; this returns
   * `undefined` observations rather than throwing, so a missing voting reads as
   * "not observed" instead of an exception at every call site.
   */
  observe(id: VotingId): Promise<VotingObservations>;

  /** Vote counts only. The thresholds they will be judged against are unreadable. */
  results(id: VotingId): Promise<VoteResults | undefined>;

  hasVoted(id: VotingId, member: EvmAddress): Promise<boolean | undefined>;

  /**
   * The **highest voting id issued so far**, and `0` when none have been.
   *
   * Named away from the contract's `nextVotingId` deliberately, because that
   * name is wrong in a way that costs. `_getNextVotingId` returns
   * `++nextVotingId` (`Zarya.sol:508`) — a pre-increment — so the stored value
   * is the id just handed out, not the one coming next. `votingExists` agrees:
   * it rejects `votingId > nextVotingId` (`Zarya.sol:566`), so `nextVotingId`
   * is itself a valid id.
   *
   * Reading it as "one past the last" underruns paging by one and hides the
   * newest voting, and reading `1` as "none exist" is wrong twice over — an
   * empty contract reports `0`, and `1` means exactly one voting exists.
   *
   * A bounded paging fallback for discovery, never a substitute for it: this
   * gives ids, and `endTime` comes only from the event.
   */
  highestVotingId(): Promise<bigint | undefined>;
}

export interface MembershipReader {
  /**
   * Membership of a specific organ.
   *
   * Also the Chairman check: the Chairman is stored as a member of the
   * Chairperson organ (`Zarya.sol:53-54`), which is why no `getChairman()` is
   * needed. Pass `CHAIRPERSON_ORGAN` resolved through `OrganResolver`.
   */
  isMember(organ: Bytes32, member: EvmAddress): Promise<boolean | undefined>;
}
