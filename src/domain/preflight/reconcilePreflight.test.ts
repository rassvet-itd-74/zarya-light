import { describe, expect, it } from 'vitest';
import { meaningOf } from '../chain/contractErrors';
import type { SimulationResult } from '../ports/CallSimulator';
import { reconcilePreflight } from './reconcilePreflight';
import { READY, blocked, blockedByPolicy, undetermined } from './verdict';

const reverting = (name: 'NotActiveMember' | 'VotingNotActive'): SimulationResult => ({
  kind: 'FAILED',
  outcome: { kind: 'REVERTED', name, meaning: meaningOf(name) },
});

const outage: SimulationResult = {
  kind: 'FAILED',
  outcome: { kind: 'UNKNOWN', reason: 'NOT_A_REVERT' },
};

describe('with no simulation', () => {
  it('keeps the client verdict and labels it as the client’s', () => {
    const client = blocked('NOT_AUTHORIZED', 'NotActiveMember');
    expect(reconcilePreflight(client, undefined)).toEqual({
      verdict: client,
      source: 'CLIENT',
      client,
    });
  });
});

describe('when the simulation succeeds', () => {
  it('overrides the client and says so', () => {
    const client = blocked('NOT_AUTHORIZED', 'NotActiveMember');
    const reconciled = reconcilePreflight(client, { kind: 'WOULD_SUCCEED' });

    // The costly direction: refusing what the chain accepts refuses real
    // governance, so the disagreement is surfaced rather than swallowed.
    expect(reconciled.verdict).toEqual(READY);
    expect(reconciled.source).toBe('SIMULATION');
    expect(reconciled.disagreement).toBe('CLIENT_STRICTER');
    expect(reconciled.client).toEqual(client);
  });

  it('reports no disagreement when both agree', () => {
    expect(reconcilePreflight(READY, { kind: 'WOULD_SUCCEED' }).disagreement).toBeUndefined();
  });

  it('overrides an undetermined client without calling it a disagreement', () => {
    // "I could not tell" and "it works" do not conflict.
    const reconciled = reconcilePreflight(undetermined('ORGAN_UNKNOWN'), {
      kind: 'WOULD_SUCCEED',
    });
    expect(reconciled.verdict).toEqual(READY);
    expect(reconciled.disagreement).toBeUndefined();
  });
});

describe('when the simulation reverts', () => {
  it('takes the contract’s answer, including its wording', () => {
    const reconciled = reconcilePreflight(undetermined('ORGAN_UNKNOWN'), reverting('NotActiveMember'));

    expect(reconciled.source).toBe('SIMULATION');
    expect(reconciled.verdict).toMatchObject({
      kind: 'BLOCKED',
      blocker: 'NOT_AUTHORIZED',
      predicted: 'NotActiveMember',
    });
    expect(reconciled.disagreement).toBeUndefined();
  });

  it('flags a client that would have allowed it', () => {
    const reconciled = reconcilePreflight(READY, reverting('NotActiveMember'));
    expect(reconciled.disagreement).toBe('CLIENT_LOOSER');
  });

  it('flags a client that predicted the wrong revert', () => {
    // A stale projection is the usual cause, and this is the signal for it.
    const reconciled = reconcilePreflight(
      blocked('VOTING_WINDOW_CLOSED', 'VotingNotActive'),
      reverting('NotActiveMember'),
    );
    expect(reconciled.disagreement).toBe('PREDICTED_WRONG_ERROR');
    expect(reconciled.verdict).toMatchObject({ predicted: 'NotActiveMember' });
  });

  it('does not flag a client that admitted it could not name one', () => {
    const reconciled = reconcilePreflight(
      { kind: 'BLOCKED', blocker: 'VOTING_WINDOW_CLOSED', meaning: meaningOf('VotingNotActive') },
      reverting('NotActiveMember'),
    );
    expect(reconciled.disagreement).toBeUndefined();
  });

  it('agrees silently when the prediction was right', () => {
    const reconciled = reconcilePreflight(
      blocked('NOT_AUTHORIZED', 'NotActiveMember'),
      reverting('NotActiveMember'),
    );
    expect(reconciled.disagreement).toBeUndefined();
  });
});

describe('when the simulation could not be made', () => {
  it('never turns an outage into a refusal', () => {
    // INVARIANTS.md: an RPC outage yields reconcile-later, not permanent failure.
    const client = blocked('ALREADY_VOTED', 'AlreadyVoted');
    const reconciled = reconcilePreflight(client, outage);

    expect(reconciled.source).toBe('CLIENT');
    expect(reconciled.verdict).toEqual(client);
    expect(reconciled.simulation).toEqual(outage);
  });

  it('withdraws a READY the client could not confirm', () => {
    // The client said yes and the only authority that could check did not
    // answer. Reporting READY would present an unverified guess as verified.
    const reconciled = reconcilePreflight(READY, outage);
    expect(reconciled.verdict).toEqual(undetermined('VOTING_UNREAD'));
  });

  it('keeps a client-policy refusal, which needed no simulation', () => {
    const policy = blockedByPolicy('Too short.');
    expect(reconcilePreflight(policy, outage).verdict).toEqual(policy);
  });
});
