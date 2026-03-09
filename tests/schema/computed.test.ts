// tests/schema/computed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { evaluateComputed } from '../../src/schema/computed.js';
import type { ComputedDefinition } from '../../src/schema/types.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('evaluateComputed', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('count aggregate', () => {
    it('counts nodes matching types_includes and references_this', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        task_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.task_count).toEqual({ value: 1 });
    });

    it('returns zero when no nodes match', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        task_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'project',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.task_count).toEqual({ value: 0 });
    });

    it('counts with field condition in filter', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        todo_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
            status: 'todo',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.todo_count).toEqual({ value: 1 });
    });

    it('returns zero when field condition does not match', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        done_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
            status: 'done',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.done_count).toEqual({ value: 0 });
    });
  });

  describe('percentage aggregate', () => {
    it('calculates percentage of matching nodes', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        completion_pct: {
          aggregate: 'percentage',
          numerator: { status: 'done' },
          filter: {
            types_includes: 'task',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.completion_pct).toEqual({
        value: 0,
        numerator: 0,
        denominator: 1,
      });
    });

    it('returns zero when denominator is zero', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        completion_pct: {
          aggregate: 'percentage',
          numerator: { status: 'done' },
          filter: {
            types_includes: 'task',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.completion_pct).toEqual({
        value: 0,
        numerator: 0,
        denominator: 0,
      });
    });

    it('calculates percentage with multiple numerator conditions', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        high_todo_pct: {
          aggregate: 'percentage',
          numerator: { status: 'todo', priority: 'high' },
          filter: {
            types_includes: 'task',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.high_todo_pct).toEqual({
        value: 100,
        numerator: 1,
        denominator: 1,
      });
    });
  });
});
