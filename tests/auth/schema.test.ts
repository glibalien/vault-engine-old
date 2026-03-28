import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../../src/auth/schema.js';

describe('createAuthSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('creates oauth_clients table', () => {
    createAuthSchema(db);
    const cols = db.prepare(`PRAGMA table_info(oauth_clients)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(['client_id', 'client_id_issued_at', 'client_secret', 'client_secret_expires_at', 'metadata']);
  });

  it('creates oauth_codes table', () => {
    createAuthSchema(db);
    const cols = db.prepare(`PRAGMA table_info(oauth_codes)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'code', 'client_id', 'redirect_uri', 'code_challenge',
      'scopes', 'resource', 'state', 'created_at', 'expires_at',
    ]);
  });

  it('creates oauth_tokens table', () => {
    createAuthSchema(db);
    const cols = db.prepare(`PRAGMA table_info(oauth_tokens)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'token', 'type', 'client_id', 'scopes', 'resource',
      'created_at', 'expires_at', 'revoked',
    ]);
  });

  it('is idempotent', () => {
    createAuthSchema(db);
    createAuthSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oauth_%'`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['oauth_clients', 'oauth_codes', 'oauth_tokens']);
  });
});
