import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';

function setupTestData(db: Database.Database) {
  db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES ('notes/infra.md', 'notes/infra.md', 'file', 'Infrastructure migration', 'Infra', 0)`).run();
  db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('notes/infra.md', 'note')`).run();
  db.prepare(`INSERT INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES ('notes/infra.md#full', 'notes/infra.md', 0, 'Infrastructure migration notes', 10)`).run();
  db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)').run(
    'notes/infra.md#full', Buffer.from(new Float32Array([0.9, 0.1, 0.0]).buffer)
  );
}

describe('semantic-search MCP tool', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
    setupTestData(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function connectClient(server: ReturnType<typeof createServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('returns error when no embedding provider is configured', async () => {
    const server = createServer(db, vaultPath);
    const client = await connectClient(server);
    const result = await client.callTool({
      name: 'semantic-search',
      arguments: { query: 'infrastructure' },
    });
    expect((result.content as any)[0].text).toContain('not configured');
    await client.close();
    await server.close();
  });

  it('returns semantic search results when provider is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.9, 0.1, 0.0]] }),
    }));
    const server = createServer(db, vaultPath, {
      embeddingConfig: { provider: 'ollama' },
    });
    const client = await connectClient(server);
    const result = await client.callTool({
      name: 'semantic-search',
      arguments: { query: 'infrastructure migration' },
    });
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.results).toBeDefined();
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].id).toBe('notes/infra.md');
    expect(data.results[0].score).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });
});
