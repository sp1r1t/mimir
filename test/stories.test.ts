import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import type { LevelAnswer, MatchArticle, MatchCandidate, MatchJudgement, StoryMatcher } from '../src/stories/matcher.js';
import { STORY_MATCH, STORY_SUMMARY } from '../src/stories/pipeline.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { buildServer } from '../src/web/server.js';
import { FeedServer, makeApp, waitFor, type TestApp } from './helpers.js';

interface Item {
  guid: string;
  title: string;
  host: string;
  description?: string;
  hoursAgo?: number;
  comments?: string;
}

function rss(items: Item[]): string {
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Wire</title><link>https://wire.example.com/</link>
    ${items
      .map(
        (i) => `<item><title>${i.title}</title><link>https://${i.host}/${i.guid}</link><guid isPermaLink="false">${i.guid}</guid>
      <pubDate>${new Date(now - (i.hoursAgo ?? 1) * 3_600_000).toUTCString()}</pubDate><description>${i.description ?? i.title}</description>${i.comments ? `<comments>${i.comments}</comments>` : ''}</item>`,
      )
      .join('\n')}
  </channel></rss>`;
}

/** Relevance from keywords, so tests control story priority. */
class KeywordClassifier implements Classifier {
  readonly name = 'fake';
  readonly version = 'fake/1';
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
    const hot = /volcano|eruption/i.test(a.title ?? '');
    return {
      classifier: this.name,
      classifierVersion: this.version,
      model: 'fake-model-1',
      inputHash: this.inputHash(a, p),
      categories: p.definition.topics.map((t, i) => ({ id: t.id, label: t.label, probability: i === 0 ? 0.8 : 0.1, assigned: i === 0 })),
      personalRelevance: hot ? 0.95 : 0.1,
      significance: hot ? 0.8 : 0.3,
      urgency: hot ? 0.8 : 0.1,
      investigate: 0.4,
      promotional: 0.05,
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

/** Same story when the article and the story share a marker word; "update" when the article says so. */
class FakeMatcher implements StoryMatcher {
  readonly name = 'fake-matcher';
  readonly version = 'fake-matcher/1';
  configured = true;
  calls: { article: MatchArticle; candidates: MatchCandidate[] }[] = [];
  constructor(private readonly markers: string[]) {}
  isConfigured() {
    return this.configured;
  }
  configurationHint() {
    return this.configured ? null : 'matcher off';
  }
  async judge(article: MatchArticle, candidates: MatchCandidate[]): Promise<MatchJudgement> {
    this.calls.push({ article, candidates });
    const marker = this.markers.find((m) => article.title?.toLowerCase().includes(m));
    return {
      model: 'fake-jev',
      candidates: candidates.map((c) => ({
        storyId: c.storyId,
        same: level(marker && c.reports.some((r) => r.title?.toLowerCase().includes(marker)) ? 2 : 0),
        update: level(/\bupdate\b|confirmed|death toll/i.test(article.title ?? '') ? 2 : 0),
      })),
      rawRequest: { article: article.id },
      rawResponse: { ok: true },
      usage: { inputTokens: 100, outputTokens: 4 },
      durationMs: 3,
    };
  }
}

describe('stories', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    await server?.close();
    await t?.cleanup();
    await srv?.stop();
    t = srv = server = null;
  });

  async function setup(opts: { matcher?: FakeMatcher; summaries?: MockSummaryProvider; env?: Record<string, string>; dir?: string } = {}) {
    srv = new FeedServer();
    await srv.start();
    t = makeApp({
      classifier: new KeywordClassifier(),
      matcher: opts.matcher ?? new FakeMatcher(['volcano', 'kernel']),
      summaries: opts.summaries,
      // A handful of articles gives little lexical signal; the fake matcher makes the decisions.
      env: { SUMMARY_AUTO_ENABLED: 'false', STORY_MIN_SIMILARITY: '0.01', ...opts.env },
      dir: opts.dir,
    });
    t.app.start();
    return t.app;
  }

  /** Publish items one feed fetch at a time and wait until each is in a story. */
  async function publish(items: Item[]) {
    const app = t!.app;
    for (const item of items) {
      srv!.serveFeed(`/${item.guid}`, () => rss([item]));
      const s = app.sources.create({ name: item.host, url: srv!.url(`/${item.guid}`), pollIntervalSeconds: 600 });
      await app.scheduler.fetchNow(s);
      const id = (app.db.prepare('SELECT id FROM articles WHERE guid = ?').get(item.guid) as { id: number }).id;
      await waitFor(() => app.stories.storyIdOf(id) != null);
    }
  }

  const idle = async () => {
    try {
      await waitFor(() => {
        const busy = t!.app.queue.counts().filter((c) => c.status === 'pending' || c.status === 'running');
        return busy.length === 0;
      });
    } catch (err) {
      console.log(t!.app.db.prepare("SELECT kind, status, attempts, run_after, last_error FROM jobs WHERE status IN ('pending', 'running')").all());
      throw err;
    }
  };

  const storyOf = (guid: string) => {
    const app = t!.app;
    const id = (app.db.prepare('SELECT id FROM articles WHERE guid = ?').get(guid) as { id: number }).id;
    return app.stories.get(app.stories.storyIdOf(id)!)!;
  };

  it('groups reports of the same event, counts publishers, and keeps unrelated articles apart', async () => {
    const matcher = new FakeMatcher(['volcano']);
    const app = await setup({ matcher });
    await publish([
      { guid: 'a', title: 'Volcano erupts near Reykjavik airport', host: 'ruv.example.is' },
      { guid: 'b', title: 'Reykjavik airport closed as volcano erupts', host: 'www.bbc.example.com' },
      { guid: 'c', title: 'Kernel 7.2 released with new scheduler', host: 'lwn.example.net' },
    ]);
    await idle();
    const volcano = storyOf('a');
    expect(storyOf('b').id).toBe(volcano.id);
    expect(volcano).toMatchObject({ articleCount: 2, publisherCount: 2, developmentCount: 1 });
    expect(volcano.members.map((m) => m.role).sort()).toEqual(['coverage', 'origin']);
    expect(storyOf('c').id).not.toBe(volcano.id);
    // Only the second volcano report had a candidate story; the kernel article had none.
    expect(matcher.calls.map((c) => c.article.title)).toEqual(['Reykjavik airport closed as volcano erupts']);
    const join = volcano.members.find((m) => m.role === 'coverage')!;
    expect(join.matchMethod).toBe('matcher');
    expect(join.matchCandidates?.[0]?.same?.level).toBe(2);
    expect(app.stories.counts()).toMatchObject({ active: 2, unassigned: 0 });
  });

  it('joins identical headlines from another publisher without asking the matcher', async () => {
    const matcher = new FakeMatcher([]);
    await setup({ matcher });
    await publish([
      { guid: 'a', title: 'Central bank raises interest rates by half a point', host: 'reuters.example.com' },
      { guid: 'b', title: 'Central bank raises interest rates by half a point', host: 'apnews.example.com' },
    ]);
    await idle();
    expect(storyOf('b').id).toBe(storyOf('a').id);
    expect(storyOf('a').members.find((m) => m.articleId !== storyOf('a').leadArticleId)?.matchMethod).toBe('title_match');
    expect(matcher.calls).toHaveLength(0);
  });

  it('distinguishes meaningful updates from repeated coverage and marks summaries stale only on updates', async () => {
    const summaries = new MockSummaryProvider();
    const app = await setup({ summaries });
    await publish([{ guid: 'a', title: 'Volcano erupts near Grindavik', host: 'ruv.example.is', hoursAgo: 5 }]);
    await idle();
    const id = storyOf('a').id;
    expect(app.storyPipeline.requestSummary(id).queued).toBe(true);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');
    expect(summaries.calls).toBe(1);

    await publish([{ guid: 'b', title: 'Grindavik volcano eruption seen from space', host: 'nasa.example.gov', hoursAgo: 4 }]);
    await idle();
    expect(app.stories.item(id)).toMatchObject({ articleCount: 2, developmentCount: 1, summaryState: 'ready' });

    await publish([{ guid: 'c', title: 'Volcano update: lava reaches Grindavik defences', host: 'ruv.example.is', hoursAgo: 1 }]);
    await idle();
    const s = app.stories.get(id)!;
    expect(s).toMatchObject({ articleCount: 3, developmentCount: 2, summaryState: 'stale' });
    expect(s.developments.map((d) => d.kind)).toEqual(['origin', 'update']);
    expect(Date.parse(s.latestDevelopmentAt!)).toBeGreaterThan(Date.parse(s.firstPublishedAt!));
    expect(summaries.calls).toBe(1); // auto summaries are off; stale is not regenerated

    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');
    const fresh = app.stories.get(id)!;
    expect(fresh.summary!.revision).toBe(2);
    expect(fresh.summary!.articles.map((a) => a.articleId).sort()).toEqual(fresh.members.map((m) => m.articleId).sort());
  });

  it('generates automatic summaries only for high-priority stories and within the daily cap', async () => {
    const summaries = new MockSummaryProvider();
    const app = await setup({
      summaries,
      env: { SUMMARY_AUTO_ENABLED: 'true', SUMMARY_AUTO_MIN_PRIORITY: '0.6', SUMMARY_AUTO_MAX_PER_DAY: '1' },
    });
    await publish([
      { guid: 'low', title: 'Local council approves new parking rules', host: 'city.example.org' },
      { guid: 'hot', title: 'Volcano erupts near Vik', host: 'ruv.example.is' },
      { guid: 'hot2', title: 'Massive eruption in Chile forces evacuations', host: 'emol.example.cl' },
    ]);
    await idle();
    await waitFor(() => storyOf('hot').summaryState === 'ready');
    await idle();
    expect(storyOf('hot').priority!).toBeGreaterThanOrEqual(0.6);
    expect(storyOf('hot2').priority!).toBeGreaterThanOrEqual(0.6);
    expect(storyOf('low').priority!).toBeLessThan(0.6);
    expect(storyOf('low').summaryState).toBe('none');
    // The cap of one automatic summary per day leaves the second eligible story waiting.
    expect(summaries.calls).toBe(1);
    expect(storyOf('hot2').summaryState).toBe('none');
    // Manual requests are not capped.
    app.storyPipeline.requestSummary(storyOf('low').id);
    await waitFor(() => storyOf('low').summaryState === 'ready');
    expect(summaries.calls).toBe(2);
  });

  it('summarizes eligible stories that were assessed before the provider was configured', async () => {
    const summaries = new MockSummaryProvider();
    summaries.configured = false;
    const app = await setup({ summaries, env: { SUMMARY_AUTO_ENABLED: 'true', SUMMARY_AUTO_MIN_PRIORITY: '0.6' } });
    await publish([
      { guid: 'low', title: 'Local council approves new parking rules', host: 'city.example.org' },
      { guid: 'hot', title: 'Volcano erupts near Vik', host: 'ruv.example.is' },
    ]);
    await idle();
    expect(storyOf('hot').priority!).toBeGreaterThanOrEqual(0.6);
    expect(storyOf('hot').summaryState).toBe('none');

    summaries.configured = true; // key added; no new articles arrive
    app.storyPipeline.reconcile();
    await waitFor(() => storyOf('hot').summaryState === 'ready');
    await idle();
    expect(storyOf('low').summaryState).toBe('none');
    expect(summaries.calls).toBe(1);
  });

  it('never replaces a good summary with a failed or malformed one', async () => {
    const summaries = new MockSummaryProvider();
    const app = await setup({ summaries, env: { SUMMARY_MAX_ATTEMPTS: '1' } });
    await publish([{ guid: 'a', title: 'Volcano erupts near Hella', host: 'ruv.example.is' }]);
    await idle();
    const id = storyOf('a').id;
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');

    summaries.mode = 'invalid';
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryState === 'failed');
    let s = app.stories.get(id)!;
    expect(s.summary!.revision).toBe(1);
    expect(s.summaryError).toMatch(/what_happened|invalid|schema/i);

    summaries.mode = 'unavailable';
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryState === 'failed' && summaries.calls === 3);
    s = app.stories.get(id)!;
    expect(s.summary!.revision).toBe(1);
    const outcomes = (app.db.prepare('SELECT outcome FROM summary_attempts ORDER BY id').all() as { outcome: string }[]).map((r) => r.outcome);
    expect(outcomes).toEqual(['ok', 'invalid_output', 'unavailable']);
  });

  it('holds summary jobs while the allowance is exhausted, without calling the provider', async () => {
    const summaries = new MockSummaryProvider('quota');
    const app = await setup({ summaries });
    await publish([{ guid: 'a', title: 'Volcano erupts near Selfoss', host: 'ruv.example.is' }]);
    await idle();
    const id = storyOf('a').id;
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryError != null);
    expect(app.stories.item(id)).toMatchObject({ summaryState: 'pending', summaryError: 'Mock allowance exhausted' });
    expect(summaries.calls).toBe(0);
  });

  it('promotes an automatic summary held by the local cap to a manual request through the page action', async () => {
    const summaries = new MockSummaryProvider();
    const app = await setup({ summaries, env: { SUMMARY_AUTO_ENABLED: 'true', SUMMARY_AUTO_MAX_PER_DAY: '1' } });
    await publish([
      { guid: 'first', title: 'Volcano erupts near Vik', host: 'ruv.example.is' },
      { guid: 'second', title: 'Massive eruption in Chile forces evacuations', host: 'emol.example.cl' },
    ]);
    await idle();
    expect(summaries.calls).toBe(1);
    const id = storyOf('second').id;
    app.queue.enqueue(STORY_SUMMARY, `story:${id}`, { storyId: id, trigger: 'auto' });
    app.storyPipeline.notify();
    await waitFor(() => !!app.stories.item(id)!.summaryError);
    const budget = app.storyPipeline.automaticSummaryBudget();
    expect(budget).toMatchObject({ used: 1, limit: 1 });
    expect(Date.parse(budget.resumesAt!)).toBeGreaterThan(Date.now());
    const job = app.db.prepare("SELECT id, attempts, run_after FROM jobs WHERE kind = ? AND status = 'pending'").get(STORY_SUMMARY) as { id: number; attempts: number; run_after: string };
    expect(Date.parse(job.run_after)).toBeGreaterThan(Date.now());
    server = buildServer(app);
    const page = await server.inject({ url: `/stories/${id}` });
    const { document } = parseHTML(page.body);
    const generate = document.querySelector(`form[action="/stories/${id}/summary"] button`)!;
    expect(generate.textContent).toBe('Write now');
    expect(generate.hasAttribute('disabled')).toBe(false);
    expect(page.body).toContain('separate from the MiniMax plan allowance');
    const response = await server.inject({ method: 'POST', url: `/api/stories/${id}/summary` });
    expect(response.statusCode).toBe(202);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');
    expect(summaries.calls).toBe(2);
    const promoted = app.db.prepare('SELECT status, payload FROM jobs WHERE id = ?').get(job.id) as { status: string; payload: string };
    expect(promoted.status).toBe('done');
    expect(JSON.parse(promoted.payload).trigger).toBe('manual');
    expect(app.db.prepare('SELECT COUNT(*) n FROM jobs WHERE kind = ? AND dedupe_key = ?').get(STORY_SUMMARY, `story:${id}`)).toEqual({ n: 1 });
    expect(app.storyPipeline.automaticSummaryBudget().used).toBe(1);
  });

  it('lets a queued request check restored provider capacity and keeps real quota checks in force', async () => {
    const summaries = new MockSummaryProvider('quota');
    const app = await setup({ summaries });
    await publish([{ guid: 'a', title: 'Volcano erupts near Selfoss', host: 'ruv.example.is' }]);
    await idle();
    const id = storyOf('a').id;
    app.storyPipeline.requestSummary(id);
    await waitFor(() => !!app.stories.item(id)!.summaryError);
    app.storyPipeline.requestSummary(id); // Explicit retries cannot bypass provider allowance.
    await waitFor(() => !!app.stories.item(id)!.summaryError);
    expect(summaries.calls).toBe(0);
    summaries.mode = 'ok';
    expect(app.storyPipeline.requestSummary(id).queued).toBe(true);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');
    expect(summaries.calls).toBe(1);
  });

  it('writes a Story Intelligence Brief, versions it, and numbers the articles as the timeline does', async () => {
    const summaries = new MockSummaryProvider();
    const app = await setup({ summaries });
    await publish([
      { guid: 'a', title: 'Volcano erupts near Hella', host: 'ruv.example.is', hoursAgo: 3 },
      { guid: 'b', title: 'Volcano eruption near Hella grounds flights', host: 'bbc.example.com', hoursAgo: 2 },
    ]);
    await idle();
    const id = storyOf('a').id;
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.item(id)!.summaryState === 'ready');

    server = buildServer(app);
    const first = await server.inject({ url: `/stories/${id}` });
    const { document } = parseHTML(first.body);
    expect(document.querySelector('.summary-panel h3')!.textContent).toBe('Story Intelligence Brief');
    // The brief says when it was written.
    expect(document.querySelector('.brief-meta')!.textContent).toMatch(/Written .* revision 1/);
    // The first brief has nothing to report as new.
    expect(first.body).not.toContain("What's new");
    // The supporting-sources list is gone: the timeline carries the numbers.
    expect(document.querySelector('.sources-list')).toBeNull();
    const entries = document.querySelectorAll('.timeline > li');
    expect(Array.from(entries).map((e) => e.querySelector('.entry-number')!.textContent)).toEqual(['1', '2']);
    // The citation numbers are the timeline's own.
    const cites = Array.from(document.querySelectorAll('.summary-panel a.cite')).map((a) => a.textContent);
    expect(cites.length).toBeGreaterThan(0);
    for (const cite of cites) {
      const n = Number(cite.replace(/[[\]]/g, ''));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
      expect(document.querySelector(`.timeline > li:nth-child(${n})`)).not.toBeNull();
    }

    // A second brief is a new revision that leads with what is new.
    await publish([{ guid: 'c', title: 'Volcano update: Hella evacuation confirmed', host: 'wire.example.com', hoursAgo: 1 }]);
    await idle();
    app.storyPipeline.requestSummary(id);
    await waitFor(() => app.stories.get(id)!.summary!.revision === 2);
    const second = await server.inject({ url: `/stories/${id}` });
    const { document: doc2 } = parseHTML(second.body);
    expect(doc2.querySelector('.brief-meta')!.textContent).toMatch(/revision 2/);
    const heads = Array.from(doc2.querySelectorAll('.summary-panel h4')).map((h) => h.textContent);
    expect(heads.some((h) => h!.startsWith("What's new since the brief of"))).toBe(true);
    // Every revision is kept.
    expect(doc2.querySelectorAll('.summary-panel details table tbody tr')).toHaveLength(2);
  });

  it('records relevance on the story, retains it across updates, and offers only Save on articles', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'Volcano erupts near Vik', host: 'ruv.example.is', hoursAgo: 3 }]);
    await idle();
    const story = storyOf('a');
    const articleId = story.members[0]!.articleId;
    server = buildServer(app);
    const response = await server.inject({ method: 'POST', url: `/api/stories/${story.id}/feedback`, payload: { type: 'relevant' } });
    expect(response.json().state.relevanceLabel).toBe('relevant');
    expect(app.articles.get(articleId)!.relevanceLabel).toBeNull();
    const event = app.db.prepare('SELECT * FROM story_feedback_events WHERE story_id = ?').get(story.id) as Record<string, unknown>;
    expect(event).toMatchObject({ event_type: 'relevant', article_count: 1, development_count: 1, profile_version: app.profiles.active().version });
    expect(event.assessment_id).not.toBeNull();
    expect(event.personal_relevance).toBe(story.personalRelevance);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${story.id}/feedback`, payload: { type: 'more_like_this' } })).statusCode).toBe(400);
    await publish([{ guid: 'b', title: 'Volcano update: Vik evacuation confirmed', host: 'bbc.example.com', hoursAgo: 1 }]);
    await idle();
    expect(storyOf('a')).toMatchObject({ developmentCount: 2, relevanceLabel: 'relevant' });
    const storyPage = await server.inject({ url: `/stories/${story.id}` });
    const { document } = parseHTML(storyPage.body);
    expect(document.querySelectorAll('.story-feedback button')).toHaveLength(2);
    expect(document.querySelectorAll('.timeline [data-type="relevant"]')).toHaveLength(0);
    for (const url of ['/articles?sort=discovered', `/articles/${articleId}`]) {
      const res = await server.inject({ url });
      const doc = parseHTML(res.body).document;
      const buttons = [...doc.querySelectorAll('form.feedback button')];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((b) => b.getAttribute('data-type') === 'save')).toBe(true);
    }
    expect((await server.inject({ method: 'POST', url: `/api/stories/${story.id}/feedback`, payload: { type: 'clear_relevance' } })).json().state.relevanceLabel).toBeNull();
    expect(app.db.prepare('SELECT COUNT(*) n FROM story_feedback_events WHERE story_id = ?').get(story.id)).toEqual({ n: 2 });
  });

  it('migrates agreeing article labels into story feedback without changing article history', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'Volcano erupts near Vik', host: 'ruv.example.is' }]);
    await idle();
    const story = storyOf('a');
    app.feedback.record(story.members[0]!.articleId, 'relevant');
    app.feedback.record(story.members[0]!.articleId, 'less_like_this');
    // Recreate the pre-005 feedback schema in this isolated database, then apply the real migration.
    app.db.exec(`DROP TABLE story_feedback_events;
      ALTER TABLE stories DROP COLUMN relevance_label;
      ALTER TABLE stories DROP COLUMN relevance_labeled_at;
      ${readFileSync(new URL('../migrations/005_story_feedback.sql', import.meta.url), 'utf8')}`);
    expect(app.stories.item(story.id)!.relevanceLabel).toBe('relevant');
    expect(app.db.prepare('SELECT event_type, actor, article_count, personal_relevance FROM story_feedback_events').all()).toEqual([
      { event_type: 'relevant', actor: 'migration', article_count: 1, personal_relevance: story.personalRelevance },
    ]);
    expect(app.feedback.counts().map((e) => e.eventType).sort()).toEqual(['less_like_this', 'relevant']);
    expect(app.articles.get(story.members[0]!.articleId)!.preference).toBe('less');
  });

  it('merges and splits stories from the web interface, with redirects for merged stories', async () => {
    const app = await setup({ matcher: new FakeMatcher([]) });
    server = buildServer(app);
    await server.ready();
    await publish([
      { guid: 'a', title: 'Storm Amy batters the Scottish coast', host: 'bbc.example.com' },
      { guid: 'b', title: 'Ferries cancelled across the Hebrides', host: 'herald.example.com' },
      { guid: 'c', title: 'Kernel 7.2 released with new scheduler', host: 'lwn.example.net' },
    ]);
    await idle();
    const storm = storyOf('a').id;
    const ferries = storyOf('b').id;
    const form = (data: Record<string, string>) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(data).toString(),
    });

    const merged = await server.inject({ method: 'POST', url: `/stories/${ferries}/merge`, ...form({ targetId: String(storm) }) });
    expect(merged.statusCode).toBe(303);
    expect(app.stories.item(ferries)!.status).toBe('merged');
    expect(app.stories.item(storm)!.articleCount).toBe(2);
    const redirect = await server.inject({ url: `/stories/${ferries}` });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe(`/stories/${storm}`);

    const page = await server.inject({ url: `/stories/${storm}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Ferries cancelled across the Hebrides');
    expect(page.body).toContain('data-confirm');

    const bId = storyOf('b').members.find((m) => m.title?.startsWith('Ferries'))!.articleId;
    const split = await server.inject({ method: 'POST', url: `/stories/${storm}/split`, ...form({ articleIds: String(bId) }) });
    expect(split.statusCode).toBe(303);
    await idle();
    const out = storyOf('b');
    expect(out.id).not.toBe(storm);
    expect(out.members[0]!.assignedBy).toBe('user');
    expect(app.stories.item(storm)!.articleCount).toBe(1);
    expect(out.events.map((e) => e.eventType)).toContain('split_from');

    const all = await server.inject({ method: 'POST', url: `/stories/${out.id}/split`, ...form({ articleIds: String(bId) }) });
    expect(decodeURIComponent(all.headers.location as string)).toContain('Leave at least one article');

    const list = await server.inject({ url: '/?view=all' });
    expect(list.body).toContain('Storm Amy batters the Scottish coast');
    const api = await server.inject({ url: `/api/stories/${ferries}` });
    expect(api.json().id).toBe(storm);
  });

  it('shows every article once in the timeline, with working discussion, feedback and split controls', async () => {
    const app = await setup();
    server = buildServer(app);
    await publish([
      { guid: 'a', title: 'Volcano erupts near Akureyri', host: 'ruv.example.is', hoursAgo: 3, comments: 'https://forum.example.org/item/1' },
      { guid: 'b', title: 'Volcano eruption near Akureyri grounds flights', host: 'bbc.example.com', hoursAgo: 2 },
      { guid: 'c', title: 'Volcano update: Akureyri evacuation confirmed', host: 'wire.example.com', hoursAgo: 1 },
    ]);
    await idle();
    const story = storyOf('a');
    expect(story.members.map((m) => m.role)).toEqual(['origin', 'coverage', 'update']);
    const response = await server.inject({ url: `/stories/${story.id}` });
    const { document } = parseHTML(response.body);
    expect(document.querySelectorAll('.timeline > li')).toHaveLength(3);
    expect(document.querySelector('table.members')).toBeNull();
    expect(document.querySelector('form form')).toBeNull();
    expect(document.querySelector('.story-dates')!.hasAttribute('open')).toBe(false);
    expect(document.querySelector('.story-membership')!.hasAttribute('open')).toBe(false);
    for (const m of story.members) {
      const entry = document.querySelector(`#a-${m.articleId}`)!;
      expect(entry).not.toBeNull();
      expect(entry.querySelector('.entry-title a')!.getAttribute('href')).toBe(`/articles/${m.articleId}`);
      expect(entry.querySelector(`a[href="/go/${m.articleId}"]`)).not.toBeNull();
      expect(entry.querySelector('form.feedback')!.getAttribute('action')).toBe(`/articles/${m.articleId}/feedback`);
      expect(entry.querySelectorAll('.fb')).toHaveLength(1);
      expect(entry.querySelector('.fb')!.getAttribute('data-type')).toBe('save');
      expect(entry.querySelector('.article-scores')!.textContent).toContain('Relevance');
      expect(entry.querySelector('.article-scores')!.textContent).toContain('Significance');
    }
    expect(document.querySelector('.timeline a[href="https://forum.example.org/item/1"]')).not.toBeNull();
    const member = story.members[1]!;
    const saved = await server.inject({ method: 'POST', url: `/articles/${member.articleId}/feedback`, headers: { accept: 'application/json' }, payload: { type: 'save' } });
    expect(saved.json().state.savedAt).not.toBeNull();
    const split = await server.inject({ method: 'POST', url: `/stories/${story.id}/split`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ articleIds: String(member.articleId) }).toString() });
    expect(split.statusCode).toBe(303);
    expect(app.stories.storyIdOf(member.articleId)).not.toBe(story.id);
  });

  it('waits for the matcher and resumes matching in order after a restart', async () => {
    const matcher = new FakeMatcher(['volcano']);
    matcher.configured = false;
    let app = await setup({ matcher });
    const dir = t!.dir;
    for (const item of [
      { guid: 'a', title: 'Volcano erupts near Akureyri', host: 'ruv.example.is', hoursAgo: 3 },
      { guid: 'b', title: 'Akureyri volcano eruption grounds flights', host: 'bbc.example.com', hoursAgo: 2 },
    ]) {
      srv!.serveFeed(`/${item.guid}`, () => rss([item]));
      await app.scheduler.fetchNow(app.sources.create({ name: item.host, url: srv!.url(`/${item.guid}`), pollIntervalSeconds: 600 }));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(app.stories.counts().active).toBe(0);
    expect(app.queue.counts().find((c) => c.kind === STORY_MATCH && c.status === 'pending')?.count).toBe(2);

    // Restart on the same database with the matcher available.
    await app.stop();
    app.db.close();
    const first = t!;
    const next = makeApp({
      classifier: new KeywordClassifier(),
      matcher: new FakeMatcher(['volcano']),
      dir,
      env: { SUMMARY_AUTO_ENABLED: 'false', STORY_MIN_SIMILARITY: '0.01' },
    });
    t = { ...next, cleanup: async () => { await next.cleanup(); await first.cleanup(); } };
    app = next.app;
    app.start();
    await waitFor(() => app.stories.counts().unassigned === 0);
    await idle();
    expect(storyOf('b').id).toBe(storyOf('a').id);
    expect(storyOf('a').articleCount).toBe(2);
  });

  it('brings a seen story back only when it has a meaningful new development', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'Volcano erupts near Grindavik', host: 'ruv.example.is', hoursAgo: 5 }]);
    await idle();
    const id = storyOf('a').id;
    expect(app.stories.item(id)).toMatchObject({ unseen: true, seenAt: null });
    expect(app.stories.list({ seen: 'unseen' }).items.map((i) => i.id)).toContain(id);

    expect(app.stories.markSeen(id)).toBe(true);
    expect(app.stories.item(id)!.unseen).toBe(false);
    expect(app.stories.list({ seen: 'unseen' }).items.map((i) => i.id)).not.toContain(id);
    expect(app.stories.list({ seen: 'seen' }).items.map((i) => i.id)).toContain(id);

    // More reporting of the same facts does not bring it back.
    await publish([{ guid: 'b', title: 'Grindavik volcano eruption seen from space', host: 'nasa.example.gov', hoursAgo: 4 }]);
    await idle();
    expect(app.stories.item(id)).toMatchObject({ articleCount: 2, developmentCount: 1, unseen: false });

    // A meaningful update does.
    await publish([{ guid: 'c', title: 'Volcano update: lava reaches Grindavik defences', host: 'ruv.example.is', hoursAgo: 1 }]);
    await idle();
    expect(app.stories.item(id)).toMatchObject({ developmentCount: 2, unseen: true });
    expect(app.stories.item(id)!.seenAt).not.toBeNull(); // distinguishes "updated" from "never seen"

    app.stories.markSeen(id);
    expect(app.stories.item(id)!.unseen).toBe(false);
    app.stories.markUnseen(id);
    expect(app.stories.item(id)).toMatchObject({ unseen: true, seenAt: null });
    expect(app.stories.markSeen(999_999)).toBe(false);
  });

  it('marks every unseen story matching a filter as seen, across pages', async () => {
    const app = await setup({ matcher: new FakeMatcher([]) });
    await publish([
      { guid: 'v1', title: 'Volcano erupts near Grindavik', host: 'a.example.com' },
      { guid: 'v2', title: 'Eruption forces evacuation of Vik', host: 'b.example.com' },
      { guid: 'low', title: 'Local council approves new parking rules', host: 'c.example.com' },
    ]);
    await idle();
    expect(app.stories.list({ minRelevance: 0.5 }).total).toBe(2);
    expect(app.stories.markSeenMatching({ minRelevance: 0.5, page: 2, pageSize: 1 })).toBe(2);
    expect(app.stories.list({ seen: 'unseen' }).items.map((i) => i.id)).toEqual([storyOf('low').id]);
    expect(app.stories.markSeenMatching({ minRelevance: 0.5 })).toBe(0); // already seen
  });

  it('lists a story\'s publishers with the first reporter first, then the rest by most recent coverage', async () => {
    const app = await setup({ matcher: new FakeMatcher(['volcano']) });
    server = buildServer(app);
    await server.ready();
    await publish([
      { guid: 'a', title: 'Volcano erupts near Grindavik', host: 'www.first.example.is', hoursAgo: 6 },
      { guid: 'b', title: 'Grindavik volcano eruption seen from space', host: 'old.example.gov', hoursAgo: 5 },
      { guid: 'c', title: 'Grindavik volcano eruption: what scientists say', host: 'recent.example.com', hoursAgo: 2 },
      { guid: 'd', title: 'Volcano update: lava reaches Grindavik defences', host: 'first.example.is', hoursAgo: 1 },
    ]);
    await idle();
    const story = storyOf('a');
    expect(story.articleCount).toBe(4);
    // www.first.example.is and first.example.is are one publisher; it reported first, so it leads even though others are older than its latest.
    expect(story.publishers.map((p) => [p.publisher, p.articles, p.origin])).toEqual([
      ['first.example.is', 2, true],
      ['recent.example.com', 1, false],
      ['old.example.gov', 1, false],
    ]);
    expect(story.publishers[0]!.articleId).toBe((app.db.prepare("SELECT id FROM articles WHERE guid = 'a'").get() as { id: number }).id);

    const page = (await server.inject({ url: '/?view=all' })).body;
    const row = page.match(/<div class="chip-row pubs"[\s\S]*?<\/div>/)![0];
    expect([...row.matchAll(/class="pub( origin)?\s*"[^>]*>([^<]+)/g)].map((m) => [m[2], !!m[1]])).toEqual([
      ['first.example.is', true],
      ['recent.example.com', false],
      ['old.example.gov', false],
    ]);
    expect(row).toContain('&times;2');
    expect(row).toContain(`href="/stories/${story.id}#a-${story.publishers[0]!.articleId}"`);
  });

  it('orders a story\'s topic tags by the importance of each topic in the profile, not by probability alone', async () => {
    const app = await setup({ matcher: new FakeMatcher([]) });
    server = buildServer(app);
    await server.ready();
    await publish([{ guid: 'a', title: 'Volcano erupts near Grindavik', host: 'a.example.com' }]);
    await idle();
    const id = storyOf('a').id;
    const topics = app.profiles.active().definition.topics;
    const prio = (t: string) => topics.find((x) => x.id === t)!.priority;
    expect([prio('ai-llm'), prio('security'), prio('economics')]).toEqual(['core', 'normal', 'low']);
    // The low-priority topic matches most strongly, the core topic least.
    app.db
      .prepare('UPDATE stories SET categories = ? WHERE id = ?')
      .run(
        JSON.stringify([
          { id: 'economics', label: 'Economics and business', probability: 0.95 },
          { id: 'security', label: 'Security and privacy', probability: 0.8 },
          { id: 'ai-llm', label: 'Artificial intelligence and LLMs', probability: 0.6 },
        ]),
        id,
      );
    const page = (await server.inject({ url: '/?view=all' })).body;
    const row = page.match(/<div class="chip-row tags-row"[\s\S]*?<\/div>/)![0];
    expect([...row.matchAll(/category=([a-z-]+)"/g)].map((m) => m[1])).toEqual(['ai-llm', 'security', 'economics']);
    expect(row).toContain('prio-core');
    expect(row).toContain('prio-low');
  });

  it('starts on relevant new stories, and lets the user mark them seen from the web interface', async () => {
    const app = await setup({ matcher: new FakeMatcher([]) });
    server = buildServer(app);
    await server.ready();
    await publish([
      { guid: 'v1', title: 'Volcano erupts near Grindavik', host: 'a.example.com' },
      { guid: 'v2', title: 'Eruption forces evacuation of Vik', host: 'b.example.com' },
      { guid: 'low', title: 'Local council approves new parking rules', host: 'c.example.com' },
    ]);
    await idle();
    const v1 = storyOf('v1').id;
    const v2 = storyOf('v2').id;
    const low = storyOf('low').id;
    const form = (data: Record<string, string>) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(data).toString(),
    });
    const get = async (url: string) => (await server!.inject({ url })).body;

    // The start page is the "relevant new" quick view; any explicit filter or view=all replaces it.
    const start = await get('/');
    expect(start).toContain(`href="/stories/${v1}"`);
    expect(start).toContain(`href="/stories/${v2}"`);
    expect(start).not.toContain(`href="/stories/${low}"`);
    expect(start).toMatch(/class="qv active"[^>]*>\s*Relevant new/);
    expect(start).toContain('Filters <span class="muted">&middot; 4 active</span>'); // the preset is visible in the filter box
    expect(start).toContain('Mark all 2 as seen');
    expect(await get('/?view=all')).toContain(`href="/stories/${low}"`);
    expect(await get('/?sort=priority')).toContain(`href="/stories/${low}"`);
    expect(await get('/?flash=hello')).not.toContain(`href="/stories/${low}"`);

    // JSON: mark one seen; it leaves the start page and appears under Seen.
    const json = await server.inject({
      method: 'POST',
      url: `/stories/${v1}/seen`,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      payload: { state: 'seen' },
    });
    expect(json.json()).toEqual({ ok: true, unseen: false, relevantNew: 1 });
    expect(await get('/')).not.toContain(`href="/stories/${v1}"`);
    expect(await get(`/?seen=seen&sort=latest`)).toContain(`href="/stories/${v1}"`);
    expect(await get(`/stories/${v1}`)).toContain('aria-pressed="true"');

    // Form post (no JavaScript): undo, then redirect back.
    const undo = await server.inject({ method: 'POST', url: `/stories/${v1}/seen`, ...form({ state: 'unseen' }) });
    expect(undo.statusCode).toBe(303);
    expect(app.stories.item(v1)!.unseen).toBe(true);
    expect((await server.inject({ method: 'POST', url: '/stories/999999/seen', ...form({ state: 'seen' }) })).statusCode).toBe(404);

    // Mark all matching the current view; the page then says there is nothing left.
    const all = await server.inject({ method: 'POST', url: '/stories/seen-all', ...form({ query: 'min=70&sort=latest&seen=unseen&days=7' }) });
    expect(all.statusCode).toBe(303);
    expect(all.headers.location).toContain('flash=Marked%202%20stories%20as%20seen');
    expect(app.stories.item(v1)!.unseen || app.stories.item(v2)!.unseen).toBe(false);
    expect(app.stories.item(low)!.unseen).toBe(true);
    expect(await get('/')).toContain('all caught up');
  });
});
