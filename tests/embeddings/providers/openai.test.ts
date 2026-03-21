import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../../src/embeddings/providers/openai.js';

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('has correct default dimensions and model', () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    expect(provider.dimensions).toBe(1536);
    expect(provider.modelName).toBe('text-embedding-3-small');
  });

  it('calls POST https://api.openai.com/v1/embeddings with Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const result = await provider.embed(['hello']);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['hello'],
    });
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it('returns embeddings sorted by index', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
          { embedding: [0.5, 0.6], index: 2 },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const result = await provider.embed(['a', 'b', 'c']);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ]);
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OpenAIProvider({ apiKey: 'bad-key' });
    await expect(provider.embed(['test'])).rejects.toThrow('OpenAI embed failed (401): Unauthorized');
  });

  it('reads apiKey from OPENAI_API_KEY env var if not provided', async () => {
    process.env.OPENAI_API_KEY = 'env-key-123';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1], index: 0 }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OpenAIProvider();
    await provider.embed(['test']);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer env-key-123');
  });
});
