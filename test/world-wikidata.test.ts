import { describe, expect, it } from 'vitest';
import { Wikidata } from '../src/world/wikidata.js';

/**
 * A Wikidata that answers from a file instead of from the internet.
 */
function fakeWikidata(entities: Record<string, unknown>): Wikidata {
  return new Wikidata({
    baseUrl: 'https://www.wikidata.org',
    queryUrl: 'https://query.wikidata.org/sparql',
    userAgent: 'Mimir/test',
    timeoutMs: 1000,
    minIntervalMs: 0,
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ entities }),
    })) as unknown as typeof fetch,
  });
}

/** A statement that starts and ends at the times given. */
function membership(start: string, end: string | null): unknown {
  return {
    mainsnak: {
      snaktype: 'value',
      property: 'P102',
      datavalue: { value: { id: 'Q2' }, type: 'wikibase-entityid' },
    },
    rank: 'normal',
    qualifiers: {
      ...(start
        ? { P580: [{ snaktype: 'value', datavalue: { value: { time: start }, type: 'time' } }] }
        : {}),
      ...(end ? { P582: [{ snaktype: 'value', datavalue: { value: { time: end }, type: 'time' } }] } : {}),
    },
  };
}

function person(claims: unknown[]): Record<string, unknown> {
  return {
    id: 'Q1',
    labels: { en: { value: 'A Leader' } },
    claims: { P102: claims },
  };
}

describe('reading Wikidata times', () => {
  it('gives a year a term every day it could have covered', async () => {
    const wikidata = fakeWikidata({ Q1: person([membership('+2019-00-00T00:00:00Z', '+2026-00-00T00:00:00Z')]) });

    const entities = await wikidata.entities(['Q1']);

    const claim = entities.get('Q1')!.claims.P102![0]!;
    // A term that started in 2019 and ended in 2026 covers the whole of both
    // years. Writing "2019-00-00" would say it ended in January, on a day that
    // does not exist.
    expect(claim.start).toBe('2019-01-01');
    expect(claim.end).toBe('2026-12-31');
  });

  it('gives a month the days it could have covered', async () => {
    const wikidata = fakeWikidata({ Q1: person([membership('+2026-05-00T00:00:00Z', '+2026-07-00T00:00:00Z')]) });

    const entities = await wikidata.entities(['Q1']);

    const claim = entities.get('Q1')!.claims.P102![0]!;
    expect(claim.start).toBe('2026-05-01');
    expect(claim.end).toBe('2026-07-31');
  });

  it('leaves a date that is whole alone', async () => {
    const wikidata = fakeWikidata({ Q1: person([membership('+2026-09-27T00:00:00Z', '+2026-12-01T00:00:00Z')]) });

    const entities = await wikidata.entities(['Q1']);

    const claim = entities.get('Q1')!.claims.P102![0]!;
    expect(claim.start).toBe('2026-09-27');
    expect(claim.end).toBe('2026-12-01');
  });

  it('says a term with no end is still running', async () => {
    const wikidata = fakeWikidata({ Q1: person([membership('+2026-00-00T00:00:00Z', null)]) });

    const entities = await wikidata.entities(['Q1']);

    const claim = entities.get('Q1')!.claims.P102![0]!;
    expect(claim.start).toBe('2026-01-01');
    expect(claim.end).toBeNull();
  });
});
