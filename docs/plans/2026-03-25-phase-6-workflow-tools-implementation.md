# Phase 6: Task Management + Workflow Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 workflow MCP tools, comparison operators for query-nodes, harden the engine, and validate performance at scale.

**Architecture:** Workflow tools (`create-meeting-notes`, `extract-tasks`, `daily-summary`, `project-status`) live in a new `src/mcp/workflow-tools.ts` module. They compose existing primitives (`batchMutate`, `resolveTarget`, field queries). Comparison operators extend the existing dynamic SQL builder in `query-nodes`. Hardening and performance work touches `server.ts`, `watcher.ts`, `writer.ts`, and `resolver.ts`.

**Tech Stack:** TypeScript ESM, better-sqlite3, @modelcontextprotocol/sdk, vitest, zod

**Spec:** `docs/plans/2026-03-25-phase-6-workflow-tools-design.md`

---

### Task 1: Comparison Operators for `query-nodes`

**Files:**
- Modify: `src/mcp/server.ts:1174-1280` (query-nodes tool registration + handler)
- Test: `tests/mcp/query-operators.test.ts` (new)

This task extends the `query-nodes` filter system from `eq`-only to the full operator set: `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `in`. This is the foundation for date/status filtering used by the workflow tools.

- [ ] **Step 1: Write failing tests for new operators**

Create `tests/mcp/query-operators.test.ts`. Use the standard MCP test pattern: in-memory DB, temp vault, InMemoryTransport client/server pair. Seed test data with nodes that have numeric, date, and string fields.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { mkdirSync, statSync } from 'node:fs';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, frontmatter: string, body: string = '') {
  const raw = `---\n${frontmatter}\n---\n${body}`;
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, id.split('/').slice(0, -1).join('/'));
  if (id.includes('/')) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function query(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'query-nodes', arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

  // Seed test nodes
  db.transaction(() => {
    seedNode('task-a.md', 'title: Task A\ntypes: [task]\nstatus: todo\npriority: 3\ndue_date: 2026-03-20');
    seedNode('task-b.md', 'title: Task B\ntypes: [task]\nstatus: done\npriority: 1\ndue_date: 2026-03-25');
    seedNode('task-c.md', 'title: Task C\ntypes: [task]\nstatus: in-progress\npriority: 5\ndue_date: 2026-04-01');
    seedNode('task-d.md', 'title: Task D\ntypes: [task]\nstatus: todo\npriority: 2\ndue_date: 2026-03-22');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('query-nodes comparison operators', () => {
  it('neq: excludes matching values', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'neq', value: 'done' }],
    });
    expect(nodes.length).toBe(3);
    expect(nodes.every((n: any) => n.fields.status !== 'done')).toBe(true);
  });

  it('lt: date before threshold', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'due_date', operator: 'lt', value: '2026-03-25' }],
    });
    // task-a (3/20), task-d (3/22)
    expect(nodes.length).toBe(2);
  });

  it('gte: date on or after threshold', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'due_date', operator: 'gte', value: '2026-03-25' }],
    });
    // task-b (3/25), task-c (4/1)
    expect(nodes.length).toBe(2);
  });

  it('gt: number greater than', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'priority', operator: 'gt', value: 3 }],
    });
    // task-c (5)
    expect(nodes.length).toBe(1);
    expect(nodes[0].fields.priority).toBe('5');
  });

  it('lte: number less than or equal', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'priority', operator: 'lte', value: 2 }],
    });
    // task-b (1), task-d (2)
    expect(nodes.length).toBe(2);
  });

  it('contains: substring match', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: 'progress' }],
    });
    expect(nodes.length).toBe(1);
    expect(nodes[0].fields.status).toBe('in-progress');
  });

  it('contains: escapes LIKE wildcards', async () => {
    // Searching for literal % should not match everything
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: '%' }],
    });
    expect(nodes.length).toBe(0);
  });

  it('in: matches any of the provided values', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'in', value: ['todo', 'done'] }],
    });
    // task-a (todo), task-b (done), task-d (todo)
    expect(nodes.length).toBe(3);
  });

  it('combines multiple operators', async () => {
    // Overdue tasks: due before 3/25, not done
    const nodes = await query({
      schema_type: 'task',
      filters: [
        { field: 'due_date', operator: 'lt', value: '2026-03-25' },
        { field: 'status', operator: 'neq', value: 'done' },
      ],
    });
    // task-a (3/20, todo), task-d (3/22, todo)
    expect(nodes.length).toBe(2);
  });

  it('backwards compatible: eq still works without operator', async () => {
    const nodes = await query({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });
    expect(nodes.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/query-operators.test.ts`
Expected: FAIL — current `query-nodes` Zod schema only accepts `operator: z.enum(['eq'])` and single-string `value`.

- [ ] **Step 3: Update Zod schema and filter SQL generation**

In `src/mcp/server.ts`, modify the `query-nodes` tool registration (around line 1174):

1. Update the Zod schema for filters:
```typescript
filters: z.array(z.object({
  field: z.string().describe('Field name, e.g. "status", "assignee"'),
  operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'])
    .default('eq')
    .describe('Comparison operator'),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .describe('Value to compare against (use array for "in" operator)'),
})).optional()
  .describe('Field filters with comparison operators'),
```

2. Replace the filter loop (around lines 1232-1238) with operator-aware SQL generation:
```typescript
if (filters) {
  for (let i = 0; i < filters.length; i++) {
    const { field, operator, value } = filters[i];
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
        conditions.push(`${alias}.key = ? AND CASE ${alias}.value_type WHEN 'number' THEN ${alias}.value_number ${sqlOp} ? WHEN 'date' THEN ${alias}.value_date ${sqlOp} ? ELSE ${alias}.value_text ${sqlOp} ? END`);
        params.push(field, value, value, value);
        break;
      }
      case 'contains': {
        // Escape LIKE wildcards
        const escaped = String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push(`${alias}.key = ? AND ${alias}.value_text LIKE '%' || ? || '%' ESCAPE '\\'`);
        params.push(field, escaped);
        break;
      }
      case 'in': {
        const vals = Array.isArray(value) ? value : [value];
        const placeholders = vals.map(() => '?').join(', ');
        conditions.push(`${alias}.key = ? AND ${alias}.value_text IN (${placeholders})`);
        params.push(field, ...vals.map(String));
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-operators.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass (backwards compatibility).

- [ ] **Step 6: Commit**

```bash
git add tests/mcp/query-operators.test.ts src/mcp/server.ts
git commit -m "add comparison operators to query-nodes (eq, neq, gt, lt, gte, lte, contains, in)"
```

---

### Task 2: Export `buildLookupMaps` from resolver

**Files:**
- Modify: `src/sync/resolver.ts:8` (export keyword)
- Modify: `src/sync/index.ts` (re-export)
- Test: `tests/sync/resolver.test.ts` (add test for exported function)

The `create-meeting-notes` tool needs to batch-resolve attendee names. Currently `buildLookupMaps` is private. We need to export it.

- [ ] **Step 1: Write failing test for exported `buildLookupMaps` and `resolveTargetWithMaps`**

Create `tests/sync/resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { buildLookupMaps, resolveTargetWithMaps } from '../../src/sync/resolver.js';

let db: Database.Database;

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe('buildLookupMaps', () => {
  it('builds title and path lookup maps from indexed nodes', () => {
    db.transaction(() => {
      indexFixture('sample-task.md', 'tasks/review-vendor-proposals.md');
      indexFixture('sample-person.md', 'people/alice-smith.md');
    })();

    const { titleMap, pathMap } = buildLookupMaps(db);

    expect(titleMap.has('review vendor proposals')).toBe(true);
    expect(titleMap.has('alice smith')).toBe(true);

    expect(pathMap.has('review-vendor-proposals')).toBe(true);
    expect(pathMap.has('tasks/review-vendor-proposals')).toBe(true);
  });
});

describe('resolveTargetWithMaps', () => {
  it('resolves by title match', () => {
    db.transaction(() => {
      indexFixture('sample-person.md', 'people/alice-smith.md');
    })();
    const { titleMap, pathMap } = buildLookupMaps(db);
    expect(resolveTargetWithMaps('Alice Smith', titleMap, pathMap)).toBe('people/alice-smith.md');
  });

  it('returns null for ambiguous matches', () => {
    db.transaction(() => {
      indexFixture('sample-person.md', 'people/alice-smith.md');
      indexFixture('sample-person.md', 'work/alice-smith.md');
    })();
    const { titleMap, pathMap } = buildLookupMaps(db);
    expect(resolveTargetWithMaps('Alice Smith', titleMap, pathMap)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: FAIL — `buildLookupMaps` is not exported.

- [ ] **Step 3: Export `buildLookupMaps`**

In `src/sync/resolver.ts`, export both `buildLookupMaps` (line 8) and `resolveTargetWithMaps` (line 79):

Change `function buildLookupMaps` to `export function buildLookupMaps`.
Change `function resolveTargetWithMaps` to `export function resolveTargetWithMaps`.

In `src/sync/index.ts`, add the re-exports:
```typescript
export { buildLookupMaps, resolveTargetWithMaps } from './resolver.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/resolver.ts src/sync/index.ts tests/sync/resolver.test.ts
git commit -m "export buildLookupMaps from resolver for batch name resolution"
```

---

### Task 3: `computeProjectTaskStats` Shared Helper

**Files:**
- Create: `src/mcp/workflow-tools.ts`
- Test: `tests/mcp/workflow-tools.test.ts` (new)

This helper computes task statistics for a project from raw SQL queries. It's used by both `project-status` and `daily-summary`.

- [ ] **Step 1: Write failing tests for `computeProjectTaskStats`**

Create `tests/mcp/workflow-tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { computeProjectTaskStats } from '../../src/mcp/workflow-tools.js';

let db: Database.Database;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  db.transaction(() => {
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\n---\n');
    seedNode('tasks/t1.md', '---\ntitle: Task 1\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t2.md', '---\ntitle: Task 2\ntypes: [task]\nstatus: done\ndue_date: 2026-03-22\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t3.md', '---\ntitle: Task 3\ntypes: [task]\nstatus: in-progress\ndue_date: 2026-04-01\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t4.md', '---\ntitle: Task 4\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-18\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('computeProjectTaskStats', () => {
  it('computes task counts and completion percentage', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    expect(stats.total_tasks).toBe(4);
    expect(stats.completed_tasks).toBe(1);
    expect(stats.completion_pct).toBeCloseTo(25.0);
  });

  it('groups tasks by status', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    expect(stats.tasks_by_status.todo.length).toBe(2);
    expect(stats.tasks_by_status.done.length).toBe(1);
    expect(stats.tasks_by_status['in-progress'].length).toBe(1);
  });

  it('identifies overdue tasks', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    // t1 (3/20, todo), t4 (3/18, todo) are overdue; t2 (done) is not
    expect(stats.overdue_tasks.length).toBe(2);
  });

  it('returns empty stats for project with no tasks', () => {
    seedNode('projects/empty.md', '---\ntitle: Empty\ntypes: [project]\n---\n');
    db.transaction(() => resolveReferences(db))();
    const stats = computeProjectTaskStats(db, 'projects/empty.md');
    expect(stats.total_tasks).toBe(0);
    expect(stats.completion_pct).toBe(0);
    expect(stats.overdue_tasks.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/workflow-tools.test.ts`
Expected: FAIL — `workflow-tools.ts` doesn't exist.

- [ ] **Step 3: Implement `computeProjectTaskStats`**

Create `src/mcp/workflow-tools.ts`:

```typescript
import type Database from 'better-sqlite3';

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  due_date: string | null;
  priority: string | null;
}

export interface ProjectTaskStats {
  total_tasks: number;
  completed_tasks: number;
  completion_pct: number;
  tasks_by_status: Record<string, TaskSummary[]>;
  overdue_tasks: TaskSummary[];
  recent_activity: Array<{ id: string; title: string; updated_at: string }>;
}

/**
 * Find all task node IDs that reference a given project via any relationship.
 */
function findProjectTaskIds(db: Database.Database, projectId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT r.source_id
    FROM relationships r
    JOIN node_types nt ON nt.node_id = r.source_id AND nt.schema_type = 'task'
    WHERE r.resolved_target_id = ?
  `).all(projectId) as Array<{ source_id: string }>;
  return rows.map(r => r.source_id);
}

function getTaskField(db: Database.Database, nodeId: string, key: string): string | null {
  const row = db.prepare('SELECT value_text, value_type, value_date FROM fields WHERE node_id = ? AND key = ?')
    .get(nodeId, key) as { value_text: string; value_type: string; value_date: string | null } | undefined;
  if (!row) return null;
  // Normalize dates to YYYY-MM-DD (value_date stores full ISO like "2026-03-20T00:00:00.000Z")
  if (row.value_type === 'date' && row.value_date) return row.value_date.slice(0, 10);
  return row.value_text;
}

export function computeProjectTaskStats(
  db: Database.Database,
  projectId: string,
  today?: string,
): ProjectTaskStats {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const taskIds = findProjectTaskIds(db, projectId);

  if (taskIds.length === 0) {
    return {
      total_tasks: 0,
      completed_tasks: 0,
      completion_pct: 0,
      tasks_by_status: {},
      overdue_tasks: [],
      recent_activity: [],
    };
  }

  const tasks: TaskSummary[] = [];
  for (const id of taskIds) {
    const node = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(id) as
      { id: string; title: string | null } | undefined;
    if (!node) continue;
    tasks.push({
      id: node.id,
      title: node.title ?? id.replace(/\.md$/, '').split('/').pop()!,
      status: getTaskField(db, id, 'status') ?? 'unknown',
      assignee: getTaskField(db, id, 'assignee'),
      due_date: getTaskField(db, id, 'due_date'),
      priority: getTaskField(db, id, 'priority'),
    });
  }

  const tasksByStatus: Record<string, TaskSummary[]> = {};
  for (const task of tasks) {
    const bucket = tasksByStatus[task.status] ?? [];
    bucket.push(task);
    tasksByStatus[task.status] = bucket;
  }

  const completedTasks = tasks.filter(t => t.status === 'done').length;
  const completionPct = tasks.length > 0
    ? Math.round((completedTasks / tasks.length) * 10000) / 100
    : 0;

  const overdueTasks = tasks.filter(t =>
    t.due_date && t.due_date < todayStr &&
    t.status !== 'done' && t.status !== 'cancelled'
  );

  // Recent activity: tasks ordered by updated_at DESC
  const placeholders = taskIds.map(() => '?').join(', ');
  const recentRows = db.prepare(`
    SELECT id, title, updated_at FROM nodes
    WHERE id IN (${placeholders})
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(...taskIds) as Array<{ id: string; title: string | null; updated_at: string }>;

  const recentActivity = recentRows.map(r => ({
    id: r.id,
    title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
    updated_at: r.updated_at,
  }));

  return {
    total_tasks: tasks.length,
    completed_tasks: completedTasks,
    completion_pct: completionPct,
    tasks_by_status: tasksByStatus,
    overdue_tasks: overdueTasks,
    recent_activity: recentActivity,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/workflow-tools.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/workflow-tools.ts tests/mcp/workflow-tools.test.ts
git commit -m "add computeProjectTaskStats shared helper for workflow tools"
```

---

### Task 4: `project-status` MCP Tool

**Files:**
- Modify: `src/mcp/server.ts` (tool registration)
- Modify: `src/mcp/workflow-tools.ts` (handler logic)
- Test: `tests/mcp/project-status.test.ts` (new)

- [ ] **Step 1: Write failing tests for `project-status`**

Create `tests/mcp/project-status.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

  db.transaction(() => {
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\nowner: "[[Alice]]"\n---\n');
    seedNode('people/alice.md', '---\ntitle: Alice\ntypes: [person]\n---\n');
    seedNode('tasks/t1.md', '---\ntitle: Review docs\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nassignee: "[[Alice]]"\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t2.md', '---\ntitle: Fix tests\ntypes: [task]\nstatus: done\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t3.md', '---\ntitle: Deploy\ntypes: [task]\nstatus: in-progress\ndue_date: 2026-04-01\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('project-status tool', () => {
  it('returns project info and task stats', async () => {
    const data = await callTool('project-status', { project_id: 'projects/alpha.md' });
    expect(data.project.id).toBe('projects/alpha.md');
    expect(data.project.title).toBe('Alpha');
    expect(data.total_tasks).toBe(3);
    expect(data.completed_tasks).toBe(1);
    expect(data.completion_pct).toBeCloseTo(33.33);
    expect(data.tasks_by_status.todo.length).toBe(1);
    expect(data.tasks_by_status.done.length).toBe(1);
    expect(data.tasks_by_status['in-progress'].length).toBe(1);
  });

  it('returns error for nonexistent project', async () => {
    const result = await client.callTool({
      name: 'project-status',
      arguments: { project_id: 'nope.md' },
    });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/project-status.test.ts`
Expected: FAIL — `project-status` tool not registered.

- [ ] **Step 3: Add handler to `workflow-tools.ts`**

Add to `src/mcp/workflow-tools.ts`:

```typescript
export function projectStatusHandler(
  db: Database.Database,
  hydrateNodes: (rows: any[], opts?: any) => any[],
  params: { project_id: string },
) {
  const { project_id } = params;

  // Verify project exists
  const projectRow = db.prepare(
    'SELECT id, file_path, node_type, title, content_text, content_md, updated_at FROM nodes WHERE id = ?'
  ).get(project_id);
  if (!projectRow) {
    return { content: [{ type: 'text' as const, text: `Error: Node not found: ${project_id}` }], isError: true };
  }

  const [project] = hydrateNodes([projectRow]);
  const stats = computeProjectTaskStats(db, project_id);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        project,
        ...stats,
      }),
    }],
  };
}
```

- [ ] **Step 4: Register tool in `server.ts`**

Add import at top of `src/mcp/server.ts`:
```typescript
import { projectStatusHandler } from './workflow-tools.js';
```

Add tool registration (after the existing tools):
```typescript
server.tool(
  'project-status',
  'Get detailed status of a project: task counts, completion percentage, tasks grouped by status, overdue tasks, recent activity.',
  {
    project_id: z.string().min(1).describe('Project node ID (vault-relative path)'),
  },
  async ({ project_id }) => {
    return projectStatusHandler(db, hydrateNodes, { project_id });
  },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/project-status.test.ts`
Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/workflow-tools.ts tests/mcp/project-status.test.ts
git commit -m "add project-status MCP tool"
```

---

### Task 5: `daily-summary` MCP Tool

**Files:**
- Modify: `src/mcp/workflow-tools.ts` (handler logic)
- Modify: `src/mcp/server.ts` (tool registration)
- Test: `tests/mcp/daily-summary.test.ts` (new)

- [ ] **Step 1: Write failing tests for `daily-summary`**

Create `tests/mcp/daily-summary.test.ts`. Use the same setup pattern as `project-status.test.ts`. Seed tasks with various due dates, statuses, and a project. Tests:

- `overdue`: tasks with `due_date < date` and status not done/cancelled
- `due_today`: tasks with `due_date == date`
- `due_this_week`: tasks with `due_date` between `date+1` and end of ISO week (exclusive of `due_today`)
- `recently_modified`: nodes ordered by `updated_at DESC`, limit 20, only typed nodes
- `active_projects`: projects with status `active` or no status, plus task stats from shared helper
- Edge case: empty vault returns all empty arrays

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

  // Date context: "today" will be 2026-03-25 (Wednesday in ISO week)
  db.transaction(() => {
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\n---\n');
    seedNode('tasks/overdue.md', '---\ntitle: Overdue task\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/today.md', '---\ntitle: Due today\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-25\n---\n');
    seedNode('tasks/this-week.md', '---\ntitle: Due Thursday\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-26\n---\n');
    seedNode('tasks/next-week.md', '---\ntitle: Due next week\ntypes: [task]\nstatus: todo\ndue_date: 2026-04-02\n---\n');
    seedNode('tasks/done.md', '---\ntitle: Done task\ntypes: [task]\nstatus: done\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('daily-summary tool', () => {
  it('returns overdue tasks (past due, not done/cancelled)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.overdue.length).toBe(1);
    expect(data.overdue[0].title).toBe('Overdue task');
  });

  it('returns tasks due today', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.due_today.length).toBe(1);
    expect(data.due_today[0].title).toBe('Due today');
  });

  it('returns tasks due rest of week (not today)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    // 2026-03-25 is Wednesday. ISO week ends Sunday 2026-03-29.
    // Due Thursday (3/26) is in range. Next week (4/2) is not.
    expect(data.due_this_week.length).toBe(1);
    expect(data.due_this_week[0].title).toBe('Due Thursday');
  });

  it('returns recently modified nodes (typed only)', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.recently_modified.length).toBeGreaterThan(0);
    // All should have types
    for (const node of data.recently_modified) {
      expect(node.types.length).toBeGreaterThan(0);
    }
  });

  it('returns active projects with task stats', async () => {
    const data = await callTool('daily-summary', { date: '2026-03-25' });
    expect(data.active_projects.length).toBe(1);
    expect(data.active_projects[0].title).toBe('Alpha');
    expect(data.active_projects[0].total_tasks).toBe(2); // overdue + done are linked
    expect(data.active_projects[0].completed_tasks).toBe(1);
  });

  it('defaults date to today if not provided', async () => {
    const data = await callTool('daily-summary', {});
    expect(data.date).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/daily-summary.test.ts`
Expected: FAIL — `daily-summary` tool not registered.

- [ ] **Step 3: Implement `dailySummaryHandler` in `workflow-tools.ts`**

Add to `src/mcp/workflow-tools.ts`:

```typescript
/**
 * Get the end of the ISO week (Sunday) for a given date.
 * ISO weeks start Monday. Sunday = day 7.
 */
function endOfIsoWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

interface DueDateTask {
  id: string;
  title: string;
  types: string[];
  due_date: string;
  status: string;
  assignee: string | null;
}

function queryDueTasks(db: Database.Database): DueDateTask[] {
  // Use SUBSTR on value_date to normalize to YYYY-MM-DD (value_date stores full ISO like "2026-03-20T00:00:00.000Z")
  const rows = db.prepare(`
    SELECT n.id, n.title,
      SUBSTR(fd.value_date, 1, 10) AS due_date,
      fs.value_text AS status,
      fa.value_text AS assignee
    FROM nodes n
    JOIN fields fd ON fd.node_id = n.id AND fd.key = 'due_date'
    LEFT JOIN fields fs ON fs.node_id = n.id AND fs.key = 'status'
    LEFT JOIN fields fa ON fa.node_id = n.id AND fa.key = 'assignee'
    WHERE fd.value_date IS NOT NULL
  `).all() as Array<{
    id: string; title: string | null;
    due_date: string; status: string | null; assignee: string | null;
  }>;

  // Load types for each
  const nodeIds = rows.map(r => r.id);
  const typeRows = nodeIds.length > 0
    ? db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${nodeIds.map(() => '?').join(',')})`)
        .all(...nodeIds) as Array<{ node_id: string; schema_type: string }>
    : [];
  const typeMap = new Map<string, string[]>();
  for (const r of typeRows) {
    const arr = typeMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    typeMap.set(r.node_id, arr);
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
    types: typeMap.get(r.id) ?? [],
    due_date: r.due_date,
    status: r.status ?? 'unknown',
    assignee: r.assignee ?? null,
  }));
}

export function dailySummaryHandler(
  db: Database.Database,
  params: { date?: string },
) {
  const today = params.date ?? new Date().toISOString().slice(0, 10);
  const weekEnd = endOfIsoWeek(today);

  const allDueTasks = queryDueTasks(db);
  const isActive = (t: DueDateTask) => t.status !== 'done' && t.status !== 'cancelled';

  const overdue = allDueTasks.filter(t => t.due_date < today && isActive(t));
  const dueToday = allDueTasks.filter(t => t.due_date === today && isActive(t));
  const dueThisWeek = allDueTasks.filter(t =>
    t.due_date > today && t.due_date <= weekEnd && isActive(t)
  );

  // Recently modified: typed nodes only, limit 20
  const recentlyModified = db.prepare(`
    SELECT DISTINCT n.id, n.title, n.updated_at
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id
    ORDER BY n.updated_at DESC
    LIMIT 20
  `).all() as Array<{ id: string; title: string | null; updated_at: string }>;

  // Load types for recently modified
  const recentIds = recentlyModified.map(r => r.id);
  const recentTypeRows = recentIds.length > 0
    ? db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${recentIds.map(() => '?').join(',')})`)
        .all(...recentIds) as Array<{ node_id: string; schema_type: string }>
    : [];
  const recentTypeMap = new Map<string, string[]>();
  for (const r of recentTypeRows) {
    const arr = recentTypeMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    recentTypeMap.set(r.node_id, arr);
  }

  // Active projects: status = 'active' OR no status field
  const activeProjects = db.prepare(`
    SELECT DISTINCT n.id, n.title
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = 'project'
    LEFT JOIN fields fs ON fs.node_id = n.id AND fs.key = 'status'
    WHERE fs.value_text = 'active' OR fs.value_text IS NULL
  `).all() as Array<{ id: string; title: string | null }>;

  const activeProjectStats = activeProjects.map(p => {
    const stats = computeProjectTaskStats(db, p.id, today);
    return {
      id: p.id,
      title: p.title ?? p.id.replace(/\.md$/, '').split('/').pop()!,
      status: 'active',
      total_tasks: stats.total_tasks,
      completed_tasks: stats.completed_tasks,
      completion_pct: stats.completion_pct,
    };
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        date: today,
        overdue,
        due_today: dueToday,
        due_this_week: dueThisWeek,
        recently_modified: recentlyModified.map(r => ({
          id: r.id,
          title: r.title ?? r.id.replace(/\.md$/, '').split('/').pop()!,
          types: recentTypeMap.get(r.id) ?? [],
          updated_at: r.updated_at,
        })),
        active_projects: activeProjectStats,
      }),
    }],
  };
}
```

- [ ] **Step 4: Register tool in `server.ts`**

Add import:
```typescript
import { projectStatusHandler, dailySummaryHandler } from './workflow-tools.js';
```

Add registration:
```typescript
server.tool(
  'daily-summary',
  'Get a summary for a given date: overdue tasks, due today, due this week, recently modified nodes, active projects with task stats.',
  {
    date: z.string().optional()
      .describe('ISO date (YYYY-MM-DD), defaults to today'),
  },
  async ({ date }) => {
    return dailySummaryHandler(db, { date });
  },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/daily-summary.test.ts`
Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/workflow-tools.ts src/mcp/server.ts tests/mcp/daily-summary.test.ts
git commit -m "add daily-summary MCP tool"
```

---

### Task 6: `create-meeting-notes` MCP Tool

**Files:**
- Modify: `src/mcp/workflow-tools.ts` (handler logic)
- Modify: `src/mcp/server.ts` (tool registration)
- Test: `tests/mcp/create-meeting-notes.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/create-meeting-notes.test.ts`. Use the same MCP test pattern. Tests:

- Creates meeting node with correct fields (date, attendees as wiki-links, project)
- Creates person stubs for unknown attendees (minimal: title + types: [person])
- Reports `resolved_attendees` vs `created_attendees`
- Resolves existing person nodes (no duplicate stubs)
- Includes agenda in body
- Atomic: if meeting creation fails, no stubs are left behind

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    data: JSON.parse((result.content as Array<{ text: string }>)[0].text),
    isError: result.isError,
  };
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

  // Pre-existing person
  db.transaction(() => {
    seedNode('people/alice.md', '---\ntitle: Alice\ntypes: [person]\nrole: Engineer\n---\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('create-meeting-notes tool', () => {
  it('creates meeting with resolved and created attendees', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'Sprint Planning',
      date: '2026-03-25',
      attendees: ['Alice', 'Bob'],
    });

    expect(data.resolved_attendees).toContain('Alice');
    expect(data.created_attendees).toContain('Bob');
    expect(data.node).toBeDefined();
    expect(data.node.fields.date).toBe('2026-03-25');

    // Bob stub exists with minimal fields
    const bob = db.prepare('SELECT * FROM nodes WHERE title = ?').get('Bob') as any;
    expect(bob).toBeDefined();
    const bobTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(bob.id) as any[];
    expect(bobTypes.map((t: any) => t.schema_type)).toEqual(['person']);
    // No extra fields on stub
    const bobFields = db.prepare('SELECT key FROM fields WHERE node_id = ?')
      .all(bob.id) as any[];
    expect(bobFields.length).toBe(0);
  });

  it('does not create stub for already-existing person', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'One-on-One',
      date: '2026-03-25',
      attendees: ['Alice'],
    });

    expect(data.resolved_attendees).toContain('Alice');
    expect(data.created_attendees.length).toBe(0);

    // Only one Alice
    const alices = db.prepare("SELECT id FROM nodes WHERE LOWER(title) = 'alice'").all();
    expect(alices.length).toBe(1);
  });

  it('includes agenda in body', async () => {
    const { data } = await callTool('create-meeting-notes', {
      title: 'Kickoff',
      date: '2026-03-25',
      attendees: ['Alice'],
      agenda: '## Topics\n\n- Budget review\n- Timeline',
    });

    // Read the file and check body
    const filePath = join(vaultPath, data.node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Budget review');
  });

  it('links project when provided', async () => {
    db.transaction(() => {
      seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\n---\n');
      resolveReferences(db);
    })();

    const { data } = await callTool('create-meeting-notes', {
      title: 'Alpha Sync',
      date: '2026-03-25',
      attendees: ['Alice'],
      project: 'Alpha',
    });

    // Meeting should have project field
    const filePath = join(vaultPath, data.node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('[[Alpha]]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/create-meeting-notes.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement `createMeetingNotesHandler` in `workflow-tools.ts`**

Add to `src/mcp/workflow-tools.ts`:

```typescript
import { buildLookupMaps, resolveTargetWithMaps } from '../sync/resolver.js';

interface MeetingNotesParams {
  title: string;
  date: string;
  attendees: string[];
  project?: string;
  agenda?: string;
  body?: string;
}

export function createMeetingNotesHandler(
  db: Database.Database,
  batchMutate: (params: { operations: Array<{ op: string; params: Record<string, unknown> }> }) => any,
  hydrateNodes: (rows: any[]) => any[],
  params: MeetingNotesParams,
) {
  const { title, date, attendees, project, agenda, body } = params;

  // Batch-resolve attendees
  const { titleMap, pathMap } = buildLookupMaps(db);
  const resolvedAttendees: string[] = [];
  const createdAttendees: string[] = [];

  const operations: Array<{ op: string; params: Record<string, unknown> }> = [];

  for (const name of attendees) {
    const nodeId = resolveTargetWithMaps(name, titleMap, pathMap);
    if (nodeId) {
      resolvedAttendees.push(name);
    } else {
      createdAttendees.push(name);
      operations.push({
        op: 'create',
        params: { title: name, types: ['person'] },
      });
    }
  }

  // Build attendees wiki-link list
  const attendeeLinks = attendees.map(name => `[[${name}]]`);

  // Build meeting fields
  const meetingFields: Record<string, unknown> = {
    date,
    attendees: attendeeLinks,
  };
  if (project) {
    meetingFields.project = `[[${project.replace(/^\[\[/, '').replace(/\]\]$/, '')}]]`;
  }

  // Build meeting body
  let meetingBody = '';
  if (agenda) meetingBody += agenda;
  if (body) meetingBody += (meetingBody ? '\n\n' : '') + body;

  operations.push({
    op: 'create',
    params: {
      title,
      types: ['meeting'],
      fields: meetingFields,
      ...(meetingBody ? { body: meetingBody } : {}),
    },
  });

  const result = batchMutate({ operations });

  // Check for error
  const parsed = JSON.parse(result.content[0].text);
  if (result.isError || parsed.error) {
    return result;
  }

  // Extract meeting node from results (last create op)
  const meetingResult = parsed.results[parsed.results.length - 1];

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        node: meetingResult.node,
        warnings: parsed.warnings,
        resolved_attendees: resolvedAttendees,
        created_attendees: createdAttendees,
      }),
    }],
  };
}
```

- [ ] **Step 4: Register tool in `server.ts`**

Add import update:
```typescript
import { projectStatusHandler, dailySummaryHandler, createMeetingNotesHandler } from './workflow-tools.js';
```

Add registration:
```typescript
server.tool(
  'create-meeting-notes',
  'Create a meeting note with linked attendees and optional project. Auto-creates minimal person stubs for unknown attendees. Returns the meeting node plus lists of resolved vs. created attendees.',
  {
    title: z.string().min(1).describe('Meeting title'),
    date: z.string().describe('Meeting date (ISO format YYYY-MM-DD)'),
    attendees: z.array(z.string().min(1)).describe('Attendee names (resolved to person nodes; stubs created for unknowns)'),
    project: z.string().optional().describe('Project name or wiki-link to associate'),
    agenda: z.string().optional().describe('Agenda text for the meeting body'),
    body: z.string().optional().describe('Additional body content'),
  },
  async (params) => {
    return createMeetingNotesHandler(db, batchMutate, hydrateNodes, params);
  },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/create-meeting-notes.test.ts`
Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/workflow-tools.ts src/mcp/server.ts tests/mcp/create-meeting-notes.test.ts
git commit -m "add create-meeting-notes MCP tool with attendee stub creation"
```

---

### Task 7: `extract-tasks` MCP Tool

**Files:**
- Modify: `src/mcp/workflow-tools.ts` (handler logic)
- Modify: `src/mcp/server.ts` (tool registration)
- Test: `tests/mcp/extract-tasks.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/extract-tasks.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    data: JSON.parse((result.content as Array<{ text: string }>)[0].text),
    isError: result.isError,
  };
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

  db.transaction(() => {
    seedNode('meetings/standup.md', '---\ntitle: Daily Standup\ntypes: [meeting]\ndate: 2026-03-25\n---\n## Action Items\n\n- Review the PR\n- Fix the login bug\n');
    resolveReferences(db);
  })();
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('extract-tasks tool', () => {
  it('creates task nodes linked back to source', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [
        { title: 'Review the PR', assignee: '[[Alice]]', status: 'todo' },
        { title: 'Fix the login bug', priority: 'high' },
      ],
    });

    expect(data.tasks.length).toBe(2);
    expect(data.tasks[0].node.title).toBe('Review the PR');
    expect(data.tasks[1].node.title).toBe('Fix the login bug');

    // Each task should have source field pointing back
    for (const task of data.tasks) {
      const filePath = join(vaultPath, task.node.id);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('[[Daily Standup]]');
    }
  });

  it('returns error for nonexistent source node', async () => {
    const { data, isError } = await callTool('extract-tasks', {
      source_node_id: 'nope.md',
      tasks: [{ title: 'Something' }],
    });
    expect(isError).toBe(true);
  });

  it('applies default status of todo', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [{ title: 'Some task' }],
    });

    const filePath = join(vaultPath, data.tasks[0].node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: todo');
  });

  it('passes through custom fields', async () => {
    const { data } = await callTool('extract-tasks', {
      source_node_id: 'meetings/standup.md',
      tasks: [{ title: 'Tagged task', fields: { department: 'engineering' } }],
    });

    const filePath = join(vaultPath, data.tasks[0].node.id);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('department: engineering');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/extract-tasks.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement `extractTasksHandler` in `workflow-tools.ts`**

Add to `src/mcp/workflow-tools.ts`:

```typescript
interface TaskInput {
  title: string;
  assignee?: string;
  due_date?: string;
  priority?: string;
  status?: string;
  fields?: Record<string, unknown>;
}

interface ExtractTasksParams {
  source_node_id: string;
  tasks: TaskInput[];
}

export function extractTasksHandler(
  db: Database.Database,
  batchMutate: (params: { operations: Array<{ op: string; params: Record<string, unknown> }> }) => any,
  params: ExtractTasksParams,
) {
  const { source_node_id, tasks } = params;

  // Validate source exists
  const sourceNode = db.prepare('SELECT id, title FROM nodes WHERE id = ?')
    .get(source_node_id) as { id: string; title: string | null } | undefined;
  if (!sourceNode) {
    return {
      content: [{ type: 'text' as const, text: `Error: Source node not found: ${source_node_id}` }],
      isError: true,
    };
  }

  const sourceTitle = sourceNode.title ?? source_node_id.replace(/\.md$/, '').split('/').pop()!;

  const operations = tasks.map(task => {
    const fields: Record<string, unknown> = {
      ...task.fields,
      source: `[[${sourceTitle}]]`,
      status: task.status ?? 'todo',
    };
    if (task.assignee) fields.assignee = task.assignee;
    if (task.due_date) fields.due_date = task.due_date;
    if (task.priority) fields.priority = task.priority;

    return {
      op: 'create',
      params: {
        title: task.title,
        types: ['task'],
        fields,
      },
    };
  });

  const result = batchMutate({ operations });
  const parsed = JSON.parse(result.content[0].text);

  if (result.isError || parsed.error) {
    return result;
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        tasks: parsed.results,
        warnings: parsed.warnings,
      }),
    }],
  };
}
```

- [ ] **Step 4: Register tool in `server.ts`**

Add import update and registration:
```typescript
server.tool(
  'extract-tasks',
  'Create task nodes from pre-extracted action items and link them back to the source node. The agent identifies action items; this tool orchestrates creation via batch-mutate.',
  {
    source_node_id: z.string().min(1).describe('Node ID the tasks were extracted from'),
    tasks: z.array(z.object({
      title: z.string().min(1).describe('Task title'),
      assignee: z.string().optional().describe('Person name or wiki-link'),
      due_date: z.string().optional().describe('ISO date'),
      priority: z.string().optional().describe('e.g. high, medium, low'),
      status: z.string().optional().describe('Defaults to "todo"'),
      fields: z.record(z.string(), z.unknown()).optional().describe('Additional fields'),
    })).min(1).describe('Pre-extracted task definitions'),
  },
  async (params) => {
    return extractTasksHandler(db, batchMutate, params);
  },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/extract-tasks.test.ts`
Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/workflow-tools.ts src/mcp/server.ts tests/mcp/extract-tasks.test.ts
git commit -m "add extract-tasks MCP tool"
```

---

### Task 8: Hardening — H1 (Error Handling) + H2 (Input Validation)

**Files:**
- Modify: `src/mcp/server.ts` (all tool handlers)
- Test: `tests/mcp/error-handling.test.ts` (new)

- [ ] **Step 1: Write tests for consistent error responses**

Create `tests/mcp/error-handling.test.ts`. Tests for each tool that:
- Invalid/empty params return structured `{ error, code }` responses with `isError: true`
- No raw stack traces leak through

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { text, isError: result.isError };
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

describe('error handling consistency', () => {
  it('get-node: returns structured error with code for missing node', async () => {
    const { text, isError } = await callTool('get-node', { node_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeTruthy();
    expect(parsed.code).toBe('NOT_FOUND');
    expect(text).not.toMatch(/at\s+\w+\s+\(/); // No stack traces
  });

  it('update-node: returns structured error for nonexistent node', async () => {
    const { text, isError } = await callTool('update-node', { node_id: 'missing.md', fields: {} });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('project-status: returns structured error for missing project', async () => {
    const { text, isError } = await callTool('project-status', { project_id: 'missing.md' });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('extract-tasks: returns structured error for missing source', async () => {
    const { text, isError } = await callTool('extract-tasks', {
      source_node_id: 'missing.md',
      tasks: [{ title: 'Test' }],
    });
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('query-nodes: returns error when no search criteria provided', async () => {
    const { text, isError } = await callTool('query-nodes', {});
    expect(isError).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });
});
```

- [ ] **Step 2: Run tests to verify current state**

Run: `npx vitest run tests/mcp/error-handling.test.ts`
Expected: Some may already pass. Note which need fixing.

- [ ] **Step 3: Audit and fix error handling in all tool handlers**

Walk through every tool handler in `server.ts`. For each:
- Ensure the outer `try/catch` returns `{ content: [{ type: 'text', text: JSON.stringify({ error: '...', code: '...' }) }], isError: true }`.
- Use structured error codes: `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `INTERNAL_ERROR`.
- Remove any raw `err.stack` from error messages.
- Add a helper function to standardize error responses:
```typescript
function toolError(message: string, code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'INTERNAL_ERROR') {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}
```

Focus areas: any handlers that currently let exceptions bubble or return inconsistent error shapes.

- [ ] **Step 4: Tighten Zod schemas**

Audit all tool Zod schemas in `server.ts`. Add:
- `.min(1)` to string params where empty string is meaningless (`node_id`, `title`, `schema_name`, etc.)
- `.positive()` or `.min(1)` to numeric params like `limit`, `max_depth`
- Path traversal protection: add `.refine(v => !v.includes('..'), 'Path traversal not allowed')` to path-like params

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/error-handling.test.ts`
Expected: All PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass (tighter validation doesn't break valid inputs).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/error-handling.test.ts
git commit -m "harden MCP error handling and input validation (H1, H2)"
```

---

### Task 9: Hardening — H3 (Batch-Scoped Write Locks) + H4 (Transaction Safety) + H5 (Watcher Resilience)

**Files:**
- Modify: `src/sync/watcher.ts` (write lock data structure)
- Modify: `src/serializer/writer.ts` (deferred lock support)
- Modify: `src/mcp/server.ts` (batch-mutate deferred locks)
- Test: `tests/mcp/batch-lock.test.ts` (new)
- Test: `tests/mcp/batch-rollback.test.ts` (new)

- [ ] **Step 1: Write failing test for batch-scoped locks**

Create `tests/mcp/batch-lock.test.ts`. This tests that write locks are held for the duration of a batch, not released per-file:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWriteLocked } from '../../src/sync/watcher.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

describe('batch-scoped write locks', () => {
  it('all locks released after batch completes', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'A' } },
          { op: 'create', params: { title: 'B' } },
          { op: 'create', params: { title: 'C' } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // All locks should be released after batch
    for (const r of data.results) {
      expect(isWriteLocked(r.node.id)).toBe(false);
    }
  });

  it('locks released even on batch failure', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'OK Node' } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    // No locks should remain after failed batch
    expect(isWriteLocked('OK Node.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing test for watcher resilience under bulk writes**

Create `tests/mcp/watcher-resilience.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchVault } from '../../src/sync/watcher.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;
let watchHandle: { close(): Promise<void>; ready: Promise<void> };

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  const server = createServer(db, vaultPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(clientTransport);

  // Start watcher
  watchHandle = watchVault(db, vaultPath, { debounceMs: 100 });
  await watchHandle.ready;

  cleanup = async () => {
    await watchHandle.close();
    await client.close();
    await server.close();
    db.close();
  };
});

afterEach(async () => {
  await cleanup();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('watcher resilience under bulk writes', () => {
  it('20-operation batch produces no spurious re-index events', async () => {
    // Instrument: count watcher-triggered indexFile calls by tracking files table writes
    // Snapshot the files table indexed_at before the batch
    const preCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c;

    const operations = [];
    for (let i = 0; i < 20; i++) {
      operations.push({ op: 'create', params: { title: `Bulk Node ${i}` } });
    }

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: { operations },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.results.length).toBe(20);

    // Record indexed_at timestamps for each created file
    const afterBatch = new Map<string, string>();
    for (const r of data.results) {
      const file = db.prepare('SELECT indexed_at FROM files WHERE path = ?').get(r.node.id) as any;
      afterBatch.set(r.node.id, file.indexed_at);
    }

    // Wait for watcher debounce to settle (2x debounce + buffer)
    await new Promise(resolve => setTimeout(resolve, 400));

    // Verify indexed_at timestamps haven't changed (no watcher re-index)
    let reindexCount = 0;
    for (const [id, ts] of afterBatch) {
      const file = db.prepare('SELECT indexed_at FROM files WHERE path = ?').get(id) as any;
      if (file.indexed_at !== ts) reindexCount++;
    }
    expect(reindexCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/batch-lock.test.ts tests/mcp/watcher-resilience.test.ts`
Expected: Watcher resilience test likely fails (lock released per-file before watcher debounce fires).

- [ ] **Step 4: Implement deferred lock support in `writer.ts`**

Modify `src/serializer/writer.ts` to accept an optional `deferredLocks` set:

```typescript
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireWriteLock, releaseWriteLock } from '../sync/watcher.js';

export function deleteNodeFile(
  vaultPath: string,
  relativePath: string,
  deferredLocks?: Set<string>,
): void {
  acquireWriteLock(relativePath);
  try {
    unlinkSync(join(vaultPath, relativePath));
  } finally {
    if (deferredLocks) {
      deferredLocks.add(relativePath);
    } else {
      releaseWriteLock(relativePath);
    }
  }
}

export function writeNodeFile(
  vaultPath: string,
  relativePath: string,
  content: string,
  deferredLocks?: Set<string>,
): void {
  acquireWriteLock(relativePath);
  try {
    const absPath = join(vaultPath, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  } finally {
    if (deferredLocks) {
      deferredLocks.add(relativePath);
    } else {
      releaseWriteLock(relativePath);
    }
  }
}
```

- [ ] **Step 5: Thread `deferredLocks` through `batchMutate`**

In `src/mcp/server.ts`, modify `batchMutate`:

1. Create `deferredLocks` set at the start of the function.
2. Pass it through to `createNodeInner`, `updateNodeInner`, `deleteNodeInner`, `addRelationshipInner`, `removeRelationshipInner`.
3. Each `*Inner` function passes it to `writeNodeFile`/`deleteNodeFile`.
4. In the outer `finally` block, release all deferred locks.

The key change to `batchMutate`:
```typescript
function batchMutate(params: { operations: ... }) {
  const deferredLocks = new Set<string>();
  // ... existing code ...
  try {
    const batchResult = db.transaction(() => {
      // ... pass deferredLocks to each *Inner call ...
    })();
    return { content: [...] };
  } catch (err) {
    rollbackFiles();
    return { content: [...], isError: true };
  } finally {
    // Release all batch-scoped locks
    for (const path of deferredLocks) {
      releaseWriteLock(path);
    }
  }
}
```

Each `*Inner` function needs an optional `deferredLocks?: Set<string>` parameter. The full threading chain:
- `batchMutate` creates `deferredLocks` set, passes to each `*Inner` call
- `createNodeInner(params, deferredLocks)` → `writeNodeFile(vaultPath, path, content, deferredLocks)`
- `updateNodeInner(params, deferredLocks)` → `writeNodeFile(vaultPath, path, content, deferredLocks)`
- `deleteNodeInner(params, deferredLocks)` → `deleteNodeFile(vaultPath, path, deferredLocks)`
- `addRelationshipInner(params, deferredLocks)` → `updateNodeInner(params, deferredLocks)` → `writeNodeFile`
- `removeRelationshipInner(params, deferredLocks)` → `updateNodeInner(params, deferredLocks)` → `writeNodeFile`

Non-batch operations (`createNode`, `updateNode`, etc.) don't pass `deferredLocks`, so `writeNodeFile`/`deleteNodeFile` fall back to immediate release (existing behavior). `renameNode` also keeps current behavior (no deferred locks — it's excluded from batch-mutate).

- [ ] **Step 6: Write test for transaction rollback safety (H4)**

Create `tests/mcp/batch-rollback.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';

let db: Database.Database;
let client: Client;
let cleanup: () => Promise<void>;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
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

describe('batch-mutate rollback safety', () => {
  it('rolls back created files when later operation fails', async () => {
    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'create', params: { title: 'Will Be Rolled Back' } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // File should not exist
    expect(existsSync(join(vaultPath, 'Will Be Rolled Back.md'))).toBe(false);
    // DB should be clean
    expect(db.prepare('SELECT COUNT(*) as c FROM nodes').get()).toEqual({ c: 0 });
  });

  it('restores modified files on rollback', async () => {
    const originalContent = '---\ntitle: Existing\ntypes: [task]\nstatus: todo\n---\nOriginal body\n';
    db.transaction(() => {
      seedNode('existing.md', originalContent);
      resolveReferences(db);
    })();

    const result = await client.callTool({
      name: 'batch-mutate',
      arguments: {
        operations: [
          { op: 'update', params: { node_id: 'existing.md', fields: { status: 'done' } } },
          { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } },
        ],
      },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.rolled_back).toBe(true);

    // File should be restored to original
    const content = readFileSync(join(vaultPath, 'existing.md'), 'utf-8');
    expect(content).toBe(originalContent);
  });
});
```

- [ ] **Step 7: Run all hardening tests**

Run: `npx vitest run tests/mcp/batch-lock.test.ts tests/mcp/watcher-resilience.test.ts tests/mcp/batch-rollback.test.ts`
Expected: All PASS.

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add src/sync/watcher.ts src/serializer/writer.ts src/mcp/server.ts tests/mcp/batch-lock.test.ts tests/mcp/watcher-resilience.test.ts tests/mcp/batch-rollback.test.ts
git commit -m "add batch-scoped write locks and transaction rollback safety (H3, H4, H5)"
```

---

### Task 10: Performance Benchmarks

**Files:**
- Create: `benchmarks/run.ts` (new)
- Modify: `package.json` (add `bench` script)

This task creates benchmark scripts that measure the 5 performance targets against the ~7000-file test vault. The benchmarks report p50/p95/p99 after warm-up.

- [ ] **Step 1: Create benchmark runner**

Create `benchmarks/run.ts`:

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema.js';
import { rebuildIndex, incrementalIndex } from '../src/sync/indexer.js';
import { resolveReferences } from '../src/sync/resolver.js';
import { traverseGraph } from '../src/graph/traversal.js';
import { existsSync } from 'node:fs';

const VAULT_PATH = process.argv[2];
const DB_PATH = process.argv[3] ?? ':memory:';
const WARMUP = 10;
const ITERATIONS = 100;

if (!VAULT_PATH || !existsSync(VAULT_PATH)) {
  console.error('Usage: npx tsx benchmarks/run.ts <vault-path> [db-path]');
  process.exit(1);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function report(name: string, times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`${name}:`);
  console.log(`  p50: ${percentile(sorted, 50).toFixed(1)}ms`);
  console.log(`  p95: ${percentile(sorted, 95).toFixed(1)}ms`);
  console.log(`  p99: ${percentile(sorted, 99).toFixed(1)}ms`);
}

async function main() {
  // P1: Full rebuild (single cold iteration — too slow for 100x, ~30s each)
  console.log('\n=== P1: Full Rebuild (single iteration) ===');
  {
    const db = new Database(DB_PATH === ':memory:' ? ':memory:' : DB_PATH);
    db.pragma('foreign_keys = ON');
    createSchema(db);
    const start = performance.now();
    rebuildIndex(db, VAULT_PATH);
    const elapsed = performance.now() - start;
    console.log(`Full rebuild: ${elapsed.toFixed(0)}ms`);
    console.log(`Threshold: < 30000ms — ${elapsed < 30000 ? 'PASS' : 'FAIL'}`);

    // P2: Incremental index (no changes) — reuse the same DB
    console.log('\n=== P2: Incremental Index (no changes) ===');
    const incTimes: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      incrementalIndex(db, VAULT_PATH);
      const e = performance.now() - s;
      if (i >= WARMUP) incTimes.push(e);
    }
    report('incrementalIndex (no changes)', incTimes);
    console.log(`Threshold: < 2000ms wall clock — ${percentile(incTimes.sort((a,b)=>a-b), 95) < 2000 ? 'PASS' : 'FAIL'}`);

    // P3: query-nodes with filters
    console.log('\n=== P3: query-nodes with filters ===');
    const queryTimes: number[] = [];
    const queryStmt = db.prepare(`
      SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.updated_at
      FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id
      JOIN fields f0 ON f0.node_id = n.id
      WHERE nt.schema_type = 'task' AND f0.key = 'status' AND f0.value_text = 'todo'
      ORDER BY n.updated_at DESC
      LIMIT 20
    `);
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      queryStmt.all();
      const e = performance.now() - s;
      if (i >= WARMUP) queryTimes.push(e);
    }
    report('query-nodes with filters', queryTimes);
    console.log(`Threshold: p95 < 100ms — ${percentile(queryTimes.sort((a,b)=>a-b), 95) < 100 ? 'PASS' : 'FAIL'}`);

    // P4: traverse-graph (2-hop)
    console.log('\n=== P4: traverse-graph (2-hop) ===');
    // Pick a node that exists
    const sampleNode = db.prepare('SELECT id FROM nodes LIMIT 1').get() as { id: string } | undefined;
    if (sampleNode) {
      const travTimes: number[] = [];
      for (let i = 0; i < WARMUP + ITERATIONS; i++) {
        const s = performance.now();
        traverseGraph(db, { node_id: sampleNode.id, direction: 'both', max_depth: 2 });
        const e = performance.now() - s;
        if (i >= WARMUP) travTimes.push(e);
      }
      report('traverse-graph 2-hop', travTimes);
      console.log(`Threshold: p95 < 200ms — ${percentile(travTimes.sort((a,b)=>a-b), 95) < 200 ? 'PASS' : 'FAIL'}`);
    } else {
      console.log('No nodes to traverse — skipped');
    }

    // P5: hydrateNodes (100 nodes)
    console.log('\n=== P5: hydrateNodes (100 nodes) ===');
    const nodeRows = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, updated_at
      FROM nodes LIMIT 100
    `).all();
    // We can't call hydrateNodes directly (it's inside createServer closure)
    // Simulate the same queries:
    const hydrateTimes: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      const ids = (nodeRows as any[]).map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`).all(...ids);
      db.prepare(`SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`).all(...ids);
      const e = performance.now() - s;
      if (i >= WARMUP) hydrateTimes.push(e);
    }
    report('hydrateNodes (100 nodes)', hydrateTimes);
    console.log(`Threshold: p95 < 50ms — ${percentile(hydrateTimes.sort((a,b)=>a-b), 95) < 50 ? 'PASS' : 'FAIL'}`);

    db.close();
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
```

- [ ] **Step 2: Add `bench` script to `package.json`**

Add to `package.json` scripts:
```json
"bench": "tsx benchmarks/run.ts"
```

- [ ] **Step 3: Run benchmarks against test vault**

Run: `npm run bench -- /path/to/test-vault`
Expected: All 5 benchmarks report results. Note any that exceed thresholds.

- [ ] **Step 4: Optimize any failures**

If any benchmark exceeds its threshold:
- P1 (rebuild >30s): Profile parsing vs. DB writes. Consider batching INSERT statements.
- P2 (incremental >2s): Profile stat() calls. Consider parallel stat.
- P3 (query >100ms): Check EXPLAIN QUERY PLAN. Add indices if table scans detected.
- P4 (traverse >200ms): Check if IN clause chunking is too small or too many levels.
- P5 (hydrate >50ms): Verify batch queries, no per-node queries.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/run.ts package.json
git commit -m "add performance benchmark suite (P1-P5)"
```

---

### Task 11: Documentation Update

**Files:**
- Modify: `CLAUDE.md` (update tool count, add workflow tools section)
- Modify: `docs/plans/2026-03-25-phase-6-workflow-tools-design.md` (mark complete if all tasks done)

- [ ] **Step 1: Update CLAUDE.md**

Update the MCP Layer section to reflect the new tool count (19 tools) and add brief descriptions of the 4 new workflow tools. Update the Phase 6 status in MEMORY.md.

Key changes:
- Tool count: 15 → 19
- Add `workflow-tools.ts` to the MCP Layer description
- Add comparison operators note to `query-nodes` description
- Mention `computeProjectTaskStats` shared helper

- [ ] **Step 2: Update memory**

Update the project memory to reflect Phase 6 completion status.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "update docs for Phase 6 workflow tools"
```
