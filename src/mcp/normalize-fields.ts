// src/mcp/normalize-fields.ts
import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllSchemas } from '../schema/loader.js';
import { patchFrontmatter, type FrontmatterMutation } from '../serializer/patch.js';
import { writeNodeFile } from '../serializer/writer.js';
import { incrementalIndex } from '../sync/indexer.js';
import { resolveReferences } from '../sync/resolver.js';
import {
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  releaseWriteLock,
} from '../sync/watcher.js';

export interface NormalizeRule {
  action: 'rename_key' | 'coerce_value';
  from_key: string;
  to_key?: string;
  target_type?: string;
}

export interface RuleReport {
  action: 'rename_key' | 'coerce_value';
  from_key: string;
  to_key?: string;
  target_type?: string;
  files_affected: number;
  sample_files: string[];
}

export interface NormalizeResult {
  rules_applied: RuleReport[];
  total_files_affected: number;
  mode: 'audit' | 'apply';
}

export function inferRules(
  db: Database.Database,
  schemaType?: string,
): NormalizeRule[] {
  const schemas = getAllSchemas(db);
  const filteredSchemas = schemaType
    ? schemas.filter(s => s.name === schemaType)
    : schemas;

  const rules: NormalizeRule[] = [];
  const seenRenames = new Set<string>();
  const seenCoercions = new Set<string>();

  for (const schema of filteredSchemas) {
    for (const [canonicalKey, fieldDef] of Object.entries(schema.fields)) {
      // Find variant keys (same key, different casing) in the DB
      const variants = db
        .prepare(
          `SELECT DISTINCT f.key FROM fields f
           JOIN node_types nt ON nt.node_id = f.node_id
           WHERE nt.schema_type = ? AND LOWER(f.key) = LOWER(?) AND f.key != ?`,
        )
        .all(schema.name, canonicalKey, canonicalKey) as Array<{
        key: string;
      }>;

      for (const { key: variantKey } of variants) {
        const rKey = `${variantKey}|${canonicalKey}`;
        if (!seenRenames.has(rKey)) {
          seenRenames.add(rKey);
          rules.push({
            action: 'rename_key',
            from_key: variantKey,
            to_key: canonicalKey,
          });
        }
      }

      // Check for value shape mismatches (only for list types)
      if (fieldDef.type.startsWith('list')) {
        const count = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM fields f
             JOIN node_types nt ON nt.node_id = f.node_id
             WHERE nt.schema_type = ?
               AND LOWER(f.key) = LOWER(?)
               AND f.value_type != 'list'`,
          )
          .get(schema.name, canonicalKey) as { cnt: number };

        if (count.cnt > 0) {
          const cKey = `${canonicalKey}|${fieldDef.type}`;
          if (!seenCoercions.has(cKey)) {
            seenCoercions.add(cKey);
            rules.push({
              action: 'coerce_value',
              from_key: canonicalKey,
              target_type: fieldDef.type,
            });
          }
        }
      }
    }
  }

  return rules;
}

function findAffectedFiles(
  db: Database.Database,
  rules: NormalizeRule[],
  schemaType?: string,
): {
  ruleReports: RuleReport[];
  fileMutations: Map<string, FrontmatterMutation[]>;
} {
  const fileMutations = new Map<string, FrontmatterMutation[]>();
  const ruleReports: RuleReport[] = [];

  // Renames first, then coercions — order matters for per-file mutation lists
  const sortedRules = [
    ...rules.filter(r => r.action === 'rename_key'),
    ...rules.filter(r => r.action === 'coerce_value'),
  ];

  for (const rule of sortedRules) {
    let query: string;
    let params: unknown[];

    if (rule.action === 'rename_key') {
      if (schemaType) {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 JOIN node_types nt ON nt.node_id = f.node_id
                 WHERE f.key = ? AND nt.schema_type = ?`;
        params = [rule.from_key, schemaType];
      } else {
        query = `SELECT DISTINCT f.node_id FROM fields f WHERE f.key = ?`;
        params = [rule.from_key];
      }
    } else {
      if (schemaType) {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 JOIN node_types nt ON nt.node_id = f.node_id
                 WHERE LOWER(f.key) = LOWER(?)
                   AND f.value_type != 'list'
                   AND nt.schema_type = ?`;
        params = [rule.from_key, schemaType];
      } else {
        query = `SELECT DISTINCT f.node_id FROM fields f
                 WHERE LOWER(f.key) = LOWER(?) AND f.value_type != 'list'`;
        params = [rule.from_key];
      }
    }

    const rows = db.prepare(query).all(...params) as Array<{
      node_id: string;
    }>;
    const fileIds = rows.map(r => r.node_id);

    ruleReports.push({
      action: rule.action,
      from_key: rule.from_key,
      to_key: rule.to_key,
      target_type: rule.target_type,
      files_affected: fileIds.length,
      sample_files: fileIds.slice(0, 5),
    });

    for (const fileId of fileIds) {
      if (!fileMutations.has(fileId)) fileMutations.set(fileId, []);
      const mutations = fileMutations.get(fileId)!;

      if (rule.action === 'rename_key') {
        mutations.push({
          type: 'rename_key',
          from: rule.from_key,
          to: rule.to_key!,
        });
      } else {
        mutations.push({
          type: 'coerce_value',
          key: rule.from_key,
          targetType: rule.target_type!,
        });
      }
    }
  }

  return { ruleReports, fileMutations };
}

export function normalizeFields(
  db: Database.Database,
  vaultPath: string,
  params: {
    mode: 'audit' | 'apply';
    schema_type?: string;
    rules?: NormalizeRule[];
  },
): NormalizeResult {
  const { mode, schema_type, rules: explicitRules } = params;

  // Validate explicit rules
  if (explicitRules) {
    for (const rule of explicitRules) {
      if (rule.action === 'rename_key' && !rule.to_key) {
        throw new Error(`rename_key rule for '${rule.from_key}' requires to_key`);
      }
      if (rule.action === 'coerce_value' && !rule.target_type) {
        throw new Error(`coerce_value rule for '${rule.from_key}' requires target_type`);
      }
    }
  }

  const rules = explicitRules ?? inferRules(db, schema_type);

  if (rules.length === 0) {
    return { rules_applied: [], total_files_affected: 0, mode };
  }

  const { ruleReports, fileMutations } = findAffectedFiles(
    db,
    rules,
    schema_type,
  );

  if (mode === 'audit' || fileMutations.size === 0) {
    return {
      rules_applied: ruleReports,
      total_files_affected: fileMutations.size,
      mode,
    };
  }

  // --- Apply mode ---
  const deferredLocks = new Set<string>();
  const fileSnapshots = new Map<string, string>();

  function rollbackFiles() {
    for (const [relPath, original] of fileSnapshots) {
      try {
        writeNodeFile(vaultPath, relPath, original);
      } catch {
        /* best effort */
      }
    }
  }

  acquireGlobalWriteLock();
  try {
    for (const [fileId, mutations] of fileMutations) {
      const absPath = join(vaultPath, fileId);
      if (!existsSync(absPath)) continue;

      const raw = readFileSync(absPath, 'utf-8');
      const patched = patchFrontmatter(raw, mutations);

      if (patched === raw) continue;

      fileSnapshots.set(fileId, raw);
      writeNodeFile(vaultPath, fileId, patched, deferredLocks);
    }
  } catch (err) {
    rollbackFiles();
    throw err;
  } finally {
    releaseGlobalWriteLock();
    for (const path of deferredLocks) {
      releaseWriteLock(path);
    }
  }

  incrementalIndex(db, vaultPath);
  resolveReferences(db);

  return {
    rules_applied: ruleReports,
    total_files_affected: fileSnapshots.size,
    mode,
  };
}
