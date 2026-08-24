import { http, createPublicClient } from 'viem';
import { sepolia } from 'viem/chains';

/**
 * The read-only client. There is no wallet client anywhere in this phase: this
 * slice, and Phase 2 as a whole, cannot sign or broadcast because it has nothing
 * to sign with.
 *
 * `chain` is pinned to Sepolia for viem's own defaults, but that is a hint, not
 * a check — what the endpoint actually reports is read over RPC and judged by
 * the domain. A configured chain object proves nothing about the node behind it.
 */

export interface PublicClientOptions {
  /** Secret: may carry an API key in its path, so it is never logged. */
  rpcUrl: string;
  /** Kept low: startup identity checks must not hang the app. */
  timeoutMs?: number;
  retryCount?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_COUNT = 2;

export function createZaryaPublicClient({
  rpcUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryCount = DEFAULT_RETRY_COUNT,
}: PublicClientOptions) {
  return createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { timeout: timeoutMs, retryCount }),
  });
}

/**
 * The concrete client type, inferred rather than annotated. viem's `PublicClient`
 * generics do not describe a chain-bound client without restating them, and a
 * mismatched annotation is a fight with no prize.
 */
export type ZaryaPublicClient = ReturnType<typeof createZaryaPublicClient>;
