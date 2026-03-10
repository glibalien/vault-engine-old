import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireWriteLock, releaseWriteLock } from '../sync/watcher.js';

export function deleteNodeFile(
  vaultPath: string,
  relativePath: string,
): void {
  acquireWriteLock(relativePath);
  try {
    unlinkSync(join(vaultPath, relativePath));
  } finally {
    releaseWriteLock(relativePath);
  }
}

export function writeNodeFile(
  vaultPath: string,
  relativePath: string,
  content: string,
): void {
  acquireWriteLock(relativePath);
  try {
    const absPath = join(vaultPath, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  } finally {
    releaseWriteLock(relativePath);
  }
}
