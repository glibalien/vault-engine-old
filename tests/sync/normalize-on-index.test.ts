import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { parseFile } from '../../src/parser/index.js';
import { normalizeOnIndex } from '../../src/sync/normalize-on-index.js';
import { incrementalIndex } from '../../src/sync/indexer.js';
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

  it('fix mode auto-corrects enum case and alias', () => {
    const raw = [
      '---',
      'title: My Task',
      'types: [task]',
      'Status: Todo',
      '---',
      'Some body text.',
    ].join('\n');
    const parsed = parseFile('tasks/my-task.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/my-task.md',
      'tasks/my-task.md',
      makeConfig('fix'),
      {},
      db,
    );

    expect(result.patched).toBe(true);
    expect(result.warnings).toEqual([]);
    // Re-parsed fields should have the corrected values
    const statusField = result.parsed.fields.find(f => f.key === 'status');
    expect(statusField).toBeDefined();
    expect(statusField!.value).toBe('todo');
    // Raw should contain the patched frontmatter
    expect(result.raw).toContain('status:');
    expect(result.raw).not.toContain('Status:');
  });

  it('warn mode returns warnings without patching', () => {
    const raw = [
      '---',
      'title: My Task',
      'types: [task]',
      'Status: Todo',
      '---',
      'Some body text.',
    ].join('\n');
    const parsed = parseFile('tasks/my-task.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/my-task.md',
      'tasks/my-task.md',
      makeConfig('warn'),
      {},
      db,
    );

    expect(result.patched).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('alias_map'))).toBe(true);
    // Raw should be unchanged
    expect(result.raw).toBe(raw);
  });

  it('off mode skips normalization', () => {
    const raw = [
      '---',
      'title: My Task',
      'types: [task]',
      'Status: Todo',
      '---',
      'Some body text.',
    ].join('\n');
    const parsed = parseFile('tasks/my-task.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/my-task.md',
      'tasks/my-task.md',
      makeConfig('off'),
      {},
      db,
    );

    expect(result.patched).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.raw).toBe(raw);
  });

  it('no types = no-op', () => {
    const raw = [
      '---',
      'title: Just a note',
      '---',
      'No types here.',
    ].join('\n');
    const parsed = parseFile('notes/plain.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/notes/plain.md',
      'notes/plain.md',
      makeConfig('fix'),
      {},
      db,
    );

    expect(result.patched).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.raw).toBe(raw);
  });

  it('already clean = no-op', () => {
    const raw = [
      '---',
      'title: Clean Task',
      'types: [task]',
      'status: todo',
      'priority: medium',
      '---',
      'Already correct.',
    ].join('\n');
    const parsed = parseFile('tasks/clean-task.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/clean-task.md',
      'tasks/clean-task.md',
      makeConfig('fix'),
      {},
      db,
    );

    expect(result.patched).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.raw).toBe(raw);
  });

  it('multi-type strictest-wins', () => {
    const raw = [
      '---',
      'title: Multi-Type Node',
      'types: [task, meeting]',
      'Status: Todo',
      '---',
      'Content.',
    ].join('\n');
    const parsed = parseFile('tasks/multi.md', raw);

    // default: warn, but task overrides to fix → strictest wins (fix)
    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/multi.md',
      'tasks/multi.md',
      makeConfig('warn', { task: 'fix' }),
      {},
      db,
    );

    expect(result.patched).toBe(true);
    const statusField = result.parsed.fields.find(f => f.key === 'status');
    expect(statusField).toBeDefined();
    expect(statusField!.value).toBe('todo');
  });

  it('global field fallback renames alias', () => {
    const globalFields: Record<string, GlobalFieldDefinition> = {
      category: {
        type: 'enum',
        values: ['engineering', 'design', 'marketing'],
      },
    };

    const raw = [
      '---',
      'title: Task With Global',
      'types: [task]',
      'status: todo',
      'Category: engineering',
      '---',
      'Content.',
    ].join('\n');
    const parsed = parseFile('tasks/global-field.md', raw);

    const result = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/global-field.md',
      'tasks/global-field.md',
      makeConfig('fix'),
      globalFields,
      db,
    );

    expect(result.patched).toBe(true);
    // The key should have been renamed from "Category" to "category"
    const categoryField = result.parsed.fields.find(f => f.key === 'category');
    expect(categoryField).toBeDefined();
    expect(categoryField!.value).toBe('engineering');
    expect(result.raw).toContain('category:');
    expect(result.raw).not.toContain('Category:');
  });

  it('convergence: second pass is a no-op', () => {
    const raw = [
      '---',
      'title: Converge Task',
      'types: [task]',
      'Status: Todo',
      'Priority: HIGH',
      '---',
      'Content.',
    ].join('\n');
    const parsed = parseFile('tasks/converge.md', raw);
    const config = makeConfig('fix');

    // First pass: should patch
    const first = normalizeOnIndex(
      raw,
      parsed,
      '/vault/tasks/converge.md',
      'tasks/converge.md',
      config,
      {},
      db,
    );
    expect(first.patched).toBe(true);
    expect(first.warnings).toEqual([]);

    // Second pass on the patched result: should be a no-op
    const second = normalizeOnIndex(
      first.raw,
      first.parsed,
      '/vault/tasks/converge.md',
      'tasks/converge.md',
      config,
      {},
      db,
    );
    expect(second.patched).toBe(false);
    expect(second.warnings).toEqual([]);
  });
});

const TASK_SCHEMA_YAML = `
name: task
display_name: Task
icon: check
fields:
  status:
    type: enum
    values: [todo, in-progress, done]
    default: todo
    required: true
  priority:
    type: enum
    values: [high, medium, low]
    default: medium
  assignee:
    type: reference
    target_schema: person
serialization:
  filename_template: "tasks/{{title}}.md"
  frontmatter_fields: [status, priority, assignee]
`;

describe('incrementalIndex with normalize-on-index', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-noi-'));
    mkdirSync(join(tmpVault, '.schemas'), { recursive: true });
    writeFileSync(join(tmpVault, '.schemas', 'task.yaml'), TASK_SCHEMA_YAML, 'utf-8');
    mkdirSync(join(tmpVault, 'tasks'), { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, tmpVault);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('fixes files on startup and reports normalized count', () => {
    writeFileSync(
      join(tmpVault, 'tasks', 'review.md'),
      '---\ntitle: Review\ntypes: [task]\nStatus: Todo\n---\nBody text.\n',
      'utf-8',
    );

    const result = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
    });

    expect(result.normalized).toBe(1);
    expect(result.indexed).toBe(1);

    // File on disk should be fixed
    const diskContent = readFileSync(join(tmpVault, 'tasks', 'review.md'), 'utf-8');
    expect(diskContent).toContain('status:');
    expect(diskContent).not.toContain('Status:');
    expect(diskContent).toContain('todo');

    // DB should have the corrected value
    const row = db.prepare(
      "SELECT value_text FROM fields WHERE node_id = 'tasks/review.md' AND key = 'status'",
    ).get() as { value_text: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value_text).toBe('todo');
  });

  it('server-down scenario: detects and fixes edits made while offline', () => {
    // 1. Write a clean file and index it
    writeFileSync(
      join(tmpVault, 'tasks', 'offline.md'),
      '---\ntitle: Offline\ntypes: [task]\nstatus: todo\n---\nBody.\n',
      'utf-8',
    );
    const r1 = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
    });
    expect(r1.normalized).toBe(0);
    expect(r1.indexed).toBe(1);

    // 2. Simulate Obsidian edit while server was down
    writeFileSync(
      join(tmpVault, 'tasks', 'offline.md'),
      '---\ntitle: Offline\ntypes: [task]\nStatus: Todo\n---\nBody.\n',
      'utf-8',
    );
    const r2 = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
    });
    expect(r2.normalized).toBe(1);
    expect(r2.indexed).toBe(1);

    // 3. Third run — nothing to fix
    const r3 = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
    });
    expect(r3.normalized).toBe(0);
  });

  it('kill switch (skipNormalize: true) prevents normalization', () => {
    writeFileSync(
      join(tmpVault, 'tasks', 'skip.md'),
      '---\ntitle: Skip\ntypes: [task]\nStatus: Todo\n---\nBody.\n',
      'utf-8',
    );

    const result = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
      skipNormalize: true,
    });

    expect(result.normalized).toBe(0);

    // File should be unchanged
    const diskContent = readFileSync(join(tmpVault, 'tasks', 'skip.md'), 'utf-8');
    expect(diskContent).toContain('Status: Todo');
  });

  it('backward compat: no options means no normalization', () => {
    writeFileSync(
      join(tmpVault, 'tasks', 'compat.md'),
      '---\ntitle: Compat\ntypes: [task]\nStatus: Todo\n---\nBody.\n',
      'utf-8',
    );

    const result = incrementalIndex(db, tmpVault);

    expect(result.normalized).toBe(0);

    // File should be unchanged
    const diskContent = readFileSync(join(tmpVault, 'tasks', 'compat.md'), 'utf-8');
    expect(diskContent).toContain('Status: Todo');
  });

  it('multiple files queued: both fixed on disk after one call', () => {
    writeFileSync(
      join(tmpVault, 'tasks', 'one.md'),
      '---\ntitle: One\ntypes: [task]\nStatus: Todo\n---\nBody 1.\n',
      'utf-8',
    );
    writeFileSync(
      join(tmpVault, 'tasks', 'two.md'),
      '---\ntitle: Two\ntypes: [task]\nPriority: HIGH\n---\nBody 2.\n',
      'utf-8',
    );

    const result = incrementalIndex(db, tmpVault, {
      enforcementConfig: makeConfig('fix'),
      globalFields: {},
    });

    expect(result.normalized).toBe(2);
    expect(result.indexed).toBe(2);

    // Both files should be fixed on disk
    const disk1 = readFileSync(join(tmpVault, 'tasks', 'one.md'), 'utf-8');
    expect(disk1).toContain('status:');
    expect(disk1).not.toContain('Status:');

    const disk2 = readFileSync(join(tmpVault, 'tasks', 'two.md'), 'utf-8');
    expect(disk2).toContain('priority:');
    expect(disk2).not.toContain('Priority:');
    expect(disk2).toContain('high');
  });
});
