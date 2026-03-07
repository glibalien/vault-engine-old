import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseMarkdown, extractPlainText } from '../../src/parser/markdown.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseMarkdown', () => {
  it('parses a markdown file into MDAST', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const tree = parseMarkdown(raw);
    expect(tree.type).toBe('root');
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it('recognizes frontmatter as a yaml node', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const tree = parseMarkdown(raw);
    const yamlNode = tree.children.find((n: any) => n.type === 'yaml');
    expect(yamlNode).toBeDefined();
  });

  it('preserves positions relative to full file', () => {
    const raw = '---\ntitle: Test\n---\nHello world';
    const tree = parseMarkdown(raw);
    const paragraph = tree.children.find((n: any) => n.type === 'paragraph');
    expect(paragraph?.position?.start.line).toBe(4);
  });
});

describe('extractPlainText', () => {
  it('extracts plain text from MDAST, skipping frontmatter', () => {
    const raw = '---\ntitle: Test\n---\nHello [[World]].\n\n- Item one\n- Item [[two]]';
    const tree = parseMarkdown(raw);
    const text = extractPlainText(tree);
    expect(text).toContain('Hello World.');
    expect(text).toContain('Item one');
    expect(text).toContain('Item two');
    expect(text).not.toContain('title: Test');
    expect(text).not.toContain('[[');
  });
});
