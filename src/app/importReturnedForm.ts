import { type GovernanceIntent, type OperationType } from '../domain/intents/intent';
import { buildIntent } from '../domain/intents/buildIntent';
import { canonicalIdentity, voteDirectionOf } from '../domain/intents/operationIdentity';
import type { IntentInput } from '../domain/intents/fields';
import { matrixCoordinate } from '../domain/matrix/matrix';
import type { FileSource } from '../domain/ports/FileSource';
import type { MatrixReader } from '../domain/ports/MatrixReader';
import type { OperationStore } from '../domain/ports/OperationStore';
import type { ReturnedFormReader } from '../domain/ports/ReturnedFormReader';
import type { ChainId, EvmAddress, OperationRef } from '../domain/primitives';

/**
 * A filled form coming back, all the way to a typed intent.
 *
 * The other half of issuance, and the half where the rules actually bite. Every
 * piece of this existed and none of it had a caller: the parser, the schema
 * assembly, the record binding and the intent builder were reachable only from
 * their own tests, which is the same condition the last three slices were built
 * to end.
 *
 * ## The order, and why it is this order
 *
 * ```text
 * read  ->  parse  ->  find the record  ->  bind  ->  assemble  ->  resolve  ->  build  ->  RETURNED
 * ```
 *
 * **Parse before anything is looked up.** The file decides nothing, but it does
 * have to be a readable form before a database is touched; a hostile file must
 * never reach a lookup keyed by something it supplied.
 *
 * **The record is found by the file's `operationRef` and then everything
 * app-authored comes from the record** — hard rule 4, and the whole reason the
 * store is load-bearing for correctness rather than for audit. The form's own
 * copies of those values are compared and discarded.
 *
 * **`resolved` keys are read from chain, after assembly and before building.**
 * `assembleFormInput` is pure and its map is deliberately incomplete for
 * `CREATE_NUMERICAL_VALUE_VOTING`; the scale of a numerical value belongs to the
 * cell the member addressed, and is read now rather than recorded at issuance so
 * that it cannot be stale. Iterated from the schema rather than special-cased,
 * so a second `resolved` key needs no change here.
 *
 * **`RETURNED` last, and only if an intent was built.** A form that fails
 * validation leaves the operation in `EMITTED`, so a member can correct the file
 * and import it again. Advancing first would burn the operation on a typo.
 *
 * ## What this does not do
 *
 * It does not preflight, submit, or sign. Producing the intent is the end of the
 * pipeline until Phase 6 exists, and a caller gets a description of what the form
 * asks for — not a promise that the chain would accept it. Client preflight is UX
 * and Solidity enforces (hard rule 6), so nothing here becomes an authorization.
 */

export interface ImportFormDeps {
  readonly files: FileSource;
  /** The form pipeline, behind one port — as issuance orchestrates `TemplateWriter`. */
  readonly forms: ReturnedFormReader;
  readonly store: OperationStore;
  /**
   * Head reads, not the report's pinned snapshot.
   *
   * A report describes a block; an import asks what is true **now**, because the
   * scale it recovers is about to produce a number a transaction will carry.
   */
  readonly matrix: MatrixReader;
  readonly deployment: {
    readonly chainId: ChainId;
    readonly contractAddress: EvmAddress;
  };
}

export interface ImportFormRequest {
  /** Already chosen by the user, in a dialog main owns. See `FileSource`. */
  readonly sourcePath: string;
}

export type ImportRefusalCode =
  /** The file is not a readable governance form. Carries the parser's own codes. */
  | 'NOT_IMPORTABLE'
  /** The form names an operation this application has no record of. */
  | 'UNKNOWN_OPERATION_REF'
  /** The record is for another deployment, or no file was ever issued under it. */
  | 'NOT_BINDABLE'
  /** A copy of this operation has already been imported. */
  | 'ALREADY_IMPORTED'
  /** A different form already asks the chain for exactly this. */
  | 'DUPLICATE_OPERATION'
  /** A different form votes the other way on the same voting. */
  | 'CONFLICTING_VOTE'
  /** The form's own fields do not satisfy the schema. */
  | 'FORM_INCOMPLETE'
  /** A value the schema resolves from chain could not be read. */
  | 'CHAIN_UNAVAILABLE'
  /** The fields are all present and do not make a valid intent. */
  | 'INVALID_INTENT';

/**
 * One reason, in the vocabulary of whichever layer produced it.
 *
 * Structurally a {@link FormNote}, and named separately because this is the use
 * case's outward vocabulary rather than the form port's — a caller of an
 * application service should not have to know which adapter a problem came from.
 */
export interface ImportProblem {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export type ImportFormOutcome =
  | {
      readonly kind: 'IMPORTED';
      readonly operationRef: OperationRef;
      readonly operationType: OperationType;
      readonly intent: GovernanceIntent;
      /**
       * Things a person should see about a form that was nonetheless read: a
       * context field edited in the file, or a field whose appearance disagrees
       * with its value. Never a reason to withhold the intent — none of them can
       * change it — and never to be dropped, because both are tamper evidence.
       */
      readonly warnings: readonly ImportProblem[];
    }
  | {
      readonly kind: 'REFUSED';
      readonly code: ImportRefusalCode;
      readonly message: string;
      readonly problems: readonly ImportProblem[];
    };

export async function importReturnedForm(
  deps: ImportFormDeps,
  request: ImportFormRequest,
): Promise<ImportFormOutcome> {
  const bytes = await deps.files.read(request.sourcePath);

  const read = await deps.forms.read(bytes);
  if (read.kind === 'UNREADABLE') {
    return refused(
      'NOT_IMPORTABLE',
      'This file could not be read as a governance form.',
      read.problems,
    );
  }

  const record = await deps.store.find(read.form.operationRef);
  if (record === undefined) {
    // Not a lookup failure — `OperationStore.find` throws on those, deliberately,
    // so that a broken database never presents as a stream of forgeries.
    return refused(
      'UNKNOWN_OPERATION_REF',
      'This application has no record of the operation this form names, so the values it ' +
        'authored cannot be recovered. Only forms issued here can be imported.',
      [],
    );
  }

  // Bound before the state is judged, and the three arms are answered in a fixed
  // order: a form from the wrong deployment is refused as such even if that
  // operation has also already been imported, because the deployment is the more
  // fundamental fact. The binding itself is pure, so doing it first costs
  // nothing when a later check refuses.
  const binding = read.form.bind(record, deps.deployment);

  if (binding.kind === 'NOT_BINDABLE') {
    const [first] = binding.problems;
    return refused(
      'NOT_BINDABLE',
      first?.message ?? 'This form cannot be bound to the operation it names.',
      binding.problems,
    );
  }

  if (record.state !== 'EMITTED') {
    // The record resolves in `RETURNED` and `SUPERSEDED` on purpose, so that a
    // second copy finds the completed operation rather than looking unbound.
    // Naming the state here is what turns that into an answer a person can act
    // on instead of a silent second import.
    return refused(
      'ALREADY_IMPORTED',
      'A copy of this form has already been imported. Importing it again would submit the ' +
        'same operation twice.',
      [{ code: record.state, message: `this operation is already ${record.state}` }],
    );
  }

  if (binding.kind === 'REFUSED') {
    return refused(
      'FORM_INCOMPLETE',
      'This form is missing or misuses fields this application requires.',
      binding.problems,
    );
  }

  const resolved = await resolveFromChain(
    deps,
    binding.operationType,
    binding.input,
    binding.resolvedKeys,
  );
  if (resolved.kind === 'UNAVAILABLE') {
    return refused('CHAIN_UNAVAILABLE', resolved.message, []);
  }

  const built = buildIntent(binding.operationType, resolved.input);
  if (built.kind === 'PROBLEMS') {
    return refused(
      'INVALID_INTENT',
      'The values on this form do not make a valid operation.',
      // A `FieldProblem` is keyed by **domain** key, not by field name. The two
      // differ by the `zarya.input.` prefix and nothing else, so the caller can
      // map back — but it is not this layer's job to, and inventing a code here
      // would put a second vocabulary between the builder and the screen.
      built.problems.map((problem) => ({
        code: 'FIELD_INVALID',
        field: problem.field,
        message: problem.message,
      })),
    );
  }

  // Identity is derived from the **built intent**, not from the form, so two
  // documents that ask for the same thing collide however differently they were
  // filled in — and a form whose values did not validate never reaches here to
  // reserve an identity it was not entitled to.
  const identityKey = canonicalIdentity(built.intent, deps.deployment);
  const direction = voteDirectionOf(built.intent);

  const alreadySeen = (
    await deps.store.findByIdentity(deps.deployment, identityKey)
  ).filter((other) => other.operationRef !== record.operationRef);

  if (alreadySeen.length > 0) {
    const [first] = alreadySeen;
    // A vote's identity excludes its direction on purpose, so a match here is
    // either the same vote again or the opposite one — and those are different
    // answers. The opposite is a contradiction for a person to resolve, never
    // something to pick a winner from.
    const opposed =
      direction !== undefined &&
      first?.voteDirection !== undefined &&
      first.voteDirection !== direction;

    return opposed
      ? refused(
          'CONFLICTING_VOTE',
          'Another imported form votes the other way on this same voting. Both cannot be ' +
            'submitted, and this application will not choose between them.',
          alreadySeen.map((other) => ({
            code: 'CONFLICTS_WITH',
            message: `${other.operationRef} voted ${String(other.voteDirection)}`,
          })),
        )
      : refused(
          'DUPLICATE_OPERATION',
          'Another form already asks for exactly this operation. Submitting both would do it ' +
            'twice.',
          alreadySeen.map((other) => ({
            code: 'DUPLICATE_OF',
            message: `already imported as ${other.operationRef}`,
          })),
        );
  }

  // Only now, and in one call. A form that failed anything above leaves the
  // operation in `EMITTED`, so the member can fix the file and import it again;
  // and the identity, the bytes and the state move together, because a
  // `RETURNED` row with no bytes cannot regenerate its receipt and an `EMITTED`
  // row holding an identity would dedup against itself.
  await deps.store.recordReturn({
    operationRef: record.operationRef,
    identityKey,
    ...(direction === undefined ? {} : { voteDirection: direction }),
    formBytes: bytes,
  });

  return {
    kind: 'IMPORTED',
    operationRef: record.operationRef,
    operationType: binding.operationType,
    intent: built.intent,
    // Both kinds of evidence, kept together: a context field edited in the file
    // and an appearance that disagrees with its value are the same class of
    // thing to a person, and neither can change the intent.
    warnings: [...binding.warnings, ...read.disclosures],
  };
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
 * the import. A cell that does not read is a **refusal**, never a default —
 * `addValue` takes no decimals argument, so a wrong scale is a valid transaction
 * storing a number off by a power of ten and nothing on chain would notice.
 */
async function resolveFromChain(
  deps: ImportFormDeps,
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
      // `x` and `y` are member-filled, so a malformed one is a validation
      // problem rather than an outage. Left to `buildIntent`, which has the
      // message for it.
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

const refused = (
  code: ImportRefusalCode,
  message: string,
  problems: readonly ImportProblem[],
): ImportFormOutcome => ({ kind: 'REFUSED', code, message, problems });
