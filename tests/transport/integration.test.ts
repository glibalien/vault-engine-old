import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createHttpApp } from '../../src/transport/http.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('HTTP transport integration', () => {
  let db: Database.Database;
  let httpServer: Server;
  let client: Client;
  let port: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const app = createHttpApp(() => createServer(db, '/tmp/test-vault'));

    // Start on random available port
    port = await new Promise<number>((resolve) => {
      httpServer = createHttpServer(app);
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    // Connect MCP client via Streamable HTTP
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    client = new Client({ name: 'integration-test', version: '0.1.0' });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
  });

  it('lists tools via HTTP transport', async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain('list-types');
    expect(toolNames).toContain('query-nodes');
  });

  it('calls list-types tool and gets results', async () => {
    indexFixture(db, 'sample-task.md', 'tasks/review.md');
    indexFixture(db, 'sample-person.md', 'people/alice.md');

    const result = await client.callTool({ name: 'list-types', arguments: {} });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const typeNames = data.map((t: { name: string }) => t.name);
    expect(typeNames).toContain('task');
    expect(typeNames).toContain('person');
  });

  it('calls query-nodes with full_text search', async () => {
    indexFixture(db, 'sample-task.md', 'tasks/review.md');

    const result = await client.callTool({
      name: 'query-nodes',
      arguments: { full_text: 'review' },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
  });
});
