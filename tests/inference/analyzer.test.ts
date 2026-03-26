import { describe, it, expect } from 'vitest';
import { inferFieldType } from '../../src/inference/analyzer.js';

describe('inferFieldType', () => {
  it('infers reference from value_type reference', () => {
    const rows = [
      { value_type: 'reference', value_text: '[[Alice]]', count: 3 },
    ];
    const result = inferFieldType(rows, 5);
    expect(result.inferred_type).toBe('reference');
    expect(result.enum_candidate).toBe(false);
  });

  it('infers date from value_type date', () => {
    const rows = [
      { value_type: 'date', value_text: '2025-03-10T00:00:00.000Z', count: 4 },
    ];
    const result = inferFieldType(rows, 4);
    expect(result.inferred_type).toBe('date');
  });

  it('infers number from value_type number', () => {
    const rows = [
      { value_type: 'number', value_text: '42', count: 2 },
    ];
    const result = inferFieldType(rows, 3);
    expect(result.inferred_type).toBe('number');
  });

  it('infers boolean from value_type boolean', () => {
    const rows = [
      { value_type: 'boolean', value_text: 'true', count: 1 },
      { value_type: 'boolean', value_text: 'false', count: 2 },
    ];
    const result = inferFieldType(rows, 5);
    expect(result.inferred_type).toBe('boolean');
  });

  it('infers list<reference> when all list elements contain [[', () => {
    const rows = [
      { value_type: 'list', value_text: '["[[Alice]]","[[Bob]]"]', count: 3 },
    ];
    const result = inferFieldType(rows, 3);
    expect(result.inferred_type).toBe('list<reference>');
  });

  it('infers list<string> when list elements do not all contain [[', () => {
    const rows = [
      { value_type: 'list', value_text: '["engineering","leadership"]', count: 2 },
    ];
    const result = inferFieldType(rows, 2);
    expect(result.inferred_type).toBe('list<string>');
  });

  it('infers reference from string value containing [[', () => {
    const rows = [
      { value_type: 'string', value_text: '[[Alice]]', count: 2 },
      { value_type: 'string', value_text: '[[Bob]]', count: 3 },
    ];
    const result = inferFieldType(rows, 5);
    expect(result.inferred_type).toBe('reference');
    // Must NOT be classified as enum even though distinct=2, ratio=2/5=0.4 < 0.5
    expect(result.enum_candidate).toBe(false);
  });

  it('infers enum when <=20 distinct values and ratio < 0.5', () => {
    const rows = [
      { value_type: 'string', value_text: 'todo', count: 10 },
      { value_type: 'string', value_text: 'done', count: 8 },
      { value_type: 'string', value_text: 'in-progress', count: 5 },
    ];
    const result = inferFieldType(rows, 23);
    expect(result.inferred_type).toBe('enum');
    expect(result.enum_candidate).toBe(true);
    expect(result.enum_values).toEqual(['todo', 'done', 'in-progress']);
  });

  it('infers string when distinct values exceed 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      value_type: 'string' as const,
      value_text: `value-${i}`,
      count: 2,
    }));
    const result = inferFieldType(rows, 50);
    expect(result.inferred_type).toBe('string');
    expect(result.enum_candidate).toBe(false);
  });

  it('infers string when ratio >= 0.5 (values rarely repeat)', () => {
    const rows = [
      { value_type: 'string', value_text: 'foo', count: 1 },
      { value_type: 'string', value_text: 'bar', count: 1 },
      { value_type: 'string', value_text: 'baz', count: 1 },
    ];
    const result = inferFieldType(rows, 3);
    expect(result.inferred_type).toBe('string');
    expect(result.enum_candidate).toBe(false);
  });

  it('uses most frequent value_type when mixed', () => {
    const rows = [
      { value_type: 'string', value_text: 'hello', count: 10 },
      { value_type: 'number', value_text: '42', count: 2 },
    ];
    const result = inferFieldType(rows, 12);
    expect(result.inferred_type).toBe('string');
  });

  it('reports sample_values up to 10', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      value_type: 'string' as const,
      value_text: `val-${i}`,
      count: 1,
    }));
    const result = inferFieldType(rows, 15);
    expect(result.sample_values.length).toBe(10);
  });
});
