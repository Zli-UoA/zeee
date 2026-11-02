import { useMemo, useState } from 'react';
import { Button, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import { MagnifyingGlassIcon, TreeStructureIcon } from '@phosphor-icons/react';
import type { Props } from './browse.server';
import { AppShell } from '../src/components/AppShell';
import { Gate } from '../src/components/Gate';
import { PageTree } from '../src/components/PageTree';
import { filterPagesByQuery } from '../src/shared/pagePath';

export default function BrowsePage({ user, pages, recentPages, loginUrl }: Props) {
  const [filter, setFilter] = useState('');
  const filteredPages = useMemo(() => filterPagesByQuery(pages, filter), [pages, filter]);
  const filtering = filter.trim().length > 0;

  return (
    <AppShell user={user} pages={pages} initialRecentPages={recentPages} activeNav="browse">
      {!user ? (
        <Gate
          title="ログインが必要です"
          description="Zeee は Zli のメンバーだけが使える知識ベース。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              すべてのページ
            </Text>
            <Text variant="secondary" size="sm" aria-live="polite">
              {filtering
                ? `${pages.length}ページ中 ${filteredPages.length}件が一致`
                : `${pages.length}ページ`}
            </Text>
          </div>

          <div className="max-w-xl">
            <Input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label="ページツリーを絞り込む"
              placeholder="パスやタイトルで絞り込む"
              enterKeyHint="search"
              className="w-full"
            />
          </div>

          {filteredPages.length === 0 ? (
            <Empty
              icon={<MagnifyingGlassIcon size={32} />}
              title={filtering ? '該当なし' : 'まだページがありません'}
              description={
                filtering
                  ? '別のキーワードで絞り込むか、フィルタをクリアしてください。'
                  : '新しいページを作成すると、ここにツリーが表示されます。'
              }
              contents={
                filtering ? (
                  <Button type="button" variant="secondary" onClick={() => setFilter('')}>
                    フィルタをクリア
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <LayerCard className="overflow-hidden p-2">
              <PageTree
                pages={filteredPages}
                variant="content"
                ariaLabel="すべてのページツリー"
                expandAll
              />
            </LayerCard>
          )}

          {!filtering && pages.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <TreeStructureIcon size={14} aria-hidden="true" className="shrink-0" />
              <Text variant="secondary" size="sm">
                ディレクトリを選ぶと、その配下のページを確認できます。
              </Text>
            </div>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
