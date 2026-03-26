export type {
  InferredField,
  Discrepancy,
  TypeAnalysis,
  InferenceResult,
  InferenceMode,
} from './types.js';

export { analyzeVault } from './analyzer.js';
export { generateSchemas, writeSchemaFiles } from './generator.js';
