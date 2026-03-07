import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkWikiLink from '../../src/parser/remark-wiki-link.js';
import type { Root } from 'mdast';
import type { WikiLinkNode } from '../../src/parser/types.js';

function parse(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkWikiLink);
  return processor.runSync(processor.parse(md)) as Root;
}

function collectNodes<T>(node: any, type: string): T[] {
  const result: T[] = [];
  if (node.type === type) result.push(node as T);
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      result.push(...collectNodes<T>(child, type));
    }
  }
  return result;
}

describe('remarkWikiLink', () => {
  it('transforms [[target]] into a wikiLink node', () => {
    const tree = parse('Hello [[Alice]].');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice');
    expect(links[0].alias).toBeUndefined();
  });

  it('transforms [[target|alias]] preserving both properties', () => {
    const tree = parse('See [[Alice Smith|Alice]].');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice Smith');
    expect(links[0].alias).toBe('Alice');
  });

  it('splits surrounding text into separate text nodes', () => {
    const tree = parse('Hello [[Alice]] goodbye.');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(3);
    expect(para.children[0]).toMatchObject({ type: 'text', value: 'Hello ' });
    expect(para.children[1]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
    expect(para.children[2]).toMatchObject({ type: 'text', value: ' goodbye.' });
  });

  it('handles multiple wiki-links in one paragraph', () => {
    const tree = parse('Talk to [[Alice]] and [[Bob]] today.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe('Alice');
    expect(links[1].target).toBe('Bob');
  });

  it('handles wiki-link as entire paragraph text', () => {
    const tree = parse('[[Alice]]');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(1);
    expect(para.children[0]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
  });

  it('transforms wiki-links inside list items', () => {
    const tree = parse('- Talk to [[Alice]]\n- See [[Bob]]');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(2);
    expect(links.map(l => l.target)).toEqual(['Alice', 'Bob']);
  });

  it('transforms wiki-links inside headings', () => {
    const tree = parse('## Meeting with [[Alice]]');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Alice');
  });

  it('does NOT transform [[...]] inside fenced code blocks', () => {
    const tree = parse('```\n[[Alice]]\n```');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('does NOT transform [[...]] inside inline code', () => {
    const tree = parse('Use `[[Alice]]` syntax.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('does NOT transform [[...]] inside YAML frontmatter', () => {
    const tree = parse('---\nassignee: "[[Alice]]"\n---\n\nBody text.');
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links).toHaveLength(0);
  });

  it('computes position with correct offset for wikiLink nodes', () => {
    const md = 'Hi [[Alice]].';
    const tree = parse(md);
    const links = collectNodes<WikiLinkNode>(tree, 'wikiLink');
    expect(links[0].position).toBeDefined();
    expect(links[0].position!.start.offset).toBe(3);
    expect(links[0].position!.end.offset).toBe(12);
  });

  it('drops empty text fragments when wiki-link is at start or end', () => {
    const tree = parse('[[Alice]] said hello');
    const para = tree.children[0] as any;
    expect(para.children).toHaveLength(2);
    expect(para.children[0]).toMatchObject({ type: 'wikiLink', target: 'Alice' });
    expect(para.children[1]).toMatchObject({ type: 'text', value: ' said hello' });
  });
});
