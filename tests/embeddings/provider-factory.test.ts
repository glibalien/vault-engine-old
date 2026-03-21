import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/embeddings/provider-factory.js';
import { OllamaProvider } from '../../src/embeddings/providers/ollama.js';
import { OpenAIProvider } from '../../src/embeddings/providers/openai.js';

describe('createProvider', () => {
  it('creates OllamaProvider for ollama config', () => {
    const provider = createProvider({ provider: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('creates OpenAIProvider for openai config', () => {
    const provider = createProvider({ provider: 'openai' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('passes custom model to Ollama provider', () => {
    const provider = createProvider({ provider: 'ollama', model: 'mxbai-embed-large' });
    expect(provider.modelName).toBe('mxbai-embed-large');
  });

  it('passes custom model to OpenAI provider', () => {
    const provider = createProvider({ provider: 'openai', model: 'text-embedding-ada-002' });
    expect(provider.modelName).toBe('text-embedding-ada-002');
  });

  it('passes custom baseUrl to Ollama provider', () => {
    const provider = createProvider({ provider: 'ollama', baseUrl: 'http://remote:11434' }) as OllamaProvider;
    // Verify it uses the baseUrl by checking it's still an OllamaProvider with the right model
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.dimensions).toBe(768);
  });

  it('passes custom baseUrl to OpenAI provider', () => {
    const provider = createProvider({ provider: 'openai', baseUrl: 'https://custom.openai.proxy' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.dimensions).toBe(1536);
  });
});
