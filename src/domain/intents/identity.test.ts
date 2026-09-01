import { describe, expect, it } from 'vitest';
import { partyOrganTriple } from '../organs/partyOrgan';
import { evmAddress } from '../primitives';
import { votingId } from '../voting/voting';
import { describeIntent, operationKey, relate } from './identity';
import {
  type CastVoteIntent,
  type GovernanceIntent,
  type IntentContext,
  votingRef,
} from './intent';

const ALICE = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const BOB = evmAddress('0x000000000000000000000000000000000000dEaD');

const CONTEXT: IntentContext = {
  chainId: 11155111,
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
  signer: ALICE,
};

const SOVIET = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });

const vote = (id: bigint, direction: 'FOR' | 'AGAINST'): CastVoteIntent => ({
  type: 'CAST_VOTE',
  voting: votingRef(votingId(id)),
  direction,
});

describe('a vote’s identity', () => {
  it('is the same for FOR and AGAINST on one voting, so a contradiction is visible', () => {
    // Direction is deliberately out of the key. Were it in, the two would look
    // unrelated, both would be submitted, and the second would revert
    // AlreadyVoted — which the registry classifies as idempotent completion. A
    // contradiction would be reported as success.
    expect(operationKey(vote(7n, 'FOR'), CONTEXT)).toBe(
      operationKey(vote(7n, 'AGAINST'), CONTEXT),
    );
    expect(relate(vote(7n, 'FOR'), vote(7n, 'AGAINST'), CONTEXT)).toBe('CONTRADICTION');
  });

  it('treats the same direction twice as a plain duplicate', () => {
    expect(relate(vote(7n, 'FOR'), vote(7n, 'FOR'), CONTEXT)).toBe('DUPLICATE');
  });

  it('separates different votings and different signers', () => {
    expect(relate(vote(7n, 'FOR'), vote(8n, 'FOR'), CONTEXT)).toBe('UNRELATED');
    // Two members casting the same vote are two operations, not a duplicate.
    expect(operationKey(vote(7n, 'FOR'), CONTEXT)).not.toBe(
      operationKey(vote(7n, 'FOR'), { ...CONTEXT, signer: BOB }),
    );
  });

  it('separates deployments and chains', () => {
    const elsewhere = { ...CONTEXT, contractAddress: BOB };
    expect(operationKey(vote(7n, 'FOR'), CONTEXT)).not.toBe(operationKey(vote(7n, 'FOR'), elsewhere));
    expect(operationKey(vote(7n, 'FOR'), CONTEXT)).not.toBe(
      operationKey(vote(7n, 'FOR'), { ...CONTEXT, chainId: 1 }),
    );
  });

  it('ignores the casing of an address, which carries no meaning for identity', () => {
    const shouty = { ...CONTEXT, signer: evmAddress(ALICE.toUpperCase().replace('0X', '0x')) };
    expect(operationKey(vote(7n, 'FOR'), shouty)).toBe(operationKey(vote(7n, 'FOR'), CONTEXT));
  });
});

describe('a proposal’s identity', () => {
  const membership = (member: typeof ALICE, duration: number): GovernanceIntent => ({
    type: 'CREATE_MEMBERSHIP_VOTING',
    organ: SOVIET,
    member,
    duration,
  });

  it('ignores the duration, so re-exporting a template is a duplicate', () => {
    // Proposing the same membership change for a day or a week is the same
    // proposal. Including the duration would let one member create two competing
    // votings for the same decision.
    expect(relate(membership(BOB, 86_400), membership(BOB, 604_800), CONTEXT)).toBe('DUPLICATE');
  });

  it('separates different subjects', () => {
    expect(relate(membership(BOB, 86_400), membership(ALICE, 86_400), CONTEXT)).toBe('UNRELATED');
  });

  it('separates admitting from removing the same person', () => {
    const remove: GovernanceIntent = {
      type: 'CREATE_MEMBERSHIP_REVOCATION_VOTING',
      organ: SOVIET,
      member: BOB,
      duration: 86_400,
    };
    expect(relate(membership(BOB, 86_400), remove, CONTEXT)).toBe('UNRELATED');
  });

  it('separates the same proposal from different organs', () => {
    const elsewhere: GovernanceIntent = {
      type: 'CREATE_MEMBERSHIP_VOTING',
      organ: partyOrganTriple({ organType: 'RegionalConference', region: 20 }),
      member: BOB,
      duration: 1,
    };
    expect(relate(membership(BOB, 1), elsewhere, CONTEXT)).toBe('UNRELATED');
  });
});

describe('a numerical value’s identity', () => {
  const value = (v: bigint, decimals: number): GovernanceIntent => ({
    type: 'CREATE_NUMERICAL_VALUE_VOTING',
    organ: SOVIET,
    at: { x: 1n, y: 2n },
    value: v,
    decimals,
    valueAuthor: BOB,
    duration: 86_400,
  });

  it('keys on the scaled integer, so 1.5 and 1.50 are one proposal', () => {
    // Both parse to 150n at two decimals. A key built from the written text
    // would submit two votings for one number.
    expect(relate(value(150n, 2), value(150n, 2), CONTEXT)).toBe('DUPLICATE');
    expect(relate(value(150n, 2), value(151n, 2), CONTEXT)).toBe('UNRELATED');
  });

  it('includes the scale, because the same integer at a different scale is a different value', () => {
    expect(relate(value(150n, 2), value(150n, 3), CONTEXT)).toBe('UNRELATED');
  });
});

describe('threshold configuration identity', () => {
  const configure = (quorum: bigint, approval: bigint): GovernanceIntent => ({
    type: 'CONFIGURE_ORGAN_THRESHOLDS',
    organ: SOVIET,
    quorum,
    approvalPercentage: approval,
    approvalPercentageBase: 10_000n,
  });

  it('never collapses two different configurations of one organ', () => {
    // Collapsing them to "configure this organ" would let a second import
    // silently replace the first in a batch.
    expect(relate(configure(10n, 6600n), configure(20n, 6600n), CONTEXT)).toBe('UNRELATED');
    expect(relate(configure(10n, 6600n), configure(10n, 5000n), CONTEXT)).toBe('UNRELATED');
    expect(relate(configure(10n, 6600n), configure(10n, 6600n), CONTEXT)).toBe('DUPLICATE');
  });
});

describe('free text in a key', () => {
  const theme = (text: string, matrix: 'CATEGORICAL' | 'NUMERICAL' = 'CATEGORICAL'): GovernanceIntent => ({
    type: 'CREATE_THEME_VOTING',
    matrix,
    x: 1n,
    theme: text,
    duration: 86_400,
  });

  it('cannot forge a segment boundary', () => {
    // Length-prefixed, so an author cannot craft a theme whose key collides with
    // another proposal's.
    expect(operationKey(theme('a|b'), CONTEXT)).not.toBe(operationKey(theme('a'), CONTEXT));
    expect(relate(theme('a|b'), theme('a'), CONTEXT)).toBe('UNRELATED');
  });

  it('separates the two matrices at the same coordinate', () => {
    expect(relate(theme('Housing'), theme('Housing', 'NUMERICAL'), CONTEXT)).toBe('UNRELATED');
  });
});

describe('describing an intent for review and audit', () => {
  it('renders a numerical value back through its own scale', () => {
    // The review screen shows what the member wrote, not the stored integer.
    const described = describeIntent({
      type: 'CREATE_NUMERICAL_VALUE_VOTING',
      organ: SOVIET,
      at: { x: 1n, y: 2n },
      value: 1234n,
      decimals: 2,
      valueAuthor: BOB,
      duration: 86_400,
    });
    expect(described).toContain('12.34');
    expect(described).not.toContain('1234');
  });

  it('states thresholds as basis points and never as a percentage', () => {
    // Rendering "66%" here would be the first step toward someone entering 66.
    const described = describeIntent({
      type: 'CONFIGURE_ORGAN_THRESHOLDS',
      organ: SOVIET,
      quorum: 10n,
      approvalPercentage: 6600n,
      approvalPercentageBase: 10_000n,
    });
    expect(described).toContain('6600');
    expect(described).toContain('basis points');
    expect(described).not.toContain('%');
  });

  it('names the organ by its identifier, which carries the subject code', () => {
    // Chechnya: ordinal 20, subject code 95. The label a reader sees is the code.
    expect(describeIntent(vote(7n, 'FOR'))).not.toContain('95');
    expect(
      describeIntent({
        type: 'CREATE_MEMBERSHIP_VOTING',
        organ: SOVIET,
        member: BOB,
        duration: 1,
      }),
    ).toContain('95.');
  });

  it('says which way a vote goes, from the explicit direction', () => {
    expect(describeIntent(vote(7n, 'FOR'))).toContain('FOR');
    expect(describeIntent(vote(7n, 'AGAINST'))).toContain('AGAINST');
  });
});
