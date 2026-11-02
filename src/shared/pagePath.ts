export const MAX_PAGE_PATH_LENGTH = 200;
export const PATH_CONFLICT = 'PATH_CONFLICT';
export const PATH_CONFLICT_MESSAGE =
  'パスが競合しています。同名のページやディレクトリと重ならない名前にしてください。';

export type PagePathPage = {
  id: string;
  title: string;
  updatedAt: number;
};

export type ParsedPagePath = {
  path: string;
  segments: string[];
  name: string;
  parentPath: string;
};

export type PagePathTrail = {
  path: string;
  directories: { name: string; path: string }[];
  current: { name: string; path: string };
};

export type PageTreePageNode = {
  kind: 'page';
  id: string;
  title: string;
  name: string;
  path: string;
  updatedAt: number;
};

export type PageTreeDirectoryNode = {
  kind: 'directory';
  name: string;
  path: string;
  children: PageTreeNode[];
};

export type PageTreeNode = PageTreeDirectoryNode | PageTreePageNode;

export type DirectorySuggestion = {
  path: string;
  name: string;
  value: string;
  depth: number;
};

export type PathConflictKind = 'duplicate' | 'page-prefix' | 'directory-prefix';

export type PathValidation =
  | { ok: true; path: string }
  | {
      ok: false;
      kind: 'invalid' | PathConflictKind;
      message: string;
      path?: string;
      pages: PagePathPage[];
    };

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

function trimSegment(value: string): string {
  return value.trim();
}

function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

function invalid(message: string): PathValidation {
  return { ok: false, kind: 'invalid', message, pages: [] };
}

export function pagePathSegments(raw: string): string[] {
  return raw.split('/').map(trimSegment).filter(Boolean);
}

export function normalizePagePath(raw: string): string | null {
  const segments = pagePathSegments(raw);
  return segments.length ? segments.join('/') : null;
}

export function normalizeDirectoryPath(raw: string | null | undefined): string {
  return pagePathSegments(raw ?? '').join('/');
}

export function parsePagePath(raw: string): ParsedPagePath | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const rawSegments = trimmed.split('/');
  if (rawSegments.some((segment) => !segment.trim())) return null;
  const segments = rawSegments.map(trimSegment);
  const path = segments.join('/');
  if (path.length > MAX_PAGE_PATH_LENGTH) return null;
  return {
    path,
    segments,
    name: segments[segments.length - 1],
    parentPath: segments.slice(0, -1).join('/'),
  };
}

export function pagePathTrail(raw: string): PagePathTrail | null {
  const segments = pagePathSegments(raw);
  if (!segments.length) return null;
  return {
    path: segments.join('/'),
    directories: segments.slice(0, -1).map((name, index) => ({
      name,
      path: segments.slice(0, index + 1).join('/'),
    })),
    current: {
      name: segments[segments.length - 1],
      path: segments.join('/'),
    },
  };
}

export function pagePathName(raw: string): string {
  const segments = pagePathSegments(raw);
  return segments.length ? segments[segments.length - 1] : raw.trim();
}

export function pagePathContext(raw: string): string {
  const segments = pagePathSegments(raw);
  return segments.slice(0, -1).join(' / ');
}

export function ancestorDirectoryPaths(raw: string): string[] {
  const segments = pagePathSegments(raw);
  return segments.slice(0, -1).map((_name, index) => segments.slice(0, index + 1).join('/'));
}

export function isStrictPathPrefix(prefix: string, path: string): boolean {
  return prefix.length > 0 && path.startsWith(`${prefix}/`);
}

export function collectDirectoryPaths(pages: PagePathPage[]): string[] {
  const paths = new Set<string>();
  for (const page of pages) {
    const segments = pagePathSegments(page.title);
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index).join('/'));
    }
  }
  return [...paths].sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    return depth || compareNames(a, b);
  });
}

type MutableDirectory = {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  pages: PageTreePageNode[];
};

function emptyDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), pages: [] };
}

function directoryNodes(directory: MutableDirectory): PageTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((a, b) => compareNames(a.name, b.name) || a.path.localeCompare(b.path))
    .map<PageTreeDirectoryNode>((child) => ({
      kind: 'directory',
      name: child.name,
      path: child.path,
      children: directoryNodes(child),
    }));
  const pages = [...directory.pages].sort(
    (a, b) => compareNames(a.name, b.name) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  return [...directories, ...pages];
}

export function buildPageTree(pages: PagePathPage[]): PageTreeNode[] {
  const root = emptyDirectory('', '');
  for (const page of pages) {
    const segments = pagePathSegments(page.title);
    if (!segments.length) continue;
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      const path = segments.slice(0, index + 1).join('/');
      let child = directory.directories.get(name);
      if (!child) {
        child = emptyDirectory(name, path);
        directory.directories.set(name, child);
      }
      directory = child;
    }
    directory.pages.push({
      kind: 'page',
      id: page.id,
      title: page.title,
      name: segments[segments.length - 1],
      path: segments.join('/'),
      updatedAt: page.updatedAt,
    });
  }
  return directoryNodes(root);
}

export function findDirectoryNode(
  nodes: PageTreeNode[],
  path: string,
): PageTreeDirectoryNode | null {
  for (const node of nodes) {
    if (node.kind !== 'directory') continue;
    if (node.path === path) return node;
    const found = findDirectoryNode(node.children, path);
    if (found) return found;
  }
  return null;
}

export function scopePageTree(nodes: PageTreeNode[], scope: string): PageTreeNode[] {
  if (!scope) return nodes;
  return findDirectoryNode(nodes, scope)?.children ?? [];
}

export function countTreePages(nodes: PageTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === 'page' ? 1 : countTreePages(node.children);
  }
  return count;
}

export function directorySuggestions(
  pages: PagePathPage[],
  input: string,
  limit = 8,
): DirectorySuggestion[] {
  const value = input.trimStart();
  const rawSegments = value.split('/');
  const baseSegments = rawSegments.slice(0, -1).map(trimSegment).filter(Boolean);
  const query = value.endsWith('/') ? '' : trimSegment(rawSegments[rawSegments.length - 1] ?? '');
  const base = baseSegments.join('/');
  const needle = query.toLocaleLowerCase();

  const suggestions = collectDirectoryPaths(pages).filter((path) => {
    if (base && !path.startsWith(`${base}/`)) return false;
    const relative = base ? path.slice(base.length + 1) : path;
    if (!relative) return false;
    return !needle || relative.toLocaleLowerCase().startsWith(needle);
  });

  return suggestions.slice(0, limit).map((path) => ({
    path,
    name: path.split('/')[path.split('/').length - 1],
    value: `${path}/`,
    depth: path.split('/').length,
  }));
}

export function nextActiveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export function validatePagePath(
  raw: string,
  pages: PagePathPage[],
  options: { excludeId?: string } = {},
): PathValidation {
  const trimmed = raw.trim();
  if (!trimmed) return invalid('ページ名を入力してください。');
  if (trimmed.length > MAX_PAGE_PATH_LENGTH) {
    return invalid(`パスは${MAX_PAGE_PATH_LENGTH}文字以内にしてください。`);
  }
  if (trimmed.endsWith('/')) {
    return invalid('末尾の「/」の後にページ名を入れてください。');
  }
  const parsed = parsePagePath(trimmed);
  if (!parsed) return invalid('「/」の前後に名前を入れてください。');

  const existing = pages
    .filter((page) => page.id !== options.excludeId)
    .flatMap((page) => {
      const path = normalizePagePath(page.title);
      return path ? [{ page, path }] : [];
    });

  const duplicate = existing.find((item) => item.path === parsed.path);
  if (duplicate) {
    return {
      ok: false,
      kind: 'duplicate',
      message: `「${parsed.path}」は既存のページと同じパスです。`,
      path: parsed.path,
      pages: [duplicate.page],
    };
  }

  const parentPage = existing.find((item) => isStrictPathPrefix(item.path, parsed.path));
  if (parentPage) {
    return {
      ok: false,
      kind: 'page-prefix',
      message: `「${parentPage.path}」はページのため、その配下にページは作成できません。`,
      path: parsed.path,
      pages: [parentPage.page],
    };
  }

  const childPages = existing.filter((item) => isStrictPathPrefix(parsed.path, item.path));
  if (childPages.length) {
    return {
      ok: false,
      kind: 'directory-prefix',
      message: `「${parsed.path}」には既存の子ページがあるため、同じパスのページは作成できません。`,
      path: parsed.path,
      pages: childPages.map((item) => item.page),
    };
  }

  return { ok: true, path: parsed.path };
}

export function pathRequestErrorMessage(status: number, code?: string | null): string {
  if (status === 409 || code === PATH_CONFLICT) return PATH_CONFLICT_MESSAGE;
  if (status === 400) return 'パスの形式が正しくありません。入力内容を確認してください。';
  return 'ページを保存できませんでした。もう一度お試しください。';
}
