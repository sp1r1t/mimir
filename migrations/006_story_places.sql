-- The places a story is about: the names a model found in the articles, and where the
-- gazetteer put them. The gazetteer's answers are kept in place_geocodes, shared by every
-- story that names the same place, so a name is looked up once and never again.
CREATE TABLE IF NOT EXISTS story_places (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('city', 'town', 'country', 'region', 'other')),
  country TEXT,
  role TEXT,
  lat REAL,
  lon REAL,
  label TEXT,
  display_name TEXT,
  osm_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('located', 'unresolved')),
  sources TEXT NOT NULL CHECK (json_valid(sources)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS story_places_story ON story_places(story_id);

-- One row per gazetteer query, found or not found: a name that is not a place stays
-- a name that is not a place.
CREATE TABLE IF NOT EXISTS place_geocodes (
  query_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('located', 'unresolved')),
  lat REAL,
  lon REAL,
  label TEXT,
  display_name TEXT,
  osm_id TEXT,
  queried_at TEXT NOT NULL
);

-- Where the lookup stands: none, queued, running, ready, outdated by a new development,
-- or failed.
ALTER TABLE stories ADD COLUMN places_state TEXT NOT NULL DEFAULT 'none'
  CHECK (places_state IN ('none', 'pending', 'running', 'ready', 'stale', 'failed'));
ALTER TABLE stories ADD COLUMN places_error TEXT;
