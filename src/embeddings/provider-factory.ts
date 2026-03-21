import type { EmbeddingConfig, EmbeddingProvider } from './types.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';

export function createProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: config.baseUrl, model: config.model });
    case 'openai':
      return new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
  }
}
