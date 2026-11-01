import { afterEach, describe, expect, it } from 'vitest';
import { electionKind, WorldFetcher, type WorldCountryRef } from '../src/world/fetch.js';
import { WORLD_FETCH } from '../src/world/pipeline.js';
import type { SparqlRow, WikidataEntity, WikidataReader } from '../src/world/wikidata.js';
import { makeApp, waitFor, type TestApp } from './helpers.js';

/**
 * A Wikidata that answers from a file instead of from the internet.
 *
 * The queries are matched by the shape of the question: which property is asked
 * about, and what it is asked of. A query the double does not know is answered
 * with nothing, so a new question in the fetcher shows up here as an empty
 * answer rather than as a wrong one.
 */
class FakeWikidata implements WikidataReader {
  /** Every question that was asked, so a test can look at the shape of them. */
  readonly queries: string[] = [];

  constructor(
    private readonly entitiesById: Record<string, WikidataEntity>,
    private readonly answers: { match: RegExp; rows: SparqlRow[] }[],
  ) {}

  async entities(ids: string[]): Promise<Map<string, WikidataEntity>> {
    const out = new Map<string, WikidataEntity>();
    for (const id of ids) {
      const entity = this.entitiesById[id];
      if (entity) out.set(id, entity);
    }
    return out;
  }

  async sparql(query: string): Promise<SparqlRow[]> {
    this.queries.push(query);
    for (const answer of this.answers) if (answer.match.test(query)) return answer.rows;
    return [];
  }
}

function entity(id: string, label: string, claims: WikidataEntity['claims'] = {}): WikidataEntity {
  return { id, label, description: null, claims };
}

function cell(value: string): SparqlRow[string] {
  return { value, type: 'uri' };
}

function row(bindings: Record<string, string>): SparqlRow {
  const out: SparqlRow = {};
  for (const [key, value] of Object.entries(bindings)) out[key] = cell(value);
  return out;
}

/** A row whose date is a date, not an item. */
function dateRow(bindings: Record<string, string>): SparqlRow {
  const out = row(bindings);
  if (out.date) out.date = { value: bindings.date!, type: 'literal' };
  return out;
}

const COUNTRIES: WorldCountryRef[] = [
  { iso2: 'RS', name: 'Serbia' },
  { iso2: 'KP', name: 'North Korea' },
  { iso2: 'AQ', name: 'Antarctica' },
];

describe('reading the world', () => {
  it('puts a country on the axis from the party that governs it', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P35: [{ property: 'P35', value: 'Q1', rank: 'normal', start: '2017-05-31', end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'Aleksandar Vučić', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [{ property: 'P102', value: 'Q2', rank: 'normal', start: '2008-01-01', end: null }],
        }),
        Q2: entity('Q2', 'Serbian Progressive Party', {
          P1387: [{ property: 'P1387', value: 'Q3', rank: 'normal', start: null, end: null }],
          P1142: [{ property: 'P1142', value: 'Q4', rank: 'normal', start: null, end: null }],
        }),
        Q3: entity('Q3', 'right-wing populism', {
          P361: [{ property: 'P361', value: 'Q76074', rank: 'normal', start: null, end: null }],
        }),
        Q4: entity('Q4', 'national conservatism', {}),
        Q76074: entity('Q76074', 'right-wing', {}),
        Q6: entity('Q6', '2026 Serbian parliamentary election', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q3', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
        {
          match: /wdt:P1001/,
          rows: [
            dateRow({
              country: 'http://www.wikidata.org/entity/Q403',
              election: 'http://www.wikidata.org/entity/Q6',
              date: '2026-12-14T00:00:00Z',
            }),
          ],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    expect(serbia.name).toBe('Serbia');
    expect(serbia.headOfState).toBe('Aleksandar Vučić');
    expect(serbia.headOfGovernment).toBe('Aleksandar Vučić');
    expect(serbia.party).toBe('Serbian Progressive Party');
    expect(serbia.position).toBe('right');
    expect(serbia.score).toBe(1);
    expect(serbia.ideologySource).toBe('Wikidata');
    expect(serbia.sourceUrl).toContain('Q403');
    // The election is dated, so the reader knows when the map may change.
    expect(serbia.nextElectionDate).toBe('2026-12-14');
    expect(serbia.nextElectionKind).toBe('parliamentary');
    expect(serbia.electionSource).toBe('Wikidata');
    // Antarctica is on the map but is not a state, so there is no row for it.
    expect(result.unmapped).toContain('AQ');
    expect(result.snapshots.find((s) => s.iso2 === 'AQ')).toBeUndefined();
  });

  it('says a one-party state is not on the axis', async () => {
    const wikidata = new FakeWikidata(
      {
        Q424: entity('Q424', 'North Korea', {
          P297: [{ property: 'P297', value: 'KP', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P122: [{ property: 'P122', value: 'Q10', rank: 'normal', start: null, end: null }],
          P35: [{ property: 'P35', value: 'Q11', rank: 'normal', start: '2019-04-01', end: null }],
        }),
        Q10: entity('Q10', 'one-party state', {}),
        Q11: entity('Q11', 'Kim Jong Un', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
        }),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'KP', country: 'http://www.wikidata.org/entity/Q424', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const korea = result.snapshots.find((s) => s.iso2 === 'KP')!;
    expect(korea.position).toBe('not-on-axis');
    expect(korea.score).toBeNull();
    expect(korea.note).toContain('one-party state');
  });

  it('leaves a country unknown rather than guessing at it', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'Aleksandar Vučić', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
        }),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    expect(serbia.position).toBe('unknown');
    expect(serbia.score).toBeNull();
    expect(serbia.state).toBe('unknown');
    expect(serbia.note).toContain('no position on the axis');
  });

  it('takes the holder whose term has not ended', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [
            { property: 'P6', value: 'Q20', rank: 'normal', start: '2021-01-01', end: '2024-05-01' },
            { property: 'P6', value: 'Q21', rank: 'normal', start: '2024-05-01', end: null },
          ],
        }),
        Q20: entity('Q20', 'Ana Brnabić', { P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }] }),
        Q21: entity('Q21', 'Đuro Macut', { P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }] }),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    expect(result.snapshots.find((s) => s.iso2 === 'RS')!.headOfGovernment).toBe('Đuro Macut');
  });

  it('keeps the party of a leader who now stands alone', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          // The president left the party in 2026 and now stands on their own.
          P102: [
            { property: 'P102', value: 'Q2', rank: 'normal', start: '2019-01-01', end: '2026-12-31' },
            { property: 'P102', value: 'Q327591', rank: 'normal', start: '2026-01-01', end: null },
          ],
        }),
        Q2: entity('Q2', 'A Party', {
          P1387: [{ property: 'P1387', value: 'Q3', rank: 'normal', start: null, end: null }],
        }),
        Q3: entity('Q3', 'right-wing', {}),
        Q327591: entity('Q327591', 'independent politician', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q3', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    // Standing on their own does not say where the president stands: the party
    // they came from does.
    expect(serbia.party).toBe('A Party');
    expect(serbia.position).toBe('right');
  });

  it('forgets a party a leader left long ago', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [
            { property: 'P102', value: 'Q2', rank: 'normal', start: '2001-01-01', end: '2019-01-01' },
            { property: 'P102', value: 'Q327591', rank: 'normal', start: '2019-01-01', end: null },
          ],
        }),
        Q2: entity('Q2', 'A Party', {
          P1387: [{ property: 'P1387', value: 'Q3', rank: 'normal', start: null, end: null }],
        }),
        Q3: entity('Q3', 'right-wing', {}),
        Q327591: entity('Q327591', 'independent politician', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q3', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    expect(serbia.party).toBeNull();
    expect(serbia.position).toBe('unknown');
  });

  it('reads the position off the ideology when the party names one', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [{ property: 'P102', value: 'Q2', rank: 'normal', start: '2019-01-01', end: null }],
        }),
        Q2: entity('Q2', 'A Party', {
          P1142: [{ property: 'P1142', value: 'Q6', rank: 'normal', start: null, end: null }],
        }),
        Q6: entity('Q6', 'paternalistic conservatism', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q6', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    expect(serbia.party).toBe('A Party');
    expect(serbia.ideology).toBe('paternalistic conservatism');
    expect(serbia.position).toBe('right');
  });

  it('says a party that calls itself authoritarian is not on the axis', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [{ property: 'P102', value: 'Q2', rank: 'normal', start: '2019-01-01', end: null }],
        }),
        Q2: entity('Q2', 'A Party', {
          P1142: [{ property: 'P1142', value: 'Q6229', rank: 'normal', start: null, end: null }],
        }),
        Q6229: entity('Q6229', 'authoritarianism', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    // A government that calls itself authoritarian is not standing to the left
    // or the right of anyone.
    expect(serbia.position).toBe('not-on-axis');
    expect(serbia.ideology).toBe('authoritarianism');
    expect(serbia.score).toBeNull();
    expect(serbia.note).toContain('authoritarianism');
  });

  it('names the party that says where the government stands', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [
            { property: 'P102', value: 'Q2', rank: 'normal', start: '2019-01-01', end: null },
            { property: 'P102', value: 'Q3', rank: 'normal', start: '2024-01-01', end: null },
          ],
        }),
        // The first party says nothing about itself. The second says where it
        // stands, so the government is known by the second.
        Q2: entity('Q2', 'A Quiet Party', {}),
        Q3: entity('Q3', 'A Party', {
          P1387: [{ property: 'P1387', value: 'Q4', rank: 'normal', start: null, end: null }],
        }),
        Q4: entity('Q4', 'right-wing', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q4', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    const result = await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const serbia = result.snapshots.find((s) => s.iso2 === 'RS')!;
    expect(serbia.party).toBe('A Party');
    expect(serbia.position).toBe('right');
    // Being listed in two parties is not being in a coalition with one of them.
    expect(serbia.coalition).toEqual([]);
  });

  it('lets the head of state govern only in a presidential system', async () => {
    const country = (form: string): WikidataEntity['claims'] => ({
      P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
      P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
      P122: [{ property: 'P122', value: form, rank: 'normal', start: null, end: null }],
      P35: [{ property: 'P35', value: 'Q1', rank: 'normal', start: '2017-05-31', end: null }],
      P6: [{ property: 'P6', value: 'Q2', rank: 'normal', start: '2024-05-01', end: null }],
    });
    const holders: Record<string, WikidataEntity['claims']> = {
      Q1: {
        P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
        P102: [{ property: 'P102', value: 'Q10', rank: 'normal', start: '2017-01-01', end: null }],
      },
      Q2: {
        P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
        P102: [{ property: 'P102', value: 'Q20', rank: 'normal', start: '2024-01-01', end: null }],
      },
    };
    const parties: Record<string, WikidataEntity['claims']> = {
      Q10: { P1387: [{ property: 'P1387', value: 'Q30', rank: 'normal', start: null, end: null }] },
      Q20: { P1387: [{ property: 'P1387', value: 'Q31', rank: 'normal', start: null, end: null }] },
    };
    const answers = [
      {
        match: /wdt:P297/,
        rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
      },
      {
        match: /wdt:P361\+ wd:Q2921172/,
        rows: [
          row({ align: 'http://www.wikidata.org/entity/Q30', ancestor: 'http://www.wikidata.org/entity/Q164597' }),
          row({ align: 'http://www.wikidata.org/entity/Q31', ancestor: 'http://www.wikidata.org/entity/Q76074' }),
        ],
      },
    ];

    const parliamentary = await new WorldFetcher({
      wikidata: new FakeWikidata(
        {
          Q403: entity('Q403', 'Serbia', country('Q100')),
          Q100: entity('Q100', 'parliamentary republic', {}),
          Q1: entity('Q1', 'A President', holders.Q1),
          Q2: entity('Q2', 'A Prime Minister', holders.Q2),
          Q10: entity('Q10', 'A Party', parties.Q10),
          Q20: entity('Q20', 'Another Party', parties.Q20),
          Q30: entity('Q30', 'left-wing', {}),
          Q31: entity('Q31', 'right-wing', {}),
        },
        answers,
      ),
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const row1 = parliamentary.snapshots.find((s) => s.iso2 === 'RS')!;
    // In a parliamentary system the head of state is a figurehead, so their party
    // is neither the government nor a coalition partner.
    expect(row1.party).toBe('Another Party');
    expect(row1.coalition).toEqual([]);
    expect(row1.position).toBe('right');

    const presidential = await new WorldFetcher({
      wikidata: new FakeWikidata(
        {
          Q403: entity('Q403', 'Serbia', country('Q101')),
          Q101: entity('Q101', 'presidential system', {}),
          Q1: entity('Q1', 'A President', holders.Q1),
          Q2: entity('Q2', 'A Prime Minister', holders.Q2),
          Q10: entity('Q10', 'A Party', parties.Q10),
          Q20: entity('Q20', 'Another Party', parties.Q20),
          Q30: entity('Q30', 'left-wing', {}),
          Q31: entity('Q31', 'right-wing', {}),
        },
        answers,
      ),
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    const row2 = presidential.snapshots.find((s) => s.iso2 === 'RS')!;
    // In a presidential system the head of state governs, and the prime
    // minister's party sits with them.
    expect(row2.party).toBe('A Party');
    expect(row2.coalition).toEqual(['Another Party']);
    expect(row2.position).toBe('left');
  });

  it('asks Wikidata questions it can answer in a moment', async () => {    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P6: [{ property: 'P6', value: 'Q1', rank: 'normal', start: '2024-05-01', end: null }],
        }),
        Q1: entity('Q1', 'A President', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [{ property: 'P102', value: 'Q2', rank: 'normal', start: '2019-01-01', end: null }],
        }),
        Q2: entity('Q2', 'A Party', {
          P1387: [{ property: 'P1387', value: 'Q3', rank: 'normal', start: null, end: null }],
        }),
        Q3: entity('Q3', 'right-wing', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q3', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    await new WorldFetcher({
      wikidata,
      countries: COUNTRIES,
      now: new Date('2026-11-01T00:00:00.000Z'),
    }).run();

    expect(wikidata.queries.length).toBeGreaterThan(0);
    for (const query of wikidata.queries) {
      // A property path that walks as far as it can reaches the whole of
      // Wikidata's hierarchy of concepts, and the query service gives up on it.
      expect(query).not.toMatch(/\)\*/);
    }
  });
});

describe('what kind of election it is', () => {
  it('reads the kind out of the name', () => {
    expect(electionKind('2026 Serbian parliamentary election')).toBe('parliamentary');
    expect(electionKind('2028 United States presidential election')).toBe('presidential');
    expect(electionKind('2026 snap election in Germany')).toBe('snap');
    expect(electionKind('2026 Greek local elections')).toBe('local');
    expect(electionKind('Serbian election')).toBe('other');
  });
});

describe('the world job', () => {
  let app: TestApp | null = null;
  afterEach(async () => {
    await app?.cleanup();
    app = null;
  });

  it('reads the world and writes it down when the job runs', async () => {
    const wikidata = new FakeWikidata(
      {
        Q403: entity('Q403', 'Serbia', {
          P297: [{ property: 'P297', value: 'RS', rank: 'normal', start: null, end: null }],
          P31: [{ property: 'P31', value: 'Q6256', rank: 'normal', start: null, end: null }],
          P35: [{ property: 'P35', value: 'Q1', rank: 'normal', start: '2017-05-31', end: null }],
        }),
        Q1: entity('Q1', 'Aleksandar Vučić', {
          P31: [{ property: 'P31', value: 'Q5', rank: 'normal', start: null, end: null }],
          P102: [{ property: 'P102', value: 'Q2', rank: 'normal', start: '2008-01-01', end: null }],
        }),
        Q2: entity('Q2', 'Serbian Progressive Party', {
          P1387: [{ property: 'P1387', value: 'Q3', rank: 'normal', start: null, end: null }],
        }),
        Q3: entity('Q3', 'right-wing populism', {}),
      },
      [
        {
          match: /wdt:P297/,
          rows: [row({ iso: 'RS', country: 'http://www.wikidata.org/entity/Q403', class: 'http://www.wikidata.org/entity/Q6256' })],
        },
        {
          match: /wdt:P361\+ wd:Q2921172/,
          rows: [row({ align: 'http://www.wikidata.org/entity/Q3', ancestor: 'http://www.wikidata.org/entity/Q76074' })],
        },
      ],
    );

    app = makeApp({ env: { WORLD_ENABLED: 'true' }, wikidata });
    app.app.worldPipeline.start();
    app.app.worldPipeline.enqueue({ manual: true });
    await waitFor(() => app!.app.world.list().length > 0);

    const serbia = app.app.world.get('RS')!;
    expect(serbia.headOfState).toBe('Aleksandar Vučić');
    expect(serbia.party).toBe('Serbian Progressive Party');
    expect(serbia.position).toBe('right');
    // The reading is written down, so the reader can see when it happened.
    expect(app.app.world.lastFetch()!.countries).toBe(1);
    // The job is done and not left hanging.
    const active = app.app.queue
      .counts()
      .filter((c) => c.kind === WORLD_FETCH && (c.status === 'pending' || c.status === 'running'))
      .reduce((n, c) => n + c.count, 0);
    expect(active).toBe(0);
  });
});
