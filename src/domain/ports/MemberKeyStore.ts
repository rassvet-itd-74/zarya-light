import type { EvmAddress } from '../primitives';

/**
 * The member wallet: created once, encrypted at rest, and never handed out.
 *
 * ## Why the key is generated here rather than configured
 *
 * A private key in an environment variable is a private key in a plaintext file
 * that a backup, a screen share, or a stray `git add` will eventually copy. This
 * client creates its own wallet on first use and stores it encrypted by the
 * operating system's own facility, so there is no moment at which a member has
 * to handle key material and no file that is dangerous to read.
 *
 * ## The port hands out an address, never a key
 *
 * Hard rule 2 as a shape, exactly like `Signer`: there is no `export`, no
 * `reveal`, no `privateKey`. {@link identity} is what the rest of the
 * application is allowed to know, and it is the thing a member needs — the
 * address to fund and to recognise on a block explorer.
 *
 * Whoever actually signs receives the key by a route the domain does not
 * describe, because the two ends of that route are process boundaries and this
 * layer may not know about processes.
 *
 * ## Losing it is permanent, and the product has to decide what that means
 *
 * The encryption is bound to the operating system account. A reinstalled
 * machine, a new user profile, or a corrupted store leaves the key
 * unrecoverable — and an unrecoverable governance wallet is an address that can
 * never vote again. Nothing here backs it up. That is a **deliberate gap**
 * awaiting a product decision, not an oversight, and it is recorded in
 * `INVARIANTS.md` so it cannot be discovered by a member instead.
 */

export type KeyStoreStatus =
  /** A wallet exists and was decrypted. */
  | 'READY'
  /** A wallet was created and stored during this call. */
  | 'CREATED'
  /**
   * The platform offers no encryption, so nothing was stored.
   *
   * Refusing to create is the whole point: writing an unencrypted key to disk
   * because the encryption was unavailable is the failure this port exists to
   * make impossible.
   */
  | 'UNAVAILABLE'
  /** A stored wallet exists and could not be decrypted or parsed. */
  | 'UNREADABLE';

export interface MemberKeyState {
  readonly status: KeyStoreStatus;
  /** Present for `READY` and `CREATED`. The address to fund. */
  readonly address?: EvmAddress;
  /** Safe to display. Never contains key material. */
  readonly message?: string;
}

export interface MemberKeyStore {
  /**
   * Loads the wallet, creating and storing one if none exists.
   *
   * Idempotent: called on every start, and it creates exactly once. A second
   * call must never replace an existing key — that would strand every operation
   * already sent from the old address.
   */
  ensure(): Promise<MemberKeyState>;

  /** What exists right now, without creating anything. */
  identity(): Promise<MemberKeyState>;
}
