# Phase 4: Vector Search Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic search alongside FTS5, with pluggable embedding providers, async embedding queue, and hybrid semantic + structured queries.

**Architecture:** New `src/embeddings/` module with four components: chunker (splits files by heading), provider abstraction (ollama/OpenAI), queue worker (background loop), and semantic search. New DB tables (`chunks`, `embedding_queue`) in existing schema; sqlite-vec virtual table (`vec_chunks`) created conditionally when embeddings are configured. Chunking always runs during indexing; embedding is async.

**Tech Stack:** TypeScript ESM, better-sqlite3, sqlite-vec (native extension), vitest, raw `fetch()` for provider APIs.

**Spec:** `docs/plans/2026-03-21-vector-search-design.md`

---

### Task 1: Schema — Add `chunks` and `embedding_queue` Tables

**Files:**
- Modify: `src/db/schema.ts:3-96` (add two new tables + indices to `createSchema`)
- Modify: `tests/db/schema.test.ts` (add table existence checks)

- [ ] **Step 1: Write the failing test**

In `tests/db/schema.test.ts`, add a test that verifies the `chunks` and `embedding_queue` tables exist after `createSchema`:

```typescript
it('creates chunks table', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'"
  ).get();
  expect(row).toBeDefined();
});

it('creates embedding_queue table', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_queue'"
  ).get();
  expect(row).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts -t "creates chunks table"`
Expected: FAIL — table does not exist

- [ ] **Step 3: Add DDL to `createSchema`**

In `src/db/schema.ts`, add the following inside the `db.exec()` template literal, after the `files` table and before the indices section:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  heading         TEXT,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS embedding_queue (
  chunk_id        TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);
```

Also add indices after the existing index block:

```sql
CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id);
CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON embedding_queue(status);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "add chunks and embedding_queue tables to schema"
```

---

### Task 2: Chunker — Section-Based File Chunking

**Files:**
- Create: `src/embeddings/types.ts`
- Create: `src/embeddings/chunker.ts`
- Create: `tests/embeddings/chunker.test.ts`

- [ ] **Step 1: Create types file**

Create `src/embeddings/types.ts` with the `Chunk` interface:

```typescript
export interface Chunk {
  id: string;
  nodeId: string;
  chunkIndex: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/embeddings/chunker.test.ts`. Use inline markdown strings (not fixture files) to keep tests self-contained. The chunker operates on `ParsedFile` objects, so tests call `parseFile` on raw strings:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/parser/index.js';
import { chunkFile } from '../../src/embeddings/chunker.js';

describe('chunkFile', () => {
  it('returns a single full chunk for short files with no headings', () => {
    const raw = '---\ntitle: Short Note\ntypes: [note]\n---\n\nJust a brief note.';
    const parsed = parseFile('notes/short.md', raw);
    const chunks = chunkFile(parsed, 'notes/short.md');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('notes/short.md#full');
    expect(chunks[0].nodeId).toBe('notes/short.md');
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].content).toContain('Just a brief note');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('splits on headings into section chunks', () => {
    const raw = [
      '---',
      'title: Meeting Notes',
      'types: [meeting]',
      '---',
      '',
      'Opening remarks.',
      '',
      '## Discussion',
      '',
      'We discussed the budget.',
      '',
      '## Action Items',
      '',
      '- Alice to follow up',
    ].join('\n');
    const parsed = parseFile('meetings/standup.md', raw);
    const chunks = chunkFile(parsed, 'meetings/standup.md');

    expect(chunks.length).toBe(3);

    // Pre-heading content
    expect(chunks[0].id).toBe('meetings/standup.md#section:0');
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].content).toContain('Opening remarks');

    // First heading section
    expect(chunks[1].id).toBe('meetings/standup.md#section:1');
    expect(chunks[1].heading).toBe('Discussion');
    expect(chunks[1].content).toContain('budget');

    // Second heading section
    expect(chunks[2].id).toBe('meetings/standup.md#section:2');
    expect(chunks[2].heading).toBe('Action Items');
    expect(chunks[2].content).toContain('Alice');
  });

  it('handles wiki-links in chunk text', () => {
    const raw = '---\ntitle: Test\ntypes: [note]\n---\n\nTalk to [[Alice Smith]] about it.';
    const parsed = parseFile('notes/test.md', raw);
    const chunks = chunkFile(parsed, 'notes/test.md');

    expect(chunks[0].content).toContain('Alice Smith');
  });

  it('returns full chunk when file has headings but total content is short', () => {
    const raw = '---\ntitle: Tiny\ntypes: [note]\n---\n\n## One\n\nHello.\n\n## Two\n\nWorld.';
    const parsed = parseFile('notes/tiny.md', raw);
    const chunks = chunkFile(parsed, 'notes/tiny.md');

    // Total content is very short, so should emit a single full chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('notes/tiny.md#full');
  });

  it('estimates token count using word count * 1.3', () => {
    const words = Array(100).fill('word').join(' ');
    const raw = `---\ntitle: Tokens\ntypes: [note]\n---\n\n${words}`;
    const parsed = parseFile('notes/tokens.md', raw);
    const chunks = chunkFile(parsed, 'notes/tokens.md');

    // 100 words * 1.3 = 130
    expect(chunks[0].tokenCount).toBe(130);
  });

  it('chunk indices are sequential starting from 0', () => {
    const raw = [
      '---',
      'title: Multi',
      'types: [note]',
      '---',
      '',
      '## A',
      '',
      'Content A with enough words to make this section meaningful for chunking purposes.',
      '',
      '## B',
      '',
      'Content B with enough words to make this section meaningful for chunking purposes.',
      '',
      '## C',
      '',
      'Content C with enough words to make this section meaningful for chunking purposes.',
    ].join('\n');
    const parsed = parseFile('notes/multi.md', raw);
    const chunks = chunkFile(parsed, 'notes/multi.md');

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/chunker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the chunker**

Create `src/embeddings/chunker.ts`:

```typescript
import type { Root } from 'mdast';
import type { ParsedFile } from '../parser/types.js';
import type { Chunk } from './types.js';

const SHORT_CONTENT_THRESHOLD = 200; // tokens

export function chunkFile(parsed: ParsedFile, nodeId: string): Chunk[] {
  const mdast = parsed.mdast;
  const bodyChildren = mdast.children.filter(n => n.type !== 'yaml');

  // Find heading indices in the body children
  const headingIndices: number[] = [];
  for (let i = 0; i < bodyChildren.length; i++) {
    if (bodyChildren[i].type === 'heading') {
      headingIndices.push(i);
    }
  }

  // If no headings or total content is short, return single full chunk
  const fullText = extractTextFromNodes(bodyChildren);
  const fullTokens = estimateTokens(fullText);

  if (headingIndices.length === 0 || fullTokens < SHORT_CONTENT_THRESHOLD) {
    return [{
      id: `${nodeId}#full`,
      nodeId,
      chunkIndex: 0,
      heading: null,
      content: fullText,
      tokenCount: fullTokens,
    }];
  }

  // Split into sections
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  // Pre-heading content (if any nodes before first heading)
  if (headingIndices[0] > 0) {
    const preNodes = bodyChildren.slice(0, headingIndices[0]);
    const text = extractTextFromNodes(preNodes);
    if (text.trim().length > 0) {
      chunks.push({
        id: `${nodeId}#section:${chunkIndex}`,
        nodeId,
        chunkIndex,
        heading: null,
        content: text,
        tokenCount: estimateTokens(text),
      });
      chunkIndex++;
    }
  }

  // Heading sections
  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : bodyChildren.length;
    const sectionNodes = bodyChildren.slice(start, end);
    const headingNode = sectionNodes[0] as any;
    const headingText = extractTextFromNodes([headingNode]).trim();
    const contentNodes = sectionNodes.slice(1);
    const text = extractTextFromNodes(contentNodes);

    chunks.push({
      id: `${nodeId}#section:${chunkIndex}`,
      nodeId,
      chunkIndex,
      heading: headingText,
      content: text,
      tokenCount: estimateTokens(text),
    });
    chunkIndex++;
  }

  return chunks;
}

function extractTextFromNodes(nodes: any[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    collectText(node, parts);
  }
  return parts.join('\n').trim();
}

function collectText(node: any, parts: string[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(node.value);
    return;
  }

  if (node.type === 'wikiLink') {
    parts.push(node.alias ?? node.target);
    return;
  }

  if (node.children && Array.isArray(node.children)) {
    const isBlock = node.type === 'paragraph' || node.type === 'heading'
      || node.type === 'listItem' || node.type === 'blockquote'
      || node.type === 'tableCell';

    if (isBlock) {
      const inline: string[] = [];
      for (const child of node.children) {
        collectText(child, inline);
      }
      parts.push(inline.join(''));
    } else {
      for (const child of node.children) {
        collectText(child, parts);
      }
    }
  }
}

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(words * 1.3);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/chunker.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/embeddings/types.ts src/embeddings/chunker.ts tests/embeddings/chunker.test.ts
git commit -m "add section-based file chunker for embedding pipeline"
```

---

### Task 3: Indexer Integration — Chunk on Index, Delete on Remove

**Files:**
- Modify: `src/sync/indexer.ts:34-111` (`indexFile` — add chunk deletes + inserts)
- Modify: `src/sync/indexer.ts:113-119` (`deleteFile` — add chunk + vec deletes)
- Modify: `src/sync/indexer.ts:190-225` (`rebuildIndex` — add table clears)
- Modify: `tests/sync/indexer.test.ts` (add chunk-related tests)

- [ ] **Step 1: Write failing tests**

Add to `tests/sync/indexer.test.ts`:

```typescript
it('creates chunks when indexing a file', () => {
  const { parsed, raw } = loadAndParse('sample-meeting.md', 'meetings/q1.md');
  indexFile(db, parsed, 'meetings/q1.md', '2025-03-06T00:00:00.000Z', raw);

  const chunks = db.prepare('SELECT * FROM chunks WHERE node_id = ? ORDER BY chunk_index').all('meetings/q1.md') as any[];
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0].node_id).toBe('meetings/q1.md');
  expect(chunks[0].content).toBeTruthy();
  expect(chunks[0].token_count).toBeGreaterThan(0);
});

it('creates embedding_queue entries for each chunk', () => {
  const { parsed, raw } = loadAndParse('sample-meeting.md', 'meetings/q1.md');
  indexFile(db, parsed, 'meetings/q1.md', '2025-03-06T00:00:00.000Z', raw);

  const queueEntries = db.prepare('SELECT * FROM embedding_queue').all() as any[];
  const chunks = db.prepare('SELECT * FROM chunks WHERE node_id = ?').all('meetings/q1.md') as any[];
  expect(queueEntries.length).toBe(chunks.length);
  expect(queueEntries.every((e: any) => e.status === 'pending')).toBe(true);
});

it('replaces chunks on re-index', () => {
  const { parsed, raw } = loadAndParse('sample-meeting.md', 'meetings/q1.md');
  indexFile(db, parsed, 'meetings/q1.md', '2025-03-06T00:00:00.000Z', raw);

  const before = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE node_id = ?').get('meetings/q1.md') as any;

  // Re-index same file
  indexFile(db, parsed, 'meetings/q1.md', '2025-03-07T00:00:00.000Z', raw);

  const after = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE node_id = ?').get('meetings/q1.md') as any;
  expect(after.count).toBe(before.count);
});

it('deletes chunks when deleteFile is called', () => {
  const { parsed, raw } = loadAndParse('sample-meeting.md', 'meetings/q1.md');
  indexFile(db, parsed, 'meetings/q1.md', '2025-03-06T00:00:00.000Z', raw);

  deleteFile(db, 'meetings/q1.md');

  const chunks = db.prepare('SELECT * FROM chunks WHERE node_id = ?').all('meetings/q1.md');
  expect(chunks).toHaveLength(0);
  const queue = db.prepare('SELECT * FROM embedding_queue').all();
  expect(queue).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts -t "creates chunks"`
Expected: FAIL — no rows in chunks table

- [ ] **Step 3: Modify `indexFile` to create chunks and queue entries**

In `src/sync/indexer.ts`:

1. Add import at top:
```typescript
import { chunkFile } from '../embeddings/chunker.js';
```

2. Add to the delete block at line 42-44, before the existing deletes:
```typescript
db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE node_id = ?)').run(relativePath);
db.prepare('DELETE FROM chunks WHERE node_id = ?').run(relativePath);
```

Note: `vec_chunks` only exists when embeddings are configured. Wrap the delete in a try/catch that ignores "no such table" errors:

```typescript
try {
  db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE node_id = ?)').run(relativePath);
} catch {
  // vec_chunks table may not exist if embeddings aren't configured
}
```

3. After the files row upsert (after line 110), add chunking + queue insertion:
```typescript
// Create chunks and queue entries
const chunks = chunkFile(parsed, relativePath);
const insertChunk = db.prepare(`
  INSERT INTO chunks (id, node_id, chunk_index, heading, content, token_count)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertQueue = db.prepare(`
  INSERT INTO embedding_queue (chunk_id) VALUES (?)
`);
for (const chunk of chunks) {
  insertChunk.run(chunk.id, chunk.nodeId, chunk.chunkIndex, chunk.heading, chunk.content, chunk.tokenCount);
  insertQueue.run(chunk.id);
}
```

- [ ] **Step 4: Modify `deleteFile` to delete chunks and vec_chunks**

In `src/sync/indexer.ts`, add to `deleteFile` before the existing deletes (before line 114):

```typescript
try {
  db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE node_id = ?)').run(relativePath);
} catch {
  // vec_chunks may not exist
}
db.prepare('DELETE FROM chunks WHERE node_id = ?').run(relativePath);
```

- [ ] **Step 5: Modify `rebuildIndex` to clear new tables**

In `src/sync/indexer.ts`, add to the clear block in `rebuildIndex` (before `DELETE FROM relationships` at line 198):

```typescript
try {
  db.prepare('DELETE FROM vec_chunks').run();
} catch {
  // vec_chunks may not exist
}
db.prepare('DELETE FROM embedding_queue').run();
db.prepare('DELETE FROM chunks').run();
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "integrate chunker into indexFile/deleteFile/rebuildIndex"
```

---

### Task 4: Embedding Provider — Interface + Ollama Implementation

**Files:**
- Modify: `src/embeddings/types.ts` (add `EmbeddingProvider`, `EmbeddingConfig`)
- Create: `src/embeddings/providers/ollama.ts`
- Create: `tests/embeddings/providers/ollama.test.ts`

- [ ] **Step 1: Add types**

Add to `src/embeddings/types.ts`:

```typescript
export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  batchSize?: number;
}
```

- [ ] **Step 2: Write failing tests for OllamaProvider**

Create `tests/embeddings/providers/ollama.test.ts`. Since we can't call a real ollama server in tests, we test the provider by mocking `fetch`. Use `vi.stubGlobal`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from '../../../src/embeddings/providers/ollama.js';

describe('OllamaProvider', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct default dimensions and model', () => {
    const provider = new OllamaProvider();
    expect(provider.dimensions).toBe(768);
    expect(provider.modelName).toBe('nomic-embed-text');
  });

  it('calls ollama embed endpoint with correct payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });

    const provider = new OllamaProvider();
    const result = await provider.embed(['hello world']);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['hello world'] }),
      }),
    );
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('uses custom baseUrl and model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 2]] }),
    });

    const provider = new OllamaProvider({
      baseUrl: 'http://gpu-server:11434',
      model: 'mxbai-embed-large',
      dimensions: 1024,
    });
    expect(provider.modelName).toBe('mxbai-embed-large');

    await provider.embed(['test']);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://gpu-server:11434/api/embed',
      expect.objectContaining({
        body: JSON.stringify({ model: 'mxbai-embed-large', input: ['test'] }),
      }),
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
    });

    const provider = new OllamaProvider();
    await expect(provider.embed(['test'])).rejects.toThrow('Ollama embed failed');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/providers/ollama.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement OllamaProvider**

Create `src/embeddings/providers/ollama.ts`:

```typescript
import type { EmbeddingProvider } from '../types.js';

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class OllamaProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts?: OllamaOptions) {
    this.baseUrl = (opts?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.modelName = opts?.model ?? 'nomic-embed-text';
    this.dimensions = opts?.dimensions ?? 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${body}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/providers/ollama.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/embeddings/types.ts src/embeddings/providers/ollama.ts tests/embeddings/providers/ollama.test.ts
git commit -m "add EmbeddingProvider interface and OllamaProvider implementation"
```

---

### Task 5: Embedding Provider — OpenAI Implementation

**Files:**
- Create: `src/embeddings/providers/openai.ts`
- Create: `tests/embeddings/providers/openai.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/embeddings/providers/openai.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../../../src/embeddings/providers/openai.js';

describe('OpenAIProvider', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct default dimensions and model', () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    expect(provider.dimensions).toBe(1536);
    expect(provider.modelName).toBe('text-embedding-3-small');
  });

  it('calls OpenAI embeddings endpoint with correct payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      }),
    });

    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const result = await provider.embed(['hello world']);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer sk-test',
        }),
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: ['hello world'],
        }),
      }),
    );
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('returns embeddings sorted by index', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [3, 3], index: 2 },
          { embedding: [1, 1], index: 0 },
          { embedding: [2, 2], index: 1 },
        ],
      }),
    });

    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const result = await provider.embed(['a', 'b', 'c']);

    expect(result).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const provider = new OpenAIProvider({ apiKey: 'bad-key' });
    await expect(provider.embed(['test'])).rejects.toThrow('OpenAI embed failed');
  });

  it('reads apiKey from OPENAI_API_KEY env var if not provided', () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env';

    const provider = new OpenAIProvider();
    // Verify it doesn't throw — the key is read from env
    expect(provider.modelName).toBe('text-embedding-3-small');

    process.env.OPENAI_API_KEY = original;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/providers/openai.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement OpenAIProvider**

Create `src/embeddings/providers/openai.ts`:

```typescript
import type { EmbeddingProvider } from '../types.js';

export interface OpenAIOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts?: OpenAIOptions) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (opts?.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.modelName = opts?.model ?? 'text-embedding-3-small';
    this.dimensions = opts?.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embed failed (${response.status}): ${body}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to ensure correct ordering
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/providers/openai.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/providers/openai.ts tests/embeddings/providers/openai.test.ts
git commit -m "add OpenAIProvider embedding implementation"
```

---

### Task 6: Provider Factory

**Files:**
- Create: `src/embeddings/provider-factory.ts`
- Create: `tests/embeddings/provider-factory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/embeddings/provider-factory.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/embeddings/provider-factory.js';
import { OllamaProvider } from '../../src/embeddings/providers/ollama.js';
import { OpenAIProvider } from '../../src/embeddings/providers/openai.js';

describe('createProvider', () => {
  it('creates OllamaProvider for ollama config', () => {
    const provider = createProvider({ provider: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.modelName).toBe('nomic-embed-text');
  });

  it('creates OpenAIProvider for openai config', () => {
    const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.modelName).toBe('text-embedding-3-small');
  });

  it('passes custom model and baseUrl to provider', () => {
    const provider = createProvider({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      baseUrl: 'http://gpu:11434',
    });
    expect(provider.modelName).toBe('mxbai-embed-large');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/provider-factory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement factory**

Create `src/embeddings/provider-factory.ts`:

```typescript
import type { EmbeddingConfig, EmbeddingProvider } from './types.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';

export function createProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.baseUrl,
        model: config.model,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/provider-factory.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/provider-factory.ts tests/embeddings/provider-factory.test.ts
git commit -m "add embedding provider factory"
```

---

### Task 7: sqlite-vec Setup — Extension Loading + Vec Table Management

**Files:**
- Create: `src/embeddings/vec.ts`
- Create: `tests/embeddings/vec.test.ts`

This task requires installing the `sqlite-vec` npm package first.

- [ ] **Step 1: Install sqlite-vec**

Run: `npm install sqlite-vec`

- [ ] **Step 2: Write failing tests**

Create `tests/embeddings/vec.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable } from '../../src/embeddings/vec.js';

describe('sqlite-vec setup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
  });

  afterEach(() => {
    db.close();
  });

  it('loads sqlite-vec extension without error', () => {
    // Extension already loaded in beforeEach — verify vec0 is available
    const result = db.prepare("SELECT vec_version()").get() as any;
    expect(result).toBeDefined();
  });

  it('creates vec_chunks virtual table with specified dimensions', () => {
    createVecTable(db, 768);

    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).get();
    expect(row).toBeDefined();
  });

  it('getVecDimensions returns null when vec_chunks does not exist', () => {
    expect(getVecDimensions(db)).toBeNull();
  });

  it('getVecDimensions returns dimensions when vec_chunks exists', () => {
    createVecTable(db, 768);
    expect(getVecDimensions(db)).toBe(768);
  });

  it('dropVecTable removes the table', () => {
    createVecTable(db, 768);
    dropVecTable(db);

    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).get();
    expect(row).toBeUndefined();
  });

  it('can insert and query vectors', () => {
    createVecTable(db, 3);

    db.prepare(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)'
    ).run('test#full', new Float32Array([1.0, 0.0, 0.0]).buffer);

    db.prepare(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)'
    ).run('test2#full', new Float32Array([0.0, 1.0, 0.0]).buffer);

    // Query for nearest neighbor to [1, 0, 0]
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const rows = db.prepare(
      'SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 2'
    ).all(queryVec) as any[];

    expect(rows).toHaveLength(2);
    expect(rows[0].chunk_id).toBe('test#full');
    expect(rows[0].distance).toBeCloseTo(0, 5);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/vec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement vec.ts**

Create `src/embeddings/vec.ts`:

```typescript
import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function loadVecExtension(db: Database.Database): void {
  sqliteVec.load(db);
}

export function createVecTable(db: Database.Database, dimensions: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    )
  `);
}

export function getVecDimensions(db: Database.Database): number | null {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
  ).get();
  if (!row) return null;

  // Query the table's SQL to extract dimensions
  const sqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
  ).get() as { sql: string } | undefined;
  if (!sqlRow) return null;

  const match = sqlRow.sql.match(/FLOAT\[(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}

export function dropVecTable(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS vec_chunks');
}
```

Note: The exact `sqlite-vec` loading API may differ — check the `sqlite-vec` npm package docs. The `sqliteVec.load(db)` pattern is the documented approach. If it uses a different API (e.g., returning a path for `db.loadExtension()`), adjust accordingly. The test in step 2 will catch any API mismatch.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/vec.test.ts`
Expected: ALL PASS. If the sqlite-vec load API differs, adjust `loadVecExtension` based on the error and re-run.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/embeddings/vec.ts tests/embeddings/vec.test.ts
git commit -m "add sqlite-vec extension loading and vec table management"
```

---

### Task 8: Embedding Queue Worker

**Files:**
- Create: `src/embeddings/worker.ts`
- Create: `tests/embeddings/worker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/embeddings/worker.test.ts`. Tests use a mock `EmbeddingProvider` and real in-memory DB:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { startEmbeddingWorker } from '../../src/embeddings/worker.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

function createMockProvider(dims: number = 3): EmbeddingProvider & { embedFn: ReturnType<typeof vi.fn> } {
  const embedFn = vi.fn<(texts: string[]) => Promise<number[][]>>();
  embedFn.mockImplementation(async (texts: string[]) =>
    texts.map(() => Array(dims).fill(0.1))
  );
  return {
    dimensions: dims,
    modelName: 'mock-model',
    embed: embedFn,
    embedFn,
  };
}

function insertTestChunkAndQueue(db: Database.Database, chunkId: string, content: string) {
  const nodeId = chunkId.split('#')[0];
  // Ensure node exists
  db.prepare(`INSERT OR IGNORE INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES (?, ?, 'file', ?, ?, 0)`).run(nodeId, nodeId, content, nodeId);
  db.prepare(`INSERT OR REPLACE INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES (?, ?, 0, ?, ?)`).run(chunkId, nodeId, content, 10);
  db.prepare(`INSERT OR REPLACE INTO embedding_queue (chunk_id) VALUES (?)`).run(chunkId);
}

describe('EmbeddingWorker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  it('processes pending queue entries and inserts vectors', async () => {
    const provider = createMockProvider();
    insertTestChunkAndQueue(db, 'test.md#full', 'hello world');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 10 });
    // Wait for one cycle
    await new Promise(r => setTimeout(r, 100));
    await worker.stop();

    // Vector should be inserted
    const vec = db.prepare('SELECT chunk_id FROM vec_chunks').all();
    expect(vec).toHaveLength(1);

    // Queue entry should be removed
    const queue = db.prepare('SELECT * FROM embedding_queue').all();
    expect(queue).toHaveLength(0);

    expect(provider.embedFn).toHaveBeenCalledWith(['hello world']);
  });

  it('handles provider failures with retry', async () => {
    const provider = createMockProvider();
    provider.embedFn
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockImplementation(async (texts: string[]) =>
        texts.map(() => [0.1, 0.2, 0.3])
      );

    insertTestChunkAndQueue(db, 'test.md#full', 'hello');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 10 });
    await new Promise(r => setTimeout(r, 300));
    await worker.stop();

    // Should have retried and succeeded
    const vec = db.prepare('SELECT chunk_id FROM vec_chunks').all();
    expect(vec).toHaveLength(1);
  });

  it('stats() returns queue status', async () => {
    insertTestChunkAndQueue(db, 'a.md#full', 'aaa');
    insertTestChunkAndQueue(db, 'b.md#full', 'bbb');

    const provider = createMockProvider();
    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 5000 });

    const stats = worker.stats();
    expect(stats.pending).toBe(2);
    expect(stats.failed).toBe(0);

    await worker.stop();
  });

  it('resets processing entries to pending on start', async () => {
    insertTestChunkAndQueue(db, 'test.md#full', 'hello');
    // Simulate crash: set status to processing
    db.prepare("UPDATE embedding_queue SET status = 'processing'").run();

    const provider = createMockProvider();
    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 10 });
    await new Promise(r => setTimeout(r, 100));
    await worker.stop();

    // Should have been reset to pending and processed
    const vec = db.prepare('SELECT chunk_id FROM vec_chunks').all();
    expect(vec).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/worker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the worker**

Create `src/embeddings/worker.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './types.js';

export interface WorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxRetries?: number;
}

export interface EmbeddingWorker {
  stop(): Promise<void>;
  stats(): { pending: number; processing: number; failed: number };
}

export function startEmbeddingWorker(
  db: Database.Database,
  provider: EmbeddingProvider,
  opts?: WorkerOptions,
): EmbeddingWorker {
  const pollIntervalMs = opts?.pollIntervalMs ?? 1000;
  const batchSize = opts?.batchSize ?? 50;
  const maxRetries = opts?.maxRetries ?? 3;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: (() => void) | null = null;

  // Reset any entries left in 'processing' state from a previous crash
  db.prepare("UPDATE embedding_queue SET status = 'pending' WHERE status = 'processing'").run();

  async function processOnce(): Promise<boolean> {
    // Claim a batch
    const pending = db.prepare(`
      SELECT eq.chunk_id, c.content
      FROM embedding_queue eq
      JOIN chunks c ON c.id = eq.chunk_id
      WHERE eq.status = 'pending'
      ORDER BY eq.created_at
      LIMIT ?
    `).all(batchSize) as Array<{ chunk_id: string; content: string }>;

    if (pending.length === 0) return false;

    const chunkIds = pending.map(p => p.chunk_id);
    const texts = pending.map(p => p.content);

    // Mark as processing
    const placeholders = chunkIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE embedding_queue SET status = 'processing', updated_at = datetime('now') WHERE chunk_id IN (${placeholders})`
    ).run(...chunkIds);

    try {
      const vectors = await provider.embed(texts);

      db.transaction(() => {
        const insertVec = db.prepare(
          'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)'
        );
        const deleteQueue = db.prepare(
          'DELETE FROM embedding_queue WHERE chunk_id = ?'
        );

        for (let i = 0; i < chunkIds.length; i++) {
          const buffer = new Float32Array(vectors[i]).buffer;
          insertVec.run(chunkIds[i], buffer);
          deleteQueue.run(chunkIds[i]);
        }
      })();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      db.transaction(() => {
        for (const chunkId of chunkIds) {
          const row = db.prepare(
            'SELECT attempts FROM embedding_queue WHERE chunk_id = ?'
          ).get(chunkId) as { attempts: number } | undefined;

          const attempts = (row?.attempts ?? 0) + 1;
          const newStatus = attempts >= maxRetries ? 'failed' : 'pending';

          db.prepare(`
            UPDATE embedding_queue
            SET status = ?, attempts = ?, error = ?, updated_at = datetime('now')
            WHERE chunk_id = ?
          `).run(newStatus, attempts, errorMsg, chunkId);
        }
      })();
    }

    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        const hadWork = await processOnce();
        if (!running) break;
        await new Promise<void>(resolve => {
          timer = setTimeout(resolve, hadWork ? 0 : pollIntervalMs);
        });
      } catch {
        if (!running) break;
        await new Promise<void>(resolve => {
          timer = setTimeout(resolve, pollIntervalMs);
        });
      }
    }
    resolveStop?.();
  }

  // Start the loop
  loop();

  return {
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      return new Promise<void>(resolve => {
        resolveStop = resolve;
        // In case the loop is already done
        setTimeout(resolve, 50);
      });
    },

    stats() {
      const rows = db.prepare(`
        SELECT status, COUNT(*) as count FROM embedding_queue GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      const counts = { pending: 0, processing: 0, failed: 0 };
      for (const row of rows) {
        if (row.status in counts) {
          counts[row.status as keyof typeof counts] = row.count;
        }
      }
      return counts;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/worker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/embeddings/worker.ts tests/embeddings/worker.test.ts
git commit -m "add async embedding queue worker"
```

---

### Task 9: Semantic Search Function

**Files:**
- Create: `src/embeddings/search.ts`
- Create: `tests/embeddings/search.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/embeddings/search.test.ts`. These tests use a real in-memory DB with pre-inserted vectors (no provider needed for search function tests — we insert vectors directly):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { semanticSearch, getPendingEmbeddingCount } from '../../src/embeddings/search.js';
import type { SemanticSearchOptions } from '../../src/embeddings/search.js';

function setupTestData(db: Database.Database) {
  // Insert nodes
  db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES ('meetings/q1.md', 'meetings/q1.md', 'file', 'Budget planning for Q1', 'Q1 Planning', 0)`).run();
  db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES ('tasks/review.md', 'tasks/review.md', 'file', 'Review vendor proposals', 'Review Vendors', 0)`).run();
  db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES ('notes/infra.md', 'notes/infra.md', 'file', 'Infrastructure migration notes', 'Infra Migration', 0)`).run();

  // Insert types
  db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('meetings/q1.md', 'meeting')`).run();
  db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('tasks/review.md', 'task')`).run();
  db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('notes/infra.md', 'note')`).run();

  // Insert fields
  db.prepare(`INSERT INTO fields (node_id, key, value_text, value_type) VALUES ('tasks/review.md', 'status', 'todo', 'string')`).run();

  // Insert chunks
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES ('meetings/q1.md#full', 'meetings/q1.md', 0, 'Budget planning for Q1', 10)`).run();
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, heading, content, token_count)
    VALUES ('tasks/review.md#section:0', 'tasks/review.md', 0, 'Overview', 'Review vendor proposals for infrastructure', 10)`).run();
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, heading, content, token_count)
    VALUES ('tasks/review.md#section:1', 'tasks/review.md', 1, 'Details', 'Compare pricing and features of each vendor', 10)`).run();
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES ('notes/infra.md#full', 'notes/infra.md', 0, 'Infrastructure migration notes from Q4', 10)`).run();

  // Insert vectors — use directional vectors so distance-based ranking is deterministic
  // "infrastructure" query vector will be [1, 0, 0]
  // notes/infra.md is closest: [0.9, 0.1, 0.0]
  // tasks/review.md section:0 is next: [0.7, 0.3, 0.0] (mentions infrastructure)
  // tasks/review.md section:1 is further: [0.3, 0.7, 0.0]
  // meetings/q1.md is furthest: [0.0, 0.0, 1.0]
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'notes/infra.md#full', new Float32Array([0.9, 0.1, 0.0]).buffer
  );
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'tasks/review.md#section:0', new Float32Array([0.7, 0.3, 0.0]).buffer
  );
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'tasks/review.md#section:1', new Float32Array([0.3, 0.7, 0.0]).buffer
  );
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'meetings/q1.md#full', new Float32Array([0.0, 0.0, 1.0]).buffer
  );
}

describe('semanticSearch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
    setupTestData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns nodes ranked by vector similarity', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, {});

    expect(results.length).toBeGreaterThan(0);
    // notes/infra.md should be closest to [1, 0, 0]
    expect(results[0].id).toBe('notes/infra.md');
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });

  it('deduplicates by node_id keeping best chunk', () => {
    const queryVec = new Float32Array([0.7, 0.3, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, {});

    // tasks/review.md has two chunks — should appear only once
    const taskResults = results.filter(r => r.id === 'tasks/review.md');
    expect(taskResults).toHaveLength(1);
  });

  it('filters by schema_type', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, { schema_type: 'task' });

    expect(results.every(r => r.types.includes('task'))).toBe(true);
    expect(results.some(r => r.id === 'tasks/review.md')).toBe(true);
  });

  it('filters by field equality', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, {
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });

    expect(results.every(r => r.fields.status === 'todo')).toBe(true);
  });

  it('includes matching chunk when include_chunks is true', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, { include_chunks: true });

    expect(results[0].matchingChunk).toBeDefined();
    expect(results[0].matchingChunk!.content).toBeTruthy();
  });

  it('omits matchingChunk when include_chunks is false', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, {});

    expect(results[0].matchingChunk).toBeUndefined();
  });

  it('respects limit parameter', () => {
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, { limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('getPendingEmbeddingCount returns count of unprocessed entries', () => {
    // Add pending queue entries
    db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, content, token_count)
      VALUES ('extra.md#full', 'notes/infra.md', 99, 'extra', 5)`).run();
    db.prepare(`INSERT INTO embedding_queue (chunk_id) VALUES ('extra.md#full')`).run();

    const count = getPendingEmbeddingCount(db);
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/search.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement semantic search**

Create `src/embeddings/search.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface SemanticSearchFilter {
  field: string;
  operator: 'eq';
  value: string;
}

export interface SemanticSearchOptions {
  schema_type?: string;
  filters?: SemanticSearchFilter[];
  limit?: number;
  include_chunks?: boolean;
}

export interface SemanticSearchResult {
  id: string;
  filePath: string;
  title: string;
  types: string[];
  fields: Record<string, string>;
  score: number;
  matchingChunk?: {
    heading: string | null;
    content: string;
  };
}

export function semanticSearch(
  db: Database.Database,
  queryVector: ArrayBuffer,
  options: SemanticSearchOptions,
): SemanticSearchResult[] {
  const limit = options.limit ?? 10;
  const overFetch = limit * 3;

  // Step 1: Get nearest neighbors from vec_chunks
  const vecRows = db.prepare(
    'SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
  ).all(queryVector, overFetch) as Array<{ chunk_id: string; distance: number }>;

  if (vecRows.length === 0) return [];

  // Step 2: Extract node_ids and deduplicate (keep best distance per node)
  const bestByNode = new Map<string, { chunkId: string; distance: number }>();
  for (const row of vecRows) {
    const nodeId = row.chunk_id.split('#')[0];
    const existing = bestByNode.get(nodeId);
    if (!existing || row.distance < existing.distance) {
      bestByNode.set(nodeId, { chunkId: row.chunk_id, distance: row.distance });
    }
  }

  // Step 3: Load node data and apply structured filters
  const nodeIds = [...bestByNode.keys()];
  const placeholders = nodeIds.map(() => '?').join(',');

  // Load nodes
  const nodes = db.prepare(`
    SELECT id, file_path, title FROM nodes WHERE id IN (${placeholders})
  `).all(...nodeIds) as Array<{ id: string; file_path: string; title: string }>;

  // Load types
  const typeRows = db.prepare(`
    SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})
  `).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

  const typesMap = new Map<string, string[]>();
  for (const row of typeRows) {
    const arr = typesMap.get(row.node_id) ?? [];
    arr.push(row.schema_type);
    typesMap.set(row.node_id, arr);
  }

  // Load fields
  const fieldRows = db.prepare(`
    SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})
  `).all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

  const fieldsMap = new Map<string, Record<string, string>>();
  for (const row of fieldRows) {
    const rec = fieldsMap.get(row.node_id) ?? {};
    rec[row.key] = row.value_text;
    fieldsMap.set(row.node_id, rec);
  }

  // Step 4: Build results with filters
  let results: SemanticSearchResult[] = [];

  for (const node of nodes) {
    const types = typesMap.get(node.id) ?? [];
    const fields = fieldsMap.get(node.id) ?? {};

    // Apply schema_type filter
    if (options.schema_type && !types.includes(options.schema_type)) continue;

    // Apply field filters
    if (options.filters) {
      let pass = true;
      for (const filter of options.filters) {
        if (fields[filter.field] !== filter.value) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;
    }

    const best = bestByNode.get(node.id)!;
    // Convert distance to 0-1 similarity: 1 / (1 + distance)
    const score = 1 / (1 + best.distance);

    const result: SemanticSearchResult = {
      id: node.id,
      filePath: node.file_path,
      title: node.title,
      types,
      fields,
      score,
    };

    if (options.include_chunks) {
      const chunk = db.prepare(
        'SELECT heading, content FROM chunks WHERE id = ?'
      ).get(best.chunkId) as { heading: string | null; content: string } | undefined;

      if (chunk) {
        result.matchingChunk = {
          heading: chunk.heading,
          content: chunk.content,
        };
      }
    }

    results.push(result);
  }

  // Sort by score descending (highest similarity first)
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

export function getPendingEmbeddingCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM embedding_queue WHERE status IN ('pending', 'processing')"
  ).get() as { count: number };
  return row.count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/search.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/embeddings/search.ts tests/embeddings/search.test.ts
git commit -m "add semantic search with hybrid filtering and deduplication"
```

---

### Task 10: Module Index — `src/embeddings/index.ts`

**Files:**
- Create: `src/embeddings/index.ts`

- [ ] **Step 1: Create the barrel export**

Create `src/embeddings/index.ts`:

```typescript
export type { Chunk, EmbeddingProvider, EmbeddingConfig } from './types.js';
export { chunkFile, estimateTokens } from './chunker.js';
export { createProvider } from './provider-factory.js';
export { OllamaProvider } from './providers/ollama.js';
export { OpenAIProvider } from './providers/openai.js';
export { loadVecExtension, createVecTable, getVecDimensions, dropVecTable } from './vec.js';
export { startEmbeddingWorker } from './worker.js';
export type { EmbeddingWorker, WorkerOptions } from './worker.js';
export { semanticSearch, getPendingEmbeddingCount } from './search.js';
export type { SemanticSearchOptions, SemanticSearchResult, SemanticSearchFilter } from './search.js';
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/embeddings/index.ts
git commit -m "add embeddings module barrel export"
```

---

### Task 11: `semantic-search` MCP Tool

**Files:**
- Modify: `src/mcp/server.ts` (add `semantic-search` tool registration)
- Create: `tests/mcp/semantic-search.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/semantic-search.test.ts`. This tests the MCP tool via `Client` + `InMemoryTransport` — the same pattern used by all existing MCP tests (see `tests/mcp/batch-mutate.test.ts`). Mock `fetch` for the provider call:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';

function setupTestData(db: Database.Database) {
  db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES ('notes/infra.md', 'notes/infra.md', 'file', 'Infrastructure migration', 'Infra', 0)`).run();
  db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('notes/infra.md', 'note')`).run();
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES ('notes/infra.md#full', 'notes/infra.md', 0, 'Infrastructure migration notes', 10)`).run();
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'notes/infra.md#full', new Float32Array([0.9, 0.1, 0.0]).buffer
  );
}

describe('semantic-search MCP tool', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
    setupTestData(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function connectClient(server: ReturnType<typeof createServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('returns error when no embedding provider is configured', async () => {
    const server = createServer(db, vaultPath);
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'semantic-search',
      arguments: { query: 'infrastructure' },
    });

    expect((result.content as any)[0].text).toContain('not configured');
    await client.close();
    await server.close();
  });

  it('returns semantic search results when provider is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.9, 0.1, 0.0]] }),
    }));

    const server = createServer(db, vaultPath, {
      embeddingConfig: { provider: 'ollama' },
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'semantic-search',
      arguments: { query: 'infrastructure migration' },
    });

    const data = JSON.parse((result.content as any)[0].text);
    expect(data.results).toBeDefined();
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].id).toBe('notes/infra.md');
    expect(data.results[0].score).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });
});
```

Key design: `createServer` takes an optional third argument `opts?: { embeddingConfig?: EmbeddingConfig }`. If absent, `semantic-search` returns an error. If present, it creates a provider and uses it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/semantic-search.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `createServer` to accept embedding config and register tool**

In `src/mcp/server.ts`:

1. Add imports at top:
```typescript
import { createProvider } from '../embeddings/provider-factory.js';
import { semanticSearch, getPendingEmbeddingCount } from '../embeddings/search.js';
import type { EmbeddingConfig, EmbeddingProvider } from '../embeddings/types.js';
```

2. Change the `createServer` signature:
```typescript
export function createServer(
  db: Database.Database,
  vaultPath: string,
  opts?: { embeddingConfig?: EmbeddingConfig },
): McpServer {
```

3. Create the provider inside `createServer` (at the top, after `const server = ...`):
```typescript
const embeddingProvider: EmbeddingProvider | null = opts?.embeddingConfig
  ? createProvider(opts.embeddingConfig)
  : null;
```

4. Register the `semantic-search` tool after the existing tool registrations:
```typescript
server.tool(
  'semantic-search',
  'Search by semantic similarity with optional type and field filters',
  {
    query: z.string().describe('Natural language search query'),
    schema_type: z.string().optional().describe('Filter results by schema type'),
    filters: z.array(z.object({
      field: z.string(),
      operator: z.literal('eq'),
      value: z.string(),
    })).optional().describe('Field equality filters'),
    limit: z.number().optional().describe('Max results (default 10)'),
    include_chunks: z.boolean().optional().describe('Include matching chunk text'),
  },
  async ({ query, schema_type, filters, limit, include_chunks }) => {
    if (!embeddingProvider) {
      return {
        content: [{ type: 'text' as const, text: 'Semantic search is not configured. Provide an embedding config when starting the engine.' }],
      };
    }

    try {
      const [queryVector] = await embeddingProvider.embed([query]);
      const queryBuffer = new Float32Array(queryVector).buffer;

      const results = semanticSearch(db, queryBuffer, {
        schema_type,
        filters,
        limit,
        include_chunks,
      });

      const pendingEmbeddings = getPendingEmbeddingCount(db);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            ...(pendingEmbeddings > 0 ? { pending_embeddings: pendingEmbeddings } : {}),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Semantic search failed: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/semantic-search.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npm test`
Expected: ALL PASS. Existing tests that call `createServer(db, vaultPath)` should still work since the third argument is optional.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/semantic-search.test.ts
git commit -m "add semantic-search MCP tool with hybrid query support"
```

---

### Task 12: Entry Point Integration

**Files:**
- Modify: `src/index.ts` (add sqlite-vec loading, vec table setup, worker start)

- [ ] **Step 1: Update entry point**

Modify `src/index.ts` to optionally load embedding config, set up sqlite-vec, and start the worker:

```typescript
// vault-engine entry point
import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable, createProvider, startEmbeddingWorker } from './embeddings/index.js';
import type { EmbeddingConfig } from './embeddings/types.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = process.argv[3] ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

// Load embedding config from .vault-engine/config.json if it exists
let embeddingConfig: EmbeddingConfig | undefined;
const configPath = join(dirname(dbPath), 'config.json');
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.embeddings) {
      embeddingConfig = config.embeddings as EmbeddingConfig;
    }
  } catch {
    console.error('[vault-engine] failed to read config.json');
  }
}

// Set up sqlite-vec and embedding worker if configured
if (embeddingConfig) {
  loadVecExtension(db);
  const provider = createProvider(embeddingConfig);

  // Handle dimension mismatch
  const existingDims = getVecDimensions(db);
  if (existingDims !== null && existingDims !== provider.dimensions) {
    console.error(`[vault-engine] embedding dimensions changed (${existingDims} → ${provider.dimensions}), rebuilding vec table`);
    dropVecTable(db);
    // Re-queue all chunks
    db.prepare('DELETE FROM embedding_queue').run();
    const chunks = db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>;
    const insertQueue = db.prepare('INSERT INTO embedding_queue (chunk_id) VALUES (?)');
    for (const chunk of chunks) {
      insertQueue.run(chunk.id);
    }
  }

  createVecTable(db, provider.dimensions);
  startEmbeddingWorker(db, provider, { batchSize: embeddingConfig.batchSize });
}

const server = createServer(db, vaultPath, embeddingConfig ? { embeddingConfig } : undefined);
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "integrate embedding pipeline into entry point with optional config"
```

---

### Task 13: End-to-End Smoke Test

**Files:**
- Create: `tests/embeddings/e2e.test.ts`

- [ ] **Step 1: Write an end-to-end test**

This test verifies the full pipeline: index a file → chunks created → worker processes queue → semantic search returns results:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { startEmbeddingWorker } from '../../src/embeddings/worker.js';
import { semanticSearch } from '../../src/embeddings/search.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

describe('embedding pipeline end-to-end', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes a file, embeds chunks, and returns semantic search results', async () => {
    // Create a mock provider that returns deterministic vectors
    const mockProvider: EmbeddingProvider = {
      dimensions: 3,
      modelName: 'mock',
      embed: async (texts: string[]) =>
        texts.map(t =>
          t.includes('infrastructure') ? [0.9, 0.1, 0.0] : [0.1, 0.1, 0.8]
        ),
    };

    // Index a file with headings — needs enough content to exceed 200-token threshold
    // so the chunker splits by section instead of returning a single full chunk.
    // ~160 words total ≈ 208 estimated tokens (160 * 1.3)
    const infraContent = 'We need to migrate the infrastructure to the new cloud provider. ' +
      'This involves moving all production databases, application servers, and networking ' +
      'configuration from the legacy data center to the cloud environment. The migration ' +
      'must be completed with zero downtime using a blue-green deployment strategy. ' +
      'Key infrastructure components include the primary PostgreSQL cluster, Redis cache ' +
      'layer, load balancers, and container orchestration platform. Each component requires ' +
      'its own migration runbook and rollback procedure.';
    const timelineContent = 'The migration timeline spans Q2 and Q3 of this year. ' +
      'Phase one covers database replication and failover testing during April and May. ' +
      'Phase two handles application server migration with traffic shifting in June. ' +
      'Phase three addresses networking cutover and DNS propagation in July. ' +
      'Final validation and legacy decommissioning will occur in August. ' +
      'Each phase has dedicated testing windows and stakeholder sign-off requirements.';
    const raw = [
      '---',
      'title: Migration Plan',
      'types: [note]',
      '---',
      '',
      '## Infrastructure',
      '',
      infraContent,
      '',
      '## Timeline',
      '',
      timelineContent,
    ].join('\n');
    const parsed = parseFile('plans/migration.md', raw);
    indexFile(db, parsed, 'plans/migration.md', '2025-03-10T00:00:00.000Z', raw);

    // Verify chunks were created — should split into 2 sections
    const chunks = db.prepare('SELECT * FROM chunks WHERE node_id = ?').all('plans/migration.md');
    expect(chunks.length).toBe(2);

    // Verify queue entries exist
    const queue = db.prepare('SELECT * FROM embedding_queue').all();
    expect(queue.length).toBe(chunks.length);

    // Start worker and wait for processing
    const worker = startEmbeddingWorker(db, mockProvider, { pollIntervalMs: 10 });
    await new Promise(r => setTimeout(r, 200));
    await worker.stop();

    // Verify embeddings were created
    const vecs = db.prepare('SELECT * FROM vec_chunks').all();
    expect(vecs.length).toBe(chunks.length);

    // Verify queue is drained
    const remaining = db.prepare('SELECT * FROM embedding_queue').all();
    expect(remaining).toHaveLength(0);

    // Search for infrastructure-related content
    const queryVec = new Float32Array([1.0, 0.0, 0.0]).buffer;
    const results = semanticSearch(db, queryVec, { include_chunks: true });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('plans/migration.md');
    expect(results[0].title).toBe('Migration Plan');
    expect(results[0].matchingChunk).toBeDefined();
    // The infrastructure chunk should be the best match
    expect(results[0].matchingChunk!.content).toContain('infrastructure');
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `npx vitest run tests/embeddings/e2e.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/embeddings/e2e.test.ts
git commit -m "add end-to-end embedding pipeline smoke test"
```
