import { encodeFunctionData } from 'viem';
import { supportOf } from '../../domain/intents/intent';
import { type ZaryaWriteCall, organOfCall } from '../../domain/intents/intentCalls';
import {
  type OrganResolver,
  OrganIdentifierMismatchError,
} from '../../domain/ports/OrganResolver';
import type { CallUnavailableReason } from '../../domain/ports/CallSimulator';
import { partyOrganIdentifier } from '../../domain/organs/partyOrgan';
import type { Bytes32 } from '../../domain/primitives';
import { isCategoricalOf } from './matrixReader';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * A domain call to calldata, and the only place that conversion happens.
 *
 * Three translations from domain vocabulary to wire values live here and nowhere
 * else, each already single-sourced: the organ triple through `OrganResolver`
 * (the contract's own `pure` helper, verified), `MatrixKind` through
 * {@link isCategoricalOf}, and `VoteDirection` through `supportOf`. There is no
 * arithmetic or boolean route around any of them.
 *
 * Encoding is **async and failable** because organ resolution is a chain call.
 * That is not incidental: a `bytes32` composed locally and never checked is how a
 * subject code passed for an ordinal reaches a real transaction addressed at a
 * different region.
 *
 * Nothing here signs or broadcasts. The result is bytes, and what is done with
 * them is the caller's — `eth_call` for the simulator, and the queue in Phase 6.
 */

export type EncodedWriteCall =
  | { readonly kind: 'DATA'; readonly data: `0x${string}` }
  /** No calldata was produced, so nothing can be sent or simulated. */
  | {
      readonly kind: 'UNAVAILABLE';
      readonly reason: CallUnavailableReason;
      readonly detail: string;
    };

export async function encodeWriteCall(
  call: ZaryaWriteCall,
  organs: OrganResolver,
): Promise<EncodedWriteCall> {
  const triple = organOfCall(call);
  let organ: Bytes32 | undefined;
  if (triple !== undefined) {
    try {
      organ = (await organs.resolve(triple)).organ;
    } catch (error) {
      // A mismatch is not retryable and an outage is, so they do not share an
      // arm. `OrganIdentifierMismatchError` is thrown only after the contract
      // answered, which is what makes the distinction sound.
      return error instanceof OrganIdentifierMismatchError
        ? {
            kind: 'UNAVAILABLE',
            reason: 'ORGAN_MISMATCH',
            detail: error.message,
          }
        : {
            kind: 'UNAVAILABLE',
            reason: 'ORGAN_UNREADABLE',
            detail: `${partyOrganIdentifier(triple)} could not be resolved: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
    }
  }

  try {
    return {
      kind: 'DATA',
      data: encodeFunctionData({
        abi: ZARYA_ABI,
        functionName: call.fn,
        args: argumentsFor(call, organ) as unknown[],
      }),
    };
  } catch (error) {
    return {
      kind: 'UNAVAILABLE',
      reason: 'NOT_ENCODABLE',
      detail: `${call.fn} would not encode against the bundled ABI: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * The argument list for each function, in the ABI's order.
 *
 * A positional array is unavoidable — it is what `encodeFunctionData` takes —
 * and it is the one thing in this file the type system cannot check, since two
 * `uint256` coordinates in a row swap cleanly. `writeCallData.test.ts` decodes
 * every arm back through the ABI and compares argument *names* to values, which
 * is the check that actually catches an `x`/`y` swap.
 *
 * `organ` is non-`undefined` exactly when {@link organOfCall} named a triple.
 * The two lists have to agree, and they are kept honest by failure rather than
 * by assertion: an arm that used `organ` without `organOfCall` naming it passes
 * `undefined` where a `bytes32` belongs, viem refuses it, and the call comes back
 * `NOT_ENCODABLE` instead of encoding 32 zero bytes. The test sweeps all
 * thirteen arms, so it never reaches production.
 */
function argumentsFor(call: ZaryaWriteCall, organ: Bytes32 | undefined): readonly unknown[] {
  switch (call.fn) {
    case 'createMembershipVoting':
    case 'createMembershipRevocationVoting':
      return [organ, call.member, BigInt(call.duration)];

    case 'createCategoryVoting':
      return [
        organ,
        call.at.x,
        call.at.y,
        call.category,
        call.categoryName,
        BigInt(call.duration),
      ];

    case 'createDecimalsVoting':
      return [organ, call.at.x, call.at.y, call.decimals, BigInt(call.duration)];

    case 'createThemeVoting':
      // One coordinate: a theme labels a column, so there is no `y`.
      return [isCategoricalOf(call.matrix), call.x, call.theme, BigInt(call.duration)];

    case 'createStatementVoting':
      // Both coordinates, and they are not interchangeable — `x` gates on a
      // theme and the statement lands at `y` (`Matricies.sol:168-181`).
      return [
        isCategoricalOf(call.matrix),
        call.at.x,
        call.at.y,
        call.statement,
        BigInt(call.duration),
      ];

    case 'createCategoricalValueVoting':
    case 'createNumericalValueVoting':
      return [organ, call.at.x, call.at.y, call.value, call.valueAuthor, BigInt(call.duration)];

    case 'castVote':
      // Two arguments. The three-argument form belongs to the predecessor
      // deployment, and encoding against this ABI is what makes pointing at it
      // produce malformed calldata rather than a wrong answer.
      return [call.votingId, supportOf(call.direction)];

    case 'setMinimumQuorum':
    case 'setMinimumApprovalPercentage':
    case 'setMinimumApprovalPercentageBase':
      return [organ, call.value];

    case 'transferChairmanship':
      return [call.newChairman];
  }
}
