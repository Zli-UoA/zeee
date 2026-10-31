import { describe, expect, it } from 'vite-plus/test';
import {
  createHeadingSlugger,
  slugifyHeading,
  transformHeadings,
  type HeadingNode,
} from '../src/markdown/headings';
import { sameToc } from '../src/markdown/toc';
import {
  containsWikiLink,
  createWikiResolver,
  findWikiReference,
  parseWikiLinkInner,
  splitWikiText,
  transformWikiLinks,
  wikiPlainText,
  type WikiLinkPage,
  type WikiNode,
} from '../src/markdown/wiki';

describe('slugifyHeading', () => {
  it('keeps Japanese characters and lowercases latin text', () => {
    expect(slugifyHeading(' Zeee の使い方 ')).toBe('zeee-の使い方');
    expect(slugifyHeading('ＡＰＩ リファレンス')).toBe('api-リファレンス');
  });

  it('removes punctuation and collapses separators', () => {
    expect(slugifyHeading('はじめに・準備！')).toBe('はじめに準備');
    expect(slugifyHeading('foo --- bar')).toBe('foo-bar');
  });

  it('falls back to section when nothing remains', () => {
    expect(slugifyHeading('！！！')).toBe('section');
    expect(slugifyHeading('')).toBe('section');
  });
});

describe('createHeadingSlugger', () => {
  it('numbers duplicate headings in order', () => {
    const slug = createHeadingSlugger();
    expect(slug('はじめに')).toBe('はじめに');
    expect(slug('はじめに')).toBe('はじめに-2');
    expect(slug('はじめに')).toBe('はじめに-3');
  });

  it('avoids collisions with headings that already end in a number', () => {
    const slug = createHeadingSlugger();
    expect(slug('foo')).toBe('foo');
    expect(slug('foo')).toBe('foo-2');
    expect(slug('foo 2')).toBe('foo-2-2');
  });
});

describe('sameToc', () => {
  it('detects heading level changes even when ids and text stay the same', () => {
    const current = [{ id: '使い方', depth: 2, text: '使い方' }];
    const next = [{ id: '使い方', depth: 3, text: '使い方' }];
    expect(sameToc(current, next)).toBe(false);
  });

  it('returns true for identical entries', () => {
    const items = [{ id: '使い方', depth: 2, text: '使い方' }];
    expect(sameToc(items, [...items])).toBe(true);
  });
});

describe('transformHeadings', () => {
  it('demotes body h1 to h2 and assigns unique ids', () => {
    const tree: HeadingNode = {
      type: 'root',
      children: [
        heading('h1', 'はじめに'),
        heading('h2', 'はじめに'),
        heading('h2', 'API リファレンス'),
      ],
    };

    transformHeadings(tree);

    expect((tree.children ?? []).map((node) => node.tagName)).toEqual(['h2', 'h2', 'h2']);
    expect((tree.children ?? []).map((node) => node.properties?.id)).toEqual([
      'はじめに',
      'はじめに-2',
      'api-リファレンス',
    ]);
  });
});

describe('parseWikiLinkInner', () => {
  it('parses title-only and labelled links', () => {
    expect(parseWikiLinkInner(' Zeee の使い方 ')).toEqual({
      title: 'Zeee の使い方',
      label: 'Zeee の使い方',
    });
    expect(parseWikiLinkInner('Zeee の使い方|使い方')).toEqual({
      title: 'Zeee の使い方',
      label: '使い方',
    });
  });

  it('ignores empty titles and falls back to the title for empty labels', () => {
    expect(parseWikiLinkInner(' | 表示名 ')).toBeNull();
    expect(parseWikiLinkInner('Zeee|')).toEqual({ title: 'Zeee', label: 'Zeee' });
  });
});

describe('createWikiResolver', () => {
  const pages: WikiLinkPage[] = [
    { id: 'new', title: '同じ名前', updatedAt: 300, aliases: [] },
    { id: 'old', title: '同じ名前', updatedAt: 100, aliases: [] },
    { id: 'other', title: '別ページ', updatedAt: 200, aliases: [] },
  ];

  it('resolves duplicates to the most recently updated page', () => {
    const resolve = createWikiResolver(pages);
    expect(resolve('同じ名前')?.id).toBe('new');
    expect(resolve(' 別ページ ')?.id).toBe('other');
  });

  it('returns null for pages outside the supplied list', () => {
    const resolve = createWikiResolver(pages);
    expect(resolve('存在しない')).toBeNull();
  });

  it('falls back to aliases after current titles and picks the newest duplicate', () => {
    const resolve = createWikiResolver([
      { id: 'current', title: '新しい名前', updatedAt: 100, aliases: [' 古い名前 '] },
      { id: 'alias-new', title: '別ページ', updatedAt: 300, aliases: ['共通の別名'] },
      { id: 'alias-old', title: 'さらに別', updatedAt: 200, aliases: ['共通の別名'] },
      { id: 'blank', title: '空の別名', updatedAt: 400, aliases: ['  '] },
    ]);
    expect(resolve('古い名前')?.id).toBe('current');
    expect(resolve('共通の別名')?.id).toBe('alias-new');
    expect(resolve('  ')).toBeNull();
  });

  it('prefers a current title over an alias even when the alias is newer', () => {
    const resolve = createWikiResolver([
      { id: 'title', title: '重複', updatedAt: 100, aliases: [] },
      { id: 'alias', title: '別名持ち', updatedAt: 300, aliases: ['重複'] },
    ]);
    expect(resolve('重複')?.id).toBe('title');
  });
});

describe('splitWikiText', () => {
  const resolve = createWikiResolver([{ id: 'page-1', title: 'Zeee', updatedAt: 1, aliases: [] }]);

  it('splits text into wiki links and resolved targets', () => {
    expect(splitWikiText('前 [[Zeee]] と [[Zeee|ゼエ]] 後', resolve)).toEqual([
      { type: 'text', value: '前 ' },
      {
        type: 'wiki',
        title: 'Zeee',
        label: 'Zeee',
        target: { id: 'page-1', title: 'Zeee', updatedAt: 1, aliases: [] },
      },
      { type: 'text', value: ' と ' },
      {
        type: 'wiki',
        title: 'Zeee',
        label: 'ゼエ',
        target: { id: 'page-1', title: 'Zeee', updatedAt: 1, aliases: [] },
      },
      { type: 'text', value: ' 後' },
    ]);
  });

  it('marks unknown titles as missing', () => {
    expect(splitWikiText('[[未作成]]', resolve)).toEqual([
      { type: 'wiki', title: '未作成', label: '未作成', target: null },
    ]);
  });

  it('does not recognize links that span lines', () => {
    expect(splitWikiText('[[Zeee\nの使い方]]', resolve)).toEqual([
      { type: 'text', value: '[[Zeee\nの使い方]]' },
    ]);
  });
});

describe('transformWikiLinks', () => {
  const resolve = createWikiResolver([{ id: 'page-1', title: 'Zeee', updatedAt: 1, aliases: [] }]);

  it('converts text but leaves code, inline code, and existing links alone', () => {
    const tree: WikiNode = {
      type: 'root',
      children: [
        paragraph([text('[[Zeee]]')]),
        { type: 'inlineCode', value: '[[Zeee]]' },
        { type: 'code', value: '[[Zeee]]' },
        paragraph([{ type: 'link', url: '/other', children: [text('[[Zeee]]')] }]),
      ],
    };

    transformWikiLinks(tree, resolve);

    const first = tree.children?.[0].children?.[0];
    expect(first).toMatchObject({
      type: 'link',
      url: '/pages/page-1',
      data: { hProperties: { dataWikiState: 'resolved', dataWikiTitle: 'Zeee' } },
    });
    expect(tree.children?.[0].children).toHaveLength(1);
    expect(tree.children?.[1]).toEqual({ type: 'inlineCode', value: '[[Zeee]]' });
    expect(tree.children?.[2]).toEqual({ type: 'code', value: '[[Zeee]]' });
    expect(tree.children?.[3]?.children?.[0]).toMatchObject({
      type: 'link',
      url: '/other',
    });
  });

  it('keeps the display label and marks missing links', () => {
    const tree: WikiNode = {
      type: 'root',
      children: [paragraph([text('[[未作成|新しいページ]]')])],
    };

    transformWikiLinks(tree, resolve);

    expect(tree.children?.[0].children?.[0]).toMatchObject({
      type: 'link',
      url: '#',
      data: { hProperties: { dataWikiState: 'missing', dataWikiTitle: '未作成' } },
      children: [{ type: 'text', value: '新しいページ' }],
    });
  });
});

describe('containsWikiLink', () => {
  const title = 'Zeee の使い方';

  it('finds title-only and labelled references', () => {
    expect(containsWikiLink('[[Zeee の使い方]]', title)).toBe(true);
    expect(containsWikiLink('[[Zeee の使い方|使い方]]', title)).toBe(true);
    expect(containsWikiLink('[[ Zeee の使い方 | 使い方 ]]', title)).toBe(true);
  });

  it('does not match partial titles or other pages', () => {
    expect(containsWikiLink('[[Zeee]]', title)).toBe(false);
    expect(containsWikiLink('[[Zeee の使い方メモ]]', title)).toBe(false);
  });

  it('ignores fenced and inline code', () => {
    expect(containsWikiLink('```md\n[[Zeee の使い方]]\n```', title)).toBe(false);
    expect(containsWikiLink('~~~\n[[Zeee の使い方]]\n~~~', title)).toBe(false);
    expect(containsWikiLink('`[[Zeee の使い方]]`', title)).toBe(false);
  });

  it('handles titles with regular expression metacharacters', () => {
    const special = 'C++ (メモ) [v2]';
    expect(containsWikiLink('[[C++ (メモ) [v2]]]', special)).toBe(true);
  });

  it('reports where the reference appears for excerpt extraction', () => {
    const markdown =
      '前書き\n\n```ts\n[[Zeee の使い方]]\n```\n\n本文で [[Zeee の使い方|使い方]] を参照。';
    const reference = findWikiReference(markdown, title);
    expect(reference).not.toBeNull();
    expect(markdown.slice(reference!.index, reference!.index + reference!.length)).toBe(
      '[[Zeee の使い方|使い方]]',
    );
  });
});

describe('wikiPlainText', () => {
  it('replaces wiki syntax with readable labels', () => {
    expect(wikiPlainText('前 [[Zeee の使い方|使い方]] 後')).toBe('前 使い方 後');
    expect(wikiPlainText('[[Zeee]]')).toBe('Zeee');
  });
});

function heading(tagName: string, value: string): HeadingNode {
  return {
    type: 'element',
    tagName,
    properties: {},
    children: [text(value)],
  };
}

function paragraph(children: WikiNode[]): WikiNode {
  return { type: 'paragraph', children };
}

function text(value: string): WikiNode {
  return { type: 'text', value };
}
