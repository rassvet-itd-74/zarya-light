import type { UnixSeconds } from '../primitives';

/**
 * Time, as the domain is allowed to know it.
 *
 * Deadline decisions use the **chain block timestamp**, never the workstation
 * clock (INVARIANTS.md, "Chain safety"). Behind a port, reaching for wall-clock
 * time in a deadline decision means importing something `src/domain/` forbids,
 * so lint catches it. Without a port it is a one-character mistake that
 * produces a subtly wrong executor.
 *
 * Declared before it has a production implementation, deliberately: the chain
 * adapter supplies one in Phase 2, and introducing this port after call sites
 * exist means rewriting them. The second implementation today is the test fake.
 */
export interface Clock {
  chainTime(): Promise<UnixSeconds>;
}
