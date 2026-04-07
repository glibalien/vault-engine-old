import type Database from 'better-sqlite3';

/** Maps typographic Unicode characters to their ASCII equivalents. */
const TYPOGRAPHIC_MAP: Array<[RegExp, string]> = [
  [/[\u2018\u2019]/g, "'"],   // curly single quotes -> straight
  [/[\u201C\u201D]/g, '"'],   // curly double quotes -> straight
  [/\u2013/g, '-'],           // en-dash -> hyphen
  [/\u2014/g, '-'],           // em-dash -> hyphen
  [/\u2026/g, '...'],         // ellipsis -> three dots
  [/\u00A0/g, ' '],           // non-breaking space -> regular space
];

/** Replace typographic Unicode characters with ASCII equivalents. */
export function normalizeTypographic(str: string): string {
  let result = str;
  for (const [pattern, replacement] of TYPOGRAPHIC_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Full normalization pipeline: NFC -> typographic -> lowercase. */
export function normalizeForLookup(str: string): string {
  return normalizeTypographic(str.normalize('NFC')).toLowerCase();
}
