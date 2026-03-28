import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAuthSchema } from '../../src/auth/schema.js';
import { SqliteClientsStore } from '../../src/auth/store.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('SqliteClientsStore', () => {
  let db: Database.Database;
  let store: SqliteClientsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createAuthSchema(db);
    store = new SqliteClientsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined for unknown client', async () => {
    const result = await store.getClient('nonexistent');
    expect(result).toBeUndefined();
  });

  it('registers and retrieves a client', async () => {
    const input = {
      client_secret: 'test-secret-abc123',
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 86400,
      redirect_uris: [new URL('https://example.com/callback')],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Test Client',
    };

    const registered = await store.registerClient!(input);

    expect(registered.client_id).toBeDefined();
    expect(typeof registered.client_id).toBe('string');
    expect(registered.client_id_issued_at).toBeDefined();
    expect(registered.client_secret).toBe('test-secret-abc123');
    expect(registered.client_name).toBe('Test Client');
    expect(registered.redirect_uris).toEqual([new URL('https://example.com/callback')]);

    const retrieved = await store.getClient(registered.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_id).toBe(registered.client_id);
    expect(retrieved!.client_secret).toBe('test-secret-abc123');
    expect(retrieved!.client_name).toBe('Test Client');
    expect(retrieved!.redirect_uris).toEqual([new URL('https://example.com/callback')]);
  });

  it('registers a public client without secret', async () => {
    const input = {
      redirect_uris: [new URL('https://example.com/callback')],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };

    const registered = await store.registerClient!(input);
    expect(registered.client_secret).toBeUndefined();

    const retrieved = await store.getClient(registered.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_secret).toBeUndefined();
  });
});
