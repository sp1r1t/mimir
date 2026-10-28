import type { DB } from '../db/database.js';
import type { PlaceKind } from '../places/places.js';
import { toFtsQuery } from '../repo/articles.js';
import { articleProvenance, type ArticleProvenance } from '../repo/provenance.js';
import { parseStoredContent, type SummaryArticle, type SummaryStory, type StorySummaryContent, type UsedArticle } from '../summaries/summary.js';
import type { FoundTerm, GlossaryEntry, TermKind, TermStatus } from '../terms/schema.js';
import { termKey } from '../terms/schema.js';
import { iso, systemClock, type Clock } from '../util/time.js';
import type { AssessmentMember, StoryAssessment } from './assessment.js';
import type { CandidateJudgement, MatchCandidate, MatchReport } from './matcher.js';
import { anyTermQuery, contentTerms, publisherOf, titleKey } from './text.js';

export type StoryRole = 'origin' | 'coverage' | 'update';
export type SummaryState = 'none' | 'pending' | 'running' | 'ready' | 'stale' | 'failed';
export type PlacesState = 'none' | 'pending' | 'running' | 'ready' | 'stale' | 'failed';
export type TermsState = 'none' | 'pending' | 'running' | 'ready' | 'stale' | 'failed';

/** A term of the glossary, with what is known about it. */
export interface TermRecord extends GlossaryEntry {
  id: number;
  createdAt: string;
  updatedAt: string;
}

/** A term of a story: the glossary's term, and the story's own note about it. */
export interface StoryTerm extends TermRecord {
  role: string | null;
  sources: number[];
}

/** A place a story is about, with where the gazetteer put it. */
export interface StoryPlace {
  id: number;
  name: string;
  kind: PlaceKind;
  country: string | null;
  /** ISO 3166-1 alpha-2 of the country the articles place it in. */
  countryCode: string | null;
  /** The name to look up in the gazetteer, made unambiguous by the model. */
  query: string | null;
  role: string | null;
  lat: number | null;
  lon: number | null;
  /** The gazetteer's short name for the place, e.g. "Kyiv, Ukraine". */
  label: string | null;
  displayName: string | null;
  osmId: string | null;
  status: 'located' | 'unresolved';
  sources: number[];
}

/** What the gazetteer said about a name, found or not found. */
export interface GeocodeRecord {
  status: 'located' | 'unresolved';
  lat: number | null;
  lon: number | null;
  label: string | null;
  displayName: string | null;
  osmId: string | null;
}

export interface ArticleForMatching {
  id: number;
  title: string | null;
  summaryText: string | null;
  sourceName: string | null;
  publisher: string;
  occurredAt: string;
}

export interface Candidate {
  storyId: number;
  similarity: number;
  titleMatch: boolean;
}

export interface MatchRecord {
  articleId: number;
  storyId: number | null;
  outcome: 'new_story' | 'joined';
  role: StoryRole;
  method: 'no_candidates' | 'title_match' | 'matcher';
  candidates: (Candidate & Partial<Pick<CandidateJudgement, 'same' | 'update'>>)[];
  matcher?: string;
  matcherVersion?: string;
  model?: string;
  rawRequest?: unknown;
  rawResponse?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number;
}

export type StorySort = 'priority' | 'relevance' | 'significance' | 'urgency' | 'latest' | 'newest' | 'coverage';
export const STORY_SORTS: StorySort[] = ['priority', 'relevance', 'significance', 'urgency', 'latest', 'newest', 'coverage'];

export interface StoryFilters {
  q?: string;
  category?: string;
  minRelevance?: number;
  minSignificance?: number;
  minPublishers?: number;
  /** Only stories with articles published in the last N days. */
  days?: number;
  state?: 'new' | 'developing';
  summary?: 'ready' | 'stale' | 'none' | 'pending' | 'failed';
  /** unseen: never marked seen, or developed since. seen: marked seen with no newer development. */
  seen?: 'unseen' | 'seen';
  /** saved: kept by the reader. unsaved: everything else. */
  saved?: 'saved' | 'unsaved';
  sort?: StorySort;
  page?: number;
  pageSize?: number;
}

export type StoryRelevanceEvent = 'relevant' | 'not_relevant' | 'clear_relevance';
export const STORY_RELEVANCE_EVENTS: StoryRelevanceEvent[] = ['relevant', 'not_relevant', 'clear_relevance'];

/** A publisher with articles in a story. */
export interface StoryPublisher {
  /** Normalized site host, the same identity used for distinct-publisher counts. */
  publisher: string;
  /** The publisher's earliest article in the story. */
  articleId: number;
  articles: number;
  firstAt: string;
  latestAt: string;
  /** Reported the story first. */
  origin: boolean;
}

export interface StoryListItem {
  id: number;
  status: 'active' | 'merged';
  mergedIntoId: number | null;
  headline: string;
  leadArticleId: number | null;
  leadSummary: string | null;
  summaryHeadline: string | null;
  articleCount: number;
  publisherCount: number;
  developmentCount: number;
  firstPublishedAt: string | null;
  latestPublishedAt: string | null;
  latestDevelopmentAt: string | null;
  personalRelevance: number | null;
  significance: number | null;
  urgency: number | null;
  coverage: number | null;
  priorityStatic: number | null;
  recencyWeight: number | null;
  recencyHalfLifeHours: number | null;
  priority: number | null;
  categories: { id: string; label: string; probability: number }[];
  summaryId: number | null;
  summaryStale: boolean;
  summaryRequest: 'idle' | 'pending' | 'running' | 'failed';
  summaryError: string | null;
  summaryState: SummaryState;
  /** Publishers in display order: the first reporter, then the rest by most recent coverage. Filled by list(), item() and get(). */
  publishers: StoryPublisher[];
  /** The reader's relevance label for the whole story; persists across developments. */
  relevanceLabel: 'relevant' | 'not_relevant' | null;
  /** When the story was last marked seen, if ever. */
  seenAt: string | null;
  /** When the reader saved the story, if ever. */
  savedAt: string | null;
  unseen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoryMember {
  articleId: number;
  title: string | null;
  url: string | null;
  sourceName: string | null;
  provenance: ArticleProvenance[];
  summaryText: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  occurredAt: string;
  role: StoryRole;
  assignedBy: 'matcher' | 'user';
  publisher: string;
  contentQuality: string;
  matchId: number | null;
  matchMethod: string | null;
  matchModel: string | null;
  matchCandidates: MatchRecord['candidates'] | null;
  classificationStatus: string;
  rankScore: number | null;
  personalRelevance: number | null;
  significance: number | null;
  urgency: number | null;
  promotional: number | null;
  relevanceLabel: 'relevant' | 'not_relevant' | null;
  preference: 'more' | 'less' | null;
  savedAt: string | null;
}

export interface StoryDevelopment {
  id: number;
  articleId: number;
  kind: 'origin' | 'update';
  occurredAt: string;
  detectedAt: string;
  title: string | null;
  sourceName: string | null;
}

export interface StorySummaryRecord {
  id: number;
  storyId: number;
  revision: number;
  trigger: 'auto' | 'manual';
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  articles: UsedArticle[];
  content: StorySummaryContent;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AssessmentRecord {
  id: number;
  formula: string;
  profileVersion: number;
  personalRelevance: number | null;
  significance: number | null;
  urgency: number | null;
  coverage: number;
  priorityStatic: number | null;
  recencyWeight: number;
  recencyHalfLifeHours: number;
  categories: StoryAssessment['categories'];
  evidence: StoryAssessment['evidence'];
  createdAt: string;
}

export interface StoryDetail extends StoryListItem {
  members: StoryMember[];
  developments: StoryDevelopment[];
  events: { id: number; eventType: string; details: Record<string, unknown>; createdAt: string }[];
  assessments: AssessmentRecord[];
  summary: StorySummaryRecord | null;
  summaryRevisions: { id: number; revision: number; trigger: string; model: string; createdAt: string; articleIds: number[] }[];
  /** When the reader asked for a brief, and when the writing of it began. */
  summaryRequestedAt: string | null;
  summaryStartedAt: string | null;
  placesState: PlacesState;
  placesError: string | null;
  places: StoryPlace[];
  termsState: TermsState;
  termsError: string | null;
  terms: StoryTerm[];
}

/** Never marked seen, or a newer meaningful development arrived since it was. */
const UNSEEN_SQL = `(s.seen_at IS NULL OR COALESCE(s.latest_development_at, '') > COALESCE(s.seen_development_at, ''))`;

const STORY_COLUMNS = `s.id, s.status, s.merged_into_id AS mergedIntoId, s.headline, s.lead_article_id AS leadArticleId,
  la.summary_text AS leadSummary, json_extract(ss.content, '$.headline') AS summaryHeadline,
  s.article_count AS articleCount, s.publisher_count AS publisherCount, s.development_count AS developmentCount,
  s.first_published_at AS firstPublishedAt, s.latest_published_at AS latestPublishedAt, s.latest_development_at AS latestDevelopmentAt,
  s.personal_relevance AS personalRelevance, s.significance, s.urgency, s.coverage,
  s.priority_static AS priorityStatic, s.recency_weight AS recencyWeight, s.recency_half_life_hours AS recencyHalfLifeHours,
  ${priorityExpr('s')} AS priority, s.categories AS categoriesJson,
  s.summary_id AS summaryId, s.summary_stale AS summaryStaleInt, s.summary_request AS summaryRequest, s.summary_error AS summaryError,
  s.relevance_label AS relevanceLabel, s.seen_at AS seenAt, s.saved_at AS savedAt, ${UNSEEN_SQL} AS unseenInt,
  s.created_at AS createdAt, s.updated_at AS updatedAt`;

const STORY_FROM = `FROM stories s
  LEFT JOIN articles la ON la.id = s.lead_article_id
  LEFT JOIN story_summaries ss ON ss.id = s.summary_id`;

/** SQL form of priorityAt() in assessment.ts; @now is an ISO timestamp. */
function priorityExpr(t: string): string {
  return `(${t}.priority_static + ${t}.recency_weight / (1.0 + MAX(0.0, (julianday(@now) - julianday(${t}.latest_development_at)) * 24.0) / ${t}.recency_half_life_hours))`;
}

type StoryRow = Omit<StoryListItem, 'categories' | 'summaryStale' | 'summaryState' | 'unseen'> & {
  categoriesJson: string;
  summaryStaleInt: number;
  unseenInt: number;
};

function toListItem(r: StoryRow): StoryListItem {
  const { categoriesJson, summaryStaleInt, unseenInt, ...rest } = r;
  const summaryStale = summaryStaleInt === 1;
  const summaryState: SummaryState =
    r.summaryRequest !== 'idle' ? r.summaryRequest : r.summaryId == null ? 'none' : summaryStale ? 'stale' : 'ready';
  return {
    ...rest,
    priority: rest.priority == null ? null : Math.min(1, Math.max(0, rest.priority)),
    categories: JSON.parse(categoriesJson),
    summaryStale,
    summaryState,
    publishers: [],
    unseen: unseenInt === 1,
  };
}

/** Publication time when plausible, otherwise discovery time. */
function occurredAt(publishedAt: string | null, discoveredAt: string): string {
  return publishedAt && publishedAt <= discoveredAt ? publishedAt : discoveredAt;
}

const MEMBER_TEXT_LIMIT = 15;

export class StoryRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return iso(this.clock());
  }

  // ---- Matching -------------------------------------------------------------------

  storyIdOf(articleId: number): number | null {
    const r = this.db.prepare('SELECT story_id AS id FROM story_articles WHERE article_id = ?').get(articleId) as { id: number } | undefined;
    return r?.id ?? null;
  }

  articleForMatching(articleId: number): ArticleForMatching | null {
    const r = this.db
      .prepare(
        `SELECT a.id, a.title, a.summary_text AS summaryText, a.url, COALESCE(src.name, e.source_name) AS sourceName,
           a.published_at AS publishedAt, a.discovered_at AS discoveredAt
         FROM articles a LEFT JOIN sources src ON src.id = a.source_id
         LEFT JOIN article_entries e ON e.article_id = a.id
         WHERE a.id = ? LIMIT 1`,
      )
      .get(articleId) as
      | { id: number; title: string | null; summaryText: string | null; url: string | null; sourceName: string | null; publishedAt: string | null; discoveredAt: string }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      summaryText: r.summaryText,
      sourceName: r.sourceName,
      publisher: publisherOf(r.url, r.sourceName),
      occurredAt: occurredAt(r.publishedAt, r.discoveredAt),
    };
  }

  /** BM25 inverse document frequency: positive even for terms in every article, so small corpora still match. */
  private idf(terms: string[]): Map<string, number> {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
    const weight = (doc: number) => Math.log(1 + (total - doc + 0.5) / (doc + 0.5));
    const out = new Map<string, number>(terms.map((t) => [t, weight(0)]));
    if (!terms.length) return out;
    const rows = this.db
      .prepare(`SELECT term, doc FROM articles_fts_vocab WHERE term IN (${terms.map(() => '?').join(',')})`)
      .all(...terms) as { term: string; doc: number }[];
    for (const r of rows) out.set(r.term, weight(r.doc));
    return out;
  }

  private static matchTerms(title: string | null, summary: string | null): string[] {
    return [...new Set([...contentTerms(title), ...contentTerms(summary?.slice(0, 500))])];
  }

  /**
   * Stories with members published within `windowDays` of the article that share its
   * distinctive terms. Similarity is the IDF-weighted share of the article's terms that
   * appear in the story's titles and summaries.
   */
  candidates(article: ArticleForMatching, opts: { windowDays: number; limit: number; excludeStoryId?: number }): Candidate[] {
    const terms = StoryRepository.matchTerms(article.title, article.summaryText);
    if (!terms.length) return [];
    const idf = this.idf(terms);
    const query = anyTermQuery([...terms].sort((a, b) => idf.get(b)! - idf.get(a)!).slice(0, 12));
    const t = Date.parse(article.occurredAt);
    const windowMs = opts.windowDays * 86_400_000;
    const storyIds = (
      this.db
        .prepare(
          `SELECT sa.story_id AS storyId, MIN(f.bm) AS bm
           FROM (SELECT rowid AS id, rank AS bm FROM articles_fts WHERE articles_fts MATCH @query) f
           JOIN story_articles sa ON sa.article_id = f.id
           JOIN stories s ON s.id = sa.story_id AND s.status = 'active'
           WHERE sa.article_id <> @articleId AND sa.occurred_at BETWEEN @from AND @to AND sa.story_id <> @exclude
           GROUP BY sa.story_id ORDER BY bm LIMIT 25`,
        )
        .all({
          query,
          articleId: article.id,
          from: new Date(t - windowMs).toISOString(),
          to: new Date(t + windowMs).toISOString(),
          exclude: opts.excludeStoryId ?? -1,
        }) as { storyId: number }[]
    ).map((r) => r.storyId);

    const titleTerms = [...new Set(contentTerms(article.title))];
    const weight = (ts: string[]) => ts.reduce((sum, term) => sum + idf.get(term)!, 0);
    const articleWeight = weight(terms);
    const titleWeight = weight(titleTerms);
    const key = titleKey(article.title);
    const memberStmt = this.db.prepare(
      `SELECT a.title, a.summary_text AS summaryText FROM story_articles sa JOIN articles a ON a.id = sa.article_id
       WHERE sa.story_id = ? ORDER BY sa.role = 'coverage', sa.occurred_at DESC LIMIT ${MEMBER_TEXT_LIMIT}`,
    );
    const out: Candidate[] = [];
    for (const storyId of storyIds) {
      const members = memberStmt.all(storyId) as { title: string | null; summaryText: string | null }[];
      const storyTerms = new Set(members.flatMap((m) => StoryRepository.matchTerms(m.title, m.summaryText)));
      const shared = (ts: string[]) => weight(ts.filter((term) => storyTerms.has(term)));
      // Teasers add many terms that dilute overlap; the title alone is often the better signal.
      const similarity = Math.max(
        articleWeight > 0 ? shared(terms) / articleWeight : 0,
        titleWeight > 0 ? shared(titleTerms) / titleWeight : 0,
      );
      const titleMatch = key.split(' ').length >= 4 && members.some((m) => titleKey(m.title) === key);
      out.push({ storyId, similarity, titleMatch });
    }
    return out.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.similarity - a.similarity).slice(0, opts.limit);
  }

  /** What the matcher sees of a story: its first report, latest developments, and latest coverage. */
  candidateView(storyId: number): MatchCandidate | null {
    const s = this.db.prepare('SELECT headline FROM stories WHERE id = ?').get(storyId) as { headline: string } | undefined;
    if (!s) return null;
    const rows = this.db
      .prepare(
        `SELECT a.title, a.summary_text AS summary, COALESCE(src.name, sa.publisher) AS source, sa.role
         FROM story_articles sa JOIN articles a ON a.id = sa.article_id LEFT JOIN sources src ON src.id = a.source_id
         WHERE sa.story_id = ? ORDER BY sa.occurred_at`,
      )
      .all(storyId) as (MatchReport & { role: StoryRole })[];
    const origin = rows.filter((r) => r.role === 'origin');
    const updates = rows.filter((r) => r.role === 'update').slice(-2);
    const coverage = rows.filter((r) => r.role === 'coverage').slice(-1);
    const reports = [...origin, ...updates, ...coverage].map(({ title, summary, source }) => ({ title, summary, source }));
    return { storyId, headline: s.headline, reports: reports.length ? reports : rows.slice(0, 1) };
  }

  recordMatch(m: MatchRecord): number {
    const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    const res = this.db
      .prepare(
        `INSERT INTO story_matches (article_id, story_id, outcome, role, method, candidates, matcher, matcher_version, model,
           raw_request, raw_response, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.articleId, m.storyId, m.outcome, m.role, m.method, JSON.stringify(m.candidates), m.matcher ?? null, m.matcherVersion ?? null,
        m.model ?? null, j(m.rawRequest), j(m.rawResponse), m.inputTokens ?? null, m.outputTokens ?? null, m.durationMs ?? null, this.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /** Follow merges to the story that now holds a merged story's articles. */
  resolve(storyId: number): number | null {
    let id: number | null = storyId;
    for (let i = 0; id != null && i < 50; i++) {
      const r = this.db.prepare('SELECT status, merged_into_id AS target FROM stories WHERE id = ?').get(id) as
        | { status: string; target: number | null }
        | undefined;
      if (!r) return null;
      if (r.status === 'active') return id;
      id = r.target;
    }
    return null;
  }

  /** Create a story with the article as its first report. Call inside a transaction with recordMatch. */
  createStory(article: ArticleForMatching, assignedBy: 'matcher' | 'user', matchId: number | null): number {
    const now = this.now();
    const res = this.db
      .prepare(`INSERT INTO stories (headline, lead_article_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(article.title ?? '(untitled)', article.id, now, now);
    const storyId = Number(res.lastInsertRowid);
    this.insertMember(storyId, article, 'origin', assignedBy, matchId);
    this.refresh(storyId);
    return storyId;
  }

  /** Add an article to a story. A meaningful update becomes a development and outdates the summary. */
  addToStory(storyId: number, article: ArticleForMatching, role: Exclude<StoryRole, 'origin'>, matchId: number | null): void {
    this.insertMember(storyId, article, role, 'matcher', matchId);
    if (role === 'update') this.markSummaryStale(storyId);
    this.refresh(storyId);
  }

  private insertMember(storyId: number, a: ArticleForMatching, role: StoryRole, assignedBy: 'matcher' | 'user', matchId: number | null): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO story_articles (article_id, story_id, role, assigned_by, match_id, publisher, occurred_at, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, storyId, role, assignedBy, matchId, a.publisher, a.occurredAt, now);
    if (role !== 'coverage') {
      this.db
        .prepare('INSERT INTO story_developments (story_id, article_id, kind, occurred_at, detected_at) VALUES (?, ?, ?, ?, ?)')
        .run(storyId, a.id, role, a.occurredAt, now);
    }
  }

  /** The story changed meaningfully: the summary and the places are outdated, and a previous failure no longer blocks automatic generation. */
  private markSummaryStale(storyId: number): void {
    this.db
      .prepare(
        `UPDATE stories SET summary_stale = CASE WHEN summary_id IS NOT NULL THEN 1 ELSE 0 END,
           summary_request = CASE WHEN summary_request = 'failed' THEN 'idle' ELSE summary_request END,
           summary_error = CASE WHEN summary_request = 'failed' THEN NULL ELSE summary_error END,
           places_state = CASE WHEN places_state = 'ready' THEN 'stale' ELSE places_state END,
           places_error = CASE WHEN places_state = 'failed' THEN NULL ELSE places_error END,
           terms_state = CASE WHEN terms_state = 'ready' THEN 'stale' ELSE terms_state END,
           terms_error = CASE WHEN terms_state = 'failed' THEN NULL ELSE terms_error END
         WHERE id = ?`,
      )
      .run(storyId);
  }

  /**
   * Make the earliest development the origin (and give a story without developments one),
   * keep member roles in line with developments, and recompute membership aggregates.
   */
  private refresh(storyId: number): void {
    const devs = this.db
      .prepare('SELECT id, article_id AS articleId FROM story_developments WHERE story_id = ? ORDER BY occurred_at, id')
      .all(storyId) as { id: number; articleId: number }[];
    if (!devs.length) {
      const first = this.db
        .prepare('SELECT article_id AS articleId, occurred_at AS occurredAt FROM story_articles WHERE story_id = ? ORDER BY occurred_at, article_id LIMIT 1')
        .get(storyId) as { articleId: number; occurredAt: string } | undefined;
      if (first) {
        const r = this.db
          .prepare(`INSERT INTO story_developments (story_id, article_id, kind, occurred_at, detected_at) VALUES (?, ?, 'origin', ?, ?)`)
          .run(storyId, first.articleId, first.occurredAt, this.now());
        devs.push({ id: Number(r.lastInsertRowid), articleId: first.articleId });
      }
    }
    devs.forEach((d, i) => {
      const kind = i === 0 ? 'origin' : 'update';
      this.db.prepare('UPDATE story_developments SET kind = ? WHERE id = ?').run(kind, d.id);
      this.db.prepare('UPDATE story_articles SET role = ? WHERE article_id = ?').run(kind, d.articleId);
    });
    this.db
      .prepare(
        `UPDATE story_articles SET role = 'coverage'
         WHERE story_id = ? AND role <> 'coverage' AND article_id NOT IN (SELECT article_id FROM story_developments WHERE story_id = ?)`,
      )
      .run(storyId, storyId);
    const origin = devs[0]?.articleId ?? null;
    this.db
      .prepare(
        `UPDATE stories SET
           article_count = (SELECT COUNT(*) FROM story_articles WHERE story_id = @id),
           publisher_count = (SELECT COUNT(DISTINCT publisher) FROM story_articles WHERE story_id = @id),
           development_count = (SELECT COUNT(*) FROM story_developments WHERE story_id = @id),
           first_published_at = (SELECT MIN(occurred_at) FROM story_articles WHERE story_id = @id),
           latest_published_at = (SELECT MAX(occurred_at) FROM story_articles WHERE story_id = @id),
           latest_development_at = (SELECT MAX(occurred_at) FROM story_developments WHERE story_id = @id),
           lead_article_id = COALESCE(@origin, lead_article_id),
           headline = COALESCE((SELECT title FROM articles WHERE id = @origin), headline),
           updated_at = @now
         WHERE id = @id`,
      )
      .run({ id: storyId, origin, now: this.now() });
  }

  // ---- Curation ---------------------------------------------------------------------

  /** Move every article of `sourceId` into `targetId` and close the source story. */
  merge(sourceId: number, targetId: number): void {
    if (sourceId === targetId) throw new Error('A story cannot be merged into itself');
    this.db.transaction(() => {
      const src = this.activeOrThrow(sourceId);
      this.activeOrThrow(targetId);
      const now = this.now();
      this.db.prepare('UPDATE story_articles SET story_id = ? WHERE story_id = ?').run(targetId, sourceId);
      this.db.prepare('UPDATE story_developments SET story_id = ? WHERE story_id = ?').run(targetId, sourceId);
      this.db.prepare(`UPDATE stories SET merged_into_id = ? WHERE merged_into_id = ?`).run(targetId, sourceId);
      this.db
        .prepare(
          `UPDATE stories SET status = 'merged', merged_into_id = ?, article_count = 0, publisher_count = 0, development_count = 0,
             summary_request = 'idle', updated_at = ? WHERE id = ?`,
        )
        .run(targetId, now, sourceId);
      this.markSummaryStale(targetId);
      this.refresh(targetId);
      this.event(sourceId, 'merged_into', { storyId: targetId, articles: src.articleCount });
      this.event(targetId, 'absorbed', { storyId: sourceId, headline: src.headline, articles: src.articleCount });
    })();
  }

  /** Move the given articles into a new story. Returns the new story's id. */
  split(storyId: number, articleIds: number[]): number {
    return this.db.transaction(() => {
      const story = this.activeOrThrow(storyId);
      const ids = [...new Set(articleIds)];
      const members = new Set(
        (this.db.prepare('SELECT article_id AS id FROM story_articles WHERE story_id = ?').all(storyId) as { id: number }[]).map((r) => r.id),
      );
      if (!ids.length) throw new Error('Select at least one article to move');
      if (ids.some((id) => !members.has(id))) throw new Error('Some selected articles are not part of this story');
      if (ids.length >= members.size) throw new Error('Leave at least one article in the story');
      const now = this.now();
      const res = this.db.prepare('INSERT INTO stories (headline, created_at, updated_at) VALUES (?, ?, ?)').run(story.headline, now, now);
      const newId = Number(res.lastInsertRowid);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE story_articles SET story_id = ?, assigned_by = 'user' WHERE article_id IN (${placeholders})`).run(newId, ...ids);
      this.db.prepare(`UPDATE story_developments SET story_id = ? WHERE article_id IN (${placeholders})`).run(newId, ...ids);
      this.markSummaryStale(storyId);
      this.refresh(storyId);
      this.refresh(newId);
      this.event(storyId, 'split_out', { storyId: newId, articleIds: ids });
      this.event(newId, 'split_from', { storyId, articleIds: ids });
      return newId;
    })();
  }

  private activeOrThrow(id: number): { headline: string; articleCount: number } {
    const r = this.db.prepare(`SELECT headline, article_count AS articleCount, status FROM stories WHERE id = ?`).get(id) as
      | { headline: string; articleCount: number; status: string }
      | undefined;
    if (!r) throw new Error(`Story ${id} not found`);
    if (r.status !== 'active') throw new Error(`Story ${id} was merged into another story`);
    return r;
  }

  private event(storyId: number, type: string, details: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO story_events (story_id, event_type, details, created_at) VALUES (?, ?, ?, ?)')
      .run(storyId, type, JSON.stringify(details), this.now());
  }

  // ---- Assessment -------------------------------------------------------------------

  assessmentMembers(storyId: number): AssessmentMember[] {
    const rows = this.db
      .prepare(
        `SELECT sa.article_id AS articleId, sa.publisher, sa.occurred_at AS occurredAt,
           c.id AS cid, c.personal_relevance AS rel, c.significance AS sig, c.urgency AS urg, c.promotional AS promo,
           c.exclusion AS excl, c.categories AS cats
         FROM story_articles sa JOIN article_state st ON st.article_id = sa.article_id
         LEFT JOIN classifications c ON c.id = st.current_classification_id
         WHERE sa.story_id = ? ORDER BY sa.occurred_at`,
      )
      .all(storyId) as {
      articleId: number; publisher: string; occurredAt: string; cid: number | null; rel: number; sig: number; urg: number;
      promo: number | null; excl: number | null; cats: string;
    }[];
    return rows.map((r) => ({
      articleId: r.articleId,
      publisher: r.publisher,
      occurredAt: r.occurredAt,
      classification:
        r.cid == null
          ? null
          : { id: r.cid, personalRelevance: r.rel, significance: r.sig, urgency: r.urg, promotional: r.promo, exclusion: r.excl, categories: JSON.parse(r.cats) },
    }));
  }

  /** Store an assessment when it differs from the current one, and make it current. Returns true when it changed. */
  saveAssessment(storyId: number, a: StoryAssessment): boolean {
    return this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT sa.input_hash AS h FROM stories s JOIN story_assessments sa ON sa.id = s.assessment_id WHERE s.id = ?')
        .get(storyId) as { h: string } | undefined;
      if (current?.h === a.inputHash) return false;
      const res = this.db
        .prepare(
          `INSERT INTO story_assessments (story_id, formula, profile_version, input_hash, personal_relevance, significance, urgency, coverage,
             priority_static, recency_weight, recency_half_life_hours, categories, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storyId, a.formula, a.profileVersion, a.inputHash, a.personalRelevance, a.significance, a.urgency, a.coverage,
          a.priorityStatic, a.recencyWeight, a.recencyHalfLifeHours, JSON.stringify(a.categories), JSON.stringify(a.evidence), this.now(),
        );
      this.db
        .prepare(
          `UPDATE stories SET assessment_id = ?, personal_relevance = ?, significance = ?, urgency = ?, coverage = ?, priority_static = ?,
             recency_weight = ?, recency_half_life_hours = ?, categories = ? WHERE id = ?`,
        )
        .run(
          Number(res.lastInsertRowid), a.personalRelevance, a.significance, a.urgency, a.coverage, a.priorityStatic,
          a.recencyWeight, a.recencyHalfLifeHours, JSON.stringify(a.categories.map(({ id, label, probability }) => ({ id, label, probability }))), storyId,
        );
      return true;
    })();
  }

  /** Active stories never assessed or assessed under another profile version, without a pending assessment job. */
  outdatedAssessments(profileVersion: number, kind: string, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT s.id FROM stories s LEFT JOIN story_assessments sa ON sa.id = s.assessment_id
           WHERE s.status = 'active' AND (sa.id IS NULL OR sa.profile_version <> ?)
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = ? AND j.dedupe_key = 'story:' || s.id AND j.status IN ('pending', 'running'))
           ORDER BY s.latest_development_at DESC LIMIT ?`,
        )
        .all(profileVersion, kind, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Recent active stories that have no summary or a stale one and no summary request in progress. */
  summaryCandidates(sinceIso: string, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM stories
           WHERE status = 'active' AND latest_development_at >= ? AND summary_request = 'idle'
             AND (summary_id IS NULL OR summary_stale = 1)
           ORDER BY priority_static + recency_weight DESC LIMIT ?`,
        )
        .all(sinceIso, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  // ---- Summaries --------------------------------------------------------------------

  summaryInput(storyId: number): { story: SummaryStory; articles: SummaryArticle[] } | null {
    const s = this.db
      .prepare(
        `SELECT id, headline, first_published_at AS firstPublishedAt, latest_development_at AS latestDevelopmentAt,
           article_count AS articleCount, publisher_count AS publisherCount FROM stories WHERE id = ? AND status = 'active'`,
      )
      .get(storyId) as SummaryStory | undefined;
    if (!s) return null;
    const articles = this.db
      .prepare(
        `SELECT a.id, sa.role, COALESCE(src.name, sa.publisher) AS source, sa.publisher, sa.occurred_at AS occurredAt, a.title,
           a.summary_text AS summaryText, a.content_text AS contentText, a.content_quality AS contentQuality, a.content_hash AS contentHash,
           c.significance
         FROM story_articles sa JOIN articles a ON a.id = sa.article_id LEFT JOIN sources src ON src.id = a.source_id
         JOIN article_state st ON st.article_id = a.id LEFT JOIN classifications c ON c.id = st.current_classification_id
         WHERE sa.story_id = ? ORDER BY sa.occurred_at`,
      )
      .all(storyId) as SummaryArticle[];
    return { story: s, articles };
  }

  currentSummary(storyId: number): StorySummaryRecord | null {
    const r = this.db
      .prepare('SELECT ss.* FROM stories s JOIN story_summaries ss ON ss.id = s.summary_id WHERE s.id = ?')
      .get(storyId) as Record<string, unknown> | undefined;
    return r ? toSummary(r) : null;
  }

  lastSummaryAt(storyId: number): string | null {
    const r = this.db.prepare('SELECT MAX(created_at) AS t FROM story_summaries WHERE story_id = ?').get(storyId) as { t: string | null };
    return r.t;
  }

  /**
   * A short digest of everything a story page shows: the brief, the places, the articles
   * and the assessment. A page that watches it knows when to refresh itself, without
   * having to be told what changed.
   */
  storyVersion(storyId: number): string {
    const r = this.db
      .prepare(
        `SELECT s.summary_id AS summaryId, s.summary_request AS summaryRequest, s.summary_stale AS summaryStale,
                s.places_state AS placesState, s.terms_state AS termsState,
                (SELECT COUNT(*) FROM story_articles WHERE story_id = s.id) AS articles,
                (SELECT MAX(id) FROM story_summaries WHERE story_id = s.id) AS brief,
                (SELECT MAX(id) FROM story_places WHERE story_id = s.id) AS places,
                (SELECT MAX(id) FROM story_terms WHERE story_id = s.id) AS terms,
                (SELECT MAX(id) FROM story_assessments WHERE story_id = s.id) AS assessment
           FROM stories s WHERE s.id = ?`,
      )
      .get(storyId) as Record<string, unknown> | undefined;
    if (!r) return '';
    return [r.summaryId, r.summaryRequest, r.summaryStale, r.placesState, r.termsState, r.articles, r.brief, r.places, r.terms, r.assessment].join('|');
  }

  // ---- Places ------------------------------------------------------------------------

  /** Where the place lookup stands, and what went wrong if something did. */
  placesState(storyId: number): { state: PlacesState; error: string | null } {
    const r = this.db.prepare('SELECT places_state AS state, places_error AS error FROM stories WHERE id = ?').get(storyId) as
      | { state: PlacesState; error: string | null }
      | undefined;
    return r ?? { state: 'none', error: null };
  }

  setPlacesState(storyId: number, state: PlacesState, error: string | null = null): void {
    this.db.prepare('UPDATE stories SET places_state = ?, places_error = ? WHERE id = ?').run(state, error, storyId);
  }

  /** After a restart, a lookup that is no longer queued must not look like it is running. */
  reconcilePlacesRequests(kind: string): number {
    const active = `SELECT 1 FROM jobs j WHERE j.kind = '${kind}' AND j.status IN ('pending', 'running')
                    AND json_extract(j.payload, '$.storyId') = stories.id`;
    const a = this.db
      .prepare(`UPDATE stories SET places_state = 'pending' WHERE places_state = 'running' AND EXISTS (${active} AND j.status = 'pending')`)
      .run().changes;
    const b = this.db
      .prepare(`UPDATE stories SET places_state = 'none' WHERE places_state IN ('pending', 'running') AND NOT EXISTS (${active})`)
      .run().changes;
    return a + b;
  }

  /** The places of a story, the located ones first. */
  places(storyId: number): StoryPlace[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, kind, country, country_code AS countryCode, query, role, lat, lon, label, display_name AS displayName, osm_id AS osmId, status, sources
           FROM story_places WHERE story_id = ? ORDER BY status = 'located' DESC, name`,
      )
      .all(storyId) as (Omit<StoryPlace, 'sources'> & { sources: string })[];
    return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }

  /** Replace a story's places with what was found this time. */
  savePlaces(storyId: number, places: Omit<StoryPlace, 'id'>[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM story_places WHERE story_id = ?').run(storyId);
      const insert = this.db.prepare(
        `INSERT INTO story_places (story_id, name, kind, country, country_code, query, role, lat, lon, label, display_name, osm_id, status, sources, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.now();
      for (const p of places) {
        insert.run(
          storyId, p.name, p.kind, p.country, p.countryCode, p.query, p.role, p.lat, p.lon, p.label, p.displayName, p.osmId, p.status,
          JSON.stringify(p.sources), now,
        );
      }
      this.db.prepare("UPDATE stories SET places_state = 'ready', places_error = NULL WHERE id = ?").run(storyId);
    })();
  }

  /** What the gazetteer said about a name, if it was asked before. */
  cachedGeocode(queryKey: string): GeocodeRecord | null {
    const r = this.db
      .prepare('SELECT status, lat, lon, label, display_name AS displayName, osm_id AS osmId FROM place_geocodes WHERE query_key = ?')
      .get(queryKey) as GeocodeRecord | undefined;
    return r ?? null;
  }

  saveGeocode(queryKey: string, g: GeocodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO place_geocodes (query_key, status, lat, lon, label, display_name, osm_id, queried_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(query_key) DO UPDATE SET status = excluded.status, lat = excluded.lat, lon = excluded.lon,
             label = excluded.label, display_name = excluded.display_name, osm_id = excluded.osm_id, queried_at = excluded.queried_at`,
      )
      .run(queryKey, g.status, g.lat, g.lon, g.label, g.displayName, g.osmId, this.now());
  }

  // ---- Terms ------------------------------------------------------------------------

  /** Where the term lookup stands, and what went wrong if something did. */
  termsState(storyId: number): { state: TermsState; error: string | null } {
    const r = this.db.prepare('SELECT terms_state AS state, terms_error AS error FROM stories WHERE id = ?').get(storyId) as
      | { state: TermsState; error: string | null }
      | undefined;
    return r ?? { state: 'none', error: null };
  }

  setTermsState(storyId: number, state: TermsState, error: string | null = null): void {
    this.db.prepare('UPDATE stories SET terms_state = ?, terms_error = ? WHERE id = ?').run(state, error, storyId);
  }

  /** After a restart, a lookup that is no longer queued must not look like it is running. */
  reconcileTermsRequests(kind: string): number {
    const active = `SELECT 1 FROM jobs j WHERE j.kind = '${kind}' AND j.status IN ('pending', 'running')
                    AND json_extract(j.payload, '$.storyId') = stories.id`;
    const a = this.db
      .prepare(`UPDATE stories SET terms_state = 'pending' WHERE terms_state = 'running' AND EXISTS (${active} AND j.status = 'pending')`)
      .run().changes;
    const b = this.db
      .prepare(`UPDATE stories SET terms_state = 'none' WHERE terms_state IN ('pending', 'running') AND NOT EXISTS (${active})`)
      .run().changes;
    return a + b;
  }

  /**
   * Remember the terms a story is about. A term keeps the explanation it was given the
   * first time: the glossary is shared by every story, so a term is explained once and
   * then reused.
   */
  saveTerms(storyId: number, terms: FoundTerm[]): void {
    this.db.transaction(() => {
      const now = this.now();
      const upsert = this.db.prepare(
        `INSERT INTO terms (term_key, name, kind, wiki, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(term_key) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             wiki = COALESCE(excluded.wiki, terms.wiki),
             status = CASE WHEN terms.status = 'unknown' AND excluded.wiki IS NOT NULL AND excluded.wiki <> terms.wiki
                           THEN 'pending' ELSE terms.status END,
             updated_at = excluded.updated_at`,
      );
      const idOf = this.db.prepare('SELECT id FROM terms WHERE term_key = ?');
      for (const t of terms) {
        const key = termKey(t.name);
        if (!key) continue;
        upsert.run(key, t.name, t.kind, t.wiki, now, now);
        const row = idOf.get(key) as { id: number } | undefined;
        if (!row) continue;
        this.db
          .prepare(
            `INSERT INTO story_terms (story_id, term_id, role, sources, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(story_id, term_id) DO UPDATE SET role = excluded.role, sources = excluded.sources`,
          )
          .run(storyId, row.id, t.role, JSON.stringify(t.sources), now);
      }
    })();
  }

  /** Give a term its explanation. */
  explainTerm(
    key: string,
    explanation: { summary: string | null; description: string | null; sourceName: string | null; sourceUrl: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE terms SET summary = ?, description = ?, source_name = ?, source_url = ?, status = 'explained', updated_at = ?
           WHERE term_key = ?`,
      )
      .run(explanation.summary, explanation.description, explanation.sourceName, explanation.sourceUrl, this.now(), key);
  }

  /** A term nothing could explain: it is kept, but it has nothing to say yet. */
  markTermUnknown(key: string): void {
    this.db.prepare("UPDATE terms SET status = 'unknown', updated_at = ? WHERE term_key = ?").run(this.now(), key);
  }

  /** The terms of a story, with what the glossary knows about them. */
  termsOf(storyId: number): StoryTerm[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.term_key AS key, t.name, t.kind, t.wiki, t.summary, t.description,
                t.source_name AS sourceName, t.source_url AS sourceUrl, t.status,
                t.created_at AS createdAt, t.updated_at AS updatedAt, st.role, st.sources
           FROM story_terms st JOIN terms t ON t.id = st.term_id
           WHERE st.story_id = ? ORDER BY t.name`,
      )
      .all(storyId) as (Omit<StoryTerm, 'sources'> & { sources: string })[];
    return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources) }));
  }

  /** One term of the glossary. */
  termByKey(key: string): TermRecord | null {
    const r = this.db
      .prepare(
        `SELECT id, term_key AS key, name, kind, wiki, summary, description, source_name AS sourceName,
                source_url AS sourceUrl, status, created_at AS createdAt, updated_at AS updatedAt
           FROM terms WHERE term_key = ?`,
      )
      .get(key) as TermRecord | undefined;
    return r ?? null;
  }

  /** Every term Mimir can explain: the ones the reader may tap in a brief or an article. */
  glossary(): TermRecord[] {
    return this.db
      .prepare(
        `SELECT id, term_key AS key, name, kind, wiki, summary, description, source_name AS sourceName,
                source_url AS sourceUrl, status, created_at AS createdAt, updated_at AS updatedAt
           FROM terms WHERE status = 'explained' ORDER BY name`,
      )
      .all() as TermRecord[];
  }

  /** The glossary, with the number of stories that name each term. */
  glossaryWithUse(): (TermRecord & { stories: number })[] {
    return this.db
      .prepare(
        `SELECT t.id, t.term_key AS key, t.name, t.kind, t.wiki, t.summary, t.description,
                t.source_name AS sourceName, t.source_url AS sourceUrl, t.status,
                t.created_at AS createdAt, t.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM story_terms st WHERE st.term_id = t.id) AS stories
           FROM terms t WHERE t.status = 'explained' ORDER BY t.kind, t.name`,
      )
      .all() as (TermRecord & { stories: number })[];
  }

  /** The kinds of term the glossary holds, for the reader who wants to browse it. */
  glossaryKinds(): { kind: TermKind; count: number }[] {
    return this.db
      .prepare('SELECT kind, COUNT(*) AS count FROM terms WHERE status = \'explained\' GROUP BY kind ORDER BY count DESC')
      .all() as { kind: TermKind; count: number }[];
  }

  /** A term's status, for the lookup that is still to come. */
  termStatus(key: string): TermStatus | null {
    const r = this.db.prepare('SELECT status FROM terms WHERE term_key = ?').get(key) as { status: TermStatus } | undefined;
    return r?.status ?? null;
  }

  /**
   * Store a validated summary as the next revision, unless the story's membership changed
   * underneath it (merge or split during generation). Returns the summary id, or null.
   */
  saveSummary(
    storyId: number,
    s: { trigger: 'auto' | 'manual'; provider: string; model: string; promptVersion: string; inputHash: string; articles: UsedArticle[];
      content: StorySummaryContent; rawOutput: string; inputTokens: number | null; outputTokens: number | null; durationMs: number },
  ): number | null {
    return this.db.transaction(() => {
      const placeholders = s.articles.map(() => '?').join(',');
      const still = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM story_articles WHERE story_id = ? AND article_id IN (${placeholders})`)
          .get(storyId, ...s.articles.map((a) => a.articleId)) as { n: number }
      ).n;
      if (still !== s.articles.length) return null;
      const revision =
        ((this.db.prepare('SELECT MAX(revision) AS r FROM story_summaries WHERE story_id = ?').get(storyId) as { r: number | null }).r ?? 0) + 1;
      const res = this.db
        .prepare(
          `INSERT INTO story_summaries (story_id, revision, trigger, provider, model, prompt_version, input_hash, articles, content, raw_output,
             input_tokens, output_tokens, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storyId, revision, s.trigger, s.provider, s.model, s.promptVersion, s.inputHash, JSON.stringify(s.articles), JSON.stringify(s.content),
          s.rawOutput, s.inputTokens, s.outputTokens, s.durationMs, this.now(),
        );
      const id = Number(res.lastInsertRowid);
      this.db
        .prepare(
          `UPDATE stories SET summary_id = ?, summary_stale = 0, summary_request = 'idle', summary_error = NULL,
             summary_started_at = NULL WHERE id = ?`,
        )
        .run(id, storyId);
      return id;
    })();
  }

  /** The current summary already reflects this input; clear the stale flag without a new revision. */
  confirmSummary(storyId: number): void {
    this.db
      .prepare(
        `UPDATE stories SET summary_stale = 0, summary_request = 'idle', summary_error = NULL, summary_started_at = NULL WHERE id = ?`,
      )
      .run(storyId);
  }

  setSummaryRequest(storyId: number, state: 'idle' | 'pending' | 'running' | 'failed', error: string | null = null): void {
    // The moment the request was made and the moment the generation started: the story
    // page counts the seconds from them, so the reader can see a brief taking its time.
    this.db
      .prepare(
        `UPDATE stories SET summary_request = ?, summary_error = ?,
           summary_requested_at = CASE WHEN ? = 'pending' THEN ? ELSE summary_requested_at END,
           summary_started_at = CASE WHEN ? = 'running' THEN ? WHEN ? = 'idle' THEN NULL ELSE summary_started_at END
           WHERE id = ?`,
      )
      .run(state, error, state, this.now(), state, this.now(), state, storyId);
  }

  recordAttempt(a: {
    storyId: number; trigger: 'auto' | 'manual'; provider: string; model: string | null; outcome: string; error: string | null;
    summaryId: number | null; inputTokens: number | null; outputTokens: number | null; durationMs: number | null; startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO summary_attempts (story_id, trigger, provider, model, outcome, error, summary_id, input_tokens, output_tokens, duration_ms, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.storyId, a.trigger, a.provider, a.model, a.outcome, a.error, a.summaryId, a.inputTokens, a.outputTokens, a.durationMs, a.startedAt);
  }

  /** Provider calls for automatic summaries since the given time (successful or not). */
  autoAttemptsSince(sinceIso: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM summary_attempts WHERE trigger = 'auto' AND started_at >= ?`).get(sinceIso) as { n: number }
    ).n;
  }

  /** Local rolling cost limit, independent of the summary provider's allowance. */
  automaticSummaryBudget(limit: number): { limit: number; used: number; resumesAt: string | null } {
    const since = iso(new Date(this.clock().getTime() - 86_400_000));
    const used = this.autoAttemptsSince(since);
    const oldest = limit > 0 && used >= limit
      ? this.db.prepare(`SELECT started_at AS startedAt FROM summary_attempts WHERE trigger = 'auto' AND started_at >= ?
          ORDER BY started_at, id LIMIT 1 OFFSET ?`).get(since, used - limit) as { startedAt: string } | undefined
      : undefined;
    return { limit, used, resumesAt: oldest ? iso(new Date(Date.parse(oldest.startedAt) + 86_400_001)) : null };
  }

  // ---- Reading ----------------------------------------------------------------------

  /** WHERE clauses (alias `s`) and parameters for a filter set, or null when nothing can match. */
  private filterClauses(f: StoryFilters): { where: string[]; params: Record<string, unknown> } | null {
    const where = [`s.status = 'active'`];
    const params: Record<string, unknown> = { now: this.now() };
    if (f.q) {
      const fts = toFtsQuery(f.q);
      if (!fts) return null;
      where.push(`s.id IN (SELECT sa.story_id FROM articles_fts JOIN story_articles sa ON sa.article_id = articles_fts.rowid WHERE articles_fts MATCH @fts)`);
      params.fts = fts;
    }
    if (f.category) {
      where.push(`EXISTS (SELECT 1 FROM json_each(s.categories) j WHERE json_extract(j.value, '$.id') = @category)`);
      params.category = f.category;
    }
    if (f.minRelevance != null) {
      where.push('s.personal_relevance >= @minRel');
      params.minRel = f.minRelevance;
    }
    if (f.minSignificance != null) {
      where.push('s.significance >= @minSig');
      params.minSig = f.minSignificance;
    }
    if (f.minPublishers != null) {
      where.push('s.publisher_count >= @minPub');
      params.minPub = f.minPublishers;
    }
    if (f.days != null) {
      where.push('s.latest_published_at >= @since');
      params.since = iso(new Date(this.clock().getTime() - f.days * 86_400_000));
    }
    if (f.state === 'new') {
      where.push('s.development_count = 1 AND s.first_published_at >= @dayAgo');
      params.dayAgo = iso(new Date(this.clock().getTime() - 86_400_000));
    } else if (f.state === 'developing') {
      where.push('s.development_count > 1 AND s.latest_development_at >= @twoDaysAgo');
      params.twoDaysAgo = iso(new Date(this.clock().getTime() - 2 * 86_400_000));
    }
    if (f.seen === 'unseen') where.push(UNSEEN_SQL);
    else if (f.seen === 'seen') where.push(`NOT ${UNSEEN_SQL}`);
    if (f.saved === 'saved') where.push('s.saved_at IS NOT NULL');
    else if (f.saved === 'unsaved') where.push('s.saved_at IS NULL');
    switch (f.summary) {
      case 'ready':
        where.push(`s.summary_id IS NOT NULL AND s.summary_stale = 0 AND s.summary_request = 'idle'`);
        break;
      case 'stale':
        where.push(`s.summary_id IS NOT NULL AND s.summary_stale = 1`);
        break;
      case 'none':
        where.push(`s.summary_id IS NULL AND s.summary_request = 'idle'`);
        break;
      case 'pending':
        where.push(`s.summary_request IN ('pending', 'running')`);
        break;
      case 'failed':
        where.push(`s.summary_request = 'failed'`);
        break;
    }
    return { where, params };
  }

  list(f: StoryFilters): { items: StoryListItem[]; total: number; page: number; pageSize: number } {
    const clauses = this.filterClauses(f);
    if (!clauses) return { items: [], total: 0, page: 1, pageSize: f.pageSize ?? 30 };
    const { where, params } = clauses;
    const order = {
      priority: `priority IS NULL, priority DESC, s.latest_development_at DESC`,
      relevance: 's.personal_relevance IS NULL, s.personal_relevance DESC, s.latest_development_at DESC',
      significance: 's.significance IS NULL, s.significance DESC, s.latest_development_at DESC',
      urgency: 's.urgency IS NULL, s.urgency DESC, s.latest_development_at DESC',
      latest: 's.latest_development_at DESC, s.id DESC',
      newest: 's.first_published_at DESC, s.id DESC',
      coverage: 's.publisher_count DESC, s.article_count DESC, s.latest_development_at DESC',
    }[f.sort ?? 'priority'];
    const pageSize = Math.min(Math.max(f.pageSize ?? 30, 1), 200);
    const page = Math.max(f.page ?? 1, 1);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM stories s ${whereSql}`).get(params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT ${STORY_COLUMNS} ${STORY_FROM} ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as StoryRow[];
    return { items: this.withPublishers(rows.map(toListItem)), total, page, pageSize };
  }

  private withPublishers(items: StoryListItem[]): StoryListItem[] {
    if (!items.length) return items;
    const rows = this.db
      .prepare(
        `SELECT sa.story_id AS storyId, sa.publisher, COUNT(*) AS articles, MIN(sa.occurred_at) AS firstAt, MAX(sa.occurred_at) AS latestAt,
           (SELECT sa2.article_id FROM story_articles sa2 WHERE sa2.story_id = sa.story_id AND sa2.publisher = sa.publisher
            ORDER BY sa2.occurred_at, sa2.article_id LIMIT 1) AS articleId
         FROM story_articles sa WHERE sa.story_id IN (${items.map(() => '?').join(',')}) GROUP BY sa.story_id, sa.publisher`,
      )
      .all(...items.map((i) => i.id)) as (Omit<StoryPublisher, 'origin'> & { storyId: number })[];
    const byStory = new Map<number, StoryPublisher[]>();
    for (const { storyId, ...p } of rows) byStory.set(storyId, [...(byStory.get(storyId) ?? []), { ...p, origin: false }]);
    for (const list of byStory.values()) {
      const first = list.reduce((a, b) => (b.firstAt < a.firstAt || (b.firstAt === a.firstAt && b.articleId < a.articleId) ? b : a));
      first.origin = true;
      list.sort((a, b) => Number(b.origin) - Number(a.origin) || (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : a.publisher.localeCompare(b.publisher)));
    }
    return items.map((i) => ({ ...i, publishers: byStory.get(i.id) ?? [] }));
  }

  /**
   * Record the reader's relevance judgment for a story, with the assessment they saw, and update the
   * story's current label. Returns false if the story does not exist or was merged away.
   */
  recordRelevance(id: number, type: StoryRelevanceEvent, context: Record<string, unknown> = {}, actor = 'user'): boolean {
    return this.db.transaction(() => {
      const now = this.now();
      const s = this.db
        .prepare(
          `SELECT s.assessment_id AS assessmentId, sa.profile_version AS profileVersion, s.personal_relevance AS relevance, s.significance, s.urgency,
             ${priorityExpr('s')} AS priority, s.article_count AS articleCount, s.publisher_count AS publisherCount, s.development_count AS developmentCount
           FROM stories s LEFT JOIN story_assessments sa ON sa.id = s.assessment_id WHERE s.id = @id AND s.status = 'active'`,
        )
        .get({ id, now }) as Record<string, number | null> | undefined;
      if (!s) return false;
      this.db
        .prepare(
          `INSERT INTO story_feedback_events (story_id, event_type, assessment_id, profile_version, personal_relevance, significance, urgency, priority,
             article_count, publisher_count, development_count, context, actor, created_at)
           VALUES (@id, @type, @assessmentId, @profileVersion, @relevance, @significance, @urgency, @priority, @articleCount, @publisherCount, @developmentCount,
             @context, @actor, @now)`,
        )
        .run({ ...s, id, type, context: JSON.stringify(context), actor, now });
      this.db
        .prepare(`UPDATE stories SET relevance_label = @label, relevance_labeled_at = @labeledAt WHERE id = @id`)
        .run({ id, label: type === 'clear_relevance' ? null : type, labeledAt: type === 'clear_relevance' ? null : now });
      return true;
    })();
  }

  /** Mark a story seen as of its current latest development. Returns false if it does not exist. */
  markSeen(id: number): boolean {
    return (
      this.db
        .prepare(`UPDATE stories SET seen_at = ?, seen_development_at = latest_development_at WHERE id = ? AND status = 'active'`)
        .run(this.now(), id).changes > 0
    );
  }

  markUnseen(id: number): boolean {
    return this.db.prepare(`UPDATE stories SET seen_at = NULL, seen_development_at = NULL WHERE id = ? AND status = 'active'`).run(id).changes > 0;
  }

  /** Keep the story with the reader. Returns false if it does not exist. */
  markSaved(id: number): boolean {
    return this.db.prepare(`UPDATE stories SET saved_at = ? WHERE id = ? AND status = 'active'`).run(this.now(), id).changes > 0;
  }

  /** Let the story go again. Returns false if it does not exist. */
  markUnsaved(id: number): boolean {
    return this.db.prepare(`UPDATE stories SET saved_at = NULL WHERE id = ? AND status = 'active'`).run(id).changes > 0;
  }

  /** Mark every unseen story matching the filters (all pages) as seen. Returns how many changed. */
  markSeenMatching(f: StoryFilters): number {
    const clauses = this.filterClauses({ ...f, seen: 'unseen' });
    if (!clauses) return 0;
    const now = this.now();
    return this.db
      .prepare(
        `UPDATE stories SET seen_at = @markNow, seen_development_at = latest_development_at
         WHERE id IN (SELECT s.id FROM stories s WHERE ${clauses.where.join(' AND ')})`,
      )
      .run({ ...clauses.params, markNow: now }).changes;
  }

  item(id: number): StoryListItem | null {
    const row = this.db.prepare(`SELECT ${STORY_COLUMNS} ${STORY_FROM} WHERE s.id = @id`).get({ id, now: this.now() }) as StoryRow | undefined;
    return row ? this.withPublishers([toListItem(row)])[0]! : null;
  }

  /** Align story summary request states with the job queue after a restart or lost job. */
  reconcileSummaryRequests(kind: string): number {
    const active = `SELECT 1 FROM jobs j WHERE j.kind = '${kind}' AND j.status IN ('pending', 'running')
                    AND json_extract(j.payload, '$.storyId') = stories.id`;
    const a = this.db.prepare(`UPDATE stories SET summary_request = 'pending' WHERE summary_request IN ('running', 'failed') AND EXISTS (${active} AND j.status = 'pending')`).run().changes;
    const b = this.db
      .prepare(
        `UPDATE stories SET summary_request = 'idle', summary_started_at = NULL
         WHERE summary_request IN ('pending', 'running') AND NOT EXISTS (${active})`,
      )
      .run().changes;
    return a + b;
  }

  get(id: number): StoryDetail | null {
    const row = this.db.prepare(`SELECT ${STORY_COLUMNS} ${STORY_FROM} WHERE s.id = @id`).get({ id, now: this.now() }) as StoryRow | undefined;
    if (!row) return null;
    const memberRows = (
      this.db
        .prepare(
          `SELECT a.id AS articleId, a.title, a.url, COALESCE(src.name, e.source_name) AS sourceName, a.summary_text AS summaryText,
             a.published_at AS publishedAt, a.discovered_at AS discoveredAt, sa.occurred_at AS occurredAt, sa.role, sa.assigned_by AS assignedBy,
             sa.publisher, a.content_quality AS contentQuality, sa.match_id AS matchId, m.method AS matchMethod, m.model AS matchModel,
             m.candidates AS candidatesJson, st.classification_status AS classificationStatus, st.rank_score AS rankScore,
             c.personal_relevance AS personalRelevance, c.significance, c.urgency, c.promotional,
             st.relevance_label AS relevanceLabel, st.preference, st.saved_at AS savedAt
           FROM story_articles sa JOIN articles a ON a.id = sa.article_id
           JOIN article_state st ON st.article_id = a.id
           LEFT JOIN classifications c ON c.id = st.current_classification_id
           LEFT JOIN sources src ON src.id = a.source_id
           LEFT JOIN article_entries e ON e.id = (SELECT MIN(id) FROM article_entries WHERE article_id = a.id)
           LEFT JOIN story_matches m ON m.id = sa.match_id
           WHERE sa.story_id = ? ORDER BY sa.occurred_at, a.id`,
        )
        .all(id) as (Omit<StoryMember, 'matchCandidates' | 'provenance'> & { candidatesJson: string | null })[]
    );
    const provenance = articleProvenance(this.db, memberRows.map((m) => m.articleId));
    const members = memberRows.map(({ candidatesJson, ...m }) => ({ ...m,
      matchCandidates: candidatesJson ? JSON.parse(candidatesJson) : null,
      provenance: provenance.get(m.articleId) ?? [],
    }));
    const developments = this.db
      .prepare(
        `SELECT d.id, d.article_id AS articleId, d.kind, d.occurred_at AS occurredAt, d.detected_at AS detectedAt, a.title,
           COALESCE(src.name, sa.publisher) AS sourceName
         FROM story_developments d JOIN articles a ON a.id = d.article_id
         LEFT JOIN sources src ON src.id = a.source_id LEFT JOIN story_articles sa ON sa.article_id = d.article_id
         WHERE d.story_id = ? ORDER BY d.occurred_at, d.id`,
      )
      .all(id) as StoryDevelopment[];
    const events = (
      this.db
        .prepare('SELECT id, event_type AS eventType, details, created_at AS createdAt FROM story_events WHERE story_id = ? ORDER BY created_at DESC, id DESC')
        .all(id) as { id: number; eventType: string; details: string; createdAt: string }[]
    ).map((e) => ({ ...e, details: JSON.parse(e.details) }));
    const assessments = (
      this.db.prepare('SELECT * FROM story_assessments WHERE story_id = ? ORDER BY id DESC LIMIT 20').all(id) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      formula: r.formula as string,
      profileVersion: r.profile_version as number,
      personalRelevance: r.personal_relevance as number | null,
      significance: r.significance as number | null,
      urgency: r.urgency as number | null,
      coverage: r.coverage as number,
      priorityStatic: r.priority_static as number | null,
      recencyWeight: r.recency_weight as number,
      recencyHalfLifeHours: r.recency_half_life_hours as number,
      categories: JSON.parse(r.categories as string),
      evidence: JSON.parse(r.evidence as string),
      createdAt: r.created_at as string,
    }));
    const summaryRevisions = (
      this.db
        .prepare('SELECT id, revision, trigger, model, created_at AS createdAt, articles FROM story_summaries WHERE story_id = ? ORDER BY revision DESC')
        .all(id) as (StoryDetail['summaryRevisions'][number] & { articles: string })[]
    ).map((r) => ({
      ...r,
      articleIds: (JSON.parse(r.articles) as { articleId: number }[]).map((a) => a.articleId),
    }));
    const placeState = this.placesState(id);
    const termState = this.termsState(id);
    const times = this.db
      .prepare('SELECT summary_requested_at AS requestedAt, summary_started_at AS startedAt FROM stories WHERE id = ?')
      .get(id) as { requestedAt: string | null; startedAt: string | null } | undefined;
    return {
      ...this.withPublishers([toListItem(row)])[0]!,
      members,
      developments,
      events,
      assessments,
      summary: this.currentSummary(id),
      summaryRevisions,
      summaryRequestedAt: times?.requestedAt ?? null,
      summaryStartedAt: times?.startedAt ?? null,
      placesState: placeState.state,
      placesError: placeState.error,
      places: this.places(id),
      termsState: termState.state,
      termsError: termState.error,
      terms: this.termsOf(id),
    };
  }

  /** Stories that may be about the same event, for merge suggestions. */
  similarStories(storyId: number, limit = 6): (Candidate & { headline: string; articleCount: number })[] {
    const lead = this.db.prepare('SELECT lead_article_id AS id FROM stories WHERE id = ?').get(storyId) as { id: number | null } | undefined;
    const article = lead?.id ? this.articleForMatching(lead.id) : null;
    if (!article) return [];
    return this.candidates(article, { windowDays: 14, limit, excludeStoryId: storyId }).map((c) => {
      const s = this.db.prepare('SELECT headline, article_count AS articleCount FROM stories WHERE id = ?').get(c.storyId) as { headline: string; articleCount: number };
      return { ...c, ...s };
    });
  }

  /** Articles not yet in a story and without a pending matching job (backfill, lost jobs). Oldest first. */
  unassignedWithoutJob(kind: string, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT a.id FROM articles a
           WHERE NOT EXISTS (SELECT 1 FROM story_articles sa WHERE sa.article_id = a.id)
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = ? AND j.status IN ('pending', 'running') AND j.dedupe_key = 'article:' || a.id)
           ORDER BY COALESCE(a.published_at, a.discovered_at), a.id LIMIT ?`,
        )
        .all(kind, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  counts(): { active: number; merged: number; multiArticle: number; unassigned: number; summaries: Record<SummaryState, number> } {
    const c = this.db
      .prepare(
        `SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'merged'), 0) AS merged,
           COALESCE(SUM(status = 'active' AND article_count > 1), 0) AS multiArticle FROM stories`,
      )
      .get() as { active: number; merged: number; multiArticle: number };
    const unassigned = (
      this.db.prepare('SELECT COUNT(*) AS n FROM articles a WHERE NOT EXISTS (SELECT 1 FROM story_articles sa WHERE sa.article_id = a.id)').get() as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN summary_request <> 'idle' THEN summary_request WHEN summary_id IS NULL THEN 'none'
                     WHEN summary_stale = 1 THEN 'stale' ELSE 'ready' END AS state, COUNT(*) AS n
         FROM stories WHERE status = 'active' GROUP BY state`,
      )
      .all() as { state: SummaryState; n: number }[];
    const summaries = { none: 0, pending: 0, running: 0, ready: 0, stale: 0, failed: 0 } as Record<SummaryState, number>;
    for (const r of rows) summaries[r.state] = r.n;
    return { ...c, unassigned, summaries };
  }

  summaryUsage(days: number): { provider: string; model: string | null; trigger: string; outcome: string; count: number; inputTokens: number; outputTokens: number; avgMs: number | null }[] {
    return this.db
      .prepare(
        `SELECT provider, model, trigger, outcome, COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens, AVG(duration_ms) AS avgMs
         FROM summary_attempts WHERE started_at >= ? GROUP BY provider, model, trigger, outcome ORDER BY count DESC`,
      )
      .all(iso(new Date(this.clock().getTime() - days * 86_400_000))) as ReturnType<StoryRepository['summaryUsage']>;
  }

  matchUsage(days: number): { method: string; outcome: string; count: number; inputTokens: number; avgMs: number | null }[] {
    return this.db
      .prepare(
        `SELECT method, outcome, COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS inputTokens, AVG(duration_ms) AS avgMs
         FROM story_matches WHERE created_at >= ? GROUP BY method, outcome ORDER BY count DESC`,
      )
      .all(iso(new Date(this.clock().getTime() - days * 86_400_000))) as ReturnType<StoryRepository['matchUsage']>;
  }

  /** Story membership of an article, for the article page. */
  forArticle(articleId: number): { storyId: number; headline: string; role: StoryRole; articleCount: number } | null {
    return (
      (this.db
        .prepare(
          `SELECT s.id AS storyId, s.headline, sa.role, s.article_count AS articleCount
           FROM story_articles sa JOIN stories s ON s.id = sa.story_id WHERE sa.article_id = ?`,
        )
        .get(articleId) as { storyId: number; headline: string; role: StoryRole; articleCount: number } | undefined) ?? null
    );
  }
}

function toSummary(r: Record<string, unknown>): StorySummaryRecord {
  const content = parseStoredContent(r.content as string);
  if (!content) throw new Error(`Summary ${r.id} has content that cannot be read`);
  return {
    id: r.id as number,
    storyId: r.story_id as number,
    revision: r.revision as number,
    trigger: r.trigger as 'auto' | 'manual',
    provider: r.provider as string,
    model: r.model as string,
    promptVersion: r.prompt_version as string,
    inputHash: r.input_hash as string,
    articles: JSON.parse(r.articles as string),
    content,
    inputTokens: r.input_tokens as number | null,
    outputTokens: r.output_tokens as number | null,
    durationMs: r.duration_ms as number | null,
    createdAt: r.created_at as string,
  };
}
