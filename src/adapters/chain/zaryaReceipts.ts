import type { ReceiptReader, TransactionOutcome } from '../../domain/ports/ReceiptReader';
import type { EvmAddress } from '../../domain/primitives';
import { decodeZaryaError } from './errorDecoder';
import type { ZaryaPublicClient } from './publicClient';
import { readRevert } from './revertData';

/**
 * `ReceiptReader` over a viem public client.
 *
 * No signer and no key: recovery has to be able to ask what a nonce did without
 * a wallet in scope, which is why this is a separate port from `Signer`.
 *
 * Every read answers `undefined` rather than throwing, following every other
 * chain reader in this client. A transaction that is not yet mined and a
 * provider that timed out are the same answer — keep waiting — and neither is a
 * failure. Turning an outage into a verdict here is how `PENDING` would wrongly
 * become `FAILED`.
 */
export class ZaryaReceipts implements ReceiptReader {
  constructor(private readonly client: ZaryaPublicClient) {}

  async outcome(hash: `0x${string}`): Promise<TransactionOutcome | undefined> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch {
      // viem throws for a hash it cannot find, which is the normal state of a
      // transaction still in a mempool. Indistinguishable from an outage here,
      // and treated the same.
      return undefined;
    }

    // The block is read for its timestamp, which is stored so a receipt can be
    // stamped later with no chain access at all.
    const confirmedAt = await this.blockTime(receipt.blockNumber);
    if (confirmedAt === undefined) return undefined;

    if (receipt.status === 'success') {
      return {
        status: 'SUCCESS',
        blockNumber: receipt.blockNumber.toString(),
        confirmedAt,
      };
    }

    return {
      status: 'REVERTED',
      blockNumber: receipt.blockNumber.toString(),
      confirmedAt,
      // A receipt carries no revert data, so the reason has to be re-derived by
      // replaying the call at that block. Best effort: a reason that cannot be
      // recovered leaves the field absent, which means "reverted, reason
      // unknown" and never "did not revert".
      ...(await this.revertReason(hash, receipt.blockNumber)),
    };
  }

  /**
   * The block's own timestamp.
   *
   * `undefined` collapses the whole outcome to "could not read": a confirmed
   * transaction whose confirmation time is unknown would be stored without one,
   * and stamping would later have to reach for a clock. Refusing the outcome
   * keeps the row `PENDING` and retryable instead.
   */
  private async blockTime(blockNumber: bigint): Promise<number | undefined> {
    try {
      const block = await this.client.getBlock({ blockNumber });
      return Number(block.timestamp);
    } catch {
      return undefined;
    }
  }

  async pendingNonce(address: EvmAddress): Promise<number | undefined> {
    try {
      return await this.client.getTransactionCount({ address, blockTag: 'pending' });
    } catch {
      return undefined;
    }
  }

  /**
   * Replays a reverted transaction to recover its error.
   *
   * `eth_call` at the block it was mined in, with the same sender and data —
   * the standard way to get revert data a receipt does not carry. It is a read
   * and cannot change anything; if the provider refuses (many public endpoints
   * do not keep the state), the reason is simply absent.
   */
  private async revertReason(
    hash: `0x${string}`,
    blockNumber: bigint,
  ): Promise<{ failure?: string; revertReason?: string }> {
    try {
      const transaction = await this.client.getTransaction({ hash });
      await this.client.call({
        account: transaction.from,
        to: transaction.to ?? undefined,
        data: transaction.input,
        blockNumber,
      });
      // It did not revert on replay. The state at that block differs from what
      // the transaction saw, so nothing can be concluded about the reason.
      return {};
    } catch (error) {
      const observed = readRevert(error);
      if (observed?.data === undefined) return {};
      const decoded = decodeZaryaError(observed.data);
      // An undecodable selector is a statement about this client's registry, not
      // about the contract — so the reason stays absent rather than becoming a
      // guess or a raw selector a member could not act on.
      return decoded === undefined ? {} : { revertReason: decoded.name };
    }
  }
}
