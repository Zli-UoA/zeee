import type { CloudContext } from 'void';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { POST as pagesPOST } from '../routes/api/pages';
import { DELETE as pageDELETE, GET as pageGET, PATCH as pagePATCH } from '../routes/api/pages/[id]';
import { POST as undeletePOST } from '../routes/api/pages/[id]/undelete';
import { GET as treeGET } from '../routes/api/pages/tree';
import {
  countLiveChildren,
  createPage,
  createSession,
  getPage,
  getPageAncestors,
  listPageNavigation,
  listPages,
  permanentlyDeletePage,
  restorePage,
  softDeletePage,
} from '../src/server/db';
import { ensureSchema } from '../src/server/schema';
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
    ('creator', 'local', 'creator', 'creator', '作成者', 0, 0),
    ('editor', 'local', 'editor', 'editor', '更新者', 0, 0)`);
  return store;
}

function context(
  db: D1Database,
  path: string,
  token: string | null,
  body?: unknown,
  params: Record<string, string> = {},
): CloudContext {
  return {
    env: { DB: db, ZEEE_DEV_AUTH: '1' },
    req: {
      url: `http://localhost${path}`,
      header: (name: string) => (name === 'cookie' && token ? `zeee_session=${token}` : undefined),
      param: (name: string) => params[name],
      json: async () => body,
    },
    json: (value: unknown, status = 200) => Response.json(value, { status }),
  } as unknown as CloudContext;
}

async function apiToken(db: D1Database) {
  return createSession(db, 'creator');
}

function responseBody(response: unknown): Promise<Record<string, unknown>> {
  return (response as Response).json() as Promise<Record<string, unknown>>;
}

describe('directory migration', () => {
  it('adds parent_id after 0001 and marks 0002 without rewriting pages', async () => {
    const { db, sqlite } = await fixture();
    const columns = sqlite.prepare('PRAGMA table_info(page)').all();
    expect(columns.filter((column) => column.name === 'parent_id')).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0001_scale'").get()?.value,
    ).toBe('1');
    expect(
      sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_directory'").get()?.value,
    ).toBe('1');
    sqlite
      .prepare('INSERT INTO page (id,title,created_by,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('legacy', 'Legacy', 'creator', 0, 0);
    expect(sqlite.prepare("SELECT parent_id FROM page WHERE id = 'legacy'").get()?.parent_id).toBe(
      null,
    );
    expect((await listPages(db)).items[0]).toMatchObject({ parentId: null });
  });

  it('re-runs 0002 as a no-op when the marker is missing but the column exists', async () => {
    const store = await fixture();
    store.sqlite.exec("DELETE FROM meta WHERE key = 'migration:0002_directory'");
    const proxy = {
      exec: store.db.exec.bind(store.db),
      prepare: store.db.prepare.bind(store.db),
      batch: store.db.batch.bind(store.db),
    } as D1Database;
    await ensureSchema(proxy);
    expect(
      store.sqlite
        .prepare('PRAGMA table_info(page)')
        .all()
        .filter((column) => column.name === 'parent_id'),
    ).toHaveLength(1);
    expect(
      store.sqlite.prepare("SELECT value FROM meta WHERE key = 'migration:0002_directory'").get()
        ?.value,
    ).toBe('1');
  });

  it('keeps 267-page navigation and the cursor list independent', async () => {
    const { db, sqlite } = await fixture();
    const insert = sqlite.prepare(
      'INSERT INTO page (id,title,created_by,created_at,updated_at) VALUES (?,?,?,?,?)',
    );
    for (let i = 0; i < 267; i++) {
      insert.run(`page-${String(i).padStart(4, '0')}`, `Page ${i}`, 'creator', i, i);
    }
    const navigation = await listPageNavigation(db);
    expect(navigation).toHaveLength(267);
    expect(navigation.every((page) => page.parentId === null)).toBe(true);
    const first = await listPages(db, { limit: 50 });
    expect(first.items).toHaveLength(50);
    expect(first.items.every((page) => page.parentId === null)).toBe(true);
    expect(first.nextCursor).not.toBeNull();
  });
});

describe('directory reads and moves', () => {
  it('returns parentId in summaries, records, and navigation', async () => {
    const { db } = await fixture();
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    expect(child.parentId).toBe(root.id);
    expect((await getPage(db, child.id))?.parentId).toBe(root.id);
    expect((await listPages(db)).items.find((page) => page.id === child.id)?.parentId).toBe(
      root.id,
    );
    expect((await listPageNavigation(db)).find((page) => page.id === child.id)?.parentId).toBe(
      root.id,
    );
  });

  it('returns ancestors from root to parent and exposes them from GET /api/pages/:id', async () => {
    const { db } = await fixture();
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    const leaf = await createPage(db, 'Leaf', 'creator', child.id);
    expect(await getPageAncestors(db, leaf.id)).toEqual([
      { id: root.id, title: 'Root' },
      { id: child.id, title: 'Child' },
    ]);

    const token = await apiToken(db);
    const response = await pageGET(
      context(db, `/api/pages/${leaf.id}`, token, undefined, { id: leaf.id }),
    );
    expect(response).toMatchObject({
      page: { id: leaf.id, parentId: child.id },
      ancestors: [
        { id: root.id, title: 'Root' },
        { id: child.id, title: 'Child' },
      ],
    });
  });

  it('creates children and moves with title in one PATCH while rejecting cycles', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    const leaf = await createPage(db, 'Leaf', 'creator', child.id);

    const created = await pagesPOST(
      context(db, '/api/pages', token, { title: 'Sibling', parentId: root.id }),
    );
    expect(await responseBody(created)).toMatchObject({
      page: { title: 'Sibling', parentId: root.id },
    });

    const self = await pagePATCH(
      context(db, `/api/pages/${root.id}`, token, { parentId: root.id }, { id: root.id }),
    );
    expect((self as Response).status).toBe(409);
    const cycle = await pagePATCH(
      context(db, `/api/pages/${root.id}`, token, { parentId: leaf.id }, { id: root.id }),
    );
    expect((cycle as Response).status).toBe(409);
    expect((await getPage(db, root.id))?.parentId).toBeNull();

    const moved = await pagePATCH(
      context(
        db,
        `/api/pages/${leaf.id}`,
        token,
        { title: 'Renamed Leaf', parentId: root.id },
        { id: leaf.id },
      ),
    );
    expect(moved).toEqual({ ok: true });
    expect(await getPage(db, leaf.id)).toMatchObject({
      title: 'Renamed Leaf',
      parentId: root.id,
    });
    expect(await getPageAncestors(db, leaf.id)).toEqual([{ id: root.id, title: 'Root' }]);
  });

  it('rejects invalid and deleted parents', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    await softDeletePage(db, child.id);

    const missing = await pagesPOST(
      context(db, '/api/pages', token, { title: 'Missing parent', parentId: 'missing' }),
    );
    expect((missing as Response).status).toBe(404);
    const deleted = await pagePATCH(
      context(db, `/api/pages/${root.id}`, token, { parentId: child.id }, { id: root.id }),
    );
    expect((deleted as Response).status).toBe(404);
  });

  it('serves the tree endpoint without cursor or limit', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    const response = await treeGET(context(db, '/api/pages/tree?limit=1', token));
    const body = response as { pages: Array<{ id: string; parentId: string | null }> };
    expect(body.pages).toHaveLength(2);
    expect(body.pages.find((page) => page.id === child.id)?.parentId).toBe(root.id);
  });
});

describe('directory deletion and restore', () => {
  it('rejects soft-deleting a page with live children, then allows it after the child is deleted', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    expect(await countLiveChildren(db, root.id)).toBe(1);

    const blocked = await pageDELETE(
      context(db, `/api/pages/${root.id}`, token, undefined, { id: root.id }),
    );
    expect((blocked as Response).status).toBe(409);
    expect(await responseBody(blocked)).toEqual({ error: 'has_children', childCount: 1 });
    expect(await getPage(db, root.id)).not.toBeNull();

    expect((await softDeletePage(db, child.id)).deleted).toBe(true);
    const deleted = await pageDELETE(
      context(db, `/api/pages/${root.id}`, token, undefined, { id: root.id }),
    );
    expect(deleted).toEqual({ ok: true });
    expect(await getPage(db, root.id)).toBeNull();
  });

  it('restores a child to the root when its parent is still deleted', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    await softDeletePage(db, child.id);
    await softDeletePage(db, root.id);

    const restored = await undeletePOST(
      context(db, `/api/pages/${child.id}/undelete`, token, undefined, { id: child.id }),
    );
    expect(restored).toEqual({ ok: true, reparentedToRoot: true });
    expect((await getPage(db, child.id))?.parentId).toBeNull();

    const parentRestored = await restorePage(db, root.id);
    expect(parentRestored).toEqual({ restored: true, reparentedToRoot: false });
    expect((await getPage(db, root.id))?.parentId).toBeNull();
  });

  it('keeps a live parent on restore', async () => {
    const { db } = await fixture();
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    await softDeletePage(db, child.id);
    expect(await restorePage(db, child.id)).toEqual({
      restored: true,
      reparentedToRoot: false,
    });
    expect((await getPage(db, child.id))?.parentId).toBe(root.id);
  });

  it('sets deleted children to the root when the parent is permanently deleted', async () => {
    const { db, sqlite } = await fixture();
    const root = await createPage(db, 'Root', 'creator');
    const child = await createPage(db, 'Child', 'creator', root.id);
    await softDeletePage(db, child.id);
    await softDeletePage(db, root.id);
    expect(await permanentlyDeletePage(db, root.id)).toBe(true);
    expect(
      sqlite.prepare('SELECT parent_id FROM page WHERE id = ?').get(child.id)?.parent_id,
    ).toBeNull();
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('directory depth guard', () => {
  it('rejects a move that would exceed the depth limit', async () => {
    const { db } = await fixture();
    const token = await apiToken(db);
    const pages = [await createPage(db, 'root', 'creator')];
    for (let depth = 1; depth <= 32; depth++) {
      pages.push(await createPage(db, `page-${depth}`, 'creator', pages.at(-1)!.id));
    }
    const loose = await createPage(db, 'loose', 'creator');
    const response = await pagePATCH(
      context(
        db,
        `/api/pages/${loose.id}`,
        token,
        { parentId: pages.at(-1)!.id },
        { id: loose.id },
      ),
    );
    expect((response as Response).status).toBe(400);
  });
});
