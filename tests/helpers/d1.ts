import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// Execute the production SQL with SQLite's FTS5, foreign keys, and batch rollback.
export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const queries: Array<{ sql: string; args: SQLInputValue[] }> = [];
  function prepare(sql: string) {
    let args: SQLInputValue[] = [];
    const statement = {
      bind(...values: SQLInputValue[]) {
        args = values;
        return statement;
      },
      async all() {
        queries.push({ sql, args });
        return { results: sqlite.prepare(sql).all(...args), success: true, meta: {} };
      },
      async first() {
        queries.push({ sql, args });
        return sqlite.prepare(sql).get(...args) ?? null;
      },
      async run() {
        queries.push({ sql, args });
        const result = sqlite.prepare(sql).run(...args);
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async exec(sql: string) {
      for (const line of sql.split('\n').filter((line) => line.trim())) sqlite.exec(line);
      return { count: 0, duration: 0 };
    },
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite, queries };
}
