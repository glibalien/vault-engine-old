// src/serializer/patch.ts

import { isSeq, parseDocument } from 'yaml';
import { serializeKey } from './frontmatter.js';

export type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string }
  | { type: 'set_value'; key: string; value: unknown };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function patchFrontmatter(
  fileContent: string,
  mutations: FrontmatterMutation[],
): string {
  if (mutations.length === 0) return fileContent;

  // Match frontmatter block: opening ---, raw YAML, closing ---, body
  const fmMatch = fileContent.match(/^(---\n)([\s\S]*?\n)(---\n?)([\s\S]*)$/);
  if (!fmMatch) return fileContent;

  const [, open, rawYaml, close, body] = fmMatch;
  let yaml = rawYaml;

  // Phase 1: Apply rename_key mutations via regex
  for (const mutation of mutations) {
    if (mutation.type === 'rename_key') {
      // Skip if target key already exists in the YAML
      const targetRe = new RegExp(`^${escapeRegExp(mutation.to)}:`, 'm');
      if (targetRe.test(yaml)) continue;

      // Replace key name at start of line, preserving the colon and everything after
      const sourceRe = new RegExp(`^${escapeRegExp(mutation.from)}(:)`, 'm');
      yaml = yaml.replace(sourceRe, `${serializeKey(mutation.to)}$1`);
    }
  }

  // Phase 2: Apply set_value and coerce_value mutations via parse-mutate-serialize
  const phase2Mutations = mutations.filter(
    (m): m is Extract<FrontmatterMutation, { type: 'set_value' } | { type: 'coerce_value' }> =>
      m.type === 'set_value' || m.type === 'coerce_value',
  );

  if (phase2Mutations.length > 0) {
    const doc = parseDocument(yaml);
    if (doc.contents) {
      let changed = false;
      for (const mutation of phase2Mutations) {
        if (mutation.type === 'set_value') {
          if (doc.has(mutation.key)) {
            doc.set(mutation.key, mutation.value);
            changed = true;
          }
        } else {
          // coerce_value: wrap non-array scalar values in a single-element list
          if (!mutation.targetType.startsWith('list')) continue;
          if (!doc.has(mutation.key)) continue;
          const node = doc.get(mutation.key, true);
          if (node == null || isSeq(node)) continue; // already a list or null
          // It's a scalar — wrap it in a single-element array
          doc.set(mutation.key, [doc.get(mutation.key)]);
          changed = true;
        }
      }
      if (changed) {
        yaml = doc.toString();
      }
    }
  }

  return open + yaml + close + body;
}
