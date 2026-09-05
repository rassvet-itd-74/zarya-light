import { http, createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { Signer, SignerIdentity, SignedSubmission, UnsignedCall } from '../../domain/ports/Signer';
import { type ChainId, type EvmAddress, chainId, evmAddress } from '../../domain/primitives';
import { hideTransportUrl } from './publicClient';

/**
 * `Signer` over a viem wallet client.
 *
 * ## The key never leaves this object
 *
 * It is turned into an account in the constructor and the string is not kept.
 * There is no getter, no field holding it, and nothing here logs, serializes or
 * returns it — hard rule 2 as code rather than as a convention.
 *
 * ## What this comment used to claim, and why it was wrong
 *
 * It said the class was "`toJSON`-hostile by having nothing to serialize", so
 * that `JSON.stringify(signer)` yielded `{}`. That was false: TypeScript's
 * `private` is erased at runtime, and the real output was two kilobytes across
 * four fields — **including the RPC URL with its API key**, which
 * `PublicClientOptions` documents as a secret that is never logged.
 *
 * The key itself was never in it. But a comment telling a reader that logging a
 * signer is safe is worse than no comment, because it is the reason someone
 * would do it. Found on 2026-09-06 by writing the test this comment had been
 * standing in for.
 *
 * Now: {@link hideTransportUrl} takes the URL out of every enumerating route,
 * and `toJSON` below makes the original claim true in a more useful form — a
 * serialized signer is its identity and nothing else.
 *
 * This runs in the **worker** and only there. Main does not construct one and
 * the renderer cannot reach one.
 *
 * ## The nonce is read back, never chosen
 *
 * `sendTransaction` lets viem ask the provider for the pending nonce, and the
 * value used is read from the signed transaction rather than assumed. A nonce
 * this client picked and the provider replaced would leave a record describing a
 * transaction that does not exist — which is the one thing recovery cannot
 * survive.
 */
export class PrivateKeySigner implements Signer {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly wallet: ReturnType<typeof createWalletClient>;
  /** Reads only. A wallet client cannot answer a nonce; a public one can. */
  private readonly reader: ReturnType<typeof createPublicClient>;
  private readonly network: ChainId;

  constructor(privateKey: `0x${string}`, rpcUrl: string) {
    this.account = privateKeyToAccount(privateKey);
    this.wallet = hideTransportUrl(
      createWalletClient({
        account: this.account,
        chain: sepolia,
        transport: http(rpcUrl),
      }),
    );
    this.reader = hideTransportUrl(
      createPublicClient({ chain: sepolia, transport: http(rpcUrl) }),
    );
    this.network = chainId(sepolia.id);
    // The key parameter goes out of scope here and is referenced nowhere else.
  }

  identity(): SignerIdentity {
    return { address: evmAddress(this.account.address) as EvmAddress, chainId: this.network };
  }

  /**
   * What a serializer gets: the identity, and nothing else.
   *
   * Covers `JSON.stringify` and anything built on it. It is not the only
   * defence — `hideTransportUrl` handles `util.inspect` and structured clone,
   * which do not consult `toJSON` — and neither is a substitute for not logging
   * a signer in the first place.
   */
  toJSON(): SignerIdentity {
    return this.identity();
  }

  async submit(call: UnsignedCall): Promise<SignedSubmission> {
    // Read before sending, so the value recorded is the one the provider is
    // about to assign rather than one inferred afterwards from a mempool that
    // may already have moved.
    const nonce = await this.reader.getTransactionCount({
      address: this.account.address,
      blockTag: 'pending',
    });

    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: sepolia,
      to: call.to,
      data: call.data,
      nonce,
    });

    return { hash, nonce };
  }
}
