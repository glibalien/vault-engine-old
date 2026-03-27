// tests/attachments/readers.test.ts
import { describe, it, expect } from 'vitest';
import { readImage, readDocument, readAudio } from '../../src/attachments/readers.js';
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
