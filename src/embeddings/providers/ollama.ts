import type { EmbeddingProvider } from '../types.js';

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class OllamaProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts?: OllamaOptions) {
    this.baseUrl = (opts?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.modelName = opts?.model ?? 'nomic-embed-text';
    this.dimensions = opts?.dimensions ?? 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${body}`);
    }
    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }
}
