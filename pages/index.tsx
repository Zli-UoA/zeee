import type { Props } from './index.server';
import { Button, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import { FilesIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { AppShell } from '../src/components/AppShell';
import { Gate } from '../src/components/Gate';
import { formatDateOnly } from '../src/shared/format';

export default function Home({ user, pages, query, results, loginUrl }: Props) {
  return (
    <AppShell user={user} pages={pages} query={query}>
      {!user ? (
        <Gate
          title="Zeee は Zli のための知識ベース"
          description="AuthZ でログインすると、ページの作成と共同編集ができる。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              {query ? '検索結果' : 'ページ'}
            </Text>
            <Text variant="secondary" size="sm">
              {query ? `「${query}」に一致するページ ${results.length}件` : `${pages.length}ページ`}
            </Text>
          </div>

          <form method="get" action="/" role="search" className="flex items-center gap-2 lg:hidden">
            <Input
              name="q"
              type="search"
              defaultValue={query}
              enterKeyHint="search"
              placeholder="ページを検索"
              aria-label="ページを検索"
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="secondary"
              icon={<MagnifyingGlassIcon size={15} />}
              aria-label="検索"
            />
          </form>

          {query && results.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<MagnifyingGlassIcon size={32} />}
                title="該当なし"
                description="一致するページはありません。"
                contents={
                  <a className="text-sm text-kumo-link" href="/">
                    ページ一覧に戻る
                  </a>
                }
              />
            </LayerCard>
          ) : !query && pages.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<FilesIcon size={32} />}
                title="まだページがありません"
                description="新しいページを作成してください。"
                contents={
                  <form
                    method="post"
                    action="/"
                    className="flex w-full max-w-sm items-center gap-2"
                  >
                    <Input
                      name="title"
                      placeholder="ページタイトル"
                      aria-label="新しいページのタイトル"
                      required
                      maxLength={200}
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" variant="primary">
                      作成
                    </Button>
                  </form>
                }
              />
            </LayerCard>
          ) : (
            <LayerCard className="overflow-hidden p-0">
              <ul className="divide-y divide-kumo-line">
                {query
                  ? results.map((result) => (
                      <li key={result.id}>
                        <a
                          className="flex flex-col gap-1 px-4 py-3 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
                          href={`/pages/${result.id}`}
                        >
                          <span className="truncate text-sm font-medium text-kumo-link">
                            {result.title}
                          </span>
                          <span className="line-clamp-2 text-sm text-kumo-subtle">
                            {result.excerpt}
                          </span>
                        </a>
                      </li>
                    ))
                  : pages.map((page) => (
                      <li key={page.id}>
                        <a
                          className="flex items-center justify-between gap-4 px-4 py-3 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
                          href={`/pages/${page.id}`}
                        >
                          <span className="truncate text-sm font-medium text-kumo-link">
                            {page.title}
                          </span>
                          <time
                            className="shrink-0 text-xs text-kumo-subtle"
                            dateTime={new Date(page.updatedAt).toISOString()}
                          >
                            {formatDateOnly(page.updatedAt)}
                          </time>
                        </a>
                      </li>
                    ))}
              </ul>
            </LayerCard>
          )}
        </div>
      )}
    </AppShell>
  );
}
