import type { DB } from '../db/database.js';
import { contentTerms, titleKey } from './text.js';

/**
 * How close an article is to a story.
 *
 * The score is the share of the article's own terms that the story already covers,
 * weighted by how rare each term is in the corpus. It is a screening number: it decides
 * which stories the matcher is asked about, never what a story is. The replay harness
 * (src/stories/replay.ts) measures how well it does that job.
 *
 * Everything here is pure with respect to one article and one story, so a different
 * scoring rule can be measured against the same recorded decisions.
 */

export interface MatchableArticle {
  title: string | null;
  summaryText: string | null;
}

export interface StoryMemberText {
  articleId?: number;
  title: string | null;
  summaryText: string | null;
}

export interface SimilarityResult {
  similarity: number;
  titleMatch: boolean;
}

/** How many members of a story are read when a story is compared with an article. */
export const MEMBER_TEXT_LIMIT = 15;

/**
 * BM25 inverse document frequency: positive even for terms in every article, so small
 * corpora still match. A term the vocabulary does not know counts as maximally rare.
 */
export function idfFor(db: DB, terms: string[]): Map<string, number> {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
  const weight = (doc: number) => Math.log(1 + (total - doc + 0.5) / (doc + 0.5));
  const out = new Map<string, number>(terms.map((t) => [t, weight(0)]));
  if (!terms.length) return out;
  const rows = db
    .prepare(`SELECT term, doc FROM articles_fts_vocab WHERE term IN (${terms.map(() => '?').join(',')})`)
    .all(...terms) as { term: string; doc: number }[];
  for (const r of rows) out.set(r.term, weight(r.doc));
  return out;
}

/** The terms of an article: its title, and the first part of its summary. */
export function matchTerms(title: string | null, summary: string | null): string[] {
  return [...new Set([...contentTerms(title), ...contentTerms(summary?.slice(0, 500))])];
}

/**
 * The text of a story's members: the coverage first, then the most recent.
 * Only the first few are read; a story's members are many and their words overlap.
 */
export function storyMemberTexts(db: DB, storyId: number, limit = MEMBER_TEXT_LIMIT): StoryMemberText[] {
  return db
    .prepare(
      `SELECT a.id AS articleId, a.title, a.summary_text AS summaryText FROM story_articles sa JOIN articles a ON a.id = sa.article_id
       WHERE sa.story_id = ? ORDER BY sa.role = 'coverage', sa.occurred_at DESC LIMIT ${limit}`,
    )
    .all(storyId) as StoryMemberText[];
}

/**
 * Score an article against a story.
 *
 * Two numbers are compared and the better one wins: the share of the article's terms
 * that the story covers, and the share of the article's title terms that the story
 * covers. Teasers add many terms that dilute overlap, so the title alone is often the
 * better signal. `titleMatch` says something stronger: the same headline, word for word,
 * which is how the same report published twice is recognised.
 */
export function scoreAgainstStory(
  article: MatchableArticle,
  members: StoryMemberText[],
  idf: Map<string, number>,
): SimilarityResult {
  const terms = matchTerms(article.title, article.summaryText);
  if (!terms.length) return { similarity: 0, titleMatch: false };
  const weight = (ts: string[]) => ts.reduce((sum, term) => sum + idf.get(term)!, 0);
  const articleWeight = weight(terms);
  const titleTerms = [...new Set(contentTerms(article.title))];
  const titleWeight = weight(titleTerms);
  const storyTerms = new Set(members.flatMap((m) => matchTerms(m.title, m.summaryText)));
  const shared = (ts: string[]) => weight(ts.filter((term) => storyTerms.has(term)));
  const similarity = Math.max(
    articleWeight > 0 ? shared(terms) / articleWeight : 0,
    titleWeight > 0 ? shared(titleTerms) / titleWeight : 0,
  );
  const key = titleKey(article.title);
  const titleMatch = key.split(' ').length >= 4 && members.some((m) => titleKey(m.title) === key);
  return { similarity, titleMatch };
}

/** A rule that says how close an article is to a story. */
export interface SimilarityScorer {
  readonly name: string;
  score(article: MatchableArticle, members: StoryMemberText[], idf: Map<string, number>): SimilarityResult;
}

/** The score the system has always used: IDF-weighted term overlap. */
export const currentScorer: SimilarityScorer = {
  name: 'idf-overlap/1',
  score: scoreAgainstStory,
};
