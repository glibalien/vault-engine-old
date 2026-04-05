// src/coercion/globals.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GlobalFieldDefinition, GlobalFieldsConfig } from './types.js';

/**
 * Load global field definitions from .schemas/_global.yaml.
 * Returns an empty record if the file doesn't exist.
 */
export function loadGlobalFields(vaultPath: string): Record<string, GlobalFieldDefinition> {
  const globalPath = join(vaultPath, '.schemas', '_global.yaml');
  if (!existsSync(globalPath)) return {};

  const raw = readFileSync(globalPath, 'utf-8');
  const parsed = parseYaml(raw) as GlobalFieldsConfig | null;

  if (!parsed?.global_fields || typeof parsed.global_fields !== 'object') return {};

  // Expand canonical_name entries: if a field has canonical_name,
  // register it under that name so alias resolution can find it.
  const result: Record<string, GlobalFieldDefinition> = {};
  for (const [key, def] of Object.entries(parsed.global_fields)) {
    const canonicalName = def.canonical_name ?? key;
    result[canonicalName] = def;
    // Also register the YAML key so alias resolution maps it
    if (canonicalName !== key) {
      result[key] = def;
    }
  }

  return result;
}
