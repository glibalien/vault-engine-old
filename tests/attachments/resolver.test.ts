// tests/attachments/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseEmbeds } from '../../src/attachments/resolver.js';

describe('parseEmbeds', () => {
  it('extracts embed filenames from markdown', () => {
    const raw = `# Notes\n\nSee this image: ![[photo.png]]\n\nAnd this: ![[recording.m4a]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png', 'recording.m4a']);
  });

  it('strips size suffix from image embeds', () => {
    const raw = `![[photo.png|400]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('skips .md file embeds (transclusions)', () => {
    const raw = `![[other-note.md]]\n![[photo.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('returns empty array when no embeds found', () => {
    const raw = `# Just text\n\nNo embeds here. [[wiki-link]] but not embed.`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual([]);
  });

  it('handles duplicate embeds (returns unique)', () => {
    const raw = `![[photo.png]]\n\n![[photo.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual(['photo.png']);
  });

  it('does not match regular wiki-links', () => {
    const raw = `[[not-an-embed.png]]`;
    const embeds = parseEmbeds(raw);
    expect(embeds).toEqual([]);
  });
});

import { resolveEmbedPath } from '../../src/attachments/resolver.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('resolveEmbedPath', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = join(tmpdir(), `vault-test-${Date.now()}`);
    mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('resolves from Attachments/ folder first', () => {
    mkdirSync(join(vaultDir, 'Attachments'), { recursive: true });
    writeFileSync(join(vaultDir, 'Attachments', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'Attachments', 'photo.png'));
  });

  it('resolves from vault root as second choice', () => {
    writeFileSync(join(vaultDir, 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'photo.png'));
  });

  it('resolves from source node directory as third choice', () => {
    mkdirSync(join(vaultDir, 'notes'), { recursive: true });
    writeFileSync(join(vaultDir, 'notes', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'notes', 'photo.png'));
  });

  it('falls back to recursive search', () => {
    mkdirSync(join(vaultDir, 'deep', 'nested', 'media'), { recursive: true });
    writeFileSync(join(vaultDir, 'deep', 'nested', 'media', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBe(join(vaultDir, 'deep', 'nested', 'media', 'photo.png'));
  });

  it('returns null when file cannot be found', () => {
    const result = resolveEmbedPath('missing.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBeNull();
  });

  it('skips .git and node_modules in recursive search', () => {
    mkdirSync(join(vaultDir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(vaultDir, '.git', 'objects', 'photo.png'), 'fake-png');

    const result = resolveEmbedPath('photo.png', vaultDir, join(vaultDir, 'notes'));
    expect(result).toBeNull();
  });
});
