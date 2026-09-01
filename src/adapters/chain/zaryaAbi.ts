import type { Abi, AbiEvent, AbiFunction } from 'viem';
import abiJson from './abi/Zarya.abi.json';

/**
 * The contract's external surface, as the ABI declares it.
 *
 * Imported rather than hand-written: `zarya-chain` forbids hand-written
 * signatures, because a transcribed one drifts silently. `castVote` losing an
 * argument between deployments is precisely the failure that costs.
 *
 * The trade-off of importing JSON is that TypeScript widens it, so viem cannot
 * infer per-function types from it. Instead of re-declaring signatures to win
 * that inference back, the items this code depends on are asserted at load —
 * name and arity both — so a drifted ABI fails immediately and loudly rather
 * than at the first call.
 */
export const ZARYA_ABI = abiJson as Abi;

export class AbiContractError extends Error {
  constructor(message: string) {
    super(`${message} — src/adapters/chain/abi/Zarya.abi.json does not match what this adapter expects`);
    this.name = 'AbiContractError';
  }
}

const functionsByName = (abi: Abi): Map<string, AbiFunction[]> => {
  const found = new Map<string, AbiFunction[]>();
  for (const item of abi) {
    if (item.type !== 'function') continue;
    found.set(item.name, [...(found.get(item.name) ?? []), item]);
  }
  return found;
};

/**
 * Asserts the ABI declares `name` exactly once with `arity` inputs.
 *
 * "Exactly once" matters as much as the arity: an ABI carrying both the
 * two- and three-argument `castVote` would let a call site pick either.
 */
export function requireFunction(name: string, arity: number, abi: Abi = ZARYA_ABI): AbiFunction {
  const overloads = functionsByName(abi).get(name) ?? [];
  if (overloads.length === 0) {
    throw new AbiContractError(`the ABI declares no ${name}()`);
  }
  if (overloads.length > 1) {
    throw new AbiContractError(
      `the ABI declares ${overloads.length} overloads of ${name}(), so a call site could pick either`,
    );
  }
  const [only] = overloads;
  if (only.inputs.length !== arity) {
    throw new AbiContractError(
      `${name}() takes ${only.inputs.length} argument(s) in the ABI, this adapter expects ${arity}`,
    );
  }
  return only;
}

/**
 * Everything this slice calls, with the arity it assumes. Checked once at
 * module load so a mismatched ABI cannot reach a call site.
 */
export const REQUIRED_FUNCTIONS: ReadonlyArray<readonly [name: string, arity: number]> = [
  // The deployment discriminator. Two arguments, never three (DEPLOYMENT.md).
  ['castVote', 2],
  // The identity fingerprint.
  ['simpleMajority', 0],
  // Organ resolution. Both `pure`, and both taking the structured triple —
  // (organType, region, number) — so an arity change here would mean the organ
  // encoding itself moved.
  ['getPartyOrgan', 3],
  ['getPartyOrganIdentifier', 3],
];

/**
 * Asserts the ABI declares an event exactly once with `inputCount` parameters,
 * and returns the fragment so callers decode against the bundled ABI rather
 * than a transcription of it.
 *
 * The `Votings` library's functions are `internal`, so they inline and their
 * events **do** reach the contract ABI — unlike `Matricies.ValueAdded`, whose
 * `external` function does not. Everything this projection reads is therefore
 * available here, and hand-writing any of it would be re-transcribing a
 * signature the file already holds.
 */
export function requireEvent(name: string, inputCount: number, abi: Abi = ZARYA_ABI): AbiEvent {
  const overloads = abi.filter(
    (item): item is AbiEvent => item.type === 'event' && item.name === name,
  );
  if (overloads.length === 0) {
    throw new AbiContractError(`the ABI declares no ${name} event`);
  }
  if (overloads.length > 1) {
    throw new AbiContractError(
      `the ABI declares ${overloads.length} ${name} events, so a decode could pick either`,
    );
  }
  const [only] = overloads;
  if (only.inputs.length !== inputCount) {
    throw new AbiContractError(
      `the ${name} event takes ${only.inputs.length} parameter(s) in the ABI, this adapter expects ${inputCount}`,
    );
  }
  return only;
}

/** Every event this client decodes, with the parameter count it assumes. */
export const REQUIRED_EVENTS: ReadonlyArray<readonly [name: string, inputCount: number]> = [
  // The discovery primitive and the only carrier of endTime.
  ['VotingCreated', 5],
  // The only carriers of a voting's governing organ. Theme and Statement are
  // absent on purpose: those votings have no organ.
  ['MembershipVotingCreated', 3],
  ['MembershipRevocationVotingCreated', 3],
  ['CategoryVotingCreated', 6],
  ['DecimalsVotingCreated', 5],
  ['CategoricalValueVotingCreated', 6],
  ['NumericalValueVotingCreated', 6],
];

export function assertAbiContract(abi: Abi = ZARYA_ABI): void {
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new AbiContractError('the ABI is empty or not an array');
  }
  for (const [name, arity] of REQUIRED_FUNCTIONS) {
    requireFunction(name, arity, abi);
  }
  for (const [name, inputCount] of REQUIRED_EVENTS) {
    requireEvent(name, inputCount, abi);
  }
}

/** The error fragments the app decodes, including those the ABI omits. */
export const ZARYA_ERROR_ABI: Abi = ZARYA_ABI.filter((item) => item.type === 'error');
