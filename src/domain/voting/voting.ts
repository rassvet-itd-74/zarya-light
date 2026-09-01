import { type Brand, type Bytes32, type EvmAddress, InvalidPrimitiveError, type UnixSeconds } from '../primitives';

/**
 * What a voting is, as far as this client can know.
 *
 * There is no `getVoting(id)`. The struct exists on chain (`Votings.sol:90-104`)
 * and nothing exposes it, so everything below `votingId` comes from the creation
 * events rather than from a read. That makes the event projection load-bearing
 * for vote preflight, not merely for deadline discovery.
 */

/**
 * A voting identifier. `uint256` on chain, so `bigint` here.
 *
 * Zero is rejected: `votingExists` refuses it (`Zarya.sol:565-567`), so a call
 * carrying it is a wasted round trip that can only revert.
 */
export type VotingId = Brand<bigint, 'VotingId'>;

export function votingId(value: bigint): VotingId {
  if (value <= 0n) {
    throw new InvalidPrimitiveError('a voting id must be a positive integer', value.toString());
  }
  return value as VotingId;
}

/** `Votings.SuggestionType`, ordinals 0-7 in declaration order. */
export const SUGGESTION_TYPES = [
  'Membership',
  'MembershipRevocation',
  'Category',
  'Decimals',
  'Theme',
  'Statement',
  'CategoricalValue',
  'NumericalValue',
] as const;

export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export function suggestionTypeByOrdinal(ordinal: number): SuggestionType {
  const found = SUGGESTION_TYPES[ordinal];
  if (found === undefined) {
    throw new InvalidPrimitiveError(
      `a suggestion type ordinal must be in 0..${SUGGESTION_TYPES.length - 1}`,
      ordinal,
    );
  }
  return found;
}

export const suggestionTypeOrdinal = (type: SuggestionType): number =>
  SUGGESTION_TYPES.indexOf(type);

/**
 * Whether a voting of this type is governed by an organ at all.
 *
 * `ThemeVotingCreated` and `StatementVotingCreated` carry no organ, correctly:
 * theme and statement votings have none, and **anyone may vote on them**. Every
 * other creation event carries one.
 */
export const isOrganGoverned = (type: SuggestionType): boolean =>
  type !== 'Theme' && type !== 'Statement';

/**
 * Which organ decides a voting — and, crucially, the difference between "none"
 * and "we do not know".
 *
 * `castVote` reads the organ from stored state and there is no getter for it, so
 * this comes from the creation event or not at all. **`UNKNOWN` must never
 * collapse into `NONE`.** `NONE` means anyone may vote; telling a non-member
 * that, on the strength of a projection gap, invites them to sign a transaction
 * that reverts. An unknown organ means simulate, never assume.
 */
export type GoverningOrgan =
  | { readonly kind: 'ORGAN'; readonly organ: Bytes32 }
  /** Theme and statement votings. Anyone may vote. */
  | { readonly kind: 'NONE' }
  /** The projection has no detail event for this voting. Eligibility undetermined. */
  | { readonly kind: 'UNKNOWN' };

export const KNOWN_ORGAN = (organ: Bytes32): GoverningOrgan => ({ kind: 'ORGAN', organ });
export const NO_ORGAN: GoverningOrgan = { kind: 'NONE' };
export const UNKNOWN_ORGAN: GoverningOrgan = { kind: 'UNKNOWN' };

/**
 * A voting as projected from its creation events.
 *
 * `endTime` is the reason this record exists: it is carried by `VotingCreated`
 * and by nothing else, so a client with a gap in its projection cannot say when
 * a voting closes.
 */
export interface VotingRecord {
  readonly votingId: VotingId;
  readonly author: EvmAddress;
  readonly startTime: UnixSeconds;
  readonly endTime: UnixSeconds;
  readonly suggestionType: SuggestionType;
  readonly governingOrgan: GoverningOrgan;
  /** Where the `VotingCreated` log sat, for cursor and reorg reasoning. */
  readonly blockNumber: bigint;
}

/**
 * Resolves what a projection knows about a voting's organ.
 *
 * The suggestion type decides whether absence is *legitimate*: for a theme or
 * statement voting there is genuinely no organ, and for every other type a
 * missing detail event means the projection is incomplete.
 */
export function governingOrganFrom(
  suggestionType: SuggestionType,
  organ: Bytes32 | undefined,
): GoverningOrgan {
  if (!isOrganGoverned(suggestionType)) return NO_ORGAN;
  return organ === undefined ? UNKNOWN_ORGAN : KNOWN_ORGAN(organ);
}
