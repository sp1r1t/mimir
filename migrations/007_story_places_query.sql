-- The place reader resolves a name in the context of the articles: it gives the name to
-- look up and the country it lies in, so that two places of the same name are not mixed up.
ALTER TABLE story_places ADD COLUMN query TEXT;
ALTER TABLE story_places ADD COLUMN country_code TEXT;
