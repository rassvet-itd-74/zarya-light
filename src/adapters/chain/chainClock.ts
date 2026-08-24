import type { Clock } from '../../domain/ports/Clock';
import { type UnixSeconds, unixSeconds } from '../../domain/primitives';
import type { ZaryaPublicClient } from './publicClient';

/**
 * `Clock` over chain block time.
 *
 * The port was declared in Phase 1 with no implementation precisely so that this
 * is the first one: deadline decisions read the chain's clock, never the
 * workstation's, and with the port in place reaching for `Date.now()` in a
 * deadline means importing something `src/domain/` forbids.
 *
 * Block timestamps are seconds since the epoch, which is why `UnixSeconds` is
 * seconds — a millisecond value branded as this type is a compile error.
 */
export class ChainClock implements Clock {
  constructor(private readonly client: ZaryaPublicClient) {}

  async chainTime(): Promise<UnixSeconds> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    // viem returns bigint seconds. Safe-integer range is not in question for a
    // timestamp, but the conversion is explicit rather than implicit.
    return unixSeconds(Number(block.timestamp));
  }
}
