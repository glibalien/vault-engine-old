import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/index.js';

export function indexFile(
  db: Database.Database,
  parsed: ParsedFile,
  relativePath: string,
  mtime: string,
): void {
  // Delete existing child rows
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);

  // Upsert node
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, depth)
    VALUES (?, ?, 'file', ?, ?, 0)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd);

  // Insert node_types
  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const type of parsed.types) {
    insertType.run(relativePath, type);
  }
}
