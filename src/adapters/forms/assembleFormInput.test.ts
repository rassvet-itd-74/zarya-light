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

  it('carries only the meta fields and the inputs, and nothing else', () => {
    // The shape of an issued form since 2026-09-06. There is no longer any
    // app-authored field for a member to see, wonder about, or type into: the
    // context block is printed text and the receipt is a stamp.
    const form = filledForm('CAST_VOTE');
    expect(Object.keys(form).filter((name) => name.startsWith('zarya.context.'))).toEqual([]);
    expect(Object.keys(form).filter((name) => name.startsWith('zarya.receipt.'))).toEqual([]);
    expect(intake('CAST_VOTE').kind).toBe('INPUT');
  });
});

describe('only the human-filled half is read from the file', () => {
  it('takes the bound values from the record, and a file cannot even claim one', () => {
    // Hard rule 4, now structural. A file used to be able to carry
    // `zarya.context.votingId` = 999 and be ignored; there is no such field to
    // carry, and adding one back by hand is a refusal rather than a value.
    const clean = intake('CAST_VOTE');
    expect(clean.kind === 'INPUT' && clean.input.votingId).toBe('7');
    expect(
      refusalCodes(intake('CAST_VOTE', { [CONTEXT_FIELDS.votingId]: '999' })),
    ).toEqual(['RETIRED_FIELD']);
  });

  it('refuses a form that tries to supply the cell scale itself', () => {
    // `zarya.input.decimals` on a numerical value form is an attempt to state a
    // scale that is neither the member's to give nor the record's to hold — it
    // is read from the cell at import. `allowed` is built from the plan's
    // `input` alone, so the same field list that refuses a bound key refuses a
    // resolved one, before any value is read.
    const form = {
      ...filledForm('CREATE_NUMERICAL_VALUE_VOTING'),
      [inputFieldName('decimals')]: '6',
    };
    const issued = issuedOperation('CREATE_NUMERICAL_VALUE_VOTING');
    expect(refusalCodes(assembleFormInput(form, issued))).toContain('UNKNOWN_FIELD');
  });

  it('leaves the cell scale absent, for the caller to resolve', () => {
    // The assembler is pure, and the scale is a chain read. So the map it
    // returns is deliberately incomplete for this one operation — see the note
    // on `FormIntakeResult.input`. Nothing here invents a default.
    const result = intake('CREATE_NUMERICAL_VALUE_VOTING');
    expect(result.kind).toBe('INPUT');
    expect(result.kind === 'INPUT' && result.input).not.toHaveProperty('decimals');
  });

  it('reads exactly the plan’s keys and no others', () => {
    const result = intake('CAST_VOTE');
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
    // `zarya.form.1` is the version this build replaced, and the one every form
    // issued before 2026-09-06 carries. It is refused like any other unknown.
    const result = intake('CAST_VOTE', { [META_FIELDS.schemaVersion]: 'zarya.form.1' });
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

describe('a field from a namespace that is no longer written', () => {
  it('refuses a form carrying a receipt field at all, filled or empty', () => {
    // The presence *is* the signal now. A receipt is stamped onto the page, so a
    // form with a `zarya.receipt.*` widget was edited by hand — and the value in
    // it is beside the point, which is why an empty one is refused too.
    expect(
      refusalCodes(intake('CAST_VOTE', { [RECEIPT_FIELDS.txHash]: '0x'.padEnd(66, 'a') })),
    ).toEqual(['RETIRED_FIELD']);
    expect(refusalCodes(intake('CAST_VOTE', { [RECEIPT_FIELDS.txHash]: '' }))).toEqual([
      'RETIRED_FIELD',
    ]);
  });

  it('refuses a hand-typed one exactly the same way', () => {
    // A forgery attempt and a receipt coming back around are the same refusal.
    // Nothing here tries to tell them apart, because the file cannot say.
    expect(refusalCodes(intake('CAST_VOTE', { [RECEIPT_FIELDS.txHash]: 'not a hash' }))).toEqual([
      'RETIRED_FIELD',
    ]);
  });

  it('names it as retired rather than as unknown', () => {
    // Two different facts about a document: "this field used to exist here" and
    // "no such field has ever existed". A member can act on the first.
    expect(refusalCodes(intake('CAST_VOTE', { 'zarya.nonsense': 'x' }))).toEqual(['UNKNOWN_FIELD']);
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
    // A record missing a bound key is a database that lost part of a row. The
    // organ is the case that matters: the form carries only a *display* copy of
    // it, which is compared and never used, so there is nowhere else to recover
    // it from and inventing one would propose against a different organ.
    const issued = issuedOperation('CREATE_NUMERICAL_VALUE_VOTING');
    const { organType, ...withoutOrganType } = issued.values;
    void organType;
    const result = assembleFormInput(filledForm('CREATE_NUMERICAL_VALUE_VOTING'), {
      ...issued,
      values: withoutOrganType,
    });
    expect(refusalCodes(result)).toEqual(['MISSING_BOUND_VALUE']);
  });
});

describe('the tamper check that no longer exists', () => {
  /**
   * There used to be one here, and it is worth saying why there is not now.
   *
   * `CONTEXT_TAMPERED` compared each `zarya.context.*` field against the record
   * and warned when they disagreed — compare, never use. It could do that
   * because the file carried the application's rendering in a field a member
   * could edit. It no longer does: the application block is printed page text,
   * which a form viewer cannot edit and this parser cannot read.
   *
   * The replacement is stronger and lives in the refusal above. A form that
   * disagrees with the record about its organ is not a form that gets imported
   * with a warning attached — it is a form that has had a field added to it,
   * and it is refused.
   */
  it('produces no warnings, because a well-formed form now carries nothing to compare', () => {
    for (const type of OPERATION_TYPES) {
      const result = intake(type);
      expect(result.kind === 'INPUT' && result.warnings, type).toEqual([]);
    }
  });

  it('refuses rather than warns when the file carries an organ label of its own', () => {
    // The old behaviour was INPUT plus a warning. A member could not have
    // produced this file with any PDF viewer, so it is not something to import.
    const result = intake('CREATE_MEMBERSHIP_VOTING', { [CONTEXT_FIELDS.organ]: '74.СОВ' });
    expect(refusalCodes(result)).toEqual(['RETIRED_FIELD']);
  });

  it('still takes the organ from the record on a clean form', () => {
    // Chechnya's subject code, which the region table alone can turn into an
    // ordinal — the value the file never had a say in either way.
    const result = intake('CREATE_MEMBERSHIP_VOTING');
    expect(result.kind === 'INPUT' && result.input.regionSubjectCode).toBe('95');
  });
});
