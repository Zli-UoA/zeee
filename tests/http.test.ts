import type { CloudContext } from 'void';
import { describe, expect, it } from 'vite-plus/test';
import {
  excerptFromMarkdown,
  getPage,
  listPages,
  searchPages,
  sortPageSummaries,
} from '../src/server/db';
import { sameOrigin } from '../src/server/http';
import type { PageSummary } from '../src/server/types';

type QueryResult = { results?: unknown[]; first?: unknown };

function database(handler: (sql: string, args: unknown[]) => QueryResult): D1Database {
  function prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
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
