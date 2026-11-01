import directoryMigration from '../../migrations/0002_directory.sql?raw';
import scaleMigration from '../../migrations/0001_scale.sql?raw';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);

CREATE TABLE IF NOT EXISTS login_flow (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS page (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES app_user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS page_updated_idx ON page(updated_at DESC);

CREATE TABLE IF NOT EXISTS page_alias (
  alias TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS page_alias_page_idx ON page_alias(page_id);

CREATE TABLE IF NOT EXISTS page_body (
  page_id TEXT PRIMARY KEY REFERENCES page(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revision (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  author_id TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, version)
);
CREATE INDEX IF NOT EXISTS revision_page_idx ON revision(page_id, version DESC);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
);
`;

const schemaPromises = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = createSchema(db).catch((error) => {
      schemaPromises.delete(db);
      throw error;
    });
    schemaPromises.set(db, promise);
  }
  return promise;
}

async function createSchema(db: D1Database): Promise<void> {
  // D1 exec treats each line as one statement (unlike SQLite's exec).
  await db.exec(
    SCHEMA.split(';')
      .map((sql) => sql.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(';\n'),
  );
  const migrated = await db
    .prepare("SELECT value FROM meta WHERE key = 'migration:0001_scale'")
    .first();
  if (!migrated) {
    // D1 batch is transactional: the marker is committed with the complete migration.
    await db.batch(migrationStatements(db, scaleMigration));
  }

  const directoryMigrated = await db
    .prepare("SELECT value FROM meta WHERE key = 'migration:0002_directory'")
    .first();
  if (!directoryMigrated) {
    const columns = await db.prepare('PRAGMA table_info(page)').all<{ name: string }>();
    const hasParentId = (columns.results ?? []).some((column) => column.name === 'parent_id');
    // SQLite has no ADD COLUMN IF NOT EXISTS. Skip the ALTER when a previous
    // manual application added the column but did not write the marker.
    await db.batch(
      migrationStatements(
        db,
        directoryMigration,
        (sql) => !(hasParentId && /\bALTER\s+TABLE\s+page\s+ADD\s+COLUMN\s+parent_id\b/i.test(sql)),
      ),
    );
  }

  try {
    await db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(page_id UNINDEXED, title, body, tokenize='trigram')",
    );
  } catch {
    await db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(page_id UNINDEXED, title, body)',
    );
  }
}

function migrationStatements(
  db: D1Database,
  migration: string,
  include: (sql: string) => boolean = () => true,
): D1PreparedStatement[] {
  return migration
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean)
    .filter(include)
    .map((sql) => db.prepare(sql));
}
