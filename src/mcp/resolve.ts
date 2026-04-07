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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchTier = 'exact' | 'nfc' | 'typographic';

export interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
}

export type ResolveResult =
  | { found: true; node: NodeRow; matchType: MatchTier }
  | { found: false; identifier: string; tried: MatchTier[]; candidates?: NodeRow[] };

// ---------------------------------------------------------------------------
// resolveById — three-tier resolution for node IDs (vault-relative paths)
// ---------------------------------------------------------------------------

export function resolveById(db: Database.Database, nodeId: string): ResolveResult {
  // Tier 1: exact SQL match
  const exact = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(nodeId) as NodeRow | undefined;
  if (exact) {
    return { found: true, node: exact, matchType: 'exact' };
  }

  // Tier 2: NFC-normalized match
  // First try direct SQL with NFC-normalized input
  const nfcInput = nodeId.normalize('NFC');
  const nfcDirect = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(nfcInput) as NodeRow | undefined;
  if (nfcDirect) {
    return { found: true, node: nfcDirect, matchType: 'nfc' };
  }

  // Load all node IDs for in-memory comparison
  const allNodes = db.prepare('SELECT id, file_path, title FROM nodes').all() as NodeRow[];

  // NFC case-insensitive comparison
  const nfcLower = nfcInput.toLowerCase();
  const nfcMatches = allNodes.filter(row => row.id.normalize('NFC').toLowerCase() === nfcLower);
  if (nfcMatches.length === 1) {
    return { found: true, node: nfcMatches[0], matchType: 'nfc' };
  }

  // Tier 3: typographic-normalized match
  const lookupNorm = normalizeForLookup(nodeId);
  const typoMatches = allNodes.filter(row => normalizeForLookup(row.id) === lookupNorm);
  if (typoMatches.length === 1) {
    return { found: true, node: typoMatches[0], matchType: 'typographic' };
  }

  return { found: false, identifier: nodeId, tried: ['exact', 'nfc', 'typographic'] };
}

// ---------------------------------------------------------------------------
// resolveByTitle — three-tier resolution for titles (case-insensitive)
// ---------------------------------------------------------------------------

export function resolveByTitle(db: Database.Database, title: string): ResolveResult {
  // Load all nodes with non-null titles
  const allNodes = db.prepare('SELECT id, file_path, title FROM nodes WHERE title IS NOT NULL').all() as NodeRow[];

  // Tier 1: exact case-insensitive match
  const titleLower = title.toLowerCase();
  const exactMatches = allNodes.filter(row => row.title!.toLowerCase() === titleLower);
  if (exactMatches.length === 1) {
    return { found: true, node: exactMatches[0], matchType: 'exact' };
  }
  if (exactMatches.length > 1) {
    // Ambiguous at tier 1
    return { found: false, identifier: title, tried: ['exact'], candidates: exactMatches };
  }

  // Tier 2: NFC-normalized case-insensitive match
  const nfcTitle = title.normalize('NFC').toLowerCase();
  const nfcMatches = allNodes.filter(row => row.title!.normalize('NFC').toLowerCase() === nfcTitle);
  if (nfcMatches.length === 1) {
    return { found: true, node: nfcMatches[0], matchType: 'nfc' };
  }
  if (nfcMatches.length > 1) {
    return { found: false, identifier: title, tried: ['exact', 'nfc'], candidates: nfcMatches };
  }

  // Tier 3: typographic-normalized match
  const lookupNorm = normalizeForLookup(title);
  const typoMatches = allNodes.filter(row => normalizeForLookup(row.title!) === lookupNorm);
  if (typoMatches.length === 1) {
    return { found: true, node: typoMatches[0], matchType: 'typographic' };
  }
  if (typoMatches.length > 1) {
    return { found: false, identifier: title, tried: ['exact', 'nfc', 'typographic'], candidates: typoMatches };
  }

  return { found: false, identifier: title, tried: ['exact', 'nfc', 'typographic'] };
}
