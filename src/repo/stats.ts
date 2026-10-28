import type { DB } from '../db/database.js';
import { iso, systemClock, type Clock } from '../util/time.js';

export interface Overview {
  articles: number;
  articlesLast24h: number;
  sources: number;
  sourcesEnabled: number;
  sourcesFailing: number;
  classified: number;
  pending: number;
  failed: number;
  classificationsLast24h: number;
  saved: number;
}

export class StatsRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  private since(days: number): string {
    return iso(new Date(this.clock().getTime() - days * 86_400_000));
  }

  overview(): Overview {
    const day = this.since(1);
    const q = <T>(sql: string, ...p: unknown[]) => this.db.prepare(sql).get(...p) as T;
    const status = this.db
      .prepare('SELECT classification_status AS s, COUNT(*) AS n FROM article_state GROUP BY classification_status')
      .all() as { s: string; n: number }[];
    const by = (s: string) => status.find((r) => r.s === s)?.n ?? 0;
    const src = q<{ total: number; enabled: number; failing: number }>(
      'SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled, COALESCE(SUM(enabled = 1 AND consecutive_failures > 0), 0) AS failing FROM sources',
    );
    return {
      articles: q<{ n: number }>('SELECT COUNT(*) AS n FROM articles').n,
      articlesLast24h: q<{ n: number }>('SELECT COUNT(*) AS n FROM articles WHERE discovered_at >= ?', day).n,
      sources: src.total,
      sourcesEnabled: src.enabled,
      sourcesFailing: src.failing,
      classified: by('classified'),
      pending: by('pending'),
      failed: by('failed'),
      classificationsLast24h: q<{ n: number }>('SELECT COUNT(*) AS n FROM classifications WHERE created_at >= ?', day).n,
      saved: q<{ n: number }>('SELECT COUNT(*) AS n FROM article_state WHERE saved_at IS NOT NULL').n,
    };
  }

  /** Articles discovered and classifications made per UTC day. */
  daily(days = 14): { day: string; discovered: number; classified: number }[] {
    const since = this.since(days - 1).slice(0, 10);
    const disc = this.db
      .prepare(`SELECT substr(discovered_at, 1, 10) AS day, COUNT(*) AS n FROM articles WHERE discovered_at >= ? GROUP BY day`)
      .all(since) as { day: string; n: number }[];
    const cls = this.db
      .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM classifications WHERE created_at >= ? GROUP BY day`)
      .all(since) as { day: string; n: number }[];
    const out: { day: string; discovered: number; classified: number }[] = [];
    const start = new Date(`${since}T00:00:00.000Z`).getTime();
    for (let i = 0; i < days; i++) {
      const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      out.push({ day, discovered: disc.find((d) => d.day === day)?.n ?? 0, classified: cls.find((d) => d.day === day)?.n ?? 0 });
    }
    return out;
  }

  /** Distribution of current personal relevance in 10 buckets. */
  relevanceHistogram(): { bucket: number; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(CAST(c.personal_relevance * 10 AS INTEGER), 9) AS bucket, COUNT(*) AS count
         FROM article_state s JOIN classifications c ON c.id = s.current_classification_id GROUP BY bucket`,
      )
      .all() as { bucket: number; count: number }[];
    return Array.from({ length: 10 }, (_, i) => ({ bucket: i, count: rows.find((r) => r.bucket === i)?.count ?? 0 }));
  }

  categoryCounts(): { categoryId: string; count: number; avgProbability: number }[] {
    return this.db
      .prepare(
        `SELECT cc.category_id AS categoryId, COUNT(*) AS count, AVG(cc.probability) AS avgProbability
         FROM article_state s JOIN classification_categories cc ON cc.classification_id = s.current_classification_id
         WHERE cc.assigned = 1 GROUP BY cc.category_id ORDER BY count DESC`,
      )
      .all() as { categoryId: string; count: number; avgProbability: number }[];
  }

  articleTypeCounts(): { articleType: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT COALESCE(c.article_type, 'unknown') AS articleType, COUNT(*) AS count
         FROM article_state s JOIN classifications c ON c.id = s.current_classification_id GROUP BY articleType ORDER BY count DESC`,
      )
      .all() as { articleType: string; count: number }[];
  }

  /** How classifier scores relate to explicit feedback; a first view of classifier quality. */
  feedbackAgreement(): { label: string; count: number; avgRelevance: number | null; avgRank: number | null }[] {
    return this.db
      .prepare(
        `SELECT label, COUNT(*) AS count, AVG(rel) AS avgRelevance, AVG(rank) AS avgRank FROM (
           SELECT s.relevance_label AS label, c.personal_relevance AS rel, s.rank_score AS rank
           FROM article_state s LEFT JOIN classifications c ON c.id = s.current_classification_id WHERE s.relevance_label IS NOT NULL
           UNION ALL
           SELECT CASE s.preference WHEN 'more' THEN 'more_like_this' ELSE 'less_like_this' END, c.personal_relevance, s.rank_score
           FROM article_state s LEFT JOIN classifications c ON c.id = s.current_classification_id WHERE s.preference IS NOT NULL
         ) GROUP BY label ORDER BY label`,
      )
      .all() as { label: string; count: number; avgRelevance: number | null; avgRank: number | null }[];
  }

  /** How story scores relate to the reader's story-level labels; a first view of ranking quality. */
  storyFeedbackAgreement(): { label: string; count: number; avgRelevance: number | null; avgSignificance: number | null }[] {
    return this.db
      .prepare(
        `SELECT relevance_label AS label, COUNT(*) AS count, AVG(personal_relevance) AS avgRelevance, AVG(significance) AS avgSignificance
         FROM stories WHERE status = 'active' AND relevance_label IS NOT NULL GROUP BY relevance_label ORDER BY relevance_label`,
      )
      .all() as { label: string; count: number; avgRelevance: number | null; avgSignificance: number | null }[];
  }

  classifierUsage(days = 7): { model: string; classifierVersion: string; count: number; inputTokens: number; avgMs: number | null }[] {
    return this.db
      .prepare(
        `SELECT model, classifier_version AS classifierVersion, COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS inputTokens,
           AVG(duration_ms) AS avgMs
         FROM classifications WHERE created_at >= ? GROUP BY model, classifier_version ORDER BY count DESC`,
      )
      .all(this.since(days)) as { model: string; classifierVersion: string; count: number; inputTokens: number; avgMs: number | null }[];
  }

  extractionCounts(): { status: string; count: number }[] {
    return this.db
      .prepare('SELECT extraction_status AS status, COUNT(*) AS count FROM articles GROUP BY extraction_status ORDER BY count DESC')
      .all() as { status: string; count: number }[];
  }

  fetchSummary(hours = 24): { outcome: string; count: number; avgMs: number | null }[] {
    return this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS count, AVG(duration_ms) AS avgMs FROM source_fetches WHERE started_at >= ? GROUP BY outcome`,
      )
      .all(this.since(hours / 24)) as { outcome: string; count: number; avgMs: number | null }[];
  }

  recentFetchErrors(limit = 15): { sourceId: number; sourceName: string; startedAt: string; httpStatus: number | null; error: string }[] {
    return this.db
      .prepare(
        `SELECT f.source_id AS sourceId, s.name AS sourceName, f.started_at AS startedAt, f.http_status AS httpStatus, f.error
         FROM source_fetches f JOIN sources s ON s.id = f.source_id WHERE f.outcome = 'error' ORDER BY f.started_at DESC LIMIT ?`,
      )
      .all(limit) as { sourceId: number; sourceName: string; startedAt: string; httpStatus: number | null; error: string }[];
  }
}
