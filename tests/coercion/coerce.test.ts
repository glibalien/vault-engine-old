import { describe, it, expect } from 'vitest';
import { coerceFields } from '../../src/coercion/coerce.js';
import type { MergeResult } from '../../src/schema/types.js';
import type { GlobalFieldDefinition } from '../../src/coercion/types.js';

function makeMerge(fields: Record<string, { type: string; values?: string[] }>): MergeResult {
  const result: MergeResult = { fields: {}, conflicts: [] };
  for (const [name, def] of Object.entries(fields)) {
    result.fields[name] = {
      type: def.type as any,
      sources: ['test'],
      ...(def.values ? { values: def.values } : {}),
    };
  }
  return result;
}

describe('coerceFields', () => {
  describe('scalar → list wrapping', () => {
    it('wraps bare string into list<string>', () => {
      const merge = makeMerge({ tags: { type: 'list<string>' } });
      const { fields, changes } = coerceFields({ tags: 'work' }, merge);
      expect(fields.tags).toEqual(['work']);
      expect(changes).toContainEqual(
        expect.objectContaining({ field: 'tags', rule: 'scalar_to_list' }),
      );
    });

    it('wraps bare reference into list<reference>', () => {
      const merge = makeMerge({ project: { type: 'list<reference>' } });
      const { fields, changes } = coerceFields({ project: '[[CenterPoint]]' }, merge);
      expect(fields.project).toEqual(['[[CenterPoint]]']);
      expect(changes).toContainEqual(
        expect.objectContaining({ field: 'project', rule: 'scalar_to_list' }),
      );
    });

    it('wraps bare string (no brackets) into list<reference> with reference wrapping', () => {
      const merge = makeMerge({ project: { type: 'list<reference>' } });
      const { fields, changes } = coerceFields({ project: 'CenterPoint' }, merge);
      expect(fields.project).toEqual(['[[CenterPoint]]']);
      expect(changes.some(c => c.rule === 'reference_wrap')).toBe(true);
      expect(changes.some(c => c.rule === 'scalar_to_list')).toBe(true);
    });

    it('does not wrap if already an array', () => {
      const merge = makeMerge({ tags: { type: 'list<string>' } });
      const { fields, changes } = coerceFields({ tags: ['a', 'b'] }, merge);
      expect(fields.tags).toEqual(['a', 'b']);
      expect(changes.filter(c => c.rule === 'scalar_to_list')).toHaveLength(0);
    });
  });

  describe('reference wrapping', () => {
    it('wraps bare string for reference field', () => {
      const merge = makeMerge({ assignee: { type: 'reference' } });
      const { fields, changes } = coerceFields({ assignee: 'Alice' }, merge);
      expect(fields.assignee).toBe('[[Alice]]');
      expect(changes).toContainEqual(
        expect.objectContaining({ field: 'assignee', rule: 'reference_wrap' }),
      );
    });

    it('does not wrap already-bracketed reference', () => {
      const merge = makeMerge({ assignee: { type: 'reference' } });
      const { fields, changes } = coerceFields({ assignee: '[[Alice]]' }, merge);
      expect(fields.assignee).toBe('[[Alice]]');
      expect(changes.filter(c => c.rule === 'reference_wrap')).toHaveLength(0);
    });

    it('wraps bare strings in list<reference> array items', () => {
      const merge = makeMerge({ attendees: { type: 'list<reference>' } });
      const { fields, changes } = coerceFields({ attendees: ['Alice', '[[Bob]]'] }, merge);
      expect(fields.attendees).toEqual(['[[Alice]]', '[[Bob]]']);
      expect(changes).toContainEqual(
        expect.objectContaining({ field: 'attendees', rule: 'reference_wrap' }),
      );
    });
  });

  describe('boolean coercion', () => {
    it.each([
      ['true', true],
      ['True', true],
      ['yes', true],
      ['YES', true],
      ['1', true],
      ['false', false],
      ['False', false],
      ['no', false],
      ['NO', false],
      ['0', false],
    ])('coerces %s to %s', (input, expected) => {
      const merge = makeMerge({ billable: { type: 'boolean' } });
      const { fields } = coerceFields({ billable: input }, merge);
      expect(fields.billable).toBe(expected);
    });

    it('passes through non-boolean strings', () => {
      const merge = makeMerge({ billable: { type: 'boolean' } });
      const { fields, changes } = coerceFields({ billable: 'maybe' }, merge);
      expect(fields.billable).toBe('maybe');
      expect(changes.filter(c => c.rule === 'boolean_coerce')).toHaveLength(0);
    });

    it('does not coerce actual booleans', () => {
      const merge = makeMerge({ billable: { type: 'boolean' } });
      const { fields, changes } = coerceFields({ billable: true }, merge);
      expect(fields.billable).toBe(true);
      expect(changes.filter(c => c.rule === 'boolean_coerce')).toHaveLength(0);
    });
  });

  describe('number coercion', () => {
    it('coerces numeric string to number', () => {
      const merge = makeMerge({ count: { type: 'number' } });
      const { fields } = coerceFields({ count: '42' }, merge);
      expect(fields.count).toBe(42);
    });

    it('coerces float string', () => {
      const merge = makeMerge({ score: { type: 'number' } });
      const { fields } = coerceFields({ score: '3.14' }, merge);
      expect(fields.score).toBe(3.14);
    });

    it('passes through non-numeric strings', () => {
      const merge = makeMerge({ count: { type: 'number' } });
      const { fields } = coerceFields({ count: 'not a number' }, merge);
      expect(fields.count).toBe('not a number');
    });

    it('does not coerce actual numbers', () => {
      const merge = makeMerge({ count: { type: 'number' } });
      const { fields, changes } = coerceFields({ count: 42 }, merge);
      expect(fields.count).toBe(42);
      expect(changes.filter(c => c.rule === 'number_coerce')).toHaveLength(0);
    });
  });

  describe('enum case-insensitive matching', () => {
    it('normalizes to canonical casing', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'in-progress', 'done'] } });
      const { fields, changes } = coerceFields({ status: 'Todo' }, merge);
      expect(fields.status).toBe('todo');
      expect(changes).toContainEqual(
        expect.objectContaining({ field: 'status', rule: 'enum_case', from: 'Todo', to: 'todo' }),
      );
    });

    it('normalizes all-caps', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields } = coerceFields({ status: 'DONE' }, merge);
      expect(fields.status).toBe('done');
    });

    it('passes through exact match unchanged', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, changes } = coerceFields({ status: 'done' }, merge);
      expect(fields.status).toBe('done');
      expect(changes.filter(c => c.rule === 'enum_case')).toHaveLength(0);
    });

    it('passes through invalid enum value for validation to catch', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields } = coerceFields({ status: 'invalid' }, merge);
      expect(fields.status).toBe('invalid');
    });
  });

  describe('unknown field handling', () => {
    it('reports unknown fields with default warn policy', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { fields, unknownFields } = coerceFields({ status: 'ok', extra: 'value' }, merge);
      expect(unknownFields).toContain('extra');
      expect(fields.extra).toBe('value');
    });

    it('strips unknown fields with strip policy', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { fields, unknownFields } = coerceFields(
        { status: 'ok', extra: 'value' },
        merge,
        undefined,
        'strip',
      );
      expect(unknownFields).toContain('extra');
      expect(fields.extra).toBeUndefined();
    });

    it('passes unknown fields through with pass policy', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { fields, unknownFields } = coerceFields(
        { status: 'ok', extra: 'value' },
        merge,
        undefined,
        'pass',
      );
      expect(unknownFields).toContain('extra');
      expect(fields.extra).toBe('value');
    });
  });

  describe('global field fallback', () => {
    it('coerces via global field when not in per-type schema', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const globals: Record<string, GlobalFieldDefinition> = {
        project: { type: 'list<reference>' },
      };
      const { fields } = coerceFields({ status: 'ok', project: '[[Foo]]' }, merge, globals);
      expect(fields.project).toEqual(['[[Foo]]']);
    });

    it('prefers per-type schema over global definition', () => {
      // per-type says reference (scalar), global says list<reference>
      const merge = makeMerge({ project: { type: 'reference' } });
      const globals: Record<string, GlobalFieldDefinition> = {
        project: { type: 'list<reference>' },
      };
      const { fields } = coerceFields({ project: 'Foo' }, merge, globals);
      // Should use per-type: coerce to [[Foo]] (scalar reference), not list
      expect(fields.project).toBe('[[Foo]]');
    });

    it('does not treat global-defined fields as unknown', () => {
      const merge = makeMerge({});
      const globals: Record<string, GlobalFieldDefinition> = {
        company: { type: 'list<reference>' },
      };
      const { fields, unknownFields } = coerceFields({ company: 'Acme' }, merge, globals);
      expect(unknownFields).not.toContain('company');
      expect(fields.company).toEqual(['[[Acme]]']);
    });

    it('global enum coercion works', () => {
      const merge = makeMerge({});
      const globals: Record<string, GlobalFieldDefinition> = {
        context: { type: 'enum', values: ['work', 'personal'] },
      };
      const { fields } = coerceFields({ context: 'Work' }, merge, globals);
      expect(fields.context).toBe('work');
    });
  });

  describe('multiple coercions on same field', () => {
    it('applies reference wrap + scalar-to-list for bare string on list<reference>', () => {
      const merge = makeMerge({ attendees: { type: 'list<reference>' } });
      const { fields, changes } = coerceFields({ attendees: 'Alice' }, merge);
      expect(fields.attendees).toEqual(['[[Alice]]']);
      expect(changes.some(c => c.rule === 'reference_wrap')).toBe(true);
      expect(changes.some(c => c.rule === 'scalar_to_list')).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('no-ops when values are already correct', () => {
      const merge = makeMerge({
        status: { type: 'enum', values: ['todo', 'done'] },
        tags: { type: 'list<string>' },
        assignee: { type: 'reference' },
        billable: { type: 'boolean' },
      });
      const input = {
        status: 'todo',
        tags: ['work', 'urgent'],
        assignee: '[[Alice]]',
        billable: true,
      };
      const { fields, changes } = coerceFields(input, merge);
      expect(fields).toEqual(input);
      expect(changes).toHaveLength(0);
    });
  });

  describe('issues array', () => {
    it('is empty when no enforcement problems', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { issues } = coerceFields({ status: 'ok' }, merge);
      expect(issues).toEqual([]);
    });
  });

  describe('unknown field reject policy', () => {
    it('produces a rejection issue for unknown fields', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { fields, unknownFields, issues } = coerceFields(
        { status: 'ok', extra: 'value' },
        merge,
        undefined,
        { unknownFields: 'reject' },
      );
      expect(unknownFields).toContain('extra');
      expect(fields.extra).toBe('value');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        field: 'extra',
        policy: 'unknown_fields',
        severity: 'rejection',
      });
    });

    it('does not produce issues for warn policy', () => {
      const merge = makeMerge({ status: { type: 'string' } });
      const { issues } = coerceFields(
        { status: 'ok', extra: 'value' },
        merge,
        undefined,
        { unknownFields: 'warn' },
      );
      expect(issues).toEqual([]);
    });
  });

  describe('enum validation policy', () => {
    it('silently passes invalid enum with default coerce policy', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, issues } = coerceFields({ status: 'invalid' }, merge);
      expect(fields.status).toBe('invalid');
      expect(issues).toEqual([]);
    });

    it('warns on invalid enum with warn policy', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, issues } = coerceFields(
        { status: 'invalid' },
        merge,
        undefined,
        { enumValidation: 'warn' },
      );
      expect(fields.status).toBe('invalid');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        field: 'status',
        policy: 'enum_validation',
        severity: 'warning',
      });
    });

    it('rejects invalid enum with reject policy', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, issues } = coerceFields(
        { status: 'invalid' },
        merge,
        undefined,
        { enumValidation: 'reject' },
      );
      expect(fields.status).toBe('invalid');
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        field: 'status',
        policy: 'enum_validation',
        severity: 'rejection',
      });
    });

    it('still coerces valid case-insensitive match even with reject policy', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, issues } = coerceFields(
        { status: 'TODO' },
        merge,
        undefined,
        { enumValidation: 'reject' },
      );
      expect(fields.status).toBe('todo');
      expect(issues).toEqual([]);
    });

    it('no issue when exact enum match with reject policy', () => {
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const { fields, issues } = coerceFields(
        { status: 'todo' },
        merge,
        undefined,
        { enumValidation: 'reject' },
      );
      expect(fields.status).toBe('todo');
      expect(issues).toEqual([]);
    });
  });
});
