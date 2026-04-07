# Unicode and API Consistency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three related bugs where the query surface and write surface have divergent resolution logic — nodes that are findable should always be writable.

**Architecture:** New `src/mcp/resolve.ts` module provides three-tier Unicode normalization (exact → NFC → typographic) for all MCP tool handlers. New `src/sync/reconciler.ts` provides periodic drift detection. Schema changes rename `updated_at` to `file_mtime` and add `indexed_at` to the `nodes` table.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest, chokidar (existing)

---

### Task 1: Normalization Utilities (`src/mcp/resolve.ts` — types and helpers)

**Files:**
- Create: `src/mcp/resolve.ts`
- Create: `tests/mcp/resolve.test.ts`

- [ ] **Step 1: Write tests for `normalizeTypographic`**

```typescript
// tests/mcp/resolve.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeTypographic, normalizeForLookup } from '../../src/mcp/resolve.js';

describe('normalizeTypographic', () => {
  it('maps curly single quotes to straight', () => {
    expect(normalizeTypographic('\u2018hello\u2019')).toBe("'hello'");
  });

  it('maps curly double quotes to straight', () => {
    expect(normalizeTypographic('\u201Chello\u201D')).toBe('"hello"');
  });

  it('maps en-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2013B')).toBe('A-B');
  });

  it('maps em-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2014B')).toBe('A-B');
  });

  it('maps ellipsis to three dots', () => {
    expect(normalizeTypographic('wait\u2026')).toBe('wait...');
  });

  it('maps non-breaking space to regular space', () => {
    expect(normalizeTypographic('hello\u00A0world')).toBe('hello world');
  });

  it('returns unchanged string when no typographic chars present', () => {
    expect(normalizeTypographic('hello world')).toBe('hello world');
  });

  it('handles multiple replacements in one string', () => {
    expect(normalizeTypographic('It\u2019s \u201Cfine\u201D \u2014 really\u2026'))
      .toBe("It's \"fine\" - really...");
  });
});

describe('normalizeForLookup', () => {
  it('applies NFC then typographic normalization then lowercases', () => {
    // NFC: e + combining accent → é
    const decomposed = 'caf\u0065\u0301';
    const result = normalizeForLookup(decomposed);
    expect(result).toBe('café');
  });

  it('applies typographic normalization and lowercases', () => {
    expect(normalizeForLookup('It\u2019s FINE')).toBe("it's fine");
  });

  it('handles combined NFC + typographic', () => {
    const input = 'Caf\u0065\u0301 \u2014 It\u2019s';
    expect(normalizeForLookup(input)).toBe("café - it's");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement normalization utilities**

```typescript
// src/mcp/resolve.ts
import type Database from 'better-sqlite3';

/** Maps typographic Unicode characters to their ASCII equivalents. */
const TYPOGRAPHIC_MAP: Array<[RegExp, string]> = [
  [/[\u2018\u2019]/g, "'"],   // curly single quotes → straight
  [/[\u201C\u201D]/g, '"'],   // curly double quotes → straight
  [/\u2013/g, '-'],           // en-dash → hyphen
  [/\u2014/g, '-'],           // em-dash → hyphen
  [/\u2026/g, '...'],         // ellipsis → three dots
  [/\u00A0/g, ' '],           // non-breaking space → regular space
];

/** Replace typographic Unicode characters with ASCII equivalents. */
export function normalizeTypographic(str: string): string {
  let result = str;
  for (const [pattern, replacement] of TYPOGRAPHIC_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Full normalization pipeline: NFC → typographic → lowercase. */
export function normalizeForLookup(str: string): string {
  return normalizeTypographic(str.normalize('NFC')).toLowerCase();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/resolve.ts tests/mcp/resolve.test.ts
git commit -m "feat(resolve): add normalizeTypographic and normalizeForLookup utilities"
```

---

### Task 2: `resolveById` and `resolveByTitle` (`src/mcp/resolve.ts`)

**Files:**
- Modify: `src/mcp/resolve.ts`
- Modify: `tests/mcp/resolve.test.ts`

- [ ] **Step 1: Write tests for `resolveById`**

Append to `tests/mcp/resolve.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveById, resolveByTitle } from '../../src/mcp/resolve.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('resolveById', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns exact match on tier 1', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveById(db, 'tasks/review.md');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('tasks/review.md');
      expect(result.matchType).toBe('exact');
    }
  });

  it('returns NFC match on tier 2', () => {
    // Index with composed form (NFC)
    const raw = '---\ntitle: "Caf\u00E9 Notes"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('caf\u00E9.md', raw);
    indexFile(db, parsed, 'caf\u00E9.md', '2025-03-10T00:00:00.000Z', raw);

    // Look up with decomposed form (NFD)
    const result = resolveById(db, 'caf\u0065\u0301.md');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('caf\u00E9.md');
      expect(result.matchType).toBe('nfc');
    }
  });

  it('returns typographic match on tier 3', () => {
    // Index with curly apostrophe
    const raw = '---\ntitle: "It\u2019s a Test"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('It\u2019s a Test.md', raw);
    indexFile(db, parsed, 'It\u2019s a Test.md', '2025-03-10T00:00:00.000Z', raw);

    // Look up with straight apostrophe
    const result = resolveById(db, "It's a Test.md");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('It\u2019s a Test.md');
      expect(result.matchType).toBe('typographic');
    }
  });

  it('returns found: false with tried array when no match', () => {
    const result = resolveById(db, 'nonexistent.md');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.identifier).toBe('nonexistent.md');
      expect(result.tried).toEqual(['exact', 'nfc', 'typographic']);
    }
  });
});
```

- [ ] **Step 2: Write tests for `resolveByTitle`**

Append to `tests/mcp/resolve.test.ts`:

```typescript
import { beforeEach, afterEach } from 'vitest';

describe('resolveByTitle', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns exact match on tier 1 (case-insensitive)', () => {
    const raw = '---\ntitle: "Review PR"\ntypes: [task]\n---\nContent';
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveByTitle(db, 'review pr');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('tasks/review.md');
      expect(result.matchType).toBe('exact');
    }
  });

  it('matches curly apostrophe title with straight apostrophe query (tier 3)', () => {
    const raw = '---\ntitle: "It\u2019s Complex"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/complex.md', raw);
    indexFile(db, parsed, 'notes/complex.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveByTitle(db, "It's Complex");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('notes/complex.md');
      expect(result.matchType).toBe('typographic');
    }
  });

  it('matches straight apostrophe title with curly apostrophe query (tier 3)', () => {
    const raw = "---\ntitle: \"It's Simple\"\ntypes: [note]\n---\nContent";
    const parsed = parseFile('notes/simple.md', raw);
    indexFile(db, parsed, 'notes/simple.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveByTitle(db, 'It\u2019s Simple');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('notes/simple.md');
      expect(result.matchType).toBe('typographic');
    }
  });

  it('matches em-dash title with hyphen query (tier 3)', () => {
    const raw = '---\ntitle: "A\u2014B"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/ab.md', raw);
    indexFile(db, parsed, 'notes/ab.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveByTitle(db, 'A-B');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('typographic');
    }
  });

  it('returns found: false for nonexistent title', () => {
    const result = resolveByTitle(db, 'Nonexistent');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.tried).toEqual(['exact', 'nfc', 'typographic']);
    }
  });

  it('returns found: false when multiple titles match (ambiguous)', () => {
    const raw1 = '---\ntitle: "Notes"\ntypes: [note]\n---\nContent 1';
    const parsed1 = parseFile('a/notes.md', raw1);
    indexFile(db, parsed1, 'a/notes.md', '2025-03-10T00:00:00.000Z', raw1);

    const raw2 = '---\ntitle: "Notes"\ntypes: [note]\n---\nContent 2';
    const parsed2 = parseFile('b/notes.md', raw2);
    indexFile(db, parsed2, 'b/notes.md', '2025-03-10T00:00:00.000Z', raw2);

    const result = resolveByTitle(db, 'Notes');
    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/resolve.test.ts`
Expected: FAIL — `resolveById` and `resolveByTitle` not exported

- [ ] **Step 4: Implement `resolveById` and `resolveByTitle`**

Add to `src/mcp/resolve.ts`:

```typescript
export type MatchTier = 'exact' | 'nfc' | 'typographic';

export interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
}

export type ResolveResult =
  | { found: true; node: NodeRow; matchType: MatchTier }
  | { found: false; identifier: string; tried: MatchTier[] };

/**
 * Resolve a node by its ID (vault-relative path) using three-tier normalization.
 * Tier 1: exact match. Tier 2: NFC-normalized. Tier 3: typographic-normalized.
 */
export function resolveById(db: Database.Database, nodeId: string): ResolveResult {
  // Tier 1: exact match
  const exact = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
    .get(nodeId) as NodeRow | undefined;
  if (exact) return { found: true, node: exact, matchType: 'exact' };

  // Tier 2: NFC-normalized
  const nfcInput = nodeId.normalize('NFC');
  if (nfcInput !== nodeId) {
    const nfcMatch = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
      .get(nfcInput) as NodeRow | undefined;
    if (nfcMatch) return { found: true, node: nfcMatch, matchType: 'nfc' };
  }

  // Tier 2/3 fallback: load all IDs and compare normalized
  const allRows = db.prepare('SELECT id, file_path, title FROM nodes').all() as NodeRow[];
  const normalizedInput = normalizeForLookup(nodeId);

  // Try NFC-only comparison first (tier 2)
  const nfcLowerInput = nfcInput.toLowerCase();
  for (const row of allRows) {
    if (row.id.normalize('NFC').toLowerCase() === nfcLowerInput) {
      return { found: true, node: row, matchType: 'nfc' };
    }
  }

  // Try full typographic normalization (tier 3)
  for (const row of allRows) {
    if (normalizeForLookup(row.id) === normalizedInput) {
      return { found: true, node: row, matchType: 'typographic' };
    }
  }

  return { found: false, identifier: nodeId, tried: ['exact', 'nfc', 'typographic'] };
}

/**
 * Resolve a node by its title using three-tier normalization.
 * All comparisons are case-insensitive. Returns found: false if ambiguous (multiple matches).
 */
export function resolveByTitle(db: Database.Database, title: string): ResolveResult {
  const allRows = db.prepare('SELECT id, file_path, title FROM nodes WHERE title IS NOT NULL')
    .all() as NodeRow[];

  // Tier 1: exact match (case-insensitive)
  const exactInput = title.toLowerCase();
  const exactMatches = allRows.filter(r => r.title!.toLowerCase() === exactInput);
  if (exactMatches.length === 1) return { found: true, node: exactMatches[0], matchType: 'exact' };
  if (exactMatches.length > 1) return { found: false, identifier: title, tried: ['exact'] };

  // Tier 2: NFC-normalized match
  const nfcInput = title.normalize('NFC').toLowerCase();
  const nfcMatches = allRows.filter(r => r.title!.normalize('NFC').toLowerCase() === nfcInput);
  if (nfcMatches.length === 1) return { found: true, node: nfcMatches[0], matchType: 'nfc' };
  if (nfcMatches.length > 1) return { found: false, identifier: title, tried: ['exact', 'nfc'] };

  // Tier 3: typographic-normalized match
  const typoInput = normalizeForLookup(title);
  const typoMatches = allRows.filter(r => normalizeForLookup(r.title!) === typoInput);
  if (typoMatches.length === 1) return { found: true, node: typoMatches[0], matchType: 'typographic' };

  const tried: MatchTier[] = ['exact', 'nfc', 'typographic'];
  return { found: false, identifier: title, tried };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/resolve.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/resolve.ts tests/mcp/resolve.test.ts
git commit -m "feat(resolve): add resolveById and resolveByTitle with three-tier normalization"
```

---

### Task 3: Integrate `resolveById` into Tool Handlers

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/graph/traversal.ts`

This task replaces all direct `SELECT * FROM nodes WHERE id = ?` lookups in tool handlers with `resolveById`. There are 9 locations to update. Each follows the same pattern — replace the inline SQL with a `resolveById` call, handle `found: false`, and use `result.node.id` (the canonical ID) for downstream operations.

- [ ] **Step 1: Add import to server.ts**

At the top of `src/mcp/server.ts`, add:

```typescript
import { resolveById, resolveByTitle } from './resolve.js';
import type { ResolveResult, MatchTier } from './resolve.js';
```

- [ ] **Step 2: Update `loadNodeForValidation` (line 122-123)**

Replace:

```typescript
  function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined;
    if (!node) return null;
```

With:

```typescript
  function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
    const resolved = resolveById(db, nodeId);
    if (!resolved.found) return null;
    const resolvedNodeId = resolved.node.id;
```

Then replace all remaining `nodeId` references inside `loadNodeForValidation` with `resolvedNodeId` (the `SELECT` queries for `node_types` and `fields` at lines 126-133 use `nodeId` — change to `resolvedNodeId`).

- [ ] **Step 3: Update `updateNodeInner` (line 335)**

Replace:

```typescript
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
```

With:

```typescript
    const resolved = resolveById(db, node_id);
    if (!resolved.found) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
    const canonicalId = resolved.node.id;
```

Then replace downstream uses of `node_id` for DB/file operations with `canonicalId`: the `join(vaultPath, node_id)` at line 341, the `parseFile(node_id, raw)` call, the `indexFile` call, and the write lock operations.

- [ ] **Step 4: Update `addRelationshipInner` (line 530)**

Replace:

```typescript
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }
```

With:

```typescript
    const resolved = resolveById(db, source_id);
    if (!resolved.found) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }
    const canonicalSourceId = resolved.node.id;
```

Then replace downstream `source_id` uses for DB/file operations with `canonicalSourceId`.

- [ ] **Step 5: Update `removeRelationshipInner` (line 661)**

Same pattern as step 4:

Replace:

```typescript
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }
```

With:

```typescript
    const resolved = resolveById(db, source_id);
    if (!resolved.found) {
      return toolError(`Node not found: ${source_id}`, 'NOT_FOUND');
    }
    const canonicalSourceId = resolved.node.id;
```

Then replace downstream `source_id` uses for DB/file operations with `canonicalSourceId`.

- [ ] **Step 6: Update `deleteNodeInner` (line 781)**

Replace:

```typescript
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
```

With:

```typescript
    const resolved = resolveById(db, node_id);
    if (!resolved.found) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
    const canonicalId = resolved.node.id;
```

Then replace downstream `node_id` uses for DB/file operations with `canonicalId`.

- [ ] **Step 7: Update `renameNode` (line 955)**

Replace:

```typescript
    const nodeRow = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node_id) as
      | { id: string; title: string }
      | undefined;
    if (!nodeRow) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
```

With:

```typescript
    const resolved = resolveById(db, node_id);
    if (!resolved.found) {
      return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
    }
    const canonicalId = resolved.node.id;
    const nodeRow = { id: canonicalId, title: resolved.node.title ?? '' };
```

Then replace downstream `node_id` uses for DB/file operations with `canonicalId`.

- [ ] **Step 8: Update `traverse-graph` handler (line 1801)**

The `traverse-graph` handler passes `node_id` to `traverseGraph()` in `src/graph/traversal.ts`, which does its own `SELECT id FROM nodes WHERE id = ?` at line 91. Add `resolveById` to `traverseGraph`:

In `src/graph/traversal.ts`, add import:

```typescript
import { resolveById } from '../mcp/resolve.js';
```

Replace (line 91-93):

```typescript
  const rootRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id) as { id: string } | undefined;
  if (!rootRow) {
    throw new Error(`Node not found: ${node_id}`);
```

With:

```typescript
  const resolved = resolveById(db, node_id);
  if (!resolved.found) {
    throw new Error(`Node not found: ${node_id}`);
```

Then replace uses of `node_id` below the resolution with `resolved.node.id` — specifically the `visited` set initialization (line 97), `depthMap` initialization (line 98), `currentLevel` initialization (line 101), and the `root_id` in the return value. The `node_ids` filter at line 138 also uses `node_id`.

- [ ] **Step 9: Update `read-embedded` handler (line 2154)**

Replace:

```typescript
      const nodeRow = db.prepare('SELECT id, file_path FROM nodes WHERE id = ?').get(node_id) as
        | { id: string; file_path: string }
        | undefined;
      if (!nodeRow) {
        return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
      }
```

With:

```typescript
      const resolved = resolveById(db, node_id);
      if (!resolved.found) {
        return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
      }
      const nodeRow = resolved.node;
```

- [ ] **Step 10: Run all tests**

Run: `npm test`
Expected: PASS (all existing tests should still pass since exact matches are tier 1)

- [ ] **Step 11: Commit**

```bash
git add src/mcp/server.ts src/graph/traversal.ts
git commit -m "refactor(mcp): replace inline node ID lookups with resolveById"
```

---

### Task 4: Integrate `resolveByTitle` and Update `get-node` / `summarize-node`

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Update `get-node` handler title resolution (lines 1168-1186)**

Replace:

```typescript
      let resolvedId = node_id;
      if (!resolvedId) {
        if (!title) {
          return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
        }
        const { titleMap, pathMap } = buildLookupMaps(db);
        const resolved = resolveTargetWithMaps(title, titleMap, pathMap);
        if (!resolved) {
          // Distinguish not found vs ambiguous
          const candidates = titleMap.get(title.toLowerCase());
          if (candidates && candidates.length > 1) {
            return toolError(
              `Multiple nodes match title '${title}': ${candidates.join(', ')}`,
              'VALIDATION_ERROR',
            );
          }
          return toolError(`No node found with title '${title}'`, 'NOT_FOUND');
        }
        resolvedId = resolved;
      }

      if (hasPathTraversal(resolvedId)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }
      const row = db.prepare(`
        SELECT id, file_path, node_type, title, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(resolvedId) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return toolError(`Node not found: ${resolvedId}`, 'NOT_FOUND');
      }
```

With:

```typescript
      if (!node_id && !title) {
        return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
      }

      const resolved = node_id ? resolveById(db, node_id) : resolveByTitle(db, title!);
      if (!resolved.found) {
        const label = node_id ? `Node not found: ${node_id}` : `No node found with title '${title}'`;
        return toolError(label, 'NOT_FOUND');
      }
      const resolvedId = resolved.node.id;

      if (hasPathTraversal(resolvedId)) {
        return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
      }

      const row = db.prepare(`
        SELECT id, file_path, node_type, title, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(resolvedId) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return toolError(`Node not found: ${resolvedId}`, 'NOT_FOUND');
      }
```

- [ ] **Step 2: Update `summarize-node` handler title resolution (lines 1990-2008)**

Apply the same pattern as step 1. Replace the `buildLookupMaps` + `resolveTargetWithMaps` block:

```typescript
      if (!node_id && !title) {
        return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
      }

      const resolved = node_id ? resolveById(db, node_id) : resolveByTitle(db, title!);
      if (!resolved.found) {
        const label = node_id ? `Node not found: ${node_id}` : `No node found with title '${title}'`;
        return toolError(label, 'NOT_FOUND');
      }
      const resolvedId = resolved.node.id;

      if (hasPathTraversal(resolvedId)) {
        return toolError('Invalid node_id: path traversal not allowed', 'VALIDATION_ERROR');
      }
```

- [ ] **Step 3: Remove unused `buildLookupMaps` / `resolveTargetWithMaps` imports from server.ts if they are no longer used there**

Check if `buildLookupMaps` and `resolveTargetWithMaps` are still used elsewhere in `server.ts` (e.g., `add-relationship` target lookup, `query-nodes` references filter). If they are, keep the imports. If they're only used by the two handlers just updated, remove them.

Note: `buildLookupMaps` is imported from `../sync/resolver.js` and is likely still used by the `query-nodes` references filter (line ~1273) for resolving the `references.target` param. Keep the import if so.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): use resolveByTitle for get-node and summarize-node title lookups"
```

---

### Task 5: Apply Normalization to Wiki-Link Resolution (`src/sync/resolver.ts`)

**Files:**
- Modify: `src/sync/resolver.ts`
- Modify: `tests/sync/resolver.test.ts`

- [ ] **Step 1: Write tests for normalized wiki-link resolution**

Append to `tests/sync/resolver.test.ts`:

```typescript
describe('Unicode-normalized resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolves straight apostrophe wiki-link to curly apostrophe filename', () => {
    const raw = '---\ntitle: "Alice\u2019s Notes"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('Alice\u2019s Notes.md', raw);
    indexFile(db, parsed, 'Alice\u2019s Notes.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveTarget(db, "Alice's Notes");
    expect(result).toBe('Alice\u2019s Notes.md');
  });

  it('resolves curly apostrophe wiki-link to straight apostrophe filename', () => {
    const raw = "---\ntitle: \"Alice's Notes\"\ntypes: [note]\n---\nContent";
    const parsed = parseFile("Alice's Notes.md", raw);
    indexFile(db, parsed, "Alice's Notes.md", '2025-03-10T00:00:00.000Z', raw);

    const result = resolveTarget(db, 'Alice\u2019s Notes');
    expect(result).toBe("Alice's Notes.md");
  });

  it('resolves NFC-decomposed wiki-link to NFC-composed filename', () => {
    const raw = '---\ntitle: "Caf\u00E9"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('Caf\u00E9.md', raw);
    indexFile(db, parsed, 'Caf\u00E9.md', '2025-03-10T00:00:00.000Z', raw);

    // Decomposed é
    const result = resolveTarget(db, 'Caf\u0065\u0301');
    expect(result).toBe('Caf\u00E9.md');
  });

  it('resolves em-dash wiki-link to hyphen filename', () => {
    const raw = '---\ntitle: "A-B"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('A-B.md', raw);
    indexFile(db, parsed, 'A-B.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveTarget(db, 'A\u2014B');
    expect(result).toBe('A-B.md');
  });

  it('still resolves exact matches normally', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const result = resolveTarget(db, 'Review vendor proposals');
    expect(result).toBe('tasks/review.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL on the new Unicode tests (straight→curly, curly→straight, NFC, em-dash)

- [ ] **Step 3: Update `buildLookupMaps` to use normalized keys**

In `src/sync/resolver.ts`, add import and modify `buildLookupMaps`:

```typescript
import { normalizeForLookup } from '../mcp/resolve.js';
```

Change the title map key generation (line 19):

```typescript
    if (row.title) {
      const key = normalizeForLookup(row.title);
      const existing = titleMap.get(key);
      if (existing) existing.push(row.id);
      else titleMap.set(key, [row.id]);
    }
```

Change the path map key generation (line 30):

```typescript
      const suffix = normalizeForLookup(parts.slice(i).join('/'));
      const existing = pathMap.get(suffix);
      if (existing) existing.push(row.id);
      else pathMap.set(suffix, [row.id]);
```

- [ ] **Step 4: Update `resolveTargetWithMaps` to normalize the incoming target**

Change line 84:

```typescript
  const target = normalizeForLookup(wikiLinkTarget);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/sync/resolver.ts tests/sync/resolver.test.ts
git commit -m "feat(resolver): apply NFC + typographic normalization to wiki-link resolution"
```

---

### Task 6: Schema Changes — `file_mtime` and `indexed_at`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/sync/indexer.ts`
- Modify: `src/mcp/server.ts` (all `updated_at` references)
- Modify: `src/mcp/query-builder.ts`
- Modify: `tests/sync/resolver.test.ts` (schema column tests)

- [ ] **Step 1: Update DDL in `src/db/schema.ts`**

Replace the `nodes` table DDL (lines 5-20):

```sql
    CREATE TABLE IF NOT EXISTS nodes (
      id              TEXT PRIMARY KEY,
      file_path       TEXT NOT NULL,
      node_type       TEXT NOT NULL,
      parent_id       TEXT,
      position_start  INTEGER,
      position_end    INTEGER,
      depth           INTEGER DEFAULT 0,
      content_text    TEXT,
      content_md      TEXT,
      title           TEXT,
      is_valid        INTEGER,
      created_at      TEXT DEFAULT (datetime('now')),
      file_mtime      TEXT,
      indexed_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES nodes(id)
    );
```

- [ ] **Step 2: Update `indexFile` in `src/sync/indexer.ts` (lines 78-81)**

Replace:

```typescript
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, title, depth, is_valid)
    VALUES (?, ?, 'file', ?, ?, ?, 0, ?)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd, deriveTitle(parsed, relativePath), isValid);
```

With:

```typescript
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, title, depth, is_valid, file_mtime, indexed_at)
    VALUES (?, ?, 'file', ?, ?, ?, 0, ?, ?, datetime('now'))
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd, deriveTitle(parsed, relativePath), isValid, mtime);
```

- [ ] **Step 3: Update `hydrateNodes` type and SELECT queries in `src/mcp/server.ts`**

The `hydrateNodes` function's type parameter references `updated_at: string`. Change to `indexed_at: string` throughout. This affects:

1. The `hydrateNodes` function signature (line 74): change `updated_at: string` to `indexed_at: string`
2. The return mapping (line 113): change `updated_at: row.updated_at` to `indexed_at: row.indexed_at`
3. Every `SELECT ... updated_at FROM nodes` query throughout `server.ts` — change `updated_at` to `indexed_at` in the SELECT column list and the `as` type annotations. There are approximately 12 occurrences (lines 290, 294, 479, 483, 507, 511, 1090, 1094, 1192, 1194, 1295, 1816-1817, 1824, 1829, 2016, 2018).

Use find-and-replace:
- Replace `content_md, updated_at` with `content_md, indexed_at` in SELECT statements
- Replace `updated_at: string` with `indexed_at: string` in type annotations
- Replace `updated_at: row.updated_at` with `indexed_at: row.indexed_at` in object mappings

- [ ] **Step 4: Update `query-builder.ts` `since` filter (lines 18-19, 152-154)**

Change the `since` comment and query:

```typescript
  /** Filter by indexed_at > since (ISO datetime string) */
  since?: string;
```

And the filter itself:

```typescript
  // Since filter (indexed_at = when engine last indexed the node)
  if (opts.since) {
    conditions.push('n.indexed_at > ?');
    conditionParams.push(opts.since);
  }
```

- [ ] **Step 5: Add `modified_since` to `QueryOptions` and `buildQuerySql`**

In `src/mcp/query-builder.ts`, add to `QueryOptions`:

```typescript
  /** Filter by file_mtime > modified_since (ISO datetime string) */
  modified_since?: string;
```

Add after the `since` filter block:

```typescript
  // Modified-since filter (file_mtime = when the file was last modified on disk)
  if (opts.modified_since) {
    conditions.push('n.file_mtime > ?');
    conditionParams.push(opts.modified_since);
  }
```

- [ ] **Step 6: Add `modified_since` Zod param to `query-nodes` tool in `server.ts`**

Find the `since` Zod definition (line ~1259) and add after it:

```typescript
      modified_since: z.string().min(1).optional()
        .describe('ISO date — only return nodes whose underlying file was modified after this time, e.g. "2026-03-27T00:00:00Z". Unlike since (which tracks when the engine indexed the node), this tracks when the file was last touched on disk.'),
```

Update the `since` description:

```typescript
      since: z.string().min(1).optional()
        .describe('ISO date — only return nodes the engine indexed after this time. Use this to find what\'s new since your last check, e.g. "2026-03-27T00:00:00Z"'),
```

Pass `modified_since` through to `buildQuerySql` in the handler.

- [ ] **Step 7: Update `order_by` default description**

The `order_by` param description currently says `"updated_at DESC"` — update to `"indexed_at DESC"`. Also update the `buildQuerySql` default order_by logic if it references `updated_at`.

Check `query-builder.ts` for the default order_by value and update it:

```typescript
  // Default order
  const defaultOrder = opts.full_text ? 'rank' : 'n.indexed_at DESC';
```

- [ ] **Step 8: Update existing tests that reference `updated_at`**

In `tests/sync/resolver.test.ts`, update the column check test if it checks for `updated_at`:

Search for `updated_at` across test files. Any test that checks for `updated_at` in node data should be updated to check for `indexed_at`.

- [ ] **Step 9: Run full test suite**

Run: `npm test`
Expected: PASS (schema is rebuildable, in-memory tests get new DDL)

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/sync/indexer.ts src/mcp/server.ts src/mcp/query-builder.ts
git commit -m "feat(schema): rename updated_at to file_mtime, add indexed_at column

since filter now queries indexed_at (when engine learned about the node).
New modified_since param queries file_mtime (when file was last touched on disk)."
```

---

### Task 7: Reconciliation Pass (`src/sync/reconciler.ts`)

**Files:**
- Create: `src/sync/reconciler.ts`
- Create: `tests/sync/reconciler.test.ts`
- Modify: `src/sync/index.ts` (re-exports)
- Modify: `src/index.ts` (startup integration)

- [ ] **Step 1: Write tests for `reconcileOnce`**

```typescript
// tests/sync/reconciler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { incrementalIndex } from '../../src/sync/indexer.js';
import { reconcileOnce, startReconciler } from '../../src/sync/reconciler.js';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function createTempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reconciler-test-'));
  return dir;
}

describe('reconcileOnce', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = createTempVault();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('detects and indexes a new file written directly to disk', () => {
    // Write a file directly (bypassing engine write tools)
    writeFileSync(
      join(vaultPath, 'new-note.md'),
      '---\ntitle: "New Note"\ntypes: [note]\n---\nSome content',
    );

    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);

    // Verify the node is now queryable
    const node = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get('new-note.md') as any;
    expect(node).toBeDefined();
    expect(node.title).toBe('New Note');
  });

  it('detects and removes a deleted file', () => {
    // Index a file first
    writeFileSync(
      join(vaultPath, 'to-delete.md'),
      '---\ntitle: "Delete Me"\ntypes: [note]\n---\nContent',
    );
    reconcileOnce(db, vaultPath);

    // Delete the file from disk
    unlinkSync(join(vaultPath, 'to-delete.md'));

    const result = reconcileOnce(db, vaultPath);
    expect(result.deleted).toBe(1);

    // Verify the node is gone
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('to-delete.md');
    expect(node).toBeUndefined();
  });

  it('skips files that have not changed', () => {
    writeFileSync(
      join(vaultPath, 'stable.md'),
      '---\ntitle: "Stable"\ntypes: [note]\n---\nContent',
    );
    reconcileOnce(db, vaultPath);

    // Run again — nothing changed
    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('handles files in subdirectories', () => {
    mkdirSync(join(vaultPath, 'notes'), { recursive: true });
    writeFileSync(
      join(vaultPath, 'notes', 'deep.md'),
      '---\ntitle: "Deep Note"\ntypes: [note]\n---\nContent',
    );

    const result = reconcileOnce(db, vaultPath);
    expect(result.indexed).toBe(1);

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('notes/deep.md');
    expect(node).toBeDefined();
  });
});
```

- [ ] **Step 2: Write tests for `startReconciler` timer wiring**

Append to `tests/sync/reconciler.test.ts`:

```typescript
describe('startReconciler', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = createTempVault();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('periodically detects new files via timer', async () => {
    const handle = startReconciler(db, vaultPath, { intervalMs: 100, firstTickMs: 20 });

    try {
      // Write a file after starting the reconciler
      writeFileSync(
        join(vaultPath, 'timed.md'),
        '---\ntitle: "Timed"\ntypes: [note]\n---\nContent',
      );

      // Wait for the first tick to fire
      await new Promise(resolve => setTimeout(resolve, 80));

      const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('timed.md');
      expect(node).toBeDefined();
    } finally {
      handle.close();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/sync/reconciler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `reconcileOnce` and `startReconciler`**

```typescript
// src/sync/reconciler.ts
import type Database from 'better-sqlite3';
import { incrementalIndex } from './indexer.js';

export interface ReconcileResult {
  indexed: number;
  skipped: number;
  deleted: number;
}

/**
 * Single-shot reconciliation pass. Calls incrementalIndex to detect
 * files that drifted from the DB state (new, modified, or deleted).
 */
export function reconcileOnce(db: Database.Database, vaultPath: string): ReconcileResult {
  const result = incrementalIndex(db, vaultPath);
  return {
    indexed: result.indexed,
    skipped: result.skipped,
    deleted: result.deleted,
  };
}

export interface ReconcilerOptions {
  /** Interval between reconciliation ticks in ms. Default: 300000 (5 minutes). */
  intervalMs?: number;
  /** Delay before the first tick in ms. Default: 30000 (30 seconds). */
  firstTickMs?: number;
}

/**
 * Start a periodic reconciliation pass that catches dropped watcher events.
 * First tick fires after firstTickMs, then every intervalMs after that.
 */
export function startReconciler(
  db: Database.Database,
  vaultPath: string,
  opts?: ReconcilerOptions,
): { close(): void } {
  const intervalMs = opts?.intervalMs ?? 300_000;
  const firstTickMs = opts?.firstTickMs ?? 30_000;

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const tick = () => {
    if (closed) return;
    try {
      const result = reconcileOnce(db, vaultPath);
      if (result.indexed > 0 || result.deleted > 0) {
        console.error(`[vault-engine] reconciler: indexed ${result.indexed}, deleted ${result.deleted}`);
      }
    } catch (err) {
      console.error('[vault-engine] reconciler error:', err);
    }
  };

  // First tick fires early, then switch to regular interval
  const firstTimer = setTimeout(() => {
    if (closed) return;
    tick();
    intervalTimer = setInterval(tick, intervalMs);
  }, firstTickMs);

  return {
    close() {
      closed = true;
      clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sync/reconciler.test.ts`
Expected: PASS

- [ ] **Step 6: Add re-export to `src/sync/index.ts`**

Add to the existing re-exports in `src/sync/index.ts`:

```typescript
export { reconcileOnce, startReconciler } from './reconciler.js';
```

- [ ] **Step 7: Integrate into entry point `src/index.ts`**

Add import:

```typescript
import { startReconciler } from './sync/index.js';
```

After the watcher startup (line ~94), add:

```typescript
// Start periodic reconciler as safety net for dropped watcher events
const reconciler = startReconciler(db, vaultPath);
console.error('[vault-engine] reconciler started (first tick in 30s, then every 5m)');
```

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/sync/reconciler.ts src/sync/index.ts src/index.ts tests/sync/reconciler.test.ts
git commit -m "feat(sync): add periodic reconciliation pass for dropped watcher events

reconcileOnce runs incrementalIndex on demand. startReconciler runs it
on a timer (30s first tick, 5m interval) as a safety net alongside the
file watcher."
```

---

### Task 8: Integration Tests — Unicode Round-Trip

**Files:**
- Create: `tests/mcp/unicode-resolution.test.ts`

This task adds end-to-end tests that exercise the full MCP tool round-trip with typographic characters.

- [ ] **Step 1: Write MCP-level integration tests**

```typescript
// tests/mcp/unicode-resolution.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function parseResult(result: Awaited<ReturnType<typeof callTool>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe('Unicode resolution integration', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = mkdtempSync(join(tmpdir(), 'unicode-test-'));

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it('get-node resolves curly apostrophe ID with straight apostrophe', async () => {
    const raw = '---\ntitle: "It\u2019s a Test"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('It\u2019s a Test.md', raw);
    indexFile(db, parsed, 'It\u2019s a Test.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: "It's a Test.md" });
    const data = parseResult(result);
    expect(data.id).toBe('It\u2019s a Test.md');
    expect(data.title).toBe('It\u2019s a Test');
  });

  it('get-node resolves curly apostrophe title with straight apostrophe query', async () => {
    const raw = '---\ntitle: "It\u2019s Complex"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/complex.md', raw);
    indexFile(db, parsed, 'notes/complex.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { title: "It's Complex" });
    const data = parseResult(result);
    expect(data.id).toBe('notes/complex.md');
  });

  it('get-node resolves smart double quotes in ID', async () => {
    const raw = '---\ntitle: "\u201CQuoted\u201D"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('\u201CQuoted\u201D.md', raw);
    indexFile(db, parsed, '\u201CQuoted\u201D.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: '"Quoted".md' });
    const data = parseResult(result);
    expect(data.id).toBe('\u201CQuoted\u201D.md');
  });

  it('get-node resolves em-dash in title', async () => {
    const raw = '---\ntitle: "A\u2014B"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('notes/ab.md', raw);
    indexFile(db, parsed, 'notes/ab.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { title: 'A-B' });
    const data = parseResult(result);
    expect(data.id).toBe('notes/ab.md');
  });

  it('update-node works with typographically-normalized ID', async () => {
    const raw = '---\ntitle: "It\u2019s Editable"\ntypes: [note]\nstatus: draft\n---\nContent';
    const parsed = parseFile('It\u2019s Editable.md', raw);
    indexFile(db, parsed, 'It\u2019s Editable.md', '2025-03-10T00:00:00.000Z', raw);

    // Write the file to disk so update-node can read it
    const { writeFileSync } = await import('fs');
    writeFileSync(join(vaultPath, 'It\u2019s Editable.md'), raw);

    const result = await callTool(client, 'update-node', {
      node_id: "It's Editable.md",
      fields: { status: 'published' },
    });
    expect(result.isError).toBeFalsy();
  });

  it('delete-node works with typographically-normalized ID', async () => {
    const raw = '---\ntitle: "It\u2019s Deletable"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('It\u2019s Deletable.md', raw);
    indexFile(db, parsed, 'It\u2019s Deletable.md', '2025-03-10T00:00:00.000Z', raw);

    // Write the file to disk so delete-node can find it
    const { writeFileSync } = await import('fs');
    writeFileSync(join(vaultPath, 'It\u2019s Deletable.md'), raw);

    const result = await callTool(client, 'delete-node', {
      node_id: "It's Deletable.md",
    });
    expect(result.isError).toBeFalsy();
  });

  it('NFC decomposed ID resolves to NFC composed stored ID', async () => {
    const raw = '---\ntitle: "Caf\u00E9"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('Caf\u00E9.md', raw);
    indexFile(db, parsed, 'Caf\u00E9.md', '2025-03-10T00:00:00.000Z', raw);

    // Decomposed form
    const result = await callTool(client, 'get-node', { node_id: 'Caf\u0065\u0301.md' });
    const data = parseResult(result);
    expect(data.id).toBe('Caf\u00E9.md');
  });

  it('exact match still works without normalization overhead', async () => {
    const raw = '---\ntitle: "Simple"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('simple.md', raw);
    indexFile(db, parsed, 'simple.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await callTool(client, 'get-node', { node_id: 'simple.md' });
    const data = parseResult(result);
    expect(data.id).toBe('simple.md');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/mcp/unicode-resolution.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/unicode-resolution.test.ts
git commit -m "test: add Unicode resolution integration tests for MCP tools"
```

---

### Task 9: Integration Tests — `since` / `modified_since` and Reconciler

**Files:**
- Modify: `tests/mcp/unicode-resolution.test.ts`

- [ ] **Step 1: Write `since` / `modified_since` tests**

Append to `tests/mcp/unicode-resolution.test.ts`:

```typescript
describe('since and modified_since filters', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = mkdtempSync(join(tmpdir(), 'since-test-'));

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it('since filters on indexed_at (engine index time)', async () => {
    const beforeIndex = new Date().toISOString();

    // Small delay to ensure indexed_at is after beforeIndex
    await new Promise(r => setTimeout(r, 50));

    const raw = '---\ntitle: "Recent"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('recent.md', raw);
    indexFile(db, parsed, 'recent.md', '2020-01-01T00:00:00.000Z', raw);

    // since = before indexing → should find it
    const result1 = await callTool(client, 'query-nodes', {
      since: beforeIndex,
      schema_type: 'note',
    });
    const data1 = parseResult(result1);
    expect(data1.length).toBe(1);
    expect(data1[0].id).toBe('recent.md');

    // since = after indexing → should NOT find it
    await new Promise(r => setTimeout(r, 50));
    const afterIndex = new Date().toISOString();

    const result2 = await callTool(client, 'query-nodes', {
      since: afterIndex,
      schema_type: 'note',
    });
    const data2 = parseResult(result2);
    expect(data2.length).toBe(0);
  });

  it('modified_since filters on file_mtime (file modification time)', async () => {
    const raw = '---\ntitle: "Old File"\ntypes: [note]\n---\nContent';
    const parsed = parseFile('old.md', raw);
    // File mtime is in the past
    indexFile(db, parsed, 'old.md', '2020-01-01T00:00:00.000Z', raw);

    // modified_since after file mtime → should NOT find it
    const result = await callTool(client, 'query-nodes', {
      modified_since: '2021-01-01T00:00:00.000Z',
      schema_type: 'note',
    });
    const data = parseResult(result);
    expect(data.length).toBe(0);

    // modified_since before file mtime → should find it
    const result2 = await callTool(client, 'query-nodes', {
      modified_since: '2019-01-01T00:00:00.000Z',
      schema_type: 'note',
    });
    const data2 = parseResult(result2);
    expect(data2.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/mcp/unicode-resolution.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/unicode-resolution.test.ts
git commit -m "test: add since/modified_since filter integration tests"
```

---

### Task 10: Update CLAUDE.md and Cleanup

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add a section about the resolve module to the MCP Layer description:

Under `### MCP Layer (`src/mcp/`)`, add after the `duplicates.ts` entry:

```markdown
- **`resolve.ts`** — `resolveById(db, nodeId)` and `resolveByTitle(db, title)` with three-tier normalization: exact → NFC → typographic. Returns `ResolveResult` with `matchType` tracking. `normalizeTypographic(str)` maps smart quotes, em-dashes, ellipsis, NBSP to ASCII equivalents. Used by all tool handlers for node lookup.
```

Add to the Sync Layer description, after the `watcher.ts` entry:

```markdown
- **`reconciler.ts`** — `reconcileOnce(db, vaultPath)` runs `incrementalIndex` on demand. `startReconciler(db, vaultPath, opts?)` runs it periodically (30s first tick, 5m interval). Safety net for dropped chokidar events. Shares indexing logic with the watcher — same `incrementalIndex` under the hood.
```

Update the DB Layer schema description to mention `file_mtime` and `indexed_at` instead of `updated_at`.

- [ ] **Step 2: Run type check and full test suite**

```bash
npx tsc --noEmit && npm test
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with resolve module and reconciler"
```
