import type { GoverningOrgan } from '../voting/voting';
import type { VotingPhase } from '../voting/votingLifecycle';
import {
  type AuthorizationVerdict,
  type MembershipObservations,
  castVoteRule,
  judgeAuthorization,
} from './authorization';
import {
  type PreflightCheck,
  type PreflightVerdict,
  READY,
  blocked,
  resolvePreflight,
  undetermined,
} from './verdict';

/**
 * Whether this wallet can cast this vote.
 *
 * The guards are written in **the order the contract evaluates them**, which is
 * not the order a UI would pick and is not negotiable:
 *
 * ```solidity
 * function castVote(uint256 votingId, bool support) external votingExists(votingId) {
 *     PartyOrgan governingOrgan = _votings[votingId].governingOrgan;   // Zarya.sol:272-278
 *     if (governingOrgan != PartyOrgans.ZERO_PARTY_ORGAN) {
 *         _onlyMemberOrChairman(governingOrgan);                       // NotActiveMember
 *     }
 *     _votings[votingId].castVote(support, msg.sender);                // VotingNotActive, then AlreadyVoted
 * }
 * ```
 *
 * So **membership is checked before the window**. A non-member looking at a
 * closed voting is refused for not being a member, not for the deadline — and a
 * preflight that reported the deadline would name a revert the chain never
 * raises. `resolvePreflight` keeps that order.
 *
 * Two of the three outcomes are not failures. `AlreadyVoted` is idempotent
 * completion, and the registry already says so — which is why this predicts
 * revert *names* and lets the registry supply the meaning.
 */

export interface VoteObservations {
  /** From the event projection: `NONE` is a permission, `UNKNOWN` is not. */
  readonly governingOrgan: GoverningOrgan;
  /** From `isVotingActive` and `isVotingFinalized`, classified. */
  readonly phase: VotingPhase;
  /** `hasVoted(votingId, caller)`. `undefined` when the read did not answer. */
  readonly hasVoted?: boolean;
  /** `isMember` against the governing organ and the Chairperson organ. */
  readonly membership: MembershipObservations;
}

export interface VotePreflight {
  readonly verdict: PreflightVerdict;
  /** Exposed so a UI can say *why* — "not a member of 74.СОВ" rather than "refused". */
  readonly authorization: AuthorizationVerdict;
}

export function judgeVotePreflight(observations: VoteObservations): VotePreflight {
  const authorization = judgeAuthorization(
    castVoteRule(observations.governingOrgan),
    observations.membership,
  );

  return {
    authorization,
    verdict: resolvePreflight([
      authorizationCheck(authorization),
      windowCheck(observations.phase),
      alreadyVotedCheck(observations.hasVoted),
    ]),
  };
}

const authorizationCheck = (authorization: AuthorizationVerdict): PreflightCheck => {
  switch (authorization.kind) {
    case 'ALLOWED':
      return READY;
    case 'DENIED':
      return blocked('NOT_AUTHORIZED', authorization.predicted);
    case 'UNDETERMINED':
      return undetermined(authorization.reason);
  }
};

/**
 * The voting's window, from the classified pair rather than from `isActive`
 * alone — `isActive` is a bare time comparison that never consults `finalized`
 * (`Votings.sol:146-148`), so it cannot answer this by itself.
 *
 * `AWAITING_EXECUTION` and `FINALIZED` both block, and both raise the same
 * `VotingNotActive`: `Votings.castVote` tests `isActive` and nothing else
 * (`Votings.sol:392`), so a finalized voting is refused for its window, not for
 * being finalized.
 */
const windowCheck = (phase: VotingPhase): PreflightCheck => {
  switch (phase) {
    case 'ACTIVE':
      return READY;
    case 'AWAITING_EXECUTION':
    case 'FINALIZED':
      return blocked('VOTING_WINDOW_CLOSED', 'VotingNotActive');
    case 'UNKNOWN':
      return undetermined('VOTING_UNREAD');
  }
};

const alreadyVotedCheck = (hasVoted: boolean | undefined): PreflightCheck => {
  if (hasVoted === undefined) return undetermined('VOTING_UNREAD');
  // Not a failure: the registry classifies AlreadyVoted as ALREADY_DONE, so a
  // caller retrying a vote that landed sees completion rather than an error.
  return hasVoted ? blocked('ALREADY_VOTED', 'AlreadyVoted') : READY;
};
