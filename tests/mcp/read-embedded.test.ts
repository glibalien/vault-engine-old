// tests/mcp/read-embedded.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

describe('read-embedded tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = join(tmpdir(), `vault-embed-test-${Date.now()}`);
    mkdirSync(vaultDir, { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultDir);
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
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns NOT_FOUND for missing node', async () => {
    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: 'nonexistent.md' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
  });

  it('returns summary when no embeds found', async () => {
    const md = '---\ntitle: Plain Note\ntypes: [note]\n---\n\nNo embeds here.';
    const notePath = 'notes/plain.md';
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('No embedded attachments found');
  });

  it('resolves and reads an image embed', async () => {
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), Buffer.from(pngBase64, 'base64'));

    const md = '---\ntitle: Image Note\ntypes: [note]\n---\n\nSee: ![[photo.png]]';
    const notePath = 'notes/with-image.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('1 image');
    expect(content[1].type).toBe('image');
    expect(content[1].mimeType).toBe('image/png');
    expect(content[1].data).toBe(pngBase64);
  });

  it('respects filter_type parameter', async () => {
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), Buffer.from('fake', 'utf-8'));
    writeFileSync(join(vaultDir, 'Attachments', 'doc.txt'), 'hello');

    const md = '---\ntitle: Mixed\ntypes: [note]\n---\n\n![[photo.png]]\n![[doc.txt]]';
    const notePath = 'notes/mixed.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath, filter_type: 'document' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('1 document');
    expect(content[0].text).not.toContain('image');
  });

  it('reports unresolved embeds in summary', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });

    const md = '---\ntitle: Broken\ntypes: [note]\n---\n\n![[missing-file.png]]';
    const notePath = 'notes/broken.md';
    writeFileSync(join(vaultDir, notePath), md);
    const parsed = parseFile(notePath, md);
    indexFile(db, parsed, notePath, new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'read-embedded',
      arguments: { node_id: notePath },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('could not be resolved');
  });
});
