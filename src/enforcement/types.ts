// src/enforcement/types.ts

export type NormalizeOnIndexPolicy = 'off' | 'warn' | 'fix';
export type UnknownFieldsPolicy = 'warn' | 'strip' | 'reject';
export type EnumValidationPolicy = 'coerce' | 'warn' | 'reject';

export interface PolicyWithOverrides<T extends string> {
  default: T;
  per_type?: Record<string, T>;
}

export interface EnforcementConfig {
  write_path: {
    coercion: 'always';
  };
  normalize_on_index: PolicyWithOverrides<NormalizeOnIndexPolicy>;
  unknown_fields: PolicyWithOverrides<UnknownFieldsPolicy>;
  enum_validation: PolicyWithOverrides<EnumValidationPolicy>;
}

/** Flat resolved policies for a specific set of node types. */
export interface ResolvedPolicies {
  unknownFields: UnknownFieldsPolicy;
  enumValidation: EnumValidationPolicy;
  normalizeOnIndex: NormalizeOnIndexPolicy;
}
