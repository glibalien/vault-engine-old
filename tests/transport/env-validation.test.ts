import { describe, it, expect } from 'vitest';
import { validateAuthEnv } from '../../src/auth/env.js';

describe('validateAuthEnv', () => {
  it('returns config for valid HTTPS URL and password', () => {
    const config = validateAuthEnv('my-password', 'https://vault.example.com');
    expect(config.ownerPassword).toBe('my-password');
    expect(config.issuerUrl).toEqual(new URL('https://vault.example.com'));
  });

  it('allows http://localhost', () => {
    const config = validateAuthEnv('pass', 'http://localhost:3333');
    expect(config.issuerUrl.protocol).toBe('http:');
  });

  it('allows http://127.0.0.1', () => {
    const config = validateAuthEnv('pass', 'http://127.0.0.1:3333');
    expect(config.issuerUrl.protocol).toBe('http:');
  });

  it('throws if password is missing', () => {
    expect(() => validateAuthEnv('', 'https://vault.example.com')).toThrow('OAUTH_OWNER_PASSWORD');
  });

  it('throws if password is undefined', () => {
    expect(() => validateAuthEnv(undefined, 'https://vault.example.com')).toThrow('OAUTH_OWNER_PASSWORD');
  });

  it('throws if issuer URL is missing', () => {
    expect(() => validateAuthEnv('pass', '')).toThrow('OAUTH_ISSUER_URL');
  });

  it('throws if issuer URL is not valid', () => {
    expect(() => validateAuthEnv('pass', 'not-a-url')).toThrow('OAUTH_ISSUER_URL');
  });

  it('throws if issuer URL is HTTP but not localhost', () => {
    expect(() => validateAuthEnv('pass', 'http://vault.example.com')).toThrow('HTTPS');
  });
});
