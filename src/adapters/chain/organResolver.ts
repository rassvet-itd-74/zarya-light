import { decodeFunctionResult, encodeFunctionData } from 'viem';
import {
  type PartyOrganTriple,
  partyOrganIdentifier,
  partyOrganTypeOrdinal,
} from '../../domain/organs/partyOrgan';
import {
  type OrganResolver,
  OrganIdentifierMismatchError,
  type ResolvedOrgan,
} from '../../domain/ports/OrganResolver';
import { type Bytes32, type EvmAddress, bytes32 } from '../../domain/primitives';
import { type OrganLabelTable, buildOrganLabelTable, organHashOf } from './organLabelTable';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * Organ resolution against the contract's own `pure` helpers.
 *
 * Both helpers are `pure`, so a resolution is two `eth_call`s that read no
 * state and cost nothing beyond the round trip. That is what makes verifying
 * every resolution affordable — and it has to be every resolution, not a
 * startup sample, because the failure this guards against is per-call: a region
 * subject code passed where an enum ordinal belongs resolves to a *different
 * real region* for 50 of the 98, silently.
 *
 * Three facts are cross-checked, and disagreement throws rather than returning a
 * hash nobody vouched for:
 *
 * 1. the contract's identifier equals the one composed locally — this is the
 *    check that catches a wrong ordinal, since the identifier carries the
 *    subject code;
 * 2. the contract's `bytes32` equals the local keccak of that identifier — this
 *    catches a bug in the local mirror, including a Cyrillic postfix that got
 *    mangled in transit;
 * 3. both calls answered at all.
 *
 * Resolutions are memoized per triple. The mapping is `pure`, so a value that
 * verified once cannot become wrong later.
 */
export class ZaryaOrganResolver implements OrganResolver {
  private readonly cache = new Map<string, ResolvedOrgan>();

  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
    private readonly table: OrganLabelTable = buildOrganLabelTable(),
  ) {}

  async resolve(triple: PartyOrganTriple): Promise<ResolvedOrgan> {
    const expected = partyOrganIdentifier(triple);
    const cached = this.cache.get(expected);
    if (cached !== undefined) return cached;

    const args = [
      partyOrganTypeOrdinal(triple.organType),
      triple.region as number,
      BigInt(triple.number),
    ] as const;

    const [organ, identifier] = await Promise.all([
      this.callBytes32('getPartyOrgan', args),
      this.callString('getPartyOrganIdentifier', args),
    ]);

    if (identifier !== expected) {
      throw new OrganIdentifierMismatchError(triple, expected, identifier);
    }
    const locally = organHashOf(identifier);
    if (organ !== locally) {
      // Same string, different hash: the local keccak or its encoding is wrong,
      // which would make the whole reverse table wrong too.
      throw new OrganIdentifierMismatchError(
        triple,
        `${expected} hashing locally to ${locally}`,
        `${identifier} hashing on chain to ${organ}`,
      );
    }

    const resolved: ResolvedOrgan = { triple, organ, identifier };
    this.cache.set(expected, resolved);
    return resolved;
  }

  label(organ: Bytes32): string | undefined {
    return this.table.label(organ);
  }

  tripleOf(organ: Bytes32): PartyOrganTriple | undefined {
    return this.table.tripleOf(organ);
  }

  /**
   * encode/call/decode rather than `readContract`: importing the ABI as JSON
   * widens it to `Abi` and viem's generics do not survive that. Same wire
   * behavior, and the result is validated here instead of being inferred.
   */
  private async callRaw(functionName: string, args: readonly unknown[]): Promise<unknown> {
    const { data } = await this.client.call({
      to: this.address,
      data: encodeFunctionData({ abi: ZARYA_ABI, functionName, args: args as unknown[] }),
    });
    if (data === undefined) {
      throw new Error(`${functionName} returned no data`);
    }
    return decodeFunctionResult({ abi: ZARYA_ABI, functionName, data });
  }

  private async callBytes32(functionName: string, args: readonly unknown[]): Promise<Bytes32> {
    const result = await this.callRaw(functionName, args);
    if (typeof result !== 'string') {
      throw new TypeError(`${functionName} did not return a bytes32`);
    }
    return bytes32(result);
  }

  private async callString(functionName: string, args: readonly unknown[]): Promise<string> {
    const result = await this.callRaw(functionName, args);
    if (typeof result !== 'string') {
      throw new TypeError(`${functionName} did not return a string`);
    }
    return result;
  }
}
