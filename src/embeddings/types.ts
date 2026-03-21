export interface Chunk {
  id: string;
  nodeId: string;
  chunkIndex: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}
