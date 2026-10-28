import { describe, expect, it } from 'vitest';
import { FeedParseError, parseFeedDocument } from '../src/feeds/parser.js';
import { fixture } from './helpers.js';

describe('parseFeedDocument', () => {
  it('normalizes RSS 2.0 entries', () => {
    const feed = parseFeedDocument(fixture('rss.xml'));
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example Tech News');
    expect(feed.language).toBe('en-us');
    expect(feed.entries).toHaveLength(3);
    const [first, second, third] = feed.entries;
    expect(first).toMatchObject({
      guid: 'example-1001',
      title: 'Kernel 7.2 released with new scheduler',
      author: 'Ada Lovelace',
      publishedAt: '2026-10-24T10:00:00.000Z',
      categories: ['Linux'],
      language: 'en-us',
    });
    expect(first!.contentHtml).toContain('Benchmarks show a 12% gain');
    expect(first!.summaryHtml).toContain('<b>scheduler</b>');
    expect(second!.publishedAt).toBe('2026-10-23T08:30:00.000Z');
    expect(third!.guid).toBeNull();
    expect(third!.publishedAt).toBeNull(); // unparseable date is dropped, not guessed
    expect(first!.raw).toBeTypeOf('object'); // original parsed metadata is preserved
  });

  it('normalizes Atom entries', () => {
    const feed = parseFeedDocument(fixture('atom.xml'));
    expect(feed.format).toBe('atom');
    expect(feed.siteUrl).toBe('https://blog.example.org/');
    const e = feed.entries[0]!;
    expect(e).toMatchObject({
      guid: 'tag:blog.example.org,2026:queues',
      link: 'https://blog.example.org/2026/queues/',
      author: 'Grace Hopper',
      publishedAt: '2026-10-24T09:00:00.000Z',
      updatedAt: '2026-10-24T11:00:00.000Z',
      categories: ['architecture'],
      language: 'en',
    });
    expect(e.contentHtml).toContain('Long-form content');
  });

  it('normalizes RDF (RSS 1.0) entries', () => {
    const feed = parseFeedDocument(fixture('rdf.xml'));
    expect(feed.format).toBe('rdf');
    expect(feed.entries[0]).toMatchObject({
      guid: 'https://world.example.net/a-1?maca=en-rss',
      title: 'Election results announced',
      publishedAt: '2026-10-25T14:13:00.000Z',
      language: 'en',
      categories: ['News'],
    });
  });

  it('normalizes JSON Feed entries', () => {
    const feed = parseFeedDocument(fixture('feed.json'));
    expect(feed.format).toBe('json');
    expect(feed.entries[0]).toMatchObject({ guid: 'j-1', author: 'Linus', categories: ['tooling'] });
  });

  it('rejects HTML pages and garbage with a descriptive error', () => {
    expect(() => parseFeedDocument(fixture('malformed.xml'))).toThrow(FeedParseError);
    expect(() => parseFeedDocument('')).toThrow(/Empty/);
    expect(() => parseFeedDocument('<rss><channel><item>')).toThrow(FeedParseError);
  });
});
