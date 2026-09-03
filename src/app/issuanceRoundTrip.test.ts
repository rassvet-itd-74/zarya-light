import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormTemplateWriter } from '../adapters/forms/formTemplateWriter';
import { assembleFormInput } from '../adapters/forms/assembleFormInput';
import { bindOperation } from '../adapters/forms/boundOperation';
import type { TemplateAssets } from '../adapters/forms/issueTemplate';
import { parseFormFields } from '../adapters/forms/pdfFormParser';
import { fillIssuedForm } from '../adapters/forms/testing/pdfFixtures';
import { CryptoIdGenerator } from '../adapters/platform/cryptoIdGenerator';
import { openDatabase } from '../adapters/store/database';
import { SqliteOperationStore } from '../adapters/store/sqliteOperationStore';
import { buildIntent } from '../domain/intents/buildIntent';
import { partyOrganTriple } from '../domain/organs/partyOrgan';
import type { FileSink } from '../domain/ports/FileSink';
import { type OperationRef, bytes32, chainId, evmAddress } from '../domain/primitives';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import { issueOperationTemplate } from './issueOperationTemplate';

/**
 * The loop closed through the **application**, not through fixtures.
 *
 * Every piece of this already had tests and every piece was reachable only from
 * them. `formRoundTrip.test.ts` proves a filled PDF becomes the right intent, but
 * its bytes come from a test fixture that writes field names, and its operation
 * record is an object a test invented. Its own header says so: *"What is still
 * missing is the issuer."*
 *
 * This is the issuer. A real `operationRef` from the real generator, a real row
 * in a real SQLite database, a real PDF from the real template writer, parsed by
 * the real parser and bound back to the row it was recorded under. The only fakes
 * are the two things that would otherwise need a chain and a disk: the organ
 * resolver and the file sink.
 *
 * What it catches that no component test could: a record whose `boundValues` are
 * shaped differently from what `buildIntent`'s reader asks for. Both halves look
 * correct alone — the writer writes a subject code, the reader reads a subject
 * code — and only meeting in the middle shows whether they agree on *which keys*.
 */

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

/** Chechnya: ordinal 20, subject code 95 — the pair that differs. */
const ORGAN = partyOrganTriple({ organType: 'LocalSoviet', region: 20, number: 7 });

/**
 * Stands in for the chain. The identifier is what the contract would render,
 * because that is what a document must print — a locally composed one is exactly
 * what `resolve` exists to verify against.
 */
const organs: OrganResolver = {
  resolve: async (triple) => ({
    triple,
    organ: bytes32(`0x${'11'.repeat(32)}`),
    identifier: '95.СОВ-7',
  }),
  label: () => undefined,
  tripleOf: () => undefined,
};

/** Captures the bytes instead of touching a disk. */
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

const issue = async (
  operationType: 'CREATE_MEMBERSHIP_VOTING' | 'CAST_VOTE',
  extra: { votingId?: string } = {},
) => {
  const database = openDatabase(':memory:');
  const store = new SqliteOperationStore(database.db);
  const files = capturingSink();

  const outcome = await issueOperationTemplate(
    {
      organs,
      store,
      templates: new FormTemplateWriter(ASSETS),
      files,
      ids: new CryptoIdGenerator(),
      deployment: DEPLOYMENT,
    },
    {
      operationType,
      ...(operationType === 'CAST_VOTE' ? {} : { organ: ORGAN }),
      ...extra,
      targetPath: '/tmp/unused.pdf',
    },
  );

  if (outcome.kind !== 'ISSUED') {
    throw new Error(`issuance refused: ${outcome.code} ${outcome.message}`);
  }
  return { outcome, store, database, bytes: files.bytes() };
};

describe('a form this application issued, imported back', () => {
  it('resolves to its own row and becomes the intent it was issued for', async () => {
    const { outcome, store, database, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');

    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });

    const parsed = await parseFormFields(filled);
    expect(parsed.kind).toBe('FIELDS');
    if (parsed.kind !== 'FIELDS') return;

    // The reference is read from the file — the only thing the file is trusted
    // for — and everything else comes from the row it names.
    const reference = parsed.fields['zarya.meta.operationRef'];
    expect(reference).toBe(outcome.operationRef);

    const record = await store.find(reference as OperationRef);
    expect(record).toBeDefined();
    if (record === undefined) return;

    const bound = bindOperation(record, DEPLOYMENT);
    expect(bound.kind).toBe('BOUND');
    if (bound.kind !== 'BOUND') return;

    const assembled = assembleFormInput(parsed.fields, bound.issued);
    expect(assembled.kind, JSON.stringify(assembled)).toBe('INPUT');
    if (assembled.kind !== 'INPUT') return;

    const built = buildIntent(assembled.operationType, assembled.input);
    expect(built.kind, JSON.stringify(built)).toBe('INTENT');
    if (built.kind !== 'INTENT') return;

    // The organ came from the record, and the region is the *ordinal* the
    // contract takes — recovered from the subject code the row stored, never
    // from the file.
    expect(built.intent).toEqual({
      type: 'CREATE_MEMBERSHIP_VOTING',
      organ: ORGAN,
      member: '0x1111111111111111111111111111111111111111',
      duration: 86400,
    });
    database.close();
  });

  it('recovers a vote’s voting number from the row, not from the document', async () => {
    // The bound value that matters most: a tampered voting number in the file
    // would move a vote onto a different proposal and the vote would succeed.
    const { store, database, bytes, outcome } = await issue('CAST_VOTE', { votingId: '1' });

    const filled = await fillIssuedForm(bytes, { support: 'FOR' });
    const parsed = await parseFormFields(filled);
    if (parsed.kind !== 'FIELDS') throw new Error('the issued vote form did not parse');

    const record = await store.find(outcome.operationRef);
    if (record === undefined) throw new Error('the row was not found');
    const bound = bindOperation(record, DEPLOYMENT);
    if (bound.kind !== 'BOUND') throw new Error(bound.message);

    const assembled = assembleFormInput(parsed.fields, bound.issued);
    if (assembled.kind !== 'INPUT') throw new Error(JSON.stringify(assembled.refusals));
    const built = buildIntent(assembled.operationType, assembled.input);
    if (built.kind !== 'INTENT') throw new Error(JSON.stringify(built.problems));

    // No organ on the intent, deliberately: `castVote(votingId, support)` reads
    // the governing organ from the voting itself.
    expect(built.intent).toEqual({
      type: 'CAST_VOTE',
      voting: { kind: 'ID', votingId: 1n },
      direction: 'FOR',
    });
    database.close();
  });

  it('refuses a form whose row belongs to the other deployment', async () => {
    // Reachable: two incompatible deployments exist and the application can be
    // repointed between them. Nothing downstream reads the contract from the
    // file, so the row is the only thing that knows.
    const { store, database, outcome } = await issue('CREATE_MEMBERSHIP_VOTING');
    const record = await store.find(outcome.operationRef);
    if (record === undefined) throw new Error('the row was not found');

    const elsewhere = bindOperation(record, {
      chainId: chainId(11155111),
      contractAddress: evmAddress('0x00000000000000000000000000000000000000ff'),
    });

    expect(elsewhere).toMatchObject({ kind: 'REFUSED', code: 'WRONG_DEPLOYMENT' });
    database.close();
  });

  it('leaves the row EMITTED, which is what makes it bindable at all', async () => {
    // A reference that never reached EMITTED did not come from this application:
    // no file was handed over under it.
    const { store, database, outcome } = await issue('CREATE_MEMBERSHIP_VOTING');

    const record = await store.find(outcome.operationRef);
    expect(record?.state).toBe('EMITTED');
    database.close();
  });

  it('prints the organ the contract renders, and stores the code it derives from', async () => {
    // Both halves of the ordinal/code split in one assertion: the *document*
    // shows the contract's identifier, the *row* keeps the subject code, and the
    // ordinal appears in neither.
    const { store, database, outcome, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const parsed = await parseFormFields(bytes);
    if (parsed.kind !== 'FIELDS') throw new Error('the issued form did not parse');

    expect(parsed.fields['zarya.context.organ']).toBe('95.СОВ-7');
    const record = await store.find(outcome.operationRef);
    expect(record?.boundValues).toEqual({
      organType: 'LocalSoviet',
      regionSubjectCode: '95',
      organNumber: '7',
    });
    database.close();
  });
});
