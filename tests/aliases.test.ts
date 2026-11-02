import type { CloudContext } from 'void';
import { describe, expect, it } from 'vite-plus/test';
import { PATCH } from '../routes/api/pages/[id]';
import { addPageAlias, listLinkTargets, updatePageTitle } from '../src/server/db';

type QueryResult = { results?: unknown[]; first?: unknown; changes?: number };
type Statement = { sql: string; args: unknown[] };
type MockDatabase = D1Database & { statements: Statement[] };

function database(handler: (sql: string, args: unknown[]) => QueryResult): MockDatabase {
  const statements: Statement[] = [];

  function prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      sql,
      get args() {
        return args;
      },
      bind(...values: unknown[]) {
        args = values;
        return statement;
      },
      async all<T>() {
        const result = handler(sql, args);
        return {
          results: result.results ?? [],
          success: true,
          meta: {},
        } as unknown as D1Result<T>;
      },
      async first<T>() {
        if (
          sql.includes("FROM meta WHERE key = 'migration:0001_scale'") ||
          sql.includes("FROM meta WHERE key = 'migration:0002_path_uniqueness'")
        )
          return { value: '1' } as T;
        return (handler(sql, args).first ?? null) as T | null;
      },
      async run() {
        statements.push({ sql, args });
        const result = handler(sql, args);
        return { success: true, meta: { changes: result.changes ?? 1 } } as unknown as D1Result;
      },
    };
    return statement;
  }

  const db = {
    statements,
    async exec() {
      return { count: 0, duration: 0 };
    },
    async batch(batch: Statement[]) {
      return batch.map((statement) => {
        statements.push({ sql: statement.sql, args: statement.args });
        const result = handler(statement.sql, statement.args);
        return {
          results: result.results ?? [],
          success: true,
          meta: { changes: result.changes ?? 0 },
        } as unknown as D1Result;
      });
    },
    prepare,
  };
  return db as unknown as MockDatabase;
}

function patchContext(db: D1Database, title: string): CloudContext {
  const url = 'http://127.0.0.1:9876/api/pages/page-1';
  return {
    env: { DB: db, ZEEE_DEV_AUTH: '1' },
    req: {
      url,
      header: (name: string) => {
        if (name === 'origin') return 'http://127.0.0.1:9876';
        if (name === 'cookie') return 'zeee_session=token';
        return undefined;
      },
      param: (name: string) => (name === 'id' ? 'page-1' : undefined),
      json: async () => ({ title }),
    },
    json: (body: unknown, status: number) => Response.json(body, { status }),
  } as unknown as CloudContext;
}

function routeDatabase(title: string, options: { missing?: boolean } = {}): MockDatabase {
  return database((sql) => {
    if (sql.includes('FROM session s JOIN app_user u')) {
      return {
        first: {
          id: 'user-1',
          username: 'tester',
          display_name: 'Tester',
          expires_at: Date.now() + 60_000,
        },
      };
    }
    if (sql.includes('FROM page p')) {
      if (options.missing) return { first: null };
      return {
        first: {
          id: 'page-1',
          title,
          created_by: 'user-1',
          created_at: 1,
          updated_at: 2,
          created_by_name: 'Tester',
          markdown: '',
        },
      };
    }
    return {};
  });
}

describe('addPageAlias', () => {
  it('upserts the alias so the latest rename owns it', async () => {
    const db = database(() => ({}));

    await addPageAlias(db, 'page-1', '  Old Title  ');

    const alias = db.statements.find((statement) =>
      statement.sql.includes('INSERT INTO page_alias'),
    );
    expect(alias?.sql).toContain('ON CONFLICT(alias) DO UPDATE');
    expect(alias?.sql).toContain('SET page_id = excluded.page_id');
    expect(alias?.args).toEqual(['Old Title', 'page-1', expect.any(Number)]);
  });

  it('ignores an empty title', async () => {
    const db = database(() => ({}));

    await addPageAlias(db, 'page-1', '   ');

    expect(db.statements).toHaveLength(0);
  });
});

describe('updatePageTitle', () => {
  it('saves the previous title as an alias in the same batch', async () => {
    const db = database(() => ({}));

    await updatePageTitle(db, 'page-1', 'New Title', 'Old Title');

    expect(db.statements).toHaveLength(4);
    const [alias, update] = db.statements;
    expect(alias.sql).toContain('INSERT INTO page_alias');
    expect(alias.args).toEqual(['Old Title', 'page-1', expect.any(Number)]);
    expect(update.sql).toBe('UPDATE page SET title = ?, updated_at = ? WHERE id = ?');
    expect(update.args).toEqual(['New Title', expect.any(Number), 'page-1']);
  });

  it('does not create an alias when the title is unchanged', async () => {
    const db = database(() => ({}));

    await updatePageTitle(db, 'page-1', 'Same Title', 'Same Title');

    expect(db.statements.some((statement) => statement.sql.includes('page_alias'))).toBe(false);
    expect(db.statements).toHaveLength(3);
  });

  it('keeps the existing behavior when no previous title is passed', async () => {
    const db = database(() => ({}));

    await updatePageTitle(db, 'page-1', 'New Title');

    expect(db.statements.some((statement) => statement.sql.includes('page_alias'))).toBe(false);
    expect(db.statements).toHaveLength(3);
  });
});

describe('listLinkTargets', () => {
  it('returns non-deleted pages within the list limit with their aliases', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        results: [
          { id: 'newer', title: 'Shared', updated_at: 300, alias: 'Latest Alias' },
          { id: 'newer', title: 'Shared', updated_at: 300, alias: 'Earlier Alias' },
          { id: 'older', title: 'Shared', updated_at: 100, alias: null },
          { id: 'single', title: 'Single', updated_at: 200, alias: null },
        ],
      };
    });

    const targets = await listLinkTargets(db);

    expect(sql).toContain('WHERE deleted_at IS NULL');
    expect(sql).not.toContain('LIMIT 200');
    expect(sql).toContain('a.created_at DESC');
    expect(sql).toContain('a.alias NOT IN (SELECT title FROM page WHERE deleted_at IS NULL)');
    expect(targets).toEqual([
      { id: 'newer', title: 'Shared', updatedAt: 300, aliases: ['Latest Alias', 'Earlier Alias'] },
      { id: 'older', title: 'Shared', updatedAt: 100, aliases: [] },
      { id: 'single', title: 'Single', updatedAt: 200, aliases: [] },
    ]);
  });

  it('keeps the newest page first when titles collide so title lookup can win', async () => {
    const db = database(() => ({
      results: [
        { id: 'newest', title: 'Duplicate', updated_at: 900, alias: null },
        { id: 'oldest', title: 'Duplicate', updated_at: 100, alias: null },
      ],
    }));

    const targets = await listLinkTargets(db);

    expect(targets.map((target) => target.id)).toEqual(['newest', 'oldest']);
    expect(targets.find((target) => target.title === 'Duplicate')?.id).toBe('newest');
  });

  it('exposes aliases that no current title shadows', async () => {
    const db = database(() => ({
      results: [
        { id: 'renamed', title: 'New Title', updated_at: 500, alias: 'Old Title' },
        { id: 'current', title: 'Current Title', updated_at: 400, alias: null },
      ],
    }));

    const targets = await listLinkTargets(db);

    expect(targets.find((target) => target.title === 'Current Title')?.aliases).toEqual([]);
    expect(targets.find((target) => target.title === 'New Title')?.aliases).toEqual(['Old Title']);
  });

  it('shadows aliases with current titles outside the 200-page window', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      const shadowsOnlyInWindow = statement.includes('a.alias NOT IN (SELECT title FROM targets)');
      return {
        results: [
          {
            id: 'renamed',
            title: 'New Title',
            updated_at: 500,
            alias: shadowsOnlyInWindow ? 'Old Title' : null,
          },
        ],
      };
    });

    const targets = await listLinkTargets(db);

    expect(sql).toContain('AND a.alias NOT IN (SELECT title FROM page WHERE deleted_at IS NULL)');
    expect(sql).not.toContain('a.alias NOT IN (SELECT title FROM targets)');
    expect(targets).toEqual([{ id: 'renamed', title: 'New Title', updatedAt: 500, aliases: [] }]);
  });
});

describe('PATCH /api/pages/:id', () => {
  it('stores the pre-change title as an alias and keeps the audit event', async () => {
    const db = routeDatabase('Old Title');

    await PATCH(patchContext(db, 'New Title'));

    const alias = db.statements.find((statement) =>
      statement.sql.includes('INSERT INTO page_alias'),
    );
    expect(alias?.args).toEqual(['Old Title', 'page-1', expect.any(Number)]);
    const update = db.statements.find((statement) =>
      statement.sql.startsWith('UPDATE page SET title'),
    );
    expect(update?.args).toEqual(['New Title', expect.any(Number), 'page-1']);
    expect(
      db.statements.find((statement) => statement.sql.includes('INSERT INTO page_last_editor'))
        ?.args,
    ).toEqual(['page-1', 'user-1', expect.any(Number)]);
    const audit = db.statements.find((statement) =>
      statement.sql.includes('INSERT INTO audit_event'),
    );
    expect(audit?.args).toContain('page.rename');
  });

  it('does not create an alias when the title is unchanged', async () => {
    const db = routeDatabase('Same Title');

    await PATCH(patchContext(db, 'Same Title'));

    expect(
      db.statements.some((statement) => statement.sql.includes('INSERT INTO page_alias')),
    ).toBe(false);
  });

  it('still returns 404 for a missing page', async () => {
    const db = routeDatabase('Old Title', { missing: true });

    const response = (await PATCH(patchContext(db, 'New Title'))) as Response;

    expect(response.status).toBe(404);
    expect(
      db.statements.some((statement) => statement.sql.includes('INSERT INTO page_alias')),
    ).toBe(false);
  });
});
