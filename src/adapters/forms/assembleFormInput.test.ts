import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../domain/intents/intent';
import { assembleFormInput, readFormReference } from './assembleFormInput';
import {
  CONTEXT_FIELDS,
  FORM_SCHEMA_VERSION,
  META_FIELDS,
  RECEIPT_FIELDS,
  inputFieldName,
} from './formSchema';
import { SAMPLE_OPERATION_REF, filledForm, issuedOperation } from './testing/formSamples';

/**
 * Intake's structural decisions, on a form that never touched a PDF library.
 *
 * Every refusal here is one that needs no chain read and no file parsing, so it
 * is reproducible: the same form and the same record always produce the same
 * answer, and a refusal is never an outage.
 */

const intake = (
  type: (typeof OPERATION_TYPES)[number],
  overrides: Readonly<Record<string, string | undefined>> = {},
) => assembleFormInput(filledForm(type, overrides), issuedOperation(type));

const refusalCodes = (result: ReturnType<typeof assembleFormInput>) =>
  result.kind === 'REFUSED' ? result.refusals.map((refusal) => refusal.code) : [];

describe('a well-formed bound form', () => {
  it('is accepted for all eleven operations, with no warnings', () => {
    for (const type of OPERATION_TYPES) {
      const result = intake(type);
      expect(result.kind, `${type}: ${JSON.stringify(refusalCodes(result))}`).toBe('INPUT');
      expect(result.kind === 'INPUT' && result.warnings).toEqual([]);
    }
  });

  it('takes its operation type from the record rather than the file', () => {
    const result = intake('CAST_VOTE');
    expect(result.kind === 'INPUT' && result.operationType).toBe('CAST_VOTE');
  });

  it('accepts the empty receipt fields a template legitimately carries', () => {
    // Refusing an empty txHash would refuse every unstamped form.
    expect(filledForm('CAST_VOTE')[RECEIPT_FIELDS.txHash]).toBe('');
    expect(intake('CAST_VOTE').kind).toBe('INPUT');
  });
});

describe('only the human-filled half is read from the file', () => {
  it('takes the bound values from the record, ignoring what the file says', () => {
    // The whole of hard rule 4 in one assertion: the file claims a different
    // voting and a different cell scale, and neither reaches the input.
    const result = intake('CAST_VOTE', { [CONTEXT_FIELDS.votingId]: '999' });
    expect(result.kind === 'INPUT' && result.input.votingId).toBe('7');
  });

  it('refuses a form that tries to supply the cell scale itself', () => {
    // `zarya.input.decimals` on a numerical value form is an attempt to state
    // the scale the record owns. The field list refuses it before any value is
    // read. The assembler also writes bound keys *after* input keys, so the
    // record would win even if the list were wrong — that second mechanism is
    // not separately observable here, precisely because the first one fires.
    const form = {
      ...filledForm('CREATE_NUMERICAL_VALUE_VOTING'),
      [inputFieldName('decimals')]: '6',
    };
    const issued = issuedOperation('CREATE_NUMERICAL_VALUE_VOTING');
    expect(refusalCodes(assembleFormInput(form, issued))).toContain('UNKNOWN_FIELD');
  });

  it('uses the record’s scale on the form that is accepted', () => {
    const result = intake('CREATE_NUMERICAL_VALUE_VOTING');
    expect(result.kind === 'INPUT' && result.input.decimals).toBe('2');
  });

  it('never reads a receipt field for its value', () => {
    // A plausible transaction hash typed in achieves nothing — and here it does
    // not even reach the value stage, because it is the re-import marker.
    const result = intake('CAST_VOTE', { [RECEIPT_FIELDS.signer]: 'Ivan' });
    expect(result.kind === 'INPUT' && Object.keys(result.input).sort()).toEqual([
      'support',
      'votingId',
    ]);
  });
});

describe('the schema version gate', () => {
  it('refuses a form that does not identify itself, such as the matrix report', () => {
    expect(refusalCodes(intake('CAST_VOTE', { [META_FIELDS.schemaVersion]: undefined }))).toEqual([
      'MISSING_SCHEMA_VERSION',
    ]);
  });

  it('refuses an unknown version outright rather than parsing what it can', () => {
    const result = intake('CAST_VOTE', { [META_FIELDS.schemaVersion]: 'zarya.form.2' });
    expect(refusalCodes(result)).toEqual(['UNKNOWN_SCHEMA_VERSION']);
    // One refusal, and no attempt at the rest: an unrecognised version means the
    // field names in the file mean something this build does not know.
    expect(result.kind === 'REFUSED' && result.refusals).toHaveLength(1);
  });

  it('is checked before anything else, even on an otherwise hostile form', () => {
    const result = intake('CAST_VOTE', {
      [META_FIELDS.schemaVersion]: 'nonsense',
      [RECEIPT_FIELDS.txHash]: '0xabc',
      'zarya.evil': 'x',
    });
    expect(refusalCodes(result)).toEqual(['UNKNOWN_SCHEMA_VERSION']);
  });

  it('trims the version, because a PDF field picks up a trailing space', () => {
    expect(intake('CAST_VOTE', { [META_FIELDS.schemaVersion]: ` ${FORM_SCHEMA_VERSION} ` }).kind).toBe(
      'INPUT',
    );
  });
});

describe('the operation reference', () => {
  it('is required, so an unbound form is refused rather than guessed at', () => {
    expect(refusalCodes(intake('CAST_VOTE', { [META_FIELDS.operationRef]: undefined }))).toEqual([
      'MISSING_OPERATION_REF',
    ]);
    expect(refusalCodes(intake('CAST_VOTE', { [META_FIELDS.operationRef]: '   ' }))).toEqual([
      'MISSING_OPERATION_REF',
    ]);
  });

  it('must match the record it was looked up with', () => {
    const result = assembleFormInput(
      filledForm('CAST_VOTE', { [META_FIELDS.operationRef]: 'op_somethingelse' }),
      issuedOperation('CAST_VOTE'),
    );
    expect(refusalCodes(result)).toContain('OPERATION_REF_MISMATCH');
  });

  it('is readable on its own, before a record has been fetched', () => {
    // The lookup is I/O in every real caller, so the reference is read first and
    // separately. This keeps the version gate ahead of the database.
    expect(readFormReference(filledForm('CAST_VOTE'))).toEqual({
      kind: 'REF',
      operationRef: SAMPLE_OPERATION_REF,
    });
  });
});

describe('the re-import marker', () => {
  it('refuses a form carrying a transaction hash', () => {
    expect(
      refusalCodes(intake('CAST_VOTE', { [RECEIPT_FIELDS.txHash]: '0x'.padEnd(66, 'a') })),
    ).toContain('RECEIPT_ALREADY_STAMPED');
  });

  it('refuses a hand-typed one exactly the same way', () => {
    // A forgery attempt and a receipt coming back around are the same refusal.
    // Nothing here tries to tell them apart, because the file cannot say.
    expect(refusalCodes(intake('CAST_VOTE', { [RECEIPT_FIELDS.txHash]: 'not a hash' }))).toContain(
      'RECEIPT_ALREADY_STAMPED',
    );
  });
});

describe('field names are never matched approximately', () => {
  it('refuses a name the schema does not define', () => {
    for (const name of ['zarya.input.member ', 'zarya.Input.support', 'zarya.meta.operation']) {
      const result = intake('CAST_VOTE', { [name]: 'x' });
      expect(refusalCodes(result), name).toContain('UNKNOWN_FIELD');
    }
  });

  it('refuses an input field belonging to a different operation', () => {
    // This is the one that matters. `zarya.input.votingId` on a vote form is an
    // attempt to supply the value the record owns.
    const result = intake('CAST_VOTE', { [inputFieldName('votingId')]: '999' });
    expect(refusalCodes(result)).toContain('UNKNOWN_FIELD');
  });

  it('refuses a missing input field rather than reporting an empty form', () => {
    // A flattened PDF loses its fields; blaming the member for leaving one
    // blank would send them back to a form that no longer has it.
    const result = intake('CAST_VOTE', { [inputFieldName('support')]: undefined });
    expect(refusalCodes(result)).toEqual(['MISSING_INPUT_FIELD']);
  });

  it('keeps a blank field apart from an absent one', () => {
    // Blank is a person who did not fill it in, and buildIntent says so per
    // field. Intake passes it through rather than deciding.
    const result = intake('CAST_VOTE', { [inputFieldName('support')]: '' });
    expect(result.kind).toBe('INPUT');
    expect(result.kind === 'INPUT' && result.input.support).toBe('');
  });
});

describe('a record that cannot complete the form', () => {
  it('is refused, naming what the application failed to author', () => {
    const issued = issuedOperation('CREATE_NUMERICAL_VALUE_VOTING');
    const { decimals, ...withoutScale } = issued.values;
    void decimals;
    const result = assembleFormInput(filledForm('CREATE_NUMERICAL_VALUE_VOTING'), {
      ...issued,
      values: withoutScale,
    });
    expect(refusalCodes(result)).toEqual(['MISSING_BOUND_VALUE']);
  });
});

describe('the tamper check compares and then ignores', () => {
  it('warns about a context field the file disagrees with', () => {
    const result = intake('CREATE_MEMBERSHIP_VOTING', {
      [CONTEXT_FIELDS.organ]: '74.СОВ',
    });
    expect(result.kind).toBe('INPUT');
    expect(result.kind === 'INPUT' && result.warnings).toEqual([
      {
        code: 'CONTEXT_TAMPERED',
        field: CONTEXT_FIELDS.organ,
        message: expect.stringContaining('74.СОВ'),
      },
    ]);
    // And the organ actually used is still the record's: Chechnya's subject
    // code, which the region table alone can turn into an ordinal.
    expect(result.kind === 'INPUT' && result.input.regionSubjectCode).toBe('95');
  });

  it('warns about a tampered chain id without refusing the form', () => {
    // Refusing would be stricter than necessary — the value is not used — and
    // would give a tampered display field power over an import.
    const result = intake('CAST_VOTE', { [CONTEXT_FIELDS.chainId]: '1' });
    expect(result.kind).toBe('INPUT');
    expect(result.kind === 'INPUT' && result.warnings.map((w) => w.field)).toEqual([
      CONTEXT_FIELDS.chainId,
    ]);
  });

  it('says nothing about a context field the record has no expectation for', () => {
    // "Unknown" and "disagrees" are different, and only one is evidence.
    const issued = issuedOperation('CAST_VOTE');
    const result = assembleFormInput(filledForm('CAST_VOTE'), { ...issued, context: {} });
    expect(result.kind === 'INPUT' && result.warnings).toEqual([]);
  });
});
