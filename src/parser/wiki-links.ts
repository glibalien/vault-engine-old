import type { Root } from 'mdast';
import type { WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface RawWikiLink {
  target: string;
  alias?: string;
}

export function extractWikiLinksFromString(text: string): RawWikiLink[] {
  const links: RawWikiLink[] = [];
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    links.push({
      target: match[1].trim(),
      alias: match[2]?.trim(),
    });
  }
  return links;
}

export function extractWikiLinksFromMdast(mdast: Root): WikiLink[] {
  const links: WikiLink[] = [];
  visitForLinks(mdast, links, undefined);
  return links;
}

function visitForLinks(node: any, links: WikiLink[], parent: any | undefined): void {
  if (node.type === 'wikiLink') {
    links.push({
      target: node.target,
      alias: node.alias,
      source: 'body',
      context: parent ? buildContext(parent) : undefined,
      position: node.position,
    });
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      visitForLinks(child, links, node);
    }
  }
}

function buildContext(parent: any): string {
  if (!parent.children || !Array.isArray(parent.children)) return '';
  return parent.children
    .map((child: any) => {
      if (child.type === 'text') return child.value;
      if (child.type === 'wikiLink') return child.alias ?? child.target;
      return '';
    })
    .join('');
}
