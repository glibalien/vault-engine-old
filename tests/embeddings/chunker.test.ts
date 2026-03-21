import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/parser/index.js';
import { chunkFile } from '../../src/embeddings/chunker.js';

describe('chunkFile', () => {
  it('returns a single full chunk for short files with no headings', () => {
    const raw = '---\ntitle: Short Note\ntypes: [note]\n---\n\nJust a brief note.';
    const parsed = parseFile('notes/short.md', raw);
    const chunks = chunkFile(parsed, 'notes/short.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('notes/short.md#full');
    expect(chunks[0].nodeId).toBe('notes/short.md');
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].content).toContain('Just a brief note');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('splits on headings into section chunks', () => {
    const raw = [
      '---', 'title: Meeting Notes', 'types: [meeting]', '---', '',
      'Opening remarks about the quarterly planning session and initial thoughts on direction.',
      '',
      '## Discussion', '',
      'We discussed the budget allocation for the upcoming quarter including infrastructure costs, ' +
      'vendor contracts, staffing requirements, and operational expenses. The team reviewed the ' +
      'projected revenue numbers and identified several areas where spending could be optimized. ' +
      'Alice presented the analysis of current resource utilization across all departments. ' +
      'Bob raised concerns about the timeline for the infrastructure migration project.',
      '',
      'The group agreed that a detailed review of the vendor contracts was necessary before ' +
      'finalizing any budget decisions. Several action items were identified and assigned to ' +
      'team members for appropriate follow-up. The meeting ran for two hours total.',
      '',
      '## Action Items', '',
      '- Alice to send updated spreadsheet with revised budget projections by end of week',
      '- Bob to review vendor proposals and prepare comparison matrix for next meeting',
      '- Charlie to schedule follow-up sessions with each department lead to gather feedback',
      '- Diana to draft the executive summary document for the board presentation next month',
    ].join('\n');
    const parsed = parseFile('meetings/standup.md', raw);
    const chunks = chunkFile(parsed, 'meetings/standup.md');
    expect(chunks.length).toBe(3);
    expect(chunks[0].id).toBe('meetings/standup.md#section:0');
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].content).toContain('Opening remarks');
    expect(chunks[1].id).toBe('meetings/standup.md#section:1');
    expect(chunks[1].heading).toBe('Discussion');
    expect(chunks[1].content).toContain('budget');
    expect(chunks[2].id).toBe('meetings/standup.md#section:2');
    expect(chunks[2].heading).toBe('Action Items');
    expect(chunks[2].content).toContain('Alice');
  });

  it('handles wiki-links in chunk text', () => {
    const raw = '---\ntitle: Test\ntypes: [note]\n---\n\nTalk to [[Alice Smith]] about it.';
    const parsed = parseFile('notes/test.md', raw);
    const chunks = chunkFile(parsed, 'notes/test.md');
    expect(chunks[0].content).toContain('Alice Smith');
  });

  it('returns full chunk when file has headings but total content is short', () => {
    const raw = '---\ntitle: Tiny\ntypes: [note]\n---\n\n## One\n\nHello.\n\n## Two\n\nWorld.';
    const parsed = parseFile('notes/tiny.md', raw);
    const chunks = chunkFile(parsed, 'notes/tiny.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('notes/tiny.md#full');
  });

  it('estimates token count using word count * 1.3', () => {
    const words = Array(100).fill('word').join(' ');
    const raw = `---\ntitle: Tokens\ntypes: [note]\n---\n\n${words}`;
    const parsed = parseFile('notes/tokens.md', raw);
    const chunks = chunkFile(parsed, 'notes/tokens.md');
    expect(chunks[0].tokenCount).toBe(130);
  });

  it('chunk indices are sequential starting from 0', () => {
    const raw = [
      '---', 'title: Multi', 'types: [note]', '---', '',
      '## A', '', 'Content A with enough words to make this section meaningful for chunking purposes.',
      '', '## B', '', 'Content B with enough words to make this section meaningful for chunking purposes.',
      '', '## C', '', 'Content C with enough words to make this section meaningful for chunking purposes.',
    ].join('\n');
    const parsed = parseFile('notes/multi.md', raw);
    const chunks = chunkFile(parsed, 'notes/multi.md');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });
});
