import { afterEach, describe, expect, it } from 'vitest';
import { JevClassifier } from '../src/classification/jev.js';
import { ClassifierError, type ClassificationArticle, type ClassificationResult, type Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { fakeSystemOneResponse, FeedServer, fixture, makeApp, readSdkRequest, waitFor, type TestApp } from './helpers.js';

/** Classifier double with switchable behaviour. */
class FakeClassifier implements Classifier {
  readonly name = 'fake';
  readonly version = 'fake/1';
  configured = true;
  mode: 'ok' | 'down' | 'invalid' = 'ok';
  calls: number[] = [];

  isConfigured() {
    return this.configured;
  }
  configurationHint() {
    return this.configured ? null : 'not configured';
  }
  inputHash(a: ClassificationArticle, p: InterestProfile) {
    return sha256(stableStringify({ a: [a.title, a.text], p: p.version }));
  }
  async classify(a: ClassificationArticle, p: InterestProfile): Promise<ClassificationResult> {
    this.calls.push(a.id);
    if (this.mode === 'down') throw new ClassifierError('service down', 'unavailable', 503);
    if (this.mode === 'invalid') throw new ClassifierError('bad request', 'invalid_input', 422);
    const relevance = a.title?.includes('Kernel') ? 0.9 : 0.1;
    return {
      classifier: this.name,
      classifierVersion: this.version,
      model: 'fake-model-1',
      inputHash: this.inputHash(a, p),
      categories: p.definition.topics.map((t, i) => ({ id: t.id, label: t.label, probability: i === 0 ? 0.8 : 0.1, assigned: i === 0 })),
      personalRelevance: relevance,
      significance: 0.5,
      urgency: 0.2,
      investigate: 0.4,
      promotional: 0.1,
      exclusion: 0,
      articleType: 'news_report',
      signals: {},
      rawRequest: { article: a.id },
      rawResponse: { ok: true },
      usage: { inputTokens: 10, outputTokens: 1 },
      durationMs: 1,
    };
  }
}

describe('classification pipeline', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  afterEach(async () => {
    await t?.cleanup();
    await srv?.stop();
    t = null;
    srv = null;
  });

  async function withFeed(classifier: Classifier, dir?: string) {
    srv ??= new FeedServer();
    if (!srv.port) {
      await srv.start();
      srv.serveFeed('/rss', () => fixture('rss.xml'));
    }
    t = makeApp({ classifier, dir });
    return t;
  }

  const status = (app: TestApp['app']) => app.stats.overview();

  it('collects articles without a configured classifier and processes them once configured', async () => {
    const fake = new FakeClassifier();
    fake.configured = false;
    const { app } = await withFeed(fake);
    app.start();
    const s = app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(s);
    await new Promise((r) => setTimeout(r, 200));
    expect(status(app)).toMatchObject({ articles: 3, pending: 3, classified: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(app.classifier.isConfigured()).toBe(false);

    fake.configured = true; // credentials supplied
    await waitFor(() => status(app).classified === 3);
    const list = app.articles.list({ sort: 'rank' }).items;
    expect(list[0]!.title).toContain('Kernel'); // ranked by score
    expect(list.every((a) => a.classificationStatus === 'classified')).toBe(true);
  });

  it('resumes pending classification after a restart with real Jev credentials', async () => {
    const unconfigured = new JevClassifier({ model: 'jev-latest', timeoutMs: 2000, maxContentChars: 500 });
    const first = await withFeed(unconfigured);
    first.app.start();
    const s = first.app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await first.app.scheduler.fetchNow(s);
    await first.app.stop();
    first.app.db.close();

    let requests = 0;
    const configured = new JevClassifier({
      apiKey: 'k',
      model: 'jev-latest',
      timeoutMs: 2000,
      maxContentChars: 500,
      fetch: async (input, init) => {
        requests++;
        const { body } = await readSdkRequest(input as RequestInfo, init as RequestInit);
        return Response.json(fakeSystemOneResponse(body, (id) => (id.startsWith('topic__') ? 0.6 : id === 'article_type' ? 'news_report' : 1)));
      },
    });
    t = makeApp({ classifier: configured, dir: first.dir });
    t.app.start();
    await waitFor(() => status(t!.app).classified === 3);
    expect(requests).toBe(3);
    const detail = t.app.articles.get(t.app.articles.list({}).items[0]!.id)!;
    const c = detail.classifications[0]!;
    expect(c.model).toBe('jev-1.14.0');
    expect(c.classifierVersion).toBe('jev-news/1');
    expect(c.profileVersion).toBe(1);
    expect(c.categories.every((x) => x.assigned)).toBe(true);
    expect(detail.classifiedAt).not.toBeNull();
  });

  it('pauses on classifier outage without losing work, while ingestion continues', async () => {
    const fake = new FakeClassifier();
    fake.mode = 'down';
    const { app } = await withFeed(fake);
    app.start();
    const s = app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(s);
    await waitFor(() => app.pipeline.breaker.pausedReason() !== null);
    expect(status(app).classified).toBe(0);
    expect(status(app).failed).toBe(0); // retries are scheduled, not failed

    // Ingestion is unaffected by the outage.
    srv!.serveFeed('/atom', () => fixture('atom.xml'), 'application/atom+xml');
    const s2 = app.sources.create({ name: 'Blog', url: srv!.url('/atom'), pollIntervalSeconds: 600 });
    expect((await app.scheduler.fetchNow(s2)).outcome).toBe('ok');
    expect(status(app).articles).toBe(4);

    // Service recovers: pending jobs drain after the operator retries (or backoff elapses).
    fake.mode = 'ok';
    app.pipeline.breaker.success();
    app.db.prepare("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z' WHERE status = 'pending'").run();
    app.pipeline.notify();
    await waitFor(() => status(app).classified === 4);
  });

  it('marks invalid requests as failed and keeps the article visible', async () => {
    const fake = new FakeClassifier();
    fake.mode = 'invalid';
    const { app } = await withFeed(fake);
    app.start();
    const s = app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(s);
    await waitFor(() => status(app).failed === 3);
    const items = app.articles.list({ status: 'failed' }).items;
    expect(items).toHaveLength(3);
    expect(items[0]!.classificationError).toMatch(/bad request/);
    expect(app.articles.list({}).total).toBe(3);

    fake.mode = 'ok';
    app.pipeline.retryFailed();
    await waitFor(() => status(app).classified === 3);
  });

  it('recovers jobs interrupted mid-run and does not classify the same input twice', async () => {
    const fake = new FakeClassifier();
    fake.configured = false;
    const first = await withFeed(fake);
    const s = first.app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await first.app.scheduler.fetchNow(s);
    // Simulate a crash while jobs were running.
    first.app.db.prepare("UPDATE jobs SET status = 'running', locked_at = '2026-01-01T00:00:00.000Z'").run();
    // Simulate a lost job: delete one job entirely.
    first.app.db.prepare('DELETE FROM jobs WHERE id = (SELECT MIN(id) FROM jobs)').run();
    first.app.db.close();

    const fake2 = new FakeClassifier();
    t = makeApp({ classifier: fake2, dir: first.dir });
    t.app.start(); // recovers running jobs, reconciler re-creates the lost one
    await waitFor(() => status(t!.app).classified === 3);
    expect(fake2.calls.sort()).toEqual([1, 2, 3]);

    // Re-queueing identical work is a no-op for the classifier.
    t.app.pipeline.reclassify({ days: 365 });
    await waitFor(() => t!.app.queue.counts().every((c) => c.kind !== 'classify' || (c.status !== 'pending' && c.status !== 'running')));
    expect(fake2.calls).toHaveLength(3);
  });

  it('versions the interest profile and keeps classification history on reclassification', async () => {
    const fake = new FakeClassifier();
    const { app } = await withFeed(fake);
    app.start();
    const s = app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(s);
    await waitFor(() => status(app).classified === 3);

    const v1 = app.profiles.active();
    const def = structuredClone(v1.definition);
    def.topics.push({ id: 'rust', label: 'Rust', description: 'The Rust language', priority: 'high', enabled: true });
    const { profile: v2, changed } = app.profiles.createVersion(def, { changeNote: 'add rust' });
    expect(changed).toBe(true);
    expect(v2.version).toBe(2);
    expect(app.profiles.list().map((p) => p.version)).toEqual([2, 1]);
    expect(app.profiles.createVersion(def).changed).toBe(false); // identical → no new version

    expect(app.pipeline.reclassify({ onlyOutdated: true })).toBe(3);
    await waitFor(() => app.articles.list({}).items.every((a) => a.profileVersion === 2));
    const detail = app.articles.get(1)!;
    expect(detail.classifications.map((c) => c.profileVersion)).toEqual([2, 1]);
    expect(detail.classifications[0]!.categories.some((c) => c.id === 'rust')).toBe(true);

    app.profiles.activate(1);
    expect(app.profiles.active().version).toBe(1);
  });

  it('records feedback as events and keeps low-scoring articles accessible', async () => {
    const fake = new FakeClassifier();
    const { app } = await withFeed(fake);
    app.start();
    const s = app.sources.create({ name: 'News', url: srv!.url('/rss'), pollIntervalSeconds: 600 });
    await app.scheduler.fetchNow(s);
    await waitFor(() => status(app).classified === 3);

    const low = app.articles.list({ sort: 'rank_asc' }).items[0]!;
    expect(low.personalRelevance).toBe(0.1);
    expect(app.articles.list({ maxRelevance: 0.2 }).total).toBe(2);
    app.feedback.record(low.id, 'relevant');
    app.feedback.record(low.id, 'more_like_this');
    app.feedback.record(low.id, 'save');
    app.feedback.record(low.id, 'unsave');
    const d = app.articles.get(low.id)!;
    expect(d.relevanceLabel).toBe('relevant');
    expect(d.preference).toBe('more');
    expect(d.savedAt).toBeNull();
    expect(d.feedbackEvents.map((e) => e.eventType)).toEqual(['unsave', 'save', 'more_like_this', 'relevant']);
    expect(d.feedbackEvents[0]!.profileVersion).toBe(1);
    expect(d.feedbackEvents[0]!.rankScore).toBe(low.rankScore);
    expect(app.stats.feedbackAgreement().find((x) => x.label === 'relevant')!.avgRelevance).toBeCloseTo(0.1);
  });
});
