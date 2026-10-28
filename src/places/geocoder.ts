import { sleep } from '../util/backoff.js';
import type { PlaceKind } from './places.js';

/** Where a place is, as the gazetteer says. */
export interface Geocode {
  status: 'located' | 'unresolved';
  lat: number | null;
  lon: number | null;
  /** A short name for the pin: "Kyiv, Ukraine". */
  label: string | null;
  /** The gazetteer's own wording, which says how sure it is. */
  displayName: string | null;
  osmId: string | null;
}

/** What to look up: the name, the country, and what kind of place it is. */
export interface PlaceQuery {
  name: string;
  country: string | null;
  /** ISO 3166-1 alpha-2, when the articles place it in a country. */
  countryCode: string | null;
  kind: PlaceKind;
  /** The name to look up, made unambiguous by the model. */
  query: string | null;
}

export interface Geocoder {
  lookup(place: PlaceQuery): Promise<Geocode>;
}

export const UNRESOLVED: Geocode = {
  status: 'unresolved',
  lat: null,
  lon: null,
  label: null,
  displayName: null,
  osmId: null,
};

export interface NominatimOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
  /** The gazetteer's public instance allows one request a second. */
  minIntervalMs: number;
  fetchImpl?: typeof fetch;
}

interface NominatimHit {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  /** jsonv2 calls the broad class "category": place, boundary, railway, leisure, … */
  category?: string;
  type?: string;
  addresstype?: string;
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
}

/**
 * The gazetteer's own filter for the kind of thing it should answer with. It is the
 * strongest lever there is: a bare "Gaza" is answered with a province in Mozambique,
 * but "Gaza" asked for as a city is answered with the city in Gaza, and "West Bank"
 * asked for as a region is answered with the region in Palestine.
 */
const FEATURE_TYPE: Partial<Record<PlaceKind, string>> = {
  city: 'city',
  town: 'city',
  country: 'country',
  region: 'state',
};

/** The address types that fit each kind of place. */
const ADDRESSTYPE: Partial<Record<PlaceKind, string[]>> = {
  city: ['city', 'town', 'village', 'municipality', 'borough', 'suburb', 'hamlet', 'locality'],
  town: ['town', 'city', 'village', 'municipality', 'borough', 'hamlet', 'locality'],
  country: ['country'],
  region: ['state', 'region', 'province', 'county', 'state_district'],
};

/**
 * The OpenStreetMap gazetteer, as it is used here: a name in, a place out. The public
 * instance asks for one request a second and for a User-Agent that says who is asking,
 * so both are honoured.
 *
 * The same name can mean different places, so the lookup is narrowed three ways: the
 * model resolves the place in the articles and says which country it is in, the search
 * asks the gazetteer for that kind of place, and the answers are judged — a hit in a
 * country the model did not name is a different place and is passed over.
 */
export class NominatimGeocoder implements Geocoder {
  private lastRequestAt = 0;

  constructor(private readonly opts: NominatimOptions) {}

  async lookup(place: PlaceQuery): Promise<Geocode> {
    const q = (place.query ?? place.name).trim();
    if (!q) return UNRESOLVED;
    const country = place.country?.trim() || null;
    const code = place.countryCode?.trim().toLowerCase() || null;
    const featureType = FEATURE_TYPE[place.kind] ?? null;

    // The narrowest search first: the kind of place, in the country the model named.
    // Then the same kind without the country, and at last the bare name. A place the
    // gazetteer files under a different country than the articles give it (the Gaza
    // Strip carries no country code of its own) is only found by the wider searches.
    const searches: { featureType: string | null; code: string | null }[] = [];
    if (featureType) searches.push({ featureType, code });
    if (featureType && code) searches.push({ featureType, code: null });
    else if (!featureType && code) searches.push({ featureType: null, code });
    searches.push({ featureType: null, code: null });

    let best: NominatimHit | null = null;
    let bestScore = -1;
    for (const search of searches) {
      const hits = await this.search(q, search.featureType, search.code);
      const hit = this.pick(hits, { code, kind: place.kind, q });
      if (!hit) continue;
      const score = this.score(hit, { code, kind: place.kind, q });
      if (score > bestScore) {
        best = hit;
        bestScore = score;
      }
      // A hit that is the right kind of place, in the right country, is the answer.
      if (this.fits(hit, { code, kind: place.kind, q })) break;
    }
    if (!best) return UNRESOLVED;

    const lat = Number(best.lat);
    const lon = Number(best.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return UNRESOLVED;

    // The gazetteer answers in the language of the place; the name in English is easier to
    // read for the person who wrote the story.
    const english = best.namedetails?.['name:en'] ?? null;
    const placeName = english ?? best.name ?? null;
    const label = placeName
      ? country && placeName.toLowerCase() !== country.toLowerCase()
        ? `${placeName}, ${country}`
        : placeName
      : best.display_name ?? null;

    return {
      status: 'located',
      lat,
      lon,
      label,
      displayName: best.display_name ?? null,
      osmId: best.osm_type && best.osm_id != null ? `${best.osm_type}/${best.osm_id}` : null,
    };
  }

  /** The hit that fits the place best, or none. */
  private pick(
    hits: NominatimHit[],
    opts: { code: string | null; kind: PlaceKind; q: string },
  ): NominatimHit | null {
    const places = hits.filter((hit) => isPlace(hit));
    // A place of the asked-for kind beats a place of another kind, however well it
    // matches the name: a suburb is not the region that shares its name.
    const fitting = places.filter((hit) => fitsKind(hit, opts.kind));
    const candidates = fitting.length ? fitting : places;
    let best: NominatimHit | null = null;
    let bestScore = -1;
    for (const hit of candidates) {
      const score = this.score(hit, opts);
      if (score > bestScore) {
        best = hit;
        bestScore = score;
      }
    }
    return best;
  }

  /** How well a hit answers the question that was asked. */
  private score(hit: NominatimHit, opts: { code: string | null; kind: PlaceKind; q: string }): number {
    const cc = hit.address?.country_code?.toLowerCase() ?? null;
    // A place in a country the model did not name is a different place.
    if (opts.code && cc && cc !== opts.code) return -1;
    let score = 0;
    if (opts.code && cc === opts.code) score += 4;
    if (fitsKind(hit, opts.kind)) score += 2;
    score += nameScore(hit, opts.q);
    return score;
  }

  /** Is this hit plainly the place that was asked for? */
  private fits(hit: NominatimHit, opts: { code: string | null; kind: PlaceKind; q: string }): boolean {
    const cc = hit.address?.country_code?.toLowerCase() ?? null;
    if (opts.code && cc && cc !== opts.code) return false;
    return fitsKind(hit, opts.kind) && nameScore(hit, opts.q) > 0;
  }

  /** Ask the gazetteer once, and wait for its turn first. */
  private async search(q: string, featureType: string | null, countryCode: string | null): Promise<NominatimHit[]> {
    const url = new URL('/search', this.opts.baseUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '8');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    if (featureType) url.searchParams.set('featureType', featureType);
    if (countryCode) url.searchParams.set('countrycodes', countryCode);
    await this.waitTurn();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Geocoder request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`Geocoder answered ${res.status} for "${q}"`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Geocoder answer for "${q}" was not JSON`);
    }
    if (!Array.isArray(body)) throw new Error(`Geocoder answer for "${q}" was not a list`);
    return body as NominatimHit[];
  }

  /** Keep the requests apart, so the gazetteer sees at most one a second. */
  private async waitTurn(): Promise<void> {
    const earliest = this.lastRequestAt + this.opts.minIntervalMs;
    const now = Date.now();
    if (earliest > now) await sleep(earliest - now);
    this.lastRequestAt = Date.now();
  }
}

/** Is this hit a place at all? A station, a street or a stadium is not one. */
function isPlace(hit: NominatimHit): boolean {
  const category = hit.category;
  if (category) return category === 'place' || category === 'boundary';
  // Without a category, fall back on the type: a road, a house or a station is not a place.
  const type = hit.type?.toLowerCase();
  if (!type) return true;
  return ![
    'road', 'street', 'house', 'residential', 'pedestrian', 'track', 'footway', 'path',
    'service', 'primary', 'secondary', 'tertiary', 'unclassified', 'living_street',
    'station', 'halt', 'tram_stop', 'subway_station', 'bus_station', 'aeroway',
  ].includes(type);
}

/** Is this hit a place of the kind that was asked for? */
function fitsKind(hit: NominatimHit, kind: PlaceKind): boolean {
  const types = ADDRESSTYPE[kind];
  if (!types) return true;
  const addressType = hit.addresstype;
  if (addressType) return types.includes(addressType);
  // Without an address type, the hit's own type speaks: "city", "town", "state", …
  const own = hit.type?.toLowerCase();
  if (!own) return false;
  return types.includes(own);
}

/**
 * How well the hit carries the name that was asked for. The whole query matching
 * exactly is the strongest signal: "Gaza Strip" is the Gaza Strip, not the Gaza
 * province of Mozambique.
 */
function nameScore(hit: NominatimHit, q: string): number {
  const wanted = q.trim().toLowerCase();
  const names = [hit.name, hit.namedetails?.['name:en']].filter(Boolean).map((n) => String(n).toLowerCase());
  if (!names.length) return 0;
  if (names.some((n) => n === wanted)) return 2;
  const word = wanted.split(/[\s,]+/)[0] ?? '';
  if (word.length < 3) return 0;
  return names.some((n) => n.includes(word)) ? 1 : 0;
}
