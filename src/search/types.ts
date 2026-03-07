export interface SearchOptions {
  query: string;
  schemaType?: string;
  limit?: number;
}

export interface SearchResult {
  id: string;
  filePath: string;
  nodeType: string;
  types: string[];
  fields: Record<string, { value: string; type: string }>;
  contentText: string;
  rank: number;
}
