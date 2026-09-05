import type { ZaryaWriteCall } from '../intents/intentCalls';

/**
 * A typed call into the bytes a transaction carries.
 *
 * A port rather than a direct call because encoding needs two things the domain
 * may not hold: the ABI, and an organ resolution that goes to the chain to
 * verify the triple against the contract's own rendering. Both live in
 * `src/adapters/chain/`.
 *
 * The union is what crosses, never calldata built elsewhere. A port that
 * accepted bytes would put a hole in the form pipeline's allow-list one layer
 * below where anyone would look for it — the same reasoning that keeps
 * `CallSimulator` taking named calls.
 */

export type EncodeFailureReason =
  /** The contract renders this organ differently from the local mirror. Not retryable. */
  | 'ORGAN_MISMATCH'
  /** The organ could not be resolved because the chain did not answer. Retryable. */
  | 'ORGAN_UNAVAILABLE'
  /** The call could not be encoded at all — a shape the ABI does not accept. */
  | 'NOT_ENCODABLE';

export type EncodedCall =
  | { readonly kind: 'DATA'; readonly data: `0x${string}` }
  | {
      readonly kind: 'UNAVAILABLE';
      readonly reason: EncodeFailureReason;
      readonly detail: string;
    };

export interface WriteCallEncoder {
  /**
   * **Never throws.** A mismatch and an outage are different answers with
   * different retry behaviour, and collapsing either into an exception would
   * make the queue treat a wrong organ as a transient fault and keep trying.
   */
  encode(call: ZaryaWriteCall): Promise<EncodedCall>;
}
