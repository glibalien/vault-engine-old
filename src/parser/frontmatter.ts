import matter from 'gray-matter';
import type { FieldEntry, WikiLink, FieldValueType } from './types.js';
import { extractWikiLinksFromString } from './wiki-links.js';

const META_KEYS = new Set(['title', 'types']);
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

export interface FrontmatterResult {
  data: Record<string, unknown>;
  content: string;
  types: string[];
  fields: FieldEntry[];
  wikiLinks: WikiLink[];
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const { data, content } = matter(raw);

  const types = normalizeTypes(data.types);
  const fields: FieldEntry[] = [];
  const wikiLinks: WikiLink[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;

    fields.push({
      key,
      value,
      valueType: inferType(value),
    });

    const extracted = extractLinksFromValue(value, key);
    wikiLinks.push(...extracted);
  }

  return { data, content, types, fields, wikiLinks };
}

function normalizeTypes(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function inferType(value: unknown): FieldValueType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') {
    if (WIKI_LINK_RE.test(value)) return 'reference';
  }
  return 'string';
}

function extractLinksFromValue(value: unknown, field: string): WikiLink[] {
  const links: WikiLink[] = [];

  if (typeof value === 'string') {
    for (const raw of extractWikiLinksFromString(value)) {
      links.push({
        target: raw.target,
        alias: raw.alias,
        source: 'frontmatter',
        field,
      });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        for (const raw of extractWikiLinksFromString(item)) {
          links.push({
            target: raw.target,
            alias: raw.alias,
            source: 'frontmatter',
            field,
          });
        }
      }
    }
  }

  return links;
}
