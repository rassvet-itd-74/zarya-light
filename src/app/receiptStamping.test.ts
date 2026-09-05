import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormTemplateWriter } from '../adapters/forms/formTemplateWriter';
import type { TemplateAssets } from '../adapters/forms/issueTemplate';
import { RECEIPT_FIELDS } from '../adapters/forms/formSchema';
import { parseFormFields } from '../adapters/forms/pdfFormParser';
import { PdfReceiptStamper, type ReceiptAssets } from '../adapters/forms/stampReceipt';
import { asGlyphs, drawnContent } from '../adapters/forms/testing/drawnText';
import { fillIssuedForm } from '../adapters/forms/testing/pdfFixtures';
import { CryptoIdGenerator } from '../adapters/platform/cryptoIdGenerator';
import { openDatabase } from '../adapters/store/database';
import { SqliteOperationStore } from '../adapters/store/sqliteOperationStore';
import { SqliteTransactionStore } from '../adapters/store/sqliteTransactionStore';
import { partyOrganTriple } from '../domain/organs/partyOrgan';
import type { FileSink } from '../domain/ports/FileSink';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import { type OperationRef, bytes32, chainId, evmAddress } from '../domain/primitives';
import { issueOperationTemplate } from './issueOperationTemplate';
import { stampOperationReceipt } from './stampOperationReceipt';

/**
 * Stamping, end to end from a real issued form.
 *
 * The rules under test are the ones a printed document makes irreversible: it is
 * stamped on **confirmation** and never on sending, a revert is still stamped,
 * and the result is reproducible from stored state with no chain access.
 */

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};
const SIGNER = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const HASH = `0x${'ab'.repeat(32)}` as const;
const CONFIRMED_AT = 1_788_637_008;

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

const STAMP_ASSETS: ReceiptAssets = {
  fontRegular: ASSETS.fontRegular,
  fontBold: ASSETS.fontBold,
  stampSvg: readFileSync('src/assets/receipt-stamp.svg'),
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

/**
 * An operation with a returned form stored and one transaction attempt.
 *
 * Built through the real issuer and the real stores, because what is being
 * tested is that stamping works from what those two actually persist.
 */
const fixture = async (
  attemptState: { outcome?: string; confirmedAt?: number; confirm: boolean } = {
    confirm: true,
  },
) => {
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
  await operations.recordReturn({ operationRef: ref, identityKey: 'k', formBytes: filled });

  await transactions.open({
    attemptId: 'att-1',
    operationRef: ref,
    chainId: DEPLOYMENT.chainId,
    contractAddress: DEPLOYMENT.contractAddress,
    signerAddress: SIGNER,
    data: '0xdeadbeef',
  });
  await transactions.advance('att-1', 'SIGNING');
  await transactions.advance('att-1', 'BROADCAST', { nonce: 3 });
  await transactions.advance('att-1', 'PENDING', { hash: HASH });
  if (attemptState.confirm) {
    await transactions.advance('att-1', 'CONFIRMED', {
      blockNumber: '11642262',
      confirmedAt: attemptState.confirmedAt ?? CONFIRMED_AT,
      outcome: attemptState.outcome ?? 'SUCCESS',
    });
  }

  const stamped = capturingSink();
  return {
    ref,
    deps: {
      operations,
      transactions,
      receipts: new PdfReceiptStamper(STAMP_ASSETS),
      files: stamped,
    },
    stamped,
  };
};

describe('stamping a receipt', () => {
  it('states every fact from the transaction record and flattens the form', async () => {
    const { ref, deps, stamped } = await fixture();

    const outcome = await stampOperationReceipt(deps, {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    expect(outcome).toMatchObject({ kind: 'STAMPED', status: 'SUCCESS', factCount: 6 });

    // Flattened, so the result carries no readable field — which is what stops a
    // receipt re-entering the pipeline as a form.
    //
    // `FLATTENED` rather than `NOT_A_FORM`: pdf-lib's `flatten()` leaves the
    // AcroForm dictionary in place with no fields under it, which is the shape
    // the parser already names. Either refusal would do; this one is the more
    // accurate description of the file.
    const parsed = await parseFormFields(stamped.bytes());
    expect(parsed.kind).toBe('REJECTED');
    if (parsed.kind !== 'REJECTED') return;
    expect(parsed.rejections[0]?.code).toBe('FLATTENED');
  });

  it('refuses to stamp a transaction that has not confirmed', async () => {
    // Hard rule 5. A form stamped for something still in a mempool becomes a
    // false record the moment it is printed, and a printed record cannot be
    // recalled.
    const { ref, deps } = await fixture({ confirm: false });

    const outcome = await stampOperationReceipt(deps, {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'NOT_CONFIRMED' });
  });

  it('stamps a reverted transaction, because it confirmed', async () => {
    // The absence of a receipt means "outcome unknown". Refusing to stamp a
    // revert would make that absence a lie about something that definitely
    // happened.
    const { ref, deps } = await fixture({ confirm: true, outcome: 'REVERTED' });

    const outcome = await stampOperationReceipt(deps, {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    expect(outcome).toMatchObject({ kind: 'STAMPED', status: 'REVERTED' });
  });

  it('is re-runnable and byte-identical, with no chain access', async () => {
    // A receipt is a rendering, not a record: a lost file is regenerated from
    // the stored form plus the transaction record. Nothing in `deps` can reach a
    // chain — there is no reader and no clock in the dependency list at all.
    const { ref, deps, stamped } = await fixture();
    const request = {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    };

    await stampOperationReceipt(deps, request);
    const first = Buffer.from(stamped.bytes());
    await stampOperationReceipt(deps, request);
    const second = Buffer.from(stamped.bytes());

    expect(second.equals(first)).toBe(true);
  });

  it('draws every fact onto the page, where a flattened form has no fields left', async () => {
    // The check the whole redesign turns on. The facts used to be field values,
    // which a test could read back by name; they are ink now, so this looks for
    // them in glyph space in the page's content stream. A fact that silently
    // stopped being drawn would otherwise leave nothing behind to miss it.
    const { ref, deps, stamped } = await fixture();
    await stampOperationReceipt(deps, {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    // The signer is read back from the store rather than compared against the
    // literal above: glyph ids are case-sensitive, so the assertion has to be
    // about the exact characters the stamper was handed.
    const attempt = await deps.transactions.find('att-1');
    const drawn = await drawnContent(stamped.bytes());
    for (const fact of [HASH, attempt?.signerAddress ?? '', '11642262', 'SUCCESS']) {
      expect(drawn, fact).toContain(asGlyphs(fact, ASSETS.fontRegular));
    }
    // And the chain's own time, never the workstation's — the block timestamp
    // stored with the attempt, rendered as an instant.
    const chainTime = new Date(CONFIRMED_AT * 1000).toISOString().slice(0, 10);
    expect(drawn).toContain(asGlyphs(chainTime, ASSETS.fontRegular));
  });

  it('refuses an attempt belonging to a different operation', async () => {
    const { deps } = await fixture();

    const outcome = await stampOperationReceipt(deps, {
      operationRef: 'zar-someone-else' as OperationRef,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'ATTEMPT_MISMATCH' });
  });

  it('names every fact it drew, and they are exactly the schema’s', async () => {
    const { ref, deps } = await fixture();
    await stampOperationReceipt(deps, {
      operationRef: ref,
      attemptId: 'att-1',
      targetPath: 'C:/receipt.pdf',
    });

    const stamper = new PdfReceiptStamper(STAMP_ASSETS);
    const form = await deps.operations.formBytes(ref);
    const result = await stamper.stamp(form as Uint8Array, {
      txHash: HASH,
      status: 'SUCCESS',
      blockNumber: '11642262',
      chainId: DEPLOYMENT.chainId,
      confirmedAt: CONFIRMED_AT as never,
      signer: SIGNER,
    });

    expect([...result.drawnFacts].sort()).toEqual([...Object.values(RECEIPT_FIELDS)].sort());
  });
});
