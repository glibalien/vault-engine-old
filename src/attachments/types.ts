// src/attachments/types.ts

export type AttachmentType = 'image' | 'audio' | 'document' | 'unknown';

export interface ResolvedEmbed {
  /** Original filename from ![[filename]] */
  filename: string;
  /** Absolute path on disk (null if unresolved) */
  absolutePath: string | null;
  /** Classified attachment type */
  attachmentType: AttachmentType;
}

export interface ReadResult {
  /** Original filename */
  filename: string;
  /** MCP content blocks produced by reading this attachment */
  content: Array<ImageContent | TextContent>;
  /** Whether reading succeeded */
  ok: boolean;
  /** Error message if reading failed */
  error?: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'wav', 'ogg', 'webm']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);

export function classifyAttachment(filename: string): AttachmentType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'unknown';
}

export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
