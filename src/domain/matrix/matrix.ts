import { type Bytes32, InvalidPrimitiveError, bytes32 } from '../primitives';

/**
 * The pair of matrices, as the domain addresses them.
 *
 * The contract keys everything on a `bool isCategorical`, which is the kind of
 * argument that is silently wrong half the time it is wrong. The domain carries
 * a named kind instead and the adapter converts at the boundary — the same
 * discipline the region ordinal gets, and for the same reason: there is no
 * numeric or boolean route into a call argument except through a translation
 * this codebase can point at.
 *
 * Nothing here reads the matrix. What a cell *contains* is a chain read; what a
 * coordinate *is* is domain vocabulary.
 */

export const MATRIX_KINDS = ['CATEGORICAL', 'NUMERICAL'] as const;

export type MatrixKind = (typeof MATRIX_KINDS)[number];

export const isMatrixKind = (value: string): value is MatrixKind =>
  (MATRIX_KINDS as readonly string[]).includes(value);

/**
 * A coordinate on one axis. `uint256` on chain, so `bigint` here.
 *
 * Unbounded above, deliberately: the contract accepts any `uint256` and nothing
 * reports the matrix size, so a client-side ceiling would be an invention. What
 * is refused is a negative, which cannot be encoded at all.
 */
export type Axis = 'x' | 'y';

export interface MatrixCoordinate {
  readonly x: bigint;
  readonly y: bigint;
}

const UINT256_MAX = (1n << 256n) - 1n;

export function axisValue(value: bigint, axis: Axis): bigint {
  if (value < 0n || value > UINT256_MAX) {
    throw new InvalidPrimitiveError(
      `a matrix ${axis} coordinate must fit in uint256`,
      value.toString(),
    );
  }
  return value;
}

export const matrixCoordinate = (x: bigint, y: bigint): MatrixCoordinate => ({
  x: axisValue(x, 'x'),
  y: axisValue(y, 'y'),
});

export const sameCoordinate = (a: MatrixCoordinate, b: MatrixCoordinate): boolean =>
  a.x === b.x && a.y === b.y;

/** Stable map key for a coordinate, since a `bigint` pair cannot key a `Map`. */
export const coordinateKey = (at: MatrixCoordinate): string => `${at.x},${at.y}`;

/**
 * `PartyOrgans.ZERO_PARTY_ORGAN` — the value a cell's organ holds before any
 * write binds it. It is a real `bytes32` the getters return, not an absence, so
 * the client has to know it to tell "unbound" from "bound to something".
 */
export const ZERO_ORGAN: Bytes32 = bytes32(`0x${'0'.repeat(64)}`);

/**
 * Which organ owns a cell — and whether one does at all.
 *
 * Binding is **first-writer-wins and permanent** (`Matricies.sol:98-104`): the
 * first successful write records the proposing organ, and a later write naming a
 * different one reverts. There is no rebinding path, so `UNBOUND` is a state a
 * cell leaves exactly once.
 */
export type CellBinding =
  | { readonly kind: 'BOUND'; readonly organ: Bytes32 }
  | { readonly kind: 'UNBOUND' };

export const cellBinding = (organ: Bytes32): CellBinding =>
  organ === ZERO_ORGAN ? { kind: 'UNBOUND' } : { kind: 'BOUND', organ };

/**
 * Whether `organ` may write to a cell in this state.
 *
 * An unbound cell accepts anyone's first write; a bound one accepts only its own
 * organ. Both value and category writes apply this, and `setDecimals` too.
 */
export const bindingAccepts = (binding: CellBinding, organ: Bytes32): boolean =>
  binding.kind === 'UNBOUND' || binding.organ === organ;

/**
 * A theme or a statement.
 *
 * The contract stores these as strings and treats the empty string as "not set"
 * — `addValue` tests `bytes(...).length == 0` before doing anything. So an empty
 * string is not a short label, it is an absence, and the two must not share a
 * representation. `undefined` stays reserved for "could not read", as everywhere
 * else in this client.
 */
export type AxisLabel =
  | { readonly kind: 'SET'; readonly text: string }
  | { readonly kind: 'UNSET' };

export const axisLabel = (text: string): AxisLabel =>
  text.length === 0 ? { kind: 'UNSET' } : { kind: 'SET', text };

/**
 * Which matrix a `ValueAdded` log belongs to.
 *
 * The event does not say. `ValueAdded(x, y, value, author)` is emitted from both
 * branches of `Matricies.addValue` and carries no `isCategorical`
 * (`Matricies.sol:45`, `118`), so the matrix has to be inferred from the cells at
 * those coordinates — a write binds its cell, so a bound cell is evidence a write
 * happened there.
 *
 * `AMBIGUOUS` is not a defensive extra. The two matrices are independent
 * mappings over the same coordinate space, so `(3, 7)` can be bound in both, and
 * once it is, no read distinguishes which one a given log came from. A projection
 * that guessed would attribute a value to the wrong matrix and display it under
 * the wrong theme.
 */
export type MatrixAttribution =
  | { readonly kind: 'CATEGORICAL' }
  | { readonly kind: 'NUMERICAL' }
  /** Both cells are bound. No read can separate them; show both or neither. */
  | { readonly kind: 'AMBIGUOUS' }
  /**
   * Not enough was read to say, or both cells read as unbound.
   *
   * The second is impossible for a coordinate a `ValueAdded` really named —
   * `addValue` binds before it emits — so it means the reads and the log
   * disagree: a reorg, or a projection built against a different deployment.
   */
  | { readonly kind: 'UNKNOWN' };

/**
 * Both readings are required, and one alone is never enough even when it is
 * `BOUND`. A bound numerical cell with the categorical side unread would look
 * like a confident `NUMERICAL`, when the unread side could have made it
 * `AMBIGUOUS` — a definite answer built on a read that did not happen.
 */
export function attributeValue(
  categorical: CellBinding | undefined,
  numerical: CellBinding | undefined,
): MatrixAttribution {
  if (categorical === undefined || numerical === undefined) return { kind: 'UNKNOWN' };
  const inCategorical = categorical.kind === 'BOUND';
  const inNumerical = numerical.kind === 'BOUND';
  if (inCategorical && inNumerical) return { kind: 'AMBIGUOUS' };
  if (inCategorical) return { kind: 'CATEGORICAL' };
  if (inNumerical) return { kind: 'NUMERICAL' };
  return { kind: 'UNKNOWN' };
}

/**
 * What a categorical cell holds. `allowedCategories` is the whole set, which the
 * contract will happily return unbounded — there is no paging on it.
 */
export interface CategoricalCell {
  readonly binding: CellBinding;
  readonly allowedCategories: readonly bigint[];
  readonly sampleLength: bigint;
}

/**
 * What a numerical cell holds.
 *
 * `decimals` is meaningful only when `binding` is `BOUND`: an untouched cell
 * reads `0`, which is also a legitimate configured value, and the two are
 * indistinguishable from this read alone.
 */
export interface NumericalCell {
  readonly binding: CellBinding;
  readonly decimals: number;
  readonly sampleLength: bigint;
}
