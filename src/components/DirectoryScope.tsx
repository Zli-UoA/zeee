import { useMemo } from 'react';
import { Link } from '@void/react';
import { Empty, LayerCard, Text } from '@cloudflare/kumo';
import { FolderIcon } from '@phosphor-icons/react';
import type { PageNavigation } from '../server/types';
import { buildPageTree, countTreePages, findDirectoryNode } from '../shared/pagePath';
import { DirectoryPathBreadcrumb } from './PagePathBreadcrumb';
import { PageTree } from './PageTree';

export function DirectoryScope({ pages, dir }: { pages: PageNavigation[]; dir: string }) {
  const tree = useMemo(() => buildPageTree(pages), [pages]);
  const directory = useMemo(() => findDirectoryNode(tree, dir), [tree, dir]);

  if (!directory) {
    return (
      <Empty
        icon={<FolderIcon size={32} />}
        title="ディレクトリがない"
        description="ページのパスが変わったか、URL が違うかもしれません。"
        contents={
          <Link className="text-sm text-kumo-link" href="/">
            ページ一覧に戻る
          </Link>
        }
      />
    );
  }

  const count = countTreePages(directory.children);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <DirectoryPathBreadcrumb path={dir} />
        <Text variant="secondary" size="sm">
          配下のページ {count}件
        </Text>
      </div>
      <LayerCard className="overflow-hidden p-2">
        <PageTree
          pages={pages}
          scope={dir}
          activeDirectory={dir}
          variant="content"
          ariaLabel={`${dir} のページツリー`}
        />
      </LayerCard>
    </div>
  );
}
