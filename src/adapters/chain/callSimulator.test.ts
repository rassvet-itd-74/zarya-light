import { encodeErrorResult } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { INTENT_SAMPLES, SAMPLE_MEMBER } from '../../domain/intents/testing/intentSamples';
import { partyOrganIdentifier } from '../../domain/organs/partyOrgan';
import type { OrganResolver } from '../../domain/ports/OrganResolver';
import { type Bytes32, bytes32 } from '../../domain/primitives';
import { ZaryaCallSimulator } from './callSimulator';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * `forIntent`, driven by a stub node.
 *
 * The fork test proves a simulation agrees with the deployed contract. These
 * prove the sequencing around it: which step is reported, what stops the
 * sequence, and that "we could not build the call" never reads as "the contract
 * refused".
 */

const ORGAN: Bytes32 = bytes32(
  '0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5',
);
/** Doubles as the simulated sender; nothing here distinguishes the two roles. */
const CONTRACT = SAMPLE_MEMBER;

const organs = (overrides: Partial<OrganResolver> = {}): OrganResolver => ({
  resolve: async (triple) => ({ triple, organ: ORGAN, identifier: partyOrganIdentifier(triple) }),
  label: () => undefined,
  tripleOf: () => undefined,
  ...overrides,
});

/** `NotChairman(address)`, as a node would return it. */
const CHAIRMAN_REVERT = Object.assign(new Error('reverted'), {
  name: 'ContractFunctionRevertedError',
  data: encodeErrorResult({ abi: ZARYA_ABI, errorName: 'NotChairman', args: [CONTRACT] }),
});

/**
 * A node that answers each `eth_call` from `answers`, in order. `undefined`
 * means success with no returndata, which is what a `void` write returns.
 */
const stubClient = (answers: readonly (undefined | Error)[] = []) => {
  const calls: { data: string; account: unknown }[] = [];
  const call = vi.fn(async ({ data, account }: { data: string; account?: unknown }) => {
    const answer = answers[calls.length];
    calls.push({ data, account });
    if (answer !== undefined) throw answer;
    return { data: '0x' };
  });
  return { client: { call } as unknown as ZaryaPublicClient, calls };
};

const simulatorWith = (
  answers: readonly (undefined | Error)[] = [],
  resolver: OrganResolver = organs(),
) => {
  const { client, calls } = stubClient(answers);
  return { simulator: new ZaryaCallSimulator(client, CONTRACT, resolver), calls };
};

describe('a one-call intent', () => {
  it('succeeds and reports the call it would have sent', async () => {
    const { simulator, calls } = simulatorWith();
    const result = await simulator.forIntent(INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING, CONTRACT);

    expect(result).toEqual({
      kind: 'WOULD_SUCCEED',
      calls: [
        {
          fn: 'createMembershipVoting',
          organ: INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING.organ,
          member: SAMPLE_MEMBER,
          duration: 86_400,
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it('simulates from the signer, not from the zero address', async () => {
    // Every authorization guard in Zarya tests msg.sender, so a simulation
    // without a sender answers a question about nobody.
    const { simulator, calls } = simulatorWith();
    await simulator.forIntent(INTENT_SAMPLES.CAST_VOTE, CONTRACT);
    expect(calls[0].account).toBe(CONTRACT);
  });

  it('reports a revert as the contract’s decision, naming the step', async () => {
    const { simulator } = simulatorWith([CHAIRMAN_REVERT]);
    const result = await simulator.forIntent(INTENT_SAMPLES.TRANSFER_CHAIRMANSHIP, CONTRACT);

    expect(result).toMatchObject({
      kind: 'FAILED',
      step: 0,
      outcome: { kind: 'REVERTED', name: 'NotChairman' },
    });
  });
});

describe('threshold configuration, which is three calls', () => {
  it('simulates all three in the dispatcher’s order when they pass', async () => {
    const { simulator, calls } = simulatorWith();
    const result = await simulator.forIntent(
      INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS,
      CONTRACT,
    );

    expect(result.kind).toBe('WOULD_SUCCEED');
    expect(result.kind === 'WOULD_SUCCEED' && result.calls.map((call) => call.fn)).toEqual([
      'setMinimumQuorum',
      'setMinimumApprovalPercentage',
      'setMinimumApprovalPercentageBase',
    ]);
    expect(calls).toHaveLength(3);
  });

  it('stops at the first refusal instead of asking about state that will not exist', async () => {
    // All three share onlyChairman, so the remaining two would fail identically
    // and a second round trip buys nothing. What matters is that `step` names
    // the transaction that would actually stop the sequence.
    const { simulator, calls } = simulatorWith([undefined, CHAIRMAN_REVERT]);
    const result = await simulator.forIntent(
      INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS,
      CONTRACT,
    );

    expect(result).toMatchObject({ kind: 'FAILED', step: 1 });
    expect(calls).toHaveLength(2);
  });

  it('sends the three calls sequentially, so the reported step is not a race', async () => {
    const { simulator, calls } = simulatorWith();
    await simulator.forIntent(INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS, CONTRACT);
    // Distinct calldata in the dispatcher's order: three parallel requests could
    // report whichever failed first rather than whichever comes first.
    expect(new Set(calls.map((entry) => entry.data)).size).toBe(3);
  });
});

describe('a call this client could not build', () => {
  it('is NOT_ATTEMPTED, never a verdict about the contract', async () => {
    // The distinction the whole client is built around: an outage must never be
    // reported as something the contract decided.
    const { simulator, calls } = simulatorWith(
      [],
      organs({
        resolve: async () => {
          throw new Error('rpc down');
        },
      }),
    );
    const result = await simulator.forIntent(INTENT_SAMPLES.CREATE_CATEGORY_VOTING, CONTRACT);

    expect(result).toMatchObject({ kind: 'NOT_ATTEMPTED', reason: 'ORGAN_UNREADABLE' });
    expect(calls).toHaveLength(0);
  });
});

describe('what the simulator cannot do', () => {
  it('has no arm that takes calldata', () => {
    // The allow list holds one layer below where anyone would look for it: a
    // simulate(to, data) method would be a hole in it.
    const { simulator } = simulatorWith();
    expect(Object.getOwnPropertyNames(ZaryaCallSimulator.prototype).sort()).toEqual([
      'castVote',
      'constructor',
      'executeVoting',
      'forIntent',
      'simulate',
    ]);
    expect(simulator).not.toHaveProperty('sendTransaction');
  });
});
