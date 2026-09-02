import { describe, expect, it } from 'vitest';
import { buildIntent } from '../../domain/intents/buildIntent';
import type { IntentInput } from '../../domain/intents/fields';
import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import {
  ALL_INPUT_FIELD_NAMES,
  CONTEXT_FIELDS,
  FIELD_PLAN,
  FORM_SCHEMA_VERSION,
  INPUT_PREFIX,
  META_FIELDS,
  ORGAN_KEYS,
  RECEIPT_FIELDS,
  contextFieldsFor,
  domainKeyOf,
  fieldTrust,
  inputFieldName,
  templateFieldNames,
} from './formSchema';
import { filledForm, issuedOperation } from './testing/formSamples';

/**
 * The load-bearing property here is not the spelling of a field name — it is
 * that the plan covers exactly what `buildIntent` reads.
 *
 * A key the builder reads and the plan does not provide is a form that can never
 * be completed, and it would show up as a validation error blaming the member.
 * So the test does not restate the builder's keys: it **observes** them, through
 * a `Proxy` that records every property the builder touches.
 */

const observedKeys = (operationType: OperationType, input: Readonly<Record<string, string>>) => {
  const seen = new Set<string>();
  const probe = new Proxy(input, {
    get(target, property) {
      if (typeof property === 'string') seen.add(property);
      return Reflect.get(target, property) as unknown;
    },
  }) as IntentInput;
  buildIntent(operationType, probe);
  return seen;
};

/** The complete input the assembler would produce, without going through it. */
const completeInput = (operationType: OperationType): Record<string, string> => {
  const form = filledForm(operationType);
  const issued = issuedOperation(operationType);
  const input: Record<string, string> = {};
  for (const key of FIELD_PLAN[operationType].input) input[key] = form[inputFieldName(key)];
  for (const key of FIELD_PLAN[operationType].bound) input[key] = issued.values[key];
  return input;
};

describe('the plan covers what the intent builder reads', () => {
  it('provides every key the builder touches, for all eleven operations', () => {
    for (const type of OPERATION_TYPES) {
      const planned = new Set([...FIELD_PLAN[type].input, ...FIELD_PLAN[type].bound]);
      for (const key of observedKeys(type, completeInput(type))) {
        expect(planned, `${type} reads ${key}`).toContain(key);
      }
    }
  });

  it('builds a valid intent from the plan alone, for all eleven', () => {
    // The other direction: not merely that no key is missing, but that what the
    // plan supplies is enough and acceptable.
    for (const type of OPERATION_TYPES) {
      const result = buildIntent(type, completeInput(type));
      // The message names the problems, not the intent: an intent holds bigints
      // and JSON.stringify refuses them.
      const why = result.kind === 'PROBLEMS' ? JSON.stringify(result.problems) : '';
      expect(result.kind, `${type} ${why}`).toBe('INTENT');
    }
  });

  it('exercises organNumber, which only a local organ reads', () => {
    // The organ triple's keys are read conditionally, so a plan listing all
    // three is only justified if some organ type reads each. This is the one
    // that a regional sample never reaches.
    const local = {
      ...completeInput('CREATE_MEMBERSHIP_VOTING'),
      organType: 'LocalSoviet',
      organNumber: '12',
    };
    expect(observedKeys('CREATE_MEMBERSHIP_VOTING', local)).toContain('organNumber');
    expect(buildIntent('CREATE_MEMBERSHIP_VOTING', local).kind).toBe('INTENT');
  });

  it('reads no region for a global organ, which the plan still lists', () => {
    const chairperson = {
      ...completeInput('CONFIGURE_ORGAN_THRESHOLDS'),
      organType: 'Chairperson',
    };
    const seen = observedKeys('CONFIGURE_ORGAN_THRESHOLDS', chairperson);
    expect(seen).not.toContain('regionSubjectCode');
    expect(seen).not.toContain('organNumber');
  });
});

describe('the bound half is hard rule 4', () => {
  it('never puts an organ key on a form', () => {
    for (const type of OPERATION_TYPES) {
      for (const key of ORGAN_KEYS) {
        expect(FIELD_PLAN[type].input, `${type} must not ask for ${key}`).not.toContain(key);
      }
    }
  });

  it('binds the cell scale on a numerical value proposal and only there', () => {
    // The scale is a property of the cell as it was when the template was
    // issued. A form allowed to state it could submit a number a hundred times
    // too small, and the contract has no argument to notice with.
    expect(FIELD_PLAN.CREATE_NUMERICAL_VALUE_VOTING.bound).toContain('decimals');
    expect(FIELD_PLAN.CREATE_NUMERICAL_VALUE_VOTING.input).not.toContain('decimals');
    // On a decimals *proposal* the same key is the thing being proposed.
    expect(FIELD_PLAN.CREATE_DECIMALS_VOTING.input).toContain('decimals');
    expect(FIELD_PLAN.CREATE_DECIMALS_VOTING.bound).not.toContain('decimals');
  });

  it('binds the voting number on a vote, leaving only the direction to a human', () => {
    expect(FIELD_PLAN.CAST_VOTE).toEqual({ input: ['support'], bound: ['votingId'] });
  });

  it('asks for no signer anywhere', () => {
    // One wallet, one serialized write queue. A field for it would ask a member
    // to choose something that cannot be honoured.
    expect(ALL_INPUT_FIELD_NAMES).not.toContain(inputFieldName('signer'));
  });

  it('never lists a key as both filled and bound', () => {
    for (const type of OPERATION_TYPES) {
      const { input, bound } = FIELD_PLAN[type];
      expect(input.filter((key) => bound.includes(key)), type).toEqual([]);
    }
  });
});

describe('field name classification', () => {
  it('sorts every schema field into its namespace', () => {
    expect(fieldTrust(META_FIELDS.schemaVersion)).toBe('META');
    expect(fieldTrust(CONTEXT_FIELDS.organ)).toBe('CONTEXT');
    expect(fieldTrust(RECEIPT_FIELDS.txHash)).toBe('RECEIPT');
    expect(fieldTrust(inputFieldName('member'))).toBe('INPUT');
  });

  it('calls an unrecognised name unknown rather than guessing at it', () => {
    // Never a near-miss to resolve. Each of these is one edit away from a real
    // field name and none of them is one.
    for (const name of [
      'zarya.Input.member',
      'zarya.input',
      'zarya.meta.operationtype',
      'zarya.contexts.organ',
      'member',
      '',
    ]) {
      expect(fieldTrust(name), name).toBe('UNKNOWN');
    }
  });

  it('recovers the domain key from an input name and nothing else', () => {
    expect(domainKeyOf(inputFieldName('valueAuthor'))).toBe('valueAuthor');
    expect(domainKeyOf(META_FIELDS.operationRef)).toBeUndefined();
  });

  it('keeps the four namespaces disjoint', () => {
    const all = [
      ...Object.values(META_FIELDS),
      ...Object.values(CONTEXT_FIELDS),
      ...Object.values(RECEIPT_FIELDS),
      ...ALL_INPUT_FIELD_NAMES,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const name of [...Object.values(META_FIELDS), ...Object.values(CONTEXT_FIELDS)]) {
      expect(name.startsWith(INPUT_PREFIX), name).toBe(false);
    }
  });
});

describe('what a template has to carry', () => {
  it('includes the receipt fields, empty, from the first issuance', () => {
    // Retrofitting them later invalidates every form already handed out.
    for (const type of OPERATION_TYPES) {
      for (const fieldName of Object.values(RECEIPT_FIELDS)) {
        expect(templateFieldNames(type), type).toContain(fieldName);
      }
    }
  });

  it('names a voting only on a vote form, and an organ only where one is bound', () => {
    // A blank context field is one a reader has to interpret.
    expect(contextFieldsFor('CAST_VOTE')).toContain(CONTEXT_FIELDS.votingId);
    expect(contextFieldsFor('CREATE_MEMBERSHIP_VOTING')).not.toContain(CONTEXT_FIELDS.votingId);
    expect(contextFieldsFor('CREATE_MEMBERSHIP_VOTING')).toContain(CONTEXT_FIELDS.organ);
    // Theme and statement proposals send no organ at all.
    expect(contextFieldsFor('CREATE_THEME_VOTING')).not.toContain(CONTEXT_FIELDS.organ);
  });

  it('has no duplicate field names, for any operation', () => {
    for (const type of OPERATION_TYPES) {
      const names = templateFieldNames(type);
      expect(new Set(names).size, type).toBe(names.length);
    }
  });

  it('pins the schema version, because bumping it invalidates issued forms', () => {
    expect(FORM_SCHEMA_VERSION).toBe('zarya.form.1');
  });
});
