// tests/mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('MCP server', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db);
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

  describe('list-types', () => {
    it('returns empty array for empty database', async () => {
      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toEqual([]);
    });

    it('returns types with counts', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

      // meeting:1 (q1), person:1 (alice), task:2 (review + q1)
      const byName = new Map(data.map((d: { name: string; count: number }) => [d.name, d.count]));
      expect(byName.get('task')).toBe(2);
      expect(byName.get('meeting')).toBe(1);
      expect(byName.get('person')).toBe(1);
    });
  });
});
