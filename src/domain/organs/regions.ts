import { type Brand, InvalidPrimitiveError } from '../primitives';

/**
 * The 98 federal subjects, in the order `Regions.Region` declares them.
 *
 * **The whole point of this module is that a region has two numbers and only
 * one of them is the argument.** The `region` parameter of `getPartyOrgan` is
 * the enum *ordinal*; the two-digit *subject code* is what the contract renders
 * that ordinal into on its way to the identifier string. `Regions.toString` is a
 * 98-branch lookup, not arithmetic, and the two differ for 50 of the 98.
 *
 * Passing a subject code where an ordinal belongs does not usually revert — it
 * addresses a different real region. Code `95` means Chechnya to a human and
 * ordinal 95 is Lugansk; code `59` means Perm and ordinal 59 is Pskov. Only
 * codes `98` and `99` exceed the enum bound and would revert `UnknownRegion`.
 *
 * So the two are separate branded types here, there is no conversion between
 * them other than this table, and nothing accepts a bare `number` as a region.
 * See "A region has two representations" in `CONTRACT_DEFECTS.md`.
 *
 * The table below is derived from `temporal_docs/libraries/Regions.sol`, not
 * transcribed from it: `regions.test.ts` re-parses that source on every run and
 * fails on any divergence. `toString` is the authority for the code, not the
 * `// = NN` comments beside the enum — they agree today, and the test checks
 * that they still do.
 */

/** The `Regions.Region` enum ordinal. This is the call argument. */
export type RegionOrdinal = Brand<number, 'RegionOrdinal'>;

/**
 * The two-digit federal subject code, as it appears inside an organ identifier.
 * Display and form input only — never a call argument.
 */
export type SubjectCode = Brand<string, 'SubjectCode'>;

export interface Region {
  readonly ordinal: RegionOrdinal;
  readonly subjectCode: SubjectCode;
  /** The Solidity enum member name. The only human-readable name in the source. */
  readonly name: string;
}

/** `[ordinal, subjectCode, enum member name]`, in declaration order. */
const TABLE: ReadonlyArray<readonly [number, string, string]> = [
  [0, '00', 'FEDERAL'],
  [1, '01', 'ADYGEA_REPUBLIC'],
  [2, '02', 'BASHKORTOSTAN_REPUBLIC'],
  [3, '03', 'BURYATIA_REPUBLIC'],
  [4, '04', 'ALTAY_REPUBLIC'],
  [5, '05', 'DAGHESTAN_REPUBLIC'],
  [6, '06', 'INGUSHETIA_REPUBLIC'],
  [7, '07', 'KABARDINO_BALKAR_REPUBLIC'],
  [8, '08', 'KALMYKIYA_REPUBLIC'],
  [9, '09', 'KARACHAY_CHERKESS_REPUBLIC'],
  [10, '10', 'KARELIA_REPUBLIC'],
  [11, '11', 'KOMI_REPUBLIC'],
  [12, '12', 'MARIY_EL_REPUBLIC'],
  [13, '13', 'MORDOVIA_REPUBLIC'],
  [14, '14', 'SAKHA_REPUBLIC_YAKUTIA'],
  [15, '15', 'NORTH_OSSETIA_ALANIA_REPUBLIC'],
  [16, '16', 'TATARSTAN_REPUBLIC'],
  [17, '17', 'TYVA_REPUBLIC'],
  [18, '18', 'UDMURTIA_REPUBLIC'],
  [19, '19', 'HAKASSIA_REPUBLIC'],
  [20, '95', 'CHECHEN_REPUBLIC'],
  [21, '21', 'CHUVASHIA_REPUBLIC'],
  [22, '82', 'KRYM_REPUBLIC'],
  [23, '22', 'ALTAYSKY_KRAI'],
  [24, '59', 'PERMSKY_KRAI'],
  [25, '25', 'PRIMORSKY_KRAI'],
  [26, '26', 'STAVROPOL_KRAI'],
  [27, '27', 'HABAROVSKY_KRAI'],
  [28, '28', 'AMURSKAYA_OBLAST'],
  [29, '29', 'ARCHANGELSKAYA_OBLAST'],
  [30, '30', 'ASTRAKHANSKAYA_OBLAST'],
  [31, '31', 'BELGORODSKAYA_OBLAST'],
  [32, '32', 'BRYANSKAYA_OBLAST'],
  [33, '33', 'VLADIMIRSKAYA_OBLAST'],
  [34, '34', 'VOLGOGRADSKAYA_OBLAST'],
  [35, '35', 'VOLOGODSKAYA_OBLAST'],
  [36, '36', 'VORONEZHSKAYA_OBLAST'],
  [37, '37', 'IVANOVSKAYA_OBLAST'],
  [38, '38', 'IRKUTSKAYA_OBLAST'],
  [39, '39', 'KALININGRADSKAYA_OBLAST'],
  [40, '40', 'KALUZHSKAYA_OBLAST'],
  [41, '42', 'KEMEROVSKAYA_OBLAST'],
  [42, '43', 'KIROVSKAYA_OBLAST'],
  [43, '44', 'KOSTROMSKAYA_OBLAST'],
  [44, '45', 'KURGANSKAYA_OBLAST'],
  [45, '46', 'KURSKAYA_OBLAST'],
  [46, '47', 'LENINGRADSKAYA_OBLAST'],
  [47, '48', 'LIPETSKAYA_OBLAST'],
  [48, '49', 'MAGADANSKAYA_OBLAST'],
  [49, '50', 'MOSKOVSKAYA_OBLAST_50'],
  [50, '90', 'MOSKOVSKAYA_OBLAST_90'],
  [51, '51', 'MURMANSKAYA_OBLAST'],
  [52, '75', 'ZABAIKALSKY_KRAI'],
  [53, '41', 'KAMCHATKSKY_KRAI'],
  [54, '23', 'KRASNODARSKY_KRAI_23'],
  [55, '93', 'KRASNODARSKY_KRAI_93'],
  [56, '24', 'KRASNOYARSKY_KRAI'],
  [57, '57', 'ORLOVSKAYA_OBLAST'],
  [58, '58', 'PENZENSKAYA_OBLAST'],
  [59, '60', 'PSKOVSKAYA_OBLAST'],
  [60, '61', 'ROSTOVSKAYA_OBLAST'],
  [61, '62', 'RYAZANSKAYA_OBLAST'],
  [62, '63', 'SAMARSKAYA_OBLAST'],
  [63, '64', 'SARATOVSKAYA_OBLAST'],
  [64, '65', 'SAKHALINSKAYA_OBLAST'],
  [65, '66', 'SVERDLOVSKAYA_OBLAST_66'],
  [66, '96', 'SVERDLOVSKAYA_OBLAST_96'],
  [67, '67', 'SMOLENSKAYA_OBLAST'],
  [68, '68', 'TAMBOVSKAYA_OBLAST'],
  [69, '69', 'TVERSKAYA_OBLAST'],
  [70, '70', 'TOMSKAYA_OBLAST'],
  [71, '71', 'TULSKAYA_OBLAST'],
  [72, '72', 'TUMENSKAYA_OBLAST'],
  [73, '73', 'ULYANOVSKAYA_OBLAST'],
  [74, '74', 'CHELYABINSKAYA_OBLAST'],
  [75, '76', 'YAROSLAVSKAYA_OBLAST'],
  [76, '52', 'NIZHEGORODSKAYA_OBLAST'],
  [77, '53', 'NOVGORODSKAYA_OBLAST'],
  [78, '54', 'NOVOSIBIRSKAYA_OBLAST'],
  [79, '55', 'OMSKAYA_OBLAST'],
  [80, '56', 'ORENBURGSKAYA_OBLAST'],
  [81, '77', 'MOSCOW_77'],
  [82, '97', 'MOSCOW_97'],
  [83, '99', 'MOSCOW_99'],
  [84, '78', 'SAINT_PETERSBURG_78'],
  [85, '98', 'SAINT_PETERSBURG_98'],
  [86, '92', 'SEVASTOPOL'],
  [87, '79', 'EVREYSKAYA_AUTONOMNAYA_OBLAST'],
  [88, '83', 'NENETSKY_AUTONOMNY_OKRUG'],
  [89, '86', 'HANTY_MANSIYSKY_AUTONOMNY_OKRUG_YUGRA'],
  [90, '87', 'CHUKOTKSKY_AUTONOMNY_OKRUG'],
  [91, '89', 'YAMALO_NENETSKY_AUTONOMNY_OKRUG'],
  [92, '88', 'EXTERNAL_LANDS_88'],
  [93, '94', 'EXTERNAL_LANDS_94'],
  // De jure part of the Russian Federation and present in the enum for
  // completeness. `Regions.sol` states that the contract's authors do not
  // recognize the annexation of these territories; the ordinals are reproduced
  // because a client that omitted them would misaddress every organ after 93.
  [94, '80', 'DONETSK_PEOPLES_REPUBLIC'],
  [95, '81', 'LUGANSK_PEOPLES_REPUBLIC'],
  [96, '84', 'HERSONSKAYA_OBLAST'],
  [97, '85', 'ZAPOROZHSKAYA_OBLAST'],
];

export const REGIONS: readonly Region[] = TABLE.map(([ordinal, code, name]) => ({
  ordinal: ordinal as RegionOrdinal,
  subjectCode: code as SubjectCode,
  name,
}));

/** 98. The enum bound — `UnknownRegion` above this. */
export const REGION_COUNT = REGIONS.length;

const BY_SUBJECT_CODE: ReadonlyMap<string, Region> = new Map(
  REGIONS.map((entry) => [entry.subjectCode as string, entry]),
);

export class UnknownRegionError extends Error {
  constructor(what: string, received: unknown) {
    super(`${what}: received ${JSON.stringify(received) ?? String(received)}`);
    this.name = 'UnknownRegionError';
  }
}

/**
 * Accepts an **ordinal**. A caller holding a subject code must go through
 * {@link regionBySubjectCode}; there is no numeric conversion, because for 50 of
 * the 98 regions there is no numeric relationship to convert.
 */
export function regionOrdinal(value: number): RegionOrdinal {
  if (!Number.isSafeInteger(value) || value < 0 || value >= REGION_COUNT) {
    throw new InvalidPrimitiveError(
      `a region ordinal must be an integer in 0..${REGION_COUNT - 1}`,
      value,
    );
  }
  return value as RegionOrdinal;
}

export function subjectCode(value: string): SubjectCode {
  if (!BY_SUBJECT_CODE.has(value)) {
    throw new UnknownRegionError('not a federal subject code', value);
  }
  return value as SubjectCode;
}

export function regionByOrdinal(ordinal: RegionOrdinal): Region {
  return REGIONS[ordinal];
}

/**
 * The one supported route from a code to an ordinal, and therefore the only way
 * a region written on a form becomes a call argument.
 */
export function regionBySubjectCode(code: string): Region {
  const found = BY_SUBJECT_CODE.get(code);
  if (found === undefined) {
    throw new UnknownRegionError('not a federal subject code', code);
  }
  return found;
}

/** As `Regions.toString` renders it into an identifier. */
export function subjectCodeOf(ordinal: RegionOrdinal): SubjectCode {
  return REGIONS[ordinal].subjectCode;
}

/**
 * Whether this region's two numbers happen to coincide. Exists for tests and
 * diagnostics: a fixture keyed on a region where they agree — Chelyabinsk is
 * ordinal 74 *and* code "74" — cannot detect a code/ordinal confusion at all.
 */
export function ordinalMatchesSubjectCode(ordinal: RegionOrdinal): boolean {
  return String(ordinal).padStart(2, '0') === (REGIONS[ordinal].subjectCode as string);
}
