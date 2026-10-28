import type { DB } from '../db/database.js';
import type { ClassificationArticle, ClassificationResult } from '../classification/types.js';
import { MAX_CONTENT_HTML, MAX_CONTENT_TEXT } from '../extraction/clean.js';
import type { ExtractionOutcome } from '../extraction/extractor.js';
import type { InterestProfile } from '../profile/schema.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import { articleProvenance, type ArticleProvenance } from './provenance.js';

export type SortKey = 'rank' | 'rank_asc' | 'published' | 'discovered' | 'relevance' | 'significance' | 'urgency' | 'match';
export const SORT_KEYS: SortKey[] = ['rank', 'rank_asc', 'published', 'discovered', 'relevance', 'significance', 'urgency', 'match'];

export interface ArticleFilters {
  q?: string;
  sourceId?: number;
  category?: string;
  /** Personal relevance bounds in [0, 1]. */
  minRelevance?: number;
  maxRelevance?: number;
  dateField?: 'published' | 'discovered';
  from?: string;
  to?: string;
  status?: 'all' | 'classified' | 'pending' | 'failed';
  saved?: boolean;
  feedback?: 'any' | 'none' | 'relevant' | 'not_relevant' | 'more' | 'less';
  articleType?: string;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
}

export interface ArticleListItem {
  id: number;
  title: string | null;
  url: string | null;
  sourceId: number | null;
  sourceName: string | null;
  provenance: ArticleProvenance[];
  author: string | null;
  summaryText: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  contentSource: string;
  extractionStatus: string;
  classificationStatus: 'pending' | 'classified' | 'failed';
  classificationError: string | null;
  classificationId: number | null;
  classifiedAt: string | null;
  profileVersion: number | null;
  rankScore: number | null;
  personalRelevance: number | null;
  significance: number | null;
  urgency: number | null;
  investigate: number | null;
  promotional: number | null;
  articleType: string | null;
  categories: { id: string; label: string; probability: number; assigned: boolean }[];
  relevanceLabel: 'relevant' | 'not_relevant' | null;
  preference: 'more' | 'less' | null;
  savedAt: string | null;
}

export interface ClassificationRecord {
  id: number;
  articleId: number;
  profileId: number;
  profileVersion: number;
  classifier: string;
  classifierVersion: string;
  model: string;
  inputHash: string;
  personalRelevance: number;
  significance: number;
  urgency: number;
  investigate: number;
  promotional: number | null;
  exclusion: number | null;
  articleType: string | null;
  rankScore: number;
  rankFormula: string;
  categories: { id: string; label: string; probability: number; assigned: boolean }[];
  signals: Record<string, unknown>;
  rawRequest: unknown;
  rawResponse: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ArticleDetail extends ArticleListItem {
  guid: string | null;
  canonicalUrl: string | null;
  declaredCanonicalUrl: string | null;
  description: string | null;
  contentHtml: string | null;
  contentText: string | null;
  contentQuality: 'unknown' | 'full' | 'partial';
  extractedHtml: string | null;
  extractionError: string | null;
  extractedAt: string | null;
  language: string | null;
  feedCategories: string[];
  sourceUpdatedAt: string | null;
  ingestedAt: string;
  contentUpdatedAt: string | null;
  firstViewedAt: string | null;
  entries: {
    id: number;
    sourceId: number | null;
    sourceName: string | null;
    entryKey: string;
    guid: string | null;
    link: string | null;
    feedFormat: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    rawFirst: unknown;
    rawLatest: unknown;
  }[];
  classifications: ClassificationRecord[];
  feedbackEvents: { id: number; eventType: string; createdAt: string; profileVersion: number | null; rankScore: number | null }[];
}

const LIST_SELECT = `
  SELECT a.id, a.title, a.url, a.source_id AS sourceId, src.name AS sourceName, a.author, a.summary_text AS summaryText,
    a.published_at AS publishedAt, a.discovered_at AS discoveredAt, a.content_source AS contentSource,
    a.extraction_status AS extractionStatus,
    s.classification_status AS classificationStatus, s.classification_error AS classificationError,
    c.id AS classificationId, c.created_at AS classifiedAt, c.profile_version AS profileVersion,
    s.rank_score AS rankScore, c.personal_relevance AS personalRelevance, c.significance, c.urgency, c.investigate,
    c.promotional, c.article_type AS articleType, c.categories AS categoriesJson,
    s.relevance_label AS relevanceLabel, s.preference, s.saved_at AS savedAt
  FROM articles a
  JOIN article_state s ON s.article_id = a.id
  LEFT JOIN classifications c ON c.id = s.current_classification_id
  LEFT JOIN sources src ON src.id = a.source_id`;

type ListRow = Omit<ArticleListItem, 'categories' | 'provenance'> & { categoriesJson: string | null };

function toListItem(r: ListRow, provenance: ArticleProvenance[]): ArticleListItem {
  const { categoriesJson, ...rest } = r;
  return { ...rest, categories: categoriesJson ? JSON.parse(categoriesJson) : [], provenance };
}

/** Turn free text into a safe FTS5 query: every token must match (prefix match on each). */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export class ArticleRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  list(f: ArticleFilters): { items: ArticleListItem[]; total: number; page: number; pageSize: number } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    let matchJoin = '';
    const fts = f.q ? toFtsQuery(f.q) : null;
    if (f.q && !fts) return { items: [], total: 0, page: 1, pageSize: f.pageSize ?? 50 };
    if (fts) {
      matchJoin = 'JOIN (SELECT rowid AS id, bm25(articles_fts, 10.0, 3.0, 1.0, 2.0) AS bm FROM articles_fts WHERE articles_fts MATCH @fts) m ON m.id = a.id';
      params.fts = fts;
    }
    if (f.sourceId) {
      where.push('EXISTS (SELECT 1 FROM article_entries e WHERE e.article_id = a.id AND e.source_id = @sourceId)');
      params.sourceId = f.sourceId;
    }
    if (f.category) {
      where.push(
        'EXISTS (SELECT 1 FROM classification_categories cc WHERE cc.classification_id = s.current_classification_id AND cc.category_id = @category AND cc.assigned = 1)',
      );
      params.category = f.category;
    }
    if (f.minRelevance != null) {
      where.push('c.personal_relevance >= @minRel');
      params.minRel = f.minRelevance;
    }
    if (f.maxRelevance != null) {
      where.push('c.personal_relevance <= @maxRel');
      params.maxRel = f.maxRelevance;
    }
    const dateCol = f.dateField === 'published' ? 'a.published_at' : 'a.discovered_at';
    if (f.from) {
      where.push(`${dateCol} >= @from`);
      params.from = f.from;
    }
    if (f.to) {
      where.push(`${dateCol} < @to`);
      params.to = f.to;
    }
    if (f.status && f.status !== 'all') {
      where.push('s.classification_status = @status');
      params.status = f.status;
    }
    if (f.saved) where.push('s.saved_at IS NOT NULL');
    if (f.articleType) {
      where.push('c.article_type = @articleType');
      params.articleType = f.articleType;
    }
    switch (f.feedback) {
      case 'any':
        where.push('(s.relevance_label IS NOT NULL OR s.preference IS NOT NULL)');
        break;
      case 'none':
        where.push('s.relevance_label IS NULL AND s.preference IS NULL');
        break;
      case 'relevant':
      case 'not_relevant':
        where.push('s.relevance_label = @label');
        params.label = f.feedback;
        break;
      case 'more':
      case 'less':
        where.push('s.preference = @pref');
        params.pref = f.feedback;
        break;
    }
    const order = {
      rank: 's.rank_score IS NULL, s.rank_score DESC, a.discovered_at DESC',
      rank_asc: 's.rank_score IS NULL, s.rank_score ASC, a.discovered_at DESC',
      published: 'COALESCE(a.published_at, a.discovered_at) DESC',
      discovered: 'a.discovered_at DESC, a.id DESC',
      relevance: 'c.personal_relevance IS NULL, c.personal_relevance DESC, a.discovered_at DESC',
      significance: 'c.significance IS NULL, c.significance DESC, a.discovered_at DESC',
      urgency: 'c.urgency IS NULL, c.urgency DESC, a.discovered_at DESC',
      match: fts ? 'm.bm ASC' : 'a.discovered_at DESC',
    }[f.sort ?? (fts ? 'match' : 'rank')];

    const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
    const page = Math.max(f.page ?? 1, 1);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const base = `FROM articles a JOIN article_state s ON s.article_id = a.id
      LEFT JOIN classifications c ON c.id = s.current_classification_id ${matchJoin} ${whereSql}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params) as { n: number }).n;
    const rows = this.db
      .prepare(`${LIST_SELECT} ${matchJoin} ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as ListRow[];
    const provenance = articleProvenance(this.db, rows.map((r) => r.id));
    return { items: rows.map((r) => toListItem(r, provenance.get(r.id) ?? [])), total, page, pageSize };
  }

  get(id: number): ArticleDetail | null {
    const row = this.db.prepare(`${LIST_SELECT} WHERE a.id = ?`).get(id) as ListRow | undefined;
    if (!row) return null;
    const extra = this.db
      .prepare(
        `SELECT a.guid, a.canonical_url AS canonicalUrl, a.declared_canonical_url AS declaredCanonicalUrl, a.description,
           a.content_html AS contentHtml, a.content_text AS contentText, a.content_quality AS contentQuality,
           a.extracted_html AS extractedHtml,
           a.extraction_error AS extractionError, a.extracted_at AS extractedAt, a.language, a.feed_categories AS feedCategories,
           a.source_updated_at AS sourceUpdatedAt, a.ingested_at AS ingestedAt, a.content_updated_at AS contentUpdatedAt,
           s.first_viewed_at AS firstViewedAt
         FROM articles a JOIN article_state s ON s.article_id = a.id WHERE a.id = ?`,
      )
      .get(id) as Record<string, unknown>;
    const entries = (
      this.db
        .prepare(
          `SELECT id, source_id AS sourceId, source_name AS sourceName, entry_key AS entryKey, guid, link,
             feed_format AS feedFormat, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             raw_first AS rawFirst, raw_latest AS rawLatest
           FROM article_entries WHERE article_id = ? ORDER BY first_seen_at`,
        )
        .all(id) as (ArticleDetail['entries'][number] & { rawFirst: string; rawLatest: string | null })[]
    ).map((e) => ({ ...e, rawFirst: JSON.parse(e.rawFirst), rawLatest: e.rawLatest ? JSON.parse(e.rawLatest) : null }));
    const feedbackEvents = this.db
      .prepare(
        `SELECT id, event_type AS eventType, created_at AS createdAt, profile_version AS profileVersion, rank_score AS rankScore
         FROM feedback_events WHERE article_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      )
      .all(id) as ArticleDetail['feedbackEvents'];
    return {
      ...toListItem(row, articleProvenance(this.db, [id]).get(id) ?? []),
      ...(extra as object),
      feedCategories: JSON.parse((extra.feedCategories as string) ?? '[]'),
      entries,
      classifications: this.classifications(id),
      feedbackEvents,
    } as ArticleDetail;
  }

  classifications(articleId: number): ClassificationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM classifications WHERE article_id = ? ORDER BY created_at DESC, id DESC')
      .all(articleId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      articleId: r.article_id as number,
      profileId: r.profile_id as number,
      profileVersion: r.profile_version as number,
      classifier: r.classifier as string,
      classifierVersion: r.classifier_version as string,
      model: r.model as string,
      inputHash: r.input_hash as string,
      personalRelevance: r.personal_relevance as number,
      significance: r.significance as number,
      urgency: r.urgency as number,
      investigate: r.investigate as number,
      promotional: r.promotional as number | null,
      exclusion: r.exclusion as number | null,
      articleType: r.article_type as string | null,
      rankScore: r.rank_score as number,
      rankFormula: r.rank_formula as string,
      categories: JSON.parse(r.categories as string),
      signals: JSON.parse(r.signals as string),
      rawRequest: JSON.parse(r.raw_request as string),
      rawResponse: JSON.parse(r.raw_response as string),
      inputTokens: r.input_tokens as number | null,
      outputTokens: r.output_tokens as number | null,
      durationMs: r.duration_ms as number | null,
      createdAt: r.created_at as string,
    }));
  }

  exists(id: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id);
  }

  /** Input for classifiers: original source information only. */
  forClassification(id: number): ClassificationArticle | null {
    const r = this.db
      .prepare(
        `SELECT a.id, a.title, COALESCE(src.name, e.source_name) AS sourceName, a.author, a.url, a.published_at AS publishedAt,
           a.language, a.feed_categories AS feedCategories, a.summary_text AS summary, a.content_text AS text,
           a.content_source AS contentSource, a.content_quality AS contentQuality
         FROM articles a
         LEFT JOIN sources src ON src.id = a.source_id
         LEFT JOIN article_entries e ON e.article_id = a.id
         WHERE a.id = ? LIMIT 1`,
      )
      .get(id) as (Omit<ClassificationArticle, 'feedCategories'> & { feedCategories: string }) | undefined;
    if (!r) return null;
    return { ...r, feedCategories: JSON.parse(r.feedCategories) };
  }

  forExtraction(id: number): {
    id: number;
    url: string | null;
    sourceId: number | null;
    publishedAt: string | null;
    extractionStatus: string;
    contentSource: string;
    textLength: number;
    summaryText: string | null;
    contentHtml: string | null;
    sourceConfig: string | null;
  } | null {
    return (
      (this.db
        .prepare(
          `SELECT a.id, a.url, a.source_id AS sourceId, a.published_at AS publishedAt, a.extraction_status AS extractionStatus,
             a.content_source AS contentSource, LENGTH(COALESCE(a.content_text, '')) AS textLength,
             a.summary_text AS summaryText, a.content_html AS contentHtml, src.config AS sourceConfig
           FROM articles a LEFT JOIN sources src ON src.id = a.source_id WHERE a.id = ?`,
        )
        .get(id) as ReturnType<ArticleRepository['forExtraction']> | undefined) ?? null
    );
  }

  setExtractionStatus(id: number, status: string, error: string | null): void {
    this.db
      .prepare('UPDATE articles SET extraction_status = ?, extraction_error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, iso(this.clock()), id);
  }

  applyExtraction(id: number, outcome: ExtractionOutcome): void {
    const now = iso(this.clock());
    if (outcome.status === 'succeeded') {
      this.db
        .prepare(
          `UPDATE articles SET content_text = ?, extracted_html = ?, content_source = 'extracted', content_quality = ?,
             extraction_status = 'succeeded',
             extraction_error = NULL, extracted_at = ?, language = COALESCE(language, ?),
             declared_canonical_url = COALESCE(?, declared_canonical_url), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          outcome.text.slice(0, MAX_CONTENT_TEXT),
          outcome.html.slice(0, MAX_CONTENT_HTML),
          outcome.quality,
          now,
          outcome.language,
          outcome.declaredCanonicalUrl,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `UPDATE articles SET extraction_status = ?, extraction_error = ?, extracted_at = ?,
             declared_canonical_url = COALESCE(?, declared_canonical_url), updated_at = ? WHERE id = ?`,
        )
        .run(outcome.status, outcome.reason, now, outcome.declaredCanonicalUrl ?? null, now, id);
    }
  }

  /** Most recent classification for (article, profile version, classifier version). */
  latestClassificationFor(articleId: number, profileVersion: number, classifierVersion: string): { id: number; inputHash: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT id, input_hash AS inputHash FROM classifications
           WHERE article_id = ? AND profile_version = ? AND classifier_version = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(articleId, profileVersion, classifierVersion) as { id: number; inputHash: string } | undefined) ?? null
    );
  }

  /** Append a classification and make it the article's current one. */
  saveClassification(articleId: number, profile: InterestProfile, r: ClassificationResult, rank: { score: number; formula: string }): number {
    return this.db.transaction(() => {
      const now = iso(this.clock());
      const res = this.db
        .prepare(
          `INSERT INTO classifications (article_id, profile_id, profile_version, classifier, classifier_version, model, input_hash,
             personal_relevance, significance, urgency, investigate, promotional, exclusion, article_type, rank_score, rank_formula,
             categories, signals, raw_request, raw_response, input_tokens, output_tokens, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          articleId, profile.id, profile.version, r.classifier, r.classifierVersion, r.model, r.inputHash,
          r.personalRelevance, r.significance, r.urgency, r.investigate, r.promotional, r.exclusion, r.articleType,
          rank.score, rank.formula, JSON.stringify(r.categories), JSON.stringify(r.signals),
          JSON.stringify(r.rawRequest), JSON.stringify(r.rawResponse), r.usage.inputTokens, r.usage.outputTokens, r.durationMs, now,
        );
      const id = Number(res.lastInsertRowid);
      const insCat = this.db.prepare(
        'INSERT INTO classification_categories (classification_id, category_id, probability, assigned) VALUES (?, ?, ?, ?)',
      );
      for (const c of r.categories) insCat.run(id, c.id, c.probability, c.assigned ? 1 : 0);
      this.db
        .prepare(
          `UPDATE article_state SET classification_status = 'classified', classification_error = NULL,
             current_classification_id = ?, rank_score = ? WHERE article_id = ?`,
        )
        .run(id, rank.score, articleId);
      return id;
    })();
  }

  markClassificationFailed(articleId: number, error: string): void {
    // Keep a previous successful classification current; only flag articles that have none.
    this.db
      .prepare(
        `UPDATE article_state SET classification_error = ?,
           classification_status = CASE WHEN current_classification_id IS NULL THEN 'failed' ELSE classification_status END
         WHERE article_id = ?`,
      )
      .run(error, articleId);
  }

  markClassificationPending(articleIds: number[]): void {
    const stmt = this.db.prepare(
      `UPDATE article_state SET classification_status = CASE WHEN current_classification_id IS NULL THEN 'pending' ELSE classification_status END,
         classification_error = NULL WHERE article_id = ?`,
    );
    this.db.transaction(() => {
      for (const id of articleIds) stmt.run(id);
    })();
  }

  /** Articles with no classification and no active job (lost jobs, recovery after restart). */
  unclassifiedWithoutJob(limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT s.article_id AS id FROM article_state s
           WHERE s.classification_status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('pending', 'running')
                             AND j.kind IN ('classify', 'extract') AND json_extract(j.payload, '$.articleId') = s.article_id)
           ORDER BY s.article_id DESC LIMIT ?`,
        )
        .all(limit) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Article ids for a reclassification scope. */
  idsForReclassification(scope: { sinceIso?: string; onlyOutdatedVersion?: number }): number[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (scope.sinceIso) {
      where.push('a.discovered_at >= @since');
      params.since = scope.sinceIso;
    }
    if (scope.onlyOutdatedVersion != null) {
      where.push('(c.profile_version IS NULL OR c.profile_version <> @version)');
      params.version = scope.onlyOutdatedVersion;
    }
    return (
      this.db
        .prepare(
          `SELECT a.id FROM articles a JOIN article_state s ON s.article_id = a.id
           LEFT JOIN classifications c ON c.id = s.current_classification_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.discovered_at DESC`,
        )
        .all(params) as { id: number }[]
    ).map((r) => r.id);
  }
}
