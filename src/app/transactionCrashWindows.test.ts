import { describe, expect, it } from 'vitest';
import { openDatabase } from '../adapters/store/database';
import { SqliteTransactionStore } from '../adapters/store/sqliteTransactionStore';
import { SqliteOperationStore } from '../adapters/store/sqliteOperationStore';
import { INTENT_SAMPLES } from '../domain/intents/testing/intentSamples';
import type { IdGenerator } from '../domain/ports/IdGenerator';
import type { ReceiptReader, TransactionOutcome } from '../domain/ports/ReceiptReader';
import type { Signer, SignedSubmission } from '../domain/ports/Signer';
import type { WriteCallEncoder } from '../domain/ports/WriteCallEncoder';
import { type EvmAddress, type OperationRef, chainId, evmAddress, operationRef } from '../domain/primitives';
import { reconcileTransactions } from './reconcileTransactions';
import { submitOperation } from './submitOperation';

/**
 * The five crash windows `zarya-transactions` requires, against a real database.
 *
 * The state machine and the store have their own tests. What only exists here is
 * whether a process that died at each point can be resolved afterwards — which
 * is a question about the *order* of the writes and about what recovery can
 * prove from what survived.
 */

const SIGNER = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};
const HASH = `0x${'ab'.repeat(32)}` as const;

const signerThat = (
  submit: () => Promise<SignedSubmission>,
  address: EvmAddress = SIGNER,
): Signer => ({
  identity: () => ({ address, chainId: DEPLOYMENT.chainId }),
  submit,
});

const receiptsThat = (
  options: {
    outcome?: TransactionOutcome | undefined;
    pendingNonce?: number | undefined;
  } = {},
): ReceiptReader => ({
  outcome: async () => options.outcome,
  pendingNonce: async () => options.pendingNonce,
});

const encoder: WriteCallEncoder = {
  encode: async () => ({ kind: 'DATA', data: '0xdeadbeef' }),
};

/** Sequential ids, so an assertion can name an attempt. */
const ids = (): IdGenerator => {
  let next = 0;
  return { newOperationRef: () => operationRef(`att-${++next}`) };
};

/** A database with one issued operation, since transactions reference one. */
const fixture = () => {
  const database = openDatabase(':memory:');
  const operations = new SqliteOperationStore(database.db);
  const transactions = new SqliteTransactionStore(database.db);
  const ref = operationRef('zar-op-1') as OperationRef;

  database.db
    .prepare(
      `INSERT INTO operations
         (operation_ref, operation_type, chain_id, contract_address,
          state, bound_values, displayed_context, recorded_at)
       VALUES (?, 'CAST_VOTE', ?, ?, 'EMITTED', '{}', '{}', 1)`,
    )
    .run(ref, DEPLOYMENT.chainId as number, DEPLOYMENT.contractAddress.toLowerCase());

  return { database, operations, transactions, ref };
};

const submitDeps = (signer: Signer, transactions: SqliteTransactionStore) => ({
  signer,
  receipts: receiptsThat(),
  encoder,
  transactions,
  ids: ids(),
  deployment: DEPLOYMENT,
});

const reconcileDeps = (receipts: ReceiptReader, transactions: SqliteTransactionStore) => ({
  receipts,
  transactions,
  deployment: DEPLOYMENT,
  signerAddress: SIGNER,
});

describe('crash window 1 — before signing', () => {
  it('leaves a row that recovery can prove was never sent', async () => {
    const { transactions, ref } = fixture();

    // The signer dies before answering. The row is already durable in `SIGNING`
    // with no nonce, which is the whole point of writing it first.
    const outcome = await submitOperation(
      submitDeps(
        signerThat(async () => {
          throw new Error('the provider did not answer');
        }),
        transactions,
      ),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );
    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'SUBMISSION_FAILED' });

    // Deliberately still in flight: an ambiguous submission must not be called
    // failed by the code that saw the exception.
    const inFlight = await transactions.listInFlight({ ...DEPLOYMENT, signerAddress: SIGNER });
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({ state: 'SIGNING' });
    // Absent keys, not keys holding `undefined`: the record omits what was never
    // learned, which is what makes a missing nonce evidence.
    expect(inFlight[0]).not.toHaveProperty('nonce');
    expect(inFlight[0]).not.toHaveProperty('hash');

    // Recovery closes it, because a missing nonce is evidence rather than an
    // inference — `submitOperation` writes the nonce before the hash.
    const reconciled = await reconcileTransactions(
      reconcileDeps(receiptsThat({ pendingNonce: 5 }), transactions),
    );
    expect(reconciled.resolutions).toEqual([{ kind: 'NEVER_SENT', attemptId: 'att-1' }]);
    expect(reconciled.blocked).toBe(true);
    expect((await transactions.find('att-1'))?.state).toBe('FAILED_RETRYABLE');
  });
});

describe('crash window 3 — after broadcast, before the hash is durable', () => {
  it('reports a spent nonce with no hash as unresolved rather than guessing', async () => {
    const { transactions, ref } = fixture();

    // A signer that names a nonce and then fails, which is exactly the shape of
    // "bytes may have left and the answer never came back".
    await submitOperation(
      submitDeps(
        signerThat(async () => {
          throw new Error('socket hang up');
        }),
        transactions,
      ),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );
    // Put a nonce on it by hand: the real path writes one at `BROADCAST`, and
    // this is the row a crash immediately after that would leave.
    await transactions.advance('att-1', 'BROADCAST', { nonce: 4 });

    const reconciled = await reconcileTransactions(
      // The provider has moved past nonce 4, so something used it — and with no
      // hash this client cannot prove it was this transaction.
      reconcileDeps(receiptsThat({ pendingNonce: 9 }), transactions),
    );

    expect(reconciled.resolutions[0]).toMatchObject({ kind: 'UNRESOLVED' });
    expect(reconciled.blocked).toBe(true);
    // Left in flight on purpose: marking it failed would invite a resend under a
    // nonce that is gone.
    expect((await transactions.find('att-1'))?.state).toBe('BROADCAST');
  });

  it('closes it as never sent when the nonce is still free', async () => {
    const { transactions, ref } = fixture();
    await submitOperation(
      submitDeps(
        signerThat(async () => {
          throw new Error('socket hang up');
        }),
        transactions,
      ),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );
    await transactions.advance('att-1', 'BROADCAST', { nonce: 9 });

    const reconciled = await reconcileTransactions(
      reconcileDeps(receiptsThat({ pendingNonce: 9 }), transactions),
    );

    expect(reconciled.resolutions[0]).toMatchObject({ kind: 'NEVER_SENT' });
    expect((await transactions.find('att-1'))?.state).toBe('FAILED_RETRYABLE');
  });
});

describe('crash windows 4 and 5 — after the hash, and after mining', () => {
  it('keeps waiting while no receipt can be read', async () => {
    const { transactions, ref } = fixture();
    await submitOperation(
      submitDeps(signerThat(async () => ({ hash: HASH, nonce: 1 })), transactions),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );
    expect((await transactions.find('att-1'))?.state).toBe('PENDING');

    // Not mined, or the provider did not answer — the same answer, and neither
    // is a failure. `PENDING` is never `FAILED`.
    const reconciled = await reconcileTransactions(
      reconcileDeps(receiptsThat({ outcome: undefined, pendingNonce: 2 }), transactions),
    );

    expect(reconciled.resolutions[0]).toMatchObject({ kind: 'STILL_PENDING' });
    expect((await transactions.find('att-1'))?.state).toBe('PENDING');
  });

  it('records a revert as a confirmed outcome, not a failure', async () => {
    const { transactions, ref } = fixture();
    await submitOperation(
      submitDeps(signerThat(async () => ({ hash: HASH, nonce: 1 })), transactions),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );

    await reconcileTransactions(
      reconcileDeps(
        receiptsThat({
          outcome: {
            status: 'REVERTED',
            blockNumber: '11642262',
            confirmedAt: 1_788_637_008,
            revertReason: 'InsufficientVotes',
          },
          pendingNonce: 2,
        }),
        transactions,
      ),
    );

    const record = await transactions.find('att-1');
    // A reverted transaction is a confirmed answer. Phase 4's receipt still gets
    // stamped for it, and the form will say `REVERTED`.
    expect(record?.state).toBe('CONFIRMED');
    expect(record?.outcome).toBe('REVERTED');
    expect(record?.failure).toBe('InsufficientVotes');
    expect(record?.blockNumber).toBe('11642262');
    // And the hash survived the transition rather than being overwritten by a
    // transition that learned other things.
    expect(record?.hash).toBe(HASH);
  });
});

describe('the serialization guard', () => {
  it('refuses to send while anything from this wallet is unresolved', async () => {
    const { transactions, ref } = fixture();
    await submitOperation(
      submitDeps(signerThat(async () => ({ hash: HASH, nonce: 1 })), transactions),
      { operationRef: ref, intent: INTENT_SAMPLES.CAST_VOTE },
    );

    const submit = async () => {
      throw new Error('must not be called');
    };
    const second = await submitOperation(submitDeps(signerThat(submit), transactions), {
      operationRef: ref,
      intent: INTENT_SAMPLES.CAST_VOTE,
    });

    // The guard reads the store rather than a flag, because the case it exists
    // for is a previous process that died.
    expect(second).toMatchObject({ kind: 'REFUSED', code: 'WRITES_IN_FLIGHT' });
  });

  it('refuses a signer configured for another chain before anything is written', async () => {
    const { transactions, ref } = fixture();
    const wrongChain: Signer = {
      identity: () => ({ address: SIGNER, chainId: chainId(1) }),
      submit: async () => {
        throw new Error('must not be called');
      },
    };

    const outcome = await submitOperation(submitDeps(wrongChain, transactions), {
      operationRef: ref,
      intent: INTENT_SAMPLES.CAST_VOTE,
    });

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'WRONG_CHAIN' });
    expect(await transactions.listInFlight({ ...DEPLOYMENT, signerAddress: SIGNER })).toEqual([]);
  });
});

describe('a three-transaction operation', () => {
  it('reports what already landed when a later call fails', async () => {
    // `CONFIGURE_ORGAN_THRESHOLDS` expands to three, there is no atomicity
    // across them, and a partial send leaves an organ genuinely part-configured.
    // Calling that "refused" would be false.
    const { transactions, ref } = fixture();
    let sent = 0;

    const outcome = await submitOperation(
      submitDeps(
        signerThat(async () => {
          sent += 1;
          if (sent === 3) throw new Error('provider rejected the third');
          return { hash: HASH, nonce: sent };
        }),
        transactions,
      ),
      { operationRef: ref, intent: INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS },
    );

    expect(outcome.kind).toBe('PARTIALLY_SUBMITTED');
    if (outcome.kind !== 'PARTIALLY_SUBMITTED') return;
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.code).toBe('SUBMISSION_FAILED');
  });
});
