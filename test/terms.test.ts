import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { parseTerms, prepareTermsPrompt, TermsValidationError } from '../src/terms/terms.js';
import { termKey } from '../src/terms/schema.js';
import { MockTermsProvider } from '../src/terms/mock.js';
import { Wikipedia, type Encyclopedia, type TermArticle } from '../src/terms/wikipedia.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
import type { MatchArticle, MatchCandidate, MatchJudgement, LevelAnswer, StoryMatcher } from '../src/stories/matcher.js';
import { buildServer } from '../src/web/server.js';
import { FeedServer, makeApp, waitFor, type TestApp } from './helpers.js';

interface Item {
  guid: string;
  title: string;
  host: string;
  description?: string;
  hoursAgo?: number;
}

function rss(items: Item[]): string {
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Wire</title><link>https://wire.example.com/</link>
    ${items
      .map(
        (i) => `<item><title>${i.title}</title><link>https://${i.host}/${i.guid}</link><guid isPermaLink="false">${i.guid}</guid>
      <pubDate>${new Date(now - (i.hoursAgo ?? 1) * 3_600_000).toUTCString()}</pubDate><description>${i.description ?? i.title}</description></item>`,
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

/** Same story when the article and the story share a marker word. */
class StubMatcher implements StoryMatcher {
  readonly name = 'stub-matcher';
  readonly version = 'stub-matcher/1';
  calls = 0;
  constructor(private readonly markers: string[] = []) {}
  isConfigured() {
    return true;
  }
  configurationHint() {
    return null;
  }
  async judge(article: MatchArticle, candidates: MatchCandidate[]): Promise<MatchJudgement> {
    this.calls++;
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

/** An encyclopedia that answers from a list, and counts what it was asked. */
class FakeEncyclopedia implements Encyclopedia {
  calls: { name: string; hint: string | null }[] = [];
  articles: Record<string, TermArticle> = {};
  async lookup(name: string, hint?: string | null): Promise<TermArticle | null> {
    this.calls.push({ name, hint: hint ?? null });
    return this.articles[name] ?? null;
  }
}

const COHERE: TermArticle = {
  title: 'Cohere',
  description: 'Canadian artificial intelligence company',
  extract: 'Cohere is a Canadian artificial intelligence company. It offers a platform for building applications on large language models.',
  url: 'https://en.wikipedia.org/wiki/Cohere',
};

describe('the term prompt', () => {
  it('reads the terms out of the answer', () => {
    const terms = parseTerms(
      JSON.stringify({
        terms: [{ name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company the story is about', sources: [3, 4] }],
      }),
      new Set([3, 4, 5]),
    );
    expect(terms).toEqual([
      { name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company the story is about', sources: [3, 4] },
    ]);
  });

  it('drops a term that cites an article it was not given', () => {
    const terms = parseTerms(
      JSON.stringify({ terms: [{ name: 'Cohere', kind: 'organisation', sources: [9] }] }),
      new Set([3]),
    );
    expect(terms).toEqual([]);
  });

  it('refuses an answer that is not the expected shape', () => {
    expect(() => parseTerms('{"nothing": true}', new Set([3]))).toThrow(TermsValidationError);
    expect(() => parseTerms('not json at all', new Set([3]))).toThrow(TermsValidationError);
  });

  it('lists a term once, even when the model says it twice', () => {
    const terms = parseTerms(
      JSON.stringify({
        terms: [
          { name: 'Cohere', kind: 'organisation', sources: [3] },
          { name: ' cohere ', kind: 'organisation', sources: [4] },
        ],
      }),
      new Set([3, 4]),
    );
    expect(terms).toHaveLength(1);
    expect(termKey('Cohere')).toBe(termKey(' cohere '));
  });

  it('asks for the terms, and for the title of their article', () => {
    const prompt = prepareTermsPrompt(
      { id: 1, headline: 'Cohere raises a round', firstPublishedAt: null, latestDevelopmentAt: null, articleCount: 1, publisherCount: 1 },
      [
        {
          id: 3,
          role: 'origin',
          source: 'wire',
          publisher: 'wire',
          occurredAt: '2026-10-01T00:00:00.000Z',
          title: 'Cohere raises a round',
          summaryText: 'Cohere raises a round',
          contentText: 'Cohere raises a round',
          contentQuality: 'full',
          contentHash: 'h',
          significance: 0.5,
        },
      ],
      { maxInputChars: 4000, language: 'English' },
    );
    expect(prompt.system).toMatch(/"terms"/);
    expect(prompt.system).toMatch(/"wiki"/);
    expect(prompt.user).toContain('Cohere raises a round');
    expect(prompt.articles.map((a) => a.articleId)).toEqual([3]);
    expect(prompt.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the encyclopedia', () => {
  function fake(
    summaries: Record<string, unknown>,
    search?: unknown,
  ): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname.startsWith('/api/rest_v1/page/summary/')) {
        const title = decodeURIComponent(url.pathname.slice('/api/rest_v1/page/summary/'.length)).replace(/_/g, ' ');
        const body = summaries[title];
        if (body == null) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/w/api.php') {
        return new Response(JSON.stringify(search ?? { query: { search: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  function wiki(fetchImpl: typeof fetch): Wikipedia {
    return new Wikipedia({ baseUrl: 'https://en.wikipedia.org', userAgent: 'Mimir/test', timeoutMs: 1000, minIntervalMs: 0, fetchImpl });
  }

  it('finds a term and says what it is', async () => {
    const { fetchImpl, calls } = fake({
      Cohere: {
        title: 'Cohere',
        description: 'Canadian artificial intelligence company',
        extract: 'Cohere is a Canadian artificial intelligence company. It builds applications on large language models.',
        type: 'standard',
        titles: { canonical: 'Cohere' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Cohere' } },
      },
    });
    const article = await wiki(fetchImpl).lookup('Cohere');
    expect(article).toMatchObject({
      title: 'Cohere',
      description: 'Canadian artificial intelligence company',
      url: 'https://en.wikipedia.org/wiki/Cohere',
    });
    expect(article!.extract).toMatch(/Canadian artificial intelligence company/);
    expect(calls[0]).toContain('/api/rest_v1/page/summary/Cohere');
  });

  it('takes the title the model gave first', async () => {
    const { fetchImpl, calls } = fake({
      'Sandbox (software development)': {
        title: 'Sandbox (software development)',
        description: 'Software development in a controlled environment',
        extract: 'A sandbox is an environment in which new code is executed.',
        titles: { canonical: 'Sandbox (software development)' },
      },
    });
    const article = await wiki(fetchImpl).lookup('Sandbox', 'Sandbox (software development)');
    expect(article!.title).toBe('Sandbox (software development)');
    expect(calls[0]).toContain('Sandbox_(software_development)');
  });

  it('refuses a redirect that leads to another thing entirely', async () => {
    const { fetchImpl } = fake({
      Sandbox: {
        title: 'Sandpit',
        description: 'A low, wide container',
        extract: 'A sandpit or sandbox is a low, wide container in which children can play.',
        titles: { canonical: 'Sandpit' },
      },
    });
    expect(await wiki(fetchImpl).lookup('Sandbox')).toBeNull();
  });

  it('follows a redirect to the article that introduces the name', async () => {
    const { fetchImpl } = fake({
      FBI: {
        title: 'Federal Bureau of Investigation',
        description: 'Federal law enforcement agency',
        extract: 'The Federal Bureau of Investigation (FBI) is the principal federal law enforcement agency of the United States.',
        titles: { canonical: 'Federal Bureau of Investigation' },
      },
    });
    const article = await wiki(fetchImpl).lookup('FBI');
    expect(article!.title).toBe('Federal Bureau of Investigation');
  });

  it('refuses a page that only lists several meanings', async () => {
    const { fetchImpl } = fake({
      Sandbox: { title: 'Sandbox', type: 'disambiguation', extract: 'Sandbox may refer to:' },
    });
    expect(await wiki(fetchImpl).lookup('Sandbox')).toBeNull();
  });

  it('takes a search hit only when its title carries the name', async () => {
    const { fetchImpl, calls } = fake(
      {
        'CTI-REALM (protocol)': {
          title: 'CTI-REALM (protocol)',
          description: 'A protocol for sharing threat intelligence',
          extract: 'CTI-REALM is a protocol for sharing threat intelligence between organisations.',
          titles: { canonical: 'CTI-REALM (protocol)' },
        },
      },
      { query: { search: [{ title: 'Coral reef' }, { title: 'CTI-REALM (protocol)' }] } },
    );
    const article = await wiki(fetchImpl).lookup('CTI-REALM');
    expect(article!.title).toBe('CTI-REALM (protocol)');
    expect(calls.some((c) => c.includes('/w/api.php'))).toBe(true);
  });

  it('refuses a search hit about something else', async () => {
    const { fetchImpl } = fake({}, { query: { search: [{ title: 'Coral reef' }] } });
    expect(await wiki(fetchImpl).lookup('CTI-REALM')).toBeNull();
  });

  it('says so when the encyclopedia cannot answer', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(wiki(fetchImpl).lookup('Cohere')).rejects.toThrow(/503/);
  });
});

describe('the terms of a story', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    await server?.close();
    await t?.cleanup();
    await srv?.stop();
    t = srv = server = null;
  });

  async function setup(opts: { summaries?: MockSummaryProvider; terms?: MockTermsProvider; encyclopedia?: FakeEncyclopedia } = {}) {
    srv = new FeedServer();
    await srv.start();
    t = makeApp({
      classifier: new StubClassifier(),
      matcher: new StubMatcher(['cohere']),
      summaries: opts.summaries,
      terms: opts.terms ?? new MockTermsProvider(),
      wikipedia: opts.encyclopedia ?? new FakeEncyclopedia(),
      env: { SUMMARY_AUTO_ENABLED: 'false', STORY_MIN_SIMILARITY: '0.01' },
    });
    t.app.start();
    return t.app;
  }

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

  const storyOf = (guid: string) => {
    const app = t!.app;
    const id = (app.db.prepare('SELECT id FROM articles WHERE guid = ?').get(guid) as { id: number }).id;
    return app.stories.get(app.stories.storyIdOf(id)!)!;
  };

  const briefWithTerms = () =>
    new MockSummaryProvider('ok', 0, [], [{ name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company' }]);

  it('takes the terms from the brief it was written with, and asks the model no more', async () => {
    const summaries = briefWithTerms();
    const terms = new MockTermsProvider();
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries, terms, encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');

    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(terms.calls).toBe(0); // the brief named them; the model was not asked again
    expect(encyclopedia.calls).toEqual([{ name: 'Cohere', hint: 'Cohere' }]);
    expect(s.terms.map((x) => x.name)).toEqual(['Cohere']);
    expect(s.terms[0]).toMatchObject({
      status: 'explained',
      kind: 'organisation',
      description: 'Canadian artificial intelligence company',
      sourceName: 'Wikipedia',
      sourceUrl: 'https://en.wikipedia.org/wiki/Cohere',
    });
    expect(s.terms[0]!.summary).toMatch(/Canadian artificial intelligence company/);
  });

  it('names the terms itself when the brief names none', async () => {
    const terms = new MockTermsProvider('ok', [{ name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company' }], 0);
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: new MockSummaryProvider(), terms, encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    expect(story.termsState).toBe('none');

    expect(app.storyPipeline.requestTerms(story.id).queued).toBe(true);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(terms.calls).toBe(1);
    expect(s.terms.map((x) => x.name)).toEqual(['Cohere']);
    expect(s.terms[0]!.status).toBe('explained');
  });

  it('explains a term the encyclopedia does not know, from the articles', async () => {
    const terms = new MockTermsProvider();
    const encyclopedia = new FakeEncyclopedia(); // it knows nothing
    const app = await setup({ summaries: briefWithTerms(), terms, encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');

    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(terms.calls).toBe(1); // the model was asked to explain it
    expect(s.terms[0]).toMatchObject({ status: 'explained', sourceName: 'Mimir, from the articles' });
    expect(s.terms[0]!.summary).toMatch(/Cohere is what the articles are about/);
  });

  it('asks the encyclopedia once for a term it already knows', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    app.storyPipeline.requestSummary(storyOf('a').id);
    await waitFor(() => app.stories.get(storyOf('a').id)!.termsState === 'ready');
    expect(encyclopedia.calls).toHaveLength(1);

    await publish([{ guid: 'b', title: 'A new model arrives', host: 'wire.example.com' }]);
    expect(storyOf('b').id).not.toBe(storyOf('a').id);
    app.storyPipeline.requestSummary(storyOf('b').id);
    await waitFor(() => app.stories.get(storyOf('b').id)!.termsState === 'ready');
    // The term is in the glossary already, so the encyclopedia is not asked again.
    expect(encyclopedia.calls).toHaveLength(1);
    expect(app.stories.get(storyOf('b').id)!.terms[0]!.summary).toMatch(/Canadian artificial intelligence company/);
  });

  it('marks the terms in the brief and lists them on the story page', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    expect(page.statusCode).toBe(200);
    const { document } = parseHTML(page.body);
    const button = document.querySelector('button.term[data-term-key="cohere"]');
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe('Cohere');
    expect(button!.getAttribute('title')).toMatch(/Canadian artificial intelligence company/);
    expect(document.querySelector('.terms-panel .term-list')!.textContent).toContain('Cohere');
    expect(document.querySelector('[data-story-action="terms"]')).not.toBeNull();
  });

  it('answers with the explanation of a term', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    server = buildServer(app);
    const res = await server.inject({ method: 'GET', url: '/api/terms/cohere' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      key: 'cohere',
      name: 'Cohere',
      kind: 'organisation',
      status: 'explained',
      sourceName: 'Wikipedia',
      sourceUrl: 'https://en.wikipedia.org/wiki/Cohere',
    });
    expect(body.summary).toMatch(/Canadian artificial intelligence company/);

    const missing = await server.inject({ method: 'GET', url: '/api/terms/nothing-here' });
    expect(missing.statusCode).toBe(404);
  });

  it('queues a lookup when the reader asks for the terms', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    server = buildServer(app);
    const res = await server.inject({ method: 'POST', url: `/stories/${story.id}/terms` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('/stories/');
    await waitFor(() => app.stories.get(story.id)!.termsState !== 'none');
  });

  it('offers the glossary of everything Mimir knows', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: '/terms' });
    expect(page.statusCode).toBe(200);
    const { document } = parseHTML(page.body);
    expect(document.body.textContent).toContain('Cohere');
    expect(document.body.textContent).toContain('Canadian artificial intelligence company');
  });
});
