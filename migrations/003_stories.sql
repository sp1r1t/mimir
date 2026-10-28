-- Stories: persistent groups of articles about the same news event, with their own
-- assessments, development history, and executive summaries. Everything here is derived;
-- articles, classifications, and feedback stay the source of truth.

CREATE TABLE stories (
  id                      INTEGER PRIMARY KEY,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into_id          INTEGER REFERENCES stories (id),
  headline                TEXT NOT NULL,
  lead_article_id         INTEGER REFERENCES articles (id) ON DELETE SET NULL,
  -- Membership aggregates, recomputed whenever membership changes.
  article_count           INTEGER NOT NULL DEFAULT 0,
  publisher_count         INTEGER NOT NULL DEFAULT 0,
  development_count       INTEGER NOT NULL DEFAULT 0,
  first_published_at      TEXT,
  latest_published_at     TEXT,
  latest_development_at   TEXT,  -- publication time of the latest meaningful development
  -- Current assessment (history in story_assessments).
  assessment_id           INTEGER,
  personal_relevance      REAL,
  significance            REAL,
  urgency                 REAL,
  coverage                REAL,
  -- priority = priority_static + recency_weight / (1 + age_hours / recency_half_life_hours)
  priority_static         REAL,
  recency_weight          REAL,
  recency_half_life_hours REAL,
  categories              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),
  -- Summary state. summary_id is the latest valid revision; failures never replace it.
  summary_id              INTEGER,
  summary_stale           INTEGER NOT NULL DEFAULT 0 CHECK (summary_stale IN (0, 1)),
  summary_request         TEXT NOT NULL DEFAULT 'idle' CHECK (summary_request IN ('idle', 'pending', 'running', 'failed')),
  summary_error           TEXT,
  summary_requested_at    TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX stories_active_latest ON stories (status, latest_development_at);
CREATE INDEX stories_merged_into ON stories (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Automatic matching decisions with their inputs and the matcher's raw answers.
CREATE TABLE story_matches (
  id              INTEGER PRIMARY KEY,
  article_id      INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  story_id        INTEGER REFERENCES stories (id) ON DELETE SET NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('new_story', 'joined')),
  role            TEXT NOT NULL CHECK (role IN ('origin', 'coverage', 'update')),
  method          TEXT NOT NULL CHECK (method IN ('no_candidates', 'title_match', 'matcher')),
  candidates      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates)),
  matcher         TEXT,
  matcher_version TEXT,
  model           TEXT,
  raw_request     TEXT CHECK (raw_request IS NULL OR json_valid(raw_request)),
  raw_response    TEXT CHECK (raw_response IS NULL OR json_valid(raw_response)),
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX story_matches_article ON story_matches (article_id, created_at DESC);
CREATE INDEX story_matches_created ON story_matches (created_at);

-- Each article belongs to at most one story.
CREATE TABLE story_articles (
  article_id   INTEGER PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  story_id     INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('origin', 'coverage', 'update')),
  assigned_by  TEXT NOT NULL CHECK (assigned_by IN ('matcher', 'user')),
  match_id     INTEGER REFERENCES story_matches (id) ON DELETE SET NULL,
  publisher    TEXT NOT NULL,      -- normalized publisher (site host) for distinct-publisher counts
  occurred_at  TEXT NOT NULL,      -- publication time, or discovery time when the source gave none
  added_at     TEXT NOT NULL
);
CREATE INDEX story_articles_story ON story_articles (story_id, occurred_at);

-- Development history: the first report and every meaningful update.
CREATE TABLE story_developments (
  id          INTEGER PRIMARY KEY,
  story_id    INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  article_id  INTEGER NOT NULL UNIQUE REFERENCES articles (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('origin', 'update')),
  occurred_at TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE INDEX story_developments_story ON story_developments (story_id, occurred_at);

-- Manual curation log (merge, split).
CREATE TABLE story_events (
  id         INTEGER PRIMARY KEY,
  story_id   INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('merged_into', 'absorbed', 'split_out', 'split_from')),
  details    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  actor      TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);
CREATE INDEX story_events_story ON story_events (story_id, created_at);

-- Assessment history. A new row is written only when inputs or results change.
CREATE TABLE story_assessments (
  id                      INTEGER PRIMARY KEY,
  story_id                INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  formula                 TEXT NOT NULL,
  profile_version         INTEGER NOT NULL,
  input_hash              TEXT NOT NULL,
  personal_relevance      REAL,
  significance            REAL,
  urgency                 REAL,
  coverage                REAL NOT NULL,
  priority_static         REAL,
  recency_weight          REAL NOT NULL,
  recency_half_life_hours REAL NOT NULL,
  categories              TEXT NOT NULL CHECK (json_valid(categories)),
  evidence                TEXT NOT NULL CHECK (json_valid(evidence)),
  created_at              TEXT NOT NULL
);
CREATE INDEX story_assessments_story ON story_assessments (story_id, id DESC);

-- Validated executive summary revisions. Failed or rejected generations are never stored here.
CREATE TABLE story_summaries (
  id             INTEGER PRIMARY KEY,
  story_id       INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  articles       TEXT NOT NULL CHECK (json_valid(articles)),  -- [{articleId, contentHash, role, basis}]
  content        TEXT NOT NULL CHECK (json_valid(content)),
  raw_output     TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL,
  UNIQUE (story_id, revision)
);

-- Every provider call for summaries, successful or not (usage, latency, failure metrics).
CREATE TABLE summary_attempts (
  id            INTEGER PRIMARY KEY,
  story_id      INTEGER REFERENCES stories (id) ON DELETE SET NULL,
  trigger       TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  provider      TEXT NOT NULL,
  model         TEXT,
  outcome       TEXT NOT NULL,
  error         TEXT,
  summary_id    INTEGER REFERENCES story_summaries (id) ON DELETE SET NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  duration_ms   INTEGER,
  started_at    TEXT NOT NULL
);
CREATE INDEX summary_attempts_started ON summary_attempts (started_at);

-- Document frequencies for candidate retrieval (IDF weighting of shared terms).
CREATE VIRTUAL TABLE articles_fts_vocab USING fts5vocab (articles_fts, 'row');

-- Set when a job is enqueued again while it runs: it then returns to pending instead of done.
ALTER TABLE jobs ADD COLUMN rerun INTEGER NOT NULL DEFAULT 0;
