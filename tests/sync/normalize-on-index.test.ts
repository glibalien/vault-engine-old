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
