import { useMemo } from 'react';
import { Link } from '@void/react';
import { Empty, LayerCard, Text } from '@cloudflare/kumo';
import { ArrowRightIcon, FolderIcon } from '@phosphor-icons/react';
import type { PageNavigation } from '../server/types';
import {
  buildPageTree,
  findDirectoryNode,
  isStrictPathPrefix,
  pagePathName,
  pagePathSegments,
  type PageTreeDirectoryNode,
} from '../shared/pagePath';
import { formatDate } from '../shared/format';
import { DirectoryPathBreadcrumb } from './PagePathBreadcrumb';

export function DirectoryScope({ pages, dir }: { pages: PageNavigation[]; dir: string }) {
  const tree = useMemo(() => buildPageTree(pages), [pages]);
  const directory = useMemo(() => findDirectoryNode(tree, dir), [tree, dir]);
  const scopedPages = useMemo(
    () => pages.filter((page) => isStrictPathPrefix(dir, pagePathSegments(page.title).join('/'))),
    [pages, dir],
  );

  if (!directory) {
    return (
      <Empty
        icon={<FolderIcon size={32} />}
        title="ディレクトリがない"
        description="ページのパスが変わったか、URL が違うかもしれません。"
        contents={
          <Link className="text-sm text-kumo-link" href="/">
            すべてのページに戻る
          </Link>
        }
      />
    );
  }

  const childDirectories = directory.children.filter(
    (node): node is PageTreeDirectoryNode => node.kind === 'directory',
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <DirectoryPathBreadcrumb path={dir} />
        <Text variant="heading" size="lg" as="h1">
          {pagePathName(dir)}
        </Text>
        <Text variant="secondary" size="sm">
          配下のページ {scopedPages.length}件
        </Text>
      </header>

      {childDirectories.length > 0 ? (
        <section aria-labelledby="child-directories" className="flex flex-col gap-2">
          <Text variant="heading" as="h2" id="child-directories">
            子ディレクトリ
          </Text>
          <LayerCard className="overflow-hidden p-0">
            <ul className="divide-y divide-kumo-line">
              {childDirectories.map((child) => (
                <li key={child.path}>
                  <Link
                    href={`/?dir=${encodeURIComponent(child.path)}`}
                    className="flex min-h-11 items-center gap-2 px-4 py-2 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
                  >
                    <FolderIcon size={16} className="shrink-0 text-kumo-subtle" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-link">
                      {child.path}/
                    </span>
                    <ArrowRightIcon size={15} className="shrink-0 text-kumo-subtle" />
                  </Link>
                </li>
              ))}
            </ul>
          </LayerCard>
        </section>
      ) : null}

      {scopedPages.length === 0 ? (
        <Empty
          icon={<FolderIcon size={32} />}
          title="このディレクトリにはページがありません"
          description="ページのパスが変わったか、URL が違うかもしれません。"
          contents={
            <Link className="text-sm text-kumo-link" href="/">
              すべてのページに戻る
            </Link>
          }
        />
      ) : (
        <LayerCard className="overflow-hidden p-0">
          <ul aria-label={`${dir} 配下のページ`} className="divide-y divide-kumo-line">
            {scopedPages.map((page) => (
              <li key={page.id}>
                <Link
                  className="flex flex-col gap-1 px-4 py-3 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
                  href={`/pages/${page.id}`}
                >
                  <span className="min-w-0 truncate text-sm font-medium text-kumo-link">
                    {page.title}
                  </span>
                  <span className="text-sm text-kumo-subtle">
                    <span className="sr-only">更新日時 </span>
                    <time dateTime={new Date(page.updatedAt).toISOString()}>
                      {formatDate(page.updatedAt)}
                    </time>
                    に更新
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </LayerCard>
      )}
    </div>
  );
}
