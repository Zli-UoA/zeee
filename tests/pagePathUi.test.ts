import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PathSuggestionListbox, PagePathInput } from '../src/components/PagePathInput';
import { PagePathBreadcrumb } from '../src/components/PagePathBreadcrumb';
import { PagePathCreateForm } from '../src/components/PagePathCreateForm';
import { PageTree } from '../src/components/PageTree';
import { directorySuggestions, type PagePathPage } from '../src/shared/pagePath';

vi.mock('@void/react', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({
      href,
      children,
      ...props
    }: {
      href?: string;
      children?: ReactNode;
      [key: string]: unknown;
    }) => h('a', { href, ...props }, children),
    useRouter: () => ({ visit: () => {} }),
  };
});

function page(id: string, title: string): PagePathPage {
  return { id, title, updatedAt: 1 };
}

describe('PageTree UI', () => {
  const pages = [page('p1', 'a/b/c'), page('p2', 'a/e'), page('p3', 'z')];

  it('renders directories before pages and expands active ancestors', () => {
    const html = renderToStaticMarkup(
      createElement(PageTree, { pages, activeTitle: 'a/b/c', variant: 'sidebar' }),
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain('data-kind="directory"');
    expect(html).toContain('data-kind="page"');
    expect(html.indexOf('data-kind="directory"')).toBeLessThan(html.indexOf('data-kind="page"'));
    expect(html).toContain('href="/?dir=a"');
    expect(html).toContain('href="/?dir=a%2Fb"');
    expect(html).toContain('href="/pages/p1"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders only the requested scope', () => {
    const html = renderToStaticMarkup(
      createElement(PageTree, { pages, scope: 'a/b', variant: 'content' }),
    );

    expect(html).toContain('href="/pages/p1"');
    expect(html).not.toContain('href="/pages/p3"');
    expect(html).not.toContain('href="/?dir=a"');
  });

  it('expands every directory when browsing all pages', () => {
    const html = renderToStaticMarkup(
      createElement(PageTree, { pages, variant: 'content', expandAll: true }),
    );

    expect(html).toContain('href="/pages/p1"');
    expect(html).toContain('href="/pages/p2"');
    expect(html).toContain('href="/pages/p3"');
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(4);
  });
});

describe('PagePathBreadcrumb UI', () => {
  it('links every ancestor directory and marks the current page', () => {
    const html = renderToStaticMarkup(createElement(PagePathBreadcrumb, { title: 'a/b/c' }));

    expect(html).toContain('aria-label="パンくずリスト"');
    expect(html).toContain('href="/?dir=a"');
    expect(html).toContain('href="/?dir=a%2Fb"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('>c</span>');
  });
});

describe('PagePathCreateForm UI', () => {
  it('shows a neutral hint instead of an error for an untouched directory path', () => {
    const html = renderToStaticMarkup(
      createElement(PagePathCreateForm, {
        pages: [page('p1', 'engineering/platform/api')],
        defaultValue: 'engineering/platform/',
        ariaLabel: 'このディレクトリに新規ページのパス',
      }),
    );

    expect(html).toContain('ページ名を入力してください。');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid="true"');
  });

  it('does not show a hint or error for a complete untouched path', () => {
    const html = renderToStaticMarkup(
      createElement(PagePathCreateForm, {
        pages: [page('p1', 'engineering/platform/api')],
        defaultValue: 'engineering/platform/new',
      }),
    );

    expect(html).not.toContain('ページ名を入力してください。');
    expect(html).not.toContain('role="alert"');
  });
});

describe('PagePathInput UI', () => {
  const pages = [page('p1', 'aaa/bbb/ccc'), page('p2', 'abc/d')];

  it('exposes combobox semantics for the path field', () => {
    const html = renderToStaticMarkup(
      createElement(PagePathInput, {
        value: 'a',
        onChange: () => {},
        pages,
        ariaLabel: 'ページのパス',
      }),
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-label="ページのパス"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('renders directory options with listbox semantics', () => {
    const suggestions = directorySuggestions(pages, 'a');
    const html = renderToStaticMarkup(
      createElement(PathSuggestionListbox, {
        id: 'suggestions',
        baseId: 'base',
        suggestions,
        activeIndex: 0,
        onActivate: () => {},
        onSelect: () => {},
      }),
    );

    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aaa/');
    expect(html).toContain('abc/');
  });
});
