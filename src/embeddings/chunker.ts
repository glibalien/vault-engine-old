import type { ParsedFile } from '../parser/types.js';
import type { Chunk } from './types.js';

const SHORT_CONTENT_THRESHOLD = 200; // tokens

export function chunkFile(parsed: ParsedFile, nodeId: string): Chunk[] {
  const mdast = parsed.mdast;
  const bodyChildren = mdast.children.filter(n => n.type !== 'yaml');

  const headingIndices: number[] = [];
  for (let i = 0; i < bodyChildren.length; i++) {
    if (bodyChildren[i].type === 'heading') {
      headingIndices.push(i);
    }
  }

  const fullText = extractTextFromNodes(bodyChildren);
  const fullTokens = estimateTokens(fullText);

  if (headingIndices.length === 0 || fullTokens < SHORT_CONTENT_THRESHOLD) {
    return [{
      id: `${nodeId}#full`,
      nodeId,
      chunkIndex: 0,
      heading: null,
      content: fullText,
      tokenCount: fullTokens,
    }];
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  if (headingIndices[0] > 0) {
    const preNodes = bodyChildren.slice(0, headingIndices[0]);
    const text = extractTextFromNodes(preNodes);
    if (text.trim().length > 0) {
      chunks.push({
        id: `${nodeId}#section:${chunkIndex}`,
        nodeId, chunkIndex,
        heading: null,
        content: text,
        tokenCount: estimateTokens(text),
      });
      chunkIndex++;
    }
  }

  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : bodyChildren.length;
    const sectionNodes = bodyChildren.slice(start, end);
    const headingNode = sectionNodes[0] as any;
    const headingText = extractTextFromNodes([headingNode]).trim();
    const contentNodes = sectionNodes.slice(1);
    const text = extractTextFromNodes(contentNodes);

    chunks.push({
      id: `${nodeId}#section:${chunkIndex}`,
      nodeId, chunkIndex,
      heading: headingText,
      content: text,
      tokenCount: estimateTokens(text),
    });
    chunkIndex++;
  }

  return chunks;
}

function extractTextFromNodes(nodes: any[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    collectText(node, parts);
  }
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

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(words * 1.3);
}
