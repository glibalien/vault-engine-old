// src/inference/analyzer.ts
import type { InferredField } from './types.js';

interface FieldRow {
  value_type: string;
  value_text: string;
  count: number;
}

/**
 * Infer the SchemaFieldType for a field from its value distribution.
 * Priority: reference > date > number > boolean > list > string(ref) > string(enum) > string.
 */
export function inferFieldType(
  rows: FieldRow[],
): Omit<InferredField, 'key' | 'frequency'> {
  const distinctValues = rows.length;
  const sampleValues = rows.slice(0, 10).map(r => r.value_text);

  // Group by value_type, pick most frequent
  const typeGroups = new Map<string, FieldRow[]>();
  for (const row of rows) {
    const group = typeGroups.get(row.value_type) ?? [];
    group.push(row);
    typeGroups.set(row.value_type, group);
  }

  // Find dominant value_type by total count
  let dominantType = 'string';
  let maxCount = 0;
  for (const [vtype, group] of typeGroups) {
    const groupCount = group.reduce((s, r) => s + r.count, 0);
    if (groupCount > maxCount) {
      maxCount = groupCount;
      dominantType = vtype;
    }
  }

  const base = { distinct_values: distinctValues, sample_values: sampleValues };

  // Priority 1-4: non-string, non-list types
  if (dominantType === 'reference') {
    return { ...base, inferred_type: 'reference', enum_candidate: false };
  }
  if (dominantType === 'date') {
    return { ...base, inferred_type: 'date', enum_candidate: false };
  }
  if (dominantType === 'number') {
    return { ...base, inferred_type: 'number', enum_candidate: false };
  }
  if (dominantType === 'boolean') {
    return { ...base, inferred_type: 'boolean', enum_candidate: false };
  }

  // Priority 5: list -- inspect elements
  if (dominantType === 'list') {
    const allRef = rows
      .filter(r => r.value_type === 'list')
      .every(r => {
        try {
          const arr = JSON.parse(r.value_text) as unknown[];
          return arr.length > 0 && arr.every(el => typeof el === 'string' && el.includes('[['));
        } catch {
          return false;
        }
      });
    return {
      ...base,
      inferred_type: allRef ? 'list<reference>' : 'list<string>',
      enum_candidate: false,
    };
  }

  // Priority 6: string containing [[ -> reference (before enum check!)
  // All string values must be wiki-links for this to trigger
  const stringRows = rows.filter(r => r.value_type === 'string');
  const allReferences = stringRows.length > 0 && stringRows.every(r => r.value_text.includes('[['));
  if (allReferences) {
    return { ...base, inferred_type: 'reference', enum_candidate: false };
  }

  // Priority 7: enum heuristic -- <=20 distinct, ratio < 0.5
  const stringDistinct = stringRows.length;
  const stringTotal = stringRows.reduce((s, r) => s + r.count, 0);
  if (stringDistinct >= 2 && stringDistinct <= 20 && stringTotal > 0 && stringDistinct / stringTotal < 0.5) {
    return {
      ...base,
      inferred_type: 'enum',
      enum_candidate: true,
      enum_values: stringRows.map(r => r.value_text),
    };
  }

  // Priority 8: plain string
  return { ...base, inferred_type: 'string', enum_candidate: false };
}
