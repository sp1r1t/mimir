import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import { buildServer } from '../src/web/server.js';
import { FeedServer, fixture, makeApp, type TestApp } from './helpers.js';

const form = (data: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(data).toString(),
});

describe('web interface', () => {
  let t: TestApp;
  let srv: FeedServer;
  let server: FastifyInstance;

  beforeEach(async () => {
    srv = new FeedServer();
    await srv.start();
    srv.serveFeed('/rss', () => fixture('rss.xml'));
    srv.routes.set('/site', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/rss"></head><body></body></html>`);
    });
    t = makeApp();
    server = buildServer(t.app);
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    await t.cleanup();
    await srv.stop();
  });

  it('adds a feed through the form, using autodiscovery and the feed title', async () => {
    const res = await server.inject({ method: 'POST', url: '/sources', ...form({ url: srv.url('/site'), pollMinutes: '15', extractContent: '1' }) });
    expect(res.statusCode).toBe(303);
    const [s] = t.app.sources.list();
    expect(s).toMatchObject({ name: 'Example Tech News', url: srv.url('/rss'), pollIntervalSeconds: 900, enabled: true });
    await new Promise((r) => setTimeout(r, 300)); // first fetch runs in the background
    expect(t.app.articles.list({}).total).toBe(3);

    const dup = await server.inject({ method: 'POST', url: '/sources', ...form({ url: srv.url('/rss') }) });
    expect(dup.statusCode).toBe(400);
    expect(dup.body).toContain('already subscribed');
    const bad = await server.inject({ method: 'POST', url: '/sources', ...form({ url: srv.url('/missing') }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Could not read a feed');
  });

  it('edits, disables, and deletes a feed', async () => {
    const s = t.app.sources.create({ name: 'News', url: srv.url('/rss'), pollIntervalSeconds: 600 });
    await server.inject({ method: 'POST', url: `/sources/${s.id}`, ...form({ url: s.url, name: 'Renamed', pollMinutes: '60', enabled: '1' }) });
    expect(t.app.sources.get(s.id)).toMatchObject({ name: 'Renamed', pollIntervalSeconds: 3600, enabled: true });
    expect(t.app.sources.get(s.id)!.config.extractContent).toBe(false);
    await server.inject({ method: 'POST', url: `/sources/${s.id}/toggle` });
    expect(t.app.sources.get(s.id)!.enabled).toBe(false);
    await server.inject({ method: 'POST', url: `/sources/${s.id}/delete` });
    expect(t.app.sources.get(s.id)).toBeNull();
  });

  it('renders every page, including unclassified articles', async () => {
    const s = t.app.sources.create({ name: 'News', url: srv.url('/rss'), pollIntervalSeconds: 600 });
    await t.app.scheduler.fetchNow(s);
    for (const url of [
      '/', '/?q=kernel&sort=latest&days=7&summary=none', '/articles', '/articles?q=kernel', '/articles?sort=rank_asc&min=0&max=50',
      '/sources', `/sources/${s.id}`, '/profile', '/profile/versions/1', '/stats', '/articles/1', '/metrics',
    ]) {
      const res = await server.inject({ url });
      expect(res.statusCode, url).toBe(200);
    }
    const inbox = await server.inject({ url: '/articles' });
    expect(inbox.body).toContain('Kernel 7.2 released with new scheduler');
    expect(inbox.body).toContain('Pending configuration');
    expect(inbox.body).toContain('Classification pending configuration');
    const sources = await server.inject({ url: '/sources' });
    expect(sources.body).toContain(`href="${s.url}"`);
    expect(sources.body).toContain('href="https://news.example.com/"');
    const source = await server.inject({ url: `/sources/${s.id}` });
    expect(source.body).toContain('href="https://news.example.com/"');
    const detail = await server.inject({ url: '/articles/1' });
    expect(detail.body).toContain('Discovered');
    expect(detail.body).not.toContain('<script>alert'); // content is sanitized
  });

  it('keeps navigation and contextual search accessible without JavaScript', async () => {
    for (const [url, searchAction, activeHref] of [
      ['/', '/', '/'],
      ['/articles', '/articles', '/articles'],
      ['/articles?saved=1', '/articles', '/articles?saved=1&sort=discovered'],
      ['/sources', '/', '/sources'],
    ]) {
      const response = await server.inject({ url });
      const { document } = parseHTML(response.body);
      expect(response.statusCode).toBe(200);
      expect(document.querySelector('.search')!.getAttribute('action')).toBe(searchAction);
      expect(document.querySelector('.primary-nav')!.getAttribute('aria-label')).toBe('Main navigation');
      expect(document.querySelector('.top a[aria-current="page"]')!.getAttribute('href')).toBe(activeHref);
      expect(document.querySelector('.skip-link')!.getAttribute('href')).toBe('#main-content');
      expect(document.querySelector('#main-content')).not.toBeNull();
      const menu = document.querySelector('details.workspace-menu')!;
      expect(menu.querySelector('summary')).not.toBeNull();
      expect([...menu.querySelectorAll('nav a')].map((a) => a.getAttribute('href'))).toEqual([
        '/sources', '/profile', '/stats', '/articles?sort=rank_asc&status=classified',
      ]);
    }
  });

  it('leads article details with reading content and keeps diagnostics available', async () => {
    const source = t.app.sources.create({ name: 'News', url: srv.url('/rss'), pollIntervalSeconds: 600 });
    await t.app.scheduler.fetchNow(source);
    const response = await server.inject({ url: '/articles/1' });
    const { document } = parseHTML(response.body);
    const sections = [...document.querySelector('.article-detail')!.children].filter((el) => el.matches('.panel'));
    expect(sections[0]!.querySelector('h3')!.textContent).toBe('Content');
    for (const id of ['article-assessment', 'article-dates', 'article-metadata']) {
      const panel = document.getElementById(id)!;
      expect(panel.tagName).toBe('DETAILS');
      expect(panel.hasAttribute('open')).toBe(false);
      expect(panel.querySelector('summary')).not.toBeNull();
    }
    expect(document.querySelector('.search')!.getAttribute('action')).toBe('/articles');
  });

  it('records feedback via JSON and form posts', async () => {
    const s = t.app.sources.create({ name: 'News', url: srv.url('/rss'), pollIntervalSeconds: 600 });
    await t.app.scheduler.fetchNow(s);
    const res = await server.inject({
      method: 'POST',
      url: '/articles/1/feedback',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      payload: { type: 'not_relevant' },
    });
    expect(res.json()).toMatchObject({ ok: true, state: { relevanceLabel: 'not_relevant' } });
    const viaForm = await server.inject({ method: 'POST', url: '/articles/1/feedback', ...form({ type: 'save' }) });
    expect(viaForm.statusCode).toBe(303);
    expect(t.app.articles.get(1)!.savedAt).not.toBeNull();
    const bad = await server.inject({ method: 'POST', url: '/articles/1/feedback', ...form({ type: 'explode' }) });
    expect(bad.statusCode).toBe(400);
    const go = await server.inject({ url: '/go/1' });
    expect(go.statusCode).toBe(302);
    expect(t.app.articles.get(1)!.feedbackEvents.map((e) => e.eventType)).toContain('open_original');
  });

  it('saves the profile form as a new version and validates JSON edits', async () => {
    const before = t.app.profiles.active();
    const fields: Record<string, string> = {
      summary: 'Test reader',
      exclusions: 'Crypto price speculation',
      editorialPreferences: 'Prefer primary sources',
      changeNote: 'trimmed',
      't.0.id': before.definition.topics[0]!.id,
      't.0.label': 'AI',
      't.0.description': 'Artificial intelligence',
      't.0.priority': 'core',
      't.0.enabled': '1',
      't.1.label': 'Brand new topic',
      't.1.priority': 'low',
      't.1.enabled': '1',
    };
    const res = await server.inject({ method: 'POST', url: '/profile', ...form(fields) });
    expect(res.statusCode).toBe(303);
    const after = t.app.profiles.active();
    expect(after.version).toBe(before.version + 1);
    expect(after.changeNote).toBe('trimmed');
    expect(after.definition.topics.map((x) => x.id)).toEqual([before.definition.topics[0]!.id, 'brand-new-topic']);
    expect(after.definition.exclusions[0]!.description).toBe('Crypto price speculation');

    const invalid = await server.inject({ method: 'POST', url: '/profile/json', ...form({ definition: '{"topics": []}' }) });
    expect(invalid.statusCode).toBe(400);
    expect(t.app.profiles.active().version).toBe(after.version);

    const api = await server.inject({ method: 'PUT', url: '/api/profile', payload: { definition: before.definition, author: 'agent', changeNote: 'restore' } });
    expect(api.json().profile).toMatchObject({ version: after.version + 1, author: 'agent' });
  });

  it('exposes health and metrics', async () => {
    const h = await server.inject({ url: '/healthz' });
    expect(h.json()).toEqual({ status: 'ok' });
    const r = await server.inject({ url: '/readyz' });
    expect(r.json().classifier.state).toBe('unconfigured');
    const m = await server.inject({ url: '/metrics' });
    expect(m.body).toContain('mimir_articles ');
    expect(m.body).toContain('mimir_classifier_ready 0');
  });
});

describe('basic auth', () => {
  it('protects pages but not health checks', async () => {
    const t = makeApp({ env: { MIMIR_BASIC_AUTH: 'me:secret' } });
    const server = buildServer(t.app);
    expect((await server.inject({ url: '/' })).statusCode).toBe(401);
    expect((await server.inject({ url: '/healthz' })).statusCode).toBe(200);
    const ok = await server.inject({ url: '/', headers: { authorization: `Basic ${Buffer.from('me:secret').toString('base64')}` } });
    expect(ok.statusCode).toBe(200);
    const cross = await server.inject({
      method: 'POST',
      url: '/jobs/retry-failed',
      headers: { authorization: `Basic ${Buffer.from('me:secret').toString('base64')}`, origin: 'https://evil.example', host: 'localhost' },
    });
    expect(cross.statusCode).toBe(403);
    await server.close();
    await t.cleanup();
  });
});
