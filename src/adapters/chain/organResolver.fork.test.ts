import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAIRPERSON_ORGAN,
  ORGAN_POSTFIX,
  PARTY_ORGAN_TYPES,
  type PartyOrganTriple,
  partyOrganIdentifier,
  partyOrganTriple,
  scopeOf,
} from '../../domain/organs/partyOrgan';
import { REGIONS, regionBySubjectCode } from '../../domain/organs/regions';
import { loadConfig } from '../config/appConfig';
import { buildOrganLabelTable, organHashOf } from './organLabelTable';
import { ZaryaOrganResolver } from './organResolver';
import { createZaryaPublicClient } from './publicClient';
import { type AnvilHandle, forkBlockNumber, forkRpcUrl, startAnvil } from './testing/anvil';

/**
 * The local organ mirror against the real deployed `PartyOrgans` library.
 *
 * This is the test that matters for the reverse table. Every other assertion
 * about organ labels compares the client against a mirror the client wrote
 * itself; here the contract's own `pure` helpers say whether that mirror is
 * right. Both helpers are `pure`, so this is `eth_call` only — nothing signed,
 * nothing broadcast.
 *
 * Opt-in via `ZARYA_FORK_RPC_URL`; skips and stays green without it.
 */

const RPC_URL = forkRpcUrl();
const CONTRACT_ADDRESS = loadConfig({ env: {}, appVersion: 'fork-test' }).publicConfig
  .contractAddress;

const MINUTE = 60_000;

describe.skipIf(RPC_URL === undefined)('organ resolution against a Sepolia fork', () => {
  let anvil: AnvilHandle;
  let resolver: ZaryaOrganResolver;

  const newResolver = (maxLocalOrganNumber = 3) =>
    new ZaryaOrganResolver(
      createZaryaPublicClient({ rpcUrl: anvil.url }),
      CONTRACT_ADDRESS,
      buildOrganLabelTable(maxLocalOrganNumber),
    );

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
    resolver = newResolver();
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('agrees with the contract on one organ of every type', async () => {
    const region = regionBySubjectCode('95').ordinal; // Chechnya: ordinal 20, code 95.
    for (const organType of PARTY_ORGAN_TYPES) {
      const triple = partyOrganTriple({
        organType,
        region: scopeOf(organType) === 'GLOBAL' ? undefined : region,
        number: 2,
      });

      // resolve() throws on any disagreement, so reaching the assertions is
      // already the result; restating them names which half moved on failure.
      const resolved = await resolver.resolve(triple);
      expect(resolved.identifier).toBe(partyOrganIdentifier(triple));
      expect(resolved.organ).toBe(organHashOf(resolved.identifier));
    }
  }, 2 * MINUTE);

  it('renders a divergent region by its subject code, as the contract does', async () => {
    // The defect this module exists for: ordinal 20 must produce "95.СОВ" on
    // chain, never "20.СОВ".
    const resolved = await resolver.resolve(
      partyOrganTriple({ organType: 'RegionalSoviet', region: 20 }),
    );
    expect(resolved.identifier).toBe(`95.${ORGAN_POSTFIX.soviet}`);
  }, MINUTE);

  it('agrees on all 98 regions for one organ type', async () => {
    // The sweep that would catch a table shifted by a row — which a spot check
    // on Chelyabinsk could not, since its ordinal and code coincide.
    const resolved = await Promise.all(
      REGIONS.map((region) =>
        resolver.resolve(
          partyOrganTriple({ organType: 'RegionalConference', region: region.ordinal }),
        ),
      ),
    );

    expect(resolved.map((entry) => entry.identifier)).toEqual(
      REGIONS.map((region) => `${region.subjectCode}.${ORGAN_POSTFIX.conference}`),
    );
  }, 3 * MINUTE);

  it('confirms the three global organs ignore region and number', async () => {
    // PartyOrgans.sol:75-80. Asserted against the contract rather than against
    // this client's own normalization, which is the thing being justified.
    const chairperson = await resolver.resolve(CHAIRPERSON_ORGAN);

    // Deliberately bypasses the normalizing constructor so the contract, not
    // partyOrganTriple, decides that the stray fields do not matter.
    const stray = {
      organType: 'Chairperson',
      region: 74,
      number: 9,
    } as unknown as PartyOrganTriple;

    const resolved = await newResolver().resolve(stray);
    expect(resolved.organ).toBe(chairperson.organ);
    expect(resolved.identifier).toBe(ORGAN_POSTFIX.chairperson);
  }, MINUTE);

  it('resolves an ordinal/code confusion to a different real organ without reverting', async () => {
    // Ordinal 20 is Chechnya, whose code is 95. A caller who passed the code
    // instead addresses ordinal 95 — Lugansk, code 81. Both succeed. Nothing on
    // chain objects, which is why the ordinal has to be a branded type rather
    // than a number a form can supply.
    const asChechnya = await resolver.resolve(
      partyOrganTriple({ organType: 'RegionalSoviet', region: 20 }),
    );
    const asSubjectCode = await resolver.resolve(
      partyOrganTriple({ organType: 'RegionalSoviet', region: 95 }),
    );

    expect(asChechnya.identifier).toBe(`95.${ORGAN_POSTFIX.soviet}`);
    expect(asSubjectCode.identifier).toBe(`81.${ORGAN_POSTFIX.soviet}`);
    expect(asChechnya.organ).not.toBe(asSubjectCode.organ);
  }, MINUTE);

  it('fails rather than resolves when the region is outside the enum', async () => {
    const beyondEnum = {
      organType: 'RegionalSoviet',
      region: 200,
      number: 0,
    } as unknown as PartyOrganTriple;

    // The contract reverts UnknownRegion; the local mirror cannot even render a
    // code. Either way this must not produce an organ.
    await expect(newResolver().resolve(beyondEnum)).rejects.toThrow();
  }, MINUTE);

  it('names an organ inside the table and refuses to name one outside it', async () => {
    const known = await resolver.resolve(
      partyOrganTriple({ organType: 'LocalSoviet', region: 74, number: 1 }),
    );
    expect(resolver.label(known.organ)).toBe(`74.1.${ORGAN_POSTFIX.soviet}`);

    // Beyond this resolver's bound of 3: the hash is real and verified, and the
    // label is still unknown rather than guessed.
    const beyondBound = await resolver.resolve(
      partyOrganTriple({ organType: 'LocalSoviet', region: 74, number: 9 }),
    );
    expect(beyondBound.organ).toBe(organHashOf(`74.9.${ORGAN_POSTFIX.soviet}`));
    expect(resolver.label(beyondBound.organ)).toBeUndefined();
  }, MINUTE);
});
