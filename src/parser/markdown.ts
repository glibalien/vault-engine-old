import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkWikiLink from './remark-wiki-link.js';
import type { Root } from 'mdast';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkWikiLink);

export function parseMarkdown(raw: string): Root {
  const tree = processor.parse(raw);
  return processor.runSync(tree) as Root;
}

export function extractPlainText(mdast: Root): string {
  const parts: string[] = [];
  collectText(mdast, parts);
  return parts.join('\n').trim();
}

function collectText(node: any, parts: string[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(node.value);
    return;
  }

  if (node.type === 'wikiLink') {
    parts.push(node.alias ?? node.target);
    return;
  }

  if (node.children && Array.isArray(node.children)) {
    const isBlock = node.type === 'paragraph' || node.type === 'heading'
      || node.type === 'listItem' || node.type === 'blockquote'
      || node.type === 'tableCell';

    if (isBlock) {
      const inline: string[] = [];
      for (const child of node.children) {
        collectText(child, inline);
      }
      parts.push(inline.join(''));
    } else {
      for (const child of node.children) {
        collectText(child, parts);
      }
    }
  }
}
