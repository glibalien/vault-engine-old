// tests/mcp/summarize-node.test.ts
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

describe('summarize-node tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = join(tmpdir(), `vault-summarize-test-${Date.now()}`);
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

  it('returns VALIDATION_ERROR when neither node_id nor title provided', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('returns NOT_FOUND for missing node_id', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'nonexistent.md' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND for unresolvable title', async () => {
    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Ghost Node' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('NOT_FOUND');
    expect(data.error).toContain('Ghost Node');
  });

  it('returns ambiguity error when title matches multiple nodes', async () => {
    mkdirSync(join(vaultDir, 'a'), { recursive: true });
    mkdirSync(join(vaultDir, 'b'), { recursive: true });
    const md1 = '---\ntitle: Standup\ntypes: [meeting]\n---\nAlpha standup.';
    const md2 = '---\ntitle: Standup\ntypes: [meeting]\n---\nBeta standup.';
    writeFileSync(join(vaultDir, 'a/standup.md'), md1);
    writeFileSync(join(vaultDir, 'b/standup.md'), md2);
    indexFile(db, parseFile('a/standup.md', md1), 'a/standup.md', new Date().toISOString(), md1);
    indexFile(db, parseFile('b/standup.md', md2), 'b/standup.md', new Date().toISOString(), md2);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Standup' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.code).toBe('VALIDATION_ERROR');
    expect(data.error).toContain('a/standup.md');
    expect(data.error).toContain('b/standup.md');
  });

  it('assembles node content with metadata header and body (no embeds)', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Planning\ntypes: [meeting]\ndate: 2026-03-27\nattendees:\n  - "[[Alice]]"\n  - "[[Bob]]"\n---\n\nDiscussed roadmap.';
    writeFileSync(join(vaultDir, 'notes/planning.md'), md);
    const parsed = parseFile('notes/planning.md', md);
    indexFile(db, parsed, 'notes/planning.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'notes/planning.md' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;

    // First block: metadata header
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('## Node: Planning');
    expect(content[0].text).toContain('meeting');
    expect(content[0].text).toContain('No embedded content found');

    // Second block: node body
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('## Node Content');
    expect(content[1].text).toContain('Discussed roadmap.');
  });

  it('resolves node by title and returns assembled content', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Weekly\ntypes: [note]\n---\n\nWeekly sync notes.';
    writeFileSync(join(vaultDir, 'notes/weekly.md'), md);
    const parsed = parseFile('notes/weekly.md', md);
    indexFile(db, parsed, 'notes/weekly.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { title: 'Weekly' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('## Node: Weekly');
    expect(content[1].text).toContain('Weekly sync notes.');
  });

  it('node_id takes precedence over title', async () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    const md = '---\ntitle: Actual\ntypes: [note]\n---\nCorrect node.';
    writeFileSync(join(vaultDir, 'notes/actual.md'), md);
    const parsed = parseFile('notes/actual.md', md);
    indexFile(db, parsed, 'notes/actual.md', new Date().toISOString(), md);

    const result = await client.callTool({
      name: 'summarize-node',
      arguments: { node_id: 'notes/actual.md', title: 'Wrong Title' },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('## Node: Actual');
  });
});
