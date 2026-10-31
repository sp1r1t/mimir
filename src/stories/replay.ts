/**
 * Replay of recorded matching decisions.
 *
 * Every matching decision the system made is written down: the article, the stories it
 * was compared with, the similarity each one got, and what the matcher then said about
 * them. The corrections the reader made are written down too: a merge says two stories
 * are one story, a split says a story was two.
 *
 * This module reads those records and answers the questions that decide whether a
 * change to the score is an improvement:
 *
 * - Does the score separate what the matcher calls the same story from what it does not?
 * - Does it order the candidates the way the matcher does?
 * - How much work would a lower threshold add, and how much of it is noise?
 * - How much does a story's size distort its score?
 * - Which pairs the reader joined by hand never got near the threshold?
 *
 * Nothing here calls a model. It only reads what was recorded.
 */

import type { DB } from '../db/database.js';
import { titleKey } from './text.js';
import {
  currentScorer,
  idfFor,
  matchTerms,
  scoreAgainstStory,
  storyMemberTexts,
  type SimilarityScorer,
  type StoryMemberText,
} from './similarity.js';

// ---- Recorded decisions -------------------------------------------------------

interface RecordedJudgement {
  score: number;
  level: number;
  confidence: number | null;
  probabilities: Record<string, number>;
}

interface RecordedCandidate {
  storyId: number;
  similarity: number;
  titleMatch: boolean;
  same?: RecordedJudgement;
  update?: RecordedJudgement;
}

interface RecordedMatch {
  id: number;
  articleId: number;
  storyId: number | null;
  outcome: string;
  role: string;
  method: string;
  candidates: RecordedCandidate[];
}

interface ArticleRow {
  id: number;
  title: string | null;
  summaryText: string | null;
}

interface StoryRow {
  id: number;
  headline: string;
  status: string;
  articleCount: number;
}

// ---- The report ---------------------------------------------------------------

export interface GateSweepRow {
  threshold: number;
  admitted: number;
  judged: number;
  sameStory: number;
  differentStory: number;
  /** Matched by the headline rule; the matcher was never asked about them. */
  titleMatched: number;
  /** Below the threshold: the matcher was never asked about them. */
  screenedOut: number;
  /** Of the pairs that were judged, how many the matcher called the same story. */
  precision: number | null;
}

export interface ReplayReport {
  generatedAt: string;
  scorer: string;
  inventory: {
    articles: number;
    stories: number;
    activeStories: number;
    matches: number;
    byMethod: Record<string, number>;
    byOutcome: Record<string, number>;
    candidatePairs: number;
    judgedPairs: number;
    titleMatchedPairs: number;
    screenedOutPairs: number;
    sameStoryPairs: number;
    differentStoryPairs: number;
    /** The lowest similarity the matcher was asked about, and the highest it was not. */
    lowestJudged: number;
    highestScreenedOut: number;
  };
  gate: {
    effectiveThreshold: number;
    judgedSameStory: number;
    judgedDifferentStory: number;
    /** Of the candidates the score let through, how many the matcher rejected. */
    precisionAtThreshold: number | null;
    sweep: GateSweepRow[];
  };
  separation: {
    /** How well the score ranks same-story pairs above different-story pairs. */
    auc: number | null;
    /** The same measure for the matcher's own confidence; a check on the data. */
    aucOfMatcherProbability: number | null;
    meanSameStory: number | null;
    meanDifferentStory: number | null;
    medianSameStory: number | null;
    medianDifferentStory: number | null;
  };
  ranking: {
    decisions: number;
    /** The accepted story was the first candidate by similarity. */
    acceptedFirst: number;
    acceptedLater: number;
    acceptedMissing: number;
    /** Decisions in which the matcher found a story it called the same story. */
    decisionsWithAPick: number;
    /** The matcher and the score chose the same candidate. */
    matcherAgreesWithTopScore: number;
    examples: { articleId: number; acceptedStoryId: number; acceptedRank: number; topStoryId: number }[];
  };
  nearMiss: {
    bands: { from: number; to: number; pairs: number; articles: number; stories: number }[];
    /** A candidate just under the line while the article went to another story. */
    pairsLostToAnotherStory: number;
    /** The pairs a judge could be asked about, cheapest first, to learn the truth. */
    worthJudging: { articleId: number; storyId: number; similarity: number; title: string | null; headline: string }[];
  };
  sizeBias: {
    buckets: { size: string; pairs: number; sameStory: number; differentStory: number; meanSame: number | null; meanDifferent: number | null }[];
    correlationWithStorySize: number | null;
  };
  textBias: {
    buckets: { text: string; pairs: number; sameStory: number; differentStory: number; meanSame: number | null; meanDifferent: number | null }[];
    /** How much of the score is decided by how much text the article carries. */
    correlationWithTermCount: number | null;
  };
  drift: {
    pairs: number;
    meanAbsoluteChange: number | null;
    correlation: number | null;
    /** Pairs that were above the threshold then and are below it now, or the other way round. */
    thresholdFlips: number;
    largestChanges: { articleId: number; storyId: number; stored: number; recomputed: number }[];
  };
  duplicateHeadlines: {
    /** Articles with the same headline, word for word, in different stories. */
    groups: number;
    pairs: number;
    examples: { title: string; stories: number[]; articles: number }[];
  };
  corrections: {
    merges: { sourceStoryId: number; targetStoryId: number; headline: string; articles: number; bestSimilarityNow: number | null }[];
    splits: { storyId: number; articleIds: number[]; headline: string; bestSimilarityNow: number | null }[];
  };
  abstention: {
    judgedPairs: number;
    /** The matcher was unsure: the same story had a real chance either way. */
    uncertainPairs: number;
    uncertainSameStory: number;
  };
}

// ---- Reading the records ------------------------------------------------------

function loadMatches(db: DB): RecordedMatch[] {
  const rows = db
    .prepare('SELECT id, article_id, story_id, outcome, role, method, candidates FROM story_matches ORDER BY id')
    .all() as {
    id: number;
    article_id: number;
    story_id: number | null;
    outcome: string;
    role: string;
    method: string;
    candidates: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    articleId: r.article_id,
    storyId: r.story_id,
    outcome: r.outcome,
    role: r.role,
    method: r.method,
    candidates: JSON.parse(r.candidates) as RecordedCandidate[],
  }));
}

function loadArticles(db: DB): Map<number, ArticleRow> {
  const rows = db.prepare('SELECT id, title, summary_text AS summaryText FROM articles').all() as ArticleRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function loadStories(db: DB): Map<number, StoryRow> {
  const rows = db
    .prepare('SELECT id, headline, status, article_count AS articleCount FROM stories')
    .all() as StoryRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** The articles that were put in a story, recovered from the decisions that put them there. */
function articlesOfStory(db: DB, storyId: number): number[] {
  const rows = db
    .prepare('SELECT article_id AS articleId FROM story_matches WHERE story_id = ?')
    .all(storyId) as { articleId: number }[];
  const members = db
    .prepare('SELECT article_id AS articleId FROM story_articles WHERE story_id = ?')
    .all(storyId) as { articleId: number }[];
  return [...new Set([...rows.map((r) => r.articleId), ...members.map((r) => r.articleId)])];
}

/** The story that holds a story now: merges move a story's articles onward. */
function resolveStory(db: DB, storyId: number): number {
  let id = storyId;
  for (let i = 0; i < 20; i++) {
    const row = db.prepare('SELECT status, merged_into_id AS target FROM stories WHERE id = ?').get(id) as
      | { status: string; target: number | null }
      | undefined;
    if (!row || row.status !== 'merged' || row.target == null) return id;
    id = row.target;
  }
  return id;
}

// ---- Small measures -----------------------------------------------------------

/** Area under the curve: how often a same-story pair scores above a different-story pair. */
function auc(scores: number[], labels: boolean[]): number | null {
  const order = scores.map((s, i) => ({ s, l: labels[i] })).sort((a, b) => a.s - b.s);
  const ranks = new Array<number>(order.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.s === order[i]!.s) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }
  let rankSum = 0;
  let positives = 0;
  order.forEach((o, k) => {
    if (o.l) {
      rankSum += ranks[k]!;
      positives++;
    }
  });
  const negatives = order.length - positives;
  if (!positives || !negatives) return null;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number | null, digits = 3): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

// ---- The replay ----------------------------------------------------------------

export interface ReplayOptions {
  scorer?: SimilarityScorer;
  /** The threshold the system was configured with, used to place the gate. */
  threshold?: number;
  /** How many near-miss pairs to list as worth judging. */
  nearMissSample?: number;
  /** Below this similarity a candidate is noise rather than a near miss. */
  nearMissFloor?: number;
}

export function runReplay(db: DB, opts: ReplayOptions = {}): ReplayReport {
  const scorer = opts.scorer ?? currentScorer;
  const threshold = opts.threshold ?? 0.3;
  const nearMissSample = opts.nearMissSample ?? 20;
  const nearMissFloor = opts.nearMissFloor ?? 0.15;

  const matches = loadMatches(db);
  const articles = loadArticles(db);
  const stories = loadStories(db);

  // Every candidate pair the system ever weighed, in three kinds: the matcher judged
  // it, the headline rule decided the whole decision, or the score kept it back.
  const pairs: { match: RecordedMatch; candidate: RecordedCandidate }[] = [];
  for (const match of matches) for (const candidate of match.candidates) pairs.push({ match, candidate });

  const judged = pairs.filter((p) => p.candidate.same);
  const headlineDecided = pairs.filter((p) => p.match.method === 'title_match');
  const screenedOut = pairs.filter((p) => p.match.method !== 'title_match' && !p.candidate.same);
  const sameStory = judged.filter((p) => p.candidate.same!.level === 2);
  const differentStory = judged.filter((p) => p.candidate.same!.level !== 2);

  const lowestJudged = judged.length ? Math.min(...judged.map((p) => p.candidate.similarity)) : 0;
  const highestScreenedOut = screenedOut.length ? Math.max(...screenedOut.map((p) => p.candidate.similarity)) : 0;

  // ---- The gate: what the score let through, and what it let in wrongly ----
  const sweep: GateSweepRow[] = [];
  for (let t = 0.05; t <= 0.95001; t += 0.05) {
    const cut = Number(t.toFixed(2));
    const admitted = pairs.filter((p) => p.candidate.similarity >= cut);
    const admittedJudged = admitted.filter((p) => p.candidate.same);
    const admittedHeadline = admitted.filter((p) => p.match.method === 'title_match');
    const s = admittedJudged.filter((p) => p.candidate.same!.level === 2);
    const d = admittedJudged.filter((p) => p.candidate.same!.level !== 2);
    sweep.push({
      threshold: cut,
      admitted: admitted.length,
      judged: admittedJudged.length,
      sameStory: s.length,
      differentStory: d.length,
      titleMatched: admittedHeadline.length,
      screenedOut: admitted.length - admittedJudged.length - admittedHeadline.length,
      precision: admittedJudged.length ? s.length / admittedJudged.length : null,
    });
  }
  const atThreshold = sweep.find((r) => Math.abs(r.threshold - threshold) < 0.026);

  // ---- Separation: does the score tell same-story from different-story? ----
  const aucOfScore = auc(
    judged.map((p) => p.candidate.similarity),
    judged.map((p) => p.candidate.same!.level === 2),
  );
  const aucOfMatcher = auc(
    judged.map((p) => p.candidate.same!.probabilities['2'] ?? 0),
    judged.map((p) => p.candidate.same!.level === 2),
  );

  // ---- Ranking: does the score order candidates the way the matcher does? ----
  const matcherDecisions = matches.filter((m) => m.method === 'matcher' && m.candidates.length > 0);
  const joinedDecisions = matcherDecisions.filter((m) => m.outcome === 'joined' && m.storyId != null);
  let acceptedFirst = 0;
  let acceptedLater = 0;
  let acceptedMissing = 0;
  let agrees = 0;
  let decisionsWithAPick = 0;
  const rankingExamples: ReplayReport['ranking']['examples'] = [];
  for (const match of matcherDecisions) {
    const byScore = [...match.candidates].sort((a, b) => b.similarity - a.similarity);
    const top = byScore[0]!;
    const judgePick = [...match.candidates]
      .filter((c) => c.same && c.same.level === 2)
      .sort((a, b) => b.same!.score - a.same!.score)[0];
    if (!judgePick) continue;
    decisionsWithAPick++;
    if (judgePick.storyId === top.storyId) agrees++;
  }
  for (const match of joinedDecisions) {
    const byScore = [...match.candidates].sort((a, b) => b.similarity - a.similarity);
    const top = byScore[0]!;
    const rank = byScore.findIndex((c) => c.storyId === match.storyId) + 1;
    if (rank === 1) acceptedFirst++;
    else if (rank > 1) acceptedLater++;
    else acceptedMissing++;
    if (rankingExamples.length < 10 && rank !== 1) {
      rankingExamples.push({ articleId: match.articleId, acceptedStoryId: match.storyId!, acceptedRank: rank, topStoryId: top.storyId });
    }
  }

  // ---- Near misses: what the threshold kept out ----
  const bandEdges = [0, 0.1, 0.15, 0.2, 0.25, 0.3];
  const bands = bandEdges.slice(0, -1).map((from, i) => {
    const to = bandEdges[i + 1]!;
    const inBand = screenedOut.filter((p) => p.candidate.similarity >= from && p.candidate.similarity < to);
    return {
      from,
      to,
      pairs: inBand.length,
      articles: new Set(inBand.map((p) => p.match.articleId)).size,
      stories: new Set(inBand.map((p) => p.candidate.storyId)).size,
    };
  });
  const lostToAnotherStory = screenedOut.filter(
    (p) =>
      p.candidate.similarity >= nearMissFloor &&
      p.match.outcome === 'joined' &&
      p.match.storyId != null &&
      p.candidate.storyId !== p.match.storyId,
  );
  const worthJudging = lostToAnotherStory
    .slice()
    .sort((a, b) => b.candidate.similarity - a.candidate.similarity)
    .slice(0, nearMissSample)
    .map((p) => ({
      articleId: p.match.articleId,
      storyId: p.candidate.storyId,
      similarity: p.candidate.similarity,
      title: articles.get(p.match.articleId)?.title ?? null,
      headline: stories.get(p.candidate.storyId)?.headline ?? '(gone)',
    }));

  // ---- Size bias: does a bigger story score higher? ----
  const sizeBuckets: { size: string; min: number; max: number }[] = [
    { size: '1', min: 1, max: 1 },
    { size: '2-3', min: 2, max: 3 },
    { size: '4-7', min: 4, max: 7 },
    { size: '8+', min: 8, max: Number.MAX_SAFE_INTEGER },
  ];
  const sizeRows = sizeBuckets.map((b) => {
    const inBucket = judged.filter((p) => {
      const count = stories.get(p.candidate.storyId)?.articleCount ?? 0;
      return count >= b.min && count <= b.max;
    });
    const s = inBucket.filter((p) => p.candidate.same!.level === 2).map((p) => p.candidate.similarity);
    const d = inBucket.filter((p) => p.candidate.same!.level !== 2).map((p) => p.candidate.similarity);
    return {
      size: b.size,
      pairs: inBucket.length,
      sameStory: s.length,
      differentStory: d.length,
      meanSame: round(mean(s)),
      meanDifferent: round(mean(d)),
    };
  });
  const sizeCounts = judged.map((p) => Math.log(1 + (stories.get(p.candidate.storyId)?.articleCount ?? 0)));

  // ---- Text bias: does the score depend on how much text the article carries? ----
  // A title alone gives few terms, so the score of a textless article and the score of
  // a full article are not the same measure even when both are about the same story.
  const termCounts = new Map<number, number>();
  const summaryWords = new Map<number, number>();
  for (const p of judged) {
    if (termCounts.has(p.match.articleId)) continue;
    const article = articles.get(p.match.articleId);
    const terms = matchTerms(article?.title ?? null, article?.summaryText ?? null);
    termCounts.set(p.match.articleId, terms.length);
    summaryWords.set(p.match.articleId, (article?.summaryText ?? '').split(/\s+/).filter(Boolean).length);
  }
  const textBuckets: { text: string; min: number; max: number }[] = [
    { text: 'no summary', min: 0, max: 0 },
    { text: 'short summary', min: 1, max: 40 },
    { text: 'long summary', min: 41, max: Number.MAX_SAFE_INTEGER },
  ];
  const textRows = textBuckets.map((b) => {
    const inBucket = judged.filter((p) => {
      const words = summaryWords.get(p.match.articleId) ?? 0;
      return words >= b.min && words <= b.max;
    });
    const s = inBucket.filter((p) => p.candidate.same!.level === 2).map((p) => p.candidate.similarity);
    const d = inBucket.filter((p) => p.candidate.same!.level !== 2).map((p) => p.candidate.similarity);
    return {
      text: b.text,
      pairs: inBucket.length,
      sameStory: s.length,
      differentStory: d.length,
      meanSame: round(mean(s)),
      meanDifferent: round(mean(d)),
    };
  });

  // ---- Drift: the score against the stories as they are now ----
  const idfCache = new Map<number, Map<string, number>>();
  const memberCache = new Map<number, StoryMemberText[]>();
  const recomputed: { articleId: number; storyId: number; stored: number; now: number }[] = [];
  for (const p of pairs) {
    const article = articles.get(p.match.articleId);
    const story = stories.get(p.candidate.storyId);
    if (!article || !story || story.status !== 'active') continue;
    const terms = matchTerms(article.title, article.summaryText);
    if (!terms.length) continue;
    let idf = idfCache.get(article.id);
    if (!idf) {
      idf = idfFor(db, terms);
      idfCache.set(article.id, idf);
    }
    let members = memberCache.get(story.id);
    if (!members) {
      members = storyMemberTexts(db, story.id);
      memberCache.set(story.id, members);
    }
    const now = scorer.score(article, members, idf).similarity;
    recomputed.push({ articleId: article.id, storyId: story.id, stored: p.candidate.similarity, now });
  }
  const driftDiffs = recomputed.map((r) => Math.abs(r.now - r.stored));
  const driftFlips = recomputed.filter((r) => (r.stored >= threshold) !== (r.now >= threshold)).length;
  const largestChanges = recomputed
    .slice()
    .sort((a, b) => Math.abs(b.now - b.stored) - Math.abs(a.now - a.stored))
    .slice(0, 10)
    .map((r) => ({ articleId: r.articleId, storyId: r.storyId, stored: round(r.stored)!, recomputed: round(r.now)! }));

  // ---- Duplicate headlines: the same report twice, in different stories ----
  const byFingerprint = new Map<string, { articleId: number; storyId: number; title: string }[]>();
  const membership = db.prepare('SELECT article_id AS articleId, story_id AS storyId FROM story_articles').all() as {
    articleId: number;
    storyId: number;
  }[];
  for (const row of membership) {
    const article = articles.get(row.articleId);
    if (!article) continue;
    const key = titleKey(article.title);
    if (key.split(' ').length < 4) continue;
    const list = byFingerprint.get(key) ?? [];
    list.push({ articleId: row.articleId, storyId: row.storyId, title: article.title ?? '' });
    byFingerprint.set(key, list);
  }
  const duplicateGroups = [...byFingerprint.values()].filter((group) => new Set(group.map((g) => g.storyId)).size > 1);
  const duplicatePairs = duplicateGroups.reduce((sum, group) => {
    const storyCount = new Set(group.map((g) => g.storyId)).size;
    return sum + (storyCount * (storyCount - 1)) / 2;
  }, 0);

  // ---- Corrections: what the reader decided ----
  const eventRows = db
    .prepare("SELECT story_id, event_type, details FROM story_events WHERE event_type IN ('merged_into', 'split_out') ORDER BY id")
    .all() as { story_id: number; event_type: string; details: string }[];
  const merges: ReplayReport['corrections']['merges'] = [];
  const splits: ReplayReport['corrections']['splits'] = [];
  for (const row of eventRows) {
    const details = JSON.parse(row.details) as { storyId?: number; articleIds?: number[] };
    if (row.event_type === 'merged_into' && details.storyId != null) {
      const source = stories.get(row.story_id);
      const sourceArticles = articlesOfStory(db, row.story_id);
      merges.push({
        sourceStoryId: row.story_id,
        targetStoryId: details.storyId,
        headline: source?.headline ?? '(gone)',
        articles: sourceArticles.length,
        bestSimilarityNow: bestSimilarityBetween(db, articles, sourceArticles, details.storyId, scorer),
      });
      continue;
    }
    const story = stories.get(row.story_id);
    const articleIds = details.articleIds ?? [];
    splits.push({
      storyId: row.story_id,
      articleIds,
      headline: story?.headline ?? '(gone)',
      bestSimilarityNow: bestSimilarityBetween(db, articles, articleIds, row.story_id, scorer),
    });
  }

  // ---- Abstention: how often the matcher was unsure ----
  const uncertain = judged.filter((p) => {
    const p2 = p.candidate.same!.probabilities['2'];
    return typeof p2 === 'number' && p2 >= 0.25 && p2 <= 0.75;
  });

  const byMethod: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const match of matches) {
    byMethod[match.method] = (byMethod[match.method] ?? 0) + 1;
    byOutcome[match.outcome] = (byOutcome[match.outcome] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    scorer: scorer.name,
    inventory: {
      articles: articles.size,
      stories: stories.size,
      activeStories: [...stories.values()].filter((s) => s.status === 'active').length,
      matches: matches.length,
      byMethod,
      byOutcome,
      candidatePairs: pairs.length,
      judgedPairs: judged.length,
      titleMatchedPairs: headlineDecided.length,
      screenedOutPairs: screenedOut.length,
      sameStoryPairs: sameStory.length,
      differentStoryPairs: differentStory.length,
      lowestJudged: round(lowestJudged)!,
      highestScreenedOut: round(highestScreenedOut)!,
    },
    gate: {
      effectiveThreshold: threshold,
      judgedSameStory: sameStory.length,
      judgedDifferentStory: differentStory.length,
      precisionAtThreshold: atThreshold?.precision ?? null,
      sweep,
    },
    separation: {
      auc: round(aucOfScore),
      aucOfMatcherProbability: round(aucOfMatcher),
      meanSameStory: round(mean(sameStory.map((p) => p.candidate.similarity))),
      meanDifferentStory: round(mean(differentStory.map((p) => p.candidate.similarity))),
      medianSameStory: round(median(sameStory.map((p) => p.candidate.similarity))),
      medianDifferentStory: round(median(differentStory.map((p) => p.candidate.similarity))),
    },
    ranking: {
      decisions: joinedDecisions.length,
      acceptedFirst,
      acceptedLater,
      acceptedMissing,
      decisionsWithAPick,
      matcherAgreesWithTopScore: agrees,
      examples: rankingExamples,
    },
    nearMiss: {
      bands,
      pairsLostToAnotherStory: lostToAnotherStory.length,
      worthJudging,
    },
    sizeBias: {
      buckets: sizeRows,
      correlationWithStorySize: round(pearson(judged.map((p) => p.candidate.similarity), sizeCounts)),
    },
    textBias: {
      buckets: textRows,
      correlationWithTermCount: round(
        pearson(judged.map((p) => p.candidate.similarity), judged.map((p) => termCounts.get(p.match.articleId) ?? 0)),
      ),
    },
    drift: {
      pairs: recomputed.length,
      meanAbsoluteChange: round(mean(driftDiffs)),
      correlation: round(pearson(recomputed.map((r) => r.stored), recomputed.map((r) => r.now))),
      thresholdFlips: driftFlips,
      largestChanges,
    },
    duplicateHeadlines: {
      groups: duplicateGroups.length,
      pairs: duplicatePairs,
      examples: duplicateGroups.slice(0, 10).map((group) => ({
        title: group[0]!.title,
        stories: [...new Set(group.map((g) => g.storyId))],
        articles: group.length,
      })),
    },
    corrections: { merges, splits },
    abstention: {
      judgedPairs: judged.length,
      uncertainPairs: uncertain.length,
      uncertainSameStory: uncertain.filter((p) => p.candidate.same!.level === 2).length,
    },
  };
}

/**
 * The highest score the current rule would give between a set of articles and a story:
 * the best of those articles against the members of the story. Used to show what a
 * reader's own correction looks like to the score.
 */
function bestSimilarityBetween(
  db: DB,
  articles: Map<number, ArticleRow>,
  articleIds: number[],
  targetStoryId: number,
  scorer: SimilarityScorer,
): number | null {
  const target = resolveStory(db, targetStoryId);
  // The articles that were moved are in the target now; measuring against them would
  // score the story against itself.
  const members = storyMemberTexts(db, target).filter((m) => !articleIds.includes(m.articleId ?? -1));
  if (!members.length) return null;
  let best: number | null = null;
  for (const articleId of articleIds) {
    const article = articles.get(articleId);
    if (!article) continue;
    const terms = matchTerms(article.title, article.summaryText);
    if (!terms.length) continue;
    const idf = idfFor(db, terms);
    const score = scorer.score(article, members, idf).similarity;
    if (best === null || score > best) best = score;
  }
  return round(best);
}

// ---- Reading the report --------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function num(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

/** The report as text, for a terminal. */
export function formatReport(report: ReplayReport): string {
  const lines: string[] = [];
  const inv = report.inventory;
  lines.push(`Story matching replay — ${report.generatedAt}`);
  lines.push(`Scorer: ${report.scorer}`);
  lines.push('');
  lines.push('What was recorded');
  lines.push(
    `  ${inv.articles} articles, ${inv.stories} stories (${inv.activeStories} active), ${inv.matches} matching decisions`,
  );
  lines.push(`  by method: ${Object.entries(inv.byMethod).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(`  by outcome: ${Object.entries(inv.byOutcome).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(
    `  ${inv.candidatePairs} candidate pairs: ${inv.judgedPairs} judged by the matcher, ${inv.titleMatchedPairs} settled by the headline rule, ${inv.screenedOutPairs} kept back by the threshold`,
  );
  lines.push(
    `  the matcher called ${inv.sameStoryPairs} of the judged pairs the same story and ${inv.differentStoryPairs} a different one`,
  );
  lines.push(`  lowest similarity judged ${inv.lowestJudged}, highest below the threshold ${inv.highestScreenedOut}`);
  lines.push('');
  lines.push('The gate');
  lines.push(
    `  at ${report.gate.effectiveThreshold}: ${report.gate.judgedSameStory} same story, ${report.gate.judgedDifferentStory} different story — precision ${pct(report.gate.precisionAtThreshold)}`,
  );
  lines.push('  threshold   admitted   judged   same   different   headline   below   precision');
  for (const row of report.gate.sweep) {
    lines.push(
      `  ${row.threshold.toFixed(2).padStart(8)}   ${String(row.admitted).padStart(8)}   ${String(row.judged).padStart(6)}   ${String(row.sameStory).padStart(4)}   ${String(row.differentStory).padStart(9)}   ${String(row.titleMatched).padStart(8)}   ${String(row.screenedOut).padStart(5)}   ${pct(row.precision).padStart(9)}`,
    );
  }
  lines.push('');
  lines.push('Does the score separate the two kinds of pair?');
  lines.push(
    `  area under the curve: ${num(report.separation.auc)} (the matcher's own confidence: ${num(report.separation.aucOfMatcherProbability)})`,
  );
  lines.push(
    `  mean similarity: same story ${num(report.separation.meanSameStory)}, different story ${num(report.separation.meanDifferentStory)}`,
  );
  lines.push(
    `  median similarity: same story ${num(report.separation.medianSameStory)}, different story ${num(report.separation.medianDifferentStory)}`,
  );
  lines.push('');
  lines.push('Does the score order the candidates the way the matcher does?');
  lines.push(
    `  ${report.ranking.decisions} joins: the accepted story was first by score ${report.ranking.acceptedFirst}, later ${report.ranking.acceptedLater}, not in the list ${report.ranking.acceptedMissing}`,
  );
  lines.push(
    `  in ${report.ranking.decisionsWithAPick} decisions the matcher found a story it called the same story, and the top-scoring candidate was that story ${report.ranking.matcherAgreesWithTopScore} times`,
  );
  lines.push('');
  lines.push('What the threshold kept out');
  for (const band of report.nearMiss.bands) {
    lines.push(`  ${band.from.toFixed(2)}–${band.to.toFixed(2)}: ${band.pairs} pairs across ${band.articles} articles`);
  }
  lines.push(`  ${report.nearMiss.pairsLostToAnotherStory} near misses lost the article to another story`);
  lines.push('');
  lines.push('Does a bigger story score higher?');
  lines.push('  story size   pairs   same   different   mean same   mean different');
  for (const bucket of report.sizeBias.buckets) {
    lines.push(
      `  ${bucket.size.padEnd(11)}   ${String(bucket.pairs).padStart(5)}   ${String(bucket.sameStory).padStart(4)}   ${String(bucket.differentStory).padStart(9)}   ${num(bucket.meanSame).padStart(9)}   ${num(bucket.meanDifferent).padStart(14)}`,
    );
  }
  lines.push(`  correlation between similarity and story size: ${num(report.sizeBias.correlationWithStorySize)}`);
  lines.push('');
  lines.push('Does the score depend on how much text the article has?');
  lines.push('  text            pairs   same   different   mean same   mean different');
  for (const bucket of report.textBias.buckets) {
    lines.push(
      `  ${bucket.text.padEnd(14)}   ${String(bucket.pairs).padStart(5)}   ${String(bucket.sameStory).padStart(4)}   ${String(bucket.differentStory).padStart(9)}   ${num(bucket.meanSame).padStart(9)}   ${num(bucket.meanDifferent).padStart(14)}`,
    );
  }
  lines.push(`  correlation between similarity and the number of terms: ${num(report.textBias.correlationWithTermCount)}`);
  lines.push('');
  lines.push('The stories as they are now');
  lines.push(
    `  ${report.drift.pairs} pairs recomputed: mean change ${num(report.drift.meanAbsoluteChange)}, correlation ${num(report.drift.correlation)}, ${report.drift.thresholdFlips} pairs crossed the threshold`,
  );
  lines.push('');
  lines.push('Headlines that repeat in different stories');
  lines.push(`  ${report.duplicateHeadlines.groups} headlines in more than one story (${report.duplicateHeadlines.pairs} pairs)`);
  for (const example of report.duplicateHeadlines.examples.slice(0, 5)) {
    lines.push(`    "${example.title}" in stories ${example.stories.join(', ')}`);
  }
  lines.push('');
  lines.push('What the reader corrected');
  lines.push(`  ${report.corrections.merges.length} merges, ${report.corrections.splits.length} splits`);
  for (const merge of report.corrections.merges) {
    lines.push(
      `    merged ${merge.sourceStoryId} into ${merge.targetStoryId}: "${merge.headline}" — best similarity now ${num(merge.bestSimilarityNow)}`,
    );
  }
  for (const split of report.corrections.splits) {
    lines.push(
      `    split ${split.articleIds.length} articles out of ${split.storyId}: "${split.headline}" — best similarity now ${num(split.bestSimilarityNow)}`,
    );
  }
  lines.push('');
  lines.push('Where the matcher was unsure');
  lines.push(
    `  ${report.abstention.uncertainPairs} of ${report.abstention.judgedPairs} judged pairs were a coin toss, ${report.abstention.uncertainSameStory} of them the same story`,
  );
  return lines.join('\n');
}
