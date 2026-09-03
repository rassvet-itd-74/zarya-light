import { decodeFunctionResult, encodeFunctionData } from 'viem';
import type { CallOutcome } from '../../domain/chain/contractErrors';
import type { EvmAddress } from '../../domain/primitives';
import { classifyCallFailure } from './errorDecoder';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * One `eth_call` against Zarya, encoded and decoded through the bundled ABI.
 *
 * encode/call/decode rather than viem's `readContract`: the ABI is imported as
 * JSON, which widens it to `Abi`, and viem's per-function generics do not
 * survive that. Restating the signatures to win the inference back would
 * reintroduce exactly the hand-written transcriptions `zarya-chain` forbids.
 *
 * The failure is **classified, not thrown**. Every reader in this client owes
 * its caller the difference between "the contract said no" and "we could not
 * ask", and a shared `throw` would erase it at the first `try` that forgot.
 */
export type ReadOutcome =
  | { readonly kind: 'VALUE'; readonly value: unknown }
  | { readonly kind: 'FAILURE'; readonly failure: CallOutcome };

export interface ContractCallOptions {
  /**
   * The `from` address of the call.
   *
   * For a `view` read this changes nothing. For a **simulation** it is the whole
   * point: every authorization guard in Zarya tests `msg.sender`, so a
   * simulation without it answers a question about the zero address.
   */
  readonly from?: EvmAddress;
  /**
   * Pins the read to one block. Omitted, it reads the head.
   *
   * Preflight wants the head — it is predicting what happens if a transaction is
   * sent now. A **report** wants a pin, because a document assembled across
   * moving state can show a pairing that never existed on chain, with nothing on
   * the page able to reveal it. See `MatrixSnapshotReader`.
   */
  readonly blockNumber?: bigint;
}

export async function callContract(
  client: ZaryaPublicClient,
  address: EvmAddress,
  functionName: string,
  args: readonly unknown[],
  options: ContractCallOptions = {},
): Promise<ReadOutcome> {
  let data: `0x${string}`;
  try {
    data = encodeFunctionData({ abi: ZARYA_ABI, functionName, args: args as unknown[] });
  } catch {
    // A local encoding failure is a programming error, not a chain condition,
    // and the error registry describes nothing like it.
    return { kind: 'FAILURE', failure: { kind: 'UNKNOWN', reason: 'NOT_A_REVERT' } };
  }

  try {
    const { data: result } = await client.call({
      to: address,
      data,
      ...(options.from === undefined ? {} : { account: options.from }),
      ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
    });
    if (result === undefined || result === '0x') {
      return { kind: 'FAILURE', failure: { kind: 'UNKNOWN', reason: 'EMPTY_REVERT' } };
    }
    return {
      kind: 'VALUE',
      value: decodeFunctionResult({ abi: ZARYA_ABI, functionName, data: result }),
    };
  } catch (error) {
    return { kind: 'FAILURE', failure: classifyCallFailure(error) };
  }
}

/**
 * A `void`-returning function's call succeeds with no returndata, which
 * {@link callContract} reports as `EMPTY_REVERT` — it cannot tell an empty
 * success from an empty revert, and guessing would be the wrong direction.
 *
 * Simulation needs that distinction, so it goes around the decode step.
 */
export async function callRaw(
  client: ZaryaPublicClient,
  address: EvmAddress,
  data: `0x${string}`,
  options: ContractCallOptions = {},
): Promise<{ readonly kind: 'SUCCESS' } | { readonly kind: 'FAILURE'; failure: CallOutcome }> {
  try {
    await client.call({
      to: address,
      data,
      ...(options.from === undefined ? {} : { account: options.from }),
    });
    return { kind: 'SUCCESS' };
  } catch (error) {
    return { kind: 'FAILURE', failure: classifyCallFailure(error) };
  }
}
