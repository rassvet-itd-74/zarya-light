import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntent } from '../../domain/intents/buildIntent';
import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import { INTENT_SAMPLES } from '../../domain/intents/testing/intentSamples';
import { chainId, evmAddress, operationRef } from '../../domain/primitives';
import { type DatabaseHandle, openDatabase } from '../store/database';
import { SqliteOperationStore } from '../store/sqliteOperationStore';
import { assembleFormInput } from './assembleFormInput';
import { bindOperation } from './boundOperation';
import { FIELD_PLAN, inputFieldName } from './formSchema';
import { type TemplateAssets, contextValuesFor, issueTemplate } from './issueTemplate';
import { parseFormFields } from './pdfFormParser';
import { filledForm, resolvedValues } from './testing/formSamples';

/**
 * The whole loop, with the database in it.
 *
 * Record the operation, issue the template, fill it as a member would, parse it,
 * resolve its reference in the store, bind, validate — and get the intent back.
 * Every earlier round-trip test invented the operation record; this one persists
 * it and reads it out, which is the gap Phase 4 slice 3 recorded as "every
 * issued form is bound to a record that does not exist".
 */

const SEPOLIA = chainId(11155111);
const CONTRACT = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');
const SCOPE = { chainId: SEPOLIA, contractAddress: CONTRACT };

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

/** The app-authored half, matching what `FIELD_PLAN` says is bound. */
const BOUND_VALUES: Readonly<Record<string, string>> = {
  organType: 'RegionalSoviet',
  regionSubjectCode: '95',
  organNumber: '0',
  decimals: '2',
  votingId: '7',
};

const boundFor = (type: OperationType): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const key of FIELD_PLAN[type].bound) values[key] = BOUND_VALUES[key];
  return values;
};

describe('issue, record, fill, ingest', () => {
  let handle: DatabaseHandle;
  let store: SqliteOperationStore;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    store = new SqliteOperationStore(handle.db);
  });
  afterEach(() => handle.close());

  /** Issuance in the order the invariant demands: record, then emit. */
  const issueAndRecord = async (type: OperationType, ref = operationRef('op_test_0001')) => {
    const context = contextValuesFor(type, {
      chainId: String(SEPOLIA),
      contract: CONTRACT,
      organ: '95.СОВ',
      votingId: BOUND_VALUES.votingId,
    });
    // RECORDED before EMITTED. A form handed over before its row exists is
    // unbound in practice and loses the tamper check for good.
    await store.record({
      operationRef: ref,
      operationType: type,
      chainId: SEPOLIA,
      contractAddress: CONTRACT,
      boundValues: boundFor(type),
      displayedContext: context,
    });
    const { bytes } = await issueTemplate({ operationType: type, operationRef: ref, context }, ASSETS);
    await store.advance(ref, 'EMITTED');
    return bytes;
  };

  /** Fills the input fields the way a member would, then re-saves. */
  const fill = async (type: OperationType, bytes: Uint8Array): Promise<Uint8Array> => {
    const document = await PDFDocument.load(bytes);
    const form = document.getForm();
    const source = filledForm(type);
    for (const [name, value] of Object.entries(source)) {
      if (!name.startsWith('zarya.input.') || value.length === 0) continue;
      const field = form.getField(name);
      if (field.constructor.name === 'PDFRadioGroup') form.getRadioGroup(name).select(value);
      else form.getTextField(name).setText(value);
    }
    return document.save({ updateFieldAppearances: false });
  };

  it('recovers the exact intent from a persisted record, all eleven', async () => {
    for (const type of OPERATION_TYPES) {
      const ref = operationRef(`op_${type}`);
      const filled = await fill(type, await issueAndRecord(type, ref));

      const parsed = await parseFormFields(filled);
      expect(parsed.kind, `${type} parse`).toBe('FIELDS');
      if (parsed.kind !== 'FIELDS') continue;

      // The reference comes off the file; everything authoritative comes from
      // the row it names.
      const record = await store.find(ref);
      expect(record, `${type} record`).toBeDefined();
      if (record === undefined) continue;

      const bound = bindOperation(record, SCOPE);
      expect(bound.kind, `${type} bind`).toBe('BOUND');
      if (bound.kind !== 'BOUND') continue;

      const assembled = assembleFormInput(parsed.fields, bound.issued);
      expect(assembled.kind, `${type} assemble: ${JSON.stringify(assembled)}`).toBe('INPUT');
      if (assembled.kind !== 'INPUT') continue;

      // The record supplies the bound half and the chain the resolved half. The
      // scale is deliberately *not* in `boundValues` above — a numerical value
      // template is issued before any cell is chosen, so there is nothing to
      // record — and the fixture stands in for reading it at import.
      const built = buildIntent(assembled.operationType, {
        ...assembled.input,
        ...resolvedValues(type),
      });
      // The problems, never the intent: an intent holds bigints and
      // JSON.stringify refuses them.
      const why = built.kind === 'PROBLEMS' ? JSON.stringify(built.problems) : '';
      expect(built.kind, `${type} build ${why}`).toBe('INTENT');
      if (built.kind !== 'INTENT') continue;

      expect(built.intent, type).toEqual(INTENT_SAMPLES[type]);
    }
  });

  it('warns about nothing, because issuance wrote the context it is compared against', async () => {
    const type = 'CREATE_MEMBERSHIP_VOTING';
    const filled = await fill(type, await issueAndRecord(type));
    const parsed = await parseFormFields(filled);
    const record = await store.find(operationRef('op_test_0001'));
    const bound = record === undefined ? undefined : bindOperation(record, SCOPE);
    const assembled =
      parsed.kind === 'FIELDS' && bound?.kind === 'BOUND'
        ? assembleFormInput(parsed.fields, bound.issued)
        : undefined;
    expect(assembled?.kind).toBe('INPUT');
    expect(assembled?.kind === 'INPUT' && assembled.warnings).toEqual([]);
  });

  it('still binds a second copy of an already-imported form', async () => {
    // It has to resolve to the completed operation so dedup can call it a
    // duplicate. Resolving to nothing would let a stale form be treated as
    // unbound and fall back to its own values.
    const type = 'CAST_VOTE';
    await issueAndRecord(type);
    const ref = operationRef('op_test_0001');
    await store.advance(ref, 'RETURNED');

    const record = await store.find(ref);
    expect(record && bindOperation(record, SCOPE).kind).toBe('BOUND');
  });

  it('uses the record’s organ, and a file cannot offer a different one', async () => {
    // The form *prints* `95.СОВ-7` for a human to check, as page text. Since
    // 2026-09-06 there is no field to retype it into: a member with a PDF
    // viewer has no way to make this document claim another organ.
    //
    // The old version of this test edited `zarya.context.organ` and asserted
    // that the edit was reported and then ignored. Adding that field back by
    // hand is now a refusal, which is the stronger outcome — so what is left to
    // check is that the organ reaching a transaction comes from the row.
    const type = 'CREATE_MEMBERSHIP_VOTING';
    const filled = await fill(type, await issueAndRecord(type));

    const parsed = await parseFormFields(filled);
    const record = await store.find(operationRef('op_test_0001'));
    const bound = record === undefined ? undefined : bindOperation(record, SCOPE);
    const assembled =
      parsed.kind === 'FIELDS' && bound?.kind === 'BOUND'
        ? assembleFormInput(parsed.fields, bound.issued)
        : undefined;

    expect(assembled?.kind).toBe('INPUT');
    expect(parsed.kind === 'FIELDS' && Object.keys(parsed.fields)).not.toContain(
      'zarya.context.organ',
    );
    // Chechnya's code, from the row, through the region table.
    expect(assembled?.kind === 'INPUT' && assembled.input.regionSubjectCode).toBe('95');
  });
});

describe('binding refusals', () => {
  let handle: DatabaseHandle;
  let store: SqliteOperationStore;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    store = new SqliteOperationStore(handle.db);
  });
  afterEach(() => handle.close());

  const record = async (overrides: { chainId?: typeof SEPOLIA; contract?: typeof CONTRACT } = {}) => {
    const ref = operationRef('op_scope');
    await store.record({
      operationRef: ref,
      operationType: 'CAST_VOTE',
      chainId: overrides.chainId ?? SEPOLIA,
      contractAddress: overrides.contract ?? CONTRACT,
      boundValues: { votingId: '7' },
      displayedContext: {},
    });
    await store.advance(ref, 'EMITTED');
    return (await store.find(ref)) as NonNullable<Awaited<ReturnType<typeof store.find>>>;
  };

  it('refuses a record from another chain', async () => {
    // Reachable, not hypothetical: nothing downstream reads the chain id from
    // the file, so the record is the only thing that says which deployment an
    // operation belongs to.
    const stored = await record({ chainId: chainId(1) });
    expect(bindOperation(stored, SCOPE)).toMatchObject({
      kind: 'REFUSED',
      code: 'WRONG_DEPLOYMENT',
    });
  });

  it('refuses a record from another contract on the same chain', async () => {
    // Two incompatible deployments exist, differing in castVote's arity.
    const stored = await record({
      contract: evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD'),
    });
    expect(bindOperation(stored, SCOPE)).toMatchObject({
      kind: 'REFUSED',
      code: 'WRONG_DEPLOYMENT',
    });
  });

  it('accepts a scope that differs only in checksum casing', async () => {
    const stored = await record();
    expect(
      bindOperation(stored, {
        chainId: SEPOLIA,
        contractAddress: evmAddress(CONTRACT.toLowerCase()),
      }).kind,
    ).toBe('BOUND');
  });

  it('refuses an operation for which no file was ever issued', async () => {
    // Different from an unknown reference, and only one of the two suggests a
    // database that lost rows.
    const ref = operationRef('op_never_emitted');
    await store.record({
      operationRef: ref,
      operationType: 'CAST_VOTE',
      chainId: SEPOLIA,
      contractAddress: CONTRACT,
      boundValues: { votingId: '7' },
      displayedContext: {},
    });
    const stored = await store.find(ref);
    expect(stored && bindOperation(stored, SCOPE)).toMatchObject({
      kind: 'REFUSED',
      code: 'NOT_EMITTED',
    });
  });
});

describe('an input field the plan does not name', () => {
  it('is still refused when the record supplies the bound half', async () => {
    // The bound/input split is enforced against the record, not against a test
    // fixture, now that the record is the real thing.
    const handle = openDatabase(':memory:');
    const store = new SqliteOperationStore(handle.db);
    const ref = operationRef('op_x');
    await store.record({
      operationRef: ref,
      operationType: 'CREATE_NUMERICAL_VALUE_VOTING',
      chainId: SEPOLIA,
      contractAddress: CONTRACT,
      boundValues: boundFor('CREATE_NUMERICAL_VALUE_VOTING'),
      displayedContext: {},
    });
    await store.advance(ref, 'EMITTED');
    const stored = await store.find(ref);
    const bound = stored === undefined ? undefined : bindOperation(stored, SCOPE);

    const fields = {
      ...filledForm('CREATE_NUMERICAL_VALUE_VOTING'),
      'zarya.meta.operationRef': ref,
      [inputFieldName('decimals')]: '6',
    };
    const assembled =
      bound?.kind === 'BOUND' ? assembleFormInput(fields, bound.issued) : undefined;
    expect(assembled?.kind).toBe('REFUSED');
    handle.close();
  });
});
