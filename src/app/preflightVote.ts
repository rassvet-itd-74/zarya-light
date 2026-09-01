import { CHAIRPERSON_ORGAN } from '../domain/organs/partyOrgan';
import type { CallSimulator } from '../domain/ports/CallSimulator';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import type { MembershipReader, VotingReader } from '../domain/ports/VotingReader';
import {
  type AuthorizationRule,
  type MembershipObservations,
  castVoteRule,
  needsChairmanRead,
  organToCheck,
} from '../domain/preflight/authorization';
import {
  type ReconciledPreflight,
  reconcilePreflight,
} from '../domain/preflight/reconcilePreflight';
import { type VotePreflight, judgeVotePreflight } from '../domain/preflight/votePreflight';
import type { EvmAddress } from '../domain/primitives';
import type { VotingRecord } from '../domain/voting/voting';
import { classifyVotingPhase } from '../domain/voting/votingLifecycle';

/**
 * "Can this wallet vote on this voting, and if not, why not?"
 *
 * The use case exists to keep the gathering apart from the judging. Every rule
 * lives in `domain/preflight/`, testable with no node; this file decides only
 * *which reads to make*, and even that is derived — `organToCheck` and
 * `needsChairmanRead` come from the rule, so a rule that grants the Chairman
 * nothing never spends a round trip asking whether the caller is Chairman, and
 * more importantly never has the answer available to misuse.
 *
 * The voting record comes from the caller, not from a read, because it cannot
 * come from a read: `endTime` and the governing organ exist only in the creation
 * events. A caller with no record for this id passes `undefined`, which is the
 * `UNKNOWN` organ path — undetermined eligibility, and the simulation decides.
 */

export interface VotePreflightRequest {
  readonly record: VotingRecord;
  readonly voter: EvmAddress;
  /**
   * Which way the vote would go. It changes nothing about eligibility — no guard
   * reads it — but the simulation should differ from the real call in as little
   * as possible, so it is sent as given.
   */
  readonly support: boolean;
}

export interface VotePreflightResult extends ReconciledPreflight {
  /** The client's own reasoning in full, including which organ decided. */
  readonly reasoning: VotePreflight;
}

export interface VotePreflightDependencies {
  readonly votings: VotingReader;
  readonly members: MembershipReader;
  readonly organs: OrganResolver;
  /**
   * Optional, and the option is real: an executor status pane wants the client
   * reasoning without spending a round trip per row, while a member about to
   * sign wants the contract's own answer. Omitted, the result is still a
   * verdict — labelled `CLIENT`, never dressed up as more than it is.
   */
  readonly simulator?: CallSimulator;
}

export async function preflightVote(
  { votings, members, organs, simulator }: VotePreflightDependencies,
  { record, voter, support }: VotePreflightRequest,
): Promise<VotePreflightResult> {
  const rule = castVoteRule(record.governingOrgan);

  const [membership, observations, hasVoted, simulation] = await Promise.all([
    readMembership(rule, voter, { members, organs }),
    votings.observe(record.votingId),
    votings.hasVoted(record.votingId, voter),
    simulator?.castVote(record.votingId, support, voter),
  ]);

  const reasoning = judgeVotePreflight({
    governingOrgan: record.governingOrgan,
    phase: classifyVotingPhase(observations),
    hasVoted,
    membership,
  });

  return {
    ...reconcilePreflight(reasoning.verdict, simulation),
    reasoning,
  };
}

/**
 * The membership reads a rule actually needs, and no others.
 *
 * The Chairperson organ is resolved through the contract's own `pure` helper
 * rather than hard-coded, so the digest this client checks against is the one the
 * deployed library produces. That resolution is memoized, so asking for it per
 * preflight costs one round trip on the first call and none after.
 */
async function readMembership(
  rule: AuthorizationRule,
  voter: EvmAddress,
  { members, organs }: Pick<VotePreflightDependencies, 'members' | 'organs'>,
): Promise<MembershipObservations> {
  const organ = organToCheck(rule);

  const [memberOfOrgan, chairman] = await Promise.all([
    organ === undefined ? undefined : members.isMember(organ, voter),
    needsChairmanRead(rule) ? readChairman(voter, { members, organs }) : undefined,
  ]);

  return { memberOfOrgan, chairman };
}

/**
 * The Chairman check, which has no getter of its own: the Chairman is stored as a
 * member of the Chairperson organ (`Zarya.sol:53-54`), so `isMember` answers it.
 *
 * A failure to resolve the organ is `undefined`, not `false`. Reporting "not the
 * Chairman" because a call timed out would hide a privilege, which is the exact
 * direction this codebase refuses to fail in.
 */
async function readChairman(
  voter: EvmAddress,
  { members, organs }: Pick<VotePreflightDependencies, 'members' | 'organs'>,
): Promise<boolean | undefined> {
  try {
    const chairperson = await organs.resolve(CHAIRPERSON_ORGAN);
    return await members.isMember(chairperson.organ, voter);
  } catch {
    return undefined;
  }
}
