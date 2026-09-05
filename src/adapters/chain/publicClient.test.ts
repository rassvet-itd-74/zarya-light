import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createZaryaPublicClient, hideTransportUrl } from './publicClient';
import { ZaryaReceipts } from './zaryaReceipts';

/**
 * The read client, and the one property on it that must not travel.
 *
 * A viem client keeps the URL it was built with on `transport.url`. Every
 * provider this application will meet puts the API key in that URL's path, and
 * `PublicClientOptions` says so — "never logged". It was, until 2026-09-06: the
 * property is ordinary and enumerable, so `JSON.stringify` and `console.log` on
 * anything holding a client printed it in full. Twelve classes in this adapter
 * hold one.
 *
 * These tests are at the construction site rather than on each of those twelve,
 * because that is where the fix is. A thirteenth class holding a client inherits
 * it without knowing.
 */

const SECRET_SEGMENT = 'sUpErSeCrEtApIkEy';
const RPC_URL = `https://sepolia.example.invalid/v2/${SECRET_SEGMENT}`;

const accidentalRenderings = (value: unknown): Record<string, string> => ({
  'JSON.stringify': JSON.stringify(value) ?? 'undefined',
  'util.inspect': inspect(value, { depth: 10 }),
});

describe('the transport URL', () => {
  it('does not appear in an accidental rendering of the client', () => {
    const client = createZaryaPublicClient({ rpcUrl: RPC_URL });
    for (const [route, text] of Object.entries(accidentalRenderings(client))) {
      expect(text, route).not.toContain(SECRET_SEGMENT);
    }
  });

  it('does not appear in a rendering of anything holding the client', () => {
    // The realistic accident. Nobody logs a bare transport; they log the adapter
    // that owns one, or it lands in an error report as a field of something
    // else.
    const receipts = new ZaryaReceipts(createZaryaPublicClient({ rpcUrl: RPC_URL }));
    for (const [route, text] of Object.entries(accidentalRenderings(receipts))) {
      expect(text, route).not.toContain(SECRET_SEGMENT);
    }
    for (const [route, text] of Object.entries(accidentalRenderings({ chain: receipts }))) {
      expect(text, `nested / ${route}`).not.toContain(SECRET_SEGMENT);
    }
  });

  it('is still readable by anything that names it', () => {
    // Hidden from enumeration, not removed — viem reads this property. A fix
    // that deleted it would break every request instead of leaking one.
    const client = createZaryaPublicClient({ rpcUrl: RPC_URL });
    expect((client.transport as { url?: string }).url).toBe(RPC_URL);
  });

  it('is still shown to someone who explicitly asks for hidden properties', () => {
    // The deliberate escape hatch for debugging a transport.
    const client = createZaryaPublicClient({ rpcUrl: RPC_URL });
    expect(inspect(client, { depth: 10, showHidden: true })).toContain(SECRET_SEGMENT);
  });

  it('does not survive a structured clone', () => {
    // The IPC boundary's own mechanism, which copies enumerable properties.
    // A client is never meant to cross it; this pins what happens if one does.
    let cloned: string;
    try {
      cloned = JSON.stringify(structuredClone({ ...createZaryaPublicClient({ rpcUrl: RPC_URL }) }));
    } catch (error) {
      cloned = String(error);
    }
    expect(cloned).not.toContain(SECRET_SEGMENT);
  });
});

describe('hiding the URL is careful about what it touches', () => {
  it('leaves an object with no transport alone', () => {
    const plain = { a: 1 };
    expect(hideTransportUrl(plain)).toBe(plain);
  });

  it('leaves a transport with no URL alone', () => {
    const client = { transport: { type: 'custom' } };
    expect(() => hideTransportUrl(client)).not.toThrow();
    expect(client.transport.type).toBe('custom');
  });

  it('refuses to rewrite a getter rather than guessing at it', () => {
    // If a viem version ever makes this a computed property, replacing it with a
    // data descriptor would change behaviour in a way this module cannot
    // predict. Leaving it is the smaller mistake — and the accompanying comment
    // says the leak is narrowed, never closed.
    const transport = { type: 'http' };
    Object.defineProperty(transport, 'url', {
      get: () => RPC_URL,
      enumerable: true,
      configurable: true,
    });
    hideTransportUrl({ transport });
    expect(Object.getOwnPropertyDescriptor(transport, 'url')?.enumerable).toBe(true);
  });
});
