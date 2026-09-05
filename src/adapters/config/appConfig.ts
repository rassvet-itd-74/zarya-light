import {
  type ChainId,
  type EvmAddress,
  chainId,
  evmAddress,
} from '../../domain/primitives';
import { assertPermittedNetwork } from '../../domain/network/networkPolicy';

/**
 * Configuration, split by where it is allowed to travel.
 *
 * This is an adapter, not a domain module: it reads the environment. The domain
 * never imports it — main and the worker load it and hand the pieces to
 * application services (`zarya-hexagonal`: "a config module that the domain
 * imports and that itself imports a library" is an anti-pattern).
 *
 * The split into two types is the point. `PublicConfig` is safe to send to the
 * renderer; `SecretConfig` is main/worker only and redacts itself if anything
 * tries to serialize or log it. One type with a "don't send this field" comment
 * would be a rule to remember; two types make it a compile error.
 */

/** Safe to cross the IPC boundary and appear in logs. */
export interface PublicConfig {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  /**
   * Host of the RPC endpoint, for display. Never the full URL — provider URLs
   * routinely carry a project id or API key in the path, which is why the whole
   * URL lives in {@link SecretConfig}.
   */
  readonly rpcHost: string;
  /**
   * Where event discovery starts backfilling. Nothing before it exists to find,
   * and scanning from genesis on a public endpoint is not viable.
   *
   * A `number`, not a `bigint`, because this type crosses IPC and appears in
   * logs — and `JSON.stringify` throws on a BigInt rather than degrading. Block
   * heights are nowhere near 2^53, so nothing is lost; the chain adapter widens
   * it at the call site.
   */
  readonly deploymentBlock: number;
  readonly executorPollIntervalSeconds: number;
  readonly appVersion: string;
  /**
   * Whether signer material is configured — presence only, never a value. The
   * UI needs to say "no member wallet configured" without any secret leaving
   * the main process.
   */
  readonly memberSignerConfigured: boolean;
  readonly executorSignerConfigured: boolean;
}

const REDACTED = '[redacted]';

/**
 * Main/worker only. Never a field on a DTO, never an argument to a log call.
 *
 * **It now carries key material.** The redaction below was written before there
 * was anything worth redacting, on the reasoning that the moment a key landed
 * here an unguarded `console.log(config)` would be the leak. That moment is
 * 2026-09-06, and the three overrides are what stop it.
 *
 * `memberKey` is the wallet a member's own governance actions are signed with.
 * It is absent unless `ZARYA_MEMBER_KEY` is set, and its absence is a normal
 * state: the whole read, issue and import half of this application works without
 * one, and only sending needs it.
 *
 * The executor key is deliberately **not** here yet. It belongs to Phase 7 and
 * hard rule 3 constrains what it may do, so it arrives with the thing that
 * enforces that rather than ahead of it.
 */
export class SecretConfig {
  readonly rpcUrl: string;
  /** `undefined` when no member wallet is configured. Not an error. */
  readonly memberKey: `0x${string}` | undefined;

  constructor(rpcUrl: string, memberKey?: `0x${string}`) {
    this.rpcUrl = rpcUrl;
    this.memberKey = memberKey;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** `util.inspect`, which is what `console.log` of an object actually calls. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export interface AppConfig {
  readonly publicConfig: PublicConfig;
  readonly secretConfig: SecretConfig;
}

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/**
 * Defaults live here rather than in domain code or in a reference document, so
 * the app starts without a hand-written environment while the values stay
 * overridable. The address is the 2026-08-24 Sepolia redeploy recorded in
 * `__ai/references/DEPLOYMENT.md`; the predecessor deployment expects a
 * three-argument `castVote` and must not be pointed at.
 */
const DEFAULTS = {
  chainId: 11155111,
  contractAddress: '0x6b31cC58a7DC5919f460068cF68D16281F360d25',
  rpcUrl: 'https://rpc.sepolia.org',
  executorPollIntervalSeconds: 300,
  /**
   * Located by binary search over `eth_getCode` against Sepolia, not
   * transcribed: block 11553464 is the first holding code at the configured
   * address, and its timestamp is 2026-08-24T00:13:00Z — matching the redeploy
   * date in `DEPLOYMENT.md`.
   *
   * It travels with the address, so overriding one without the other backfills
   * from the wrong place. Overriding the address alone is caught only if the new
   * deployment is *newer*, which is why they are validated together below.
   */
  deploymentBlock: 11_553_464,
} as const;

const MIN_POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

/** Just enough of `process.env` to be passed a plain object in a test. */
export type Environment = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  env?: Environment;
  appVersion: string;
}

const readInteger = (raw: string, variable: string): number => {
  // Number() rather than parseInt(): parseInt('300abc') is 300, which would let
  // a typo through as a plausible-looking value.
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${variable} must be an integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
};

/**
 * Loads configuration and fails closed. Every rejection here happens at startup
 * rather than at the first chain call, so a misconfigured client never reaches a
 * write path.
 */
export function loadConfig({ env = process.env, appVersion }: LoadConfigOptions): AppConfig {
  const rawChainId = env.ZARYA_CHAIN_ID;
  const observedChainId = rawChainId === undefined
    ? chainId(DEFAULTS.chainId)
    : chainId(readInteger(rawChainId, 'ZARYA_CHAIN_ID'));

  // Hard rule 1, enforced by the domain. Deliberately not a warning: the rest
  // of the app is written on the assumption that only Sepolia is reachable.
  assertPermittedNetwork(observedChainId);

  let contractAddress: EvmAddress;
  try {
    contractAddress = evmAddress(env.ZARYA_CONTRACT_ADDRESS ?? DEFAULTS.contractAddress);
  } catch (cause) {
    throw new ConfigError('ZARYA_CONTRACT_ADDRESS is not a valid address', { cause });
  }

  const rpcUrl = env.ZARYA_RPC_URL ?? DEFAULTS.rpcUrl;
  let rpcHost: string;
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'wss:') {
      throw new Error(`unsupported protocol ${parsed.protocol}`);
    }
    rpcHost = parsed.host;
  } catch (cause) {
    // The URL itself is never echoed back — it may carry an API key.
    throw new ConfigError('ZARYA_RPC_URL is not a usable http(s) or wss URL', { cause });
  }

  const rawPoll = env.ZARYA_EXECUTOR_POLL_SECONDS;
  const executorPollIntervalSeconds = rawPoll === undefined
    ? DEFAULTS.executorPollIntervalSeconds
    : readInteger(rawPoll, 'ZARYA_EXECUTOR_POLL_SECONDS');
  if (
    executorPollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS ||
    executorPollIntervalSeconds > MAX_POLL_INTERVAL_SECONDS
  ) {
    throw new ConfigError(
      `ZARYA_EXECUTOR_POLL_SECONDS must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_POLL_INTERVAL_SECONDS}, received ${executorPollIntervalSeconds}`,
    );
  }

  const rawDeploymentBlock = env.ZARYA_DEPLOYMENT_BLOCK;
  let deploymentBlock: number;
  if (rawDeploymentBlock === undefined) {
    // The default belongs to the default address. A custom address with the
    // stock deployment block would backfill from before its own deployment —
    // wasteful but harmless — or, if it is older, miss its early votings
    // entirely. Refuse rather than guess.
    if (contractAddress.toLowerCase() !== DEFAULTS.contractAddress.toLowerCase()) {
      throw new ConfigError(
        'ZARYA_DEPLOYMENT_BLOCK must be set when ZARYA_CONTRACT_ADDRESS is not the default — ' +
          'discovery would otherwise backfill from another deployment’s block',
      );
    }
    deploymentBlock = DEFAULTS.deploymentBlock;
  } else {
    const parsed = readInteger(rawDeploymentBlock, 'ZARYA_DEPLOYMENT_BLOCK');
    if (parsed < 0) {
      throw new ConfigError(
        `ZARYA_DEPLOYMENT_BLOCK must not be negative, received ${parsed}`,
      );
    }
    deploymentBlock = parsed;
  }

  // Presence, not value. Nothing that leaves this function copies key material.
  const configured = (value: string | undefined): boolean =>
    value !== undefined && value.trim().length > 0;

  // Validated here so a malformed key is a startup message rather than a failure
  // at the moment a member presses send. The value is never echoed, not even
  // truncated: a prefix of a private key is still key material.
  let memberKey: `0x${string}` | undefined;
  const rawMemberKey = env.ZARYA_MEMBER_KEY?.trim();
  if (rawMemberKey !== undefined && rawMemberKey.length > 0) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(rawMemberKey)) {
      throw new ConfigError(
        'ZARYA_MEMBER_KEY is not a 32-byte hex private key (0x followed by 64 hex characters)',
      );
    }
    memberKey = rawMemberKey as `0x${string}`;
  }

  return {
    publicConfig: {
      chainId: observedChainId,
      contractAddress,
      rpcHost,
      deploymentBlock,
      executorPollIntervalSeconds,
      appVersion,
      memberSignerConfigured: configured(env.ZARYA_MEMBER_KEY),
      executorSignerConfigured: configured(env.ZARYA_EXECUTOR_KEY),
    },
    secretConfig: new SecretConfig(rpcUrl, memberKey),
  };
}
