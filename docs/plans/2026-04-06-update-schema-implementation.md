# Update Schema Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `update-schema` MCP tool that performs direct, surgical modifications to `.schemas/*.yaml` schema definition files.

**Architecture:** Core logic in `src/mcp/update-schema.ts` (read YAML → apply operations → validate → write → reload). Tool registration in `server.ts`. Tests use the MCP client/server in-memory transport pattern established by `infer-schemas.test.ts`.

**Tech Stack:** `yaml` (stringify), `better-sqlite3`, `zod`, `vitest`, `@modelcontextprotocol/sdk`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/mcp/update-schema.ts` | Core logic: `updateSchema()` function — reads YAML, applies operations, validates, writes, reloads |
| Modify | `src/mcp/server.ts` | Register `update-schema` tool, import and call `updateSchema()` |
| Create | `tests/mcp/update-schema.test.ts` | All tests for the update-schema tool |

---

### Task 1: Core `updateSchema` function — add_field operation

**Files:**
- Create: `tests/mcp/update-schema.test.ts`
- Create: `src/mcp/update-schema.ts`

- [ ] **Step 1: Write the failing test — add_field to an existing schema**

```typescript
// tests/mcp/update-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema } from '../../src/schema/loader.js';
import { updateSchema } from '../../src/mcp/update-schema.js';

describe('updateSchema', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-update-schema-'));

    // Create a base task schema
    const schemasDir = join(tmpDir, '.schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'task.yaml'),
      [
        'name: task',
        'display_name: Task',
        'icon: check',
        'fields:',
        '  status:',
        '    type: enum',
        '    values: [todo, in-progress, done]',
        '    required: true',
        '  assignee:',
        '    type: reference',
        '    target_schema: person',
        '',
      ].join('\n'),
      'utf-8',
    );

    loadSchemas(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a new field to an existing schema', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
    ]);

    expect(result.operations_applied).toBe(1);
    expect(result.file_path).toBe('.schemas/task.yaml');
    expect(result.warnings).toEqual([]);

    // Verify schema was reloaded into DB
    const schema = getSchema(db, 'task');
    expect(schema).not.toBeNull();
    expect(schema!.fields.due_date).toEqual({ type: 'date' });
    // Existing fields preserved
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.assignee.type).toBe('reference');
  });

  it('errors when adding a field that already exists', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'status', definition: { type: 'string' } },
      ]),
    ).toThrow("Field 'status' already exists in schema 'task'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/update-schema.js`

- [ ] **Step 3: Write the `updateSchema` function with add_field support**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): add_field operation with validation and rollback"
```

---

### Task 2: remove_field and rename_field operations

**Files:**
- Modify: `tests/mcp/update-schema.test.ts`
- Modify: `src/mcp/update-schema.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('updateSchema')` block:

```typescript
  it('removes a field from a schema', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'remove_field', field: 'assignee' },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    expect(schema!.fields.assignee).toBeUndefined();
    expect(schema!.fields.status).toBeDefined();
  });

  it('errors when removing a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'remove_field', field: 'nonexistent' },
      ]),
    ).toThrow("Field 'nonexistent' does not exist in schema 'task'");
  });

  it('renames a field preserving its definition', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'rename_field', field: 'assignee', new_name: 'owner' },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    expect(schema!.fields.assignee).toBeUndefined();
    expect(schema!.fields.owner).toEqual({ type: 'reference', target_schema: 'person' });
  });

  it('errors when renaming to a name that already exists', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'rename_field', field: 'assignee', new_name: 'status' },
      ]),
    ).toThrow("Cannot rename 'assignee' to 'status': field 'status' already exists in schema 'task'");
  });

  it('errors when renaming a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'rename_field', field: 'nope', new_name: 'whatever' },
      ]),
    ).toThrow("Field 'nope' does not exist in schema 'task'");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: FAIL — `Unknown action: remove_field` and `Unknown action: rename_field`

- [ ] **Step 3: Add remove_field and rename_field to `applyOperation`**

In `src/mcp/update-schema.ts`, add these cases to the `switch` in `applyOperation`, before the `default`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): remove_field and rename_field operations"
```

---

### Task 3: update_field and set_metadata operations

**Files:**
- Modify: `tests/mcp/update-schema.test.ts`
- Modify: `src/mcp/update-schema.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('updateSchema')` block:

```typescript
  it('updates an existing field definition (merge semantics)', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'update_field', field: 'status', definition: { values: ['todo', 'in-progress', 'done', 'archived'] } },
    ]);

    expect(result.operations_applied).toBe(1);
    const schema = getSchema(db, 'task');
    // Updated keys merged
    expect(schema!.fields.status.values).toEqual(['todo', 'in-progress', 'done', 'archived']);
    // Existing keys preserved
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.status.required).toBe(true);
  });

  it('errors when updating a field that does not exist', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'update_field', field: 'nope', definition: { type: 'string' } },
      ]),
    ).toThrow("Field 'nope' does not exist in schema 'task'");
  });

  it('sets schema metadata', () => {
    const result = updateSchema(db, tmpDir, 'task', [
      { action: 'set_metadata', key: 'display_name', value: 'Work Task' },
      { action: 'set_metadata', key: 'icon', value: 'briefcase' },
    ]);

    expect(result.operations_applied).toBe(2);
    const schema = getSchema(db, 'task');
    expect(schema!.display_name).toBe('Work Task');
    expect(schema!.icon).toBe('briefcase');
  });

  it('sets serialization metadata', () => {
    updateSchema(db, tmpDir, 'task', [
      { action: 'set_metadata', key: 'serialization', value: { filename_template: 'tasks/work/{{title}}.md' } },
    ]);

    const schema = getSchema(db, 'task');
    expect(schema!.serialization).toEqual({ filename_template: 'tasks/work/{{title}}.md' });
  });

  it('errors on unsupported metadata key', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'bogus', value: 'whatever' },
      ]),
    ).toThrow("Unsupported metadata key 'bogus'");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: FAIL — `Unknown action: update_field` and `Unknown action: set_metadata`

- [ ] **Step 3: Add update_field and set_metadata to `applyOperation`**

In `src/mcp/update-schema.ts`, add these cases to the `switch` in `applyOperation`, before the `default`:

```typescript
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
      (schema as Record<string, unknown>)[op.key] = op.value;
      break;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): update_field and set_metadata operations"
```

---

### Task 4: New schema creation, extends validation, and rollback

**Files:**
- Modify: `tests/mcp/update-schema.test.ts`
- Modify: `src/mcp/update-schema.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('updateSchema')` block:

```typescript
  it('creates a new schema from scratch', () => {
    const result = updateSchema(db, tmpDir, 'project', [
      { action: 'set_metadata', key: 'display_name', value: 'Project' },
      { action: 'set_metadata', key: 'icon', value: 'folder' },
      { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['active', 'completed', 'archived'] } },
      { action: 'add_field', field: 'lead', definition: { type: 'reference', target_schema: 'person' } },
    ]);

    expect(result.operations_applied).toBe(4);
    expect(result.file_path).toBe('.schemas/project.yaml');

    const schema = getSchema(db, 'project');
    expect(schema).not.toBeNull();
    expect(schema!.display_name).toBe('Project');
    expect(schema!.icon).toBe('folder');
    expect(schema!.fields.status.type).toBe('enum');
    expect(schema!.fields.lead.type).toBe('reference');
  });

  it('validates extends target exists on disk', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'subtask', [
        { action: 'set_metadata', key: 'extends', value: 'nonexistent' },
        { action: 'add_field', field: 'parent', definition: { type: 'reference' } },
      ]),
    ).toThrow(
      "Cannot set extends to 'nonexistent': no schema file found at .schemas/nonexistent.yaml. " +
      'Create the parent schema first, then extend from it.',
    );

    // Schema file should NOT have been created
    expect(getSchema(db, 'subtask')).toBeNull();
  });

  it('validates field types', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' as any } },
      ]),
    ).toThrow("Invalid field type 'invalid' for field 'bad'");
  });

  it('validates enum fields have values', () => {
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'category', definition: { type: 'enum' } },
      ]),
    ).toThrow("Enum field 'category' requires a non-empty 'values' array");
  });

  it('rolls back on reload failure', () => {
    // Create a child schema that extends task
    writeFileSync(
      join(tmpDir, '.schemas', 'work-task.yaml'),
      [
        'name: work-task',
        'extends: task',
        'fields:',
        '  department:',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    loadSchemas(db, tmpDir);

    // Read original task.yaml content for comparison
    const originalContent = readFileSync(join(tmpDir, '.schemas', 'task.yaml'), 'utf-8');

    // Set extends to create a cycle: task extends work-task, but work-task extends task
    // This will pass per-file validation (work-task.yaml exists) but fail on loadSchemas
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'set_metadata', key: 'extends', value: 'work-task' },
      ]),
    ).toThrow(/Schema reload failed/);

    // File should be rolled back
    const afterContent = readFileSync(join(tmpDir, '.schemas', 'task.yaml'), 'utf-8');
    expect(afterContent).toBe(originalContent);

    // DB should still have the original schemas
    const schema = getSchema(db, 'task');
    expect(schema).not.toBeNull();
    expect(schema!.extends).toBeUndefined();
  });

  it('applies multiple operations atomically', () => {
    // Second operation should fail, so first should not be applied either
    expect(() =>
      updateSchema(db, tmpDir, 'task', [
        { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' as any } },
      ]),
    ).toThrow("Invalid field type 'invalid'");

    // due_date should NOT have been added (atomicity)
    const schema = getSchema(db, 'task');
    expect(schema!.fields.due_date).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: Some pass (new schema creation should already work), some fail (rollback test should fail because file was written before validation caught the cycle — wait, actually the cycle passes per-file validation since work-task.yaml exists, but `loadSchemas` will throw on cycle detection, which triggers rollback). Let's verify.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (18 tests). The core logic from Tasks 1-3 already handles new schema creation (empty file path → fresh object), extends validation (in `validateSchema`), field type validation, enum validation, and rollback (in `updateSchema`). No new code needed — these tests exercise existing code paths.

If any test fails, fix the issue and re-run.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/update-schema.test.ts
git commit -m "test(update-schema): new schema creation, extends validation, rollback, atomicity"
```

---

### Task 5: Inheritance warning for update_field on inherited fields

**Files:**
- Modify: `tests/mcp/update-schema.test.ts`
- Modify: `src/mcp/update-schema.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('updateSchema')` block:

```typescript
  it('warns when updating a field inherited from a parent schema', () => {
    // Create work-task that extends task
    writeFileSync(
      join(tmpDir, '.schemas', 'work-task.yaml'),
      [
        'name: work-task',
        'extends: task',
        'fields:',
        '  department:',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    loadSchemas(db, tmpDir);

    // Adding a field that also exists in the parent (override)
    const result = updateSchema(db, tmpDir, 'work-task', [
      { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['open', 'closed'] } },
    ]);

    expect(result.warnings).toContain(
      "Field 'status' is inherited from parent schema 'task'; this add_field creates a local override in 'work-task'.",
    );
    // The field should be added locally
    const schema = getSchema(db, 'work-task');
    expect(schema!.fields.status.values).toEqual(['open', 'closed']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: FAIL — warnings array is empty (no inheritance check yet)

- [ ] **Step 3: Add inheritance warning logic**

The `applyOperation` function needs access to the parent schema's fields to detect overrides. Modify `updateSchema` to pass parent field info, and update `applyOperation` to accept and use it.

In `src/mcp/update-schema.ts`, change the `updateSchema` function to resolve parent fields before the operation loop, and pass them + a `warnings` array to `applyOperation`:

Replace the operation loop and the `applyOperation` signature:

```typescript
// In updateSchema(), before the operation loop, resolve parent fields:
  let parentFields: Record<string, FieldDefinition> = {};
  if (schema.extends) {
    const parentPath = join(vaultPath, '.schemas', `${schema.extends}.yaml`);
    if (existsSync(parentPath)) {
      const parentRaw = readFileSync(parentPath, 'utf-8');
      const parentParsed = parseYaml(parentRaw);
      // Walk the full ancestor chain via the DB (already loaded)
      const parentResolved = getSchema(db, schema.extends);
      if (parentResolved) {
        parentFields = parentResolved.fields;
      }
    }
  }

  // Apply all operations to in-memory copy
  for (const op of operations) {
    applyOperation(schema, op, schemaName, parentFields, warnings);
  }
```

Update `applyOperation` signature to accept `parentFields` and `warnings`. Add inheritance check to `add_field`. All existing cases (`remove_field`, `rename_field`, `update_field`, `set_metadata`) keep the same logic — only the function signature changes:

```typescript
function applyOperation(
  schema: SchemaDefinition,
  op: SchemaOperation,
  schemaName: string,
  parentFields: Record<string, FieldDefinition>,
  warnings: string[],
): void {
  switch (op.action) {
    case 'add_field': {
      if (!op.field) throw new Error("add_field requires 'field'");
      if (!op.definition) throw new Error("add_field requires 'definition'");
      if (schema.fields[op.field]) {
        throw new Error(`Field '${op.field}' already exists in schema '${schemaName}'`);
      }
      if (parentFields[op.field]) {
        warnings.push(
          `Field '${op.field}' is inherited from parent schema '${schema.extends}'; this add_field creates a local override in '${schemaName}'.`,
        );
      }
      schema.fields[op.field] = op.definition as FieldDefinition;
      break;
    }
    // remove_field, rename_field, update_field, set_metadata — same logic, just updated signature
    // ...
  }
}
```

Update the call site in `updateSchema` to pass the new parameters:

```typescript
  for (const op of operations) {
    applyOperation(schema, op, schemaName, parentFields, warnings);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): warn when overriding inherited fields"
```

---

### Task 6: Register MCP tool in server.ts

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/update-schema.test.ts`

- [ ] **Step 1: Write the failing test — MCP tool integration**

Add a new `describe` block at the bottom of `tests/mcp/update-schema.test.ts` for MCP integration tests:

```typescript
describe('update-schema MCP tool', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-update-schema-mcp-'));

    // Create a base task schema
    const schemasDir = join(tmpDir, '.schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'task.yaml'),
      [
        'name: task',
        'display_name: Task',
        'icon: check',
        'fields:',
        '  status:',
        '    type: enum',
        '    values: [todo, in-progress, done]',
        '    required: true',
        '  assignee:',
        '    type: reference',
        '    target_schema: person',
        '',
      ].join('\n'),
      'utf-8',
    );

    loadSchemas(db, tmpDir);

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

  async function callTool(toolName: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name: toolName, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('adds a field via MCP tool', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'due_date', definition: { type: 'date' } },
      ],
    });

    expect(result.operations_applied).toBe(1);
    expect(result.file_path).toBe('.schemas/task.yaml');
    expect(result.schema.fields.due_date).toEqual({ type: 'date' });
  });

  it('creates a new schema via MCP tool', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'project',
      operations: [
        { action: 'set_metadata', key: 'display_name', value: 'Project' },
        { action: 'add_field', field: 'status', definition: { type: 'enum', values: ['active', 'done'] } },
      ],
    });

    expect(result.schema.name).toBe('project');
    expect(result.schema.fields.status.type).toBe('enum');
  });

  it('returns error for invalid operations', async () => {
    const result = await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'bad', definition: { type: 'invalid' } },
      ],
    });

    expect(result.error).toBeDefined();
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('subsequent describe-schema reflects changes', async () => {
    await callTool('update-schema', {
      schema_name: 'task',
      operations: [
        { action: 'add_field', field: 'priority', definition: { type: 'enum', values: ['high', 'medium', 'low'] } },
      ],
    });

    const schema = await callTool('describe-schema', { schema_name: 'task' });
    expect(schema.fields.priority).toBeDefined();
    expect(schema.fields.priority.type).toBe('enum');
  });
});
```

Add the required imports at the top of the test file:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: FAIL — `update-schema` tool not found (not registered yet)

- [ ] **Step 3: Register the tool in server.ts**

In `src/mcp/server.ts`, add the import at the top with the other imports:

```typescript
import { updateSchema } from './update-schema.js';
```

Then add the tool registration before `return server;` (before line 2283):

```typescript
  // ── update-schema ──────────────────────────────────────────────
  server.tool(
    'update-schema',
    'Update a schema definition. Add, remove, rename, or modify fields and metadata. ' +
    'Changes are written to .schemas/*.yaml and reloaded into the DB immediately. ' +
    'If the schema does not exist yet, it will be created. ' +
    'This tool modifies schema definitions only — it does not touch vault files. ' +
    'Use normalize-fields to propagate schema changes to existing files. ' +
    'Note: YAML comments in schema files are not preserved on write.',
    {
      schema_name: z.string().min(1)
        .describe("Name of the schema to update or create, e.g. 'task', 'meeting'"),
      operations: z.array(z.object({
        action: z.enum(['add_field', 'remove_field', 'rename_field', 'update_field', 'set_metadata'])
          .describe('Operation to perform'),
        field: z.string().optional()
          .describe('Field name (required for all field actions)'),
        definition: z.object({
          type: z.string().optional()
            .describe("Field type: 'string', 'number', 'date', 'boolean', 'reference', 'enum', 'list<string>', 'list<reference>'"),
          values: z.array(z.string()).optional()
            .describe('For enum fields: valid values'),
          required: z.boolean().optional(),
          target_schema: z.string().optional()
            .describe('For reference fields: expected target schema type'),
          default: z.any().optional(),
        }).optional()
          .describe('Field definition (required for add_field, update_field)'),
        new_name: z.string().optional()
          .describe('For rename_field: the new field name'),
        key: z.string().optional()
          .describe("For set_metadata: metadata key (display_name, icon, extends, serialization)"),
        value: z.any().optional()
          .describe('For set_metadata: metadata value'),
      })).min(1)
        .describe('Operations to apply sequentially'),
    },
    async ({ schema_name, operations }) => {
      try {
        const result = updateSchema(db, vaultPath, schema_name, operations);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toolError(
          err instanceof Error ? err.message : String(err),
          'VALIDATION_ERROR',
        );
      }
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: PASS (23 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): register MCP tool in server.ts"
```

---

### Task 7: Full test suite pass and final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass. No regressions from existing tests.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit if any fixups were needed**

If any fixes were required, commit them:

```bash
git add -A
git commit -m "fix(update-schema): address test suite / type-check issues"
```
