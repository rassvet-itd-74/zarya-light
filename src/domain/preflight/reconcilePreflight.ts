import type { SimulationResult } from '../ports/CallSimulator';
import { type PreflightVerdict, blockerFor, undetermined } from './verdict';

/**
 * What to believe when the client's own preflight and a simulation disagree.
 *
 * They will disagree, and the disagreements are informative rather than
 * embarrassing. The client reasons from a projection and a handful of reads; the
 * simulation runs the deployed bytecode. When they differ, **the simulation is
 * right about what would happen** and the difference is a fact about this
 * client's model — a stale event projection, an organ read that raced a
 * membership voting, a guard nobody mirrored.
 *
 * So the rule is: prefer the simulation, keep the client verdict, and record
 * that they differed. Hiding the disagreement would throw away the only signal
 * that the projection has drifted.
 *
 * The exception is an outage. `FAILED` with an `UNKNOWN` outcome is not the
 * contract refusing, it is the node not answering, and treating it as a refusal
 * is the mistake `INVARIANTS.md` names outright. Then the client's verdict
 * stands, labelled as what it is.
 */

export type PreflightSource =
  /** The deployed bytecode answered. */
  | 'SIMULATION'
  /** No usable simulation. The verdict is this client's own reasoning. */
  | 'CLIENT';

export type PreflightDisagreement =
  /** The client refused something the contract would accept — the costly direction. */
  | 'CLIENT_STRICTER'
  /** The client would have allowed something the contract refuses. */
  | 'CLIENT_LOOSER'
  /** Both refused, but the client named the wrong revert. */
  | 'PREDICTED_WRONG_ERROR';

export interface ReconciledPreflight {
  readonly verdict: PreflightVerdict;
  readonly source: PreflightSource;
  /** Always kept — it carries the explanation a bare revert does not. */
  readonly client: PreflightVerdict;
  readonly simulation?: SimulationResult;
  readonly disagreement?: PreflightDisagreement;
}

export function reconcilePreflight(
  client: PreflightVerdict,
  simulation: SimulationResult | undefined,
): ReconciledPreflight {
  if (simulation === undefined) {
    return { verdict: client, source: 'CLIENT', client };
  }

  if (simulation.kind === 'WOULD_SUCCEED') {
    return {
      verdict: { kind: 'READY' },
      source: 'SIMULATION',
      client,
      simulation,
      // A client that refuses what the chain accepts is refusing real
      // governance, which is the failure `zarya-chain` warns about by name.
      ...(client.kind === 'BLOCKED' ? { disagreement: 'CLIENT_STRICTER' as const } : {}),
    };
  }

  if (simulation.outcome.kind !== 'REVERTED') {
    // An outage, an empty revert, or a selector nobody can name. None of them is
    // a verdict about what the contract decided.
    return {
      verdict: client.kind === 'READY' ? undetermined('VOTING_UNREAD') : client,
      source: 'CLIENT',
      client,
      simulation,
    };
  }

  const { name, meaning } = simulation.outcome;
  const verdict: PreflightVerdict = {
    kind: 'BLOCKED',
    blocker: blockerFor(name),
    predicted: name,
    meaning,
  };

  return {
    verdict,
    source: 'SIMULATION',
    client,
    simulation,
    ...disagreementWith(client, name),
  };
}

const disagreementWith = (
  client: PreflightVerdict,
  actual: string,
): { disagreement?: PreflightDisagreement } => {
  if (client.kind === 'READY') return { disagreement: 'CLIENT_LOOSER' };
  if (client.kind === 'UNDETERMINED') return {};
  // A client verdict with no predicted error already admits it could not name
  // one, so a differing name is not a disagreement — it is the answer it said it
  // did not have.
  if (client.predicted === undefined || client.predicted === actual) return {};
  return { disagreement: 'PREDICTED_WRONG_ERROR' };
};
