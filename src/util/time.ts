export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function iso(d: Date): string {
  return d.toISOString();
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** Parse a date string from a feed; returns ISO-8601 UTC or null when unparseable. */
export function parseFeedDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2200) return null;
  return d.toISOString();
}
