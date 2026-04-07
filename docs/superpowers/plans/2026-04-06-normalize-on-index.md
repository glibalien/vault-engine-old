# Normalize-on-Index (Layer 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the indexer processes a file (startup or live watcher), automatically normalize frontmatter field names and values to match schema definitions based on per-type enforcement config.

**Architecture:** A new `normalizeOnIndex()` function in `src/sync/normalize-on-index.ts` sits between `parseFile()` and `indexFile()` at both call sites (watcher and `incrementalIndex`). It reuses the existing `coerceFields()` engine and `patchFrontmatter()` serializer to detect and optionally fix field mismatches. File writes in `incrementalIndex` are queued and flushed only after the DB transaction commits, ensuring atomicity.

**Tech Stack:** TypeScript ESM, vitest, better-sqlite3, `yaml` package (parse/stringify)

**Spec:** `docs/superpowers/specs/2026-04-06-normalize-on-index-design.md`

---

### Task 1: Extend `patchFrontmatter` with `set_value` mutation

**Files:**
- Modify: `src/serializer/patch.ts:3-6` (FrontmatterMutation type)
- Modify: `src/serializer/patch.ts:11-51` (patchFrontmatter function)
- Test: `tests/serializer/patch.test.ts`

- [ ] **Step 1: Write failing tests for `set_value`**

Add these tests to `tests/serializer/patch.test.ts`:

```ts
describe('set_value', () => {
  it('replaces an enum value in frontmatter', () => {
    const file = '---\ntitle: My Task\nstatus: Todo\n---\n\nBody content.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'status', value: 'todo' },
    ]);
    expect(result).toContain('status: todo');
    expect(result).not.toContain('status: Todo');
    expect(result).toContain('title: My Task');
    expect(result).toContain('Body content.');
  });

  it('replaces a boolean string with a real boolean', () => {
    const file = '---\ntitle: Test\ncompleted: "true"\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'completed', value: true },
    ]);
    expect(result).toContain('completed: true');
    expect(result).not.toContain('"true"');
  });

  it('replaces a string number with a real number', () => {
    const file = '---\ntitle: Test\npriority: "3"\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'priority', value: 3 },
    ]);
    expect(result).toContain('priority: 3');
    expect(result).not.toContain('"3"');
  });

  it('wraps a bare string as a wiki-link reference', () => {
    const file = '---\ntitle: Test\nassignee: Alice\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'assignee', value: '[[Alice]]' },
    ]);
    expect(result).toContain('assignee: "[[Alice]]"');
  });

  it('preserves keys not targeted by set_value', () => {
    const file = '---\ntitle: My Task\nstatus: Todo\npriority: high\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'status', value: 'todo' },
    ]);
    expect(result).toContain('title: My Task');
    expect(result).toContain('priority: high');
  });

  it('preserves body content byte-for-byte', () => {
    const file = '---\nstatus: Todo\n---\n\nBody with [[links]] and stuff.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'status', value: 'todo' },
    ]);
    expect(result).toContain('Body with [[links]] and stuff.');
  });

  it('handles set_value for a key that does not exist (no-op)', () => {
    const file = '---\ntitle: Test\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'set_value', key: 'nonexistent', value: 'foo' },
    ]);
    expect(result).toBe(file);
  });

  it('works combined with rename_key and coerce_value', () => {
    const file = '---\nStatus: Todo\nPeople: Alice\n---\n\nBody.\n';
    const result = patchFrontmatter(file, [
      { type: 'rename_key', from: 'Status', to: 'status' },
      { type: 'rename_key', from: 'People', to: 'people' },
      { type: 'coerce_value', key: 'people', targetType: 'list<string>' },
      { type: 'set_value', key: 'status', value: 'todo' },
    ]);
    expect(result).toContain('status: todo');
    expect(result).toContain('people: [Alice]');
    expect(result).not.toContain('Status');
    expect(result).not.toContain('People');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serializer/patch.test.ts`
Expected: FAIL — `set_value` is not a recognized mutation type.

- [ ] **Step 3: Implement `set_value` in `patchFrontmatter`**

In `src/serializer/patch.ts`, update the `FrontmatterMutation` type to include the new variant:

```ts
export type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string }
  | { type: 'set_value'; key: string; value: unknown };
```

Add a `yaml` import at the top of the file:

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
```

Rewrite `patchFrontmatter` to apply `rename_key` and `coerce_value` mutations first (regex, existing logic), then apply all `set_value` mutations in a single parse-mutate-serialize pass:

```ts
export function patchFrontmatter(
  fileContent: string,
  mutations: FrontmatterMutation[],
): string {
  if (mutations.length === 0) return fileContent;

  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?\n)(---\n?)([\s\S]*)$/);
  if (!fmMatch) return fileContent;

  const [, open, rawYaml, close, body] = fmMatch;
  let yaml = rawYaml;

  // Phase 1: Apply rename_key and coerce_value (regex-based, existing logic)
  for (const mutation of mutations) {
    if (mutation.type === 'rename_key') {
      const targetRe = new RegExp(`^${escapeRegExp(mutation.to)}:`, 'm');
      if (targetRe.test(yaml)) continue;
      const sourceRe = new RegExp(`^${escapeRegExp(mutation.from)}(:)`, 'm');
      yaml = yaml.replace(sourceRe, `${mutation.to}$1`);
    } else if (mutation.type === 'coerce_value') {
      if (!mutation.targetType.startsWith('list')) continue;
      const keyRe = new RegExp(
        `^(${escapeRegExp(mutation.key)}:\\s+)(.+)$`,
        'm',
      );
      yaml = yaml.replace(keyRe, (_match, prefix: string, value: string) => {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) return prefix + value;
        return `${prefix}[${trimmed}]`;
      });
    }
  }

  // Phase 2: Apply set_value mutations (parse-mutate-serialize)
  const setValueMutations = mutations.filter(
    (m): m is Extract<FrontmatterMutation, { type: 'set_value' }> =>
      m.type === 'set_value',
  );

  if (setValueMutations.length > 0) {
    const parsed = parseYaml(yaml) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object') {
      let changed = false;
      for (const mutation of setValueMutations) {
        if (mutation.key in parsed) {
          parsed[mutation.key] = mutation.value;
          changed = true;
        }
      }
      if (changed) {
        yaml = stringifyYaml(parsed);
      }
    }
  }

  return open + yaml + close + body;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serializer/patch.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/serializer/patch.ts tests/serializer/patch.test.ts
git commit -m "feat(patch): add set_value mutation type with parse-mutate-serialize"
```

---

### Task 2: Create `normalizeOnIndex` core function

**Files:**
- Create: `src/sync/normalize-on-index.ts`
- Test: `tests/sync/normalize-on-index.test.ts`

This is the core logic — given a parsed file, enforcement config, and global fields, decide whether to normalize and return the result. No file I/O in this function (pure logic + DB reads for schema lookup).

- [ ] **Step 1: Write failing tests for the core function**

Create `tests/sync/normalize-on-index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { parseFile } from '../../src/parser/index.js';
import { normalizeOnIndex } from '../../src/sync/normalize-on-index.js';
import type { EnforcementConfig } from '../../src/enforcement/types.js';
import type { GlobalFieldDefinition } from '../../src/coercion/types.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function makeConfig(
  normalizePolicy: 'off' | 'warn' | 'fix',
  perType?: Record<string, 'off' | 'warn' | 'fix'>,
): EnforcementConfig {
  return {
    write_path: { coercion: 'always' },
    normalize_on_index: { default: normalizePolicy, per_type: perType },
    unknown_fields: { default: 'warn' },
    enum_validation: { default: 'coerce' },
  };
}

describe('normalizeOnIndex', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('auto-corrects field key casing and enum value in fix mode', () => {
    const raw = '---\ntitle: Review Task\ntypes: [task]\nStatus: Todo\n---\n\nBody text.\n';
    const parsed = parseFile('tasks/review.md', raw);
    const config = makeConfig('fix');

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/review.md', 'tasks/review.md', config, {}, db);

    expect(result.patched).toBe(true);
    expect(result.raw).toContain('status: todo');
    expect(result.raw).not.toContain('Status: Todo');
    expect(result.raw).toContain('Body text.');
    // Re-parsed fields should reflect corrections
    const statusField = result.parsed.fields.find(f => f.key === 'status');
    expect(statusField).toBeDefined();
    expect(statusField!.value).toBe('todo');
  });

  it('returns warnings but does not modify file in warn mode', () => {
    const raw = '---\ntitle: Review Task\ntypes: [task]\nStatus: Todo\n---\n\nBody text.\n';
    const parsed = parseFile('tasks/review.md', raw);
    const config = makeConfig('warn');

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/review.md', 'tasks/review.md', config, {}, db);

    expect(result.patched).toBe(false);
    expect(result.raw).toBe(raw);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('Status'))).toBe(true);
  });

  it('skips entirely in off mode', () => {
    const raw = '---\ntitle: Review Task\ntypes: [task]\nStatus: Todo\n---\n\nBody text.\n';
    const parsed = parseFile('tasks/review.md', raw);
    const config = makeConfig('off');

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/review.md', 'tasks/review.md', config, {}, db);

    expect(result.patched).toBe(false);
    expect(result.raw).toBe(raw);
    expect(result.warnings).toHaveLength(0);
  });

  it('is a no-op for files with no types', () => {
    const raw = '# Just a note\nNo frontmatter types.\n';
    const parsed = parseFile('notes/plain.md', raw);
    const config = makeConfig('fix');

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/notes/plain.md', 'notes/plain.md', config, {}, db);

    expect(result.patched).toBe(false);
    expect(result.raw).toBe(raw);
    expect(result.warnings).toHaveLength(0);
  });

  it('is a no-op when file already matches schema', () => {
    const raw = '---\ntitle: Clean Task\ntypes: [task]\nstatus: todo\npriority: high\n---\n\nBody.\n';
    const parsed = parseFile('tasks/clean.md', raw);
    const config = makeConfig('fix');

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/clean.md', 'tasks/clean.md', config, {}, db);

    expect(result.patched).toBe(false);
    expect(result.raw).toBe(raw);
  });

  it('uses strictest policy for multi-type nodes', () => {
    // task: fix, note: warn (via per_type overrides) → should fix
    const raw = '---\ntitle: Multi Type\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n';
    const parsed = parseFile('tasks/multi.md', raw);
    const config = makeConfig('warn', { task: 'fix' });

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/multi.md', 'tasks/multi.md', config, {}, db);

    expect(result.patched).toBe(true);
    expect(result.raw).toContain('status: todo');
  });

  it('uses global field definitions for coercion fallback', () => {
    const raw = '---\ntitle: With Global\ntypes: [task]\nstatus: todo\nCategory: engineering\n---\n\nBody.\n';
    const parsed = parseFile('tasks/global.md', raw);
    const config = makeConfig('fix');
    const globalFields: Record<string, GlobalFieldDefinition> = {
      category: { type: 'enum', values: ['engineering', 'design', 'marketing'] },
    };

    const result = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/global.md', 'tasks/global.md', config, globalFields, db);

    expect(result.patched).toBe(true);
    // Category → category (alias resolution via global fields)
    expect(result.raw).toContain('category:');
    expect(result.raw).not.toContain('Category:');
  });

  it('convergence: second pass produces zero changes', () => {
    const raw = '---\ntitle: Review Task\ntypes: [task]\nStatus: Todo\npriority: High\n---\n\nBody.\n';
    const parsed = parseFile('tasks/review.md', raw);
    const config = makeConfig('fix');

    const first = normalizeOnIndex(raw, parsed, '/tmp/vault/tasks/review.md', 'tasks/review.md', config, {}, db);
    expect(first.patched).toBe(true);

    const second = normalizeOnIndex(first.raw, first.parsed, '/tmp/vault/tasks/review.md', 'tasks/review.md', config, {}, db);
    expect(second.patched).toBe(false);
    expect(second.warnings).toHaveLength(0);
    expect(second.raw).toBe(first.raw);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: FAIL — `normalizeOnIndex` doesn't exist yet.

- [ ] **Step 3: Implement `normalizeOnIndex`**

Create `src/sync/normalize-on-index.ts`:

```ts
import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/types.js';
import type { EnforcementConfig } from '../enforcement/types.js';
import type { GlobalFieldDefinition } from '../coercion/types.js';
import { resolveEnforcementPolicies } from '../enforcement/loader.js';
import { mergeSchemaFields } from '../schema/merger.js';
import { coerceFields } from '../coercion/coerce.js';
import { patchFrontmatter } from '../serializer/patch.js';
import type { FrontmatterMutation } from '../serializer/patch.js';
import { parseFile } from '../parser/index.js';
import type { CoercionChange } from '../coercion/types.js';

export interface NormalizeOnIndexResult {
  raw: string;
  parsed: ParsedFile;
  patched: boolean;
  warnings: string[];
}

function changeToWarning(change: CoercionChange): string {
  return `Field '${change.field}': ${change.rule} — '${String(change.from)}' → '${String(change.to)}'`;
}

function changesToMutations(changes: CoercionChange[]): FrontmatterMutation[] {
  const mutations: FrontmatterMutation[] = [];

  for (const change of changes) {
    switch (change.rule) {
      case 'alias_map':
        mutations.push({
          type: 'rename_key',
          from: String(change.from),
          to: String(change.to),
        });
        break;
      case 'scalar_to_list':
        // change.to is the coerced array; infer target type from content
        mutations.push({
          type: 'coerce_value',
          key: change.field,
          targetType: 'list<string>', // patchFrontmatter only checks startsWith('list')
        });
        break;
      case 'enum_case':
      case 'boolean_coerce':
      case 'number_coerce':
      case 'reference_wrap':
        mutations.push({
          type: 'set_value',
          key: change.field,
          value: change.to,
        });
        break;
      // date_normalize: not currently emitted by coerceFields, skip
    }
  }

  return mutations;
}

export function normalizeOnIndex(
  raw: string,
  parsed: ParsedFile,
  _absPath: string,
  relativePath: string,
  enforcementConfig: EnforcementConfig,
  globalFields: Record<string, GlobalFieldDefinition>,
  db: Database.Database,
): NormalizeOnIndexResult {
  const unchanged = { raw, parsed, patched: false, warnings: [] as string[] };

  // No types → nothing to enforce
  if (parsed.types.length === 0) return unchanged;

  // Resolve policy for this node's types
  const policies = resolveEnforcementPolicies(enforcementConfig, parsed.types);
  if (policies.normalizeOnIndex === 'off') return unchanged;

  // Check if any of the node's types have a known schema
  const hasKnownSchema = parsed.types.some(t => {
    const schema = db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(t);
    return schema !== undefined;
  });
  if (!hasKnownSchema) return unchanged;

  // Merge schema fields for coercion
  const mergeResult = mergeSchemaFields(db, parsed.types);

  // Build fields record from parsed fields
  const fields: Record<string, unknown> = {};
  for (const field of parsed.fields) {
    fields[field.key] = field.value;
  }

  // Run coercion
  const coercion = coerceFields(fields, mergeResult, globalFields, {
    unknownFields: policies.unknownFields,
    enumValidation: policies.enumValidation,
  });

  // No changes needed
  if (coercion.changes.length === 0) return unchanged;

  // Warn mode: report but don't modify
  if (policies.normalizeOnIndex === 'warn') {
    return {
      raw,
      parsed,
      patched: false,
      warnings: coercion.changes.map(changeToWarning),
    };
  }

  // Fix mode: convert changes to mutations and patch the file
  const mutations = changesToMutations(coercion.changes);
  if (mutations.length === 0) return unchanged;

  const patchedRaw = patchFrontmatter(raw, mutations);
  if (patchedRaw === raw) return unchanged;

  // Re-parse the patched content
  const reParsed = parseFile(relativePath, patchedRaw);

  return {
    raw: patchedRaw,
    parsed: reParsed,
    patched: true,
    warnings: [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sync/normalize-on-index.ts tests/sync/normalize-on-index.test.ts
git commit -m "feat: add normalizeOnIndex core function"
```

---

### Task 3: Integrate into `incrementalIndex`

**Files:**
- Modify: `src/sync/indexer.ts:148-215` (incrementalIndex function)
- Modify: `src/sync/index.ts` (re-export)
- Test: `tests/sync/normalize-on-index.test.ts` (add integration tests)

- [ ] **Step 1: Write failing integration tests**

Add to `tests/sync/normalize-on-index.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexFile, incrementalIndex } from '../../src/sync/indexer.js';

// ... (existing imports and helpers from above)

describe('incrementalIndex with normalize-on-index', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-noi-'));
    // Write task schema
    mkdirSync(join(tmpVault, '.schemas'), { recursive: true });
    writeFileSync(
      join(tmpVault, '.schemas', 'task.yaml'),
      [
        'name: task',
        'fields:',
        '  status:',
        '    type: enum',
        '    values: [todo, in-progress, done]',
        '  priority:',
        '    type: enum',
        '    values: [high, medium, low]',
        '  assignee:',
        '    type: reference',
      ].join('\n'),
    );
    loadSchemas(db, tmpVault);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  function writeVaultFile(relPath: string, content: string) {
    const abs = join(tmpVault, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('fixes files on startup and reports normalized count', () => {
    writeVaultFile('tasks/review.md', '---\ntitle: Review\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');
    const config = makeConfig('fix');

    const result = incrementalIndex(db, tmpVault, { enforcementConfig: config, globalFields: {} });

    expect(result.indexed).toBe(1);
    expect(result.normalized).toBe(1);

    // File on disk should be corrected
    const onDisk = readFileSync(join(tmpVault, 'tasks/review.md'), 'utf-8');
    expect(onDisk).toContain('status: todo');
    expect(onDisk).not.toContain('Status: Todo');

    // DB should reflect corrected values
    const field = db.prepare("SELECT value_text FROM fields WHERE node_id = 'tasks/review.md' AND key = 'status'").get() as any;
    expect(field.value_text).toBe('todo');
  });

  it('server-down scenario: external edit → server up → file gets fixed once', () => {
    // Initial clean state
    writeVaultFile('tasks/review.md', '---\ntitle: Review\ntypes: [task]\nstatus: todo\n---\n\nBody.\n');
    const config = makeConfig('fix');
    const r1 = incrementalIndex(db, tmpVault, { enforcementConfig: config, globalFields: {} });
    expect(r1.normalized).toBe(0);

    // Simulate external edit (Obsidian) while server was down
    writeVaultFile('tasks/review.md', '---\ntitle: Review\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');

    // Server restarts
    const r2 = incrementalIndex(db, tmpVault, { enforcementConfig: config, globalFields: {} });
    expect(r2.normalized).toBe(1);
    expect(r2.indexed).toBe(1);

    // File is corrected
    const onDisk = readFileSync(join(tmpVault, 'tasks/review.md'), 'utf-8');
    expect(onDisk).toContain('status: todo');

    // Third run: nothing to do
    const r3 = incrementalIndex(db, tmpVault, { enforcementConfig: config, globalFields: {} });
    expect(r3.normalized).toBe(0);
  });

  it('does not write files when skipNormalize is true', () => {
    writeVaultFile('tasks/review.md', '---\ntitle: Review\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');
    const config = makeConfig('fix');

    const result = incrementalIndex(db, tmpVault, {
      enforcementConfig: config,
      globalFields: {},
      skipNormalize: true,
    });

    expect(result.normalized).toBe(0);
    // File should remain unchanged
    const onDisk = readFileSync(join(tmpVault, 'tasks/review.md'), 'utf-8');
    expect(onDisk).toContain('Status: Todo');
  });

  it('does not normalize when no config is provided (backward compat)', () => {
    writeVaultFile('tasks/review.md', '---\ntitle: Review\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');

    const result = incrementalIndex(db, tmpVault);

    expect(result.normalized).toBe(0);
    const onDisk = readFileSync(join(tmpVault, 'tasks/review.md'), 'utf-8');
    expect(onDisk).toContain('Status: Todo');
  });

  it('queues file writes and only flushes after transaction commits', () => {
    // Write two files, both need fixing
    writeVaultFile('tasks/a.md', '---\ntitle: A\ntypes: [task]\nStatus: Todo\n---\n\nBody A.\n');
    writeVaultFile('tasks/b.md', '---\ntitle: B\ntypes: [task]\nStatus: Done\n---\n\nBody B.\n');
    const config = makeConfig('fix');

    const result = incrementalIndex(db, tmpVault, { enforcementConfig: config, globalFields: {} });

    expect(result.normalized).toBe(2);

    // Both files on disk should be corrected
    expect(readFileSync(join(tmpVault, 'tasks/a.md'), 'utf-8')).toContain('status: todo');
    expect(readFileSync(join(tmpVault, 'tasks/b.md'), 'utf-8')).toContain('status: done');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: FAIL — `incrementalIndex` doesn't accept options yet, and doesn't return `normalized`.

- [ ] **Step 3: Modify `incrementalIndex` to accept options and integrate normalize-on-index**

In `src/sync/indexer.ts`, add imports and the options interface, then modify `incrementalIndex`:

Add imports at the top:

```ts
import { writeFileSync } from 'node:fs';  // add writeFileSync to existing import
import type { EnforcementConfig } from '../enforcement/types.js';
import type { GlobalFieldDefinition } from '../coercion/types.js';
import { normalizeOnIndex } from './normalize-on-index.js';
```

Add the options interface:

```ts
export interface IncrementalIndexOptions {
  enforcementConfig?: EnforcementConfig;
  globalFields?: Record<string, GlobalFieldDefinition>;
  skipNormalize?: boolean;
}
```

Modify the `incrementalIndex` signature and implementation:

```ts
export function incrementalIndex(
  db: Database.Database,
  vaultPath: string,
  options?: IncrementalIndexOptions,
): { indexed: number; skipped: number; deleted: number; normalized: number } {
  const mdFiles = globMd(vaultPath);
  const pendingWrites: Array<{ absPath: string; content: string }> = [];

  const run = db.transaction(() => {
    const existingFiles = new Map<string, { mtime: string; hash: string }>();
    const rows = db.prepare('SELECT path, mtime, hash FROM files').all() as Array<{ path: string; mtime: string; hash: string }>;
    for (const row of rows) {
      existingFiles.set(row.path, { mtime: row.mtime, hash: row.hash });
    }

    let indexed = 0;
    let skipped = 0;
    let normalized = 0;

    for (const absPath of mdFiles) {
      const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
      const mtime = statSync(absPath).mtime.toISOString();
      const existing = existingFiles.get(rel);

      existingFiles.delete(rel);

      if (existing && existing.mtime === mtime) {
        skipped++;
        continue;
      }

      let raw = readFileSync(absPath, 'utf-8');

      if (existing) {
        const hash = createHash('sha256').update(raw).digest('hex');
        if (hash === existing.hash) {
          db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, rel);
          skipped++;
          continue;
        }
      }

      try {
        let parsed = parseFile(rel, raw);

        // Normalize-on-index: if config provided and not skipped
        if (options?.enforcementConfig && !options?.skipNormalize) {
          const noiResult = normalizeOnIndex(
            raw, parsed, absPath, rel,
            options.enforcementConfig,
            options.globalFields ?? {},
            db,
          );
          if (noiResult.patched) {
            pendingWrites.push({ absPath, content: noiResult.raw });
            normalized++;
          }
          if (noiResult.warnings.length > 0) {
            for (const w of noiResult.warnings) {
              process.stderr.write(`[vault-engine] normalize-on-index warn: ${rel}: ${w}\n`);
            }
          }
          raw = noiResult.raw;
          parsed = noiResult.parsed;
        }

        indexFile(db, parsed, rel, mtime, raw);
        indexed++;
      } catch {
        // Skip files that fail to parse
      }
    }

    let deleted = 0;
    for (const [path] of existingFiles) {
      deleteFile(db, path);
      deleted++;
    }

    resolveReferences(db);

    return { indexed, skipped, deleted, normalized };
  });

  const result = run();

  // Flush pending file writes AFTER transaction commits
  for (const { absPath, content } of pendingWrites) {
    writeFileSync(absPath, content, 'utf-8');
  }

  return result;
}
```

Note: `writeFileSync` is already imported from `node:fs` — just add it to the existing destructured import on line 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS. Existing `incrementalIndex` callers pass no options, so `normalized` is always 0 for them — backward compatible.

- [ ] **Step 6: Commit**

```bash
git add src/sync/indexer.ts tests/sync/normalize-on-index.test.ts
git commit -m "feat: integrate normalize-on-index into incrementalIndex with queued writes"
```

---

### Task 4: Integrate into watcher

**Files:**
- Modify: `src/sync/watcher.ts:43-47` (WatcherOptions interface)
- Modify: `src/sync/watcher.ts:85-109` (handleAddOrChange function)
- Test: `tests/sync/normalize-on-index.test.ts` (add watcher integration test)

- [ ] **Step 1: Write failing watcher integration test**

Add to `tests/sync/normalize-on-index.test.ts`:

```ts
import {
  watchVault,
  acquireWriteLock,
  releaseWriteLock,
  isWriteLocked,
} from '../../src/sync/watcher.js';

// Helper: poll a condition until it's true or timeout
function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('watcher with normalize-on-index', () => {
  let db: Database.Database;
  let tmpVault: string;
  let handle: { close(): Promise<void>; ready: Promise<void> } | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-noi-watch-'));
    mkdirSync(join(tmpVault, '.schemas'), { recursive: true });
    writeFileSync(
      join(tmpVault, '.schemas', 'task.yaml'),
      [
        'name: task',
        'fields:',
        '  status:',
        '    type: enum',
        '    values: [todo, in-progress, done]',
        '  priority:',
        '    type: enum',
        '    values: [high, medium, low]',
      ].join('\n'),
    );
    loadSchemas(db, tmpVault);
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('normalizes a file on live change and indexes it once', async () => {
    const config = makeConfig('fix');
    handle = watchVault(db, tmpVault, {
      enforcementConfig: config,
      globalFields: {},
      debounceMs: 100,
    });
    await handle.ready;

    // Write a file with wrong casing
    const filePath = join(tmpVault, 'tasks', 'live.md');
    mkdirSync(join(tmpVault, 'tasks'), { recursive: true });
    writeFileSync(filePath, '---\ntitle: Live Task\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');

    // Wait for watcher to index the file
    await waitFor(() =>
      db.prepare("SELECT * FROM nodes WHERE id = 'tasks/live.md'").get() !== undefined,
    );

    // File on disk should be corrected
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).toContain('status: todo');
    expect(onDisk).not.toContain('Status: Todo');

    // DB should have corrected values
    const field = db.prepare("SELECT value_text FROM fields WHERE node_id = 'tasks/live.md' AND key = 'status'").get() as any;
    expect(field.value_text).toBe('todo');
  });

  it('does not normalize when skipNormalize is true', async () => {
    const config = makeConfig('fix');
    handle = watchVault(db, tmpVault, {
      enforcementConfig: config,
      globalFields: {},
      skipNormalize: true,
      debounceMs: 100,
    });
    await handle.ready;

    const filePath = join(tmpVault, 'tasks', 'skip.md');
    mkdirSync(join(tmpVault, 'tasks'), { recursive: true });
    writeFileSync(filePath, '---\ntitle: Skip Task\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n');

    await waitFor(() =>
      db.prepare("SELECT * FROM nodes WHERE id = 'tasks/skip.md'").get() !== undefined,
    );

    // File should NOT be corrected
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).toContain('Status: Todo');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: FAIL — `watchVault` doesn't accept `enforcementConfig` yet.

- [ ] **Step 3: Modify `watchVault` to integrate normalize-on-index**

In `src/sync/watcher.ts`, add imports:

```ts
import { writeFileSync } from 'node:fs';  // add to existing import
import type { EnforcementConfig } from '../enforcement/types.js';
import type { GlobalFieldDefinition } from '../coercion/types.js';
import { normalizeOnIndex } from './normalize-on-index.js';
```

Extend `WatcherOptions`:

```ts
export interface WatcherOptions {
  debounceMs?: number;
  ignorePaths?: string[];
  onSchemaChange?: () => void;
  enforcementConfig?: EnforcementConfig;
  globalFields?: Record<string, GlobalFieldDefinition>;
  skipNormalize?: boolean;
}
```

Modify `handleAddOrChange` inside `watchVault` to normalize after parsing:

```ts
function handleAddOrChange(absPath: string): void {
  if (globalLockActive) return;
  const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
  if (isWriteLocked(rel)) return;

  debounced(rel, () => {
    try {
      let raw = readFileSync(absPath, 'utf-8');
      const hash = createHash('sha256').update(raw).digest('hex');
      const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(rel) as
        | { hash: string }
        | undefined;
      if (existing && existing.hash === hash) return;

      let parsed = parseFile(rel, raw);

      // Normalize-on-index
      if (opts?.enforcementConfig && !opts?.skipNormalize) {
        const noiResult = normalizeOnIndex(
          raw, parsed, absPath, rel,
          opts.enforcementConfig,
          opts.globalFields ?? {},
          db,
        );
        if (noiResult.patched) {
          acquireWriteLock(rel);
          try {
            writeFileSync(absPath, noiResult.raw, 'utf-8');
          } finally {
            releaseWriteLock(rel);
          }
          process.stderr.write(`[vault-engine] watcher: normalized + indexed ${rel} (${noiResult.warnings.length || 'fix'} corrections)\n`);
        }
        if (noiResult.warnings.length > 0) {
          for (const w of noiResult.warnings) {
            process.stderr.write(`[vault-engine] normalize-on-index warn: ${rel}: ${w}\n`);
          }
        }
        raw = noiResult.raw;
        parsed = noiResult.parsed;
      }

      const mtime = statSync(absPath).mtime.toISOString();
      db.transaction(() => {
        indexFile(db, parsed, rel, mtime, raw);
        resolveReferences(db);
      })();
      process.stderr.write(`[vault-engine] watcher: indexed ${rel}\n`);
    } catch (err) {
      console.error(`[vault-engine] failed to index ${rel}:`, err);
    }
  });
}
```

Note: The `statSync` call is moved after the potential normalize write so the mtime reflects the corrected file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sync/watcher.ts tests/sync/normalize-on-index.test.ts
git commit -m "feat: integrate normalize-on-index into file watcher"
```

---

### Task 5: Wire up in entry point with logging and kill switch

**Files:**
- Modify: `src/index.ts:9-10` (add imports)
- Modify: `src/index.ts:64-71` (pass config to incrementalIndex and watchVault, add logging)

- [ ] **Step 1: Modify `src/index.ts`**

Add imports near the top (after existing imports):

```ts
import { loadEnforcementConfig } from './enforcement/index.js';
import { loadGlobalFields } from './coercion/globals.js';
```

After `loadSchemas(db, vaultPath)` (line 23), add:

```ts
// Load enforcement and global field config for normalize-on-index
const enforcementConfig = loadEnforcementConfig(vaultPath);
const globalFields = loadGlobalFields(vaultPath);
const skipNormalize = process.env.VAULT_ENGINE_SKIP_NORMALIZE === '1';

if (skipNormalize) {
  console.error('[vault-engine] normalize-on-index: disabled via VAULT_ENGINE_SKIP_NORMALIZE');
}
```

Modify the `incrementalIndex` call:

```ts
const indexResult = incrementalIndex(db, vaultPath, {
  enforcementConfig,
  globalFields,
  skipNormalize,
});
console.error(`[vault-engine] indexed ${indexResult.indexed}, skipped ${indexResult.skipped}, deleted ${indexResult.deleted}, normalized ${indexResult.normalized}`);
if (indexResult.normalized > 0) {
  console.error(`[vault-engine] normalize-on-index: fixed ${indexResult.normalized} file(s)`);
}
```

Modify the `watchVault` call:

```ts
const watcher = watchVault(db, vaultPath, {
  enforcementConfig,
  globalFields,
  skipNormalize,
  onSchemaChange: () => loadSchemas(db, vaultPath),
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire normalize-on-index into startup with logging and kill switch"
```

---

### Task 6: Export from barrel and update re-exports

**Files:**
- Modify: `src/sync/index.ts` (re-export normalizeOnIndex and types)

- [ ] **Step 1: Update `src/sync/index.ts`**

Add the re-export:

```ts
export { normalizeOnIndex } from './normalize-on-index.js';
export type { NormalizeOnIndexResult } from './normalize-on-index.js';
export type { IncrementalIndexOptions } from './indexer.js';
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/sync/index.ts
git commit -m "chore: re-export normalize-on-index from sync barrel"
```

---

### Task 7: Watcher loop prevention smoke test

**Files:**
- Test: `tests/sync/normalize-on-index.test.ts` (add loop prevention test)

- [ ] **Step 1: Write the loop prevention smoke test**

Add to the watcher describe block in `tests/sync/normalize-on-index.test.ts`:

```ts
it('does not re-trigger watcher after normalize-on-index write', async () => {
  const config = makeConfig('fix');
  let indexCount = 0;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stderrSpy = (chunk: any) => {
    if (typeof chunk === 'string' && chunk.includes('watcher: indexed tasks/loop.md')) {
      indexCount++;
    }
    return originalStderrWrite(chunk);
  };
  process.stderr.write = stderrSpy as any;

  try {
    handle = watchVault(db, tmpVault, {
      enforcementConfig: config,
      globalFields: {},
      debounceMs: 100,
    });
    await handle.ready;

    mkdirSync(join(tmpVault, 'tasks'), { recursive: true });
    writeFileSync(
      join(tmpVault, 'tasks', 'loop.md'),
      '---\ntitle: Loop Test\ntypes: [task]\nStatus: Todo\n---\n\nBody.\n',
    );

    // Wait for the file to be indexed
    await waitFor(() =>
      db.prepare("SELECT * FROM nodes WHERE id = 'tasks/loop.md'").get() !== undefined,
    );

    // Wait a bit more to ensure no second trigger
    await new Promise(resolve => setTimeout(resolve, 800));

    expect(indexCount).toBe(1);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/sync/normalize-on-index.test.ts`
Expected: PASS — file is indexed exactly once.

- [ ] **Step 3: Commit**

```bash
git add tests/sync/normalize-on-index.test.ts
git commit -m "test: add watcher loop prevention smoke test for normalize-on-index"
```
