import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../../src/embeddings/providers/ollama.js';

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct default dimensions and model', () => {
    const provider = new OllamaProvider();
    expect(provider.dimensions).toBe(768);
    expect(provider.modelName).toBe('nomic-embed-text');
  });

  it('calls POST http://localhost:11434/api/embed with model and input body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OllamaProvider();
    const result = await provider.embed(['hello world']);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'nomic-embed-text',
      input: ['hello world'],
    });
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('uses custom baseUrl and model when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2]] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OllamaProvider({
      baseUrl: 'http://my-ollama:8080/',
      model: 'mxbai-embed-large',
      dimensions: 1024,
    });

    expect(provider.modelName).toBe('mxbai-embed-large');
    expect(provider.dimensions).toBe(1024);

    await provider.embed(['test']);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://my-ollama:8080/api/embed');
    expect(JSON.parse(init.body as string).model).toBe('mxbai-embed-large');
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new OllamaProvider();
    await expect(provider.embed(['test'])).rejects.toThrow('Ollama embed failed (500): Internal Server Error');
  });
});
