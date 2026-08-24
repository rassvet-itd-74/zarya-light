import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NetworkNotPermittedError } from '../../domain/network/networkPolicy';
import { ConfigError, SecretConfig, loadConfig } from './appConfig';

const load = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ env, appVersion: '0.0.1-test' });

describe('loadConfig', () => {
  it('starts on Sepolia with no environment at all', () => {
    const { publicConfig } = load();
    expect(publicConfig.chainId).toBe(11155111);
    expect(publicConfig.contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(publicConfig.appVersion).toBe('0.0.1-test');
  });

  it('refuses any network but Sepolia', () => {
    expect(() => load({ ZARYA_CHAIN_ID: '1' })).toThrow(NetworkNotPermittedError);
    expect(() => load({ ZARYA_CHAIN_ID: '31337' })).toThrow(NetworkNotPermittedError);
  });

  it('refuses a chain id that is not an integer, rather than coercing it', () => {
    // Number('11155111abc') is NaN, but parseInt would have returned the right
    // number and hidden the typo.
    expect(() => load({ ZARYA_CHAIN_ID: '11155111abc' })).toThrow(ConfigError);
  });

  it('refuses a malformed contract address', () => {
    expect(() => load({ ZARYA_CONTRACT_ADDRESS: '0xnope' })).toThrow(ConfigError);
  });

  it('bounds the executor poll interval', () => {
    expect(load({ ZARYA_EXECUTOR_POLL_SECONDS: '60' }).publicConfig
      .executorPollIntervalSeconds).toBe(60);
    expect(() => load({ ZARYA_EXECUTOR_POLL_SECONDS: '1' })).toThrow(ConfigError);
    expect(() => load({ ZARYA_EXECUTOR_POLL_SECONDS: '999999' })).toThrow(ConfigError);
  });

  it('refuses an unusable RPC URL without echoing it back', () => {
    // The URL may carry an API key, so it must not appear in the message.
    const secretish = 'not-a-url-but-secret-looking';
    expect(() => load({ ZARYA_RPC_URL: secretish })).toThrow(ConfigError);
    try {
      load({ ZARYA_RPC_URL: secretish });
    } catch (error) {
      expect((error as Error).message).not.toContain(secretish);
    }
  });
});

describe('the public/secret split', () => {
  const env = {
    ZARYA_RPC_URL: 'https://sepolia.example.com/v2/PROJECT-KEY-DO-NOT-LEAK',
    ZARYA_MEMBER_KEY: '0xdeadbeef',
    ZARYA_EXECUTOR_KEY: '  ',
  };

  it('keeps the full RPC URL out of the public config, carrying only the host', () => {
    const { publicConfig } = load(env);
    expect(publicConfig.rpcHost).toBe('sepolia.example.com');
    expect(JSON.stringify(publicConfig)).not.toContain('PROJECT-KEY-DO-NOT-LEAK');
  });

  it('reports whether signers are configured, never their values', () => {
    const { publicConfig } = load(env);
    expect(publicConfig.memberSignerConfigured).toBe(true);
    // Whitespace is not a configured key.
    expect(publicConfig.executorSignerConfigured).toBe(false);
    expect(JSON.stringify(publicConfig)).not.toContain('0xdeadbeef');
  });

  it('redacts the secret config however it is serialized', () => {
    const { secretConfig } = load(env);

    // It still works as a value...
    expect(secretConfig.rpcUrl).toBe(env.ZARYA_RPC_URL);

    // ...but cannot be leaked by any of the three ways an object usually
    // escapes: a log line, a JSON body, or string interpolation.
    expect(inspect(secretConfig)).toBe('[redacted]');
    expect(JSON.stringify(secretConfig)).toBe('"[redacted]"');
    expect(`${secretConfig}`).toBe('[redacted]');
    expect(inspect({ nested: secretConfig })).not.toContain('PROJECT-KEY');
  });

  it('redacts a SecretConfig constructed directly', () => {
    expect(inspect(new SecretConfig('https://user:pass@host/path'))).toBe('[redacted]');
  });
});
