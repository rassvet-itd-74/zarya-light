import { describe, expect, it } from 'vitest';
import type { CategoricalCell, NumericalCell } from '../matrix/matrix';
import { bytes32 } from '../primitives';
import { SUGGESTION_TYPES } from '../voting/voting';
import {
  canFailAtApplication,
  categoricalValueWarnings,
  categoryWarnings,
  decimalsWarnings,
  numericalValueWarnings,
  statementWarnings,
} from './applicationPreflight';

const OURS = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const THEIRS = bytes32(`0x${'ab'.repeat(32)}`);

const SET = { kind: 'SET', text: 'Housing' } as const;
const UNSET = { kind: 'UNSET' } as const;

const categoricalCell = (
  overrides: Partial<CategoricalCell> = {},
): CategoricalCell => ({
  binding: { kind: 'BOUND', organ: OURS },
  allowedCategories: [1n, 2n],
  sampleLength: 0n,
  ...overrides,
});

const numericalCell = (overrides: Partial<NumericalCell> = {}): NumericalCell => ({
  binding: { kind: 'BOUND', organ: OURS },
  decimals: 2,
  sampleLength: 0n,
  ...overrides,
});

const codes = (warnings: readonly { code: string }[]): string[] =>
  warnings.map((warning) => warning.code);

describe('which suggestion types can fail while being applied', () => {
  it('names the five that can and the three that cannot', () => {
    // Membership and revocation call EnumerableSet.add/.remove and ignore the
    // return; setTheme is a bare assignment.
    expect(canFailAtApplication('Membership')).toBe(false);
    expect(canFailAtApplication('MembershipRevocation')).toBe(false);
    expect(canFailAtApplication('Theme')).toBe(false);

    expect(canFailAtApplication('Statement')).toBe(true);
    expect(canFailAtApplication('Category')).toBe(true);
    expect(canFailAtApplication('Decimals')).toBe(true);
    expect(canFailAtApplication('CategoricalValue')).toBe(true);
    expect(canFailAtApplication('NumericalValue')).toBe(true);
  });

  it('answers for every type', () => {
    for (const type of SUGGESTION_TYPES) {
      expect(canFailAtApplication(type)).toBeTypeOf('boolean');
    }
  });
});

describe('a statement proposal', () => {
  it('warns when its column has no theme', () => {
    // Statement votings are permissionless, so nothing stops one being created
    // against a column nobody has themed. It passes, then reverts on execution.
    expect(codes(statementWarnings(UNSET))).toEqual(['NO_THEME_AT_COLUMN']);
    expect(statementWarnings(UNSET)[0].predicted).toBe('NoThemeSet');
  });

  it('is clean when the theme is there', () => {
    expect(statementWarnings(SET)).toEqual([]);
  });

  it('reports an unread theme as unchecked rather than met', () => {
    expect(codes(statementWarnings(undefined))).toEqual(['PRECONDITION_UNREAD']);
  });
});

describe('a numerical value proposal', () => {
  const base = { organ: OURS, theme: SET, statement: SET, cell: numericalCell() };

  it('is clean against its own bound cell with both axes labelled', () => {
    expect(numericalValueWarnings(base)).toEqual([]);
  });

  it('is clean against an unbound cell, which its write would bind', () => {
    expect(
      numericalValueWarnings({ ...base, cell: numericalCell({ binding: { kind: 'UNBOUND' } }) }),
    ).toEqual([]);
  });

  it('warns for each missing precondition, in the order addValue checks them', () => {
    expect(
      codes(
        numericalValueWarnings({
          ...base,
          theme: UNSET,
          statement: UNSET,
          cell: numericalCell({ binding: { kind: 'BOUND', organ: THEIRS } }),
        }),
      ),
    ).toEqual(['NO_THEME_AT_COLUMN', 'NO_STATEMENT_AT_ROW', 'CELL_BOUND_TO_ANOTHER_ORGAN']);
  });

  it('names InvalidOrgan for a cell bound elsewhere', () => {
    const [warning] = numericalValueWarnings({
      ...base,
      cell: numericalCell({ binding: { kind: 'BOUND', organ: THEIRS } }),
    });
    expect(warning.predicted).toBe('InvalidOrgan');
  });
});

describe('a categorical value proposal', () => {
  const base = { organ: OURS, theme: SET, statement: SET, category: 1n, cell: categoricalCell() };

  it('is clean when the category is allowed on its own cell', () => {
    expect(categoricalValueWarnings(base)).toEqual([]);
  });

  it('warns when the category is not in the allowed set', () => {
    const warnings = categoricalValueWarnings({ ...base, category: 9n });
    expect(codes(warnings)).toEqual(['CATEGORY_NOT_ALLOWED']);
    expect(warnings[0].predicted).toBe('InvalidCategory');
  });

  it('predicts InvalidCategory — not InvalidOrgan — for another organ’s cell', () => {
    // The trap this function exists for. addValue's categorical branch applies
    // the five-argument isCategoryAllowed, which tests the organ as well as the
    // set (Matricies.sol:48-61), and it runs *before* the organ check. So an
    // organ mismatch reverts naming the category, and the InvalidOrgan branch is
    // unreachable on this path.
    const warnings = categoricalValueWarnings({
      ...base,
      cell: categoricalCell({ binding: { kind: 'BOUND', organ: THEIRS } }),
    });

    expect(codes(warnings)).toEqual(['CELL_BOUND_TO_ANOTHER_ORGAN']);
    expect(warnings[0].predicted).toBe('InvalidCategory');
    expect(warnings[0].predicted).not.toBe('InvalidOrgan');
  });

  it('warns once, not twice, when the cell is another organ’s and the category is unknown', () => {
    const warnings = categoricalValueWarnings({
      ...base,
      category: 9n,
      cell: categoricalCell({ binding: { kind: 'BOUND', organ: THEIRS } }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CELL_BOUND_TO_ANOTHER_ORGAN');
  });

  it('does not conclude the category is allowed from the public getter alone', () => {
    // The four-argument isCategoryAllowed(x, y, category) this client can call
    // tests set membership only (Matricies.sol:266-277). Here it would answer
    // true, and the value still cannot be added.
    const cell = categoricalCell({ binding: { kind: 'BOUND', organ: THEIRS } });
    expect(cell.allowedCategories.includes(1n)).toBe(true);
    expect(categoricalValueWarnings({ ...base, cell })).not.toEqual([]);
  });

  it('reports an unread cell as unchecked', () => {
    expect(codes(categoricalValueWarnings({ ...base, cell: undefined }))).toEqual([
      'PRECONDITION_UNREAD',
    ]);
  });
});

describe('a category proposal', () => {
  it('needs no theme or statement — only the binding and the duplicate check', () => {
    expect(categoryWarnings(OURS, 3n, categoricalCell())).toEqual([]);
  });

  it('warns on a duplicate category', () => {
    const warnings = categoryWarnings(OURS, 1n, categoricalCell());
    expect(codes(warnings)).toEqual(['CATEGORY_ALREADY_EXISTS']);
    expect(warnings[0].predicted).toBe('CategoryAlreadyExists');
  });

  it('warns on another organ’s cell, and here it really is InvalidOrgan', () => {
    // addCategory checks the binding first and directly, unlike addValue.
    const warnings = categoryWarnings(
      OURS,
      3n,
      categoricalCell({ binding: { kind: 'BOUND', organ: THEIRS } }),
    );
    expect(codes(warnings)).toEqual(['CELL_BOUND_TO_ANOTHER_ORGAN']);
    expect(warnings[0].predicted).toBe('InvalidOrgan');
  });
});

describe('a decimals proposal', () => {
  it('depends on the binding and nothing else', () => {
    expect(decimalsWarnings(OURS, numericalCell())).toEqual([]);
    expect(decimalsWarnings(OURS, numericalCell({ binding: { kind: 'UNBOUND' } }))).toEqual([]);
    expect(
      codes(decimalsWarnings(OURS, numericalCell({ binding: { kind: 'BOUND', organ: THEIRS } }))),
    ).toEqual(['CELL_BOUND_TO_ANOTHER_ORGAN']);
  });

  it('reports an unread cell as unchecked', () => {
    expect(codes(decimalsWarnings(OURS, undefined))).toEqual(['PRECONDITION_UNREAD']);
  });
});
