import { describe, expect, it } from 'vite-plus/test';
import {
  ancestorDirectoryPaths,
  buildPageTree,
  collectDirectoryPaths,
  countTreePages,
  directorySuggestions,
  findDirectoryNode,
  nextActiveIndex,
  normalizeDirectoryPath,
  pagePathContext,
  pagePathName,
  pagePathSegments,
  pagePathTrail,
  parsePagePath,
  PATH_CONFLICT_MESSAGE,
  pathRequestErrorMessage,
  scopePageTree,
  validatePagePath,
  type PagePathPage,
} from '../src/shared/pagePath';

function page(id: string, title: string, updatedAt = 1): PagePathPage {
  return { id, title, updatedAt };
}

describe('page path parsing', () => {
  it('parses slash-separated paths into segments', () => {
    expect(parsePagePath('a/b/c')).toEqual({
      path: 'a/b/c',
      segments: ['a', 'b', 'c'],
      name: 'c',
      parentPath: 'a/b',
    });
    expect(parsePagePath('  a / b  ')).toEqual({
      path: 'a/b',
      segments: ['a', 'b'],
      name: 'b',
      parentPath: 'a',
    });
  });

  it('rejects empty, incomplete, and duplicate separators', () => {
    expect(parsePagePath('')).toBeNull();
    expect(parsePagePath('   ')).toBeNull();
    expect(parsePagePath('/a')).toBeNull();
    expect(parsePagePath('a/')).toBeNull();
    expect(parsePagePath('a//b')).toBeNull();
  });

  it('normalizes paths for tree and directory lookups', () => {
    expect(pagePathSegments('a//b/ c ')).toEqual(['a', 'b', 'c']);
    expect(normalizeDirectoryPath('a/b/')).toBe('a/b');
    expect(normalizeDirectoryPath(null)).toBe('');
  });

  it('builds a trail and ancestor list from the path', () => {
    expect(pagePathTrail('a/b/c')).toEqual({
      path: 'a/b/c',
      directories: [
        { name: 'a', path: 'a' },
        { name: 'b', path: 'a/b' },
      ],
      current: { name: 'c', path: 'a/b/c' },
    });
    expect(ancestorDirectoryPaths('a/b/c')).toEqual(['a', 'a/b']);
    expect(ancestorDirectoryPaths('root')).toEqual([]);
    expect(pagePathName('a/b/c')).toBe('c');
    expect(pagePathContext('a/b/c')).toBe('a / b');
    expect(pagePathContext('root')).toBe('');
  });
});

describe('page tree', () => {
  const pages = [
    page('p1', 'a/b/c', 3),
    page('p2', 'a/b/d', 2),
    page('p3', 'a/e', 1),
    page('p4', 'z', 4),
  ];

  it('derives directories and sorts directories before pages', () => {
    const tree = buildPageTree(pages);
    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual(['directory:a', 'page:z']);
    const a = findDirectoryNode(tree, 'a');
    expect(a?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      'directory:a/b',
      'page:a/e',
    ]);
    const b = findDirectoryNode(tree, 'a/b');
    expect(b?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      'page:a/b/c',
      'page:a/b/d',
    ]);
  });

  it('scopes the tree to a directory without opening a page', () => {
    const tree = buildPageTree(pages);
    expect(scopePageTree(tree, 'a').map((node) => node.path)).toEqual(['a/b', 'a/e']);
    expect(scopePageTree(tree, 'a/b').map((node) => node.path)).toEqual(['a/b/c', 'a/b/d']);
    expect(scopePageTree(tree, '').map((node) => node.path)).toEqual(['a', 'z']);
    expect(scopePageTree(tree, 'missing')).toEqual([]);
  });

  it('counts pages and collects directory paths', () => {
    const tree = buildPageTree(pages);
    expect(countTreePages(tree)).toBe(4);
    expect(countTreePages(findDirectoryNode(tree, 'a')?.children ?? [])).toBe(3);
    expect(collectDirectoryPaths(pages)).toEqual(['a', 'a/b']);
  });

  it('keeps a page and a conflicting legacy directory at the same level', () => {
    const tree = buildPageTree([page('page-a', 'a'), page('page-ab', 'a/b')]);
    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual(['directory:a', 'page:a']);
  });
});

describe('directory suggestions', () => {
  const pages = [
    page('1', 'aaa'),
    page('2', 'aaa/bbb/ccc'),
    page('3', 'abc'),
    page('4', 'foo/bar'),
    page('5', 'a/b/c'),
    page('6', 'a/b/c/d'),
  ];

  it('suggests matching directories and completes them with a slash', () => {
    const suggestions = directorySuggestions(pages, 'a');
    expect(suggestions.map((suggestion) => suggestion.value)).toEqual(
      expect.arrayContaining(['a/', 'aaa/', 'a/b/', 'aaa/bbb/']),
    );
    expect(suggestions.every((suggestion) => suggestion.value.endsWith('/'))).toBe(true);
  });

  it('suggests child directories after a directory is completed', () => {
    expect(directorySuggestions(pages, 'aaa/').map((suggestion) => suggestion.value)).toEqual([
      'aaa/bbb/',
    ]);
    expect(directorySuggestions(pages, 'a/b/').map((suggestion) => suggestion.value)).toEqual([
      'a/b/c/',
    ]);
    expect(directorySuggestions(pages, 'a/b').map((suggestion) => suggestion.value)).toEqual([
      'a/b/',
      'a/b/c/',
    ]);
  });

  it('does not suggest unrelated directories and respects the limit', () => {
    expect(directorySuggestions(pages, 'foo/')).toEqual([]);
    expect(directorySuggestions(pages, 'zzz')).toEqual([]);
    expect(directorySuggestions(pages, 'a', 2)).toHaveLength(2);
  });

  it('cycles suggestion indexes for keyboard navigation', () => {
    expect(nextActiveIndex(-1, 1, 3)).toBe(0);
    expect(nextActiveIndex(-1, -1, 3)).toBe(2);
    expect(nextActiveIndex(2, 1, 3)).toBe(0);
    expect(nextActiveIndex(0, -1, 3)).toBe(2);
    expect(nextActiveIndex(0, 1, 0)).toBe(-1);
  });
});

describe('path conflicts', () => {
  const pages = [page('p1', 'a'), page('p2', 'a/b'), page('p3', 'x/y')];

  it('rejects an exact duplicate path', () => {
    expect(validatePagePath('a/b', pages)).toMatchObject({
      ok: false,
      kind: 'duplicate',
      path: 'a/b',
    });
  });

  it('rejects a path below an existing page', () => {
    expect(validatePagePath('a/b/c', pages)).toMatchObject({
      ok: false,
      kind: 'page-prefix',
      path: 'a/b/c',
    });
  });

  it('rejects a page that would become a directory', () => {
    expect(validatePagePath('a', [page('p2', 'a/b')])).toMatchObject({
      ok: false,
      kind: 'directory-prefix',
      path: 'a',
    });
  });

  it('allows siblings that only share a directory', () => {
    expect(validatePagePath('a/c', [page('p2', 'a/b')])).toEqual({ ok: true, path: 'a/c' });
    expect(validatePagePath('x/z', pages)).toEqual({ ok: true, path: 'x/z' });
  });

  it('excludes the edited page from its own conflict check', () => {
    expect(validatePagePath('a/b', [page('p2', 'a/b')], { excludeId: 'p2' })).toEqual({
      ok: true,
      path: 'a/b',
    });
  });

  it('reports incomplete paths as invalid', () => {
    expect(validatePagePath('', pages)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(validatePagePath('a/', pages)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(validatePagePath('a//b', pages)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(validatePagePath('a'.repeat(201), pages)).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it('maps a backend PATH_CONFLICT response to a display message', () => {
    expect(pathRequestErrorMessage(409, 'PATH_CONFLICT')).toBe(PATH_CONFLICT_MESSAGE);
    expect(pathRequestErrorMessage(409, null)).toBe(PATH_CONFLICT_MESSAGE);
    expect(pathRequestErrorMessage(500, null)).not.toBe(PATH_CONFLICT_MESSAGE);
  });
});
