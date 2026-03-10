# update-node Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `update-node` MCP tool that modifies existing nodes' fields and/or body content with merge semantics.

**Architecture:** Read existing `.md` file → parse → merge field updates → resolve body → validate against schemas → serialize → write → re-index → return hydrated node with warnings. Reuses the same serializer, file writer, and validation pipeline as `create-node`.

**Tech Stack:** TypeScript, vitest, MCP SDK (Zod params), better-sqlite3, gray-matter

---

## File Structure

- **Modify:** `src/mcp/server.ts` — add `readFileSync` import, `updateNode` helper function, `update-node` tool registration
- **Create:** `tests/mcp/update-node.test.ts` — 16 tests covering errors, field merge, body handling, validation, and re-indexing

---

### Task 1: Error handling + tool registration

**Files:**
- Create: `tests/mcp/update-node.test.ts`
- Modify: `src/mcp/server.ts:11,229,585`

- [ ] **Step 1: Write error handling tests**

Create `tests/mcp/update-node.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('update-node', () => {
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

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'create-node',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when no updates provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: { node_id: 'Target.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('No updates provided');
  });

  it('returns error when both body and append_body provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Target.md',
        body: 'new body',
        append_body: 'more content',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('body');
    expect(text).toContain('append_body');
    expect(text).toContain('mutually exclusive');
  });

  it('returns error when node does not exist', async () => {
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'nonexistent.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
    expect(text).toContain('nonexistent.md');
  });

  it('returns error when file is missing on disk but exists in DB', async () => {
    await createTestNode({ title: 'Ghost' });
    // Delete the file but leave the DB entry
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Ghost.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File not found on disk');
    expect(text).toContain('out of sync');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: FAIL — `update-node` tool not registered

- [ ] **Step 3: Implement `updateNode` scaffolding + tool registration**

In `src/mcp/server.ts`:

1. Add `readFileSync` to the `node:fs` import (line 11):

```typescript
import { existsSync, statSync, readFileSync } from 'node:fs';
```

2. Add `updateNode` function after `createNode` (after line 229):

```typescript
  function updateNode(params: {
    node_id: string;
    fields?: Record<string, unknown>;
    body?: string;
    append_body?: string;
  }) {
    const { node_id, fields: fieldUpdates, body: newBody, append_body } = params;

    // Param validation
    if (!fieldUpdates && newBody === undefined && append_body === undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Error: No updates provided: at least one of fields, body, or append_body is required' }],
        isError: true,
      };
    }
    if (newBody !== undefined && append_body !== undefined) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Cannot provide both body and append_body — they are mutually exclusive' }],
        isError: true,
      };
    }

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${node_id}` }],
        isError: true,
      };
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text' as const, text: `Error: File not found on disk: ${node_id}. Database and filesystem are out of sync.` }],
        isError: true,
      };
    }

    throw new Error('Update pipeline not yet implemented');
  }
```

3. Add tool registration after the `create-node` tool (after line 585, before `return server`):

```typescript
  server.tool(
    'update-node',
    'Update an existing node\'s fields and/or body content. Fields are merged (not replaced); set a field to null to remove it.',
    {
      node_id: z.string().describe('Vault-relative file path of the node to update, e.g. "tasks/review.md"'),
      fields: z.record(z.string(), z.unknown()).optional()
        .describe('Fields to update (merged with existing). Set a value to null to remove a field.'),
      body: z.string().optional()
        .describe('Replace the entire body content'),
      append_body: z.string().optional()
        .describe('Append to existing body content'),
    },
    async (params) => {
      try {
        return updateNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/update-node.test.ts src/mcp/server.ts
git commit -m "add update-node error handling tests and tool registration"
```

---

### Task 2: Field updates with full pipeline

**Files:**
- Modify: `tests/mcp/update-node.test.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Write field merge tests**

Add to `tests/mcp/update-node.test.ts` inside the `describe` block:

```typescript
  it('updates a field while preserving existing fields', async () => {
    await createTestNode({
      title: 'My Task',
      fields: { status: 'todo', priority: 'high' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'My Task.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('done');
    expect(data.node.fields.priority).toBe('high');

    // Verify file content
    const content = readFileSync(join(vaultPath, 'My Task.md'), 'utf-8');
    expect(content).toContain('status: done');
    expect(content).toContain('priority: high');
  });

  it('adds a new field to an existing node', async () => {
    await createTestNode({
      title: 'Simple Note',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Simple Note.md',
        fields: { priority: 'high' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBe('high');
  });

  it('removes a field by setting it to null', async () => {
    await createTestNode({
      title: 'Removable',
      fields: { status: 'todo', priority: 'high', assignee: '[[Alice]]' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Removable.md',
        fields: { priority: null },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBeUndefined();
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    // Verify field is gone from file
    const content = readFileSync(join(vaultPath, 'Removable.md'), 'utf-8');
    expect(content).not.toContain('priority');
  });

  it('ignores title and types in field updates', async () => {
    await createTestNode({
      title: 'Immutable',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Immutable.md',
        fields: { title: 'Changed', types: ['task'], status: 'done' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('done');

    // Title should remain unchanged, no duplicate keys
    const content = readFileSync(join(vaultPath, 'Immutable.md'), 'utf-8');
    expect(content).toContain('title: Immutable');
    expect(content).not.toContain('title: Changed');
  });

  it('handles mixed operations: update, add, and remove fields', async () => {
    await createTestNode({
      title: 'Mixed',
      fields: { status: 'todo', old_field: 'remove me' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Mixed.md',
        fields: {
          status: 'in-progress',
          new_field: 'hello',
          old_field: null,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('in-progress');
    expect(data.node.fields.new_field).toBe('hello');
    expect(data.node.fields.old_field).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: 5 new tests FAIL with `"Update pipeline not yet implemented"`

- [ ] **Step 3: Implement full update pipeline**

In `src/mcp/server.ts`, replace `throw new Error('Update pipeline not yet implemented');` in the `updateNode` function with:

```typescript
    // Read existing file
    const raw = readFileSync(absPath, 'utf-8');

    // Parse existing file
    const parsed = parseFile(node_id, raw);

    // Extract title and types (immutable in update-node)
    const title = typeof parsed.frontmatter.title === 'string'
      ? parsed.frontmatter.title
      : node_id.replace(/\.md$/, '').split('/').pop()!;
    const types = parsed.types;

    // Merge fields: existing (excluding meta-keys) + updates
    const mergedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      mergedFields[key] = value;
    }
    if (fieldUpdates) {
      for (const [key, value] of Object.entries(fieldUpdates)) {
        if (key === 'title' || key === 'types') continue;
        if (value === null) {
          delete mergedFields[key];
        } else {
          mergedFields[key] = value;
        }
      }
    }

    // Resolve body
    let body: string;
    if (newBody !== undefined) {
      body = newBody;
    } else if (append_body !== undefined) {
      body = parsed.contentMd ? `${parsed.contentMd}\n\n${append_body}` : append_body;
    } else {
      body = parsed.contentMd;
    }

    // Validate against schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);
    let warnings: ValidationWarning[] = [];

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const forValidation = {
        filePath: node_id,
        frontmatter: {},
        types,
        fields: Object.entries(mergedFields).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        })),
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const validation = validateNode(forValidation, mergeResult);
      warnings = validation.warnings;
    }

    // Compute field order + serialize
    const fieldOrder = computeFieldOrder(types, db);
    const content = serializeNode({
      title,
      types,
      fields: mergedFields,
      body: body || undefined,
      fieldOrder,
    });

    // Write file (same path — update in place)
    writeNodeFile(vaultPath, node_id, content);

    // Stat for mtime
    const stat = statSync(absPath);
    const mtime = stat.mtime.toISOString();

    // Parse + index + resolve refs in transaction
    const reParsed = parseFile(node_id, content);
    db.transaction(() => {
      indexFile(db, reParsed, node_id, mtime, content);
      resolveReferences(db);
    })();

    // Return hydrated node + warnings
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(node_id) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings }) }],
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add tests/mcp/update-node.test.ts src/mcp/server.ts
git commit -m "add update-node field merge with read-parse-merge-serialize-write pipeline"
```

---

### Task 3: Body handling

**Files:**
- Modify: `tests/mcp/update-node.test.ts`

- [ ] **Step 1: Write body handling tests**

Add to `tests/mcp/update-node.test.ts`:

```typescript
  it('replaces body content', async () => {
    await createTestNode({
      title: 'Body Test',
      fields: { status: 'todo' },
      body: 'Original body content.',
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Body Test.md',
        body: 'Completely new body.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Body Test.md'), 'utf-8');
    expect(content).toContain('Completely new body.');
    expect(content).not.toContain('Original body');

    // Existing fields preserved
    expect(content).toContain('status: todo');
  });

  it('appends to existing body content', async () => {
    await createTestNode({
      title: 'Append Test',
      body: 'First paragraph.',
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Append Test.md',
        append_body: 'Second paragraph.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Append Test.md'), 'utf-8');
    expect(content).toContain('First paragraph.');
    expect(content).toContain('Second paragraph.');
  });

  it('appends body when node has no existing body', async () => {
    await createTestNode({ title: 'No Body' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'No Body.md',
        append_body: 'New content.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'No Body.md'), 'utf-8');
    expect(content).toContain('New content.');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: All 12 tests PASS (body handling already implemented in Task 2's pipeline)

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/update-node.test.ts
git commit -m "add update-node body handling tests"
```

---

### Task 4: Schema validation, field order, and re-indexing integration

**Files:**
- Modify: `tests/mcp/update-node.test.ts`

- [ ] **Step 1: Write schema validation and integration tests**

Add to `tests/mcp/update-node.test.ts`:

```typescript
  it('returns validation warnings after field update', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Valid Task',
      types: ['task'],
      fields: { status: 'todo', priority: 'high' },
    });

    // Update with invalid enum value
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/Valid Task.md',
        fields: { priority: 'extreme' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // Node updated despite warnings
    expect(data.node.fields.priority).toBe('extreme');
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings.some((w: any) => w.rule === 'invalid_enum')).toBe(true);
  });

  it('preserves schema field order in serialized output', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Ordered Task',
      types: ['task'],
      fields: { status: 'todo', priority: 'high', assignee: '[[Bob]]' },
    });

    // Update to add due_date — output should preserve schema field order
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/Ordered Task.md',
        fields: { due_date: '2026-04-01' },
      },
    });

    expect(result.isError).toBeFalsy();
    // Schema frontmatter_fields order: [status, assignee, due_date, priority]
    const content = readFileSync(join(vaultPath, 'tasks/Ordered Task.md'), 'utf-8');
    const statusIdx = content.indexOf('status:');
    const assigneeIdx = content.indexOf('assignee:');
    const dueDateIdx = content.indexOf('due_date:');
    const priorityIdx = content.indexOf('priority:');
    expect(statusIdx).toBeLessThan(assigneeIdx);
    expect(assigneeIdx).toBeLessThan(dueDateIdx);
    expect(dueDateIdx).toBeLessThan(priorityIdx);
  });

  it('updated node is queryable via get-node with new values', async () => {
    await createTestNode({
      title: 'Queryable',
      fields: { status: 'todo' },
      body: 'Original content.',
    });

    await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Queryable.md',
        fields: { status: 'done' },
        body: 'Updated content with xylophone.',
      },
    });

    // get-node should return updated data
    const result = await client.callTool({
      name: 'get-node',
      arguments: { node_id: 'Queryable.md' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.fields.status).toBe('done');
    expect(data.content_text).toContain('xylophone');
  });

  it('resolves references after adding wiki-link field', async () => {
    const { writeFileSync: fsWriteFileSync, mkdirSync: fsMkdirSync } = await import('node:fs');
    const { parseFile: parseFileSync } = await import('../../src/parser/index.js');
    const { indexFile: indexFileSync } = await import('../../src/sync/indexer.js');

    // Create target node on disk and index it
    const aliceContent = '---\ntitle: Alice\ntypes: [person]\n---\n';
    fsMkdirSync(join(vaultPath, 'people'), { recursive: true });
    fsWriteFileSync(join(vaultPath, 'people/Alice.md'), aliceContent, 'utf-8');
    const aliceParsed = parseFileSync('people/Alice.md', aliceContent);
    db.transaction(() => {
      indexFileSync(db, aliceParsed, 'people/Alice.md', new Date().toISOString(), aliceContent);
    })();

    // Create a node without the reference
    await createTestNode({
      title: 'Unlinked Task',
      fields: { status: 'todo' },
    });

    // Update to add the reference
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Unlinked Task.md',
        fields: { assignee: '[[Alice]]' },
      },
    });

    expect(result.isError).toBeFalsy();

    // Check relationship resolution
    const rels = db.prepare(
      'SELECT target_id, resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('Unlinked Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const assigneeRel = rels.find(r => r.target_id === 'Alice');
    expect(assigneeRel).toBeDefined();
    expect(assigneeRel!.resolved_target_id).toBe('people/Alice.md');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-node.test.ts`
Expected: All 16 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/update-node.test.ts
git commit -m "add update-node schema validation and re-indexing integration tests"
```
