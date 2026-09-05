import { encodeErrorResult, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { evmAddress } from '../../domain/primitives';
import { FULL_ERROR_ABI } from './errorDecoder';
import type { ZaryaPublicClient } from './publicClient';
import { ZaryaReceipts } from './zaryaReceipts';

/**
 * The receipt reader, against a client that answers however the test needs.
 *
 * No network and no fork. What is being tested is not viem — it is this
 * adapter's **refusal to turn an outage into a verdict**, which is a property of
 * the code around the calls and is exercised by making those calls fail.
 *
 * That distinction is the reason the module exists. "Not mined yet" and "the
 * provider is down" arrive at the same catch site and mean the same thing to a
 * caller: keep waiting. "Reverted" means something else entirely and is a final
 * answer. Collapsing the first two into the third is how a `PENDING` row would
 * wrongly become `FAILED` during a provider hiccup, and it is not recoverable
 * afterwards — the queue would have moved on.
 */

const HASH = `0x${'ab'.repeat(32)}` as const;
const SENDER = '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD' as const;
const CONTRACT = '0x6b31cC58a7DC5919f460068cF68D16281F360d25' as const;

/** A viem error shaped the way `readRevert` recognises one. */
const revertWith = (data?: `0x${string}`): Error =>
  Object.assign(new Error('execution reverted'), {
    name: 'ContractFunctionRevertedError',
    ...(data === undefined ? {} : { data }),
  });

interface FakeParts {
  receipt?: unknown;
  block?: unknown;
  transaction?: unknown;
  call?: () => never;
  nonce?: number;
}

/**
 * A client whose every method either answers or throws.
 *
 * Cast rather than implemented: viem's client type is a large inferred surface
 * and this adapter touches five of its methods. Naming those five is the point —
 * a sixth appearing in the adapter shows up here as an undefined call rather
 * than as a silent pass.
 */
const fakeClient = (parts: FakeParts): ZaryaPublicClient =>
  ({
    getTransactionReceipt: async () => {
      if (parts.receipt === undefined) throw new Error('not found');
      return parts.receipt;
    },
    getBlock: async () => {
      if (parts.block === undefined) throw new Error('block unavailable');
      return parts.block;
    },
    getTransaction: async () => {
      if (parts.transaction === undefined) throw new Error('transaction unavailable');
      return parts.transaction;
    },
    call: async () => {
      if (parts.call === undefined) return { data: '0x' };
      return parts.call();
    },
    getTransactionCount: async () => {
      if (parts.nonce === undefined) throw new Error('rpc down');
      return parts.nonce;
    },
  }) as unknown as ZaryaPublicClient;

const minedAt = (blockNumber: bigint, status: 'success' | 'reverted') => ({
  blockNumber,
  status,
});

describe('reading an outcome', () => {
  it('reports a success with its block and the block’s own time', async () => {
    const receipts = new ZaryaReceipts(
      fakeClient({
        receipt: minedAt(11_642_262n, 'success'),
        block: { timestamp: 1_788_637_008n },
      }),
    );

    expect(await receipts.outcome(HASH)).toEqual({
      status: 'SUCCESS',
      // A decimal string, not a bigint: records are text, and a bigint cannot
      // cross structured-clone IPC in this application at all.
      blockNumber: '11642262',
      confirmedAt: 1_788_637_008,
    });
  });

  it('answers undefined for a transaction the node has never heard of', async () => {
    // The normal state of something still in a mempool. viem throws for it, and
    // an adapter that let that escape would make every pending transaction an
    // error the first time it was polled.
    const receipts = new ZaryaReceipts(fakeClient({}));
    expect(await receipts.outcome(HASH)).toBeUndefined();
  });

  it('answers undefined when the confirming block cannot be read', async () => {
    // The receipt arrived and the block did not. Returning the outcome without a
    // time would store a confirmed attempt with no `confirmed_at`, and stamping
    // would then have nowhere to get a date but a workstation clock — which is
    // exactly what the receipt invariant forbids. Refusing keeps the row PENDING
    // and retryable.
    const receipts = new ZaryaReceipts(
      fakeClient({ receipt: minedAt(11_642_262n, 'success') }),
    );
    expect(await receipts.outcome(HASH)).toBeUndefined();
  });

  it('never invents a time of its own', async () => {
    // The stronger form of the check above: whatever the block says is what is
    // reported, including a timestamp that is nowhere near now.
    const receipts = new ZaryaReceipts(
      fakeClient({ receipt: minedAt(1n, 'success'), block: { timestamp: 0n } }),
    );
    expect(await receipts.outcome(HASH)).toMatchObject({ confirmedAt: 0 });
  });
});

describe('a revert is an answer, not a failure', () => {
  const reverted = (parts: FakeParts) =>
    new ZaryaReceipts(
      fakeClient({
        receipt: minedAt(11_642_262n, 'reverted'),
        block: { timestamp: 1_788_637_008n },
        transaction: { from: SENDER, to: CONTRACT, input: '0xdeadbeef' },
        ...parts,
      }),
    );

  it('reports REVERTED with the decoded reason when the replay yields one', async () => {
    // A receipt carries no revert data, so the reason is recovered by replaying
    // the call at the block it was mined in. `InsufficientVotes` is the one that
    // matters most: it is terminal, never retryable, and the executor has to be
    // able to tell it apart from a transient failure.
    // Two arguments — the votes cast and the quorum required. Encoded with them
    // because a selector alone would not decode, which is the same reason the
    // reason is absent when a payload is truncated.
    const data = encodeErrorResult({
      abi: FULL_ERROR_ABI,
      errorName: 'InsufficientVotes',
      args: [0n, 1n],
    });
    const receipts = reverted({
      call: () => {
        throw revertWith(data);
      },
    });

    expect(await receipts.outcome(HASH)).toEqual({
      status: 'REVERTED',
      blockNumber: '11642262',
      confirmedAt: 1_788_637_008,
      revertReason: 'InsufficientVotes',
    });
  });

  it('still reports REVERTED when the reason cannot be recovered', async () => {
    // Public endpoints often do not keep the state needed to replay. The
    // transaction still reverted; only the reason is unknown. Absent means
    // "reason unknown" and never "did not revert" — the distinction the outcome
    // type's own comment insists on.
    const receipts = reverted({ transaction: undefined });
    expect(await receipts.outcome(HASH)).toEqual({
      status: 'REVERTED',
      blockNumber: '11642262',
      confirmedAt: 1_788_637_008,
    });
  });

  it('omits the reason for a bare revert with no payload', async () => {
    const receipts = reverted({
      call: () => {
        throw revertWith();
      },
    });
    expect(await receipts.outcome(HASH)).not.toHaveProperty('revertReason');
  });

  it('omits the reason for a selector this client does not know', async () => {
    // An undecodable selector is a statement about this client's error registry,
    // not about the contract. Reporting the raw selector would put something in
    // front of a member that they cannot act on and that looks like a diagnosis.
    const receipts = reverted({
      call: () => {
        throw revertWith(toFunctionSelector('SomethingElseEntirely(uint256)'));
      },
    });
    expect(await receipts.outcome(HASH)).not.toHaveProperty('revertReason');
  });

  it('concludes nothing when the replay does not revert at all', async () => {
    // The state at that block differs from what the transaction saw. Nothing can
    // be said about why it failed, so nothing is said.
    const receipts = reverted({});
    expect(await receipts.outcome(HASH)).not.toHaveProperty('revertReason');
  });

  it('does not mistake a transport failure for an empty revert', async () => {
    // A timeout during the replay is not evidence about the contract. It reaches
    // the same place as a bare revert and produces the same absent reason — the
    // safe direction, and worth pinning because the opposite would report a
    // network outage as a governance verdict.
    const receipts = reverted({
      call: () => {
        throw new Error('socket hang up');
      },
    });
    expect(await receipts.outcome(HASH)).toMatchObject({ status: 'REVERTED' });
  });
});

describe('the pending nonce', () => {
  it('counts what is already in the mempool', async () => {
    // `pending`, not `latest`. Counting only mined transactions would hand out a
    // nonce already taken by something this client sent moments ago.
    const receipts = new ZaryaReceipts(fakeClient({ nonce: 7 }));
    expect(await receipts.pendingNonce(evmAddress(SENDER))).toBe(7);
  });

  it('answers undefined rather than zero when the provider is unreachable', async () => {
    // Zero is a real nonce — the first one an address ever uses. Returning it for
    // "could not read" would tell recovery that nothing has ever been sent from
    // this wallet, which is the most destructive possible wrong answer here.
    const receipts = new ZaryaReceipts(fakeClient({}));
    expect(await receipts.pendingNonce(evmAddress(SENDER))).toBeUndefined();
  });
});
