// src/coercion/aliases.ts
import type { CoercionChange } from './types.js';

/**
 * Convert camelCase or PascalCase to snake_case.
 * e.g. "dueDate" → "due_date", "assignedTo" → "assigned_to"
 */
function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Convert snake_case to space-separated form for matching against
 * canonical names that use spaces. e.g. "people_involved" → "people involved"
 */
function snakeToSpaces(str: string): string {
  return str.replace(/_/g, ' ');
}

/**
 * Resolve field name aliases to canonical names.
 * Tries these strategies in order:
 * 1. Exact match against known field names — no change needed
 * 2. Case-insensitive match (e.g. "Status" → "status")
 * 3. camelCase/PascalCase → snake_case conversion (e.g. "dueDate" → "due_date")
 * 4. snake_case → space-separated (e.g. "people_involved" → "people involved")
 */
export function resolveAliases(
  fields: Record<string, unknown>,
  knownFieldNames: Set<string>,
): { fields: Record<string, unknown>; changes: CoercionChange[] } {
  const result: Record<string, unknown> = {};
  const changes: CoercionChange[] = [];

  // Build lookup maps for case-insensitive and variant matching
  const lowerMap = new Map<string, string>();
  const snakeMap = new Map<string, string>();
  const spacedMap = new Map<string, string>();
  for (const name of knownFieldNames) {
    lowerMap.set(name.toLowerCase(), name);
    snakeMap.set(toSnakeCase(name), name);
    spacedMap.set(snakeToSpaces(name).toLowerCase(), name);
  }

  for (const [key, value] of Object.entries(fields)) {
    // 1. Exact match
    if (knownFieldNames.has(key)) {
      result[key] = value;
      continue;
    }

    // 2. Case-insensitive match
    const lowerMatch = lowerMap.get(key.toLowerCase());
    if (lowerMatch) {
      changes.push({ field: key, rule: 'alias_map', from: key, to: lowerMatch });
      result[lowerMatch] = value;
      continue;
    }

    // 3. camelCase → snake_case
    const snake = toSnakeCase(key);
    if (snake !== key) {
      const snakeMatch = lowerMap.get(snake);
      if (snakeMatch) {
        changes.push({ field: key, rule: 'alias_map', from: key, to: snakeMatch });
        result[snakeMatch] = value;
        continue;
      }
    }

    // 4. snake_case → space-separated
    const spaced = snakeToSpaces(key).toLowerCase();
    const spacedMatch = spacedMap.get(spaced);
    if (spacedMatch && spacedMatch !== key) {
      changes.push({ field: key, rule: 'alias_map', from: key, to: spacedMatch });
      result[spacedMatch] = value;
      continue;
    }

    // No match — pass through as-is
    result[key] = value;
  }

  return { fields: result, changes };
}
