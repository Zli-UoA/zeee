import type { CloudContext } from 'void';
import { describe, expect, it } from 'vite-plus/test';
import {
  excerptFromMarkdown,
  getPage,
  listDeletedPages,
  listPages,
  permanentlyDeletePage,
  searchPages,
  sortPageSummaries,
  undeletePage,
} from '../src/server/db';
import { sameOrigin } from '../src/server/http';
import type { PageSummary } from '../src/server/types';

type QueryResult = { results?: unknown[]; first?: unknown };
type Statement = { sql: string; args: unknown[] };

function database(handler: (sql: string, args: unknown[]) => QueryResult): D1Database {
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
        return (handler(sql, args).first ?? null) as T | null;
      },
      async run() {
        return { success: true, meta: {} } as unknown as D1Result;
      },
    };
    return statement;
  }

  return {
    async exec() {
      return { count: 0, duration: 0 };
    },
    async batch(statements: Statement[]) {
      return statements.map((statement) => {
        const result = handler(statement.sql, statement.args);
        return {
          results: result.results ?? [],
          success: true,
          meta: {},
        } as unknown as D1Result;
      });
    },
    prepare,
  } as unknown as D1Database;
}

function pageSummary(id: string, title: string, createdAt: number, updatedAt: number): PageSummary {
  return {
    id,
    title,
    createdAt,
    createdByName: '',
    excerpt: '',
    updatedAt,
  };
}

function context(
  url: string,
  origin: string | undefined,
  env: Record<string, string | undefined> = {},
): CloudContext {
  return {
    env,
    req: {
      url,
      header: (name: string) => (name === 'origin' ? origin : undefined),
    },
  } as unknown as CloudContext;
}

describe('sameOrigin', () => {
  it('allows requests without an origin', () => {
    expect(sameOrigin(context('http://127.0.0.1:9876/', undefined))).toBe(true);
  });

  it('allows the actual request origin when dev mode points elsewhere', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://192.168.0.170:9876', {
          ZEEE_DEV_AUTH: '1',
          PUBLIC_ORIGIN: 'http://127.0.0.1:9876',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a different origin in dev mode', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://127.0.0.1:9876', {
          ZEEE_DEV_AUTH: '1',
          PUBLIC_ORIGIN: 'http://127.0.0.1:9876',
        }),
      ),
    ).toBe(false);
  });

  it('allows the public origin behind a proxy in production', () => {
    expect(
      sameOrigin(
        context('http://celld:8080/pages/1', 'https://zeee.zli.works', {
          PUBLIC_ORIGIN: 'https://zeee.zli.works',
        }),
      ),
    ).toBe(true);
  });

  it('does not trust the request origin in production', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://192.168.0.170:9876', {
          PUBLIC_ORIGIN: 'https://zeee.zli.works',
        }),
      ),
    ).toBe(false);
  });
});

describe('listPages', () => {
  it('returns creation metadata, author names, and plain-text excerpts', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        results: [
          {
            id: 'newer',
            title: 'Newer',
            created_at: 100,
            updated_at: 300,
            created_by_name: '山田 太郎',
            excerpt_source: '# 見出し\n\n**本文**と[リンク](https://example.com)です。',
          },
          {
            id: 'older',
            title: 'Older',
            created_at: 200,
            updated_at: 200,
            created_by_name: null,
            excerpt_source: '`code` のみ',
          },
        ],
      };
    });

    const pages = await listPages(db);

    expect(sql).toContain('LEFT JOIN app_user');
    expect(sql).toContain('ORDER BY p.updated_at DESC');
    expect(sql).toContain('LIMIT 200');
    expect(pages.map((page) => page.id)).toEqual(['newer', 'older']);
    expect(pages[0]).toMatchObject({
      createdAt: 100,
      createdByName: '山田 太郎',
      excerpt: '見出し 本文とリンクです。',
      updatedAt: 300,
    });
    expect(pages[1].createdByName).toBe('');
    expect(pages[1].excerpt).toBe('code のみ');
  });
});

describe('getPage', () => {
  it('returns the same summary fields as listPages together with the markdown', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        first: {
          id: 'page-1',
          title: 'Page',
          created_by: 'user-1',
          created_by_name: '山田 太郎',
          created_at: 100,
          updated_at: 200,
          markdown: '# 見出し\n\n本文です。',
        },
      };
    });

    const page = await getPage(db, 'page-1');

    expect(sql).toContain('LEFT JOIN app_user');
    expect(page).toMatchObject({
      id: 'page-1',
      title: 'Page',
      createdBy: 'user-1',
      createdByName: '山田 太郎',
      createdAt: 100,
      excerpt: '見出し 本文です。',
      updatedAt: 200,
      markdown: '# 見出し\n\n本文です。',
    });
  });
});

describe('listDeletedPages', () => {
  it('returns soft-deleted pages with deletion metadata and excerpts', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        results: [
          {
            id: 'trashed',
            title: '古いメモ',
            created_at: 100,
            updated_at: 300,
            deleted_at: 400,
            created_by_name: '山田 太郎',
            excerpt_source: '## 見出し\n\n本文です。',
          },
          {
            id: 'trashed-older',
            title: 'さらに古いメモ',
            created_at: 50,
            updated_at: 150,
            deleted_at: 200,
            created_by_name: null,
            excerpt_source: '',
          },
        ],
      };
    });

    const pages = await listDeletedPages(db);

    expect(sql).toContain('p.deleted_at IS NOT NULL');
    expect(sql).toContain('ORDER BY p.deleted_at DESC');
    expect(sql).toContain('LIMIT 200');
    expect(pages).toEqual([
      {
        id: 'trashed',
        title: '古いメモ',
        createdAt: 100,
        createdByName: '山田 太郎',
        excerpt: '見出し 本文です。',
        updatedAt: 300,
        deletedAt: 400,
      },
      {
        id: 'trashed-older',
        title: 'さらに古いメモ',
        createdAt: 50,
        createdByName: '',
        excerpt: '',
        updatedAt: 150,
        deletedAt: 200,
      },
    ]);
  });
});

describe('undeletePage', () => {
  it('clears deleted_at and rebuilds the search index', async () => {
    const statements: Statement[] = [];
    const db = database((sql, args) => {
      statements.push({ sql, args });
      if (sql.includes('SELECT id FROM page')) return { first: { id: 'page-1' } };
      return {};
    });

    await expect(undeletePage(db, 'page-1')).resolves.toBe(true);

    const update = statements.find((statement) => statement.sql.startsWith('UPDATE page'));
    expect(update?.sql).toBe('UPDATE page SET deleted_at = NULL, updated_at = ? WHERE id = ?');
    expect(update?.args).toEqual([expect.any(Number), 'page-1']);

    const clearFts = statements.find(
      (statement) => statement.sql === 'DELETE FROM page_fts WHERE page_id = ?',
    );
    expect(clearFts?.args).toEqual(['page-1']);

    const rebuildFts = statements.find((statement) =>
      statement.sql.startsWith('INSERT INTO page_fts'),
    );
    expect(rebuildFts?.sql).toContain('COALESCE(b.markdown');
    expect(rebuildFts?.args).toEqual(['page-1']);
  });

  it('does not restore a page that is not in the trash', async () => {
    let statements = 0;
    const db = database(() => {
      statements += 1;
      return { first: null };
    });

    await expect(undeletePage(db, 'missing')).resolves.toBe(false);
    expect(statements).toBe(1);
  });
});

describe('permanentlyDeletePage', () => {
  it('removes the page, body, revisions, and search index', async () => {
    const statements: Statement[] = [];
    const db = database((sql, args) => {
      statements.push({ sql, args });
      if (sql.includes('SELECT id FROM page')) return { first: { id: 'page-1' } };
      return {};
    });

    await expect(permanentlyDeletePage(db, 'page-1')).resolves.toBe(true);

    const deletes = statements.filter((statement) => statement.sql.startsWith('DELETE FROM'));
    expect(deletes.map((statement) => statement.sql)).toEqual([
      'DELETE FROM revision WHERE page_id = ?',
      'DELETE FROM page_fts WHERE page_id = ?',
      'DELETE FROM page_body WHERE page_id = ?',
      'DELETE FROM page WHERE id = ? AND deleted_at IS NOT NULL',
    ]);
    for (const statement of deletes) {
      expect(statement.args).toEqual(['page-1']);
    }
  });

  it('does not purge a page that is not in the trash', async () => {
    let statements = 0;
    const db = database(() => {
      statements += 1;
      return { first: null };
    });

    await expect(permanentlyDeletePage(db, 'missing')).resolves.toBe(false);
    expect(statements).toBe(1);
  });
});

describe('sortPageSummaries', () => {
  const pages = [
    pageSummary('b', 'Page 10', 200, 100),
    pageSummary('a', 'Page 2', 300, 300),
    pageSummary('c', 'Page 1', 100, 200),
  ];

  it('sorts by updated time by default', () => {
    expect(sortPageSummaries(pages, 'updated').map((page) => page.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by created time', () => {
    expect(sortPageSummaries(pages, 'created').map((page) => page.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts titles naturally without changing the input', () => {
    expect(sortPageSummaries(pages, 'title').map((page) => page.title)).toEqual([
      'Page 1',
      'Page 2',
      'Page 10',
    ]);
    expect(pages.map((page) => page.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('excerptFromMarkdown', () => {
  it('strips common Markdown syntax and collapses whitespace', () => {
    expect(
      excerptFromMarkdown(
        '## 見出し\n\n> 引用\n\n- **太字** と `code`\n\n```ts\nconst x = 1;\n```',
      ),
    ).toBe('見出し 引用 太字 と code const x = 1;');
  });

  it('truncates long text with an ellipsis', () => {
    expect(excerptFromMarkdown('あ'.repeat(20), 5)).toBe('あああああ…');
  });

  it('removes unmatched emphasis markers left by a truncated snippet', () => {
    expect(excerptFromMarkdown('Zeee の使い方 **Zee…')).toBe('Zeee の使い方 Zee…');
  });
});

describe('searchPages', () => {
  it('returns updatedAt and a clean excerpt for FTS matches', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        results: [
          {
            id: 'page-1',
            title: 'Zeee の使い方',
            excerpt: 'Zeee は **Markdown** の知識ベース。',
            updated_at: 1234,
          },
        ],
      };
    });

    const results = await searchPages(db, 'Zeee');

    expect(sql).toContain('p.updated_at AS updated_at');
    expect(results).toEqual([
      {
        id: 'page-1',
        title: 'Zeee の使い方',
        excerpt: 'Zeee は Markdown の知識ベース。',
        updatedAt: 1234,
      },
    ]);
  });

  it('returns updatedAt for LIKE fallback matches', async () => {
    let sql = '';
    const db = database((statement) => {
      sql = statement;
      return {
        results: [
          {
            id: 'page-2',
            title: 'メモ',
            excerpt: '短いメモの本文',
            updated_at: 5678,
          },
        ],
      };
    });

    const results = await searchPages(db, 'メモ');

    expect(sql).toContain('p.updated_at AS updated_at');
    expect(results[0]).toEqual({
      id: 'page-2',
      title: 'メモ',
      excerpt: '短いメモの本文',
      updatedAt: 5678,
    });
  });
});
