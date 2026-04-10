import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
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
      const parsed = matter(result).data;
      expect(parsed['people involved']).toEqual(['[[Alice]]']);
    });

    it('wraps bare string in array for list<string>', () => {
      const file = '---\ntags: work\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      const parsed = matter(result).data;
      expect(parsed.tags).toEqual(['work']);
    });

    it('does not double-wrap existing flow-style arrays', () => {
      const file = '---\ntags: [work, play]\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      const parsed = matter(result).data;
      expect(parsed.tags).toEqual(['work', 'play']);
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
      const parsed = matter(result).data;
      expect(parsed['people involved']).toEqual(['[[Alice]]']);
      expect(result).not.toContain('People Involved');
    });
  });

  describe('set_value', () => {
    it('replaces an enum value', () => {
      const file = '---\nstatus: Todo\ntitle: My Task\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      expect(result).toContain('status: todo');
      expect(result).not.toContain('status: Todo');
    });

    it('replaces a boolean string with a real boolean', () => {
      const file = '---\ncompleted: "true"\ntitle: My Task\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'completed', value: true },
      ]);
      expect(result).toContain('completed: true');
      expect(result).not.toContain('completed: "true"');
    });

    it('replaces a string number with a real number', () => {
      const file = '---\npriority: "3"\ntitle: My Task\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'priority', value: 3 },
      ]);
      expect(result).toContain('priority: 3');
      expect(result).not.toContain('priority: "3"');
    });

    it('wraps a bare string as wiki-link reference', () => {
      const file = '---\nassignee: Alice\ntitle: My Task\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'assignee', value: '[[Alice]]' },
      ]);
      expect(result).toContain('assignee: "[[Alice]]"');
      expect(result).not.toContain('assignee: Alice\n');
    });

    it('preserves keys not targeted by set_value', () => {
      const file = '---\nstatus: Todo\ntitle: My Task\npriority: 1\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      expect(result).toContain('title: My Task');
      expect(result).toContain('priority: 1');
    });

    it('preserves body content byte-for-byte', () => {
      const body = '\nBody with [[wiki-links]] and *formatting*.\n\nAnother paragraph.\n';
      const file = '---\nstatus: Todo\ntitle: My Task\n---\n' + body;
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      const resultBody = result.slice(result.indexOf('---\n', 4) + 4);
      expect(resultBody).toBe(body);
    });

    it('is a no-op for a key that does not exist in frontmatter', () => {
      const file = '---\nstatus: Todo\ntitle: My Task\ntypes: [meeting, task]\n---\n\nBody.\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'nonexistent', value: 'something' },
      ]);
      expect(result).toBe(file);
    });

    it('works combined with rename_key and coerce_value in the same mutation set', () => {
      const file = '---\nStatus: Todo\nPeople: "[[Alice]]"\ntags: work\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'Status', to: 'status' },
        { type: 'rename_key', from: 'People', to: 'people' },
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      const parsed = matter(result).data;
      // rename_key applied first, then set_value operates on canonical name
      expect(parsed.status).toBe('todo');
      expect(parsed.tags).toEqual(['work']);
      expect(result).not.toContain('Status:');
      expect(result).not.toContain('People:');
      expect(parsed.people).toBe('[[Alice]]');
    });

    it('preserves flow-style arrays in untouched fields', () => {
      const file = '---\nstatus: Todo\ntypes: [task, meeting]\ntags: [work, urgent]\n---\n\nBody.\n';
      const result = patchFrontmatter(file, [
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      expect(result).toContain('status: todo');
      expect(result).toMatch(/types: \[.*task.*meeting.*\]/);
      expect(result).toMatch(/tags: \[.*work.*urgent.*\]/);
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

  describe('coerce_value block-style list handling', () => {
    it('does not corrupt block-style multi-line lists', () => {
      const file = [
        '---',
        'title: Meeting Notes',
        'types: [meeting]',
        'people involved:',
        '  - "[[Raphael Berdugo]]"',
        '---',
        '',
        'Body content.',
        '',
      ].join('\n');
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
      ]);
      // Must produce valid YAML that parses back correctly
      const parsed = matter(result).data;
      expect(parsed['people involved']).toEqual(['[[Raphael Berdugo]]']);
      // Must NOT contain the corruption patterns
      expect(result).not.toContain('[-');
      expect(result).not.toContain('[people involved:]');
    });

    it('wraps scalar to single-element list', () => {
      const file = '---\ntags: foo\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      const parsed = matter(result).data;
      expect(parsed.tags).toEqual(['foo']);
    });

    it('is a no-op for existing block-style list', () => {
      const file = [
        '---',
        'tags:',
        '  - alpha',
        '  - beta',
        '---',
        '',
        'Body',
        '',
      ].join('\n');
      const before = matter(file).data;
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      const after = matter(result).data;
      expect(after.tags).toEqual(before.tags);
    });

    it('is a no-op for existing flow-style list', () => {
      const file = '---\ntags: [alpha, beta]\n---\n\nBody\n';
      const before = matter(file).data;
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      const after = matter(result).data;
      expect(after.tags).toEqual(before.tags);
    });

    it('is a no-op for missing key', () => {
      const file = '---\ntitle: Test\n---\n\nBody\n';
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
      ]);
      expect(result).toBe(file);
    });

    it('handles combined rename_key + set_value + coerce_value', () => {
      const file = [
        '---',
        'Status: Todo',
        'People: "[[Alice]]"',
        'tags: work',
        'priority: 3',
        '---',
        '',
        'Body',
        '',
      ].join('\n');
      const result = patchFrontmatter(file, [
        { type: 'rename_key', from: 'Status', to: 'status' },
        { type: 'rename_key', from: 'People', to: 'people' },
        { type: 'coerce_value', key: 'tags', targetType: 'list<string>' },
        { type: 'coerce_value', key: 'people', targetType: 'list<reference>' },
        { type: 'set_value', key: 'status', value: 'todo' },
      ]);
      const parsed = matter(result).data;
      expect(parsed.status).toBe('todo');
      expect(parsed.tags).toEqual(['work']);
      expect(parsed.people).toEqual(['[[Alice]]']);
      expect(parsed.priority).toBe(3);
      expect(result).not.toContain('Status:');
      expect(result).not.toContain('People:');
    });

    it('handles the real repro file (Barry - Raphael 2026-04-10.md)', () => {
      const file = [
        '---',
        'title: Barry - Raphael 2026-04-10',
        'types:',
        '  - meeting',
        'date: 2026-04-10',
        'people involved:',
        '  - "[[Raphael Berdugo]]"',
        'company: "[[Lux Harmonics]]"',
        'status: completed',
        '---',
        '',
        '## Agenda',
        '',
        '- Discuss Q2 planning',
        '- Review deliverables',
        '',
        '## Notes',
        '',
        'Meeting went well. Follow up on [[Project Alpha]] next week.',
        '',
      ].join('\n');

      // Dispatch the mutations that normalizeOnIndex would dispatch
      const result = patchFrontmatter(file, [
        { type: 'coerce_value', key: 'people involved', targetType: 'list<reference>' },
        { type: 'coerce_value', key: 'company', targetType: 'reference' },
      ]);

      // Output must be valid YAML
      const parsed = matter(result).data;
      expect(parsed['people involved']).toEqual(['[[Raphael Berdugo]]']);
      expect(parsed.company).toBe('[[Lux Harmonics]]');
      expect(parsed.title).toBe('Barry - Raphael 2026-04-10');
      expect(parsed.status).toBe('completed');

      // Must NOT contain the corruption patterns
      expect(result).not.toContain('[people involved:]');
      expect(result).not.toContain('[-');

      // Body must be preserved
      expect(result).toContain('## Agenda');
      expect(result).toContain('## Notes');
      expect(result).toContain('[[Project Alpha]]');
    });
  });
});
