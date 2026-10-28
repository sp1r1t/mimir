import { parseHTML } from 'linkedom';
import { fetchFeed } from '../feeds/fetcher.js';
import { parseFeedDocument, type NormalizedFeed } from '../feeds/parser.js';

export interface DiscoveredFeed {
  url: string;
  feed: NormalizedFeed;
}

/**
 * Validate a feed URL by fetching and parsing it. If the URL is an HTML page,
 * follow its `<link rel="alternate">` feed reference (feed autodiscovery).
 */
export async function discoverFeed(url: string, opts: { userAgent: string; timeoutMs: number; maxBytes: number }): Promise<DiscoveredFeed> {
  const fetchOpts = { ...opts, retries: 0 };
  const res = await fetchFeed(url, { etag: null, lastModified: null }, fetchOpts);
  if (res.kind !== 'ok') throw new Error('Unexpected 304 response');
  try {
    return { url: res.finalUrl || url, feed: parseFeedDocument(res.body) };
  } catch (err) {
    const alt = findAlternateFeed(res.body, res.finalUrl || url);
    if (!alt) throw err;
    const res2 = await fetchFeed(alt, { etag: null, lastModified: null }, fetchOpts);
    if (res2.kind !== 'ok') throw new Error('Unexpected 304 response');
    return { url: alt, feed: parseFeedDocument(res2.body) };
  }
}

export function findAlternateFeed(body: string, base: string): string | null {
  if (!/<html|<!doctype html/i.test(body.slice(0, 2000))) return null;
  const { document } = parseHTML(body);
  const link = [...document.querySelectorAll('link[rel~="alternate"]')].find((l) =>
    /rss|atom|feed\+json/i.test(l.getAttribute('type') ?? ''),
  );
  const href = link?.getAttribute('href');
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
