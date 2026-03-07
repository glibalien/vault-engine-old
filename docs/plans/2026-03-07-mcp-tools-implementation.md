# MCP Tools (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 4 read-only MCP tools (`get-node`, `query-nodes`, `get-recent`, `list-types`) as the final task of Phase 1.

**Architecture:** Single `src/mcp/server.ts` file exports `createServer(db)` which creates an `McpServer`, registers all 4 tools with direct SQL queries, and returns the server instance. `src/index.ts` entry point connects it to `StdioServerTransport`. Tests use `InMemoryTransport` + MCP `Client` to call tools through the protocol layer.

**Tech Stack:** `@modelcontextprotocol/sdk` (McpServer, Client, InMemoryTransport), `better-sqlite3`, `zod` (for tool input schemas)

---

### Task 1: `list-types` tool + test

The simplest tool — no parameters, one query. Good starting point to establish the server setup pattern.

**Files:**
- Create: `src/mcp/server.ts`
- Create: `tests/mcp/server.test.ts`

**Step 1: Write the failing test**

Create `tests/mcp/server.test.ts`:

```typescript
// tests/mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('MCP server', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('list-types', () => {
    it('returns empty array for empty database', async () => {
      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toEqual([]);
    });

    it('returns types with counts', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

      // meeting:1 (q1), person:1 (alice), task:2 (review + q1)
      const byName = new Map(data.map((d: { name: string; count: number }) => [d.name, d.count]));
      expect(byName.get('task')).toBe(2);
      expect(byName.get('meeting')).toBe(1);
      expect(byName.get('person')).toBe(1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `src/mcp/server.js` does not exist

**Step 3: Write minimal implementation**

Create `src/mcp/server.ts`:

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });

  server.tool(
    'list-types',
    'List all node types found in the vault with their counts',
    {},
    async () => {
      const rows = db.prepare(`
        SELECT schema_type AS name, COUNT(*) AS count
        FROM node_types
        GROUP BY schema_type
        ORDER BY schema_type
      `).all() as Array<{ name: string; count: number }>;

      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );

  return server;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add list-types MCP tool with tests"
```

---

### Task 2: `get-node` tool + tests

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/server.test.ts`

**Step 1: Write the failing tests**

Add to `tests/mcp/server.test.ts` inside the `describe('MCP server')` block:

```typescript
  describe('get-node', () => {
    it('returns node with types and fields', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md' },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.id).toBe('tasks/review.md');
      expect(data.file_path).toBe('tasks/review.md');
      expect(data.node_type).toBe('file');
      expect(data.types).toContain('task');
      expect(data.fields.status).toBe('todo');
      expect(data.fields.priority).toBe('high');
      expect(data.content_text).toContain('vendor');
      expect(data.content_md).toContain('vendor');
      expect(data.updated_at).toBeDefined();
    });

    it('returns error for nonexistent node', async () => {
      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'nonexistent.md' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Node not found');
    });

    it('includes relationships when requested', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md', include_relationships: true },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.relationships).toBeDefined();
      expect(data.relationships.length).toBeGreaterThan(0);
      // Should include outgoing wiki-links
      const targets = data.relationships.map((r: { target_id: string }) => r.target_id);
      expect(targets).toContain('Bob Jones');
      expect(targets).toContain('Q1 Planning Meeting');
    });

    it('omits relationships by default', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.relationships).toBeUndefined();
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `get-node` tool not registered

**Step 3: Write minimal implementation**

Add to `src/mcp/server.ts` inside `createServer`, before `return server`:

First, add a shared helper function at the top of `createServer` (before tool registrations):

```typescript
  // Shared helper: hydrate node rows with types and fields
  function hydrateNodes(
    nodeRows: Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>,
    opts?: { includeContentMd?: boolean },
  ) {
    if (nodeRows.length === 0) return [];

    const nodeIds = nodeRows.map(r => r.id);
    const placeholders = nodeIds.map(() => '?').join(',');

    const typeRows = db.prepare(
      `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

    const fieldRows = db.prepare(
      `SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

    const typesMap = new Map<string, string[]>();
    for (const row of typeRows) {
      const arr = typesMap.get(row.node_id) ?? [];
      arr.push(row.schema_type);
      typesMap.set(row.node_id, arr);
    }

    const fieldsMap = new Map<string, Record<string, string>>();
    for (const row of fieldRows) {
      const rec = fieldsMap.get(row.node_id) ?? {};
      rec[row.key] = row.value_text;
      fieldsMap.set(row.node_id, rec);
    }

    return nodeRows.map(row => {
      const node: Record<string, unknown> = {
        id: row.id,
        file_path: row.file_path,
        node_type: row.node_type,
        types: typesMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? {},
        content_text: row.content_text,
        updated_at: row.updated_at,
      };
      if (opts?.includeContentMd) {
        node.content_md = row.content_md;
      }
      return node;
    });
  }
```

Then register the `get-node` tool:

```typescript
  server.tool(
    'get-node',
    'Get full details of a specific node by its ID (vault-relative file path)',
    {
      node_id: z.string().describe('Vault-relative file path, e.g. "tasks/review.md"'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
    },
    async ({ node_id, include_relationships }) => {
      const row = db.prepare(`
        SELECT id, file_path, node_type, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(node_id) as { id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return {
          content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
          isError: true,
        };
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(node_id, node_id) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add get-node MCP tool with tests"
```

---

### Task 3: `get-recent` tool + tests

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/server.test.ts`

**Step 1: Write the failing tests**

Add to `tests/mcp/server.test.ts`:

```typescript
  describe('get-recent', () => {
    it('returns nodes ordered by updated_at descending', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(2);
      // Both have same mtime, so just check structure
      expect(data[0].id).toBeDefined();
      expect(data[0].types).toBeDefined();
      expect(data[0].fields).toBeDefined();
      // content_md should NOT be included (compact response)
      expect(data[0].content_md).toBeUndefined();
    });

    it('filters by schema_type', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: { schema_type: 'person' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('people/alice.md');
    });

    it('filters by since date', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      // The node's updated_at is set by SQLite datetime('now'), so use a past date
      const result = await client.callTool({
        name: 'get-recent',
        arguments: { since: '2020-01-01T00:00:00.000Z' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);

      // Future date should return nothing
      const result2 = await client.callTool({
        name: 'get-recent',
        arguments: { since: '2099-01-01T00:00:00.000Z' },
      });

      const data2 = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
      expect(data2).toHaveLength(0);
    });

    it('respects limit', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: { limit: 1 },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `get-recent` tool not registered

**Step 3: Write minimal implementation**

Add to `src/mcp/server.ts` inside `createServer`:

```typescript
  server.tool(
    'get-recent',
    'Get recently created or modified nodes',
    {
      schema_type: z.string().optional()
        .describe('Filter by schema type, e.g. "task", "meeting"'),
      since: z.string().optional()
        .describe('ISO date — only return nodes updated after this time'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({ schema_type, since, limit }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let joinType = '';

      if (schema_type) {
        joinType = 'JOIN node_types nt ON nt.node_id = n.id';
        conditions.push('nt.schema_type = ?');
        params.push(schema_type);
      }

      if (since) {
        conditions.push('n.updated_at > ?');
        params.push(since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const rows = db.prepare(`
        SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
        FROM nodes n
        ${joinType}
        ${where}
        ORDER BY n.updated_at DESC
        LIMIT ?
      `).all(...params) as Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>;

      const nodes = hydrateNodes(rows);
      return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
    },
  );
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add get-recent MCP tool with tests"
```

---

### Task 4: `query-nodes` tool + tests

The most complex tool — dynamic SQL with FTS, type filter, field equality, and ordering.

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/server.test.ts`

**Step 1: Write the failing tests**

Add to `tests/mcp/server.test.ts`:

```typescript
  describe('query-nodes', () => {
    it('returns error when no filter criteria provided', async () => {
      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('At least one');
    });

    it('queries by schema_type only', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'person' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('people/alice.md');
      expect(data[0].types).toContain('person');
      // content_md should NOT be included
      expect(data[0].content_md).toBeUndefined();
    });

    it('queries by full_text search', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { full_text: 'vendor' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/review.md');
    });

    it('combines schema_type and full_text', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      // Both have type "task", but only review has "vendor"
      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', full_text: 'vendor' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/review.md');
    });

    it('filters by field equality', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      // Both sample-task and sample-meeting have status: todo
      expect(data).toHaveLength(2);
    });

    it('combines schema_type and field filter', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          schema_type: 'meeting',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('meetings/q1.md');
    });

    it('returns empty array when filters match nothing', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          filters: [{ field: 'status', operator: 'eq', value: 'done' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toEqual([]);
    });

    it('respects limit', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', limit: 1 },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
    });

    it('supports order_by on updated_at', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', order_by: 'updated_at ASC' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(2);
      // Just verify both returned — ordering by updated_at with same insert time is deterministic by rowid
    });

    it('handles FTS5 syntax errors gracefully', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { full_text: '***invalid***' },
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `query-nodes` tool not registered

**Step 3: Write minimal implementation**

Add to `src/mcp/server.ts` inside `createServer`:

```typescript
  server.tool(
    'query-nodes',
    'Search for nodes by type, field values, and/or full text. At least one of schema_type, full_text, or filters is required.',
    {
      schema_type: z.string().optional()
        .describe('Schema type to filter by, e.g. "task", "project", "meeting"'),
      full_text: z.string().optional()
        .describe('Full-text search query (FTS5 syntax: supports "quoted phrases", prefix*, AND/OR)'),
      filters: z.array(z.object({
        field: z.string().describe('Field name, e.g. "status", "assignee"'),
        operator: z.enum(['eq']).describe('Comparison operator: eq (equals)'),
        value: z.string().describe('Value to compare against'),
      })).optional()
        .describe('Field equality filters'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
      order_by: z.string().optional()
        .describe('Sort field + direction, e.g. "updated_at DESC", "due_date ASC". Default: updated_at DESC (or FTS rank when full_text is used)'),
    },
    async ({ schema_type, full_text, filters, limit, order_by }) => {
      if (!schema_type && !full_text && (!filters || filters.length === 0)) {
        return {
          content: [{ type: 'text', text: 'Error: At least one of schema_type, full_text, or filters is required' }],
          isError: true,
        };
      }

      try {
        const joins: string[] = [];
        const conditions: string[] = [];
        const params: unknown[] = [];

        // FTS path
        let selectFrom: string;
        let defaultOrder: string;
        if (full_text) {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at, fts.rank
            FROM nodes_fts fts
            JOIN nodes n ON n.rowid = fts.rowid`;
          conditions.push('nodes_fts MATCH ?');
          params.push(full_text);
          defaultOrder = 'fts.rank';
        } else {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
            FROM nodes n`;
          defaultOrder = 'n.updated_at DESC';
        }

        // Type filter
        if (schema_type) {
          joins.push('JOIN node_types nt ON nt.node_id = n.id');
          conditions.push('nt.schema_type = ?');
          params.push(schema_type);
        }

        // Field equality filters
        if (filters) {
          for (let i = 0; i < filters.length; i++) {
            const alias = `f${i}`;
            joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);
            conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
            params.push(filters[i].field, filters[i].value);
          }
        }

        // Order by
        let orderClause: string;
        if (order_by && !full_text) {
          // Parse "field_name ASC" or "field_name DESC" or just "field_name"
          const parts = order_by.trim().split(/\s+/);
          const fieldName = parts[0];
          const direction = parts[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

          if (fieldName === 'updated_at') {
            orderClause = `n.updated_at ${direction}`;
          } else {
            // Order by a field value — join fields table
            joins.push('LEFT JOIN fields f_order ON f_order.node_id = n.id AND f_order.key = ?');
            params.push(fieldName);
            orderClause = `f_order.value_text ${direction}`;
          }
        } else {
          orderClause = defaultOrder;
        }

        params.push(limit);

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `${selectFrom}\n${joins.join('\n')}\n${where}\nORDER BY ${orderClause}\nLIMIT ?`;

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string; file_path: string; node_type: string;
          content_text: string; content_md: string | null; updated_at: string;
        }>;

        const nodes = hydrateNodes(rows);
        return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS (19 tests)

**Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "add query-nodes MCP tool with tests"
```

---

### Task 5: Entry point + type-check + full test run

Wire up `src/index.ts` as the stdio entry point, verify type-checking, run full test suite.

**Files:**
- Modify: `src/index.ts`

**Step 1: Write the entry point**

Replace the contents of `src/index.ts`:

```typescript
// src/index.ts
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/index.js';
import { createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');

const db = openDatabase(dbPath);
createSchema(db);

const server = createServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing tests + new MCP tests)

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "add stdio entry point for MCP server"
```

---

### Task 6: Update CLAUDE.md and project memory

**Files:**
- Modify: `CLAUDE.md` — add MCP layer docs to Architecture section
- Modify: memory files

**Step 1: Update CLAUDE.md**

Add a new subsection under Architecture:

```markdown
### MCP Layer (`src/mcp/`)

MCP server exposing read-only query tools over the indexed vault.

- **`server.ts`** — `createServer(db)` creates an `McpServer` with 4 tools registered. Returns the server instance (caller connects transport). Contains a `hydrateNodes` helper that batch-loads types and fields for node rows.
  - **`list-types`** — No params. Returns distinct types from `node_types` with counts.
  - **`get-node`** — Returns full node details by ID (vault-relative path). Optional `include_relationships` flag.
  - **`get-recent`** — Returns nodes ordered by `updated_at DESC`. Optional `schema_type` and `since` filters.
  - **`query-nodes`** — Structured search with optional `schema_type`, `full_text` (FTS5), field `filters` (equality), `order_by`, and `limit`. Dynamic SQL construction with bound parameters.
```

Also update the entry point description at the top:

```markdown
- **`src/index.ts`** — Entry point: opens DB, creates schema, starts MCP server over stdio transport.
```

**Step 2: Update memory**

Update MEMORY.md current status: Task 7 complete, Phase 1 complete.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "update CLAUDE.md with MCP layer docs"
```
