import type { NetworkVerdict } from '../network/networkIdentity';

/**
 * Answers "may this client talk to what it is pointed at?".
 *
 * Called before every write session and after every provider reconnect
 * (INVARIANTS.md, "Chain safety"), not once at startup — a provider can come
 * back on a different chain, and a verdict is only as fresh as its last check.
 */
export interface NetworkGuard {
  /**
   * Never throws for a network condition: an unreachable provider is the
   * `UNREACHABLE` verdict, not an exception. Callers must be able to treat
   * "cannot tell" differently from "definitely wrong".
   */
  verify(): Promise<NetworkVerdict>;
}
