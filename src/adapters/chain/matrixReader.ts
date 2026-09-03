import {
  type AxisLabel,
  type CategoricalCell,
  type MatrixCoordinate,
  type MatrixKind,
  type NumericalCell,
  axisLabel,
  cellBinding,
} from '../../domain/matrix/matrix';
import type { MatrixReader } from '../../domain/ports/MatrixReader';
import { type EvmAddress, bytes32 } from '../../domain/primitives';
import { callContract } from './contractCall';
import type { ZaryaPublicClient } from './publicClient';

/**
 * The matrix metadata reads, behind the domain's port.
 *
 * Two translations happen here and nowhere else.
 *
 * **`MatrixKind` becomes `isCategorical`.** The contract keys the pair of
 * matrices on a bare `bool`, and a bare `bool` is wrong silently — it addresses
 * the *other real matrix* rather than failing, which is the same shape of
 * mistake as a region subject code passed for an ordinal. The domain carries a
 * named kind and the boolean exists only in {@link isCategoricalOf}.
 *
 * **The zero organ becomes `UNBOUND`.** `getCategoricalCellOrgan` returns a
 * `bytes32` for every coordinate, bound or not, and the unbound answer is 32
 * zero bytes rather than an error. Left as a hash it would flow into an
 * `isMember` call and quietly report nobody as a member of nothing.
 *
 * As everywhere else: `undefined` means the read did not answer. An empty cell
 * answers `UNBOUND` and an empty axis answers `UNSET`.
 */
export class ZaryaMatrixReader implements MatrixReader {
  /**
   * `blockNumber` pins every read on this instance.
   *
   * Absent — the default, and what preflight uses — the reads follow the head.
   * The matrix report constructs a pinned one so that a whole document describes
   * a single block; see `ZaryaMatrixSnapshot`, which composes this rather than
   * repeating its decoding.
   */
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
    private readonly blockNumber?: bigint,
  ) {}

  private get pin(): { readonly blockNumber?: bigint } {
    return this.blockNumber === undefined ? {} : { blockNumber: this.blockNumber };
  }

  /**
   * One call, not three. `getCategoricalCellInfo` returns the organ, the allowed
   * categories and the sample length together (`Matricies.sol:280-292`), and the
   * three have to be consistent with each other: reading the binding and the
   * category set in separate round trips could straddle a finalization and
   * produce a pair that never existed on chain.
   */
  async categoricalCell(at: MatrixCoordinate): Promise<CategoricalCell | undefined> {
    const outcome = await callContract(
      this.client,
      this.address,
      'getCategoricalCellInfo',
      [at.x, at.y],
      this.pin,
    );
    if (outcome.kind !== 'VALUE' || !Array.isArray(outcome.value)) return undefined;

    const [organ, categories, sampleLength] = outcome.value as unknown[];
    if (
      typeof organ !== 'string' ||
      !Array.isArray(categories) ||
      typeof sampleLength !== 'bigint'
    ) {
      return undefined;
    }
    if (!categories.every((category): category is bigint => typeof category === 'bigint')) {
      return undefined;
    }

    try {
      return {
        binding: cellBinding(bytes32(organ)),
        allowedCategories: categories,
        sampleLength,
      };
    } catch {
      return undefined;
    }
  }

  async numericalCell(at: MatrixCoordinate): Promise<NumericalCell | undefined> {
    const outcome = await callContract(
      this.client,
      this.address,
      'getNumericalCellInfo',
      [at.x, at.y],
      this.pin,
    );
    if (outcome.kind !== 'VALUE' || !Array.isArray(outcome.value)) return undefined;

    const [organ, decimals, sampleLength] = outcome.value as unknown[];
    if (
      typeof organ !== 'string' ||
      typeof decimals !== 'number' ||
      typeof sampleLength !== 'bigint'
    ) {
      return undefined;
    }

    try {
      return { binding: cellBinding(bytes32(organ)), decimals, sampleLength };
    } catch {
      return undefined;
    }
  }

  theme(kind: MatrixKind, x: bigint): Promise<AxisLabel | undefined> {
    return this.readLabel('getTheme', [isCategoricalOf(kind), x]);
  }

  /** By `y` alone — see the port, and `Matricies.sol:168-181` for why. */
  statement(kind: MatrixKind, y: bigint): Promise<AxisLabel | undefined> {
    return this.readLabel('getStatement', [isCategoricalOf(kind), y]);
  }

  /**
   * Shared by `getTheme`, `getStatement` and `getCategoryName` — three getters
   * that return a `string` whose empty value means "not set" rather than "an
   * empty name", so all three go through {@link axisLabel}.
   */
  async readLabel(functionName: string, args: readonly unknown[]): Promise<AxisLabel | undefined> {
    const outcome = await callContract(this.client, this.address, functionName, args, this.pin);
    return outcome.kind === 'VALUE' && typeof outcome.value === 'string'
      ? axisLabel(outcome.value)
      : undefined;
  }
}

/**
 * The only place a `MatrixKind` becomes the contract's `bool isCategorical`.
 *
 * Exhaustive rather than `kind === 'CATEGORICAL'`, so a third matrix would be a
 * compile error here instead of silently reading as numerical.
 */
export function isCategoricalOf(kind: MatrixKind): boolean {
  switch (kind) {
    case 'CATEGORICAL':
      return true;
    case 'NUMERICAL':
      return false;
  }
}

/**
 * The same translation the other way, for logs rather than for calls.
 *
 * `ThemeVotingCreated` and `StatementVotingCreated` carry the raw
 * `bool isCategorical`, so the index needs the inverse of {@link isCategoricalOf}
 * — and it belongs here, beside it, because this module is where the boolean is
 * allowed to exist and a second conversion elsewhere is a second chance to
 * invert it.
 */
export const matrixKindOf = (isCategorical: boolean): MatrixKind =>
  isCategorical ? 'CATEGORICAL' : 'NUMERICAL';
