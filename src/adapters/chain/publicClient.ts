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
  return hideTransportUrl(
    createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl, { timeout: timeoutMs, retryCount }),
    }),
  );
}

/**
 * Makes a viem client's transport URL non-enumerable, so it stops travelling
 * into logs.
 *
 * **Found by testing the signer, on 2026-09-06.** A client keeps the URL it was
 * built with on `transport.url`, and it is an ordinary enumerable property — so
 * `JSON.stringify` and `util.inspect` on *anything holding a client* print it in
 * full. Twelve classes in this adapter hold one. An API key in an error report
 * is the kind of leak nobody notices until the key is rotated for other reasons.
 *
 * Non-enumerable rather than deleted, because viem reads it: the property still
 * resolves for every caller that names it, and only the enumerating routes stop
 * seeing it. `JSON.stringify` skips it, `console.log` skips it, `structuredClone`
 * skips it; `inspect(x, { showHidden: true })` still shows it, which is the
 * deliberate escape hatch for someone actually debugging a transport.
 *
 * This is a narrowing, not a guarantee. A caller that reads `transport.url` and
 * logs it defeats it, and nothing here can stop that.
 */
export function hideTransportUrl<T>(client: T): T {
  const transport = (client as { transport?: Record<string, unknown> }).transport;
  if (transport === undefined || !Object.hasOwn(transport, 'url')) return client;
  const descriptor = Object.getOwnPropertyDescriptor(transport, 'url');
  // A getter or a non-configurable property is left alone rather than replaced:
  // guessing at viem's internals would be worse than the leak.
  if (descriptor?.configurable !== true || descriptor.get !== undefined) return client;
  Object.defineProperty(transport, 'url', { ...descriptor, enumerable: false });
  return client;
}

/**
 * The concrete client type, inferred rather than annotated. viem's `PublicClient`
 * generics do not describe a chain-bound client without restating them, and a
 * mismatched annotation is a fight with no prize.
 */
export type ZaryaPublicClient = ReturnType<typeof createZaryaPublicClient>;
