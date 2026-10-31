import type { Props } from './index.server';
import { Button, ButtonGroup, Empty, Input, LayerCard, LinkButton, Text } from '@cloudflare/kumo';
import { FilesIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { AppShell } from '../src/components/AppShell';
import { Gate } from '../src/components/Gate';
import { formatDate } from '../src/shared/format';
import {
  PAGE_LIST_LIMIT,
  type PageSort,
  type PageSummary,
  type SearchResult,
} from '../src/server/types';

const SORT_OPTIONS: { value: PageSort; label: string }[] = [
  { value: 'updated', label: '更新順' },
  { value: 'created', label: '作成順' },
  { value: 'title', label: 'タイトル順' },
];

const TIME_ZONE = 'Asia/Tokyo';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

type GroupKey = 'today' | 'yesterday' | 'week' | 'older';

type DateGroup = {
  key: GroupKey;
  label: string;
  pages: PageSummary[];
};

const GROUP_LABELS: { key: GroupKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '今週' },
  { key: 'older', label: 'それ以前' },
];

export default function Home({ user, pages, query, sort, results, now, loginUrl }: Props) {
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
            {!query && pages.length >= PAGE_LIST_LIMIT ? (
              <Text variant="secondary" size="sm">
                最新{PAGE_LIST_LIMIT}件を表示しています。
              </Text>
            ) : null}
          </div>

          <form method="get" action="/" role="search" className="flex items-center gap-2 lg:hidden">
            {sort !== 'updated' ? <input type="hidden" name="sort" value={sort} /> : null}
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
              shape="square"
              aria-label="検索"
            />
          </form>

          {!query && pages.length > 0 ? (
            <nav aria-label="並び順" className="flex flex-wrap items-center gap-2">
              <Text as="span" variant="secondary" size="sm" id="page-sort-label">
                並び順
              </Text>
              <ButtonGroup aria-labelledby="page-sort-label">
                {SORT_OPTIONS.map((option) => {
                  const active = option.value === sort;
                  return (
                    <LinkButton
                      key={option.value}
                      href={indexHref(option.value, query)}
                      size="sm"
                      variant={active ? 'primary' : 'secondary'}
                      aria-current={active ? 'true' : undefined}
                    >
                      {option.label}
                    </LinkButton>
                  );
                })}
              </ButtonGroup>
            </nav>
          ) : null}

          {query && results.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<MagnifyingGlassIcon size={32} />}
                title="該当なし"
                description={`「${query}」に一致するページはありません。このタイトルで新規作成できます。`}
                contents={
                  <div className="flex w-full max-w-sm flex-col items-center gap-3">
                    <form method="post" action="/" className="flex w-full items-center gap-2">
                      <Input
                        name="title"
                        defaultValue={query}
                        placeholder="ページタイトル"
                        aria-label="新しいページのタイトル"
                        required
                        maxLength={200}
                        className="min-w-0 flex-1"
                      />
                      <Button type="submit" variant="primary" icon={<PlusIcon size={14} />}>
                        作成
                      </Button>
                    </form>
                    <a className="text-sm text-kumo-link" href="/">
                      ページ一覧に戻る
                    </a>
                  </div>
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
          ) : query ? (
            <LayerCard className="overflow-hidden p-0">
              <ul className="divide-y divide-kumo-line">
                {results.map((result) => (
                  <SearchResultRow key={result.id} result={result} query={query} />
                ))}
              </ul>
            </LayerCard>
          ) : sort === 'title' ? (
            <LayerCard className="overflow-hidden p-0">
              <ul className="divide-y divide-kumo-line">
                {pages.map((page) => (
                  <PageRow key={page.id} page={page} />
                ))}
              </ul>
            </LayerCard>
          ) : (
            <div className="flex flex-col gap-6">
              {groupPages(pages, sort === 'created' ? 'createdAt' : 'updatedAt', now).map(
                (group) => (
                  <section
                    key={group.key}
                    aria-labelledby={`page-group-${group.key}`}
                    className="flex flex-col gap-2"
                  >
                    <Text as="h2" id={`page-group-${group.key}`} variant="heading">
                      {group.label}
                    </Text>
                    <LayerCard className="overflow-hidden p-0">
                      <ul className="divide-y divide-kumo-line">
                        {group.pages.map((page) => (
                          <PageRow key={page.id} page={page} />
                        ))}
                      </ul>
                    </LayerCard>
                  </section>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}

function indexHref(sort: PageSort, query: string): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (sort !== 'updated') params.set('sort', sort);
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

function groupPages(
  pages: PageSummary[],
  field: 'createdAt' | 'updatedAt',
  now: number,
): DateGroup[] {
  const today = dayNumber(now);
  const weekStart = today - ((today + 3) % 7);
  const grouped = new Map<GroupKey, PageSummary[]>();

  for (const page of pages) {
    const day = dayNumber(page[field]);
    const difference = today - day;
    let key: GroupKey;
    if (difference <= 0) {
      key = 'today';
    } else if (difference === 1) {
      key = 'yesterday';
    } else if (day >= weekStart) {
      key = 'week';
    } else {
      key = 'older';
    }
    const current = grouped.get(key);
    if (current) current.push(page);
    else grouped.set(key, [page]);
  }

  return GROUP_LABELS.flatMap(({ key, label }) => {
    const groupPages = grouped.get(key);
    return groupPages ? [{ key, label, pages: groupPages }] : [];
  });
}

function dayNumber(timestamp: number): number {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of dayFormatter.formatToParts(new Date(timestamp))) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function PageRow({ page }: { page: PageSummary }) {
  return (
    <li>
      <a
        className="flex flex-col gap-1.5 px-4 py-3 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
        href={`/pages/${page.id}`}
      >
        <span className="min-w-0 truncate text-sm font-medium text-kumo-link">{page.title}</span>
        <span className="line-clamp-2 text-sm text-kumo-subtle">
          {page.excerpt || '本文はまだありません'}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
          <span className="max-w-full truncate">{page.createdByName || '不明なユーザー'}</span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="sr-only">更新日時 </span>
            <time dateTime={new Date(page.updatedAt).toISOString()}>
              {formatDate(page.updatedAt)}
            </time>
          </span>
        </span>
      </a>
    </li>
  );
}

function SearchResultRow({ result, query }: { result: SearchResult; query: string }) {
  return (
    <li>
      <a
        className="flex flex-col gap-1.5 px-4 py-3 no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset focus-visible:outline-none"
        href={`/pages/${result.id}`}
      >
        <span className="min-w-0 truncate text-sm font-medium text-kumo-link">
          <Highlight text={result.title} query={query} />
        </span>
        <span className="line-clamp-2 text-sm text-kumo-subtle">
          <Highlight text={result.excerpt || '本文はまだありません'} query={query} />
        </span>
        <span className="text-xs text-kumo-subtle">
          <span className="sr-only">更新日時 </span>
          <time dateTime={new Date(result.updatedAt).toISOString()}>
            {formatDate(result.updatedAt)}
          </time>
        </span>
      </a>
    </li>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return text;

  const matcher = new RegExp(`(${escapeRegExp(needle)})`, 'gi');
  const lowerNeedle = needle.toLowerCase();
  return (
    <>
      {text.split(matcher).map((part, index) =>
        part.toLowerCase() === lowerNeedle ? (
          <mark
            key={`${index}-${part}`}
            className="rounded-sm bg-kumo-brand/15 px-0.5 text-inherit"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
