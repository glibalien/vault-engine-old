# `create-node` MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `create-node` mutation tool to the MCP server that validates, serializes, writes, indexes, and returns a new node.

**Architecture:** `createNode` helper function inside the `createServer` closure captures `db` and `vaultPath`. The tool composes existing modules: schema validation (merger + validator), serializer (node-to-file + path), writer, parser, and indexer. `createServer` signature changes from `createServer(db)` to `createServer(db, vaultPath)`.

**Tech Stack:** TypeScript ESM, vitest, better-sqlite3, MCP SDK (zod params), Node fs (statSync/existsSync)

---

## File Structure

- **Modify:** `src/mcp/server.ts` — add `vaultPath` param, `createNode` helper, `create-node` tool registration
- **Modify:** `src/serializer/path.ts` — export `sanitizeSegment` for reuse by `parent_path` logic
- **Modify:** `src/serializer/index.ts` — re-export `sanitizeSegment`
- **Modify:** `src/index.ts` — pass `vaultPath` to `createServer`
- **Test:** `tests/mcp/create-node.test.ts` — new file, focused on `create-node` tool

---

## Task 1: Update `createServer` Signature

Adds `vaultPath` parameter and updates the entry point. No behavior change yet — just plumbing.

**Files:**
- Modify: `src/mcp/server.ts:12` (`createServer` function signature)
- Modify: `src/index.ts:15` (`createServer` call site)
- Modify: `tests/mcp/server.test.ts:31` (existing test `createServer` calls)

- [ ] **Step 1: Update `createServer` signature in `src/mcp/server.ts`**

At line 12, change:

```typescript
export function createServer(db: Database.Database): McpServer {
```

to:

```typescript
export function createServer(db: Database.Database, vaultPath: string): McpServer {
```

- [ ] **Step 2: Update entry point `src/index.ts`**

At line 15, change:

```typescript
const server = createServer(db);
```

to:

```typescript
const server = createServer(db, vaultPath);
```

- [ ] **Step 3: Update existing tests in `tests/mcp/server.test.ts`**

At line 31 in the `beforeEach`, change:

```typescript
const server = createServer(db);
```

to:

```typescript
const server = createServer(db, '/tmp/test-vault');
```

The existing tests don't use `vaultPath` (they're all read-only tools), so a dummy path is fine.

- [ ] **Step 4: Run existing tests to verify nothing breaks**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: All existing tests PASS (no behavior change)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/index.ts tests/mcp/server.test.ts
git commit -m "add vaultPath param to createServer"
```

---

## Task 2: Basic `create-node` — Title Only (No Schema)

The simplest case: create a node with just a title and no types/schema. This establishes the full pipeline (serialize → generate path → check existence → write → stat → parse → index → return) without any schema complexity.

**Files:**
- Create: `tests/mcp/create-node.test.ts`
- Modify: `src/mcp/server.ts` (add imports, `createNode` helper, tool registration)

- [ ] **Step 1: Write the test file scaffold and first failing test**

Create `tests/mcp/create-node.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('create-node', () => {
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

  it('creates a node with title only (no types, no schema)', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: { title: 'My Note' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.id).toBe('My Note.md');
    expect(data.node.types).toEqual([]);
    expect(data.node.fields).toEqual({});
    expect(data.warnings).toEqual([]);

    // File should exist on disk
    const filePath = join(vaultPath, 'My Note.md');
    expect(existsSync(filePath)).toBe(true);

    // File content should be valid markdown with frontmatter
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('title: My Note');
    expect(content).toContain('types: []');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: FAIL — `create-node` tool not registered

- [ ] **Step 3: Implement `createNode` helper and `create-node` tool**

In `src/mcp/server.ts`, add imports at the top (after existing imports):

```typescript
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { serializeNode, computeFieldOrder, generateFilePath, writeNodeFile, sanitizeSegment } from '../serializer/index.js';
import { indexFile } from '../sync/indexer.js';
import { resolveReferences } from '../sync/resolver.js';
import type { ValidationWarning } from '../schema/types.js';
```

Note: `mergeSchemaFields` and `validateNode` are already imported at the top of `server.ts` — no new imports needed for those.

Also, export `sanitizeSegment` from the serializer module. In `src/serializer/path.ts`, change `function sanitizeSegment` to `export function sanitizeSegment`. In `src/serializer/index.ts`, add `sanitizeSegment` to the re-exports from `'./path.js'`.

Then, inside the `createServer` function body (after the existing helper functions, before the first `server.tool` call), add the `createNode` helper:

```typescript
  function createNode(params: {
    title: string;
    types: string[];
    fields: Record<string, unknown>;
    body?: string;
    parent_path?: string;
    relationships: Array<{ target: string; rel_type: string }>;
  }) {
    const { title, types, body: inputBody, parent_path, relationships } = params;
    const fields = { ...params.fields };
    let body = inputBody ?? '';

    // Step 1: Validate against schemas (if any types have schemas)
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let mergeResult = hasSchemas ? mergeSchemaFields(db, types) : null;
    let warnings: ValidationWarning[] = [];

    if (mergeResult) {
      const parsed = {
        filePath: 'pending',
        frontmatter: {},
        types,
        fields: Object.entries(fields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(parsed, mergeResult);
      warnings = validation.warnings;
    }

    // Step 2: Process relationships
    for (const rel of relationships) {
      const target = rel.target.startsWith('[[') ? rel.target : `[[${rel.target}]]`;

      // Check if rel_type is a schema field
      const mergedField = mergeResult?.fields[rel.rel_type];
      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = fields[rel.rel_type];
          if (Array.isArray(existing)) {
            existing.push(target);
          } else {
            fields[rel.rel_type] = [target];
          }
        } else {
          fields[rel.rel_type] = target;
        }
      } else if (!hasSchemas && Array.isArray(fields[rel.rel_type])) {
        // Schema-less fallback: check if existing value is an array
        (fields[rel.rel_type] as unknown[]).push(target);
      } else if (!hasSchemas && rel.rel_type in fields) {
        // Schema-less scalar field
        fields[rel.rel_type] = target;
      } else {
        // No matching field — append to body
        body = body ? `${body}\n\n${target}` : target;
      }
    }

    // Step 3: Compute field order
    const fieldOrder = computeFieldOrder(types, db);

    // Step 4: Serialize
    const content = serializeNode({ title, types, fields, body: body || undefined, fieldOrder });

    // Step 5: Generate path
    let relativePath: string;
    if (parent_path) {
      const sanitized = sanitizeSegment(title);
      const prefix = parent_path.endsWith('/') ? parent_path : `${parent_path}/`;
      relativePath = `${prefix}${sanitized}.md`;
    } else {
      relativePath = generateFilePath(title, types, fields, db);
    }

    // Step 6: Check existence
    if (existsSync(join(vaultPath, relativePath))) {
      return {
        content: [{
          type: 'text',
          text: `Error: File already exists at ${relativePath}. Use update-node to modify existing nodes or choose a different title.`,
        }],
        isError: true,
      };
    }

    // Step 7: Write
    writeNodeFile(vaultPath, relativePath, content);

    // Step 8: Stat for mtime
    const stat = statSync(join(vaultPath, relativePath));
    const mtime = stat.mtime.toISOString();

    // Step 9: Parse + index + resolve refs in transaction
    const parsed = parseFile(relativePath, content);
    db.transaction(() => {
      indexFile(db, parsed, relativePath, mtime, content);
      resolveReferences(db);
    })();

    // Step 10: Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(relativePath) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text', text: JSON.stringify({ node, warnings }) }],
    };
  }
```

Then register the tool (after the `validate-node` tool, before `return server`):

```typescript
  server.tool(
    'create-node',
    'Create a new node as a markdown file with frontmatter. Validates against schemas, writes to disk, and indexes.',
    {
      title: z.string().describe('Node title (required)'),
      types: z.array(z.string()).optional().default([])
        .describe('Schema types, e.g. ["task"] or ["task", "meeting"]'),
      fields: z.record(z.string(), z.unknown()).optional().default({})
        .describe('Field values, e.g. { "status": "todo", "assignee": "[[Bob]]" }'),
      body: z.string().optional()
        .describe('Markdown body content'),
      parent_path: z.string().optional()
        .describe('Override path: file created at <parent_path>/<title>.md instead of schema template'),
      relationships: z.array(z.object({
        target: z.string().describe('Wiki-link target, e.g. "Bob" or "[[Bob]]"'),
        rel_type: z.string().describe('Relationship type — schema field name for frontmatter, or appended to body'),
      })).optional().default([])
        .describe('Relationships to create with the node'),
    },
    async (params) => {
      try {
        return createNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 5: Also run existing tests to ensure no regressions**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: All PASS

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/create-node.test.ts
git commit -m "add create-node MCP tool with basic title-only creation"
```

---

## Task 3: Create Node With Types and Fields (Schema Validation)

Tests creation with typed nodes, field validation, and schema-driven path generation.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for typed node with valid fields**

Add to `tests/mcp/create-node.test.ts`, inside the `describe('create-node')` block:

```typescript
  it('creates a typed node with fields and schema-driven path', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Fix login bug',
        types: ['task'],
        fields: { status: 'todo', priority: 'high' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Schema template: "tasks/{{title}}.md"
    expect(data.node.id).toBe('tasks/Fix login bug.md');
    expect(data.node.types).toContain('task');
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBe('high');
    expect(data.warnings).toEqual([]);

    // File exists with correct content
    const content = readFileSync(join(vaultPath, 'tasks/Fix login bug.md'), 'utf-8');
    expect(content).toContain('title: Fix login bug');
    expect(content).toContain('types: [task]');
    expect(content).toContain('status: todo');
    expect(content).toContain('priority: high');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS (implementation from Task 2 should handle this)

- [ ] **Step 3: Write test for validation warnings (invalid enum)**

```typescript
  it('returns validation warnings but still creates the node', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Bad Task',
        types: ['task'],
        fields: { priority: 'extreme' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Node is created despite warnings
    expect(data.node.id).toBe('tasks/Bad Task.md');
    expect(existsSync(join(vaultPath, 'tasks/Bad Task.md'))).toBe(true);

    // Warnings present
    expect(data.warnings.length).toBeGreaterThan(0);
    const rules = data.warnings.map((w: any) => w.rule);
    expect(rules).toContain('required');     // missing status
    expect(rules).toContain('invalid_enum'); // extreme not in enum
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node tests for typed nodes and validation warnings"
```

---

## Task 4: `parent_path` Override

Tests that `parent_path` overrides the schema's `filename_template`.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for `parent_path` override**

```typescript
  it('uses parent_path to override schema filename_template', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Special Task',
        types: ['task'],
        fields: { status: 'todo' },
        parent_path: 'projects/acme',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Should use parent_path, not schema template
    expect(data.node.id).toBe('projects/acme/Special Task.md');
    expect(existsSync(join(vaultPath, 'projects/acme/Special Task.md'))).toBe(true);
  });
```

- [ ] **Step 2: Write test for `parent_path` with trailing slash**

```typescript
  it('handles parent_path with trailing slash', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Slash Test',
        parent_path: 'notes/',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.id).toBe('notes/Slash Test.md');
  });
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node tests for parent_path override"
```

---

## Task 5: File Existence Error

Tests that creating a node at an existing path returns an actionable error.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for file-already-exists error**

```typescript
  it('returns error when file already exists at generated path', async () => {
    // Create first node
    await client.callTool({
      name: 'create-node',
      arguments: { title: 'Duplicate' },
    });

    // Try to create same node again
    const result = await client.callTool({
      name: 'create-node',
      arguments: { title: 'Duplicate' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File already exists');
    expect(text).toContain('Duplicate.md');
    expect(text).toContain('update-node');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node test for file existence error"
```

---

## Task 6: Body Content

Tests that body content is included in the serialized file and indexed.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for body content**

```typescript
  it('creates a node with body content', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Meeting Notes',
        types: ['meeting'],
        fields: { date: '2026-03-09' },
        body: '## Agenda\n\n- Discuss roadmap\n- Review budget',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // meeting template: "meetings/{{date}}-{{title}}.md"
    expect(data.node.id).toBe('meetings/2026-03-09-Meeting Notes.md');

    // Body content in file
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('## Agenda');
    expect(content).toContain('- Discuss roadmap');

    // Body content indexed for FTS
    expect(data.node.content_text).toContain('Discuss roadmap');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node test for body content"
```

---

## Task 7: Relationships

Tests the relationship processing logic: scalar field, list field, and body fallback.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for scalar relationship (schema field)**

```typescript
  it('processes scalar relationship into frontmatter field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Review PR',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // assignee is a scalar reference field in the task schema
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('assignee: "[[Alice]]"');
  });
```

- [ ] **Step 2: Write test for list relationship (schema field)**

```typescript
  it('processes list relationship by appending to array field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Sprint Review',
        types: ['meeting'],
        fields: { date: '2026-03-09' },
        relationships: [
          { target: 'Alice', rel_type: 'attendees' },
          { target: 'Bob', rel_type: 'attendees' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // attendees is list<reference> in meeting schema
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });
```

- [ ] **Step 3: Write test for body fallback (no matching schema field)**

```typescript
  it('appends relationship to body when rel_type has no schema field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Research Note',
        types: ['task'],
        fields: { status: 'todo' },
        body: 'Some initial notes.',
        relationships: [
          { target: 'Related Paper', rel_type: 'wiki-link' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Research Note.md'), 'utf-8');
    // Body should contain the original text and the appended wiki-link
    expect(content).toContain('Some initial notes.');
    expect(content).toContain('[[Related Paper]]');
  });
```

- [ ] **Step 4: Write test for already-wrapped `[[target]]` syntax**

```typescript
  it('does not double-wrap targets already in [[bracket]] syntax', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Linked Task',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: '[[Bob Jones]]', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('assignee: "[[Bob Jones]]"');
    expect(content).not.toContain('[[[[');
  });
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node tests for relationships (scalar, list, body fallback)"
```

---

## Task 8: Node Indexed and Queryable

Verifies the created node is fully indexed and queryable via existing read tools.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test that created node is retrievable via `get-node`**

```typescript
  it('created node is retrievable via get-node', async () => {
    await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Queryable Node',
        types: ['task'],
        fields: { status: 'todo', priority: 'high' },
        body: 'This should be searchable.',
      },
    });

    // Retrieve via get-node
    const result = await client.callTool({
      name: 'get-node',
      arguments: { node_id: 'Queryable Node.md' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.id).toBe('Queryable Node.md');
    expect(data.types).toContain('task');
    expect(data.fields.status).toBe('todo');
    expect(data.content_text).toContain('searchable');
  });
```

- [ ] **Step 2: Write test that created node is found via `query-nodes`**

```typescript
  it('created node is found via query-nodes full-text search', async () => {
    await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Searchable Task',
        types: ['task'],
        fields: { status: 'todo' },
        body: 'Unique keyword xylophone for search.',
      },
    });

    const result = await client.callTool({
      name: 'query-nodes',
      arguments: { full_text: 'xylophone' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('Searchable Task.md');
  });
```

Note: these tests don't need schema loading since they use types without filename templates — the node lands at `<title>.md`. For the first test, add this to the beginning if schema path generation is needed, or just use no types. Actually, looking at this more carefully: these tests pass `types: ['task']` but don't load schemas, so `generateFilePath` will fall back to `{{title}}.md` (no schema = no template). That's correct behavior and tests it well.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node integration tests for indexing and queryability"
```

---

## Task 9: Reference Resolution

Verifies that wiki-links in the created node get resolved to target node IDs.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for reference resolution after create**

```typescript
  it('resolves references in the created node', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    const { indexFile: indexFileSync } = await import('../../src/sync/indexer.js');
    const { parseFile: parseFileSync } = await import('../../src/parser/index.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // First, create a target node (Alice) on disk and index it
    const aliceContent = '---\ntitle: Alice\ntypes: [person]\nrole: Engineer\n---\n';
    mkdirSync(join(vaultPath, 'people'), { recursive: true });
    writeFileSync(join(vaultPath, 'people/Alice.md'), aliceContent, 'utf-8');
    const aliceParsed = parseFileSync('people/Alice.md', aliceContent);
    db.transaction(() => {
      indexFileSync(db, aliceParsed, 'people/Alice.md', new Date().toISOString(), aliceContent);
    })();

    // Now create a task that references Alice
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Assigned Task',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();

    // Check that the relationship is resolved
    const rels = db.prepare(
      'SELECT target_id, resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('tasks/Assigned Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const assigneeRel = rels.find(r => r.target_id === 'Alice');
    expect(assigneeRel).toBeDefined();
    expect(assigneeRel!.resolved_target_id).toBe('people/Alice.md');
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node test for reference resolution"
```

---

## Task 10: Schema-Less Node With Relationships

Tests relationship processing for nodes without schemas (array fallback logic).

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for schema-less node with body relationship**

```typescript
  it('appends relationships to body for schema-less nodes', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Loose Note',
        body: 'Some thoughts.',
        relationships: [
          { target: 'Idea A', rel_type: 'related' },
          { target: 'Idea B', rel_type: 'related' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Loose Note.md'), 'utf-8');
    expect(content).toContain('Some thoughts.');
    expect(content).toContain('[[Idea A]]');
    expect(content).toContain('[[Idea B]]');
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node test for schema-less relationships"
```

---

## Task 11: Edge Cases — Missing Template Variable and Schema-Less Scalar Overwrite

Tests error handling for missing template variables and the schema-less scalar field overwrite path.

**Files:**
- Modify: `tests/mcp/create-node.test.ts`

- [ ] **Step 1: Write test for missing template variable error**

```typescript
  it('returns error when schema template requires a field not provided', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // meeting schema template: "meetings/{{date}}-{{title}}.md"
    // Omit the required 'date' field
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'No Date Meeting',
        types: ['meeting'],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('date');
    expect(text).toContain('no value');
  });
```

- [ ] **Step 2: Write test for schema-less scalar field overwrite via relationship**

```typescript
  it('overwrites existing scalar field via relationship for schema-less nodes', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Override Test',
        fields: { assignee: 'placeholder' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Override Test.md'), 'utf-8');
    // Relationship should overwrite the placeholder value
    expect(content).toContain('[[Alice]]');
    expect(content).not.toContain('placeholder');
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/mcp/create-node.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/create-node.test.ts
git commit -m "add create-node edge case tests (missing template var, schema-less overwrite)"
```
