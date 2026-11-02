import { readFileSync } from 'node:fs';
import type { CloudContext } from 'void';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { GET as pagesGET } from '../routes/api/pages';
import { GET as searchGET } from '../routes/api/search';
import { GET as trashGET } from '../routes/api/trash';
import { loader, type Props } from '../pages/index.server';
import {
  createPage,
  createRevision,
  createSession,
  getPage,
  listDeletedPages,
  listLinkTargets,
  listPageNavigation,
  listPages,
  materializePage,
  permanentlyDeletePage,
  searchPages,
  softDeletePage,
  sortPageSummaries,
  undeletePage,
  updatePageTitle,
} from '../src/server/db';
import {
  encodeCursor,
  PaginationError,
  parsePagination,
  readCursor,
} from '../src/server/pagination';
import { ensureSchema } from '../src/server/schema';
import type { PageSummary, PageSort } from '../src/server/types';
import { sqliteD1 } from './helpers/d1';

const stores: ReturnType<typeof sqliteD1>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

async function fixture(count = 0) {
  const store = sqliteD1();
  stores.push(store);
  await ensureSchema(store.db);
  store.sqlite.exec(`INSERT INTO app_user VALUES
    ('creator', 'local', 'creator', 'creator', '作成者', 0, 0),
    ('editor', 'local', 'editor', 'editor', '更新者', 0, 0)`);
  const insert = store.sqlite.prepare(
    'INSERT INTO page (id,title,created_by,created_at,updated_at) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < count; i++) {
    const id = `page-${String(i).padStart(4, '0')}`;
    const title = i % 13 === 0 ? `同じ題名 ${i}` : `Page ${i}`;
    insert.run(id, title, 'creator', Math.floor(i / 9), Math.floor(i / 7));
    store.sqlite.prepare('INSERT INTO page_body VALUES (?,?,?)').run(id, 'needle 本文', 0);
    store.sqlite.prepare('INSERT INTO page_fts VALUES (?,?,?)').run(id, title, 'needle 本文');
  }
  store.queries.length = 0;
  return store;
}

async function allPages(db: D1Database, sort: PageSort, limit = 17) {
  const items: PageSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const slice = await listPages(db, { sort, limit, cursor });
    expect(slice.items.length).toBeLessThanOrEqual(limit);
    items.push(...slice.items);
    cursor = slice.nextCursor;
    if (!cursor) return items;
  }
  throw new Error('pagination did not terminate');
}

describe('keyset page lists', () => {
  for (const sort of ['updated', 'created', 'title'] as const) {
    it(`traverses more than 200 pages in ${sort} order with timestamp/title ties`, async () => {
      const { db, sqlite, queries } = await fixture(267);
      const expected = sqlite
        .prepare('SELECT id,title,created_at,updated_at FROM page')
        .all()
        .map((row) => ({
          id: String(row.id),
          title: String(row.title),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          createdByName: '',
          updatedBy: null,
          updatedByName: '',
          excerpt: '',
        }));
      const pages = await allPages(db, sort);
      expect(pages.map((p) => p.id)).toEqual(sortPageSummaries(expected, sort).map((p) => p.id));
      expect(new Set(pages.map((p) => p.id)).size).toBe(267);
      expect(queries.every(({ sql }) => !/\bOFFSET\b/i.test(sql))).toBe(true);
      if (sort !== 'title') expect(queries.every(({ sql }) => sql.includes('LIMIT ?'))).toBe(true);
    });
  }

  it('preserves Japanese, case-insensitive, and natural numeric title order', async () => {
    const { db, sqlite } = await fixture(8);
    const titles = ['ページ10', 'ページ2', 'ぺーじ２', 'Alpha', 'alpha', 'あ', 'ア', '漢字'];
    titles.forEach((title, i) =>
      sqlite
        .prepare('UPDATE page SET title = ? WHERE id = ?')
        .run(title, `page-${String(i).padStart(4, '0')}`),
    );
    const expected = await allPages(db, 'updated');
    expect((await allPages(db, 'title', 1)).map((p) => p.id)).toEqual(
      sortPageSummaries(expected, 'title').map((p) => p.id),
    );
  });

  it('continues after a deleted boundary and ignores newly inserted rows before it', async () => {
    const { db, sqlite } = await fixture(12);
    const first = await listPages(db, { limit: 4 });
    await softDeletePage(db, first.items[3].id);
    sqlite
      .prepare('INSERT INTO page VALUES (?,?,?,?,?,NULL)')
      .run('new', 'New', 'creator', 1000, 1000);
    const second = await listPages(db, { limit: 20, cursor: first.nextCursor });
    expect(second.items).toHaveLength(8);
    expect(second.items.some((p) => p.id === 'new' || first.items.some((q) => q.id === p.id))).toBe(
      false,
    );
  });

  it('handles empty and exactly-full final pages without an extra cursor', async () => {
    const { db } = await fixture(2);
    expect((await listPages(db, { limit: 2 })).nextCursor).toBeNull();
    for (const p of (await listPages(db)).items) await softDeletePage(db, p.id);
    expect((await listPages(db)).items).toEqual([]);
    expect((await listDeletedPages(db, { limit: 1 })).nextCursor).not.toBeNull();
  });

  it('keeps the sidebar and all link candidates beyond the first page', async () => {
    const { db } = await fixture(267);
    expect(await listPageNavigation(db)).toHaveLength(267);
    expect(await listLinkTargets(db)).toHaveLength(267);
    expect((await listPages(db)).items).toHaveLength(50);
  });

  it('uses a range seek on the composite time indexes for continuation', async () => {
    const { db, sqlite, queries } = await fixture(267);
    for (const sort of ['updated', 'created'] as const) {
      const first = await listPages(db, { sort });
      await listPages(db, { sort, cursor: first.nextCursor });
      const { sql, args } = queries.at(-1)!;
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
      expect(plan.map((row) => row.detail).join('\n')).toContain(
        `SEARCH p USING INDEX page_active_${sort}_idx`,
      );
    }
  });
});

describe('keyset search', () => {
  for (const query of ['needle', '本文']) {
    it(`traverses every ${query === 'needle' ? 'FTS' : 'LIKE'} match with rank/time ties`, async () => {
      const { db, sqlite } = await fixture(67);
      await softDeletePage(db, 'page-0003');
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const slice = await searchPages(db, query, { limit: 9, cursor });
        ids.push(...slice.items.map((p) => p.id));
        cursor = slice.nextCursor;
        if (cursor)
          expect(readCursor(cursor, ['fts', 'like'], query)?.kind).toBe(
            query === 'needle' ? 'fts' : 'like',
          );
        expect(ids.length).toBeLessThanOrEqual(66);
      } while (cursor);
      const expected =
        query === 'needle'
          ? sqlite
              .prepare(
                "SELECT f.page_id AS id FROM page_fts f JOIN page p ON p.id=f.page_id WHERE page_fts MATCH 'needle' AND p.deleted_at IS NULL ORDER BY rank, p.id",
              )
              .all()
          : sqlite
              .prepare('SELECT id FROM page WHERE deleted_at IS NULL ORDER BY updated_at DESC, id')
              .all();
      expect(ids).toEqual(expected.map((p) => p.id));
    });
  }
  it('pins LIKE fallback and never silently switches a continuation from FTS', async () => {
    const { db, sqlite } = await fixture(4);
    const fts = await searchPages(db, 'needle', { limit: 1 });
    sqlite.exec('DROP TABLE page_fts');
    const like = await searchPages(db, 'needle', { limit: 1 });
    expect(readCursor(like.nextCursor, ['like'], 'needle')?.kind).toBe('like');
    expect((await searchPages(db, 'needle', { cursor: like.nextCursor })).items).toHaveLength(3);
    await expect(searchPages(db, 'needle', { cursor: fts.nextCursor })).rejects.toThrow();
  });
  it('returns no results for blank queries and safely quotes FTS syntax', async () => {
    const { db } = await fixture(3);
    expect((await searchPages(db, '  ')).items).toEqual([]);
    expect((await searchPages(db, '" OR needle')).items).toEqual([]);
  });
});

describe('cursor validation and HTTP/loader contract', () => {
  it('rejects malformed, cross-sort, cross-query and non-finite cursors', async () => {
    const { db } = await fixture(3);
    const list = await listPages(db, { limit: 1 });
    await expect(
      listPages(db, { sort: 'created', cursor: list.nextCursor }),
    ).rejects.toBeInstanceOf(PaginationError);
    const search = await searchPages(db, 'needle', { limit: 1 });
    await expect(searchPages(db, 'other', { cursor: search.nextCursor })).rejects.toBeInstanceOf(
      PaginationError,
    );
    for (const cursor of [
      '',
      'abc',
      'x'.repeat(9000),
      encodeCursor({ v: 1, kind: 'updated', query: '', keys: [NaN, 0, 'id'] }),
    ]) {
      await expect(listPages(db, { cursor })).rejects.toBeInstanceOf(PaginationError);
    }
    for (const raw of ['0', '-1', '101', '1.5', 'NaN', 'Infinity', '']) {
      expect(() => parsePagination(new URLSearchParams({ limit: raw }))).toThrow(PaginationError);
    }
  });

  it('returns bounded envelopes, preserves sidebar/recent pages, and resets on sort/search', async () => {
    const { db } = await fixture(267);
    const token = await createSession(db, 'creator');
    const ctx = (path: string) => context(db, path, token);
    const first = await pagesGET(ctx('/api/pages?limit=3&sort=created'));
    expect(first).toMatchObject({
      limit: 3,
      sort: 'created',
      pages: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const search = await searchGET(ctx('/api/search?q=needle&limit=2'));
    expect(search).toMatchObject({
      query: 'needle',
      limit: 2,
      results: expect.any(Array),
      nextCursor: expect.any(String),
    });
    expect(await trashGET(ctx('/api/trash'))).toEqual({ pages: [], nextCursor: null, limit: 50 });
    const home = (await loader(ctx('/?limit=2&sort=title'))) as Props | Response;
    expect(home).toMatchObject({
      pages: expect.any(Array),
      sidebarPages: expect.any(Array),
      limit: 2,
      nextCursor: expect.any(String),
    });
    if (home instanceof Response) throw new Error('unexpected response');
    expect(home.pages).toHaveLength(2);
    expect(home.sidebarPages).toHaveLength(267);
    expect(home.recentPages.map((p) => p.id)).toEqual(['page-0000']);
    const next = await loader(ctx(`/?limit=2&sort=title&cursor=${home.nextCursor}`));
    expect(next).toMatchObject({ sort: 'title', cursor: home.nextCursor });
    expect(await loader(ctx('/?sort=updated'))).toMatchObject({ cursor: null, sort: 'updated' });
    for (const handler of [pagesGET, searchGET, trashGET, loader]) {
      const invalid = (await handler(ctx('/?limit=0'))) as Response;
      expect(invalid.status).toBe(400);
    }
    expect(((await pagesGET(context(db, '/api/pages'))) as Response).status).toBe(401);
  });
});

function context(db: D1Database, path: string, token?: string): CloudContext {
  return {
    env: { DB: db, ZEEE_DEV_AUTH: '1' },
    req: {
      url: `http://localhost${path}`,
      header: (name: string) =>
        name === 'cookie' && token
          ? `zeee_session=${token}; zeee_recent_pages_creator=page-0000`
          : undefined,
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as CloudContext;
}

describe('last editor and additive migration', () => {
  it('tracks creation, body saves and renames, preserving the creator separately', async () => {
    const { db } = await fixture();
    const page = await createPage(db, 'New', 'creator');
    expect(page.updatedByName).toBe('作成者');
    await materializePage(db, page.id, 'needle', 'editor');
    expect(await getPage(db, page.id)).toMatchObject({
      createdByName: '作成者',
      updatedBy: 'editor',
      updatedByName: '更新者',
    });
    expect((await searchPages(db, 'needle')).items[0].updatedByName).toBe('更新者');
    await updatePageTitle(db, page.id, 'Renamed', 'New', 'creator');
    expect((await listPages(db)).items[0].updatedByName).toBe('作成者');
    await materializePage(db, page.id, 'needle', 'editor');
    expect((await getPage(db, page.id))?.updatedBy).toBe('creator');
    await createRevision(db, page.id, 'needle', 'editor', true);
    expect((await getPage(db, page.id))?.updatedBy).toBe('creator'); // saving a snapshot is not editing
    await softDeletePage(db, page.id);
    expect((await listDeletedPages(db)).items[0].updatedBy).toBe('creator');
    await undeletePage(db, page.id);
    expect((await getPage(db, page.id))?.updatedBy).toBe('creator');
    await materializePage(db, page.id, 'unknown author');
    expect((await getPage(db, page.id))?.updatedBy).toBeNull();
    await softDeletePage(db, page.id);
    await permanentlyDeletePage(db, page.id);
  });

  it('backfills existing revisions/renames, preserves data and live editors on replay', async () => {
    const { db, sqlite } = await fixture(4);
    sqlite.exec(
      "DELETE FROM meta WHERE key = 'migration:0001_scale'; DROP TABLE page_last_editor;",
    );
    sqlite.exec(`INSERT INTO revision VALUES ('r1','page-0000',1,'old','editor',0,100);
      INSERT INTO revision VALUES ('r2','page-0001',1,'unknown',NULL,0,100);
      INSERT INTO revision VALUES ('zzz','page-0002',1,'earlier','creator',0,100);
      INSERT INTO revision VALUES ('aaa','page-0002',2,'later','editor',0,100);
      INSERT INTO audit_event VALUES ('a1','creator','page.rename','page','page-0000',200)`);
    const sql = readFileSync(new URL('../migrations/0001_scale.sql', import.meta.url), 'utf8');
    sqlite.exec(sql);
    expect(
      sqlite
        .prepare('SELECT author_id FROM page_last_editor ORDER BY page_id')
        .all()
        .map((p) => p.author_id),
    ).toEqual(['creator', null, 'editor', 'creator']);
    await materializePage(db, 'page-0000', 'latest', 'editor');
    sqlite.exec(sql);
    expect((await getPage(db, 'page-0000'))?.updatedBy).toBe('editor');
    expect(sqlite.prepare('SELECT count(*) AS n FROM app_user').get()?.n).toBe(2);
    expect(sqlite.prepare('SELECT count(*) AS n FROM revision').get()?.n).toBe(4);
    expect(sqlite.prepare('SELECT count(*) AS n FROM page_body').get()?.n).toBe(4);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back a failed migration and retries initialization without poisoning the cache', async () => {
    const store = sqliteD1();
    stores.push(store);
    let fail = true;
    const db = {
      exec: store.db.exec.bind(store.db),
      prepare: store.db.prepare.bind(store.db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (fail) {
          fail = false;
          return store.db.batch([
            ...statements.slice(0, 2),
            store.db.prepare('INSERT INTO missing_table VALUES (1)'),
            ...statements.slice(2),
          ]);
        }
        return store.db.batch(statements);
      },
    } as D1Database;
    await expect(ensureSchema(db)).rejects.toThrow();
    expect(
      store.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'page_last_editor'").get(),
    ).toBeUndefined();
    expect(
      store.sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0001_scale'").get(),
    ).toBeUndefined();
    await ensureSchema(db);
    expect(
      store.sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0001_scale'").get()
        ?.value,
    ).toBe('1');
  });
  it('initializes independent databases in one isolate', async () => {
    const a = await fixture(1);
    const b = await fixture(2);
    expect((await listPages(a.db)).items).toHaveLength(1);
    expect((await listPages(b.db)).items).toHaveLength(2);
  });
});
