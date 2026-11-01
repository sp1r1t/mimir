/**
 * Build the world map's shapes from Natural Earth.
 *
 * Natural Earth's 110m admin-0 countries are public domain. This script downloads
 * them, simplifies them for a map that is read at a glance, and writes
 * `public/vendor/world/countries.json`.
 *
 *   npx tsx scripts/build-world-geo.ts
 *
 * The download is cached in `data/`, which is not in the repository. The shapes that
 * come out are deliberately coarse: the map colours a country as one mark, and the
 * detail of a coastline at this scale is noise.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const CACHE = resolve('data/ne_110m_admin_0_countries.geojson');
const OUT = resolve('public/vendor/world/countries.json');

interface Position {
  type: string;
  coordinates: number[][] | number[][][];
}

interface Feature {
  type: 'Feature';
  properties: Record<string, string | number | null>;
  geometry: Position;
}

/**
 * The names Natural Earth abbreviates, and the ones Mimir writes out in full.
 * A map label is read at a glance, so "W. Sahara" has to become "Western Sahara".
 */
const RENAME: Record<string, string> = {
  'W. Sahara': 'Western Sahara',
  'Dem. Rep. Congo': 'DR Congo',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Dominican Rep.': 'Dominican Republic',
  'Central African Rep.': 'Central African Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  'S. Sudan': 'South Sudan',
  'Congo': 'Republic of the Congo',
  'Falkland Is.': 'Falkland Islands',
  'Solomon Is.': 'Solomon Islands',
  'Fr. S. Antarctic Lands': 'French Southern Territories',
  'Gambia': 'The Gambia',
  'Bahamas': 'The Bahamas',
  'eSwatini': 'Eswatini',
  'United States of America': 'United States',
  'Czechia': 'Czechia',
  "Côte d'Ivoire": "Côte d'Ivoire",
};

type Ring = number[][];

function ringsOf(geometry: Position): Ring[] {
  const coords = geometry.coordinates as number[][][] | number[][][];
  if (geometry.type === 'Polygon') return [coords[0] as Ring];
  if (geometry.type === 'MultiPolygon') return (coords as number[][][][]).map((poly) => poly[0]);
  return [];
}

/** The area of a ring, in square degrees. Planar, which is enough to rank countries. */
function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function pointInRing(point: number[], ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if (y1 > y !== y2 > y) {
      const crossing = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
      if (x < crossing) inside = !inside;
    }
  }
  return inside;
}

function ringCentroid(ring: Ring): number[] {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (area === 0) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  }
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

/**
 * A point on the land of a country, for a label to sit on. The centroid of a
 * crescent falls in the sea, so when that happens the widest interior span is
 * used instead.
 */
function visualCentre(geometry: Position): number[] | null {
  const rings = ringsOf(geometry);
  if (!rings.length) return null;
  // The largest ring is the mainland: a country with overseas parts keeps its
  // label on the part the reader sees.
  const main = rings.reduce((a, b) => (Math.abs(ringArea(a)) >= Math.abs(ringArea(b)) ? a : b));
  const centre = ringCentroid(main);
  if (pointInRing(centre, main)) return centre;

  const ys = main.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  let best: number[] | null = null;
  let bestWidth = 0;
  const step = (maxY - minY) / 400 || 0.1;
  for (let y = minY; y <= maxY; y += step) {
    const xs: number[] = [];
    for (let i = 0; i < main.length - 1; i += 1) {
      const [x1, y1] = main[i];
      const [x2, y2] = main[i + 1];
      if (y1 > y !== y2 > y) xs.push(((x2 - x1) * (y - y1)) / (y2 - y1) + x1);
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i += 1) {
      const width = xs[i + 1] - xs[i];
      if (width > 0 && width > bestWidth) {
        bestWidth = width;
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
  }
  return best ?? centre;
}

/** The ring a point falls in, if any. */
function pointInCountry(point: number[], geometry: Position): boolean {
  return ringsOf(geometry).some((ring) => pointInRing(point, ring));
}

/** The box a country covers, in degrees. */
function bboxOf(geometry: Position): [number, number, number, number] {
  const points = ringsOf(geometry).flat();
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function roundCoords(coords: unknown, digits = 2): unknown {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    return [Number((coords[0] as number).toFixed(digits)), Number((coords[1] as number).toFixed(digits))];
  }
  return (coords as unknown[]).map((c) => roundCoords(c, digits));
}

async function loadSource(): Promise<Feature[]> {
  if (!existsSync(CACHE)) {
    process.stdout.write('Downloading Natural Earth 110m countries…\n');
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`The source could not be downloaded (HTTP ${res.status})`);
    const body = await res.text();
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, body);
  }
  const parsed = JSON.parse(await readFile(CACHE, 'utf8')) as { features: Feature[] };
  return parsed.features;
}

async function main(): Promise<void> {
  const features = await loadSource();
  const out: unknown[] = [];
  const skipped: string[] = [];
  const moved: string[] = [];

  for (const feature of features) {
    const p = feature.properties;
    const iso2 = String(p.ISO_A2_EH ?? p.ISO_A2 ?? '').trim().toUpperCase();
    if (iso2.length !== 2) {
      skipped.push(String(p.NAME));
      continue;
    }
    const centre = visualCentre(feature.geometry);
    // Natural Earth's own label point, which is where a cartographer would put the
    // name. A few of them fall in the sea, so those fall back to the centre of the
    // land: a label always sits on the colour of its own country.
    const labelX = Number(p.LABEL_X);
    const labelY = Number(p.LABEL_Y);
    const neLabel: number[] | null =
      Number.isFinite(labelX) && Number.isFinite(labelY) ? [labelX, labelY] : null;
    const onLand = neLabel ? pointInCountry(neLabel, feature.geometry) : false;
    const anchor = onLand ? neLabel : centre;
    if (neLabel && !onLand) moved.push(String(p.NAME));
    const size = ringsOf(feature.geometry).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
    const box = bboxOf(feature.geometry);

    out.push({
      iso2,
      name: RENAME[String(p.NAME)] ?? String(p.NAME),
      continent: p.CONTINENT ?? null,
      center: centre ? [Number(centre[0].toFixed(3)), Number(centre[1].toFixed(3))] : null,
      label: anchor ? [Number(anchor[0].toFixed(3)), Number(anchor[1].toFixed(3))] : null,
      bbox: box.map((v) => Number(v.toFixed(2))),
      size: Number(Math.sqrt(size).toFixed(3)),
      geometry: {
        type: feature.geometry.type,
        coordinates: roundCoords(feature.geometry.coordinates),
      },
    });
  }

  out.sort((a, b) => String((a as { iso2: string }).iso2).localeCompare(String((b as { iso2: string }).iso2)));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        source: 'Natural Earth 110m admin 0 countries (public domain)',
        sourceUrl: SOURCE_URL,
        generated: new Date().toISOString().slice(0, 10),
        features: out,
      },
      null,
      0,
    ).replace(/</g, '\\u003c'),
  );
  process.stdout.write(`Wrote ${out.length} countries to ${OUT}. Skipped: ${skipped.join(', ') || 'none'}\n`);
  if (moved.length) process.stdout.write(`Labels moved onto land: ${moved.join(', ')}\n`);
}

await main();
