import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import type { MatchArticle, MatchCandidate, MatchJudgement, LevelAnswer, StoryMatcher } from '../src/stories/matcher.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
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

describe('the rewrite button in the brief card', () => {
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

  /** The arrow in the head of the brief card. */
  function rewrite(body: string) {
    const { document } = parseHTML(body);
    const form = document.querySelector('form.rewrite-form');
    if (!form) return null;
    const button = form.querySelector('button')!;
    const head = form.closest('.panel-head');
    return {
      form,
      button,
      icon: button.querySelector('.rewrite-icon')?.textContent ?? null,
      action: form.getAttribute('action'),
      label: button.getAttribute('aria-label'),
      stale: button.classList.contains('stale'),
      inBriefCard: !!head && !!head.closest('.summary-panel'),
      inStoryHeader: !!form.closest('header'),
      bordered: button.className.includes('bordered'),
    };
  }

  it('sits in the brief card once there is a brief', async () => {
    const storyId = await setup();
    expect(rewrite((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body)).toBeNull();

    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);

    const button = rewrite((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body)!;
    expect(button).not.toBeNull();
    expect(button.icon).toBe('↻');
    expect(button.action).toBe(`/stories/${storyId}/summary`);
    expect(button.label).toMatch(/rewrite/i);
    expect(button.stale).toBe(false);
  });

  it('belongs to the brief, not to the story', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);

    const button = rewrite((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body)!;
    expect(button.inBriefCard).toBe(true);
    expect(button.inStoryHeader).toBe(false);
  });

  it('is a plain glyph, without a circle around it', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);

    const { document } = parseHTML((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body);
    const button = document.querySelector('form.rewrite-form button')!;
    expect(button.getAttribute('style')).toBeNull();
    expect(button.querySelectorAll('*').length).toBe(1);

    // The stylesheet gives it the same bare look as the check that marks a story seen:
    // no border, no round shape, no background.
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    const rule = css.match(/\.rewrite-btn\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/border:\s*0/);
    expect(rule).toMatch(/border-radius:\s*0/);
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).not.toMatch(/border-radius:\s*999px/);
  });

  it('keeps the plain button for a brief that is not there yet', async () => {
    const storyId = await setup();

    const { document } = parseHTML((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body);
    const panel = [...document.querySelectorAll('section.panel')].find((p) => p.querySelector('h3')?.textContent === 'Story Intelligence Brief')!;
    const labels = [...panel.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(labels.some((l) => /write the brief/i.test(l))).toBe(true);
    expect(document.querySelector('form.rewrite-form')).toBeNull();
  });

  it('says the brief is outdated', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);
    t!.app.db.prepare('UPDATE stories SET summary_stale = 1 WHERE id = ?').run(storyId);

    const button = rewrite((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body)!;
    expect(button.stale).toBe(true);
    expect(button.label).toMatch(/outdated/i);
  });

  it('writes the brief from the arrow', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);
    const before = t!.app.stories.get(storyId)!.summary!.revision;

    const res = await server!.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/summary`,
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => (t!.app.stories.get(storyId)!.summary?.revision ?? 0) > before);
  });

  it('has no arrow while the brief is being written', async () => {
    const storyId = await setup();
    t!.app.storyPipeline.requestSummary(storyId);
    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);
    t!.app.stories.setSummaryRequest(storyId, 'running');

    const { document } = parseHTML((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body);
    expect(document.querySelector('form.rewrite-form')).toBeNull();
    // The panel says that the brief is being written, and the counter counts it.
    expect(document.querySelector('.summary-panel .badge')!.textContent).toContain('Writing');
  });
});
