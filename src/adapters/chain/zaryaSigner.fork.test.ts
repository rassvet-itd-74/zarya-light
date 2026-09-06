import { encodeFunctionData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/appConfig';
import { evmAddress } from '../../domain/primitives';
import { createZaryaPublicClient } from './publicClient';
import { type AnvilHandle, forkBlockNumber, forkRpcUrl, startAnvil } from './testing/anvil';
import { ZARYA_ABI } from './zaryaAbi';
import { ZaryaReceipts } from './zaryaReceipts';
import { PrivateKeySigner } from './zaryaSigner';

/**
 * The signer, and the only way it can honestly be tested: by signing.
 *
 * **This is the first test in the repository that sends a transaction.** Every
 * other `*.fork.test.ts` says "nothing here signs or broadcasts", and that stays
 * true of them. It cannot stay true here — nonce assignment, hash derivation and
 * the ambiguity of a failed send are properties of a real node's response, and a
 * fake provider would only prove that a fake was consulted.
 *
 * What that does and does not mean:
 *
 * - Everything happens against a **local anvil** forking Sepolia. The live
 *   network is read once, at fork time, exactly as every other fork test reads
 *   it. Nothing reaches Sepolia, no funds move anywhere real, and the fork state
 *   is discarded when the process exits.
 * - The key is **anvil's first published development account**, printed by the
 *   tool at every startup and funded only on a local node.
 * - It is opt-in. Without `ZARYA_FORK_RPC_URL` these skip, and `npm test` stays
 *   green offline.
 *
 * Hard rule 1 forbids broadcasting to a network without being asked. A local
 * fork is not a network, and this is the sanctioned harness in `zarya-testing` —
 * but the distinction is worth stating rather than assuming, because it is the
 * one that stops being true if anyone ever points `ZARYA_FORK_RPC_URL` at a node
 * that forwards writes.
 */

const RPC_URL = forkRpcUrl();
const CONTRACT = loadConfig({ env: {}, appVersion: 'fork-test' }).publicConfig.contractAddress;

/** anvil account #0. Published in every Foundry tutorial; funded only locally. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

/** Somewhere to send that certainly holds no code, so a transfer just succeeds. */
const SINK = evmAddress('0x000000000000000000000000000000000000dEaD');

const MINUTE = 60_000;

describe.skipIf(RPC_URL === undefined)('the signer against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let signer: PrivateKeySigner;
  let receipts: ZaryaReceipts;

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    signer = new PrivateKeySigner(ANVIL_KEY, anvil.url);
    receipts = new ZaryaReceipts(createZaryaPublicClient({ rpcUrl: anvil.url }));
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('reports the chain it is pointed at, and it is Sepolia', () => {
    // The fork keeps the upstream chain id, so this is also a check that the
    // harness is forking what it claims to be forking.
    expect(signer.identity().chainId).toBe(11155111);
  });

  it('returns a real hash and the nonce the provider actually used', async () => {
    const before = await receipts.pendingNonce(signer.identity().address);
    const submission = await signer.submit({ to: SINK, data: '0x' });

    expect(submission.hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Read back, not assumed. A nonce this client picked and the provider
    // replaced would leave a record describing a transaction that does not
    // exist, which is the one thing recovery cannot survive.
    expect(submission.nonce).toBe(before);
  });

  it('produces a receipt the reader can resolve, with the block’s own time', async () => {
    const submission = await signer.submit({ to: SINK, data: '0x' });
    // Polled rather than read once. `outcome` answers `undefined` for a read it
    // could not complete as well as for one that is not mined yet — that is the
    // adapter's whole contract — so a single read makes this assertion
    // load-sensitive. It failed exactly that way under a full parallel suite
    // while passing alone. Reconciliation polls for the same reason.
    let outcome;
    for (let attempt = 0; attempt < 20 && outcome === undefined; attempt += 1) {
      outcome = await receipts.outcome(submission.hash);
      if (outcome === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(outcome).toMatchObject({ status: 'SUCCESS' });
    expect(Number(outcome?.blockNumber)).toBeGreaterThan(0);
    // A real Sepolia block timestamp, in seconds — not milliseconds, and not the
    // workstation clock. This is the value a receipt is later stamped with.
    expect(outcome?.confirmedAt).toBeGreaterThan(1_700_000_000);
    expect(outcome?.confirmedAt).toBeLessThan(4_000_000_000);
  });

  it('advances the nonce by exactly one per send', async () => {
    // Hard rule 8: one wallet, one serialized write queue. Two sends in
    // sequence must not collide, and the second must not reuse the first's
    // nonce — which is what a `latest` rather than `pending` read would cause.
    const first = await signer.submit({ to: SINK, data: '0x' });
    const second = await signer.submit({ to: SINK, data: '0x' });

    expect(second.nonce).toBe(first.nonce + 1);
    expect(await receipts.pendingNonce(signer.identity().address)).toBe(second.nonce + 1);
  });

  it('throws without consuming a nonce when the call would revert', async () => {
    // `castVote` on a voting that does not exist. viem estimates gas before
    // sending, so this fails *before* anything is signed — and the nonce is
    // therefore still free.
    //
    // That is precisely what makes recovery by nonce sound: `reconcileTransactions`
    // treats a free nonce as proof that nothing was sent. Asserting it here is
    // asserting the premise that reasoning rests on, against a real node rather
    // than against a comment.
    const data = encodeFunctionData({
      abi: ZARYA_ABI,
      functionName: 'castVote',
      args: [999_999_999n, true],
    });
    const before = await receipts.pendingNonce(signer.identity().address);

    await expect(signer.submit({ to: CONTRACT, data })).rejects.toThrow();

    expect(await receipts.pendingNonce(signer.identity().address)).toBe(before);
  });

  it('answers undefined for a hash the node has never seen', async () => {
    // The normal state of something still in a mempool, against a real node
    // rather than a fake that was told to throw.
    expect(await receipts.outcome(`0x${'ab'.repeat(32)}`)).toBeUndefined();
  });
});
