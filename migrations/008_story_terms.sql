-- The glossary: the terms Mimir knows, each with an explanation of its own. A term is
-- looked up once, and every story and article that names it afterwards reuses it.
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  term_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organisation', 'product', 'person', 'project', 'concept', 'acronym', 'other')),
  wiki TEXT,
  summary TEXT,
  description TEXT,
  source_name TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'explained', 'unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The terms of a story, and the articles that name them.
CREATE TABLE IF NOT EXISTS story_terms (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  role TEXT,
  sources TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, term_id)
);
CREATE INDEX IF NOT EXISTS story_terms_term ON story_terms(term_id);

-- Where the term lookup stands, the way the places do.
ALTER TABLE stories ADD COLUMN terms_state TEXT NOT NULL DEFAULT 'none'
  CHECK (terms_state IN ('none', 'pending', 'running', 'ready', 'stale', 'failed'));
ALTER TABLE stories ADD COLUMN terms_error TEXT;
