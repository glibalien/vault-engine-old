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

  it('returns incoming neighbors at depth 1', () => {
    const result = traverseGraph(db, {
      node_id: 'people/alice.md',
      direction: 'incoming',
      max_depth: 1,
    });

    expect(result.root_id).toBe('people/alice.md');
    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('meetings/q1.md');
    expect(nodeIds).toContain('tasks/review.md');
  });

  it('traverses both directions', () => {
    const rawA = '---\ntitle: Node A\n---\nLinks to [[Node B]]';
    const rawB = '---\ntitle: Node B\n---\nStandalone node.';
    const rawC = '---\ntitle: Node C\n---\nLinks to [[Node A]]';
    db.transaction(() => {
      indexFile(db, parseFile('a.md', rawA), 'a.md', '2025-03-10T00:00:00.000Z', rawA);
      indexFile(db, parseFile('b.md', rawB), 'b.md', '2025-03-10T00:00:00.000Z', rawB);
      indexFile(db, parseFile('c.md', rawC), 'c.md', '2025-03-10T00:00:00.000Z', rawC);
      resolveReferences(db);
    })();

    const result = traverseGraph(db, {
      node_id: 'a.md',
      direction: 'both',
      max_depth: 1,
    });

    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('b.md');
    expect(nodeIds).toContain('c.md');
    for (const n of result.node_ids) {
      expect(n.depth).toBe(1);
    }
  });

  it('traverses multiple hops', () => {
    // Build a chain: hop1.md → hop2.md → hop3.md
    // Starting from hop1.md outgoing depth 2 should reach both hop2 (depth 1) and hop3 (depth 2)
    const rawHop1 = '---\ntitle: Hop 1\n---\nLinks to [[Hop 2]]';
    const rawHop2 = '---\ntitle: Hop 2\n---\nLinks to [[Hop 3]]';
    const rawHop3 = '---\ntitle: Hop 3\n---\nEnd of chain.';
    db.transaction(() => {
      indexFile(db, parseFile('hop1.md', rawHop1), 'hop1.md', '2025-03-10T00:00:00.000Z', rawHop1);
      indexFile(db, parseFile('hop2.md', rawHop2), 'hop2.md', '2025-03-10T00:00:00.000Z', rawHop2);
      indexFile(db, parseFile('hop3.md', rawHop3), 'hop3.md', '2025-03-10T00:00:00.000Z', rawHop3);
      resolveReferences(db);
    })();

    const result = traverseGraph(db, {
      node_id: 'hop1.md',
      direction: 'outgoing',
      max_depth: 2,
    });

    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('hop2.md');
    expect(nodeIds).toContain('hop3.md');
    const hop2Entry = result.node_ids.find(n => n.id === 'hop2.md');
    const hop3Entry = result.node_ids.find(n => n.id === 'hop3.md');
    expect(hop2Entry?.depth).toBe(1);
    expect(hop3Entry?.depth).toBe(2);
    expect(result.node_ids.some(n => n.depth === 2)).toBe(true);
  });

  it('handles cycles without infinite loop', () => {
    const rawA = '---\ntitle: Node A\n---\nLinks to [[Node B]]';
    const rawB = '---\ntitle: Node B\n---\nLinks to [[Node A]]';
    db.transaction(() => {
      indexFile(db, parseFile('a.md', rawA), 'a.md', '2025-03-10T00:00:00.000Z', rawA);
      indexFile(db, parseFile('b.md', rawB), 'b.md', '2025-03-10T00:00:00.000Z', rawB);
      resolveReferences(db);
    })();

    const result = traverseGraph(db, {
      node_id: 'a.md',
      direction: 'both',
      max_depth: 5,
    });

    expect(result.root_id).toBe('a.md');
    expect(result.node_ids).toHaveLength(1);
    expect(result.node_ids[0].id).toBe('b.md');
    expect(result.node_ids[0].depth).toBe(1);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by rel_types', () => {
    const result = traverseGraph(db, {
      node_id: 'meetings/q1.md',
      direction: 'outgoing',
      rel_types: ['attendees'],
      max_depth: 1,
    });

    for (const e of result.edges) {
      expect(e.rel_type).toBe('attendees');
    }
    const nodeIds = result.node_ids.map(n => n.id);
    expect(nodeIds).toContain('people/alice.md');
  });

  it('filters results by target_types without affecting traversal', () => {
    const unfiltered = traverseGraph(db, {
      node_id: 'tasks/review.md',
      direction: 'outgoing',
      max_depth: 1,
    });
    const unfilteredIds = unfiltered.node_ids.map(n => n.id);
    expect(unfilteredIds).toContain('people/alice.md');
    expect(unfilteredIds).toContain('meetings/q1.md');

    const filtered = traverseGraph(db, {
      node_id: 'tasks/review.md',
      direction: 'outgoing',
      target_types: ['person'],
      max_depth: 1,
    });

    const filteredIds = filtered.node_ids.map(n => n.id);
    expect(filteredIds).toContain('people/alice.md');
    expect(filteredIds).not.toContain('meetings/q1.md');
    expect(filtered.edges.length).toBe(unfiltered.edges.length);
  });

  it('throws when root node does not exist', () => {
    expect(() => traverseGraph(db, {
      node_id: 'nonexistent.md',
      direction: 'both',
      max_depth: 1,
    })).toThrow('Node not found: nonexistent.md');
  });

  it('clamps max_depth to 1-10 range', () => {
    const result = traverseGraph(db, {
      node_id: 'meetings/q1.md',
      direction: 'outgoing',
      max_depth: 0,
    });

    expect(result.node_ids.length).toBeGreaterThan(0);
    for (const n of result.node_ids) {
      expect(n.depth).toBe(1);
    }
  });

  it('handles self-referential edges', () => {
    const raw = '---\ntitle: Self Ref\n---\nLinks to [[Self Ref]] itself.';
    db.transaction(() => {
      indexFile(db, parseFile('self.md', raw), 'self.md', '2025-03-10T00:00:00.000Z', raw);
      resolveReferences(db);
    })();

    const result = traverseGraph(db, {
      node_id: 'self.md',
      direction: 'outgoing',
      max_depth: 2,
    });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source_id).toBe('self.md');
    expect(result.edges[0].resolved_target_id).toBe('self.md');
    expect(result.node_ids).toEqual([]);
  });

  it('deduplicates edges when direction is both', () => {
    const rawA = '---\ntitle: Dup A\n---\n[[Dup B]]';
    const rawB = '---\ntitle: Dup B\n---\n[[Dup A]]';
    db.transaction(() => {
      indexFile(db, parseFile('dup-a.md', rawA), 'dup-a.md', '2025-03-10T00:00:00.000Z', rawA);
      indexFile(db, parseFile('dup-b.md', rawB), 'dup-b.md', '2025-03-10T00:00:00.000Z', rawB);
      resolveReferences(db);
    })();

    const result = traverseGraph(db, {
      node_id: 'dup-a.md',
      direction: 'both',
      max_depth: 2,
    });

    const edgeIds = result.edges.map(e => `${e.source_id}->${e.resolved_target_id}`);
    const uniqueEdgeIds = new Set(edgeIds);
    expect(edgeIds.length).toBe(uniqueEdgeIds.size);
  });

  it('returns empty results for a node with no relationships', () => {
    const raw = '---\ntitle: Isolated\n---\nNo links here.';
    db.transaction(() => {
      indexFile(db, parseFile('isolated.md', raw), 'isolated.md', '2025-03-10T00:00:00.000Z', raw);
    })();

    const result = traverseGraph(db, {
      node_id: 'isolated.md',
      direction: 'both',
      max_depth: 2,
    });

    expect(result.root_id).toBe('isolated.md');
    expect(result.node_ids).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
