import { type ChainId, chainId } from '../primitives';

/**
 * Which network this client is permitted to talk to.
 *
 * Hard rule 1: Sepolia only. This is the single place in code where that chain
 * id appears — DEPLOYMENT.md records it for humans, configuration carries the
 * runtime value, and this module decides whether that value is allowed.
 *
 * It lives in the domain rather than in the chain adapter because it is a
 * product rule, not a translation. The Phase 2 `NetworkGuard` adapter observes
 * the chain id over RPC and asks this module; it does not re-decide.
 */
export const PERMITTED_CHAIN_ID: ChainId = chainId(11155111);

export const PERMITTED_NETWORK_NAME = 'Sepolia';

export class NetworkNotPermittedError extends Error {
  readonly observed: ChainId;
  readonly permitted: ChainId;

  constructor(observed: ChainId) {
    super(
      `network not permitted: chainId ${observed} is not ${PERMITTED_NETWORK_NAME} (${PERMITTED_CHAIN_ID}). ` +
        'This client is restricted to a single network by product rule.',
    );
    this.name = 'NetworkNotPermittedError';
    this.observed = observed;
    this.permitted = PERMITTED_CHAIN_ID;
  }
}

export function isPermittedNetwork(observed: ChainId): boolean {
  return observed === PERMITTED_CHAIN_ID;
}

/**
 * Throws unless `observed` is the permitted network. Called at configuration
 * load, before every write session, and after every provider reconnect.
 */
export function assertPermittedNetwork(observed: ChainId): void {
  if (!isPermittedNetwork(observed)) {
    throw new NetworkNotPermittedError(observed);
  }
}
