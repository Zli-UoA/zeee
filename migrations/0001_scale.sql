-- Additive and replay-safe on an existing pre-Scale database.
CREATE TABLE IF NOT EXISTS page_last_editor (
  page_id TEXT PRIMARY KEY REFERENCES page(id) ON DELETE CASCADE,
  author_id TEXT,
  edited_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS page_active_updated_idx
  ON page(updated_at DESC, created_at DESC, id ASC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS page_active_created_idx
  ON page(created_at DESC, updated_at DESC, id ASC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS page_active_title_idx
  ON page(title, updated_at DESC, id ASC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS page_deleted_idx
  ON page(deleted_at DESC, id ASC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_page_rename_idx
  ON audit_event(target_id, created_at DESC) WHERE target_type = 'page' AND action = 'page.rename';

-- Use the latest recorded content revision or rename, falling back to creation.
-- A revision whose author is unknown stays unknown. Never overwrite a live editor row.
INSERT OR IGNORE INTO page_last_editor (page_id, author_id, edited_at)
SELECT p.id,
  (SELECT author_id FROM (
    SELECT p.created_by AS author_id, p.created_at AS at, 0 AS priority, '' AS event_id
    UNION ALL
    SELECT r.author_id, r.created_at, 1, printf('%020d', r.version) FROM revision r WHERE r.page_id = p.id
    UNION ALL
    SELECT a.actor_id, a.created_at, 2, a.id FROM audit_event a
      WHERE a.target_id = p.id AND a.target_type = 'page' AND a.action = 'page.rename'
  ) ORDER BY at DESC, priority DESC, event_id DESC LIMIT 1),
  p.updated_at
FROM page p;

INSERT OR REPLACE INTO meta (key, value) VALUES ('migration:0001_scale', '1');
