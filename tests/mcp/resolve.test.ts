import { describe, it, expect } from 'vitest';
import { normalizeTypographic, normalizeForLookup } from '../../src/mcp/resolve.js';

describe('normalizeTypographic', () => {
  it('maps curly single quotes to straight', () => {
    expect(normalizeTypographic('\u2018hello\u2019')).toBe("'hello'");
  });

  it('maps curly double quotes to straight', () => {
    expect(normalizeTypographic('\u201Chello\u201D')).toBe('"hello"');
  });

  it('maps en-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2013B')).toBe('A-B');
  });

  it('maps em-dash to hyphen', () => {
    expect(normalizeTypographic('A\u2014B')).toBe('A-B');
  });

  it('maps ellipsis to three dots', () => {
    expect(normalizeTypographic('wait\u2026')).toBe('wait...');
  });

  it('maps non-breaking space to regular space', () => {
    expect(normalizeTypographic('hello\u00A0world')).toBe('hello world');
  });

  it('returns unchanged string when no typographic chars present', () => {
    expect(normalizeTypographic('hello world')).toBe('hello world');
  });

  it('handles multiple replacements in one string', () => {
    expect(normalizeTypographic('It\u2019s \u201Cfine\u201D \u2014 really\u2026'))
      .toBe("It's \"fine\" - really...");
  });
});

describe('normalizeForLookup', () => {
  it('applies NFC then typographic normalization then lowercases', () => {
    // NFC: e + combining accent -> e-acute
    const decomposed = 'caf\u0065\u0301';
    const result = normalizeForLookup(decomposed);
    expect(result).toBe('caf\u00e9');
  });

  it('applies typographic normalization and lowercases', () => {
    expect(normalizeForLookup('It\u2019s FINE')).toBe("it's fine");
  });

  it('handles combined NFC + typographic', () => {
    const input = 'Caf\u0065\u0301 \u2014 It\u2019s';
    expect(normalizeForLookup(input)).toBe("caf\u00e9 - it's");
  });
});
