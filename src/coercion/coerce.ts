// src/coercion/coerce.ts
import type { MergeResult } from '../schema/types.js';
import type { CoercionChange, CoercionResult, GlobalFieldDefinition, UnknownFieldPolicy } from './types.js';
import { resolveAliases } from './aliases.js';

const WIKI_LINK_RE = /^\[\[.+\]\]$/;

function wrapReference(value: string): string {
  return WIKI_LINK_RE.test(value) ? value : `[[${value}]]`;
}

function coerceValue(
  key: string,
  value: unknown,
  schemaType: string,
  enumValues?: string[],
  changes: CoercionChange[] = [],
): unknown {
  // Scalar → list wrapping
  if (schemaType === 'list<reference>' || schemaType === 'list<string>') {
    if (!Array.isArray(value)) {
      let coerced: unknown;
      if (schemaType === 'list<reference>') {
        const wrapped = typeof value === 'string' ? wrapReference(value) : value;
        coerced = [wrapped];
        if (wrapped !== value) {
          changes.push({ field: key, rule: 'reference_wrap', from: value, to: wrapped });
        }
      } else {
        coerced = [value];
      }
      changes.push({ field: key, rule: 'scalar_to_list', from: value, to: coerced });
      return coerced;
    }
    // Array value — still wrap individual items for list<reference>
    if (schemaType === 'list<reference>') {
      let anyWrapped = false;
      const wrapped = (value as unknown[]).map(item => {
        if (typeof item === 'string' && !WIKI_LINK_RE.test(item)) {
          anyWrapped = true;
          return `[[${item}]]`;
        }
        return item;
      });
      if (anyWrapped) {
        changes.push({ field: key, rule: 'reference_wrap', from: value, to: wrapped });
        return wrapped;
      }
    }
    return value;
  }

  // Reference wrapping (scalar)
  if (schemaType === 'reference') {
    if (typeof value === 'string' && !WIKI_LINK_RE.test(value)) {
      const wrapped = `[[${value}]]`;
      changes.push({ field: key, rule: 'reference_wrap', from: value, to: wrapped });
      return wrapped;
    }
    return value;
  }

  // Boolean coercion
  if (schemaType === 'boolean' && typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === '1') {
      changes.push({ field: key, rule: 'boolean_coerce', from: value, to: true });
      return true;
    }
    if (lower === 'false' || lower === 'no' || lower === '0') {
      changes.push({ field: key, rule: 'boolean_coerce', from: value, to: false });
      return false;
    }
    return value;
  }

  // Number coercion
  if (schemaType === 'number' && typeof value === 'string') {
    const num = Number(value);
    if (!isNaN(num) && value.trim() !== '') {
      changes.push({ field: key, rule: 'number_coerce', from: value, to: num });
      return num;
    }
    return value;
  }

  // Enum case-insensitive matching
  if (schemaType === 'enum' && typeof value === 'string' && enumValues) {
    const match = enumValues.find(v => v.toLowerCase() === value.toLowerCase());
    if (match && match !== value) {
      changes.push({ field: key, rule: 'enum_case', from: value, to: match });
      return match;
    }
    return value;
  }

  return value;
}

export function coerceFields(
  fields: Record<string, unknown>,
  mergeResult: MergeResult,
  globalFields?: Record<string, GlobalFieldDefinition>,
  unknownFieldPolicy: UnknownFieldPolicy = 'warn',
): CoercionResult {
  const changes: CoercionChange[] = [];
  const unknownFields: string[] = [];

  // Step 1: Resolve aliases (camelCase → snake_case, known variations)
  const knownFieldNames = new Set([
    ...Object.keys(mergeResult.fields),
    ...Object.keys(globalFields ?? {}),
  ]);
  const { fields: aliasedFields, changes: aliasChanges } = resolveAliases(fields, knownFieldNames);
  changes.push(...aliasChanges);

  // Step 2: Coerce values using schema definitions with global fallback
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(aliasedFields)) {
    // Look up field definition: per-type schema first, then global
    const schemaDef = mergeResult.fields[key];
    const globalDef = globalFields?.[key];
    const fieldType = schemaDef?.type ?? globalDef?.type;
    const enumValues = schemaDef?.values ?? globalDef?.values;

    if (fieldType) {
      result[key] = coerceValue(key, value, fieldType, enumValues, changes);
    } else {
      // Unknown field — not in any schema or global definition
      unknownFields.push(key);
      if (unknownFieldPolicy !== 'strip') {
        result[key] = value;
      }
    }
  }

  return { fields: result, changes, unknownFields };
}
