import type { Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import type { WikiLinkNode } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const remarkWikiLink: Plugin<[], Root> = () => (tree: Root) => {
  transformChildren(tree);
};

function transformChildren(node: any): void {
  if (!node.children || !Array.isArray(node.children)) return;
  if (node.type === 'yaml') return;

  let changed = false;
  const newChildren: any[] = [];

  for (const child of node.children) {
    if (child.type === 'text' && child.value.includes('[[')) {
      const split = splitTextNode(child);
      if (split.length !== 1 || split[0] !== child) {
        newChildren.push(...split);
        changed = true;
      } else {
        newChildren.push(child);
      }
    } else {
      newChildren.push(child);
    }
  }

  if (changed) {
    node.children = newChildren;
  }

  for (const child of node.children) {
    transformChildren(child);
  }
}

function splitTextNode(node: Text): (Text | WikiLinkNode)[] {
  const result: (Text | WikiLinkNode)[] = [];
  const text = node.value;
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(makeText(text.slice(lastIndex, match.index), node, lastIndex));
    }

    const wikiLink: WikiLinkNode = {
      type: 'wikiLink',
      target: match[1].trim(),
    };
    const alias = match[2]?.trim();
    if (alias) wikiLink.alias = alias;

    if (node.position && node.position.start.offset != null) {
      const startOffset = node.position.start.offset + match.index;
      const endOffset = startOffset + match[0].length;
      wikiLink.position = {
        start: {
          line: node.position.start.line,
          column: node.position.start.column + match.index,
          offset: startOffset,
        },
        end: {
          line: node.position.start.line,
          column: node.position.start.column + match.index + match[0].length,
          offset: endOffset,
        },
      };
    }

    result.push(wikiLink);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) return [node];

  if (lastIndex < text.length) {
    result.push(makeText(text.slice(lastIndex), node, lastIndex));
  }

  return result;
}

function makeText(value: string, parent: Text, offsetInParent: number): Text {
  const node: Text = { type: 'text', value };
  if (parent.position && parent.position.start.offset != null) {
    const startOffset = parent.position.start.offset + offsetInParent;
    node.position = {
      start: {
        line: parent.position.start.line,
        column: parent.position.start.column + offsetInParent,
        offset: startOffset,
      },
      end: {
        line: parent.position.start.line,
        column: parent.position.start.column + offsetInParent + value.length,
        offset: startOffset + value.length,
      },
    };
  }
  return node;
}

export default remarkWikiLink;
