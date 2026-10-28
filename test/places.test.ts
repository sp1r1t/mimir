import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseHTML } from 'linkedom';
import type { ClassificationArticle, ClassificationResult, Classifier } from '../src/classification/types.js';
import type { InterestProfile } from '../src/profile/schema.js';
import { sha256, stableStringify } from '../src/util/hash.js';
import { NominatimGeocoder, UNRESOLVED, type Geocode, type Geocoder, type PlaceQuery } from '../src/places/geocoder.js';
import { parsePlaces, placeKey, PlacesValidationError, preparePlacesPrompt } from '../src/places/places.js';
import { MockPlacesProvider } from '../src/places/mock.js';
import type { MatchArticle, MatchCandidate, MatchJudgement, LevelAnswer, StoryMatcher } from '../src/stories/matcher.js';
import { buildServer } from '../src/web/server.js';
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

/** Same story when the article and the story share a marker word; an update when the article says so. */
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

/** A gazetteer that answers from a list, and counts what it was asked. */
class FakeGeocoder implements Geocoder {
  calls: string[] = [];
  fail = false;
  constructor(private readonly answers: Record<string, { lat: number; lon: number; label: string }> = {}) {}
  async lookup(place: PlaceQuery): Promise<Geocode> {
    // The model may make the name unambiguous; the gazetteer answers to the bare name too.
    const candidates = [place.query, place.country ? `${place.name}, ${place.country}` : null, place.name].filter(
      (c): c is string => !!c,
    );
    this.calls.push(candidates[0]!);
    if (this.fail) throw new Error('the gazetteer is down');
    const hit = candidates.map((c) => this.answers[c]).find(Boolean);
    if (!hit) return UNRESOLVED;
    return { status: 'located', lat: hit.lat, lon: hit.lon, label: hit.label, displayName: hit.label, osmId: 'node/1' };
  }
}

const KYIV = { lat: 50.4501, lon: 30.5234, label: 'Kyiv, Ukraine' };
const UKRAINE = { lat: 48.3794, lon: 31.1656, label: 'Ukraine' };

describe('the place prompt', () => {
  it('reads the places out of the answer', () => {
    const places = parsePlaces(
      JSON.stringify({
        places: [{ name: 'Kyiv', kind: 'city', country: 'Ukraine', role: 'where it happened', sources: [3, 4] }],
      }),
      new Set([3, 4, 5]),
    );
    expect(places).toEqual([
      { name: 'Kyiv', kind: 'city', country: 'Ukraine', countryCode: null, query: null, role: 'where it happened', sources: [3, 4] },
    ]);
  });

  it('reads the country and the unambiguous name out of the answer', () => {
    const places = parsePlaces(
      JSON.stringify({
        places: [
          { name: 'Gaza', kind: 'city', country: 'Palestine', country_code: 'PS', query: 'Gaza Strip', sources: [3] },
        ],
      }),
      new Set([3]),
    );
    expect(places[0]).toMatchObject({ name: 'Gaza', country: 'Palestine', countryCode: 'ps', query: 'Gaza Strip' });
  });

  it('refuses an answer that cites an article it was not given', () => {
    expect(() =>
      parsePlaces(JSON.stringify({ places: [{ name: 'Kyiv', kind: 'city', sources: [9] }] }), new Set([3])),
    ).toThrow(PlacesValidationError);
  });

  it('refuses an answer that is not the expected shape', () => {
    expect(() => parsePlaces('{"nothing": true}', new Set([3]))).toThrow(PlacesValidationError);
    expect(() => parsePlaces('not json at all', new Set([3]))).toThrow(PlacesValidationError);
  });

  it('lists a place once, even when the model says it twice', () => {
    const places = parsePlaces(
      JSON.stringify({
        places: [
          { name: 'Kyiv', kind: 'city', country: 'Ukraine', sources: [3] },
          { name: 'kyiv', kind: 'city', country: 'ukraine', sources: [4] },
        ],
      }),
      new Set([3, 4]),
    );
    expect(places).toHaveLength(1);
    expect(placeKey('Kyiv', 'Ukraine')).toBe(placeKey(' kyiv ', 'ukraine'));
  });

  it('asks for names and asks for no coordinates', () => {
    const prompt = preparePlacesPrompt(
      { id: 1, headline: 'A strike in Kyiv', firstPublishedAt: null, latestDevelopmentAt: null, articleCount: 1, publisherCount: 1 },
      [
        {
          id: 3,
          role: 'origin',
          source: 'wire',
          publisher: 'wire',
          occurredAt: '2026-10-01T00:00:00.000Z',
          title: 'A strike in Kyiv',
          summaryText: 'A strike in Kyiv',
          contentText: 'A strike in Kyiv',
          contentQuality: 'full',
          contentHash: 'h',
          significance: 0.5,
        },
      ],
      { maxInputChars: 4000, language: 'English' },
    );
    expect(prompt.system).toMatch(/Give no coordinates/);
    expect(prompt.system).toMatch(/"places"/);
    expect(prompt.user).toContain('A strike in Kyiv');
    expect(prompt.articles.map((a) => a.articleId)).toEqual([3]);
    expect(prompt.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the gazetteer', () => {
  it('finds a place and says where it is', async () => {
    const calls: string[] = [];
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify([
            {
              lat: '50.4501',
              lon: '30.5234',
              display_name: 'Kyiv, Ukraine',
              name: 'Kyiv',
              osm_type: 'relation',
              osm_id: 270,
              category: 'place',
              type: 'city',
              addresstype: 'city',
              address: { city: 'Kyiv', country: 'Ukraine', country_code: 'ua' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const hit = await geocoder.lookup({ name: 'Kyiv', country: 'Ukraine', countryCode: 'ua', kind: 'city', query: 'Kyiv' });
    expect(hit).toMatchObject({ status: 'located', lat: 50.4501, lon: 30.5234, label: 'Kyiv, Ukraine', osmId: 'relation/270' });
    expect(calls[0]).toContain('nominatim.example.org/search');
    expect(calls[0]).toContain('q=Kyiv');
    expect(calls[0]).toContain('countrycodes=ua');
    expect(calls[0]).toContain('featureType=city');
  });

  it('names a place in English', async () => {
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              lat: '46.6261',
              lon: '32.722',
              name: 'Олешки',
              display_name: 'Олешки, Україна',
              category: 'place',
              type: 'town',
              addresstype: 'town',
              namedetails: { 'name:en': 'Oleshky' },
              address: { country_code: 'ua' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const hit = await geocoder.lookup({ name: 'Oleshky', country: 'Ukraine', countryCode: 'ua', kind: 'town', query: 'Oleshky' });
    expect(hit.label).toBe('Oleshky, Ukraine');
  });

  it('takes the place the model meant, not the one of the same name in another country', async () => {
    const calls: string[] = [];
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify([
            {
              lat: '-23.33',
              lon: '32.81',
              name: 'Gaza',
              display_name: 'Gaza, Mozambique',
              category: 'boundary',
              type: 'administrative',
              addresstype: 'state',
              address: { country: 'Mozambique', country_code: 'mz' },
            },
            {
              lat: '31.5129',
              lon: '34.4581',
              name: 'Gaza',
              display_name: 'Gaza, Gaza Strip, Palestine',
              category: 'boundary',
              type: 'administrative',
              addresstype: 'city',
              address: { country: 'Palestine', country_code: 'ps' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const hit = await geocoder.lookup({ name: 'Gaza', country: 'Palestine', countryCode: 'ps', kind: 'city', query: 'Gaza' });
    expect(hit).toMatchObject({ status: 'located', lat: 31.5129, lon: 34.4581 });
    expect(calls[0]).toContain('countrycodes=ps');
  });

  it('asks without the country when the country brings nothing', async () => {
    const calls: string[] = [];
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (String(input).includes('countrycodes=ua')) return new Response('[]', { status: 200 });
        return new Response(
          JSON.stringify([
            {
              lat: '46.6374',
              lon: '32.6143',
              name: 'Херсонська область',
              display_name: 'Херсонська область, Україна',
              category: 'boundary',
              type: 'administrative',
              addresstype: 'state',
              namedetails: { 'name:en': 'Kherson Oblast' },
              address: { country_code: 'ua' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const hit = await geocoder.lookup({
      name: 'Kherson region',
      country: 'Ukraine',
      countryCode: 'ua',
      kind: 'region',
      query: 'Kherson region',
    });
    expect(hit.status).toBe('located');
    expect(hit.label).toBe('Kherson Oblast, Ukraine');
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('countrycodes');
  });

  it('refuses a loose answer that is not a place of the kind that was asked for', async () => {
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              lat: '46.63',
              lon: '32.62',
              name: 'Державний архів Херсонської області',
              display_name: 'Державний архів Херсонської області, Україна',
              category: 'government',
              type: 'government',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    expect(
      await geocoder.lookup({ name: 'Kherson region', country: 'Ukraine', countryCode: 'ua', kind: 'region', query: 'Kherson region' }),
    ).toEqual(UNRESOLVED);
  });

  it('takes the region, not the railway station of the same name', async () => {
    const calls: string[] = [];
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify([
            {
              lat: '44.9719',
              lon: '-93.2463',
              name: 'West Bank',
              display_name: 'West Bank, Washington Avenue South, Minneapolis, United States',
              category: 'railway',
              type: 'station',
              addresstype: 'railway',
              address: { country: 'United States', country_code: 'us' },
            },
            {
              lat: '32.0255',
              lon: '35.2888',
              name: 'الضفة الغربية',
              display_name: 'الضفة الغربية, الأراضي الفلسطينية',
              category: 'boundary',
              type: 'administrative',
              addresstype: 'region',
              namedetails: { 'name:en': 'West Bank' },
              address: { country: 'Palestine', country_code: 'ps' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const hit = await geocoder.lookup({ name: 'West Bank', country: null, countryCode: null, kind: 'region', query: 'West Bank' });
    expect(hit).toMatchObject({ status: 'located', lat: 32.0255, lon: 35.2888, label: 'West Bank' });
    expect(calls[0]).toContain('featureType=state');
  });

  it('says a name it does not know is not a place', async () => {
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    expect(await geocoder.lookup({ name: 'Nowhere at all', country: null, countryCode: null, kind: 'city', query: null })).toEqual(
      UNRESOLVED,
    );
  });

  it('asks at most one question a second', async () => {
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 120,
      fetchImpl: async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const started = Date.now();
    await geocoder.lookup({ name: 'Kyiv', country: null, countryCode: null, kind: 'city', query: null });
    await geocoder.lookup({ name: 'Ukraine', country: null, countryCode: null, kind: 'country', query: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('says so when the gazetteer cannot answer', async () => {
    const geocoder = new NominatimGeocoder({
      baseUrl: 'https://nominatim.example.org',
      userAgent: 'Mimir/test',
      timeoutMs: 1000,
      minIntervalMs: 0,
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    await expect(
      geocoder.lookup({ name: 'Kyiv', country: null, countryCode: null, kind: 'city', query: null }),
    ).rejects.toThrow(/503/);
  });
});

describe('the places of a story', () => {
  let t: TestApp | null = null;
  let srv: FeedServer | null = null;
  let server: FastifyInstance | null = null;
  afterEach(async () => {
    await server?.close();
    await t?.cleanup();
    await srv?.stop();
    t = srv = server = null;
  });

  async function setup(opts: { places?: MockPlacesProvider; geocoder?: FakeGeocoder } = {}) {
    srv = new FeedServer();
    await srv.start();
    t = makeApp({
      classifier: new StubClassifier(),
      matcher: new StubMatcher(['kyiv']),
      places: opts.places ?? new MockPlacesProvider(),
      geocoder: opts.geocoder ?? new FakeGeocoder({ 'Kyiv, Ukraine': KYIV, Ukraine: UKRAINE }),
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

  it('names the places of a story and puts them on the map', async () => {
    const places = new MockPlacesProvider();
    const app = await setup({ places });
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    expect(story.placesState).toBe('none');

    expect(app.storyPipeline.requestPlaces(story.id).queued).toBe(true);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready');

    const s = app.stories.get(story.id)!;
    expect(places.calls).toBe(1);
    expect(s.places.map((p) => p.name)).toEqual(['Kyiv', 'Ukraine']);
    expect(s.places[0]).toMatchObject({ status: 'located', lat: KYIV.lat, lon: KYIV.lon, label: 'Kyiv, Ukraine' });
    expect(s.places[0]!.sources).toHaveLength(1);
  });

  it('keeps a place the gazetteer does not know, without a pin', async () => {
    const app = await setup({ geocoder: new FakeGeocoder({ Ukraine: UKRAINE }) });
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestPlaces(story.id);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready');
    const s = app.stories.get(story.id)!;
    const kyiv = s.places.find((p) => p.name === 'Kyiv')!;
    expect(kyiv.status).toBe('unresolved');
    expect(kyiv.lat).toBeNull();
    expect(s.places.find((p) => p.name === 'Ukraine')!.status).toBe('located');
  });

  it('asks the gazetteer once for a name it has already answered', async () => {
    const geocoder = new FakeGeocoder({ Kyiv: KYIV, Ukraine: UKRAINE });
    const app = await setup({ geocoder });
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    app.storyPipeline.requestPlaces(storyOf('a').id);
    await waitFor(() => app.stories.get(storyOf('a').id)!.placesState === 'ready');
    expect(geocoder.calls).toEqual(['Kyiv', 'Ukraine']);

    await publish([{ guid: 'b', title: 'A volcano erupts in Iceland', host: 'wire.example.com' }]);
    expect(storyOf('b').id).not.toBe(storyOf('a').id);
    app.storyPipeline.requestPlaces(storyOf('b').id);
    await waitFor(() => app.stories.get(storyOf('b').id)!.placesState === 'ready');
    // The second story names the same places, so the gazetteer is not asked again.
    expect(geocoder.calls).toEqual(['Kyiv', 'Ukraine']);
  });

  it('keeps the places when the gazetteer is down', async () => {
    const geocoder = new FakeGeocoder();
    geocoder.fail = true;
    const app = await setup({ geocoder });
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestPlaces(story.id);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready', 20000);
    const s = app.stories.get(story.id)!;
    expect(s.places.map((p) => p.name)).toEqual(['Kyiv', 'Ukraine']);
    expect(s.places.every((p) => p.status === 'unresolved')).toBe(true);
    expect(s.placesError).toMatch(/gazetteer/);
  });

  it('outdates the places when the story develops', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestPlaces(story.id);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready');

    await publish([{ guid: 'b', title: 'Kyiv update: more strikes', host: 'wire.example.com' }]);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'stale');
  });

  it('offers the map on the story page and answers with the places', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    app.storyPipeline.requestPlaces(story.id);
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready');

    server = buildServer(app);
    const page = await server.inject({ method: 'GET', url: `/stories/${story.id}` });
    expect(page.statusCode).toBe(200);
    const { document } = parseHTML(page.body);
    const toggle = document.querySelector('[data-map-toggle]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-controls')).toBe('story-map');
    const card = document.querySelector('#story-map');
    expect(card!.hasAttribute('hidden')).toBe(true);
    expect(card!.textContent).toContain('Kyiv');

    const opened = await server.inject({ method: 'GET', url: `/stories/${story.id}?map=1` });
    const openDoc = parseHTML(opened.body).document;
    expect(openDoc.querySelector('#story-map')!.hasAttribute('hidden')).toBe(false);
    const data = openDoc.querySelector('[data-map-data]')!.textContent!;
    const parsed = JSON.parse(data);
    expect(parsed.places.map((p: { name: string }) => p.name)).toEqual(['Kyiv', 'Ukraine']);
    expect(parsed.tileUrl).toContain('tile.openstreetmap.org');

    const api = await server.inject({ method: 'GET', url: `/api/stories/${story.id}/places` });
    expect(api.statusCode).toBe(200);
    const body = JSON.parse(api.body);
    expect(body.state).toBe('ready');
    expect(body.places.map((p: { name: string }) => p.name)).toEqual(['Kyiv', 'Ukraine']);
  });

  it('queues a lookup when the reader asks for the map', async () => {
    const app = await setup();
    await publish([{ guid: 'a', title: 'A strike in Kyiv', host: 'wire.example.com' }]);
    const story = storyOf('a');
    server = buildServer(app);
    const res = await server.inject({ method: 'POST', url: `/stories/${story.id}/places` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain('/stories/');
    expect(res.headers.location).toContain('map=1');
    await waitFor(() => app.stories.get(story.id)!.placesState === 'ready');
  });
});
