import type { VotingRecord } from '../voting/voting';

/**
 * Indexing `VotingCreated` and the per-type detail events that accompany it.
 *
 * `VotingCreated` is the discovery primitive and the **only** carrier of
 * `endTime`; the detail events are the only carrier of a voting's organ. Both
 * absences are contract limitations, not design choices here.
 *
 * The port scans a window and reports what it found. It does not decide which
 * window — that is `planDiscovery` — and it does not move the cursor, because
 * the cursor may only advance after the records have been handled.
 */

export interface ScannedWindow {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** In ascending `votingId` order. Empty is the ordinary case between polls. */
  readonly records: readonly VotingRecord[];
  /**
   * Votings whose `VotingCreated` was found but whose detail event was not, in
   * this window. Their organ is `UNKNOWN`, not absent, and eligibility for them
   * must be simulated. A non-empty list on a full-window scan means the two logs
   * landed either side of a boundary and a re-scan will resolve it.
   */
  readonly withoutDetail: readonly bigint[];
}

export interface VotingDiscovery {
  /** Inclusive on both ends, matching `eth_getLogs`. */
  scan(fromBlock: bigint, toBlock: bigint): Promise<ScannedWindow>;
}
