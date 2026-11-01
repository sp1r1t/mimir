import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_DIR } from '../paths.js';
import type { WorldCountryRef } from './fetch.js';

interface Shape {
  iso2: string;
  name: string;
}

/**
 * The countries the map draws.
 *
 * The map is made of Natural Earth's shapes, and those shapes are the list of
 * countries Mimir keeps a snapshot of: a country that is not on the map has no
 * row, and a row without a shape has nowhere to be drawn.
 */
export function mapCountries(): WorldCountryRef[] {
  const file = resolve(PUBLIC_DIR, 'vendor/world/countries.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { features?: Shape[] };
  return (parsed.features ?? [])
    .filter((f) => typeof f.iso2 === 'string' && f.iso2.length === 2 && typeof f.name === 'string')
    .map((f) => ({ iso2: f.iso2.toUpperCase(), name: f.name }));
}
