export { indexFile, rebuildIndex, deleteFile, incrementalIndex } from './indexer.js';
export type { IncrementalIndexOptions } from './indexer.js';
export {
  watchVault,
  acquireWriteLock,
  releaseWriteLock,
  isWriteLocked,
  acquireGlobalWriteLock,
  releaseGlobalWriteLock,
  isGlobalWriteLocked,
} from './watcher.js';
export type { WatcherOptions } from './watcher.js';
export { resolveReferences, resolveTarget, buildLookupMaps, resolveTargetWithMaps } from './resolver.js';
export { normalizeOnIndex } from './normalize-on-index.js';
export type { NormalizeOnIndexResult } from './normalize-on-index.js';
