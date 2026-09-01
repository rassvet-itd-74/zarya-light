import type {
  MembershipReader,
  VoteResults,
  VotingReader,
} from '../../domain/ports/VotingReader';
import type { Bytes32, EvmAddress } from '../../domain/primitives';
import type { VotingId } from '../../domain/voting/voting';
import type { VotingObservations } from '../../domain/voting/votingLifecycle';
import { type ReadOutcome, callContract } from './contractCall';
import type { ZaryaPublicClient } from './publicClient';

/**
 * The `view` reads, behind the domain's ports.
 *
 * One rule shapes every method: **a read that did not answer returns
 * `undefined`, never a value that looks like an answer.** `false` and "we could
 * not tell" are different facts, and a reader that conflated them would let an
 * RPC hiccup read as "not a member" or "not finalized" — the first would hide a
 * privilege, the second would queue an execution against a settled voting.
 *
 * `VotingNotFound` is treated the same way rather than as an error, because at
 * this layer a voting the contract does not have and a voting we could not read
 * are both "no observation". The distinction, where a caller needs it, comes
 * from `nextVotingId`.
 */
export class ZaryaVotingReader implements VotingReader, MembershipReader {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {}

  /**
   * Both flags in one pass, because either alone is ambiguous: `isActive` is a
   * time window that does not consult `finalized` (`Votings.sol:146-148`).
   *
   * The two calls are concurrent and not atomic — a voting can finalize between
   * them, yielding `active: false, finalized: true`, which classifies as
   * `FINALIZED` and is correct. The pair that cannot occur is
   * `active: true, finalized: true`, which the domain reports as `UNKNOWN`.
   */
  async observe(id: VotingId): Promise<VotingObservations> {
    const [active, finalized] = await Promise.all([
      this.readBoolean('isVotingActive', [id]),
      this.readBoolean('isVotingFinalized', [id]),
    ]);
    return { active, finalized };
  }

  async results(id: VotingId): Promise<VoteResults | undefined> {
    const outcome = await this.read('getVotingResults', [id]);
    if (outcome.kind !== 'VALUE' || typeof outcome.value !== 'object' || outcome.value === null) {
      return undefined;
    }
    const { forVotes, againstVotes, totalVotes } = outcome.value as Record<string, unknown>;
    if (
      typeof forVotes !== 'bigint' ||
      typeof againstVotes !== 'bigint' ||
      typeof totalVotes !== 'bigint'
    ) {
      return undefined;
    }
    return { forVotes, againstVotes, totalVotes };
  }

  hasVoted(id: VotingId, member: EvmAddress): Promise<boolean | undefined> {
    return this.readBoolean('hasVoted', [id, member]);
  }

  isMember(organ: Bytes32, member: EvmAddress): Promise<boolean | undefined> {
    return this.readBoolean('isMember', [organ, member]);
  }

  /**
   * Reads the contract's `nextVotingId`, whose name does not describe it: it
   * holds the **last** id issued, because `_getNextVotingId` pre-increments
   * (`Zarya.sol:508`). The port's name says what the value is.
   */
  async highestVotingId(): Promise<bigint | undefined> {
    const outcome = await this.read('nextVotingId', []);
    return outcome.kind === 'VALUE' && typeof outcome.value === 'bigint'
      ? outcome.value
      : undefined;
  }

  /**
   * Whether the contract has a voting with this id at all.
   *
   * `false` requires evidence — a decoded `VotingNotFound`, which is the
   * `votingExists` guard speaking. Anything else is `undefined`, because "the
   * node did not answer" must never read as "that voting does not exist".
   */
  async exists(id: VotingId): Promise<boolean | undefined> {
    const outcome = await this.read('isVotingActive', [id]);
    if (outcome.kind === 'VALUE') return true;
    if (outcome.failure.kind === 'REVERTED' && outcome.failure.name === 'VotingNotFound') {
      return false;
    }
    return undefined;
  }

  private async readBoolean(
    functionName: string,
    args: readonly unknown[],
  ): Promise<boolean | undefined> {
    const outcome = await this.read(functionName, args);
    return outcome.kind === 'VALUE' && typeof outcome.value === 'boolean'
      ? outcome.value
      : undefined;
  }

  /**
   * The classified failure is kept rather than collapsed, so callers that need
   * to tell `VotingNotFound` from an outage can, and those that do not can keep
   * ignoring it.
   */
  private read(functionName: string, args: readonly unknown[]): Promise<ReadOutcome> {
    return callContract(this.client, this.address, functionName, args);
  }
}
