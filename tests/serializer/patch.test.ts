import { describe, it, expect } from 'vitest';
import { patchFrontmatter } from '../../src/serializer/patch.js';

describe('patchFrontmatter', () => {
  const baseFile = [
    '---',
    'title: Test Note',
    'types: [meeting]',
    'Company: Acme Corp',
    'people involved: "[[Alice]]"',
    'status: active',
    '---',
    '',
    'Body content with [[wiki-links]] here.',
    '',
    'More body text.',
    '',
  ].join('\n');

  describe('rename_key', () => {
    it('renames a frontmatter key preserving value', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      expect(result).toContain('company: Acme Corp');
      expect(result).not.toContain('Company:');
    });

    it('skips rename if target key already exists', () => {
      const file = '---\nCompany: Acme\ncompany: Initech\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      // Both keys should remain unchanged
      expect(result).toContain('Company: Acme');
      expect(result).toContain('company: Initech');
    });

    it('is a no-op if from_key does not exist', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'nonexistent', to: 'something' },
      ]);
      expect(result).toBe(baseFile);
    });
  });

  describe('coerce_value', () => {
    it('wraps bare reference in array for list<reference>', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
      ]);
      expect(result).toContain('people involved: ["[[Alice]]"]');
    });

    it('wraps bare string in array for list<string>', () => {
      const file = '---\ntags: work\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      expect(result).toContain('tags: [work]');
    });

    it('does not double-wrap existing arrays', () => {
      const file = '---\ntags: [work, play]\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      expect(result).toContain('tags: [work, play]');
    });

    it('is a no-op for non-list target types', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'coerce_value', key: 'status', targetType: 'string' },
      ]);
      expect(result).toBe(baseFile);
    });
  });

  describe('body preservation', () => {
    it('preserves body content byte-for-byte', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      const origBody = baseFile.slice(baseFile.indexOf('---\n', 4) + 4);
      const resultBody = result.slice(result.indexOf('---\n', 4) + 4);
      expect(resultBody).toBe(origBody);
    });
  });

  describe('multiple mutations', () => {
    it('applies rename then coerce in sequence', () => {
      const file = '---\nPeople Involved: "[[Alice]]"\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'People Involved', to: 'people involved' },
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
      ]);
      expect(result).toContain('people involved: ["[[Alice]]"]');
      expect(result).not.toContain('People Involved');
    });
  });

  describe('edge cases', () => {
    it('returns unchanged content if no frontmatter', () => {
      const noFm = 'Just body content\nNo frontmatter here\n';
      expect(patchFrontmatter(noFm, [
        { type: 'rename_key', from: 'a', to: 'b' },
      ])).toBe(noFm);
    });

    it('handles empty mutations array', () => {
      expect(patchFrontmatter(baseFile, [])).toBe(baseFile);
    });

    it('preserves keys not targeted by mutations', () => {
      const result = patchFrontmatter(baseFile, [
        { type: 'rename_key', from: 'Company', to: 'company' },
      ]);
      expect(result).toContain('title: Test Note');
      expect(result).toContain('types: [meeting]');
      expect(result).toContain('status: active');
      expect(result).toContain('people involved: "[[Alice]]"');
    });
  });
});
