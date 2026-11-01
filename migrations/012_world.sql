-- The world snapshot: what Mimir knows about who governs each country, where that
-- came from, and when it was last seen. One row per country.
--
-- The row is a claim with a source and a date, never a bare fact: a country Mimir
-- knows nothing about has no row at all, and a row it does not trust says so in
-- "state".
CREATE TABLE IF NOT EXISTS world_snapshot (
  country_iso2        TEXT PRIMARY KEY,
  country_name        TEXT NOT NULL,
  head_of_state       TEXT,
  head_of_government  TEXT,
  party               TEXT,
  coalition           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(coalition)),
  -- The label as its source gives it: "social democracy", "liberal conservatism".
  ideology            TEXT,
  -- Where the government sits on the left-right axis, when it sits on it at all.
  position            TEXT NOT NULL CHECK (position IN ('left','centre-left','centre','centre-right','right','not-on-axis','unknown')),
  -- -1 at the left end, 1 at the right end; null when the position is not on the axis.
  score               REAL,
  ideology_source     TEXT,
  source_url          TEXT,
  next_election_date  TEXT,
  next_election_kind  TEXT,
  election_source     TEXT,
  -- fresh: the source was read recently. stale: the news says it may have changed.
  -- unknown: the row exists but the position is not known. manual: a person set it.
  -- failed: the last refresh did not work and the row is the last good one.
  state               TEXT NOT NULL CHECK (state IN ('fresh','stale','unknown','manual','failed')),
  note                TEXT,
  fetched_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_snapshot_state ON world_snapshot (state);
CREATE INDEX IF NOT EXISTS world_snapshot_election ON world_snapshot (next_election_date);
