import { backoffMs, parseRetryAfter, sleep } from '../util/backoff.js';

/**
 * A claim as Wikidata states it: what it points at, how sure Wikidata is, and the
 * times it holds. The times matter: a country lists every head of government it has
 * ever had, and only the end times say which one is the current holder.
 */
export interface WikidataClaim {
  property: string;
  /** The item the claim points at, when it points at an item. */
  value: string | null;
  rank: 'preferred' | 'normal' | 'deprecated';
  /** When the claim started holding (P580). */
  start: string | null;
  /** When it stopped holding (P582). */
  end: string | null;
}

export interface WikidataEntity {
  id: string;
  label: string | null;
  description: string | null;
  claims: Record<string, WikidataClaim[]>;
}

export interface WikidataOptions {
  /** The entity API, for reading items in bulk. */
  baseUrl: string;
  /** The query service, for asking questions the entity API cannot answer. */
  queryUrl: string;
  /** Wikidata asks who is asking, and answers a stranger with less. */
  userAgent: string;
  timeoutMs: number;
  /** The smallest gap between two requests, in milliseconds. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
}

/** One cell of a query answer. */
export interface SparqlCell {
  value: string;
  type: string;
}

export type SparqlRow = Record<string, SparqlCell>;

/**
 * What the fetcher needs from Wikidata. The service itself is one way of
 * answering these two questions; a test answers them from a file.
 */
export interface WikidataReader {
  entities(ids: string[]): Promise<Map<string, WikidataEntity>>;
  sparql(query: string): Promise<SparqlRow[]>;
}

/** How many items the entity API reads in one request. */
const BATCH = 50;

/** How many times a request is made before it is given up on. */
const ATTEMPTS = 4;

/**
 * Which language a name comes from when an item has no English one. A new item is
 * often named in its own language first, and a name in any language is better than
 * no name at all.
 */
const LABEL_ORDER = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'sv', 'pl', 'ru', 'zh', 'ja', 'ko'];

interface RawSnak {
  snaktype?: string;
  property?: string;
  datavalue?: { value?: unknown; type?: string };
}

interface RawStatement {
  mainsnak?: RawSnak;
  rank?: string;
  qualifiers?: Record<string, RawSnak[]>;
}

interface RawEntity {
  id?: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, RawStatement[]>;
  sitelinks?: Record<string, { title?: string }>;
}

/**
 * The date part of a Wikidata time, e.g. "+2026-09-27T00:00:00Z" → "2026-09-27".
 *
 * Wikidata does not always know the whole date. A time of "+2026-00-00" means
 * "somewhere in 2026", and the month and day are written as zeros to say so. A
 * start is moved to the first day of the period it names and an end to the last,
 * so that a term is given every day it could possibly have covered. Reading the
 * zeros as a date would say "+2026-00-00" ended in January, which is a date that
 * does not exist.
 */
function dateOf(time: unknown, edge: 'start' | 'end'): string | null {
  if (typeof time !== 'string') return null;
  const m = /^([+-])(\d{4})-(\d{2})-(\d{2})/.exec(time);
  if (!m) return null;
  const sign = m[1] === '-' ? '-' : '';
  const [, , year, month, day] = m;
  if (month === '00') {
    return edge === 'start' ? `${sign}${year}-01-01` : `${sign}${year}-12-31`;
  }
  if (day === '00') {
    const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return edge === 'start'
      ? `${sign}${year}-${month}-01`
      : `${sign}${year}-${month}-${String(last).padStart(2, '0')}`;
  }
  return `${sign}${year}-${month}-${day}`;
}

/**
 * Wikidata, read the way a careful reader reads it: in bulk, one request at a time,
 * and with a User-Agent that says who is asking. The data is CC0, so nothing here
 * needs a key.
 */
export class Wikidata {
  private lastRequestAt = 0;

  constructor(private readonly opts: WikidataOptions) {}

  /** Read a set of items, in as few requests as the API allows. */
  async entities(ids: string[]): Promise<Map<string, WikidataEntity>> {
    const wanted = [...new Set(ids.filter(Boolean))];
    const out = new Map<string, WikidataEntity>();
    // The service sometimes answers with fewer items than it was asked for. Asking
    // again for the ones it left out is cheaper than carrying on without them.
    let pending = wanted;
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      for (let i = 0; i < pending.length; i += BATCH) {
        const chunk = pending.slice(i, i + BATCH);
        const body = await this.get<{ entities?: Record<string, RawEntity>; error?: { info?: string } }>(
          '/w/api.php',
          {
            action: 'wbgetentities',
            ids: chunk.join('|'),
            props: 'labels|descriptions|claims',
            languages: 'en',
            format: 'json',
          },
        );
        if (body.error) throw new Error(`Wikidata refused the request: ${body.error.info ?? 'unknown error'}`);
        for (const [id, raw] of Object.entries(body.entities ?? {})) {
          out.set(id, toEntity(id, raw));
        }
      }
      pending = pending.filter((id) => !out.has(id));
      if (pending.length) await sleep(this.opts.minIntervalMs);
    }
    await this.fillLabels(out, wanted);
    return out;
  }

  /**
   * Give a name to the items that came back nameless. An item with no English
   * label usually has one in another language, and its English Wikipedia page
   * usually says what it is called in English. A name in any language is better
   * than no name at all.
   */
  private async fillLabels(out: Map<string, WikidataEntity>, ids: string[]): Promise<void> {
    const need = ids.filter((id) => out.get(id) && !out.get(id)!.label);
    for (let i = 0; i < need.length; i += BATCH) {
      const chunk = need.slice(i, i + BATCH);
      const body = await this.get<{ entities?: Record<string, RawEntity> }>('/w/api.php', {
        action: 'wbgetentities',
        ids: chunk.join('|'),
        props: 'labels|sitelinks',
        sitefilter: 'enwiki',
        format: 'json',
      });
      for (const [id, raw] of Object.entries(body.entities ?? {})) {
        const entity = out.get(id);
        if (!entity) continue;
        const english = raw.sitelinks?.enwiki?.title;
        const label = english ?? pickLabel(raw.labels);
        if (label) entity.label = label;
      }
    }
  }

  /** Ask the query service a question, and read the rows of the answer. */
  async sparql(query: string): Promise<SparqlRow[]> {
    const url = new URL(this.opts.queryUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    const body = await this.request(url.toString());
    const parsed = body as { results?: { bindings?: SparqlRow[] } };
    return parsed.results?.bindings ?? [];
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return (await this.request(url.toString())) as T;
  }

  /**
   * Ask once, and wait for a turn first so the service is not hammered. A service
   * that says it is too busy is asked again, later.
   */
  private async request(url: string, attempt = 0): Promise<unknown> {
    await this.waitTurn();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      if (attempt < ATTEMPTS) {
        await sleep(backoffMs(attempt + 1, 1000, 30_000));
        return this.request(url, attempt + 1);
      }
      throw new Error(`Wikidata request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < ATTEMPTS) {
        const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffMs(attempt + 1, 1000, 30_000);
        await sleep(wait);
        return this.request(url, attempt + 1);
      }
      throw new Error(`Wikidata answered ${res.status}`);
    }
    if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error('Wikidata answer was not JSON');
    }
  }

  /** Keep the requests apart, so the service sees at most one at a time. */
  private async waitTurn(): Promise<void> {
    const earliest = this.lastRequestAt + this.opts.minIntervalMs;
    const now = Date.now();
    if (earliest > now) await sleep(earliest - now);
    this.lastRequestAt = Date.now();
  }
}

function toEntity(id: string, raw: RawEntity): WikidataEntity {
  const claims: Record<string, WikidataClaim[]> = {};
  for (const [property, statements] of Object.entries(raw.claims ?? {})) {
    const list: WikidataClaim[] = [];
    for (const st of statements) {
      const snak = st.mainsnak;
      if (!snak || snak.snaktype === 'novalue' || snak.snaktype === 'somevalue') continue;
      const raw2 = snak.datavalue?.value;
      let value: string | null = null;
      if (typeof raw2 === 'object' && raw2 !== null && 'id' in raw2) value = String((raw2 as { id: unknown }).id);
      else if (typeof raw2 === 'string') value = raw2;
      const quals = st.qualifiers ?? {};
      list.push({
        property,
        value,
        rank: st.rank === 'preferred' ? 'preferred' : st.rank === 'deprecated' ? 'deprecated' : 'normal',
        start: dateOf(firstValue(quals.P580), 'start'),
        end: dateOf(firstValue(quals.P582), 'end'),
      });
    }
    if (list.length) claims[property] = list;
  }
  return {
    id: raw.id ?? id,
    label: raw.labels?.en?.value ?? null,
    description: raw.descriptions?.en?.value ?? null,
    claims,
  };
}

function firstValue(snaks: RawSnak[] | undefined): unknown {
  const snak = snaks?.[0];
  if (!snak) return undefined;
  const v = snak.datavalue?.value;
  if (v && typeof v === 'object' && 'time' in v) return (v as { time: unknown }).time;
  return v;
}

/** The name of an item, in the best language it has one in. */
function pickLabel(labels: Record<string, { value?: string }> | undefined): string | null {
  if (!labels) return null;
  for (const lang of LABEL_ORDER) {
    const value = labels[lang]?.value;
    if (value) return value;
  }
  for (const label of Object.values(labels)) if (label.value) return label.value;
  return null;
}
