import { describe, expect, it } from 'vite-plus/test';
import { listBacklinks } from '../src/server/backlinks';

type QueryResult = { results?: unknown[]; first?: unknown };

function database(handler: (sql: string, args: unknown[]) => QueryResult): D1Database {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    calls,
    async exec() {
      return { count: 0, duration: 0 };
    },
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          calls.push({ sql, args });
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
    },
  };
  return db as unknown as D1Database;
}

function row(id: string, title: string, markdown: string, updatedAt = 100) {
  return {
    id,
    title,
    author_name: '山田 太郎',
    updated_at: updatedAt,
    markdown,
  };
}

describe('listBacklinks', () => {
  it('returns pages that reference the title and filters non-matches in JS', async () => {
    const db = database((sql) => {
      if (sql.includes('SELECT title FROM page')) return { first: { title: 'Zeee の使い方' } };
      return {
        results: [
          row('a', 'A', '前 [[Zeee の使い方]] 後', 300),
          row('b', 'B', '前 [[Zeee の使い方|使い方]] 後', 200),
          row('c', 'C', '`[[Zeee の使い方]]`', 100),
          row('d', 'D', '[[Zeee]]', 50),
        ],
      };
    });

    const backlinks = await listBacklinks(db, 'current');

    expect(backlinks.map((backlink) => backlink.id)).toEqual(['a', 'b']);
    expect(backlinks[0]).toMatchObject({
      id: 'a',
      title: 'A',
      authorName: '山田 太郎',
      updatedAt: 300,
    });
    expect(backlinks[0].excerpt).toContain('Zeee の使い方');
  });

  it('queries the target title, excludes deleted and self pages, and pre-filters with LIKE', async () => {
    const db = database((sql) => {
      if (sql.includes('SELECT title FROM page')) {
        return { first: { title: '50%_メモ' } };
      }
      return { results: [] };
    }) as D1Database & { calls: { sql: string; args: unknown[] }[] };

    await listBacklinks(db, 'current');

    const candidate = db.calls.find((call) => call.sql.includes('FROM page p'));
    expect(candidate?.sql).toContain('p.deleted_at IS NULL');
    expect(candidate?.sql).toContain('p.id <> ?');
    expect(candidate?.sql).toContain('LIKE ? ESCAPE');
    expect(candidate?.sql).toContain('LEFT JOIN app_user');
    expect(candidate?.args[0]).toBe('current');
    expect(candidate?.args[1]).toBe('%[[%50\\%\\_メモ%');
  });

  it('returns an empty list when the target page is missing', async () => {
    const db = database(() => ({ first: null }));
    expect(await listBacklinks(db, 'missing')).toEqual([]);
  });

  it('caps the result at 20 pages', async () => {
    const db = database((sql) => {
      if (sql.includes('SELECT title FROM page')) return { first: { title: 'Zeee' } };
      return {
        results: Array.from({ length: 30 }, (_, index) =>
          row(`page-${index}`, `Page ${index}`, '[[Zeee]]', 1000 - index),
        ),
      };
    });

    const backlinks = await listBacklinks(db, 'current');
    expect(backlinks).toHaveLength(20);
  });
});
