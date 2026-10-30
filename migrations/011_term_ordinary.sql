-- Whether a name is an ordinary word in this news. "NEW" is Debian's incoming queue in
-- one story and the opposite of old in all the others, so the glossary has to know which
-- names the news writes as words.
ALTER TABLE terms ADD COLUMN ordinary INTEGER NOT NULL DEFAULT 0;
