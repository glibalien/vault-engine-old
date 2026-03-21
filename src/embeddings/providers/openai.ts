import type { EmbeddingProvider } from '../types.js';

export interface OpenAIOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts?: OpenAIOptions) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (opts?.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.modelName = opts?.model ?? 'text-embedding-3-small';
    this.dimensions = opts?.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embed failed (${response.status}): ${body}`);
    }
    const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}
