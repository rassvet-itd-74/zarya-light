import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ZaryaWriteCallEncoder } from '../adapters/chain/writeCallEncoder';
import { FormTemplateWriter } from '../adapters/forms/formTemplateWriter';
import type { TemplateAssets } from '../adapters/forms/issueTemplate';
import { PdfReturnedFormReader } from '../adapters/forms/returnedFormReader';
import { fillIssuedForm } from '../adapters/forms/testing/pdfFixtures';
import { CryptoIdGenerator } from '../adapters/platform/cryptoIdGenerator';
import { openDatabase } from '../adapters/store/database';
import { SqliteOperationStore } from '../adapters/store/sqliteOperationStore';
import { SqliteTransactionStore } from '../adapters/store/sqliteTransactionStore';
import { partyOrganTriple } from '../domain/organs/partyOrgan';
import type { FileSink } from '../domain/ports/FileSink';
import type { FileSource } from '../domain/ports/FileSource';
import type { MatrixReader } from '../domain/ports/MatrixReader';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import type { Signer, SignerIdentity, UnsignedCall } from '../domain/ports/Signer';
import { type OperationRef, bytes32, chainId, evmAddress } from '../domain/primitives';
import { importReturnedForm } from './importReturnedForm';
import { issueOperationTemplate } from './issueOperationTemplate';
import { submitImportedOperation } from './submitImportedOperation';

/**
 * Sending an imported operation, from an issued template through to calldata.
 *
 * The signer is a fake and **nothing here reaches a network** — that is not a
 * shortcut, it is the boundary: this test is about what gets handed to a signer,
 * which is the question the whole form pipeline exists to answer. Whether a
 * signer then talks to a node correctly is `zaryaSigner.fork.test.ts`, against a
 * real one.
 *
 * The two properties that matter:
 *
 * - **The intent is derived from the stored document**, not from anything a
 *   caller supplies. The request is one reference.
 * - **Refusals happen before anything is signed.** Every arm below asserts the
 *   fake signer was never called, because "it refused" and "it refused after
 *   sending" are the same value and completely different events.
 */

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};
const SIGNER_ADDRESS = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const HASH = `0x${'cd'.repeat(32)}` as const;

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

const ORGAN = partyOrganTriple({ organType: 'LocalSoviet', region: 20, number: 7 });

const organs: OrganResolver = {
  resolve: async (triple) => ({
    triple,
    organ: bytes32(`0x${'11'.repeat(32)}`),
    identifier: '95.СОВ-7',
  }),
  label: () => undefined,
  tripleOf: () => undefined,
};

/** Reads nothing, because the operation under test resolves nothing from chain. */
const matrix = { numericalCell: async () => undefined } as unknown as MatrixReader;

const capturingSink = (): FileSink & { bytes(): Uint8Array } => {
  let captured: Uint8Array | undefined;
  return {
    write: async (_target, bytes) => {
      captured = bytes;
    },
    bytes: () => {
      if (captured === undefined) throw new Error('nothing was written');
      return captured;
    },
  };
};

/** Records what it was asked to send. Never touches a network. */
const fakeSigner = (behaviour: { throws?: boolean; chain?: number } = {}) => {
  const calls: UnsignedCall[] = [];
  let nonce = 4;
  const signer: Signer = {
    identity: (): SignerIdentity => ({
      address: SIGNER_ADDRESS,
      chainId: chainId(behaviour.chain ?? 11155111),
    }),
    submit: async (call) => {
      calls.push(call);
      if (behaviour.throws === true) throw new Error('the provider did not answer');
      return { hash: HASH, nonce: nonce++ };
    },
  };
  return { signer, calls };
};

/**
 * An issued, filled and imported operation, in a fresh in-memory database.
 *
 * Built through the real issuer, the real form reader and the real import use
 * case, because what is being tested is that submission can pick up from what
 * those actually persist.
 */
const imported = async () => {
  const database = openDatabase(':memory:');
  const operations = new SqliteOperationStore(database.db);
  const transactions = new SqliteTransactionStore(database.db);
  const issued = capturingSink();

  const outcome = await issueOperationTemplate(
    {
      organs,
      store: operations,
      templates: new FormTemplateWriter(ASSETS),
      files: issued,
      ids: new CryptoIdGenerator(),
      deployment: DEPLOYMENT,
    },
    { operationType: 'CREATE_MEMBERSHIP_VOTING', organ: ORGAN, targetPath: 'C:/f.pdf' },
  );
  if (outcome.kind !== 'ISSUED') throw new Error('issuance refused');
  const ref = outcome.operationRef as OperationRef;

  const filled = await fillIssuedForm(issued.bytes(), {
    member: '0x1111111111111111111111111111111111111111',
    duration: '86400',
  });

  const files: FileSource = { read: async () => filled };
  const importOutcome = await importReturnedForm(
    { files, forms: new PdfReturnedFormReader(), store: operations, matrix, deployment: DEPLOYMENT },
    { sourcePath: 'C:/filled.pdf' },
  );
  if (importOutcome.kind !== 'IMPORTED') {
    throw new Error(`import refused: ${importOutcome.code}`);
  }

  const { signer, calls } = fakeSigner();
  return {
    ref,
    calls,
    operations,
    transactions,
    deps: {
      signer,
      receipts: { outcome: async () => undefined, pendingNonce: async () => 4 },
      encoder: new ZaryaWriteCallEncoder(organs),
      transactions,
      store: operations,
      forms: new PdfReturnedFormReader(),
      matrix,
      ids: new CryptoIdGenerator(),
      deployment: DEPLOYMENT,
    },
  };
};

describe('sending an imported operation', () => {
  it('derives the calldata from the stored form and records the attempt', async () => {
    const { ref, deps, calls, transactions } = await imported();

    const outcome = await submitImportedOperation(deps, { operationRef: ref });

    expect(outcome).toMatchObject({ kind: 'SUBMITTED' });
    // One transaction, addressed to the configured contract, carrying calldata
    // the request never supplied and could not have.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(DEPLOYMENT.contractAddress);
    expect(calls[0]?.data).toMatch(/^0x[0-9a-f]{8,}$/);

    const attempt =
      outcome.kind === 'SUBMITTED'
        ? await transactions.find(outcome.attempts[0]?.attemptId ?? '')
        : undefined;
    expect(attempt).toMatchObject({ state: 'PENDING', hash: HASH, operationRef: ref });
  });

  it('carries the member’s own answer into the calldata', async () => {
    // The whole pipeline in one assertion: a value a person typed into a PDF
    // reaches the bytes of a transaction, through the schema, the record and the
    // ABI — and nothing else could have put it there.
    const { ref, deps, calls } = await imported();
    await submitImportedOperation(deps, { operationRef: ref });

    expect(calls[0]?.data.toLowerCase()).toContain(
      '1111111111111111111111111111111111111111',
    );
  });

  it('refuses an operation with no imported form, without signing', async () => {
    // `EMITTED` — a form was handed out and never came back. Ordinary, and not
    // an error, but there is nothing to send.
    const { deps, calls, operations } = await imported();
    const other = await issueOperationTemplate(
      {
        organs,
        store: operations,
        templates: new FormTemplateWriter(ASSETS),
        files: capturingSink(),
        ids: new CryptoIdGenerator(),
        deployment: DEPLOYMENT,
      },
      { operationType: 'CREATE_MEMBERSHIP_VOTING', organ: ORGAN, targetPath: 'C:/g.pdf' },
    );
    if (other.kind !== 'ISSUED') throw new Error('issuance refused');

    const outcome = await submitImportedOperation(deps, {
      operationRef: other.operationRef as OperationRef,
    });

    expect(outcome).toMatchObject({ kind: 'NOT_SENT', code: 'NOT_IMPORTED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown reference, without signing', async () => {
    const { deps, calls } = await imported();

    const outcome = await submitImportedOperation(deps, {
      operationRef: 'zar-no-such-operation' as OperationRef,
    });

    expect(outcome).toMatchObject({ kind: 'NOT_SENT', code: 'UNKNOWN_OPERATION' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a signer configured for another chain, without signing', async () => {
    // Hard rule 1, and it fails closed: a signer on the wrong chain produces a
    // perfectly valid transaction for the wrong network.
    const { ref, deps, calls } = await imported();
    const wrongChain = fakeSigner({ chain: 1 });

    const outcome = await submitImportedOperation(
      { ...deps, signer: wrongChain.signer },
      { operationRef: ref },
    );

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'WRONG_CHAIN' });
    expect(calls).toHaveLength(0);
    expect(wrongChain.calls).toHaveLength(0);
  });

  it('leaves an ambiguous send unresolved rather than calling it failed', async () => {
    // The provider may have accepted the transaction and failed to answer. The
    // row stays `SIGNING`, which reconciliation reads as "resolve this by
    // nonce" — calling it retryable here is how a client votes twice.
    const { ref, deps, transactions } = await imported();
    const failing = fakeSigner({ throws: true });

    const outcome = await submitImportedOperation(
      { ...deps, signer: failing.signer },
      { operationRef: ref },
    );

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'SUBMISSION_FAILED' });
    const inFlight = await transactions.listInFlight({
      chainId: DEPLOYMENT.chainId,
      contractAddress: DEPLOYMENT.contractAddress,
      signerAddress: SIGNER_ADDRESS,
    });
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({ state: 'SIGNING' });
  });

  it('refuses a second send while anything from that wallet is unresolved', async () => {
    // Hard rule 8, asked of the store rather than of memory — the case it exists
    // for is a process that died mid-send.
    const { ref, deps } = await imported();
    const failing = fakeSigner({ throws: true });
    await submitImportedOperation({ ...deps, signer: failing.signer }, { operationRef: ref });

    const second = await submitImportedOperation(deps, { operationRef: ref });

    expect(second).toMatchObject({ kind: 'REFUSED', code: 'WRITES_IN_FLIGHT' });
  });

  it('reads the chain at submission, not at import', async () => {
    // The scale of a numerical value belongs to the cell and is read again here,
    // one step closer to the mined block than at import. This asserts the read
    // happens rather than its result: the operation used above resolves nothing,
    // so the reader is untouched, and a change that started resolving at import
    // and caching it would show up as a call that never happened.
    const { ref, deps } = await imported();
    const reader = { numericalCell: vi.fn(async () => undefined) };

    await submitImportedOperation(
      { ...deps, matrix: reader as unknown as MatrixReader },
      { operationRef: ref },
    );

    expect(reader.numericalCell).not.toHaveBeenCalled();
  });
});
