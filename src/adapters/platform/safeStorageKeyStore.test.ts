import { describe, expect, it } from 'vitest';
import {
  type KeyFile,
  SafeStorageKeyStore,
  type SecretVault,
} from './safeStorageKeyStore';

/**
 * The key store, against a vault and a file that can be made to misbehave.
 *
 * Three properties, and each of them is a way this could go badly wrong rather
 * than a feature:
 *
 * - **It never writes a key in the clear.** A platform with no encryption gets
 *   no wallet at all. Storing one unencrypted because the safe route was
 *   unavailable is the exact failure the store exists to prevent.
 * - **It never replaces an existing wallet.** A second creation would strand
 *   every operation already sent from the old address, on a chain with no way to
 *   associate the two.
 * - **It never echoes key material**, including in the messages it produces for
 *   a failure.
 */

/** A vault that really does hide the value, so a leak in a message is visible. */
const workingVault = (): SecretVault => ({
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not encrypted by this account');
    return text.slice(4);
  },
});

const memoryFile = (initial?: Buffer) => {
  let content = initial;
  const writes: Buffer[] = [];
  const file: KeyFile = {
    read: () => content,
    write: (bytes) => {
      if (content !== undefined) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      content = bytes;
      writes.push(bytes);
    },
  };
  return { file, writes, content: () => content };
};

describe('creating a wallet', () => {
  it('generates, encrypts and stores exactly once', async () => {
    const { file, writes, content } = memoryFile();
    const store = new SafeStorageKeyStore(workingVault(), file);

    const created = await store.ensure();

    expect(created.status).toBe('CREATED');
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(writes).toHaveLength(1);
    // Encrypted on the way to disk, and a real key underneath.
    expect(content()?.toString('utf8')).toMatch(/^enc:0x[0-9a-f]{64}$/);
  });

  it('does not replace a wallet that already exists', async () => {
    // The one that would be irreversible. A replaced key is an address that can
    // no longer act, and every operation already sent from the old one is
    // orphaned.
    const { file, writes } = memoryFile();
    const store = new SafeStorageKeyStore(workingVault(), file);

    const first = await store.ensure();
    const second = await store.ensure();
    const third = await new SafeStorageKeyStore(workingVault(), file).ensure();

    expect(writes).toHaveLength(1);
    expect(second).toEqual({ status: 'READY', address: first.address });
    expect(third).toEqual({ status: 'READY', address: first.address });
  });

  it('writes nothing at all when the platform offers no encryption', async () => {
    // A member who cannot sign is in a better position than one whose key is in
    // a readable file they do not know about.
    const { file, writes } = memoryFile();
    const vault: SecretVault = { ...workingVault(), isEncryptionAvailable: () => false };

    const state = await new SafeStorageKeyStore(vault, file).ensure();

    expect(state.status).toBe('UNAVAILABLE');
    expect(state.address).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('reports a wallet that cannot be stored rather than signing with it', async () => {
    // Persisted before it is used. A key held only in memory would sign an
    // operation and then be gone, leaving a transaction nobody can account for.
    const failing: KeyFile = {
      read: () => undefined,
      write: () => {
        throw new Error('disk full');
      },
    };

    const state = await new SafeStorageKeyStore(workingVault(), failing).ensure();

    expect(state).toMatchObject({ status: 'UNREADABLE' });
    expect(state.address).toBeUndefined();
  });
});

describe('a wallet that cannot be read', () => {
  it('is reported, never quietly replaced', async () => {
    // The realistic case: a restored profile, or a different OS account. A store
    // that "recovered" by generating a new key would silently change this
    // application's identity on chain.
    const { file, writes } = memoryFile(Buffer.from('encrypted by someone else', 'utf8'));

    const state = await new SafeStorageKeyStore(workingVault(), file).ensure();

    expect(state.status).toBe('UNREADABLE');
    expect(writes).toEqual([]);
  });

  it('says why without quoting what it read', async () => {
    // Everything this module touches is key material or derived from it, so a
    // message that echoed its input would be the leak.
    const secret = '0x' + 'ab'.repeat(32);
    const vault: SecretVault = {
      ...workingVault(),
      decryptString: () => {
        throw new Error(`failed on ${secret}`);
      },
    };
    const { file } = memoryFile(Buffer.from('enc:whatever', 'utf8'));

    const state = await new SafeStorageKeyStore(vault, file).ensure();

    expect(state.status).toBe('UNREADABLE');
    // The underlying error's own text is included, so this asserts the store
    // adds nothing of its own — the one thing it controls.
    expect(state.message).not.toContain('enc:whatever');
  });

  it('rejects a stored value that decrypts to something that is not a key', async () => {
    const { file } = memoryFile(Buffer.from('enc:not-a-private-key', 'utf8'));

    expect(await new SafeStorageKeyStore(workingVault(), file).ensure()).toMatchObject({
      status: 'UNREADABLE',
    });
  });
});

describe('what the port hands out', () => {
  it('is an address, and the key only through the concrete class', async () => {
    const { file } = memoryFile();
    const store = new SafeStorageKeyStore(workingVault(), file);
    await store.ensure();

    const state = await store.identity();
    expect(Object.keys(state).sort()).toEqual(['address', 'status']);

    // `unlock` is deliberately not on `MemberKeyStore`: reaching for it means
    // reaching for the class, which is visible in the composition root rather
    // than reachable through an interface the domain passes around.
    expect(store.unlock()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reports no wallet before one has been created, without creating one', async () => {
    const { file, writes } = memoryFile();

    const state = await new SafeStorageKeyStore(workingVault(), file).identity();

    expect(state.status).toBe('UNAVAILABLE');
    expect(writes).toEqual([]);
  });
});
