// Standard Code 128 bar/space widths, indexed by symbol value. Verified against
// @zxing/library's Code128Reader.CODE_PATTERNS (the scanner used by this app).
const patterns = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213",
  "122312", "132212", "221213", "221312", "231212", "112232", "122132",
  "122231", "113222", "123122", "123221", "223211", "221132", "221231",
  "213212", "223112", "312131", "311222", "321122", "321221", "312212",
  "322112", "322211", "212123", "212321", "232121", "111323", "131123",
  "131321", "112313", "132113", "132311", "211313", "231113", "231311",
  "112133", "112331", "132131", "113123", "113321", "133121", "313121",
  "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111",
  "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114",
  "413111", "241112", "134111", "111242", "121142", "121241", "114212",
  "124112", "124211", "411212", "421112", "421211", "212141", "214121",
  "412121", "111143", "111341", "131141", "114113", "114311", "411113",
  "411311", "113141", "114131", "311141", "411131", "211412", "211214",
  "211232", "2331112",
] as const;

export const CODE128_QUIET_ZONE_MODULES = 10;
const START_B = 104;
const STOP = 106;

export type Code128Run = Readonly<{
  isBar: boolean;
  modules: number;
}>;

export type Code128Encoding = Readonly<{
  payload: string;
  codewords: readonly number[];
  runs: readonly Code128Run[];
  totalModules: number;
}>;

/** Encode printable ASCII exactly as recorded using Code 128 character set B. */
export function encodeCode128(value: string): Code128Encoding {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Code 128 payload must be a non-empty string.");
  }
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error("Code 128 payload contains an unsupported character; only printable ASCII is supported.");
  }

  const data = [...value].map((character) => character.charCodeAt(0) - 32);
  const checksum = data.reduce(
    (sum, codeword, index) => (sum + codeword * ((index + 1) % 103)) % 103,
    START_B % 103,
  );
  const codewords = [START_B, ...data, checksum, STOP];
  const runs: Code128Run[] = [
    { isBar: false, modules: CODE128_QUIET_ZONE_MODULES },
  ];

  for (const codeword of codewords) {
    for (const [index, width] of [...patterns[codeword]].entries()) {
      runs.push({ isBar: index % 2 === 0, modules: Number(width) });
    }
  }
  runs.push({ isBar: false, modules: CODE128_QUIET_ZONE_MODULES });

  return {
    payload: value,
    codewords,
    runs,
    totalModules: runs.reduce((sum, run) => sum + run.modules, 0),
  };
}
