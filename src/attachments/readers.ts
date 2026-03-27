// src/attachments/readers.ts
import { readFileSync, createReadStream } from 'node:fs';
import OpenAI from 'openai';
import { getMimeType } from './types.js';
import type { ReadResult, ImageContent } from './types.js';

export interface WhisperSegment {
  speaker_id?: number | null;
  text: string;
  start: number;
  end: number;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDiarized(segments: WhisperSegment[]): string {
  const merged: Array<{ speaker: number | null; text: string; start: number; end: number }> = [];
  for (const seg of segments) {
    const speaker = seg.speaker_id ?? null;
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    if (merged.length > 0 && merged[merged.length - 1].speaker === speaker) {
      merged[merged.length - 1].text += ' ' + text;
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ speaker, text, start: seg.start, end: seg.end });
    }
  }
  return merged
    .map(block => {
      const label = block.speaker !== null
        ? `**Speaker ${block.speaker}** (${formatTimestamp(block.start)} - ${formatTimestamp(block.end)})`
        : `**Unknown Speaker** (${formatTimestamp(block.start)} - ${formatTimestamp(block.end)})`;
      return `${label}\n${block.text}`;
    })
    .join('\n\n');
}

export function readImage(absolutePath: string, filename: string): ReadResult {
  try {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'svg') {
      const text = readFileSync(absolutePath, 'utf-8');
      return {
        filename,
        ok: true,
        content: [{ type: 'text', text: `--- ${filename} ---\n${text}` }],
      };
    }
    const buffer = readFileSync(absolutePath);
    const data = buffer.toString('base64');
    const mimeType = getMimeType(filename);
    return {
      filename,
      ok: true,
      content: [{ type: 'image', data, mimeType } as ImageContent],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{ type: 'text', text: `--- ${filename} ---\nError reading image: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

export async function readDocument(absolutePath: string, filename: string): Promise<ReadResult> {
  try {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    let text: string;

    if (ext === 'txt' || ext === 'md') {
      text = readFileSync(absolutePath, 'utf-8');
    } else if (ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = readFileSync(absolutePath);
      const result = await pdfParse(buffer);
      text = result.text;
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: absolutePath });
      text = result.value;
    } else {
      text = readFileSync(absolutePath, 'utf-8');
    }

    return {
      filename,
      ok: true,
      content: [{ type: 'text', text: `--- ${filename} ---\n${text}` }],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{ type: 'text', text: `--- ${filename} ---\nError reading document: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

export async function readAudio(absolutePath: string, filename: string): Promise<ReadResult> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    return {
      filename,
      ok: false,
      error: 'FIREWORKS_API_KEY not set',
      content: [{
        type: 'text',
        text: `--- ${filename} ---\nFIREWORKS_API_KEY not set — cannot transcribe audio files`,
      }],
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.fireworks.ai/inference/v1',
    });

    const file = createReadStream(absolutePath);
    const response = await client.audio.transcriptions.create({
      model: 'whisper-v3',
      file,
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      ...{ diarize: true },
    } as any);

    const segments = (response as any).segments as WhisperSegment[] | undefined;
    const transcript = segments && segments.length > 0
      ? formatDiarized(segments)
      : (response as any).text ?? '';

    return {
      filename,
      ok: true,
      content: [{ type: 'text', text: `--- ${filename} ---\n${transcript}` }],
    };
  } catch (err) {
    return {
      filename,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      content: [{
        type: 'text',
        text: `--- ${filename} ---\nError transcribing audio: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}
