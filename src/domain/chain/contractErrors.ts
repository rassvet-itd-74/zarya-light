/**
 * What a Zarya revert means, and what a caller should do about it.
 *
 * Decoding a selector is adapter work. Deciding that `InsufficientVotes` must
 * never be retried is a product rule, so it lives here and is testable without a
 * node. `zarya-chain`: decode them all, do not invent generic categories.
 *
 * **The ABI is not the whole error surface.** `NoThemeSet`, `NoStatementSet` and
 * `InvalidCategory` are raised from `external` library functions and never reach
 * the ABI; the panics are compiler-generated and are in no ABI by construction.
 * All of them are reachable, so all of them are named here.
 */

export const ZARYA_ERROR_NAMES = [
  // The ABI's 16.
  'AlreadyVoted',
  'CannotRemoveChairman',
  'CategoryAlreadyExists',
  'EmptyInitializationData',
  'InsufficientVotes',
  'InvalidMemberAddress',
  'InvalidOrgan',
  'InvalidPartyOrganType',
  'NotActiveMember',
  'NotChairman',
  'OrgansAlreadyInitialized',
  'UnknownRegion',
  'VotingAlreadyFinalized',
  'VotingNotActive',
  'VotingNotFound',
  'VotingStillActive',
  // Declared in externally-linked libraries, absent from the ABI.
  'NoThemeSet',
  'NoStatementSet',
  'InvalidCategory',
  // Compiler-generated.
  'Panic',
  // The plain `revert("...")` form. Zarya raises none, but a proxy or a
  // misconfigured address might.
  'Error',
] as const;

export type ZaryaErrorName = (typeof ZARYA_ERROR_NAMES)[number];

/**
 * What the caller should do. This is the axis that matters at every call site —
 * a queue asks it to decide retry, a UI asks it to decide wording, and the
 * executor's whole design turns on `TERMINAL`.
 */
export type ErrorDisposition =
  /**
   * The thing the caller wanted is already true. Not a failure: a second client
   * won the race, or this one is retrying something that landed.
   */
  | 'ALREADY_DONE'
  /**
   * Correct call, wrong moment. The same call may succeed later without anything
   * being fixed — `executeVoting` before `endTime` is the case that exists.
   */
  | 'NOT_YET'
  /**
   * The request is wrong and re-sending it unchanged will fail identically.
   * Something about the intent must change.
   */
  | 'REJECTED'
  /**
   * Permanently unachievable. Not retryable, and not fixable by editing the
   * request — the chain will refuse this forever.
   */
  | 'TERMINAL';

export interface ErrorMeaning {
  readonly disposition: ErrorDisposition;
  /** One line, safe to show a user. No addresses, no hashes, no key material. */
  readonly summary: string;
}

const MEANINGS: Readonly<Record<ZaryaErrorName, ErrorMeaning>> = {
  AlreadyVoted: {
    disposition: 'ALREADY_DONE',
    summary: 'This wallet has already voted on this voting.',
  },
  VotingAlreadyFinalized: {
    disposition: 'ALREADY_DONE',
    summary: 'This voting has already been finalized.',
  },
  OrgansAlreadyInitialized: {
    disposition: 'ALREADY_DONE',
    summary: 'Organ setup has already been performed and cannot be repeated.',
  },

  VotingStillActive: {
    disposition: 'NOT_YET',
    summary: 'The voting period has not ended yet, so it cannot be executed.',
  },

  // Terminal. `executeVoting` reverts here and leaves `finalized` false
  // (`Votings.sol:429`), so the voting is past its deadline, never finalized,
  // and every future call reverts identically. Discovery keeps offering it,
  // which is why it has to be recorded and suppressed locally rather than
  // retried. See "Quorum failure is permanent" in CONTRACT_DEFECTS.md.
  InsufficientVotes: {
    disposition: 'TERMINAL',
    summary:
      'This voting received too few votes to meet its quorum. It can never be executed, and will not be retried.',
  },
  // First-writer-wins and permanent (`Matricies.sol:98-104`); there is no
  // rebinding path. But a wrong region ordinal against an already-bound cell
  // produces this too, so check the ordinal before believing the cell.
  InvalidOrgan: {
    disposition: 'TERMINAL',
    summary:
      'This matrix cell is permanently bound to a different organ. Check that the region ordinal is right before concluding the cell is at fault.',
  },

  NotActiveMember: {
    disposition: 'REJECTED',
    summary: 'This wallet is not an active member of the organ governing this action.',
  },
  NotChairman: {
    disposition: 'REJECTED',
    summary: 'Only the Chairman may perform this action.',
  },
  VotingNotFound: {
    disposition: 'REJECTED',
    summary: 'No voting exists with that identifier.',
  },
  VotingNotActive: {
    disposition: 'REJECTED',
    summary: 'The voting window is closed, so no vote can be cast.',
  },
  InvalidPartyOrganType: {
    disposition: 'REJECTED',
    summary: 'That organ type does not exist.',
  },
  UnknownRegion: {
    disposition: 'REJECTED',
    summary:
      'That region ordinal is outside the contract’s enum. A subject code was likely passed where an ordinal belongs.',
  },
  CannotRemoveChairman: {
    disposition: 'REJECTED',
    summary: 'The Chairman cannot be removed by a membership revocation.',
  },
  InvalidMemberAddress: {
    disposition: 'REJECTED',
    summary: 'A member address was empty.',
  },
  CategoryAlreadyExists: {
    disposition: 'REJECTED',
    summary: 'That category is already defined on this cell.',
  },
  EmptyInitializationData: {
    disposition: 'REJECTED',
    summary: 'Organ setup input was empty or its lists were of unequal length.',
  },
  NoThemeSet: {
    disposition: 'REJECTED',
    summary: 'No theme has been set for that column, so nothing can be added under it.',
  },
  NoStatementSet: {
    disposition: 'REJECTED',
    summary: 'No statement has been set for that row, so no value can be added to it.',
  },
  InvalidCategory: {
    disposition: 'REJECTED',
    summary: 'That category is not permitted on this cell.',
  },

  Panic: {
    disposition: 'REJECTED',
    summary: 'The contract hit an internal arithmetic or bounds error.',
  },
  Error: {
    disposition: 'REJECTED',
    summary: 'The contract rejected the call.',
  },
};

/**
 * Solidity's panic codes, only the three reachable here.
 *
 * `0x12` — the zero-vote division in `executeVoting` — was guarded on
 * 2026-08-24 and is unreachable in this source. It stays decodable because the
 * authority for deployed behavior is the bytecode, not this tree, and a
 * deployment predating the fix would still raise it.
 */
export const PANIC_SUMMARIES: Readonly<Record<string, string>> = {
  '0x11': 'Arithmetic overflow or underflow inside the contract.',
  '0x12': 'Division by zero inside the contract.',
  '0x32': 'An index was read past the end of a stored array.',
};

export const isZaryaErrorName = (name: string): name is ZaryaErrorName =>
  (ZARYA_ERROR_NAMES as readonly string[]).includes(name);

export function meaningOf(name: ZaryaErrorName, panicCode?: bigint): ErrorMeaning {
  const base = MEANINGS[name];
  if (name !== 'Panic' || panicCode === undefined) return base;
  const hex = `0x${panicCode.toString(16)}`;
  const summary = PANIC_SUMMARIES[hex];
  return summary === undefined ? base : { disposition: base.disposition, summary };
}

/**
 * What a call produced. `UNKNOWN` is the important member: an undecodable
 * revert, an empty one, or a transport failure must never become a confirmed
 * verdict about the contract (INVARIANTS.md, "Chain safety").
 */
export type CallOutcome =
  | { readonly kind: 'REVERTED'; readonly name: ZaryaErrorName; readonly meaning: ErrorMeaning }
  | { readonly kind: 'UNKNOWN'; readonly reason: 'NOT_A_REVERT' | 'EMPTY_REVERT' | 'UNDECODABLE' };

/** Whether re-sending the identical call could plausibly succeed later. */
export function isRetryable(outcome: CallOutcome): boolean {
  if (outcome.kind === 'UNKNOWN') {
    // An outage is reconcile-later. An undecodable revert is not — but it is
    // also not something a retry loop should hammer, so only transport
    // failures say yes.
    return outcome.reason === 'NOT_A_REVERT';
  }
  return outcome.meaning.disposition === 'NOT_YET';
}

/** Whether this outcome should stop the caller from ever trying again. */
export function isTerminal(outcome: CallOutcome): boolean {
  return outcome.kind === 'REVERTED' && outcome.meaning.disposition === 'TERMINAL';
}
