import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('infer-schemas MCP tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-infer-'));

    const server = createServer(db, tmpDir);
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadAndIndex(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  async function callTool(toolName: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name: toolName, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns analysis in report mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = await callTool('infer-schemas', {});

    expect(result.types).toBeDefined();
    expect(result.types.length).toBeGreaterThanOrEqual(2);

    const task = result.types.find((t: any) => t.name === 'task');
    expect(task).toBeDefined();
    expect(task.node_count).toBe(1);
    expect(task.inferred_fields.length).toBeGreaterThan(0);
    expect(result.files_written).toBeUndefined();
  });

  it('writes schema files in overwrite mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = await callTool('infer-schemas', { mode: 'overwrite' });

    expect(result.files_written).toBeDefined();
    expect(result.files_written.length).toBeGreaterThan(0);
    expect(result.files_written[0]).toMatch(/\.schemas\//);
  });

  it('returns error for empty vault', async () => {
    const result = await callTool('infer-schemas', {});
    expect(result.error).toBeDefined();
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('returns error for unknown type filter', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = await callTool('infer-schemas', { types: ['nonexistent'] });
    expect(result.error).toBeDefined();
    expect(result.code).toBe('NOT_FOUND');
  });

  it('reloads schemas after writing in merge mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    await callTool('infer-schemas', { mode: 'merge' });

    // Schemas should be loaded into DB now
    const schemas = db.prepare('SELECT name FROM schemas ORDER BY name').all() as Array<{ name: string }>;
    expect(schemas.some(s => s.name === 'task')).toBe(true);
  });
});
