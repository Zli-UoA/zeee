-- Active page titles are `/`-separated paths. Exact duplicates and prefix
-- collisions (a vs a/b) are rejected for active pages only. Deleted pages are
-- ignored; undelete re-checks the restored path.
--
-- This migration refuses to run when existing active data already violates the
-- contract. Run the audit SQL in docs/operations.md before applying it.

-- Abort with a descriptive blocker when pre-existing rows conflict. The guard
-- table and trigger are removed in the same transactional batch.
CREATE TABLE IF NOT EXISTS page_path_migration_guard (
  ok INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS page_path_migration_guard_abort
BEFORE INSERT ON page_path_migration_guard
WHEN NEW.ok <> 1
BEGIN
  SELECT RAISE(ABORT, 'PATH_CONFLICT: existing active page paths conflict');
END;

INSERT INTO page_path_migration_guard (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM page p
  JOIN page q
    ON q.id > p.id
   AND p.deleted_at IS NULL
   AND q.deleted_at IS NULL
   AND (
     p.title = q.title
     OR substr(q.title, 1, length(p.title) + 1) = p.title || '/'
     OR substr(p.title, 1, length(q.title) + 1) = q.title || '/'
   )
) THEN 0 ELSE 1 END;

DROP TRIGGER IF EXISTS page_path_migration_guard_abort;
DROP TABLE IF EXISTS page_path_migration_guard;

-- Exact duplicates among active pages.
CREATE UNIQUE INDEX IF NOT EXISTS page_active_path_unique_idx
  ON page(title) WHERE deleted_at IS NULL;

-- Prefix collisions cannot be expressed by an index, so every write that makes
-- a path active is guarded by a trigger.
CREATE TRIGGER IF NOT EXISTS page_path_insert_guard
BEFORE INSERT ON page
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'PATH_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM page p
    WHERE p.deleted_at IS NULL
      AND (
        p.title = NEW.title
        OR substr(p.title, 1, length(NEW.title) + 1) = NEW.title || '/'
        OR substr(NEW.title, 1, length(p.title) + 1) = p.title || '/'
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS page_path_title_update_guard
BEFORE UPDATE OF title ON page
WHEN NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'PATH_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM page p
    WHERE p.deleted_at IS NULL
      AND p.id <> OLD.id
      AND (
        p.title = NEW.title
        OR substr(p.title, 1, length(NEW.title) + 1) = NEW.title || '/'
        OR substr(NEW.title, 1, length(p.title) + 1) = p.title || '/'
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS page_path_undelete_guard
BEFORE UPDATE OF deleted_at ON page
WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PATH_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM page p
    WHERE p.deleted_at IS NULL
      AND p.id <> OLD.id
      AND (
        p.title = NEW.title
        OR substr(p.title, 1, length(NEW.title) + 1) = NEW.title || '/'
        OR substr(NEW.title, 1, length(p.title) + 1) = p.title || '/'
      )
  );
END;

INSERT OR REPLACE INTO meta (key, value) VALUES ('migration:0002_path_uniqueness', '1');
