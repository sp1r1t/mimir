import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArticleExtractor, isPrivateAddress } from '../src/extraction/extractor.js';
import { FeedServer } from './helpers.js';

const longText = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i} explains the development in considerable technical detail for readers.</p>`).join('');
const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><title>T</title><link rel="canonical" href="/canonical">${head}</head><body><article><h1>Title</h1>${body}</article></body></html>`;

describe('ArticleExtractor', () => {
  let srv: FeedServer;
  let ex: ArticleExtractor;
  beforeEach(async () => {
    srv = new FeedServer();
    await srv.start();
    srv.routes.set('/robots.txt', (_q, r) => r.end('User-agent: *\nDisallow: /private/\n'));
    ex = new ArticleExtractor({ userAgent: 'Mimir-test', timeoutMs: 2000, maxBytes: 1_000_000, respectRobots: true, allowPrivateNetworks: true, perHostIntervalMs: 0 });
  });
  afterEach(() => srv.stop());

  const html = (path: string, body: string, headers: Record<string, string> = {}) =>
    srv.routes.set(path, (_q, r) => {
      r.setHeader('Content-Type', 'text/html');
      for (const [k, v] of Object.entries(headers)) r.setHeader(k, v);
      r.end(body);
    });

  it('extracts main text and the declared canonical URL', async () => {
    html('/a', page(longText));
    const out = await ex.extract(srv.url('/a'), 100);
    expect(out.status).toBe('succeeded');
    if (out.status !== 'succeeded') return;
    expect(out.text).toContain('Paragraph 29');
    expect(out.declaredCanonicalUrl).toBe(srv.url('/canonical'));
    expect(out.language).toBe('en');
  });

  it('respects robots.txt and noarchive directives', async () => {
    html('/private/x', page(longText));
    expect((await ex.extract(srv.url('/private/x'), 0)).status).toBe('not_permitted');
    html('/b', page(longText, '<meta name="robots" content="noarchive">'));
    expect((await ex.extract(srv.url('/b'), 0)).status).toBe('not_permitted');
    html('/c', page(longText), { 'X-Robots-Tag': 'noindex, noarchive' });
    expect((await ex.extract(srv.url('/c'), 0)).status).toBe('not_permitted');
  });

  it('drops a hidden consent notice when the document root looks like chrome', async () => {
    const prose = [
      'Paragraph one is long enough to count as article prose about a policy change and its consequences for readers today.',
      'Paragraph two adds a second substantive block so the extraction can be judged as a real article body rather than a teaser.',
    ];
    html(
      '/standard',
      `<!doctype html><html class="theme-default dst-header" lang="de"><head><title>Titel</title></head><body>
        <article><h1>Titel</h1>${prose.map((p) => `<p>${p}</p>`).join('')}</article>
        <div hidden><h2>Willkommen bei DER STANDARD</h2><p>Bitte deaktivieren Sie Adblocker. Accept all cookies. Manage preferences.</p></div>
      </body></html>`,
    );
    const out = await ex.extract(srv.url('/standard'), 80);
    expect(out.status).toBe('succeeded');
    if (out.status !== 'succeeded') return;
    expect(out.text).toContain('Paragraph two');
    expect(out.text).not.toContain('DER STANDARD');
    expect(out.text).not.toContain('Adblocker');
    expect(out.html).not.toContain('hidden');
    expect(out.quality).toBe('full');
  });

  it('keeps a shorter clean article when the feed is only a summary', async () => {
    const body = `<p>${'The project shipped a new scheduler with bounded retries and a documented recovery path for operators. '.repeat(3)}</p><p>${'A second section explains how failed feeds stay isolated from the rest of the collection. '.repeat(2)}</p>`;
    html('/short', page(body));
    const out = await ex.extract(srv.url('/short'), 1000);
    expect(out.status).toBe('succeeded');
    if (out.status !== 'succeeded') return;
    expect(out.text.length).toBeLessThan(1000);
    expect(out.quality).toBe('full');
  });

  it('keeps a short news item that is still an article', async () => {
    const sentence = 'A research group released an open model that beats the previous coding benchmark by twelve points on the standard suite and published the weights, notes, and harness.';
    html('/brief', page(`<p>${sentence}</p>`));
    const out = await ex.extract(srv.url('/brief'), 40);
    expect(out.status).toBe('succeeded');
    if (out.status !== 'succeeded') return;
    expect(out.text).toContain('open model');
    expect(out.quality).toBe('full');
  });

  it('rejects a consent widget with no article', async () => {
    html(
      '/consent',
      page('<div class="consent-banner"><p>Accept all cookies. Reject all. Manage preferences. Sign in to our newsletter.</p></div><p>Subscribe to read.</p>'),
    );
    expect((await ex.extract(srv.url('/consent'), 80)).status).toBe('insufficient');
  });

  it('keeps feed content when the page offers no more (teaser or paywall)', async () => {
    html('/teaser', page('<p>Subscribe to read the full story.</p>'));
    expect((await ex.extract(srv.url('/teaser'), 400)).status).toBe('insufficient');
    srv.routes.set('/paywall', (_q, r) => {
      r.statusCode = 402;
      r.end();
    });
    const out = await ex.extract(srv.url('/paywall'), 0);
    expect(out).toMatchObject({ status: 'unavailable', reason: 'HTTP 402 (access restricted)' });
  });

  it('treats server errors as transient', async () => {
    srv.routes.set('/err', (_q, r) => {
      r.statusCode = 503;
      r.end();
    });
    await expect(ex.extract(srv.url('/err'), 0)).rejects.toThrow(/HTTP 503/);
  });

  it('stops contacting hosts that repeatedly deny access', async () => {
    srv.routes.set('/denied', (_q, r) => {
      r.statusCode = 403;
      r.end();
    });
    for (let i = 0; i < 3; i++) await ex.extract(srv.url('/denied'), 0);
    const before = srv.requests.length;
    const out = await ex.extract(srv.url('/denied'), 0);
    expect(out.status).toBe('unavailable');
    expect(srv.requests.length).toBe(before);
  });

  it('refuses private network targets unless allowed', async () => {
    const strict = new ArticleExtractor({ userAgent: 'x', timeoutMs: 1000, maxBytes: 1000, respectRobots: false, allowPrivateNetworks: false });
    expect((await strict.extract(srv.url('/a'), 0)).status).toBe('not_permitted');
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.10')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
});
