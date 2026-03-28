import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { incrementalIndex } from '../../src/sync/indexer.js';

describe('normalize-fields', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-nf-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Create schema with canonical field names
    mkdirSync(join(vaultPath, '.schemas'));
    writeFileSync(
      join(vaultPath, '.schemas', 'meeting.yaml'),
      [
        'name: meeting',
        'fields:',
        '  company:',
        '    type: string',
        '  people involved:',
        '    type: "list<reference>"',
        '  status:',
        '    type: string',
        '  tags:',
        '    type: "list<string>"',
      ].join('\n') + '\n',
    );
    loadSchemas(db, vaultPath);

    const server = createServer(db, vaultPath);
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
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function writeVaultFile(relativePath: string, content: string) {
    const dir = relativePath.includes('/')
      ? join(vaultPath, relativePath.split('/').slice(0, -1).join('/'))
      : vaultPath;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(vaultPath, relativePath), content);
  }

  function indexVault() {
    incrementalIndex(db, vaultPath);
  }

  async function callTool(args: Record<string, unknown>) {
    const result = await client.callTool({
      name: 'normalize-fields',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  describe('audit mode', () => {
    it('detects casing mismatches', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      writeVaultFile(
        'meetings/b.md',
        '---\ntitle: Meeting B\ntypes: [meeting]\ncompany: Initech\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      expect(result.mode).toBe('audit');
      const renameRule = result.rules_applied.find(
        (r: any) => r.action === 'rename_key' && r.from_key === 'Company',
      );
      expect(renameRule).toBeDefined();
      expect(renameRule.to_key).toBe('company');
      expect(renameRule.files_affected).toBe(1);
    });

    it('detects value shape mismatches', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\npeople involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      const coerceRule = result.rules_applied.find(
        (r: any) =>
          r.action === 'coerce_value' && r.from_key === 'people involved',
      );
      expect(coerceRule).toBeDefined();
      expect(coerceRule.target_type).toBe('list<reference>');
      expect(coerceRule.files_affected).toBe(1);
    });

    it('filters by schema_type', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      writeVaultFile(
        'tasks/a.md',
        '---\ntitle: Task A\ntypes: [task]\nCompany: Acme\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({
        mode: 'audit',
        schema_type: 'meeting',
      });

      const renameRule = result.rules_applied.find(
        (r: any) => r.action === 'rename_key',
      );
      expect(renameRule).toBeDefined();
      expect(renameRule.files_affected).toBe(1);
      expect(renameRule.sample_files).toEqual(['meetings/a.md']);
    });

    it('returns empty report when no mismatches exist', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\ncompany: Acme\npeople involved: ["[[Alice]]"]\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'audit' });

      expect(result.rules_applied).toHaveLength(0);
      expect(result.total_files_affected).toBe(0);
    });
  });

  describe('apply mode', () => {
    it('renames keys in files and re-indexes', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'apply' });

      expect(result.mode).toBe('apply');
      expect(result.total_files_affected).toBeGreaterThan(0);

      // Verify file was patched on disk
      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('company: Acme');
      expect(content).not.toContain('Company:');

      // Verify DB was re-indexed with the new key
      const field = db
        .prepare(
          'SELECT key FROM fields WHERE node_id = ? AND LOWER(key) = ?',
        )
        .get('meetings/a.md', 'company') as { key: string } | undefined;
      expect(field).toBeDefined();
      expect(field!.key).toBe('company');
    });

    it('coerces bare values to arrays', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\npeople involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('people involved: ["[[Alice]]"]');
    });

    it('preserves body content byte-for-byte', async () => {
      const body =
        '\nBody with [[wiki-links]] and special chars.\n\nParagraph two.\n';
      writeVaultFile(
        'meetings/a.md',
        `---\ntitle: Meeting A\ntypes: [meeting]\nCompany: Acme\n---\n${body}`,
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain(body);
    });

    it('applies explicit rules', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nMyField: value\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({
        mode: 'apply',
        rules: [
          { action: 'rename_key', from_key: 'MyField', to_key: 'my_field' },
        ],
      });

      expect(result.total_files_affected).toBe(1);
      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('my_field: value');
    });

    it('handles combined rename + coerce on same field', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\nPeople Involved: "[[Alice]]"\n---\n\nBody\n',
      );
      indexVault();

      await callTool({ mode: 'apply' });

      const content = readFileSync(join(vaultPath, 'meetings/a.md'), 'utf-8');
      expect(content).toContain('people involved: ["[[Alice]]"]');
      expect(content).not.toContain('People Involved');
    });

    it('skips files where no mutations apply', async () => {
      writeVaultFile(
        'meetings/a.md',
        '---\ntitle: Meeting A\ntypes: [meeting]\ncompany: Acme\npeople involved: ["[[Alice]]"]\n---\n\nBody\n',
      );
      writeVaultFile(
        'meetings/b.md',
        '---\ntitle: Meeting B\ntypes: [meeting]\nCompany: Other\n---\n\nBody\n',
      );
      indexVault();

      const result = await callTool({ mode: 'apply' });

      expect(result.total_files_affected).toBe(1);
    });
  });

  describe('validation', () => {
    it('returns error when rename_key rule is missing to_key', async () => {
      const result = await client.callTool({
        name: 'normalize-fields',
        arguments: {
          mode: 'audit',
          rules: [{ action: 'rename_key', from_key: 'Status' }],
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text,
      );
      expect(parsed.error).toContain("rename_key rule for 'Status' requires to_key");
    });

    it('returns error when coerce_value rule is missing target_type', async () => {
      const result = await client.callTool({
        name: 'normalize-fields',
        arguments: {
          mode: 'audit',
          rules: [{ action: 'coerce_value', from_key: 'tags' }],
        },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text,
      );
      expect(parsed.error).toContain("coerce_value rule for 'tags' requires target_type");
    });
  });
});
