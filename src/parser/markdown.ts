import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root } from 'mdast';
import { stripWikiLinks } from './wiki-links.js';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml']);

export function parseMarkdown(raw: string): Root {
  return processor.parse(raw);
}

export function extractPlainText(mdast: Root): string {
  const parts: string[] = [];
  collectText(mdast, parts);
  return parts.join('\n').trim();
}

function collectText(node: any, parts: string[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(stripWikiLinks(node.value));
    return;
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectText(child, parts);
    }
  }
}
