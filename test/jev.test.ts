import { describe, expect, it } from 'vitest';
import {
  buildJevRequest,
  JevClassifier,
  mapJevResponse,
  RELEVANCE_LEVELS,
  SIGNIFICANCE_LEVELS,
  URGENCY_LEVELS,
} from '../src/classification/jev.js';
import { ClassifierError, type ClassificationArticle } from '../src/classification/types.js';
import { loadDefaultProfile } from '../src/profile/repository.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { fakeSystemOneResponse, readSdkRequest } from './helpers.js';

const profile: InterestProfile = {
  id: 1,
  version: 3,
  definition: loadDefaultProfile(),
  changeNote: null,
  author: 'system',
  isActive: true,
  createdAt: '2026-10-25T00:00:00Z',
  activatedAt: null,
};

const article: ClassificationArticle = {
  id: 7,
  title: 'Open model tops coding benchmark',
  sourceName: 'Example News',
  author: 'Ada',
  url: 'https://news.example.com/open-model',
  publishedAt: '2026-10-24T10:00:00Z',
  language: 'en',
  feedCategories: ['AI'],
  summary: 'An open-weights model reaches a new state of the art on agentic coding.',
  text: 'An open-weights model reaches a new state of the art on agentic coding. '.repeat(200),
  contentSource: 'extracted',
  contentQuality: 'full',
};

const opts = { model: 'jev-latest', maxContentChars: 2000 };

describe('buildJevRequest', () => {
  it('builds a System One request with documented question types', () => {
    const req = buildJevRequest(article, profile, opts);
    expect(req.model).toBe('jev-latest');
    const ids = Object.keys(req.questions);
    const topicIds = profile.definition.topics.map((t) => `topic__${t.id}`);
    expect(ids).toEqual(expect.arrayContaining([...topicIds, 'personal_relevance', 'significance', 'urgency', 'investigate', 'promotional', 'exclusion', 'article_type']));
    for (const id of topicIds) expect(req.questions[id]!.type).toBe('noul');
    expect(req.questions.personal_relevance).toMatchObject({ type: 'score', criteria: RELEVANCE_LEVELS });
    expect(req.questions.significance).toMatchObject({ type: 'score', criteria: SIGNIFICANCE_LEVELS });
    expect(req.questions.urgency).toMatchObject({ type: 'score', criteria: URGENCY_LEVELS });
    expect(req.questions.article_type!.type).toBe('choice');
    // Score criteria must have 2..10 levels; choice criteria at most 255 options (API limits).
    for (const q of Object.values(req.questions)) {
      if (q.type === 'score') expect(q.criteria.length).toBeGreaterThanOrEqual(2);
      if (q.type === 'score') expect(q.criteria.length).toBeLessThanOrEqual(10);
    }
  });

  it('separates article content from the reader profile and truncates long text', () => {
    const req = buildJevRequest(article, profile, opts);
    const a = req.state.article as Record<string, string>;
    expect(a.title).toBe(article.title);
    expect(a.text_excerpt!.length).toBeLessThanOrEqual(2001);
    const reader = req.state.reader_profile as Record<string, unknown>;
    expect((reader.interests as unknown[]).length).toBe(profile.definition.topics.length);
    expect(reader.exclusions).toHaveLength(profile.definition.exclusions.length);
    expect(req.state).not.toHaveProperty('inferred_interests');
    expect(a).not.toHaveProperty('text_completeness');
  });

  it('marks partial article text without changing a full article request', () => {
    const partial = buildJevRequest({ ...article, contentQuality: 'partial' }, profile, opts);
    expect((partial.state.article as Record<string, string>).text_completeness).toBe('partial');
    const full = buildJevRequest(article, profile, opts);
    expect(full.state.article).not.toHaveProperty('text_completeness');
  });

  it('omits disabled topics and the exclusion question when there are no exclusions', () => {
    const def = structuredClone(profile.definition);
    def.topics[0]!.enabled = false;
    def.exclusions = [];
    const req = buildJevRequest(article, { ...profile, definition: def }, opts);
    expect(req.questions).not.toHaveProperty(`topic__${def.topics[0]!.id}`);
    expect(req.questions).not.toHaveProperty('exclusion');
  });

  it('keeps inferred interests separate from explicit ones', () => {
    const def = structuredClone(profile.definition);
    def.inferred.topics = [{ label: 'Rust', description: 'Rust language', weight: 0.5 }];
    const req = buildJevRequest(article, { ...profile, definition: def }, opts);
    expect(req.state.inferred_interests).toEqual([{ topic: 'Rust', description: 'Rust language' }]);
    expect(JSON.stringify(req.state.reader_profile)).not.toContain('Rust language');
  });
});

describe('mapJevResponse', () => {
  it('normalizes scores to [0, 1] and assigns categories by threshold', () => {
    const req = buildJevRequest(article, profile, opts);
    const res = fakeSystemOneResponse(req, (id) => {
      if (id === 'topic__ai-llm') return 0.92;
      if (id === 'topic__agentic-coding') return 0.71;
      if (id.startsWith('topic__')) return 0.05;
      if (id === 'personal_relevance') return 3.6;
      if (id === 'significance') return 2;
      if (id === 'urgency') return 1.5;
      if (id === 'investigate') return 0.8;
      if (id === 'article_type') return 'release';
      return 0.1;
    });
    const m = mapJevResponse(req, res as never, profile);
    expect(m.model).toBe('jev-1.14.0');
    expect(m.personalRelevance).toBeCloseTo(0.9);
    expect(m.significance).toBeCloseTo(0.5);
    expect(m.urgency).toBeCloseTo(0.5);
    expect(m.investigate).toBe(0.8);
    expect(m.promotional).toBe(0.1);
    expect(m.exclusion).toBe(0.1);
    expect(m.articleType).toBe('release');
    expect(m.categories.filter((c) => c.assigned).map((c) => c.id)).toEqual(['ai-llm', 'agentic-coding']);
    expect(m.categories).toHaveLength(profile.definition.topics.length); // low-probability topics are kept, not discarded
    expect(m.signals.confidence).toMatchObject({ personalRelevance: 0.6 });
    expect(m.usage).toEqual({ inputTokens: 1234, outputTokens: 20 });
  });

  it('rejects responses missing required answers', () => {
    const req = buildJevRequest(article, profile, opts);
    const res = fakeSystemOneResponse(req);
    delete (res.answers as Record<string, unknown>).personal_relevance;
    expect(() => mapJevResponse(req, res as never, profile)).toThrow(ClassifierError);
  });
});

describe('JevClassifier', () => {
  it('is not configured without an API key', () => {
    const c = new JevClassifier({ model: 'jev-latest', timeoutMs: 1000, maxContentChars: 1000 });
    expect(c.isConfigured()).toBe(false);
    expect(c.configurationHint()).toMatch(/TYPESAFE_API_KEY/);
  });

  it('calls POST /v1/systemone through the SDK and keeps the raw exchange', async () => {
    let seen: Awaited<ReturnType<typeof readSdkRequest>> | null = null;
    const c = new JevClassifier({
      apiKey: 'test-key',
      model: 'jev-latest',
      timeoutMs: 5000,
      maxContentChars: 1000,
      fetch: async (input, init) => {
        seen = await readSdkRequest(input as RequestInfo, init as RequestInit);
        return Response.json(fakeSystemOneResponse(seen.body, (id) => (id === 'personal_relevance' ? 4 : 0.5)));
      },
    });
    const r = await c.classify(article, profile);
    expect(seen!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen!.headers.get('authorization')).toBe('Bearer test-key');
    expect(seen!.body.model).toBe('jev-latest');
    expect(Object.keys(seen!.body.questions)).toContain('personal_relevance');
    expect(r.personalRelevance).toBe(1);
    expect(r.classifier).toBe('jev');
    expect(r.classifierVersion).toBe('jev-news/1');
    expect(r.model).toBe('jev-1.14.0');
    expect(r.inputHash).toBe(c.inputHash(article, profile));
    expect((r.rawRequest as { questions: object }).questions).toEqual(seen!.body.questions);
    expect((r.rawResponse as { model: string }).model).toBe('jev-1.14.0');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [422, 'invalid_input'],
    [400, 'invalid_input'],
    [429, 'unavailable'],
    [529, 'unavailable'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const c = new JevClassifier({
      apiKey: 'k',
      model: 'jev-latest',
      timeoutMs: 2000,
      maxContentChars: 500,
      fetch: async () => Response.json({ detail: 'nope' }, { status }),
    });
    const err = await c.classify(article, profile).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err.kind).toBe(kind);
  });

  it('maps connection failures to unavailable', async () => {
    const c = new JevClassifier({
      apiKey: 'k',
      model: 'jev-latest',
      timeoutMs: 2000,
      maxContentChars: 500,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = await c.classify(article, profile).catch((e) => e);
    expect(err.kind).toBe('unavailable');
  });
});
