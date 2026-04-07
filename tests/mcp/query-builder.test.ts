import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { buildQuerySql } from '../../src/mcp/query-builder.js';

describe('buildQuerySql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  function seed(file: string, raw: string) {
    const parsed = parseFile(file, raw);
    indexFile(db, parsed, file, '2026-03-25T00:00:00.000Z', raw);
  }

  it('builds SQL for schema_type filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('people/b.md', '---\ntitle: B\ntypes: [person]\n---\n');

    const { sql, params } = buildQuerySql({ schema_type: 'task', limit: 20 });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('builds SQL for field eq filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('builds SQL for full_text search', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\n---\nSpecial keyword here');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\n---\nNothing relevant');

    const { sql, params } = buildQuerySql({ full_text: 'keyword', limit: 20 });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('builds SQL for neq filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\n---\n');
    seed('tasks/c.md', '---\ntitle: C\ntypes: [task]\nstatus: in-progress\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'neq', value: 'done' }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('tasks/b.md');
  });

  it('builds SQL for numeric gt filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\npriority: 1\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\npriority: 5\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'priority', operator: 'gt', value: 3 }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/b.md');
  });

  it('builds SQL for contains filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: in-progress\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'contains', value: 'progress' }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('builds SQL for in filter', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\n---\n');
    seed('tasks/c.md', '---\ntitle: C\ntypes: [task]\nstatus: in-progress\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'in', value: ['todo', 'done'] }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('tasks/a.md');
    expect(ids).toContain('tasks/b.md');
  });

  it('builds SQL for empty in filter (matches nothing)', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [{ field: 'status', operator: 'in', value: [] }],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('builds SQL with order_by on a field', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\npriority: 3\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\npriority: 1\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      order_by: 'priority ASC',
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('tasks/b.md');
    expect(rows[1].id).toBe('tasks/a.md');
  });

  it('builds SQL with order_by indexed_at', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      order_by: 'indexed_at ASC',
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('combines multiple filters', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\nstatus: todo\npriority: 1\n---\n');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\nstatus: done\npriority: 5\n---\n');
    seed('tasks/c.md', '---\ntitle: C\ntypes: [task]\nstatus: todo\npriority: 5\n---\n');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      filters: [
        { field: 'status', operator: 'eq', value: 'todo' },
        { field: 'priority', operator: 'gt', value: 3 },
      ],
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/c.md');
  });

  it('combines schema_type with full_text', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\n---\nSpecial keyword');
    seed('people/b.md', '---\ntitle: B\ntypes: [person]\n---\nSpecial keyword');

    const { sql, params } = buildQuerySql({
      schema_type: 'task',
      full_text: 'keyword',
      limit: 20,
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
  });

  it('ignores order_by when full_text is present (uses FTS rank)', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\n---\nAlpha keyword');
    seed('tasks/b.md', '---\ntitle: B\ntypes: [task]\n---\nBeta keyword');

    const { sql, params } = buildQuerySql({
      full_text: 'keyword',
      order_by: 'indexed_at ASC',
      limit: 20,
    });
    // Should still work — order_by is ignored when full_text is present
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });

  it('returns only id columns for id-only mode', () => {
    seed('tasks/a.md', '---\ntitle: A\ntypes: [task]\n---\n');

    const { sql, params } = buildQuerySql({ schema_type: 'task', limit: 20, select: 'id-only' });
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('tasks/a.md');
    // Should not have content_text, content_md etc.
    expect(rows[0]).not.toHaveProperty('content_text');
  });
});
