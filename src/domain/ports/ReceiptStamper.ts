import type { ChainId, EvmAddress, UnixSeconds } from '../primitives';

/**
 * Turning a returned form into a receipt.
 *
 * The stamp is the **whole** of what makes a receipt: the form is flattened so
 * the result is a document rather than something still fillable, and a mark
 * carrying the transaction's facts is applied on top of it.
 *
 * Nothing is written into a field. `zarya.receipt.*` used to be six widgets
 * issued empty and filled here, which meant the stamper had a rule to keep —
 * overwrite unconditionally, never merge with what a member typed. There is now
 * nothing to merge with, because there is nothing for a member to type into.
 *
 * ## A receipt is a rendering, not a record
 *
 * Everything on it is already in the database. Nothing downstream ever parses
 * one to recover a value, and a stamped receipt carries no readable field at
 * all — it is flattened — so it cannot re-enter the pipeline as input.
 *
 * That is what makes stamping **idempotent and re-runnable**: a lost receipt is
 * regenerated from the stored form bytes plus the transaction record, with no
 * chain write and no chain read. The file is disposable output.
 *
 * ## A stamp is not a security control
 *
 * Anyone can put one on any PDF, and an official-looking one is easier to forge
 * than a plain one, not harder. It marks the document for a human reading it;
 * the chain is the verification, reachable from the transaction hash the stamp
 * prints. Nothing in this application may treat a stamped file as evidence of
 * anything (`INVARIANTS.md`).
 */

/**
 * What a receipt states, all of it from the transaction record.
 *
 * **A confirmed transaction is not an accepted proposal.** `status` is the
 * transaction's outcome and says nothing about whether a voting passed —
 * `executeVoting` succeeding is a statement about a call, not about governance.
 * The two are kept as separate sentences on the page for the same reason they
 * are separate fields here.
 */
export interface ReceiptFacts {
  readonly txHash: `0x${string}`;
  /** `SUCCESS` or `REVERTED`. A reverted transaction is still stamped. */
  readonly status: string;
  readonly blockNumber: string;
  readonly chainId: ChainId;
  /** Chain block time, never the workstation's. */
  readonly confirmedAt: UnixSeconds;
  /** The signer's address. No other key material may appear on a receipt. */
  readonly signer: EvmAddress;
}

export interface StampedReceipt {
  readonly bytes: Uint8Array;
  /**
   * Which facts the stamp states, named by their schema keys, for a test to
   * assert against the schema rather than against a literal list.
   */
  readonly drawnFacts: readonly string[];
}

export interface ReceiptStamper {
  /**
   * Stamps `form` — the bytes exactly as the member returned them — with `facts`.
   *
   * Takes the stored bytes rather than a path, because the input is a record and
   * the output is disposable: where the result goes is the caller's, through
   * `FileSink`.
   *
   * **Throws** if the form cannot carry a receipt — a document that cannot name
   * its own operation was not issued by this application, and stamping one would
   * produce a plausible-looking file with nothing behind it.
   */
  stamp(form: Uint8Array, facts: ReceiptFacts): Promise<StampedReceipt>;
}
