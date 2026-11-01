import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../src/db/database.js';
import { buildServer } from '../src/web/server.js';
import { daysUntil, electionStanding, POSITION_SCORE, type CountrySnapshot } from '../src/world/schema.js';
import { makeApp, type TestApp } from './helpers.js';

let app: TestApp | null = null;
let server: FastifyInstance | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  await app?.cleanup();
  app = null;
});

/** A story with a place in it, so the activity of a country can be counted. */
function storyWithPlace(db: DB, id: number, headline: string, iso2: string, at: string): void {
  db.prepare(
    `INSERT INTO stories (id, status, headline, article_count, publisher_count, development_count,
       latest_development_at, created_at, updated_at)
     VALUES (?, 'active', ?, 1, 1, 2, ?, ?, ?)`,
  ).run(id, headline, at, at, at);
  db.prepare(
    `INSERT INTO story_places (story_id, name, kind, country, country_code, status, sources, created_at)
     VALUES (?, 'Somewhere', 'city', ?, ?, 'located', '[]', ?)`,
  ).run(id, iso2.toUpperCase(), iso2.toLowerCase(), at);
}

/** One country as a fetch would leave it. */
function snapshot(iso2: string, over: Partial<CountrySnapshot> = {}): CountrySnapshot {
  return {
    iso2,
    name: 'Serbia',
    headOfState: 'President Aleksandar Vučić',
    headOfGovernment: 'Prime Minister Đuro Macut',
    party: 'Serbian Progressive Party',
    coalition: [],
    ideology: 'social conservatism',
    position: 'centre-right',
    score: 0.5,
    ideologySource: 'Wikidata',
    sourceUrl: `https://www.wikidata.org/wiki/Q${iso2}`,
    nextElectionDate: '2026-12-14',
    nextElectionKind: 'parliamentary',
    electionSource: 'Wikidata',
    state: 'fresh',
    note: null,
    fetchedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('the world snapshot', () => {
  it('starts empty and fills up when a fetch is written', async () => {
    app = makeApp();
    const world = app.app.world;
    expect(world.list()).toHaveLength(0);
    expect(world.get('RS')).toBeNull();

    const written = world.saveSnapshots([snapshot('RS')]);
    expect(written).toBe(1);
    expect(world.list()).toHaveLength(1);
    expect(world.get('RS')!.party).toBe('Serbian Progressive Party');
    expect(world.get('RS')!.position).toBe('centre-right');
  });

  it('writes a new reading over the old one', async () => {
    app = makeApp();
    const world = app.app.world;
    world.saveSnapshots([snapshot('RS', { party: 'Old Party', position: 'left', score: -1 })]);
    world.saveSnapshots([snapshot('RS', { party: 'New Party', position: 'right', score: 1 })]);
    const row = world.get('RS')!;
    expect(row.party).toBe('New Party');
    expect(row.position).toBe('right');
    expect(world.list()).toHaveLength(1);
  });

  it('leaves a row a person set by hand alone', async () => {
    app = makeApp();
    const world = app.app.world;
    world.saveSnapshots([snapshot('RS', { state: 'manual', party: 'Set by hand' })]);
    world.saveSnapshots([snapshot('RS', { party: 'Serbian Progressive Party' })]);
    expect(world.get('RS')!.party).toBe('Set by hand');
    expect(world.get('RS')!.state).toBe('manual');
  });

  it('says so when the last reading did not work', async () => {
    app = makeApp();
    const world = app.app.world;
    world.saveSnapshots([snapshot('RS')]);
    const marked = world.markStale();
    expect(marked).toBe(1);
    expect(world.get('RS')!.state).toBe('stale');
    // The row itself is still there: it is the last good one.
    expect(world.get('RS')!.party).toBe('Serbian Progressive Party');
  });

  it('writes down what each reading found', async () => {
    app = makeApp();
    const world = app.app.world;
    expect(world.lastFetch()).toBeNull();
    world.recordFetch({
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:03:00.000Z',
      countries: 168,
      unmapped: ['AQ', 'EH'],
    });
    const last = world.lastFetch()!;
    expect(last.countries).toBe(168);
    expect(last.unmapped).toEqual(['AQ', 'EH']);
    expect(last.error).toBeNull();
  });

  it('counts the news that touches a country', async () => {
    app = makeApp();
    const now = new Date('2026-11-01T00:00:00.000Z');
    storyWithPlace(app.app.db, 1, 'An election in Serbia', 'RS', '2026-10-30T00:00:00.000Z');
    storyWithPlace(app.app.db, 2, 'Something else in Serbia', 'RS', '2026-10-20T00:00:00.000Z');
    storyWithPlace(app.app.db, 3, 'An old story in Serbia', 'RS', '2025-01-01T00:00:00.000Z');

    const activity = app.app.world.activity(30);
    expect(activity.get('RS')?.stories).toBe(2);
    expect(app.app.world.storyCount('RS')).toBe(3);
    expect(app.app.world.storiesFor('RS', 10)).toHaveLength(3);
    expect(now.getUTCFullYear()).toBe(2026);
  });

  it('puts a country with an election at the top of the moving list', async () => {
    app = makeApp();
    app.app.world.saveSnapshots([
      snapshot('US', { name: 'United States', nextElectionDate: '2026-11-03', nextElectionKind: 'presidential' }),
      snapshot('RS', { name: 'Serbia', nextElectionDate: '2027-06-01' }),
    ]);
    const now = new Date('2026-11-01T00:00:00.000Z');
    const moving = app.app.world.moving(now);
    const first = moving[0];
    expect(first).toBeDefined();
    expect(first!.snapshot!.iso2).toBe('US');
    expect(first!.reasons.some((r) => r.kind === 'election-now')).toBe(true);
  });
});

describe('the world page', () => {
  it('draws the map and offers the three ways of colouring it', async () => {
    app = makeApp();
    server = buildServer(app.app);
    const res = await server.inject({ url: '/world' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-map-kind="world"');
    expect(res.body).toContain('Colour the map by');
    expect(res.body).toContain('Position of the government');
    expect(res.body).toContain('Moving now');
    // The map can be framed on the news or on the whole world.
    expect(res.body).toContain('data-world-frame="news"');
    expect(res.body).toContain('data-world-frame="all"');
    // Nothing is claimed to be there before it has been read.
    expect(res.body).toContain('No snapshot yet');
  });

  it('gives the fill one meaning at a time', async () => {
    app = makeApp();
    server = buildServer(app.app);
    const politics = await server.inject({ url: '/world?view=politics' });
    expect(politics.body).toContain('Position of the government');
    const activity = await server.inject({ url: '/world?view=activity' });
    expect(activity.body).toContain('Stories in the last 30 days');
    const elections = await server.inject({ url: '/world?view=elections' });
    expect(elections.body).toContain('Next election');
  });

  it('sends the map the countries and what it knows about them', async () => {
    app = makeApp();
    app.app.world.saveSnapshots([snapshot('RS')]);
    server = buildServer(app.app);
    const res = await server.inject({ url: '/world' });
    const match = res.body.match(/<script type="application\/json" data-map-data>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1]!.replace(/\\u003c/g, '<'));
    expect(data.view).toBe('politics');
    expect(data.countries.RS.position).toBe('centre-right');
    expect(data.countries.RS.nextElection).toBe('2026-12-14');
  });

  it('draws the map from shapes and not from tiles', async () => {
    app = makeApp();
    server = buildServer(app.app);
    const res = await server.inject({ url: '/world' });
    const match = res.body.match(/<script type="application\/json" data-map-data>([\s\S]*?)<\/script>/);
    const data = JSON.parse(match![1]!.replace(/\\u003c/g, '<'));
    // The countries are the map. A street map underneath a political map only
    // argues with it.
    expect(data.countriesUrl).toBe('/static/vendor/world/countries.json');
    expect(data.tileUrl).toBeUndefined();
    expect(data.attribution).toBeUndefined();
    // The shapes come from somewhere, and the page says where.
    expect(res.body).toContain('Natural Earth');
  });

  it('shows a country with its government, its election and its news', async () => {
    app = makeApp();
    app.app.world.saveSnapshots([snapshot('RS')]);
    server = buildServer(app.app);
    storyWithPlace(app.app.db, 7, 'Serbia goes to the polls', 'RS', '2026-10-31T00:00:00.000Z');
    const res = await server.inject({ url: '/world/rs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Serbia');
    expect(res.body).toContain('Serbian Progressive Party');
    expect(res.body).toContain('2026-12-14');
    expect(res.body).toContain('Serbia goes to the polls');
    expect(res.body).toContain('data-map-kind="country"');
  });

  it('says so when it knows nothing about a country', async () => {
    app = makeApp();
    server = buildServer(app.app);
    const res = await server.inject({ url: '/world/sm' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('no snapshot of this country yet');
  });
});

describe('the shapes of the map', () => {
  const shapes = JSON.parse(readFileSync(resolve('public/vendor/world/countries.json'), 'utf8')) as {
    features: { iso2: string; name: string; label: [number, number] | null; bbox: number[] | null; size: number }[];
  };

  it('gives every country a name and a place to write it', () => {
    expect(shapes.features.length).toBeGreaterThan(150);
    for (const country of shapes.features) {
      expect(country.name.length).toBeGreaterThan(1);
      expect(country.label).not.toBeNull();
      expect(country.bbox).not.toBeNull();
      const [minLon, minLat, maxLon, maxLat] = country.bbox!;
      expect(minLon!).toBeLessThan(maxLon!);
      expect(minLat!).toBeLessThan(maxLat!);
    }
  });

  it('writes a name inside the country it belongs to', () => {
    // The name of a country is written on the colour of that country, so the point
    // it is written at has to be on its own land.
    const serbia = shapes.features.find((c) => c.iso2 === 'RS');
    expect(serbia).toBeDefined();
    const [lon, lat] = serbia!.label!;
    const [minLon, minLat, maxLon, maxLat] = serbia!.bbox!;
    expect(lon!).toBeGreaterThan(minLon!);
    expect(lon!).toBeLessThan(maxLon!);
    expect(lat!).toBeGreaterThan(minLat!);
    expect(lat!).toBeLessThan(maxLat!);
  });

  it('knows which countries are big enough to be named', () => {
    const bySize = [...shapes.features].sort((a, b) => b.size - a.size);
    expect(bySize[0]!.iso2).toBe('AQ');
    // A country big enough to hold a name is bigger than a country that is not.
    expect(bySize.find((c) => c.iso2 === 'RS')!.size).toBeGreaterThan(
      bySize.find((c) => c.iso2 === 'LU')!.size,
    );
  });
});

describe('the axis', () => {
  it('puts the poles at the ends and nothing off the axis', () => {
    expect(POSITION_SCORE.left).toBe(-1);
    expect(POSITION_SCORE.right).toBe(1);
    expect(POSITION_SCORE.centre).toBe(0);
    expect(POSITION_SCORE['not-on-axis']).toBeNull();
    expect(POSITION_SCORE.unknown).toBeNull();
  });

  it('knows when an election is happening', () => {
    const now = new Date('2026-11-01T00:00:00.000Z');
    expect(electionStanding('2026-11-03T00:00:00.000Z', now)).toBe('now');
    expect(electionStanding('2026-12-14T00:00:00.000Z', now)).toBe('soon');
    expect(electionStanding('2026-01-01T00:00:00.000Z', now)).toBe('past');
    expect(electionStanding(null, now)).toBe('none');
    expect(daysUntil('2026-11-15T00:00:00.000Z', now)).toBe(14);
  });
});
