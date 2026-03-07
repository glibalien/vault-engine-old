import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseFrontmatter', () => {
  it('extracts frontmatter data and body content', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe('Review vendor proposals');
    expect(result.content).toContain('Review the three vendor proposals');
  });

  it('extracts types array', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual(['meeting', 'task']);
  });

  it('defaults types to empty array when missing', () => {
    const raw = '---\ntitle: No Types\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual([]);
  });

  it('handles single type as string', () => {
    const raw = '---\ntitle: Test\ntypes: task\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual(['task']);
  });
});

describe('field type inference', () => {
  it('infers reference type for wiki-link strings', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const assignee = result.fields.find(f => f.key === 'assignee');
    expect(assignee?.valueType).toBe('reference');
  });

  it('infers list type for arrays', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const attendees = result.fields.find(f => f.key === 'attendees');
    expect(attendees?.valueType).toBe('list');
  });

  it('infers date type for date values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const dueDate = result.fields.find(f => f.key === 'due_date');
    expect(dueDate?.valueType).toBe('date');
  });

  it('infers number type for numeric values', () => {
    const raw = '---\ntitle: Test\ncount: 42\nprice: 3.14\n---\nBody';
    const result = parseFrontmatter(raw);
    const count = result.fields.find(f => f.key === 'count');
    const price = result.fields.find(f => f.key === 'price');
    expect(count?.valueType).toBe('number');
    expect(price?.valueType).toBe('number');
  });

  it('infers boolean type for true/false', () => {
    const raw = '---\ntitle: Test\nactive: true\n---\nBody';
    const result = parseFrontmatter(raw);
    const active = result.fields.find(f => f.key === 'active');
    expect(active?.valueType).toBe('boolean');
  });

  it('infers string type for plain strings', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const role = result.fields.find(f => f.key === 'role');
    expect(role?.valueType).toBe('string');
  });

  it('excludes title and types from fields', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const keys = result.fields.map(f => f.key);
    expect(keys).not.toContain('title');
    expect(keys).not.toContain('types');
  });

  it('extracts wiki-links from frontmatter values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const assigneeLink = result.wikiLinks.find(l => l.field === 'assignee');
    expect(assigneeLink?.target).toBe('Bob Jones');
    expect(assigneeLink?.source).toBe('frontmatter');
  });

  it('extracts wiki-links from array frontmatter values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const attendeeLinks = result.wikiLinks.filter(l => l.field === 'attendees');
    expect(attendeeLinks).toHaveLength(2);
    expect(attendeeLinks.map(l => l.target)).toEqual(['Alice Smith', 'Bob Jones']);
  });
});
