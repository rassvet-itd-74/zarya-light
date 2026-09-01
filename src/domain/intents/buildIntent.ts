import { MATRIX_KINDS, type MatrixKind, matrixCoordinate } from '../matrix/matrix';
import { FixedPointError, parseFixedPoint } from '../matrix/fixedPoint';
import {
  PARTY_ORGAN_TYPES,
  type PartyOrganTriple,
  partyOrganTriple,
} from '../organs/partyOrgan';
import { InvalidPrimitiveError } from '../primitives';
import { REGIONS, regionBySubjectCode } from '../organs/regions';
import { votingId } from '../voting/voting';
import { type FieldProblem, FieldReader, type IntentInput, TEXT_LIMITS } from './fields';
import {
  type GovernanceIntent,
  type OperationType,
  VOTE_DIRECTIONS,
  votingRef,
} from './intent';

/**
 * Raw form text to a validated intent, or to every reason it is not one.
 *
 * This is the narrowest point in the whole pipeline. Above it, a returned PDF is
 * arbitrary bytes a hostile party may have authored; below it, everything speaks
 * a closed union of eleven operations with typed arguments. Nothing crosses
 * except through one of the builders here, and none of them can produce a call
 * this client did not already know how to make.
 *
 * Shape only. No chain reads, no clock, no storage — so a validation result is
 * reproducible, and a failure is never an outage. Whether the organ has members,
 * whether the signer may act, and whether the cell can hold the value are
 * preflight's questions.
 */

/**
 * Discriminated by a string `kind`, like every other union in this codebase, and
 * not by an `ok: boolean`.
 *
 * That is not only convention. This project does not run TypeScript's `strict`
 * mode, and without `strictNullChecks` a `true`/`false` literal discriminant
 * does not narrow — `if (result.kind === 'INTENT')` leaves the union intact and every access to
 * the other arm is an error. A string discriminant narrows either way.
 */
export type BuildIntentResult =
  | { readonly kind: 'INTENT'; readonly intent: GovernanceIntent }
  | { readonly kind: 'PROBLEMS'; readonly problems: readonly FieldProblem[] };

const failed = (problems: readonly FieldProblem[]): BuildIntentResult => ({
  kind: 'PROBLEMS',
  problems,
});

/**
 * Builds the intent named by `operationType`.
 *
 * Exhaustive over the union with no default arm, so a twelfth operation type is
 * a compile error here rather than a silent fall-through to whichever builder
 * happened to be listed first.
 */
export function buildIntent(
  operationType: OperationType,
  input: IntentInput,
): BuildIntentResult {
  const read = new FieldReader(input);

  switch (operationType) {
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      return membership(operationType, read);
    case 'CREATE_CATEGORY_VOTING':
      return category(read);
    case 'CREATE_DECIMALS_VOTING':
      return decimals(read);
    case 'CREATE_THEME_VOTING':
      return theme(read);
    case 'CREATE_STATEMENT_VOTING':
      return statement(read);
    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      return categoricalValue(read);
    case 'CREATE_NUMERICAL_VALUE_VOTING':
      return numericalValue(read);
    case 'CAST_VOTE':
      return castVote(read);
    case 'CONFIGURE_ORGAN_THRESHOLDS':
      return thresholds(read);
    case 'TRANSFER_CHAIRMANSHIP':
      return chairmanship(read);
  }
}

/**
 * The organ triple, read as three fields and normalized.
 *
 * Two things happen here that the rest of the codebase depends on.
 *
 * **The region arrives as a subject code and leaves as an ordinal.** A form asks
 * a human for a region, and a human knows `74` or `95` — the code on a numberplate
 * — not the position of a member in a Solidity enum. Those differ for 50 of the
 * 98, and passing a code where an ordinal belongs addresses a *different real
 * region* without reverting. So the code goes through `regionBySubjectCode` or
 * it does not become an argument at all; there is no arithmetic path between the
 * two representations anywhere in this codebase.
 *
 * **Fields the organ type ignores are dropped.** `partyOrganTriple` zeroes the
 * region and number for a global organ, so a Chairperson organ "in Chelyabinsk"
 * *is* the Chairperson organ and compares equal to itself. A form that supplies
 * them is not refused for it — the contract ignores them too.
 */
function organ(read: FieldReader): PartyOrganTriple | undefined {
  const organType = read.choice('organType', PARTY_ORGAN_TYPES);
  if (organType === undefined) return undefined;

  const scopeNeedsRegion =
    organType !== 'Chairperson' && organType !== 'CentralSoviet' && organType !== 'Congress';
  if (!scopeNeedsRegion) return partyOrganTriple({ organType });

  const code = read.choice('regionSubjectCode', KNOWN_SUBJECT_CODES);
  if (code === undefined) return undefined;
  // `regionBySubjectCode` throws rather than returning a fallback, which is the
  // right shape for it: there is no sensible default region. Here it cannot
  // throw, because the choice list above is the table's own codes.
  const region = regionBySubjectCode(code);

  const isLocal = organType === 'LocalSoviet' || organType === 'LocalGeneralAssembly';
  if (!isLocal) return partyOrganTriple({ organType, region: region.ordinal });

  const number = read.uint('organNumber', BigInt(Number.MAX_SAFE_INTEGER));
  if (number === undefined) return undefined;
  try {
    return partyOrganTriple({ organType, region: region.ordinal, number: Number(number) });
  } catch (error) {
    return read.reject(
      'organNumber',
      error instanceof InvalidPrimitiveError ? error.message : 'This organ number is not usable.',
    );
  }
}

/**
 * Every subject code the region table carries, as the accepted values for a
 * form field.
 *
 * Derived from the table rather than restated, so the codes a form may carry and
 * the codes that resolve to an ordinal cannot drift apart — a restated list that
 * gained an entry would accept a code with nothing behind it.
 */
const KNOWN_SUBJECT_CODES: readonly string[] = REGIONS.map(
  (region) => region.subjectCode as string,
);

const coordinate = (read: FieldReader) => {
  const x = read.coordinate('x');
  const y = read.coordinate('y');
  return x === undefined || y === undefined ? undefined : matrixCoordinate(x, y);
};

const matrixKind = (read: FieldReader): MatrixKind | undefined =>
  read.choice('matrix', MATRIX_KINDS);

function membership(
  type: 'CREATE_MEMBERSHIP_VOTING' | 'CREATE_MEMBERSHIP_REVOCATION_VOTING',
  read: FieldReader,
): BuildIntentResult {
  const triple = organ(read);
  const member = read.nonZeroAddress('member');
  const duration = read.duration('duration');
  if (!read.ok || triple === undefined || member === undefined || duration === undefined) {
    return failed(read.failures);
  }
  return { kind: 'INTENT', intent: { type, organ: triple, member, duration } };
}

function category(read: FieldReader): BuildIntentResult {
  const triple = organ(read);
  const at = coordinate(read);
  const id = read.uint('category');
  const categoryName = read.text('categoryName', TEXT_LIMITS.categoryName);
  const duration = read.duration('duration');
  if (
    !read.ok ||
    triple === undefined ||
    at === undefined ||
    id === undefined ||
    categoryName === undefined ||
    duration === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: {
      type: 'CREATE_CATEGORY_VOTING',
      organ: triple,
      at,
      category: id,
      categoryName,
      duration,
    },
  };
}

function decimals(read: FieldReader): BuildIntentResult {
  const triple = organ(read);
  const at = coordinate(read);
  const places = read.uint8('decimals');
  const duration = read.duration('duration');
  if (
    !read.ok ||
    triple === undefined ||
    at === undefined ||
    places === undefined ||
    duration === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: { type: 'CREATE_DECIMALS_VOTING', organ: triple, at, decimals: places, duration },
  };
}

function theme(read: FieldReader): BuildIntentResult {
  const matrix = matrixKind(read);
  const x = read.coordinate('x');
  const text = read.text('theme', TEXT_LIMITS.theme);
  const duration = read.duration('duration');
  if (
    !read.ok ||
    matrix === undefined ||
    x === undefined ||
    text === undefined ||
    duration === undefined
  ) {
    return failed(read.failures);
  }
  return { kind: 'INTENT', intent: { type: 'CREATE_THEME_VOTING', matrix, x, theme: text, duration } };
}

function statement(read: FieldReader): BuildIntentResult {
  const matrix = matrixKind(read);
  const at = coordinate(read);
  const text = read.text('statement', TEXT_LIMITS.statement);
  const duration = read.duration('duration');
  if (
    !read.ok ||
    matrix === undefined ||
    at === undefined ||
    text === undefined ||
    duration === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: { type: 'CREATE_STATEMENT_VOTING', matrix, at, statement: text, duration },
  };
}

function categoricalValue(read: FieldReader): BuildIntentResult {
  const triple = organ(read);
  const at = coordinate(read);
  // The proposed value on a categorical cell *is* a category id, read as a
  // whole number with no scale. There is no decimals field on this branch and
  // adding one would invite a member to write `1.5` where only `1` exists.
  const id = read.uint('category');
  const valueAuthor = read.nonZeroAddress('valueAuthor');
  const duration = read.duration('duration');
  if (
    !read.ok ||
    triple === undefined ||
    at === undefined ||
    id === undefined ||
    valueAuthor === undefined ||
    duration === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: {
      type: 'CREATE_CATEGORICAL_VALUE_VOTING',
      organ: triple,
      at,
      category: id,
      valueAuthor,
      duration,
    },
  };
}

/**
 * The one builder that scales.
 *
 * `decimals` is app-authored — it comes from the cell as it was read when the
 * template was issued, not from something the member typed — and it travels into
 * the intent so preflight can compare it against the cell's decimals now. A
 * template issued against a two-decimal cell and returned after a decimals
 * voting changed it to four would otherwise submit a number a hundred times too
 * small, and nothing on chain would notice.
 */
function numericalValue(read: FieldReader): BuildIntentResult {
  const triple = organ(read);
  const at = coordinate(read);
  const places = read.uint8('decimals');
  const valueAuthor = read.nonZeroAddress('valueAuthor');
  const duration = read.duration('duration');
  const written = read.text('value', 40);

  let value: bigint | undefined;
  if (written !== undefined && places !== undefined) {
    try {
      value = parseFixedPoint(written, places);
    } catch (error) {
      read.reject(
        'value',
        error instanceof FixedPointError ? error.message : 'This value could not be read.',
      );
    }
  }

  if (
    !read.ok ||
    triple === undefined ||
    at === undefined ||
    places === undefined ||
    valueAuthor === undefined ||
    duration === undefined ||
    value === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: {
      type: 'CREATE_NUMERICAL_VALUE_VOTING',
      organ: triple,
      at,
      value,
      decimals: places,
      valueAuthor,
      duration,
    },
  };
}

function castVote(read: FieldReader): BuildIntentResult {
  const id = read.uint('votingId');
  const direction = read.choice('support', VOTE_DIRECTIONS);
  // No organ is read, and a form must not carry one: castVote takes only
  // (votingId, support) and the contract reads the organ from the voting.
  if (!read.ok || id === undefined || direction === undefined) {
    return failed(read.failures);
  }
  try {
    return { kind: 'INTENT', intent: { type: 'CAST_VOTE', voting: votingRef(votingId(id)), direction } };
  } catch {
    // votingId(0) — the contract's own votingExists guard refuses it, so this
    // saves a round trip that could only revert.
    return failed([
      ...read.failures,
      { field: 'votingId', message: 'Voting numbers start at 1; there is no voting 0.' },
    ]);
  }
}

/**
 * All three thresholds together, and the rule that stops the silent no-op.
 *
 * A base of zero resets the organ to `simpleMajority` and discards the other
 * two, so submitting a quorum and an approval with a zero base is a form whose
 * transactions all succeed and whose effect is nothing. It is refused here
 * rather than at preflight, because it is a statement about the request itself
 * and needs no chain read to see.
 *
 * A base of zero *on its own* is allowed: that is the deliberate "reset this
 * organ to the default" operation, and refusing it would remove the only way
 * back.
 */
function thresholds(read: FieldReader): BuildIntentResult {
  const triple = organ(read);
  const quorum = read.uint('quorum', (1n << 256n) - 1n);
  const approvalPercentage = read.uint('approvalPercentage', (1n << 256n) - 1n);
  const approvalPercentageBase = read.uint('approvalPercentageBase', (1n << 256n) - 1n);

  if (
    approvalPercentageBase === 0n &&
    ((quorum ?? 0n) !== 0n || (approvalPercentage ?? 0n) !== 0n)
  ) {
    read.reject(
      'approvalPercentageBase',
      'A base of zero makes the contract ignore the quorum and approval entirely and fall back to a simple majority. ' +
        'Set a base — 10000 for basis points — or set all three to zero to reset this organ deliberately.',
    );
  }

  if (
    approvalPercentage !== undefined &&
    approvalPercentageBase !== undefined &&
    approvalPercentageBase !== 0n &&
    approvalPercentage >= approvalPercentageBase
  ) {
    // approval is a strict `>` comparison against the base-scaled ratio, so an
    // approval at or above the base can never be met: it would need more than
    // all votes in favour.
    read.reject(
      'approvalPercentage',
      'This is at or above the base, which no vote can exceed — the comparison is strict. ' +
        'For 50% with a base of 10000, use 5000.',
    );
  }

  if (
    !read.ok ||
    triple === undefined ||
    quorum === undefined ||
    approvalPercentage === undefined ||
    approvalPercentageBase === undefined
  ) {
    return failed(read.failures);
  }
  return {
    kind: 'INTENT',
    intent: {
      type: 'CONFIGURE_ORGAN_THRESHOLDS',
      organ: triple,
      quorum,
      approvalPercentage,
      approvalPercentageBase,
    },
  };
}

function chairmanship(read: FieldReader): BuildIntentResult {
  const newChairman = read.nonZeroAddress('newChairman');
  if (!read.ok || newChairman === undefined) return failed(read.failures);
  return { kind: 'INTENT', intent: { type: 'TRANSFER_CHAIRMANSHIP', newChairman } };
}
