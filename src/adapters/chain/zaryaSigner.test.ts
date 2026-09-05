import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PrivateKeySigner } from './zaryaSigner';

/**
 * What can be checked about a signer without a chain: who it says it is, and
 * whether the key can get back out of it.
 *
 * The second is hard rule 2 — private keys never reach the renderer, the logs,
 * or the database — expressed as a test rather than as a comment. Every route
 * out of this object is a route into a log line or a crash report, and the ones
 * that matter are the accidental ones: an object dropped into `console.log`, an
 * error serialized by a reporter, a value handed to `structuredClone` on its way
 * across IPC.
 *
 * The key below is **anvil's first published development account**, printed by
 * the tool on every startup and present in every Foundry tutorial. It is funded
 * only on a local node and holds nothing anywhere else. Using a real-shaped key
 * is the point: a fake one might not exercise the same code path in viem.
 */

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** The key without its `0x`, which is how it would appear inside a blob. */
const BARE_KEY = ANVIL_KEY.slice(2);

/**
 * A URL shaped like the real one: the secret is in the *path*, which is how
 * every provider this client will meet does it.
 */
const SECRET_SEGMENT = 'sUpErSeCrEtApIkEy';
const RPC_URL = `https://sepolia.example.invalid/v2/${SECRET_SEGMENT}`;

const signer = () => new PrivateKeySigner(ANVIL_KEY, RPC_URL);

/** Every string this object can be turned into by an accident. */
const renderings = (value: unknown): Record<string, string> => ({
  'JSON.stringify': JSON.stringify(value) ?? 'undefined',
  // No `showHidden`: this is what `console.log` and every error reporter do.
  'util.inspect': inspect(value, { depth: 10 }),
  'String()': String(value),
  'template literal': `${String(value)}`,
});

/** The debugging escape hatch, which is *supposed* to see everything. */
const deepRendering = (value: unknown): string =>
  inspect(value, { depth: 10, showHidden: true });

describe('who the signer is', () => {
  it('derives its address from the key, with no provider round trip', () => {
    // Synchronous by design: a caller displaying who is about to sign must not
    // have to wait on a network that may be down.
    expect(signer().identity().address.toLowerCase()).toBe(ANVIL_ADDRESS.toLowerCase());
  });

  it('reports Sepolia, and reports it from the chain it was built with', () => {
    // Hard rule 1. This is the client's own claim about itself, not a check of
    // the endpoint — `ZaryaNetworkGuard` does that against the node, because a
    // configured chain object proves nothing about what is behind the URL.
    expect(signer().identity().chainId).toBe(11155111);
  });

  it('needs no reachable endpoint to answer', () => {
    // Constructed against a port nothing is listening on. If identity ever
    // starts asking the provider, this fails rather than hanging in production
    // startup.
    expect(() => signer().identity()).not.toThrow();
  });
});

describe('the RPC URL cannot get back out either', () => {
  /**
   * A found defect, not a hypothetical.
   *
   * A viem client keeps its URL on `transport.url` as an ordinary enumerable
   * property, so before 2026-09-06 `JSON.stringify(signer)` and
   * `util.inspect(signer)` both printed it in full — API key and all — while the
   * class comment claimed the object had nothing to serialize. The same was true
   * of the twelve other classes in this adapter that hold a client.
   */
  it('appears in no accidental rendering of the signer', () => {
    const subject = signer();
    for (const [route, text] of Object.entries(renderings(subject))) {
      expect(text, route).not.toContain(SECRET_SEGMENT);
    }
    // And still visible to someone who explicitly asks for hidden properties —
    // the point is to stop it travelling by accident, not to make debugging a
    // transport impossible.
    expect(deepRendering(subject)).toContain(SECRET_SEGMENT);
  });

  it('is still readable by anything that names it', () => {
    // Hidden from enumeration, not removed. viem reads this property, and a
    // "fix" that deleted it would break every request instead of leaking one.
    const transport = (signer() as unknown as { reader: { transport: { url?: string } } }).reader
      .transport;
    expect(transport.url).toBe(RPC_URL);
  });
});

describe('the key cannot get back out', () => {
  it('appears in no accidental rendering of the signer', () => {
    const subject = signer();
    for (const [route, text] of Object.entries(renderings(subject))) {
      expect(text.toLowerCase(), route).not.toContain(BARE_KEY.toLowerCase());
    }
  });

  it('appears in no rendering of what identity hands out', () => {
    // The value that actually crosses a boundary. Whatever the signer holds
    // internally, this is what reaches IPC and the logs.
    for (const [route, text] of Object.entries(renderings(signer().identity()))) {
      expect(text.toLowerCase(), route).not.toContain(BARE_KEY.toLowerCase());
    }
  });

  it('exposes no property that returns key material', () => {
    // Walks the object and its prototype rather than trusting TypeScript's
    // `private`, which is erased at runtime and stops nobody.
    const subject = signer() as unknown as Record<string, unknown>;
    const names = [
      ...Object.getOwnPropertyNames(subject),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(subject)),
    ];
    for (const name of names) {
      expect(name.toLowerCase(), name).not.toMatch(/private|secret|mnemonic|seed/);
    }
  });

  it('serializes to its identity and nothing else', () => {
    // The claim the class comment used to make and did not keep. It said
    // `JSON.stringify(signer)` yielded `{}` because TypeScript's `private` hid
    // the fields; `private` is erased at runtime and the real output was two
    // kilobytes. Now it is true, in a more useful form than `{}`.
    expect(JSON.parse(JSON.stringify(signer()))).toEqual({
      address: ANVIL_ADDRESS,
      chainId: 11155111,
    });
  });

  it('survives a structured clone without carrying one', () => {
    // The IPC boundary's actual mechanism. A signer is never meant to cross it,
    // and this pins what happens if one ever does.
    let cloned: string;
    try {
      cloned = JSON.stringify(structuredClone(signer().identity()));
    } catch (error) {
      cloned = String(error);
    }
    expect(cloned.toLowerCase()).not.toContain(BARE_KEY.toLowerCase());
  });
});
