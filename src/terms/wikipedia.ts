import { parseRetryAfter, sleep } from '../util/backoff.js';
import { fitsRole } from './fit.js';

/** What an encyclopedia says about a term. */
export interface TermArticle {
  /** The title of the article the term was found in. */
  title: string;
  /** The encyclopedia's own one-liner: "Canadian artificial intelligence company". */
  description: string | null;
  /** The opening of the article. */
  extract: string | null;
  /** Where the reader can read more. */
  url: string | null;
}

export interface WikipediaOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
  /** Wikipedia asks for a request at a time, and for a User-Agent that says who is asking. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
}

/** The encyclopedia, as the rest of Mimir uses it. */
export interface Encyclopedia {
  /**
   * The article that explains a term, or nothing when there is none. The note the story
   * made about the term ("Chromium's WebGPU implementation") says which of the several
   * things the name stands for the story means; an article about another of them is not
   * an answer.
   */
  lookup(name: string, hint?: string | null, role?: string | null, signal?: AbortSignal): Promise<TermArticle | null>;
}

interface RestSummary {
  title?: string;
  description?: string;
  extract?: string;
  type?: string;
  titles?: { canonical?: string };
  content_urls?: { desktop?: { page?: string } };
}

interface SearchAnswer {
  query?: { search?: { title?: string }[] };
}

/**
 * The encyclopedia, as it is used here: a term in, a short explanation out.
 *
 * A name on its own is often not enough to find the right article. "Sandbox" is a pit
 * for children and a place where code runs; "Cohere" is a company and a physics word.
 * So the title the model gives is tried first, the plain name second, and a search last,
 * where the articles that carry the name come first: the search answers "CTI-REALM"
 * with an article about coral reefs, which is no answer at all.
 *
 * The encyclopedia also answers with a redirect: "Sandbox" leads to "Sandpit", a
 * different thing entirely. A redirect is only followed when the article it leads to
 * introduces the name that was asked for — "The Federal Bureau of Investigation (FBI)",
 * but not "A sandpit or sandbox is a low, wide container".
 */
export class Wikipedia implements Encyclopedia {
  private lastRequestAt = 0;

  constructor(private readonly opts: WikipediaOptions) {}

  /**
   * The article for a title, or nothing when there is none. A page that only lists
   * several meanings explains nothing, so it is not an answer either.
   */
  async summary(title: string, signal?: AbortSignal): Promise<TermArticle | null> {
    const wanted = title.trim();
    if (!wanted) return null;
    const url = new URL(`/api/rest_v1/page/summary/${encodeURIComponent(wanted.replace(/ /g, '_'))}`, this.opts.baseUrl);
    const body = await this.get(url, 0, signal);
    if (body === null) return null;
    const data = body as RestSummary;
    if (data.type === 'disambiguation') return null;
    const canonical = data.titles?.canonical ?? data.title ?? wanted;
    const extract = data.extract?.trim() || null;
    const description = data.description?.trim() || null;
    // A page that does not exist answers with an error, not with an article.
    if (!extract && !description) return null;
    // A redirect leads to a different article. It is only the answer when the article
    // introduces the name that was asked for.
    if (!sameArticle(wanted, canonical) && !introduces(extract, description, wanted)) return null;
    return {
      title: canonical,
      description,
      extract,
      url: data.content_urls?.desktop?.page ?? null,
    };
  }

  /**
   * The article that explains a term: the title the model gave first, the plain name
   * second, and a validated search last. An article that does not explain the term the
   * way the story uses it is not an answer, and the next candidate is tried.
   *
   * When no candidate fits, the best one is returned all the same: the caller holds the
   * note the story made about the term and can judge the article for itself. A term the
   * encyclopedia has nothing at all about is explained from the articles instead.
   */
  async lookup(name: string, hint?: string | null, role?: string | null, signal?: AbortSignal): Promise<TermArticle | null> {
    const titles = [hint?.trim(), name.trim()].filter((t): t is string => !!t);
    let fallback: TermArticle | null = null;
    for (const title of titles) {
      const article = await this.summary(title, signal);
      if (!article) continue;
      if (fitsRole(article, role)) return article;
      fallback ??= article;
    }
    // Nothing under either title fits the story: a search may still know the term.
    for (const title of await this.searchTitles(name, hint ?? null, signal)) {
      const article = await this.summary(title, signal);
      if (!article) continue;
      if (fitsRole(article, role)) return article;
      fallback ??= article;
    }
    return fallback;
  }

  /**
   * The titles of the articles that could carry the name, best first: the article named
   * exactly as the term is, then the one with the qualifier the model asked for, then
   * the others the search found.
   *
   * The others are worth trying even when their titles do not carry the name: "A2A" is
   * an Italian utility, and the protocol the story means is written "Agent2Agent". The
   * note the story made says which of them is meant, and one that does not fit is
   * passed over.
   */
  private async searchTitles(name: string, hint: string | null, signal?: AbortSignal): Promise<string[]> {
    const wanted = normalize(name);
    if (!wanted) return [];
    const url = new URL('/w/api.php', this.opts.baseUrl);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', name);
    url.searchParams.set('srlimit', '10');
    url.searchParams.set('format', 'json');
    const body = await this.get(url, 0, signal);
    if (body === null) return [];
    const hits = (body as SearchAnswer).query?.search ?? [];
    const qualifier = qualifierOf(hint);
    const exact: string[] = [];
    const asked: string[] = [];
    const others: string[] = [];
    for (const hit of hits) {
      const title = hit.title?.trim();
      if (!title) continue;
      const normalized = normalize(title);
      // The article is named exactly as the term is: the best possible answer.
      if (normalized === wanted) {
        if (!exact.includes(title)) exact.push(title);
        continue;
      }
      // The article is the term with a qualifier: "Sandbox (computer security)". The
      // qualifier the model asked for wins over any other.
      if (normalized.startsWith(`${wanted} (`) && normalized.endsWith(')')) {
        const q = normalized.slice(wanted.length + 2, -1);
        if (!q || q === 'disambiguation' || q.endsWith('disambiguation')) continue;
        if (qualifier && qualifierWords(qualifier).every((w) => q.includes(w))) {
          if (!asked.includes(title)) asked.push(title);
          continue;
        }
        if (!others.includes(title)) others.push(title);
        continue;
      }
      // Any other article the search found: it may be the one, under another name.
      if (!others.includes(title)) others.push(title);
    }
    return [...exact, ...asked, ...others].slice(0, 8);
  }

  /**
   * Ask the encyclopedia once, and wait for its turn first.
   *
   * The encyclopedia may say "come back later" — it answers 429 when it is busy or
   * when the caller has asked too often. It says when, in the Retry-After header.
   * Waiting is the answer to that, not failing: the work is not lost, it is later.
   */
  private async get(url: URL, attempt = 0, signal?: AbortSignal): Promise<unknown | null> {
    await this.waitTurn(signal);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new Error(`Encyclopedia request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A page that does not exist is an answer of its own: there is nothing to explain.
    if (res.status === 404) return null;
    if (res.status === 429) {
      if (attempt >= 3) throw new Error(`Encyclopedia answered 429 for "${url.pathname}"`);
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? 30_000;
      await sleep(Math.min(Math.max(wait, 1_000), 120_000), signal);
      return this.get(url, attempt + 1, signal);
    }
    if (!res.ok) throw new Error(`Encyclopedia answered ${res.status} for "${url.pathname}"`);
    try {
      return await res.json();
    } catch {
      throw new Error(`Encyclopedia answer for "${url.pathname}" was not JSON`);
    }
  }

  /** Keep the requests apart, so the encyclopedia sees at most one at a time. */
  private async waitTurn(signal?: AbortSignal): Promise<void> {
    const earliest = this.lastRequestAt + this.opts.minIntervalMs;
    const now = Date.now();
    if (earliest > now) await sleep(earliest - now, signal);
    this.lastRequestAt = Date.now();
  }
}

/** The same article under two spellings: "Sandbox (software)" and "Sandbox (software development)". */
function sameArticle(requested: string, canonical: string): boolean {
  const a = normalize(requested);
  const b = normalize(canonical);
  if (a === b) return true;
  if (b.startsWith(`${a} (`) && b.endsWith(')')) return true;
  // The article carries the legal suffix of a company: "Okta" is "Okta, Inc.".
  return b.startsWith(`${a},`);
}

/** Does the article introduce the name that was asked for? "the FBI" and "(FBI)" count. */
function introduces(extract: string | null, description: string | null, name: string): boolean {
  const wanted = normalize(name);
  if (!wanted) return false;
  const pattern = new RegExp(`\\(\\s*${escapeRegExp(wanted)}\\s*\\)`, 'i');
  return pattern.test(extract ?? '') || pattern.test(description ?? '');
}

/** The words of a qualifier: "software development" out of "Sandbox (software development)". */
function qualifierOf(title: string | null): string | null {
  if (!title) return null;
  const match = normalize(title).match(/\(([^)]*)\)\s*$/);
  return match?.[1] ?? null;
}

function qualifierWords(qualifier: string): string[] {
  return qualifier.split(/[^a-z0-9]+/i).filter((w) => w.length > 2);
}

function normalize(title: string): string {
  return title
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
