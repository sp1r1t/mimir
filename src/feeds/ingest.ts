import type { DB } from '../db/database.js';
import { textQuality, type StoredQuality } from '../extraction/clean.js';
import { sha256, stableStringify } from '../util/hash.js';
import { htmlToText } from '../util/text.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import { canonicalizeUrl } from '../util/url.js';
import type { NormalizedEntry, NormalizedFeed } from './parser.js';

export interface IngestResult {
  seen: number;
  created: number[];
  updated: number;
  linked: number;
  skipped: number;
}

export interface IngestContext {
  sourceId: number;
  sourceName: string;
  feedUrl: string;
  /** Start of the fetch that produced this feed document; recorded as discovery time. */
  fetchedAt: Date;
}

/** Stable identifier of an entry within its source. */
export function entryKey(e: NormalizedEntry, canonicalLink: string | null): string | null {
  if (e.guid) return `guid:${e.guid}`;
  if (canonicalLink) return `url:${canonicalLink}`;
  if (e.title) return `hash:${sha256(`${e.title}\u0000${e.publishedAt ?? ''}`)}`;
  return null;
}

/** Hash of the source-provided fields; changes signal an updated entry. */
export function entryContentHash(e: NormalizedEntry): string {
  return sha256(stableStringify([e.title, e.link, e.author, e.summaryHtml, e.contentHtml, e.updatedAt]));
}

function bestText(e: NormalizedEntry): {
  text: string;
  source: 'none' | 'feed_summary' | 'feed_content';
  quality: StoredQuality;
} {
  const content = htmlToText(e.contentHtml);
  const summary = htmlToText(e.summaryHtml);
  if (content && content.length >= summary.length) return { text: content, source: 'feed_content', quality: textQuality(content) };
  if (summary) return { text: summary, source: 'feed_summary', quality: textQuality(summary) };
  return { text: '', source: 'none', quality: 'unknown' };
}

interface ExistingEntry {
  id: number;
  article_id: number;
  content_hash: string;
}

/**
 * Persist a parsed feed. Deduplication order:
 *  1. Same source + same entry key (GUID, else canonical link, else title/date hash) → same article.
 *  2. Same canonical URL (any source) → same article; the entry is recorded as an additional sighting.
 *  3. Otherwise a new article.
 * Updated entries refresh the stored source fields but do not trigger reclassification.
 */
export class FeedIngestor {
  constructor(
    private readonly db: DB,
    private readonly onNewArticle: (articleId: number) => void,
    private readonly clock: Clock = systemClock,
  ) {}

  ingest(feed: NormalizedFeed, ctx: IngestContext): IngestResult {
    const result: IngestResult = { seen: 0, created: [], updated: 0, linked: 0, skipped: 0 };
    const discoveredAt = iso(ctx.fetchedAt);

    const findEntry = this.db.prepare('SELECT id, article_id, content_hash FROM article_entries WHERE source_id = ? AND entry_key = ?');
    const findByUrl = this.db.prepare('SELECT id FROM articles WHERE canonical_url = ? OR declared_canonical_url = ? LIMIT 1');
    const insertArticle = this.db.prepare(
      `INSERT INTO articles (source_id, guid, title, url, canonical_url, author, description, summary_text, content_html,
         content_text, content_source, content_quality, language, feed_categories, published_at, source_updated_at, discovered_at,
         ingested_at, content_hash, updated_at)
       VALUES (@sourceId, @guid, @title, @url, @canonicalUrl, @author, @description, @summaryText, @contentHtml,
         @contentText, @contentSource, @contentQuality, @language, @categories, @publishedAt, @updatedAt, @discoveredAt,
         @now, @hash, @now)`,
    );
    const insertEntry = this.db.prepare(
      `INSERT INTO article_entries (article_id, source_id, source_name, entry_key, guid, link, feed_format, content_hash,
         raw_first, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertState = this.db.prepare('INSERT OR IGNORE INTO article_state (article_id) VALUES (?)');
    const touchEntry = this.db.prepare('UPDATE article_entries SET last_seen_at = ? WHERE id = ?');
    const updateEntry = this.db.prepare(
      'UPDATE article_entries SET last_seen_at = ?, content_hash = ?, raw_latest = ? WHERE id = ?',
    );
    // Only refresh article fields from the source that first delivered the article.
    const updateArticle = this.db.prepare(
      `UPDATE articles SET title = COALESCE(@title, title), author = COALESCE(@author, author),
         description = COALESCE(@description, description), summary_text = COALESCE(@summaryText, summary_text),
         content_html = COALESCE(@contentHtml, content_html),
         content_text = CASE WHEN content_source = 'extracted' THEN content_text ELSE @contentText END,
         content_source = CASE WHEN content_source = 'extracted' THEN content_source ELSE @contentSource END,
         content_quality = CASE WHEN content_source = 'extracted' THEN content_quality ELSE @contentQuality END,
         source_updated_at = COALESCE(@updatedAt, source_updated_at), feed_categories = @categories,
         content_hash = @hash, content_updated_at = @now, updated_at = @now
       WHERE id = @articleId AND source_id = @sourceId`,
    );

    const run = this.db.transaction(() => {
      const now = iso(this.clock());
      for (const e of feed.entries) {
        result.seen++;
        const link = e.link ? safeResolve(e.link, ctx.feedUrl) : null;
        const canonicalUrl = canonicalizeUrl(link);
        const key = entryKey(e, canonicalUrl);
        if (!key || (!e.title && !link && !e.summaryHtml && !e.contentHtml)) {
          result.skipped++;
          continue;
        }
        const hash = entryContentHash(e);
        const raw = JSON.stringify(e.raw ?? {});
        const { text, source, quality } = bestText(e);
        const fields = {
          sourceId: ctx.sourceId,
          guid: e.guid,
          title: e.title ? htmlToText(e.title) : null,
          url: link,
          canonicalUrl,
          author: e.author,
          description: e.summaryHtml,
          summaryText: htmlToText(e.summaryHtml) || null,
          contentHtml: e.contentHtml,
          contentText: text || null,
          contentSource: source,
          contentQuality: quality,
          language: e.language,
          categories: JSON.stringify(e.categories),
          publishedAt: e.publishedAt,
          updatedAt: e.updatedAt,
          discoveredAt,
          now,
          hash,
        };

        const existing = findEntry.get(ctx.sourceId, key) as ExistingEntry | undefined;
        if (existing) {
          if (existing.content_hash === hash) {
            touchEntry.run(now, existing.id);
          } else {
            updateEntry.run(now, hash, raw, existing.id);
            updateArticle.run({ ...fields, articleId: existing.article_id });
            result.updated++;
          }
          continue;
        }

        const dup = canonicalUrl ? (findByUrl.get(canonicalUrl, canonicalUrl) as { id: number } | undefined) : undefined;
        if (dup) {
          insertEntry.run(dup.id, ctx.sourceId, ctx.sourceName, key, e.guid, link, feed.format, hash, raw, now, now);
          result.linked++;
          continue;
        }

        const res = insertArticle.run(fields);
        const articleId = Number(res.lastInsertRowid);
        insertEntry.run(articleId, ctx.sourceId, ctx.sourceName, key, e.guid, link, feed.format, hash, raw, now, now);
        insertState.run(articleId);
        this.onNewArticle(articleId);
        result.created.push(articleId);
      }
    });
    run();
    return result;
  }
}

function safeResolve(link: string, base: string): string {
  try {
    return new URL(link.trim(), base).toString();
  } catch {
    return link.trim();
  }
}
