import { afterEach, describe, expect, it } from 'vite-plus/test';
import { clampLikePattern, clampLikeText, searchPages } from '../src/server/db';
import { ensureSchema } from '../src/server/schema';
import { sqliteD1 } from './helpers/d1';

const encoder = new TextEncoder();
const stores: ReturnType<typeof sqliteD1>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

async function fixture(keepFts = false) {
  const store = sqliteD1();
  stores.push(store);
  await ensureSchema(store.db);
  store.sqlite.exec(`
    INSERT INTO app_user (id, issuer, subject, username, display_name, created_at, updated_at)
      VALUES ('creator', 'local', 'creator', 'creator', '作成者', 0, 0);
    INSERT INTO page (id, title, created_by, created_at, updated_at)
      VALUES ('page-1', '${'あ'.repeat(50)}', 'creator', 0, 0);
    INSERT INTO page_body (page_id, markdown, updated_at) VALUES ('page-1', '本文', 0);
  `);
  if (!keepFts) store.sqlite.exec('DROP TABLE page_fts');
  store.queries.length = 0;
  return store;
}

describe('clampLikePattern', () => {
  it('keeps short patterns byte-for-byte compatible with the old fallback', () => {
    expect(clampLikePattern('Zeee')).toBe('%Zeee%');
    expect(clampLikePattern('メモ')).toBe('%メモ%');
    expect(clampLikePattern('')).toBe('%%');
  });

  it('clamps Japanese text at a character boundary and keeps the trailing wildcard', () => {
    const pattern = clampLikePattern('あ'.repeat(100));

    expect(pattern).toBe(`%${'あ'.repeat(14)}%`); // 14 * 3 + 2 = 44 bytes
    expect(byteLength(pattern)).toBeLessThanOrEqual(44);
    expect(pattern.endsWith('%')).toBe(true);
    expect(pattern.slice(1, -1)).not.toContain('\uFFFD');
  });

  it('never splits a four-byte emoji', () => {
    const pattern = clampLikePattern('😀'.repeat(20));

    expect(pattern).toBe(`%${'😀'.repeat(10)}%`); // 10 * 4 + 2 = 42 bytes
    expect(byteLength(pattern)).toBeLessThanOrEqual(44);
    expect(pattern.slice(1, -1)).not.toContain('\uFFFD');
  });

  it('handles mixed Japanese, emoji and ASCII without losing the prefix', () => {
    const query = 'Zeee の😀メモ検索';
    const pattern = clampLikePattern(query, 12); // budget 10 bytes

    expect(pattern).toBe('%Zeee の%'); // 1 * 5 + 3 + 2 = 10 bytes
    expect(byteLength(pattern)).toBeLessThanOrEqual(12);
    expect(query.startsWith(pattern.slice(1, -1))).toBe(true);
    expect(pattern.slice(1, -1)).not.toContain('\uFFFD');
  });

  it('does not throw on lone surrogates and still respects the budget', () => {
    expect(clampLikePattern('\uD83D\uDE00'.repeat(20))).toBe(`%${'😀'.repeat(10)}%`);
    expect(clampLikePattern(`a\uD83D${'あ'.repeat(20)}`, 8)).toBe('%a\uD83D%');
    expect(byteLength(clampLikePattern(`a\uD83D${'あ'.repeat(20)}`, 8))).toBeLessThanOrEqual(8);
  });

  it('honors custom budgets and falls back to the safe default for invalid ones', () => {
    expect(clampLikePattern('abcdef', 4)).toBe('%ab%');
    expect(clampLikePattern('あいう', 4)).toBe('%%');
    expect(clampLikePattern('あいう', 5)).toBe('%あ%');
    expect(
      byteLength(clampLikePattern('あ'.repeat(100), Number.POSITIVE_INFINITY)),
    ).toBeLessThanOrEqual(44);
  });

  it("caps an oversized maxBytes at D1's 50-byte limit", () => {
    const japanese = clampLikePattern('あ'.repeat(100), 100);
    const ascii = clampLikePattern('a'.repeat(100), 100);

    expect(japanese).toBe(`%${'あ'.repeat(16)}%`); // 16 * 3 + 2 = 50 bytes
    expect(byteLength(japanese)).toBe(50);
    expect(ascii).toBe(`%${'a'.repeat(48)}%`);
    expect(byteLength(ascii)).toBe(50);
  });

  it('never exceeds a requested budget smaller than the two wildcards', () => {
    expect(clampLikePattern('あいう', 0)).toBe('');
    expect(clampLikePattern('あいう', 1)).toBe('%');
    expect(clampLikePattern('あいう', -4)).toBe('');
    expect(byteLength(clampLikePattern('あいう', 0))).toBeLessThanOrEqual(0);
    expect(byteLength(clampLikePattern('あいう', 1))).toBeLessThanOrEqual(1);
  });
});

describe('clampLikeText', () => {
  it('escapes each character before counting bytes and keeps escapes intact', () => {
    const escape = (char: string) => char.replace(/[\\%_]/g, '\\$&');

    // 12 Japanese bytes (4 chars) + escaped `%` (2 bytes) = 14 bytes.
    expect(clampLikeText('あいうえ%_%', 14, escape)).toBe('あいうえ\\%');
    expect(byteLength(clampLikeText('あいうえ%_%', 14, escape))).toBe(14);
    expect(clampLikeText('あいうえ%_%', 14, escape).endsWith('\\')).toBe(false);
  });
});

describe('searchPages LIKE byte limit', () => {
  it('binds the clamped pattern for both the result query and its count', async () => {
    const { db, queries } = await fixture();
    const query = 'あ'.repeat(100);

    const result = await searchPages(db, query);

    expect(result.items.map((item) => item.id)).toEqual(['page-1']);
    const likeQueries = queries.filter((entry) => entry.sql.includes('LIKE ?'));
    expect(likeQueries).toHaveLength(2);
    for (const entry of likeQueries) {
      const patterns = entry.args.filter((arg): arg is string => typeof arg === 'string');
      expect(patterns).toEqual([clampLikePattern(query), clampLikePattern(query)]);
      for (const pattern of patterns) expect(byteLength(pattern)).toBeLessThanOrEqual(44);
    }
  });

  it('leaves the FTS path unchanged when FTS is available', async () => {
    const { db, queries } = await fixture(true);
    const query = 'あ'.repeat(100);

    await searchPages(db, query);

    const ftsQueries = queries.filter((entry) => entry.sql.includes('page_fts MATCH'));
    expect(ftsQueries.length).toBeGreaterThan(0);
    for (const entry of ftsQueries) expect(entry.args[0]).toBe(`"${query}"`);
    expect(queries.some((entry) => entry.sql.includes('LIKE ?'))).toBe(false);
  });
});
