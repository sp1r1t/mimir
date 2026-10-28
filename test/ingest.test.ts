import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db/database.js';
import { FeedIngestor } from '../src/feeds/ingest.js';
import { parseFeedDocument } from '../src/feeds/parser.js';
import { ArticleRepository } from '../src/repo/articles.js';
import { SourceRepository } from '../src/repo/sources.js';
import { fixture, tempDir } from './helpers.js';

const T0 = new Date('2026-10-25T12:00:00Z');

describe('FeedIngestor', () => {
  let tmp: ReturnType<typeof tempDir>;
  let db: DB;
  let created: number[];
  let ingestor: FeedIngestor;
  let sources: SourceRepository;

  beforeEach(() => {
    tmp = tempDir();
    db = openDatabase(`${tmp.dir}/test.db`);
    created = [];
    sources = new SourceRepository(db, () => T0);
    ingestor = new FeedIngestor(db, (id) => created.push(id), () => new Date(T0.getTime() + 500));
  });
  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  function addSource(name: string, url: string) {
    return sources.create({ name, url, pollIntervalSeconds: 600 });
  }

  it('stores entries with separate published, discovered, and stored timestamps', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    const res = ingestor.ingest(parseFeedDocument(fixture('rss.xml')), {
      sourceId: s.id,
      sourceName: s.name,
      feedUrl: s.url,
      fetchedAt: T0,
    });
    expect(res.created).toHaveLength(3);
    const row = db.prepare("SELECT * FROM articles WHERE guid = 'example-1001'").get() as Record<string, string>;
    expect(row.published_at).toBe('2026-10-24T10:00:00.000Z');
    expect(row.discovered_at).toBe(T0.toISOString());
    expect(row.ingested_at).toBe('2026-10-25T12:00:00.500Z');
    expect(row.canonical_url).toBe('https://news.example.com/kernel-7-2');
    expect(row.url).toContain('utm_source=rss'); // original link preserved as published
    expect(row.content_source).toBe('feed_content');
    expect(row.content_text).toContain('Benchmarks show a 12% gain.');
    expect(row.summary_text).toBe('The new scheduler improves latency.');
    const entry = db.prepare('SELECT raw_first FROM article_entries WHERE article_id = ?').get(row.id) as { raw_first: string };
    expect(JSON.parse(entry.raw_first).guid.value).toBe('example-1001');
    expect(count('SELECT COUNT(*) AS n FROM article_state')).toBe(3);
  });

  it('does not create duplicates when the same feed is ingested again', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    const ctx = { sourceId: s.id, sourceName: s.name, feedUrl: s.url, fetchedAt: T0 };
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), ctx);
    const again = ingestor.ingest(parseFeedDocument(fixture('rss.xml')), { ...ctx, fetchedAt: new Date(T0.getTime() + 3600_000) });
    expect(again.created).toHaveLength(0);
    expect(again.updated).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM articles')).toBe(3);
    expect(created).toHaveLength(3); // downstream processing triggered once per article
    // discovery time is the first sighting
    const row = db.prepare("SELECT discovered_at FROM articles WHERE guid = 'example-1001'").get() as { discovered_at: string };
    expect(row.discovered_at).toBe(T0.toISOString());
  });

  it('updates changed entries in place and keeps the first raw version', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    const ctx = { sourceId: s.id, sourceName: s.name, feedUrl: s.url, fetchedAt: T0 };
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), ctx);
    const changed = fixture('rss.xml').replace('Kernel 7.2 released with new scheduler', 'Kernel 7.2 released (updated)');
    const res = ingestor.ingest(parseFeedDocument(changed), ctx);
    expect(res.updated).toBe(1);
    expect(res.created).toHaveLength(0);
    const a = db.prepare("SELECT id, title, content_updated_at FROM articles WHERE guid = 'example-1001'").get() as Record<string, string>;
    expect(a.title).toBe('Kernel 7.2 released (updated)');
    expect(a.content_updated_at).not.toBeNull();
    const e = db.prepare('SELECT raw_first, raw_latest FROM article_entries WHERE article_id = ?').get(a.id) as { raw_first: string; raw_latest: string };
    expect(JSON.parse(e.raw_first).title).toBe('Kernel 7.2 released with new scheduler');
    expect(JSON.parse(e.raw_latest).title).toBe('Kernel 7.2 released (updated)');
  });

  it('deduplicates across sources by canonical URL and records the extra sighting', () => {
    const a = addSource('News', 'https://news.example.com/feed');
    const b = addSource('Blog', 'https://blog.example.org/atom.xml');
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), { sourceId: a.id, sourceName: a.name, feedUrl: a.url, fetchedAt: T0 });
    const res = ingestor.ingest(parseFeedDocument(fixture('atom.xml')), { sourceId: b.id, sourceName: b.name, feedUrl: b.url, fetchedAt: T0 });
    // The Atom cross-post links to https://www.news.example.com/open-model/ — same canonical URL as the RSS item.
    expect(res.created).toHaveLength(1);
    expect(res.linked).toBe(1);
    const art = db.prepare("SELECT id FROM articles WHERE canonical_url = 'https://news.example.com/open-model'").get() as { id: number };
    const entries = db.prepare('SELECT source_name FROM article_entries WHERE article_id = ? ORDER BY id').all(art.id);
    expect(entries).toEqual([{ source_name: 'News' }, { source_name: 'Blog' }]);
  });

  it('keys entries without GUID by canonical link, so tracking-param changes do not duplicate', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    const ctx = { sourceId: s.id, sourceName: s.name, feedUrl: s.url, fetchedAt: T0 };
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), ctx);
    const variant = fixture('rss.xml').replace('https://news.example.com/no-guid#comments', 'https://news.example.com/no-guid?utm_campaign=x');
    const res = ingestor.ingest(parseFeedDocument(variant), ctx);
    expect(res.created).toHaveLength(0);
  });

  it('persists articles and makes them searchable after the database is reopened', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), { sourceId: s.id, sourceName: s.name, feedUrl: s.url, fetchedAt: T0 });
    db.close();
    db = openDatabase(`${tmp.dir}/test.db`); // simulates a restart; migrations are idempotent
    const repo = new ArticleRepository(db);
    expect(repo.list({}).total).toBe(3);
    const hits = repo.list({ q: 'benchmarks' });
    expect(hits.items.map((i) => i.title)).toEqual(['Kernel 7.2 released with new scheduler']);
    expect(repo.list({ q: 'sched' }).total).toBe(1); // prefix match
    expect(repo.list({ q: '"; DROP TABLE articles; --' }).total).toBe(0); // query is sanitized
  });

  it('keeps articles when their source is deleted', () => {
    const s = addSource('News', 'https://news.example.com/feed');
    ingestor.ingest(parseFeedDocument(fixture('rss.xml')), { sourceId: s.id, sourceName: s.name, feedUrl: s.url, fetchedAt: T0 });
    sources.delete(s.id);
    expect(count('SELECT COUNT(*) AS n FROM articles')).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM article_entries WHERE source_name = 'News'")).toBe(3);
  });
});
