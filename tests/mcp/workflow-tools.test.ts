import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { computeProjectTaskStats } from '../../src/mcp/workflow-tools.js';

let db: Database.Database;
let vaultPath: string;

function seedNode(id: string, raw: string) {
  const absPath = join(vaultPath, id);
  const dir = join(vaultPath, ...id.split('/').slice(0, -1));
  if (id.includes('/')) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, raw);
  const parsed = parseFile(id, raw);
  const mtime = statSync(absPath).mtime.toISOString();
  indexFile(db, parsed, id, mtime, raw);
}

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  db.transaction(() => {
    seedNode('projects/alpha.md', '---\ntitle: Alpha\ntypes: [project]\nstatus: active\n---\n');
    seedNode('tasks/t1.md', '---\ntitle: Task 1\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-20\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t2.md', '---\ntitle: Task 2\ntypes: [task]\nstatus: done\ndue_date: 2026-03-22\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t3.md', '---\ntitle: Task 3\ntypes: [task]\nstatus: in-progress\ndue_date: 2026-04-01\nproject: "[[Alpha]]"\n---\n');
    seedNode('tasks/t4.md', '---\ntitle: Task 4\ntypes: [task]\nstatus: todo\ndue_date: 2026-03-18\nproject: "[[Alpha]]"\n---\n');
    resolveReferences(db);
  })();
});

afterEach(() => {
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('computeProjectTaskStats', () => {
  it('computes task counts and completion percentage', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    expect(stats.total_tasks).toBe(4);
    expect(stats.completed_tasks).toBe(1);
    expect(stats.completion_pct).toBeCloseTo(25.0);
  });

  it('groups tasks by status', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    expect(stats.tasks_by_status.todo.length).toBe(2);
    expect(stats.tasks_by_status.done.length).toBe(1);
    expect(stats.tasks_by_status['in-progress'].length).toBe(1);
  });

  it('identifies overdue tasks', () => {
    const stats = computeProjectTaskStats(db, 'projects/alpha.md', '2026-03-25');
    // t1 (3/20, todo), t4 (3/18, todo) are overdue; t2 (done) is not
    expect(stats.overdue_tasks.length).toBe(2);
  });

  it('returns empty stats for project with no tasks', () => {
    seedNode('projects/empty.md', '---\ntitle: Empty\ntypes: [project]\n---\n');
    db.transaction(() => resolveReferences(db))();
    const stats = computeProjectTaskStats(db, 'projects/empty.md');
    expect(stats.total_tasks).toBe(0);
    expect(stats.completion_pct).toBe(0);
    expect(stats.overdue_tasks.length).toBe(0);
  });
});
