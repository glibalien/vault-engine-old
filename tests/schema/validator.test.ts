import { describe, it, expect } from 'vitest';
import { validateNode } from '../../src/schema/validator.js';
import type { ParsedFile } from '../../src/parser/types.js';
import type { MergeResult } from '../../src/schema/types.js';

function makeParsed(fields: Array<{ key: string; value: unknown; valueType: string }>): ParsedFile {
  return {
    filePath: 'test.md',
    frontmatter: {},
    types: [],
    fields: fields as ParsedFile['fields'],
    wikiLinks: [],
    mdast: { type: 'root', children: [] },
    contentText: '',
    contentMd: '',
  };
}

function makeMerge(fields: Record<string, { type: string; required?: boolean; values?: string[]; target_schema?: string }>): MergeResult {
  const merged: MergeResult['fields'] = {};
  for (const [name, def] of Object.entries(fields)) {
    merged[name] = { ...def, sources: ['test'] } as any;
  }
  return { fields: merged, conflicts: [] };
}

describe('validateNode', () => {
  describe('required fields', () => {
    it('warns when a required field is missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual({
        field: 'status',
        rule: 'required',
        message: "Required field 'status' is missing",
      });
    });

    it('passes when a required field is present', () => {
      const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.warnings.filter(w => w.rule === 'required')).toHaveLength(0);
    });

    it('skips non-required fields that are missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ notes: { type: 'string' } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });
});
