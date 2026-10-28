-- When the reader saved the story, so it stays in reach after it has been seen.
ALTER TABLE stories ADD COLUMN saved_at TEXT;
CREATE INDEX stories_saved ON stories (status, saved_at);
