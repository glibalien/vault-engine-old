# Schema Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `infer-schemas` MCP tool that analyzes indexed vault data, infers schema definitions, detects discrepancies against existing schemas, and optionally writes/merges YAML schema files.

**Architecture:** Pure SQL queries against the existing `fields`, `node_types`, and `schemas` tables, assembled in TypeScript into a structured analysis report. Three modes control output: `report` (analysis only), `merge` (expand existing schemas), `overwrite` (replace with inferred). A new `src/inference/` module with analyzer, generator, and types.

**Tech Stack:** TypeScript (ESM), better-sqlite3, yaml (v2, already a dependency), zod (validation), vitest (testing)

---

### Task 1: Inference Types

**Files:**
- Create: `src/inference/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/inference/types.ts
import type { SchemaFieldType } from '../schema/types.js';

export interface InferredField {
  key: string;
  inferred_type: SchemaFieldType;
  frequency: number;
  distinct_values: number;
  sample_values: string[];
  enum_candidate: boolean;
  enum_values?: string[];
}

export interface Discrepancy {
  field: string;
  issue: string;
  schema_value: unknown;
  inferred_value: unknown;
}

export interface TypeAnalysis {
  name: string;
  node_count: number;
  has_existing_schema: boolean;
  inferred_fields: InferredField[];
  discrepancies: Discrepancy[];
  shared_fields: string[];
}

export interface InferenceResult {
  types: TypeAnalysis[];
}

export type InferenceMode = 'report' | 'merge' | 'overwrite';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/inference/types.ts
git commit -m "feat: add inference types for schema inference tool"
```

---

### Task 2: Analyzer — Type Inference Logic

**Files:**
- Create: `tests/inference/analyzer.test.ts`
- Create: `src/inference/analyzer.ts`

- [ ] **Step 1: Write the failing test for `inferFieldType`**

Create `tests/inference/analyzer.test.ts`:

```typescript
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

  it('infers enum when ≤20 distinct values and ratio < 0.5', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: FAIL — module `../../src/inference/analyzer.js` not found

- [ ] **Step 3: Implement `inferFieldType`**

Create `src/inference/analyzer.ts`:

```typescript
// src/inference/analyzer.ts
import type Database from 'better-sqlite3';
import type { SchemaFieldType } from '../schema/types.js';
import type { InferredField, TypeAnalysis, Discrepancy, InferenceResult } from './types.js';

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
  nodeCount: number,
): Omit<InferredField, 'key' | 'frequency'> {
  const totalOccurrences = rows.reduce((sum, r) => sum + r.count, 0);
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

  // Priority 5: list — inspect elements
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

  // Priority 6: string containing [[ → reference (before enum check!)
  const refRows = rows.filter(r => r.value_type === 'string' && r.value_text.includes('[['));
  const refCount = refRows.reduce((s, r) => s + r.count, 0);
  if (refCount > maxCount / 2) {
    return { ...base, inferred_type: 'reference', enum_candidate: false };
  }

  // Priority 7: enum heuristic — ≤20 distinct, ratio < 0.5
  const stringRows = rows.filter(r => r.value_type === 'string');
  const stringDistinct = stringRows.length;
  const stringTotal = stringRows.reduce((s, r) => s + r.count, 0);
  if (stringDistinct <= 20 && stringTotal > 0 && stringDistinct / stringTotal < 0.5) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/inference/analyzer.ts tests/inference/analyzer.test.ts
git commit -m "feat: add inferFieldType with type inference priority logic"
```

---

### Task 3: Analyzer — `analyzeVault` Integration

**Files:**
- Modify: `tests/inference/analyzer.test.ts`
- Modify: `src/inference/analyzer.ts`

- [ ] **Step 1: Write failing tests for `analyzeVault`**

Append to `tests/inference/analyzer.test.ts`:

```typescript
import { beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { analyzeVault } from '../../src/inference/analyzer.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('analyzeVault', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndIndex(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('returns type analysis for all indexed types', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db);

    const taskAnalysis = result.types.find(t => t.name === 'task');
    expect(taskAnalysis).toBeDefined();
    expect(taskAnalysis!.node_count).toBe(1);
    expect(taskAnalysis!.has_existing_schema).toBe(false);

    const personAnalysis = result.types.find(t => t.name === 'person');
    expect(personAnalysis).toBeDefined();
    expect(personAnalysis!.node_count).toBe(1);
  });

  it('filters by types param', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db, ['task']);
    expect(result.types).toHaveLength(1);
    expect(result.types[0].name).toBe('task');
  });

  it('infers correct field types from indexed data', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;

    const assignee = task.inferred_fields.find(f => f.key === 'assignee');
    expect(assignee).toBeDefined();
    expect(assignee!.inferred_type).toBe('reference');

    const dueDate = task.inferred_fields.find(f => f.key === 'due_date');
    expect(dueDate).toBeDefined();
    expect(dueDate!.inferred_type).toBe('date');
  });

  it('computes frequency as fraction of nodes with the field', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-meeting.md', 'meetings/q1.md');

    const result = analyzeVault(db);
    // sample-meeting.md has types: [meeting, task]
    // So task type has 2 nodes: review.md and q1.md
    const task = result.types.find(t => t.name === 'task')!;
    expect(task.node_count).toBe(2);

    // 'source' field only exists on review.md, not q1.md
    const source = task.inferred_fields.find(f => f.key === 'source');
    expect(source).toBeDefined();
    expect(source!.frequency).toBe(0.5);
  });

  it('detects list<reference> for attendees field', () => {
    loadAndIndex('sample-meeting.md', 'meetings/q1.md');

    const result = analyzeVault(db);
    const meeting = result.types.find(t => t.name === 'meeting')!;
    const attendees = meeting.inferred_fields.find(f => f.key === 'attendees');
    expect(attendees).toBeDefined();
    expect(attendees!.inferred_type).toBe('list<reference>');
  });

  it('detects list<string> for tags field', () => {
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = analyzeVault(db);
    const person = result.types.find(t => t.name === 'person')!;
    const tags = person.inferred_fields.find(f => f.key === 'tags');
    expect(tags).toBeDefined();
    expect(tags!.inferred_type).toBe('list<string>');
  });

  it('detects discrepancies against existing schemas', () => {
    loadSchemas(db, fixturesDir);
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = analyzeVault(db);
    const task = result.types.find(t => t.name === 'task')!;
    expect(task.has_existing_schema).toBe(true);

    // 'source' field exists in data but not in task schema
    const sourceDisc = task.discrepancies.find(d => d.field === 'source');
    expect(sourceDisc).toBeDefined();
    expect(sourceDisc!.issue).toContain('not defined in schema');
  });

  it('detects shared fields across types', () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-meeting.md', 'meetings/q1.md');

    const result = analyzeVault(db);
    // Both task and meeting types have 'status' field (from sample-meeting which has types: [meeting, task])
    // But meeting gets status from sample-meeting.md, task gets it from both
    // 'status' and 'assignee' and 'due_date' appear in both task and meeting types
    const task = result.types.find(t => t.name === 'task')!;
    const meeting = result.types.find(t => t.name === 'meeting')!;

    // status appears in both with same inferred type
    expect(task.shared_fields).toContain('status');
    expect(meeting.shared_fields).toContain('status');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: FAIL — `analyzeVault` not exported

- [ ] **Step 3: Implement `analyzeVault`**

Add to `src/inference/analyzer.ts`:

```typescript
import { getAllSchemas } from '../schema/loader.js';
import type { ResolvedSchema } from '../schema/types.js';

interface FieldProfileRow {
  key: string;
  value_type: string;
  value_text: string;
  cnt: number;
}

export function analyzeVault(db: Database.Database, types?: string[]): InferenceResult {
  // Query 1: type counts
  let typeSql = 'SELECT schema_type, COUNT(*) AS count FROM node_types';
  const typeParams: string[] = [];
  if (types && types.length > 0) {
    typeSql += ` WHERE schema_type IN (${types.map(() => '?').join(',')})`;
    typeParams.push(...types);
  }
  typeSql += ' GROUP BY schema_type ORDER BY schema_type';
  const typeCounts = db.prepare(typeSql).all(...typeParams) as Array<{
    schema_type: string;
    count: number;
  }>;

  // Query 3: existing schemas
  const existingSchemas = new Map<string, ResolvedSchema>();
  for (const schema of getAllSchemas(db)) {
    existingSchemas.set(schema.name, schema);
  }

  // For each type, build field profiles
  const typeAnalyses: TypeAnalysis[] = [];

  for (const { schema_type, count: nodeCount } of typeCounts) {
    // Query 2: field profiles for this type
    const fieldRows = db.prepare(`
      SELECT f.key, f.value_type, f.value_text, COUNT(*) AS cnt
      FROM fields f
      JOIN node_types nt ON nt.node_id = f.node_id
      WHERE nt.schema_type = ?
      GROUP BY f.key, f.value_type, f.value_text
      ORDER BY f.key, cnt DESC
    `).all(schema_type) as FieldProfileRow[];

    // Group by key
    const fieldsByKey = new Map<string, FieldRow[]>();
    for (const row of fieldRows) {
      const group = fieldsByKey.get(row.key) ?? [];
      group.push({ value_type: row.value_type, value_text: row.value_text, count: row.cnt });
      fieldsByKey.set(row.key, group);
    }

    // Count how many nodes of this type have each field
    const fieldNodeCounts = db.prepare(`
      SELECT f.key, COUNT(DISTINCT f.node_id) AS node_count
      FROM fields f
      JOIN node_types nt ON nt.node_id = f.node_id
      WHERE nt.schema_type = ?
      GROUP BY f.key
    `).all(schema_type) as Array<{ key: string; node_count: number }>;
    const fieldFreqMap = new Map(fieldNodeCounts.map(r => [r.key, r.node_count]));

    // Infer each field
    const inferredFields: InferredField[] = [];
    for (const [key, rows] of fieldsByKey) {
      const inferred = inferFieldType(rows, nodeCount);
      const fieldNodeCount = fieldFreqMap.get(key) ?? 0;
      inferredFields.push({
        key,
        frequency: nodeCount > 0 ? fieldNodeCount / nodeCount : 0,
        ...inferred,
      });
    }

    // Discrepancy detection
    const discrepancies: Discrepancy[] = [];
    const existingSchema = existingSchemas.get(schema_type);
    const hasExistingSchema = !!existingSchema;

    if (existingSchema) {
      const schemaFieldNames = new Set(Object.keys(existingSchema.fields));
      const inferredFieldNames = new Set(inferredFields.map(f => f.key));

      // Fields in data but not in schema
      for (const field of inferredFields) {
        if (!schemaFieldNames.has(field.key)) {
          discrepancies.push({
            field: field.key,
            issue: `field '${field.key}' exists in ${Math.round(field.frequency * 100)}% of nodes but is not defined in schema`,
            schema_value: null,
            inferred_value: field.inferred_type,
          });
        }
      }

      // Fields in schema but not in data
      for (const [name, def] of Object.entries(existingSchema.fields)) {
        if (!inferredFieldNames.has(name)) {
          discrepancies.push({
            field: name,
            issue: `field '${name}' defined in schema but not found in any node`,
            schema_value: def.type,
            inferred_value: null,
          });
        }
      }

      // Type mismatches and enum value differences
      for (const field of inferredFields) {
        const schemaDef = existingSchema.fields[field.key];
        if (!schemaDef) continue;

        // Type mismatch
        if (schemaDef.type !== field.inferred_type) {
          discrepancies.push({
            field: field.key,
            issue: `schema defines '${field.key}' as '${schemaDef.type}' but data suggests '${field.inferred_type}'`,
            schema_value: schemaDef.type,
            inferred_value: field.inferred_type,
          });
        }

        // Enum value differences
        if (schemaDef.type === 'enum' && schemaDef.values && field.enum_values) {
          const schemaValues = new Set(schemaDef.values);
          const inferredValues = new Set(field.enum_values);

          for (const v of inferredValues) {
            if (!schemaValues.has(v)) {
              discrepancies.push({
                field: field.key,
                issue: `value '${v}' appears in data but is not in schema 'values' list for '${field.key}'`,
                schema_value: schemaDef.values,
                inferred_value: v,
              });
            }
          }

          for (const v of schemaValues) {
            if (!inferredValues.has(v)) {
              discrepancies.push({
                field: field.key,
                issue: `schema defines value '${v}' for '${field.key}' but it never appears in data`,
                schema_value: v,
                inferred_value: field.enum_values,
              });
            }
          }
        }
      }
    }

    typeAnalyses.push({
      name: schema_type,
      node_count: nodeCount,
      has_existing_schema: hasExistingSchema,
      inferred_fields: inferredFields,
      discrepancies,
      shared_fields: [], // populated after all types analyzed
    });
  }

  // Shared field detection
  const fieldTypeMap = new Map<string, Map<string, SchemaFieldType>>();
  for (const analysis of typeAnalyses) {
    for (const field of analysis.inferred_fields) {
      const types = fieldTypeMap.get(field.key) ?? new Map();
      types.set(analysis.name, field.inferred_type);
      fieldTypeMap.set(field.key, types);
    }
  }

  for (const analysis of typeAnalyses) {
    for (const field of analysis.inferred_fields) {
      const types = fieldTypeMap.get(field.key);
      if (!types || types.size < 2) continue;
      // Check all types agree on the inferred_type
      const inferredTypes = new Set(types.values());
      if (inferredTypes.size === 1) {
        analysis.shared_fields.push(field.key);
      }
    }
  }

  return { types: typeAnalyses };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inference/analyzer.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/inference/analyzer.ts tests/inference/analyzer.test.ts
git commit -m "feat: add analyzeVault with field profiling, discrepancy detection, shared fields"
```

---

### Task 4: Generator — Schema Generation & YAML Writing

**Files:**
- Create: `tests/inference/generator.test.ts`
- Create: `src/inference/generator.ts`

- [ ] **Step 1: Write failing tests for `generateSchemas` and `writeSchemaFiles`**

Create `tests/inference/generator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inference/generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `generateSchemas` and `writeSchemaFiles`**

Create `src/inference/generator.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/inference/generator.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/inference/generator.ts tests/inference/generator.test.ts
git commit -m "feat: add schema generation and YAML writing for merge/overwrite modes"
```

---

### Task 5: Inference Module Index

**Files:**
- Create: `src/inference/index.ts`

- [ ] **Step 1: Create the index file**

```typescript
// src/inference/index.ts
export type {
  InferredField,
  Discrepancy,
  TypeAnalysis,
  InferenceResult,
  InferenceMode,
} from './types.js';

export { analyzeVault } from './analyzer.js';
export { generateSchemas, writeSchemaFiles } from './generator.js';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/inference/index.ts
git commit -m "feat: add inference module index with re-exports"
```

---

### Task 6: MCP Tool Registration

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/infer-schemas.test.ts`

- [ ] **Step 1: Write failing test for the `infer-schemas` MCP tool**

Create `tests/mcp/infer-schemas.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('infer-schemas MCP tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-infer-'));

    const server = createServer(db, tmpDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadAndIndex(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  async function callTool(toolName: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name: toolName, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns analysis in report mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');
    loadAndIndex('sample-person.md', 'people/alice.md');

    const result = await callTool('infer-schemas', {});

    expect(result.types).toBeDefined();
    expect(result.types.length).toBeGreaterThanOrEqual(2);

    const task = result.types.find((t: any) => t.name === 'task');
    expect(task).toBeDefined();
    expect(task.node_count).toBe(1);
    expect(task.inferred_fields.length).toBeGreaterThan(0);
    expect(result.files_written).toBeUndefined();
  });

  it('writes schema files in overwrite mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = await callTool('infer-schemas', { mode: 'overwrite' });

    expect(result.files_written).toBeDefined();
    expect(result.files_written.length).toBeGreaterThan(0);
    expect(result.files_written[0]).toMatch(/\.schemas\//);
  });

  it('returns error for empty vault', async () => {
    const result = await callTool('infer-schemas', {});
    expect(result.error).toBeDefined();
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('returns error for unknown type filter', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    const result = await callTool('infer-schemas', { types: ['nonexistent'] });
    expect(result.error).toBeDefined();
    expect(result.code).toBe('NOT_FOUND');
  });

  it('reloads schemas after writing in merge mode', async () => {
    loadAndIndex('sample-task.md', 'tasks/review.md');

    await callTool('infer-schemas', { mode: 'merge' });

    // Schemas should be loaded into DB now
    const schemas = db.prepare('SELECT name FROM schemas ORDER BY name').all() as Array<{ name: string }>;
    expect(schemas.some(s => s.name === 'task')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/infer-schemas.test.ts`
Expected: FAIL — `infer-schemas` tool not registered

- [ ] **Step 3: Register the `infer-schemas` tool in `server.ts`**

Add these imports to the top of `src/mcp/server.ts`:

```typescript
import { analyzeVault } from '../inference/analyzer.js';
import { generateSchemas, writeSchemaFiles } from '../inference/generator.js';
import type { InferenceMode } from '../inference/types.js';
```

Add the tool registration inside `createServer`, after the existing tool registrations:

```typescript
  // ── infer-schemas ──────────────────────────────────────────────
  server.tool(
    'infer-schemas',
    'Analyze indexed vault data and infer schema definitions. Detects field types, enum candidates, discrepancies against existing schemas, and shared fields across types. Modes: report (default, analysis only), merge (expand existing schemas), overwrite (replace with inferred).',
    {
      mode: z.enum(['report', 'merge', 'overwrite']).default('report')
        .describe('report = analysis only; merge = expand existing schemas; overwrite = replace entirely'),
      types: z.array(z.string().min(1)).optional()
        .describe('Limit analysis to specific types. Omit to analyze all.'),
    },
    async ({ mode, types }) => {
      const analysis = analyzeVault(db, types);

      if (analysis.types.length === 0) {
        if (types && types.length > 0) {
          return toolError(
            `Type '${types.find(t => !analysis.types.some(a => a.name === t)) ?? types[0]}' not found in indexed data.`,
            'NOT_FOUND',
          );
        }
        return toolError('No indexed nodes found. Run incremental index first.', 'VALIDATION_ERROR');
      }

      // Check that all requested types were found
      if (types) {
        const foundNames = new Set(analysis.types.map(t => t.name));
        const missing = types.find(t => !foundNames.has(t));
        if (missing) {
          return toolError(`Type '${missing}' not found in indexed data.`, 'NOT_FOUND');
        }
      }

      const response: Record<string, unknown> = { types: analysis.types };

      if (mode !== 'report') {
        const existingSchemas = new Map(
          getAllSchemas(db).map(s => [s.name, s]),
        );
        const schemas = generateSchemas(analysis, mode as InferenceMode, existingSchemas);
        const filesWritten = writeSchemaFiles(schemas, vaultPath);

        // Reload schemas into DB so changes take effect immediately
        loadSchemas(db, vaultPath);

        response.files_written = filesWritten;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      };
    },
  );
```

Add `loadSchemas` to the existing import from `'../schema/loader.js'` if not already imported (it is — `getAllSchemas` and `getSchema` are already imported, `loadSchemas` needs to be added):

Check the existing import line and add `loadSchemas`:

```typescript
import { getAllSchemas, getSchema, loadSchemas } from '../schema/loader.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/infer-schemas.test.ts`
Expected: tests pass (note: the `callTool` helper may need adjustment based on how `McpServer` exposes handlers — if the internal API differs, adapt the test to use the `analyzeVault` + `generateSchemas` functions directly and test the handler logic separately)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/infer-schemas.test.ts
git commit -m "feat: register infer-schemas MCP tool with report/merge/overwrite modes"
```

---

### Task 7: CLAUDE.md & Enhancements Doc Update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `vault-engine-enhancements.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to the MCP Layer section in CLAUDE.md, updating the tool count from 19 to 20 and adding the `infer-schemas` tool description:

In the MCP Layer description, change "19 tools" to "20 tools" and add:
```
  - **`infer-schemas`** — Analyzes indexed vault data to infer schema definitions. Reports field types, frequencies, enum candidates, discrepancies against existing schemas, and shared fields across types. Three modes: report (analysis only), merge (expand existing schemas with inferred data), overwrite (replace schemas entirely).
```

Add to the Architecture section under a new "Inference Layer" heading:
```
### Inference Layer (`src/inference/`)

Schema inference from indexed vault data.

- **`types.ts`** — `InferredField`, `TypeAnalysis`, `Discrepancy`, `InferenceResult`, `InferenceMode`.
- **`analyzer.ts`** — `analyzeVault(db, types?)` queries `fields` + `node_types` tables, infers `SchemaFieldType` per field with priority-ordered type detection (reference > date > number > boolean > list > string-ref > enum > string), detects discrepancies against existing schemas, identifies shared fields across types.
- **`generator.ts`** — `generateSchemas(analysis, mode, existingSchemas)` produces `SchemaDefinition[]` based on mode. `writeSchemaFiles(schemas, vaultPath)` serializes to `.schemas/*.yaml`. Merge mode preserves existing fields/properties and unions enum values. Overwrite mode produces clean schemas from data.
- **`index.ts`** — Re-exports all types and functions.
```

- [ ] **Step 2: Update enhancements doc**

In `vault-engine-enhancements.md`, update Enhancement #1 to show it's complete. Add a note at the top of the section:

```
**Status:** COMPLETE
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md vault-engine-enhancements.md
git commit -m "docs: update CLAUDE.md and enhancements doc for schema inference"
```
