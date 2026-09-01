import { encodeAbiParameters, stringToHex, toFunctionSelector } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  ORGAN_POSTFIX,
  partyOrganIdentifier,
  partyOrganTriple,
} from '../../domain/organs/partyOrgan';
import { OrganIdentifierMismatchError } from '../../domain/ports/OrganResolver';
import { evmAddress } from '../../domain/primitives';
import { buildOrganLabelTable, organHashOf } from './organLabelTable';
import { ZaryaOrganResolver } from './organResolver';
import type { ZaryaPublicClient } from './publicClient';

/**
 * The resolver's cross-checks, driven by a stub client.
 *
 * The fork test proves the client agrees with the real contract. These prove
 * what happens when it does not — which no honest fork can produce, because a
 * contract does not disagree with itself.
 */

const ADDRESS = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');

const CHECHNYA = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });

/** The two helpers differ only by selector; this is how the stub tells them apart. */
const IDENTIFIER_SELECTOR = toFunctionSelector(
  'getPartyOrganIdentifier(uint8,uint8,uint256)',
);

/**
 * A client that answers `getPartyOrgan` and `getPartyOrganIdentifier` from a
 * supplied identifier, encoding real ABI return data so the decode path is the
 * production one.
 */
const stubClient = (answers: {
  identifier: string;
  /** Defaults to the honest hash of `identifier`. */
  organ?: string;
}): ZaryaPublicClient => {
  const organ = answers.organ ?? organHashOf(answers.identifier);
  const call = vi.fn(async ({ data }: { data: string }) => ({
    data: data.startsWith(IDENTIFIER_SELECTOR)
      ? encodeAbiParameters([{ type: 'string' }], [answers.identifier])
      : encodeAbiParameters([{ type: 'bytes32' }], [organ as `0x${string}`]),
  }));
  return { call } as unknown as ZaryaPublicClient;
};

const resolverWith = (client: ZaryaPublicClient) =>
  new ZaryaOrganResolver(client, ADDRESS, buildOrganLabelTable(1));

describe('a resolution the contract confirms', () => {
  it('returns the triple, the hash, and the label together', async () => {
    const identifier = partyOrganIdentifier(CHECHNYA);
    const resolved = await resolverWith(stubClient({ identifier })).resolve(CHECHNYA);

    expect(resolved).toEqual({
      triple: CHECHNYA,
      identifier: `95.${ORGAN_POSTFIX.soviet}`,
      organ: organHashOf(identifier),
    });
  });

  it('memoizes, since a pure helper cannot change its answer', async () => {
    const client = stubClient({ identifier: partyOrganIdentifier(CHECHNYA) });
    const resolver = resolverWith(client);

    await resolver.resolve(CHECHNYA);
    await resolver.resolve(CHECHNYA);
    await resolver.resolve(partyOrganTriple({ organType: 'RegionalSoviet', region: 20 }));

    // Two calls for the first resolution, none after.
    expect(client.call).toHaveBeenCalledTimes(2);
  });
});

describe('a resolution the contract contradicts', () => {
  it('throws when the contract renders a different label', async () => {
    // What an ordinal/code confusion would look like if the contract could
    // report it: we composed "95.СОВ" and it says "81.СОВ".
    const client = stubClient({ identifier: `81.${ORGAN_POSTFIX.soviet}` });

    await expect(resolverWith(client).resolve(CHECHNYA)).rejects.toThrow(
      OrganIdentifierMismatchError,
    );
  });

  it('names the region confusion in the message', async () => {
    const client = stubClient({ identifier: `81.${ORGAN_POSTFIX.soviet}` });

    await expect(resolverWith(client).resolve(CHECHNYA)).rejects.toThrow(
      /subject code .* ordinal/i,
    );
  });

  it('throws when the label agrees but the hash does not', async () => {
    // Catches a broken local keccak or a mangled postfix — the failure that
    // would make the entire reverse table wrong while every label looked right.
    const client = stubClient({
      identifier: partyOrganIdentifier(CHECHNYA),
      organ: `0x${'11'.repeat(32)}`,
    });

    await expect(resolverWith(client).resolve(CHECHNYA)).rejects.toThrow(
      OrganIdentifierMismatchError,
    );
  });

  it('does not cache a rejected resolution', async () => {
    const client = stubClient({ identifier: `81.${ORGAN_POSTFIX.soviet}` });
    const resolver = resolverWith(client);

    await expect(resolver.resolve(CHECHNYA)).rejects.toThrow();
    await expect(resolver.resolve(CHECHNYA)).rejects.toThrow();
    expect(client.call).toHaveBeenCalledTimes(4);
  });

  it('throws rather than returning a partial result when the call answers nothing', async () => {
    const client = { call: vi.fn(async () => ({ data: undefined })) } as unknown as
      ZaryaPublicClient;

    await expect(resolverWith(client).resolve(CHECHNYA)).rejects.toThrow(/returned no data/);
  });
});

describe('reverse lookup', () => {
  it('reads through to the table', async () => {
    const resolver = resolverWith(stubClient({ identifier: partyOrganIdentifier(CHECHNYA) }));
    const organ = organHashOf(`95.${ORGAN_POSTFIX.soviet}`);

    expect(resolver.label(organ)).toBe(`95.${ORGAN_POSTFIX.soviet}`);
    expect(resolver.tripleOf(organ)).toEqual(CHECHNYA);
  });

  it('returns undefined for a hash outside the bound', () => {
    const resolver = resolverWith(stubClient({ identifier: 'unused' }));
    // Local number 5, beyond this table's bound of 1.
    expect(resolver.label(organHashOf(`74.5.${ORGAN_POSTFIX.soviet}`))).toBeUndefined();
  });
});

describe('the triple reaching the wire', () => {
  it('sends the enum ordinal, not the subject code', async () => {
    const client = stubClient({ identifier: partyOrganIdentifier(CHECHNYA) });
    await resolverWith(client).resolve(CHECHNYA);

    // uint8 region sits in the second 32-byte word after the selector. Ordinal
    // 20 is 0x14; the subject code 95 would be 0x5f.
    const [{ data }] = (client.call as unknown as { mock: { calls: [{ data: string }][] } })
      .mock.calls[0];
    const words = (data.slice(10).match(/.{64}/g) ?? []).map((word) => BigInt(`0x${word}`));
    expect(words[1]).toBe(20n);
  });

  it('never puts a Cyrillic label on the wire', async () => {
    const client = stubClient({ identifier: partyOrganIdentifier(CHECHNYA) });
    await resolverWith(client).resolve(CHECHNYA);

    // The client hashes an identifier locally only to check the answer. What it
    // *sends* is the structured triple.
    const cyrillic = stringToHex(ORGAN_POSTFIX.soviet).slice(2);
    for (const [{ data }] of (
      client.call as unknown as { mock: { calls: [{ data: string }][] } }
    ).mock.calls) {
      expect(data).not.toContain(cyrillic);
    }
  });
});
