import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnforcementConfig, resolveEnforcementPolicies } from '../../src/enforcement/loader.js';
import type { EnforcementConfig } from '../../src/enforcement/types.js';

describe('loadEnforcementConfig', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'enforcement-'));
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadEnforcementConfig(vaultPath);
    expect(config.write_path.coercion).toBe('always');
    expect(config.normalize_on_index.default).toBe('warn');
    expect(config.unknown_fields.default).toBe('warn');
    expect(config.enum_validation.default).toBe('coerce');
    expect(config.normalize_on_index.per_type).toBeUndefined();
    expect(config.unknown_fields.per_type).toBeUndefined();
    expect(config.enum_validation.per_type).toBeUndefined();
  });

  it('returns defaults when .vault-engine dir exists but no enforcement.yaml', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.default).toBe('warn');
  });

  it('loads a full config', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
enforcement:
  write_path:
    coercion: always
  normalize_on_index:
    default: warn
    per_type:
      task: fix
      meeting: fix
  unknown_fields:
    default: warn
    per_type:
      task: reject
      note: warn
  enum_validation:
    default: coerce
    per_type:
      task: reject
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.write_path.coercion).toBe('always');
    expect(config.normalize_on_index.default).toBe('warn');
    expect(config.normalize_on_index.per_type).toEqual({ task: 'fix', meeting: 'fix' });
    expect(config.unknown_fields.default).toBe('warn');
    expect(config.unknown_fields.per_type).toEqual({ task: 'reject', note: 'warn' });
    expect(config.enum_validation.default).toBe('coerce');
    expect(config.enum_validation.per_type).toEqual({ task: 'reject' });
  });

  it('fills missing sections with defaults', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
enforcement:
  unknown_fields:
    default: strip
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.default).toBe('strip');
    expect(config.normalize_on_index.default).toBe('warn');
    expect(config.enum_validation.default).toBe('coerce');
  });

  it('accepts config without enforcement wrapper key', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
unknown_fields:
  default: reject
enum_validation:
  default: warn
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.default).toBe('reject');
    expect(config.enum_validation.default).toBe('warn');
  });

  it('falls back to defaults on invalid YAML', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
: : invalid yaml {{
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.default).toBe('warn');
    expect(config.enum_validation.default).toBe('coerce');
  });

  it('ignores invalid policy values and uses defaults', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
enforcement:
  unknown_fields:
    default: explode
  enum_validation:
    default: nuke
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.default).toBe('warn');
    expect(config.enum_validation.default).toBe('coerce');
  });

  it('skips invalid per_type entries', () => {
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, '.vault-engine', 'enforcement.yaml'), `
enforcement:
  unknown_fields:
    default: warn
    per_type:
      task: reject
      note: explode
`);
    const config = loadEnforcementConfig(vaultPath);
    expect(config.unknown_fields.per_type).toEqual({ task: 'reject' });
  });
});

describe('resolveEnforcementPolicies', () => {
  const fullConfig: EnforcementConfig = {
    write_path: { coercion: 'always' },
    normalize_on_index: {
      default: 'warn',
      per_type: { task: 'fix', meeting: 'fix', 'daily-note': 'off' },
    },
    unknown_fields: {
      default: 'warn',
      per_type: { task: 'reject', note: 'warn' },
    },
    enum_validation: {
      default: 'coerce',
      per_type: { task: 'reject', meeting: 'warn' },
    },
  };

  it('returns defaults for empty types array', () => {
    const policies = resolveEnforcementPolicies(fullConfig, []);
    expect(policies.unknownFields).toBe('warn');
    expect(policies.enumValidation).toBe('coerce');
    expect(policies.normalizeOnIndex).toBe('warn');
  });

  it('returns defaults for types without overrides', () => {
    const policies = resolveEnforcementPolicies(fullConfig, ['clipping']);
    expect(policies.unknownFields).toBe('warn');
    expect(policies.enumValidation).toBe('coerce');
    expect(policies.normalizeOnIndex).toBe('warn');
  });

  it('returns per-type override for single type', () => {
    const policies = resolveEnforcementPolicies(fullConfig, ['task']);
    expect(policies.unknownFields).toBe('reject');
    expect(policies.enumValidation).toBe('reject');
    expect(policies.normalizeOnIndex).toBe('fix');
  });

  it('picks most restrictive for multi-type nodes', () => {
    // task: reject/reject/fix, note: warn/coerce(default)/warn(default)
    const policies = resolveEnforcementPolicies(fullConfig, ['task', 'note']);
    expect(policies.unknownFields).toBe('reject');
    expect(policies.enumValidation).toBe('reject');
    expect(policies.normalizeOnIndex).toBe('fix');
  });

  it('picks most restrictive when one type has override and other uses default', () => {
    // meeting: warn(default)/warn/fix, clipping: warn(default)/coerce(default)/warn(default)
    const policies = resolveEnforcementPolicies(fullConfig, ['meeting', 'clipping']);
    expect(policies.unknownFields).toBe('warn');
    expect(policies.enumValidation).toBe('warn');
    expect(policies.normalizeOnIndex).toBe('fix');
  });

  it('handles daily-note off override', () => {
    const policies = resolveEnforcementPolicies(fullConfig, ['daily-note']);
    expect(policies.normalizeOnIndex).toBe('off');
  });

  it('most restrictive: fix beats off', () => {
    // task: fix, daily-note: off → fix wins
    const policies = resolveEnforcementPolicies(fullConfig, ['task', 'daily-note']);
    expect(policies.normalizeOnIndex).toBe('fix');
  });

  it('works with no per_type overrides at all', () => {
    const simpleConfig: EnforcementConfig = {
      write_path: { coercion: 'always' },
      normalize_on_index: { default: 'fix' },
      unknown_fields: { default: 'strip' },
      enum_validation: { default: 'reject' },
    };
    const policies = resolveEnforcementPolicies(simpleConfig, ['task', 'note']);
    expect(policies.unknownFields).toBe('strip');
    expect(policies.enumValidation).toBe('reject');
    expect(policies.normalizeOnIndex).toBe('fix');
  });
});
