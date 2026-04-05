// src/enforcement/loader.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  EnforcementConfig,
  ResolvedPolicies,
  UnknownFieldsPolicy,
  EnumValidationPolicy,
  NormalizeOnIndexPolicy,
  PolicyWithOverrides,
} from './types.js';

const DEFAULTS: EnforcementConfig = {
  write_path: { coercion: 'always' },
  normalize_on_index: { default: 'warn' },
  unknown_fields: { default: 'warn' },
  enum_validation: { default: 'coerce' },
};

const UNKNOWN_FIELDS_STRICTNESS: Record<UnknownFieldsPolicy, number> = {
  warn: 0,
  strip: 1,
  reject: 2,
};

const ENUM_VALIDATION_STRICTNESS: Record<EnumValidationPolicy, number> = {
  coerce: 0,
  warn: 1,
  reject: 2,
};

const NORMALIZE_STRICTNESS: Record<NormalizeOnIndexPolicy, number> = {
  off: 0,
  warn: 1,
  fix: 2,
};

const VALID_UNKNOWN_FIELDS = new Set<string>(['warn', 'strip', 'reject']);
const VALID_ENUM_VALIDATION = new Set<string>(['coerce', 'warn', 'reject']);
const VALID_NORMALIZE = new Set<string>(['off', 'warn', 'fix']);

function pickStrictest<T extends string>(values: T[], ordering: Record<T, number>): T {
  return values.reduce((a, b) => (ordering[b] > ordering[a] ? b : a));
}

function validatePolicy<T extends string>(
  value: unknown,
  validSet: Set<string>,
  fallback: T,
): T {
  if (typeof value === 'string' && validSet.has(value)) return value as T;
  return fallback;
}

function resolveSection<T extends string>(
  raw: unknown,
  validSet: Set<string>,
  fallback: T,
): PolicyWithOverrides<T> {
  if (!raw || typeof raw !== 'object') return { default: fallback };
  const obj = raw as Record<string, unknown>;
  const defaultVal = validatePolicy<T>(obj.default, validSet, fallback);
  const result: PolicyWithOverrides<T> = { default: defaultVal };

  if (obj.per_type && typeof obj.per_type === 'object') {
    const perType: Record<string, T> = {};
    for (const [type, val] of Object.entries(obj.per_type as Record<string, unknown>)) {
      const validated = validatePolicy<T>(val, validSet, defaultVal);
      if (typeof val === 'string' && validSet.has(val)) {
        perType[type] = validated;
      }
      // skip invalid per_type entries silently
    }
    if (Object.keys(perType).length > 0) {
      result.per_type = perType;
    }
  }

  return result;
}

export function loadEnforcementConfig(vaultPath: string): EnforcementConfig {
  const configPath = join(vaultPath, '.vault-engine', 'enforcement.yaml');
  if (!existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };

    const doc = (parsed as Record<string, unknown>).enforcement ?? parsed;
    if (!doc || typeof doc !== 'object') return { ...DEFAULTS };

    const config = doc as Record<string, unknown>;

    return {
      write_path: { coercion: 'always' },
      normalize_on_index: resolveSection<NormalizeOnIndexPolicy>(
        config.normalize_on_index, VALID_NORMALIZE, DEFAULTS.normalize_on_index.default,
      ),
      unknown_fields: resolveSection<UnknownFieldsPolicy>(
        config.unknown_fields, VALID_UNKNOWN_FIELDS, DEFAULTS.unknown_fields.default,
      ),
      enum_validation: resolveSection<EnumValidationPolicy>(
        config.enum_validation, VALID_ENUM_VALIDATION, DEFAULTS.enum_validation.default,
      ),
    };
  } catch {
    console.error('[vault-engine] failed to parse enforcement.yaml, using defaults');
    return { ...DEFAULTS };
  }
}

function resolveDimension<T extends string>(
  policy: PolicyWithOverrides<T>,
  types: string[],
  ordering: Record<T, number>,
): T {
  if (types.length === 0 || !policy.per_type) return policy.default;

  const values: T[] = types.map(t =>
    policy.per_type && t in policy.per_type ? policy.per_type[t] : policy.default,
  );

  return pickStrictest(values, ordering);
}

export function resolveEnforcementPolicies(
  config: EnforcementConfig,
  types: string[],
): ResolvedPolicies {
  return {
    unknownFields: resolveDimension(config.unknown_fields, types, UNKNOWN_FIELDS_STRICTNESS),
    enumValidation: resolveDimension(config.enum_validation, types, ENUM_VALIDATION_STRICTNESS),
    normalizeOnIndex: resolveDimension(config.normalize_on_index, types, NORMALIZE_STRICTNESS),
  };
}
