import type { Props } from './index.server';
import { Badge, Button, Empty, Input, LayerCard, Table, Text } from '@cloudflare/kumo';
import { FileTextIcon } from '@phosphor-icons/react';
import { AppShell } from '../src/components/AppShell';
import { Gate } from '../src/components/Gate';
import { formatDate } from '../src/shared/format';

export default function Home({ user, pages, query, results, loginUrl }: Props) {
  return (
    <AppShell user={user} pages={pages} loginUrl={loginUrl}>
      {!user ? (
        <Gate
          code="AUTH / 01"
          title="Zeee は Zli のための知識ベース"
          description="AuthZ でログインすると、ページの作成と共同編集ができる。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Text variant="heading" size="lg" as="h1">
                {query ? 'Search' : 'Index'}
              </Text>
              <Text variant="secondary" size="sm">
                {query
                  ? `${results.length} results for “${query}”`
                  : `${pages.length} pages in Zeee`}
              </Text>
            </div>
            <Badge variant="beta">internal</Badge>
          </div>

          <form method="get" action="/" className="flex items-center gap-2 sm:hidden">
            <Input
              name="q"
              size="sm"
              placeholder="Search pages"
              aria-label="Search pages"
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>

          {query && results.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<FileTextIcon size={32} />}
                title="No results"
                description="その言葉はまだ書かれていない。"
                contents={
                  <a className="text-sm text-kumo-link" href="/">
                    索引に戻る
                  </a>
                }
              />
            </LayerCard>
          ) : !query && pages.length === 0 ? (
            <LayerCard className="p-0">
              <Empty
                icon={<FileTextIcon size={32} />}
                title="No pages yet"
                description="最初のページを書いて、この索引をはじめよう。"
                contents={
                  <form
                    method="post"
                    action="/"
                    className="flex w-full max-w-sm items-center gap-2"
                  >
                    <Input
                      name="title"
                      size="sm"
                      placeholder="Page title"
                      aria-label="New page title"
                      required
                      maxLength={200}
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" variant="primary" size="sm">
                      Create
                    </Button>
                  </form>
                }
              />
            </LayerCard>
          ) : (
            <LayerCard className="overflow-hidden p-0">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>{query ? 'Page' : 'Title'}</Table.Head>
                    <Table.Head className="w-48">{query ? 'Excerpt' : 'Updated'}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {query
                    ? results.map((result) => (
                        <Table.Row key={result.id}>
                          <Table.Cell>
                            <a
                              className="font-medium text-kumo-link no-underline hover:underline"
                              href={`/pages/${result.id}`}
                            >
                              {result.title}
                            </a>
                          </Table.Cell>
                          <Table.Cell>
                            <Text variant="secondary" size="sm" truncate>
                              {result.excerpt}
                            </Text>
                          </Table.Cell>
                        </Table.Row>
                      ))
                    : pages.map((page) => (
                        <Table.Row key={page.id}>
                          <Table.Cell>
                            <a
                              className="font-medium text-kumo-link no-underline hover:underline"
                              href={`/pages/${page.id}`}
                            >
                              {page.title}
                            </a>
                          </Table.Cell>
                          <Table.Cell>
                            <Text variant="mono-secondary">{formatDate(page.updatedAt)}</Text>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                </Table.Body>
              </Table>
            </LayerCard>
          )}
        </div>
      )}
    </AppShell>
  );
}
