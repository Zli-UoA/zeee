import scaleMigration from '../../migrations/0001_scale.sql?raw';
import pathUniquenessMigration from '../../migrations/0002_path_uniqueness.sql?raw';

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

// Split SQL text into complete statements. Trigger bodies contain semicolons,
// so a plain `split(';')` would break `CREATE TRIGGER ... BEGIN ... END;`.
// This also ignores semicolons inside strings and comments.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  let trigger = false;
  let depth = 0;
  let i = 0;

  const isWordChar = (char: string) => /[A-Za-z0-9_$]/.test(char);
  const flush = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text) statements.push(text);
    start = end + 1;
    trigger = false;
    depth = 0;
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 2;
        else {
          quote = null;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      i++;
      continue;
    }
    if (char === ';') {
      if (!trigger || depth === 0) flush(i);
      i++;
      continue;
    }
    if (isWordChar(char) && (i === 0 || !isWordChar(sql[i - 1]))) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      const word = sql.slice(i, end).toUpperCase();
      if (!trigger && word === 'CREATE' && /^\s+TRIGGER\b/i.test(sql.slice(end))) {
        trigger = true;
      }
      if (trigger) {
        if (word === 'BEGIN' || word === 'CASE') depth++;
        else if (word === 'END') depth = Math.max(0, depth - 1);
      }
      i = end;
      continue;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  // D1 batch is transactional: the marker is committed with the complete migration.
  await db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)));
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
  if (!migrated) await applyMigration(db, scaleMigration);

  const pathsMigrated = await db
    .prepare("SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness'")
    .first();
  if (!pathsMigrated) await applyMigration(db, pathUniquenessMigration);

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
