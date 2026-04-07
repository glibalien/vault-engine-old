// src/sync/normalize-on-index.ts
import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/types.js';
import type { EnforcementConfig } from '../enforcement/types.js';
import type { GlobalFieldDefinition } from '../coercion/types.js';
import type { CoercionChange } from '../coercion/types.js';
import type { FrontmatterMutation } from '../serializer/patch.js';
import { resolveEnforcementPolicies } from '../enforcement/loader.js';
import { mergeSchemaFields } from '../schema/merger.js';
import { coerceFields } from '../coercion/coerce.js';
import { patchFrontmatter } from '../serializer/patch.js';
import { parseFile } from '../parser/index.js';

export interface NormalizeOnIndexResult {
  raw: string;
  parsed: ParsedFile;
  patched: boolean;
  warnings: string[];
}

function changeToWarning(change: CoercionChange): string {
  return `Field '${change.field}': ${change.rule} — '${String(change.from)}' → '${String(change.to)}'`;
}

function changesToMutations(changes: CoercionChange[]): FrontmatterMutation[] {
  const mutations: FrontmatterMutation[] = [];

  for (const change of changes) {
    switch (change.rule) {
      case 'alias_map':
        mutations.push({
          type: 'rename_key',
          from: change.from as string,
          to: change.to as string,
        });
        break;
      case 'scalar_to_list':
        mutations.push({
          type: 'coerce_value',
          key: change.field,
          targetType: 'list<string>',
        });
        break;
      case 'enum_case':
      case 'boolean_coerce':
      case 'number_coerce':
      case 'reference_wrap':
        mutations.push({
          type: 'set_value',
          key: change.field,
          value: change.to,
        });
        break;
      // date_normalize: no mutation needed (dates are handled by gray-matter)
    }
  }

  return mutations;
}

export function normalizeOnIndex(
  raw: string,
  parsed: ParsedFile,
  _absPath: string,
  relativePath: string,
  config: EnforcementConfig,
  globalFields: Record<string, GlobalFieldDefinition>,
  db: Database.Database,
): NormalizeOnIndexResult {
  const unchanged = { raw, parsed, patched: false, warnings: [] };

  // 1. No types → no normalization
  if (parsed.types.length === 0) return unchanged;

  // 2. Resolve enforcement policies
  const policies = resolveEnforcementPolicies(config, parsed.types);
  if (policies.normalizeOnIndex === 'off') return unchanged;

  // 3. Check if any type has a known schema
  const hasSchema = parsed.types.some(
    t => db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(t) != null,
  );
  if (!hasSchema) return unchanged;

  // 4. Merge field definitions for all types
  const mergeResult = mergeSchemaFields(db, parsed.types);

  // 5. Build fields record from parsed fields
  const fields: Record<string, unknown> = {};
  for (const entry of parsed.fields) {
    fields[entry.key] = entry.value;
  }

  // 6. Run coercion engine
  const coercionResult = coerceFields(fields, mergeResult, globalFields, {
    unknownFields: policies.unknownFields,
    enumValidation: policies.enumValidation,
  });

  // 7. No changes → return unchanged
  if (coercionResult.changes.length === 0) return unchanged;

  // 8. Warn mode: report changes but don't patch
  if (policies.normalizeOnIndex === 'warn') {
    return {
      raw,
      parsed,
      patched: false,
      warnings: coercionResult.changes.map(changeToWarning),
    };
  }

  // 9. Fix mode: convert changes to mutations, patch, and re-parse
  const mutations = changesToMutations(coercionResult.changes);
  const patchedRaw = patchFrontmatter(raw, mutations);
  const reParsed = parseFile(relativePath, patchedRaw);

  return {
    raw: patchedRaw,
    parsed: reParsed,
    patched: true,
    warnings: [],
  };
}
