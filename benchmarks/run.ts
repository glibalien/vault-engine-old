import Database from 'better-sqlite3';
import { createSchema } from '../src/db/schema.js';
import { rebuildIndex, incrementalIndex } from '../src/sync/indexer.js';
import { traverseGraph } from '../src/graph/traversal.js';
import { existsSync } from 'node:fs';

const VAULT_PATH = process.argv[2];
const DB_PATH = process.argv[3] ?? ':memory:';
const WARMUP = 10;
const ITERATIONS = 100;

if (!VAULT_PATH || !existsSync(VAULT_PATH)) {
  console.error('Usage: npx tsx benchmarks/run.ts <vault-path> [db-path]');
  process.exit(1);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function report(name: string, times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`${name}:`);
  console.log(`  p50: ${percentile(sorted, 50).toFixed(1)}ms`);
  console.log(`  p95: ${percentile(sorted, 95).toFixed(1)}ms`);
  console.log(`  p99: ${percentile(sorted, 99).toFixed(1)}ms`);
}

async function main() {
  // P1: Full rebuild (single cold iteration — too slow for 100x, ~30s each)
  console.log('\n=== P1: Full Rebuild (single iteration) ===');
  {
    const db = new Database(DB_PATH === ':memory:' ? ':memory:' : DB_PATH);
    db.pragma('foreign_keys = ON');
    createSchema(db);
    const start = performance.now();
    rebuildIndex(db, VAULT_PATH);
    const elapsed = performance.now() - start;
    console.log(`Full rebuild: ${elapsed.toFixed(0)}ms`);
    console.log(`Threshold: < 30000ms — ${elapsed < 30000 ? 'PASS' : 'FAIL'}`);

    // P2: Incremental index (no changes) — reuse the same DB
    console.log('\n=== P2: Incremental Index (no changes) ===');
    const incTimes: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      incrementalIndex(db, VAULT_PATH);
      const e = performance.now() - s;
      if (i >= WARMUP) incTimes.push(e);
    }
    report('incrementalIndex (no changes)', incTimes);
    console.log(`Threshold: < 2000ms wall clock — ${percentile(incTimes.sort((a, b) => a - b), 95) < 2000 ? 'PASS' : 'FAIL'}`);

    // P3: query-nodes with filters
    console.log('\n=== P3: query-nodes with filters ===');
    const queryTimes: number[] = [];
    const queryStmt = db.prepare(`
      SELECT n.id, n.file_path, n.node_type, n.title, n.content_text, n.content_md, n.indexed_at
      FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id
      JOIN fields f0 ON f0.node_id = n.id
      WHERE nt.schema_type = 'task' AND f0.key = 'status' AND f0.value_text = 'todo'
      ORDER BY n.indexed_at DESC
      LIMIT 20
    `);
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      queryStmt.all();
      const e = performance.now() - s;
      if (i >= WARMUP) queryTimes.push(e);
    }
    report('query-nodes with filters', queryTimes);
    console.log(`Threshold: p95 < 100ms — ${percentile(queryTimes.sort((a, b) => a - b), 95) < 100 ? 'PASS' : 'FAIL'}`);

    // P4: traverse-graph (2-hop)
    console.log('\n=== P4: traverse-graph (2-hop) ===');
    const sampleNode = db.prepare('SELECT id FROM nodes LIMIT 1').get() as { id: string } | undefined;
    if (sampleNode) {
      const travTimes: number[] = [];
      for (let i = 0; i < WARMUP + ITERATIONS; i++) {
        const s = performance.now();
        traverseGraph(db, { node_id: sampleNode.id, direction: 'both', max_depth: 2 });
        const e = performance.now() - s;
        if (i >= WARMUP) travTimes.push(e);
      }
      report('traverse-graph 2-hop', travTimes);
      console.log(`Threshold: p95 < 200ms — ${percentile(travTimes.sort((a, b) => a - b), 95) < 200 ? 'PASS' : 'FAIL'}`);
    } else {
      console.log('No nodes to traverse — skipped');
    }

    // P5: hydrateNodes (100 nodes)
    console.log('\n=== P5: hydrateNodes (100 nodes) ===');
    const nodeRows = db.prepare(`
      SELECT id, file_path, node_type, title, content_text, content_md, indexed_at
      FROM nodes LIMIT 100
    `).all();
    const hydrateTimes: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const s = performance.now();
      const ids = (nodeRows as any[]).map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`).all(...ids);
      db.prepare(`SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`).all(...ids);
      const e = performance.now() - s;
      if (i >= WARMUP) hydrateTimes.push(e);
    }
    report('hydrateNodes (100 nodes)', hydrateTimes);
    console.log(`Threshold: p95 < 50ms — ${percentile(hydrateTimes.sort((a, b) => a - b), 95) < 50 ? 'PASS' : 'FAIL'}`);

    db.close();
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
