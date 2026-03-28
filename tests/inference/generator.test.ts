import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { generateSchemas, writeSchemaFiles } from '../../src/inference/generator.js';
import type { InferenceResult } from '../../src/inference/types.js';
import type { ResolvedSchema } from '../../src/schema/types.js';

function makeAnalysis(): InferenceResult {
  return {
    types: [
      {
        name: 'task',
        node_count: 10,
        has_existing_schema: false,
        inferred_template: null,
        inferred_fields: [
          {
            key: 'status',
            inferred_type: 'enum',
            frequency: 1.0,
            distinct_values: 3,
            sample_values: ['todo', 'done', 'in-progress'],
            enum_candidate: true,
            enum_values: ['todo', 'done', 'in-progress'],
          },
          {
            key: 'assignee',
            inferred_type: 'reference',
            frequency: 0.8,
            distinct_values: 4,
            sample_values: ['[[Alice]]', '[[Bob]]'],
            enum_candidate: false,
          },
          {
            key: 'due_date',
            inferred_type: 'date',
            frequency: 0.7,
            distinct_values: 8,
            sample_values: ['2025-03-10'],
            enum_candidate: false,
          },
        ],
        discrepancies: [],
        shared_fields: ['status'],
      },
    ],
  };
}

describe('generateSchemas', () => {
  it('returns empty array for report mode', () => {
    const result = generateSchemas(makeAnalysis(), 'report', new Map());
    expect(result).toEqual([]);
  });

  it('generates fresh schema for type with no existing schema (overwrite)', () => {
    const result = generateSchemas(makeAnalysis(), 'overwrite', new Map());
    expect(result).toHaveLength(1);
    const schema = result[0];
    expect(schema.name).toBe('task');
    expect(schema.display_name).toBe('Task');
    expect(schema.fields.status.type).toBe('enum');
    expect(schema.fields.status.values).toEqual(['todo', 'done', 'in-progress']);
    expect(schema.fields.assignee.type).toBe('reference');
    expect(schema.fields.due_date.type).toBe('date');
    // Should not have required, default, target_schema
    expect(schema.fields.status.required).toBeUndefined();
    expect(schema.fields.status.default).toBeUndefined();
    expect(schema.fields.assignee.target_schema).toBeUndefined();
  });

  it('generates fresh schema for merge mode with no existing schema', () => {
    const result = generateSchemas(makeAnalysis(), 'merge', new Map());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('task');
  });

  it('merges inferred fields into existing schema (merge mode)', () => {
    const existing: ResolvedSchema = {
      name: 'task',
      ancestors: [],
      fields: {
        status: { type: 'enum', values: ['todo', 'done'], required: true, default: 'todo' },
        priority: { type: 'enum', values: ['high', 'low'] },
      },
      serialization: { filename_template: 'tasks/{{title}}.md' },
    };

    const analysis = makeAnalysis();
    analysis.types[0].has_existing_schema = true;

    const result = generateSchemas(analysis, 'merge', new Map([['task', existing]]));
    expect(result).toHaveLength(1);

    const schema = result[0];
    // Existing fields preserved with their properties
    expect(schema.fields.status.required).toBe(true);
    expect(schema.fields.status.default).toBe('todo');
    // Enum values unioned
    expect(schema.fields.status.values).toContain('todo');
    expect(schema.fields.status.values).toContain('done');
    expect(schema.fields.status.values).toContain('in-progress');
    // Existing field not in inferred data preserved
    expect(schema.fields.priority).toBeDefined();
    // New inferred fields added
    expect(schema.fields.assignee).toBeDefined();
    expect(schema.fields.assignee.type).toBe('reference');
    expect(schema.fields.due_date).toBeDefined();
    // Serialization preserved
    expect(schema.serialization?.filename_template).toBe('tasks/{{title}}.md');
  });

  it('replaces existing schema entirely in overwrite mode', () => {
    const existing: ResolvedSchema = {
      name: 'task',
      ancestors: [],
      fields: {
        priority: { type: 'enum', values: ['high', 'low'] },
      },
      serialization: { filename_template: 'tasks/{{title}}.md' },
      computed: { task_count: { aggregate: 'count', filter: { types_includes: 'task' } } },
    };

    const analysis = makeAnalysis();
    analysis.types[0].has_existing_schema = true;

    const result = generateSchemas(analysis, 'overwrite', new Map([['task', existing]]));
    expect(result).toHaveLength(1);

    const schema = result[0];
    // priority NOT present (not in inferred data)
    expect(schema.fields.priority).toBeUndefined();
    // serialization and computed dropped
    expect(schema.serialization).toBeUndefined();
    expect(schema.computed).toBeUndefined();
    // Only inferred fields present
    expect(schema.fields.status).toBeDefined();
    expect(schema.fields.assignee).toBeDefined();
    expect(schema.fields.due_date).toBeDefined();
  });

  it('generates title-cased display_name from type name', () => {
    const analysis = makeAnalysis();
    analysis.types[0].name = 'work-task';
    const result = generateSchemas(analysis, 'overwrite', new Map());
    expect(result[0].display_name).toBe('Work Task');
  });
});

describe('writeSchemaFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-inference-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes YAML files to .schemas/ directory', () => {
    const schemas = generateSchemas(makeAnalysis(), 'overwrite', new Map());
    const written = writeSchemaFiles(schemas, tmpDir);

    expect(written).toEqual(['.schemas/task.yaml']);
    const content = readFileSync(join(tmpDir, '.schemas', 'task.yaml'), 'utf-8');
    const parsed = parseYaml(content);
    expect(parsed.name).toBe('task');
    expect(parsed.fields.status.type).toBe('enum');
  });

  it('creates .schemas/ directory if it does not exist', () => {
    const schemas = generateSchemas(makeAnalysis(), 'overwrite', new Map());
    writeSchemaFiles(schemas, tmpDir);
    expect(existsSync(join(tmpDir, '.schemas'))).toBe(true);
  });
});
