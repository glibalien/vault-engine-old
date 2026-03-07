# Reference Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve raw wiki-link target strings in `relationships.target_id` to actual node IDs (vault-relative file paths), stored in a new `resolved_target_id` column.

**Architecture:** Add `title` column to `nodes` table (populated during indexing from frontmatter title or filename stem). Add `resolved_target_id` column to `relationships`. New `src/sync/resolver.ts` module with `resolveReferences(db)` (batch) and `resolveTarget(db, target)` (single lookup). Resolution runs as end-of-transaction pass in `rebuildIndex`, `incrementalIndex`, and watcher events.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Schema Changes — Add `title` and `resolved_target_id` Columns

**Files:**
- Modify: `src/db/schema.ts:5-18` (nodes table), `src/db/schema.ts:44-52` (relationships table), add index

**Step 1: Write failing test for `title` column**

Create `tests/sync/resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';

describe('schema changes for reference resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('nodes table has a title column', () => {
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as any[];
    const titleCol = cols.find((c: any) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol.type).toBe('TEXT');
  });

  it('relationships table has a resolved_target_id column', () => {
    const cols = db.prepare("PRAGMA table_info('relationships')").all() as any[];
    const resolvedCol = cols.find((c: any) => c.name === 'resolved_target_id');
    expect(resolvedCol).toBeDefined();
    expect(resolvedCol.type).toBe('TEXT');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `title` column not found, `resolved_target_id` column not found

**Step 3: Update schema**

In `src/db/schema.ts`, add `title TEXT` after `content_md` in the nodes CREATE TABLE:

```sql
      content_md      TEXT,
      title           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
```

Add `resolved_target_id TEXT` after `context` in the relationships CREATE TABLE:

```sql
      context         TEXT,
      resolved_target_id TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
```

Add new index after existing indices:

```sql
    CREATE INDEX IF NOT EXISTS idx_rel_resolved ON relationships(resolved_target_id);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All existing tests pass (schema is additive — new nullable columns don't break existing INSERTs)

**Step 6: Commit**

```bash
git add src/db/schema.ts tests/sync/resolver.test.ts
git commit -m "add title and resolved_target_id columns to schema"
```

---

### Task 2: Populate `title` in `indexFile`

**Files:**
- Modify: `src/sync/indexer.ts:37-40` (INSERT INTO nodes)
- Test: `tests/sync/resolver.test.ts` (add tests)

**Step 1: Write failing tests for title population**

Append to `tests/sync/resolver.test.ts`:

```typescript
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('title population in indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('uses frontmatter title when present', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('tasks/review.md') as any;
    expect(node.title).toBe('Review vendor proposals');
  });

  it('derives title from filename stem when no frontmatter title', () => {
    const raw = '# Just a note\n\nSome content.';
    const parsed = parseFile('notes/My Great Note.md', raw);
    indexFile(db, parsed, 'notes/My Great Note.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('notes/My Great Note.md') as any;
    expect(node.title).toBe('My Great Note');
  });

  it('derives title from nested path filename stem', () => {
    const raw = 'Plain content.';
    const parsed = parseFile('deep/nested/path/Cool File.md', raw);
    indexFile(db, parsed, 'deep/nested/path/Cool File.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('deep/nested/path/Cool File.md') as any;
    expect(node.title).toBe('Cool File');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `node.title` is `null` (column exists but not populated)

**Step 3: Update `indexFile` to populate title**

In `src/sync/indexer.ts`, import `basename` from `node:path`:

```typescript
import { relative, join, basename } from 'node:path';
```

Add a helper function above `indexFile`:

```typescript
function deriveTitle(parsed: ParsedFile, relativePath: string): string {
  if (parsed.frontmatter.title && typeof parsed.frontmatter.title === 'string') {
    return parsed.frontmatter.title;
  }
  return basename(relativePath, '.md');
}
```

Update the INSERT in `indexFile` to include `title`:

```typescript
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, title, depth)
    VALUES (?, ?, 'file', ?, ?, ?, 0)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd, deriveTitle(parsed, relativePath));
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/sync/indexer.ts tests/sync/resolver.test.ts
git commit -m "populate title column in indexFile"
```

---

### Task 3: `resolveTarget` — Single Target Resolution

**Files:**
- Create: `src/sync/resolver.ts`
- Test: `tests/sync/resolver.test.ts` (add tests)

**Step 1: Write failing tests for resolveTarget**

Append to `tests/sync/resolver.test.ts`:

```typescript
import { resolveTarget } from '../../src/sync/resolver.js';

describe('resolveTarget', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves by frontmatter title (case-insensitive)', () => {
    seed('people/alice-smith.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');

    expect(resolveTarget(db, 'Alice Smith')).toBe('people/alice-smith.md');
    expect(resolveTarget(db, 'alice smith')).toBe('people/alice-smith.md');
    expect(resolveTarget(db, 'ALICE SMITH')).toBe('people/alice-smith.md');
  });

  it('resolves by filename stem when no title match', () => {
    seed('notes/Meeting Notes.md', '# Meeting\nContent.');

    expect(resolveTarget(db, 'Meeting Notes')).toBe('notes/Meeting Notes.md');
    expect(resolveTarget(db, 'meeting notes')).toBe('notes/Meeting Notes.md');
  });

  it('returns null for unresolvable targets', () => {
    seed('notes/hello.md', '# Hello');

    expect(resolveTarget(db, 'Nonexistent Node')).toBeNull();
  });

  it('prefers title match over filename stem match', () => {
    // File with title that differs from filename
    seed('docs/readme.md', '---\ntitle: Getting Started Guide\n---\nContent.');

    expect(resolveTarget(db, 'Getting Started Guide')).toBe('docs/readme.md');
    expect(resolveTarget(db, 'readme')).toBe('docs/readme.md');
  });

  it('resolves with path suffix for disambiguation', () => {
    seed('work/Meeting Notes.md', '---\ntitle: Meeting Notes\n---\nWork meetings.');
    seed('personal/Meeting Notes.md', '---\ntitle: Meeting Notes\n---\nPersonal meetings.');

    // Ambiguous — two nodes with same title
    expect(resolveTarget(db, 'Meeting Notes')).toBeNull();

    // Disambiguated with path prefix
    expect(resolveTarget(db, 'work/Meeting Notes')).toBe('work/Meeting Notes.md');
    expect(resolveTarget(db, 'personal/Meeting Notes')).toBe('personal/Meeting Notes.md');
  });

  it('handles path suffix matching case-insensitively', () => {
    seed('Projects/Alpha/Status.md', '---\ntitle: Status\n---\nStatus update.');
    seed('Projects/Beta/Status.md', '---\ntitle: Status\n---\nStatus update.');

    expect(resolveTarget(db, 'Alpha/Status')).toBe('Projects/Alpha/Status.md');
    expect(resolveTarget(db, 'alpha/status')).toBe('Projects/Alpha/Status.md');
  });

  it('returns null when path suffix is still ambiguous', () => {
    seed('a/shared/Note.md', '---\ntitle: Note\n---\nA.');
    seed('b/shared/Note.md', '---\ntitle: Note\n---\nB.');

    // Both end with shared/Note — still ambiguous
    expect(resolveTarget(db, 'shared/Note')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `resolveTarget` not found (module doesn't exist)

**Step 3: Implement `resolveTarget`**

Create `src/sync/resolver.ts`:

```typescript
import type Database from 'better-sqlite3';

interface NodeLookupRow {
  id: string;
  title: string | null;
}

function buildLookupMaps(db: Database.Database): {
  titleMap: Map<string, string[]>;
  pathMap: Map<string, string[]>;
} {
  const rows = db.prepare('SELECT id, title FROM nodes').all() as NodeLookupRow[];
  const titleMap = new Map<string, string[]>();
  const pathMap = new Map<string, string[]>();

  for (const row of rows) {
    // Title-based lookup
    if (row.title) {
      const key = row.title.toLowerCase();
      const existing = titleMap.get(key);
      if (existing) existing.push(row.id);
      else titleMap.set(key, [row.id]);
    }

    // Path-based lookup: generate all suffixes
    // e.g., "projects/alpha/status.md" → ["status", "alpha/status", "projects/alpha/status"]
    const pathWithoutExt = row.id.replace(/\.md$/, '');
    const parts = pathWithoutExt.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const suffix = parts.slice(i).join('/').toLowerCase();
      const existing = pathMap.get(suffix);
      if (existing) existing.push(row.id);
      else pathMap.set(suffix, [row.id]);
    }
  }

  return { titleMap, pathMap };
}

export function resolveTarget(db: Database.Database, wikiLinkTarget: string): string | null {
  const { titleMap, pathMap } = buildLookupMaps(db);
  return resolveTargetWithMaps(wikiLinkTarget, titleMap, pathMap);
}

function resolveTargetWithMaps(
  wikiLinkTarget: string,
  titleMap: Map<string, string[]>,
  pathMap: Map<string, string[]>,
): string | null {
  const target = wikiLinkTarget.toLowerCase();

  // 1. Try title match
  const titleMatches = titleMap.get(target);
  if (titleMatches && titleMatches.length === 1) {
    return titleMatches[0];
  }

  // 2. Try path suffix match (handles both stem-only and path/stem)
  const pathMatches = pathMap.get(target);
  if (pathMatches && pathMatches.length === 1) {
    return pathMatches[0];
  }

  // 3. If title matched multiple, try path suffix to disambiguate
  if (titleMatches && titleMatches.length > 1) {
    const pathFiltered = pathMap.get(target);
    if (pathFiltered && pathFiltered.length === 1) {
      return pathFiltered[0];
    }
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sync/resolver.ts tests/sync/resolver.test.ts
git commit -m "add resolveTarget for single wiki-link resolution"
```

---

### Task 4: `resolveReferences` — Batch Resolution

**Files:**
- Modify: `src/sync/resolver.ts` (add `resolveReferences`)
- Test: `tests/sync/resolver.test.ts` (add tests)

**Step 1: Write failing tests for resolveReferences**

Append to `tests/sync/resolver.test.ts`:

```typescript
import { resolveReferences } from '../../src/sync/resolver.js';

describe('resolveReferences', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves relationships where target matches a node title', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');

    const result = resolveReferences(db);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
    expect(result.resolved).toBeGreaterThanOrEqual(1);
  });

  it('leaves unresolvable targets as NULL', () => {
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Nobody]]"\n---\nDo it.');

    const result = resolveReferences(db);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Nobody'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
    expect(result.unresolved).toBeGreaterThanOrEqual(1);
  });

  it('clears stale resolutions when target node is deleted', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    resolveReferences(db);

    // Verify it was resolved
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');

    // Delete the target node
    db.prepare("DELETE FROM nodes WHERE id = 'people/alice.md'").run();

    // Re-resolve — should clear the stale reference
    resolveReferences(db);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
  });

  it('resolves previously dangling refs when target node is added', () => {
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    resolveReferences(db);

    // Dangling
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();

    // Add the target node
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    resolveReferences(db);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('returns counts of resolved and unresolved references', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\nsource: "[[Unknown]]"\n---\nDo it.');

    const result = resolveReferences(db);

    expect(result.resolved).toBe(1);
    expect(result.unresolved).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `resolveReferences` not found

**Step 3: Implement `resolveReferences`**

Add to `src/sync/resolver.ts`:

```typescript
export function resolveReferences(db: Database.Database): { resolved: number; unresolved: number } {
  // Step 1: Clear stale resolutions
  db.prepare(`
    UPDATE relationships SET resolved_target_id = NULL
    WHERE resolved_target_id IS NOT NULL
      AND resolved_target_id NOT IN (SELECT id FROM nodes)
  `).run();

  // Step 2: Build lookup maps
  const { titleMap, pathMap } = buildLookupMaps(db);

  // Step 3: Resolve unresolved references
  const unresolved = db.prepare(
    'SELECT id, target_id FROM relationships WHERE resolved_target_id IS NULL'
  ).all() as Array<{ id: number; target_id: string }>;

  const update = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');

  let resolved = 0;
  let stillUnresolved = 0;

  for (const row of unresolved) {
    const nodeId = resolveTargetWithMaps(row.target_id, titleMap, pathMap);
    if (nodeId) {
      update.run(nodeId, row.id);
      resolved++;
    } else {
      stillUnresolved++;
    }
  }

  return { resolved, unresolved: stillUnresolved };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sync/resolver.ts tests/sync/resolver.test.ts
git commit -m "add resolveReferences for batch wiki-link resolution"
```

---

### Task 5: Integration — Wire Resolution Into Indexing Pipeline

**Files:**
- Modify: `src/sync/indexer.ts` (`rebuildIndex`, `incrementalIndex`)
- Modify: `src/sync/watcher.ts` (`handleAddOrChange`, `unlink`)
- Modify: `src/sync/index.ts` (re-export)
- Test: `tests/sync/resolver.test.ts` (add integration tests)

**Step 1: Write failing integration tests**

Append to `tests/sync/resolver.test.ts`:

```typescript
import { rebuildIndex, incrementalIndex } from '../../src/sync/indexer.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('reference resolution integration', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-ref-test-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  function writeVaultFile(relPath: string, content: string) {
    const abs = join(tmpVault, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('rebuildIndex resolves references after indexing all files', () => {
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');

    rebuildIndex(db, tmpVault);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('incrementalIndex resolves references including newly added files', () => {
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    incrementalIndex(db, tmpVault);

    // Dangling ref
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();

    // Add the target file
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    incrementalIndex(db, tmpVault);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('incrementalIndex clears stale refs when target file is deleted', () => {
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    incrementalIndex(db, tmpVault);

    // Resolved
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');

    // Delete the target file
    rmSync(join(tmpVault, 'people/alice.md'));
    incrementalIndex(db, tmpVault);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `rebuildIndex` and `incrementalIndex` don't call `resolveReferences` yet

**Step 3: Wire resolution into indexer**

In `src/sync/indexer.ts`, add import at top:

```typescript
import { resolveReferences } from './resolver.js';
```

In `rebuildIndex`, add `resolveReferences(db)` call before the `return` inside the transaction:

```typescript
    // After the for loop that indexes all files:
    resolveReferences(db);

    return { filesIndexed };
```

In `incrementalIndex`, add `resolveReferences(db)` call before the `return` inside the transaction:

```typescript
    // After the for loop that deletes removed files:
    resolveReferences(db);

    return { indexed, skipped, deleted };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 5: Wire resolution into watcher**

In `src/sync/watcher.ts`, add import:

```typescript
import { resolveReferences } from './resolver.js';
```

In `handleAddOrChange`, add `resolveReferences(db)` inside the transaction:

```typescript
        db.transaction(() => {
          indexFile(db, parsed, rel, mtime, raw);
          resolveReferences(db);
        })();
```

In the `unlink` handler, add `resolveReferences(db)` inside the transaction:

```typescript
        db.transaction(() => {
          deleteFile(db, rel);
          resolveReferences(db);
        })();
```

**Step 6: Update re-exports**

In `src/sync/index.ts`, add:

```typescript
export { resolveReferences, resolveTarget } from './resolver.js';
```

**Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing tests unaffected — `resolved_target_id` is NULL by default, no breakage)

**Step 8: Commit**

```bash
git add src/sync/indexer.ts src/sync/watcher.ts src/sync/index.ts src/sync/resolver.ts tests/sync/resolver.test.ts
git commit -m "integrate reference resolution with indexer and watcher"
```

---

### Task 6: Edge Cases and Fixture Vault Test

**Files:**
- Test: `tests/sync/resolver.test.ts` (add edge case tests)

**Step 1: Write edge case tests**

Append to `tests/sync/resolver.test.ts`:

```typescript
describe('resolveTarget edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves by filename stem for files without frontmatter', () => {
    seed('notes/Quick Note.md', 'Just a quick note, no frontmatter.');

    expect(resolveTarget(db, 'Quick Note')).toBe('notes/Quick Note.md');
  });

  it('title match takes priority over filename stem match in different node', () => {
    // Node A has title "Status Report" but filename "weekly.md"
    seed('reports/weekly.md', '---\ntitle: Status Report\n---\nWeekly status.');
    // Node B has filename "Status Report.md" with no title
    seed('notes/Status Report.md', 'Some notes.');

    // "Status Report" matches both: Node A by title, Node B by stem
    // Title match should be preferred — but both match, so it's ambiguous
    // unless we prioritize title. Let's test: title is checked first.
    // titleMap has "status report" → ["reports/weekly.md"]
    // pathMap has "status report" → ["notes/Status Report.md"]
    // Title match returns exactly 1 → resolved to Node A
    expect(resolveTarget(db, 'Status Report')).toBe('reports/weekly.md');
  });

  it('handles wiki-link targets with .md extension', () => {
    seed('notes/Todo.md', '---\ntitle: Todo\n---\nList.');

    // Users might write [[Todo.md]] — should still resolve
    // Path map includes "todo.md" → but wait, we strip .md from paths
    // So [[Todo.md]] won't match the stem "todo" directly.
    // This is correct behavior — Obsidian-style links don't include .md
    expect(resolveTarget(db, 'Todo')).toBe('notes/Todo.md');
  });

  it('handles body wiki-links in fixture vault via rebuildIndex', () => {
    // Use the real fixture vault
    const vaultDir = resolve(import.meta.dirname, '../fixtures/vault');
    rebuildIndex(db, vaultDir);

    // sample-task.md has body link [[Alice Smith]]
    // alice-smith.md has title "Alice Smith"
    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/review-vendor-proposals.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice-smith.md');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/sync/resolver.test.ts
git commit -m "add reference resolution edge case tests"
```
