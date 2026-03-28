import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, join, basename } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { parseFile } from '../parser/index.js';
import { indexFile, deleteFile } from './indexer.js';
import { resolveReferences } from './resolver.js';

// Directories to exclude from watching.
// chokidar v5 treats string ignored patterns as exact matches (not globs),
// so we use a function to properly filter directories by basename.
const IGNORED_DIRS = new Set(['node_modules', '.git', '.vault-engine']);

const writeLocks = new Set<string>();

export function acquireWriteLock(relativePath: string): void {
  writeLocks.add(relativePath);
}

export function releaseWriteLock(relativePath: string): void {
  writeLocks.delete(relativePath);
}

export function isWriteLocked(relativePath: string): boolean {
  return writeLocks.has(relativePath);
}

let globalLockActive = false;

export function acquireGlobalWriteLock(): void {
  globalLockActive = true;
}

export function releaseGlobalWriteLock(): void {
  globalLockActive = false;
}

export function isGlobalWriteLocked(): boolean {
  return globalLockActive;
}

export interface WatcherOptions {
  debounceMs?: number;
  ignorePaths?: string[];
  onSchemaChange?: () => void;
}

export function watchVault(
  db: Database.Database,
  vaultPath: string,
  opts?: WatcherOptions,
): { close(): Promise<void>; ready: Promise<void> } {
  const debounceMs = opts?.debounceMs ?? 300;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const extraIgnored = new Set(opts?.ignorePaths ?? []);

  const watcher: FSWatcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: (path: string, stats?: import('node:fs').Stats) => {
      if (!stats) return false;
      if (stats.isDirectory()) {
        const name = basename(path);
        return IGNORED_DIRS.has(name) || extraIgnored.has(name);
      }
      return !path.endsWith('.md');
    },
  });

  process.stderr.write(`[vault-engine] watcher: watching ${vaultPath}\n`);

  function debounced(relPath: string, action: () => void): void {
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        action();
      }, debounceMs),
    );
  }

  function handleAddOrChange(absPath: string): void {
    if (globalLockActive) return;
    const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
    if (isWriteLocked(rel)) return;

    debounced(rel, () => {
      try {
        const raw = readFileSync(absPath, 'utf-8');
        const hash = createHash('sha256').update(raw).digest('hex');
        const existing = db.prepare('SELECT hash FROM files WHERE path = ?').get(rel) as
          | { hash: string }
          | undefined;
        if (existing && existing.hash === hash) return;

        const mtime = statSync(absPath).mtime.toISOString();
        const parsed = parseFile(rel, raw);
        db.transaction(() => {
          indexFile(db, parsed, rel, mtime, raw);
          resolveReferences(db);
        })();
        process.stderr.write(`[vault-engine] watcher: indexed ${rel}\n`);
      } catch (err) {
        console.error(`[vault-engine] failed to index ${rel}:`, err);
      }
    });
  }

  watcher.on('add', handleAddOrChange);
  watcher.on('change', handleAddOrChange);

  watcher.on('error', (err) => {
    console.error('[vault-engine] watcher error:', err);
  });

  watcher.on('unlink', (absPath: string) => {
    if (globalLockActive) return;
    const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
    if (isWriteLocked(rel)) return;

    debounced(rel, () => {
      try {
        db.transaction(() => {
          deleteFile(db, rel);
          resolveReferences(db);
        })();
        process.stderr.write(`[vault-engine] watcher: deleted ${rel}\n`);
      } catch (err) {
        console.error(`[vault-engine] failed to delete ${rel}:`, err);
      }
    });
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', resolve);
  });

  let schemaWatcher: FSWatcher | undefined;
  let schemaTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.onSchemaChange) {
    const schemasDir = join(vaultPath, '.schemas');
    const onSchemaChange = opts.onSchemaChange;

    schemaWatcher = watch(schemasDir, {
      ignoreInitial: true,
      ignored: (path: string, stats?: import('node:fs').Stats) => {
        if (!stats || stats.isDirectory()) return false;
        return !path.endsWith('.yaml') && !path.endsWith('.yml');
      },
    });

    const schemaDebounce = () => {
      if (schemaTimer) clearTimeout(schemaTimer);
      schemaTimer = setTimeout(() => {
        schemaTimer = undefined;
        onSchemaChange();
      }, debounceMs);
    };

    schemaWatcher.on('add', schemaDebounce);
    schemaWatcher.on('change', schemaDebounce);
    schemaWatcher.on('unlink', schemaDebounce);

    schemaWatcher.on('error', (err) => {
      console.error('[vault-engine] schema watcher error:', err);
    });
  }

  return {
    ready,
    close: async () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (schemaTimer) clearTimeout(schemaTimer);
      await watcher.close();
      if (schemaWatcher) await schemaWatcher.close();
    },
  };
}
