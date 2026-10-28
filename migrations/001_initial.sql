-- Mimir initial schema.
-- Timestamps are ISO-8601 UTC strings (e.g. 2026-10-25T14:13:00.000Z), which sort lexicographically.
-- Original source information (sources, articles, article_entries) is kept separate from
-- generated interpretations (classifications) and user state (article_state, feedback_events).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Feed subscriptions and their fetch state.
CREATE TABLE sources (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  url                   TEXT NOT NULL UNIQUE,
  type                  TEXT NOT NULL DEFAULT 'feed' CHECK (type IN ('feed')),
  site_url              TEXT,
  config                TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds >= 60),
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- fetch state
  etag                  TEXT,
  last_modified         TEXT,
  next_fetch_at         TEXT,
  last_fetch_at         TEXT,
  last_success_at       TEXT,
  last_http_status      INTEGER,
  last_error            TEXT,
  last_error_at         TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  feed_format           TEXT,
  feed_title            TEXT,
  feed_metadata         TEXT CHECK (feed_metadata IS NULL OR json_valid(feed_metadata))
);
CREATE INDEX sources_due ON sources (enabled, next_fetch_at);

-- One row per fetch attempt (pruned by retention).
CREATE TABLE source_fetches (
  id            INTEGER PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'not_modified', 'error')),
  http_status   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 1,
  bytes         INTEGER,
  items_seen    INTEGER NOT NULL DEFAULT 0,
  items_new     INTEGER NOT NULL DEFAULT 0,
  items_updated INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX source_fetches_source ON source_fetches (source_id, started_at DESC);
CREATE INDEX source_fetches_started ON source_fetches (started_at);

-- Articles as published by their sources. Deduplicated by canonical URL across sources.
CREATE TABLE articles (
  id                     INTEGER PRIMARY KEY,
  source_id              INTEGER REFERENCES sources (id) ON DELETE SET NULL, -- source that first delivered it
  guid                   TEXT,          -- original GUID/id from the first entry
  title                  TEXT,
  url                    TEXT,          -- original link as published
  canonical_url          TEXT UNIQUE,   -- normalized link, dedupe key
  declared_canonical_url TEXT,          -- <link rel=canonical> from the article page, if extracted
  author                 TEXT,
  description            TEXT,          -- feed summary as provided (may be HTML)
  summary_text           TEXT,          -- plain-text form of description
  content_html           TEXT,          -- full content as provided by the feed (may be HTML)
  content_text           TEXT,          -- best available plain text (feed or extracted)
  content_source         TEXT NOT NULL DEFAULT 'none'
                         CHECK (content_source IN ('none', 'feed_summary', 'feed_content', 'extracted')),
  extracted_html         TEXT,
  extraction_status      TEXT NOT NULL DEFAULT 'pending'
                         CHECK (extraction_status IN ('pending', 'succeeded', 'not_needed', 'disabled',
                                                      'not_permitted', 'unavailable', 'insufficient', 'failed')),
  extraction_error       TEXT,
  extracted_at           TEXT,
  language               TEXT,
  feed_categories        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(feed_categories)),
  published_at           TEXT,          -- publication date claimed by the source
  source_updated_at      TEXT,          -- update date claimed by the source
  discovered_at          TEXT NOT NULL, -- start of the fetch that first saw the entry
  ingested_at            TEXT NOT NULL, -- when the record was stored
  content_updated_at     TEXT,          -- last time stored content changed due to a feed update
  content_hash           TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX articles_source ON articles (source_id);
CREATE INDEX articles_published ON articles (published_at);
CREATE INDEX articles_discovered ON articles (discovered_at);
CREATE INDEX articles_declared_canonical ON articles (declared_canonical_url);

-- Every feed entry that mapped to an article (one per source), with original metadata.
CREATE TABLE article_entries (
  id            INTEGER PRIMARY KEY,
  article_id    INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_id     INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  source_name   TEXT,                  -- snapshot so provenance survives source deletion
  entry_key     TEXT NOT NULL,         -- stable identifier within the source (guid, link, or hash)
  guid          TEXT,
  link          TEXT,
  feed_format   TEXT,
  content_hash  TEXT NOT NULL,
  raw_first     TEXT NOT NULL CHECK (json_valid(raw_first)),
  raw_latest    TEXT CHECK (raw_latest IS NULL OR json_valid(raw_latest)), -- NULL while identical to raw_first
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (source_id, entry_key)
);
CREATE INDEX article_entries_article ON article_entries (article_id);

CREATE VIRTUAL TABLE articles_fts USING fts5 (
  title, summary_text, content_text, author,
  content = 'articles', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER articles_fts_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, title, summary_text, content_text, author)
  VALUES (new.id, new.title, new.summary_text, new.content_text, new.author);
END;
CREATE TRIGGER articles_fts_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary_text, content_text, author)
  VALUES ('delete', old.id, old.title, old.summary_text, old.content_text, old.author);
END;
CREATE TRIGGER articles_fts_au AFTER UPDATE OF title, summary_text, content_text, author ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary_text, content_text, author)
  VALUES ('delete', old.id, old.title, old.summary_text, old.content_text, old.author);
  INSERT INTO articles_fts (rowid, title, summary_text, content_text, author)
  VALUES (new.id, new.title, new.summary_text, new.content_text, new.author);
END;

-- Versioned interest profiles. Exactly one is active.
CREATE TABLE interest_profiles (
  id           INTEGER PRIMARY KEY,
  version      INTEGER NOT NULL UNIQUE,
  definition   TEXT NOT NULL CHECK (json_valid(definition)),
  change_note  TEXT,
  author       TEXT NOT NULL DEFAULT 'user' CHECK (author IN ('system', 'user', 'agent')),
  is_active    INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL,
  activated_at TEXT
);
CREATE UNIQUE INDEX interest_profiles_one_active ON interest_profiles (is_active) WHERE is_active = 1;

-- Classification history. Never overwritten; article_state points at the current one.
CREATE TABLE classifications (
  id                 INTEGER PRIMARY KEY,
  article_id         INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  profile_id         INTEGER NOT NULL REFERENCES interest_profiles (id),
  profile_version    INTEGER NOT NULL,
  classifier         TEXT NOT NULL,     -- e.g. 'jev'
  classifier_version TEXT NOT NULL,     -- question-set / adapter version
  model              TEXT NOT NULL,     -- model id reported by the service
  input_hash         TEXT NOT NULL,     -- hash of the exact request sent
  personal_relevance REAL NOT NULL CHECK (personal_relevance BETWEEN 0 AND 1),
  significance       REAL NOT NULL CHECK (significance BETWEEN 0 AND 1),
  urgency            REAL NOT NULL CHECK (urgency BETWEEN 0 AND 1),
  investigate        REAL NOT NULL CHECK (investigate BETWEEN 0 AND 1),
  promotional        REAL CHECK (promotional IS NULL OR promotional BETWEEN 0 AND 1),
  exclusion          REAL CHECK (exclusion IS NULL OR exclusion BETWEEN 0 AND 1),
  article_type       TEXT,
  rank_score         REAL NOT NULL,
  rank_formula       TEXT NOT NULL,
  categories         TEXT NOT NULL CHECK (json_valid(categories)),
  signals            TEXT NOT NULL CHECK (json_valid(signals)),
  raw_request        TEXT NOT NULL CHECK (json_valid(raw_request)),
  raw_response       TEXT NOT NULL CHECK (json_valid(raw_response)),
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  duration_ms        INTEGER,
  created_at         TEXT NOT NULL
);
CREATE INDEX classifications_article ON classifications (article_id, created_at DESC);
CREATE INDEX classifications_created ON classifications (created_at);

CREATE TABLE classification_categories (
  classification_id INTEGER NOT NULL REFERENCES classifications (id) ON DELETE CASCADE,
  category_id       TEXT NOT NULL,
  probability       REAL NOT NULL CHECK (probability BETWEEN 0 AND 1),
  assigned          INTEGER NOT NULL CHECK (assigned IN (0, 1)),
  PRIMARY KEY (classification_id, category_id)
);
CREATE INDEX classification_categories_category ON classification_categories (category_id, assigned);

-- Derived per-article state: current classification and current user feedback state.
-- feedback_events is the source of truth; this table is a materialized view for querying.
CREATE TABLE article_state (
  article_id                INTEGER PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  classification_status     TEXT NOT NULL DEFAULT 'pending'
                            CHECK (classification_status IN ('pending', 'classified', 'failed')),
  classification_error      TEXT,
  current_classification_id INTEGER REFERENCES classifications (id) ON DELETE SET NULL,
  rank_score                REAL,
  relevance_label           TEXT CHECK (relevance_label IN ('relevant', 'not_relevant')),
  preference                TEXT CHECK (preference IN ('more', 'less')),
  saved_at                  TEXT,
  first_viewed_at           TEXT,
  last_feedback_at          TEXT
);
CREATE INDEX article_state_rank ON article_state (rank_score);
CREATE INDEX article_state_status ON article_state (classification_status);
CREATE INDEX article_state_saved ON article_state (saved_at) WHERE saved_at IS NOT NULL;

-- Append-only user feedback and interaction events.
CREATE TABLE feedback_events (
  id                INTEGER PRIMARY KEY,
  article_id        INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'relevant', 'not_relevant', 'clear_relevance',
                      'more_like_this', 'less_like_this', 'clear_preference',
                      'save', 'unsave', 'view', 'open_original')),
  classification_id INTEGER REFERENCES classifications (id) ON DELETE SET NULL,
  profile_version   INTEGER,
  rank_score        REAL,              -- score shown at the time of the event
  context           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context)),
  actor             TEXT NOT NULL DEFAULT 'user',
  created_at        TEXT NOT NULL
);
CREATE INDEX feedback_events_article ON feedback_events (article_id, created_at);
CREATE INDEX feedback_events_type ON feedback_events (event_type, created_at);

-- Persistent job queue for extraction and classification.
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    TEXT NOT NULL,
  locked_at    TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs (kind, dedupe_key) WHERE status IN ('pending', 'running');
CREATE INDEX jobs_claim ON jobs (kind, status, priority DESC, run_after);
CREATE INDEX jobs_finished ON jobs (status, finished_at);
