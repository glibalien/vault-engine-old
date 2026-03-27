# read-embedded Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `read-embedded` MCP tool that reads `![[embed]]` attachments from vault notes — images as base64, audio transcribed via Fireworks Whisper, documents as extracted text.

**Architecture:** New `src/attachments/` module with three files: types, resolver (embed parsing + path resolution), and readers (type-branched content extraction). The MCP tool in `server.ts` orchestrates resolution and reading, returning an array of MCP content blocks. Fireworks Whisper called via OpenAI SDK with API key from `process.env.FIREWORKS_API_KEY` loaded by dotenv.

**Tech Stack:** OpenAI SDK (Fireworks Whisper), mammoth (docx), pdf-parse (PDF), dotenv (env loading), vitest (tests)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/attachments/types.ts` | `AttachmentType` enum, `ResolvedEmbed`, `ReadResult` interfaces |
| `src/attachments/resolver.ts` | `parseEmbeds(raw)` extracts embed filenames, `resolveEmbedPath(filename, vaultPath, sourceDir)` finds file on disk |
| `src/attachments/readers.ts` | `readImage(path)`, `readAudio(path)`, `readDocument(path)` — type-branched content extraction |
| `src/attachments/index.ts` | Re-exports |
| `src/mcp/server.ts` | New `read-embedded` tool registration (at end, before `return server`) |
| `src/index.ts` | Add `import 'dotenv/config'` as first import |
| `.env.example` | Template: `FIREWORKS_API_KEY=your-key-here` |
| `.gitignore` | Add `.env` entry |
| `tests/attachments/resolver.test.ts` | Embed parsing and path resolution tests |
| `tests/attachments/readers.test.ts` | Content reader tests with fixture files |
| `tests/mcp/read-embedded.test.ts` | MCP tool integration test |

---

### Task 1: Project setup — dependencies, dotenv, .env.example, .gitignore

**Files:**
- Modify: `package.json`
- Modify: `src/index.ts:1` (add dotenv import)
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install openai mammoth pdf-parse dotenv
npm install --save-dev @types/pdf-parse
```

- [ ] **Step 2: Add dotenv import as first line of `src/index.ts`**

Change the top of `src/index.ts` from:
```typescript
// vault-engine entry point
import { resolve, dirname, join } from 'node:path';
```
to:
```typescript
// vault-engine entry point
import 'dotenv/config';
import { resolve, dirname, join } from 'node:path';
```

- [ ] **Step 3: Add `.env` to `.gitignore`**

Append `.env` to the end of `.gitignore` (after the existing `.worktrees/` line).

- [ ] **Step 4: Create `.env.example`**

Create `.env.example` with:
```
FIREWORKS_API_KEY=your-key-here
```

- [ ] **Step 5: Verify build passes**

Run: `npx tsc --noEmit`
Expected: no errors (dotenv/config is a side-effect import, no types needed)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/index.ts .gitignore .env.example
git commit -m "chore: add dotenv, openai, mammoth, pdf-parse dependencies"
```

---

### Task 2: Attachment types

**Files:**
- Create: `src/attachments/types.ts`

- [ ] **Step 1: Create `src/attachments/types.ts`**

```typescript
// src/attachments/types.ts

export type AttachmentType = 'image' | 'audio' | 'document' | 'unknown';

export interface ResolvedEmbed {
  /** Original filename from ![[filename]] */
  filename: string;
  /** Absolute path on disk (null if unresolved) */
  absolutePath: string | null;
  /** Classified attachment type */
  attachmentType: AttachmentType;
}

export interface ReadResult {
  /** Original filename */
  filename: string;
  /** MCP content blocks produced by reading this attachment */
  content: Array<ImageContent | TextContent>;
  /** Whether reading succeeded */
  ok: boolean;
  /** Error message if reading failed */
  error?: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'ogg', 'webm']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);

export function classifyAttachment(filename: string): AttachmentType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'unknown';
}

export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/attachments/types.ts
git commit -m "feat(attachments): add attachment type definitions"
```

---

### Task 3: Embed resolver — parsing and path resolution

**Files:**
- Create: `src/attachments/resolver.ts`
- Create: `tests/attachments/resolver.test.ts`

- [ ] **Step 1: Write failing tests for `parseEmbeds`**

Create `tests/attachments/resolver.test.ts`:

```typescript
// tests/attachments/resolver.test.ts
import { describe, it, expect } from 'vitest';
import { parseEmbeds } from '../../src/attachments/resolver.js';

describe('parseEmbeds', () => {
  it('extracts embed filenames from markdown', () => {
    const raw = `# Notes\n\nSee this image: ![[photo.png]]\n\nAnd this: ![[recording.m4a]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png', 'recording.m4a']);
  });

  it('strips size suffix from image embeds', () => {
    const raw = `![[photo.png|400]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('skips .md file embeds (transclusions)', () => {
    const raw = `![[other-note.md]]\n![[photo.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('returns empty array when no embeds found', () => {
    const raw = `# Just text\n\nNo embeds here. [[wiki-link]] but not embed.`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual([]);
  });

  it('handles duplicate embeds (returns unique)', () => {
    const raw = `![[photo.png]]\n\n![[photo.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('does not match regular wiki-links', () => {
    const raw = `[[not-an-embed.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/attachments/resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `parseEmbeds`**

Create `src/attachments/resolver.ts`:

```typescript
// src/attachments/resolver.ts
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { classifyAttachment } from './types.js';
import type { AttachmentType, ResolvedEmbed } from './types.js';

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

export function parseEmbeds(raw: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EMBED_RE.source, EMBED_RE.flags);
  while ((match = re.exec(raw)) !== null) {
    // Strip optional size/display suffix: ![[file.png|400]] → file.png
    let filename = match[1].split('|')[0].trim();
    // Skip .md transclusions
    if (filename.toLowerCase().endsWith('.md')) continue;
    if (!seen.has(filename)) {
      seen.add(filename);
      results.push(filename);
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attachments/resolver.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Write failing tests for `resolveEmbedPath`**

Add to `tests/attachments/resolver.test.ts`:

```typescript
import { resolveEmbedPath } from '../../src/attachments/resolver.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';

describe('resolveEmbedPath', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = join(tmpdir(), `vault-test-${Date.now()}`);
    mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('resolves from Attachments/ folder first', () => {
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'Attachments', 'photo.png'));
  });

  it('resolves from vault root as second choice', () => {
    writeFileSync(join(vaultDir, 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'photo.png'));
  });

  it('resolves from source node directory as third choice', () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'notes', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'notes', 'photo.png'));
  });

  it('falls back to recursive search', () => {
    mkdirSync(join(vaultDir, 'deep', 'nested', 'media'), { recursive: true });
    writeFileSync(join(vaultDir, 'deep', 'nested', 'media', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'deep', 'nested', 'media', 'photo.png'));
  });

  it('returns null when file cannot be found', () => {
    const result = resolveEmbedPath('missing.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBeNull();
  });

  it('skips .git and node_modules in recursive search', () => {
    mkdirSync(join(vaultDir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(vaultDir, '.git', 'objects', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests to verify new tests fail**

Run: `npx vitest run tests/attachments/resolver.test.ts`
Expected: `resolveEmbedPath` tests FAIL — function not exported

- [ ] **Step 7: Implement `resolveEmbedPath`**

Add to `src/attachments/resolver.ts`:

```typescript
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vault-engine']);

export function resolveEmbedPath(
  filename: string,
  vaultPath: string,
  sourceDir: string,
): string | null {
  // 1. Attachments/ folder
  const attachmentsPath = join(vaultPath, 'Attachments', filename);
  if (existsSync(attachmentsPath)) return attachmentsPath;

  // 2. Vault root
  const rootPath = join(vaultPath, filename);
  if (existsSync(rootPath)) return rootPath;

  // 3. Same directory as source note
  const siblingPath = join(sourceDir, filename);
  if (existsSync(siblingPath)) return siblingPath;

  // 4. Recursive search (slow path)
  const target = basename(filename);
  try {
    const entries = readdirSync(vaultPath, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name !== target) continue;
      // Build parent path and check for skip dirs
      const parentPath = entry.parentPath ?? (entry as any).path ?? '';
      const relative = parentPath.startsWith(vaultPath)
        ? parentPath.slice(vaultPath.length + 1)
        : parentPath;
      const segments = relative.split('/');
      if (segments.some(seg => SKIP_DIRS.has(seg))) continue;
      return join(parentPath, entry.name);
    }
  } catch {
    // readdirSync failure — vault path issue, return null
  }

  return null;
}
```

- [ ] **Step 8: Also add the `resolveEmbeds` convenience function**

Add to `src/attachments/resolver.ts`:

```typescript
export function resolveEmbeds(
  raw: string,
  vaultPath: string,
  sourceDir: string,
  filterType?: AttachmentType | 'all',
): ResolvedEmbed[] {
  const filenames = parseEmbeds(raw);
  const results: ResolvedEmbed[] = [];
  for (const filename of filenames) {
    const attachmentType = classifyAttachment(filename);
    if (filterType && filterType !== 'all' && attachmentType !== filterType) continue;
    const absolutePath = resolveEmbedPath(filename, vaultPath, sourceDir);
    results.push({ filename, absolutePath, attachmentType });
  }
  return results;
}
```

- [ ] **Step 9: Run all resolver tests**

Run: `npx vitest run tests/attachments/resolver.test.ts`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/attachments/resolver.ts tests/attachments/resolver.test.ts
git commit -m "feat(attachments): add embed parser and path resolver"
```

---

### Task 4: Content readers — image, audio, document

**Files:**
- Create: `src/attachments/readers.ts`
- Create: `tests/attachments/readers.test.ts`
- Create: `tests/fixtures/attachments/` (test fixture files)

- [ ] **Step 1: Create test fixture files**

Create minimal fixture files for testing:

```bash
mkdir -p tests/fixtures/attachments
```

Create `tests/fixtures/attachments/sample.txt` with content:
```
This is sample text content for testing.
```

Create a 1x1 red PNG pixel for image testing. Run:
```bash
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' | base64 -d > tests/fixtures/attachments/pixel.png
```

Create `tests/fixtures/attachments/sample.svg` with content:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="red" width="10" height="10"/></svg>
```

- [ ] **Step 2: Write failing tests for `readImage`**

Create `tests/attachments/readers.test.ts`:

```typescript
// tests/attachments/readers.test.ts
import { describe, it, expect } from 'vitest';
import { readImage } from '../../src/attachments/readers.js';
import { resolve } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures/attachments');

describe('readImage', () => {
  it('returns base64 image content block for raster images', () => {
    const result = readImage(resolve(fixturesDir, 'pixel.png'), 'pixel.png');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect((result.content[0] as any).data).toBeTruthy();
  });

  it('returns text content block for SVG', () => {
    const result = readImage(resolve(fixturesDir, 'sample.svg'), 'sample.svg');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toContain('<svg');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `readImage`**

Create `src/attachments/readers.ts`:

```typescript
// src/attachments/readers.ts
import { readFileSync, createReadStream } from 'node:fs';
import { getMimeType } from './types.js';
import type { ReadResult, ImageContent, TextContent } from './types.js';

export function readImage(absolutePath: string, filename: string): ReadResult {
  try {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'svg') {
      const text = readFileSync(absolutePath, 'utf-8');
      return {
        filename,
        ok: true,
        content: [{ type: 'text', text: `--- ${filename} ---\n${text}` }],
      };
    }
    const buffer = readFileSync(absolutePath);
    const data = buffer.toString('base64');
    const mimeType = getMimeType(filename);
    return {
      filename,
      ok: true,
      content: [{ type: 'image', data, mimeType } as ImageContent],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{ type: 'text', text: `--- ${filename} ---\nError reading image: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}
```

- [ ] **Step 5: Run image tests**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing tests for `readDocument`**

Add to `tests/attachments/readers.test.ts`:

```typescript
import { readDocument } from '../../src/attachments/readers.js';

describe('readDocument', () => {
  it('reads plain text files', async () => {
    const result = await readDocument(resolve(fixturesDir, 'sample.txt'), 'sample.txt');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain('sample text content');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: `readDocument` test FAIL

- [ ] **Step 8: Implement `readDocument`**

Add to `src/attachments/readers.ts`:

```typescript
export async function readDocument(absolutePath: string, filename: string): Promise<ReadResult> {
  try {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    let text: string;

    if (ext === 'txt' || ext === 'md') {
      text = readFileSync(absolutePath, 'utf-8');
    } else if (ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = readFileSync(absolutePath);
      const result = await pdfParse(buffer);
      text = result.text;
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: absolutePath });
      text = result.value;
    } else {
      text = readFileSync(absolutePath, 'utf-8');
    }

    return {
      filename,
      ok: true,
      content: [{ type: 'text', text: `--- ${filename} ---\n${text}` }],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{ type: 'text', text: `--- ${filename} ---\nError reading document: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}
```

- [ ] **Step 9: Run document tests**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: PASS

- [ ] **Step 10: Write failing test for `readAudio`**

Add to `tests/attachments/readers.test.ts`:

```typescript
import { readAudio } from '../../src/attachments/readers.js';

describe('readAudio', () => {
  it('returns error when FIREWORKS_API_KEY is not set', async () => {
    const originalKey = process.env.FIREWORKS_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    try {
      const result = await readAudio('/fake/path/recording.m4a', 'recording.m4a');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('FIREWORKS_API_KEY');
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('FIREWORKS_API_KEY not set');
    } finally {
      if (originalKey !== undefined) process.env.FIREWORKS_API_KEY = originalKey;
    }
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: `readAudio` test FAIL

- [ ] **Step 12: Implement `readAudio`**

Add to `src/attachments/readers.ts`:

```typescript
import OpenAI from 'openai';

interface WhisperSegment {
  speaker_id?: number | null;
  text: string;
  start: number;
  end: number;
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDiarized(segments: WhisperSegment[]): string {
  const merged: Array<{ speaker: number | null; text: string; start: number; end: number }> = [];
  for (const seg of segments) {
    const speaker = seg.speaker_id ?? null;
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    if (merged.length > 0 && merged[merged.length - 1].speaker === speaker) {
      merged[merged.length - 1].text += ' ' + text;
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ speaker, text, start: seg.start, end: seg.end });
    }
  }
  return merged
    .map(block => {
      const label = block.speaker !== null
        ? `**Speaker ${block.speaker}** (${formatTimestamp(block.start)} - ${formatTimestamp(block.end)})`
        : `**Unknown Speaker** (${formatTimestamp(block.start)} - ${formatTimestamp(block.end)})`;
      return `${label}\n${block.text}`;
    })
    .join('\n\n');
}

export async function readAudio(absolutePath: string, filename: string): Promise<ReadResult> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    return {
      filename,
      ok: false,
      error: 'FIREWORKS_API_KEY not set',
      content: [{
        type: 'text',
        text: `--- ${filename} ---\nFIREWORKS_API_KEY not set — cannot transcribe audio files`,
      }],
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.fireworks.ai/inference/v1',
    });

    const file = createReadStream(absolutePath);
    const response = await client.audio.transcriptions.create({
      model: 'whisper-v3',
      file,
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      ...{ diarize: true },
    } as any);

    const segments = (response as any).segments as WhisperSegment[] | undefined;
    const transcript = segments && segments.length > 0
      ? formatDiarized(segments)
      : (response as any).text ?? '';

    return {
      filename,
      ok: true,
      content: [{ type: 'text', text: `--- ${filename} ---\n${transcript}` }],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{
        type: 'text',
        text: `--- ${filename} ---\nError transcribing audio: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}
```

- [ ] **Step 13: Run all reader tests**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: all tests PASS

- [ ] **Step 14: Commit**

```bash
git add src/attachments/readers.ts tests/attachments/readers.test.ts tests/fixtures/attachments/
git commit -m "feat(attachments): add image, audio, and document content readers"
```

---

### Task 5: Diarization formatting unit tests

**Files:**
- Modify: `tests/attachments/readers.test.ts`
- Modify: `src/attachments/readers.ts` (export `formatDiarized` and `formatTimestamp`)

- [ ] **Step 1: Export formatting functions for testing**

In `src/attachments/readers.ts`, change `formatTimestamp` and `formatDiarized` from unexported to exported:

```typescript
export function formatTimestamp(seconds: number): string {
```

```typescript
export function formatDiarized(segments: WhisperSegment[]): string {
```

Also export the `WhisperSegment` interface:
```typescript
export interface WhisperSegment {
```

- [ ] **Step 2: Write tests for `formatTimestamp`**

Add to `tests/attachments/readers.test.ts`:

```typescript
import { formatTimestamp, formatDiarized } from '../../src/attachments/readers.js';
import type { WhisperSegment } from '../../src/attachments/readers.js';

describe('formatTimestamp', () => {
  it('formats seconds as M:SS', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5)).toBe('0:05');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(599)).toBe('9:59');
  });

  it('formats as H:MM:SS when over an hour', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3661)).toBe('1:01:01');
    expect(formatTimestamp(7325)).toBe('2:02:05');
  });
});
```

- [ ] **Step 3: Write tests for `formatDiarized`**

Add to `tests/attachments/readers.test.ts`:

```typescript
describe('formatDiarized', () => {
  it('merges consecutive segments from same speaker', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: 0, text: 'Hello', start: 0, end: 2 },
      { speaker_id: 0, text: 'world', start: 2, end: 4 },
      { speaker_id: 1, text: 'Hi there', start: 4, end: 6 },
    ];
    const result = formatDiarized(segments);
    expect(result).toContain('**Speaker 0** (0:00 - 0:04)');
    expect(result).toContain('Hello world');
    expect(result).toContain('**Speaker 1** (0:04 - 0:06)');
    expect(result).toContain('Hi there');
  });

  it('handles null speaker_id as Unknown Speaker', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: null, text: 'Unknown', start: 0, end: 5 },
    ];
    const result = formatDiarized(segments);
    expect(result).toContain('**Unknown Speaker**');
  });

  it('skips empty text segments', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: 0, text: '', start: 0, end: 1 },
      { speaker_id: 0, text: 'Actual text', start: 1, end: 3 },
    ];
    const result = formatDiarized(segments);
    expect(result).toBe('**Speaker 0** (0:01 - 0:03)\nActual text');
  });

  it('returns empty string for no segments', () => {
    expect(formatDiarized([])).toBe('');
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run tests/attachments/readers.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/attachments/readers.ts tests/attachments/readers.test.ts
git commit -m "test(attachments): add diarization formatting unit tests"
```

---

### Task 6: Module index and build verification

**Files:**
- Create: `src/attachments/index.ts`

- [ ] **Step 1: Create `src/attachments/index.ts`**

```typescript
// src/attachments/index.ts
export { parseEmbeds, resolveEmbedPath, resolveEmbeds } from './resolver.js';
export { readImage, readAudio, readDocument, formatTimestamp, formatDiarized } from './readers.js';
export type {
  AttachmentType,
  ResolvedEmbed,
  ReadResult,
  ImageContent,
  TextContent,
  WhisperSegment,
} from './types.js';
export { classifyAttachment, getMimeType } from './types.js';
```

- [ ] **Step 2: Verify full build passes**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run all existing tests to check for regressions**

Run: `npm test`
Expected: all existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/attachments/index.ts
git commit -m "feat(attachments): add module index with re-exports"
```

---

### Task 7: MCP tool registration — `read-embedded`

**Files:**
- Modify: `src/mcp/server.ts` (add tool registration before `return server`)
- Create: `tests/mcp/read-embedded.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `tests/mcp/read-embedded.test.ts`:

```typescript
// tests/mcp/read-embedded.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

describe('read-embedded tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = join(tmpdir(), `vault-embed-test-${Date.now()}`);
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

  it('returns NOT_FOUND for missing node', async () => {
    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: 'nonexistent.md' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
  });

  it('returns summary when no embeds found', async () => {
    const md = '---\ntitle: Plain Note\ntypes: [note]\n---\n\nNo embeds here.';
    const notePath = 'notes/plain.md';
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('No embedded attachments found');
  });

  it('resolves and reads an image embed', async () => {
    // Create an image file in Attachments/
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    // 1x1 red PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), Buffer.from(pngBase64, 'base64'));

    const md = '---\ntitle: Image Note\ntypes: [note]\n---\n\nSee: ![[photo.png]]';
    const notePath = 'notes/with-image.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    // First block: summary
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('1 image');
    // Second block: the image
    expect(content[1].type).toBe('image');
    expect(content[1].mimeType).toBe('image/png');
    expect(content[1].data).toBe(pngBase64);
  });

  it('respects filter_type parameter', async () => {
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), Buffer.from('fake', 'utf-8'));
    writeFileSync(join(vaultDir, 'Attachments', 'doc.txt'), 'hello');

    const md = '---\ntitle: Mixed\ntypes: [note]\n---\n\n![[photo.png]]\n![[doc.txt]]';
    const notePath = 'notes/mixed.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath, filter_type: 'document' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    // Summary should only mention document
    expect(content[0].text).toContain('1 document');
    expect(content[0].text).not.toContain('image');
  });

  it('reports unresolved embeds in summary', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });

    const md = '---\ntitle: Broken\ntypes: [note]\n---\n\n![[missing-file.png]]';
    const notePath = 'notes/broken.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('could not be resolved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/read-embedded.test.ts`
Expected: FAIL — tool not registered

- [ ] **Step 3: Add import and tool registration to `server.ts`**

Add import near the top of `src/mcp/server.ts` (after the existing imports):
```typescript
import { resolveEmbeds } from '../attachments/resolver.js';
import { readImage, readAudio, readDocument } from '../attachments/readers.js';
import type { ImageContent, TextContent } from '../attachments/types.js';
import { dirname } from 'node:path';
```

Note: `dirname` may already be imported — if `join` is imported from `node:path`, add `dirname` to that import. If not already imported, add a new import.

Add the tool registration before the `return server;` line at the end of `createServer`:

```typescript
  // --- read-embedded tool ---
  server.tool(
    'read-embedded',
    'Read and return embedded attachments (![[file]]) from a vault note. Images returned as base64, audio transcribed via Whisper, documents as extracted text.',
    {
      node_id: z.string().min(1).describe('Vault-relative file path of the node to read embeds from, e.g. "notes/meeting.md"'),
      filter_type: z.enum(['all', 'audio', 'image', 'document']).optional().default('all')
        .describe('Filter to specific attachment types'),
    },
    async ({ node_id, filter_type }) => {
      if (hasPathTraversal(node_id)) {
        return toolError('Invalid node_id: path traversal not allowed', 'VALIDATION_ERROR');
      }

      // Check node exists in DB
      const nodeRow = db.prepare('SELECT id, file_path FROM nodes WHERE id = ?').get(node_id) as
        | { id: string; file_path: string }
        | undefined;
      if (!nodeRow) {
        return toolError(`Node not found: ${node_id}`, 'NOT_FOUND');
      }

      // Read raw markdown from disk
      const absPath = join(vaultPath, nodeRow.file_path);
      if (!existsSync(absPath)) {
        return toolError(`File not found on disk: ${nodeRow.file_path}`, 'NOT_FOUND');
      }
      const raw = readFileSync(absPath, 'utf-8');

      // Resolve embeds
      const sourceDir = dirname(absPath);
      const embeds = resolveEmbeds(raw, vaultPath, sourceDir, filter_type === 'all' ? undefined : filter_type);

      if (embeds.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No embedded attachments found in ${node_id}.` }],
        };
      }

      // Read each resolved embed
      const contentBlocks: Array<ImageContent | TextContent> = [];
      const counts = { image: 0, audio: 0, document: 0, unresolved: 0, errors: 0 };

      for (const embed of embeds) {
        if (!embed.absolutePath) {
          counts.unresolved++;
          continue;
        }

        let result;
        switch (embed.attachmentType) {
          case 'image':
            result = readImage(embed.absolutePath, embed.filename);
            if (result.ok) counts.image++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          case 'audio':
            result = await readAudio(embed.absolutePath, embed.filename);
            if (result.ok) counts.audio++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          case 'document':
            result = await readDocument(embed.absolutePath, embed.filename);
            if (result.ok) counts.document++;
            else counts.errors++;
            contentBlocks.push(...result.content);
            break;
          default:
            counts.unresolved++;
            break;
        }
      }

      // Build summary
      const parts: string[] = [];
      if (counts.image > 0) parts.push(`${counts.image} image${counts.image > 1 ? 's' : ''}`);
      if (counts.audio > 0) parts.push(`${counts.audio} audio file${counts.audio > 1 ? 's' : ''} (transcribed)`);
      if (counts.document > 0) parts.push(`${counts.document} document${counts.document > 1 ? 's' : ''}`);
      if (counts.errors > 0) parts.push(`${counts.errors} failed`);
      if (counts.unresolved > 0) parts.push(`${counts.unresolved} could not be resolved`);
      const summary = `Found ${parts.join(', ')}.`;

      return {
        content: [
          { type: 'text' as const, text: summary },
          ...contentBlocks,
        ],
      };
    },
  );
```

- [ ] **Step 4: Verify build passes**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Run integration tests**

Run: `npx vitest run tests/mcp/read-embedded.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/read-embedded.test.ts
git commit -m "feat: add read-embedded MCP tool for attachment content extraction"
```

---

### Task 8: Final verification and CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md` (document the new tool)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Update CLAUDE.md**

In the MCP Layer section of CLAUDE.md, add `read-embedded` to the tool list in the `server.ts` bullet. Update the tool count from 20 to 21 (or current count + 1).

Add a bullet under `server.ts`:
```
  - **`read-embedded`** — Reads `![[embed]]` attachments from a node. Resolves embed paths (Attachments/ → root → sibling → recursive search), then reads by type: images as base64 MCP image blocks, audio transcribed via Fireworks Whisper API (OpenAI SDK), documents via pdf-parse/mammoth/fs. Returns array of content blocks with summary. Requires `FIREWORKS_API_KEY` env var for audio only.
```

Add a new section after the MCP Layer:

```
### Attachments Layer (`src/attachments/`)

Embed resolution and content extraction for `![[file]]` attachments.

- **`types.ts`** — `AttachmentType` enum (image/audio/document/unknown), `ResolvedEmbed`, `ReadResult`, `ImageContent`, `TextContent` interfaces. `classifyAttachment(filename)` and `getMimeType(filename)` helpers.
- **`resolver.ts`** — `parseEmbeds(raw)` extracts `![[filename]]` from markdown via regex (not AST — remark-wiki-link doesn't handle `!` prefix). `resolveEmbedPath(filename, vaultPath, sourceDir)` tries Attachments/ → vault root → source dir → recursive search (skips .git, node_modules, .vault-engine). `resolveEmbeds(raw, vaultPath, sourceDir, filterType?)` combines parsing + resolution.
- **`readers.ts`** — `readImage(path, filename)` returns base64 image block (SVG as text). `readAudio(path, filename)` calls Fireworks Whisper via OpenAI SDK with diarization, formats speaker-labeled transcript. `readDocument(path, filename)` handles PDF (pdf-parse), DOCX (mammoth), TXT/MD (fs). All return `ReadResult` with per-file error handling.
- **`index.ts`** — Re-exports all types and functions.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add read-embedded tool and attachments layer to CLAUDE.md"
```
