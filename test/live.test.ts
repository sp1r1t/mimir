import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { AddressInfo } from 'node:net';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import type { LevelAnswer, MatchArticle, MatchCandidate, MatchJudgement, StoryMatcher } from '../src/stories/matcher.js';
import { MockSummaryProvider } from '../src/summaries/mock.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { buildServer } from '../src/web/server.js';
import { FeedServer, makeApp, waitFor, type TestApp } from './helpers.js';

interface Item {
  guid: string;
  title: string;
  host: string;
  description?: string;
}

function rss(items: Item[]): string {
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Wire</title><link>https://wire.example.com/</link>
    ${items
      .map(
        (i) => `<item><title>${i.title}</title><link>https://${i.host}/${i.guid}</link><guid isPermaLink="false">${i.guid}</guid>
      <pubDate>${new Date(now - 3_600_000).toUTCString()}</pubDate><description>${i.description ?? i.title}</description></item>`,
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

/** Read the next "change" frame of an event stream. */
async function nextChange(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 8000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (data) return data;
      cut = buffer.indexOf('\n\n');
    }
  }
  throw new Error('no change event came');
}

describe('the page that watches its story', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  let server: FastifyInstance | null = null;
  let stream: AbortController | null = null;
  afterEach(async () => {
    stream?.abort();
    stream = null;
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

  it('tells the page which version of the story it is looking at', async () => {
    const storyId = await setup();
    const version = t!.app.stories.storyVersion(storyId);
    expect(version).not.toBe('');

    const page = await server!.inject({ method: 'GET', url: `/stories/${storyId}` });
    const { document } = parseHTML(page.body);
    const article = document.querySelector('.story-detail');
    expect(article!.getAttribute('data-story-id')).toBe(String(storyId));
    expect(article!.getAttribute('data-version')).toBe(version);

    // The two buttons ask the server to write something; the page watches for the result.
    const summary = document.querySelector('form[data-story-action="summary"]');
    const places = document.querySelector('form[data-story-action="places"]');
    expect(summary!.getAttribute('action')).toBe(`/stories/${storyId}/summary`);
    expect(places!.getAttribute('action')).toBe(`/stories/${storyId}/places`);
  });

  it('says the story changed when the brief is written', async () => {
    const storyId = await setup();
    const before = t!.app.stories.storyVersion(storyId);

    await server!.listen({ port: 0, host: '127.0.0.1' });
    const port = (server!.server.address() as AddressInfo).port;
    stream = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${storyId}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: stream.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    // The stream opens with the version the page already has.
    expect(JSON.parse(await nextChange(reader)).version).toBe(before);

    // Asking for the brief changes the story, and the stream says so.
    t!.app.storyPipeline.requestSummary(storyId);
    const after = await nextChange(reader);
    expect(JSON.parse(after).version).not.toBe(before);
    expect(JSON.parse(after).version).toBe(t!.app.stories.storyVersion(storyId));
  });

  it('asks for the version of a story when the stream cannot be held open', async () => {
    const storyId = await setup();
    const res = await server!.inject({ method: 'GET', url: `/api/stories/${storyId}/state` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).version).toBe(t!.app.stories.storyVersion(storyId));

    const missing = await server!.inject({ method: 'GET', url: '/api/stories/999999/state' });
    expect(missing.statusCode).toBe(404);
  });

  it('changes the version when the story changes', async () => {
    const storyId = await setup();
    const versions = new Set([t!.app.stories.storyVersion(storyId)]);

    t!.app.storyPipeline.requestSummary(storyId);
    versions.add(t!.app.stories.storyVersion(storyId));

    await waitFor(() => t!.app.stories.get(storyId)!.summary != null);
    versions.add(t!.app.stories.storyVersion(storyId));

    expect(versions.size).toBeGreaterThan(1);
  });
});
