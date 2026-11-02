import { readFileSync } from 'node:fs';
import type { CloudContext } from 'void';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { POST as createPagePOST } from '../routes/api/pages';
import { PATCH as pagePATCH } from '../routes/api/pages/[id]';
import { POST as undeletePOST } from '../routes/api/pages/[id]/undelete';
import {
  createPage,
  createSession,
  getPage,
  PathConflictError,
  softDeletePage,
  undeletePage,
  updatePageTitle,
} from '../src/server/db';
import { ensureSchema, splitSqlStatements } from '../src/server/schema';
import { sqliteD1 } from './helpers/d1';

const stores: ReturnType<typeof sqliteD1>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

async function fixture() {
  const store = sqliteD1();
  stores.push(store);
  await ensureSchema(store.db);
  store.sqlite.exec(`INSERT INTO app_user VALUES
    ('creator', 'local', 'creator', 'creator', '作成者', 0, 0)`);
  return store;
}

function insertPage(
  sqlite: ReturnType<typeof sqliteD1>['sqlite'],
  id: string,
  title: string,
): void {
  sqlite
    .prepare('INSERT INTO page (id,title,created_by,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(id, title, 'creator', 1, 1);
}

function applyMigration(db: D1Database): Promise<D1Result[]> {
  const sql = readFileSync(
    new URL('../migrations/0002_path_uniqueness.sql', import.meta.url),
    'utf8',
  );
  return db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)));
}

function requestContext(
  db: D1Database,
  path: string,
  token: string | null,
  body: unknown,
  pageId?: string,
): CloudContext {
  return {
    env: { DB: db, ZEEE_DEV_AUTH: '1' },
    req: {
      url: `http://localhost${path}`,
      header: (name: string) => {
        if (name === 'origin') return 'http://localhost';
        if (name === 'cookie' && token) return `zeee_session=${token}`;
        return undefined;
      },
      param: (name: string) => (name === 'id' ? pageId : undefined),
      json: async () => body,
    },
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
    text: (payload: string, status = 200) => new Response(payload, { status }),
  } as unknown as CloudContext;
}

describe('active page path uniqueness', () => {
  it('rejects exact duplicates and prefix collisions in both directions', async () => {
    const { db, sqlite } = await fixture();
    await createPage(db, 'a/b', 'creator');

    await expect(createPage(db, 'a/b', 'creator')).rejects.toBeInstanceOf(PathConflictError);
    expect(() => insertPage(sqlite, 'direct', 'a/b')).toThrow(/PATH_CONFLICT/);

    await expect(createPage(db, 'a', 'creator')).rejects.toBeInstanceOf(PathConflictError);
    await expect(createPage(db, 'a/b/c', 'creator')).rejects.toBeInstanceOf(PathConflictError);
    await expect(createPage(db, 'a/c', 'creator')).resolves.toMatchObject({ title: 'a/c' });

    await createPage(db, 'x/y', 'creator');
    await expect(createPage(db, 'x', 'creator')).rejects.toBeInstanceOf(PathConflictError);
  });

  it('ignores deleted pages and re-checks the path on restore', async () => {
    const { db } = await fixture();
    const first = await createPage(db, 'a', 'creator');
    await softDeletePage(db, first.id);

    const second = await createPage(db, 'a', 'creator');
    await softDeletePage(db, second.id);
    const child = await createPage(db, 'a/b', 'creator');

    await expect(undeletePage(db, second.id)).rejects.toBeInstanceOf(PathConflictError);
    await expect(undeletePage(db, first.id)).rejects.toBeInstanceOf(PathConflictError);
    expect(await getPage(db, first.id)).toBeNull();

    await softDeletePage(db, child.id);
    await expect(undeletePage(db, first.id)).resolves.toBe(true);
    expect(await getPage(db, first.id)).toMatchObject({ title: 'a' });
  });

  it('allows sibling paths and rolls a rejected rename back completely', async () => {
    const { db, sqlite } = await fixture();
    const leaf = await createPage(db, 'a/x', 'creator');
    const other = await createPage(db, 'b', 'creator');

    await updatePageTitle(db, leaf.id, 'a/y', 'a/x', 'creator');
    expect((await getPage(db, leaf.id))?.title).toBe('a/y');

    await expect(updatePageTitle(db, other.id, 'a', 'b', 'creator')).rejects.toBeInstanceOf(
      PathConflictError,
    );
    await expect(updatePageTitle(db, other.id, 'a/y/z', 'b', 'creator')).rejects.toBeInstanceOf(
      PathConflictError,
    );
    expect((await getPage(db, other.id))?.title).toBe('b');
    expect(sqlite.prepare("SELECT count(*) AS n FROM page_alias WHERE alias = 'b'").get()?.n).toBe(
      0,
    );

    await updatePageTitle(db, other.id, 'a/z', 'b', 'creator');
    expect((await getPage(db, other.id))?.title).toBe('a/z');
  });
});

describe('path conflict API contract', () => {
  it('returns 409 PATH_CONFLICT for create, rename, and restore', async () => {
    const { db } = await fixture();
    const token = await createSession(db, 'creator');

    const created = (await createPagePOST(
      requestContext(db, '/api/pages', token, { title: 'a' }),
    )) as Response;
    expect(created.status).toBe(201);

    const duplicate = (await createPagePOST(
      requestContext(db, '/api/pages', token, { title: 'a' }),
    )) as Response;
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'PATH_CONFLICT' });

    const other = await createPage(db, 'b', 'creator');
    const rename = (await pagePATCH(
      requestContext(db, `/api/pages/${other.id}`, token, { title: 'a' }, other.id),
    )) as Response;
    expect(rename.status).toBe(409);
    expect(await rename.json()).toEqual({ error: 'PATH_CONFLICT' });

    const deleted = await createPage(db, 'c', 'creator');
    await softDeletePage(db, deleted.id);
    await createPage(db, 'c/d', 'creator');
    const restore = (await undeletePOST(
      requestContext(db, `/api/pages/${deleted.id}/undelete`, token, null, deleted.id),
    )) as Response;
    expect(restore.status).toBe(409);
    expect(await restore.json()).toEqual({ error: 'PATH_CONFLICT' });
  });

  it('keeps the existing 401 and 404 responses', async () => {
    const { db } = await fixture();
    const token = await createSession(db, 'creator');

    const unauthenticated = (await createPagePOST(
      requestContext(db, '/api/pages', null, { title: 'a' }),
    )) as Response;
    expect(unauthenticated.status).toBe(401);

    const missing = (await pagePATCH(
      requestContext(db, '/api/pages/missing', token, { title: 'a' }, 'missing'),
    )) as Response;
    expect(missing.status).toBe(404);
  });
});

describe('0002_path_uniqueness migration', () => {
  it('re-runs the migration file without changing data or dropping guarantees', async () => {
    const { db, sqlite } = await fixture();
    await createPage(db, 'a', 'creator');

    await applyMigration(db);
    await applyMigration(db);

    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness'").get()
        ?.value,
    ).toBe('1');
    await expect(createPage(db, 'a', 'creator')).rejects.toBeInstanceOf(PathConflictError);
  });

  it('fails safely when existing active paths conflict and succeeds after a fix', async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec(`DROP TRIGGER IF EXISTS page_path_insert_guard;
      DROP TRIGGER IF EXISTS page_path_title_update_guard;
      DROP TRIGGER IF EXISTS page_path_undelete_guard;
      DROP INDEX IF EXISTS page_active_path_unique_idx;`);
    sqlite.prepare("DELETE FROM meta WHERE key = 'migration:0002_path_uniqueness'").run();
    insertPage(sqlite, 'dup-1', 'same');
    insertPage(sqlite, 'dup-2', 'same');

    await expect(applyMigration(db)).rejects.toThrow(
      /PATH_CONFLICT: existing active page paths conflict/,
    );
    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness'").get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'page_path_migration_guard'")
        .get(),
    ).toBeUndefined();

    sqlite.prepare("UPDATE page SET title = 'other' WHERE id = 'dup-2'").run();
    await expect(applyMigration(db)).resolves.toBeDefined();
    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness'").get()
        ?.value,
    ).toBe('1');
    await expect(createPage(db, 'same', 'creator')).rejects.toBeInstanceOf(PathConflictError);
  });

  it('applies through the schema runner after 0001 and retries a fresh binding', async () => {
    const { db, sqlite } = await fixture();
    sqlite.prepare("DELETE FROM meta WHERE key = 'migration:0002_path_uniqueness'").run();
    const rerun = {
      exec: db.exec.bind(db),
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
    } as D1Database;
    await ensureSchema(rerun);
    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_path_uniqueness'").get()
        ?.value,
    ).toBe('1');
    await expect(createPage(rerun, 'a', 'creator')).resolves.toMatchObject({ title: 'a' });
  });
});
