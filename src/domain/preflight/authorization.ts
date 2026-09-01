import type { Bytes32 } from '../primitives';
import type { GoverningOrgan, SuggestionType } from '../voting/voting';

/**
 * Who the contract lets call what, as a value rather than as scattered `if`s.
 *
 * `zarya-chain`: **preflight must mirror the contract's checks exactly** —
 * anything stricter rejects calls the contract would accept, and the Chairman
 * exemption is the place that invites a wrong guess, because it applies to some
 * guarded entry points and not others.
 *
 * The rules are read from `Zarya.sol`'s modifiers and bodies, and there are only
 * four of them plus one non-answer. Phase 3's intent union maps each variant onto
 * one of these; nothing else in the client is allowed to decide authorization.
 */
export type AuthorizationRule =
  /**
   * No check at all. `createThemeVoting`, `createStatementVoting`,
   * `executeVoting`, every getter — and `castVote` on a voting with no organ.
   *
   * **Do not add a membership check to these.** They are open by design, and a
   * client that refused a non-member would be refusing a call the chain accepts.
   */
  | { readonly kind: 'PERMISSIONLESS' }
  /**
   * `_onlyMemberOrChairman` — membership in the named organ, or membership in
   * the Chairperson organ. Membership votings and `castVote`.
   */
  | { readonly kind: 'MEMBER_OR_CHAIRMAN'; readonly organ: Bytes32 }
  /**
   * `onlyMember` — membership in the named organ, and **the Chairman is not
   * exempt**. The four matrix-configuration votings, and the only place in the
   * contract where the Chairman override does not apply.
   */
  | { readonly kind: 'MEMBER_ONLY'; readonly organ: Bytes32 }
  /** `onlyChairman` — the privileged setters and `transferChairmanship`. */
  | { readonly kind: 'CHAIRMAN_ONLY' }
  /**
   * Not a rule the contract has: the rule this client cannot determine, because
   * it does not know which organ decides.
   *
   * Two ways to get here. `castVote` reads the voting's organ from storage and
   * no getter returns it, so a voting missing from the event projection has an
   * eligibility nobody can evaluate locally — see "A voting's governing organ
   * has no getter" in `CONTRACT_DEFECTS.md`. And an intent naming an organ whose
   * `bytes32` has not been resolved yet is in the same position for a duller
   * reason.
   *
   * Neither is the same as **no** organ, which is a permission.
   */
  | { readonly kind: 'UNDETERMINED_ORGAN' };

export const PERMISSIONLESS: AuthorizationRule = { kind: 'PERMISSIONLESS' };
export const CHAIRMAN_ONLY: AuthorizationRule = { kind: 'CHAIRMAN_ONLY' };
export const UNDETERMINED_ORGAN: AuthorizationRule = { kind: 'UNDETERMINED_ORGAN' };

/**
 * What was actually read about the caller. Both optional, and the optionality is
 * load-bearing — an unread membership must never be judged as a denial.
 */
export interface MembershipObservations {
  /** `isMember(rule.organ, caller)`. Absent unless the rule names an organ. */
  readonly memberOfOrgan?: boolean;
  /** `isMember(CHAIRPERSON_ORGAN, caller)` — the Chairman check, which has no getter of its own. */
  readonly chairman?: boolean;
}

export type AuthorizationVerdict =
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'DENIED'; readonly reason: DenialReason; readonly predicted: PredictedRevert }
  | { readonly kind: 'UNDETERMINED'; readonly reason: UndeterminedReason };

export type DenialReason =
  /** Not in the organ, and not the Chairman either. */
  | 'NOT_A_MEMBER'
  /** In neither the organ nor an exemption, because this rule grants none. */
  | 'MEMBER_ONLY_ORGAN'
  | 'NOT_CHAIRMAN';

export type UndeterminedReason =
  /** The voting's organ is not in the projection. Simulate; do not assume. */
  | 'ORGAN_UNKNOWN'
  /** `isMember` did not answer. An outage is not a denial. */
  | 'MEMBERSHIP_UNREAD';

/** The revert a denied call would produce, so a prediction can be checked against one. */
export type PredictedRevert = 'NotActiveMember' | 'NotChairman';

const ALLOWED: AuthorizationVerdict = { kind: 'ALLOWED' };

const undetermined = (reason: UndeterminedReason): AuthorizationVerdict => ({
  kind: 'UNDETERMINED',
  reason,
});

const denied = (reason: DenialReason, predicted: PredictedRevert): AuthorizationVerdict => ({
  kind: 'DENIED',
  reason,
  predicted,
});

/**
 * Applies a rule to what was read.
 *
 * Two asymmetries are deliberate and both come from the same principle — an
 * unread fact is not a false one:
 *
 * - Under `MEMBER_OR_CHAIRMAN`, either read alone can *grant*. A confirmed
 *   member need not be checked against the Chairperson organ, and a confirmed
 *   Chairman need not be a member. Only when neither read grants does the
 *   absence of the other one matter.
 * - Nothing here ever denies on a missing read. `UNDETERMINED` is the answer,
 *   and the caller simulates.
 */
export function judgeAuthorization(
  rule: AuthorizationRule,
  observations: MembershipObservations,
): AuthorizationVerdict {
  const { memberOfOrgan, chairman } = observations;

  switch (rule.kind) {
    case 'PERMISSIONLESS':
      return ALLOWED;

    case 'MEMBER_OR_CHAIRMAN':
      if (memberOfOrgan === true || chairman === true) return ALLOWED;
      if (memberOfOrgan === undefined || chairman === undefined) {
        return undetermined('MEMBERSHIP_UNREAD');
      }
      return denied('NOT_A_MEMBER', 'NotActiveMember');

    case 'MEMBER_ONLY':
      if (memberOfOrgan === undefined) return undetermined('MEMBERSHIP_UNREAD');
      // No Chairman branch, and its absence is the whole point: the
      // `onlyMember` modifier calls `_onlyMember` (Zarya.sol:36-38, 559-563),
      // which consults the named organ and nothing else.
      return memberOfOrgan ? ALLOWED : denied('MEMBER_ONLY_ORGAN', 'NotActiveMember');

    case 'CHAIRMAN_ONLY':
      if (chairman === undefined) return undetermined('MEMBERSHIP_UNREAD');
      return chairman ? ALLOWED : denied('NOT_CHAIRMAN', 'NotChairman');

    case 'UNDETERMINED_ORGAN':
      return undetermined('ORGAN_UNKNOWN');
  }
}

/** Which organ, if any, a rule requires a membership read against. */
export const organToCheck = (rule: AuthorizationRule): Bytes32 | undefined =>
  rule.kind === 'MEMBER_OR_CHAIRMAN' || rule.kind === 'MEMBER_ONLY' ? rule.organ : undefined;

/**
 * Whether a rule can be decided without reading the Chairperson organ.
 *
 * `MEMBER_ONLY` grants the Chairman nothing, so reading it there would be a
 * wasted round trip *and* an invitation to use the answer.
 */
export const needsChairmanRead = (rule: AuthorizationRule): boolean =>
  rule.kind === 'MEMBER_OR_CHAIRMAN' || rule.kind === 'CHAIRMAN_ONLY';

/**
 * The rule guarding `castVote`, derived from what the projection knows.
 *
 * All three arms matter. `NONE` is a real permission — theme and statement
 * votings skip the organ check entirely, so anyone may vote on them — and
 * `UNKNOWN` must never borrow that answer.
 */
export function castVoteRule(organ: GoverningOrgan): AuthorizationRule {
  switch (organ.kind) {
    case 'NONE':
      return PERMISSIONLESS;
    case 'ORGAN':
      return { kind: 'MEMBER_OR_CHAIRMAN', organ: organ.organ };
    case 'UNKNOWN':
      return UNDETERMINED_ORGAN;
  }
}

/**
 * The rule guarding creation of each voting type — the access-control table in
 * `CONTRACT.md`, as code.
 *
 * Exhaustive over `SuggestionType` with no default arm, so adding a ninth type
 * is a compile error here rather than a silent inheritance of whichever rule
 * happened to be first.
 */
export function creationRule(type: SuggestionType, organ: Bytes32): AuthorizationRule {
  switch (type) {
    // `_onlyMemberOrChairman(organ)` — Zarya.sol:75, 98.
    case 'Membership':
    case 'MembershipRevocation':
      return { kind: 'MEMBER_OR_CHAIRMAN', organ };

    // `onlyMember(organ)` — Zarya.sol:123, 151, 227, 254. The Chairman is not
    // exempt from any of these four.
    case 'Category':
    case 'Decimals':
    case 'CategoricalValue':
    case 'NumericalValue':
      return { kind: 'MEMBER_ONLY', organ };

    // No modifier and no organ argument at all — Zarya.sol:170, 193. These
    // snapshot `simpleMajority` and are open to anyone.
    case 'Theme':
    case 'Statement':
      return PERMISSIONLESS;
  }
}
