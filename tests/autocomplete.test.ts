import { describe, expect, it } from 'vite-plus/test';
import {
  filterWikiCompletions,
  findWikiCompletionContext,
  uniqueWikiTargets,
  wikiCompletionText,
  wikiCompletionTo,
} from '../src/markdown/autocomplete';
import type { LinkTarget } from '../src/markdown/wiki';

const targets: LinkTarget[] = [
  { id: 'roadmap', title: 'ロードマップ', updatedAt: 10, aliases: ['予定'] },
  {
    id: 'minutes',
    title: '議事録',
    updatedAt: 20,
    aliases: ['ミーティング', 'ロードマップ会議'],
  },
  { id: 'duplicate-old', title: '重複', updatedAt: 1, aliases: ['古い別名'] },
  { id: 'duplicate-new', title: '重複', updatedAt: 5, aliases: [] },
  { id: 'api', title: 'API', updatedAt: 30, aliases: ['えーぴーあい'] },
  { id: 'blank', title: '  ', updatedAt: 40, aliases: ['無視される'] },
];

describe('findWikiCompletionContext', () => {
  it('finds an open wiki link directly before the cursor', () => {
    expect(findWikiCompletionContext('前 [[Zee', 7)).toEqual({ from: 2, query: 'Zee' });
    expect(findWikiCompletionContext('[[', 2)).toEqual({ from: 0, query: '' });
  });

  it('keeps working while the query is being typed', () => {
    expect(findWikiCompletionContext('[[ロー', 4)).toEqual({ from: 0, query: 'ロー' });
    const markdown = '本文\n[[ロー';
    expect(findWikiCompletionContext(markdown, markdown.length)).toEqual({
      from: 3,
      query: 'ロー',
    });
  });

  it('does not fire on completed links, labels, other lines, or nested brackets', () => {
    expect(findWikiCompletionContext('[[Zeee]]', 8)).toBeNull();
    const labelled = '[[Zeee|ゼエ';
    expect(findWikiCompletionContext(labelled, labelled.length)).toBeNull();
    const multiline = '[[Zeee\n次の行';
    expect(findWikiCompletionContext(multiline, multiline.length)).toBeNull();
    expect(findWikiCompletionContext('[[[Zeee', 7)).toBeNull();
  });

  it('ignores fenced and inline code', () => {
    const fenced = '```\n[[Zeee\n```';
    expect(findWikiCompletionContext(fenced, fenced.indexOf('Zeee') + 'Zeee'.length)).toBeNull();

    const inline = '`[[Zeee`';
    expect(findWikiCompletionContext(inline, inline.length - 1)).toBeNull();

    const afterInline = '`Zeee` [[メモ';
    expect(findWikiCompletionContext(afterInline, afterInline.length)).toEqual({
      from: 7,
      query: 'メモ',
    });
  });
});

describe('wikiCompletionTo', () => {
  it('replaces an existing closing bracket pair', () => {
    expect(wikiCompletionTo('[[Zeee]]', 6)).toBe(8);
    expect(wikiCompletionTo('[[Zeee', 6)).toBe(6);
    expect(wikiCompletionTo('[[Zeee]', 6)).toBe(6);
  });
});

describe('uniqueWikiTargets', () => {
  it('trims titles and aliases, drops blanks, and keeps the newest duplicate', () => {
    const unique = uniqueWikiTargets(targets);
    expect(unique.map((target) => target.title)).toEqual(['ロードマップ', '議事録', '重複', 'API']);
    expect(unique.find((target) => target.title === '重複')?.id).toBe('duplicate-new');
    expect(unique.find((target) => target.title === '重複')?.aliases).toEqual([]);
    expect(unique.find((target) => target.title === 'ロードマップ')?.aliases).toEqual(['予定']);
  });
});

describe('filterWikiCompletions', () => {
  it('returns every unique target for an empty query', () => {
    expect(filterWikiCompletions(targets, '').map((target) => target.title)).toEqual([
      'ロードマップ',
      '議事録',
      '重複',
      'API',
    ]);
  });

  it('filters by current title for later typing', () => {
    expect(filterWikiCompletions(targets, 'ロー').map((target) => target.title)).toEqual([
      'ロードマップ',
      '議事録',
    ]);
    expect(filterWikiCompletions(targets, 'api').map((target) => target.title)).toEqual(['API']);
    expect(filterWikiCompletions(targets, '存在しない')).toEqual([]);
  });

  it('matches aliases but reports the current title to insert', () => {
    const results = filterWikiCompletions(targets, '予定');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'roadmap',
      title: 'ロードマップ',
      matchedAlias: '予定',
    });
  });

  it('shows both title matches and alias matches while typing', () => {
    const results = filterWikiCompletions(targets, 'ロードマップ');
    expect(results.map((target) => target.title)).toEqual(['ロードマップ', '議事録']);
    expect(results[0].matchedAlias).toBeUndefined();
    expect(results[1].matchedAlias).toBe('ロードマップ会議');
  });
});

describe('wikiCompletionText', () => {
  it('inserts the current title wrapped in wiki brackets', () => {
    expect(wikiCompletionText('ロードマップ')).toBe('[[ロードマップ]]');
  });
});
