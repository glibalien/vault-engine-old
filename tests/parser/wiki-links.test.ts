import { describe, it, expect } from 'vitest';
import { extractWikiLinksFromString, extractWikiLinksFromMdast } from '../../src/parser/wiki-links.js';
import type { Root } from 'mdast';

describe('extractWikiLinksFromString', () => {
  it('extracts a simple wiki-link', () => {
    const result = extractWikiLinksFromString('[[Bob Jones]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: undefined }]);
  });

  it('extracts a wiki-link with alias', () => {
    const result = extractWikiLinksFromString('[[Bob Jones|Bob]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: 'Bob' }]);
  });

  it('extracts multiple wiki-links from one string', () => {
    const result = extractWikiLinksFromString('Talk to [[Alice]] and [[Bob]]');
    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('Alice');
    expect(result[1].target).toBe('Bob');
  });

  it('returns empty array for no links', () => {
    const result = extractWikiLinksFromString('no links here');
    expect(result).toEqual([]);
  });

  it('handles wiki-links in array values', () => {
    const values = ['[[Alice Smith]]', '[[Bob Jones]]'];
    const results = values.flatMap(v => extractWikiLinksFromString(v));
    expect(results).toHaveLength(2);
    expect(results[0].target).toBe('Alice Smith');
    expect(results[1].target).toBe('Bob Jones');
  });
});

describe('extractWikiLinksFromMdast', () => {
  it('extracts wiki-links from wikiLink nodes with context', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Read proposal from ' },
            {
              type: 'wikiLink',
              target: 'Acme Corp',
              position: {
                start: { line: 5, column: 20, offset: 59 },
                end: { line: 5, column: 33, offset: 72 },
              },
            } as any,
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('Acme Corp');
    expect(result[0].source).toBe('body');
    expect(result[0].context).toBe('Read proposal from Acme Corp');
    expect(result[0].position).toBeDefined();
  });

  it('extracts multiple wiki-links from multiple paragraphs', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'wikiLink', target: 'Alice' } as any,
            { type: 'text', value: ' and ' },
            { type: 'wikiLink', target: 'Bob' } as any,
          ],
        },
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'wikiLink', target: 'Charlie' } as any,
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result).toHaveLength(3);
    expect(result.map(l => l.target)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('builds context from sibling nodes in parent', () => {
    const mdast: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Talk to ' },
            { type: 'wikiLink', target: 'Alice', alias: 'A' } as any,
            { type: 'text', value: ' and ' },
            { type: 'wikiLink', target: 'Bob' } as any,
            { type: 'text', value: ' today.' },
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast);
    expect(result[0].context).toBe('Talk to A and Bob today.');
    expect(result[1].context).toBe('Talk to A and Bob today.');
  });
});
