import { type Abi, type Hex, decodeErrorResult } from 'viem';
import {
  type CallOutcome,
  type ZaryaErrorName,
  isZaryaErrorName,
  meaningOf,
} from '../../domain/chain/contractErrors';
import { readRevert } from './revertData';
import { ZARYA_ERROR_ABI } from './zaryaAbi';

/**
 * Turning revert bytes into a domain outcome.
 *
 * The adapter decodes; `domain/chain/contractErrors.ts` decides what a decoded
 * name means. Kept apart so the retry rules — most of all "InsufficientVotes is
 * terminal" — are asserted without a node or a revert payload.
 */

/**
 * The errors that never reach the ABI, written out by hand because there is
 * nothing to generate them from.
 *
 * `NoThemeSet`, `NoStatementSet` and `InvalidCategory` are declared in
 * `Matricies.sol` and raised from `external` library functions, so solc emits
 * them into the library's ABI and not the contract's — they arrive as
 * undecodable selectors unless registered here. `Panic` and `Error` are
 * compiler-generated and appear in no ABI at all.
 *
 * viem appends its own `Panic`/`Error` fragments during decoding; these come
 * first so the decode does not depend on that behavior surviving an upgrade.
 *
 * `errorDecoder.test.ts` re-parses `Matricies.sol` and fails if a signature here
 * stops matching its declaration.
 */
export const UNPUBLISHED_ERROR_ABI = [
  {
    type: 'error',
    name: 'NoThemeSet',
    inputs: [
      { name: 'isCategorical', type: 'bool' },
      { name: 'x', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'NoStatementSet',
    inputs: [
      { name: 'isCategorical', type: 'bool' },
      { name: 'y', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidCategory',
    inputs: [{ name: 'category', type: 'uint64' }],
  },
  {
    type: 'error',
    name: 'Panic',
    inputs: [{ name: 'code', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'Error',
    inputs: [{ name: 'reason', type: 'string' }],
  },
] as const satisfies Abi;

/** Every error this client can name: the ABI's 16 plus the five above. */
export const FULL_ERROR_ABI: Abi = [...UNPUBLISHED_ERROR_ABI, ...ZARYA_ERROR_ABI];

export interface DecodedZaryaError {
  readonly name: ZaryaErrorName;
  readonly args: readonly unknown[];
  /** Present only for `Panic`, which is the one error whose argument changes its meaning. */
  readonly panicCode?: bigint;
}

/**
 * Decodes revert returndata. `undefined` means the selector is not one we know —
 * which is a statement about this client's registry, not about the contract.
 */
export function decodeZaryaError(data: Hex): DecodedZaryaError | undefined {
  let decoded: { errorName: string; args?: readonly unknown[] };
  try {
    decoded = decodeErrorResult({ abi: FULL_ERROR_ABI, data });
  } catch {
    return undefined;
  }

  if (!isZaryaErrorName(decoded.errorName)) return undefined;
  const args = decoded.args ?? [];

  if (decoded.errorName === 'Panic') {
    const [code] = args;
    return {
      name: 'Panic',
      args,
      panicCode: typeof code === 'bigint' ? code : undefined,
    };
  }
  return { name: decoded.errorName, args };
}

/**
 * Classifies a thrown call failure end to end.
 *
 * The three `UNKNOWN` reasons are kept distinct rather than collapsed, because
 * they call for different behavior: a transport failure is reconcile-later, an
 * empty revert means the selector is not on that contract, and an undecodable
 * payload means something is there that we cannot name. None of them is a
 * verdict about what the contract decided.
 */
export function classifyCallFailure(error: unknown): CallOutcome {
  const revert = readRevert(error);
  if (revert === undefined) {
    return { kind: 'UNKNOWN', reason: 'NOT_A_REVERT' };
  }
  if (revert.data === undefined) {
    return { kind: 'UNKNOWN', reason: 'EMPTY_REVERT' };
  }
  const decoded = decodeZaryaError(revert.data);
  if (decoded === undefined) {
    return { kind: 'UNKNOWN', reason: 'UNDECODABLE' };
  }
  return {
    kind: 'REVERTED',
    name: decoded.name,
    meaning: meaningOf(decoded.name, decoded.panicCode),
  };
}
