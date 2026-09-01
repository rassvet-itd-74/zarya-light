import { describe, expect, it } from 'vitest';
import { meaningOf } from '../domain/chain/contractErrors';
import { CHAIRPERSON_ORGAN, partyOrganTriple } from '../domain/organs/partyOrgan';
import type { CallSimulator, SimulationResult } from '../domain/ports/CallSimulator';
import type { OrganResolver, ResolvedOrgan } from '../domain/ports/OrganResolver';
import type { MembershipReader, VotingReader } from '../domain/ports/VotingReader';
import { type Bytes32, bytes32, evmAddress, unixSeconds } from '../domain/primitives';
import type { GoverningOrgan, VotingId, VotingRecord } from '../domain/voting/voting';
import { votingId } from '../domain/voting/voting';
import { preflightVote } from './preflightVote';

const SOVIET = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const CHAIRPERSON = bytes32(`0x${'cc'.repeat(32)}`);
const VOTER = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');

const recordWith = (governingOrgan: GoverningOrgan): VotingRecord => ({
  votingId: votingId(1n),
  author: VOTER,
  startTime: unixSeconds(1_787_530_584),
  endTime: unixSeconds(1_787_530_704),
  suggestionType: 'Membership',
  governingOrgan,
  blockNumber: 11_553_481n,
});

interface Spy {
  readonly membershipReads: Bytes32[];
  readonly organResolutions: string[];
  readonly simulations: VotingId[];
}

interface FakeOptions {
  readonly memberOf?: readonly Bytes32[];
  readonly active?: boolean;
  readonly finalized?: boolean;
  readonly hasVoted?: boolean;
  readonly simulation?: SimulationResult;
  readonly organResolutionFails?: boolean;
}

const fakes = (options: FakeOptions) => {
  const spy: Spy = { membershipReads: [], organResolutions: [], simulations: [] };

  const votings: VotingReader = {
    observe: async () => ({ active: options.active, finalized: options.finalized }),
    results: async () => undefined,
    hasVoted: async () => options.hasVoted,
    highestVotingId: async () => 1n,
  };

  const members: MembershipReader = {
    isMember: async (organ) => {
      spy.membershipReads.push(organ);
      return (options.memberOf ?? []).includes(organ);
    },
  };

  const organs: OrganResolver = {
    resolve: async (triple) => {
      spy.organResolutions.push(triple.organType);
      if (options.organResolutionFails === true) throw new Error('rpc down');
      return { triple, organ: CHAIRPERSON, identifier: 'ПРЛ' } satisfies ResolvedOrgan;
    },
    label: () => undefined,
    tripleOf: () => undefined,
  };

  const simulator: CallSimulator = {
    castVote: async (id) => {
      spy.simulations.push(id);
      return options.simulation ?? { kind: 'WOULD_SUCCEED' };
    },
    executeVoting: async () => ({ kind: 'WOULD_SUCCEED' }),
  };

  return { spy, votings, members, organs, simulator };
};

describe('reading only what the rule can use', () => {
  it('makes no membership read at all for a voting with no organ', async () => {
    // Theme and statement votings are open to anyone. A membership read here
    // would be a round trip whose answer must not be allowed to matter.
    const { spy, votings, members, organs } = fakes({ active: true, finalized: false, hasVoted: false });

    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'NONE' }), voter: VOTER, support: true },
    );

    expect(spy.membershipReads).toEqual([]);
    expect(spy.organResolutions).toEqual([]);
    expect(result.verdict).toEqual({ kind: 'READY' });
  });

  it('makes no read at all when the organ is unknown', async () => {
    const { spy, votings, members, organs } = fakes({ active: true, finalized: false, hasVoted: false });

    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'UNKNOWN' }), voter: VOTER, support: true },
    );

    expect(spy.membershipReads).toEqual([]);
    expect(result.verdict).toEqual({ kind: 'UNDETERMINED', reason: 'ORGAN_UNKNOWN' });
  });

  it('reads both the organ and the Chairperson organ for a governed voting', async () => {
    const { spy, votings, members, organs } = fakes({
      memberOf: [SOVIET],
      active: true,
      finalized: false,
      hasVoted: false,
    });

    await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(spy.membershipReads).toContain(SOVIET);
    expect(spy.membershipReads).toContain(CHAIRPERSON);
    // Through the contract's own pure helper, not from a constant.
    expect(spy.organResolutions).toEqual([CHAIRPERSON_ORGAN.organType]);
  });
});

describe('the Chairman exemption', () => {
  it('lets a non-member Chairman vote', async () => {
    const { votings, members, organs } = fakes({
      memberOf: [CHAIRPERSON],
      active: true,
      finalized: false,
      hasVoted: false,
    });

    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(result.reasoning.authorization).toEqual({ kind: 'ALLOWED' });
  });

  it('is undetermined, not denied, when the Chairperson organ cannot be resolved', async () => {
    // An outage on the resolution must never read as "not the Chairman" — that
    // would hide a privilege.
    const { votings, members, organs } = fakes({
      active: true,
      finalized: false,
      hasVoted: false,
      organResolutionFails: true,
    });

    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(result.reasoning.authorization).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
  });
});

describe('with a simulator', () => {
  it('takes the contract’s refusal over the client’s guess and flags the drift', async () => {
    // The projection says this member may vote; the chain says otherwise —
    // exactly what a stale projection looks like from here.
    const refusal: SimulationResult = {
      kind: 'FAILED',
      outcome: {
        kind: 'REVERTED',
        name: 'NotActiveMember',
        meaning: meaningOf('NotActiveMember'),
      },
    };
    const { spy, votings, members, organs, simulator } = fakes({
      memberOf: [SOVIET],
      active: true,
      finalized: false,
      hasVoted: false,
      simulation: refusal,
    });

    const result = await preflightVote(
      { votings, members, organs, simulator },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(spy.simulations).toEqual([1n]);
    expect(result.source).toBe('SIMULATION');
    expect(result.disagreement).toBe('CLIENT_LOOSER');
    expect(result.verdict).toMatchObject({ blocker: 'NOT_AUTHORIZED' });
  });

  it('resolves an unknown organ that the client could not', async () => {
    // The projection has no entry, so the client cannot judge eligibility. The
    // simulation can, which is the whole reason the UNKNOWN path simulates
    // rather than assuming the voting is open.
    const { votings, members, organs, simulator } = fakes({
      active: true,
      finalized: false,
      hasVoted: false,
    });

    const result = await preflightVote(
      { votings, members, organs, simulator },
      { record: recordWith({ kind: 'UNKNOWN' }), voter: VOTER, support: true },
    );

    expect(result.reasoning.verdict).toEqual({ kind: 'UNDETERMINED', reason: 'ORGAN_UNKNOWN' });
    expect(result.verdict).toEqual({ kind: 'READY' });
    expect(result.source).toBe('SIMULATION');
  });
});

describe('without a simulator', () => {
  it('still answers, and never dresses the answer up as the contract’s', async () => {
    const { votings, members, organs } = fakes({
      memberOf: [SOVIET],
      active: true,
      finalized: false,
      hasVoted: true,
    });

    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(result.source).toBe('CLIENT');
    expect(result.simulation).toBeUndefined();
    expect(result.verdict).toMatchObject({ blocker: 'ALREADY_VOTED' });
  });
});

describe('the organ a UI would name', () => {
  it('is available even when the verdict is a refusal', async () => {
    // "Not a member of 74.СОВ" rather than "refused" — the reasoning is kept
    // beside the verdict for exactly this.
    const soviet = partyOrganTriple({ organType: 'RegionalSoviet', region: 74 });
    expect(soviet.number).toBe(0);

    const { votings, members, organs } = fakes({ active: true, finalized: false, hasVoted: false });
    const result = await preflightVote(
      { votings, members, organs },
      { record: recordWith({ kind: 'ORGAN', organ: SOVIET }), voter: VOTER, support: true },
    );

    expect(result.reasoning.authorization).toEqual({
      kind: 'DENIED',
      reason: 'NOT_A_MEMBER',
      predicted: 'NotActiveMember',
    });
  });
});
