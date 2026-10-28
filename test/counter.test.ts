import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import type { LevelAnswer, MatchArticle, MatchCandidate, MatchJudgement, StoryMatcher } from '../src/stories/matcher.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { elapsedLabel } from '../src/web/pages/stories.js';
import { buildServer } from '../src/web/server.js';
import { FeedServer, makeApp, waitFor, type TestApp } from './helpers.js';

interface Item {
  guid: string;
  title: string;
  host: string;
}

function rss(items: Item[]): string {
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Wire</title><link>https://wire.example.com/</link>
    ${items
      .map(
        (i) => `<item><title>${i.title}</title><link>https://${i.host}/${i.guid}</link><guid isPermaLink="false">${i.guid}</guid>
      <pubDate>${new Date(now - 3_600_000).toUTCString()}</pubDate><description>${i.title}</description></item>`,
      )
      .join('\n')}
  </channel></rss>`;
}

/** A classifier that says every article is a plain report. */
class PlainClassifier implements Classifier {
  readonly name = 'plain';
  readonly version = 'plain/1';
  isConfigured() {
    return true;
  }
  configurationHint() {
    return null;
  }
  inputHash(a: ClassificationArticle, p: InterestProfile) {
    return sha256(stableStringify({ a: [a.title, a.text], p: p.version }));
  }
  async classify(a: ClassificationArticle, p: InterestProfile): Promise<ClassificationResult> {
    return {
      classifier: this.name,
      classifierVersion: this.version,
      model: 'plain-model-1',
      inputHash: this.inputHash(a, p),
      categories: [],
      personalRelevance: 0.6,
      significance: 0.6,
      urgency: 0.4,
      investigate: 0.2,
      promotional: 0,
      exclusion: 0,
      articleType: 'news_report',
      signals: {},
      rawRequest: {},
      rawResponse: {},
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
  }
}

const level = (score: number): LevelAnswer => ({ score, level: Math.round(score), confidence: 0.9, probabilities: {} });

/** One story for every article that shares a marker word. */
class OneStoryMatcher implements StoryMatcher {
  readonly name = 'one-story-matcher';
  readonly version = 'one-story-matcher/1';
  isConfigured() {
    return true;
  }
  configurationHint() {
    return null;
  }
  async judge(article: MatchArticle, candidates: MatchCandidate[]): Promise<MatchJudgement> {
    return {
      model: 'stub',
      candidates: candidates.map((c) => ({
        storyId: c.storyId,
        same: level(/volcano/i.test(article.title ?? '') ? 2 : 0),
        update: level(0),
      })),
      rawRequest: {},
      rawResponse: {},
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
  }
}

describe('the seconds a brief has been taking', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z');

  it('counts the seconds, then the minutes, then the hours', () => {
    expect(elapsedLabel('2026-10-29T11:59:35.000Z', now)).toBe('25s');
    expect(elapsedLabel('2026-10-29T11:58:55.000Z', now)).toBe('1m 05s');
    expect(elapsedLabel('2026-10-29T09:57:00.000Z', now)).toBe('2h 03m');
  });

  it('says nothing when there is no moment to count from', () => {
    expect(elapsedLabel(null, now)).toBeNull();
    expect(elapsedLabel('not a moment', now)).toBeNull();
    expect(elapsedLabel('2026-10-29T12:05:00.000Z', now)).toBeNull();
  });
});

describe('the counter on the story page', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    await server?.close();
    await t?.cleanup();
    await srv?.stop();
    t = srv = server = null;
  });

  async function setup() {
    srv = new FeedServer();
    await srv.start();
    t = makeApp({
      classifier: new PlainClassifier(),
      matcher: new OneStoryMatcher(),
      summaries: new MockSummaryProvider(),
      env: { SUMMARY_AUTO_ENABLED: 'false', STORY_MIN_SIMILARITY: '0.01' },
    });
    t.app.start();
    server = buildServer(t.app);
    await server.ready();
    srv.serveFeed('/a', () => rss([{ guid: 'a', title: 'A volcano erupts near Reykjavik', host: 'ruv.example.is' }]));
    const source = t.app.sources.create({ name: 'ruv.example.is', url: srv.url('/a'), pollIntervalSeconds: 600 });
    await t.app.scheduler.fetchNow(source);
    const article = t.app.db.prepare('SELECT id FROM articles WHERE guid = ?').get('a') as { id: number };
    await waitFor(() => t!.app.stories.storyIdOf(article.id) != null);
    return t.app.stories.storyIdOf(article.id)!;
  }

  /** Put the story in a state, as the pipeline would. */
  function setState(storyId: number, state: 'pending' | 'running' | 'idle', startedSecondsAgo?: number) {
    const app = t!.app;
    app.stories.setSummaryRequest(storyId, state);
    if (state === 'running' && startedSecondsAgo != null) {
      app.db
        .prepare('UPDATE stories SET summary_started_at = ? WHERE id = ?')
        .run(new Date(Date.now() - startedSecondsAgo * 1000).toISOString(), storyId);
    }
  }

  it('counts the seconds next to the writing badge', async () => {
    const storyId = await setup();
    setState(storyId, 'running', 65);

    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    expect(page.statusCode).toBe(200);
    const { document } = parseHTML(page.body);
    const line = document.querySelector('.badge-line');
    expect(line!.textContent).toContain('Writing');
    const counter = line!.querySelector('.write-counter');
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toBe('1m 05s');
    // The browser counts from the moment the server gives it, so a refresh does not
    // start the count again.
    expect(counter!.getAttribute('data-elapsed-since')).toBe(
      (t!.app.db.prepare('SELECT summary_started_at AS at FROM stories WHERE id = ?').get(storyId) as { at: string }).at,
    );
    expect(Date.parse(counter!.getAttribute('data-elapsed-now')!)).not.toBeNaN();
  });

  it('counts the waiting time of a queued brief', async () => {
    const storyId = await setup();
    setState(storyId, 'pending');

    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    const { document } = parseHTML(page.body);
    const counter = document.querySelector('.badge-line .write-counter');
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toMatch(/^\d+s$/);
  });

  it('shows no counter when no brief is being written', async () => {
    const storyId = await setup();
    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    const { document } = parseHTML(page.body);
    expect(document.querySelector('.write-counter')).toBeNull();
  });

  it('takes the counter away when the brief is there', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);
    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    const { document } = parseHTML(page.body);
    expect(document.querySelector('.write-counter')).toBeNull();
  });
});
