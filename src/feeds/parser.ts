import { parseFeed } from 'feedsmith';
import { parseFeedDate } from '../util/time.js';

export type FeedFormat = 'rss' | 'atom' | 'rdf' | 'json';

/** A feed entry normalized across RSS, Atom, RDF, and JSON Feed. `raw` keeps the parsed original. */
export interface NormalizedEntry {
  guid: string | null;
  link: string | null;
  title: string | null;
  author: string | null;
  summaryHtml: string | null;
  contentHtml: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  categories: string[];
  language: string | null;
  raw: unknown;
}

export interface NormalizedFeed {
  format: FeedFormat;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  language: string | null;
  /** Feed-level metadata as parsed, without the entries. */
  metadata: Record<string, unknown>;
  entries: NormalizedEntry[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Text from a string, a number, or an Atom text construct `{ value }`. */
function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (isRec(v)) return text(v.value ?? v.text ?? v.name);
  return null;
}

function arr(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function first<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null && v !== '') return v;
  return null;
}

function personNames(v: unknown): string[] {
  return arr(v)
    .map((p) => (typeof p === 'string' ? p.trim() : isRec(p) ? text(p.name ?? p.email) : null))
    .filter((s): s is string => !!s);
}

function dc(item: Rec): Rec {
  return isRec(item.dc) ? item.dc : {};
}

function atomLink(links: unknown, rel = 'alternate'): string | null {
  const ls = arr(links).filter(isRec);
  const match =
    ls.find((l) => (l.rel ?? 'alternate') === rel && (!l.type || String(l.type).includes('html'))) ??
    ls.find((l) => (l.rel ?? 'alternate') === rel) ??
    (rel === 'alternate' ? ls.find((l) => !l.rel) : undefined);
  return match ? text(match.href) : null;
}

function uniqStrings(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function normalizeRss(item: Rec, feedLang: string | null): NormalizedEntry {
  const d = dc(item);
  const content = isRec(item.content) ? text(item.content.encoded) : null;
  const guid = isRec(item.guid) ? text(item.guid.value) : text(item.guid);
  const atomNs = isRec(item.atom) ? item.atom : {};
  return {
    guid,
    link: first(text(item.link), isRec(item.guid) && item.guid.isPermaLink !== false ? text(item.guid.value) : null),
    title: text(item.title) ?? text(arr(d.titles)[0]),
    author: first(personNames(item.authors).join(', ') || null, personNames(d.creators).join(', ') || null),
    summaryHtml: text(item.description),
    contentHtml: content,
    publishedAt: first(parseFeedDate(item.pubDate), parseFeedDate(arr(d.dates)[0])),
    updatedAt: first(parseFeedDate(atomNs.updated), parseFeedDate(isRec(item.dcterms) ? item.dcterms.modified : null)),
    categories: uniqStrings(arr(item.categories).map((c) => text(c)).concat(arr(d.subjects).map((s) => text(s)))),
    language: first(text(arr(d.languages)[0]), feedLang),
    raw: item,
  };
}

function normalizeAtom(entry: Rec, feedLang: string | null): NormalizedEntry {
  const xml = isRec(entry.xml) ? entry.xml : {};
  return {
    guid: text(entry.id),
    link: atomLink(entry.links),
    title: text(entry.title),
    author: personNames(entry.authors).join(', ') || null,
    summaryHtml: text(entry.summary),
    contentHtml: text(entry.content),
    publishedAt: first(parseFeedDate(entry.published), parseFeedDate(arr(dc(entry).dates)[0])),
    updatedAt: parseFeedDate(entry.updated),
    categories: uniqStrings(arr(entry.categories).map((c) => (isRec(c) ? text(c.label ?? c.term) : text(c)))),
    language: first(text(xml.lang), feedLang),
    raw: entry,
  };
}

function normalizeRdf(item: Rec, feedLang: string | null): NormalizedEntry {
  const d = dc(item);
  const rdf = isRec(item.rdf) ? item.rdf : {};
  return {
    guid: text(rdf.about),
    link: text(item.link) ?? text(rdf.about),
    title: text(item.title),
    author: personNames(d.creators).join(', ') || null,
    summaryHtml: text(item.description),
    contentHtml: isRec(item.content) ? text(item.content.encoded) : null,
    publishedAt: parseFeedDate(arr(d.dates)[0]),
    updatedAt: null,
    categories: uniqStrings(arr(d.subjects).map((s) => text(s))),
    language: first(text(arr(d.languages)[0]), feedLang),
    raw: item,
  };
}

function normalizeJson(item: Rec, feedLang: string | null): NormalizedEntry {
  return {
    guid: text(item.id),
    link: first(text(item.url), text(item.external_url)),
    title: text(item.title),
    author: personNames(item.authors ?? item.author).join(', ') || null,
    summaryHtml: text(item.summary),
    contentHtml: first(text(item.content_html), text(item.content_text)),
    publishedAt: parseFeedDate(item.date_published),
    updatedAt: parseFeedDate(item.date_modified),
    categories: uniqStrings(arr(item.tags).map((t) => text(t))),
    language: first(text(item.language), feedLang),
    raw: item,
  };
}

/** Parse RSS 0.9x/2.0, Atom 1.0, RDF/RSS 1.0, or JSON Feed into a normalized structure. */
export function parseFeedDocument(body: string): NormalizedFeed {
  const input = body.replace(/^﻿/, '').trimStart();
  if (!input) throw new FeedParseError('Empty response body');
  let parsed: ReturnType<typeof parseFeed>;
  try {
    parsed = parseFeed(input.startsWith('{') ? JSON.parse(input) : input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /^<!doctype html|^<html/i.test(input) ? ' (received an HTML page, not a feed)' : '';
    throw new FeedParseError(`Unrecognized or malformed feed: ${msg}${hint}`);
  }
  const feed = parsed.feed as unknown as Rec;
  const { items, entries, ...metadata } = feed;
  const rawEntries = arr(items ?? entries).filter(isRec);
  const feedDc = dc(feed);
  const xml = isRec(feed.xml) ? feed.xml : {};
  const language = first(text(feed.language), text(arr(feedDc.languages)[0]), text(xml.lang));
  const normalize = { rss: normalizeRss, atom: normalizeAtom, rdf: normalizeRdf, json: normalizeJson }[parsed.format];
  const siteUrl =
    parsed.format === 'atom'
      ? atomLink(feed.links)
      : parsed.format === 'json'
        ? text(feed.home_page_url)
        : text(feed.link);
  return {
    format: parsed.format,
    title: text(feed.title),
    siteUrl,
    description: text(feed.description ?? feed.subtitle),
    language,
    metadata,
    entries: rawEntries.map((e) => normalize(e, language)),
  };
}
