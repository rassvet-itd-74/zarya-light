import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/appConfig';
import { evmAddress } from '../../domain/primitives';
import { ChainClock } from './chainClock';
import { ZaryaNetworkGuard } from './networkGuard';
import { createZaryaPublicClient } from './publicClient';
import { type AnvilHandle, forkBlockNumber, forkRpcUrl, startAnvil } from './testing/anvil';

/**
 * The network guard against the real deployed Zarya, on a local anvil forking
 * Sepolia.
 *
 * Opt-in: set `ZARYA_FORK_RPC_URL` (and optionally `ZARYA_FORK_BLOCK` to pin the
 * fork for reproducibility). Without it these skip and `npm test` stays green
 * offline, per the network policy in `zarya-testing`.
 *
 * Nothing here signs or broadcasts. Every call is `eth_call` against the local
 * fork; the live network is read once, at fork time.
 */

const RPC_URL = forkRpcUrl();
const CONTRACT_ADDRESS = loadConfig({ env: {}, appVersion: 'fork-test' }).publicConfig
  .contractAddress;

// An address that certainly holds no code: the guard must say so rather than
// failing at the first read.
const EMPTY_ADDRESS = evmAddress('0x000000000000000000000000000000000000dEaD');

const MINUTE = 60_000;

describe.skipIf(RPC_URL === undefined)('network guard against a Sepolia fork', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
    });
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  const guardFor = (address = CONTRACT_ADDRESS) =>
    new ZaryaNetworkGuard(createZaryaPublicClient({ rpcUrl: anvil.url }), address);

  it('accepts the configured deployment', async () => {
    const verdict = await guardFor().verify();

    // If this fails as WRONG_DEPLOYMENT, the configured address is the
    // three-argument predecessor; as NOT_ZARYA, it is not Zarya at all.
    expect(verdict.status).toBe('OK');
    expect(verdict).toMatchObject({ chainId: 11155111 });
    if (verdict.status === 'OK') {
      expect(verdict.blockNumber).toBeGreaterThan(0n);
    }
  }, MINUTE);

  it('rejects an address holding no code', async () => {
    expect(await guardFor(EMPTY_ADDRESS).verify()).toMatchObject({
      status: 'NO_CONTRACT_CODE',
      address: EMPTY_ADDRESS,
    });
  }, MINUTE);

  it('reads the eligibility fingerprint as basis points from the live contract', async () => {
    // The guard already asserts this internally; failing here rather than as a
    // bare NOT_ZARYA says which half of the check moved.
    const verdict = await guardFor().verify();
    expect(verdict.status).not.toBe('NOT_ZARYA');
  }, MINUTE);

  describe('Clock', () => {
    it('returns chain block time, not workstation time', async () => {
      const client = createZaryaPublicClient({ rpcUrl: anvil.url });
      const clock = new ChainClock(client);

      const chainTime = await clock.chainTime();
      const block = await client.getBlock({ blockTag: 'latest' });

      expect(chainTime).toBe(Number(block.timestamp));
      // Seconds, not milliseconds — the brand says seconds and a ms value here
      // would be ~1000x out.
      expect(chainTime).toBeLessThan(Date.now());
    }, MINUTE);

    it('is unaffected by the workstation clock', async () => {
      const clock = new ChainClock(createZaryaPublicClient({ rpcUrl: anvil.url }));

      const before = await clock.chainTime();
      const realNow = Date.now;
      try {
        // Jump the workstation clock a decade into the future.
        Date.now = () => realNow() + 10 * 365 * 24 * 60 * 60 * 1000;
        expect(await clock.chainTime()).toBe(before);
      } finally {
        Date.now = realNow;
      }
    }, MINUTE);
  });

  describe('reconnect', () => {
    it('reports UNREACHABLE while the provider is down, then recovers', async () => {
      const outage = await startAnvil({
        forkUrl: RPC_URL as string,
        forkBlockNumber: forkBlockNumber(),
      });
      const guard = new ZaryaNetworkGuard(
        createZaryaPublicClient({ rpcUrl: outage.url, timeoutMs: 2_000, retryCount: 0 }),
        CONTRACT_ADDRESS,
      );

      expect((await guard.verify()).status).toBe('OK');

      await outage.stop();
      const duringOutage = await guard.verify();
      // The invariant: an outage is reconcile-later, never a confirmed
      // rejection of the deployment.
      expect(duringOutage.status).toBe('UNREACHABLE');

      const restored = await startAnvil({
        forkUrl: RPC_URL as string,
        forkBlockNumber: forkBlockNumber(),
      });
      try {
        const afterReconnect = await new ZaryaNetworkGuard(
          createZaryaPublicClient({ rpcUrl: restored.url }),
          CONTRACT_ADDRESS,
        ).verify();
        expect(afterReconnect.status).toBe('OK');
      } finally {
        await restored.stop();
      }
    }, 3 * MINUTE);
  });
});

describe.skipIf(RPC_URL === undefined)('network guard on the wrong chain', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    // Same forked state, mainnet's chain id: the one path that cannot be
    // exercised on an honest Sepolia fork.
    anvil = await startAnvil({
      forkUrl: RPC_URL as string,
      forkBlockNumber: forkBlockNumber(),
      chainId: 1,
    });
  }, 2 * MINUTE);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('refuses a non-Sepolia chain even though the contract is there', async () => {
    const verdict = await new ZaryaNetworkGuard(
      createZaryaPublicClient({ rpcUrl: anvil.url }),
      CONTRACT_ADDRESS,
    ).verify();

    expect(verdict).toMatchObject({ status: 'WRONG_NETWORK', observed: 1, permitted: 11155111 });
  }, MINUTE);
});
