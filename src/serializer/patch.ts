// src/serializer/patch.ts

export type FrontmatterMutation =
  | { type: 'rename_key'; from: string; to: string }
  | { type: 'coerce_value'; key: string; targetType: string };

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

  for (const mutation of mutations) {
    if (mutation.type === 'rename_key') {
      // Skip if target key already exists in the YAML
      const targetRe = new RegExp(`^${escapeRegExp(mutation.to)}:`, 'm');
      if (targetRe.test(yaml)) continue;

      // Replace key name at start of line, preserving the colon and everything after
      const sourceRe = new RegExp(`^${escapeRegExp(mutation.from)}(:)`, 'm');
      yaml = yaml.replace(sourceRe, `${mutation.to}$1`);
    } else if (mutation.type === 'coerce_value') {
      // Only coerce for list target types
      if (!mutation.targetType.startsWith('list')) continue;

      // Find the key's line and wrap non-array value in brackets
      const keyRe = new RegExp(
        `^(${escapeRegExp(mutation.key)}:\\s+)(.+)$`,
        'm',
      );
      yaml = yaml.replace(keyRe, (_match, prefix: string, value: string) => {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) return prefix + value; // Already an array
        return `${prefix}[${trimmed}]`;
      });
    }
  }

  return open + yaml + close + body;
}
