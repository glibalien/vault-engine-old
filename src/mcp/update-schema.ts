// src/mcp/update-schema.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadSchemas, getSchema } from '../schema/loader.js';
import type { SchemaDefinition, FieldDefinition, ResolvedSchema, SchemaFieldType } from '../schema/types.js';
import type Database from 'better-sqlite3';

const VALID_FIELD_TYPES: ReadonlySet<string> = new Set<SchemaFieldType>([
  'string', 'number', 'date', 'boolean', 'enum', 'reference',
  'list<string>', 'list<reference>',
]);

export interface SchemaOperation {
  action: 'add_field' | 'remove_field' | 'rename_field' | 'update_field' | 'set_metadata';
  field?: string;
  definition?: Partial<FieldDefinition>;
  new_name?: string;
  key?: string;
  value?: unknown;
}

export interface UpdateSchemaResult {
  schema: ResolvedSchema;
  file_path: string;
  operations_applied: number;
  warnings: string[];
}

export function updateSchema(
  db: Database.Database,
  vaultPath: string,
  schemaName: string,
  operations: SchemaOperation[],
): UpdateSchemaResult {
  const schemasDir = join(vaultPath, '.schemas');
  const filePath = join(schemasDir, `${schemaName}.yaml`);
  const relPath = join('.schemas', `${schemaName}.yaml`);
  const warnings: string[] = [];

  // Read current schema from disk (or start fresh)
  let schema: SchemaDefinition;
  let snapshot: string | null = null;

  if (existsSync(filePath)) {
    snapshot = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(snapshot);
    schema = {
      name: parsed.name ?? schemaName,
      display_name: parsed.display_name,
      icon: parsed.icon,
      extends: parsed.extends,
      fields: parsed.fields ?? {},
      serialization: parsed.serialization,
      computed: parsed.computed,
    };
  } else {
    schema = { name: schemaName, fields: {} };
  }

  // Apply all operations to in-memory copy
  for (const op of operations) {
    applyOperation(schema, op, schemaName);
  }

  // Validate final result
  validateSchema(schema, vaultPath);

  // Write to disk
  mkdirSync(schemasDir, { recursive: true });
  const yamlContent = stringifyYaml(schema, { lineWidth: 0 });
  writeFileSync(filePath, yamlContent, 'utf-8');

  // Reload schemas — rollback on failure
  try {
    loadSchemas(db, vaultPath);
  } catch (err) {
    // Restore snapshot
    if (snapshot !== null) {
      writeFileSync(filePath, snapshot, 'utf-8');
    } else {
      unlinkSync(filePath);
    }
    // Re-reload with original state
    try {
      loadSchemas(db, vaultPath);
    } catch {
      /* best effort */
    }
    throw new Error(
      `Schema reload failed after writing '${relPath}': ${err instanceof Error ? err.message : String(err)}. ` +
      'File has been rolled back to its previous state.',
    );
  }

  const resolved = getSchema(db, schemaName)!;
  return {
    schema: resolved,
    file_path: relPath,
    operations_applied: operations.length,
    warnings,
  };
}

function applyOperation(
  schema: SchemaDefinition,
  op: SchemaOperation,
  schemaName: string,
): void {
  switch (op.action) {
    case 'add_field': {
      if (!op.field) throw new Error("add_field requires 'field'");
      if (!op.definition) throw new Error("add_field requires 'definition'");
      if (schema.fields[op.field]) {
        throw new Error(`Field '${op.field}' already exists in schema '${schemaName}'`);
      }
      schema.fields[op.field] = op.definition as FieldDefinition;
      break;
    }
    case 'remove_field': {
      if (!op.field) throw new Error("remove_field requires 'field'");
      if (!schema.fields[op.field]) {
        throw new Error(`Field '${op.field}' does not exist in schema '${schemaName}'`);
      }
      delete schema.fields[op.field];
      break;
    }
    case 'rename_field': {
      if (!op.field) throw new Error("rename_field requires 'field'");
      if (!op.new_name) throw new Error("rename_field requires 'new_name'");
      if (!schema.fields[op.field]) {
        throw new Error(`Field '${op.field}' does not exist in schema '${schemaName}'`);
      }
      if (schema.fields[op.new_name]) {
        throw new Error(
          `Cannot rename '${op.field}' to '${op.new_name}': field '${op.new_name}' already exists in schema '${schemaName}'`,
        );
      }
      // Preserve field ordering by rebuilding the fields object
      const newFields: Record<string, FieldDefinition> = {};
      for (const [key, def] of Object.entries(schema.fields)) {
        if (key === op.field) {
          newFields[op.new_name] = def;
        } else {
          newFields[key] = def;
        }
      }
      schema.fields = newFields;
      break;
    }
    case 'update_field': {
      if (!op.field) throw new Error("update_field requires 'field'");
      if (!op.definition) throw new Error("update_field requires 'definition'");
      if (!schema.fields[op.field]) {
        throw new Error(`Field '${op.field}' does not exist in schema '${schemaName}'`);
      }
      schema.fields[op.field] = { ...schema.fields[op.field], ...op.definition } as FieldDefinition;
      break;
    }
    case 'set_metadata': {
      if (!op.key) throw new Error("set_metadata requires 'key'");
      const ALLOWED_KEYS = new Set(['display_name', 'icon', 'extends', 'serialization']);
      if (!ALLOWED_KEYS.has(op.key)) {
        throw new Error(
          `Unsupported metadata key '${op.key}'. Allowed keys: ${[...ALLOWED_KEYS].join(', ')}`,
        );
      }
      (schema as unknown as Record<string, unknown>)[op.key] = op.value;
      break;
    }
    default:
      throw new Error(`Unknown action: ${op.action}`);
  }
}

function validateSchema(schema: SchemaDefinition, vaultPath: string): void {
  for (const [name, def] of Object.entries(schema.fields)) {
    if (!VALID_FIELD_TYPES.has(def.type)) {
      throw new Error(
        `Invalid field type '${def.type}' for field '${name}'. ` +
        `Valid types: ${[...VALID_FIELD_TYPES].join(', ')}`,
      );
    }
    if (def.type === 'enum' && (!def.values || def.values.length === 0)) {
      throw new Error(
        `Enum field '${name}' requires a non-empty 'values' array`,
      );
    }
  }

  if (schema.extends) {
    const parentPath = join(vaultPath, '.schemas', `${schema.extends}.yaml`);
    if (!existsSync(parentPath)) {
      throw new Error(
        `Cannot set extends to '${schema.extends}': no schema file found at .schemas/${schema.extends}.yaml. ` +
        'Create the parent schema first, then extend from it.',
      );
    }
  }
}
