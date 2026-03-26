// src/inference/types.ts
import type { SchemaFieldType } from '../schema/types.js';

export interface InferredField {
  key: string;
  inferred_type: SchemaFieldType;
  frequency: number;
  distinct_values: number;
  sample_values: string[];
  enum_candidate: boolean;
  enum_values?: string[];
}

export interface Discrepancy {
  field: string;
  issue: string;
  schema_value: unknown;
  inferred_value: unknown;
}

export interface TypeAnalysis {
  name: string;
  node_count: number;
  has_existing_schema: boolean;
  inferred_fields: InferredField[];
  discrepancies: Discrepancy[];
  shared_fields: string[];
}

export interface InferenceResult {
  types: TypeAnalysis[];
}

export type InferenceMode = 'report' | 'merge' | 'overwrite';
