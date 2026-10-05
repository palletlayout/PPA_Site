const patterns = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
} as const;

type Code39Character = keyof typeof patterns;

export const CODE39_NARROW_MODULES = 1;
export const CODE39_WIDE_MODULES = 3;
export const CODE39_INTER_CHARACTER_GAP_MODULES = 1;
export const CODE39_QUIET_ZONE_MODULES = 10;

export type Code39Run = Readonly<{
  isBar: boolean;
  modules: number;
}>;

export type Code39Encoding = Readonly<{
  payload: string;
  framedValue: string;
  runs: readonly Code39Run[];
  totalModules: number;
}>;

function canonicalPayload(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Code 39 payload must be a non-empty string.");
  }

  // Unicode uppercasing can expand a character (e.g. ß → SS), changing the
  // identifier printed on the label. Only ASCII case conversion is lossless.
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error("Code 39 payload contains an unsupported character; only ASCII is supported.");
  }
  const payload = value.toUpperCase();
  for (const character of payload) {
    if (character === "*" || !(character in patterns)) {
      throw new Error(`Code 39 payload contains unsupported character ${JSON.stringify(character)}.`);
    }
  }
  return payload;
}

export function encodeCode39(value: string): Code39Encoding {
  const payload = canonicalPayload(value);
  const framedValue = `*${payload}*`;
  const runs: Code39Run[] = [
    { isBar: false, modules: CODE39_QUIET_ZONE_MODULES },
  ];

  for (const [characterIndex, character] of [...framedValue].entries()) {
    const pattern = patterns[character as Code39Character];
    for (const [elementIndex, width] of [...pattern].entries()) {
      runs.push({
        isBar: elementIndex % 2 === 0,
        modules: width === "w" ? CODE39_WIDE_MODULES : CODE39_NARROW_MODULES,
      });
    }

    if (characterIndex < framedValue.length - 1) {
      runs.push({ isBar: false, modules: CODE39_INTER_CHARACTER_GAP_MODULES });
    }
  }

  runs.push({ isBar: false, modules: CODE39_QUIET_ZONE_MODULES });

  return {
    payload,
    framedValue,
    runs,
    totalModules: runs.reduce((sum, run) => sum + run.modules, 0),
  };
}

export function code39Runs(value: string): readonly Code39Run[] {
  return encodeCode39(value).runs;
}

export function code39TotalModules(value: string): number {
  return encodeCode39(value).totalModules;
}
