# batch-mutate + remove-relationship Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `remove-relationship` and `batch-mutate` MCP tools, completing Phase 3 of the vault-engine write path.

**Architecture:** Four sequential tasks: (1) pure helper for body link removal, (2) `remove-relationship` MCP tool mirroring `add-relationship`, (3) refactor existing helpers into inner/outer functions to support shared transaction control, (4) `batch-mutate` MCP tool with file rollback for atomicity.

**Tech Stack:** TypeScript ESM, vitest, better-sqlite3, MCP SDK, remark/mdast

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/mcp/rename-helpers.ts` | Modify | Add `removeBodyWikiLink` helper |
| `tests/mcp/rename-helpers.test.ts` | Modify | Add tests for `removeBodyWikiLink` |
| `tests/mcp/remove-relationship.test.ts` | Create | Tests for `remove-relationship` MCP tool |
| `src/mcp/server.ts` | Modify | Add `removeRelationship`, `deleteNodeInner`, `batchMutate`; refactor inner/outer pattern; register 2 new MCP tools |
| `tests/mcp/batch-mutate.test.ts` | Create | Tests for `batch-mutate` MCP tool |

---

## Chunk 1: Tasks 1-2 (removeBodyWikiLink + remove-relationship)

### Task 1: `removeBodyWikiLink` helper

**Files:**
- Modify: `src/mcp/rename-helpers.ts`
- Modify: `tests/mcp/rename-helpers.test.ts`

- [ ] **Step 1: Write failing tests for `removeBodyWikiLink`**

Add a new `describe` block at the end of `tests/mcp/rename-helpers.test.ts`:

```typescript
describe('removeBodyWikiLink', () => {
  it('removes a single wiki-link from body text', () => {
    const body = 'See [[Alice]] for details.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('See  for details.');
  });

  it('removes wiki-link with alias', () => {
    const body = 'Contact [[Alice|the boss]] today.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('Contact  today.');
  });

  it('matches case-insensitively', () => {
    const body = 'See [[alice]] here.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('See  here.');
  });

  it('removes all occurrences of matching link', () => {
    const body = 'First [[Alice]], then [[Alice]] again.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('First , then  again.');
  });

  it('does not remove substring matches', () => {
    const body = 'See [[Alice Cooper]] and [[Alice]].';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('See [[Alice Cooper]] and .');
  });

  it('returns body unchanged when no matches', () => {
    const body = 'See [[Bob]] for details.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('See [[Bob]] for details.');
  });

  it('returns empty string for empty body', () => {
    expect(removeBodyWikiLink('', 'Alice')).toBe('');
  });

  it('collapses blank lines left by standalone link removal', () => {
    const body = 'First paragraph.\n\n[[Alice]]\n\nSecond paragraph.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('handles link as entire body', () => {
    const body = '[[Alice]]';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('');
  });

  it('handles link at start of body with trailing content', () => {
    const body = '[[Alice]]\n\nSome text.';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('Some text.');
  });

  it('handles link at end of body', () => {
    const body = 'Some text.\n\n[[Alice]]';
    const result = removeBodyWikiLink(body, 'Alice');
    expect(result).toBe('Some text.');
  });
});
```

Update the import at the top of the file to include `removeBodyWikiLink`:

```typescript
import { updateBodyReferences, updateFrontmatterReferences, removeBodyWikiLink } from '../../src/mcp/rename-helpers.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: FAIL — `removeBodyWikiLink` is not exported

- [ ] **Step 3: Implement `removeBodyWikiLink`**

Add to `src/mcp/rename-helpers.ts` after the existing `updateBodyReferences` function:

```typescript
export function removeBodyWikiLink(body: string, target: string): string {
  if (!body) return body;

  const mdast = parseMarkdown(body);
  const links = extractWikiLinksFromMdast(mdast);

  const matching = links
    .filter(l => l.target.toLowerCase() === target.toLowerCase())
    .filter(l => l.position?.start.offset != null && l.position?.end.offset != null);

  if (matching.length === 0) return body;

  // Sort by offset descending so removals don't shift earlier positions
  matching.sort((a, b) => b.position!.start.offset! - a.position!.start.offset!);

  let result = body;
  for (const link of matching) {
    const start = link.position!.start.offset!;
    const end = link.position!.end.offset!;
    result = result.slice(0, start) + result.slice(end);
  }

  // Collapse runs of 3+ newlines to 2 (preserves paragraph spacing)
  result = result.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing whitespace
  result = result.trim();

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/rename-helpers.ts tests/mcp/rename-helpers.test.ts
git commit -m "add removeBodyWikiLink helper for body link removal"
```

---

### Task 2: `remove-relationship` MCP tool

**Files:**
- Create: `tests/mcp/remove-relationship.test.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/remove-relationship.test.ts`:

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

describe('remove-relationship', () => {
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
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  // Error cases

  it('returns error when source node does not exist', async () => {
    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'nonexistent.md', target: 'Alice', rel_type: 'wiki-link' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('Node not found');
  });

  it('returns error when file is missing on disk', async () => {
    await createTestNode({ title: 'Ghost' });
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Ghost.md', target: 'Alice', rel_type: 'wiki-link' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('File not found on disk');
  });

  // Body link removal

  it('removes body wiki-link when rel_type is wiki-link', async () => {
    await createTestNode({
      title: 'Note',
      body: 'See [[Alice]] for details.',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Note.md', target: 'Alice', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Note.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  it('returns current node when body link does not exist (no-op)', async () => {
    await createTestNode({
      title: 'No Link',
      body: 'No wiki-links here.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'No Link.md'), 'utf-8');

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'No Link.md', target: 'Alice', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'No Link.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  // Schema scalar field removal

  it('removes scalar reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Assigned Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Assigned Task.md', target: 'Alice', rel_type: 'assignee' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Assigned Task.md'), 'utf-8');
    expect(content).not.toContain('assignee');
    expect(content).not.toContain('[[Alice]]');
    // Other fields preserved
    expect(content).toContain('status: todo');
  });

  it('no-op when scalar field does not match target', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Other Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'tasks/Other Task.md'), 'utf-8');

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Other Task.md', target: 'Bob', rel_type: 'assignee' },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'tasks/Other Task.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  // Schema list field removal

  it('removes item from list reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Team Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [
        { target: 'Alice', rel_type: 'attendees' },
        { target: 'Bob', rel_type: 'attendees' },
      ],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Team Meeting.md', target: 'Alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Team Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  it('removes last item from list leaving empty array', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Solo Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Solo Meeting.md', target: 'Alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Solo Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('attendees: []');
  });

  it('matches case-insensitively when removing from list', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Case Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'meetings/2026-03-09-Case Meeting.md', target: 'alice', rel_type: 'attendees' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  // Schema-less fallback

  it('removes from array field without schema', async () => {
    await createTestNode({
      title: 'Tagless Node',
      fields: { refs: ['[[Alice]]', '[[Bob]]'] },
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Tagless Node.md', target: 'Alice', rel_type: 'refs' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Tagless Node.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  it('removes scalar field without schema', async () => {
    await createTestNode({
      title: 'Scalar Node',
      fields: { owner: '[[Alice]]' },
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Scalar Node.md', target: 'Alice', rel_type: 'owner' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Scalar Node.md'), 'utf-8');
    expect(content).not.toContain('owner');
    expect(content).not.toContain('[[Alice]]');
  });

  // Body fallback

  it('removes from body when rel_type has no matching schema or frontmatter field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Body Fallback',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Related to [[SomeProject]].',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'tasks/Body Fallback.md', target: 'SomeProject', rel_type: 'unknown_field' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Body Fallback.md'), 'utf-8');
    expect(content).not.toContain('[[SomeProject]]');
  });

  // Target normalization

  it('handles already-bracketed target input', async () => {
    await createTestNode({
      title: 'Bracket Test',
      body: 'See [[Alice]] here.',
    });

    const result = await client.callTool({
      name: 'remove-relationship',
      arguments: { source_id: 'Bracket Test.md', target: '[[Alice]]', rel_type: 'wiki-link' },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Bracket Test.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/remove-relationship.test.ts`
Expected: FAIL — `remove-relationship` tool not registered

- [ ] **Step 3: Implement `removeRelationship` and register MCP tool**

In `src/mcp/server.ts`, add import for `removeBodyWikiLink`:

```typescript
import { updateBodyReferences, updateFrontmatterReferences, removeBodyWikiLink } from './rename-helpers.js';
```

Add `removeRelationship` function inside the `createServer` closure, after the `addRelationship` MCP tool registration:

```typescript
  function removeRelationship(params: {
    source_id: string;
    target: string;
    rel_type: string;
  }) {
    const { source_id, target: rawTarget, rel_type } = params;

    // Normalize: extract inner target from [[target]] or [[target|alias]]
    const innerTarget = rawTarget.startsWith('[[')
      ? (rawTarget.match(/^\[\[([^\]|]+)/)?.[1] ?? rawTarget)
      : rawTarget;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${source_id}` }],
        isError: true,
      };
    }

    const absPath = join(vaultPath, source_id);
    if (!existsSync(absPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File not found on disk: ${source_id}. Database and filesystem are out of sync.`,
        }],
        isError: true,
      };
    }

    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(source_id, raw);
    const types = parsed.types;

    // Force body if rel_type is 'wiki-link'
    if (rel_type === 'wiki-link') {
      const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
      if (!bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
        return returnCurrentNode(source_id);
      }
      const newBody = removeBodyWikiLink(parsed.contentMd, innerTarget);
      return updateNode({ node_id: source_id, body: newBody });
    }

    // Check schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const mergedField = mergeResult.fields[rel_type];

      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = parsed.frontmatter[rel_type];
          if (!Array.isArray(existing)) return returnCurrentNode(source_id);
          const filtered = existing.filter((item: unknown) => {
            if (typeof item !== 'string') return true;
            const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
            return inner == null || inner.toLowerCase() !== innerTarget.toLowerCase();
          });
          if (filtered.length === existing.length) return returnCurrentNode(source_id);
          return updateNode({
            node_id: source_id,
            fields: { [rel_type]: filtered },
          });
        } else {
          // Scalar: remove if matches
          const existing = parsed.frontmatter[rel_type];
          if (typeof existing !== 'string') return returnCurrentNode(source_id);
          const inner = existing.match(/^\[\[([^\]|]+)/)?.[1];
          if (inner == null || inner.toLowerCase() !== innerTarget.toLowerCase()) {
            return returnCurrentNode(source_id);
          }
          return updateNode({ node_id: source_id, fields: { [rel_type]: null } });
        }
      }
    }

    // Schema-less fallback: check existing frontmatter
    if (!hasSchemas && rel_type !== 'title' && rel_type !== 'types') {
      const existing = parsed.frontmatter[rel_type];
      if (Array.isArray(existing)) {
        const filtered = existing.filter((item: unknown) => {
          if (typeof item !== 'string') return true;
          const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
          return inner == null || inner.toLowerCase() !== innerTarget.toLowerCase();
        });
        if (filtered.length === existing.length) return returnCurrentNode(source_id);
        return updateNode({
          node_id: source_id,
          fields: { [rel_type]: filtered },
        });
      } else if (typeof existing === 'string' && rel_type in parsed.frontmatter) {
        const inner = existing.match(/^\[\[([^\]|]+)/)?.[1];
        if (inner == null || inner.toLowerCase() !== innerTarget.toLowerCase()) {
          return returnCurrentNode(source_id);
        }
        return updateNode({ node_id: source_id, fields: { [rel_type]: null } });
      }
    }

    // Body fallback: remove from body
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    if (!bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
      return returnCurrentNode(source_id);
    }
    const newBody = removeBodyWikiLink(parsed.contentMd, innerTarget);
    return updateNode({ node_id: source_id, body: newBody });
  }

  server.tool(
    'remove-relationship',
    'Remove a relationship from one node to another. Inverse of add-relationship. Routes to frontmatter field or body based on schema.',
    {
      source_id: z.string().describe('Vault-relative file path of the source node, e.g. "tasks/review.md"'),
      target: z.string().describe('Wiki-link target to remove, e.g. "Alice" or "[[Alice]]"'),
      rel_type: z.string().describe('Relationship type — schema field name for frontmatter, or "wiki-link" for body'),
    },
    async (params) => {
      try {
        return removeRelationship(params);
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

Run: `npx vitest run tests/mcp/remove-relationship.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run all existing tests to verify no regressions**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/rename-helpers.ts tests/mcp/rename-helpers.test.ts tests/mcp/remove-relationship.test.ts
git commit -m "add remove-relationship MCP tool with body and frontmatter routing"
```

---

## Chunk 2: Task 3 (Transaction extraction)

### Task 3: Refactor inner/outer function pattern + `deleteNodeInner`

**Files:**
- Modify: `src/mcp/server.ts`

**Why:** The existing helpers (`createNode`, `updateNode`, `addRelationship`, `removeRelationship`) each manage their own `db.transaction()` call. `batch-mutate` needs to wrap all operations in a single transaction. We extract the core logic into `*Inner` functions (no transaction, no `resolveReferences`), and the public wrappers add the transaction boundary.

**Pattern:**
```
fooInner(params) → does file I/O + DB writes, returns result object
foo(params)      → db.transaction(() => { result = fooInner(params); resolveReferences(db); return result; })()
```

- [ ] **Step 1: Refactor `createNode` into `createNodeInner` + `createNode`**

In `src/mcp/server.ts`, rename the existing `createNode` function to `createNodeInner` and create a new `createNode` wrapper.

The `createNodeInner` function is the existing body of `createNode` with one change: replace the `db.transaction(...)()` block with direct calls (no transaction, no `resolveReferences`):

Replace this inside what becomes `createNodeInner`:
```typescript
    // Step 9: Parse + index + resolve refs in transaction
    const parsed = parseFile(relativePath, content);
    db.transaction(() => {
      indexFile(db, parsed, relativePath, mtime, content);
      resolveReferences(db);
    })();
```

With:
```typescript
    // Step 9: Parse + index (no transaction, no resolveReferences — caller controls)
    const parsed = parseFile(relativePath, content);
    indexFile(db, parsed, relativePath, mtime, content);
```

Then add the wrapper:
```typescript
  function createNode(params: Parameters<typeof createNodeInner>[0]) {
    return db.transaction(() => {
      const result = createNodeInner(params);
      if (!result.isError) resolveReferences(db);
      return result;
    })();
  }
```

- [ ] **Step 2: Run all tests to verify no regressions**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Refactor `updateNode` into `updateNodeInner` + `updateNode`**

Same pattern. Rename existing `updateNode` to `updateNodeInner`.

Replace the transaction block inside what becomes `updateNodeInner`:
```typescript
    const reParsed = parseFile(node_id, content);
    db.transaction(() => {
      indexFile(db, reParsed, node_id, mtime, content);
      resolveReferences(db);
    })();
```

With:
```typescript
    const reParsed = parseFile(node_id, content);
    indexFile(db, reParsed, node_id, mtime, content);
```

Add wrapper:
```typescript
  function updateNode(params: Parameters<typeof updateNodeInner>[0]) {
    return db.transaction(() => {
      const result = updateNodeInner(params);
      if (!result.isError) resolveReferences(db);
      return result;
    })();
  }
```

- [ ] **Step 4: Update `addRelationship` to use `updateNodeInner`**

Rename the existing `addRelationship` function to `addRelationshipInner`. Inside it, change all calls from `updateNode(...)` to `updateNodeInner(...)`. The `returnCurrentNode` calls stay unchanged (they're read-only).

Add wrapper:
```typescript
  function addRelationship(params: Parameters<typeof addRelationshipInner>[0]) {
    return db.transaction(() => {
      const result = addRelationshipInner(params);
      if (!result.isError) resolveReferences(db);
      return result;
    })();
  }
```

- [ ] **Step 5: Update `removeRelationship` to use `updateNodeInner`**

Same pattern. Rename to `removeRelationshipInner`. Change `updateNode(...)` calls to `updateNodeInner(...)`.

Add wrapper:
```typescript
  function removeRelationship(params: Parameters<typeof removeRelationshipInner>[0]) {
    return db.transaction(() => {
      const result = removeRelationshipInner(params);
      if (!result.isError) resolveReferences(db);
      return result;
    })();
  }
```

- [ ] **Step 6: Add `deleteNodeInner`**

Add after `removeRelationshipInner`:

```typescript
  function deleteNodeInner(params: { node_id: string }) {
    const { node_id } = params;

    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(node_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${node_id}` }],
        isError: true,
      };
    }

    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File not found on disk: ${node_id}. Database and filesystem are out of sync.`,
        }],
        isError: true,
      };
    }

    deleteNodeFile(vaultPath, node_id);
    deleteFile(db, node_id);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node_id, deleted: true }) }],
    };
  }
```

- [ ] **Step 7: Run all tests to verify no regressions**

Run: `npm test`
Expected: All tests PASS — behavior is identical, just reorganized

- [ ] **Step 8: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor mutation helpers into inner/outer pattern for batch transaction support"
```

---

## Chunk 3: Task 4 (batch-mutate)

### Task 4: `batch-mutate` MCP tool

**Files:**
- Create: `tests/mcp/batch-mutate.test.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Write failing tests — basic operations**

Create `tests/mcp/batch-mutate.test.ts`:

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

describe('batch-mutate', () => {
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
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  async function callBatch(operations: Array<{ op: string; params: Record<string, unknown> }>) {
    return client.callTool({ name: 'batch-mutate', arguments: { operations } });
  }

  function parseResult(result: Awaited<ReturnType<typeof callBatch>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  // Basic operations

  it('returns error when no operations provided', async () => {
    const result = await callBatch([]);
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('No operations');
  });

  it('executes a single create operation', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Batch Created', fields: { status: 'todo' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].op).toBe('create');
    expect(data.results[0].node.id).toBe('Batch Created.md');
    expect(existsSync(join(vaultPath, 'Batch Created.md'))).toBe(true);
  });

  it('executes a single update operation', async () => {
    await createTestNode({ title: 'Existing', fields: { status: 'todo' } });

    const result = await callBatch([
      { op: 'update', params: { node_id: 'Existing.md', fields: { status: 'done' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results[0].node.fields.status).toBe('done');
  });

  it('executes a single delete operation', async () => {
    await createTestNode({ title: 'Doomed' });

    const result = await callBatch([
      { op: 'delete', params: { node_id: 'Doomed.md' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results[0].op).toBe('delete');
    expect(data.results[0].node_id).toBe('Doomed.md');
    expect(existsSync(join(vaultPath, 'Doomed.md'))).toBe(false);

    // DB should be cleaned up
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Doomed.md');
    expect(node).toBeUndefined();
  });

  it('executes a single link operation', async () => {
    await createTestNode({ title: 'Source', body: 'Some text.' });

    const result = await callBatch([
      { op: 'link', params: { source_id: 'Source.md', target: 'Alice', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Source.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
  });

  it('executes a single unlink operation', async () => {
    await createTestNode({ title: 'Linked', body: 'See [[Alice]] here.' });

    const result = await callBatch([
      { op: 'unlink', params: { source_id: 'Linked.md', target: 'Alice', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Linked.md'), 'utf-8');
    expect(content).not.toContain('[[Alice]]');
  });

  // Sequential execution — later ops see earlier ops' results

  it('create then link: link references freshly created node', async () => {
    await createTestNode({ title: 'Existing Node', body: 'Content here.' });

    const result = await callBatch([
      { op: 'create', params: { title: 'New Target' } },
      { op: 'link', params: { source_id: 'Existing Node.md', target: 'New Target', rel_type: 'wiki-link' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].op).toBe('create');
    expect(data.results[1].op).toBe('link');

    const content = readFileSync(join(vaultPath, 'Existing Node.md'), 'utf-8');
    expect(content).toContain('[[New Target]]');
  });

  it('create then update the created node', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Fresh Node', fields: { status: 'todo' } } },
      { op: 'update', params: { node_id: 'Fresh Node.md', fields: { status: 'done' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(data.results[1].node.fields.status).toBe('done');
  });

  // Multiple creates

  it('creates multiple nodes in one batch', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Node A' } },
      { op: 'create', params: { title: 'Node B' } },
      { op: 'create', params: { title: 'Node C' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(3);
    expect(existsSync(join(vaultPath, 'Node A.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Node B.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Node C.md'))).toBe(true);
  });

  // Create then delete in same batch

  it('creates then deletes a node in the same batch', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'Ephemeral' } },
      { op: 'delete', params: { node_id: 'Ephemeral.md' } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.results).toHaveLength(2);
    expect(existsSync(join(vaultPath, 'Ephemeral.md'))).toBe(false);

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Ephemeral.md');
    expect(node).toBeUndefined();
  });

  // Rollback on failure

  it('rolls back all changes when a middle operation fails', async () => {
    await createTestNode({ title: 'Before Batch', fields: { status: 'original' } });
    const contentBefore = readFileSync(join(vaultPath, 'Before Batch.md'), 'utf-8');

    const result = await callBatch([
      { op: 'create', params: { title: 'Will Be Rolled Back' } },
      { op: 'update', params: { node_id: 'Before Batch.md', fields: { status: 'changed' } } },
      { op: 'update', params: { node_id: 'nonexistent.md', fields: { status: 'boom' } } }, // fails
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 2');
    expect(data.error).toContain('update');
    expect(data.rolled_back).toBe(true);

    // Created file should be deleted
    expect(existsSync(join(vaultPath, 'Will Be Rolled Back.md'))).toBe(false);

    // Modified file should be restored
    const contentAfter = readFileSync(join(vaultPath, 'Before Batch.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    // DB should be rolled back — no node created
    const created = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Will Be Rolled Back.md');
    expect(created).toBeUndefined();

    // DB should be rolled back — original fields preserved
    const field = db.prepare('SELECT value_text FROM fields WHERE node_id = ? AND key = ?').get('Before Batch.md', 'status') as { value_text: string };
    expect(field.value_text).toBe('original');
  });

  it('rolls back deleted file on failure', async () => {
    await createTestNode({ title: 'Survivor' });
    const contentBefore = readFileSync(join(vaultPath, 'Survivor.md'), 'utf-8');

    const result = await callBatch([
      { op: 'delete', params: { node_id: 'Survivor.md' } },
      { op: 'update', params: { node_id: 'nonexistent.md', fields: { x: 1 } } }, // fails
    ]);

    expect(result.isError).toBe(true);

    // File should be restored
    expect(existsSync(join(vaultPath, 'Survivor.md'))).toBe(true);
    const contentAfter = readFileSync(join(vaultPath, 'Survivor.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    // DB should be rolled back — node still exists
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Survivor.md');
    expect(node).toBeDefined();
  });

  // Reference resolution

  it('resolves references once at end of batch', async () => {
    // Create target and source in same batch, references should resolve
    const result = await callBatch([
      { op: 'create', params: { title: 'Target Node' } },
      { op: 'create', params: { title: 'Source Node', body: '[[Target Node]]' } },
    ]);

    expect(result.isError).toBeFalsy();

    const rels = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('Source Node.md') as Array<{ resolved_target_id: string | null }>;

    expect(rels).toHaveLength(1);
    expect(rels[0].resolved_target_id).toBe('Target Node.md');
  });

  it('returns error when first operation fails with nothing to roll back', async () => {
    const result = await callBatch([
      { op: 'delete', params: { node_id: 'nonexistent.md' } },
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 0');
    expect(data.rolled_back).toBe(true);
  });

  // Error format

  it('identifies failed operation by index and type', async () => {
    const result = await callBatch([
      { op: 'create', params: { title: 'OK' } },
      { op: 'delete', params: { node_id: 'ghost.md' } },
    ]);

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain('Operation 1');
    expect(data.error).toContain('delete');
  });

  // Warnings collection

  it('collects warnings from individual operations', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await callBatch([
      { op: 'create', params: { title: 'Bad Task', types: ['task'], fields: { priority: 'extreme' } } },
    ]);

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/batch-mutate.test.ts`
Expected: FAIL — `batch-mutate` tool not registered

- [ ] **Step 3: Implement `batchMutate` and register MCP tool**

In `src/mcp/server.ts`, add the `batchMutate` function and tool registration inside the `createServer` closure.

Add this type definition at the top of the function (after the existing helper function definitions):

```typescript
  type MutationResult = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  };
```

Add the `batchMutate` function:

```typescript
  function batchMutate(params: {
    operations: Array<{
      op: 'create' | 'update' | 'delete' | 'link' | 'unlink';
      params: Record<string, unknown>;
    }>;
  }) {
    const { operations } = params;

    if (!operations || operations.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No operations provided' }) }],
        isError: true,
      };
    }

    // File snapshot tracking for rollback
    const fileSnapshots = new Map<string, string | null>(); // path → original content (null = didn't exist)

    function snapshotFile(relativePath: string) {
      if (fileSnapshots.has(relativePath)) return;
      const absPath = join(vaultPath, relativePath);
      if (existsSync(absPath)) {
        fileSnapshots.set(relativePath, readFileSync(absPath, 'utf-8'));
      } else {
        fileSnapshots.set(relativePath, null);
      }
    }

    function rollbackFiles() {
      for (const [relativePath, originalContent] of fileSnapshots) {
        const absPath = join(vaultPath, relativePath);
        if (originalContent === null) {
          // File was created during batch — delete it
          if (existsSync(absPath)) {
            try { deleteNodeFile(vaultPath, relativePath); } catch { /* best effort */ }
          }
        } else {
          // File was modified or deleted — restore original content
          try { writeNodeFile(vaultPath, relativePath, originalContent); } catch { /* best effort */ }
        }
      }
    }

    interface OpResult {
      op: string;
      [key: string]: unknown;
    }

    try {
      const batchResult = db.transaction(() => {
        const results: OpResult[] = [];
        const allWarnings: Array<{ op_index: number; warnings: unknown[] }> = [];

        for (let i = 0; i < operations.length; i++) {
          const { op, params: opParams } = operations[i];
          let result: MutationResult;

          switch (op) {
            case 'create': {
              result = createNodeInner(opParams as Parameters<typeof createNodeInner>[0]);
              // Track created file for rollback AFTER createNodeInner writes it.
              // We do this post-hoc because createNodeInner processes relationships
              // before computing the final path, and we need the actual path it used.
              if (!result.isError) {
                const data = JSON.parse(result.content[0].text);
                if (!fileSnapshots.has(data.node.id)) {
                  fileSnapshots.set(data.node.id, null); // null = file didn't exist before batch
                }
              }
              break;
            }
            case 'update': {
              snapshotFile((opParams as { node_id: string }).node_id);
              result = updateNodeInner(opParams as Parameters<typeof updateNodeInner>[0]);
              break;
            }
            case 'delete': {
              snapshotFile((opParams as { node_id: string }).node_id);
              result = deleteNodeInner(opParams as Parameters<typeof deleteNodeInner>[0]);
              break;
            }
            case 'link': {
              snapshotFile((opParams as { source_id: string }).source_id);
              result = addRelationshipInner(opParams as Parameters<typeof addRelationshipInner>[0]);
              break;
            }
            case 'unlink': {
              snapshotFile((opParams as { source_id: string }).source_id);
              result = removeRelationshipInner(opParams as Parameters<typeof removeRelationshipInner>[0]);
              break;
            }
            default:
              throw new Error(`Unknown operation: ${op}`);
          }

          if (result.isError) {
            const errorText = result.content[0].text;
            throw new Error(`Operation ${i} (${op}) failed: ${errorText}`);
          }

          // Parse result and collect
          const parsed = JSON.parse(result.content[0].text);
          results.push({ op, ...parsed });

          // Collect warnings
          if (parsed.warnings && parsed.warnings.length > 0) {
            allWarnings.push({ op_index: i, warnings: parsed.warnings });
          }
        }

        // Resolve all references once at the end
        resolveReferences(db);

        return { results, warnings: allWarnings.flatMap(w => w.warnings) };
      })();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(batchResult) }],
      };
    } catch (err) {
      rollbackFiles();
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: message, rolled_back: true }),
        }],
        isError: true,
      };
    }
  }
```

Register the MCP tool:

```typescript
  server.tool(
    'batch-mutate',
    'Execute multiple mutations atomically. All operations succeed or all are rolled back. Supports create, update, delete, link, and unlink.',
    {
      operations: z.array(z.object({
        op: z.enum(['create', 'update', 'delete', 'link', 'unlink'])
          .describe('Operation type'),
        params: z.record(z.string(), z.unknown())
          .describe('Operation parameters (same as standalone tool)'),
      })).describe('Array of operations to execute in order'),
    },
    async (params) => {
      try {
        return batchMutate(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 4: Run batch-mutate tests to verify they pass**

Run: `npx vitest run tests/mcp/batch-mutate.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run all tests to verify no regressions**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/batch-mutate.test.ts
git commit -m "add batch-mutate MCP tool with atomic transactions and file rollback"
```

---

## Post-Implementation

After all tasks are complete:

- [ ] **Update MEMORY.md** — Mark Phase 3 Task 7 as complete, add `batch-mutate` and `remove-relationship` key design decisions
- [ ] **Run full test suite one final time:** `npm test`
- [ ] **Run type check:** `npx tsc --noEmit`
