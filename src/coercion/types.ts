// src/coercion/types.ts
import type { SchemaFieldType, FieldDefinition } from '../schema/types.js';
import type { EnumValidationPolicy } from '../enforcement/types.js';

export type UnknownFieldPolicy = 'warn' | 'strip' | 'pass' | 'reject';

export interface CoercionPolicies {
  unknownFields?: UnknownFieldPolicy;
  enumValidation?: EnumValidationPolicy;
}

export interface CoercionChange {
  field: string;
  rule: 'scalar_to_list' | 'reference_wrap' | 'boolean_coerce' | 'number_coerce' | 'date_normalize' | 'enum_case' | 'alias_map';
  from: unknown;
  to: unknown;
}

export interface CoercionIssue {
  field: string;
  policy: 'unknown_fields' | 'enum_validation';
  severity: 'warning' | 'rejection';
  message: string;
}

export interface CoercionResult {
  fields: Record<string, unknown>;
  changes: CoercionChange[];
  unknownFields: string[];
  issues: CoercionIssue[];
}

export interface GlobalFieldDefinition {
  type: SchemaFieldType;
  canonical_name?: string;
  description?: string;
  coerce?: boolean;
  values?: string[];
}

export interface GlobalFieldsConfig {
  global_fields: Record<string, GlobalFieldDefinition>;
}
