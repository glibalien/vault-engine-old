import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { traverseGraph } from '../../src/graph/traversal.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('traverseGraph', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    db.transaction(() => {
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      resolveReferences(db);
    })();
  });

  afterEach(() => {
    db.close();
  });

  it('returns outgoing neighbors at depth 1', () => {
    const result = traverseGraph(db, {
      node_id: 'meetings/q1.md',
      direction: 'outgoing',
      max_depth: 1,
    });

    expect(result.root_id).toBe('meetings/q1.md');
    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('people/alice.md');
    for (const n of result.node_ids) {
      expect(n.depth).toBe(1);
    }
    expect(result.edges.length).toBeGreaterThan(0);
    for (const e of result.edges) {
      expect(e.source_id).toBeTruthy();
      expect(e.target_id).toBeTruthy();
      expect(e.resolved_target_id).toBeTruthy();
      expect(e.rel_type).toBeTruthy();
    }
  });
});
