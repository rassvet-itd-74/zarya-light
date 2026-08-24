import type { Hex } from 'viem';

/**
 * Telling a revert apart from a transport failure.
 *
 * This distinction is the whole reason the module exists. "The node did not
 * answer" and "the contract rejected the call" look similar at the catch site
 * and mean opposite things: one is reconcile-later, the other is a verdict. Get
 * it wrong and an RPC hiccup is reported as a wrong deployment.
 *
 * Matching is duck-typed over the error's cause chain rather than by
 * `instanceof`, so a viem upgrade that reshapes its error classes degrades to
 * "not a revert" — which is the safe direction: unknown, not condemned.
 */

const MAX_CAUSE_DEPTH = 10;

const REVERT_ERROR_NAMES = new Set([
  'ContractFunctionRevertedError',
  'RawContractError',
  'CallExecutionError',
  'ContractFunctionExecutionError',
  'ExecutionRevertedError',
]);

const isHex = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

const causeChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
};

export interface RevertObservation {
  /** Revert payload, if any. Absent or `0x` means the call hit no function. */
  readonly data?: Hex;
}

/**
 * Returns the revert observation, or `undefined` when the failure was not a
 * revert at all — a timeout, a DNS failure, a 500 from the provider.
 */
export function readRevert(error: unknown): RevertObservation | undefined {
  let looksLikeRevert = false;
  let data: Hex | undefined;

  for (const node of causeChain(error)) {
    if (node == null || typeof node !== 'object') continue;
    const candidate = node as {
      name?: unknown;
      data?: unknown;
      details?: unknown;
      shortMessage?: unknown;
    };

    if (typeof candidate.name === 'string' && REVERT_ERROR_NAMES.has(candidate.name)) {
      looksLikeRevert = true;
    }
    for (const text of [candidate.details, candidate.shortMessage]) {
      if (typeof text === 'string' && text.toLowerCase().includes('execution reverted')) {
        looksLikeRevert = true;
      }
    }
    // The first hex payload found wins: the innermost error carries the raw
    // returndata, and outer wrappers repeat it.
    if (data === undefined && isHex(candidate.data)) {
      data = candidate.data;
      looksLikeRevert = true;
    }
  }

  if (!looksLikeRevert) return undefined;
  // `0x` is an empty revert, which is the signal we care about — normalize it
  // away so callers test one thing.
  return data === undefined || data === '0x' ? {} : { data };
}
