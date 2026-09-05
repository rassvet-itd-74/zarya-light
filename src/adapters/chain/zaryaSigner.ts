import { http, createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { Signer, SignerIdentity, SignedSubmission, UnsignedCall } from '../../domain/ports/Signer';
import { type ChainId, type EvmAddress, chainId, evmAddress } from '../../domain/primitives';

/**
 * `Signer` over a viem wallet client.
 *
 * ## The key never leaves this object
 *
 * It is turned into an account in the constructor and the string is not kept.
 * There is no getter, no field holding it, and nothing here logs, serializes or
 * returns it — hard rule 2 as code rather than as a convention. The class is
 * also `toJSON`-hostile by having nothing to serialize; an accidental
 * `JSON.stringify(signer)` yields `{}` rather than a key.
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
    this.wallet = createWalletClient({
      account: this.account,
      chain: sepolia,
      transport: http(rpcUrl),
    });
    this.reader = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    this.network = chainId(sepolia.id);
    // The key parameter goes out of scope here and is referenced nowhere else.
  }

  identity(): SignerIdentity {
    return { address: evmAddress(this.account.address) as EvmAddress, chainId: this.network };
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
