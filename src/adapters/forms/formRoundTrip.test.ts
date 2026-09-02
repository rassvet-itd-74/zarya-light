import { describe, expect, it } from 'vitest';
import { buildIntent } from '../../domain/intents/buildIntent';
import { callsForIntent } from '../../domain/intents/intentCalls';
import { OPERATION_TYPES, type GovernanceIntent } from '../../domain/intents/intent';
import { INTENT_SAMPLES } from '../../domain/intents/testing/intentSamples';
import { assembleFormInput } from './assembleFormInput';
import { inputFieldName } from './formSchema';
import { filledForm, issuedOperation } from './testing/formSamples';

/**
 * Form fields to a typed intent, for all eleven operations.
 *
 * This is the check `zarya-pdf-forms` calls the strongest available one, minus
 * the PDF: fill a template's fields programmatically, run intake, build the
 * intent, and assert it equals the intent the intent layer is already tested
 * against. Until this existed, the two halves agreed by *reading* — Phase 3
 * recorded "nothing has ever built an intent from a real form" as unverified,
 * and this is what closes it.
 *
 * The PDF library slice replaces `filledForm` with a real issue-and-parse and
 * keeps these assertions unchanged.
 */

const intentFrom = (type: (typeof OPERATION_TYPES)[number]): GovernanceIntent => {
  const assembled = assembleFormInput(filledForm(type), issuedOperation(type));
  if (assembled.kind !== 'INPUT') {
    throw new Error(`${type} was refused: ${JSON.stringify(assembled.refusals)}`);
  }
  const built = buildIntent(assembled.operationType, assembled.input);
  if (built.kind !== 'INTENT') {
    throw new Error(`${type} failed validation: ${JSON.stringify(built.problems)}`);
  }
  return built.intent;
};

describe('a filled form becomes the intent it was issued for', () => {
  it('reproduces every one of the eleven intent fixtures exactly', () => {
    for (const type of OPERATION_TYPES) {
      expect(intentFrom(type), type).toEqual(INTENT_SAMPLES[type]);
    }
  });

  it('turns a subject code on the form into the region ordinal in the intent', () => {
    // The form carries `95`; the intent carries ordinal 20. They differ for 50
    // of the 98 regions and Chechnya is one of them, so a form that passed its
    // number straight through would be visible here.
    const intent = intentFrom('CREATE_MEMBERSHIP_VOTING');
    expect(issuedOperation('CREATE_MEMBERSHIP_VOTING').values.regionSubjectCode).toBe('95');
    expect(intent.type === 'CREATE_MEMBERSHIP_VOTING' && intent.organ.region).toBe(20);
  });

  it('scales a written decimal by the cell’s recorded precision', () => {
    // `12.34` on the form, two decimals in the record, `1234n` in the intent.
    // The scale never appears on the form and never reaches the call.
    const intent = intentFrom('CREATE_NUMERICAL_VALUE_VOTING');
    expect(intent.type === 'CREATE_NUMERICAL_VALUE_VOTING' && intent.value).toBe(1234n);
    expect(intent.type === 'CREATE_NUMERICAL_VALUE_VOTING' && intent.decimals).toBe(2);
  });

  it('refuses the same value against a scale the cell does not hold', () => {
    // The template said two decimals; a member wrote three. Refused rather than
    // rounded, because a rounded governance value is one nobody chose.
    const form = filledForm('CREATE_NUMERICAL_VALUE_VOTING', {
      [inputFieldName('value')]: '12.345',
    });
    const assembled = assembleFormInput(form, issuedOperation('CREATE_NUMERICAL_VALUE_VOTING'));
    expect(assembled.kind).toBe('INPUT');
    const built = buildIntent('CREATE_NUMERICAL_VALUE_VOTING', {
      ...(assembled.kind === 'INPUT' ? assembled.input : {}),
    });
    expect(built.kind).toBe('PROBLEMS');
    expect(built.kind === 'PROBLEMS' && built.problems.map((problem) => problem.field)).toEqual([
      'value',
    ]);
  });

  it('maps a radio value to a direction and never infers one from text', () => {
    const forDirection = intentFrom('CAST_VOTE');
    expect(forDirection.type === 'CAST_VOTE' && forDirection.direction).toBe('FOR');

    const against = assembleFormInput(
      filledForm('CAST_VOTE', { [inputFieldName('support')]: 'AGAINST' }),
      issuedOperation('CAST_VOTE'),
    );
    const built = buildIntent('CAST_VOTE', against.kind === 'INPUT' ? against.input : {});
    expect(built.kind === 'INTENT' && built.intent.type === 'CAST_VOTE' && built.intent.direction).toBe(
      'AGAINST',
    );

    // Anything else is refused. No sentiment, no case folding, no near-miss.
    for (const written of ['yes', 'For', 'да', 'true', '1']) {
      const edited = assembleFormInput(
        filledForm('CAST_VOTE', { [inputFieldName('support')]: written }),
        issuedOperation('CAST_VOTE'),
      );
      const result = buildIntent('CAST_VOTE', edited.kind === 'INPUT' ? edited.input : {});
      expect(result.kind, written).toBe('PROBLEMS');
    }
  });
});

describe('the whole pipeline, form to calls', () => {
  it('produces contract calls for all eleven, and never executeVoting', () => {
    // End to end within the deterministic half: fields, intake, validation,
    // dispatch. The transaction layer is the only thing after this.
    const functions = OPERATION_TYPES.flatMap((type) =>
      callsForIntent(intentFrom(type)).map((call) => call.fn),
    );
    expect(functions).not.toContain('executeVoting');
    // Eleven intents, thirteen calls: thresholds expands to three.
    expect(functions).toHaveLength(13);
  });

  it('cannot be steered to a function a form named', () => {
    // There is no field that carries a function name, so there is nothing to
    // tamper with. The assertion is that adding one changes nothing.
    const form = filledForm('CAST_VOTE', {
      'zarya.input.functionName': 'transferChairmanship',
    });
    const assembled = assembleFormInput(form, issuedOperation('CAST_VOTE'));
    // Refused for the unknown field — and even the refusal path has no way to
    // reach a call.
    expect(assembled.kind).toBe('REFUSED');
  });
});
