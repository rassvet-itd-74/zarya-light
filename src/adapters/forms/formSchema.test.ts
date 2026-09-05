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
  resolvedKeysFor,
  templateFieldNames,
} from './formSchema';
import { filledForm, issuedOperation, resolvedValues } from './testing/formSamples';

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

/**
 * The complete input ingestion would produce, without going through it.
 *
 * All three provenances, from the three sources that own them: the form, the
 * operation record, and the chain read. Assembling it here from the plan is what
 * makes the coverage test below meaningful — if a category were left out, every
 * key in it would look like one the builder reads and the plan does not supply.
 */
const completeInput = (operationType: OperationType): Record<string, string> => {
  const form = filledForm(operationType);
  const issued = issuedOperation(operationType);
  const resolved = resolvedValues(operationType);
  const input: Record<string, string> = {};
  for (const key of FIELD_PLAN[operationType].input) input[key] = form[inputFieldName(key)];
  for (const key of FIELD_PLAN[operationType].bound) input[key] = issued.values[key];
  for (const key of FIELD_PLAN[operationType].resolved) input[key] = resolved[key];
  return input;
};

describe('the plan covers what the intent builder reads', () => {
  it('provides every key the builder touches, for all eleven operations', () => {
    for (const type of OPERATION_TYPES) {
      const planned = new Set([
        ...FIELD_PLAN[type].input,
        ...FIELD_PLAN[type].bound,
        ...FIELD_PLAN[type].resolved,
      ]);
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

  it('resolves the cell scale on a numerical value proposal and only there', () => {
    // The scale is a property of the *cell*, read at import for the coordinate
    // the member wrote. It is not bound — at issuance there is no cell — and not
    // member-filled, because a form allowed to state it could submit a number a
    // hundred times too small and the contract has no argument to notice with.
    expect(FIELD_PLAN.CREATE_NUMERICAL_VALUE_VOTING.resolved).toEqual(['decimals']);
    expect(FIELD_PLAN.CREATE_NUMERICAL_VALUE_VOTING.bound).not.toContain('decimals');
    expect(FIELD_PLAN.CREATE_NUMERICAL_VALUE_VOTING.input).not.toContain('decimals');
    // On a decimals *proposal* the same key is the thing being proposed.
    expect(FIELD_PLAN.CREATE_DECIMALS_VOTING.input).toContain('decimals');
    expect(FIELD_PLAN.CREATE_DECIMALS_VOTING.bound).not.toContain('decimals');
    expect(FIELD_PLAN.CREATE_DECIMALS_VOTING.resolved).toEqual([]);
  });

  it('resolves nothing anywhere else', () => {
    // Ten empty and one populated, asserted as a whole. A second resolved key
    // means a second chain read in ingestion, which is a decision to make
    // deliberately rather than to discover.
    const resolving = OPERATION_TYPES.filter((type) => FIELD_PLAN[type].resolved.length > 0);
    expect(resolving).toEqual(['CREATE_NUMERICAL_VALUE_VOTING']);
    expect(resolvedKeysFor('CREATE_MEMBERSHIP_VOTING')).toEqual([]);
  });

  it('binds the voting number on a vote, leaving only the direction to a human', () => {
    expect(FIELD_PLAN.CAST_VOTE).toEqual({
      input: ['support'],
      bound: ['votingId'],
      resolved: [],
    });
  });

  it('asks for no signer anywhere', () => {
    // One wallet, one serialized write queue. A field for it would ask a member
    // to choose something that cannot be honoured.
    expect(ALL_INPUT_FIELD_NAMES).not.toContain(inputFieldName('signer'));
  });

  it('keeps the three categories disjoint', () => {
    // A key in two categories has two provenances, and which one wins would be
    // decided by whichever loop ran last in `assembleFormInput`.
    for (const type of OPERATION_TYPES) {
      const { input, bound, resolved } = FIELD_PLAN[type];
      const all = [...input, ...bound, ...resolved];
      expect(new Set(all).size, `${type} lists a key twice`).toBe(all.length);
    }
  });

  it('binds only keys issuance can actually supply', () => {
    // The invariant that used to be discovered at runtime, by
    // `unavailableBoundKeys` returning `decimals` and refusing the issuance. It
    // is checked here instead, so a bound key with no issuance-time source fails
    // the suite rather than one operation type in the app.
    const availableAtIssuance = new Set([...ORGAN_KEYS, 'votingId']);
    for (const type of OPERATION_TYPES) {
      for (const key of FIELD_PLAN[type].bound) {
        expect(availableAtIssuance, `${type} binds ${key}, which issuance cannot know`).toContain(
          key,
        );
      }
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
  it('carries no receipt or context field, for any operation', () => {
    // The receipt is a stamp drawn on the page and the context block is printed
    // text, so neither is a widget any more. This is the assertion behind the
    // rule a member can see: every box on an issued form is a box for them.
    for (const type of OPERATION_TYPES) {
      const names = templateFieldNames(type);
      for (const fieldName of [...Object.values(RECEIPT_FIELDS), ...Object.values(CONTEXT_FIELDS)]) {
        expect(names, `${type} / ${fieldName}`).not.toContain(fieldName);
      }
    }
  });

  it('is exactly the meta fields plus that operation’s inputs', () => {
    // Named exhaustively rather than by a `toContain` sweep: a field quietly
    // added back is the failure this catches, and `toContain` cannot see one.
    for (const type of OPERATION_TYPES) {
      expect([...templateFieldNames(type)].sort(), type).toEqual(
        [
          ...Object.values(META_FIELDS),
          ...FIELD_PLAN[type].input.map(inputFieldName),
        ].sort(),
      );
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
    // `.2` since 2026-09-06, when the context and receipt namespaces stopped
    // being fields. Every form issued under `.1` is now uningestible, which was
    // affordable because none were in circulation.
    expect(FORM_SCHEMA_VERSION).toBe('zarya.form.2');
  });
});
