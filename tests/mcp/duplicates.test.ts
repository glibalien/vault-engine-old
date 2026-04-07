// tests/mcp/duplicates.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { findDuplicates } from '../../src/mcp/duplicates.js';

function seedNode(
  db: Database.Database,
  id: string,
  title: string,
  types: string[],
  fields?: Record<string, string>,
) {
  db.prepare(
    `INSERT INTO nodes (id, file_path, node_type, title, content_text, indexed_at)
     VALUES (?, ?, 'file', ?, '', datetime('now'))`,
  ).run(id, id, title);
  for (const t of types) {
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, t);
  }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      db.prepare(
        'INSERT INTO fields (node_id, key, value_text, value_type) VALUES (?, ?, ?, ?)',
      ).run(id, key, value, 'string');
    }
  }
}

describe('findDuplicates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds exact title duplicates', () => {
    seedNode(db, 'meetings/standup-1.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'meetings/standup-2.md', 'Weekly Standup', ['meeting']);

    const result = findDuplicates(db, {});
    expect(result.total_groups).toBe(1);
    expect(result.groups[0].similarity).toBe(1.0);
    expect(result.groups[0].reason).toBe('identical normalized title');
    expect(result.groups[0].nodes).toHaveLength(2);
    const ids = result.groups[0].nodes.map(n => n.id).sort();
    expect(ids).toEqual(['meetings/standup-1.md', 'meetings/standup-2.md']);
  });

  it('finds near-match title duplicates', () => {
    seedNode(db, 'meetings/standup-1.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'meetings/standup-2.md', 'Weekly Stand-up', ['meeting']);

    // After normalization: "weekly standup" vs "weekly standup" — the hyphen is stripped
    // These will actually be exact matches after normalize strips punctuation
    const result = findDuplicates(db, {});
    expect(result.total_groups).toBe(1);
    expect(result.groups[0].nodes).toHaveLength(2);
  });

  it('finds near-match titles with edit distance', () => {
    // Titles that differ slightly after normalization
    seedNode(db, 'notes/a.md', 'Project Alpha Review', ['note']);
    seedNode(db, 'notes/b.md', 'Project Alpha Reviews', ['note']);

    const result = findDuplicates(db, { threshold: 0.8 });
    expect(result.total_groups).toBe(1);
    expect(result.groups[0].reason).toBe('similar title');
    expect(result.groups[0].similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('filters by schema_type', () => {
    seedNode(db, 'meetings/standup-1.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'meetings/standup-2.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'tasks/task-1.md', 'Deploy Server', ['task']);
    seedNode(db, 'tasks/task-2.md', 'Deploy Server', ['task']);

    const result = findDuplicates(db, { schema_type: 'task' });
    expect(result.total_groups).toBe(1);
    expect(result.groups[0].nodes.every(n => n.types.includes('task'))).toBe(true);
    const ids = result.groups[0].nodes.map(n => n.id).sort();
    expect(ids).toEqual(['tasks/task-1.md', 'tasks/task-2.md']);
  });

  it('respects limit', () => {
    // Create 3 groups of exact duplicates
    seedNode(db, 'a1.md', 'Alpha', ['note']);
    seedNode(db, 'a2.md', 'Alpha', ['note']);
    seedNode(db, 'b1.md', 'Bravo', ['note']);
    seedNode(db, 'b2.md', 'Bravo', ['note']);
    seedNode(db, 'c1.md', 'Charlie', ['note']);
    seedNode(db, 'c2.md', 'Charlie', ['note']);

    const result = findDuplicates(db, { limit: 2 });
    expect(result.total_groups).toBe(3);
    expect(result.groups).toHaveLength(2);
  });

  it('returns empty when no duplicates', () => {
    seedNode(db, 'a.md', 'Alpha', ['note']);
    seedNode(db, 'b.md', 'Bravo', ['note']);
    seedNode(db, 'c.md', 'Charlie', ['note']);

    const result = findDuplicates(db, {});
    expect(result.total_groups).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it('includes field overlap when include_fields is true', () => {
    seedNode(db, 'a.md', 'Weekly Sync', ['meeting'], { status: 'done', location: 'Room A' });
    seedNode(db, 'b.md', 'Weekly Syncs', ['meeting'], { status: 'done', location: 'Room A' });

    // Without fields — just title similarity
    const withoutFields = findDuplicates(db, { threshold: 0.8 });
    expect(withoutFields.total_groups).toBe(1);
    const simWithout = withoutFields.groups[0].similarity;

    // With fields — similarity boosted by field overlap
    const withFields = findDuplicates(db, { threshold: 0.8, include_fields: true });
    expect(withFields.total_groups).toBe(1);
    const simWith = withFields.groups[0].similarity;

    // Field overlap (Jaccard = 2/2 = 1.0) should boost similarity
    // Formula: 0.7 * titleSim + 0.3 * 1.0
    expect(simWith).toBeGreaterThanOrEqual(simWithout);
  });

  it('handles nodes with null titles', () => {
    // Insert a node with null title directly
    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, title, content_text, indexed_at)
       VALUES (?, ?, 'file', NULL, '', datetime('now'))`,
    ).run('null-title.md', 'null-title.md');
    seedNode(db, 'a.md', 'Alpha', ['note']);

    const result = findDuplicates(db, {});
    expect(result.total_groups).toBe(0);
  });

  it('sorts groups by similarity descending', () => {
    // Create exact match group (sim=1.0) and near-match group
    seedNode(db, 'a1.md', 'Alpha One', ['note']);
    seedNode(db, 'a2.md', 'Alpha One', ['note']);
    seedNode(db, 'b1.md', 'Beta Testing', ['note']);
    seedNode(db, 'b2.md', 'Beta Testings', ['note']);

    const result = findDuplicates(db, { threshold: 0.8 });
    expect(result.total_groups).toBeGreaterThanOrEqual(2);
    // First group should have the highest similarity
    for (let i = 1; i < result.groups.length; i++) {
      expect(result.groups[i - 1].similarity).toBeGreaterThanOrEqual(result.groups[i].similarity);
    }
  });
});

describe('find-duplicates MCP tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, '/tmp/test-vault');
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
  });

  it('finds duplicates via MCP tool call', async () => {
    seedNode(db, 'meetings/standup-1.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'meetings/standup-2.md', 'Weekly Standup', ['meeting']);
    seedNode(db, 'tasks/unique.md', 'Something Unique', ['task']);

    const result = await client.callTool({
      name: 'find-duplicates',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total_groups).toBe(1);
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].similarity).toBe(1.0);
    expect(data.groups[0].nodes).toHaveLength(2);

    const ids = data.groups[0].nodes.map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['meetings/standup-1.md', 'meetings/standup-2.md']);
  });

  it('accepts schema_type filter via MCP', async () => {
    seedNode(db, 'a.md', 'Duplicate', ['meeting']);
    seedNode(db, 'b.md', 'Duplicate', ['meeting']);
    seedNode(db, 'c.md', 'Duplicate', ['task']);
    seedNode(db, 'd.md', 'Duplicate', ['task']);

    const result = await client.callTool({
      name: 'find-duplicates',
      arguments: { schema_type: 'task' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total_groups).toBe(1);
    const ids = data.groups[0].nodes.map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['c.md', 'd.md']);
  });

  it('returns empty for no duplicates via MCP', async () => {
    seedNode(db, 'a.md', 'Alpha', ['note']);
    seedNode(db, 'b.md', 'Bravo', ['note']);

    const result = await client.callTool({
      name: 'find-duplicates',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.total_groups).toBe(0);
    expect(data.groups).toHaveLength(0);
  });
});
