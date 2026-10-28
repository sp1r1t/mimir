import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { createRequire } from 'node:module';
import { fetchText, HttpError, isRetryableStatus } from '../util/http.js';
import { cleanExtractedHtml, prepareDocument, preferExtracted, type ExtractionQuality } from './clean.js';

interface RobotsTxt {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
// robots-parser is CommonJS with `module.exports = fn`; its bundled types declare an ESM default.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, body: string) => RobotsTxt;

export type ExtractionOutcome =
  | {
      status: 'succeeded';
      text: string;
      html: string;
      language: string | null;
      declaredCanonicalUrl: string | null;
      title: string | null;
      quality: Exclude<ExtractionQuality, 'suspect'>;
    }
  | { status: 'not_permitted' | 'unavailable' | 'insufficient'; reason: string; declaredCanonicalUrl?: string | null };

/** Thrown when the host was contacted too recently; retry after `waitMs` without counting an attempt. */
export class HostBusyError extends Error {
  constructor(readonly waitMs: number) {
    super(`Host rate limit: retry in ${waitMs} ms`);
    this.name = 'HostBusyError';
  }
}

/** Thrown for transient failures that are worth retrying. */
export class TransientExtractionError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TransientExtractionError';
  }
}

export interface ExtractorOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  respectRobots: boolean;
  allowPrivateNetworks: boolean;
  /** Minimum spacing between requests to the same host. */
  perHostIntervalMs?: number;
}

/** After this many consecutive access-denied responses, a host is skipped for BLOCK_TTL_MS. */
const BLOCK_THRESHOLD = 3;
const BLOCK_TTL_MS = 24 * 3600_000;
const MAX_INLINE_WAIT_MS = 5000;

const ROBOTS_TTL_MS = 6 * 3600_000;
/** Product token checked against robots.txt groups. */
const ROBOTS_AGENT = 'Mimir';

/**
 * Fetches an article page and extracts its main text with Readability.
 * Honors robots.txt and `noarchive`/`none` directives, never sends credentials
 * or cookies, and does not try to work around paywalls: if the page offers no
 * more text than the feed, the feed content is kept.
 */
export class ArticleExtractor {
  private readonly robots = new Map<string, { fetchedAt: number; parser: RobotsTxt | null }>();
  private readonly hosts = new Map<string, { nextAt: number; denied: number; blockedUntil: number }>();

  constructor(private readonly opts: ExtractorOptions) {}

  /** Reserve a request slot for a host: waits briefly in place, or throws HostBusyError for longer waits. */
  private async reserve(host: string, signal?: AbortSignal): Promise<void> {
    const interval = this.opts.perHostIntervalMs ?? 3000;
    const h = this.hosts.get(host) ?? { nextAt: 0, denied: 0, blockedUntil: 0 };
    this.hosts.set(host, h);
    const wait = h.nextAt - Date.now();
    if (wait > MAX_INLINE_WAIT_MS) throw new HostBusyError(wait);
    h.nextAt = Math.max(Date.now(), h.nextAt) + interval;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw new TransientExtractionError('aborted');
  }

  private noteAccess(host: string, denied: boolean): void {
    const h = this.hosts.get(host);
    if (!h) return;
    h.denied = denied ? h.denied + 1 : 0;
    if (h.denied >= BLOCK_THRESHOLD) h.blockedUntil = Date.now() + BLOCK_TTL_MS;
  }

  private blocked(host: string): boolean {
    return (this.hosts.get(host)?.blockedUntil ?? 0) > Date.now();
  }

  async extract(url: string, currentTextLength: number, signal?: AbortSignal): Promise<ExtractionOutcome> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { status: 'unavailable', reason: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { status: 'unavailable', reason: `Unsupported protocol ${parsed.protocol}` };
    }
    const host = parsed.hostname.toLowerCase();
    if (this.blocked(host)) {
      return { status: 'unavailable', reason: 'Host denies automated access (repeated HTTP 401/403); skipped' };
    }
    if (!this.opts.allowPrivateNetworks && (await resolvesToPrivate(parsed.hostname))) {
      return { status: 'not_permitted', reason: 'Host resolves to a private network address' };
    }
    if (this.opts.respectRobots && !(await this.robotsAllows(parsed, signal))) {
      return { status: 'not_permitted', reason: 'Disallowed by robots.txt' };
    }

    await this.reserve(host, signal);
    let res;
    try {
      res = await fetchText(url, {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        timeoutMs: this.opts.timeoutMs,
        maxBytes: this.opts.maxBytes,
        signal,
      });
    } catch (err) {
      if (err instanceof HttpError && !err.retryable) return { status: 'unavailable', reason: err.message };
      throw new TransientExtractionError(err instanceof Error ? err.message : String(err));
    }
    if (res.status < 200 || res.status >= 300) {
      if (isRetryableStatus(res.status)) throw new TransientExtractionError(`HTTP ${res.status}`);
      const paywall = res.status === 401 || res.status === 402 || res.status === 403 || res.status === 451;
      this.noteAccess(host, res.status === 401 || res.status === 403);
      return { status: 'unavailable', reason: `HTTP ${res.status}${paywall ? ' (access restricted)' : ''}` };
    }
    this.noteAccess(host, false);
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype && !/html|xml/i.test(ctype)) return { status: 'unavailable', reason: `Not an HTML page (${ctype})` };
    if (hasNoArchive(res.headers.get('x-robots-tag'))) {
      return { status: 'not_permitted', reason: 'X-Robots-Tag forbids archiving' };
    }

    const html = res.body.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(res.finalUrl)}">`);
    const { document } = parseHTML(html);
    const metaRobots = [...document.querySelectorAll('meta[name="robots"]')]
      .map((m) => m.getAttribute('content') ?? '')
      .join(',');
    const declared = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
    const declaredCanonicalUrl = declared ? safeUrl(declared, res.finalUrl) : null;
    if (hasNoArchive(metaRobots)) {
      return { status: 'not_permitted', reason: 'Page robots meta forbids archiving', declaredCanonicalUrl };
    }
    const lang = document.documentElement?.getAttribute('lang') ?? null;
    prepareDocument(document);

    let article: ReturnType<Readability<string>['parse']>;
    try {
      article = new Readability(document as unknown as Document, { charThreshold: 80 }).parse();
    } catch (err) {
      return { status: 'unavailable', reason: `Readability failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const cleaned = article?.content ? cleanExtractedHtml(article.content) : null;
    if (!article || !cleaned || !preferExtracted(cleaned.quality, cleaned.text.length, currentTextLength)) {
      const why = cleaned?.reasons.length ? cleaned.reasons.join(', ') : 'no article content';
      const chars = cleaned?.text.length ?? 0;
      return {
        status: 'insufficient',
        reason: `Page text not used (${chars} chars, ${why}); feed content kept (${currentTextLength} chars)`,
        declaredCanonicalUrl,
      };
    }
    const quality = cleaned.quality === 'full' ? 'full' : 'partial';
    return {
      status: 'succeeded',
      text: cleaned.text,
      html: cleaned.html,
      language: article.lang || lang,
      declaredCanonicalUrl,
      title: article.title || null,
      quality,
    };
  }

  private async robotsAllows(url: URL, signal?: AbortSignal): Promise<boolean> {
    const origin = url.origin;
    const cached = this.robots.get(origin);
    let parser = cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS ? cached.parser : undefined;
    if (parser === undefined) {
      const robotsUrl = `${origin}/robots.txt`;
      await this.reserve(url.hostname.toLowerCase(), signal);
      try {
        const res = await fetchText(robotsUrl, {
          headers: { 'User-Agent': this.opts.userAgent },
          timeoutMs: Math.min(this.opts.timeoutMs, 10_000),
          maxBytes: 512 * 1024,
          signal,
        });
        if (res.status >= 200 && res.status < 300) parser = robotsParser(robotsUrl, res.body);
        else if (res.status >= 500) throw new TransientExtractionError(`robots.txt HTTP ${res.status}`);
        else parser = null; // 4xx: no restrictions
      } catch (err) {
        if (err instanceof TransientExtractionError) throw err;
        throw new TransientExtractionError(`robots.txt unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.robots.set(origin, { fetchedAt: Date.now(), parser });
    }
    if (!parser) return true;
    return parser.isAllowed(url.toString(), ROBOTS_AGENT) !== false;
  }
}

function hasNoArchive(value: string | null | undefined): boolean {
  if (!value) return false;
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .some((d) => d === 'noarchive' || d === 'none');
}

function safeUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function resolvesToPrivate(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return false; // resolution errors surface as fetch errors
    }
  }
  return addrs.some(isPrivateAddress);
}

export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = addr.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
