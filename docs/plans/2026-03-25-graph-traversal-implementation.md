# Graph Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `traverse-graph` MCP tool that performs N-hop BFS traversal over the relationship graph with direction, rel_type, and target_type filtering.

**Architecture:** Application-level BFS in `src/graph/traversal.ts` returns raw node IDs, depths, and edges. The MCP tool handler in `src/mcp/server.ts` hydrates results via the existing `hydrateNodes` closure. No DB schema changes.

**Tech Stack:** TypeScript, better-sqlite3, vitest, zod, @modelcontextprotocol/sdk

**Spec:** `docs/plans/2026-03-25-graph-traversal-design.md`

---

### Task 1: Extend `hydrateNodes` to include `title`

The existing `hydrateNodes` closure in `src/mcp/server.ts` omits `title` from its SELECT and output. All tools that hydrate nodes will benefit from this fix.

**Files:**
- Modify: `src/mcp/server.ts:34-79` (hydrateNodes closure)
- Modify: `src/mcp/server.ts:1085-1088` (get-node SELECT)
- Modify: `src/mcp/server.ts` (get-recent, query-nodes SELECTs — any that feed into hydrateNodes)
- Test: `tests/mcp/server.test.ts` (existing tests should still pass; add a title assertion)

- [ ] **Step 1: Update `hydrateNodes` input type to include `title`**

In `src/mcp/server.ts`, change the `hydrateNodes` parameter type and output:

```typescript
function hydrateNodes(
  nodeRows: Array<{ id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string }>,
  opts?: { includeContentMd?: boolean },
) {
```

And in the mapping function (around line 66), add `title`:

```typescript
return nodeRows.map(row => {
  const node: Record<string, unknown> = {
    id: row.id,
    file_path: row.file_path,
    node_type: row.node_type,
    title: row.title,
    types: typesMap.get(row.id) ?? [],
    fields: fieldsMap.get(row.id) ?? {},
    content_text: row.content_text,
    updated_at: row.updated_at,
  };
```

- [ ] **Step 2: Update all SELECT queries that feed into `hydrateNodes` to include `title`**

There are multiple SELECT queries throughout `server.ts` that produce rows for `hydrateNodes`. Each needs `title` added:

1. `get-node` (line ~1086): `SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id = ?`
2. `get-recent`: find its SELECT and add `title`
3. `query-nodes`: find its SELECT(s) and add `title`

Search for all `SELECT id, file_path, node_type` in `server.ts` and add `title` to each one.

Also update the `as` type casts on those queries to include `title: string | null`.

- [ ] **Step 3: Run existing tests to verify nothing broke**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: All existing tests pass.

- [ ] **Step 4: Add a title assertion to an existing test**

In `tests/mcp/server.test.ts`, find a test that calls `get-node` and add:

```typescript
expect(parsed.title).toBe('Review vendor proposals');
```

- [ ] **Step 5: Run tests to confirm the assertion passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add title to hydrateNodes output"
```

---

### Task 2: Create `src/graph/traversal.ts` with types and core BFS

**Files:**
- Create: `src/graph/traversal.ts`
- Create: `src/graph/index.ts`
- Test: `tests/graph/traversal.test.ts`

- [ ] **Step 1: Write the test for basic 1-hop outgoing traversal**

Create `tests/graph/traversal.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { traverseGraph } from '../../src/graph/traversal.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('traverseGraph', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Index three connected fixtures:
    // meeting -> (attendees) -> alice, bob
    // meeting -> (project) -> centerpoint (unresolved, no file)
    // task -> (assignee) -> bob
    // task -> (source) -> meeting
    // alice -> (wiki-link) -> centerpoint (unresolved)
    db.transaction(() => {
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      resolveReferences(db);
    })();
  });

  afterEach(() => {
    db.close();
  });

  it('returns outgoing neighbors at depth 1', () => {
    const result = traverseGraph(db, {
      node_id: 'meetings/q1.md',
      direction: 'outgoing',
      max_depth: 1,
    });

    expect(result.root_id).toBe('meetings/q1.md');
    // meeting has outgoing resolved refs to alice and bob (and others that are unresolved)
    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('people/alice.md');
    // All discovered nodes should be depth 1
    for (const n of result.node_ids) {
      expect(n.depth).toBe(1);
    }
    // Edges should exist
    expect(result.edges.length).toBeGreaterThan(0);
    // Every edge should have source_id, target_id, resolved_target_id, rel_type
    for (const e of result.edges) {
      expect(e.source_id).toBeTruthy();
      expect(e.target_id).toBeTruthy();
      expect(e.resolved_target_id).toBeTruthy();
      expect(e.rel_type).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/graph/traversal.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/traversal.js`

- [ ] **Step 3: Create `src/graph/traversal.ts` with types and core BFS implementation**

```typescript
import type Database from 'better-sqlite3';

export interface TraverseOptions {
  node_id: string;
  direction: 'outgoing' | 'incoming' | 'both';
  rel_types?: string[];
  target_types?: string[];
  max_depth: number;
}

export interface TraverseEdge {
  source_id: string;
  target_id: string;
  resolved_target_id: string;
  rel_type: string;
  context: string | null;
}

export interface TraverseResult {
  root_id: string;
  node_ids: Array<{ id: string; depth: number }>;
  edges: TraverseEdge[];
}

interface RelRow {
  id: number;
  source_id: string;
  target_id: string;
  rel_type: string;
  context: string | null;
  resolved_target_id: string | null;
}

const MAX_DEPTH_LIMIT = 10;
const IN_CLAUSE_CHUNK_SIZE = 500;

// Tagged row: includes which query produced it so neighbor can be determined
interface TaggedRelRow extends RelRow {
  _direction: 'outgoing' | 'incoming';
}

function queryRelationships(
  db: Database.Database,
  nodeIds: string[],
  direction: 'outgoing' | 'incoming' | 'both',
): TaggedRelRow[] {
  const results: TaggedRelRow[] = [];

  for (let i = 0; i < nodeIds.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = nodeIds.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');

    if (direction === 'outgoing' || direction === 'both') {
      const rows = db.prepare(
        `SELECT id, source_id, target_id, rel_type, context, resolved_target_id
         FROM relationships
         WHERE source_id IN (${placeholders}) AND resolved_target_id IS NOT NULL`
      ).all(...chunk) as RelRow[];
      for (const row of rows) {
        results.push({ ...row, _direction: 'outgoing' });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const rows = db.prepare(
        `SELECT id, source_id, target_id, rel_type, context, resolved_target_id
         FROM relationships
         WHERE resolved_target_id IN (${placeholders})`
      ).all(...chunk) as RelRow[];
      for (const row of rows) {
        results.push({ ...row, _direction: 'incoming' });
      }
    }
  }

  // Deduplicate by relationship id when direction is 'both'
  if (direction === 'both') {
    const seen = new Set<number>();
    return results.filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }

  return results;
}

export function traverseGraph(db: Database.Database, options: TraverseOptions): TraverseResult {
  const { node_id, direction, rel_types, target_types } = options;
  const maxDepth = Math.max(1, Math.min(MAX_DEPTH_LIMIT, options.max_depth));

  // Validate root exists
  const rootRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id) as { id: string } | undefined;
  if (!rootRow) {
    throw new Error(`Node not found: ${node_id}`);
  }

  const relTypesSet = rel_types ? new Set(rel_types) : null;
  const visited = new Set<string>([node_id]);
  const depthMap = new Map<string, number>([[node_id, 0]]);
  const edges: TraverseEdge[] = [];
  const seenEdgeIds = new Set<number>(); // dedup edges across BFS levels
  let currentLevel = [node_id];
  let currentDepth = 0;

  while (currentLevel.length > 0 && currentDepth < maxDepth) {
    const rows = queryRelationships(db, currentLevel, direction);
    const nextLevel: string[] = [];

    for (const row of rows) {
      // Determine neighbor based on which query produced this row
      // outgoing query: source is in currentLevel, neighbor is resolved_target_id
      // incoming query: resolved_target_id is in currentLevel, neighbor is source_id
      const neighborId: string | null = row._direction === 'outgoing'
        ? row.resolved_target_id
        : row.source_id;

      if (!neighborId) continue;

      // Filter by rel_types
      if (relTypesSet && !relTypesSet.has(row.rel_type)) continue;

      // Skip if this relationship row was already recorded at a previous level
      if (seenEdgeIds.has(row.id)) continue;
      seenEdgeIds.add(row.id);

      // Record edge (after rel_types filter, before visited check)
      // resolved_target_id is guaranteed non-null: outgoing query has IS NOT NULL,
      // incoming query matched on resolved_target_id so it's non-null
      edges.push({
        source_id: row.source_id,
        target_id: row.target_id,
        resolved_target_id: row.resolved_target_id as string,
        rel_type: row.rel_type,
        context: row.context,
      });

      // Skip if already visited
      if (visited.has(neighborId)) continue;

      visited.add(neighborId);
      depthMap.set(neighborId, currentDepth + 1);
      nextLevel.push(neighborId);
    }

    currentLevel = nextLevel;
    currentDepth++;
  }

  // Collect node_ids (excluding root)
  let nodeIds = Array.from(depthMap.entries())
    .filter(([id]) => id !== node_id)
    .map(([id, depth]) => ({ id, depth }));

  // Apply target_types filter (display only)
  if (target_types && target_types.length > 0) {
    const idsToCheck = nodeIds.map(n => n.id);
    if (idsToCheck.length > 0) {
      const matchingIds = new Set<string>();
      for (let i = 0; i < idsToCheck.length; i += IN_CLAUSE_CHUNK_SIZE) {
        const chunk = idsToCheck.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const typePlaceholders = target_types.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT DISTINCT node_id FROM node_types
           WHERE node_id IN (${placeholders})
             AND schema_type IN (${typePlaceholders})`
        ).all(...chunk, ...target_types) as Array<{ node_id: string }>;
        for (const row of rows) {
          matchingIds.add(row.node_id);
        }
      }
      nodeIds = nodeIds.filter(n => matchingIds.has(n.id));
    }
  }

  return { root_id: node_id, node_ids: nodeIds, edges };
}
```

- [ ] **Step 4: Create `src/graph/index.ts` barrel export**

```typescript
export { traverseGraph } from './traversal.js';
export type { TraverseOptions, TraverseEdge, TraverseResult } from './traversal.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/graph/traversal.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/graph/traversal.ts src/graph/index.ts tests/graph/traversal.test.ts
git commit -m "add graph traversal module with BFS implementation"
```

---

### Task 3: Add tests for incoming, both, cycles, rel_types, target_types, and edge cases

**Files:**
- Modify: `tests/graph/traversal.test.ts`

- [ ] **Step 1: Add test for incoming traversal**

```typescript
it('returns incoming neighbors at depth 1', () => {
  // alice is referenced by meeting (attendees and assignee fields) and task (body wiki-link)
  const result = traverseGraph(db, {
    node_id: 'people/alice.md',
    direction: 'incoming',
    max_depth: 1,
  });

  expect(result.root_id).toBe('people/alice.md');
  const nodeIds = result.node_ids.map(n => n.id);
  // meeting references alice via attendees and assignee
  expect(nodeIds).toContain('meetings/q1.md');
  // task references alice in body
  expect(nodeIds).toContain('tasks/review.md');
});
```

- [ ] **Step 2: Add test for `direction: 'both'` traversal**

```typescript
it('traverses both directions', () => {
  // Create two nodes that reference each other plus a third
  // A -> B (outgoing), C -> A (incoming)
  const rawA = '---\ntitle: Node A\n---\nLinks to [[Node B]]';
  const rawB = '---\ntitle: Node B\n---\nStandalone node.';
  const rawC = '---\ntitle: Node C\n---\nLinks to [[Node A]]';
  db.transaction(() => {
    indexFile(db, parseFile('a.md', rawA), 'a.md', '2025-03-10T00:00:00.000Z', rawA);
    indexFile(db, parseFile('b.md', rawB), 'b.md', '2025-03-10T00:00:00.000Z', rawB);
    indexFile(db, parseFile('c.md', rawC), 'c.md', '2025-03-10T00:00:00.000Z', rawC);
    resolveReferences(db);
  })();

  const result = traverseGraph(db, {
    node_id: 'a.md',
    direction: 'both',
    max_depth: 1,
  });

  const nodeIds = result.node_ids.map(n => n.id);
  // Outgoing: A -> B
  expect(nodeIds).toContain('b.md');
  // Incoming: C -> A
  expect(nodeIds).toContain('c.md');
  // Both at depth 1
  for (const n of result.node_ids) {
    expect(n.depth).toBe(1);
  }
});
```

- [ ] **Step 3: Add test for multi-hop traversal**

```typescript
it('traverses multiple hops', () => {
  const result = traverseGraph(db, {
    node_id: 'people/alice.md',
    direction: 'both',
    max_depth: 2,
  });

  const nodeIds = result.node_ids.map(n => n.id);
  // Depth 1: meeting and task reference alice
  expect(nodeIds).toContain('meetings/q1.md');
  expect(nodeIds).toContain('tasks/review.md');
  // Depth 2: nodes connected to meeting/task (that aren't alice)
  // task has outgoing to meeting (source), bob (assignee)
  // meeting has outgoing to alice (already visited), bob (attendees)
  // So depth 2 should include at least the other connected nodes
  expect(result.node_ids.some(n => n.depth === 2)).toBe(true);
});
```

- [ ] **Step 4: Add test for cycle detection**

```typescript
it('handles cycles without infinite loop', () => {
  // Create a cycle: A -> B -> A
  const rawA = '---\ntitle: Node A\n---\nLinks to [[Node B]]';
  const rawB = '---\ntitle: Node B\n---\nLinks to [[Node A]]';
  const parsedA = parseFile('a.md', rawA);
  const parsedB = parseFile('b.md', rawB);
  db.transaction(() => {
    indexFile(db, parsedA, 'a.md', '2025-03-10T00:00:00.000Z', rawA);
    indexFile(db, parsedB, 'b.md', '2025-03-10T00:00:00.000Z', rawB);
    resolveReferences(db);
  })();

  const result = traverseGraph(db, {
    node_id: 'a.md',
    direction: 'both',
    max_depth: 5,
  });

  expect(result.root_id).toBe('a.md');
  expect(result.node_ids).toHaveLength(1);
  expect(result.node_ids[0].id).toBe('b.md');
  expect(result.node_ids[0].depth).toBe(1);
  // Should have edges in both directions
  expect(result.edges.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 5: Add test for `rel_types` filtering**

```typescript
it('filters by rel_types', () => {
  const result = traverseGraph(db, {
    node_id: 'meetings/q1.md',
    direction: 'outgoing',
    rel_types: ['attendees'],
    max_depth: 1,
  });

  // Only attendees relationships should be traversed
  for (const e of result.edges) {
    expect(e.rel_type).toBe('attendees');
  }
  const nodeIds = result.node_ids.map(n => n.id);
  expect(nodeIds).toContain('people/alice.md');
});
```

- [ ] **Step 6: Add test for `target_types` display filtering**

```typescript
it('filters results by target_types without affecting traversal', () => {
  // Task has resolved outgoing refs to: meeting (via source) and alice (via body wiki-link)
  // meeting has types [meeting, task], alice has types [person]
  // Without filter: finds both meeting and alice
  // With target_types: ['person']: only alice should appear
  const unfiltered = traverseGraph(db, {
    node_id: 'tasks/review.md',
    direction: 'outgoing',
    max_depth: 1,
  });
  const unfilteredIds = unfiltered.node_ids.map(n => n.id);
  expect(unfilteredIds).toContain('people/alice.md');
  expect(unfilteredIds).toContain('meetings/q1.md');

  const filtered = traverseGraph(db, {
    node_id: 'tasks/review.md',
    direction: 'outgoing',
    target_types: ['person'],
    max_depth: 1,
  });

  const filteredIds = filtered.node_ids.map(n => n.id);
  // Alice (person) should be included
  expect(filteredIds).toContain('people/alice.md');
  // Meeting should be excluded (types: meeting, task — not person)
  expect(filteredIds).not.toContain('meetings/q1.md');

  // Edges should still include all traversed edges (not filtered)
  expect(filtered.edges.length).toBe(unfiltered.edges.length);
});
```

- [ ] **Step 7: Add test for node not found**

```typescript
it('throws when root node does not exist', () => {
  expect(() => traverseGraph(db, {
    node_id: 'nonexistent.md',
    direction: 'both',
    max_depth: 1,
  })).toThrow('Node not found: nonexistent.md');
});
```

- [ ] **Step 8: Add test for max_depth clamping**

```typescript
it('clamps max_depth to 1-10 range', () => {
  // max_depth 0 should be clamped to 1
  const result = traverseGraph(db, {
    node_id: 'meetings/q1.md',
    direction: 'outgoing',
    max_depth: 0,
  });

  // Should still find depth-1 nodes (clamped to 1, not 0)
  expect(result.node_ids.length).toBeGreaterThan(0);
  for (const n of result.node_ids) {
    expect(n.depth).toBe(1);
  }
});
```

- [ ] **Step 9: Add test for self-referential edge**

```typescript
it('handles self-referential edges', () => {
  const raw = '---\ntitle: Self Ref\n---\nLinks to [[Self Ref]] itself.';
  db.transaction(() => {
    indexFile(db, parseFile('self.md', raw), 'self.md', '2025-03-10T00:00:00.000Z', raw);
    resolveReferences(db);
  })();

  const result = traverseGraph(db, {
    node_id: 'self.md',
    direction: 'outgoing',
    max_depth: 2,
  });

  // Self-link edge should be recorded
  expect(result.edges).toHaveLength(1);
  expect(result.edges[0].source_id).toBe('self.md');
  expect(result.edges[0].resolved_target_id).toBe('self.md');
  // But no new nodes discovered (self is already visited as root)
  expect(result.node_ids).toEqual([]);
});
```

- [ ] **Step 10: Add test for edge deduplication with `direction: 'both'`**

```typescript
it('deduplicates edges when direction is both', () => {
  // Create A -> B. With direction 'both' from A, the outgoing query
  // finds A->B, and the incoming query on B finds A->B again.
  // But at depth 0, only A is in currentLevel, so the incoming query
  // is WHERE resolved_target_id IN ('a.md') which would only match
  // edges pointing TO a.md. So for dedup to matter, we need both
  // endpoints in the same level. Create: A -> B, B -> A (mutual refs)
  const rawA = '---\ntitle: Dup A\n---\n[[Dup B]]';
  const rawB = '---\ntitle: Dup B\n---\n[[Dup A]]';
  db.transaction(() => {
    indexFile(db, parseFile('dup-a.md', rawA), 'dup-a.md', '2025-03-10T00:00:00.000Z', rawA);
    indexFile(db, parseFile('dup-b.md', rawB), 'dup-b.md', '2025-03-10T00:00:00.000Z', rawB);
    resolveReferences(db);
  })();

  const result = traverseGraph(db, {
    node_id: 'dup-a.md',
    direction: 'both',
    max_depth: 2,
  });

  // There are 2 relationship rows (A->B and B->A).
  // At depth 0, currentLevel=[A]. Outgoing finds A->B, incoming finds B->A.
  // These are different relationship rows, so both should appear.
  // At depth 1, currentLevel=[B]. Outgoing finds B->A (A already visited),
  // incoming finds A->B (same row as depth 0 outgoing — but different
  // relationship row). Both edges should be recorded, deduped by row id.
  // Total unique edges: 2 (A->B and B->A), each recorded once per BFS level
  // they're first encountered. The dedup ensures no single row appears twice.
  const edgeIds = result.edges.map(e => `${e.source_id}->${e.resolved_target_id}`);
  const uniqueEdgeIds = new Set(edgeIds);
  // Verify no exact duplicate edges (same source+target+rel_type)
  expect(edgeIds.length).toBe(uniqueEdgeIds.size);
});
```

- [ ] **Step 11: Add test for isolated node (no relationships)**

```typescript
it('returns empty results for a node with no relationships', () => {
  const raw = '---\ntitle: Isolated\n---\nNo links here.';
  const parsed = parseFile('isolated.md', raw);
  db.transaction(() => {
    indexFile(db, parsed, 'isolated.md', '2025-03-10T00:00:00.000Z', raw);
  })();

  const result = traverseGraph(db, {
    node_id: 'isolated.md',
    direction: 'both',
    max_depth: 2,
  });

  expect(result.root_id).toBe('isolated.md');
  expect(result.node_ids).toEqual([]);
  expect(result.edges).toEqual([]);
});
```

- [ ] **Step 12: Run all tests**

Run: `npx vitest run tests/graph/traversal.test.ts`
Expected: All PASS

- [ ] **Step 13: Commit**

```bash
git add tests/graph/traversal.test.ts
git commit -m "add comprehensive graph traversal tests"
```

---

### Task 4: Register `traverse-graph` MCP tool

**Files:**
- Modify: `src/mcp/server.ts` (add tool registration + import)
- Test: `tests/mcp/server.test.ts` (add integration test via MCP tool call)

- [ ] **Step 1: Write the MCP integration test**

Add a `describe('traverse-graph', ...)` block to `tests/mcp/server.test.ts`. The test pattern uses `client.callTool({ name: ..., arguments: ... })` and `JSON.parse((result.content as Array<{ text: string }>)[0].text)` — match the existing tests exactly.

```typescript
describe('traverse-graph', () => {
  it('returns hydrated nodes with depth and edges', async () => {
    indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
    indexFixture(db, 'sample-task.md', 'tasks/review.md');
    indexFixture(db, 'sample-person.md', 'people/alice.md');
    // resolveReferences is needed for traversal to work
    const { resolveReferences } = await import('../../src/sync/resolver.js');
    resolveReferences(db);

    const result = await client.callTool({
      name: 'traverse-graph',
      arguments: {
        node_id: 'meetings/q1.md',
        direction: 'outgoing',
        max_depth: 1,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Root should be hydrated with title
    expect(parsed.root.id).toBe('meetings/q1.md');
    expect(parsed.root.title).toBe('Q1 Planning Meeting');
    expect(parsed.root.types).toContain('meeting');
    // Nodes should have depth
    expect(parsed.nodes.length).toBeGreaterThan(0);
    for (const n of parsed.nodes) {
      expect(n.depth).toBe(1);
      expect(n.title).toBeTruthy();
      expect(n.types).toBeDefined();
      expect(n.fields).toBeDefined();
    }
    // Edges should have full shape
    for (const e of parsed.edges) {
      expect(e.source_id).toBeTruthy();
      expect(e.target_id).toBeTruthy();
      expect(e.resolved_target_id).toBeTruthy();
      expect(e.rel_type).toBeTruthy();
      expect('context' in e).toBe(true);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts` (or the new test file)
Expected: FAIL — tool not registered

- [ ] **Step 3: Add the `traverse-graph` tool registration in `src/mcp/server.ts`**

Add the import at the top of the file:

```typescript
import { traverseGraph } from '../graph/index.js';
```

Add the tool registration (after existing tools, before the `return server` statement):

```typescript
server.tool(
  'traverse-graph',
  'Traverse the relationship graph from a starting node. Returns connected nodes within N hops, with edges showing how they are connected. Use direction to control whether to follow outgoing links, incoming links, or both.',
  {
    node_id: z.string()
      .describe("ID of the starting node (vault-relative path, e.g. 'projects/acme.md')"),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
      .describe("'outgoing': follow links FROM this node. 'incoming': follow links TO this node. 'both': follow both."),
    rel_types: z.array(z.string()).optional()
      .describe("Only traverse these relationship types, e.g. ['assignee', 'source']. Omit for all types."),
    target_types: z.array(z.string()).optional()
      .describe("Filter result nodes to those with at least one of these schema types. Does NOT affect traversal — all nodes are explored, but only matching types appear in the response."),
    max_depth: z.number().default(2)
      .describe("Maximum hops from the starting node (1-10). Default 2."),
  },
  async ({ node_id, direction, rel_types, target_types, max_depth }) => {
    try {
      const result = traverseGraph(db, {
        node_id,
        direction,
        rel_types,
        target_types,
        max_depth,
      });

      // Hydrate root
      const rootRow = db.prepare(
        'SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id = ?'
      ).get(result.root_id) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string };
      const [hydratedRoot] = hydrateNodes([rootRow]);

      // Hydrate discovered nodes (chunk IN clause for large result sets)
      let hydratedNodes: Array<Record<string, unknown>> = [];
      if (result.node_ids.length > 0) {
        const ids = result.node_ids.map(n => n.id);
        const nodeRows: Array<{ id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string }> = [];
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT id, file_path, node_type, title, content_text, content_md, updated_at
             FROM nodes WHERE id IN (${placeholders})`
          ).all(...chunk) as typeof nodeRows;
          nodeRows.push(...rows);
        }

        const hydrated = hydrateNodes(nodeRows);

        // Build depth lookup and attach depth to each hydrated node
        const depthMap = new Map(result.node_ids.map(n => [n.id, n.depth]));
        hydratedNodes = hydrated.map(n => ({
          ...n,
          depth: depthMap.get(n.id as string) ?? 0,
        }));
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            root: hydratedRoot,
            nodes: hydratedNodes,
            edges: result.edges,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts` (or the new test file)
Expected: PASS

- [ ] **Step 5: Add a test for the error case (node not found)**

```typescript
  it('returns error for nonexistent node', async () => {
    const result = await client.callTool({
      name: 'traverse-graph',
      arguments: { node_id: 'nonexistent.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
  });
}); // close describe('traverse-graph')
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run tests/mcp/`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add traverse-graph MCP tool"
```

---

### Task 5: End-to-end smoke test and full test suite run

**Files:**
- No new files — verification only

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass (including the known flaky mtime test — if it fails, re-run once).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify the graph module exports are clean**

Run: `node -e "import('./src/graph/index.js').then(m => console.log(Object.keys(m)))"`
Expected: Prints `['traverseGraph']` (or similar with type exports stripped).

Actually, since this is a TypeScript project, use:
Run: `npx tsx -e "import { traverseGraph } from './src/graph/index.js'; console.log(typeof traverseGraph)"`
Expected: `function`

- [ ] **Step 4: Commit any fixes if needed, otherwise done**

If any issues were found and fixed, commit them. Otherwise, Phase 5 graph traversal is complete.
