import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db/database.js';
import { cleanExtractedHtml, preferExtracted } from '../src/extraction/clean.js';
import { repairExtractedArticles } from '../src/extraction/repair.js';
import { sanitize } from '../src/web/pages/article.js';

const prose =
  'Paragraph one is long enough to count as article prose about a policy change and its consequences for readers today.';
const prose2 =
  'Paragraph two adds a second substantive block so the extraction can be judged as a real article body rather than a teaser.';
const notice = 'Willkommen bei DER STANDARD. Bitte deaktivieren Sie Adblocker. Accept all cookies.';

function articleHtml(extra = ''): string {
  return `<div class="page"><article><p>${prose}</p><p>${prose2}</p></article>${extra}</div>`;
}

describe('stored extraction repair', () => {
  let db: DB;
  afterEach(() => db?.close());

  function insert(canonical: string, html: string, text: string, summary = 'A clean feed summary of the same story.'): number {
    const now = '2026-10-25T12:00:00.000Z';
    const res = db
      .prepare(
        `INSERT INTO articles (title, canonical_url, summary_text, content_text, content_source, extracted_html,
           extraction_status, feed_categories, discovered_at, ingested_at, content_hash, updated_at)
         VALUES ('Title', ?, ?, ?, 'extracted', ?, 'succeeded', '[]', ?, ?, 'hash', ?)`,
      )
      .run(canonical, summary, text, html, now, now, now);
    return Number(res.lastInsertRowid);
  }

  it('removes a hidden notice from saved HTML and marks only changed text for classification', () => {
    db = openDatabase(':memory:');
    const dirty = insert('https://example.com/a', articleHtml(`<div hidden><p>${notice}</p></div>`), `${prose}\n\n${prose2}\n\n${notice}`);
    const clean = insert('https://example.com/b', articleHtml(), `${prose}\n\n${prose2}`);
    const emptyHidden = insert('https://example.com/empty', articleHtml('<div hidden></div>'), `${prose}\n\n${prose2}`);
    const first = repairExtractedArticles(db);
    expect(first.examined).toBe(3);
    expect(first.reclassifyIds).toEqual([dirty]);
    expect(first.unchanged).toBe(2);
    expect((db.prepare('SELECT content_text AS text FROM articles WHERE id = ?').get(emptyHidden) as { text: string }).text).toContain(prose2);

    const row = db.prepare('SELECT content_text AS text, extracted_html AS html, content_quality AS quality FROM articles WHERE id = ?').get(dirty) as {
      text: string;
      html: string;
      quality: string;
    };
    expect(row.text).toContain(prose2);
    expect(row.text).not.toContain('Adblocker');
    expect(row.html).not.toContain('hidden');
    expect(row.quality).toBe('full');
    expect((db.prepare('SELECT content_text AS text FROM articles WHERE id = ?').get(clean) as { text: string }).text).toContain(prose2);

    const second = repairExtractedArticles(db);
    expect(second.reclassifyIds).toEqual([]);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it('restores feed text when the saved page is only a consent widget', () => {
    db = openDatabase(':memory:');
    const summary = 'The legislature published the bill text and the committee schedule for next week.';
    const id = insert(
      'https://example.com/c',
      '<div class="consent-banner"><p>Accept all cookies. Reject all. Manage preferences. Sign in to our newsletter.</p></div>',
      'Accept all cookies. Reject all. Manage preferences. Sign in to our newsletter.',
      summary,
    );
    const result = repairExtractedArticles(db);
    expect(result.restoredFeed).toBe(1);
    expect(result.reclassifyIds).toEqual([id]);
    const row = db.prepare('SELECT content_text AS text, content_source AS source, extraction_status AS status, extracted_html AS html FROM articles WHERE id = ?').get(id) as {
      text: string;
      source: string;
      status: string;
      html: string | null;
    };
    expect(row.text).toBe(summary);
    expect(row.source).toBe('feed_summary');
    expect(row.status).toBe('insufficient');
    expect(row.html).toBeNull();
  });
});

describe('extraction cleanup', () => {
  it('drops hidden and invisible fragments before plain text is produced', () => {
    const cleaned = cleanExtractedHtml(
      `<article><p>${prose}</p><p>${prose2}</p><p hidden>Accept all cookies.</p><p style="display:none">Reject all cookies.</p><p aria-hidden="true">Sign in to our newsletter.</p></article>`,
    );
    expect(cleaned.removed).toBeGreaterThan(0);
    expect(cleaned.text).toContain(prose);
    expect(cleaned.text).not.toContain('Accept all');
    expect(cleaned.text).not.toContain('Reject all');
    expect(cleaned.text).not.toContain('newsletter');
    expect(cleaned.quality).toBe('full');
  });

  it('does not let length alone beat a longer feed or a boilerplate page', () => {
    expect(preferExtracted('full', 400, 1000)).toBe(true);
    expect(preferExtracted('full', 400, 2000)).toBe(false);
    expect(preferExtracted('suspect', 2000, 100)).toBe(false);
    expect(preferExtracted('partial', 200, 80)).toBe(true);
    expect(preferExtracted('partial', 200, 400)).toBe(false);
  });

  it('does not render hidden feed markup', () => {
    const safe = sanitize(`<p>${prose}</p><div hidden><p>${notice}</p></div><p style="display: none">Accept all cookies.</p>`);
    expect(safe).toContain('Paragraph one');
    expect(safe).not.toContain('DER STANDARD');
    expect(safe).not.toContain('Accept all');
  });
});
