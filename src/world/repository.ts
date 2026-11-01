import type { DB } from '../db/database.js';
import type { Clock } from '../util/time.js';
import { iso } from '../util/time.js';
import { PLACEHOLDERS, PLACEHOLDER_SOURCE } from './placeholders.js';
import {
  POSITION_SCORE,
  daysUntil,
  electionStanding,
  type CountrySnapshot,
  type ElectionStanding,
  type Position,
  type SnapshotState,
} from './schema.js';

export interface CountryActivity {
  /** How many stories name a place in this country. */
  stories: number;
  /** How many developments those stories have seen. */
  developments: number;
  /** When the newest of them was published. */
  latestAt: string | null;
}

export interface CountryStory {
  id: number;
  headline: string;
  publisherCount: number;
  articleCount: number;
  latestAt: string | null;
  relevance: number | null;
}

/** Why a country is worth a look. The reasons are ordered by how loud they are. */
export interface MovingReason {
  kind: 'election-now' | 'election-soon' | 'outdated' | 'active';
  label: string;
}

export interface CountrySummary {
  snapshot: CountrySnapshot | null;
  activity: CountryActivity;
  reasons: MovingReason[];
}

interface SnapshotRow {
  country_iso2: string;
  country_name: string;
  head_of_state: string | null;
  head_of_government: string | null;
  party: string | null;
  coalition: string;
  ideology: string | null;
  position: string;
  score: number | null;
  ideology_source: string | null;
  source_url: string | null;
  next_election_date: string | null;
  next_election_kind: string | null;
  election_source: string | null;
  state: string;
  note: string | null;
  fetched_at: string;
  updated_at: string;
}

const SELECT = `SELECT country_iso2, country_name, head_of_state, head_of_government, party, coalition,
  ideology, position, score, ideology_source, source_url, next_election_date, next_election_kind,
  election_source, state, note, fetched_at, updated_at FROM world_snapshot`;

function toSnapshot(row: SnapshotRow): CountrySnapshot {
  let coalition: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.coalition);
    if (Array.isArray(parsed)) coalition = parsed.map((c) => String(c));
  } catch {
    coalition = [];
  }
  return {
    iso2: row.country_iso2,
    name: row.country_name,
    headOfState: row.head_of_state,
    headOfGovernment: row.head_of_government,
    party: row.party,
    coalition,
    ideology: row.ideology,
    position: row.position as Position,
    score: row.score,
    ideologySource: row.ideology_source,
    sourceUrl: row.source_url,
    nextElectionDate: row.next_election_date,
    nextElectionKind: row.next_election_kind,
    electionSource: row.election_source,
    state: row.state as SnapshotState,
    note: row.note,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

const EMPTY_ACTIVITY: CountryActivity = { stories: 0, developments: 0, latestAt: null };

export class WorldRepository {
  constructor(
    private db: DB,
    private clock: Clock,
  ) {}

  /**
   * Write the placeholder rows when the snapshot is empty, so the map has something
   * on it before the fetch job exists. It never overwrites anything: a real snapshot
   * is left alone.
   */
  seedPlaceholders(): number {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM world_snapshot').get() as { n: number };
    if (count.n > 0) return 0;
    const now = iso(this.clock());
    const insert = this.db.prepare(`INSERT INTO world_snapshot
      (country_iso2, country_name, head_of_state, head_of_government, party, coalition, ideology,
       position, score, ideology_source, source_url, next_election_date, next_election_kind,
       election_source, state, note, fetched_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const write = this.db.transaction(() => {
      for (const p of PLACEHOLDERS) {
        insert.run(
          p.iso2,
          p.name,
          p.headOfState ?? null,
          p.headOfGovernment ?? null,
          p.party ?? null,
          JSON.stringify(p.coalition ?? []),
          p.ideology ?? null,
          p.position,
          POSITION_SCORE[p.position],
          PLACEHOLDER_SOURCE,
          null,
          p.nextElection ?? null,
          p.nextElectionKind ?? null,
          p.nextElection ? PLACEHOLDER_SOURCE : null,
          p.state ?? 'fresh',
          p.note ?? null,
          now,
          now,
        );
      }
    });
    write();
    return PLACEHOLDERS.length;
  }

  /** Every country Mimir has a row for. */
  list(): CountrySnapshot[] {
    const rows = this.db.prepare(`${SELECT} ORDER BY country_name`).all() as SnapshotRow[];
    return rows.map(toSnapshot);
  }

  get(iso2: string): CountrySnapshot | null {
    const row = this.db.prepare(`${SELECT} WHERE country_iso2 = ?`).get(iso2.toUpperCase()) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  /** When the snapshot was last written, and how many rows it holds. */
  freshness(): { updatedAt: string | null; countries: number } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updated FROM world_snapshot')
      .get() as { n: number; updated: string | null };
    return { updatedAt: row.updated, countries: row.n };
  }

  /**
   * How much of Mimir's news touches each country. The stories are the ones the
   * reader's profile ranked as worth reading, so the map is about their news and
   * not about the world's.
   */
  activity(days: number): Map<string, CountryActivity> {
    const since = new Date(this.clock().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT p.country_code AS iso2,
                COUNT(DISTINCT p.story_id) AS stories,
                SUM(s.development_count) AS developments,
                MAX(COALESCE(s.latest_development_at, s.latest_published_at, s.created_at)) AS latest
         FROM story_places p
         JOIN stories s ON s.id = p.story_id
         WHERE p.country_code IS NOT NULL AND p.country_code <> ''
           AND s.status = 'active'
           AND COALESCE(s.latest_development_at, s.latest_published_at, s.created_at) >= ?
         GROUP BY p.country_code`,
      )
      .all(since) as { iso2: string; stories: number; developments: number | null; latest: string | null }[];
    const map = new Map<string, CountryActivity>();
    for (const row of rows) {
      map.set(row.iso2.toUpperCase(), {
        stories: row.stories,
        developments: row.developments ?? row.stories,
        latestAt: row.latest,
      });
    }
    return map;
  }

  /** The stories that name a place in this country, newest first. */
  storiesFor(iso2: string, limit: number): CountryStory[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.headline, s.publisher_count, s.article_count, s.personal_relevance,
                MAX(COALESCE(s.latest_development_at, s.latest_published_at, s.created_at)) AS latest
         FROM story_places p
         JOIN stories s ON s.id = p.story_id
         WHERE p.country_code = ? AND s.status = 'active'
         GROUP BY s.id
         ORDER BY latest DESC
         LIMIT ?`,
      )
      // The places keep the country code as the model wrote it, in lower case.
      .all(iso2.toLowerCase(), limit) as {
      id: number;
      headline: string;
      publisher_count: number;
      article_count: number;
      personal_relevance: number | null;
      latest: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      publisherCount: r.publisher_count,
      articleCount: r.article_count,
      latestAt: r.latest,
      relevance: r.personal_relevance,
    }));
  }

  /** How many stories name a place in this country, all time. */
  storyCount(iso2: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT p.story_id) AS n FROM story_places p JOIN stories s ON s.id = p.story_id
         WHERE p.country_code = ? AND s.status = 'active'`,
      )
      .get(iso2.toLowerCase()) as { n: number };
    return row.n;
  }

  /**
   * The countries worth a look: an election is happening or coming, the news says the
   * snapshot may be out of date, or the country is where the news is.
   */
  moving(now = this.clock()): CountrySummary[] {
    const snapshots = this.list();
    const activity = this.activity(30);
    const summaries: CountrySummary[] = snapshots.map((snapshot) => {
      const reasons: MovingReason[] = [];
      const standing = electionStanding(snapshot.nextElectionDate, now);
      const days = daysUntil(snapshot.nextElectionDate, now);
      if (standing === 'now') {
        reasons.push({ kind: 'election-now', label: days != null && days < 0 ? 'election just held' : 'election now' });
      } else if (standing === 'soon' && days != null && days <= 30) {
        reasons.push({ kind: 'election-soon', label: `election in ${days} days` });
      }
      if (snapshot.state === 'stale') reasons.push({ kind: 'outdated', label: 'may be out of date' });
      const act = activity.get(snapshot.iso2) ?? EMPTY_ACTIVITY;
      if (act.stories > 0) reasons.push({ kind: 'active', label: `${act.stories} ${act.stories === 1 ? 'story' : 'stories'}` });
      return { snapshot, activity: act, reasons };
    });
    const weight = (s: CountrySummary): number => {
      const kinds = s.reasons.map((r) => r.kind);
      let w = 0;
      if (kinds.includes('election-now')) w += 100;
      if (kinds.includes('election-soon')) w += 60;
      if (kinds.includes('outdated')) w += 40;
      w += Math.min(20, s.activity.stories);
      return w;
    };
    return summaries.filter((s) => s.reasons.length > 0).sort((a, b) => weight(b) - weight(a) || a.snapshot!.name.localeCompare(b.snapshot!.name));
  }
}
