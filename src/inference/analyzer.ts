// src/inference/analyzer.ts
import type Database from 'better-sqlite3';
import { getAllSchemas } from '../schema/loader.js';
import type { ResolvedSchema } from '../schema/types.js';
import type { InferredField, InferenceResult, TypeAnalysis, Discrepancy } from './types.js';

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

/**
 * Analyze all indexed types in the vault, inferring field types,
 * computing frequencies, detecting discrepancies against existing schemas,
 * and identifying shared fields across types.
 */
export function analyzeVault(db: Database.Database, types?: string[]): InferenceResult {
  // 1. Query type counts
  let typeCounts: Array<{ schema_type: string; count: number }>;
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(', ');
    typeCounts = db.prepare(
      `SELECT schema_type, COUNT(*) AS count FROM node_types WHERE schema_type IN (${placeholders}) GROUP BY schema_type`
    ).all(...types) as Array<{ schema_type: string; count: number }>;
  } else {
    typeCounts = db.prepare(
      'SELECT schema_type, COUNT(*) AS count FROM node_types GROUP BY schema_type'
    ).all() as Array<{ schema_type: string; count: number }>;
  }

  // 4. Load existing schemas
  const existingSchemas = getAllSchemas(db);
  const schemaByName = new Map<string, ResolvedSchema>();
  for (const schema of existingSchemas) {
    schemaByName.set(schema.name, schema);
  }

  // Build per-type field profiles
  const fieldProfileStmt = db.prepare(
    `SELECT f.key, f.value_type, f.value_text, COUNT(*) AS cnt
     FROM fields f
     JOIN node_types nt ON nt.node_id = f.node_id
     WHERE nt.schema_type = ?
     GROUP BY f.key, f.value_type, f.value_text
     ORDER BY f.key, cnt DESC`
  );

  // Per-field node counts
  const fieldNodeCountStmt = db.prepare(
    `SELECT f.key, COUNT(DISTINCT f.node_id) AS node_count
     FROM fields f
     JOIN node_types nt ON nt.node_id = f.node_id
     WHERE nt.schema_type = ?
     GROUP BY f.key`
  );

  // Track inferred fields per type for shared-field detection
  const typeFieldMap = new Map<string, Map<string, string>>(); // typeName -> Map<fieldKey, inferredType>

  const typeAnalyses: TypeAnalysis[] = [];

  for (const { schema_type, count: nodeCount } of typeCounts) {
    const fieldRows = fieldProfileStmt.all(schema_type) as Array<{
      key: string;
      value_type: string;
      value_text: string;
      cnt: number;
    }>;

    const fieldNodeCounts = fieldNodeCountStmt.all(schema_type) as Array<{
      key: string;
      node_count: number;
    }>;
    const fieldNodeCountMap = new Map<string, number>();
    for (const row of fieldNodeCounts) {
      fieldNodeCountMap.set(row.key, row.node_count);
    }

    // Group field rows by key
    const fieldGroups = new Map<string, FieldRow[]>();
    for (const row of fieldRows) {
      const group = fieldGroups.get(row.key) ?? [];
      group.push({ value_type: row.value_type, value_text: row.value_text, count: row.cnt });
      fieldGroups.set(row.key, group);
    }

    // 5. Infer field types and compute frequency
    const inferredFields: InferredField[] = [];
    const fieldTypeMap = new Map<string, string>();

    for (const [key, rows] of fieldGroups) {
      const inferred = inferFieldType(rows);
      const fieldNodeCount = fieldNodeCountMap.get(key) ?? 0;
      const frequency = nodeCount > 0 ? fieldNodeCount / nodeCount : 0;

      inferredFields.push({
        key,
        frequency,
        ...inferred,
      });

      fieldTypeMap.set(key, inferred.inferred_type);
    }

    typeFieldMap.set(schema_type, fieldTypeMap);

    // 6. Discrepancy detection
    const discrepancies: Discrepancy[] = [];
    const existingSchema = schemaByName.get(schema_type);
    const hasExistingSchema = !!existingSchema;

    if (existingSchema) {
      const schemaFields = existingSchema.fields;

      // Fields in data but not in schema
      for (const field of inferredFields) {
        if (!(field.key in schemaFields)) {
          discrepancies.push({
            field: field.key,
            issue: `Field '${field.key}' exists in ${Math.round(field.frequency * 100)}% of nodes but is not defined in schema`,
            schema_value: undefined,
            inferred_value: field.inferred_type,
          });
        }
      }

      // Fields in schema but not in data
      for (const [fieldName, fieldDef] of Object.entries(schemaFields)) {
        if (!fieldTypeMap.has(fieldName)) {
          discrepancies.push({
            field: fieldName,
            issue: `Field '${fieldName}' defined in schema but not found in data`,
            schema_value: fieldDef.type,
            inferred_value: undefined,
          });
        }
      }

      // Type mismatches
      for (const field of inferredFields) {
        if (field.key in schemaFields) {
          const schemaType = schemaFields[field.key].type;
          if (schemaType !== field.inferred_type) {
            discrepancies.push({
              field: field.key,
              issue: `Type mismatch for '${field.key}': schema='${schemaType}', inferred='${field.inferred_type}'`,
              schema_value: schemaType,
              inferred_value: field.inferred_type,
            });
          }

          // Enum value differences
          if (schemaType === 'enum' && field.inferred_type === 'enum') {
            const schemaValues = schemaFields[field.key].values ?? [];
            const inferredValues = field.enum_values ?? [];

            // Values in data but not in schema
            const extraValues = inferredValues.filter(v => !schemaValues.includes(v));
            if (extraValues.length > 0) {
              discrepancies.push({
                field: field.key,
                issue: `Enum values in data but not in schema: ${extraValues.join(', ')}`,
                schema_value: schemaValues,
                inferred_value: inferredValues,
              });
            }

            // Values in schema but not in data
            const missingValues = schemaValues.filter(v => !inferredValues.includes(v));
            if (missingValues.length > 0) {
              discrepancies.push({
                field: field.key,
                issue: `Enum values in schema but not in data: ${missingValues.join(', ')}`,
                schema_value: schemaValues,
                inferred_value: inferredValues,
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
      shared_fields: [], // Filled in below
    });
  }

  // 7. Shared field detection: find fields with same key and same inferred_type across 2+ types
  const fieldTypeOccurrences = new Map<string, Set<string>>(); // "key:type" -> Set<typeName>
  for (const [typeName, fieldMap] of typeFieldMap) {
    for (const [fieldKey, inferredType] of fieldMap) {
      const compositeKey = `${fieldKey}:${inferredType}`;
      const typeSet = fieldTypeOccurrences.get(compositeKey) ?? new Set();
      typeSet.add(typeName);
      fieldTypeOccurrences.set(compositeKey, typeSet);
    }
  }

  // Collect shared field keys per type
  const sharedFieldsByType = new Map<string, Set<string>>();
  for (const [compositeKey, typeNames] of fieldTypeOccurrences) {
    if (typeNames.size >= 2) {
      const fieldKey = compositeKey.split(':')[0];
      for (const typeName of typeNames) {
        const sharedSet = sharedFieldsByType.get(typeName) ?? new Set();
        sharedSet.add(fieldKey);
        sharedFieldsByType.set(typeName, sharedSet);
      }
    }
  }

  // Attach shared_fields to each TypeAnalysis
  for (const analysis of typeAnalyses) {
    const shared = sharedFieldsByType.get(analysis.name);
    if (shared) {
      analysis.shared_fields = [...shared].sort();
    }
  }

  return { types: typeAnalyses };
}
