import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../domain/intents/intent';
import { chainId, evmAddress, operationRef } from '../../domain/primitives';
import { FormTemplateWriter } from './formTemplateWriter';
import { CONTEXT_FIELDS, FIELD_PLAN, ORGAN_KEYS } from './formSchema';
import type { TemplateAssets } from './issueTemplate';

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

const writer = new FormTemplateWriter(ASSETS);

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};

describe('what each operation needs before it can be issued', () => {
  it('is derived from the field plan, for all eleven', () => {
    // Derived rather than restated: a use case with its own table of "does this
    // operation have an organ" would be a second list to fall out of step.
    for (const type of OPERATION_TYPES) {
      const { bound } = FIELD_PLAN[type];
      const requirements = writer.requirements(type);

      expect(requirements.organ, type).toBe(ORGAN_KEYS.some((key) => bound.includes(key)));
      expect(requirements.votingId, type).toBe(bound.includes('votingId'));
    }
  });

  it('needs an organ for seven of them and none for four', () => {
    // Each of the four has its own reason, and none of them is an omission:
    // theme and statement votings take `bool isCategorical` instead and anyone
    // may vote on them; `CAST_VOTE` reads the governing organ from the voting,
    // so a form asking for one would ask a member to choose something that
    // cannot be honoured; chairmanship transfer has no organ at all.
    expect(OPERATION_TYPES.filter((type) => !writer.requirements(type).organ)).toEqual([
      'CREATE_THEME_VOTING',
      'CREATE_STATEMENT_VOTING',
      'CAST_VOTE',
      'TRANSFER_CHAIRMANSHIP',
    ]);
    expect(OPERATION_TYPES.filter((type) => writer.requirements(type).organ)).toHaveLength(7);
  });

  it('needs a voting number for the vote and nothing else', () => {
    expect(OPERATION_TYPES.filter((type) => writer.requirements(type).votingId)).toEqual([
      'CAST_VOTE',
    ]);
  });
});

describe('the one operation that cannot be issued, and why', () => {
  it('names `decimals` as unavailable on a numerical value proposal', () => {
    // `FIELD_PLAN` says this `decimals` is bound — "the scale the cell had when
    // the template was issued" — while listing that same operation's `x` and `y`
    // as member-filled. Both statements are in the same file and they cannot both
    // hold: at issuance there is no cell, so there is no scale to record.
    expect(writer.requirements('CREATE_NUMERICAL_VALUE_VOTING').unavailableBoundKeys).toEqual([
      'decimals',
    ]);
  });

  it('reports nothing unavailable for the other ten', () => {
    // If this ever fails, a bound value was added that issuance cannot supply —
    // which is a schema decision, not a bug to patch here.
    const blocked = OPERATION_TYPES.filter(
      (type) => writer.requirements(type).unavailableBoundKeys.length > 0,
    );

    expect(blocked).toEqual(['CREATE_NUMERICAL_VALUE_VOTING']);
  });
});

describe('issuing', () => {
  it('returns the printed context keyed by field name, for the record to keep', async () => {
    // The caller stores this without knowing that `zarya.context.organ` exists,
    // and it is the only thing a tamper check can compare a returned file to.
    const issued = await writer.issue({
      operationType: 'CREATE_MEMBERSHIP_VOTING',
      operationRef: operationRef('zar-test-1'),
      context: { ...DEPLOYMENT, organIdentifier: '95.СОВ-7' },
    });

    expect(issued.displayedContext).toEqual({
      [CONTEXT_FIELDS.chainId]: '11155111',
      [CONTEXT_FIELDS.contract]: DEPLOYMENT.contractAddress,
      [CONTEXT_FIELDS.organ]: '95.СОВ-7',
    });
    expect(issued.bytes.byteLength).toBeGreaterThan(0);
    expect(issued.fieldNames).toContain('zarya.meta.operationRef');
  });

  it('omits the organ field entirely for an operation that has none', async () => {
    // A blank field for a value that cannot exist is a field a reader has to
    // interpret.
    const issued = await writer.issue({
      operationType: 'CREATE_THEME_VOTING',
      operationRef: operationRef('zar-test-2'),
      context: DEPLOYMENT,
    });

    expect(issued.displayedContext).not.toHaveProperty(CONTEXT_FIELDS.organ);
  });

  it('refuses to print a form with a context value missing', async () => {
    // `USE_CASES.md`, issuance row 6: a template with blank context is worse than
    // no template, because it looks complete.
    await expect(
      writer.issue({
        operationType: 'CREATE_MEMBERSHIP_VOTING',
        operationRef: operationRef('zar-test-3'),
        context: DEPLOYMENT,
      }),
    ).rejects.toThrow('needs a value for');
  });
});
