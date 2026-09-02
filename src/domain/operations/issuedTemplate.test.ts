import { describe, expect, it } from 'vitest';
import {
  ISSUED_TEMPLATE_STATES,
  IllegalTemplateTransitionError,
  assertTransition,
  canBindReturnedForm,
  canTransition,
  isIssuedTemplateState,
  isTerminalTemplateState,
} from './issuedTemplate';

describe('the one transition that is a correctness rule', () => {
  it('reaches EMITTED only from RECORDED', () => {
    // The operation is durable before the file reaches the user. A form whose
    // reference was never recorded is unbound in practice and loses the tamper
    // check permanently, so this is not a slower version of the same thing.
    const from = ISSUED_TEMPLATE_STATES.filter((state) => canTransition(state, 'EMITTED'));
    expect(from).toEqual(['RECORDED']);
  });

  it('does not let a template be emitted before its context is read', () => {
    expect(canTransition('REQUESTED', 'EMITTED')).toBe(false);
    expect(canTransition('CONTEXT_READ', 'EMITTED')).toBe(false);
  });
});

describe('what the machine deliberately refuses', () => {
  it('gives EMITTED no failure edge', () => {
    // A template may simply never come back. That is the normal case, not a
    // stuck job, and it must never be retried automatically.
    expect(canTransition('EMITTED', 'UNAVAILABLE')).toBe(false);
    expect(canTransition('EMITTED', 'SUPERSEDED')).toBe(false);
    expect(ISSUED_TEMPLATE_STATES.filter((state) => canTransition('EMITTED', state))).toEqual([
      'RETURNED',
    ]);
  });

  it('never returns to REQUESTED', () => {
    // Reissuing is a new operationRef, not a rewind: the old file is still out
    // there and still has to resolve to the operation it names.
    for (const state of ISSUED_TEMPLATE_STATES) {
      expect(canTransition(state, 'REQUESTED'), state).toBe(false);
    }
  });

  it('lets nothing leave a terminal state', () => {
    for (const terminal of ['UNAVAILABLE', 'SUPERSEDED'] as const) {
      expect(isTerminalTemplateState(terminal), terminal).toBe(true);
      for (const state of ISSUED_TEMPLATE_STATES) {
        expect(canTransition(terminal, state), `${terminal} -> ${state}`).toBe(false);
      }
    }
  });

  it('has no state that can move to itself', () => {
    for (const state of ISSUED_TEMPLATE_STATES) {
      expect(canTransition(state, state), state).toBe(false);
    }
  });
});

describe('binding a returned form', () => {
  it('accepts a form against an operation that already completed', () => {
    // A resubmitted old form must resolve to a *completed* operation rather
    // than to nothing. "Duplicate" and "unknown reference" are different
    // answers, and the difference is what stops a stale form being treated as
    // unbound and falling back to its own values.
    expect(canBindReturnedForm('EMITTED')).toBe(true);
    expect(canBindReturnedForm('RETURNED')).toBe(true);
    expect(canBindReturnedForm('SUPERSEDED')).toBe(true);
  });

  it('refuses a form against an operation whose file was never handed over', () => {
    // A form claiming a reference that never reached `EMITTED` did not come
    // from this application.
    expect(canBindReturnedForm('REQUESTED')).toBe(false);
    expect(canBindReturnedForm('CONTEXT_READ')).toBe(false);
    expect(canBindReturnedForm('RECORDED')).toBe(false);
    expect(canBindReturnedForm('UNAVAILABLE')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('throws on an illegal move, naming what was possible', () => {
    // An illegal transition is a programming error, not a condition to branch
    // on — there is no useful behavior for "I tried to un-emit a form".
    expect(() => assertTransition('RECORDED', 'RETURNED')).toThrow(
      IllegalTemplateTransitionError,
    );
    expect(() => assertTransition('RECORDED', 'RETURNED')).toThrow(/the only moves are EMITTED/);
    expect(() => assertTransition('SUPERSEDED', 'RETURNED')).toThrow(/SUPERSEDED is terminal/);
  });

  it('is silent on a legal one', () => {
    expect(() => assertTransition('RECORDED', 'EMITTED')).not.toThrow();
  });
});

describe('the state names are the stored vocabulary', () => {
  it('recognises its own members and nothing else', () => {
    // These strings go into a database column and are read back, so a rename is
    // a migration rather than a refactor.
    for (const state of ISSUED_TEMPLATE_STATES) expect(isIssuedTemplateState(state)).toBe(true);
    expect(isIssuedTemplateState('recorded')).toBe(false);
    expect(isIssuedTemplateState('DONE')).toBe(false);
  });
});
