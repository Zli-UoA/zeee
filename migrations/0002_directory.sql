-- Additive directory metadata. Existing pages stay at the root (parent_id IS NULL).
ALTER TABLE page ADD COLUMN parent_id TEXT REFERENCES page(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS page_parent_idx ON page(parent_id, title, id);

INSERT OR REPLACE INTO meta (key, value) VALUES ('migration:0002_directory', '1');
