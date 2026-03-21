import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { startEmbeddingWorker } from '../../src/embeddings/worker.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

function createMockProvider(dims: number = 3): EmbeddingProvider & { embedFn: ReturnType<typeof vi.fn> } {
  const embedFn = vi.fn<(texts: string[]) => Promise<number[][]>>();
  embedFn.mockImplementation(async (texts: string[]) =>
    texts.map(() => Array(dims).fill(0.1))
  );
  return { dimensions: dims, modelName: 'mock-model', embed: embedFn, embedFn };
}

function insertTestChunkAndQueue(db: Database.Database, chunkId: string, content: string) {
  const nodeId = chunkId.split('#')[0];
  db.prepare(`INSERT OR IGNORE INTO nodes (id, file_path, node_type, content_text, title, depth)
    VALUES (?, ?, 'file', ?, ?, 0)`).run(nodeId, nodeId, content, nodeId);
  db.prepare(`INSERT OR REPLACE INTO chunks (id, node_id, chunk_index, content, token_count)
    VALUES (?, ?, 0, ?, ?)`).run(chunkId, nodeId, content, 10);
  db.prepare(`INSERT OR REPLACE INTO embedding_queue (chunk_id) VALUES (?)`).run(chunkId);
}

describe('embedding queue worker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  it('processes pending entries and inserts vectors', async () => {
    const provider = createMockProvider(3);
    insertTestChunkAndQueue(db, 'note.md#full', 'Hello world content');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 50, batchSize: 10 });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 200));
    await worker.stop();

    // Assert vec_chunks has row
    const vecRow = db.prepare('SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?').get('note.md#full');
    expect(vecRow).toBeDefined();

    // Assert queue is empty
    const queueRow = db.prepare('SELECT * FROM embedding_queue').get();
    expect(queueRow).toBeUndefined();

    // Assert provider was called with correct text
    expect(provider.embedFn).toHaveBeenCalledWith(['Hello world content']);
  });

  it('handles provider failures with retry', async () => {
    const provider = createMockProvider(3);
    // First call fails, second succeeds
    provider.embedFn
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockImplementation(async (texts: string[]) =>
        texts.map(() => Array(3).fill(0.1))
      );

    insertTestChunkAndQueue(db, 'retry.md#full', 'Retry content');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 50, batchSize: 10, maxRetries: 3 });

    // Wait for retry cycle
    await new Promise(resolve => setTimeout(resolve, 400));
    await worker.stop();

    // Assert vector eventually inserted
    const vecRow = db.prepare('SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?').get('retry.md#full');
    expect(vecRow).toBeDefined();

    // Assert queue is empty (successfully processed)
    const queueRow = db.prepare('SELECT * FROM embedding_queue').get();
    expect(queueRow).toBeUndefined();

    // Provider called at least twice (first fail, then success)
    expect(provider.embedFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stats() returns queue status', async () => {
    // Make the provider block so processOnce cannot complete during our check
    let resolveEmbed!: (value: number[][]) => void;
    const provider = createMockProvider(3);
    provider.embedFn.mockImplementation(() =>
      new Promise<number[][]>(resolve => { resolveEmbed = resolve; })
    );

    insertTestChunkAndQueue(db, 'a.md#full', 'Content A');
    insertTestChunkAndQueue(db, 'b.md#full', 'Content B');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 60000, batchSize: 50 });

    // Yield to let the loop start and claim the batch (sets status to 'processing')
    await new Promise(resolve => setTimeout(resolve, 50));

    // While the provider is blocked, the entries are in 'processing' state
    const stats = worker.stats();
    expect(stats.processing).toBe(2);
    expect(stats.failed).toBe(0);

    // Unblock the provider and stop the worker
    resolveEmbed([[0.1, 0.1, 0.1], [0.1, 0.1, 0.1]]);
    await worker.stop();
  });

  it('resets processing entries to pending on start', async () => {
    const provider = createMockProvider(3);
    insertTestChunkAndQueue(db, 'stuck.md#full', 'Stuck content');

    // Manually set status to 'processing' (simulating a crash)
    db.prepare("UPDATE embedding_queue SET status = 'processing' WHERE chunk_id = 'stuck.md#full'").run();

    // Verify it's in processing state
    const before = db.prepare("SELECT status FROM embedding_queue WHERE chunk_id = 'stuck.md#full'").get() as any;
    expect(before.status).toBe('processing');

    const worker = startEmbeddingWorker(db, provider, { pollIntervalMs: 50, batchSize: 10 });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 200));
    await worker.stop();

    // Assert vector was inserted (the stuck entry was recovered and processed)
    const vecRow = db.prepare('SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?').get('stuck.md#full');
    expect(vecRow).toBeDefined();

    // Assert queue is empty
    const queueRow = db.prepare('SELECT * FROM embedding_queue').get();
    expect(queueRow).toBeUndefined();
  });
});
