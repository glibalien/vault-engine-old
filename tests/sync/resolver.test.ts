import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile, rebuildIndex, incrementalIndex } from '../../src/sync/indexer.js';
import { resolveTarget, resolveReferences } from '../../src/sync/resolver.js';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('schema changes for reference resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('nodes table has a title column', () => {
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as any[];
    const titleCol = cols.find((c: any) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol.type).toBe('TEXT');
  });

  it('relationships table has a resolved_target_id column', () => {
    const cols = db.prepare("PRAGMA table_info('relationships')").all() as any[];
    const resolvedCol = cols.find((c: any) => c.name === 'resolved_target_id');
    expect(resolvedCol).toBeDefined();
    expect(resolvedCol.type).toBe('TEXT');
  });
});

describe('title population in indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('uses frontmatter title when present', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('tasks/review.md') as any;
    expect(node.title).toBe('Review vendor proposals');
  });

  it('derives title from filename stem when no frontmatter title', () => {
    const raw = '# Just a note\n\nSome content.';
    const parsed = parseFile('notes/My Great Note.md', raw);
    indexFile(db, parsed, 'notes/My Great Note.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('notes/My Great Note.md') as any;
    expect(node.title).toBe('My Great Note');
  });

  it('derives title from nested path filename stem', () => {
    const raw = 'Plain content.';
    const parsed = parseFile('deep/nested/path/Cool File.md', raw);
    indexFile(db, parsed, 'deep/nested/path/Cool File.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('deep/nested/path/Cool File.md') as any;
    expect(node.title).toBe('Cool File');
  });
});

describe('resolveTarget', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves by frontmatter title (case-insensitive)', () => {
    seed('people/alice-smith.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');

    expect(resolveTarget(db, 'Alice Smith')).toBe('people/alice-smith.md');
    expect(resolveTarget(db, 'alice smith')).toBe('people/alice-smith.md');
    expect(resolveTarget(db, 'ALICE SMITH')).toBe('people/alice-smith.md');
  });

  it('resolves by filename stem when no title match', () => {
    seed('notes/Meeting Notes.md', '# Meeting\nContent.');

    expect(resolveTarget(db, 'Meeting Notes')).toBe('notes/Meeting Notes.md');
    expect(resolveTarget(db, 'meeting notes')).toBe('notes/Meeting Notes.md');
  });

  it('returns null for unresolvable targets', () => {
    seed('notes/hello.md', '# Hello');

    expect(resolveTarget(db, 'Nonexistent Node')).toBeNull();
  });

  it('prefers title match over filename stem match', () => {
    seed('docs/readme.md', '---\ntitle: Getting Started Guide\n---\nContent.');

    expect(resolveTarget(db, 'Getting Started Guide')).toBe('docs/readme.md');
    expect(resolveTarget(db, 'readme')).toBe('docs/readme.md');
  });

  it('resolves with path suffix for disambiguation', () => {
    seed('work/Meeting Notes.md', '---\ntitle: Meeting Notes\n---\nWork meetings.');
    seed('personal/Meeting Notes.md', '---\ntitle: Meeting Notes\n---\nPersonal meetings.');

    // Ambiguous — two nodes with same title
    expect(resolveTarget(db, 'Meeting Notes')).toBeNull();

    // Disambiguated with path prefix
    expect(resolveTarget(db, 'work/Meeting Notes')).toBe('work/Meeting Notes.md');
    expect(resolveTarget(db, 'personal/Meeting Notes')).toBe('personal/Meeting Notes.md');
  });

  it('handles path suffix matching case-insensitively', () => {
    seed('Projects/Alpha/Status.md', '---\ntitle: Status\n---\nStatus update.');
    seed('Projects/Beta/Status.md', '---\ntitle: Status\n---\nStatus update.');

    expect(resolveTarget(db, 'Alpha/Status')).toBe('Projects/Alpha/Status.md');
    expect(resolveTarget(db, 'alpha/status')).toBe('Projects/Alpha/Status.md');
  });

  it('returns null when path suffix is still ambiguous', () => {
    seed('a/shared/Note.md', '---\ntitle: Note\n---\nA.');
    seed('b/shared/Note.md', '---\ntitle: Note\n---\nB.');

    expect(resolveTarget(db, 'shared/Note')).toBeNull();
  });
});

describe('resolveReferences', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves relationships where target matches a node title', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');

    const result = resolveReferences(db);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
    expect(result.resolved).toBeGreaterThanOrEqual(1);
  });

  it('leaves unresolvable targets as NULL', () => {
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Nobody]]"\n---\nDo it.');

    const result = resolveReferences(db);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Nobody'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
    expect(result.unresolved).toBeGreaterThanOrEqual(1);
  });

  it('clears stale resolutions when target node is deleted', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    resolveReferences(db);

    // Verify it was resolved
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');

    // Delete the target node
    db.prepare("DELETE FROM nodes WHERE id = 'people/alice.md'").run();

    // Re-resolve — should clear the stale reference
    resolveReferences(db);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
  });

  it('resolves previously dangling refs when target node is added', () => {
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    resolveReferences(db);

    // Dangling
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();

    // Add the target node
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    resolveReferences(db);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('returns counts of resolved and unresolved references', () => {
    seed('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    seed('tasks/todo.md', '---\ntitle: My Task\nassignee: "[[Alice Smith]]"\nsource: "[[Unknown]]"\n---\nDo it.');

    const result = resolveReferences(db);

    expect(result.resolved).toBe(1);
    expect(result.unresolved).toBe(1);
  });
});

describe('reference resolution integration', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-ref-test-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  function writeVaultFile(relPath: string, content: string) {
    const abs = join(tmpVault, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('rebuildIndex resolves references after indexing all files', () => {
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');

    rebuildIndex(db, tmpVault);

    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('incrementalIndex resolves references including newly added files', () => {
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    incrementalIndex(db, tmpVault);

    // Dangling ref
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();

    // Add the target file
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    incrementalIndex(db, tmpVault);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');
  });

  it('incrementalIndex clears stale refs when target file is deleted', () => {
    writeVaultFile('people/alice.md', '---\ntitle: Alice Smith\ntypes: [person]\n---\nBio.');
    writeVaultFile('tasks/todo.md', '---\ntitle: Review\nassignee: "[[Alice Smith]]"\n---\nDo it.');
    incrementalIndex(db, tmpVault);

    // Resolved
    let rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice.md');

    // Delete the target file
    rmSync(join(tmpVault, 'people/alice.md'));
    incrementalIndex(db, tmpVault);

    rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/todo.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBeNull();
  });
});

describe('resolveTarget edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('resolves by filename stem for files without frontmatter', () => {
    seed('notes/Quick Note.md', 'Just a quick note, no frontmatter.');

    expect(resolveTarget(db, 'Quick Note')).toBe('notes/Quick Note.md');
  });

  it('unique title match wins when only one node has that explicit title', () => {
    // Node A has explicit frontmatter title "Status Report" and filename "weekly.md"
    seed('reports/weekly.md', '---\ntitle: Status Report\n---\nWeekly status.');

    // Only one node with title "Status Report" — resolves unambiguously by title
    expect(resolveTarget(db, 'Status Report')).toBe('reports/weekly.md');
  });

  it('falls back to path when title match is ambiguous due to derived titles', () => {
    // Node A has explicit title "Status Report" but filename "weekly.md"
    seed('reports/weekly.md', '---\ntitle: Status Report\n---\nWeekly status.');
    // Node B has filename "Status Report.md" — derived title is also "Status Report"
    seed('notes/Status Report.md', 'Some notes.');

    // Both nodes have title "Status Report" (explicit vs derived), so title match is ambiguous.
    // Falls back to path suffix: "status report" uniquely matches Node B by filename stem.
    expect(resolveTarget(db, 'Status Report')).toBe('notes/Status Report.md');

    // Node A is only reachable by its filename stem
    expect(resolveTarget(db, 'weekly')).toBe('reports/weekly.md');
  });

  it('handles body wiki-links in fixture vault via rebuildIndex', () => {
    // Use the real fixture vault
    const vaultDir = resolve(import.meta.dirname, '../fixtures/vault');
    rebuildIndex(db, vaultDir);

    // sample-task.md (review-vendor-proposals.md) has body link [[Alice Smith]]
    // alice-smith.md has title "Alice Smith"
    const rel = db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = 'tasks/review-vendor-proposals.md' AND target_id = 'Alice Smith'"
    ).get() as any;
    expect(rel.resolved_target_id).toBe('people/alice-smith.md');
  });
});
