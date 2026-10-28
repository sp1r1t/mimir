import { z } from 'zod';
import { optionalText } from '../util/text.js';

export const TERM_KINDS = ['organisation', 'product', 'person', 'project', 'concept', 'acronym', 'other'] as const;
export type TermKind = (typeof TERM_KINDS)[number];

/** How far along a term is: named, explained, or found nowhere. */
export const TERM_STATUSES = ['pending', 'explained', 'unknown'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

/** A term as the glossary holds it: what it is, and what is known about it. */
export interface GlossaryEntry {
  /** The name the term is filed under, the way it is written in the articles. */
  key: string;
  name: string;
  kind: TermKind;
  /** The title of the encyclopedia article, when there is one. */
  wiki: string | null;
  /** One or two sentences: what the term is. */
  summary: string | null;
  /** The source's own one-liner: "Canadian artificial intelligence company". */
  description: string | null;
  /** Where the explanation came from: "Wikipedia", or the articles. */
  sourceName: string | null;
  sourceUrl: string | null;
  status: TermStatus;
}

/**
 * A term as the model names it: the words the articles use, and the articles that use
 * them. The explanation is not the model's to give: it comes from an encyclopedia, or
 * from a second, separate reading of the articles.
 */
export const NamedTermSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(TERM_KINDS).catch('other'),
    /** The title of the encyclopedia article, when the name alone is ambiguous. */
    wiki: optionalText(160),
    role: optionalText(200),
    sources: z.array(z.number().int().positive()).min(1).max(20),
  })
  .strict();

export type NamedTerm = z.infer<typeof NamedTermSchema>;

/** A term as Mimir holds it: the same term, in the shape the rest of the code reads. */
export const FoundTermSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(TERM_KINDS),
    wiki: z.string().nullable(),
    role: z.string().nullable(),
    sources: z.array(z.number().int().positive()),
  })
  .strict();

export type FoundTerm = z.infer<typeof FoundTermSchema>;

/** A term without its citations: what a provider names, before the articles are attached. */
export interface TermName {
  name: string;
  kind: TermKind;
  wiki?: string | null;
  role?: string | null;
}

export function toFoundTerm(t: NamedTerm): FoundTerm {
  return {
    name: t.name,
    kind: t.kind,
    wiki: t.wiki?.trim() || null,
    role: t.role?.trim() || null,
    sources: [...new Set(t.sources)].sort((a, b) => a - b),
  };
}

/**
 * The name a term is filed under, so the same term is not looked up and explained
 * twice: "OpenAI", "openai" and "Open AI " are one term.
 */
export function termKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Read the terms out of a brief's answer. A term that does not fit is dropped, and one
 * that cites an article the model was not given loses that citation: a bad term must
 * never cost the reader the brief it came with.
 */
export function parseBriefTerms(value: unknown, allowedIds: Set<number>): FoundTerm[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: FoundTerm[] = [];
  for (const raw of value.slice(0, 12)) {
    const parsed = NamedTermSchema.safeParse(raw);
    if (!parsed.success) continue;
    const sources = parsed.data.sources.filter((id) => allowedIds.has(id));
    if (!sources.length) continue;
    const term = toFoundTerm({ ...parsed.data, sources });
    const key = termKey(term.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
