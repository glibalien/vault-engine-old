import { describe, it, expect } from 'vitest';
import { resolveAliases } from '../../src/coercion/aliases.js';

describe('resolveAliases', () => {
  const knownFields = new Set(['due_date', 'assigned_to', 'status', 'people involved', 'project']);

  it('passes through exact matches unchanged', () => {
    const { fields, changes } = resolveAliases({ status: 'todo' }, knownFields);
    expect(fields).toEqual({ status: 'todo' });
    expect(changes).toHaveLength(0);
  });

  it('resolves case-insensitive match', () => {
    const { fields, changes } = resolveAliases({ Status: 'todo' }, knownFields);
    expect(fields).toEqual({ status: 'todo' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(
      expect.objectContaining({ field: 'Status', rule: 'alias_map', from: 'Status', to: 'status' }),
    );
  });

  it('resolves camelCase to snake_case', () => {
    const { fields, changes } = resolveAliases({ dueDate: '2026-04-01' }, knownFields);
    expect(fields).toEqual({ due_date: '2026-04-01' });
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toBe('due_date');
  });

  it('resolves PascalCase to snake_case', () => {
    const { fields } = resolveAliases({ DueDate: '2026-04-01' }, knownFields);
    expect(fields).toEqual({ due_date: '2026-04-01' });
  });

  it('resolves assignedTo to assigned_to', () => {
    const { fields } = resolveAliases({ assignedTo: '[[Alice]]' }, knownFields);
    expect(fields).toEqual({ assigned_to: '[[Alice]]' });
  });

  it('resolves snake_case to space-separated canonical name', () => {
    const { fields, changes } = resolveAliases({ people_involved: ['[[Alice]]'] }, knownFields);
    expect(fields).toEqual({ 'people involved': ['[[Alice]]'] });
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toBe('people involved');
  });

  it('passes through unknown fields as-is', () => {
    const { fields, changes } = resolveAliases({ custom_field: 'val' }, knownFields);
    expect(fields).toEqual({ custom_field: 'val' });
    expect(changes).toHaveLength(0);
  });

  it('handles multiple fields at once', () => {
    const { fields } = resolveAliases(
      { dueDate: '2026-04-01', status: 'todo', AssignedTo: '[[Alice]]' },
      knownFields,
    );
    expect(fields).toEqual({
      due_date: '2026-04-01',
      status: 'todo',
      assigned_to: '[[Alice]]',
    });
  });
});
