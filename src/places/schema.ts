import { z } from 'zod';

export const PLACE_KINDS = ['city', 'town', 'country', 'region', 'other'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** A field the model may leave empty; an empty string means "not stated". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))
    .catch(null);

/** A two-letter country code, or nothing when the model left it out or got it wrong. */
export const countryCode = z
  .string()
  .trim()
  .nullish()
  .transform((v) => {
    const code = v?.toLowerCase();
    return code && /^[a-z]{2}$/.test(code) ? code : null;
  })
  .catch(null);

/**
 * A place as the model names it: the words it used, and the articles that name it.
 * The coordinates are not the model's to give.
 */
export const NamedPlaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(PLACE_KINDS).catch('other'),
    country: optionalText(120),
    country_code: countryCode,
    query: optionalText(160),
    role: optionalText(200),
    sources: z.array(z.number().int().positive()).min(1).max(20),
  })
  .strict();

export type NamedPlace = z.infer<typeof NamedPlaceSchema>;

/** A place as Mimir holds it: the same place, in the shape the rest of the code reads. */
export const FoundPlaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(PLACE_KINDS),
    country: z.string().nullable(),
    countryCode: z.string().nullable(),
    query: z.string().nullable(),
    role: z.string().nullable(),
    sources: z.array(z.number().int().positive()),
  })
  .strict();

export type FoundPlace = z.infer<typeof FoundPlaceSchema>;

/** A place without its citations: what a provider names, before the articles are attached. */
export interface PlaceName {
  name: string;
  kind: PlaceKind;
  country?: string | null;
  countryCode?: string | null;
  query?: string | null;
  role?: string | null;
}

export function toFoundPlace(p: NamedPlace): FoundPlace {
  return {
    name: p.name,
    kind: p.kind,
    country: p.country?.trim() || null,
    countryCode: p.country_code?.trim().toLowerCase() || null,
    query: p.query?.trim() || null,
    role: p.role?.trim() || null,
    sources: [...new Set(p.sources)].sort((a, b) => a - b),
  };
}

/** The name a place is filed under, so the same place is not listed twice. */
export function placeKey(name: string, country: string | null): string {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const c = country?.trim().toLowerCase() ?? '';
  return c ? `${n}|${c}` : n;
}

/**
 * The key of a cached gazetteer answer. The kind and the country are part of it: the
 * gazetteer is asked differently for a city and for a region, and the country decides
 * which of several places of the same name is meant.
 */
export function geocodeKey(query: string, kind: PlaceKind, countryCode: string | null): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${q}|${kind}|${countryCode?.toLowerCase() ?? ''}`;
}

/**
 * Read the places out of a brief's answer. A place that does not fit is dropped, and one
 * that cites an article the model was not given loses that citation: a bad place must
 * never cost the reader the brief it came with.
 */
export function parseBriefPlaces(value: unknown, allowedIds: Set<number>): FoundPlace[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const places: FoundPlace[] = [];
  for (const raw of value.slice(0, 12)) {
    const parsed = NamedPlaceSchema.safeParse(raw);
    if (!parsed.success) continue;
    const sources = parsed.data.sources.filter((id) => allowedIds.has(id));
    if (!sources.length) continue;
    const place = toFoundPlace({ ...parsed.data, sources });
    const key = placeKey(place.name, place.country);
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }
  return places;
}
