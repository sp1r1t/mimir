import type { DB } from '../db/database.js';

/** Where an article was discovered, separate from its destination URL. */
export interface ArticleProvenance {
  sourceId: number | null;
  sourceName: string | null;
  discussionUrl: string | null;
}

function discussionUrl(raw: unknown, base: string | null): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const candidates: unknown[] = [entry.comments];
  // Atom feeds can advertise a comments page with rel="replies".
  const links = Array.isArray(entry.links) ? entry.links : [];
  for (const link of links) {
    if (link && typeof link === 'object' && link.rel === 'replies' && (!link.type || /html/i.test(link.type))) {
      candidates.push(link.href);
    }
  }
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim(), base ?? undefined);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
    } catch { /* Invalid source metadata is not a link. */ }
  }
  return null;
}

/** One batched lookup; uses preserved feed metadata, including for existing articles. */
export function articleProvenance(db: DB, articleIds: number[]): Map<number, ArticleProvenance[]> {
  const result = new Map<number, ArticleProvenance[]>();
  if (!articleIds.length) return result;
  const rows = db.prepare(`
    SELECT e.article_id AS articleId, e.source_id AS sourceId, COALESCE(s.name, e.source_name) AS sourceName,
      s.url AS feedUrl, a.url AS articleUrl, e.raw_first AS rawFirst, e.raw_latest AS rawLatest
    FROM article_entries e JOIN articles a ON a.id = e.article_id LEFT JOIN sources s ON s.id = e.source_id
    WHERE e.article_id IN (SELECT value FROM json_each(?)) ORDER BY e.first_seen_at, e.id
  `).all(JSON.stringify(articleIds)) as {
    articleId: number; sourceId: number | null; sourceName: string | null; feedUrl: string | null;
    articleUrl: string | null; rawFirst: string; rawLatest: string | null;
  }[];
  for (const row of rows) {
    const url = discussionUrl(row.rawLatest ? JSON.parse(row.rawLatest) : null, row.feedUrl)
      ?? discussionUrl(JSON.parse(row.rawFirst), row.feedUrl);
    const entry = { sourceId: row.sourceId, sourceName: row.sourceName, discussionUrl: url === row.articleUrl ? null : url };
    const entries = result.get(row.articleId) ?? [];
    if (!entries.some((e) => e.sourceId === entry.sourceId && e.sourceName === entry.sourceName && e.discussionUrl === entry.discussionUrl)) entries.push(entry);
    result.set(row.articleId, entries);
  }
  return result;
}
