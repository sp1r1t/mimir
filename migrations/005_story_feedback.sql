-- Story-level relevance feedback. A label says whether the story matters to the reader; it
-- stays when the story develops (unlike "seen"). Each event keeps the assessment the reader
-- saw, so labels can later be compared with the scores and used for behavioural learning.
-- Article-level feedback_events stay untouched as history.
ALTER TABLE stories ADD COLUMN relevance_label TEXT CHECK (relevance_label IS NULL OR relevance_label IN ('relevant', 'not_relevant'));
ALTER TABLE stories ADD COLUMN relevance_labeled_at TEXT;

CREATE TABLE story_feedback_events (
  id                 INTEGER PRIMARY KEY,
  story_id           INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL CHECK (event_type IN ('relevant', 'not_relevant', 'clear_relevance')),
  assessment_id      INTEGER,
  profile_version    INTEGER,
  personal_relevance REAL,
  significance       REAL,
  urgency            REAL,
  priority           REAL,
  article_count      INTEGER,
  publisher_count    INTEGER,
  development_count  INTEGER,
  context            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context)),
  actor              TEXT NOT NULL DEFAULT 'user',
  created_at         TEXT NOT NULL
);
CREATE INDEX story_feedback_events_story ON story_feedback_events (story_id, created_at);
CREATE INDEX story_feedback_events_type ON story_feedback_events (event_type, created_at);

-- Carry article-level relevance labels over to their story when every labelled article agrees.
UPDATE stories SET
  relevance_label = (SELECT MIN(st.relevance_label) FROM story_articles sa JOIN article_state st ON st.article_id = sa.article_id
                     WHERE sa.story_id = stories.id AND st.relevance_label IS NOT NULL),
  relevance_labeled_at = (SELECT MAX(st.last_feedback_at) FROM story_articles sa JOIN article_state st ON st.article_id = sa.article_id
                          WHERE sa.story_id = stories.id AND st.relevance_label IS NOT NULL)
WHERE status = 'active'
  AND (SELECT COUNT(DISTINCT st.relevance_label) FROM story_articles sa JOIN article_state st ON st.article_id = sa.article_id
       WHERE sa.story_id = stories.id AND st.relevance_label IS NOT NULL) = 1;

INSERT INTO story_feedback_events (story_id, event_type, assessment_id, profile_version, personal_relevance, significance, urgency,
                                   article_count, publisher_count, development_count, context, actor, created_at)
SELECT s.id, s.relevance_label, s.assessment_id, (SELECT profile_version FROM story_assessments WHERE id = s.assessment_id),
       s.personal_relevance, s.significance, s.urgency, s.article_count, s.publisher_count, s.development_count,
       '{"carriedOverFromArticles":true}', 'migration', COALESCE(s.relevance_labeled_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM stories s WHERE s.relevance_label IS NOT NULL;
