import { buildIntent } from '../domain/intents/buildIntent';
import type { IntentInput } from '../domain/intents/fields';
import type { GovernanceIntent, OperationType } from '../domain/intents/intent';
import { matrixCoordinate } from '../domain/matrix/matrix';
import type { MatrixReader } from '../domain/ports/MatrixReader';

/**
 * The last two steps of reading a form: resolve what the chain owns, then build.
 *
 * Shared by importing a form and by submitting one that was imported earlier,
 * because **the intent is not stored**. What is stored is the document, and an
 * intent is derived from it again at submission time.
 *
 * That is deliberate and it is the safer of the two designs. A persisted intent
 * would be a second copy of the decision, and the two could disagree after a
 * migration or a bug; deriving it again means the transaction that gets sent is
 * derived from the same bytes a member returned, by the same code that refused or
 * accepted them. It also means the numerical scale below is read at **submission**
 * rather than at import, which is one step closer to the mined block.
 *
 * The cost is that a form is parsed twice. It is hundreds of kilobytes and one
 * person pressing one button.
 */

export interface IntentFromFormDeps {
  /**
   * Head reads, never the report's pinned snapshot.
   *
   * A report describes a block; this asks what is true **now**, because the scale
   * it recovers is about to produce a number a transaction carries.
   */
  readonly matrix: MatrixReader;
}

export type IntentDerivation =
  | { readonly kind: 'INTENT'; readonly intent: GovernanceIntent }
  /** A value the schema resolves from chain could not be read. Retryable. */
  | { readonly kind: 'UNAVAILABLE'; readonly message: string }
  | {
      readonly kind: 'INVALID';
      readonly problems: readonly { readonly field: string; readonly message: string }[];
    };

export async function intentFromForm(
  deps: IntentFromFormDeps,
  operationType: OperationType,
  input: IntentInput,
  resolvedKeys: readonly string[],
): Promise<IntentDerivation> {
  const resolved = await resolveFromChain(deps, operationType, input, resolvedKeys);
  if (resolved.kind === 'UNAVAILABLE') return resolved;

  const built = buildIntent(operationType, resolved.input);
  return built.kind === 'PROBLEMS'
    ? {
        kind: 'INVALID',
        // A `FieldProblem` is keyed by **domain** key, not by field name. The two
        // differ by the `zarya.input.` prefix and nothing else, so a caller can
        // map back — but inventing a code here would put a second vocabulary
        // between the builder and the screen.
        problems: built.problems.map((problem) => ({
          field: problem.field,
          message: problem.message,
        })),
      }
    : { kind: 'INTENT', intent: built.intent };
}

type Resolution =
  | { readonly kind: 'RESOLVED'; readonly input: IntentInput }
  | { readonly kind: 'UNAVAILABLE'; readonly message: string };

/**
 * Fills in the keys the schema says come from chain rather than from the form or
 * the record.
 *
 * The keys come from the form port, which knows the schema; they are empty for
 * ten of the eleven operations — and that is exactly why this iterates them
 * instead of testing for `CREATE_NUMERICAL_VALUE_VOTING`. A second resolved key
 * would otherwise need a change here, and the one place it must not be forgotten
 * is the one place a reader would not think to look.
 *
 * The coordinate comes from the member's own `x` and `y`, which is the whole
 * point of the design: the scale that produced the integer is never older than
 * the read. A cell that does not read is a **refusal**, never a default —
 * `addValue` takes no decimals argument, so a wrong scale is a valid transaction
 * storing a number off by a power of ten and nothing on chain would notice.
 */
async function resolveFromChain(
  deps: IntentFromFormDeps,
  operationType: OperationType,
  input: IntentInput,
  keys: readonly string[],
): Promise<Resolution> {
  if (keys.length === 0) return { kind: 'RESOLVED', input };

  const resolved: Record<string, string | undefined> = { ...input };

  for (const key of keys) {
    if (key !== 'decimals') {
      // The schema grew a resolved key this function does not know how to read.
      // A refusal rather than a silent omission: the alternative is `buildIntent`
      // reporting a missing field a member never saw and cannot supply.
      return {
        kind: 'UNAVAILABLE',
        message: `This application does not know how to recover ${key} for a ${operationType}.`,
      };
    }

    const at = coordinateFrom(input);
    if (at === undefined) {
      // `x` and `y` are member-filled, so a malformed one is a validation problem
      // rather than an outage. Left to `buildIntent`, which has the message.
      return { kind: 'RESOLVED', input };
    }

    const cell = await deps.matrix.numericalCell(at);
    if (cell === undefined) {
      return {
        kind: 'UNAVAILABLE',
        message:
          'The precision of the cell this form addresses could not be read from the chain, ' +
          'and it is what the value means. Try again when the network is reachable.',
      };
    }
    resolved[key] = String(cell.decimals);
  }

  return { kind: 'RESOLVED', input: resolved };
}

/** The member's coordinate, or `undefined` when it is not two integers. */
function coordinateFrom(input: IntentInput): ReturnType<typeof matrixCoordinate> | undefined {
  const x = input.x?.trim();
  const y = input.y?.trim();
  if (x === undefined || y === undefined || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return undefined;
  }
  try {
    return matrixCoordinate(BigInt(x), BigInt(y));
  } catch {
    return undefined;
  }
}
