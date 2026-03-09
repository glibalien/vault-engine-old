# Schema Introspection MCP Tools — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three MCP tools (`list-schemas`, `describe-schema`, `validate-node`) that expose the schema system to agents.

**Architecture:** Thin wrappers in `src/mcp/server.ts` over existing `getAllSchemas`, `getSchema`, `mergeSchemaFields`, and `validateNode` functions. Tests use the same in-memory MCP client/server pattern as existing MCP tests.

**Tech Stack:** TypeScript ESM, better-sqlite3, @modelcontextprotocol/sdk, zod, vitest

---

### Task 1: `list-schemas` tool — test + implementation

**Files:**
- Modify: `tests/mcp/server.test.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Write the failing tests**

Add this `describe` block at the end of the `MCP server` describe in `tests/mcp/server.test.ts`:

```typescript
describe('list-schemas', () => {
  it('returns empty array when no schemas are loaded', async () => {
    const result = await client.callTool({ name: 'list-schemas', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('returns schema summaries with field counts', async () => {
    // Load schemas from fixtures
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({ name: 'list-schemas', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Fixtures have: task, work-task, person, meeting
    expect(data).toHaveLength(4);
    const task = data.find((s: any) => s.name === 'task');
    expect(task).toBeDefined();
    expect(task.display_name).toBe('Task');
    expect(task.field_count).toBe(4); // status, assignee, due_date, priority
    expect(task.extends).toBeNull();
    expect(task.ancestors).toEqual([]);

    const workTask = data.find((s: any) => s.name === 'work-task');
    expect(workTask.extends).toBe('task');
    expect(workTask.ancestors).toEqual(['task']);
    expect(workTask.field_count).toBe(7); // 4 inherited + project, department, billable
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `list-schemas` tool not found.

**Step 3: Implement `list-schemas` in `src/mcp/server.ts`**

Add import at top of file:

```typescript
import { getAllSchemas } from '../schema/loader.js';
```

Add tool registration before the `return server;` line:

```typescript
server.tool(
  'list-schemas',
  'List all schema definitions loaded from YAML. Shows what structure is defined, as opposed to list-types which shows what types nodes actually have.',
  {},
  async () => {
    const schemas = getAllSchemas(db);
    const summaries = schemas.map(s => ({
      name: s.name,
      display_name: s.display_name ?? null,
      icon: s.icon ?? null,
      extends: s.extends ?? null,
      ancestors: s.ancestors,
      field_count: Object.keys(s.fields).length,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summaries) }] };
  },
);
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/mcp/server.test.ts src/mcp/server.ts
git commit -m "add list-schemas MCP tool"
```

---

### Task 2: `describe-schema` tool — test + implementation

**Files:**
- Modify: `tests/mcp/server.test.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Write the failing tests**

Add this `describe` block after `list-schemas` in the test file:

```typescript
describe('describe-schema', () => {
  it('returns full schema with inherited fields', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'describe-schema',
      arguments: { schema_name: 'work-task' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.name).toBe('work-task');
    expect(data.extends).toBe('task');
    expect(data.ancestors).toEqual(['task']);
    // Should include inherited fields from task
    expect(data.fields.status).toBeDefined();
    expect(data.fields.status.type).toBe('enum');
    // And own fields
    expect(data.fields.department).toBeDefined();
    expect(data.fields.department.type).toBe('string');
  });

  it('returns error for unknown schema', async () => {
    const result = await client.callTool({
      name: 'describe-schema',
      arguments: { schema_name: 'nonexistent' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('not found');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `describe-schema` tool not found.

**Step 3: Implement `describe-schema` in `src/mcp/server.ts`**

Add import (alongside existing `getAllSchemas`):

```typescript
import { getAllSchemas, getSchema } from '../schema/loader.js';
```

Add tool registration:

```typescript
server.tool(
  'describe-schema',
  'Get the full definition of a schema including inherited fields, field types, and constraints',
  {
    schema_name: z.string().describe('Schema name, e.g. "task", "work-task"'),
  },
  async ({ schema_name }) => {
    const schema = getSchema(db, schema_name);
    if (!schema) {
      return {
        content: [{ type: 'text', text: `Error: Schema not found: ${schema_name}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
  },
);
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/mcp/server.test.ts src/mcp/server.ts
git commit -m "add describe-schema MCP tool"
```

---

### Task 3: `validate-node` tool (node_id mode) — test + implementation

**Files:**
- Modify: `tests/mcp/server.test.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Write the failing tests**

Add this `describe` block after `describe-schema`:

```typescript
describe('validate-node', () => {
  it('validates an existing node by ID', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));
    indexFixture(db, 'sample-task.md', 'tasks/review.md');

    const result = await client.callTool({
      name: 'validate-node',
      arguments: { node_id: 'tasks/review.md' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.valid).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  it('returns validation warnings for invalid node', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    // Index a task node with missing required field (status) and bad enum (priority)
    const raw = [
      '---',
      'title: Bad Task',
      'types: [task]',
      'priority: extreme',
      '---',
      'Content here.',
    ].join('\n');
    const parsed = (await import('../../src/parser/index.js')).parseFile('tasks/bad.md', raw);
    indexFile(db, parsed, 'tasks/bad.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await client.callTool({
      name: 'validate-node',
      arguments: { node_id: 'tasks/bad.md' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.valid).toBe(false);
    expect(data.warnings.length).toBeGreaterThan(0);
    const rules = data.warnings.map((w: any) => w.rule);
    expect(rules).toContain('required');    // missing status
    expect(rules).toContain('invalid_enum'); // extreme not in enum
  });

  it('returns error for nonexistent node', async () => {
    const result = await client.callTool({
      name: 'validate-node',
      arguments: { node_id: 'nonexistent.md' },
    });

    expect(result.isError).toBe(true);
  });

  it('returns valid with empty warnings when node has no schemas', async () => {
    // Index a node with types that have no schema definitions loaded
    const raw = [
      '---',
      'title: Orphan',
      'types: [unknown-type]',
      '---',
      'Content.',
    ].join('\n');
    const parsed = (await import('../../src/parser/index.js')).parseFile('orphan.md', raw);
    indexFile(db, parsed, 'orphan.md', '2025-03-10T00:00:00.000Z', raw);

    const result = await client.callTool({
      name: 'validate-node',
      arguments: { node_id: 'orphan.md' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.valid).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  it('returns error when neither node_id nor types provided', async () => {
    const result = await client.callTool({
      name: 'validate-node',
      arguments: {},
    });

    expect(result.isError).toBe(true);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `validate-node` tool not found.

**Step 3: Implement `validate-node` in `src/mcp/server.ts`**

Add imports:

```typescript
import { mergeSchemaFields } from '../schema/merger.js';
import { validateNode } from '../schema/validator.js';
import type { FieldEntry, FieldValueType } from '../parser/types.js';
```

Add a helper function inside `createServer` (after `hydrateNodes`):

```typescript
function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
  const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined;
  if (!node) return null;

  const typeRows = db.prepare(
    'SELECT schema_type FROM node_types WHERE node_id = ?'
  ).all(nodeId) as Array<{ schema_type: string }>;
  const types = typeRows.map(r => r.schema_type);

  const fieldRows = db.prepare(
    'SELECT key, value_text, value_type, value_number, value_date FROM fields WHERE node_id = ?'
  ).all(nodeId) as Array<{ key: string; value_text: string; value_type: string; value_number: number | null; value_date: string | null }>;

  const fields: FieldEntry[] = fieldRows.map(r => {
    let value: unknown = r.value_text;
    const valueType = r.value_type as FieldValueType;
    if (valueType === 'number' && r.value_number !== null) value = r.value_number;
    else if (valueType === 'date' && r.value_date) value = new Date(r.value_date);
    else if (valueType === 'list' && r.value_text) {
      try { value = JSON.parse(r.value_text); } catch { /* keep as string */ }
    }
    return { key: r.key, value, valueType };
  });

  return { types, fields };
}
```

Add a helper to infer `FieldValueType` from JS values (for hypothetical mode, used in Task 4):

```typescript
function inferFieldType(value: unknown): FieldValueType {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string' && /^\[\[.+\]\]$/.test(value)) return 'reference';
  return 'string';
}
```

Add tool registration:

```typescript
server.tool(
  'validate-node',
  'Validate a node against its schemas. Provide node_id for an existing node, or types + fields for hypothetical validation.',
  {
    node_id: z.string().optional()
      .describe('Validate an existing node by its ID (vault-relative path)'),
    types: z.array(z.string()).optional()
      .describe('Schema types for hypothetical validation, e.g. ["task", "meeting"]'),
    fields: z.record(z.unknown()).optional()
      .describe('Field values for hypothetical validation, e.g. { "status": "todo" }'),
  },
  async ({ node_id, types, fields: hypotheticalFields }) => {
    if (!node_id && !types) {
      return {
        content: [{ type: 'text', text: 'Error: Provide node_id or types (with optional fields)' }],
        isError: true,
      };
    }

    let nodeTypes: string[];
    let fieldEntries: FieldEntry[];

    if (node_id) {
      const loaded = loadNodeForValidation(node_id);
      if (!loaded) {
        return {
          content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
          isError: true,
        };
      }
      nodeTypes = loaded.types;
      fieldEntries = loaded.fields;
    } else {
      nodeTypes = types!;
      fieldEntries = Object.entries(hypotheticalFields ?? {}).map(([key, value]) => ({
        key,
        value,
        valueType: inferFieldType(value),
      }));
    }

    // If no types have schemas, nothing to validate
    const hasKnownSchema = nodeTypes.some(t =>
      db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(t) !== undefined
    );
    if (!hasKnownSchema) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ valid: true, warnings: [] }) }],
      };
    }

    const merge = mergeSchemaFields(db, nodeTypes);
    const parsed = {
      filePath: node_id ?? 'hypothetical',
      frontmatter: {},
      types: nodeTypes,
      fields: fieldEntries,
      wikiLinks: [],
      mdast: { type: 'root' as const, children: [] },
      contentText: '',
      contentMd: '',
    };
    const result = validateNode(parsed, merge);

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/mcp/server.test.ts src/mcp/server.ts
git commit -m "add validate-node MCP tool (node_id mode)"
```

---

### Task 4: `validate-node` hypothetical mode — test + implementation

**Files:**
- Modify: `tests/mcp/server.test.ts`

**Step 1: Write the failing tests**

Add these tests inside the existing `validate-node` describe block (before the closing `});`):

```typescript
  it('validates hypothetical data with types and fields', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'validate-node',
      arguments: {
        types: ['task'],
        fields: { status: 'todo', priority: 'high' },
      },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.valid).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  it('returns warnings for hypothetical data with invalid fields', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'validate-node',
      arguments: {
        types: ['task'],
        fields: { priority: 'extreme' },
      },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.valid).toBe(false);
    const rules = data.warnings.map((w: any) => w.rule);
    expect(rules).toContain('required');     // missing status
    expect(rules).toContain('invalid_enum'); // extreme not valid
  });

  it('validates hypothetical data with types only (no fields)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, resolve(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'validate-node',
      arguments: { types: ['task'] },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // task schema has required: status, so should warn
    expect(data.valid).toBe(false);
    expect(data.warnings.some((w: any) => w.rule === 'required' && w.field === 'status')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they pass**

The implementation from Task 3 already handles hypothetical mode. These tests should pass immediately.

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS (hypothetical mode already implemented in Task 3).

**Step 3: Commit**

```bash
git add tests/mcp/server.test.ts
git commit -m "add validate-node hypothetical mode tests"
```

---

### Task 5: Run full test suite + update phase 2 checklist

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 2: Update phase 2 checklist**

In `docs/phase-2-overview.md`, check the three MCP tool items:

```markdown
- [x] MCP tool: `list-schemas`
- [x] MCP tool: `describe-schema`
- [x] MCP tool: `validate-node`
```

**Step 3: Commit**

```bash
git add docs/phase-2-overview.md
git commit -m "mark phase 2 task 5 (schema introspection MCP tools) complete"
```
