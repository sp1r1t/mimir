import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { formatReport, runReplay } from '../src/stories/replay.js';
import { tempDir } from './helpers.js';

type DB = ReturnType<typeof openDatabase>;

/** One article row, with the columns the schema insists on. */
function article(db: DB, id: number, title: string, summary: string): void {
  db.prepare(
    `INSERT INTO articles (id, title, summary_text, content_hash, discovered_at, ingested_at, updated_at)
     VALUES (?, ?, ?, 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, title, summary);
}

function story(db: DB, id: number, headline: string, status = 'active', mergedInto: number | null = null): void {
  db.prepare(
    `INSERT INTO stories (id, status, merged_into_id, headline, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, status, mergedInto, headline);
}

function member(db: DB, articleId: number, storyId: number, role = 'origin'): void {
  db.prepare(
    `INSERT INTO story_articles (article_id, story_id, role, assigned_by, publisher, occurred_at, added_at)
     VALUES (?, ?, ?, 'matcher', 'example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(articleId, storyId, role);
}

interface Candidate {
  storyId: number;
  similarity: number;
  titleMatch?: boolean;
  same?: { score: number; level: number; confidence: number | null; probabilities: Record<string, number> };
}

function match(db: DB, id: number, articleId: number, storyId: number | null, outcome: string, method: string, candidates: Candidate[]): void {
  db.prepare(
    `INSERT INTO story_matches (id, article_id, story_id, outcome, role, method, candidates, created_at)
     VALUES (?, ?, ?, ?, 'coverage', ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(id, articleId, storyId, outcome, method, JSON.stringify(candidates));
}

/** What the matcher said about a candidate: level 2 is the same story. */
const judged = (level: number, score: number) => ({
  score,
  level,
  confidence: 0.7,
  probabilities: { 0: level === 0 ? 0.8 : 0.1, 1: level === 1 ? 0.8 : 0.1, 2: level === 2 ? 0.8 : 0.1 },
});

/**
 * A small history: six decisions, of which two joined a story. One of the joins the
 * score would have ordered the other way round, one candidate was kept back by the
 * threshold, one headline sits in two stories, and one story was merged by hand.
 */
function build(): DB {
  const dir = tempDir();
  const db = openDatabase(join(dir.dir, 'mimir.db'));

  article(db, 1, 'Apple unveils a new phone in Berlin', 'Apple showed the new phone in Berlin today.');
  article(db, 2, 'Apple unveils a new phone in Berlin', 'Apple showed the new phone in Berlin today.');
  article(db, 3, 'Oil prices climb sharply in Oslo', 'Oil prices climbed sharply in Oslo this week.');
  article(db, 4, 'Central bank raises rates in Lima', 'The central bank raised rates in Lima.');
  article(db, 5, 'Regulators question the new phone in Paris', 'Regulators questioned the phone launch in Paris.');
  article(db, 6, 'Reporters gather for the phone launch in Rome', 'Reporters gathered in Rome for the phone launch.');
  article(db, 7, 'Brokerage note about the phone company', 'A brokerage wrote about the phone company.');
  article(db, 8, 'Column about the phone company', 'A column about the phone company.');
  article(db, 9, 'Regulator opens a probe into the phone company', 'A regulator opened a probe into the phone company.');
  article(db, 10, 'Regulator opens a probe into the phone company', 'A regulator opened a probe into the phone company.');

  story(db, 10, 'Apple unveils a new phone in Berlin');
  story(db, 20, 'Apple unveils a new phone in Berlin');
  story(db, 30, 'Oil prices climb sharply in Oslo');
  story(db, 50, 'Regulator opens a probe into the phone company');
  story(db, 40, 'Regulator opens a probe into the phone company', 'merged', 50);

  member(db, 1, 10);
  member(db, 2, 20);
  member(db, 3, 30);
  member(db, 9, 50);
  member(db, 10, 50);

  // A candidate the matcher rejected, though the score liked it.
  match(db, 1, 4, null, 'new_story', 'matcher', [{ storyId: 30, similarity: 0.55, same: judged(0, 0.1) }]);
  // A join: the score and the matcher agree on the first candidate.
  match(db, 2, 5, 10, 'joined', 'matcher', [
    { storyId: 10, similarity: 0.75, same: judged(2, 1.9) },
    { storyId: 20, similarity: 0.45, same: judged(1, 1.1) },
  ]);
  // A join the score would have ordered the other way round.
  match(db, 3, 6, 10, 'joined', 'matcher', [
    { storyId: 30, similarity: 0.85, same: judged(0, 0.2) },
    { storyId: 10, similarity: 0.65, same: judged(2, 1.8) },
  ]);
  // A candidate the threshold kept back.
  match(db, 4, 7, null, 'new_story', 'no_candidates', [{ storyId: 30, similarity: 0.25 }]);
  // A join where another story was a near miss.
  match(db, 5, 8, 10, 'joined', 'matcher', [
    { storyId: 10, similarity: 0.8, same: judged(2, 1.9) },
    { storyId: 30, similarity: 0.22 },
  ]);
  // The story the reader merged by hand.
  match(db, 6, 9, 40, 'new_story', 'no_candidates', []);
  db.prepare(
    `INSERT INTO story_events (story_id, event_type, details, created_at)
     VALUES (40, 'merged_into', '{"storyId":50,"articles":1}', '2026-01-02T00:00:00.000Z')`,
  ).run();

  return db;
}

describe('replay of recorded matching decisions', () => {
  it('reads back what was recorded', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    expect(report.inventory.matches).toBe(6);
    expect(report.inventory.judgedPairs).toBe(6);
    expect(report.inventory.screenedOutPairs).toBe(2);
    expect(report.inventory.sameStoryPairs).toBe(3);
    expect(report.inventory.differentStoryPairs).toBe(3);
    db.close();
  });

  it('separates the same-story pairs from the different-story ones', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    // Same-story pairs score 0.75, 0.65 and 0.8; different-story pairs 0.55, 0.45 and 0.85.
    // Six of the nine comparisons come out right: the score is better than chance, but
    // the join it ordered wrongly is one of them.
    expect(report.separation.auc).toBeCloseTo(0.667, 2);
    expect(report.separation.aucOfMatcherProbability).toBe(1);
    expect(report.separation.meanSameStory).toBeCloseTo(0.733, 2);
    expect(report.separation.meanDifferentStory).toBeCloseTo(0.617, 2);
    db.close();
  });

  it('reports the gate the score made', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    const atThreshold = report.gate.sweep.find((r) => r.threshold === 0.3)!;
    expect(atThreshold.judged).toBe(6);
    expect(atThreshold.sameStory).toBe(3);
    expect(atThreshold.differentStory).toBe(3);
    expect(atThreshold.precision).toBe(0.5);
    expect(atThreshold.screenedOut).toBe(0);
    // A lower threshold would have asked about the two candidates that were kept back.
    const lower = report.gate.sweep.find((r) => r.threshold === 0.2)!;
    expect(lower.screenedOut).toBe(2);
    db.close();
  });

  it('counts the joins the score ordered first and the joins it did not', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    expect(report.ranking.decisions).toBe(3);
    expect(report.ranking.acceptedFirst).toBe(2);
    expect(report.ranking.acceptedLater).toBe(1);
    expect(report.ranking.acceptedMissing).toBe(0);
    // The matcher's pick and the top-scoring candidate agreed on two of the three.
    expect(report.ranking.matcherAgreesWithTopScore).toBe(2);
    expect(report.ranking.examples[0]).toMatchObject({ articleId: 6, acceptedStoryId: 10, acceptedRank: 2 });
    db.close();
  });

  it('lists the candidates the threshold kept back', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    expect(report.nearMiss.bands.at(-1)!.pairs).toBe(1);
    expect(report.nearMiss.bands.at(-2)!.pairs).toBe(1);
    // The article that went to another story while this candidate was below the line.
    expect(report.nearMiss.pairsLostToAnotherStory).toBe(1);
    expect(report.nearMiss.worthJudging[0]).toMatchObject({ articleId: 8, storyId: 30 });
    db.close();
  });

  it('finds the headline that sits in two stories', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    expect(report.duplicateHeadlines.groups).toBe(1);
    expect(report.duplicateHeadlines.pairs).toBe(1);
    expect(report.duplicateHeadlines.examples[0]!.stories.sort()).toEqual([10, 20]);
    db.close();
  });

  it('shows what the reader merged by hand', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });

    expect(report.corrections.merges).toHaveLength(1);
    expect(report.corrections.merges[0]).toMatchObject({ sourceStoryId: 40, targetStoryId: 50, articles: 1 });
    // The same headline: the score would have given it the highest mark it can give.
    expect(report.corrections.merges[0]!.bestSimilarityNow).toBe(1);
    db.close();
  });

  it('says the same story when the score agrees with the matcher', () => {
    const dir = tempDir();
    const db = openDatabase(join(dir.dir, 'mimir.db'));
    article(db, 1, 'Apple unveils a new phone in Berlin', 'Apple showed the new phone in Berlin today.');
    article(db, 2, 'Oil prices climb sharply in Oslo', 'Oil prices climbed sharply in Oslo this week.');
    article(db, 3, 'A report about the phone launch', 'Something about the phone launch.');
    article(db, 4, 'A note about oil markets', 'Something about the oil markets.');
    story(db, 10, 'Apple unveils a new phone in Berlin');
    story(db, 30, 'Oil prices climb sharply in Oslo');
    member(db, 1, 10);
    member(db, 2, 30);
    match(db, 1, 3, 10, 'joined', 'matcher', [{ storyId: 10, similarity: 0.8, same: judged(2, 1.9) }]);
    match(db, 2, 4, 30, 'joined', 'matcher', [{ storyId: 30, similarity: 0.2, same: judged(0, 0.1) }]);

    const report = runReplay(db, { threshold: 0.3 });
    expect(report.separation.auc).toBe(1);
    // The different-story pair scored 0.2 and never reached the matcher, so everything
    // that did reach it was the same story.
    expect(report.gate.precisionAtThreshold).toBe(1);
    db.close();
  });

  it('reads as text', () => {
    const db = build();
    const report = runReplay(db, { threshold: 0.3 });
    const text = formatReport(report);

    expect(text).toContain('Story matching replay');
    expect(text).toContain('area under the curve');
    expect(text).toContain('What the reader corrected');
    db.close();
  });
});
