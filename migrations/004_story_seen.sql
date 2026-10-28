-- "Seen" state for stories. seen_development_at is the story's latest_development_at at the
-- moment it was marked seen; a story counts as unseen again when a newer meaningful development
-- arrives (additional coverage does not move latest_development_at).
ALTER TABLE stories ADD COLUMN seen_at TEXT;
ALTER TABLE stories ADD COLUMN seen_development_at TEXT;
CREATE INDEX stories_seen ON stories (status, seen_at);
