import type { ParsedFile } from '../parser/types.js';
import type { MergeResult, ValidationResult, ValidationWarning } from './types.js';

export function validateNode(parsed: ParsedFile, mergeResult: MergeResult): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const presentKeys = new Set(parsed.fields.map(f => f.key));

  // Check required fields
  for (const [name, field] of Object.entries(mergeResult.fields)) {
    if (field.required && !presentKeys.has(name)) {
      warnings.push({
        field: name,
        rule: 'required',
        message: `Required field '${name}' is missing`,
      });
    }
  }

  return { valid: warnings.length === 0, warnings };
}
