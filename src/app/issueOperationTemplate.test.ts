import { describe, expect, it, vi } from 'vitest';
import type { OperationType } from '../domain/intents/intent';
import { partyOrganTriple } from '../domain/organs/partyOrgan';
import type { FileSink } from '../domain/ports/FileSink';
import type { NewOperationRecord, OperationStore } from '../domain/ports/OperationStore';
import { OrganIdentifierMismatchError, type OrganResolver } from '../domain/ports/OrganResolver';
import type { ContextRequirements, TemplateWriter } from '../domain/ports/TemplateWriter';
import { bytes32, chainId, evmAddress } from '../domain/primitives';
import { SequentialIdGenerator } from '../adapters/platform/cryptoIdGenerator';
import { issueOperationTemplate } from './issueOperationTemplate';

/**
 * The first use case that changes anything, so the tests are mostly about
 * **order** — the one property no test of a single component could hold.
 */

const DEPLOYMENT = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};

/** Chechnya: ordinal 20, subject code 95. The pair that differs. */
const CHECHNYA_LOCAL = partyOrganTriple({ organType: 'LocalSoviet', region: 20, number: 7 });

const requirements = (over: Partial<ContextRequirements> = {}): ContextRequirements => ({
  organ: true,
  votingId: false,
  unavailableBoundKeys: [],
  ...over,
});

interface Harness {
  readonly order: string[];
  readonly records: NewOperationRecord[];
  readonly advanced: string[];
  readonly written: { path: string; bytes: Uint8Array }[];
  readonly deps: Parameters<typeof issueOperationTemplate>[0];
}

const harness = (options: {
  requirements?: ContextRequirements;
  resolve?: OrganResolver['resolve'];
  writeFails?: boolean;
} = {}): Harness => {
  const order: string[] = [];
  const records: NewOperationRecord[] = [];
  const advanced: string[] = [];
  const written: { path: string; bytes: Uint8Array }[] = [];

  const organs: OrganResolver = {
    resolve:
      options.resolve ??
      (async (triple) => {
        order.push('resolve');
        return { triple, organ: bytes32(`0x${'11'.repeat(32)}`), identifier: '95.СОВ-7' };
      }),
    label: () => undefined,
    tripleOf: () => undefined,
  };

  const store: OperationStore = {
    record: async (record) => {
      order.push('record');
      records.push(record);
    },
    find: async () => undefined,
    advance: async (ref, state) => {
      order.push(`advance:${state}`);
      advanced.push(`${ref}:${state}`);
    },
    // Import's half of the port. Issuance never reaches either, and a throw
    // rather than a no-op is what would say so if it ever did.
    findByIdentity: async () => {
      throw new Error('issuance does not dedup');
    },
    recordReturn: async () => {
      throw new Error('issuance does not import');
    },
    formBytes: async () => {
      throw new Error('issuance does not read returned forms');
    },
    listByState: async () => [],
  };

  const templates: TemplateWriter = {
    requirements: () => options.requirements ?? requirements(),
    issue: async (command) => {
      order.push('issue');
      return {
        bytes: new Uint8Array([1, 2, 3]),
        fieldNames: ['zarya.meta.operationRef', 'zarya.input.member'],
        displayedContext: {
          'zarya.context.chainId': String(command.context.chainId),
          'zarya.context.contract': command.context.contractAddress,
          ...(command.context.organIdentifier === undefined
            ? {}
            : { 'zarya.context.organ': command.context.organIdentifier }),
        },
      };
    },
  };

  const files: FileSink = {
    write: async (path, bytes) => {
      order.push('write');
      if (options.writeFails === true) throw new Error('EACCES: permission denied');
      written.push({ path, bytes });
    },
  };

  return {
    order,
    records,
    advanced,
    written,
    deps: { organs, store, templates, files, ids: new SequentialIdGenerator(), deployment: DEPLOYMENT },
  };
};

const request = (over: Record<string, unknown> = {}) => ({
  operationType: 'CREATE_MEMBERSHIP_VOTING' as OperationType,
  organ: CHECHNYA_LOCAL,
  targetPath: '/tmp/form.pdf',
  ...over,
});

describe('the order of operations', () => {
  it('resolves, builds, records, writes, then marks it emitted', async () => {
    const h = harness();
    const outcome = await issueOperationTemplate(h.deps, request());

    expect(outcome.kind).toBe('ISSUED');
    expect(h.order).toEqual(['resolve', 'issue', 'record', 'write', 'advance:EMITTED']);
  });

  it('records before the file exists, which is the whole reason the store exists', async () => {
    // An operationRef printed on a file that no row resolves is a form the
    // application cannot bind — so ingestion would have to fall back to the
    // file's own values, which hard rule 4 forbids.
    const h = harness();
    await issueOperationTemplate(h.deps, request());

    expect(h.order.indexOf('record')).toBeLessThan(h.order.indexOf('write'));
  });

  it('leaves the row RECORDED when the write fails, never EMITTED', async () => {
    // The crash window working as designed: RECORDED means recorded and not
    // handed over, which is exactly true here.
    const h = harness({ writeFails: true });

    await expect(issueOperationTemplate(h.deps, request())).rejects.toThrow('EACCES');
    expect(h.records).toHaveLength(1);
    expect(h.advanced).toEqual([]);
  });

  it('stores what the template printed, not a second rendering of it', async () => {
    // The context map exists to be compared against a returned file. Two
    // compositions of the same values could differ, and a tamper check between
    // them would report a forgery whenever one changed.
    const h = harness();
    await issueOperationTemplate(h.deps, request());

    expect(h.records[0].displayedContext).toEqual({
      'zarya.context.chainId': '11155111',
      'zarya.context.contract': DEPLOYMENT.contractAddress,
      'zarya.context.organ': '95.СОВ-7',
    });
  });

  it('records the deployment, so a form cannot bind against the other one', async () => {
    const h = harness();
    await issueOperationTemplate(h.deps, request());

    expect(h.records[0]).toMatchObject({
      chainId: DEPLOYMENT.chainId,
      contractAddress: DEPLOYMENT.contractAddress,
    });
  });
});

describe('the bound values', () => {
  it('store the region as a subject code, never as an ordinal', async () => {
    // Chechnya is ordinal 20 and code 95. An ordinal written here would bind to
    // a *different real region* when the form comes back, and nothing would say
    // so — the two differ for 50 of 98 regions.
    const h = harness();
    await issueOperationTemplate(h.deps, request());

    expect(h.records[0].boundValues).toEqual({
      organType: 'LocalSoviet',
      regionSubjectCode: '95',
      organNumber: '7',
    });
  });

  it('omit the keys an organ’s scope does not use', async () => {
    // `buildIntent`'s reader asks for a region only for a scoped type and a
    // number only for a local one. A normalized zero written for the others
    // could be read as a real region 0, which is Adygea.
    const h = harness();
    await issueOperationTemplate(
      h.deps,
      request({ organ: partyOrganTriple({ organType: 'CentralSoviet' }) }),
    );

    expect(h.records[0].boundValues).toEqual({ organType: 'CentralSoviet' });
  });

  it('carry a regional organ’s region but not a number', async () => {
    const h = harness();
    await issueOperationTemplate(
      h.deps,
      request({ organ: partyOrganTriple({ organType: 'RegionalSoviet', region: 20 }) }),
    );

    expect(h.records[0].boundValues).toEqual({
      organType: 'RegionalSoviet',
      regionSubjectCode: '95',
    });
  });

  it('carry the voting id for a vote and for nothing else', async () => {
    const voting = harness({ requirements: requirements({ organ: false, votingId: true }) });
    await issueOperationTemplate(
      voting.deps,
      request({ operationType: 'CAST_VOTE', organ: undefined, votingId: '7' }),
    );
    expect(voting.records[0].boundValues).toEqual({ votingId: '7' });

    // A voting id supplied where the operation has none is not recorded.
    const membership = harness();
    await issueOperationTemplate(membership.deps, request({ votingId: '7' }));
    expect(membership.records[0].boundValues).not.toHaveProperty('votingId');
  });
});

describe('what is refused, and refused before anything is written', () => {
  const expectNothingHappened = (h: Harness) => {
    expect(h.records).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.advanced).toEqual([]);
  };

  it('an operation that needs an organ and was given none', async () => {
    const h = harness();
    const outcome = await issueOperationTemplate(h.deps, request({ organ: undefined }));

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'ORGAN_REQUIRED' });
    expectNothingHappened(h);
  });

  it('an organ supplied for an operation that has none', async () => {
    // Refused rather than dropped: an organ silently ignored would let a member
    // believe a theme voting was scoped to their organ when the contract takes
    // no organ and anyone may vote.
    const h = harness({ requirements: requirements({ organ: false }) });
    const outcome = await issueOperationTemplate(
      h.deps,
      request({ operationType: 'CREATE_THEME_VOTING' }),
    );

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'ORGAN_NOT_APPLICABLE' });
    expectNothingHappened(h);
  });

  it('a vote with no voting named', async () => {
    const h = harness({ requirements: requirements({ organ: false, votingId: true }) });
    const outcome = await issueOperationTemplate(
      h.deps,
      request({ operationType: 'CAST_VOTE', organ: undefined }),
    );

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'VOTING_ID_REQUIRED' });
    expectNothingHappened(h);
  });

  it('a bound value issuance cannot know', async () => {
    // No real operation reports one any more — `CREATE_NUMERICAL_VALUE_VOTING`
    // did, because its `decimals` was bound to a cell whose coordinates the
    // member fills in, and the schema now reads that from the cell at import
    // instead. The stubbed port keeps the guard under test regardless: a future
    // bound key with no issuance-time source is refused with a reason rather
    // than recorded with a guess.
    const h = harness({ requirements: requirements({ unavailableBoundKeys: ['decimals'] }) });
    const outcome = await issueOperationTemplate(
      h.deps,
      request({ operationType: 'CREATE_NUMERICAL_VALUE_VOTING' }),
    );

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'BOUND_VALUE_UNAVAILABLE' });
    expect(outcome.kind === 'REFUSED' && outcome.message).toContain('decimals');
    expectNothingHappened(h);
  });

  it('an organ the contract renders differently from the local mirror', async () => {
    // The signature of an ordinal/code confusion, which otherwise resolves
    // silently to a different real region.
    const h = harness({
      resolve: async () => {
        throw new OrganIdentifierMismatchError(CHECHNYA_LOCAL, '95.СОВ-7', '20.СОВ-7');
      },
    });
    const outcome = await issueOperationTemplate(h.deps, request());

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'ORGAN_MISMATCH' });
    expectNothingHappened(h);
  });
});

describe('an unreachable provider', () => {
  it('propagates rather than becoming a verdict about the organ', async () => {
    // A refusal would tell the user their organ is wrong. It is not: nobody
    // could ask.
    const h = harness({
      resolve: async () => {
        throw new Error('fetch failed');
      },
    });

    await expect(issueOperationTemplate(h.deps, request())).rejects.toThrow('fetch failed');
    expect(h.records).toEqual([]);
  });
});

describe('the reference', () => {
  it('comes from the generator and is what the file is recorded under', async () => {
    const h = harness();
    const outcome = await issueOperationTemplate(h.deps, request());

    expect(outcome).toMatchObject({ kind: 'ISSUED', operationRef: 'zar-test-1' });
    expect(h.records[0].operationRef).toBe('zar-test-1');
    expect(h.advanced).toEqual(['zar-test-1:EMITTED']);
  });

  it('is new on every issuance, so reissuing is not a rewind', async () => {
    const h = harness();
    const first = await issueOperationTemplate(h.deps, request());
    const second = await issueOperationTemplate(h.deps, request());

    expect(first.kind === 'ISSUED' && first.operationRef).not.toBe(
      second.kind === 'ISSUED' && second.operationRef,
    );
  });
});

describe('the file', () => {
  it('is written to the path the caller chose, with the issued bytes', async () => {
    const h = harness();
    await issueOperationTemplate(h.deps, request({ targetPath: '/tmp/chosen.pdf' }));

    expect(h.written).toEqual([{ path: '/tmp/chosen.pdf', bytes: new Uint8Array([1, 2, 3]) }]);
  });

  it('is never asked for before the organ is verified', async () => {
    const write = vi.fn();
    const h = harness({
      resolve: async () => {
        expect(write).not.toHaveBeenCalled();
        throw new OrganIdentifierMismatchError(CHECHNYA_LOCAL, 'a', 'b');
      },
    });
    h.deps.files.write = write;

    await issueOperationTemplate(h.deps, request());
    expect(write).not.toHaveBeenCalled();
  });
});
