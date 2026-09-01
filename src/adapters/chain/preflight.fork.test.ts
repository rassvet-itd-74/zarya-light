import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preflightVote } from '../../app/preflightVote';
import { matrixCoordinate } from '../../domain/matrix/matrix';
import { CHAIRPERSON_ORGAN } from '../../domain/organs/partyOrgan';
import { evmAddress } from '../../domain/primitives';
import {
  categoricalValueWarnings,
  numericalValueWarnings,
} from '../../domain/preflight/applicationPreflight';
import { votingId } from '../../domain/voting/voting';
import { loadConfig } from '../config/appConfig';
import { ZaryaCallSimulator } from './callSimulator';
import { ZaryaMatrixEvents } from './matrixEvents';
import { ZaryaMatrixReader } from './matrixReader';
import { ZaryaOrganResolver } from './organResolver';
import { createZaryaPublicClient } from './publicClient';
import { type AnvilHandle, forkBlockNumber, forkRpcUrl, startAnvil } from './testing/anvil';
import { ZaryaVotingDiscovery } from './votingDiscovery';
import { ZaryaVotingReader } from './votingReader';

/**
 * Preflight and the matrix reads against the real deployed Zarya.
 *
 * The claim under test is not "preflight returns something". It is that the
 * client's prediction **matches what the deployed bytecode does**, including the
 * ordering that a plainer implementation would get wrong: `castVote` checks the
 * voting's organ before it checks the window, so a stranger looking at the
 * deployment's one expired voting is refused for membership, not for the
 * deadline.
 *
 * Every call is `eth_call` against a local fork. Nothing is signed, nothing is
 * broadcast, and `ZaryaCallSimulator` has no path to a transaction at all.
 *
 * Opt-in via `ZARYA_FORK_RPC_URL`; skips and stays green without it.
 */

const RPC_URL = forkRpcUrl();
const CONFIG = loadConfig({ env: {}, appVersion: 'fork-test' }).publicConfig;
const MINUTE = 60_000;

/** Nobody. Not a member of anything, and certainly not the Chairman. */
const STRANGER = evmAddress('0x000000000000000000000000000000000000dEaD');

const VOTING_1 = { id: 1n, createdAtBlock: 11_553_481n } as const;

describe.skipIf(RPC_URL === undefined)('vote preflight against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let dependencies: Parameters<typeof preflightVote>[0];
  let simulator: ZaryaCallSimulator;
  let record: Awaited<ReturnType<ZaryaVotingDiscovery['scan']>>['records'][number];

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    simulator = new ZaryaCallSimulator(client, CONFIG.contractAddress);
    const votings = new ZaryaVotingReader(client, CONFIG.contractAddress);
    dependencies = {
      votings,
      members: votings,
      organs: new ZaryaOrganResolver(client, CONFIG.contractAddress),
      simulator,
    };

    // The record comes from the real creation logs, not from a literal: the
    // governing organ preflight depends on exists only there.
    const window = await new ZaryaVotingDiscovery(client, CONFIG.contractAddress).scan(
      BigInt(CONFIG.deploymentBlock),
      VOTING_1.createdAtBlock,
    );
    record = window.records[0];
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('refuses a stranger for membership, not for the closed window', async () => {
    // The ordering claim, checked against the bytecode. Voting 1 is *both* past
    // its deadline and governed by an organ the stranger is not in, so a
    // preflight that tested the window first would predict VotingNotActive — and
    // the chain would raise NotActiveMember.
    const result = await preflightVote(dependencies, {
      record,
      voter: STRANGER,
      support: true,
    });

    expect(result.verdict).toMatchObject({
      kind: 'BLOCKED',
      blocker: 'NOT_AUTHORIZED',
      predicted: 'NotActiveMember',
    });
    expect(result.source).toBe('SIMULATION');
    // The client reasoned its way to the same answer the bytecode gave.
    expect(result.reasoning.verdict).toMatchObject({ predicted: 'NotActiveMember' });
    expect(result.disagreement).toBeUndefined();
  }, MINUTE);

  it('predicts the same revert the simulation produces, for the voting’s own author', async () => {
    // The author created a membership voting for 74.СОВ, which needs membership
    // of that organ or the chairmanship — so this sender clears the organ guard
    // that stops the stranger, and hits the window instead. Whichever way the
    // deployment's membership actually falls, the client and the bytecode must
    // agree; that agreement is the assertion, not a guess about who this is.
    const result = await preflightVote(dependencies, {
      record,
      voter: record.author,
      support: true,
    });

    expect(result.disagreement).toBeUndefined();
    expect(result.verdict).toMatchObject({
      kind: 'BLOCKED',
      predicted: 'VotingNotActive',
      blocker: 'VOTING_WINDOW_CLOSED',
    });
    expect(result.reasoning.authorization).toEqual({ kind: 'ALLOWED' });
  }, MINUTE);

  it('resolves the Chairperson organ through the contract to answer the Chairman check', async () => {
    // There is no getChairman(). The check is isMember against the organ the
    // contract's own pure helper produces.
    const chairperson = await dependencies.organs.resolve(CHAIRPERSON_ORGAN);
    expect(chairperson.identifier).toBe('ПРЛ');

    expect(await dependencies.members.isMember(chairperson.organ, STRANGER)).toBe(false);
    // Somebody is the Chairman: the constructor seeds one and there is no path
    // that empties the organ.
    expect(await dependencies.members.isMember(chairperson.organ, record.author)).toBe(true);
  }, MINUTE);

  it('simulates executeVoting without signing anything', async () => {
    // Same terminal InsufficientVotes the reader's fork test observes, this time
    // through the simulator port rather than a raw call.
    const result = await simulator.executeVoting(votingId(VOTING_1.id), STRANGER);

    expect(result).toMatchObject({
      kind: 'FAILED',
      outcome: { kind: 'REVERTED', name: 'InsufficientVotes' },
    });
  }, MINUTE);
});

describe.skipIf(RPC_URL === undefined)('matrix reads against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let matrix: ZaryaMatrixReader;
  let events: ZaryaMatrixEvents;

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    matrix = new ZaryaMatrixReader(client, CONFIG.contractAddress);
    events = new ZaryaMatrixEvents(client, CONFIG.contractAddress);
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('reads an untouched cell as unbound rather than as an organ', async () => {
    const at = matrixCoordinate(0n, 0n);

    expect(await matrix.categoricalCell(at)).toEqual({
      binding: { kind: 'UNBOUND' },
      allowedCategories: [],
      sampleLength: 0n,
    });
    expect(await matrix.numericalCell(at)).toEqual({
      binding: { kind: 'UNBOUND' },
      decimals: 0,
      sampleLength: 0n,
    });
  }, MINUTE);

  it('reads unlabelled axes as UNSET, which is an answer and not a failure', async () => {
    expect(await matrix.theme('CATEGORICAL', 0n)).toEqual({ kind: 'UNSET' });
    expect(await matrix.statement('NUMERICAL', 0n)).toEqual({ kind: 'UNSET' });
  }, MINUTE);

  it('warns that a value proposal here would pass and then be unexecutable', async () => {
    // The finding this slice exists for, against real state: nothing on this
    // deployment has a theme, so a value voting created now would be accepted,
    // voted on, approved — and then revert NoThemeSet inside executeVoting,
    // leaving itself unfinalized forever.
    const at = matrixCoordinate(0n, 0n);
    const organ = `0x${'11'.repeat(32)}` as never;

    const numerical = numericalValueWarnings({
      organ,
      theme: await matrix.theme('NUMERICAL', at.x),
      statement: await matrix.statement('NUMERICAL', at.y),
      cell: await matrix.numericalCell(at),
    });
    expect(numerical.map((warning) => warning.code)).toEqual([
      'NO_THEME_AT_COLUMN',
      'NO_STATEMENT_AT_ROW',
    ]);
    expect(numerical[0].predicted).toBe('NoThemeSet');

    const categorical = categoricalValueWarnings({
      organ,
      category: 1n,
      theme: await matrix.theme('CATEGORICAL', at.x),
      statement: await matrix.statement('CATEGORICAL', at.y),
      cell: await matrix.categoricalCell(at),
    });
    // Plus the category, which no cell allows yet.
    expect(categorical.map((warning) => warning.code)).toEqual([
      'NO_THEME_AT_COLUMN',
      'NO_STATEMENT_AT_ROW',
      'CATEGORY_NOT_ALLOWED',
    ]);
  }, MINUTE);

  it('finds no applied matrix change in the whole deployment history', async () => {
    // Consistent with the cell reads above, and it exercises the hand-written
    // ValueAdded fragment against a live provider: a filter built on a wrong
    // topic would return exactly this — nothing — which is why the topic is
    // pinned by hash rather than trusted here.
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    const head = await client.getBlockNumber();

    const window = await events.scan(BigInt(CONFIG.deploymentBlock), head);
    expect(window.changes).toEqual([]);
  }, 2 * MINUTE);
});
