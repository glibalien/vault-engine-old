// tests/attachments/readers.test.ts
import { describe, it, expect } from 'vitest';
import { readImage, readDocument, readAudio, formatTimestamp, formatDiarized } from '../../src/attachments/readers.js';
import type { WhisperSegment } from '../../src/attachments/readers.js';
import { resolve } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures/attachments');

describe('readImage', () => {
  it('returns base64 image content block for raster images', () => {
    const result = readImage(resolve(fixturesDir, 'pixel.png'), 'pixel.png');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect((result.content[0] as any).data).toBeTruthy();
  });

  it('returns text content block for SVG', () => {
    const result = readImage(resolve(fixturesDir, 'sample.svg'), 'sample.svg');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toContain('<svg');
  });
});

describe('readDocument', () => {
  it('reads plain text files', async () => {
    const result = await readDocument(resolve(fixturesDir, 'sample.txt'), 'sample.txt');
    expect(result.ok).toBe(true);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain('sample text content');
  });
});

describe('readAudio', () => {
  it('returns error when FIREWORKS_API_KEY is not set', async () => {
    const originalKey = process.env.FIREWORKS_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    try {
      const result = await readAudio('/fake/path/recording.m4a', 'recording.m4a');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('FIREWORKS_API_KEY');
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('FIREWORKS_API_KEY not set');
    } finally {
      if (originalKey !== undefined) process.env.FIREWORKS_API_KEY = originalKey;
    }
  });
});

describe('formatTimestamp', () => {
  it('formats seconds as M:SS', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(5)).toBe('0:05');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(599)).toBe('9:59');
  });

  it('formats as H:MM:SS when over an hour', () => {
    expect(formatTimestamp(3600)).toBe('1:00:00');
    expect(formatTimestamp(3661)).toBe('1:01:01');
    expect(formatTimestamp(7325)).toBe('2:02:05');
  });
});

describe('formatDiarized', () => {
  it('merges consecutive segments from same speaker', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: 0, text: 'Hello', start: 0, end: 2 },
      { speaker_id: 0, text: 'world', start: 2, end: 4 },
      { speaker_id: 1, text: 'Hi there', start: 4, end: 6 },
    ];
    const result = formatDiarized(segments);
    expect(result).toContain('**Speaker 0** (0:00 - 0:04)');
    expect(result).toContain('Hello world');
    expect(result).toContain('**Speaker 1** (0:04 - 0:06)');
    expect(result).toContain('Hi there');
  });

  it('handles null speaker_id as Unknown Speaker', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: null, text: 'Unknown', start: 0, end: 5 },
    ];
    const result = formatDiarized(segments);
    expect(result).toContain('**Unknown Speaker**');
  });

  it('skips empty text segments', () => {
    const segments: WhisperSegment[] = [
      { speaker_id: 0, text: '', start: 0, end: 1 },
      { speaker_id: 0, text: 'Actual text', start: 1, end: 3 },
    ];
    const result = formatDiarized(segments);
    expect(result).toBe('**Speaker 0** (0:01 - 0:03)\nActual text');
  });

  it('returns empty string for no segments', () => {
    expect(formatDiarized([])).toBe('');
  });
});
