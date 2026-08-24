import { describe, expect, it } from 'vitest';
import { chainId } from '../primitives';
import {
  NetworkNotPermittedError,
  PERMITTED_CHAIN_ID,
  assertPermittedNetwork,
  isPermittedNetwork,
} from './networkPolicy';

describe('network policy', () => {
  it('permits Sepolia', () => {
    expect(PERMITTED_CHAIN_ID).toBe(11155111);
    expect(isPermittedNetwork(chainId(11155111))).toBe(true);
    expect(() => assertPermittedNetwork(chainId(11155111))).not.toThrow();
  });

  // Mainnet first, because that is the one where a mistake costs real money.
  it.each([
    ['Ethereum mainnet', 1],
    ['Holesky', 17000],
    ['Hoodi', 560048],
    ['Polygon', 137],
    ['a local node', 31337],
  ])('rejects %s', (_name, id) => {
    const observed = chainId(id);
    expect(isPermittedNetwork(observed)).toBe(false);
    expect(() => assertPermittedNetwork(observed)).toThrow(NetworkNotPermittedError);
  });

  it('names both the observed and the permitted network in the error', () => {
    try {
      assertPermittedNetwork(chainId(1));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkNotPermittedError);
      const typed = error as NetworkNotPermittedError;
      expect(typed.observed).toBe(1);
      expect(typed.permitted).toBe(PERMITTED_CHAIN_ID);
      expect(typed.message).toContain('Sepolia');
      expect(typed.message).toContain('11155111');
    }
  });
});
