// src/mcp/duplicates.ts
import type Database from 'better-sqlite3';

export interface DuplicateNode {
  id: string;
  title: string;
  types: string[];
}

export interface DuplicateGroup {
  similarity: number;
  reason: string;
  nodes: DuplicateNode[];
}

export interface DuplicateResult {
  groups: DuplicateGroup[];
  total_groups: number;
}

export interface DuplicateOptions {
  schema_type?: string;
  include_fields?: boolean;
  threshold?: number;
  limit?: number;
}

function normalize(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ');   // collapse whitespace
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

export function findDuplicates(db: Database.Database, opts: DuplicateOptions): DuplicateResult {
  const threshold = opts.threshold ?? 0.8;
  const limit = opts.limit ?? 50;

  // Load nodes
  let sql = 'SELECT n.id, n.title FROM nodes n';
  const params: unknown[] = [];
  if (opts.schema_type) {
    sql += ' JOIN node_types nt ON nt.node_id = n.id WHERE nt.schema_type = ?';
    params.push(opts.schema_type);
  }
  const rows = db.prepare(sql).all(...params) as Array<{ id: string; title: string | null }>;

  // Normalize titles
  const entries = rows
    .filter(r => r.title !== null)
    .map(r => ({ id: r.id, title: r.title!, normalized: normalize(r.title!) }));

  // Load types for all nodes
  const typeRows = db.prepare(
    'SELECT node_id, schema_type FROM node_types'
  ).all() as Array<{ node_id: string; schema_type: string }>;
  const typesMap = new Map<string, string[]>();
  for (const r of typeRows) {
    const arr = typesMap.get(r.node_id) ?? [];
    arr.push(r.schema_type);
    typesMap.set(r.node_id, arr);
  }

  // Phase 1: Exact matches — group by normalized title
  const exactGroups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = exactGroups.get(entry.normalized) ?? [];
    group.push(entry);
    exactGroups.set(entry.normalized, group);
  }

  const groups: DuplicateGroup[] = [];
  const usedIds = new Set<string>();

  for (const [, group] of exactGroups) {
    if (group.length >= 2) {
      groups.push({
        similarity: 1.0,
        reason: 'identical normalized title',
        nodes: group.map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
      });
      for (const e of group) usedIds.add(e.id);
    }
  }

  // Phase 2: Near-matches — bucket by first 3 chars
  const remaining = entries.filter(e => !usedIds.has(e.id));
  const buckets = new Map<string, typeof entries>();
  for (const entry of remaining) {
    const key = entry.normalized.slice(0, 3);
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }

  const bucketKeys = [...buckets.keys()].sort();
  const checkedPairs = new Set<string>();

  for (let bi = 0; bi < bucketKeys.length; bi++) {
    const bucket = buckets.get(bucketKeys[bi])!;
    // Within bucket
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const pairKey = [bucket[i].id, bucket[j].id].sort().join('|');
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);
        const sim = titleSimilarity(bucket[i].normalized, bucket[j].normalized);
        if (sim >= threshold && sim < 1.0) {
          groups.push({
            similarity: Math.round(sim * 100) / 100,
            reason: 'similar title',
            nodes: [bucket[i], bucket[j]].map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
          });
        }
      }
    }
    // Adjacent bucket
    if (bi + 1 < bucketKeys.length) {
      const nextBucket = buckets.get(bucketKeys[bi + 1])!;
      for (const a of bucket) {
        for (const b of nextBucket) {
          const pairKey = [a.id, b.id].sort().join('|');
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);
          const sim = titleSimilarity(a.normalized, b.normalized);
          if (sim >= threshold && sim < 1.0) {
            groups.push({
              similarity: Math.round(sim * 100) / 100,
              reason: 'similar title',
              nodes: [a, b].map(e => ({ id: e.id, title: e.title, types: typesMap.get(e.id) ?? [] })),
            });
          }
        }
      }
    }
  }

  // Phase 3: Field overlap refinement
  if (opts.include_fields) {
    const fieldRows = db.prepare(
      'SELECT node_id, key, value_text FROM fields'
    ).all() as Array<{ node_id: string; key: string; value_text: string }>;
    const fieldsMap = new Map<string, Map<string, string>>();
    for (const r of fieldRows) {
      const m = fieldsMap.get(r.node_id) ?? new Map();
      m.set(r.key, r.value_text);
      fieldsMap.set(r.node_id, m);
    }

    for (const group of groups) {
      if (group.nodes.length !== 2) continue;
      const [a, b] = group.nodes;
      const fieldsA = fieldsMap.get(a.id) ?? new Map();
      const fieldsB = fieldsMap.get(b.id) ?? new Map();
      const allKeys = new Set([...fieldsA.keys(), ...fieldsB.keys()]);
      if (allKeys.size === 0) continue;
      let intersection = 0;
      for (const key of allKeys) {
        if (fieldsA.get(key) === fieldsB.get(key)) intersection++;
      }
      const jaccard = intersection / allKeys.size;
      group.similarity = Math.round((0.7 * group.similarity + 0.3 * jaccard) * 100) / 100;
    }

    // Re-filter against threshold
    const filtered = groups.filter(g => g.similarity >= threshold);
    groups.length = 0;
    groups.push(...filtered);
  }

  // Sort by similarity descending
  groups.sort((a, b) => b.similarity - a.similarity);

  const totalGroups = groups.length;
  return {
    groups: groups.slice(0, limit),
    total_groups: totalGroups,
  };
}
