import type { DB } from '../db/database.js';
import { htmlToText, normalizeWhitespace } from '../util/text.js';
import { iso } from '../util/time.js';
import { cleanExtractedHtml, textContainsRemoved, textQuality, type StoredQuality } from './clean.js';

export interface RepairResult {
  examined: number;
  updated: number;
  restoredFeed: number;
  unchanged: number;
  /** Articles whose classifier input changed and should be classified again. */
  reclassifyIds: number[];
}

interface StoredExtraction {
  id: number;
  contentText: string | null;
  extractedHtml: string;
  summaryText: string | null;
  contentHtml: string | null;
}

/**
 * Re-clean stored page HTML. Does not fetch URLs or call a classifier.
 * Feed HTML and the original entry payload stay untouched.
 */
export function repairExtractedArticles(db: DB, now = new Date()): RepairResult {
  const rows = db.prepare(
    `SELECT id, content_text AS contentText, extracted_html AS extractedHtml,
            summary_text AS summaryText, content_html AS contentHtml
     FROM articles
     WHERE content_source = 'extracted' AND extracted_html IS NOT NULL`,
  );
  const updateClean = db.prepare(
    `UPDATE articles SET content_text = ?, extracted_html = ?, content_quality = ?,
       content_updated_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const restoreFeed = db.prepare(
    `UPDATE articles SET content_text = ?, content_source = ?, content_quality = ?,
       extracted_html = NULL, extraction_status = 'insufficient', extraction_error = ?,
       content_updated_at = ?, updated_at = ?
     WHERE id = ?`,
  );

  const result: RepairResult = { examined: 0, updated: 0, restoredFeed: 0, unchanged: 0, reclassifyIds: [] };
  const pending: (() => void)[] = [];
  const stamp = iso(now);

  for (const row of rows.iterate() as Iterable<StoredExtraction>) {
    result.examined++;
    const cleaned = cleanExtractedHtml(row.extractedHtml);
    const stored = normalizeWhitespace(row.contentText ?? '');
    if (!textContainsRemoved(stored, cleaned.removedText)) {
      result.unchanged++;
      continue;
    }
    if (cleaned.quality === 'suspect') {
      const summary = normalizeWhitespace(row.summaryText ?? '');
      const fromFeed = normalizeWhitespace(htmlToText(row.contentHtml));
      const useFeedHtml = fromFeed.length >= summary.length && fromFeed.length > 0;
      const feedText = useFeedHtml ? fromFeed : summary;
      if (feedText && feedText !== stored) {
        const source = useFeedHtml ? 'feed_content' : 'feed_summary';
        const quality = textQuality(feedText);
        pending.push(() => {
          restoreFeed.run(
            feedText,
            source,
            quality,
            'Stored page text failed quality checks; feed text restored',
            stamp,
            stamp,
            row.id,
          );
        });
        result.restoredFeed++;
        result.reclassifyIds.push(row.id);
        continue;
      }
    }
    const quality: StoredQuality = cleaned.quality === 'full' ? 'full' : 'partial';
    const textChanged = cleaned.text !== stored;
    pending.push(() => {
      updateClean.run(cleaned.text, cleaned.html, quality, stamp, stamp, row.id);
    });
    result.updated++;
    if (textChanged) result.reclassifyIds.push(row.id);
  }

  db.transaction(() => {
    for (const write of pending) write();
  })();
  return result;
}
