import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../domain/ports/IdGenerator';
import { type OperationRef, operationRef } from '../../domain/primitives';

/**
 * `IdGenerator` over the platform CSPRNG.
 *
 * The `zar-` prefix is there so a reference is recognisable in a filename, a log
 * line, or written on a printed form, and so a bare UUID from somewhere else
 * cannot be mistaken for one of ours.
 */
export class CryptoIdGenerator implements IdGenerator {
  newOperationRef(): OperationRef {
    return operationRef(`zar-${randomUUID()}`);
  }
}

/**
 * Deterministic `IdGenerator` for tests — the second implementation that makes
 * the port a boundary rather than a wrapper.
 */
export class SequentialIdGenerator implements IdGenerator {
  private next = 1;

  constructor(private readonly prefix = 'zar-test-') {}

  newOperationRef(): OperationRef {
    return operationRef(`${this.prefix}${this.next++}`);
  }
}
