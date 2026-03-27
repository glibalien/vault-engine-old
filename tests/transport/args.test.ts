import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/transport/args.js';

describe('parseArgs', () => {
  it('returns defaults with no args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'stdio',
      port: 3333,
    });
  });

  it('parses positional dbPath and vaultPath', () => {
    const result = parseArgs(['/tmp/vault.db', '/tmp/vault']);
    expect(result).toEqual({
      dbPath: '/tmp/vault.db',
      vaultPath: '/tmp/vault',
      transport: 'stdio',
      port: 3333,
    });
  });

  it('parses --transport http', () => {
    const result = parseArgs(['--transport', 'http']);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'http',
      port: 3333,
    });
  });

  it('parses --transport both --port 4000', () => {
    const result = parseArgs(['--transport', 'both', '--port', '4000']);
    expect(result).toEqual({
      dbPath: undefined,
      vaultPath: undefined,
      transport: 'both',
      port: 4000,
    });
  });

  it('parses positional args mixed with flags', () => {
    const result = parseArgs(['/tmp/vault.db', '/tmp/vault', '--transport', 'http', '--port', '5000']);
    expect(result).toEqual({
      dbPath: '/tmp/vault.db',
      vaultPath: '/tmp/vault',
      transport: 'http',
      port: 5000,
    });
  });

  it('rejects invalid transport value', () => {
    expect(() => parseArgs(['--transport', 'websocket'])).toThrow('Invalid --transport value');
  });

  it('rejects non-numeric port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow('Invalid --port value');
  });

  it('rejects float port', () => {
    expect(() => parseArgs(['--port', '3.14'])).toThrow('Invalid --port value');
  });

  it('rejects out-of-range port', () => {
    expect(() => parseArgs(['--port', '99999'])).toThrow('Invalid --port value');
  });

  it('throws when --transport has no value', () => {
    expect(() => parseArgs(['--transport'])).toThrow('Missing value for --transport');
  });

  it('throws when --port has no value', () => {
    expect(() => parseArgs(['--port'])).toThrow('Missing value for --port');
  });
});
