import { z } from 'zod';

/**
 * Where a government sits on the left-right axis.
 *
 * "not-on-axis" is not a gap in the data: a one-party state and an absolute monarchy
 * have a government whose position on that axis does not mean anything, and saying
 * "right" about them would be a claim Mimir cannot support. "unknown" means the row
 * exists and the position was not established.
 */
export const POSITIONS = ['left', 'centre-left', 'centre', 'centre-right', 'right', 'not-on-axis', 'unknown'] as const;
export type Position = (typeof POSITIONS)[number];

/** How much Mimir trusts a row. The same vocabulary the places use. */
export const SNAPSHOT_STATES = ['fresh', 'stale', 'unknown', 'manual', 'failed'] as const;
export type SnapshotState = (typeof SNAPSHOT_STATES)[number];

export const PositionSchema = z.enum(POSITIONS);
export const SnapshotStateSchema = z.enum(SNAPSHOT_STATES);

export const ELECTION_KINDS = ['parliamentary', 'presidential', 'snap', 'local', 'other'] as const;
export type ElectionKind = (typeof ELECTION_KINDS)[number];

/** The position of a government on the axis: -1 at the left end, 1 at the right end. */
export const POSITION_SCORE: Record<Position, number | null> = {
  left: -1,
  'centre-left': -0.5,
  centre: 0,
  'centre-right': 0.5,
  right: 1,
  'not-on-axis': null,
  unknown: null,
};

/** How a position is named to the reader. */
export const POSITION_LABEL: Record<Position, string> = {
  left: 'left',
  'centre-left': 'centre-left',
  centre: 'centre',
  'centre-right': 'centre-right',
  right: 'right',
  'not-on-axis': 'not on the axis',
  unknown: 'unknown',
};

/** The stops of the ramp, from the left end to the right end. */
export const RAMP: { position: Position; label: string; token: string }[] = [
  { position: 'left', label: 'left', token: '--world-left' },
  { position: 'centre-left', label: 'centre-left', token: '--world-centre-left' },
  { position: 'centre', label: 'centre', token: '--world-centre' },
  { position: 'centre-right', label: 'centre-right', token: '--world-centre-right' },
  { position: 'right', label: 'right', token: '--world-right' },
];

export interface CountrySnapshot {
  iso2: string;
  name: string;
  headOfState: string | null;
  headOfGovernment: string | null;
  party: string | null;
  coalition: string[];
  ideology: string | null;
  position: Position;
  score: number | null;
  ideologySource: string | null;
  sourceUrl: string | null;
  nextElectionDate: string | null;
  nextElectionKind: string | null;
  electionSource: string | null;
  state: SnapshotState;
  note: string | null;
  fetchedAt: string;
  updatedAt: string;
}

/** The three ways the map can be coloured. Each one gives the fill a single meaning. */
export const WORLD_VIEWS = ['politics', 'activity', 'elections'] as const;
export type WorldView = (typeof WORLD_VIEWS)[number];

export const WorldViewSchema = z.enum(WORLD_VIEWS);

export const VIEW_LABEL: Record<WorldView, string> = {
  politics: 'Politics',
  activity: 'Activity',
  elections: 'Elections',
};

/** How an election stands relative to now. */
export type ElectionStanding = 'none' | 'past' | 'now' | 'soon';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The whole days from now until a date. Negative when the date has passed. */
export function daysUntil(date: string | null, now: Date): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now.getTime()) / DAY_MS);
}

/**
 * Where an election stands: it has passed, it is happening now (the last week before
 * and the day after), it is coming, or there is none to speak of.
 */
export function electionStanding(date: string | null, now: Date): ElectionStanding {
  const days = daysUntil(date, now);
  if (days == null) return 'none';
  if (days < -1) return 'past';
  if (days <= 7) return 'now';
  return 'soon';
}
