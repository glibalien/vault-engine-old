import { parseMarkdown } from '../parser/markdown.js';
import { extractWikiLinksFromMdast } from '../parser/wiki-links.js';

export function updateBodyReferences(body: string, oldTitle: string, newTitle: string): string {
  if (!body) return body;

  const mdast = parseMarkdown(body);
  const links = extractWikiLinksFromMdast(mdast);

  // Filter links matching old title (case-insensitive, exact match)
  const matching = links
    .filter(l => l.target.toLowerCase() === oldTitle.toLowerCase())
    .filter(l => l.position?.start.offset != null && l.position?.end.offset != null);

  if (matching.length === 0) return body;

  // Sort by offset descending so replacements don't shift earlier positions
  matching.sort((a, b) => b.position!.start.offset! - a.position!.start.offset!);

  let result = body;
  for (const link of matching) {
    const start = link.position!.start.offset!;
    const end = link.position!.end.offset!;
    const replacement = link.alias
      ? `[[${newTitle}|${link.alias}]]`
      : `[[${newTitle}]]`;
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

export function removeBodyWikiLink(body: string, target: string): string {
  if (!body) return body;

  const mdast = parseMarkdown(body);
  const links = extractWikiLinksFromMdast(mdast);

  const matching = links
    .filter(l => l.target.toLowerCase() === target.toLowerCase())
    .filter(l => l.position?.start.offset != null && l.position?.end.offset != null);

  if (matching.length === 0) return body;

  // Sort by offset descending so removals don't shift earlier positions
  matching.sort((a, b) => b.position!.start.offset! - a.position!.start.offset!);

  let result = body;
  for (const link of matching) {
    const start = link.position!.start.offset!;
    const end = link.position!.end.offset!;
    result = result.slice(0, start) + result.slice(end);
  }

  // Collapse runs of 3+ newlines to 2 (preserves paragraph spacing)
  result = result.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing whitespace
  result = result.trim();

  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceInValue(value: unknown, re: RegExp, newTitle: string): unknown {
  if (typeof value === 'string') {
    return value.replace(re, (_match: string, alias?: string) =>
      alias ? `[[${newTitle}${alias}]]` : `[[${newTitle}]]`
    );
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceInValue(item, re, newTitle));
  }
  return value;
}

export function updateFrontmatterReferences(
  fields: Record<string, unknown>,
  oldTitle: string,
  newTitle: string,
): Record<string, unknown> {
  const escaped = escapeRegExp(oldTitle);
  const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, 'gi');

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = replaceInValue(value, re, newTitle);
  }
  return result;
}
