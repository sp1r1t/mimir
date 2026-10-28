import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import type { MatchArticle, MatchCandidate, MatchJudgement, LevelAnswer, StoryMatcher } from '../src/stories/matcher.js';
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

/** A classifier that answers the same way for every article. */
class StubClassifier implements Classifier {
  readonly name = 'stub';
  readonly version = 'stub/1';
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
      model: 'stub-model-1',
      inputHash: this.inputHash(a, p),
      categories: [],
      personalRelevance: 0.8,
      significance: 0.7,
      urgency: 0.5,
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

/** Every article is its own story, unless the titles share a marker word. */
class StubMatcher implements StoryMatcher {
  readonly name = 'stub-matcher';
  readonly version = 'stub-matcher/1';
  constructor(private readonly markers: string[] = []) {}
  isConfigured() {
    return true;
  }
  configurationHint() {
    return null;
  }
  async judge(article: MatchArticle, candidates: MatchCandidate[]): Promise<MatchJudgement> {
    const marker = this.markers.find((m) => article.title?.toLowerCase().includes(m));
    const shares = (c: MatchCandidate) => !!marker && c.reports.some((r) => r.title?.toLowerCase().includes(marker));
    const level = (n: number): LevelAnswer => ({ score: n, level: n, confidence: 0.9, probabilities: {} });
    return {
      model: 'stub',
      candidates: candidates.map((c) => ({
        storyId: c.storyId,
        same: level(shares(c) ? 2 : 0),
        update: level(/\bupdate\b|confirmed/i.test(article.title ?? '') ? 2 : 0),
      })),
      rawRequest: {},
      rawResponse: {},
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
  }
}

describe('saving a story', () => {
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
      classifier: new StubClassifier(),
      matcher: new StubMatcher(),
      env: { SUMMARY_AUTO_ENABLED: 'false', STORY_MIN_SIMILARITY: '0.01' },
    });
    t.app.start();
    server = buildServer(t.app);
    await server.ready();
    return t.app;
  }

  /** Publish one article, which becomes one story. */
  async function publish(guid: string, title: string) {
    const app = t!.app;
    srv!.serveFeed(`/${guid}`, () => rss([{ guid, title, host: `${guid}.example.is` }]));
    const source = app.sources.create({ name: `${guid}.example.is`, url: srv!.url(`/${guid}`), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(source);
    const id = (app.db.prepare('SELECT id FROM articles WHERE guid = ?').get(guid) as { id: number }).id;
    await waitFor(() => app.stories.storyIdOf(id) != null);
    return app.stories.storyIdOf(id)!;
  }

  /** The save button on the story page. */
  function saveButton(body: string) {
    const { document } = parseHTML(body);
    const form = document.querySelector('form.story-save');
    expect(form).not.toBeNull();
    const button = form!.querySelector('button.fb')!;
    return { form: form!, button, action: form!.getAttribute('action')! };
  }

  it('keeps the story and shows it as saved', async () => {
    const app = await setup();
    const storyId = await publish('a', 'A volcano erupts near Reykjavik');

    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    const before = saveButton(page.body);
    expect(before.button.getAttribute('value')).toBe('save');
    expect(before.button.querySelector('.fb-icon')!.textContent).toBe('☆');

    const saved = await server!.inject({ method: 'POST', url: `/stories/${storyId}/save`, payload: { type: 'save' } });
    expect(saved.statusCode).toBe(303);

    const after = saveButton((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body);
    expect(after.button.getAttribute('value')).toBe('unsave');
    expect(after.button.querySelector('.fb-icon')!.textContent).toBe('★');
    expect(after.button.getAttribute('aria-pressed')).toBe('true');
    expect(app.stories.get(storyId)!.savedAt).not.toBeNull();
  });

  it('lets the story go again', async () => {
    const app = await setup();
    const storyId = await publish('a', 'A volcano erupts near Reykjavik');
    app.stories.markSaved(storyId);

    await server!.inject({ method: 'POST', url: `/stories/${storyId}/save`, payload: { type: 'unsave' } });
    expect(app.stories.get(storyId)!.savedAt).toBeNull();
    const button = saveButton((await server!.inject({ method: 'GET', url: `/stories/${storyId}` })).body).button;
    expect(button.getAttribute('value')).toBe('save');
    expect(button.querySelector('.fb-icon')!.textContent).toBe('☆');
  });

  it('answers the api with the moment of the save', async () => {
    const app = await setup();
    const storyId = await publish('a', 'A volcano erupts near Reykjavik');

    const res = await server!.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/save`,
      payload: { type: 'save' },
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; state: { savedAt: string | null } };
    expect(body.ok).toBe(true);
    expect(body.state.savedAt).toBe(app.stories.get(storyId)!.savedAt);
    expect(body.state.savedAt).not.toBeNull();
  });

  it('says no when the story is not there', async () => {
    await setup();
    const res = await server!.inject({
      method: 'POST',
      url: `/api/stories/9999/save`,
      payload: { type: 'save' },
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists only the saved stories when the reader asks for them', async () => {
    const app = await setup();
    const first = await publish('a', 'A volcano erupts near Reykjavik');
    await publish('b', 'A new model arrives');

    await server!.inject({ method: 'POST', url: `/stories/${first}/save`, payload: { type: 'save' } });

    const saved = await server!.inject({ method: 'GET', url: '/?saved=saved' });
    expect(saved.statusCode).toBe(200);
    const { document } = parseHTML(saved.body);
    const cards = [...document.querySelectorAll('article.card.story')];
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-story')).toBe(String(first));

    const all = await server!.inject({ method: 'GET', url: '/?view=all' });
    expect(parseHTML(all.body).document.querySelectorAll('article.card.story')).toHaveLength(2);
    expect(app.stories.list({ saved: 'saved' }).total).toBe(1);
    expect(app.stories.list({ saved: 'unsaved' }).total).toBe(1);
  });

  it('shows a star on every story card', async () => {
    await setup();
    const storyId = await publish('a', 'A volcano erupts near Reykjavik');

    const page = await server!.inject({ method: 'GET', url: '/?view=all' });
    const { document } = parseHTML(page.body);
    const card = document.querySelector(`article.card.story[data-story="${storyId}"]`)!;
    const star = card.querySelector('form.story-save button.fb')!;
    expect(star).not.toBeNull();
    expect(star.getAttribute('value')).toBe('save');
    expect(star.querySelector('.fb-icon')!.textContent).toBe('☆');
  });
});
