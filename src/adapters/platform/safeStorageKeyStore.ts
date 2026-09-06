import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type {
  MemberKeyState,
  MemberKeyStore,
} from '../../domain/ports/MemberKeyStore';
import { type EvmAddress, evmAddress } from '../../domain/primitives';

/**
 * `MemberKeyStore` over Electron's `safeStorage`.
 *
 * **Main process only, and that is a platform fact rather than a preference.**
 * `safeStorage` is declared in Electron's `Main` namespace and not in `Utility`,
 * so a `utilityProcess` cannot decrypt anything. The worker signs, so the key
 * has to reach it by a message; this class is the only thing that ever touches
 * the ciphertext.
 *
 * What the encryption is worth, stated plainly: on Windows it is DPAPI, bound to
 * the logged-in account, so the file is useless to another user of the same
 * machine and useless on another machine. It is **not** protection against
 * malware running as that user, which can simply ask the same API to decrypt it.
 *
 * ## It creates exactly once
 *
 * `ensure` is called on every start. An existing file is loaded and never
 * replaced — overwriting one would strand every operation already sent from the
 * old address, on a chain that has no way to associate the two.
 *
 * ## It refuses rather than degrading
 *
 * If the platform reports no encryption available — a Linux session with no
 * keyring is the usual case — nothing is written. Storing a plaintext key
 * because the safe route was unavailable is precisely the failure this exists to
 * prevent, and a member who cannot sign is in a better position than one whose
 * key is in a readable file they do not know about.
 */

/** The subset of `safeStorage` used, so this is testable without Electron. */
export interface SecretVault {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The filesystem calls used, for the same reason. */
export interface KeyFile {
  read(): Buffer | undefined;
  write(bytes: Buffer): void;
}

export const KEY_FILE_NAME = 'member-key.bin';

/**
 * The file, in the same directory as the database.
 *
 * `readFileSync` distinguishes "absent" from "unreadable" by errno rather than
 * by a prior `existsSync`: the check-then-read has a race, and the two answers
 * lead to different states — one creates a wallet, the other must never.
 */
export const keyFileAt = (directory: string): KeyFile => {
  const file = path.join(directory, KEY_FILE_NAME);
  return {
    read: () => {
      try {
        return readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    // `wx` — fail if it already exists. Creation happens once and a race between
    // two starts must lose loudly rather than overwrite a wallet.
    write: (bytes) => writeFileSync(file, bytes, { flag: 'wx' }),
  };
};

export class SafeStorageKeyStore implements MemberKeyStore {
  /**
   * The decrypted key, held only after an explicit `unlock`.
   *
   * Deliberately not exposed on the port: `MemberKeyStore` hands out an address
   * and nothing else, and the one caller that needs the key is the composition
   * root wiring it to a signer.
   */
  private key: `0x${string}` | undefined;

  constructor(
    private readonly vault: SecretVault,
    private readonly file: KeyFile,
  ) {}

  async ensure(): Promise<MemberKeyState> {
    const existing = this.load();
    // Only "no file yet" leads to creation. Every other answer — readable,
    // undecryptable, or a platform with no encryption — is returned as it is,
    // because each of them means a wallet may already exist and replacing one
    // would strand what it has already signed.
    return existing.status === 'ABSENT' ? this.create() : existing;
  }

  async identity(): Promise<MemberKeyState> {
    const state = this.load();
    return state.status === 'ABSENT'
      ? { status: 'UNAVAILABLE', message: 'No member wallet has been created yet.' }
      : (state as MemberKeyState);
  }

  /**
   * The decrypted key, for the composition root to hand to whoever signs.
   *
   * Not on the port. A caller has to reach for the concrete class, which is the
   * intended friction: every use of this method is visible in `main.ts` rather
   * than reachable through an interface the domain hands around.
   */
  unlock(): `0x${string}` | undefined {
    if (this.key === undefined) this.load();
    return this.key;
  }

  private load(): MemberKeyState | { status: 'ABSENT' } {
    let stored: Buffer | undefined;
    try {
      stored = this.file.read();
    } catch (error) {
      return {
        status: 'UNREADABLE',
        message: `The member wallet file could not be read: ${describe(error)}`,
      };
    }
    if (stored === undefined) return { status: 'ABSENT' };

    if (!this.vault.isEncryptionAvailable()) {
      return {
        status: 'UNAVAILABLE',
        message:
          'A member wallet is stored but this system offers no secure storage, so it cannot be ' +
          'decrypted.',
      };
    }

    let plain: string;
    try {
      plain = this.vault.decryptString(stored);
    } catch (error) {
      // Usually a different OS account, or a restored profile. Never repaired
      // automatically: creating a replacement would silently change the
      // application's on-chain identity.
      return {
        status: 'UNREADABLE',
        message:
          'The stored member wallet could not be decrypted on this system. It was encrypted for ' +
          `a different account or installation: ${describe(error)}`,
      };
    }

    const address = addressOf(plain);
    if (address === undefined) {
      return { status: 'UNREADABLE', message: 'The stored member wallet is not a usable key.' };
    }

    this.key = plain as `0x${string}`;
    return { status: 'READY', address };
  }

  private create(): MemberKeyState {
    if (!this.vault.isEncryptionAvailable()) {
      return {
        status: 'UNAVAILABLE',
        message:
          'This system offers no secure storage, so no member wallet was created. Nothing was ' +
          'written to disk — an unencrypted key on disk would be worse than being unable to sign.',
      };
    }

    const generated = generatePrivateKey();
    const address = addressOf(generated);
    if (address === undefined) {
      return { status: 'UNREADABLE', message: 'The generated key was not usable.' };
    }

    try {
      this.file.write(this.vault.encryptString(generated));
    } catch (error) {
      // Written before it is used, so a wallet that could not be persisted is
      // never signed with. A key held only in memory would sign an operation
      // and then be gone, leaving a transaction nobody can account for.
      return {
        status: 'UNREADABLE',
        message: `The new member wallet could not be stored: ${describe(error)}`,
      };
    }

    this.key = generated;
    return { status: 'CREATED', address };
  }
}

/** The address for a key, or `undefined` if it is not one. Never rethrows. */
const addressOf = (key: string): EvmAddress | undefined => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  try {
    return evmAddress(privateKeyToAccount(key as `0x${string}`).address);
  } catch {
    return undefined;
  }
};

/**
 * An error's message, and never the value that caused it.
 *
 * Everything this module touches is either key material or derived from it, so a
 * message that echoed its input would be the leak.
 */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';
