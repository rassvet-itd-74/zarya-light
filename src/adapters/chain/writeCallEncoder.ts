import type { ZaryaWriteCall } from '../../domain/intents/intentCalls';
import type { OrganResolver } from '../../domain/ports/OrganResolver';
import type { EncodedCall, WriteCallEncoder } from '../../domain/ports/WriteCallEncoder';
import { encodeWriteCall } from './writeCallData';

/**
 * `WriteCallEncoder` over `encodeWriteCall`.
 *
 * A class around a function, and the only thing it adds is the port — which is
 * the point. `submitOperation` orchestrates ports and may not import an adapter
 * module by path (hard rule 9, and the lint rule that enforces it), so the
 * function needed a shape the domain could declare.
 *
 * The one real translation is the reason vocabulary. `encodeWriteCall` answers in
 * the simulator's `CallUnavailableReason`, where the retryable case is called
 * `ORGAN_UNREADABLE`; the write port calls it `ORGAN_UNAVAILABLE`. Mapping it
 * here rather than widening either union keeps the distinction the queue depends
 * on — a mismatch is a wrong organ and will never succeed, an unreadable one is
 * an outage and will.
 */
export class ZaryaWriteCallEncoder implements WriteCallEncoder {
  constructor(private readonly organs: OrganResolver) {}

  async encode(call: ZaryaWriteCall): Promise<EncodedCall> {
    const encoded = await encodeWriteCall(call, this.organs);
    if (encoded.kind === 'DATA') return encoded;
    return {
      kind: 'UNAVAILABLE',
      reason: encoded.reason === 'ORGAN_UNREADABLE' ? 'ORGAN_UNAVAILABLE' : encoded.reason,
      detail: encoded.detail,
    };
  }
}
