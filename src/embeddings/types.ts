export interface Chunk {
  id: string;
  nodeId: string;
  chunkIndex: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  batchSize?: number;
}
