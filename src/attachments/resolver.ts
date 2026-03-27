// src/attachments/resolver.ts
import { existsSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { classifyAttachment } from './types.js';
import type { AttachmentType, ResolvedEmbed } from './types.js';

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

export function parseEmbeds(raw: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EMBED_RE.source, EMBED_RE.flags);
  while ((match = re.exec(raw)) !== null) {
    // Strip optional size/display suffix: ![[file.png|400]] → file.png
    let filename = match[1].split('|')[0].trim();
    // Skip .md transclusions
    if (filename.toLowerCase().endsWith('.md')) continue;
    if (!seen.has(filename)) {
      seen.add(filename);
      results.push(filename);
    }
  }
  return results;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.vault-engine']);

function isInsideVault(candidate: string, vaultPath: string): boolean {
  return resolve(candidate).startsWith(resolve(vaultPath) + '/');
}

export function resolveEmbedPath(
  filename: string,
  vaultPath: string,
  sourceDir: string,
): string | null {
  // 1. Attachments/ folder
  const attachmentsPath = join(vaultPath, 'Attachments', filename);
  if (isInsideVault(attachmentsPath, vaultPath) && existsSync(attachmentsPath)) return attachmentsPath;

  // 2. Vault root
  const rootPath = join(vaultPath, filename);
  if (isInsideVault(rootPath, vaultPath) && existsSync(rootPath)) return rootPath;

  // 3. Same directory as source note
  const siblingPath = join(sourceDir, filename);
  if (isInsideVault(siblingPath, vaultPath) && existsSync(siblingPath)) return siblingPath;

  // 4. Recursive search (slow path)
  const target = basename(filename);
  try {
    const entries = readdirSync(vaultPath, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name !== target) continue;
      // Build parent path and check for skip dirs
      const parentPath = entry.parentPath ?? (entry as any).path ?? '';
      const relative = parentPath.startsWith(vaultPath)
        ? parentPath.slice(vaultPath.length + 1)
        : parentPath;
      const segments = relative.split('/');
      if (segments.some(seg => SKIP_DIRS.has(seg))) continue;
      return join(parentPath, entry.name);
    }
  } catch {
    // readdirSync failure — vault path issue, return null
  }

  return null;
}

export function resolveEmbeds(
  raw: string,
  vaultPath: string,
  sourceDir: string,
  filterType?: AttachmentType | 'all',
): ResolvedEmbed[] {
  const filenames = parseEmbeds(raw);
  const results: ResolvedEmbed[] = [];
  for (const filename of filenames) {
    const attachmentType = classifyAttachment(filename);
    if (filterType && filterType !== 'all' && attachmentType !== filterType) continue;
    const absolutePath = resolveEmbedPath(filename, vaultPath, sourceDir);
    results.push({ filename, absolutePath, attachmentType });
  }
  return results;
}
