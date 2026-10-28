import { afterEach, describe, expect, it } from 'vitest';
import { FeedIngestor } from '../src/feeds/ingest.js';
import { parseFeedDocument } from '../src/feeds/parser.js';
import { articleProvenance } from '../src/repo/provenance.js';
import { buildServer } from '../src/web/server.js';
import { fixture, makeApp } from './helpers.js';

describe('article discovery and discussion links', () => {
  const apps: ReturnType<typeof makeApp>[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.cleanup(); });

  function setup(comments = 'https://news.ycombinator.com/item?id=123') {
    const t = makeApp();
    apps.push(t);
    const source = t.app.sources.create({ name: 'Hacker News (150+ points)', url: 'https://hnrss.org/frontpage?points=150', pollIntervalSeconds: 600 });
    const feed = fixture('rss.xml').replace('<guid isPermaLink="false">example-1001</guid>', `<comments>${comments}</comments><guid isPermaLink="false">example-1001</guid>`);
    new FeedIngestor(t.app.db, () => {}).ingest(parseFeedDocument(feed), { sourceId: source.id, sourceName: source.name, feedUrl: source.url, fetchedAt: new Date() });
    return { app: t.app, source };
  }

  it('renders the preserved discussion separately from the original on lists and details', async () => {
    const { app } = setup();
    const a = app.articles.get(1)!;
    expect(a.provenance[0]).toMatchObject({ sourceName: 'Hacker News (150+ points)', discussionUrl: 'https://news.ycombinator.com/item?id=123' });
    expect(app.articles.list({}).items.find((a) => a.id === 1)!.provenance).toEqual(a.provenance);
    const server = buildServer(app);
    try {
      for (const url of ['/articles', '/articles/1']) {
        const response = await server.inject({ url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('href="https://news.ycombinator.com/item?id=123"');
        expect(response.body).toContain('href="/go/1"');
        expect(response.body).toContain('Discovered via');
      }
      const original = await server.inject({ url: '/go/1' });
      expect(original.headers.location).toBe(a.url);
    } finally { await server.close(); }
  });

  it('preserves multiple discovery sources and survives source deletion and newer incomplete metadata', () => {
    const { app, source } = setup();
    const other = app.sources.create({ name: 'Second feed', url: 'https://other.example/feed', pollIntervalSeconds: 600 });
    new FeedIngestor(app.db, () => {}).ingest(parseFeedDocument(fixture('rss.xml')), { sourceId: other.id, sourceName: other.name, feedUrl: other.url, fetchedAt: new Date() });
    app.db.prepare("UPDATE article_entries SET raw_latest = '{}' WHERE source_id = ?").run(source.id);
    app.sources.delete(source.id);
    const entries = articleProvenance(app.db, [1]).get(1)!;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ sourceId: null, sourceName: source.name, discussionUrl: 'https://news.ycombinator.com/item?id=123' });
    expect(entries[1]).toMatchObject({ sourceId: other.id, discussionUrl: null });
  });

  it('rejects executable and credential-bearing discussion URLs', () => {
    for (const comments of ['javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.org/comments']) {
      const { app } = setup(comments);
      expect(app.articles.get(1)!.provenance[0]!.discussionUrl).toBeNull();
    }
  });

  it('supports Atom reply links without assuming the GUID is a discussion', () => {
    const { app } = setup();
    app.db.prepare('UPDATE article_entries SET raw_first = ?, raw_latest = NULL WHERE article_id = 1').run(JSON.stringify({
      guid: { value: 'https://news.ycombinator.com/item?id=999' },
      links: [{ rel: 'replies', type: 'text/html', href: 'https://forum.example.org/thread/7' }],
    }));
    expect(app.articles.get(1)!.provenance[0]!.discussionUrl).toBe('https://forum.example.org/thread/7');
    app.db.prepare('UPDATE article_entries SET raw_first = ? WHERE article_id = 1').run(JSON.stringify({ guid: 'https://example.org/not-a-discussion' }));
    expect(app.articles.get(1)!.provenance[0]!.discussionUrl).toBeNull();
  });
});
