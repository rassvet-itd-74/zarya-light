import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormTemplateWriter } from '../adapters/forms/formTemplateWriter';
import type { TemplateAssets } from '../adapters/forms/issueTemplate';
import { fillIssuedForm } from '../adapters/forms/testing/pdfFixtures';
import { PdfReturnedFormReader } from '../adapters/forms/returnedFormReader';
import { CryptoIdGenerator } from '../adapters/platform/cryptoIdGenerator';
import { openDatabase } from '../adapters/store/database';
import { SqliteOperationStore } from '../adapters/store/sqliteOperationStore';
import { cellBinding } from '../domain/matrix/matrix';
import { partyOrganTriple } from '../domain/organs/partyOrgan';
import type { FileSink } from '../domain/ports/FileSink';
import type { FileSource } from '../domain/ports/FileSource';
import type { MatrixReader } from '../domain/ports/MatrixReader';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import { bytes32, chainId, evmAddress, type OperationRef } from '../domain/primitives';
import { importReturnedForm } from './importReturnedForm';
import { issueOperationTemplate } from './issueOperationTemplate';

/**
 * The loop closed the other way: issue, fill, **import**.
 *
 * `issuanceRoundTrip.test.ts` proves a returned form assembles into the right
 * input. This proves the use case that does it for real — a real PDF from the
 * real issuer, a real row in a real SQLite database, the real parser, the real
 * schema, the real intent builder, and the operation advanced to `RETURNED`
 * afterwards.
 *
 * What only exists here is the **order**, and the two things that follow from
 * it: that a failure anywhere leaves the operation importable again, and that a
 * second copy of a form is refused rather than submitted twice.
 */

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};

const OTHER_DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x141eb271Fb1eD3D0D0e9E0E7C1E51b1E5aB3C0f1'),
};

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

/** Chechnya: ordinal 20, subject code 95 — the pair that differs. */
const ORGAN = partyOrganTriple({ organType: 'LocalSoviet', region: 20, number: 7 });
const ORGAN_HASH = bytes32(`0x${'11'.repeat(32)}`);

const organs: OrganResolver = {
  resolve: async (triple) => ({ triple, organ: ORGAN_HASH, identifier: '95.СОВ-7' }),
  label: () => undefined,
  tripleOf: () => undefined,
};

/** A matrix whose one numerical cell holds `decimals`, or which answers nothing. */
const matrixWith = (decimals: number | 'UNREADABLE'): MatrixReader => ({
  categoricalCell: async () => undefined,
  numericalCell: async () =>
    decimals === 'UNREADABLE'
      ? undefined
      : { binding: cellBinding(ORGAN_HASH), decimals, sampleLength: 0n },
  theme: async () => undefined,
  statement: async () => undefined,
});

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

const sourceOf = (bytes: Uint8Array): FileSource => ({ read: async () => bytes });

const issue = async (
  operationType: 'CREATE_MEMBERSHIP_VOTING' | 'CREATE_NUMERICAL_VALUE_VOTING',
  deployment = DEPLOYMENT,
) => {
  const database = openDatabase(':memory:');
  const store = new SqliteOperationStore(database.db);
  const files = capturingSink();

  const outcome = await issueOperationTemplate(
    { organs, store, templates: new FormTemplateWriter(ASSETS), files, ids: new CryptoIdGenerator(), deployment },
    { operationType, organ: ORGAN, targetPath: 'C:/unused.pdf' },
  );
  if (outcome.kind !== 'ISSUED') {
    throw new Error(`issuance refused: ${outcome.code} ${outcome.message}`);
  }
  return { outcome, store, database, bytes: files.bytes() };
};

/** A second template in a database that already has one, for the dedup cases. */
const issueInto = async (
  store: SqliteOperationStore,
  operationType: 'CREATE_MEMBERSHIP_VOTING' | 'CREATE_NUMERICAL_VALUE_VOTING',
) => {
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
    { operationType, organ: ORGAN, targetPath: 'C:/unused.pdf' },
  );
  if (outcome.kind !== 'ISSUED') throw new Error(`issuance refused: ${outcome.code}`);
  return { outcome, bytes: files.bytes() };
};

const stateOf = async (store: SqliteOperationStore, ref: string) =>
  (await store.find(ref as OperationRef))?.state;

describe('importing a form this application issued', () => {
  it('becomes the intent it was issued for, and marks the operation returned', async () => {
    const { outcome, store, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });

    expect(await stateOf(store, outcome.operationRef)).toBe('EMITTED');

    const imported = await importReturnedForm(
      { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT },
      { sourcePath: 'C:/returned.pdf' },
    );

    expect(imported.kind).toBe('IMPORTED');
    if (imported.kind !== 'IMPORTED') return;

    expect(imported.operationRef).toBe(outcome.operationRef);
    expect(imported.intent).toMatchObject({
      type: 'CREATE_MEMBERSHIP_VOTING',
      member: '0x1111111111111111111111111111111111111111',
    });
    // The organ came from the **record**, never from the file — hard rule 4. The
    // ordinal is what a call takes and the record stored a subject code, so this
    // also pins that the two halves agree on which is which.
    expect(imported.intent).toMatchObject({ organ: { organType: 'LocalSoviet', region: 20, number: 7 } });
    expect(imported.warnings).toEqual([]);

    expect(await stateOf(store, outcome.operationRef)).toBe('RETURNED');
  });

  it('refuses a second copy rather than submitting the operation twice', async () => {
    const { outcome, store, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });
    const deps = { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT };

    expect((await importReturnedForm(deps, { sourcePath: 'C:/a.pdf' })).kind).toBe('IMPORTED');

    // The record still *binds* — that is deliberate, so a stale copy resolves to
    // the completed operation instead of looking unbound — and this is what turns
    // that into an answer rather than a silent second import.
    const again = await importReturnedForm(deps, { sourcePath: 'C:/a.pdf' });
    expect(again).toMatchObject({ kind: 'REFUSED', code: 'ALREADY_IMPORTED' });
    expect(await stateOf(store, outcome.operationRef)).toBe('RETURNED');
  });

  it('reads the scale from the cell the member addressed, at import', async () => {
    // The whole argument of the `resolved` category. The same filled form means
    // twelve-point-three-four at whatever precision the cell holds *now*, so the
    // integer differs with the cell and the form does not have to be reissued.
    const forScale = async (decimals: number) => {
      const { store, bytes } = await issue('CREATE_NUMERICAL_VALUE_VOTING');
      const filled = await fillIssuedForm(bytes, {
        x: '3',
        y: '7',
        value: '12.34',
        valueAuthor: '0x1111111111111111111111111111111111111111',
        duration: '86400',
      });
      const imported = await importReturnedForm(
        { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(decimals), deployment: DEPLOYMENT },
        { sourcePath: 'C:/n.pdf' },
      );
      if (imported.kind !== 'IMPORTED') throw new Error(`refused: ${imported.code}`);
      return imported.intent;
    };

    expect(await forScale(2)).toMatchObject({ value: 1234n, decimals: 2 });
    expect(await forScale(4)).toMatchObject({ value: 123400n, decimals: 4 });
  });

  it('refuses when the cell’s precision cannot be read, and keeps the form importable', async () => {
    // `addValue` takes no decimals argument, so a guessed scale is a valid
    // transaction storing a number off by a power of ten and nothing on chain
    // would notice. An outage is therefore a refusal, never a default.
    const { outcome, store, bytes } = await issue('CREATE_NUMERICAL_VALUE_VOTING');
    const filled = await fillIssuedForm(bytes, {
      x: '3',
      y: '7',
      value: '12.34',
      valueAuthor: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });

    const imported = await importReturnedForm(
      {
        files: sourceOf(filled),
        forms: new PdfReturnedFormReader(),
        store,
        matrix: matrixWith('UNREADABLE'),
        deployment: DEPLOYMENT,
      },
      { sourcePath: 'C:/n.pdf' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'CHAIN_UNAVAILABLE' });
    // Still `EMITTED`: the member can import the same file again once the
    // network is back. Advancing before the intent was built would have burned
    // the operation on an outage.
    expect(await stateOf(store, outcome.operationRef)).toBe('EMITTED');
  });

  it('leaves the operation importable when the form fails validation', async () => {
    const { outcome, store, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const filled = await fillIssuedForm(bytes, {
      member: 'not an address',
      duration: '86400',
    });

    const imported = await importReturnedForm(
      { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT },
      { sourcePath: 'C:/bad.pdf' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'INVALID_INTENT' });
    if (imported.kind !== 'REFUSED') return;
    expect(imported.problems[0]).toMatchObject({ field: 'member' });
    expect(await stateOf(store, outcome.operationRef)).toBe('EMITTED');
  });

  it('refuses a form issued against another deployment', async () => {
    // Nothing downstream reads the chain id or the contract from the file, so
    // the record is the only thing that says which deployment an operation
    // belongs to — and two incompatible ones exist.
    const { store, bytes } = await issue('CREATE_MEMBERSHIP_VOTING', OTHER_DEPLOYMENT);
    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });

    const imported = await importReturnedForm(
      { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT },
      { sourcePath: 'C:/other.pdf' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'NOT_BINDABLE' });
  });

  it('refuses a form whose operation this application never recorded', async () => {
    const { bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });
    // A different, empty database: the file is genuine and its reference resolves
    // to nothing here.
    const store = new SqliteOperationStore(openDatabase(':memory:').db);

    const imported = await importReturnedForm(
      { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT },
      { sourcePath: 'C:/orphan.pdf' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'UNKNOWN_OPERATION_REF' });
  });

  it('stores the returned file and its identity with the state, in one step', async () => {
    // Phase 6 regenerates a receipt from these bytes, and the bytes exist only
    // at import. The three move together because a `RETURNED` row with no bytes
    // cannot regenerate anything, and an `EMITTED` row holding an identity would
    // dedup against itself.
    const { outcome, store, bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const filled = await fillIssuedForm(bytes, {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    });

    await importReturnedForm(
      { files: sourceOf(filled), forms: new PdfReturnedFormReader(), store, matrix: matrixWith(2), deployment: DEPLOYMENT },
      { sourcePath: 'C:/r.pdf' },
    );

    const record = await store.find(outcome.operationRef as OperationRef);
    expect(record?.state).toBe('RETURNED');
    expect(record?.identityKey).toMatch(/CREATE_MEMBERSHIP_VOTING/);
    expect(record?.formHash).toMatch(/^[0-9a-f]{64}$/);
    // Not a vote, so no direction — absent rather than empty.
    expect(record?.voteDirection).toBeUndefined();
  });

  it('refuses a second form asking for the same thing under a different reference', async () => {
    // The case `operationRef` dedup cannot see: a member who mislaid the first
    // template and reissued has two references and one intention. Submitting
    // both would create two votings.
    const filledValues = {
      member: '0x1111111111111111111111111111111111111111',
      duration: '86400',
    };
    const first = await issue('CREATE_MEMBERSHIP_VOTING');
    const store = first.store;

    await importReturnedForm(
      {
        files: sourceOf(await fillIssuedForm(first.bytes, filledValues)),
        forms: new PdfReturnedFormReader(),
        store,
        matrix: matrixWith(2),
        deployment: DEPLOYMENT,
      },
      { sourcePath: 'C:/first.pdf' },
    );

    // A second template for the same operation, in the same database.
    const second = await issueInto(store, 'CREATE_MEMBERSHIP_VOTING');
    expect(second.outcome.operationRef).not.toBe(first.outcome.operationRef);

    const imported = await importReturnedForm(
      {
        files: sourceOf(await fillIssuedForm(second.bytes, filledValues)),
        forms: new PdfReturnedFormReader(),
        store,
        matrix: matrixWith(2),
        deployment: DEPLOYMENT,
      },
      { sourcePath: 'C:/second.pdf' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'DUPLICATE_OPERATION' });
    if (imported.kind !== 'REFUSED') return;
    expect(imported.problems[0]?.message).toContain(first.outcome.operationRef);
    // And the second operation stays importable, because nothing about it was
    // wrong — the answer may change if the first is abandoned.
    expect(await stateOf(store, second.outcome.operationRef)).toBe('EMITTED');
  });

  it('surfaces two opposite votes on one voting as a conflict, not a duplicate', async () => {
    // A vote's identity excludes its direction on purpose, so both forms land on
    // one key. That collision is the mechanism: the application must say the two
    // contradict rather than pick a winner or treat them as unrelated.
    const database = openDatabase(':memory:');
    const store = new SqliteOperationStore(database.db);

    const castVote = async () => {
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
        { operationType: 'CAST_VOTE', votingId: '7', targetPath: 'C:/v.pdf' },
      );
      if (outcome.kind !== 'ISSUED') throw new Error(`refused: ${outcome.code}`);
      return { outcome, bytes: files.bytes() };
    };

    const importVote = async (bytes: Uint8Array, support: string) =>
      await importReturnedForm(
        {
          files: sourceOf(await fillIssuedForm(bytes, { support })),
          forms: new PdfReturnedFormReader(),
          store,
          matrix: matrixWith(2),
          deployment: DEPLOYMENT,
        },
        { sourcePath: 'C:/v.pdf' },
      );

    const first = await castVote();
    expect((await importVote(first.bytes, 'FOR')).kind).toBe('IMPORTED');
    expect((await store.find(first.outcome.operationRef as OperationRef))?.voteDirection).toBe(
      'FOR',
    );

    const second = await castVote();
    const opposed = await importVote(second.bytes, 'AGAINST');

    expect(opposed).toMatchObject({ kind: 'REFUSED', code: 'CONFLICTING_VOTE' });
    if (opposed.kind !== 'REFUSED') return;
    expect(opposed.problems[0]?.message).toContain('FOR');

    // The same direction twice is a duplicate instead — a different answer, and
    // the reason direction is stored beside the key rather than in it.
    const third = await castVote();
    expect(await importVote(third.bytes, 'FOR')).toMatchObject({
      kind: 'REFUSED',
      code: 'DUPLICATE_OPERATION',
    });
  });

  it('refuses a file that is not a form at all, before any lookup', async () => {
    const store = new SqliteOperationStore(openDatabase(':memory:').db);
    const imported = await importReturnedForm(
      {
        files: sourceOf(Uint8Array.from(Buffer.from('not a pdf'))),
        forms: new PdfReturnedFormReader(),
        store,
        matrix: matrixWith(2),
        deployment: DEPLOYMENT,
      },
      { sourcePath: 'C:/notes.txt' },
    );

    expect(imported).toMatchObject({ kind: 'REFUSED', code: 'NOT_IMPORTABLE' });
    if (imported.kind !== 'REFUSED') return;
    expect(imported.problems.map((problem) => problem.code)).toEqual(['UNREADABLE']);
  });
});
