// src/schema/types.ts

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'reference'
  | 'list<string>'
  | 'list<reference>';

export interface FieldDefinition {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  target_schema?: string;
}

export interface SchemaDefinition {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}

export interface ResolvedSchema {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  ancestors: string[];
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}
