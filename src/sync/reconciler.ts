import type Database from 'better-sqlite3';
import { incrementalIndex } from './indexer.js';

export interface ReconcileResult {
  indexed: number;
  skipped: number;
  deleted: number;
}

export function reconcileOnce(db: Database.Database, vaultPath: string): ReconcileResult {
  const result = incrementalIndex(db, vaultPath);
  return {
    indexed: result.indexed,
    skipped: result.skipped,
    deleted: result.deleted,
  };
}

export interface ReconcilerOptions {
  intervalMs?: number;    // Default: 300000 (5 minutes)
  firstTickMs?: number;   // Default: 30000 (30 seconds)
}

export function startReconciler(
  db: Database.Database,
  vaultPath: string,
  opts?: ReconcilerOptions,
): { close(): void } {
  const intervalMs = opts?.intervalMs ?? 300_000;
  const firstTickMs = opts?.firstTickMs ?? 30_000;

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const tick = () => {
    if (closed) return;
    try {
      const result = reconcileOnce(db, vaultPath);
      if (result.indexed > 0 || result.deleted > 0) {
        console.error(`[vault-engine] reconciler: indexed ${result.indexed}, deleted ${result.deleted}`);
      }
    } catch (err) {
      console.error('[vault-engine] reconciler error:', err);
    }
  };

  const firstTimer = setTimeout(() => {
    if (closed) return;
    tick();
    intervalTimer = setInterval(tick, intervalMs);
  }, firstTickMs);

  return {
    close() {
      closed = true;
      clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
    },
  };
}
