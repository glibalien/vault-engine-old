# Missed Use Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill 6 gaps in the MCP tool suite: bulk field updates, standalone delete, reference/relationship/path filtering, duplicate detection, and `get-recent` consolidation.

**Architecture:** All changes live in `src/mcp/server.ts` (tool registrations + SQL builders) with two new modules: `src/mcp/query-builder.ts` (extracted SQL builder shared between `query-nodes` and `update-node` query mode) and `src/mcp/duplicates.ts` (duplicate detection logic). Tests follow existing patterns using MCP client/server with in-memory transport.

**Tech Stack:** TypeScript ESM, better-sqlite3, Zod, vitest, MCP SDK (`@modelcontextprotocol/sdk`)

---

### Task 1: Extract Query Builder from `query-nodes`

The SQL construction logic in `query-nodes` (lines 1212–1315 of `src/mcp/server.ts`) needs to be reusable for the bulk-update query mode. Extract it into a shared function before adding new features.

**Files:**
- Create: `src/mcp/query-builder.ts`
- Create: `tests/mcp/query-builder.test.ts`
- Modify: `src/mcp/server.ts:1184-1328` (replace inline SQL with call to extracted builder)

- [ ] **Step 1: Write the failing test for the extracted query builder**

In `tests/mcp/query-builder.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { buildQuerySql } from '../../src/mcp/query-builder.js';

describe('buildQuerySql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  function seed(file: string, raw: string) {
    const parsed = parseFile(file, raw);
    indexFile(db, parsed, file, '2026-03-25T00:00:00.000Z', raw);
  }

  it('builds SQL for schema_type filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('people/b.md', '---\ntitle: B\ntypes: [person]\n---\n');

    const { sql, params } = buildQuerySql({ schema_type: 'task', limit: 20 });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('builds SQL for field eq filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: FAIL — `buildQuerySql` does not exist yet.

- [ ] **Step 3: Implement the query builder**

Create `src/mcp/query-builder.ts`:

```typescript
// src/mcp/query-builder.ts

export interface QueryFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';
  value: string | number | boolean | string[];
}

export interface QueryOptions {
  schema_type?: string;
  full_text?: string;
  filters?: QueryFilter[];
  order_by?: string;
  limit: number;
  since?: string;
  path_prefix?: string;
  references?: {
    target: string;
    rel_type?: string;
    direction?: 'outgoing' | 'incoming' | 'both';
  };
  resolvedTargetId?: string | null; // pre-resolved target for references filter
}

export interface QueryResult {
  sql: string;
  params: unknown[];
}

export function buildQuerySql(opts: QueryOptions): QueryResult {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  // FTS path
  let selectFrom: string;
  let defaultOrder: string;
  if (opts.full_text) {
    selectFrom = `
      SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.updated_at, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid`;
    conditions.push('nodes_fts MATCH ?');
    params.push(opts.full_text);
    defaultOrder = 'fts.rank';
  } else {
    selectFrom = `
      SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.updated_at
      FROM nodes n`;
    defaultOrder = 'n.updated_at DESC';
  }

  // Type filter
  if (opts.schema_type) {
    joins.push('JOIN node_types nt ON nt.node_id = n.id');
    conditions.push('nt.schema_type = ?');
    params.push(opts.schema_type);
  }

  // Field filters
  if (opts.filters) {
    for (let i = 0; i < opts.filters.length; i++) {
      const { field, operator, value } = opts.filters[i];
      const alias = `f${i}`;
      joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);

      switch (operator) {
        case 'eq':
          conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
          params.push(field, String(value));
          break;
        case 'neq':
          conditions.push(`${alias}.key = ? AND ${alias}.value_text != ?`);
          params.push(field, String(value));
          break;
        case 'gt':
        case 'lt':
        case 'gte':
        case 'lte': {
          const sqlOp = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[operator];
          conditions.push(
            `${alias}.key = ? AND CASE ${alias}.value_type ` +
            `WHEN 'number' THEN ${alias}.value_number ${sqlOp} ? ` +
            `WHEN 'date' THEN ${alias}.value_date ${sqlOp} ? ` +
            `ELSE ${alias}.value_text ${sqlOp} ? END`,
          );
          params.push(field, value, value, value);
          break;
        }
        case 'contains': {
          const escaped = String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          conditions.push(`${alias}.key = ? AND ${alias}.value_text LIKE '%' || ? || '%' ESCAPE '\\'`);
          params.push(field, escaped);
          break;
        }
        case 'in': {
          const vals = Array.isArray(value) ? value : [value];
          if (vals.length === 0) {
            conditions.push('0');
            break;
          }
          const placeholders = vals.map(() => '?').join(', ');
          conditions.push(`${alias}.key = ? AND ${alias}.value_text IN (${placeholders})`);
          params.push(field, ...vals.map(String));
          break;
        }
      }
    }
  }

  // Order by
  let orderClause: string;
  if (opts.order_by && !opts.full_text) {
    const parts = opts.order_by.trim().split(/\s+/);
    const fieldName = parts[0];
    const direction = parts[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    if (fieldName === 'updated_at') {
      orderClause = `n.updated_at ${direction}`;
    } else {
      joins.push('LEFT JOIN fields f_order ON f_order.node_id = n.id AND f_order.key = ?');
      params.push(fieldName);
      orderClause = `f_order.value_text ${direction}`;
    }
  } else {
    orderClause = defaultOrder;
  }

  params.push(opts.limit);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `${selectFrom}\n${joins.join('\n')}\n${where}\nORDER BY ${orderClause}\nLIMIT ?`;

  return { sql, params };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the extracted builder into `query-nodes`**

In `src/mcp/server.ts`, replace the inline SQL construction in the `query-nodes` handler (lines ~1212–1315) with a call to `buildQuerySql`. Add `import { buildQuerySql } from './query-builder.js';` at the top.

The handler becomes:

```typescript
async ({ schema_type, full_text, filters, limit, order_by }) => {
  if (!schema_type && !full_text && (!filters || filters.length === 0)) {
    return toolError('At least one of schema_type, full_text, or filters is required', 'VALIDATION_ERROR');
  }

  try {
    const { sql, params } = buildQuerySql({
      schema_type, full_text, filters, order_by, limit,
    });

    const rows = db.prepare(sql).all(...params) as Array<{
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    }>;

    const nodes = hydrateNodes(rows);
    return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
  }
},
```

- [ ] **Step 6: Run existing query-nodes tests to verify no regressions**

Run: `npx vitest run tests/mcp/query-operators.test.ts tests/mcp/server.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/query-builder.ts tests/mcp/query-builder.test.ts src/mcp/server.ts
git commit -m "refactor: extract query builder from query-nodes for reuse"
```

---

### Task 2: Bulk Field Updates on `update-node`

Add query mode to `update-node`: pass `query` instead of `node_id` to update multiple nodes at once. Includes `dry_run` mode.

**Files:**
- Modify: `src/mcp/server.ts:1455-1481` (update-node tool registration — new params + handler logic)
- Create: `tests/mcp/bulk-update.test.ts`

- [ ] **Step 1: Write failing tests for bulk update**

In `tests/mcp/bulk-update.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

function seedTasks(db: Database.Database, vaultPath: string) {
  const tasks = [
    { file: 'tasks/task-a.md', title: 'Task A', status: 'todo', priority: 'low' },
    { file: 'tasks/task-b.md', title: 'Task B', status: 'todo', priority: 'high' },
    { file: 'tasks/task-c.md', title: 'Task C', status: 'done', priority: 'low' },
  ];
  for (const t of tasks) {
    const raw = `---\ntitle: ${t.title}\ntypes: [task]\nstatus: ${t.status}\npriority: ${t.priority}\n---\n`;
    mkdirSync(join(vaultPath, 'tasks'), { recursive: true });
    writeFileSync(join(vaultPath, t.file), raw);
    const parsed = parseFile(t.file, raw);
    indexFile(db, parsed, t.file, '2026-03-25T00:00:00.000Z', raw);
  }
}

describe('update-node query mode (bulk update)', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-bulk-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    seedTasks(db, vaultPath);

    const server = createServer(db, vaultPath);
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
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function callUpdate(args: Record<string, unknown>) {
    return client.callTool({ name: 'update-node', arguments: args });
  }

  function parseResult(result: Awaited<ReturnType<typeof callUpdate>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('updates all matching nodes', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task', filters: [{ field: 'status', operator: 'eq', value: 'todo' }] },
      fields: { status: 'in-progress' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.updated).toBe(2);
    expect(data.nodes).toHaveLength(2);
    for (const node of data.nodes) {
      expect(node.fields.status).toBe('in-progress');
    }

    // Verify files on disk
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentA).toContain('status: in-progress');
    const contentB = readFileSync(join(vaultPath, 'tasks/task-b.md'), 'utf-8');
    expect(contentB).toContain('status: in-progress');
    // task-c should be unchanged (status: done)
    const contentC = readFileSync(join(vaultPath, 'tasks/task-c.md'), 'utf-8');
    expect(contentC).toContain('status: done');
  });

  it('dry_run returns matches without writing', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task', filters: [{ field: 'status', operator: 'eq', value: 'todo' }] },
      fields: { status: 'in-progress' },
      dry_run: true,
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.matched).toBe(2);
    expect(data.nodes).toHaveLength(2);

    // Files unchanged
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentA).toContain('status: todo');
  });

  it('errors when both node_id and query provided', async () => {
    const result = await callUpdate({
      node_id: 'tasks/task-a.md',
      query: { schema_type: 'task' },
      fields: { status: 'done' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('mutually exclusive');
  });

  it('errors when body provided with query', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task' },
      fields: { status: 'done' },
      body: 'new body',
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('body');
  });

  it('errors when append_body provided with query', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task' },
      fields: { status: 'done' },
      append_body: 'extra',
    });

    expect(result.isError).toBe(true);
  });

  it('errors when title provided with query', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task' },
      fields: { status: 'done' },
      title: 'New Title',
    });

    expect(result.isError).toBe(true);
  });

  it('errors when types provided with query', async () => {
    const result = await callUpdate({
      query: { schema_type: 'task' },
      fields: { status: 'done' },
      types: ['project'],
    });

    expect(result.isError).toBe(true);
  });

  it('errors when query has no schema_type or filters', async () => {
    const result = await callUpdate({
      query: {},
      fields: { status: 'done' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('At least one');
  });

  it('rolls back all files on error', async () => {
    // Simulate error by deleting a file that the query will match
    const contentA = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    rmSync(join(vaultPath, 'tasks/task-b.md')); // task-b matched but missing on disk

    const result = await callUpdate({
      query: { schema_type: 'task', filters: [{ field: 'status', operator: 'eq', value: 'todo' }] },
      fields: { status: 'in-progress' },
    });

    expect(result.isError).toBe(true);

    // task-a should be rolled back to original
    const contentAfter = readFileSync(join(vaultPath, 'tasks/task-a.md'), 'utf-8');
    expect(contentAfter).toBe(contentA);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/bulk-update.test.ts`
Expected: FAIL — query mode not implemented yet.

- [ ] **Step 3: Implement bulk update in server.ts**

In `src/mcp/server.ts`, modify the `update-node` tool registration (around line 1455):

1. Add new params to the Zod schema:

```typescript
query: z.object({
  schema_type: z.string().min(1).optional(),
  filters: z.array(z.object({
    field: z.string().min(1),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in']).default('eq'),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  })).optional(),
}).optional()
  .describe('Query to select multiple nodes for bulk field update. Mutually exclusive with node_id.'),
dry_run: z.boolean().optional().default(false)
  .describe('When true with query mode, returns matched nodes without writing changes.'),
```

2. Replace the handler with:

```typescript
async (params) => {
  const { node_id, query, fields: fieldUpdates, body, append_body, types, title, dry_run } = params;

  // Mutual exclusion: node_id vs query
  if (node_id && query) {
    return toolError('node_id and query are mutually exclusive — provide one or the other', 'VALIDATION_ERROR');
  }

  // Single-node mode (existing behavior)
  if (node_id) {
    if (hasPathTraversal(node_id)) {
      return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
    }
    try {
      return updateNode({ node_id, fields: fieldUpdates, body, append_body, types, title });
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
    }
  }

  // Query mode (bulk update)
  if (!query) {
    return toolError('Either node_id or query is required', 'VALIDATION_ERROR');
  }

  // Validate query mode constraints
  if (body !== undefined) {
    return toolError('body is not allowed in query mode — bulk updates are field-only', 'VALIDATION_ERROR');
  }
  if (append_body !== undefined) {
    return toolError('append_body is not allowed in query mode — bulk updates are field-only', 'VALIDATION_ERROR');
  }
  if (title !== undefined) {
    return toolError('title is not allowed in query mode — use single-node update or rename-node', 'VALIDATION_ERROR');
  }
  if (types !== undefined) {
    return toolError('types is not allowed in query mode — use single-node update', 'VALIDATION_ERROR');
  }
  if (!fieldUpdates) {
    return toolError('fields is required in query mode', 'VALIDATION_ERROR');
  }
  if (!query.schema_type && (!query.filters || query.filters.length === 0)) {
    return toolError('At least one of schema_type or filters is required in query', 'VALIDATION_ERROR');
  }

  try {
    // Resolve matching nodes
    const { sql, params: queryParams } = buildQuerySql({
      schema_type: query.schema_type,
      filters: query.filters,
      limit: 10000, // generous upper bound
    });

    const matchedRows = db.prepare(sql).all(...queryParams) as Array<{
      id: string; file_path: string; node_type: string; title: string | null;
      content_text: string; content_md: string | null; updated_at: string;
    }>;

    if (matchedRows.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ updated: 0, nodes: [], warnings: [] }) }] };
    }

    // Dry run: return matches without writing
    if (dry_run) {
      const nodes = hydrateNodes(matchedRows);
      return { content: [{ type: 'text', text: JSON.stringify({ matched: matchedRows.length, nodes }) }] };
    }

    // Wet run: update all matched nodes with file rollback
    const fileSnapshots = new Map<string, string>();
    const deferredLocks = new Set<string>();

    // Snapshot all files before any writes
    for (const row of matchedRows) {
      const absPath = join(vaultPath, row.id);
      if (existsSync(absPath)) {
        fileSnapshots.set(row.id, readFileSync(absPath, 'utf-8'));
      }
    }

    function rollbackFiles() {
      for (const [relativePath, originalContent] of fileSnapshots) {
        try { writeNodeFile(vaultPath, relativePath, originalContent); } catch { /* best effort */ }
      }
    }

    try {
      const batchResult = db.transaction(() => {
        const allWarnings: unknown[] = [];

        for (const row of matchedRows) {
          const result = updateNodeInner({ node_id: row.id, fields: fieldUpdates }, deferredLocks);
          if (result.isError) {
            throw new Error(`Failed to update ${row.id}: ${result.content[0].text}`);
          }
          const parsed = JSON.parse(result.content[0].text);
          if (parsed.warnings?.length > 0) {
            allWarnings.push(...parsed.warnings);
          }
        }

        resolveReferences(db);

        // Re-read all updated nodes
        const updatedRows = db.prepare(
          `SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id IN (${matchedRows.map(() => '?').join(',')})`
        ).all(...matchedRows.map(r => r.id)) as typeof matchedRows;

        const nodes = hydrateNodes(updatedRows);
        return { updated: matchedRows.length, nodes, warnings: allWarnings };
      })();

      return { content: [{ type: 'text', text: JSON.stringify(batchResult) }] };
    } catch (err) {
      rollbackFiles();
      return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
    } finally {
      for (const lockedPath of deferredLocks) {
        releaseWriteLock(lockedPath);
      }
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
  }
},
```

Also make `node_id` optional in the Zod schema (currently required):

```typescript
node_id: z.string().min(1).optional().describe('Vault-relative file path of the node to update. Mutually exclusive with query.'),
```

- [ ] **Step 4: Run all update-node tests to verify they pass**

Run: `npx vitest run tests/mcp/bulk-update.test.ts tests/mcp/update-node.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/bulk-update.test.ts
git commit -m "feat: add query mode to update-node for bulk field updates"
```

---

### Task 3: Standalone `delete-node` Tool

Wrap `deleteNodeInner` as a standalone tool.

**Files:**
- Modify: `src/mcp/server.ts` (add tool registration after existing mutation tools)
- Create: `tests/mcp/delete-node.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/mcp/delete-node.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('delete-node', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-del-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultPath);
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
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('deletes a node and its file', async () => {
    await createTestNode({ title: 'Doomed', types: ['task'], fields: { status: 'todo' } });
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(true);

    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'Doomed.md' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node_id).toBe('Doomed.md');
    expect(data.deleted).toBe(true);

    // File gone
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(false);

    // DB row gone
    const dbRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Doomed.md');
    expect(dbRow).toBeUndefined();
  });

  it('clears stale resolved_target_id after delete', async () => {
    await createTestNode({ title: 'Target', types: ['person'] });
    await createTestNode({
      title: 'Source',
      types: ['task'],
      fields: { assignee: '[[Target]]' },
    });

    // Before delete: relationship should be resolved
    const relBefore = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('Source.md') as { resolved_target_id: string | null } | undefined;
    expect(relBefore?.resolved_target_id).toBe('Target.md');

    // Delete target
    await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'Target.md' },
    });

    // After delete: resolved_target_id should be cleared
    const relAfter = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('Source.md') as { resolved_target_id: string | null } | undefined;
    expect(relAfter?.resolved_target_id).toBeNull();
  });

  it('returns error for nonexistent node', async () => {
    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: 'ghost.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
  });

  it('rejects path traversal', async () => {
    const result = await client.callTool({
      name: 'delete-node',
      arguments: { node_id: '../escape.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('path traversal');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/delete-node.test.ts`
Expected: FAIL — `delete-node` tool not registered.

- [ ] **Step 3: Register the `delete-node` tool**

In `src/mcp/server.ts`, add after the `batch-mutate` tool registration (around line 1540):

```typescript
server.tool(
  'delete-node',
  'Delete a node and its file from the vault. Incoming references in other files become broken links.',
  {
    node_id: z.string().min(1).describe('Vault-relative file path of the node to delete, e.g. "tasks/review.md"'),
  },
  async ({ node_id }) => {
    if (hasPathTraversal(node_id)) {
      return toolError('Invalid node_id: path traversal segments ("..") are not allowed', 'VALIDATION_ERROR');
    }
    try {
      return db.transaction(() => {
        const result = deleteNodeInner({ node_id });
        if (!result.isError) resolveReferences(db);
        return result;
      })();
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
    }
  },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/delete-node.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/delete-node.test.ts
git commit -m "feat: add standalone delete-node tool"
```

---

### Task 4: Fix Reference Field Filtering in `query-nodes`

Make `eq`, `neq`, `contains`, and `in` operators reference-aware so that filtering by `"Bob Jones"` matches `value_text = "[[Bob Jones]]"`.

**Files:**
- Modify: `src/mcp/query-builder.ts` (update operator SQL generation)
- Create: `tests/mcp/query-reference-filter.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/mcp/query-reference-filter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

function seedWithReferences(db: Database.Database, vaultPath: string) {
  const files = [
    {
      file: 'tasks/task-a.md',
      raw: '---\ntitle: Task A\ntypes: [task]\nassignee: "[[Alice]]"\nstatus: todo\n---\n',
    },
    {
      file: 'tasks/task-b.md',
      raw: '---\ntitle: Task B\ntypes: [task]\nassignee: "[[Bob]]"\nstatus: done\n---\n',
    },
    {
      file: 'meetings/standup.md',
      raw: '---\ntitle: Standup\ntypes: [meeting]\nattendees:\n  - "[[Alice]]"\n  - "[[Bob]]"\n---\n',
    },
  ];
  for (const f of files) {
    const dir = join(vaultPath, f.file, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vaultPath, f.file), f.raw);
    const parsed = parseFile(f.file, f.raw);
    indexFile(db, parsed, f.file, '2026-03-25T00:00:00.000Z', f.raw);
  }
}

describe('query-nodes reference field filtering', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-ref-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    seedWithReferences(db, vaultPath);

    const server = createServer(db, vaultPath);
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
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function callQuery(args: Record<string, unknown>) {
    return client.callTool({ name: 'query-nodes', arguments: args });
  }

  function parseResult(result: Awaited<ReturnType<typeof callQuery>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('eq: matches reference field without brackets', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'eq', value: 'Alice' }],
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  it('eq: still matches non-reference fields normally', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  it('neq: excludes matching reference field', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'neq', value: 'Alice' }],
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-b.md');
  });

  it('contains: finds reference inside list field', async () => {
    const result = await callQuery({
      filters: [{ field: 'attendees', operator: 'contains', value: 'Alice' }],
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('meetings/standup.md');
  });

  it('in: matches reference field values', async () => {
    const result = await callQuery({
      schema_type: 'task',
      filters: [{ field: 'assignee', operator: 'in', value: ['Alice', 'Charlie'] }],
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/query-reference-filter.test.ts`
Expected: FAIL — `eq` filter by `"Alice"` won't match `"[[Alice]]"` stored in `value_text`.

- [ ] **Step 3: Update query builder with reference-aware operators**

In `src/mcp/query-builder.ts`, update the operator cases:

**`eq`:**
```typescript
case 'eq':
  conditions.push(
    `${alias}.key = ? AND CASE ${alias}.value_type ` +
    `WHEN 'reference' THEN REPLACE(REPLACE(${alias}.value_text, '[[', ''), ']]', '') ` +
    `ELSE ${alias}.value_text END = ?`,
  );
  params.push(field, String(value));
  break;
```

**`neq`:**
```typescript
case 'neq':
  conditions.push(
    `${alias}.key = ? AND CASE ${alias}.value_type ` +
    `WHEN 'reference' THEN REPLACE(REPLACE(${alias}.value_text, '[[', ''), ']]', '') ` +
    `ELSE ${alias}.value_text END != ?`,
  );
  params.push(field, String(value));
  break;
```

**`contains`:**
```typescript
case 'contains': {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  conditions.push(
    `${alias}.key = ? AND (${alias}.value_text LIKE '%' || ? || '%' ESCAPE '\\' ` +
    `OR (${alias}.value_type = 'list' AND ${alias}.value_text LIKE '%[[' || ? || ']]%'))`,
  );
  params.push(field, escaped, escaped);
  break;
}
```

**`in`:**
```typescript
case 'in': {
  const vals = Array.isArray(value) ? value : [value];
  if (vals.length === 0) {
    conditions.push('0');
    break;
  }
  const placeholders = vals.map(() => '?').join(', ');
  conditions.push(
    `${alias}.key = ? AND CASE ${alias}.value_type ` +
    `WHEN 'reference' THEN REPLACE(REPLACE(${alias}.value_text, '[[', ''), ']]', '') ` +
    `ELSE ${alias}.value_text END IN (${placeholders})`,
  );
  params.push(field, ...vals.map(String));
  break;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-reference-filter.test.ts tests/mcp/query-operators.test.ts`
Expected: All PASS (new tests + no regressions on existing operator tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/query-builder.ts tests/mcp/query-reference-filter.test.ts
git commit -m "fix: make query-nodes field filters reference-aware (strip [[]] for comparison)"
```

---

### Task 5: Add `references` Filter to `query-nodes`

New param on `query-nodes` that JOINs the `relationships` table to filter by linked nodes.

**Files:**
- Modify: `src/mcp/query-builder.ts` (add references JOIN logic)
- Modify: `src/mcp/server.ts` (add `references` param to Zod schema, resolve target before calling builder)
- Add tests to: `tests/mcp/query-reference-filter.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/mcp/query-reference-filter.test.ts`, inside the existing `describe` block (after the `in` test):

```typescript
describe('references filter', () => {
  it('outgoing: finds nodes that link to a target', async () => {
    const result = await callQuery({
      references: { target: 'Alice' },
    });

    const data = parseResult(result);
    // task-a (assignee: [[Alice]]) and standup (attendees includes [[Alice]])
    const ids = data.map((n: { id: string }) => n.id).sort();
    expect(ids).toContain('tasks/task-a.md');
    expect(ids).toContain('meetings/standup.md');
  });

  it('outgoing with rel_type: narrows by relationship type', async () => {
    const result = await callQuery({
      references: { target: 'Alice', rel_type: 'assignee' },
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });

  it('incoming: finds nodes that a source links to', async () => {
    const result = await callQuery({
      references: { target: 'tasks/task-a.md', direction: 'incoming' },
    });

    // task-a links to Alice via assignee
    const data = parseResult(result);
    // Incoming means: find nodes where task-a.md is the source → the targets
    // But targets may not be nodes in the DB. This may return empty if Alice isn't indexed.
    // With our seed data: Alice is not a node, so incoming on task-a finds nothing resolvable.
    // Let's test with standup which links to Alice and Bob (neither are nodes).
    // Better test: incoming on Alice should find task-a and standup since they link TO Alice.
    // Wait — incoming means "source links TO these results" — i.e. result nodes are targets.
    // Actually per spec: incoming = "find nodes that this target links TO" = target is the source.
    // So if target = "tasks/task-a.md" (a real node ID), find nodes that task-a links to.
    // task-a links to Alice (unresolved). Alice is not a node. So empty result.
    expect(data).toHaveLength(0);
  });

  it('composable with schema_type', async () => {
    const result = await callQuery({
      schema_type: 'task',
      references: { target: 'Alice' },
    });

    const data = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tasks/task-a.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/query-reference-filter.test.ts`
Expected: FAIL — `references` param not recognized.

- [ ] **Step 3: Add references support to the query builder**

In `src/mcp/query-builder.ts`, add after the field filters block and before the order-by block:

```typescript
// Since filter
if (opts.since) {
  conditions.push('n.updated_at > ?');
  params.push(opts.since);
}

// Path prefix filter
if (opts.path_prefix) {
  const prefix = opts.path_prefix.endsWith('/') ? opts.path_prefix : opts.path_prefix + '/';
  conditions.push('n.id LIKE ? || \'%\'');
  params.push(prefix);
}

// References filter
if (opts.references) {
  const ref = opts.references;
  const direction = ref.direction ?? 'outgoing';
  const resolvedId = opts.resolvedTargetId;
  const rawTarget = ref.target;

  if (direction === 'outgoing') {
    let refJoin = 'JOIN relationships r_ref ON r_ref.source_id = n.id AND (';
    if (resolvedId) {
      refJoin += 'r_ref.resolved_target_id = ? OR (r_ref.resolved_target_id IS NULL AND LOWER(r_ref.target_id) = LOWER(?))';
      params.push(resolvedId, rawTarget);
    } else {
      refJoin += 'LOWER(r_ref.target_id) = LOWER(?)';
      params.push(rawTarget);
    }
    refJoin += ')';
    if (ref.rel_type) {
      refJoin += ' AND r_ref.rel_type = ?';
      params.push(ref.rel_type);
    }
    joins.push(refJoin);
  } else if (direction === 'incoming') {
    // Find nodes that the target (as source) links to
    // resolvedId here is the source node's ID
    const sourceId = resolvedId ?? rawTarget;
    let refJoin = 'JOIN relationships r_ref ON r_ref.source_id = ? AND r_ref.resolved_target_id = n.id';
    params.push(sourceId);
    if (ref.rel_type) {
      refJoin += ' AND r_ref.rel_type = ?';
      params.push(ref.rel_type);
    }
    joins.push(refJoin);
  } else {
    // both: use EXISTS with OR
    let existsClause = 'EXISTS (SELECT 1 FROM relationships r_ref WHERE ';
    const existsParams: unknown[] = [];

    if (resolvedId) {
      existsClause += '(r_ref.source_id = n.id AND (r_ref.resolved_target_id = ? OR (r_ref.resolved_target_id IS NULL AND LOWER(r_ref.target_id) = LOWER(?))))';
      existsParams.push(resolvedId, rawTarget);
      existsClause += ' OR (r_ref.source_id = ? AND r_ref.resolved_target_id = n.id)';
      existsParams.push(resolvedId);
    } else {
      existsClause += '(r_ref.source_id = n.id AND LOWER(r_ref.target_id) = LOWER(?))';
      existsParams.push(rawTarget);
    }

    if (ref.rel_type) {
      existsClause = existsClause.replace('SELECT 1 FROM relationships r_ref WHERE ',
        `SELECT 1 FROM relationships r_ref WHERE r_ref.rel_type = ? AND (`);
      existsParams.unshift(ref.rel_type);
      existsClause += ')';
    }
    existsClause += ')';
    conditions.push(existsClause);
    params.push(...existsParams);
  }
}
```

- [ ] **Step 4: Add `references` param to `query-nodes` Zod schema in server.ts**

In the `query-nodes` tool registration, add to the params object:

```typescript
references: z.object({
  target: z.string().min(1).describe('Node title or ID to find relationships for'),
  rel_type: z.string().min(1).optional().describe('Filter by relationship type (field name or "wiki-link")'),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('outgoing')
    .describe('outgoing = nodes linking TO target; incoming = nodes target links TO; both = either'),
}).optional()
  .describe('Filter by relationship — find nodes connected to a target node'),
```

Update the handler to resolve the target before calling `buildQuerySql`:

```typescript
// Resolve references target
let resolvedTargetId: string | null = null;
if (references) {
  // Try exact node ID first
  const exactMatch = db.prepare('SELECT id FROM nodes WHERE id = ?').get(references.target) as { id: string } | undefined;
  if (exactMatch) {
    resolvedTargetId = exactMatch.id;
  } else {
    resolvedTargetId = resolveTarget(db, references.target);
  }
}

const { sql, params } = buildQuerySql({
  schema_type, full_text, filters, order_by, limit,
  references,
  resolvedTargetId,
});
```

Add `import { resolveTarget } from '../sync/resolver.js';` if not already imported (it's already imported as part of the existing imports on line 18).

Update the validation check to accept `references` as a sufficient filter:

```typescript
if (!schema_type && !full_text && (!filters || filters.length === 0) && !references) {
  return toolError('At least one of schema_type, full_text, filters, or references is required', 'VALIDATION_ERROR');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-reference-filter.test.ts tests/mcp/query-operators.test.ts tests/mcp/server.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/query-builder.ts src/mcp/server.ts tests/mcp/query-reference-filter.test.ts
git commit -m "feat: add references filter to query-nodes for relationship-based queries"
```

---

### Task 6: Add `path_prefix` and `since` Filters to `query-nodes`

Two small additions to `query-nodes`. The `since` filter also prepares for `get-recent` removal.

**Files:**
- Modify: `src/mcp/query-builder.ts` (already has placeholders from Task 5 — `since` and `path_prefix` were added in Step 3)
- Modify: `src/mcp/server.ts` (add params to Zod schema, update validation)
- Add tests to: `tests/mcp/query-operators.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/mcp/query-operators.test.ts`, inside the existing `describe` block:

```typescript
it('path_prefix: filters nodes by folder', async () => {
  // seedTasks already puts everything in tasks/
  const result = await callQuery({ path_prefix: 'tasks/' });
  const data = parseResult(result);
  expect(data).toHaveLength(4); // all 4 seed tasks
});

it('path_prefix: appends trailing slash if missing', async () => {
  const result = await callQuery({ path_prefix: 'tasks' });
  const data = parseResult(result);
  expect(data).toHaveLength(4);
});

it('path_prefix: no matches for nonexistent folder', async () => {
  const result = await callQuery({ path_prefix: 'meetings/' });
  const data = parseResult(result);
  expect(data).toHaveLength(0);
});

it('since: filters by updated_at', async () => {
  // All seed tasks have updated_at set by SQLite datetime('now')
  const result = await callQuery({
    schema_type: 'task',
    since: '2020-01-01T00:00:00.000Z',
  });
  const data = parseResult(result);
  expect(data).toHaveLength(4);

  const result2 = await callQuery({
    schema_type: 'task',
    since: '2099-01-01T00:00:00.000Z',
  });
  const data2 = parseResult(result2);
  expect(data2).toHaveLength(0);
});

it('since: is sufficient as a standalone filter (no schema_type required)', async () => {
  const result = await callQuery({
    since: '2020-01-01T00:00:00.000Z',
  });
  expect(result.isError).toBeFalsy();
  const data = parseResult(result);
  expect(data).toHaveLength(4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/query-operators.test.ts`
Expected: FAIL — `path_prefix` and `since` not recognized by Zod.

- [ ] **Step 3: Add params to `query-nodes` Zod schema in server.ts**

Add to the `query-nodes` params object:

```typescript
since: z.string().min(1).optional()
  .describe('ISO date — only return nodes updated after this time, e.g. "2026-03-27T00:00:00Z"'),
path_prefix: z.string().min(1).optional()
  .describe('Filter by folder path prefix, e.g. "Meetings/" or "projects/acme/"'),
```

Update the validation check:

```typescript
if (!schema_type && !full_text && (!filters || filters.length === 0) && !references && !since && !path_prefix) {
  return toolError('At least one of schema_type, full_text, filters, references, since, or path_prefix is required', 'VALIDATION_ERROR');
}
```

Pass the new params to `buildQuerySql`:

```typescript
const { sql, params } = buildQuerySql({
  schema_type, full_text, filters, order_by, limit,
  since, path_prefix,
  references,
  resolvedTargetId,
});
```

- [ ] **Step 4: Verify the `since` and `path_prefix` SQL in query-builder.ts**

The SQL for both was already added in Task 5 Step 3 as part of the references implementation. Verify the code is present in `src/mcp/query-builder.ts`:

- `since`: `conditions.push('n.updated_at > ?')` with `params.push(opts.since)`
- `path_prefix`: normalizes trailing slash, then `conditions.push('n.id LIKE ? || \'%\'')` with `params.push(prefix)`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-operators.test.ts tests/mcp/server.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/query-builder.ts tests/mcp/query-operators.test.ts
git commit -m "feat: add path_prefix and since filters to query-nodes"
```

---

### Task 7: Duplicate Detection — `find-duplicates` Tool

New module for title similarity detection with optional field overlap scoring.

**Files:**
- Create: `src/mcp/duplicates.ts`
- Create: `tests/mcp/duplicates.test.ts`
- Modify: `src/mcp/server.ts` (register tool)

- [ ] **Step 1: Write failing tests for the core detection logic**

In `tests/mcp/duplicates.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { findDuplicates } from '../../src/mcp/duplicates.js';

describe('findDuplicates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  function seed(file: string, raw: string) {
    const parsed = parseFile(file, raw);
    indexFile(db, parsed, file, '2026-03-25T00:00:00.000Z', raw);
  }

  it('finds exact title duplicates', () => {
    seed('meetings/standup.md', '---\ntitle: Weekly Standup\ntypes: [meeting]\n---\n');
    seed('meetings/standup-2.md', '---\ntitle: Weekly Standup\ntypes: [meeting]\n---\n');
    seed('tasks/review.md', '---\ntitle: Review\ntypes: [task]\n---\n');

    const result = findDuplicates(db, {});
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].similarity).toBe(1.0);
    expect(result.groups[0].nodes).toHaveLength(2);
    const ids = result.groups[0].nodes.map(n => n.id).sort();
    expect(ids).toEqual(['meetings/standup-2.md', 'meetings/standup.md']);
  });

  it('finds near-match title duplicates', () => {
    seed('a.md', '---\ntitle: Weekly Standup\ntypes: [meeting]\n---\n');
    seed('b.md', '---\ntitle: Weekly Stand-up\ntypes: [meeting]\n---\n');

    const result = findDuplicates(db, { threshold: 0.8 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('filters by schema_type', () => {
    seed('meetings/a.md', '---\ntitle: Standup\ntypes: [meeting]\n---\n');
    seed('meetings/b.md', '---\ntitle: Standup\ntypes: [meeting]\n---\n');
    seed('tasks/a.md', '---\ntitle: Standup\ntypes: [task]\n---\n');

    const result = findDuplicates(db, { schema_type: 'meeting' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].nodes).toHaveLength(2);
    // Only meeting nodes, not the task
    for (const node of result.groups[0].nodes) {
      expect(node.types).toContain('meeting');
    }
  });

  it('respects limit', () => {
    // Create 3 groups of duplicates
    seed('a1.md', '---\ntitle: Alpha\n---\n');
    seed('a2.md', '---\ntitle: Alpha\n---\n');
    seed('b1.md', '---\ntitle: Beta\n---\n');
    seed('b2.md', '---\ntitle: Beta\n---\n');
    seed('c1.md', '---\ntitle: Gamma\n---\n');
    seed('c2.md', '---\ntitle: Gamma\n---\n');

    const result = findDuplicates(db, { limit: 2 });
    expect(result.groups).toHaveLength(2);
    expect(result.total_groups).toBe(3);
  });

  it('returns empty when no duplicates', () => {
    seed('a.md', '---\ntitle: Unique A\n---\n');
    seed('b.md', '---\ntitle: Unique B\n---\n');

    const result = findDuplicates(db, {});
    expect(result.groups).toHaveLength(0);
  });

  it('includes field overlap when include_fields is true', () => {
    seed('a.md', '---\ntitle: Standup\ntypes: [meeting]\nstatus: active\n---\n');
    seed('b.md', '---\ntitle: Standup\ntypes: [meeting]\nstatus: active\n---\n');

    const result = findDuplicates(db, { include_fields: true });
    expect(result.groups).toHaveLength(1);
    // With identical fields, combined score should be very high
    expect(result.groups[0].similarity).toBeGreaterThanOrEqual(0.9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/duplicates.test.ts`
Expected: FAIL — `findDuplicates` does not exist.

- [ ] **Step 3: Implement the duplicates module**

Create `src/mcp/duplicates.ts`:

```typescript
// src/mcp/duplicates.ts
import type Database from 'better-sqlite3';

export interface DuplicateNode {
  id: string;
  title: string;
  types: string[];
}

export interface DuplicateGroup {
  similarity: number;
  reason: string;
  nodes: DuplicateNode[];
}

export interface DuplicateResult {
  groups: DuplicateGroup[];
  total_groups: number;
}

export interface DuplicateOptions {
  schema_type?: string;
  include_fields?: boolean;
  threshold?: number;
  limit?: number;
}

function normalize(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ');   // collapse whitespace
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

export function findDuplicates(db: Database.Database, opts: DuplicateOptions): DuplicateResult {
  const threshold = opts.threshold ?? 0.8;
  const limit = opts.limit ?? 50;

  // Load nodes
  let sql = 'SELECT n.id, n.title FROM nodes n';
  const params: unknown[] = [];
  if (opts.schema_type) {
    sql += ' JOIN node_types nt ON nt.node_id = n.id WHERE nt.schema_type = ?';
    params.push(opts.schema_type);
  }
  const rows = db.prepare(sql).all(...params) as Array<{ id: string; title: string | null }>;

  // Normalize titles and group
  const entries = rows
    .filter(r => r.title !== null)
    .map(r => ({ id: r.id, title: r.title!, normalized: normalize(r.title!) }));

  // Load types for all nodes
  const typeRows = db.prepare(
    'SELECT node_id, schema_type FROM node_types'
  ).all() as Array<{ node_id: string; schema_type: string }>;
  const typesMap = new Map<string, string[]>();
  for (const r of typeRows) {
    const arr = typesMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    typesMap.set(r.node_id, arr);
  }

  // Phase 1: Exact matches — group by normalized title
  const exactGroups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = exactGroups.get(entry.normalized) ?? [];
    group.push(entry);
    exactGroups.set(entry.normalized, group);
  }

  const groups: DuplicateGroup[] = [];
  const usedIds = new Set<string>(); // track IDs already in a group

  for (const [, group] of exactGroups) {
    if (group.length >= 2) {
      groups.push({
        similarity: 1.0,
        reason: 'identical normalized title',
        nodes: group.map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
      });
      for (const e of group) usedIds.add(e.id);
    }
  }

  // Phase 2: Near-matches — bucket by first 3 chars for performance
  const remaining = entries.filter(e => !usedIds.has(e.id));
  const buckets = new Map<string, typeof entries>();
  for (const entry of remaining) {
    const key = entry.normalized.slice(0, 3);
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }

  const bucketKeys = [...buckets.keys()].sort();
  const checkedPairs = new Set<string>();

  for (let bi = 0; bi < bucketKeys.length; bi++) {
    const bucket = buckets.get(bucketKeys[bi])!;
    // Compare within bucket
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const pairKey = [bucket[i].id, bucket[j].id].sort().join('|');
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        const sim = titleSimilarity(bucket[i].normalized, bucket[j].normalized);
        if (sim >= threshold && sim < 1.0) {
          groups.push({
            similarity: Math.round(sim * 100) / 100,
            reason: 'similar title',
            nodes: [bucket[i], bucket[j]].map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
          });
        }
      }
    }
    // Compare with adjacent bucket
    if (bi + 1 < bucketKeys.length) {
      const nextBucket = buckets.get(bucketKeys[bi + 1])!;
      for (const a of bucket) {
        for (const b of nextBucket) {
          const pairKey = [a.id, b.id].sort().join('|');
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);

          const sim = titleSimilarity(a.normalized, b.normalized);
          if (sim >= threshold && sim < 1.0) {
            groups.push({
              similarity: Math.round(sim * 100) / 100,
              reason: 'similar title',
              nodes: [a, b].map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
            });
          }
        }
      }
    }
  }

  // Phase 3: Field overlap refinement
  if (opts.include_fields) {
    const fieldRows = db.prepare(
      'SELECT node_id, key, value_text FROM fields'
    ).all() as Array<{ node_id: string; key: string; value_text: string }>;
    const fieldsMap = new Map<string, Map<string, string>>();
    for (const r of fieldRows) {
      const m = fieldsMap.get(r.node_id) ?? new Map();
      m.set(r.key, r.value_text);
      fieldsMap.set(r.node_id, m);
    }

    for (const group of groups) {
      if (group.nodes.length !== 2) continue; // field overlap only for pairs
      const [a, b] = group.nodes;
      const fieldsA = fieldsMap.get(a.id) ?? new Map();
      const fieldsB = fieldsMap.get(b.id) ?? new Map();

      const allKeys = new Set([...fieldsA.keys(), ...fieldsB.keys()]);
      if (allKeys.size === 0) continue;

      let intersection = 0;
      for (const key of allKeys) {
        if (fieldsA.get(key) === fieldsB.get(key)) intersection++;
      }
      const jaccard = intersection / allKeys.size;
      group.similarity = Math.round((0.7 * group.similarity + 0.3 * jaccard) * 100) / 100;
    }

    // Re-filter against threshold
    const filtered = groups.filter(g => g.similarity >= threshold);
    groups.length = 0;
    groups.push(...filtered);
  }

  // Sort by similarity descending
  groups.sort((a, b) => b.similarity - a.similarity);

  const totalGroups = groups.length;
  return {
    groups: groups.slice(0, limit),
    total_groups: totalGroups,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/duplicates.test.ts`
Expected: All PASS.

- [ ] **Step 5: Register the `find-duplicates` tool in server.ts**

In `src/mcp/server.ts`, add `import { findDuplicates } from './duplicates.js';` at the top, then register the tool:

```typescript
server.tool(
  'find-duplicates',
  'Find nodes with similar or identical titles. Useful for vault hygiene and deduplication.',
  {
    schema_type: z.string().min(1).optional()
      .describe('Scope detection to a specific type, e.g. "meeting", "task"'),
    include_fields: z.boolean().optional().default(false)
      .describe('Layer in field overlap scoring for more accurate results'),
    threshold: z.number().min(0).max(1).optional().default(0.8)
      .describe('Minimum similarity score (0.0–1.0) to report as duplicate'),
    limit: z.number().int().min(1).optional().default(50)
      .describe('Maximum number of duplicate groups to return'),
  },
  async ({ schema_type, include_fields, threshold, limit }) => {
    try {
      const result = findDuplicates(db, { schema_type, include_fields, threshold, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err), 'INTERNAL_ERROR');
    }
  },
);
```

- [ ] **Step 6: Write an integration test via MCP client**

Add to `tests/mcp/duplicates.test.ts`:

```typescript
import { afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';

describe('find-duplicates MCP tool', () => {
  let db2: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-dup-'));
    db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    createSchema(db2);

    function seed2(file: string, raw: string) {
      const dir = join(vaultPath, file, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(vaultPath, file), raw);
      const parsed = parseFile(file, raw);
      indexFile(db2, parsed, file, '2026-03-25T00:00:00.000Z', raw);
    }

    seed2('meetings/standup.md', '---\ntitle: Weekly Standup\ntypes: [meeting]\n---\n');
    seed2('meetings/standup-copy.md', '---\ntitle: Weekly Standup\ntypes: [meeting]\n---\n');
    seed2('tasks/review.md', '---\ntitle: Review\ntypes: [task]\n---\n');

    const server = createServer(db2, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db2.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('finds duplicates via MCP tool call', async () => {
    const result = await client.callTool({
      name: 'find-duplicates',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].nodes).toHaveLength(2);
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run tests/mcp/duplicates.test.ts`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/duplicates.ts tests/mcp/duplicates.test.ts src/mcp/server.ts
git commit -m "feat: add find-duplicates tool for vault hygiene"
```

---

### Task 8: Remove `get-recent`, Consolidate into `query-nodes`

Delete the `get-recent` tool now that `query-nodes` has `since` and `path_prefix`.

**Files:**
- Modify: `src/mcp/server.ts:1140-1182` (delete `get-recent` registration)
- Modify: `tests/mcp/server.test.ts:251-319` (delete `get-recent` describe block)
- Modify: `tests/mcp/error-handling.test.ts:279-290` (delete `get-recent` error tests)

- [ ] **Step 1: Write a replacement test for `since` on `query-nodes`**

The existing `get-recent` tests in `server.test.ts` should be replaced by equivalent `query-nodes` tests. The `since` tests were already added in Task 6. Verify they exist in `tests/mcp/query-operators.test.ts` — the `since` test from Task 6 covers the key behavior.

- [ ] **Step 2: Delete the `get-recent` tool registration from server.ts**

Remove lines ~1140–1182 (the entire `server.tool('get-recent', ...)` block) from `src/mcp/server.ts`.

- [ ] **Step 3: Delete `get-recent` tests from server.test.ts**

Remove the entire `describe('get-recent', ...)` block (lines ~251–319) from `tests/mcp/server.test.ts`.

- [ ] **Step 4: Delete `get-recent` error tests from error-handling.test.ts**

Remove the two `get-recent` error tests (lines ~279–290) from `tests/mcp/error-handling.test.ts`.

- [ ] **Step 5: Update the `query-nodes` validation to handle the "no filter required" case for `since`**

This was already done in Task 6. The validation now accepts `since` as a sufficient standalone filter. Verify the check reads:

```typescript
if (!schema_type && !full_text && (!filters || filters.length === 0) && !references && !since && !path_prefix) {
```

- [ ] **Step 6: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: All tests PASS. Any test referencing `get-recent` should have been removed.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts tests/mcp/error-handling.test.ts
git commit -m "refactor: remove get-recent tool, consolidate into query-nodes with since param"
```

---

### Task 9: Final Verification

Run the full test suite and type checker to confirm everything works together.

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Verify tool count**

Run a quick count of `server.tool(` calls in `src/mcp/server.ts`:

Run: `grep -c "server.tool(" src/mcp/server.ts`
Expected: 24 (was 23, +delete-node, +find-duplicates, -get-recent = 24)
