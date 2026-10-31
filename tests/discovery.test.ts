import { describe, expect, it } from 'vite-plus/test';
import { splitHighlight } from '../src/client/highlight';
import { buildPaletteActions, normalizeSearchResults } from '../src/client/palette';
import {
  clearLegacyRecentPages,
  loadRecentPages,
  normalizeRecentPages,
  RECENT_PAGES_STORAGE_KEY,
  recentPagesStorageKey,
  saveRecentPages,
  withRecentPage,
  type RecentPage,
} from '../src/client/useRecentPages';

describe('splitHighlight', () => {
  it('splits text into highlighted and plain parts', () => {
    expect(splitHighlight('Zeee の検索ページ', '検索')).toEqual([
      { text: 'Zeee の', match: false },
      { text: '検索', match: true },
      { text: 'ページ', match: false },
    ]);
  });

  it('matches case-insensitively and highlights every term', () => {
    expect(splitHighlight('Command Palette command', 'command palette')).toEqual([
      { text: 'Command', match: true },
      { text: ' ', match: false },
      { text: 'Palette', match: true },
      { text: ' ', match: false },
      { text: 'command', match: true },
    ]);
  });

  it('treats regular expression characters literally', () => {
    expect(splitHighlight('a+b (c)', '+')).toEqual([
      { text: 'a', match: false },
      { text: '+', match: true },
      { text: 'b (c)', match: false },
    ]);
    expect(splitHighlight('a+b (c)', '(')).toEqual([
      { text: 'a+b ', match: false },
      { text: '(', match: true },
      { text: 'c)', match: false },
    ]);
  });

  it('returns the original text when the query is blank', () => {
    expect(splitHighlight('本文', '   ')).toEqual([{ text: '本文', match: false }]);
  });
});

describe('palette actions', () => {
  const result = { id: 'page-1', title: 'Page 1', excerpt: 'excerpt' };

  it('puts search results before the create action', () => {
    const actions = buildPaletteActions({
      trimmedQuery: 'page',
      results: [result],
      resultsQuery: 'page',
      loading: false,
      error: null,
      intent: 'search',
      recentPages: [],
    });

    expect(actions.map((action) => action.kind)).toEqual(['result', 'all', 'create']);
  });

  it('puts the create action first when the search has no results', () => {
    const actions = buildPaletteActions({
      trimmedQuery: 'missing',
      results: [],
      resultsQuery: 'missing',
      loading: false,
      error: null,
      intent: 'search',
      recentPages: [],
    });

    expect(actions.map((action) => action.kind)).toEqual(['create', 'all']);
  });

  it('does not expose create while a search is pending or failed', () => {
    const base = {
      trimmedQuery: 'page',
      results: [result],
      resultsQuery: 'page',
      loading: false,
      error: null,
      intent: 'search' as const,
      recentPages: [],
    };

    expect(buildPaletteActions({ ...base, loading: true })).toEqual([]);
    expect(buildPaletteActions({ ...base, resultsQuery: 'old' })).toEqual([]);
    expect(buildPaletteActions({ ...base, error: 'failed' })).toEqual([]);
  });

  it('keeps updatedAt when the search API provides it', () => {
    expect(
      normalizeSearchResults([{ id: 'page-1', title: 'Page 1', excerpt: '', updatedAt: 123 }]),
    ).toEqual([{ id: 'page-1', title: 'Page 1', excerpt: '', updatedAt: 123 }]);
    expect(normalizeSearchResults([{ id: 'page-1', title: 'Page 1' }])).toEqual([
      { id: 'page-1', title: 'Page 1', excerpt: '' },
    ]);
  });
});

describe('recent pages', () => {
  it('deduplicates and keeps the newest eight pages', () => {
    let pages: RecentPage[] = [];
    for (let index = 0; index < 10; index += 1) {
      pages = withRecentPage(pages, { id: `page-${index}`, title: `Page ${index}` }, index);
    }

    expect(pages).toHaveLength(8);
    expect(pages[0]).toEqual({ id: 'page-9', title: 'Page 9', visitedAt: 9 });
    expect(pages.at(-1)).toEqual({ id: 'page-2', title: 'Page 2', visitedAt: 2 });

    pages = withRecentPage(pages, { id: 'page-2', title: 'Renamed' }, 20);
    expect(pages[0]).toEqual({ id: 'page-2', title: 'Renamed', visitedAt: 20 });
    expect(pages.filter((page) => page.id === 'page-2')).toHaveLength(1);
    expect(pages).toHaveLength(8);
  });

  it('normalizes stored entries by dropping malformed rows and duplicates', () => {
    const stored = [
      { id: 'a', title: 'A', visitedAt: 1 },
      { id: 'a', title: 'A duplicate', visitedAt: 4 },
      { id: 'b', title: 'B', visitedAt: 3 },
      { id: 'c', title: 3, visitedAt: 5 },
      { id: 'd', title: 'D', visitedAt: '6' },
      null,
    ];

    expect(normalizeRecentPages(stored)).toEqual([
      { id: 'a', title: 'A duplicate', visitedAt: 4 },
      { id: 'b', title: 'B', visitedAt: 3 },
    ]);
    expect(normalizeRecentPages({ id: 'a' })).toEqual([]);
  });

  it('scopes the storage key to the signed-in user', () => {
    expect(recentPagesStorageKey('user-a')).toBe(`${RECENT_PAGES_STORAGE_KEY}:user-a`);
    expect(recentPagesStorageKey('user-a')).not.toBe(recentPagesStorageKey('user-b'));
  });

  it('keeps recent pages separate for each user', () => {
    const storage = memoryStorage();
    saveRecentPages(storage, 'user-a', [{ id: 'a', title: 'A', visitedAt: 1 }]);
    saveRecentPages(storage, 'user-b', [{ id: 'b', title: 'B', visitedAt: 2 }]);

    expect(loadRecentPages(storage, 'user-a')).toEqual([{ id: 'a', title: 'A', visitedAt: 1 }]);
    expect(loadRecentPages(storage, 'user-b')).toEqual([{ id: 'b', title: 'B', visitedAt: 2 }]);
    expect(loadRecentPages(storage, 'user-c')).toEqual([]);
    expect(storage.getItem(RECENT_PAGES_STORAGE_KEY)).toBeNull();
  });

  it('ignores and clears the legacy shared storage key', () => {
    const legacy = [{ id: 'old', title: 'Old', visitedAt: 1 }];
    const storage = memoryStorage({
      [RECENT_PAGES_STORAGE_KEY]: JSON.stringify(legacy),
    });

    expect(loadRecentPages(storage, 'user-a')).toEqual([]);

    clearLegacyRecentPages(storage);
    expect(storage.getItem(RECENT_PAGES_STORAGE_KEY)).toBeNull();
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}
