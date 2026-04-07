import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { incrementalIndex } from '../../src/sync/indexer.js';
import { loadEnforcementConfig } from '../../src/enforcement/loader.js';
import { loadGlobalFields } from '../../src/coercion/globals.js';

function parseResult(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

function setupVault(vaultPath: string, enforcementYaml?: string) {
  // Copy schema fixtures
  const fixtureSchemas = join(import.meta.dirname, '../fixtures/.schemas');
  const schemasDir = join(vaultPath, '.schemas');
  mkdirSync(schemasDir, { recursive: true });

  for (const file of ['task.yaml', 'person.yaml', 'meeting.yaml', 'work-task.yaml']) {
    writeFileSync(
      join(schemasDir, file),
      readFileSync(join(fixtureSchemas, file), 'utf-8'),
    );
  }

  if (enforcementYaml) {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), enforcementYaml);
  }
}

describe('enforcement integration', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  async function startServer() {
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
  }

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-enforce-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  describe('no enforcement config (defaults)', () => {
    it('accepts unknown fields with default warn policy', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'todo', extra_field: 'some value' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.extra_field).toBe('some value');
    });

    it('silently passes invalid enum values', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('invalid_status');
    });
  });

  describe('reject unknown fields', () => {
    it('rejects create-node with unknown fields when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'todo', unknown_field: 'bad' },
        },
      });

      expect(result.isError).toBeTruthy();
      const data = parseResult(result);
      expect(data.error).toContain('Enforcement policy rejected');
      expect(data.error).toContain('unknown_field');
    });

    it('allows unknown fields on types with warn policy', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
`);
      await startServer();

      // person type is not set to reject, so unknown fields should be accepted
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Alice',
          types: ['person'],
          fields: { role: 'engineer', extra: 'ok' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.extra).toBe('ok');
    });

    it('rejects update-node with unknown fields when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    per_type:
      task: reject
`);
      await startServer();

      // First create a valid task
      const createResult = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Valid Task',
          types: ['task'],
          fields: { status: 'todo' },
        },
      });
      expect(createResult.isError).toBeFalsy();
      const created = parseResult(createResult);

      // Now try to update with unknown field
      const updateResult = await client.callTool({
        name: 'update-node',
        arguments: {
          node_id: created.node.id,
          fields: { unknown_field: 'bad' },
        },
      });

      expect(updateResult.isError).toBeTruthy();
      const data = parseResult(updateResult);
      expect(data.error).toContain('unknown_field');
    });
  });

  describe('reject enum validation', () => {
    it('rejects invalid enum values when policy is reject', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeTruthy();
      const data = parseResult(result);
      expect(data.error).toContain('Enforcement policy rejected');
      expect(data.error).toContain('status');
    });

    it('still coerces valid case-insensitive enum even with reject policy', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: reject
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'TODO' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('todo');
    });

    it('warns on invalid enum with warn policy', async () => {
      setupVault(vaultPath, `
enforcement:
  enum_validation:
    per_type:
      task: warn
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Test Task',
          types: ['task'],
          fields: { status: 'invalid_status' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('invalid_status');
      expect(data.enforcement_issues).toBeDefined();
      expect(data.enforcement_issues.length).toBeGreaterThan(0);
      expect(data.enforcement_issues[0].policy).toBe('enum_validation');
    });
  });

  describe('describe-schema includes enforcement', () => {
    it('includes enforcement policies in schema description', async () => {
      setupVault(vaultPath, `
enforcement:
  unknown_fields:
    per_type:
      task: reject
  enum_validation:
    per_type:
      task: reject
  normalize_on_index:
    per_type:
      task: fix
`);
      await startServer();

      const result = await client.callTool({
        name: 'describe-schema',
        arguments: { schema_name: 'task' },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.enforcement).toBeDefined();
      expect(data.enforcement.unknownFields).toBe('reject');
      expect(data.enforcement.enumValidation).toBe('reject');
      expect(data.enforcement.normalizeOnIndex).toBe('fix');
    });

    it('shows defaults when no per-type override', async () => {
      setupVault(vaultPath);
      await startServer();

      const result = await client.callTool({
        name: 'describe-schema',
        arguments: { schema_name: 'task' },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.enforcement).toBeDefined();
      expect(data.enforcement.unknownFields).toBe('warn');
      expect(data.enforcement.enumValidation).toBe('coerce');
      expect(data.enforcement.normalizeOnIndex).toBe('warn');
    });
  });

  // Note schema used by multi-type tests:
  //   - share_link: string (note-only field)
  //   - status: string (conflicts with task's status: enum)
  //   - category: enum [personal, work, reference] (compatible with nothing in task)
  const NOTE_SCHEMA = `name: note
display_name: Note
icon: file-text

fields:
  share_link:
    type: string
  status:
    type: string
  category:
    type: enum
    values: [personal, work, reference]
`;

  function setupVaultWithNote(enforcementYaml?: string) {
    setupVault(vaultPath, enforcementYaml);
    writeFileSync(join(vaultPath, '.schemas', 'note.yaml'), NOTE_SCHEMA);
  }

  // The enforcement YAML used for "strict" tests: task gets reject, note gets default warn
  const STRICT_ENFORCEMENT = `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
`;

  describe('multi-typed nodes with enforcement', () => {
    // ------------------------------------------------------------------
    // Original spec proof: non-conflict, task-only + note-only fields
    // ------------------------------------------------------------------
    it('accepts task-only (status) and note-only (share_link) fields on a [task, note] node', async () => {
      setupVaultWithNote(STRICT_ENFORCEMENT);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Spec proof node',
          types: ['task', 'note'],
          fields: { status: 'todo', share_link: 'https://x' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('todo');
      expect(data.node.fields.share_link).toBe('https://x');
    });

    // ------------------------------------------------------------------
    // Cross-product: (strict | lenient) × (A-only | B-only | compatible | conflicting)
    // ------------------------------------------------------------------

    // ---- STRICT (task: reject) ----

    it('strict: accepts field defined only on A (task-only: priority)', async () => {
      setupVaultWithNote(STRICT_ENFORCEMENT);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Strict A-only',
          types: ['task', 'note'],
          fields: { status: 'todo', priority: 'high' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.priority).toBe('high');
    });

    it('strict: accepts field defined only on B (note-only: share_link)', async () => {
      setupVaultWithNote(STRICT_ENFORCEMENT);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Strict B-only',
          types: ['task', 'note'],
          fields: { status: 'todo', share_link: 'https://example.com' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.share_link).toBe('https://example.com');
    });

    it('strict: accepts field compatible on both schemas (same type)', async () => {
      // Add a note schema that also defines due_date as date (same as task)
      setupVault(vaultPath, STRICT_ENFORCEMENT);
      writeFileSync(join(vaultPath, '.schemas', 'note.yaml'), `name: note
display_name: Note
icon: file-text

fields:
  share_link:
    type: string
  due_date:
    type: date
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Strict compatible',
          types: ['task', 'note'],
          fields: { status: 'todo', due_date: '2026-01-15' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.due_date).toBeDefined();
    });

    it('strict: accepts conflicting field with type_conflict warning (status: enum vs string)', async () => {
      setupVaultWithNote(STRICT_ENFORCEMENT);
      await startServer();

      // status is enum on task, string on note — conflicts in the merger
      // Must NOT be rejected as unknown; must produce a type_conflict warning
      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Strict conflicting',
          types: ['task', 'note'],
          fields: { status: 'open', share_link: 'https://x' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('open');
      // Conflicted field produces a warning
      expect(data.enforcement_issues).toBeDefined();
      const conflictIssue = data.enforcement_issues.find(
        (i: { policy: string }) => i.policy === 'type_conflict',
      );
      expect(conflictIssue).toBeDefined();
      expect(conflictIssue.field).toBe('status');
      expect(conflictIssue.message).toContain('incompatible definitions');
    });

    it('strict: still rejects truly unknown fields on multi-typed nodes', async () => {
      setupVaultWithNote(STRICT_ENFORCEMENT);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Strict truly unknown',
          types: ['task', 'note'],
          fields: { status: 'todo', totally_made_up: 'bad' },
        },
      });

      expect(result.isError).toBeTruthy();
      const data = parseResult(result);
      expect(data.error).toContain('totally_made_up');
    });

    // ---- LENIENT (default: warn, no per_type reject) ----

    it('lenient: accepts field defined only on A (task-only: priority)', async () => {
      setupVaultWithNote(); // no enforcement yaml → defaults (warn)
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Lenient A-only',
          types: ['task', 'note'],
          fields: { status: 'todo', priority: 'high' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.priority).toBe('high');
    });

    it('lenient: accepts field defined only on B (note-only: share_link)', async () => {
      setupVaultWithNote();
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Lenient B-only',
          types: ['task', 'note'],
          fields: { status: 'todo', share_link: 'https://example.com' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.share_link).toBe('https://example.com');
    });

    it('lenient: accepts field compatible on both schemas (same type)', async () => {
      setupVault(vaultPath); // no enforcement
      writeFileSync(join(vaultPath, '.schemas', 'note.yaml'), `name: note
display_name: Note
icon: file-text

fields:
  share_link:
    type: string
  due_date:
    type: date
`);
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Lenient compatible',
          types: ['task', 'note'],
          fields: { status: 'todo', due_date: '2026-01-15' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.due_date).toBeDefined();
    });

    it('lenient: accepts conflicting field with type_conflict warning', async () => {
      setupVaultWithNote();
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Lenient conflicting',
          types: ['task', 'note'],
          fields: { status: 'open', share_link: 'https://x' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.status).toBe('open');
      expect(data.enforcement_issues).toBeDefined();
      const conflictIssue = data.enforcement_issues.find(
        (i: { policy: string }) => i.policy === 'type_conflict',
      );
      expect(conflictIssue).toBeDefined();
      expect(conflictIssue.field).toBe('status');
    });

    it('lenient: accepts truly unknown fields (warn, not reject)', async () => {
      setupVaultWithNote();
      await startServer();

      const result = await client.callTool({
        name: 'create-node',
        arguments: {
          title: 'Lenient truly unknown',
          types: ['task', 'note'],
          fields: { status: 'todo', totally_made_up: 'fine' },
        },
      });

      expect(result.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data.node.fields.totally_made_up).toBe('fine');
    });
  });

  describe('normalize-on-index does not corrupt multi-typed nodes', () => {
    it('fix mode preserves note-only fields on a [task, note] node', async () => {
      const enforcementYaml = `
enforcement:
  unknown_fields:
    per_type:
      task: reject
  normalize_on_index:
    default: fix
`;
      setupVaultWithNote(enforcementYaml);

      // Write a [task, note] markdown file directly to disk
      const mdContent = `---
title: Indexed multi-type
types:
  - task
  - note
status: todo
priority: high
share_link: https://example.com
category: personal
---

Body content here.
`;
      mkdirSync(join(vaultPath, 'tasks'), { recursive: true });
      writeFileSync(join(vaultPath, 'tasks', 'multi.md'), mdContent);

      // Run incrementalIndex with enforcement config to trigger normalize-on-index
      loadSchemas(db, vaultPath);
      const enforcementConfig = loadEnforcementConfig(vaultPath);
      const globalFields = loadGlobalFields(vaultPath);
      incrementalIndex(db, vaultPath, { enforcementConfig, globalFields });

      // Verify the file is untouched — all fields preserved
      const afterContent = readFileSync(join(vaultPath, 'tasks', 'multi.md'), 'utf-8');
      expect(afterContent).toContain('share_link: https://example.com');
      expect(afterContent).toContain('category: personal');
      expect(afterContent).toContain('status: todo');
      expect(afterContent).toContain('priority: high');

      // Also verify all fields were indexed into the DB
      const fields = db.prepare(
        'SELECT key, value_text FROM fields WHERE node_id = ?',
      ).all('tasks/multi.md') as Array<{ key: string; value_text: string }>;
      const fieldMap = Object.fromEntries(fields.map(f => [f.key, f.value_text]));
      expect(fieldMap.status).toBe('todo');
      expect(fieldMap.priority).toBe('high');
      expect(fieldMap.share_link).toBe('https://example.com');
      expect(fieldMap.category).toBe('personal');
    });
  });
});
