import { describe, expect, it } from 'vite-plus/test';
import { splitHighlight } from '../src/client/highlight';
import {
  normalizeRecentPages,
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
});
