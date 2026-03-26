// src/inference/generator.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SchemaDefinition, FieldDefinition, ResolvedSchema } from '../schema/types.js';
import type { InferenceResult, InferenceMode } from './types.js';

function titleCase(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function buildFreshSchema(name: string, inferredFields: InferenceResult['types'][0]['inferred_fields']): SchemaDefinition {
  const fields: Record<string, FieldDefinition> = {};
  for (const field of inferredFields) {
    const def: FieldDefinition = { type: field.inferred_type };
    if (field.inferred_type === 'enum' && field.enum_values) {
      def.values = [...field.enum_values];
    }
    fields[field.key] = def;
  }

  return {
    name,
    display_name: titleCase(name),
    fields,
  };
}

function mergeSchema(
  existing: ResolvedSchema,
  inferredFields: InferenceResult['types'][0]['inferred_fields'],
): SchemaDefinition {
  const fields: Record<string, FieldDefinition> = {};

  // Start with all existing fields (preserving their full definitions)
  for (const [key, def] of Object.entries(existing.fields)) {
    fields[key] = { ...def };
  }

  // Add inferred fields that don't already exist, and union enum values
  for (const field of inferredFields) {
    if (fields[field.key]) {
      // Field exists — only merge enum values
      const existingDef = fields[field.key];
      if (existingDef.type === 'enum' && existingDef.values && field.enum_values) {
        const merged = new Set([...existingDef.values, ...field.enum_values]);
        existingDef.values = [...merged];
      }
    } else {
      // New field — add it
      const def: FieldDefinition = { type: field.inferred_type };
      if (field.inferred_type === 'enum' && field.enum_values) {
        def.values = [...field.enum_values];
      }
      fields[field.key] = def;
    }
  }

  const schema: SchemaDefinition = {
    name: existing.name,
    display_name: existing.display_name ?? titleCase(existing.name),
    fields,
  };

  // Preserve existing properties
  if (existing.icon) schema.icon = existing.icon;
  if (existing.extends) schema.extends = existing.extends;
  if (existing.serialization) schema.serialization = existing.serialization;
  if (existing.computed) schema.computed = existing.computed;

  return schema;
}

export function generateSchemas(
  analysis: InferenceResult,
  mode: InferenceMode,
  existingSchemas: Map<string, ResolvedSchema>,
): SchemaDefinition[] {
  if (mode === 'report') return [];

  const schemas: SchemaDefinition[] = [];

  for (const typeAnalysis of analysis.types) {
    if (mode === 'merge' && typeAnalysis.has_existing_schema) {
      const existing = existingSchemas.get(typeAnalysis.name);
      if (existing) {
        schemas.push(mergeSchema(existing, typeAnalysis.inferred_fields));
        continue;
      }
    }

    // overwrite mode, or merge with no existing schema — build fresh
    schemas.push(buildFreshSchema(typeAnalysis.name, typeAnalysis.inferred_fields));
  }

  return schemas;
}

export function writeSchemaFiles(schemas: SchemaDefinition[], vaultPath: string): string[] {
  const schemasDir = join(vaultPath, '.schemas');
  mkdirSync(schemasDir, { recursive: true });

  const written: string[] = [];

  for (const schema of schemas) {
    const filename = `${schema.name}.yaml`;
    const absPath = join(schemasDir, filename);
    const yamlContent = stringifyYaml(schema, { lineWidth: 0 });
    writeFileSync(absPath, yamlContent, 'utf-8');
    written.push(join('.schemas', filename));
  }

  return written;
}
