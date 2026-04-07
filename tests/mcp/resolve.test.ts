import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { normalizeTypographic, normalizeForLookup, resolveById, resolveByTitle } from '../../src/mcp/resolve.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('normalizeTypographic', () => {
  it('maps curly single quotes to straight', () => {
    expect(normalizeTypographic('\u2018hello\u2019')).toBe("'hello'");
  });

  it('maps curly double quotes to straight', () => {
    expect(normalizeTypographic('\u201Chello\u201D')).toBe('"hello"');
  });

  it('maps en-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2013B')).toBe('A-B');
  });

  it('maps em-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2014B')).toBe('A-B');
  });

  it('maps ellipsis to three dots', () => {
    expect(normalizeTypographic('wait\u2026')).toBe('wait...');
  });

  it('maps non-breaking space to regular space', () => {
    expect(normalizeTypographic('hello\u00A0world')).toBe('hello world');
  });

  it('returns unchanged string when no typographic chars present', () => {
    expect(normalizeTypographic('hello world')).toBe('hello world');
  });

  it('handles multiple replacements in one string', () => {
    expect(normalizeTypographic('It\u2019s \u201Cfine\u201D \u2014 really\u2026'))
      .toBe("It's \"fine\" - really...");
  });
});

describe('normalizeForLookup', () => {
  it('applies NFC then typographic normalization then lowercases', () => {
    // NFC: e + combining accent -> e-acute
    const decomposed = 'caf\u0065\u0301';
    const result = normalizeForLookup(decomposed);
    expect(result).toBe('caf\u00e9');
  });

  it('applies typographic normalization and lowercases', () => {
    expect(normalizeForLookup('It\u2019s FINE')).toBe("it's fine");
  });

  it('handles combined NFC + typographic', () => {
    const input = 'Caf\u0065\u0301 \u2014 It\u2019s';
    expect(normalizeForLookup(input)).toBe("caf\u00e9 - it's");
  });
});

describe('resolveById', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndIndex(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('exact match (tier 1)', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    const result = resolveById(db, 'tasks/review.md');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.id).toBe('tasks/review.md');
      expect(result.matchType).toBe('exact');
    }
  });

  it('NFC match (tier 2) — composed lookup for decomposed ID', () => {
    // Index with composed form: caf\u00e9.md
    loadAndIndex('sample-task.md', 'caf\u00e9.md');
    // Lookup with decomposed form: cafe\u0301.md
    const result = resolveById(db, 'cafe\u0301.md');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('nfc');
    }
  });

  it('typographic match (tier 3) — curly indexed, straight lookup', () => {
    loadAndIndex('sample-task.md', 'It\u2019s a Test.md');
    const result = resolveById(db, "It's a Test.md");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('typographic');
    }
  });

  it('not found — returns tried array', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    const result = resolveById(db, 'nonexistent.md');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.identifier).toBe('nonexistent.md');
      expect(result.tried).toEqual(['exact', 'nfc', 'typographic']);
    }
  });
});

describe('resolveByTitle', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function indexWithTitle(relativePath: string, title: string) {
    const raw = `---\ntitle: "${title}"\ntypes: [note]\n---\nBody text.\n`;
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('exact match (case-insensitive)', () => {
    indexWithTitle('tasks/review.md', 'Review PR');
    const result = resolveByTitle(db, 'review pr');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.node.title).toBe('Review PR');
      expect(result.matchType).toBe('exact');
    }
  });

  it('curly to straight match (tier 3)', () => {
    indexWithTitle('notes/complex.md', 'It\u2019s Complex');
    const result = resolveByTitle(db, "It's Complex");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('typographic');
    }
  });

  it('straight to curly match (tier 3)', () => {
    indexWithTitle('notes/simple.md', "It's Simple");
    const result = resolveByTitle(db, 'It\u2019s Simple');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('typographic');
    }
  });

  it('em-dash to hyphen match (tier 3)', () => {
    indexWithTitle('notes/dash.md', 'A\u2014B');
    const result = resolveByTitle(db, 'A-B');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchType).toBe('typographic');
    }
  });

  it('not found — nonexistent title', () => {
    indexWithTitle('notes/x.md', 'Existing');
    const result = resolveByTitle(db, 'Nonexistent');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.identifier).toBe('Nonexistent');
      expect(result.tried).toEqual(['exact', 'nfc', 'typographic']);
    }
  });

  it('ambiguous — two nodes with same title', () => {
    indexWithTitle('notes/a.md', 'Duplicate Title');
    indexWithTitle('notes/b.md', 'Duplicate Title');
    const result = resolveByTitle(db, 'Duplicate Title');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.identifier).toBe('Duplicate Title');
      // Ambiguity detected at tier 1 (exact), so tried only includes 'exact'
      expect(result.tried).toEqual(['exact']);
    }
  });
});
