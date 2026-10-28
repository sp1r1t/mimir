-- Quality of the text stored for reading and classification.
-- full: validated article body, or substantial feed content.
-- partial: a summary or an incomplete extraction kept on purpose.
-- unknown: stored before quality was assessed.
ALTER TABLE articles ADD COLUMN content_quality TEXT NOT NULL DEFAULT 'unknown'
  CHECK (content_quality IN ('unknown', 'full', 'partial'));
