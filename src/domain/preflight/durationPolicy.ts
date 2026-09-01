import { type PreflightCheck, READY, blockedByPolicy } from './verdict';

/**
 * How long a voting may run — a **client rule**, and the only one in preflight
 * that the contract does not share.
 *
 * `self.endTime = block.timestamp + duration` in all eight creators
 * (`Votings.sol:166`, `194`, `225`, …), with no floor and no ceiling anywhere
 * along the way. `duration == 0` produces a voting whose window closes
 * in the block that created it, so it is votable only by someone in that same
 * block; the deployment's one existing voting used 120 seconds and collected
 * zero votes, which is the same failure a little slower.
 *
 * Being stricter than the chain is normally the wrong move — a client that
 * refuses what Solidity accepts refuses real governance. It is right here for
 * one narrow reason: the value being bounded is *this member's own proposal*,
 * not someone else's action, and every value outside these bounds produces a
 * voting that cannot serve its purpose. The refusal is marked `CLIENT_POLICY`
 * rather than mirroring a revert, so nothing downstream can mistake it for
 * something the contract said.
 */

/**
 * An hour. Below this, a proposal cannot realistically reach the members who
 * would have to fill in a form and return it — and a voting nobody could vote on
 * is not a proposal, it is an accident.
 */
export const MIN_DURATION_SECONDS = 60 * 60;

/**
 * A year. Above this the executor holds a job it will not act on for longer than
 * this client has existed, and a mistyped duration is far more likely than a
 * deliberate one.
 */
export const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;

const readable = (seconds: number): string =>
  seconds % 86_400 === 0
    ? `${seconds / 86_400} day(s)`
    : `${Math.round(seconds / 3600)} hour(s)`;

export function judgeDuration(seconds: number): PreflightCheck {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return blockedByPolicy('A voting duration must be a whole number of seconds.');
  }
  if (seconds < MIN_DURATION_SECONDS) {
    return blockedByPolicy(
      `A voting must run for at least ${readable(MIN_DURATION_SECONDS)}, so members have time to receive and return a form.`,
    );
  }
  if (seconds > MAX_DURATION_SECONDS) {
    return blockedByPolicy(`A voting must not run for longer than ${readable(MAX_DURATION_SECONDS)}.`);
  }
  return READY;
}
