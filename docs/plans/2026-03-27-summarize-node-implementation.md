# `summarize-node` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `summarize-node` MCP tool that reads a node and all its embedded attachments, returning everything assembled as MCP content blocks — plus add a `title` param to `get-node`.

**Architecture:** Two changes to `src/mcp/server.ts`: (1) new `summarize-node` tool handler that reuses `hydrateNodes` for node metadata and `resolveEmbeds`/`readImage`/`readAudio`/`readDocument` from `src/attachments/` for embed extraction, (2) add optional `title` param to existing `get-node` tool. Title resolution uses `buildLookupMaps` + `resolveTargetWithMaps` from `src/sync/resolver.ts`, with ambiguity detection via direct `titleMap` inspection.

**Tech Stack:** TypeScript ESM, vitest, MCP SDK (`@modelcontextprotocol/sdk`), better-sqlite3, zod

**Spec:** `docs/specs/summarize-node-spec.md`

---

### Task 1: Add `title` param to `get-node`

**Files:**
- Modify: `src/mcp/server.ts:1054-1106` (get-node tool registration)
- Test: `tests/mcp/server.test.ts` (get-node describe block)

- [ ] **Step 1: Write failing tests for title-based get-node lookup**

Add these tests inside the existing `describe('get-node', ...)` block in `tests/mcp/server.test.ts`:

```typescript
it('resolves node by title', async () => {
  indexFixture(db, 'sample-task.md', 'tasks/review.md');

  const result = await client.callTool({
    name: 'get-node',
    arguments: { title: 'Review PR' },
  });

  expect(result.isError).toBeFalsy();
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.id).toBe('tasks/review.md');
});

it('returns error when title matches no node', async () => {
  const result = await client.callTool({
    name: 'get-node',
    arguments: { title: 'Nonexistent Node' },
  });
  expect(result.isError).toBe(true);
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.code).toBe('NOT_FOUND');
  expect(data.error).toContain('Nonexistent Node');
});

it('returns error when title is ambiguous', async () => {
  // Index two nodes with the same title
  const md1 = '---\ntitle: Status\ntypes: [note]\n---\nAlpha status.';
  const md2 = '---\ntitle: Status\ntypes: [note]\n---\nBeta status.';
  const parsed1 = parseFile('projects/alpha/status.md', md1);
  const parsed2 = parseFile('projects/beta/status.md', md2);
  indexFile(db, parsed1, 'projects/alpha/status.md', '2025-03-10T00:00:00.000Z', md1);
  indexFile(db, parsed2, 'projects/beta/status.md', '2025-03-10T00:00:00.000Z', md2);

  const result = await client.callTool({
    name: 'get-node',
    arguments: { title: 'Status' },
  });
  expect(result.isError).toBe(true);
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.code).toBe('VALIDATION_ERROR');
  expect(data.error).toContain('projects/alpha/status.md');
  expect(data.error).toContain('projects/beta/status.md');
});

it('returns error when neither node_id nor title provided', async () => {
  const result = await client.callTool({
    name: 'get-node',
    arguments: {},
  });
  expect(result.isError).toBe(true);
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.code).toBe('VALIDATION_ERROR');
});

it('node_id takes precedence over title', async () => {
  indexFixture(db, 'sample-task.md', 'tasks/review.md');

  const result = await client.callTool({
    name: 'get-node',
    arguments: { node_id: 'tasks/review.md', title: 'Some Other Title' },
  });

  expect(result.isError).toBeFalsy();
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.id).toBe('tasks/review.md');
});
```

These tests require adding `parseFile` and `indexFile` imports to the test file. Add at the top alongside existing imports:

```typescript
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/server.test.ts -v`
Expected: 5 new tests FAIL (title not recognized as a valid parameter)

- [ ] **Step 3: Implement title resolution in get-node**

In `src/mcp/server.ts`, add an import for `buildLookupMaps` and `resolveTargetWithMaps`:

```typescript
import { resolveReferences, buildLookupMaps, resolveTargetWithMaps } from '../sync/resolver.js';
```

Replace the `get-node` tool registration (lines 1054-1106) with:

```typescript
  server.tool(
    'get-node',
    'Get full details of a specific node by its ID (vault-relative file path) or title',
    {
      node_id: z.string().optional()
        .describe('Vault-relative file path, e.g. "tasks/review.md"'),
      title: z.string().optional()
        .describe('Node title for lookup, e.g. "Review PR". Resolved via wiki-link resolution logic. Use when you know the name but not the directory.'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
      include_computed: z.boolean().optional().default(false)
        .describe('Include computed field values from schema definitions'),
    },
    async ({ node_id, title, include_relationships, include_computed }) => {
      // Resolve node_id from title if needed
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

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(resolvedId, resolvedId) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      if (include_computed) {
        const nodeTypes = (node as Record<string, unknown>).types as string[];
        const allComputedDefs: Record<string, ComputedDefinition> = {};
        for (const typeName of nodeTypes) {
          const schema = getSchema(db, typeName);
          if (schema?.computed) {
            Object.assign(allComputedDefs, schema.computed);
          }
        }
        const computed = Object.keys(allComputedDefs).length > 0
          ? evaluateComputed(db, resolvedId, allComputedDefs)
          : {};
        (node as Record<string, unknown>).computed = computed;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/server.test.ts -v`
Expected: All tests PASS (including existing get-node tests — `node_id` is now optional but existing tests all provide it)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat(get-node): add optional title param with wiki-link resolution"
```

---

### Task 2: Register `summarize-node` tool — node resolution and metadata assembly

**Files:**
- Modify: `src/mcp/server.ts` (add new tool registration before the `return server` line)
- Create: `tests/mcp/summarize-node.test.ts`

- [ ] **Step 1: Write failing tests for node resolution and metadata header**

Create `tests/mcp/summarize-node.test.ts`:

```typescript
// tests/mcp/summarize-node.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

describe('summarize-node tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = join(tmpdir(), `vault-summarize-test-${Date.now()}`);
    mkdirSync(vaultDir, { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultDir);
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
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns VALIDATION_ERROR when neither node_id nor title provided', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('returns NOT_FOUND for missing node_id', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'nonexistent.md' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND for unresolvable title', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Ghost Node' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
    expect(data.error).toContain('Ghost Node');
  });

  it('returns ambiguity error when title matches multiple nodes', async () => {
    mkdirSync(join(vaultDir, 'a'), { recursive: true });
    mkdirSync(join(vaultDir, 'b'), { recursive: true });
    const md1 = '---\ntitle: Standup\ntypes: [meeting]\n---\nAlpha standup.';
    const md2 = '---\ntitle: Standup\ntypes: [meeting]\n---\nBeta standup.';
    writeFileSync(join(vaultDir, 'a/standup.md'), md1);
    writeFileSync(join(vaultDir, 'b/standup.md'), md2);
    indexFile(db, parseFile('a/standup.md', md1), 'a/standup.md', new Date().toISOString(), md1);
    indexFile(db, parseFile('b/standup.md', md2), 'b/standup.md', new Date().toISOString(), md2);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Standup' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('VALIDATION_ERROR');
    expect(data.error).toContain('a/standup.md');
    expect(data.error).toContain('b/standup.md');
  });

  it('assembles node content with metadata header and body (no embeds)', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Planning\ntypes: [meeting]\ndate: 2026-03-27\nattendees:\n  - "[[Alice]]"\n  - "[[Bob]]"\n---\n\nDiscussed roadmap.';
    writeFileSync(join(vaultDir, 'notes/planning.md'), md);
    const parsed = parseFile('notes/planning.md', md);
    indexFile(db, parsed, 'notes/planning.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'notes/planning.md' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;

    // First block: metadata header
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('## Node: Planning');
    expect(content[0].text).toContain('meeting');
    expect(content[0].text).toContain('No embedded content found');

    // Second block: node body
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('## Node Content');
    expect(content[1].text).toContain('Discussed roadmap.');
  });

  it('resolves node by title and returns assembled content', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Weekly\ntypes: [note]\n---\n\nWeekly sync notes.';
    writeFileSync(join(vaultDir, 'notes/weekly.md'), md);
    const parsed = parseFile('notes/weekly.md', md);
    indexFile(db, parsed, 'notes/weekly.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Weekly' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('## Node: Weekly');
    expect(content[1].text).toContain('Weekly sync notes.');
  });

  it('node_id takes precedence over title', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Actual\ntypes: [note]\n---\nCorrect node.';
    writeFileSync(join(vaultDir, 'notes/actual.md'), md);
    const parsed = parseFile('notes/actual.md', md);
    indexFile(db, parsed, 'notes/actual.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'notes/actual.md', title: 'Wrong Title' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('## Node: Actual');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/summarize-node.test.ts -v`
Expected: All tests FAIL (tool not registered)

- [ ] **Step 3: Implement the summarize-node tool**

In `src/mcp/server.ts`, add the `summarize-node` tool registration **before** the `read-embedded` tool (before line 1700). Insert the following:

```typescript
  // --- summarize-node tool ---
  server.tool(
    'summarize-node',
    'Read a node and all its embedded content (audio transcriptions, PDFs, images, documents), returning everything assembled as text. Use this when asked to summarize, review, or analyze a note — especially meeting notes with audio recordings. The tool handles all content extraction; the calling model does the summarization. Also accepts a title instead of a full file path.',
    {
      node_id: z.string().optional()
        .describe("Vault-relative file path, e.g. 'Meetings/Q1 Planning.md'"),
      title: z.string().optional()
        .describe("Node title for lookup, e.g. 'Q1 Planning'. Resolved via wiki-link resolution logic. Use when you know the name but not the directory."),
    },
    async ({ node_id, title }) => {
      // 1. Resolve node ID
      let resolvedId = node_id;
      if (!resolvedId) {
        if (!title) {
          return toolError('Either node_id or title must be provided', 'VALIDATION_ERROR');
        }
        const { titleMap, pathMap } = buildLookupMaps(db);
        const resolved = resolveTargetWithMaps(title, titleMap, pathMap);
        if (!resolved) {
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
        return toolError('Invalid node_id: path traversal not allowed', 'VALIDATION_ERROR');
      }

      // 2. Load node from DB
      const row = db.prepare(`
        SELECT id, file_path, node_type, title, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(resolvedId) as { id: string; file_path: string; node_type: string; title: string | null; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return toolError(`Node not found: ${resolvedId}`, 'NOT_FOUND');
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });
      const nodeTitle = (node.title as string) ?? resolvedId;
      const types = (node.types as string[]).join(', ') || 'none';
      const fields = node.fields as Record<string, string>;

      // Read raw markdown from disk for embed detection
      const absPath = join(vaultPath, row.file_path);
      const raw = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : null;

      // 3. Extract body (from content_md or raw markdown)
      const body = (row.content_md as string) ?? '';

      // 4. Resolve embeds
      const contentBlocks: Array<ImageContent | TextContent> = [];
      const embedInventory: string[] = [];

      if (raw) {
        const sourceDir = dirname(absPath);
        const embeds = resolveEmbeds(raw, vaultPath, sourceDir);

        for (const embed of embeds) {
          if (!embed.absolutePath) {
            embedInventory.push(`${embed.filename} (not found on disk)`);
            contentBlocks.push({
              type: 'text' as const,
              text: `## ${embed.attachmentType === 'unknown' ? 'File' : embed.attachmentType.charAt(0).toUpperCase() + embed.attachmentType.slice(1)}: ${embed.filename}\n\n⚠️ File not found on disk`,
            });
            continue;
          }

          let result;
          switch (embed.attachmentType) {
            case 'image':
              result = readImage(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (image${result.ok ? '' : ', failed'})`);
              if (result.ok) {
                // Add image blocks then a label
                contentBlocks.push(...result.content);
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Image: ${embed.filename}\n(image returned above)`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Image: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to read image'}`,
                });
              }
              break;
            case 'audio':
              result = await readAudio(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (audio${result.ok ? ', transcribed' : ', failed'})`);
              if (result.ok) {
                // readAudio returns text blocks with transcript — wrap with header
                const transcriptText = result.content
                  .filter((c): c is TextContent => c.type === 'text')
                  .map(c => c.text)
                  .join('\n\n');
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Audio: ${embed.filename}\n\n${transcriptText}`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Audio: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to transcribe audio'}`,
                });
              }
              break;
            case 'document':
              result = await readDocument(embed.absolutePath, embed.filename);
              embedInventory.push(`${embed.filename} (document${result.ok ? '' : ', failed'})`);
              if (result.ok) {
                const docText = result.content
                  .filter((c): c is TextContent => c.type === 'text')
                  .map(c => c.text)
                  .join('\n\n');
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Document: ${embed.filename}\n\n${docText}`,
                });
              } else {
                contentBlocks.push({
                  type: 'text' as const,
                  text: `## Document: ${embed.filename}\n\n⚠️ ${result.error ?? 'Failed to read document'}`,
                });
              }
              break;
            default:
              embedInventory.push(`${embed.filename} (unknown type, skipped)`);
              break;
          }
        }
      }

      // 5. Build header
      const fieldLines = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const embedSummary = embedInventory.length > 0
        ? `**Embedded content found:** ${embedInventory.join('; ')}`
        : '**No embedded content found**';

      const header = `## Node: ${nodeTitle}\n**Types:** ${types}\n**Fields:** ${fieldLines || 'none'}\n\n${embedSummary}\n---`;

      // 6. Assemble response
      return {
        content: [
          { type: 'text' as const, text: header },
          { type: 'text' as const, text: `## Node Content\n\n${body}` },
          ...contentBlocks,
        ],
      };
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/summarize-node.test.ts -v`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/summarize-node.test.ts
git commit -m "feat: add summarize-node MCP tool for content assembly"
```

---

### Task 3: Add embed extraction tests for `summarize-node`

**Files:**
- Modify: `tests/mcp/summarize-node.test.ts`

- [ ] **Step 1: Write tests for image embed extraction**

Add to the `describe('summarize-node tool', ...)` block in `tests/mcp/summarize-node.test.ts`:

```typescript
it('extracts and returns image embeds with header blocks', async () => {
  mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
  mkdirSync(join(vaultDir, 'notes'), { recursive: true });

  // 1x1 transparent PNG
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  writeFileSync(join(vaultDir, 'Attachments', 'diagram.png'), Buffer.from(pngBase64, 'base64'));

  const md = '---\ntitle: Design Doc\ntypes: [note]\n---\n\nSee diagram:\n\n![[diagram.png]]';
  writeFileSync(join(vaultDir, 'notes/design.md'), md);
  const parsed = parseFile('notes/design.md', md);
  indexFile(db, parsed, 'notes/design.md', new Date().toISOString(), md);

  const result = await client.callTool({
    name: 'summarize-node',
    arguments: { node_id: 'notes/design.md' },
  });

  expect(result.isError).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

  // Header should mention the image
  expect(content[0].text).toContain('diagram.png');
  expect(content[0].text).toContain('image');

  // Body block
  expect(content[1].text).toContain('See diagram:');

  // Image block (base64)
  const imageBlock = content.find(c => c.type === 'image');
  expect(imageBlock).toBeDefined();
  expect(imageBlock!.mimeType).toBe('image/png');

  // Image label block
  const labelBlock = content.find(c => c.type === 'text' && c.text?.includes('## Image: diagram.png'));
  expect(labelBlock).toBeDefined();
});
```

- [ ] **Step 2: Write test for document embed extraction**

Add to the same describe block:

```typescript
it('extracts and returns document embeds as text', async () => {
  mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
  mkdirSync(join(vaultDir, 'notes'), { recursive: true });

  writeFileSync(join(vaultDir, 'Attachments', 'readme.txt'), 'This is a plain text document.');

  const md = '---\ntitle: Docs Review\ntypes: [note]\n---\n\nReview this:\n\n![[readme.txt]]';
  writeFileSync(join(vaultDir, 'notes/docs-review.md'), md);
  const parsed = parseFile('notes/docs-review.md', md);
  indexFile(db, parsed, 'notes/docs-review.md', new Date().toISOString(), md);

  const result = await client.callTool({
    name: 'summarize-node',
    arguments: { node_id: 'notes/docs-review.md' },
  });

  expect(result.isError).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string }>;

  // Header mentions document
  expect(content[0].text).toContain('readme.txt');
  expect(content[0].text).toContain('document');

  // Document content block
  const docBlock = content.find(c => c.type === 'text' && c.text?.includes('## Document: readme.txt'));
  expect(docBlock).toBeDefined();
  expect(docBlock!.text).toContain('This is a plain text document.');
});
```

- [ ] **Step 3: Write test for unresolvable embed (missing file)**

```typescript
it('includes warning for embeds that cannot be found on disk', async () => {
  mkdirSync(join(vaultDir, 'notes'), { recursive: true });

  const md = '---\ntitle: Broken Embeds\ntypes: [note]\n---\n\nSee: ![[missing-file.pdf]]';
  writeFileSync(join(vaultDir, 'notes/broken.md'), md);
  const parsed = parseFile('notes/broken.md', md);
  indexFile(db, parsed, 'notes/broken.md', new Date().toISOString(), md);

  const result = await client.callTool({
    name: 'summarize-node',
    arguments: { node_id: 'notes/broken.md' },
  });

  expect(result.isError).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string }>;

  // Header should mention the missing file
  expect(content[0].text).toContain('missing-file.pdf');
  expect(content[0].text).toContain('not found');

  // Warning block for the missing embed
  const warningBlock = content.find(c => c.type === 'text' && c.text?.includes('⚠️ File not found on disk'));
  expect(warningBlock).toBeDefined();
});
```

- [ ] **Step 4: Write test for multiple embeds of different types**

```typescript
it('handles multiple embeds of different types', async () => {
  mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
  mkdirSync(join(vaultDir, 'notes'), { recursive: true });

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), Buffer.from(pngBase64, 'base64'));
  writeFileSync(join(vaultDir, 'Attachments', 'notes.txt'), 'Meeting notes text content.');

  const md = '---\ntitle: Multi Embed\ntypes: [meeting]\n---\n\n![[photo.png]]\n\n![[notes.txt]]';
  writeFileSync(join(vaultDir, 'notes/multi.md'), md);
  const parsed = parseFile('notes/multi.md', md);
  indexFile(db, parsed, 'notes/multi.md', new Date().toISOString(), md);

  const result = await client.callTool({
    name: 'summarize-node',
    arguments: { node_id: 'notes/multi.md' },
  });

  expect(result.isError).toBeFalsy();
  const content = result.content as Array<{ type: string; text?: string; data?: string }>;

  // Header mentions both
  expect(content[0].text).toContain('photo.png');
  expect(content[0].text).toContain('notes.txt');

  // Image block present
  expect(content.some(c => c.type === 'image')).toBe(true);

  // Document block present
  const docBlock = content.find(c => c.type === 'text' && c.text?.includes('## Document: notes.txt'));
  expect(docBlock).toBeDefined();
  expect(docBlock!.text).toContain('Meeting notes text content.');
});
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `npx vitest run tests/mcp/summarize-node.test.ts -v`
Expected: All 11 tests PASS

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All tests PASS (no regressions in existing tools)

- [ ] **Step 7: Commit**

```bash
git add tests/mcp/summarize-node.test.ts
git commit -m "test: add embed extraction tests for summarize-node"
```

---

### Task 4: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md` (MCP Layer section — update tool count, add summarize-node description, update get-node description)

- [ ] **Step 1: Update CLAUDE.md**

In the MCP Layer section of `CLAUDE.md`:

1. Update the server.ts description from "21 tools" to "22 tools" (add summarize-node).
2. Update the `get-node` entry to mention the optional `title` param.
3. Add a `summarize-node` entry after `read-embedded`:

```
  - **`summarize-node`** — Content assembly tool. Reads a node and all its `![[embedded]]` attachments, returning everything as MCP content blocks. Accepts `node_id` or `title` (resolved via wiki-link logic). Returns: metadata header, node body as-is, then each embed's extracted content (audio transcripts, images as base64, documents as text) with `## Type: filename` headers. Missing embeds get `⚠️` warnings. The calling model handles summarization.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add summarize-node tool and get-node title param to CLAUDE.md"
```
