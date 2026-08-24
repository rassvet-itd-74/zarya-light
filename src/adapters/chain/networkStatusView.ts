import type { NetworkVerdict } from '../../domain/network/networkIdentity';
import { isTransientVerdict, isUsableNetwork } from '../../domain/network/networkIdentity';

/**
 * Turns a domain verdict into something that can cross IPC and be read by a
 * person.
 *
 * The wording lives here rather than in the domain, which does not format
 * user-facing strings (`zarya-hexagonal`). The DTO is deliberately free of
 * `bigint` so it survives `JSON.stringify` as well as structured clone, and
 * carries no URL — the RPC endpoint may hold an API key.
 */

export type NetworkStatusCode = NetworkVerdict['status'] | 'NOT_CHECKED';

export interface NetworkStatusView {
  readonly status: NetworkStatusCode;
  /** One sentence, safe to display, saying what to do about it. */
  readonly detail: string;
  readonly chainId: number | null;
  /** Decimal string: block numbers are bigint and DTOs are not. */
  readonly blockNumber: string | null;
  /** Whether re-checking could change the answer. */
  readonly transient: boolean;
  readonly usable: boolean;
}

export const NOT_CHECKED: NetworkStatusView = {
  status: 'NOT_CHECKED',
  detail: 'The network has not been checked yet.',
  chainId: null,
  blockNumber: null,
  transient: true,
  usable: false,
};

const detailFor = (verdict: NetworkVerdict): string => {
  switch (verdict.status) {
    case 'OK':
      return `Connected to Sepolia at block ${verdict.blockNumber}.`;
    case 'WRONG_NETWORK':
      return `The RPC endpoint reports chain ${verdict.observed}, but this client only works on Sepolia (${verdict.permitted}). Point ZARYA_RPC_URL at a Sepolia endpoint.`;
    case 'NO_CONTRACT_CODE':
      return `No contract is deployed at ${verdict.address} on this network. Check ZARYA_CONTRACT_ADDRESS.`;
    case 'NOT_ZARYA':
      return verdict.reason === 'ELIGIBILITY_FINGERPRINT_MISMATCH'
        ? `The contract at ${verdict.address} answered simpleMajority() with unexpected values, so it is not the Zarya deployment this client expects.`
        : `The contract at ${verdict.address} accepted a vote on voting 0, which Zarya always rejects. This is a different contract.`;
    case 'WRONG_DEPLOYMENT':
      return `The contract at ${verdict.address} does not accept the two-argument castVote, so it is an older Zarya deployment. Point ZARYA_CONTRACT_ADDRESS at the current one.`;
    case 'UNREACHABLE':
      return `Could not reach the RPC endpoint (no ${verdict.missing.join(', ')}). This is not a rejection — it will be retried.`;
  }
};

export function toNetworkStatusView(verdict: NetworkVerdict): NetworkStatusView {
  return {
    status: verdict.status,
    detail: detailFor(verdict),
    chainId:
      verdict.status === 'OK'
        ? verdict.chainId
        : verdict.status === 'WRONG_NETWORK'
          ? verdict.observed
          : null,
    blockNumber: verdict.status === 'OK' ? verdict.blockNumber.toString() : null,
    transient: isTransientVerdict(verdict),
    usable: isUsableNetwork(verdict),
  };
}
