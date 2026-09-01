import { describe, expect, it } from 'vitest';
import { regionBySubjectCode } from '../organs/regions';
import { OPERATION_TYPES, type OperationType, supportOf } from './intent';
import { type BuildIntentResult, buildIntent } from './buildIntent';
import type { FieldProblem, IntentInput } from './fields';

/**
 * The narrowest point in the pipeline: arbitrary text above, a closed union of
 * eleven typed operations below.
 */

const CHECHNYA = { subjectCode: '95', ordinal: 20 } as const;
const MEMBER = '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD';
const ZERO = '0x0000000000000000000000000000000000000000';

/** A regional soviet in Chechnya, whose ordinal and subject code differ. */
const SOVIET: IntentInput = {
  organType: 'RegionalSoviet',
  regionSubjectCode: CHECHNYA.subjectCode,
};

const intentOf = (result: BuildIntentResult) => {
  if (result.kind === 'PROBLEMS') {
    throw new Error(`expected an intent, got: ${JSON.stringify(result.problems)}`);
  }
  return result.intent;
};

const problemsOf = (result: BuildIntentResult): readonly FieldProblem[] => {
  if (result.kind === 'PROBLEMS') return result.problems;
  throw new Error('expected problems, got an intent');
};

const fields = (result: BuildIntentResult): string[] =>
  problemsOf(result).map((problem) => problem.field);

const messages = (result: BuildIntentResult): string =>
  problemsOf(result)
    .map((problem) => problem.message)
    .join('\n');

describe('the region a form asks for', () => {
  it('is a subject code, and becomes an ordinal only through the table', () => {
    // The trap: for 50 of 98 regions the two differ, and passing the code where
    // the ordinal belongs addresses a different real region without reverting.
    // Chechnya is code 95 and ordinal 20 — nothing arithmetic connects them.
    const intent = intentOf(
      buildIntent('CREATE_MEMBERSHIP_VOTING', {
        ...SOVIET,
        member: MEMBER,
        duration: '86400',
      }),
    );

    expect(intent.type).toBe('CREATE_MEMBERSHIP_VOTING');
    expect(regionBySubjectCode(CHECHNYA.subjectCode).ordinal).toBe(CHECHNYA.ordinal);
    expect(intent.type === 'CREATE_MEMBERSHIP_VOTING' && intent.organ.region).toBe(
      CHECHNYA.ordinal,
    );
    // Emphatically not the code.
    expect(intent.type === 'CREATE_MEMBERSHIP_VOTING' && intent.organ.region).not.toBe(95);
  });

  it('refuses a number that is not a subject code, including a bare ordinal', () => {
    // "20" is Chechnya's ordinal and is not any region's subject code, so a form
    // carrying an ordinal is refused rather than resolved to something else.
    const result = buildIntent('CREATE_MEMBERSHIP_VOTING', {
      organType: 'RegionalSoviet',
      regionSubjectCode: '20',
      member: MEMBER,
      duration: '86400',
    });

    expect(fields(result)).toEqual(['regionSubjectCode']);
  });

  it('is not read at all for a global organ, whose region the contract ignores', () => {
    const intent = intentOf(
      buildIntent('CREATE_MEMBERSHIP_VOTING', {
        organType: 'Chairperson',
        regionSubjectCode: '74',
        organNumber: '3',
        member: MEMBER,
        duration: '86400',
      }),
    );

    // Normalized away, so a Chairperson organ "in Chelyabinsk" is the
    // Chairperson organ and compares equal to itself.
    expect(intent.type === 'CREATE_MEMBERSHIP_VOTING' && intent.organ).toEqual({
      organType: 'Chairperson',
      region: 0,
      number: 0,
    });
  });

  it('reads a number only for a local organ', () => {
    const local = intentOf(
      buildIntent('CREATE_MEMBERSHIP_VOTING', {
        organType: 'LocalSoviet',
        regionSubjectCode: CHECHNYA.subjectCode,
        organNumber: '12',
        member: MEMBER,
        duration: '86400',
      }),
    );
    expect(local.type === 'CREATE_MEMBERSHIP_VOTING' && local.organ.number).toBe(12);

    // A regional organ's number is ignored by the contract, so it is not read.
    const regional = intentOf(
      buildIntent('CREATE_MEMBERSHIP_VOTING', {
        ...SOVIET,
        organNumber: 'nonsense',
        member: MEMBER,
        duration: '86400',
      }),
    );
    expect(regional.type === 'CREATE_MEMBERSHIP_VOTING' && regional.organ.number).toBe(0);
  });
});

describe('collecting every problem', () => {
  it('reports all bad fields at once, not just the first', () => {
    // A form is filled by someone who then walks away. Two round trips through a
    // human to fix two fields is two round trips too many.
    const result = buildIntent('CREATE_MEMBERSHIP_VOTING', {
      organType: 'NotAnOrgan',
      member: 'nonsense',
      duration: '-5',
    });

    expect(fields(result)).toEqual(['organType', 'member', 'duration']);
  });

  it('reports a missing field distinctly from a blank one', () => {
    const missing = buildIntent('TRANSFER_CHAIRMANSHIP', {});
    const blank = buildIntent('TRANSFER_CHAIRMANSHIP', { newChairman: '   ' });

    expect(messages(missing)).toMatch(/not supplied/);
    expect(messages(blank)).toMatch(/left blank/);
  });
});

describe('addresses', () => {
  it('refuses the zero address where the contract would accept it', () => {
    // valueAuthor is never validated on chain, and a value of 0 authored by
    // 0x00…00 encodes to zero — which get*ValueAtTimestamp reads as *not found*.
    // The write succeeds and the value is invisible.
    const result = buildIntent('CREATE_CATEGORICAL_VALUE_VOTING', {
      ...SOVIET,
      x: '1',
      y: '2',
      category: '3',
      valueAuthor: ZERO,
      duration: '86400',
    });

    expect(fields(result)).toEqual(['valueAuthor']);
  });

  it('accepts a real address and preserves its checksum casing', () => {
    const intent = intentOf(
      buildIntent('TRANSFER_CHAIRMANSHIP', { newChairman: MEMBER }),
    );
    expect(intent.type === 'TRANSFER_CHAIRMANSHIP' && intent.newChairman).toBe(MEMBER);
  });
});

describe('whole numbers', () => {
  it('refuses anything that parses only partially', () => {
    // parseInt('12abc') is 12, and a value that parses partially is how a typo
    // becomes a different proposal. Whitespace *around* a value is not in this
    // list: it is trimmed once, for every field, since a PDF field routinely
    // picks up a trailing space and no governance value is distinguished by one.
    for (const bad of ['12abc', '1.5', '1 2', '0x10', '1e3', '-1', '+1']) {
      expect(fields(buildIntent('CREATE_DECIMALS_VOTING', {
        ...SOVIET,
        x: '1',
        y: '2',
        decimals: bad,
        duration: '86400',
      }))).toEqual(['decimals']);
    }
  });

  it('trims surrounding whitespace, once, for every field', () => {
    const intent = intentOf(
      buildIntent('CREATE_DECIMALS_VOTING', {
        ...SOVIET,
        x: ' 1 ',
        y: '2',
        decimals: '  2',
        duration: '86400 ',
      }),
    );
    expect(intent).toMatchObject({ decimals: 2, at: { x: 1n, y: 2n }, duration: 86400 });
  });

  it('bounds decimals to a uint8', () => {
    expect(fields(buildIntent('CREATE_DECIMALS_VOTING', {
      ...SOVIET,
      x: '1',
      y: '2',
      decimals: '256',
      duration: '86400',
    }))).toEqual(['decimals']);
  });

  it('puts no client ceiling on a coordinate', () => {
    // Nothing reports the matrix size, so a smaller bound would refuse
    // coordinates the chain accepts.
    const huge = ((1n << 256n) - 1n).toString();
    const intent = intentOf(
      buildIntent('CREATE_DECIMALS_VOTING', {
        ...SOVIET,
        x: huge,
        y: '0',
        decimals: '2',
        duration: '86400',
      }),
    );
    expect(intent.type === 'CREATE_DECIMALS_VOTING' && intent.at.x).toBe((1n << 256n) - 1n);
  });
});

describe('free text', () => {
  it('normalizes to NFC so one visible string is one dedup key', () => {
    // й as и + combining breve, which looks identical and compares unequal.
    const decomposed = 'Жильй';
    const intent = intentOf(
      buildIntent('CREATE_THEME_VOTING', {
        matrix: 'CATEGORICAL',
        x: '1',
        theme: decomposed,
        duration: '86400',
      }),
    );

    expect(intent.type === 'CREATE_THEME_VOTING' && intent.theme).toBe(decomposed.normalize('NFC'));
    expect(intent.type === 'CREATE_THEME_VOTING' && intent.theme.length).toBeLessThan(
      decomposed.length,
    );
  });

  it('refuses text-direction overrides, which can make text read as its reverse', () => {
    expect(fields(buildIntent('CREATE_THEME_VOTING', {
      matrix: 'CATEGORICAL',
      x: '1',
      theme: 'Housing‮special',
      duration: '86400',
    }))).toEqual(['theme']);
  });

  it('refuses control characters', () => {
    expect(fields(buildIntent('CREATE_THEME_VOTING', {
      matrix: 'CATEGORICAL',
      x: '1',
      theme: 'Housing ',
      duration: '86400',
    }))).toEqual(['theme']);
  });

  it('bounds length after normalization', () => {
    expect(fields(buildIntent('CREATE_THEME_VOTING', {
      matrix: 'CATEGORICAL',
      x: '1',
      theme: 'x'.repeat(201),
      duration: '86400',
    }))).toEqual(['theme']);
  });
});

describe('casting a vote', () => {
  it('maps an explicit direction to the boolean, never sentiment', () => {
    const yes = intentOf(buildIntent('CAST_VOTE', { votingId: '7', support: 'FOR' }));
    const no = intentOf(buildIntent('CAST_VOTE', { votingId: '7', support: 'AGAINST' }));

    expect(yes.type === 'CAST_VOTE' && supportOf(yes.direction)).toBe(true);
    expect(no.type === 'CAST_VOTE' && supportOf(no.direction)).toBe(false);
  });

  it('refuses anything but the two export values, without fuzzy matching', () => {
    // No case folding and no near-miss resolution. `zarya-pdf-forms` refuses to
    // fuzzy-match a field name; this refuses to fuzzy-match a field value.
    for (const bad of ['for', 'yes', 'Y', 'TRUE', 'FOR AGAINST', 'SUPPORT']) {
      expect(fields(buildIntent('CAST_VOTE', { votingId: '7', support: bad }))).toEqual(['support']);
    }
  });

  it('refuses voting 0 rather than spending a call that can only revert', () => {
    expect(fields(buildIntent('CAST_VOTE', { votingId: '0', support: 'FOR' }))).toEqual(['votingId']);
  });

  it('has no organ field, and ignores one if a form carries it', () => {
    // castVote takes only (votingId, support); the organ comes from the voting.
    const intent = intentOf(
      buildIntent('CAST_VOTE', { votingId: '7', support: 'FOR', organType: 'RegionalSoviet' }),
    );
    expect(Object.keys(intent).sort()).toEqual(['direction', 'type', 'voting']);
  });
});

describe('numerical values', () => {
  it('scales by the decimals the template captured', () => {
    const intent = intentOf(
      buildIntent('CREATE_NUMERICAL_VALUE_VOTING', {
        ...SOVIET,
        x: '1',
        y: '2',
        decimals: '2',
        value: '12.34',
        valueAuthor: MEMBER,
        duration: '86400',
      }),
    );

    expect(intent).toMatchObject({ value: 1234n, decimals: 2 });
  });

  it('refuses a value more precise than the cell, rather than rounding', () => {
    const result = buildIntent('CREATE_NUMERICAL_VALUE_VOTING', {
      ...SOVIET,
      x: '1',
      y: '2',
      decimals: '2',
      value: '12.345',
      valueAuthor: MEMBER,
      duration: '86400',
    });

    expect(fields(result)).toEqual(['value']);
    expect(messages(result)).toMatch(/refused rather than rounded/);
  });
});

describe('categorical values', () => {
  it('read the proposed value as a category id, with no decimals field', () => {
    // On a categorical cell the value *is* the category. A decimals field here
    // would invite someone to write 1.5 where only 1 exists.
    const intent = intentOf(
      buildIntent('CREATE_CATEGORICAL_VALUE_VOTING', {
        ...SOVIET,
        x: '1',
        y: '2',
        category: '3',
        valueAuthor: MEMBER,
        duration: '86400',
      }),
    );

    expect(intent).toMatchObject({ category: 3n });
    expect(intent).not.toHaveProperty('decimals');
    expect(intent).not.toHaveProperty('value');
  });
});

describe('threshold configuration', () => {
  const organ = { ...SOVIET };

  it('accepts all three together', () => {
    const intent = intentOf(
      buildIntent('CONFIGURE_ORGAN_THRESHOLDS', {
        ...organ,
        quorum: '10',
        approvalPercentage: '6600',
        approvalPercentageBase: '10000',
      }),
    );

    expect(intent).toMatchObject({
      quorum: 10n,
      approvalPercentage: 6600n,
      approvalPercentageBase: 10000n,
    });
  });

  it('refuses a configuration that would succeed and change nothing', () => {
    // A zero base makes the contract discard all three and fall back to
    // simpleMajority. Two transactions succeed, nothing changes, and no getter
    // exists to notice.
    const result = buildIntent('CONFIGURE_ORGAN_THRESHOLDS', {
      ...organ,
      quorum: '10',
      approvalPercentage: '6600',
      approvalPercentageBase: '0',
    });

    expect(fields(result)).toEqual(['approvalPercentageBase']);
    expect(messages(result)).toMatch(/fall back to a simple majority/);
  });

  it('allows an all-zero reset, which is the only way back to the default', () => {
    const intent = intentOf(
      buildIntent('CONFIGURE_ORGAN_THRESHOLDS', {
        ...organ,
        quorum: '0',
        approvalPercentage: '0',
        approvalPercentageBase: '0',
      }),
    );
    expect(intent).toMatchObject({ approvalPercentageBase: 0n });
  });

  it('refuses an approval at or above its base, which no vote can exceed', () => {
    // The comparison is a strict `>` against the base-scaled ratio, so 10000 of
    // 10000 would need more than every vote in favour.
    for (const approval of ['10000', '10001']) {
      expect(fields(buildIntent('CONFIGURE_ORGAN_THRESHOLDS', {
        ...organ,
        quorum: '1',
        approvalPercentage: approval,
        approvalPercentageBase: '10000',
      }))).toEqual(['approvalPercentage']);
    }
  });

  it('keeps basis points as basis points', () => {
    // 50% is 5000 of 10000. Nothing here converts, and a percentage typed by
    // mistake is a hundred times too permissive rather than an error.
    const intent = intentOf(
      buildIntent('CONFIGURE_ORGAN_THRESHOLDS', {
        ...organ,
        quorum: '1',
        approvalPercentage: '5000',
        approvalPercentageBase: '10000',
      }),
    );
    expect(intent).toMatchObject({ approvalPercentage: 5000n });
  });
});

describe('the union is closed', () => {
  it('has a builder for every operation type', () => {
    const required: Record<OperationType, IntentInput> = {
      CREATE_MEMBERSHIP_VOTING: { ...SOVIET, member: MEMBER, duration: '86400' },
      CREATE_MEMBERSHIP_REVOCATION_VOTING: { ...SOVIET, member: MEMBER, duration: '86400' },
      CREATE_CATEGORY_VOTING: {
        ...SOVIET,
        x: '1',
        y: '2',
        category: '3',
        categoryName: 'Good',
        duration: '86400',
      },
      CREATE_DECIMALS_VOTING: { ...SOVIET, x: '1', y: '2', decimals: '2', duration: '86400' },
      CREATE_THEME_VOTING: { matrix: 'CATEGORICAL', x: '1', theme: 'Housing', duration: '86400' },
      CREATE_STATEMENT_VOTING: {
        matrix: 'NUMERICAL',
        x: '1',
        y: '2',
        statement: 'Rents rise',
        duration: '86400',
      },
      CREATE_CATEGORICAL_VALUE_VOTING: {
        ...SOVIET,
        x: '1',
        y: '2',
        category: '3',
        valueAuthor: MEMBER,
        duration: '86400',
      },
      CREATE_NUMERICAL_VALUE_VOTING: {
        ...SOVIET,
        x: '1',
        y: '2',
        decimals: '2',
        value: '1.00',
        valueAuthor: MEMBER,
        duration: '86400',
      },
      CAST_VOTE: { votingId: '7', support: 'FOR' },
      CONFIGURE_ORGAN_THRESHOLDS: {
        ...SOVIET,
        quorum: '1',
        approvalPercentage: '5000',
        approvalPercentageBase: '10000',
      },
      TRANSFER_CHAIRMANSHIP: { newChairman: MEMBER },
    };

    for (const type of OPERATION_TYPES) {
      expect(intentOf(buildIntent(type, required[type])).type).toBe(type);
    }
    expect(OPERATION_TYPES).toHaveLength(11);
  });

  it('has no variant for executing a voting', () => {
    // Not an omission — enforcement. A document must never be able to trigger a
    // mechanical action, and it cannot, because there is nothing to construct.
    expect(OPERATION_TYPES).not.toContain('EXECUTE_VOTING');
  });
});
