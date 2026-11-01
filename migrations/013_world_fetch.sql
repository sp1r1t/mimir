-- What each reading of the world found.
--
-- The snapshot itself says what Mimir knows; this says what the source said when
-- Mimir last asked, and whether the asking worked. A reader looking at a stale
-- country wants to know whether the map is old or the source is broken.
CREATE TABLE IF NOT EXISTS world_fetch_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- How many countries the reading produced.
  countries     INTEGER NOT NULL DEFAULT 0,
  -- The codes the map draws that Wikidata does not know as sovereign states.
  unmapped      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unmapped)),
  -- The reading failed; the rows are the last good ones.
  error         TEXT
);

CREATE INDEX IF NOT EXISTS world_fetch_log_started ON world_fetch_log (started_at DESC);
