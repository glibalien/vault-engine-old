import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './types.js';

export interface WorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxRetries?: number;
}

export interface EmbeddingWorker {
  stop(): Promise<void>;
  stats(): { pending: number; processing: number; failed: number };
}

export function startEmbeddingWorker(
  db: Database.Database,
  provider: EmbeddingProvider,
  opts?: WorkerOptions,
): EmbeddingWorker {
  const pollIntervalMs = opts?.pollIntervalMs ?? 1000;
  const batchSize = opts?.batchSize ?? 50;
  const maxRetries = opts?.maxRetries ?? 3;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: (() => void) | null = null;

  // Reset any entries stuck in 'processing' state (e.g., from a crash)
  db.prepare("UPDATE embedding_queue SET status = 'pending' WHERE status = 'processing'").run();

  async function processOnce(): Promise<boolean> {
    const pending = db.prepare(`
      SELECT eq.chunk_id, c.content
      FROM embedding_queue eq
      JOIN chunks c ON c.id = eq.chunk_id
      WHERE eq.status = 'pending'
      ORDER BY eq.created_at
      LIMIT ?
    `).all(batchSize) as Array<{ chunk_id: string; content: string }>;

    if (pending.length === 0) return false;

    const chunkIds = pending.map(p => p.chunk_id);
    const texts = pending.map(p => p.content);
    const placeholders = chunkIds.map(() => '?').join(',');

    // Claim batch by setting status to 'processing'
    db.prepare(
      `UPDATE embedding_queue SET status = 'processing', updated_at = datetime('now') WHERE chunk_id IN (${placeholders})`
    ).run(...chunkIds);

    try {
      const vectors = await provider.embed(texts);

      db.transaction(() => {
        const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');
        const deleteQueue = db.prepare('DELETE FROM embedding_queue WHERE chunk_id = ?');
        for (let i = 0; i < chunkIds.length; i++) {
          const buffer = Buffer.from(new Float32Array(vectors[i]).buffer);
          insertVec.run(chunkIds[i], buffer);
          deleteQueue.run(chunkIds[i]);
        }
      })();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      db.transaction(() => {
        for (const chunkId of chunkIds) {
          const row = db.prepare('SELECT attempts FROM embedding_queue WHERE chunk_id = ?')
            .get(chunkId) as { attempts: number } | undefined;
          const attempts = (row?.attempts ?? 0) + 1;
          const newStatus = attempts >= maxRetries ? 'failed' : 'pending';
          db.prepare(
            `UPDATE embedding_queue SET status = ?, attempts = ?, error = ?, updated_at = datetime('now') WHERE chunk_id = ?`
          ).run(newStatus, attempts, errorMsg, chunkId);
        }
      })();
    }

    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        const hadWork = await processOnce();
        if (!running) break;
        await new Promise<void>(resolve => {
          timer = setTimeout(resolve, hadWork ? 0 : pollIntervalMs);
        });
      } catch {
        if (!running) break;
        await new Promise<void>(resolve => {
          timer = setTimeout(resolve, pollIntervalMs);
        });
      }
    }
    resolveStop?.();
  }

  // Start the async loop
  loop();

  return {
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      return new Promise<void>(resolve => {
        resolveStop = resolve;
        // Safety timeout in case the loop is between awaits
        setTimeout(resolve, 50);
      });
    },

    stats() {
      const rows = db.prepare(
        `SELECT status, COUNT(*) as count FROM embedding_queue GROUP BY status`
      ).all() as Array<{ status: string; count: number }>;
      const counts = { pending: 0, processing: 0, failed: 0 };
      for (const row of rows) {
        if (row.status in counts) {
          counts[row.status as keyof typeof counts] = row.count;
        }
      }
      return counts;
    },
  };
}
