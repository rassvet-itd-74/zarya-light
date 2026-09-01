import type { Bytes32 } from '../primitives';
import type { PartyOrganTriple } from '../organs/partyOrgan';

/**
 * Both directions of organ resolution, which are not symmetric.
 *
 * Forward — triple to `bytes32` — has a `pure` getter, so it is a chain call and
 * returns something verified. Reverse — `bytes32` to label — has **no getter at
 * all**, and every event and cell getter returns the hash alone, so the only way
 * back is to hash candidate triples and look the answer up. That makes reverse
 * resolution local, synchronous, and permitted to fail.
 */

export interface ResolvedOrgan {
  readonly triple: PartyOrganTriple;
  readonly organ: Bytes32;
  /** As the contract renders it — e.g. `74.СОВ`. Safe to display. */
  readonly identifier: string;
}

/**
 * Raised when the contract's identifier for a triple is not the one the local
 * mirror composed. The subject-code case is called out because that is the
 * signature of an ordinal/code confusion, which otherwise resolves silently to a
 * different real region.
 */
export class OrganIdentifierMismatchError extends Error {
  constructor(
    readonly triple: PartyOrganTriple,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `the contract renders this organ as ${JSON.stringify(actual)}, ` +
        `this client composed ${JSON.stringify(expected)} — ` +
        'a region subject code may have been passed where an enum ordinal belongs',
    );
    this.name = 'OrganIdentifierMismatchError';
  }
}

export interface OrganResolver {
  /**
   * Resolves through the contract's own `pure` helpers and verifies the label
   * it returns against the locally composed one. Throws
   * {@link OrganIdentifierMismatchError} on disagreement rather than returning a
   * hash nobody has checked.
   */
  resolve(triple: PartyOrganTriple): Promise<ResolvedOrgan>;

  /**
   * Reverse lookup for display. `undefined` means the hash is outside the table
   * this client enumerated — show the hash verbatim, never a guess.
   */
  label(organ: Bytes32): string | undefined;

  /** The triple behind a hash, when the table has it. */
  tripleOf(organ: Bytes32): PartyOrganTriple | undefined;
}
