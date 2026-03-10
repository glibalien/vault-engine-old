import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeNodeFile, deleteNodeFile } from '../../src/serializer/writer.js';
import { isWriteLocked } from '../../src/sync/watcher.js';

describe('writeNodeFile', () => {
  let tmpVault: string;

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('creates a file with the given content', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Hello\n');
  });

  it('creates parent directories recursively', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'tasks/work/review.md', '# Review\n');
    expect(readFileSync(join(tmpVault, 'tasks/work/review.md'), 'utf-8')).toBe('# Review\n');
  });

  it('overwrites an existing file', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Original\n');
    writeNodeFile(tmpVault, 'test.md', '# Updated\n');
    expect(readFileSync(join(tmpVault, 'test.md'), 'utf-8')).toBe('# Updated\n');
  });

  it('releases write lock after successful write', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeNodeFile(tmpVault, 'test.md', '# Hello\n');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releases write lock on filesystem error', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    // Write to a path where the parent is a file, not a directory — mkdirSync throws ENOTDIR
    writeNodeFile(tmpVault, 'blocker', '# Blocker\n');
    expect(() => writeNodeFile(tmpVault, 'blocker/nested.md', '# Fail\n')).toThrow();
    expect(isWriteLocked('blocker/nested.md')).toBe(false);
  });
});

describe('deleteNodeFile', () => {
  let tmpVault: string;

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('removes the file', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeFileSync(join(tmpVault, 'test.md'), '# Hello\n');
    deleteNodeFile(tmpVault, 'test.md');
    expect(existsSync(join(tmpVault, 'test.md'))).toBe(false);
  });

  it('throws if file does not exist', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    expect(() => deleteNodeFile(tmpVault, 'nonexistent.md')).toThrow();
  });

  it('releases write lock after successful delete', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    writeFileSync(join(tmpVault, 'test.md'), '# Hello\n');
    deleteNodeFile(tmpVault, 'test.md');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releases write lock on error', () => {
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-'));
    expect(() => deleteNodeFile(tmpVault, 'nonexistent.md')).toThrow();
    expect(isWriteLocked('nonexistent.md')).toBe(false);
  });
});
