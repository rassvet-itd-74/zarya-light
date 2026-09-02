import { type AbiFunction, decodeFunctionData, getAbiItem } from 'viem';
import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../domain/intents/intent';
import {
  ZARYA_WRITE_FUNCTIONS,
  type ZaryaWriteCall,
  callsForIntent,
} from '../../domain/intents/intentCalls';
import {
  INTENT_SAMPLES,
  SAMPLE_AUTHOR,
  SAMPLE_MEMBER,
  SAMPLE_SOVIET,
} from '../../domain/intents/testing/intentSamples';
import { partyOrganIdentifier } from '../../domain/organs/partyOrgan';
import {
  type OrganResolver,
  OrganIdentifierMismatchError,
} from '../../domain/ports/OrganResolver';
import { type Bytes32, bytes32 } from '../../domain/primitives';
import { encodeWriteCall } from './writeCallData';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * What the encoder actually has to get right is **argument order**, and no type
 * checks it: `createStatementVoting(bool, uint256 x, uint256 y, string, uint256)`
 * takes two `uint256` in a row, so a swap encodes cleanly and addresses a
 * different cell.
 *
 * So these tests decode the calldata back through the same ABI and compare
 * argument *names* to values. A positional expectation would restate the bug.
 */

const ORGAN: Bytes32 = bytes32(
  '0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5',
);

const resolver = (overrides: Partial<OrganResolver> = {}): OrganResolver => ({
  resolve: async (triple) => ({ triple, organ: ORGAN, identifier: partyOrganIdentifier(triple) }),
  label: () => undefined,
  tripleOf: () => undefined,
  ...overrides,
});

/** The decoded call as `{ argumentName: value }`, per the ABI's own input names. */
function decodeByName(data: `0x${string}`): { fn: string; args: Record<string, unknown> } {
  const { functionName, args = [] } = decodeFunctionData({ abi: ZARYA_ABI, data });
  const item = getAbiItem({ abi: ZARYA_ABI, name: functionName }) as AbiFunction;
  const named: Record<string, unknown> = {};
  item.inputs.forEach((input, index) => {
    named[input.name ?? `#${index}`] = (args as readonly unknown[])[index];
  });
  return { fn: functionName, args: named };
}

const encodeOne = async (call: ZaryaWriteCall, organs: OrganResolver = resolver()) => {
  const encoded = await encodeWriteCall(call, organs);
  if (encoded.kind !== 'DATA') throw new Error(`expected calldata, got ${encoded.reason}`);
  return decodeByName(encoded.data);
};

const only = async (type: (typeof OPERATION_TYPES)[number]) =>
  encodeOne(callsForIntent(INTENT_SAMPLES[type])[0]);

describe('the allow list matches the ABI', () => {
  it('names only functions the contract declares, and none of them view', () => {
    // A name that drifted out of the ABI would fail at encode time as
    // NOT_ENCODABLE — a runtime symptom for a static mistake. This is where it
    // should show up instead.
    for (const fn of ZARYA_WRITE_FUNCTIONS) {
      const item = getAbiItem({ abi: ZARYA_ABI, name: fn }) as AbiFunction | undefined;
      expect(item, fn).toBeDefined();
      expect(item?.stateMutability, fn).not.toBe('view');
      expect(item?.stateMutability, fn).not.toBe('pure');
    }
  });
});

describe('every arm encodes', () => {
  it('produces calldata for all thirteen write calls', async () => {
    const encoded = new Set<string>();
    for (const type of OPERATION_TYPES) {
      for (const call of callsForIntent(INTENT_SAMPLES[type])) {
        encoded.add((await encodeOne(call)).fn);
      }
    }
    // The sweep is what discharges the organ list: an arm that used `organ`
    // without `organOfCall` naming it would pass `undefined` for a bytes32,
    // viem would refuse it, and `encodeOne` would throw here.
    expect([...encoded].sort()).toEqual([...ZARYA_WRITE_FUNCTIONS].sort());
  });
});

describe('the organ triple becomes a bytes32 only through the resolver', () => {
  it('sends the hash the contract itself produced', async () => {
    const { args } = await only('CREATE_MEMBERSHIP_VOTING');
    expect(args.organ).toBe(ORGAN);
  });

  it('reports an unreadable organ as retryable and never as a refusal', async () => {
    const organs = resolver({
      resolve: async () => {
        throw new Error('rpc down');
      },
    });
    const encoded = await encodeWriteCall(
      callsForIntent(INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING)[0],
      organs,
    );
    expect(encoded).toMatchObject({ kind: 'UNAVAILABLE', reason: 'ORGAN_UNREADABLE' });
    // The identifier is named so the log says which organ, and the transport
    // error is kept so the reason is not invented.
    expect(encoded.kind === 'UNAVAILABLE' && encoded.detail).toContain('95.');
  });

  it('keeps an identifier mismatch apart from an outage', async () => {
    // Different retry behavior: an outage is reconcile-later, a mismatch
    // repeats exactly and means the region table or the deployment is wrong.
    const organs = resolver({
      resolve: async (triple) => {
        throw new OrganIdentifierMismatchError(triple, '95.СОВ', '20.СОВ');
      },
    });
    const encoded = await encodeWriteCall(
      callsForIntent(INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING)[0],
      organs,
    );
    expect(encoded).toMatchObject({ kind: 'UNAVAILABLE', reason: 'ORGAN_MISMATCH' });
  });

  it('does not resolve anything for a call that takes no organ', async () => {
    let resolutions = 0;
    const organs = resolver({
      resolve: async (triple) => {
        resolutions += 1;
        return { triple, organ: ORGAN, identifier: partyOrganIdentifier(triple) };
      },
    });
    await encodeWriteCall(callsForIntent(INTENT_SAMPLES.CREATE_THEME_VOTING)[0], organs);
    await encodeWriteCall(callsForIntent(INTENT_SAMPLES.CAST_VOTE)[0], organs);
    await encodeWriteCall(callsForIntent(INTENT_SAMPLES.TRANSFER_CHAIRMANSHIP)[0], organs);
    expect(resolutions).toBe(0);
  });
});

describe('argument order, by name', () => {
  it('membership proposals', async () => {
    expect(await only('CREATE_MEMBERSHIP_VOTING')).toEqual({
      fn: 'createMembershipVoting',
      args: { organ: ORGAN, member: SAMPLE_MEMBER, duration: 86_400n },
    });
    expect((await only('CREATE_MEMBERSHIP_REVOCATION_VOTING')).fn).toBe(
      'createMembershipRevocationVoting',
    );
  });

  it('a category proposal keeps x before y and the name after the id', async () => {
    expect(await only('CREATE_CATEGORY_VOTING')).toEqual({
      fn: 'createCategoryVoting',
      args: { organ: ORGAN, x: 3n, y: 7n, category: 5n, categoryName: 'Good', duration: 86_400n },
    });
  });

  it('a decimals proposal sends a uint8', async () => {
    expect(await only('CREATE_DECIMALS_VOTING')).toEqual({
      fn: 'createDecimalsVoting',
      args: { organ: ORGAN, x: 3n, y: 7n, decimals: 2, duration: 86_400n },
    });
  });

  it('a theme proposal sends one coordinate and isCategorical true', async () => {
    expect(await only('CREATE_THEME_VOTING')).toEqual({
      fn: 'createThemeVoting',
      args: { isCategorical: true, x: 3n, theme: 'Жилищный вопрос', duration: 86_400n },
    });
  });

  it('a statement proposal sends both coordinates and isCategorical false', async () => {
    // `x` gates on the theme and the statement lands at `y`. A swap here would
    // check the wrong column and write the wrong row, both without reverting.
    expect(await only('CREATE_STATEMENT_VOTING')).toEqual({
      fn: 'createStatementVoting',
      args: { isCategorical: false, x: 3n, y: 7n, statement: 'Аренда растёт', duration: 86_400n },
    });
  });

  it('a categorical value proposal sends the category as value', async () => {
    expect(await only('CREATE_CATEGORICAL_VALUE_VOTING')).toEqual({
      fn: 'createCategoricalValueVoting',
      args: {
        organ: ORGAN,
        x: 3n,
        y: 7n,
        value: 5n,
        valueAuthor: SAMPLE_AUTHOR,
        duration: 86_400n,
      },
    });
  });

  it('a numerical value proposal sends the scaled integer and no scale', async () => {
    const { args } = await only('CREATE_NUMERICAL_VALUE_VOTING');
    // 12.34 against a two-decimal cell. The 2 is not in the call at all.
    expect(args).toEqual({
      organ: ORGAN,
      x: 3n,
      y: 7n,
      value: 1234n,
      valueAuthor: SAMPLE_AUTHOR,
      duration: 86_400n,
    });
    expect(args).not.toHaveProperty('decimals');
  });

  it('a vote sends two arguments, and FOR is the only thing that is true', async () => {
    expect(await only('CAST_VOTE')).toEqual({
      fn: 'castVote',
      args: { votingId: 7n, support: true },
    });
    const against = await encodeOne({ fn: 'castVote', votingId: 7n, direction: 'AGAINST' } as
      ZaryaWriteCall);
    expect(against.args).toEqual({ votingId: 7n, support: false });
  });

  it('chairmanship transfer sends only the new chairman', async () => {
    expect(await only('TRANSFER_CHAIRMANSHIP')).toEqual({
      fn: 'transferChairmanship',
      args: { newChairman: SAMPLE_MEMBER },
    });
  });
});

describe('the three threshold setters', () => {
  it('each send the target organ and one value, in the dispatcher’s order', async () => {
    const calls = callsForIntent(INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS);
    const encoded = [];
    for (const call of calls) encoded.push(await encodeOne(call));

    expect(encoded).toEqual([
      { fn: 'setMinimumQuorum', args: { organ: ORGAN, value: 3n } },
      { fn: 'setMinimumApprovalPercentage', args: { organ: ORGAN, value: 6600n } },
      { fn: 'setMinimumApprovalPercentageBase', args: { organ: ORGAN, value: 10_000n } },
    ]);
  });

  it('resolves the same organ for all three', async () => {
    const seen: string[] = [];
    const organs = resolver({
      resolve: async (triple) => {
        seen.push(partyOrganIdentifier(triple));
        return { triple, organ: ORGAN, identifier: partyOrganIdentifier(triple) };
      },
    });
    for (const call of callsForIntent(INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS)) {
      await encodeWriteCall(call, organs);
    }
    expect(seen).toEqual([
      partyOrganIdentifier(SAMPLE_SOVIET),
      partyOrganIdentifier(SAMPLE_SOVIET),
      partyOrganIdentifier(SAMPLE_SOVIET),
    ]);
  });
});

describe('an argument the ABI will not take', () => {
  it('is UNAVAILABLE rather than an exception', async () => {
    // A uint64 value overflowing is caught at validation, not here — this is the
    // backstop for the case validation missed, and it must not throw into a
    // caller that is deciding whether to sign.
    const encoded = await encodeWriteCall(
      {
        fn: 'createNumericalValueVoting',
        organ: SAMPLE_SOVIET,
        at: { x: 3n, y: 7n },
        value: 1n << 70n,
        valueAuthor: SAMPLE_AUTHOR,
        duration: 86_400,
      },
      resolver(),
    );
    expect(encoded).toMatchObject({ kind: 'UNAVAILABLE', reason: 'NOT_ENCODABLE' });
  });
});
