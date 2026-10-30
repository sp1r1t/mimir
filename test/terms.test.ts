import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import { loadConfig } from '../src/config.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { dropFragmentTerms, parseTerms, prepareTermsPrompt, TermsValidationError } from '../src/terms/terms.js';
import { termKey, type FoundTerm } from '../src/terms/schema.js';
import { MockTermsProvider } from '../src/terms/mock.js';
import { Wikipedia, type Encyclopedia, type TermArticle } from '../src/terms/wikipedia.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
import type { MatchArticle, MatchCandidate, MatchJudgement, LevelAnswer, StoryMatcher } from '../src/stories/matcher.js';
import { buildServer } from '../src/web/server.js';
import { markTerms, markingTerms, type MarkableTerm } from '../src/web/terms.js';
import { countWords, ordinaryNames } from '../src/terms/vocabulary.js';
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

  it('takes a search hit whose title does not carry the name', async () => {
    // "A2A" is an Italian utility; the protocol the story means is written "Agent2Agent".
    const { fetchImpl } = fake(
      {
        Agent2Agent: {
          title: 'Agent2Agent',
          description: 'Open protocol for communication between AI agents',
          extract: 'Agent2Agent (A2A) is an open protocol that defines how artificial intelligence agents communicate.',
          titles: { canonical: 'Agent2Agent' },
        },
      },
      { query: { search: [{ title: 'A2A' }, { title: 'Agent2Agent' }] } },
    );
    const article = await wiki(fetchImpl).lookup('A2A');
    expect(article!.title).toBe('Agent2Agent');
  });

  it('takes the article that carries the legal suffix of a company', async () => {
    const { fetchImpl } = fake({
      Okta: {
        title: 'Okta, Inc.',
        description: 'American information technology company',
        extract: 'Okta, Inc. is an American identity and access management company based in San Francisco.',
        titles: { canonical: 'Okta, Inc.' },
      },
    });
    const article = await wiki(fetchImpl).lookup('Okta');
    expect(article!.title).toBe('Okta, Inc.');
  });

  it('answers with the article it has, when none of them fits the note', async () => {
    // The story means Chromium's WebGPU; the encyclopedia has the hour before sunrise.
    // The note the story made is what tells the two apart, so it is handed on.
    const { fetchImpl } = fake({
      Dawn: {
        title: 'Dawn',
        description: 'Time that marks the beginning of twilight before sunrise',
        extract: 'Dawn is the time that marks the beginning of twilight before sunrise.',
        titles: { canonical: 'Dawn' },
      },
    });
    const article = await wiki(fetchImpl).lookup('Dawn', null, "Chromium's WebGPU implementation for inference");
    expect(article!.title).toBe('Dawn');
  });

  it('says so when the encyclopedia cannot answer', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(wiki(fetchImpl).lookup('Cohere')).rejects.toThrow(/503/);
  });

  it('waits when the encyclopedia says to come back later', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(
        JSON.stringify({
          title: 'Cohere',
          description: 'Canadian artificial intelligence company',
          extract: 'Cohere is a Canadian artificial intelligence company.',
          type: 'standard',
          titles: { canonical: 'Cohere' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const article = await wiki(fetchImpl).lookup('Cohere');
    expect(article!.title).toBe('Cohere');
    expect(calls).toBe(2);
  });

  it('gives up when the encyclopedia keeps saying to come back later', async () => {
    const fetchImpl = (async () =>
      new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } })) as typeof fetch;
    await expect(wiki(fetchImpl).lookup('Cohere')).rejects.toThrow(/429/);
  });

  it('asks in a way that says who is asking', () => {
    // Wikipedia's edge answers 429 to a User-Agent that carries no address, whatever
    // the gap between the requests is.
    const { userAgent } = loadConfig({}).terms.wikipedia;
    expect(userAgent).toMatch(/https?:\/\/\S+/)
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

  it('drops a term the articles only name inside another word', async () => {
    // The brief names "ICE", but the articles only say "office".
    const summaries = new MockSummaryProvider('ok', 0, [], [
      { name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company' },
      { name: 'ICE', kind: 'acronym', wiki: 'ICE', role: 'the agency' },
    ]);
    const terms = new MockTermsProvider();
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries, terms, encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere met in the Barcelona office', host: 'wire.example.com', description: 'Cohere met in the Barcelona office.' }]);
    const story = storyOf('a');

    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(s.terms.map((x) => x.name)).toEqual(['Cohere']);
    expect(encyclopedia.calls.map((c) => c.name)).not.toContain('ICE');
  });

  it('lets a story go of a term that turns out not to be a term', async () => {
    // The brief names "ICE", but the articles only say "office".
    const summaries = new MockSummaryProvider('ok', 0, [], [
      { name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company' },
      { name: 'ICE', kind: 'acronym', wiki: 'ICE', role: 'the agency' },
    ]);
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries, terms: new MockTermsProvider(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere met in the Barcelona office', host: 'wire.example.com', description: 'Cohere met in the Barcelona office.' }]);
    const story = storyOf('a');

    // An earlier run had linked the story to ICE.
    app.stories.saveTerms(story.id, [{ name: 'ICE', kind: 'acronym', wiki: 'ICE', role: 'the agency', sources: [1] }]);
    expect(app.stories.termsOf(story.id).map((t) => t.name)).toEqual(['ICE']);

    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    expect(app.stories.termsOf(story.id).map((t) => t.name)).toEqual(['Cohere']);
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

  it('explains a term from the articles when the encyclopedia answered about another thing', async () => {
    // The encyclopedia answered with the article about the Italian utility, and the
    // model, which has read the articles, says that is not what the story means.
    const summaries = new MockSummaryProvider('ok', 0, [], [
      { name: 'A2A', kind: 'acronym', wiki: 'A2A', role: 'protocol for agents to talk to each other' },
    ]);
    const terms = new MockTermsProvider('ok', [], 0, { A2A: false });
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['A2A'] = {
      title: 'A2A',
      description: 'Italian utilities company',
      extract: 'A2A is an Italian multi-utility company registered in Brescia.',
      url: 'https://en.wikipedia.org/wiki/A2A',
    };
    const app = await setup({ summaries, terms, encyclopedia });
    await publish([{ guid: 'a', title: 'The agent protocol arrives', host: 'wire.example.com' }]);
    const story = storyOf('a');

    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(s.terms[0]).toMatchObject({ status: 'explained', sourceName: 'Mimir, from the articles' });
    expect(s.terms[0]!.description).toBeNull();
    expect(s.terms[0]!.summary).toMatch(/A2A is what the articles are about/);
  });

  it('explains one term again when the reader says the explanation is wrong', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');
    expect(encyclopedia.calls).toHaveLength(1);

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    expect(page.statusCode).toBe(200);
    const { document } = parseHTML(page.body);
    expect(document.querySelector('.terms-panel form[action$="/terms/cohere"]')).not.toBeNull();

    const res = await server.inject({ method: 'POST', url: `/stories/${story.id}/terms/cohere` });
    expect(res.statusCode).toBe(303);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');
    // The term was put back on the shelf, and the encyclopedia was asked about it again.
    expect(encyclopedia.calls).toHaveLength(2);
    expect(app.stories.get(story.id)!.terms[0]!.summary).toMatch(/Canadian artificial intelligence company/);
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

  it('folds the terms away, after the timeline', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    const { document } = parseHTML(page.body);
    const panel = document.querySelector('details.terms-panel');
    expect(panel).not.toBeNull();
    // Folded away: the reader opens it when they want it.
    expect(panel!.hasAttribute('open')).toBe(false);
    // After the timeline: the story is what the reader came for.
    const panels = [...document.querySelectorAll('.story-detail > section, .story-detail > details')];
    const timeline = panels.findIndex((p) => p.querySelector('.timeline'));
    const terms = panels.findIndex((p) => p.classList.contains('terms-panel'));
    expect(timeline).toBeGreaterThanOrEqual(0);
    expect(terms).toBeGreaterThan(timeline);
  });

  it('folds the timeline away, and leaves the brief standing', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.summary != null);

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    const { document } = parseHTML(page.body);
    // The timeline is a long list: it folds away.
    const timeline = document.querySelector('details.timeline-panel');
    expect(timeline).not.toBeNull();
    expect(timeline!.hasAttribute('open')).toBe(false);
    // The brief is the story itself: it stands open, and can be folded away.
    const brief = document.querySelector('details.summary-panel');
    expect(brief).not.toBeNull();
    expect(brief!.hasAttribute('open')).toBe(true);
  });

  it('keeps the links of a term on one line', async () => {
    const encyclopedia = new FakeEncyclopedia();
    encyclopedia.articles['Cohere'] = COHERE;
    const app = await setup({ summaries: briefWithTerms(), encyclopedia });
    await publish([{ guid: 'a', title: 'Cohere raises a round', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestSummary(story.id);
    await waitFor(() => app.stories.get(story.id)!.termsState === 'ready');

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    const { document } = parseHTML(page.body);
    // The source, the articles it comes from and the button stand together in one row:
    // each of them on a line of its own takes the room of a small screen.
    const links = document.querySelector('.terms-panel .term-links');
    expect(links).not.toBeNull();
    expect(links!.querySelector('.term-source')).not.toBeNull();
    expect(links!.querySelector('form')).not.toBeNull();
    expect(links!.parentElement!.classList.contains('term-entry')).toBe(true);
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

describe('a name that stands for two things', () => {
  const PT = { key: 'pt', name: 'PT', description: "Lula's Workers' Party", summary: null };
  const CNN = { key: 'cnn', name: 'CNN', description: 'A convolutional neural network', summary: null };
  const CUBE = { key: 'cube', name: 'Cube', description: "Roblox's generative system", summary: null };

  /** The terms that were marked in a text, with the text that was marked. */
  function marked(text: string, terms: MarkableTerm[]): string[] {
    const { document } = parseHTML(`<body>${markTerms(text, terms).value}</body>`);
    return [...document.querySelectorAll('button.term')].map((b) => b.textContent ?? '');
  }

  it('marks the name where the words of its reading stand near it', () => {
    const glossary = markingTerms([PT], []);
    expect(marked('Die linken Arbeiterpartei PT von Lula hat den Etat vorgelegt.', glossary)).toEqual(['PT']);
    expect(marked('The Workers Party PT won the vote in Brazil.', glossary)).toEqual(['PT']);
  });

  it('does not mark the name where its reading is not meant', () => {
    const glossary = markingTerms([PT], []);
    // The Pacific time zone is not the party.
    expect(marked('The call starts at 3 PM PT.', glossary)).toEqual([]);
  });

  it('marks the name in the story that named it, whatever the text around it says', () => {
    const glossary = markingTerms([PT], [PT]);
    expect(marked('The call starts at 3 PM PT.', glossary)).toEqual(['PT']);
  });

  it('tells a neural network from a television channel', () => {
    const glossary = markingTerms([CNN], []);
    expect(marked('The CNN layers are trained on MNIST.', glossary)).toEqual(['CNN']);
    expect(marked('CNN reported from Washington on Tuesday.', glossary)).toEqual([]);
  });

  it('matches a name with two readings as it is written', () => {
    const glossary = markingTerms([CUBE], []);
    // The solid with six faces is written in lower case.
    expect(marked('The cube has six faces.', glossary)).toEqual([]);
    expect(marked('Roblox Cube makes 3D content.', glossary)).toEqual(['Cube']);
  });

  it('tells a terminal emulator from a character on the merchandise', () => {
    const KITTY = { key: 'kitty', name: 'Kitty', description: 'Terminal emulator', summary: null };
    const HELLO_KITTY = { key: 'hello kitty', name: 'Hello Kitty', description: "Sanrio's character", summary: null };
    const glossary = markingTerms([KITTY, HELLO_KITTY], []);
    expect(marked('Ghostty now supports the Kitty graphics protocol.', glossary)).toEqual(['Kitty']);
    // The merchandise is not the terminal: the character has a name of its own.
    expect(marked('Hello Kitty maker cuts ties with a Japanese spy drama.', glossary)).toEqual(['Hello Kitty']);
    expect(marked('The company behind the Hello Kitty franchise apologised.', glossary)).toEqual(['Hello Kitty']);
  });
});

describe('the word boundary of a term', () => {
  const ICE = { key: 'ice', name: 'ICE', description: 'Federal law enforcement agency', summary: null };
  const OPENAI = { key: 'openai', name: 'OpenAI', description: 'An AI company', summary: null };
  const BP = { key: 'bp', name: 'BP', description: 'An oil company', summary: null };

  /** The terms that were marked in a text, with the text that was marked. */
  function marked(text: string, terms: MarkableTerm[]): string[] {
    const { document } = parseHTML(`<body>${markTerms(text, terms).value}</body>`);
    return [...document.querySelectorAll('button.term')].map((b) => b.textContent ?? '');
  }

  it('does not mark a term inside another word', () => {
    expect(marked('the Barcelona office and a practice of shipping code', [ICE])).toEqual([]);
  });

  it('marks the term when it stands on its own', () => {
    expect(marked('the ICE agents were there', [ICE])).toEqual(['ICE']);
  });

  it('does not mark a term that is glued to a word', () => {
    expect(marked('a ReopenAI model', [OPENAI])).toEqual([]);
  });

  it('marks a term that carries a possessive', () => {
    expect(marked("OpenAI's model", [OPENAI])).toEqual(["OpenAI's"]);
  });

  it('matches a short name only as it is written', () => {
    expect(marked('the bp model and the BP model', [BP])).toEqual(['BP']);
  });
});

describe('a term that is only part of another word', () => {
  const term = (name: string): FoundTerm => ({ name, kind: 'acronym', wiki: null, role: null, sources: [1] });

  it('drops a term the articles only name inside another word', () => {
    const terms = [term('ice'), term('Thoughtworks')];
    const kept = dropFragmentTerms(terms, ['the team met in our Barcelona office', 'Thoughtworks wrote it']);
    expect(kept.map((t) => t.name)).toEqual(['Thoughtworks']);
  });

  it('keeps a term the articles name as a word of its own', () => {
    const kept = dropFragmentTerms([term('ICE')], ['the ICE agents were there']);
    expect(kept.map((t) => t.name)).toEqual(['ICE']);
  });

  it('keeps a term the articles do not name at all', () => {
    // The model may know the term under another spelling.
    const kept = dropFragmentTerms([term('U.S. Immigration and Customs Enforcement')], ['the agents were there']);
    expect(kept.map((t) => t.name)).toEqual(['U.S. Immigration and Customs Enforcement']);
  });

  it('keeps a short name that stands on its own', () => {
    const kept = dropFragmentTerms([term('BP')], ['the bp well and the BP well']);
    expect(kept.map((t) => t.name)).toEqual(['BP']);
  });

  it('keeps a long name, which is an inflected form and not an accident', () => {
    // The German article writes the genitive: "...des Audiovisuelle-Mediendienste-Gesetzes".
    const kept = dropFragmentTerms([term('Audiovisuelle-Mediendienste-Gesetz')], ['umgesetzt durch eine Novellierung des Audiovisuelle-Mediendienste-Gesetzes']);
    expect(kept.map((t) => t.name)).toEqual(['Audiovisuelle-Mediendienste-Gesetz']);
  });

  it('keeps a long name that the articles only write in an inflected form', () => {
    const kept = dropFragmentTerms([term('Bundestag')], ['die Beschlüsse des Bundestags']);
    expect(kept.map((t) => t.name)).toEqual(['Bundestag']);
  });
});

describe('a name that is an ordinary word', () => {
  const NEW: MarkableTerm = { key: 'new', name: 'NEW', description: 'The queue of new packages', summary: null, ordinary: true };
  const OPENAI: MarkableTerm = { key: 'openai', name: 'OpenAI', description: 'An AI company', summary: null };

  /** The terms that were marked in a text, with the text that was marked. */
  function marked(text: string, terms: MarkableTerm[]): string[] {
    const { document } = parseHTML(`<body>${markTerms(text, terms).value}</body>`);
    return [...document.querySelectorAll('button.term')].map((b) => b.textContent ?? '');
  }

  it('leaves an ordinary word out of the marks of a story that did not name it', () => {
    expect(markingTerms([NEW, OPENAI], []).map((t) => t.key)).toEqual(['openai']);
  });

  it('marks the ordinary word of the story that named it', () => {
    expect(markingTerms([NEW, OPENAI], [NEW]).map((t) => t.key)).toEqual(['openai', 'new']);
  });

  it('marks an ordinary word only where it is written as it is named', () => {
    const terms = markingTerms([NEW], [NEW]);
    expect(marked('the NEW queue and a new release', terms)).toEqual(['NEW']);
  });

  it('does not mark an ordinary word that is the first half of a longer name', () => {
    const terms = markingTerms([NEW], [NEW]);
    expect(marked('the New York Times reported it', terms)).toEqual([]);
  });

  it('keeps a name the news writes in capitals marked everywhere', () => {
    expect(marked('OpenAI and openai', markingTerms([OPENAI], []))).toEqual(['OpenAI', 'openai']);
  });
});

describe('counting the ordinary words of the news', () => {
  it('calls a name an ordinary word when the news writes it in lower case', () => {
    const counts = new Map([['new', { total: 100, lower: 80 }]]);
    expect([...ordinaryNames(counts, [{ key: 'new', name: 'NEW' }])]).toEqual(['new']);
  });

  it('keeps a name the news writes in capitals', () => {
    const counts = new Map([['anthropic', { total: 100, lower: 2 }]]);
    expect(ordinaryNames(counts, [{ key: 'anthropic', name: 'Anthropic' }]).size).toBe(0);
  });

  it('never calls a name of one or two letters an ordinary word', () => {
    const counts = new Map([['pt', { total: 100, lower: 100 }]]);
    expect(ordinaryNames(counts, [{ key: 'pt', name: 'PT' }]).size).toBe(0);
  });

  it('needs to see the name often enough', () => {
    const counts = new Map([['dawn', { total: 3, lower: 3 }]]);
    expect(ordinaryNames(counts, [{ key: 'dawn', name: 'Dawn' }]).size).toBe(0);
  });

  it('counts the headlines and the teasers, and leaves the code alone', async () => {
    const t = makeApp();
    try {
      t.app.db
        .prepare(
          `INSERT INTO articles (title, summary_text, content_text, content_hash, discovered_at, ingested_at, updated_at)
           VALUES (?, ?, ?, 'hash', '2024-01-01', '2024-01-01', '2024-01-01')`,
        )
        .run('The new queue', 'A new release and the NEW queue', 'return_tensors="pt"');
      const counts = countWords(t.app.db);
      expect(counts.get('new')).toEqual({ total: 3, lower: 2 });
      expect(counts.get('pt')).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });

  it('marks the names the news writes in lower case', async () => {
    const t = makeApp();
    try {
      const db = t.app.db;
      db.prepare(
        `INSERT INTO terms (term_key, name, kind, status, created_at, updated_at)
         VALUES ('new', 'NEW', 'concept', 'explained', '2024-01-01', '2024-01-01')`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO articles (title, summary_text, content_hash, discovered_at, ingested_at, updated_at)
         VALUES (?, ?, 'hash', '2024-01-01', '2024-01-01', '2024-01-01')`,
      );
      for (let i = 0; i < 12; i++) insert.run('A new release', 'a new version of the package');

      const counted = t.app.stories.refreshOrdinaryTerms();
      expect(counted).toEqual({ ordinary: 1, terms: 1 });
      expect(t.app.stories.glossary()[0]!.ordinary).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
