/**
 * The life of an issued template, as a finite state machine.
 *
 * `STATE_MACHINES.md`: use explicit finite states, and avoid encoding workflow
 * state as scattered booleans. The one transition that carries a correctness
 * rule rather than a bookkeeping one is `RECORDED -> EMITTED`: the operation is
 * persisted **before** the file reaches the user, because a form whose reference
 * was never recorded is unbound in practice and loses the tamper check for good.
 * Ordering it the other way is not a slower version of the same thing; it is a
 * different product.
 */

export const ISSUED_TEMPLATE_STATES = [
  /** A button was pressed. Nothing has been read and nothing written. */
  'REQUESTED',
  /** The chain reads a template pre-fills from have answered. */
  'CONTEXT_READ',
  /** The operation and its `operationRef` are durable. */
  'RECORDED',
  /** The file has been handed to the user. */
  'EMITTED',
  /** A filled copy came back and was bound to this operation. */
  'RETURNED',
  /** A required chain read did not answer, so no form was emitted. */
  'UNAVAILABLE',
  /** A later import replaced this one as the live copy of the operation. */
  'SUPERSEDED',
] as const;

export type IssuedTemplateState = (typeof ISSUED_TEMPLATE_STATES)[number];

export const isIssuedTemplateState = (value: string): value is IssuedTemplateState =>
  (ISSUED_TEMPLATE_STATES as readonly string[]).includes(value);

/**
 * The legal moves, and nothing else.
 *
 * Two absences are deliberate:
 *
 * - **`EMITTED` has no failure edge.** A template may simply never come back, and
 *   that is not a fault — `STATE_MACHINES.md` says so explicitly, and it must
 *   never be retried automatically. A form sitting on someone's desk is the
 *   normal case, not a stuck job.
 * - **Nothing returns to `REQUESTED`, and `EMITTED` cannot become `SUPERSEDED`.**
 *   Reissuing a template is a *new* operation with a new `operationRef`, not a
 *   rewind of this one, because the old file is still out there and must still
 *   resolve to the operation it names.
 */
const TRANSITIONS: { readonly [S in IssuedTemplateState]: readonly IssuedTemplateState[] } = {
  REQUESTED: ['CONTEXT_READ', 'UNAVAILABLE'],
  CONTEXT_READ: ['RECORDED', 'UNAVAILABLE'],
  RECORDED: ['EMITTED'],
  EMITTED: ['RETURNED'],
  RETURNED: ['SUPERSEDED'],
  UNAVAILABLE: [],
  SUPERSEDED: [],
};

export const canTransition = (from: IssuedTemplateState, to: IssuedTemplateState): boolean =>
  TRANSITIONS[from].includes(to);

/** A state with no moves left. A record here is history, never work. */
export const isTerminalTemplateState = (state: IssuedTemplateState): boolean =>
  TRANSITIONS[state].length === 0;

/**
 * Whether an operation in this state can still bind a returned form.
 *
 * `RETURNED` is included, and that is the point: **a second copy of a form that
 * was already imported must resolve to this operation**, not to nothing. The
 * skill's rule is that a record is kept after the operation completes so a
 * resubmitted old form finds a completed operation rather than falling back to
 * the file's own values. Dedup then reports it as a duplicate — which is a
 * different answer from "unknown reference", and the difference is what stops a
 * stale form being treated as unbound.
 */
export const canBindReturnedForm = (state: IssuedTemplateState): boolean =>
  state === 'EMITTED' || state === 'RETURNED' || state === 'SUPERSEDED';

export class IllegalTemplateTransitionError extends Error {
  constructor(
    readonly from: IssuedTemplateState,
    readonly to: IssuedTemplateState,
  ) {
    super(
      `an issued template cannot move from ${from} to ${to}` +
        (TRANSITIONS[from].length === 0
          ? ` — ${from} is terminal`
          : ` — from ${from} the only moves are ${TRANSITIONS[from].join(', ')}`),
    );
    this.name = 'IllegalTemplateTransitionError';
  }
}

/**
 * Throws rather than returning a result, unlike most of this codebase.
 *
 * An illegal transition is a programming error, not a condition a caller can
 * sensibly branch on: there is no useful behavior for "I tried to un-emit a
 * form". The union-returning style is for facts the world supplies; this is a
 * fact about the code.
 */
export function assertTransition(from: IssuedTemplateState, to: IssuedTemplateState): void {
  if (!canTransition(from, to)) throw new IllegalTemplateTransitionError(from, to);
}
