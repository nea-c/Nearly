import {
  uploadPartialSuffix,
  nativeErrorLiterals,
  nativeErrorTemplates,
} from "./translations-native-errors.js";

type Language = "ja" | "en";
const exact = { ja: new Map<string, string>(), en: new Map<string, string>() };
for (const [ja, en] of nativeErrorLiterals) {
  for (const language of ["ja", "en"] as const) {
    const output = language === "ja" ? ja : en;
    for (const input of [ja, en]) {
      const existing = exact[language].get(input);
      if (existing !== undefined && existing !== output)
        throw new Error("Conflicting native error translation");
      exact[language].set(input, output);
    }
  }
}
function compile(template: string): {
  pattern: RegExp;
  slots: number[];
  separators: string[];
} {
  const slots: number[] = [];
  const tokens = template.split(/(\{\d+\})/g);
  const separators = tokens.filter(
    (_part, index) => index > 0 && index < tokens.length - 1 && index % 2 === 0,
  );
  const parts = tokens.map((part) => {
    if (/^\{\d+\}$/.test(part)) {
      slots.push(Number(part.slice(1, -1)));
      return "([\\s\\S]*?)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp("^" + parts.join("") + "$"), slots, separators };
}
const patterns = nativeErrorTemplates.flatMap(([ja, en]) =>
  [ja, en].map((input) => ({ ...compile(input), ja, en })),
);

/** Translate only a whole application-owned message. Parameters, OS/library
 * details, paths, fingerprints and names are opaque, even if they look like UI.
 * Unknown messages are deliberately returned byte-for-byte unchanged. */
export function localizeNativeError(
  message: string,
  language: Language,
): string {
  for (const suffix of Object.values(uploadPartialSuffix)) {
    if(message.endsWith(suffix) && message.length > suffix.length && message.length <= 65536) {
      const inner=message.slice(0,-suffix.length);
      // Only this owned wrapper recursively localizes a complete owned inner error.
      if(!inner.includes(uploadPartialSuffix.en) && !inner.includes(uploadPartialSuffix.ja))
        return localizeNativeError(inner,language)+uploadPartialSuffix[language];
    }
  }
  const literal = exact[language].get(message);
  if (literal !== undefined) return literal;
  if (message.length > 65536) return message;
  for (const entry of patterns) {
    // Plain strings cannot distinguish a delimiter embedded inside a path from
    // the owned delimiter. Refuse ambiguous parsing rather than rewrite data.
    if (
      entry.separators.some(
        (separator) =>
          !separator ||
          message.indexOf(separator) !== message.lastIndexOf(separator),
      )
    )
      continue;
    const match = entry.pattern.exec(message);
    // `$` may match before a final newline; that is not a whole-message match.
    if (!match || match[0] !== message) continue;
    const values: string[] = [];
    entry.slots.forEach((slot, index) => {
      values[slot] = match[index + 1];
    });
    return entry[language].replace(
      /\{(\d+)\}/g,
      (_token, index: string) => values[Number(index)],
    );
  }
  return message;
}
