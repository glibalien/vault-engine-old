import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGlobalFields } from '../../src/coercion/globals.js';

describe('loadGlobalFields', () => {
  let vaultPath: string;

  afterEach(() => {
    if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns empty when _global.yaml does not exist', () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    const result = loadGlobalFields(vaultPath);
    expect(result).toEqual({});
  });

  it('returns empty when .schemas dir does not exist', () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    const result = loadGlobalFields(vaultPath);
    expect(result).toEqual({});
  });

  it('loads global field definitions', () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(vaultPath, '.schemas'), { recursive: true });
    writeFileSync(
      join(vaultPath, '.schemas', '_global.yaml'),
      `global_fields:
  project:
    type: list<reference>
    description: "Links to projects"
  tags:
    type: list<string>
    description: "Freeform tags"
  context:
    type: enum
    values: [work, personal]
`,
    );

    const result = loadGlobalFields(vaultPath);
    expect(result.project).toEqual({
      type: 'list<reference>',
      description: 'Links to projects',
    });
    expect(result.tags).toEqual({
      type: 'list<string>',
      description: 'Freeform tags',
    });
    expect(result.context).toEqual({
      type: 'enum',
      values: ['work', 'personal'],
    });
  });

  it('expands canonical_name entries', () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(vaultPath, '.schemas'), { recursive: true });
    writeFileSync(
      join(vaultPath, '.schemas', '_global.yaml'),
      `global_fields:
  people_involved:
    canonical_name: "people involved"
    type: list<reference>
`,
    );

    const result = loadGlobalFields(vaultPath);
    // Both the YAML key and the canonical name should be registered
    expect(result['people involved']).toBeDefined();
    expect(result['people_involved']).toBeDefined();
    expect(result['people involved'].type).toBe('list<reference>');
  });

  it('handles empty global_fields', () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    mkdirSync(join(vaultPath, '.schemas'), { recursive: true });
    writeFileSync(join(vaultPath, '.schemas', '_global.yaml'), 'global_fields:\n');

    const result = loadGlobalFields(vaultPath);
    expect(result).toEqual({});
  });
});
