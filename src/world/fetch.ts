import { POSITION_SCORE, type CountrySnapshot, type Position } from './schema.js';
import type { SparqlRow, WikidataClaim, WikidataEntity, WikidataReader } from './wikidata.js';

/** A country the map draws, and the code it carries. */
export interface WorldCountryRef {
  iso2: string;
  name: string;
}

/** What a fetch produced, and what it could not. */
export interface WorldFetchResult {
  snapshots: CountrySnapshot[];
  /** Countries the map draws that Wikidata does not know as sovereign states. */
  unmapped: string[];
}

export interface WorldFetchOptions {
  wikidata: WikidataReader;
  countries: WorldCountryRef[];
  now: Date;
  log?: { info: (msg: string, extra?: Record<string, unknown>) => void; warn: (msg: string, extra?: Record<string, unknown>) => void };
}

/**
 * The two classes Wikidata uses for a country. A map of the world is a map of
 * sovereign states, so a territory that is not one — Puerto Rico, French Southern
 * Territories, Antarctica — is left out rather than given a government it does
 * not have.
 */
const COUNTRY_CLASSES = new Set(['Q6256', 'Q3624078']);

/** The point of the spectrum, and where it puts a government. */
const AXIS_POINTS: Record<string, Position> = {
  Q1129409: 'left', // far-left politics
  Q164597: 'left', // left-wing
  Q737014: 'centre-left',
  Q6587194: 'centre', // centrism
  Q844072: 'centre-right',
  Q76074: 'right', // right-wing
  Q127869500: 'right', // far-right
  Q204481: 'right', // right-wing extremism
  Q23018230: 'right', // alt-right
  Q21848959: 'right', // radical right
  Q3347089: 'right', // neo-reactionary movement
  Q1324222: 'right', // Eurasianism
  Q127393: 'left', // autonomism
  Q96146266: 'left', // a child of autonomism
  Q21535389: 'left', // regressive left
  Q65045683: 'left', // zo gaau
  Q97177998: 'centre', // a child of centrism
};

/**
 * Which point of the axis wins when several sit above the same alignment.
 * Wikidata hangs the spectrum as a tree — "centre-left" is part of "left-wing",
 * "centre-right" of "right-wing" — so an alignment is described by several
 * points at once, and the narrowest one is the one that says the most. The
 * order below follows the depth of each point in that tree, deepest first.
 */
const AXIS_PRECISION = [
  // Two steps down from the spectrum.
  'Q21848959',
  'Q23018230',
  'Q3347089',
  'Q1324222',
  'Q96146266',
  'Q97177998',
  // One step down.
  'Q1129409',
  'Q127869500',
  'Q204481',
  'Q127393',
  'Q21535389',
  'Q737014',
  'Q844072',
  'Q65045683',
  // The spectrum itself.
  'Q164597',
  'Q76074',
  'Q6587194',
];

/**
 * Ideologies are not points of the axis in Wikidata's own graph: "social
 * democracy" sits nowhere near "centre-left" as far as the data is concerned. So a
 * party described by an ideology rather than by an alignment needs a translation,
 * and this table is that translation — the ideology, and the position it usually
 * means. It is a reading of the word, not a fact Wikidata states.
 */
const IDEOLOGY_POSITION: Record<string, Position> = {
  // Left.
  Q6186: 'left', // communism
  Q7272: 'left', // socialism
  Q7264: 'left', // Marxism
  Q211930: 'left', // Marxism–Leninism
  Q189280: 'left', // democratic socialism
  Q155059: 'left', // Leninism
  Q179121: 'left', // Stalinism
  Q188670: 'left', // anarcho-communism
  Q6199: 'left', // anarchism
  Q1066224: 'left', // left communism
  Q206743: 'left', // Eurocommunism
  Q571627: 'left', // National Bolshevism
  Q181800: 'left', // Juche
  Q11900614: 'left', // left-wing populism
  Q2981930: 'left', // agrarian socialism
  Q1813600: 'left', // Nasserism
  Q2582421: 'left', // Ba'athism
  Q1144178: 'left', // anti-imperialism
  Q1202972: 'left', // left-wing nationalism
  Q1852084: 'left', // libertarian socialism
  Q2385364: 'left', // alter-globalization
  Q3326688: 'left', // gremialismo
  Q389647: 'left', // anti-capitalism
  Q865354: 'left', // scientific socialism
  // Centre-left.
  Q121254: 'centre-left', // social democracy
  Q201712: 'centre-left', // social liberalism
  Q821102: 'centre-left', // progressivism
  Q1661415: 'centre-left', // green politics
  Q494792: 'centre-left', // Third Way
  Q1080800: 'centre-left', // Christian left
  Q613875: 'centre-left', // Third-Worldism
  Q1822939: 'centre-left', // liberal socialism
  Q2855609: 'centre-left', // environmentalism
  Q3778417: 'centre-left', // green party
  Q7252: 'centre-left', // feminism
  Q98113730: 'centre-left', // LGBT ideology
  Q913401: 'centre-left', // classical radicalism
  // Centre.
  Q6216: 'centre', // liberalism
  Q492050: 'centre', // agrarianism
  Q729119: 'centre', // economic liberalism
  Q877848: 'centre', // Republicanism
  Q333024: 'centre', // pluralism
  Q1229663: 'centre', // distributism
  Q16334344: 'centre', // Catholic social teaching
  Q16152203: 'centre', // progressive
  Q180490: 'centre', // populism
  Q1194747: 'centre', // constitutionalism
  Q126692: 'centre', // pragmatism
  Q188961: 'centre', // decentralization
  Q190044: 'centre', // technocracy
  Q192125: 'centre', // liberal democracy
  Q204886: 'centre', // federalism
  Q216920: 'centre', // secularism
  Q2641411: 'centre', // Islamic democracy
  Q265685: 'centre', // Poporanism
  Q2684060: 'centre', // regionalism
  Q324530: 'centre', // communitarianism
  Q3781399: 'centre', // pro-Europeanism
  Q4950170: 'centre', // Bourguibism
  Q602875: 'centre', // federalisation of the European Union
  Q60741353: 'centre', // anti-corruption
  Q660018: 'centre', // national liberalism
  Q7174: 'centre', // democracy
  Q728697: 'centre', // laicism
  Q794394: 'centre', // classical liberalism
  Q59599: 'centre', // civic nationalism
  Q15986535: 'centre', // national democracy
  // Centre-right.
  Q7169: 'centre-right', // conservatism
  Q209158: 'centre-right', // Christian democracy
  Q1043096: 'centre-right', // liberal conservatism
  Q617609: 'centre-right', // conservative liberalism
  Q852739: 'centre-right', // national conservatism
  Q1062758: 'centre-right', // green conservatism
  Q269443: 'centre-right', // Kemalism
  Q162719: 'centre-right', // neoliberalism
  Q192886: 'centre-right', // corporatism
  Q1414298: 'centre-right', // social conservatism
  Q1377153: 'centre-right', // European values
  Q2698984: 'centre-right', // fiscal conservatism
  Q388698: 'centre-right', // Atlanticism
  Q65352237: 'centre-right', // religious conservatism
  Q969021: 'centre-right', // post-communism
  Q700386: 'centre-right', // Russophilia
  // Right.
  Q6235: 'right', // nationalism
  Q436860: 'right', // right-wing populism
  Q178598: 'right', // libertarianism
  Q696116: 'right', // neo-fascism
  Q6223: 'right', // fascism
  Q281347: 'right', // Hindutva
  Q1322213: 'right', // Christian right
  Q1140370: 'right', // Islamic fundamentalism
  Q189746: 'right', // Islamism
  Q30970737: 'right', // political Islam
  Q112114970: 'right', // revolutionary nationalism
  Q695868: 'right', // Third Position
  Q1207817: 'right', // Putinism
  Q2354258: 'right', // Russian nationalism
  Q1123231: 'right', // clerical fascism
  Q114213: 'right', // Arab nationalism
  Q132304396: 'right', // Arab-Islamic nationalism
  Q17025987: 'right', // Romanian nationalism
  Q182121: 'right', // anti-communism
  Q193476: 'right', // Pan-Arabism
  Q223200: 'right', // euroscepticism
  Q22649: 'right', // antisemitism
  Q2275310: 'right', // anti-Masonry
  Q268455: 'right', // crypto-fascism
  Q282739: 'right', // Pan-Africanism
  Q38352698: 'right', // ultranationalism
  Q3874021: 'right', // African nationalism
  Q5333440: 'right', // economic antisemitism
  Q555887: 'right', // economic nationalism
  Q700594: 'right', // national syndicalism
  Q7247692: 'right', // Producerism
  Q7310: 'right', // Nazism
  Q7333466: 'right', // paternalistic conservatism
  Q7853208: 'right', // Tunisian nationalism
  Q85743247: 'right', // Aryanism
  Q912036: 'right', // sovereigntism
};

/**
 * Forms of government that have no place on the axis. A one-party state and an
 * absolute monarchy are not "right" or "left": the axis describes how a
 * government stands against another, and there is nothing to stand against.
 */
const OFF_AXIS_FORMS = new Set([
  'one-party state',
  'communist state',
  'communist dictatorship',
  'absolute monarchy',
  'theocracy',
  'islamic theocracy',
  'military junta',
  'military government',
  'military rule',
  'provisional government',
  'juche',
  'family dictatorship',
  'emirate',
  'islamic republic',
  'islamic state',
  'absolute theocracy',
]);

/**
 * Ideologies that put a government off the axis as well. A party that describes
 * itself as authoritarian, monarchist or statist is not standing to the left or
 * the right of anyone: there is nothing to stand against. This is only read
 * when the party's own alignment says nothing, because an alignment is a plain
 * statement about the axis and an ideology is only a description — a
 * constitutional monarchist party with a centre-right alignment is on the axis.
 */
const OFF_AXIS_IDEOLOGIES = new Set([
  'Q6229', // authoritarianism
  'Q216669', // monarchism
  'Q322294', // statism
]);

/** The head of state, and the head of government. */
const HEAD_OF_STATE = 'P35';
const HEAD_OF_GOVERNMENT = 'P6';
/** The party a person belongs to, and the ideology a party or a person stands for. */
const MEMBER_OF_PARTY = 'P102';
const POLITICAL_IDEOLOGY = 'P1142';
/** Where a party stands on the axis. */
const POLITICAL_ALIGNMENT = 'P1387';
/** The form of government of a country. */
const FORM_OF_GOVERNMENT = 'P122';
/** The class of a country — a one-party state is a class as well as a form. */
const INSTANCE_OF = 'P31';
/** The offices the head of state and the head of government hold. */
const OFFICE_OF_HEAD_OF_STATE = 'P1906';
const OFFICE_OF_HEAD_OF_GOVERNMENT = 'P1313';
/** The office a person holds. */
const POSITION_HELD = 'P39';
/** The date an election happens. */
const POINT_IN_TIME = 'P585';

const HUMAN = 'Q5';
/** The party of a person who belongs to none. */
const INDEPENDENT = 'Q327591';

const RANK_ORDER: Record<string, number> = { preferred: 0, normal: 1, deprecated: 2 };

/** How many countries one query asks about at a time. The query service is faster on small questions. */
const ELECTION_CHUNK = 24;
/** How many offices one query asks about at a time. */
const OFFICE_CHUNK = 60;
/** How many alignments one query asks about at a time. */
const AXIS_CHUNK = 100;
/** An election further ahead than this is a placeholder, not a plan. */
const MAX_ELECTION_YEARS = 25;
/** A party someone left more than this long ago is not the party they lead. */
const RECENT_PARTY_YEARS = 5;

interface CountryPlan {
  iso2: string;
  fallbackName: string;
  qid: string;
  entity: WikidataEntity | undefined;
  stateClaim: WikidataClaim | null;
  governmentClaim: WikidataClaim | null;
  stateOffice: string | null;
  governmentOffice: string | null;
  /** The parties the people in office belong to. */
  parties: string[];
  /** The form of government the country says it has. */
  forms: string[];
  /** The classes the country is an instance of. */
  classes: string[];
}

interface Election {
  date: string;
  kind: string;
  label: string;
}

interface Reading {
  people: Map<string, WikidataEntity>;
  parties: Map<string, WikidataEntity>;
  /** The labels of the things a country is described as: its forms, its ideologies. */
  words: Map<string, string>;
  /** The points of the axis each alignment reaches. */
  axisPoints: Map<string, Set<string>>;
  elections: Map<string, Election>;
  /** What another item with the same name says about a party that says nothing. */
  borrowed: Map<string, Borrowed>;
}

/** What a party that says nothing about itself is described as by its namesake. */
interface Borrowed {
  aligns: string[];
  ideos: string[];
}

/**
 * Reads the world's governments out of Wikidata and writes them down as snapshots.
 *
 * Wikidata keeps a country as a list of everyone who has ever been its head of
 * state or head of government, each with the dates they held the office. The
 * current holder is the one whose term has no end. Their party comes next, and
 * the party knows where it stands on the left–right axis.
 */
export class WorldFetcher {
  constructor(private readonly opts: WorldFetchOptions) {}

  async run(): Promise<WorldFetchResult> {
    const index = await this.countryIndex();
    const refs = new Map(this.opts.countries.map((c) => [c.iso2, c]));
    const unmapped = this.opts.countries.map((c) => c.iso2).filter((iso2) => !index.has(iso2));

    const plans: CountryPlan[] = [];
    for (const [iso2, qid] of index) {
      plans.push({
        iso2,
        fallbackName: refs.get(iso2)?.name ?? iso2,
        qid,
        entity: undefined,
        stateClaim: null,
        governmentClaim: null,
        stateOffice: null,
        governmentOffice: null,
        parties: [],
        forms: [],
        classes: [],
      });
    }

    const countryEntities = await this.opts.wikidata.entities(plans.map((p) => p.qid));
    for (const plan of plans) {
      plan.entity = countryEntities.get(plan.qid);
      plan.stateClaim = currentHolder(plan.entity?.claims[HEAD_OF_STATE], this.opts.now);
      plan.governmentClaim = currentHolder(plan.entity?.claims[HEAD_OF_GOVERNMENT], this.opts.now);
      plan.stateOffice = firstValue(plan.entity?.claims[OFFICE_OF_HEAD_OF_STATE]);
      plan.governmentOffice = firstValue(plan.entity?.claims[OFFICE_OF_HEAD_OF_GOVERNMENT]);
      plan.forms = currentValues(plan.entity?.claims[FORM_OF_GOVERNMENT], this.opts.now);
      plan.classes = currentValues(plan.entity?.claims[INSTANCE_OF], this.opts.now);
    }

    // The holders, and whether they are people or the offices themselves.
    const holderIds = new Set<string>();
    for (const plan of plans) {
      for (const claim of [plan.stateClaim, plan.governmentClaim]) if (claim?.value) holderIds.add(claim.value);
    }
    const holderEntities = await this.opts.wikidata.entities([...holderIds]);
    const offices = new Set<string>();
    for (const id of holderIds) if (!isHuman(holderEntities.get(id))) offices.add(id);
    for (const plan of plans) {
      if (plan.stateOffice) offices.add(plan.stateOffice);
      if (plan.governmentOffice) offices.add(plan.governmentOffice);
    }
    const incumbents = await this.incumbentsOf([...offices]);

    // Where a country does not say who is in office, the office it names says so.
    for (const plan of plans) {
      for (const [claimKey, officeKey] of [
        ['stateClaim', 'stateOffice'],
        ['governmentClaim', 'governmentOffice'],
      ] as const) {
        const claim = plan[claimKey];
        if (claim?.value) {
          const person = incumbents.get(claim.value);
          if (person) claim.value = person;
          continue;
        }
        const office = plan[officeKey];
        const person = office ? incumbents.get(office) : undefined;
        if (person) plan[claimKey] = { property: claimKey, value: person, rank: 'normal', start: null, end: null };
      }
    }

    const people = await this.opts.wikidata.entities(
      [...new Set(plans.flatMap((p) => [p.stateClaim?.value, p.governmentClaim?.value]).filter(Boolean) as string[])],
    );

    // The parties, and the words the countries and the parties are described in.
    const partyIds = new Set<string>();
    const wordIds = new Set<string>();
    const alignments = new Set<string>();
    for (const plan of plans) {
      for (const claim of [plan.stateClaim, plan.governmentClaim]) {
        const person = claim?.value ? people.get(claim.value) : undefined;
        for (const party of partiesOf(person, this.opts.now)) {
          partyIds.add(party);
          if (!plan.parties.includes(party)) plan.parties.push(party);
        }
        for (const ideology of ideologiesOf(person)) wordIds.add(ideology);
        for (const align of alignmentsOf(person)) alignments.add(align);
      }
      for (const form of [...plan.forms, ...plan.classes]) wordIds.add(form);
    }
    const partyEntities = await this.opts.wikidata.entities([...partyIds]);
    for (const party of partyEntities.values()) {
      for (const align of alignmentsOf(party)) alignments.add(align);
      // An ideology is a name for where a party stands, and Wikidata often knows
      // where the ideology itself sits on the axis.
      for (const ideology of ideologiesOf(party)) {
        wordIds.add(ideology);
        alignments.add(ideology);
      }
    }

    // Some parties are described in one item and left bare in another. When a
    // party says nothing about itself, another item with the same name in the same
    // country may say it for it.
    const borrowed = await this.borrowedParties(plans, partyEntities);
    for (const entry of borrowed.values()) {
      for (const align of entry.aligns) alignments.add(align);
      for (const ideology of entry.ideos) {
        wordIds.add(ideology);
        alignments.add(ideology);
      }
    }

    const wordEntities = await this.opts.wikidata.entities([...wordIds, ...alignments]);
    const words = new Map<string, string>();
    for (const [id, entity] of wordEntities) if (entity.label) words.set(id, entity.label);

    // Where each party stands.
    const axisPoints = await this.axisPoints([...alignments]);

    // The elections.
    const elections = await this.elections(plans.map((p) => p.qid));

    const reading: Reading = { people, parties: partyEntities, words, axisPoints, elections, borrowed };
    const snapshots = plans.map((plan) => this.snapshot(plan, reading));
    this.opts.log?.info('read the world snapshot', { countries: snapshots.length, unmapped: unmapped.length });
    return { snapshots, unmapped };
  }

  /**
   * Match each code the map knows with the item Wikidata uses for that country.
   * An item is a country when it is a country or a sovereign state; that also
   * settles the codes two items could answer to.
   */
  private async countryIndex(): Promise<Map<string, string>> {
    const codes = this.opts.countries.map((c) => c.iso2);
    if (!codes.length) return new Map();
    const rows = await this.opts.wikidata.sparql(`SELECT ?iso ?country ?class WHERE {
      VALUES ?iso { ${codes.map((c) => `"${c}"`).join(' ')} }
      ?country wdt:P297 ?iso ; wdt:P31 ?class .
    }`);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const cls = row.class?.value.split('/').pop();
      if (!cls || !COUNTRY_CLASSES.has(cls)) continue;
      const iso = row.iso?.value;
      const qid = row.country?.value.split('/').pop();
      if (!iso || !qid) continue;
      const key = `${iso}|${qid}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const best = new Map<string, { qid: string; score: number }>();
    for (const [key, score] of counts) {
      const [iso, qid] = key.split('|');
      if (!iso || !qid) continue;
      const current = best.get(iso);
      if (!current || score > current.score) best.set(iso, { qid, score });
    }
    return new Map([...best].map(([iso, v]) => [iso, v.qid]));
  }

  /**
   * Find the person who holds an office now. Wikidata records an office holder as
   * a statement with a start and, usually, an end; the one still open is the
   * current holder.
   */
  private async incumbentsOf(offices: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(offices)];
    const now = this.opts.now.toISOString();
    for (let i = 0; i < unique.length; i += OFFICE_CHUNK) {
      const chunk = unique.slice(i, i + OFFICE_CHUNK);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rows = await this.opts.wikidata.sparql(`SELECT ?office ?person ?start WHERE {
            VALUES ?office { ${chunk.map((o) => `wd:${o}`).join(' ')} }
            ?person p:${POSITION_HELD} ?statement .
            ?statement ps:${POSITION_HELD} ?office .
            OPTIONAL { ?statement pq:P580 ?start }
            FILTER NOT EXISTS { ?statement pq:P582 ?end . FILTER(?end <= "${now}"^^xsd:dateTime) }
          }`);
          const starts = new Map<string, string>();
          for (const row of rows) {
            const office = row.office?.value.split('/').pop();
            const person = row.person?.value.split('/').pop();
            if (!office || !person) continue;
            const start = row.start?.value ?? '';
            const best = starts.get(office);
            if (best === undefined || start > best) {
              starts.set(office, start);
              out.set(office, person);
            }
          }
          break;
        } catch (err) {
          if (attempt === 2) {
            this.opts.log?.warn('could not read the holders of a group of offices', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * The points of the axis each alignment reaches. Wikidata models the spectrum
   * as a tree, so an alignment is on the axis when it is, or is part of, one of
   * the named points — "right-wing extremism" reaches "right-wing" that way. An
   * alignment that names another alignment is on the axis where that one is:
   * "right-wing populism" says of itself that it is right-wing.
   *
   * The tree is walked one step at a time on purpose. Walking it as far as it
   * goes reaches the whole of Wikidata's hierarchy of concepts, which the query
   * service answers in a minute or gives up on, and every point of the spectrum
   * is already one step from the alignment that names it.
   */
  private async axisPoints(alignments: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    const unique = [...new Set(alignments)];
    for (let i = 0; i < unique.length; i += AXIS_CHUNK) {
      const chunk = unique.slice(i, i + AXIS_CHUNK);
      let rows: SparqlRow[] = [];
      try {
        rows = await this.opts.wikidata.sparql(`SELECT ?align ?ancestor WHERE {
          VALUES ?align { ${chunk.map((a) => `wd:${a}`).join(' ')} }
          ?align (wdt:P361|wdt:P279|wdt:P1387)? ?ancestor .
          ?ancestor wdt:P361+ wd:Q2921172 .
        }`);
      } catch (err) {
        this.opts.log?.warn('could not read a group of alignments', {
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      for (const row of rows) {
        const align = row.align?.value.split('/').pop();
        const ancestor = row.ancestor?.value.split('/').pop();
        if (!align || !ancestor) continue;
        if (!out.has(align)) out.set(align, new Set());
        out.get(align)!.add(ancestor);
      }
    }
    return out;
  }

  /**
   * The next election in each country. Wikidata links an election to the country
   * it happens in; the date is the point in time it happens.
   */
  private async elections(countryIds: string[]): Promise<Map<string, Election>> {
    const candidates = new Map<string, Map<string, Set<string>>>();
    const unique = [...new Set(countryIds)];
    const now = this.opts.now.toISOString();
    const limit = this.opts.now.getFullYear() + MAX_ELECTION_YEARS;
    for (let i = 0; i < unique.length; i += ELECTION_CHUNK) {
      const chunk = unique.slice(i, i + ELECTION_CHUNK);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rows = await this.opts.wikidata.sparql(`SELECT ?country ?election ?date WHERE {
            VALUES ?country { ${chunk.map((c) => `wd:${c}`).join(' ')} }
            ?election wdt:P1001 ?country ; wdt:${POINT_IN_TIME} ?date .
            FILTER(?date > "${now}"^^xsd:dateTime)
          }`);
          for (const row of rows) {
            const country = row.country?.value.split('/').pop();
            const election = row.election?.value.split('/').pop();
            const date = row.date?.value.slice(0, 10);
            if (!country || !election || !date) continue;
            // A date far in the future is a placeholder for "someday", not a plan.
            if (Number(date.slice(0, 4)) > limit) continue;
            if (!candidates.has(country)) candidates.set(country, new Map());
            const dates = candidates.get(country)!;
            if (!dates.has(date)) dates.set(date, new Set());
            dates.get(date)!.add(election);
          }
          break;
        } catch (err) {
          if (attempt === 2) {
            this.opts.log?.warn('could not read the elections of a group of countries', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // The names of the elections, and what kind of election each one is.
    const ids = new Set<string>();
    for (const dates of candidates.values()) for (const qids of dates.values()) for (const id of qids) ids.add(id);
    const entities = await this.opts.wikidata.entities([...ids]);

    const found = new Map<string, Election>();
    for (const [country, dates] of candidates) {
      const datesSorted = [...dates.keys()].sort();
      let best: Election | null = null;
      for (const date of datesSorted) {
        for (const id of dates.get(date)!) {
          const label = entities.get(id)?.label ?? id;
          const kind = electionKind(label);
          // The same day can hold several elections — a parliament and its
          // chambers. The one that says what the country is voting for comes
          // first; the date settles the rest.
          if (best && best.date < date) continue;
          if (best && best.date === date && (KIND_RANK[best.kind] ?? 9) <= (KIND_RANK[kind] ?? 9)) continue;
          best = { date, kind, label };
        }
        if (best) break;
      }
      if (best) found.set(country, best);
    }
    return found;
  }

  /**
   * Some parties are described in one item and left bare in another. When a
   * party says nothing about itself, another item with the same name in the same
   * country may say it for it. The country matters: "National People's Party" is
   * a different party in a different country.
   */
  private async borrowedParties(
    plans: CountryPlan[],
    partyEntities: Map<string, WikidataEntity>,
  ): Promise<Map<string, Borrowed>> {
    const wanted = new Map<string, { label: string; country: string }>();
    for (const plan of plans) {
      for (const id of plan.parties) {
        const party = partyEntities.get(id);
        if (!party?.label) continue;
        if ((party.claims[POLITICAL_ALIGNMENT] ?? []).length) continue;
        if (ideologiesOf(party).length) continue;
        wanted.set(`${party.label}|${plan.qid}`, { label: party.label, country: plan.qid });
      }
    }
    const out = new Map<string, Borrowed>();
    if (!wanted.size) return out;
    const entries = [...wanted.values()];
    for (let i = 0; i < entries.length; i += ELECTION_CHUNK) {
      const chunk = entries.slice(i, i + ELECTION_CHUNK);
      try {
        const rows = await this.opts.wikidata.sparql(`SELECT ?party ?country ?align ?ideo WHERE {
          VALUES (?label ?country) { ${chunk.map((e) => `("${e.label}"@en wd:${e.country})`).join(' ')} }
          ?party rdfs:label ?label ; wdt:P17 ?country .
          OPTIONAL { ?party wdt:P1387 ?align }
          OPTIONAL { ?party wdt:P1142 ?ideo }
        }`);
        for (const row of rows) {
          const align = row.align?.value.split('/').pop();
          const ideo = row.ideo?.value.split('/').pop();
          const country = row.country?.value.split('/').pop();
          if (!country) continue;
          const label = chunk.find((e) => e.country === country)?.label;
          if (!label) continue;
          const mapKey = `${label}|${country}`;
          const entry = out.get(mapKey) ?? { aligns: [], ideos: [] };
          if (align && !entry.aligns.includes(align)) entry.aligns.push(align);
          if (ideo && !entry.ideos.includes(ideo)) entry.ideos.push(ideo);
          out.set(mapKey, entry);
        }
      } catch (err) {
        this.opts.log?.warn('could not read the other descriptions of a party', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /** Put one country together. */
  private snapshot(plan: CountryPlan, ctx: Reading): CountrySnapshot {
    const now = this.opts.now.toISOString();
    const name = plan.entity?.label ?? plan.fallbackName;
    const statePerson = plan.stateClaim?.value ? ctx.people.get(plan.stateClaim.value) : undefined;
    const governmentPerson = plan.governmentClaim?.value ? ctx.people.get(plan.governmentClaim.value) : undefined;

    const forms = plan.forms.map((id) => ctx.words.get(id) ?? id);
    const classes = plan.classes.map((id) => ctx.words.get(id) ?? id);
    const election = ctx.elections.get(plan.qid) ?? null;

    // In a presidential system the government is the head of state: their party
    // governs. In a parliamentary one the head of state is a figurehead, and
    // their party is not part of the government at all. A country that calls
    // itself both is treated as parliamentary, which is the safer of the two:
    // a party that is only the president's is not a government.
    const parliamentary = forms.some((f) => /parliamentary/i.test(f));
    const presidential = !parliamentary && forms.some((f) => /presidential/i.test(f));

    const stateParties = partiesOf(statePerson, this.opts.now);
    const governmentParties = partiesOf(governmentPerson, this.opts.now);
    // The government is the head of government's party, unless the country is a
    // presidential one and the head of state holds it. A head of state who rules
    // as well — a president — is the same person, so their party counts twice
    // over and there is nothing to add.
    const governing = presidential && statePerson
      ? [...stateParties, ...governmentParties.filter((p) => !stateParties.includes(p))]
      : [...governmentParties, ...stateParties.filter((p) => !governmentParties.includes(p))];
    // What each of those parties says about where it stands. A leader can be
    // listed in several parties, and the first one may say nothing at all.
    const stances = governing.map((id) => {
      const candidate = ctx.parties.get(id);
      // A party that says nothing about itself may have a namesake that does.
      const borrowed = candidate?.label ? ctx.borrowed.get(`${candidate.label}|${plan.qid}`) : undefined;
      return { id, label: candidate?.label ?? null, stance: stanceOf(candidate, ctx, borrowed) };
    });
    // A party that spans a continent says where the government stands less well
    // than the national party it sits in, so the national one comes first. The
    // party named on the row is that one: it is the party the government is made
    // of, and the most recent one the leader belongs to.
    const national = stances.filter((s) => s.id !== INDEPENDENT && !isContinental(s.label));
    const main = national[0] ?? stances.find((s) => s.id !== INDEPENDENT) ?? null;
    const mainPartyId = main?.id ?? null;
    const party = main?.label ?? null;

    // A coalition is the other party in office. Wikidata does not record
    // coalitions as such, so the parties of both offices are what there is — but
    // only when the head of state governs too, and only when the two offices are
    // held by different people. A leader listed in several parties is in one of
    // them, not in a coalition with the other.
    const sameHolder = !!statePerson && !!governmentPerson && statePerson.id === governmentPerson.id;
    const otherParties = sameHolder || !presidential ? [] : governmentParties;
    const coalition: string[] = [];
    for (const id of otherParties) {
      if (id === mainPartyId || id === INDEPENDENT) continue;
      const label = ctx.parties.get(id)?.label;
      if (!label || isContinental(label)) continue;
      if (!coalition.includes(label)) coalition.push(label);
    }

    const offAxis = isOffAxis(forms, classes, election, party !== null);

    let position: Position = 'unknown';
    let ideology: string | null = null;
    if (offAxis) {
      position = 'not-on-axis';
    } else {
      // A person in office can belong to more than one party, and the first one
      // may say nothing about where it stands while the second says everything.
      // A European party is read last: it says where its members stand, which is
      // near enough, and better than nothing at all.
      for (const candidate of [...national, ...stances.filter((s) => !national.includes(s))]) {
        if (candidate.id === INDEPENDENT) continue;
        if (candidate.stance.position) {
          position = candidate.stance.position;
          ideology = candidate.stance.ideology;
          break;
        }
        if (!ideology && candidate.stance.ideology) ideology = candidate.stance.ideology;
      }
      if (position === 'unknown') {
        for (const person of [governmentPerson, statePerson]) {
          const stance = stanceOf(person, ctx);
          if (stance.position) {
            position = stance.position;
            ideology = stance.ideology;
            break;
          }
          if (!ideology && stance.ideology) ideology = stance.ideology;
        }
      }
    }

    const notes: string[] = [];
    if (offAxis) notes.push([...forms, ...classes].find((f) => OFF_AXIS_FORMS.has(f)) ?? 'not a party government');
    else if (position === 'not-on-axis') {
      notes.push(`${party ? 'the party' : 'the government'} says it stands for ${ideology ?? 'no side'}`);
    }
    if (!party && !offAxis) notes.push('Wikidata records no party for the government');
    if (position === 'unknown' && !offAxis) notes.push('no position on the axis could be established');
    if (!election) notes.push('Wikidata has no dated election for this country');

    return {
      iso2: plan.iso2,
      name,
      headOfState: statePerson?.label ?? null,
      headOfGovernment: governmentPerson?.label ?? null,
      party,
      coalition,
      ideology,
      position,
      score: POSITION_SCORE[position] ?? null,
      ideologySource: 'Wikidata',
      sourceUrl: `https://www.wikidata.org/wiki/${plan.qid}`,
      nextElectionDate: election?.date ?? null,
      nextElectionKind: election?.kind ?? null,
      electionSource: election ? 'Wikidata' : null,
      state: position === 'unknown' ? 'unknown' : 'fresh',
      note: notes.length ? notes.join('; ') : null,
      fetchedAt: now,
      updatedAt: now,
    };
  }
}

/**
 * The party a person belongs to. A person can belong to several: the national
 * party they stand for, and a European one on top of it. The national party is
 * the one that says where the government stands, so it comes first.
 */
function partiesOf(person: WikidataEntity | undefined, now: Date): string[] {
  if (!person) return [];
  const today = now.toISOString().slice(0, 10);
  const claims = (person.claims[MEMBER_OF_PARTY] ?? []).filter((c) => c.value);
  const current = claims.filter((c) => c.end === null || c.end > today);
  // A person who is listed as an independent says they belong to nobody, and
  // that says nothing about where they stand. A person who is in a party is
  // known by it, even when another statement calls them independent.
  const inParty = current.filter((c) => c.value !== INDEPENDENT);
  if (inParty.length) return order(inParty);
  // Nobody is in a party any more. The last one they were in is the one they are
  // known by — unless they left it long ago, which means the party is gone and
  // says nothing about who they are now.
  const recent = claims.filter(
    (c) => c.value !== INDEPENDENT && c.end !== null && yearsSince(c.end, now) < RECENT_PARTY_YEARS,
  );
  if (recent.length) return order(recent);
  return order(current);
}

/** The parties of a person, the one they are most likely to be known by first. */
function order(claims: WikidataClaim[]): string[] {
  return claims
    .slice()
    .sort((a, b) => {
      const rank = (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1);
      if (rank !== 0) return rank;
      return (b.start ?? '').localeCompare(a.start ?? '');
    })
    .map((c) => c.value!)
    .filter((v, i, all) => all.indexOf(v) === i);
}

/** How long ago a date was, in years. */
function yearsSince(date: string, now: Date): number {
  return (now.getTime() - Date.parse(date)) / (365.25 * 24 * 3600 * 1000);
}

/** The ideologies a party or a person is described by. */
function ideologiesOf(entity: WikidataEntity | undefined): string[] {
  if (!entity) return [];
  return (entity.claims[POLITICAL_IDEOLOGY] ?? []).map((c) => c.value).filter((v): v is string => !!v);
}

/** The alignments a party or a person is given. */
function alignmentsOf(entity: WikidataEntity | undefined): string[] {
  if (!entity) return [];
  return (entity.claims[POLITICAL_ALIGNMENT] ?? []).map((c) => c.value).filter((v): v is string => !!v);
}

/**
 * Where a party or a person stands on the axis, and the ideology that says so.
 *
 * Three things say where someone stands: the alignment they are given, which
 * Wikidata hangs on the axis itself; the ideology they stand for, which Wikidata
 * often hangs on the axis as well; and, when neither says anything, a reading of
 * the word.
 */
function stanceOf(
  entity: WikidataEntity | undefined,
  ctx: Reading,
  borrowed?: Borrowed,
): { position: Position | null; ideology: string | null } {
  const aligns = [...alignmentsOf(entity), ...(borrowed?.aligns ?? [])];
  const ideos = [...ideologiesOf(entity), ...(borrowed?.ideos ?? [])];

  // The alignment is the plainest statement of where someone stands.
  const byAlignment = narrowest(aligns.flatMap((a) => [...(ctx.axisPoints.get(a) ?? [])]));
  if (byAlignment) {
    // A party can be described by several ideologies. The one that agrees with
    // the position is the one worth naming, when there is one.
    const agreeing = agreeingIdeology(ideos, ctx, byAlignment);
    const first = ideos.length ? ctx.words.get(ideos[0]!) ?? null : null;
    return { position: byAlignment, ideology: agreeing ?? first };
  }

  // The ideology may say where it sits on the axis itself.
  for (const ideo of ideos) {
    const byIdeology = narrowest([...(ctx.axisPoints.get(ideo) ?? [])]);
    if (byIdeology) return { position: byIdeology, ideology: ctx.words.get(ideo) ?? null };
  }

  // An ideology that puts a government off the axis altogether.
  for (const ideo of ideos) {
    if (OFF_AXIS_IDEOLOGIES.has(ideo)) {
      return { position: 'not-on-axis', ideology: ctx.words.get(ideo) ?? null };
    }
  }

  // Otherwise the word itself has to be read.
  let position: Position | null = null;
  let ideology: string | null = null;
  for (const qid of ideos) {
    const label = ctx.words.get(qid) ?? null;
    const known = IDEOLOGY_POSITION[qid] ?? null;
    if (known && !position) {
      position = known;
      ideology = label;
    } else if (!ideology) {
      ideology = label;
    }
  }
  return { position, ideology };
}

/**
 * The narrowest of the points of the axis that were reached, which is the one
 * that says the most: "centre-left" says more than "left-wing".
 */
function narrowest(points: string[]): Position | null {
  const set = new Set(points);
  for (const point of AXIS_PRECISION) if (set.has(point)) return AXIS_POINTS[point] ?? null;
  return null;
}

/**
 * The ideology that agrees with a position. An ideology is on the axis when
 * Wikidata says where it sits, and otherwise it means what it usually means.
 */
function ideologyPosition(ideo: string, ctx: Reading): Position | null {
  return narrowest([...(ctx.axisPoints.get(ideo) ?? [])]) ?? IDEOLOGY_POSITION[ideo] ?? null;
}

/** The ideology that agrees with a position, when one of them does. */
function agreeingIdeology(ideos: string[], ctx: Reading, position: Position): string | null {
  for (const ideo of ideos) {
    if (ideologyPosition(ideo, ctx) === position) return ctx.words.get(ideo) ?? null;
  }
  return null;
}

/**
 * The values of a property that still hold. A country lists the forms of
 * government it has had; the ones with an end date are history.
 */
function currentValues(claims: WikidataClaim[] | undefined, now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  return (claims ?? [])
    .filter((c) => c.value && (c.end === null || c.end > today))
    .map((c) => c.value!)
    .filter((v, i, all) => all.indexOf(v) === i);
}

/** The first value of a property, when it has one. */
function firstValue(claims: WikidataClaim[] | undefined): string | null {
  for (const claim of claims ?? []) if (claim.value) return claim.value;
  return null;
}

/** Whether an item is a person rather than an office or a party. */
function isHuman(entity: WikidataEntity | undefined): boolean {
  if (!entity) return true;
  const classes = entity.claims[INSTANCE_OF] ?? [];
  if (classes.some((c) => c.value === HUMAN)) return true;
  if (classes.some((c) => c.value && c.value !== HUMAN)) return false;
  return true;
}

/**
 * The holder of an office now: the statement whose term has not ended. A term that
 * ends next year is still the current one. When every term has ended, the latest
 * one is used — it is the closest to the present.
 */
function currentHolder(claims: WikidataClaim[] | undefined, now: Date): WikidataClaim | null {
  if (!claims?.length) return null;
  const withValue = claims.filter((c) => c.value);
  if (!withValue.length) return null;
  const today = now.toISOString().slice(0, 10);
  const open = withValue.filter((c) => c.end === null || c.end > today);
  const pool = open.length ? open : withValue;
  return (
    pool
      .slice()
      .sort((a, b) => {
        const rank = (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1);
        if (rank !== 0) return rank;
        return (b.start ?? '').localeCompare(a.start ?? '');
      })[0] ?? null
  );
}

/**
 * A government with no place on the axis: a one-party state, an absolute
 * monarchy, a military government. A "people's republic" counts too, but only
 * when the country holds no election — with elections it is a party government
 * that happens to be called a republic. So does a monarchy with no party in it
 * and no election to bring one in.
 */
function isOffAxis(forms: string[], classes: string[], election: Election | null, hasParty: boolean): boolean {
  for (const form of [...forms, ...classes]) if (OFF_AXIS_FORMS.has(form)) return true;
  // A state calls itself a people's republic whether or not it has more than one
  // party; only the absence of an election says it is a one-party state.
  if (forms.some((f) => f.toLowerCase().includes("people's republic")) && !election) return true;
  if (!hasParty && !election && [...forms, ...classes].some((f) => /monarchy|kingdom|sultanate|emirate/i.test(f))) {
    return true;
  }
  return false;
}

/**
 * A party that spans more than one country — a European party — says where the
 * government stands less well than the national party it sits in.
 */
function isContinental(label: string | null | undefined): boolean {
  return !!label && /^european\b/i.test(label);
}

/** What kind of election a name says it is. */
export function electionKind(label: string): string {
  const text = label.toLowerCase();
  if (/presidential/.test(text)) return 'presidential';
  if (/by-election|snap|partial/.test(text)) return 'snap';
  if (/municipal|regional|local|gubernatorial|state legislative|provincial/.test(text)) return 'local';
  if (/parliamentary|legislative|general election|assembly|congress|federal election|elections$|parliament|senate|chamber of deputies|national assembly|landtags|folketing|reichstag|duma/.test(text)) {
    return 'parliamentary';
  }
  return 'other';
}

/**
 * Which election to show when several happen on the same day. The election that
 * says what the whole country votes for comes first.
 */
const KIND_RANK: Record<string, number> = {
  parliamentary: 0,
  presidential: 1,
  snap: 2,
  local: 3,
  other: 4,
};
