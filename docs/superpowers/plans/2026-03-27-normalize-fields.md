# normalize-fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `normalize-fields` MCP tool that normalizes frontmatter field names and value shapes across the vault to match schema definitions.

**Architecture:** Three layers: (1) `patchFrontmatter()` — regex-based surgical YAML patcher that only modifies targeted keys and preserves body byte-for-byte, (2) global write lock in watcher to suppress events during bulk writes, (3) MCP tool handler with rule inference from schemas, audit/apply modes, and file rollback on error.

**Tech Stack:** gray-matter (parse only), regex (patch), better-sqlite3, vitest

---

## File Structure

- **Create:** `src/serializer/patch.ts` — `patchFrontmatter()` pure function + `FrontmatterMutation` type
- **Create:** `src/mcp/normalize-fields.ts` — rule inference, affected-file discovery, audit/apply handler
- **Create:** `tests/serializer/patch.test.ts` — unit tests for patchFrontmatter
- **Create:** `tests/sync/global-lock.test.ts` — global write lock tests
- **Create:** `tests/mcp/normalize-fields.test.ts` — MCP tool integration tests
- **Modify:** `src/serializer/index.ts` — re-export patchFrontmatter + type
- **Modify:** `src/sync/watcher.ts` — add global write lock functions + watcher check
- **Modify:** `src/sync/index.ts` — re-export global lock functions
- **Modify:** `src/mcp/server.ts` — register normalize-fields tool + import handler

---

### Task 1: patchFrontmatter helper

**Files:**
- Create: `src/serializer/patch.ts`
- Create: `tests/serializer/patch.test.ts`
- Modify: `src/serializer/index.ts`

- [ ] **Step 1: Create `src/serializer/patch.ts` with types and stub**

```typescript
// src/serializer/patch.ts

export type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string };

export function patchFrontmatter(
  fileContent: string,
  mutations: FrontmatterMutation[],
): string {
  return fileContent; // stub
}
```

- [ ] **Step 2: Write tests in `tests/serializer/patch.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { patchFrontmatter } from '../../src/serializer/patch.js';

describe('patchFrontmatter', () => {
  const baseFile = [
    '---',
    'title: Test Note',
    'types: [meeting]',
    'Company: Acme Corp',
    'people involved: "[[Alice]]"',
    'status: active',
    '---',
    '',
    'Body content with [[wiki-links]] here.',
    '',
    'More body text.',
    '',
  ].join('\n');

  describe('rename_key', () => {
    it('renames a frontmatter key preserving value', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      expect(result).toContain('company: Acme Corp');
      expect(result).not.toContain('Company:');
    });

    it('skips rename if target key already exists', () => {
      const file = '---\nCompany: Acme\ncompany: Initech\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      // Both keys should remain unchanged
      expect(result).toContain('Company: Acme');
      expect(result).toContain('company: Initech');
    });

    it('is a no-op if from_key does not exist', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'nonexistent', to: 'something' },
      ]);
      expect(result).toBe(baseFile);
    });
  });

  describe('coerce_value', () => {
    it('wraps bare reference in array for list<reference>', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
      ]);
      expect(result).toContain('people involved: ["[[Alice]]"]');
    });

    it('wraps bare string in array for list<string>', () => {
      const file = '---\ntags: work\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      expect(result).toContain('tags: [work]');
    });

    it('does not double-wrap existing arrays', () => {
      const file = '---\ntags: [work, play]\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      expect(result).toContain('tags: [work, play]');
    });

    it('is a no-op for non-list target types', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'coerce_value', key: 'status', targetType: 'string' },
      ]);
      expect(result).toBe(baseFile);
    });
  });

  describe('body preservation', () => {
    it('preserves body content byte-for-byte', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      // Extract body (everything after the closing --- delimiter)
      const origBody = baseFile.slice(baseFile.indexOf('---\n', 4) + 4);
      const resultBody = result.slice(result.indexOf('---\n', 4) + 4);
      expect(resultBody).toBe(origBody);
    });
  });

  describe('multiple mutations', () => {
    it('applies rename then coerce in sequence', () => {
      const file = '---\nPeople Involved: "[[Alice]]"\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'People Involved', to: 'people involved' },
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
      ]);
      expect(result).toContain('people involved: ["[[Alice]]"]');
      expect(result).not.toContain('People Involved');
    });
  });

  describe('edge cases', () => {
    it('returns unchanged content if no frontmatter', () => {
      const noFm = 'Just body content\nNo frontmatter here\n';
      expect(patchFrontmatter(noFm, [
        { type: 'rename_key', from: 'a', to: 'b' },
      ])).toBe(noFm);
    });

    it('handles empty mutations array', () => {
      expect(patchFrontmatter(baseFile, [])).toBe(baseFile);
    });

    it('preserves keys not targeted by mutations', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      expect(result).toContain('title: Test Note');
      expect(result).toContain('types: [meeting]');
      expect(result).toContain('status: active');
      expect(result).toContain('people involved: "[[Alice]]"');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/patch.test.ts`
Expected: Tests involving actual changes FAIL (stub returns unchanged content). Edge cases with no-op mutations may pass.

- [ ] **Step 4: Implement `patchFrontmatter` in `src/serializer/patch.ts`**

```typescript
// src/serializer/patch.ts

export type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function patchFrontmatter(
  fileContent: string,
  mutations: FrontmatterMutation[],
): string {
  if (mutations.length === 0) return fileContent;

  // Match frontmatter block: opening ---, raw YAML, closing ---, body
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?\n)(---\n?)([\s\S]*)$/);
  if (!fmMatch) return fileContent;

  const [, open, rawYaml, close, body] = fmMatch;
  let yaml = rawYaml;

  for (const mutation of mutations) {
    if (mutation.type === 'rename_key') {
      // Skip if target key already exists in the YAML
      const targetRe = new RegExp(`^${escapeRegExp(mutation.to)}:`, 'm');
      if (targetRe.test(yaml)) continue;

      // Replace key name at start of line, preserving the colon and everything after
      const sourceRe = new RegExp(`^${escapeRegExp(mutation.from)}(:)`, 'm');
      yaml = yaml.replace(sourceRe, `${mutation.to}$1`);
    } else if (mutation.type === 'coerce_value') {
      // Only coerce for list target types
      if (!mutation.targetType.startsWith('list')) continue;

      // Find the key's line and wrap non-array value in brackets
      const keyRe = new RegExp(
        `^(${escapeRegExp(mutation.key)}:\\s+)(.+)$`,
        'm',
      );
      yaml = yaml.replace(keyRe, (_, prefix: string, value: string) => {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) return prefix + value; // Already an array
        return `${prefix}[${trimmed}]`;
      });
    }
  }

  return open + yaml + close + body;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/patch.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Add exports to `src/serializer/index.ts`**

Add these lines:

```typescript
export { patchFrontmatter } from './patch.js';
export type { FrontmatterMutation } from './patch.js';
```

- [ ] **Step 7: Commit**

```bash
git add src/serializer/patch.ts tests/serializer/patch.test.ts src/serializer/index.ts
git commit -m "feat: add patchFrontmatter helper for surgical YAML patching

TDD: pure function that applies rename_key and coerce_value mutations
to frontmatter via regex, preserving body and untouched keys byte-for-byte."
```

---

### Task 2: Global write lock

**Files:**
- Modify: `src/sync/watcher.ts`
- Modify: `src/sync/index.ts`
- Create: `tests/sync/global-lock.test.ts`

- [ ] **Step 1: Write tests in `tests/sync/global-lock.test.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import {
  watchVault,
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  isGlobalWriteLocked,
} from '../../src/sync/watcher.js';

describe('global write lock', () => {
  afterEach(() => {
    // Ensure global lock is released between tests
    if (isGlobalWriteLocked()) releaseGlobalWriteLock();
  });

  it('tracks lock state correctly', () => {
    expect(isGlobalWriteLocked()).toBe(false);
    acquireGlobalWriteLock();
    expect(isGlobalWriteLocked()).toBe(true);
    releaseGlobalWriteLock();
    expect(isGlobalWriteLocked()).toBe(false);
  });

  it('watcher skips file events when global lock is held', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-glock-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const watcher = watchVault(db, vaultPath, { debounceMs: 50 });
    await watcher.ready;

    // Acquire global lock
    acquireGlobalWriteLock();

    // Write a new file while locked
    writeFileSync(
      join(vaultPath, 'locked.md'),
      '---\ntitle: Locked\ntypes: [note]\n---\n\nBody\n',
    );

    // Wait longer than debounce
    await new Promise(r => setTimeout(r, 200));

    // File should NOT be indexed because global lock was held
    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('locked.md');
    expect(row).toBeUndefined();

    releaseGlobalWriteLock();
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('watcher processes events after global lock is released', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'vault-glock-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const watcher = watchVault(db, vaultPath, { debounceMs: 50 });
    await watcher.ready;

    // Write a file AFTER ensuring lock is not held
    expect(isGlobalWriteLocked()).toBe(false);
    writeFileSync(
      join(vaultPath, 'normal.md'),
      '---\ntitle: Normal\ntypes: [note]\n---\n\nBody\n',
    );

    // Wait for watcher to process
    await new Promise(r => setTimeout(r, 400));

    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('normal.md');
    expect(row).toBeDefined();

    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/global-lock.test.ts`
Expected: FAIL — `acquireGlobalWriteLock` is not exported

- [ ] **Step 3: Implement global write lock in `src/sync/watcher.ts`**

Add after the existing per-file lock functions (after line 21):

```typescript
let globalLockActive = false;

export function acquireGlobalWriteLock(): void {
  globalLockActive = true;
}

export function releaseGlobalWriteLock(): void {
  globalLockActive = false;
}

export function isGlobalWriteLocked(): boolean {
  return globalLockActive;
}
```

Add global lock check as first line in `handleAddOrChange`:

```typescript
function handleAddOrChange(absPath: string): void {
  if (globalLockActive) return;
  // ... existing code unchanged
}
```

Add global lock check as first line in the `unlink` handler:

```typescript
watcher.on('unlink', (absPath: string) => {
  if (globalLockActive) return;
  // ... existing code unchanged
});
```

- [ ] **Step 4: Add exports to `src/sync/index.ts`**

Replace the watcher export line with:

```typescript
export {
  watchVault,
  acquireWriteLock,
  releaseWriteLock,
  isWriteLocked,
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  isGlobalWriteLocked,
} from './watcher.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sync/global-lock.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/sync/watcher.ts src/sync/index.ts tests/sync/global-lock.test.ts
git commit -m "feat: add global write lock for bulk watcher suppression

Adds acquireGlobalWriteLock/releaseGlobalWriteLock that suppress ALL
watcher events while held. Used by normalize-fields for bulk file writes."
```

---

### Task 3: normalize-fields handler and MCP tool

**Files:**
- Create: `src/mcp/normalize-fields.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/normalize-fields.test.ts`

- [ ] **Step 1: Create `src/mcp/normalize-fields.ts` with types and stub**

```typescript
// src/mcp/normalize-fields.ts
import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllSchemas } from '../schema/loader.js';
import { patchFrontmatter, type FrontmatterMutation } from '../serializer/patch.js';
import { writeNodeFile } from '../serializer/writer.js';
import { incrementalIndex } from '../sync/indexer.js';
import { resolveReferences } from '../sync/resolver.js';
import {
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  releaseWriteLock,
} from '../sync/watcher.js';

export interface NormalizeRule {
  action: 'rename_key' | 'coerce_value';
  from_key: string;
  to_key?: string;
  target_type?: string;
}

export interface RuleReport {
  action: string;
  from_key: string;
  to_key?: string;
  target_type?: string;
  files_affected: number;
  sample_files: string[];
}

export interface NormalizeResult {
  rules_applied: RuleReport[];
  total_files_affected: number;
  mode: 'audit' | 'apply';
}

export function inferRules(
  db: Database.Database,
  schemaType?: string,
): NormalizeRule[] {
  return []; // stub
}

export function normalizeFields(
  db: Database.Database,
  vaultPath: string,
  params: {
    mode: 'audit' | 'apply';
    schema_type?: string;
    rules?: NormalizeRule[];
  },
): NormalizeResult {
  return { rules_applied: [], total_files_affected: 0, mode: params.mode }; // stub
}
```

- [ ] **Step 2: Register tool in `src/mcp/server.ts`**

Add import at top of file (after existing imports):

```typescript
import { normalizeFields } from './normalize-fields.js';
```

Add tool registration before the `return server;` line (before line 1979):

```typescript
  server.tool(
    'normalize-fields',
    'Normalize frontmatter field names and value shapes across the vault to match schema definitions. Run with mode=audit first to review changes, then mode=apply to execute.',
    {
      mode: z.enum(['audit', 'apply']).default('audit')
        .describe('audit: report what would change. apply: execute normalization.'),
      schema_type: z.string().min(1).optional()
        .describe('Limit to nodes of a specific type. Omit to normalize all typed nodes.'),
      rules: z.array(z.object({
        action: z.enum(['rename_key', 'coerce_value']),
        from_key: z.string().min(1),
        to_key: z.string().min(1).optional(),
        target_type: z.string().min(1).optional(),
      })).optional()
        .describe('Explicit normalization rules. Omit to auto-infer from schema definitions.'),
    },
    ({ mode, schema_type, rules }) => {
      try {
        const result = normalizeFields(db, vaultPath, { mode, schema_type, rules });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, 'INTERNAL_ERROR');
      }
    },
  );
```

- [ ] **Step 3: Write tests in `tests/mcp/normalize-fields.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { incrementalIndex } from '../../src/sync/indexer.js';

describe('normalize-fields', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-nf-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Create schema with canonical field names
    mkdirSync(join(vaultPath, '.schemas'));
    writeFileSync(
      join(vaultPath, '.schemas', 'meeting.yaml'),
      [
        'name: meeting',
        'fields:',
        '  company:',
        '    type: string',
        '  people involved:',
        '    type: "list<reference>"',
        '  status:',
        '    type: string',
        '  tags:',
        '    type: "list<string>"',
      ].join('\n') + '\n',
    );
    loadSchemas(db, vaultPath);

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

  function writeVaultFile(relativePath: string, content: string) {
    const dir = relativePath.includes('/')
      ? join(vaultPath, relativePath.split('/').slice(0, -1).join('/'))
      : vaultPath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vaultPath, relativePath), content);
  }

  function indexVault() {
    incrementalIndex(db, vaultPath);
  }

  async function callTool(args: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'normalize-fields',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  // --- Audit mode ---

  describe('audit mode', () => {
    it('detects casing mismatches', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      writeVaultFile(
        'meetings/b.md',
        '---\ntitle: Meeting B\ntypes: [meeting]\ncompany: Initech\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      expect(result.mode).toBe('audit');
      const renameRule = result.rules_applied.find(
        (r: any) => r.action === 'rename_key' && r.from_key === 'Company',
      );
      expect(renameRule).toBeDefined();
      expect(renameRule.to_key).toBe('company');
      expect(renameRule.files_affected).toBe(1);
    });

    it('detects value shape mismatches', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\npeople involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      const coerceRule = result.rules_applied.find(
        (r: any) =>
          r.action === 'coerce_value' && r.from_key === 'people involved',
      );
      expect(coerceRule).toBeDefined();
      expect(coerceRule.target_type).toBe('list<reference>');
      expect(coerceRule.files_affected).toBe(1);
    });

    it('filters by schema_type', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      writeVaultFile(
        'tasks/a.md',
        '---\ntitle: Task A\ntypes: [task]\nCompany: Acme\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({
        mode: 'audit',
        schema_type: 'meeting',
      });

      const renameRule = result.rules_applied.find(
        (r: any) => r.action === 'rename_key',
      );
      expect(renameRule).toBeDefined();
      // Only meeting files should be affected
      for (const f of renameRule.sample_files) {
        expect(f).not.toContain('tasks/');
      }
    });

    it('returns empty report when no mismatches exist', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\ncompany: Acme\npeople involved: ["[[Alice]]"]\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      expect(result.rules_applied).toHaveLength(0);
      expect(result.total_files_affected).toBe(0);
    });
  });

  // --- Apply mode ---

  describe('apply mode', () => {
    it('renames keys in files and re-indexes', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'apply' });

      expect(result.mode).toBe('apply');
      expect(result.total_files_affected).toBeGreaterThan(0);

      // Verify file was patched on disk
      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('company: Acme');
      expect(content).not.toContain('Company:');

      // Verify DB was re-indexed with the new key
      const field = db
        .prepare(
          'SELECT key FROM fields WHERE node_id = ? AND LOWER(key) = ?',
        )
        .get('meetings/a.md', 'company') as { key: string } | undefined;
      expect(field).toBeDefined();
      expect(field!.key).toBe('company');
    });

    it('coerces bare values to arrays', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\npeople involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('people involved: ["[[Alice]]"]');
    });

    it('preserves body content byte-for-byte', async () => {
      const body =
        '\nBody with [[wiki-links]] and special chars.\n\nParagraph two.\n';
      writeVaultFile(
        'meetings/a.md',
        `---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n${body}`,
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain(body);
    });

    it('applies explicit rules', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nMyField: value\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({
        mode: 'apply',
        rules: [
          { action: 'rename_key', from_key: 'MyField', to_key: 'my_field' },
        ],
      });

      expect(result.total_files_affected).toBe(1);
      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('my_field: value');
    });

    it('handles combined rename + coerce on same field', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nPeople Involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('people involved: ["[[Alice]]"]');
      expect(content).not.toContain('People Involved');
    });

    it('skips files where no mutations apply', async () => {
      // File already conforms
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\ncompany: Acme\npeople involved: ["[[Alice]]"]\n---\n\nBody\n',
      );
      // File needs fixing
      writeVaultFile(
        'meetings/b.md',
        '---\ntitle: Meeting B\ntypes: [meeting]\nCompany: Other\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'apply' });

      // Only the non-conforming file should be counted
      expect(result.total_files_affected).toBe(1);
    });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/normalize-fields.test.ts`
Expected: Audit and apply tests FAIL (stubs return empty results). Build should succeed.

- [ ] **Step 5: Implement `inferRules` in `src/mcp/normalize-fields.ts`**

Replace the stub `inferRules` function:

```typescript
export function inferRules(
  db: Database.Database,
  schemaType?: string,
): NormalizeRule[] {
  const schemas = getAllSchemas(db);
  const filteredSchemas = schemaType
    ? schemas.filter(s => s.name === schemaType)
    : schemas;

  const rules: NormalizeRule[] = [];
  const seenRenames = new Set<string>();
  const seenCoercions = new Set<string>();

  for (const schema of filteredSchemas) {
    for (const [canonicalKey, fieldDef] of Object.entries(schema.fields)) {
      // Find variant keys (same key, different casing) in the DB
      const variants = db
        .prepare(
          `SELECT DISTINCT f.key FROM fields f
           JOIN node_types nt ON nt.node_id = f.node_id
           WHERE nt.schema_type = ? AND LOWER(f.key) = LOWER(?) AND f.key != ?`,
        )
        .all(schema.name, canonicalKey, canonicalKey) as Array<{
        key: string;
      }>;

      for (const { key: variantKey } of variants) {
        const rKey = `${variantKey}|${canonicalKey}`;
        if (!seenRenames.has(rKey)) {
          seenRenames.add(rKey);
          rules.push({
            action: 'rename_key',
            from_key: variantKey,
            to_key: canonicalKey,
          });
        }
      }

      // Check for value shape mismatches (only for list types)
      if (fieldDef.type.startsWith('list')) {
        const count = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM fields f
             JOIN node_types nt ON nt.node_id = f.node_id
             WHERE nt.schema_type = ?
               AND LOWER(f.key) = LOWER(?)
               AND f.value_type != 'list'`,
          )
          .get(schema.name, canonicalKey) as { cnt: number };

        if (count.cnt > 0) {
          const cKey = `${canonicalKey}|${fieldDef.type}`;
          if (!seenCoercions.has(cKey)) {
            seenCoercions.add(cKey);
            rules.push({
              action: 'coerce_value',
              from_key: canonicalKey,
              target_type: fieldDef.type,
            });
          }
        }
      }
    }
  }

  return rules;
}
```

- [ ] **Step 6: Implement `findAffectedFiles` helper in `src/mcp/normalize-fields.ts`**

Add this function after `inferRules`:

```typescript
function findAffectedFiles(
  db: Database.Database,
  rules: NormalizeRule[],
  schemaType?: string,
): {
  ruleReports: RuleReport[];
  fileMutations: Map<string, FrontmatterMutation[]>;
} {
  const fileMutations = new Map<string, FrontmatterMutation[]>();
  const ruleReports: RuleReport[] = [];

  // Process renames first, then coercions (order matters for per-file mutations)
  const sortedRules = [
    ...rules.filter(r => r.action === 'rename_key'),
    ...rules.filter(r => r.action === 'coerce_value'),
  ];

  for (const rule of sortedRules) {
    let query: string;
    let params: unknown[];

    if (rule.action === 'rename_key') {
      // Exact match on the variant key
      if (schemaType) {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 JOIN node_types nt ON nt.node_id = f.node_id
                 WHERE f.key = ? AND nt.schema_type = ?`;
        params = [rule.from_key, schemaType];
      } else {
        query = `SELECT DISTINCT f.node_id FROM fields f WHERE f.key = ?`;
        params = [rule.from_key];
      }
    } else {
      // Case-insensitive match (catches both canonical and variant keys)
      if (schemaType) {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 JOIN node_types nt ON nt.node_id = f.node_id
                 WHERE LOWER(f.key) = LOWER(?)
                   AND f.value_type != 'list'
                   AND nt.schema_type = ?`;
        params = [rule.from_key, schemaType];
      } else {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 WHERE LOWER(f.key) = LOWER(?) AND f.value_type != 'list'`;
        params = [rule.from_key];
      }
    }

    const rows = db.prepare(query).all(...params) as Array<{
      node_id: string;
    }>;
    const fileIds = rows.map(r => r.node_id);

    ruleReports.push({
      action: rule.action,
      from_key: rule.from_key,
      to_key: rule.to_key,
      target_type: rule.target_type,
      files_affected: fileIds.length,
      sample_files: fileIds.slice(0, 5),
    });

    // Build per-file mutations (renames added before coercions due to sort order)
    for (const fileId of fileIds) {
      if (!fileMutations.has(fileId)) fileMutations.set(fileId, []);
      const mutations = fileMutations.get(fileId)!;

      if (rule.action === 'rename_key') {
        mutations.push({
          type: 'rename_key',
          from: rule.from_key,
          to: rule.to_key!,
        });
      } else {
        mutations.push({
          type: 'coerce_value',
          key: rule.from_key,
          targetType: rule.target_type!,
        });
      }
    }
  }

  return { ruleReports, fileMutations };
}
```

- [ ] **Step 7: Implement `normalizeFields` in `src/mcp/normalize-fields.ts`**

Replace the stub:

```typescript
export function normalizeFields(
  db: Database.Database,
  vaultPath: string,
  params: {
    mode: 'audit' | 'apply';
    schema_type?: string;
    rules?: NormalizeRule[];
  },
): NormalizeResult {
  const { mode, schema_type, rules: explicitRules } = params;

  // Determine rules: explicit or auto-inferred
  const rules = explicitRules ?? inferRules(db, schema_type);

  if (rules.length === 0) {
    return { rules_applied: [], total_files_affected: 0, mode };
  }

  // Find affected files and build per-file mutations
  const { ruleReports, fileMutations } = findAffectedFiles(
    db,
    rules,
    schema_type,
  );

  if (mode === 'audit' || fileMutations.size === 0) {
    return {
      rules_applied: ruleReports,
      total_files_affected: fileMutations.size,
      mode,
    };
  }

  // --- Apply mode ---
  const deferredLocks = new Set<string>();
  const fileSnapshots = new Map<string, string>(); // path → original content

  function rollbackFiles() {
    for (const [relPath, original] of fileSnapshots) {
      try {
        writeNodeFile(vaultPath, relPath, original);
      } catch {
        /* best effort */
      }
    }
  }

  acquireGlobalWriteLock();
  try {
    for (const [fileId, mutations] of fileMutations) {
      const absPath = join(vaultPath, fileId);
      if (!existsSync(absPath)) continue;

      const raw = readFileSync(absPath, 'utf-8');
      const patched = patchFrontmatter(raw, mutations);

      // Skip files where no mutations actually changed anything
      if (patched === raw) continue;

      // Snapshot for rollback before writing
      fileSnapshots.set(fileId, raw);
      writeNodeFile(vaultPath, fileId, patched, deferredLocks);
    }
  } catch (err) {
    rollbackFiles();
    throw err;
  } finally {
    releaseGlobalWriteLock();
    for (const path of deferredLocks) {
      releaseWriteLock(path);
    }
  }

  // Re-index all changed files and resolve references
  incrementalIndex(db, vaultPath);
  resolveReferences(db);

  return {
    rules_applied: ruleReports,
    total_files_affected: fileSnapshots.size,
    mode,
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/normalize-fields.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Run full test suite**

Run: `npm test`
Expected: ALL PASS (no regressions)

- [ ] **Step 10: Commit**

```bash
git add src/mcp/normalize-fields.ts src/mcp/server.ts tests/mcp/normalize-fields.test.ts
git commit -m "feat: add normalize-fields MCP tool

Audit mode reports casing mismatches and value shape mismatches against
schema definitions. Apply mode patches files surgically via regex,
re-indexes, and supports rollback on failure. Uses global write lock
to suppress watcher events during bulk writes."
```

---

### Task 4: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add `normalize-fields` to the MCP tool list in the `server.ts` section (after `summarize-node`):

```markdown
  - **`normalize-fields`** — Normalizes frontmatter field names and value shapes across the vault to match schema definitions. Two modes: `audit` (report what would change) and `apply` (execute). Optional `schema_type` filter and explicit `rules` param; when rules omitted, auto-infers from schema definitions. Apply mode uses global write lock, file rollback on failure, and re-indexes after patching.
```

Add `patch.ts` to the Serializer section:

```markdown
- **`patch.ts`** — `patchFrontmatter(fileContent, mutations)` — surgical regex-based frontmatter patching. Applies `rename_key` and `coerce_value` mutations to raw YAML without re-serializing the whole file. Body preserved byte-for-byte.
```

Add global write lock note to the Sync Layer watcher description:

```markdown
Global write lock functions (`acquireGlobalWriteLock`/`releaseGlobalWriteLock`/`isGlobalWriteLocked`) suppress ALL watcher events during bulk operations like normalize-fields. Per-file locks remain for single-file write tools.
```

- [ ] **Step 2: Type-check the project**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add normalize-fields tool and global write lock to CLAUDE.md"
```
