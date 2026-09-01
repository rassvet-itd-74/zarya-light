import { encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTerminal } from '../../domain/chain/contractErrors';
import { CHAIRPERSON_ORGAN, ORGAN_POSTFIX, partyOrganTriple } from '../../domain/organs/partyOrgan';
import { evmAddress } from '../../domain/primitives';
import { planDiscovery } from '../../domain/voting/discoveryPlan';
import { votingId } from '../../domain/voting/voting';
import { classifyVotingPhase, isExecutionDue } from '../../domain/voting/votingLifecycle';
import { loadConfig } from '../config/appConfig';
import { MemoryCursorStore } from '../store/memoryCursorStore';
import { ChainClock } from './chainClock';
import { classifyCallFailure } from './errorDecoder';
import { ZaryaOrganResolver } from './organResolver';
import { createZaryaPublicClient } from './publicClient';
import { type AnvilHandle, forkBlockNumber, forkRpcUrl, startAnvil } from './testing/anvil';
import { ZaryaVotingDiscovery } from './votingDiscovery';
import { ZaryaVotingReader } from './votingReader';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * Voting reads and discovery against the real deployed Zarya.
 *
 * The deployment holds exactly one voting, and it happens to be the most
 * instructive one possible: a membership voting created 2026-08-24 with a
 * 120-second duration, **zero votes cast**, past its deadline and never
 * finalized. That is the "Quorum failure is permanent" case from
 * `CONTRACT_DEFECTS.md`, live — so the terminal classification this client
 * builds its executor on can be checked against the contract rather than
 * inferred from source.
 *
 * Every call here is `eth_call` against the local fork, including the
 * `executeVoting` simulation. Nothing is signed and nothing is broadcast.
 *
 * Opt-in via `ZARYA_FORK_RPC_URL`; skips and stays green without it.
 */

const RPC_URL = forkRpcUrl();
const CONFIG = loadConfig({ env: {}, appVersion: 'fork-test' }).publicConfig;
const MINUTE = 60_000;

const STRANGER = evmAddress('0x000000000000000000000000000000000000dEaD');

/** The one voting on this deployment, as its creation logs report it. */
const VOTING_1 = {
  id: 1n,
  author: '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD',
  createdAtBlock: 11_553_481n,
  startTime: 1_787_530_584,
  endTime: 1_787_530_704,
  /** keccak256("74.СОВ") — the Chelyabinsk regional soviet. */
  organ: '0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5',
} as const;

describe.skipIf(RPC_URL === undefined)('voting reads against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let reader: ZaryaVotingReader;

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    reader = new ZaryaVotingReader(
      createZaryaPublicClient({ rpcUrl: anvil.url }),
      CONFIG.contractAddress,
    );
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('reads the highest issued id, which is the last one and not one past it', async () => {
    // `nextVotingId` pre-increments (Zarya.sol:508), so this value is itself a
    // valid id. Reading it as an exclusive bound would hide the newest voting.
    expect(await reader.highestVotingId()).toBe(VOTING_1.id);
  }, MINUTE);

  it('confirms that id is a real voting and the next one is not', async () => {
    const highest = (await reader.highestVotingId()) as bigint;

    expect(await reader.exists(votingId(highest))).toBe(true);
    // End to end against a real revert: votingExists rejects it, viem surfaces
    // it, revertData separates it from a transport failure, and the registry
    // names it VotingNotFound. Until now that path only saw payloads this
    // repository encoded itself.
    expect(await reader.exists(votingId(highest + 1n))).toBe(false);
  }, MINUTE);

  it('reads the voting as past its deadline and unfinalized', async () => {
    const observations = await reader.observe(votingId(VOTING_1.id));

    expect(observations).toEqual({ active: false, finalized: false });
    expect(classifyVotingPhase(observations)).toBe('AWAITING_EXECUTION');
  }, MINUTE);

  it('reads zero votes, which is what makes it permanently unexecutable', async () => {
    expect(await reader.results(votingId(VOTING_1.id))).toEqual({
      forVotes: 0n,
      againstVotes: 0n,
      totalVotes: 0n,
    });
    expect(await reader.hasVoted(votingId(VOTING_1.id), STRANGER)).toBe(false);
  }, MINUTE);

  it('agrees with chain time that execution is due', async () => {
    const clock = new ChainClock(createZaryaPublicClient({ rpcUrl: anvil.url }));
    const chainTime = await clock.chainTime();

    expect(chainTime).toBeGreaterThan(VOTING_1.endTime);
    expect(
      isExecutionDue(
        {
          votingId: votingId(VOTING_1.id),
          author: evmAddress(VOTING_1.author),
          startTime: VOTING_1.startTime as never,
          endTime: VOTING_1.endTime as never,
          suggestionType: 'Membership',
          governingOrgan: { kind: 'ORGAN', organ: VOTING_1.organ as never },
          blockNumber: VOTING_1.createdAtBlock,
        },
        chainTime,
      ),
    ).toBe(true);
  }, MINUTE);

  it('simulates executeVoting and gets the terminal InsufficientVotes', async () => {
    // The claim the whole executor design rests on, checked against the
    // deployed contract instead of read from source. `eth_call`, no signer, no
    // broadcast — and the voting stays unfinalized, exactly as the defect says.
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    let outcome;
    try {
      await client.call({
        to: CONFIG.contractAddress,
        data: encodeFunctionData({
          abi: ZARYA_ABI,
          functionName: 'executeVoting',
          args: [VOTING_1.id],
        }),
      });
      throw new Error('executeVoting did not revert, which this voting must');
    } catch (error) {
      outcome = classifyCallFailure(error);
    }

    expect(outcome).toMatchObject({ kind: 'REVERTED', name: 'InsufficientVotes' });
    expect(isTerminal(outcome)).toBe(true);

    // And it really is permanent: still unfinalized after the attempt.
    expect(await reader.observe(votingId(VOTING_1.id))).toEqual({
      active: false,
      finalized: false,
    });
  }, MINUTE);

  it('reads membership, and reports a stranger as not a member', async () => {
    // isMember has no existence guard, so an unknown organ is simply empty —
    // `false` is an answer here, not a failure to read.
    const resolver = new ZaryaOrganResolver(
      createZaryaPublicClient({ rpcUrl: anvil.url }),
      CONFIG.contractAddress,
    );
    const chairperson = await resolver.resolve(CHAIRPERSON_ORGAN);
    expect(await reader.isMember(chairperson.organ, STRANGER)).toBe(false);

    const chelyabinskSoviet = await resolver.resolve(
      partyOrganTriple({ organType: 'RegionalSoviet', region: 74 }),
    );
    // The organ this voting is governed by, resolved forward through the
    // contract and matching the hash its creation log carried.
    expect(chelyabinskSoviet.organ).toBe(VOTING_1.organ);
    expect(chelyabinskSoviet.identifier).toBe(`74.${ORGAN_POSTFIX.soviet}`);
    expect(await reader.isMember(chelyabinskSoviet.organ, STRANGER)).toBe(false);
  }, MINUTE);

  it('returns no observations for a voting that does not exist', async () => {
    const highest = (await reader.highestVotingId()) as bigint;
    const observations = await reader.observe(votingId(highest + 1n));

    // Not `false`. "No such voting" and "not active" are different facts, and
    // only UNKNOWN says the first.
    expect(observations).toEqual({ active: undefined, finalized: undefined });
    expect(classifyVotingPhase(observations)).toBe('UNKNOWN');
    expect(await reader.results(votingId(highest + 1n))).toBeUndefined();
  }, MINUTE);
});

describe.skipIf(RPC_URL === undefined)('voting discovery against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let discovery: ZaryaVotingDiscovery;

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    discovery = new ZaryaVotingDiscovery(
      createZaryaPublicClient({ rpcUrl: anvil.url }),
      CONFIG.contractAddress,
    );
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('confirms the configured deployment block is where the code appears', async () => {
    // The default was found by binary search, not transcribed. Code at that
    // block, none in the one before.
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    const deployment = BigInt(CONFIG.deploymentBlock);

    const at = await client.getCode({ address: CONFIG.contractAddress, blockNumber: deployment });
    const before = await client.getCode({
      address: CONFIG.contractAddress,
      blockNumber: deployment - 1n,
    });

    expect(at).not.toBe('0x');
    expect(at).toBeDefined();
    expect(before === undefined || before === '0x').toBe(true);
  }, 2 * MINUTE);

  it('projects the real voting from its real creation logs', async () => {
    // The whole projection end to end: VotingCreated decoded, the detail event
    // joined by votingId, and the organ carried through as a bytes32 the local
    // table can name.
    const window = await discovery.scan(BigInt(CONFIG.deploymentBlock), VOTING_1.createdAtBlock);

    expect(window.records).toHaveLength(1);
    expect(window.records[0]).toEqual({
      votingId: VOTING_1.id,
      author: VOTING_1.author,
      startTime: VOTING_1.startTime,
      endTime: VOTING_1.endTime,
      suggestionType: 'Membership',
      governingOrgan: { kind: 'ORGAN', organ: VOTING_1.organ },
      blockNumber: VOTING_1.createdAtBlock,
    });
    // Both logs landed in the same block, so nothing is missing a detail event.
    expect(window.withoutDetail).toEqual([]);
  }, 2 * MINUTE);

  it('finds nothing in a window that ends before the creation block', async () => {
    // Both logs sit in block 11553481, so no honest window can split them —
    // the UNKNOWN-organ path is covered over synthetic logs instead. What this
    // pins is that a window stopping short finds nothing at all, rather than a
    // half-built record with a missing deadline.
    const window = await discovery.scan(
      BigInt(CONFIG.deploymentBlock),
      VOTING_1.createdAtBlock - 1n,
    );
    expect(window.records).toEqual([]);
  }, 2 * MINUTE);

  it('backfills the whole history in bounded windows without gaps', async () => {
    const client = createZaryaPublicClient({ rpcUrl: anvil.url });
    const head = await client.getBlockNumber();
    const store = new MemoryCursorStore();
    const key = {
      chainId: CONFIG.chainId,
      contractAddress: CONFIG.contractAddress,
      projection: 'votings',
    };

    const found: bigint[] = [];
    let scans = 0;
    let previousTo: bigint | undefined;

    for (; scans < 60; scans += 1) {
      const plan = planDiscovery({
        cursor: await store.read(key),
        headBlock: head,
        deploymentBlock: BigInt(CONFIG.deploymentBlock),
      });
      if (plan.kind !== 'SCAN') break;

      // Contiguity against a live provider, not merely in the abstract.
      if (previousTo !== undefined) expect(plan.fromBlock).toBe(previousTo + 1n);
      previousTo = plan.toBlock;

      const window = await discovery.scan(plan.fromBlock, plan.toBlock);
      found.push(...window.records.map((record) => record.votingId as bigint));
      // The cursor advances only after the window was handled, which is what
      // makes a crash mid-backfill re-scan rather than skip.
      await store.commit(key, plan.toBlock);
    }

    expect(scans).toBeGreaterThan(1);
    // A chunked backfill finds exactly what a single sweep would.
    expect(found).toEqual([VOTING_1.id]);
    expect(
      planDiscovery({
        cursor: await store.read(key),
        headBlock: head,
        deploymentBlock: BigInt(CONFIG.deploymentBlock),
      }).kind,
    ).toBe('UP_TO_DATE');
  }, 5 * MINUTE);
});
