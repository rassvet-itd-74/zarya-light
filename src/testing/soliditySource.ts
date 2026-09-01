import { existsSync, readFileSync } from 'node:fs';

/**
 * Reading the Solidity source of truth, for tests that check derived tables
 * against it.
 *
 * Several tables in this client — the 98 regions, the eight organ types, the
 * error fragments the ABI omits — are transcriptions of `temporal_docs/`. A test
 * that restated those values by hand would agree with a transcription error, so
 * the tests re-parse the source instead and compare.
 *
 * ## These checks are temporary by design
 *
 * `temporal_docs/` is scheduled to leave the repository once the implementation
 * plan is complete. So every source-derived check is **opt-in on the source
 * being present** — {@link hasSoliditySource} — exactly as the fork tests are
 * opt-in on an RPC URL. When the sources go, those suites skip and the run stays
 * green rather than failing over a file nobody meant to keep.
 *
 * What survives that removal is the stronger evidence, not the weaker:
 *
 * - the **fork tests** resolve every region and every organ type through the
 *   deployed contract's own `pure` helpers, and deployed bytecode outranks any
 *   source tree;
 * - the **literal keccak digests** in `organLabelTable.test.ts` pin the local
 *   mirror's encoding without reference to any file.
 *
 * These parsers are the cheapest check while the source is here, not the only
 * one holding the tables up.
 *
 * ## Why the module lives outside both layers
 *
 * It reads files, and the domain may not. That restriction covers domain *test*
 * files too, and rightly — an exception carved into the lint rule would apply to
 * production modules the next time someone added one. So the I/O sits in a
 * module nothing shipped imports: none of the four build entries reach it.
 *
 * Paths are relative to the repository root, which is Vitest's working
 * directory.
 */

const cache = new Map<string, string>();

const read = (path: string): string => {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const contents = readFileSync(path, 'utf8');
  cache.set(path, contents);
  return contents;
};

export const REGIONS_SOL = 'temporal_docs/libraries/Regions.sol';
export const PARTY_ORGANS_SOL = 'temporal_docs/libraries/PartyOrgans.sol';
export const MATRICIES_SOL = 'temporal_docs/libraries/Matricies.sol';
export const VOTINGS_SOL = 'temporal_docs/libraries/Votings.sol';

/**
 * Whether the Solidity source is still in the tree. Guard every source-derived
 * suite with `describe.skipIf(!hasSoliditySource(...))`.
 */
export const hasSoliditySource = (path: string): boolean => existsSync(path);

export const soliditySource = (path: string): string => read(path);

/**
 * Enum member names in declaration order. The index is the ordinal, which is
 * what the ABI's `uint8` arguments carry.
 */
export function enumMembers(path: string, enumName: string): string[] {
  const source = read(path);
  const opening = `enum ${enumName} {`;
  const start = source.indexOf(opening);
  if (start < 0) throw new Error(`${path} declares no enum ${enumName}`);

  const body = source.slice(start + opening.length);
  const end = body.indexOf('}');
  if (end < 0) throw new Error(`enum ${enumName} in ${path} is unterminated`);

  const members: string[] = [];
  for (const line of body.slice(0, end).split('\n')) {
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('//')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*(?:\/\/.*)?$/.exec(stripped);
    if (match === null) throw new Error(`unparsed ${enumName} line: ${JSON.stringify(stripped)}`);
    members.push(match[1]);
  }
  return members;
}

/**
 * `Regions.toString`'s branches: enum member name to two-digit subject code.
 *
 * This function, not the `// = NN` comments beside the enum, is what the
 * contract actually executes on its way to an organ identifier.
 */
export function regionSubjectCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  const pattern = /if\s*\(region\s*==\s*Region\.([A-Z0-9_]+)\)\s*return\s*"(\d{2})";/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(read(REGIONS_SOL))) !== null) {
    codes.set(match[1], match[2]);
  }
  return codes;
}

/** The `// = NN` annotations beside the enum members. Documentation, not behavior. */
export function regionCommentedCodes(): Map<string, string> {
  const commented = new Map<string, string>();
  const pattern = /^\s*([A-Z0-9_]+)\s*,?\s*\/\/\s*=\s*(\d+)\s*,?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(read(REGIONS_SOL))) !== null) {
    commented.set(match[1], match[2]);
  }
  return commented;
}

/**
 * The parameter types of a declared `error`, e.g. `NoThemeSet` →
 * `['bool', 'uint256']`. `undefined` when the file declares no such error.
 */
export function errorParameterTypes(path: string, name: string): string[] | undefined {
  const declaration = new RegExp(`error\\s+${name}\\(([^)]*)\\);`).exec(read(path));
  if (declaration === null) return undefined;
  return declaration[1]
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((part) => part !== '');
}

export interface SolidityEventParameter {
  readonly type: string;
  readonly indexed: boolean;
  readonly name: string;
}

/**
 * The parameters of a declared `event`, in order, with their `indexed` flags.
 *
 * Needed for exactly one event: `ValueAdded`, which is the only signature this
 * client hand-writes, because an externally-linked library's events never reach
 * the calling contract's ABI. Everything else is read from the ABI file itself.
 */
export function eventParameters(
  path: string,
  name: string,
): SolidityEventParameter[] | undefined {
  const declaration = new RegExp(`event\\s+${name}\\(([^)]*)\\);`).exec(read(path));
  if (declaration === null) return undefined;

  return declaration[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const words = part.split(/\s+/);
      const indexed = words.includes('indexed');
      return {
        type: words[0],
        indexed,
        name: words[words.length - 1],
      };
    });
}

/** Whether a `unicode"..."` literal appears verbatim in the source. */
export const declaresUnicodeLiteral = (path: string, literal: string): boolean =>
  read(path).includes(`unicode"${literal}"`);
