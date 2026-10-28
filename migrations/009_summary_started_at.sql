-- When the brief generation started, so the story page can show how long it is taking.
ALTER TABLE stories ADD COLUMN summary_started_at TEXT;
