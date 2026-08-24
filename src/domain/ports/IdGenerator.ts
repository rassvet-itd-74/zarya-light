import type { OperationRef } from '../primitives';

/**
 * Generates the app's operation references.
 *
 * A port rather than an inline `randomUUID()` call because issuance must be
 * testable: a template is recorded under its `operationRef` before the file is
 * handed over, and a round-trip test needs that reference to be predictable.
 * `node:crypto` is also forbidden inside `src/domain/`.
 */
export interface IdGenerator {
  newOperationRef(): OperationRef;
}
