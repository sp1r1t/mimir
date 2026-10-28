import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedServer, fixture, makeApp, type TestApp } from './helpers.js';

describe('feed fetching', () => {
  let srv: FeedServer;
  let t: TestApp;

  beforeEach(async () => {
    srv = new FeedServer();
    await srv.start();
    t = makeApp();
  });
  afterEach(async () => {
    await t.cleanup();
    await srv.stop();
  });

  it('uses conditional requests and avoids re-downloading unchanged feeds', async () => {
    srv.serveFeed('/rss', () => fixture('rss.xml'));
    const s = t.app.sources.create({ name: 'News', url: srv.url('/rss'), pollIntervalSeconds: 600 });
    const first = await t.app.scheduler.fetchNow(s);
    expect(first.outcome).toBe('ok');
    expect(first.result!.created).toHaveLength(3);
    const second = await t.app.scheduler.fetchNow(t.app.sources.get(s.id)!);
    expect(second.outcome).toBe('not_modified');
    expect(srv.requests[1]!.headers['if-none-match']).toBeTruthy();
    const after = t.app.sources.get(s.id)!;
    expect(after.lastHttpStatus).toBe(304);
    expect(after.consecutiveFailures).toBe(0);
    expect(Date.parse(after.nextFetchAt!)).toBeGreaterThan(Date.now() + 590_000);
    expect(t.app.sources.recentFetches(s.id).map((f) => f.outcome)).toEqual(['not_modified', 'ok']);
  });

  it('records failures with backoff while other feeds keep working', async () => {
    srv.serveFeed('/good', () => fixture('atom.xml'), 'application/atom+xml');
    srv.serveFeed('/html', () => fixture('malformed.xml'), 'text/html');
    srv.routes.set('/down', (_req, res) => {
      res.statusCode = 503;
      res.end('maintenance');
    });
    const good = t.app.sources.create({ name: 'Good', url: srv.url('/good'), pollIntervalSeconds: 600 });
    const html = t.app.sources.create({ name: 'Html', url: srv.url('/html'), pollIntervalSeconds: 600 });
    const down = t.app.sources.create({ name: 'Down', url: srv.url('/down'), pollIntervalSeconds: 600 });
    const missing = t.app.sources.create({ name: 'Gone', url: 'http://127.0.0.1:1/feed', pollIntervalSeconds: 600 });

    const results = await Promise.all([good, html, down, missing].map((s) => t.app.scheduler.fetchNow(s)));
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'error', 'error', 'error']);
    expect(t.app.articles.list({}).total).toBe(2);

    const h = t.app.sources.get(html.id)!;
    expect(h.lastError).toMatch(/HTML page, not a feed/);
    expect(h.consecutiveFailures).toBe(1);
    const d = t.app.sources.get(down.id)!;
    expect(d.lastError).toBe('HTTP 503');
    expect(d.lastHttpStatus).toBe(503);
    expect(t.app.sources.get(missing.id)!.lastError).toMatch(/Network error/);

    // Failure backoff grows with consecutive failures.
    const firstNext = Date.parse(d.nextFetchAt!);
    await t.app.scheduler.fetchNow(d);
    const d2 = t.app.sources.get(down.id)!;
    expect(d2.consecutiveFailures).toBe(2);
    expect(Date.parse(d2.nextFetchAt!) - Date.parse(d2.lastFetchAt!)).toBeGreaterThan(firstNext - Date.parse(d.lastFetchAt!));

    // Recovery resets the failure state.
    srv.serveFeed('/down', () => fixture('rss.xml'));
    expect((await t.app.scheduler.fetchNow(d2)).outcome).toBe('ok');
    expect(t.app.sources.get(down.id)!.consecutiveFailures).toBe(0);
    expect(t.app.sources.get(down.id)!.lastError).toBeNull();
  });

  it('retries transient errors within one fetch', async () => {
    let calls = 0;
    srv.routes.set('/flaky', (_req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 502;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/rss+xml');
      res.end(fixture('rss.xml'));
    });
    await t.cleanup();
    t = makeApp({ env: { FEED_RETRIES: '2' } });
    const s = t.app.sources.create({ name: 'Flaky', url: srv.url('/flaky'), pollIntervalSeconds: 600 });
    const r = await t.app.scheduler.fetchNow(s);
    expect(r.outcome).toBe('ok');
    expect(t.app.sources.recentFetches(s.id)[0]!.attempts).toBe(2);
  });

  it('times out slow feeds', async () => {
    srv.routes.set('/slow', () => {
      /* never responds */
    });
    await t.cleanup();
    t = makeApp({ env: { FEED_TIMEOUT_MS: '1000' } });
    const s = t.app.sources.create({ name: 'Slow', url: srv.url('/slow'), pollIntervalSeconds: 600 });
    const r = await t.app.scheduler.fetchNow(s);
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/timed out/);
  });

  it('polls due sources automatically and skips disabled ones', async () => {
    srv.serveFeed('/a', () => fixture('rss.xml'));
    srv.serveFeed('/b', () => fixture('atom.xml'), 'application/atom+xml');
    t.app.sources.create({ name: 'A', url: srv.url('/a'), pollIntervalSeconds: 600 });
    const b = t.app.sources.create({ name: 'B', url: srv.url('/b'), pollIntervalSeconds: 600 });
    t.app.sources.setEnabled(b.id, false);
    t.app.scheduler.tick();
    await new Promise((r) => setTimeout(r, 500));
    expect(srv.requests.map((r) => r.path)).toEqual(['/a']);
    t.app.scheduler.tick(); // not due again
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.requests).toHaveLength(1);
  });

  it('bounds simultaneous manual fetches and shares requests for the same source', async () => {
    await t.cleanup();
    t = makeApp({ env: { FEED_CONCURRENCY: '1' } });
    let active = 0;
    let peak = 0;
    for (const path of ['/one', '/two', '/three']) {
      srv.routes.set(path, (_req, res) => {
        peak = Math.max(peak, ++active);
        setTimeout(() => {
          active--;
          res.end(fixture('rss.xml'));
        }, 40);
      });
    }
    const sources = ['/one', '/two', '/three'].map((path) =>
      t.app.sources.create({ name: path, url: srv.url(path), pollIntervalSeconds: 600 }),
    );
    const requests = sources.map((source) => t.app.scheduler.fetchNow(source));
    requests.push(t.app.scheduler.fetchNow(sources[1]!));
    t.app.scheduler.tick(); // Automatic collection also respects occupied slots.
    const results = await Promise.all(requests);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(peak).toBe(1);
    expect(srv.requests.map((r) => r.path)).toEqual(['/one', '/two', '/three']);
  });
});
