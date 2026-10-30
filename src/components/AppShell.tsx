import type { ReactNode } from 'react';
import { Badge, Breadcrumbs, Button, Input, Text } from '@cloudflare/kumo';
import { PlusIcon, SignOutIcon } from '@phosphor-icons/react';
import type { PageSummary, SessionUser } from '../server/types';

type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  activePageId?: string;
  activeTitle?: string;
  loginUrl: string;
  children: ReactNode;
};

export function AppShell({ user, pages, activePageId, activeTitle, loginUrl, children }: Props) {
  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <header className="sticky top-0 z-30 border-b border-kumo-line bg-kumo-base/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4">
          <a className="flex shrink-0 items-center gap-2 no-underline" href="/">
            <span className="text-lg font-semibold tracking-tight text-kumo-strong">Zeee</span>
            <Badge variant="outline">zli</Badge>
          </a>

          <div className="hidden min-w-0 md:block">
            <Breadcrumbs size="sm">
              <Breadcrumbs.Link href="/">Index</Breadcrumbs.Link>
              {activeTitle ? (
                <>
                  <Breadcrumbs.Separator />
                  <Breadcrumbs.Current>{activeTitle}</Breadcrumbs.Current>
                </>
              ) : null}
            </Breadcrumbs>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <>
                <form method="get" action="/" className="hidden sm:block">
                  <Input
                    name="q"
                    size="sm"
                    placeholder="Search pages"
                    aria-label="Search pages"
                    className="w-56"
                  />
                </form>
                <Badge variant="neutral">{user.displayName}</Badge>
                <a
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default"
                  href="/auth/logout"
                >
                  <SignOutIcon size={14} />
                  Logout
                </a>
              </>
            ) : (
              <a
                className="inline-flex h-8 items-center rounded-md bg-kumo-contrast px-3 text-xs font-medium text-kumo-inverse no-underline hover:opacity-90"
                href={loginUrl}
              >
                Login
              </a>
            )}
          </div>
        </div>
      </header>

      {user ? (
        <div className="mx-auto grid max-w-[1440px] grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="border-b border-kumo-line bg-kumo-elevated/40 lg:border-b-0 lg:border-r">
            <div className="p-3 lg:p-4">
              <div className="mb-3 hidden items-center justify-between lg:flex">
                <Text variant="heading" as="h2">
                  Pages
                </Text>
                <Badge variant="outline">{pages.length}</Badge>
              </div>

              <form
                method="post"
                action="/"
                className="flex flex-row items-center gap-2 lg:flex-col lg:items-stretch"
              >
                <Input
                  name="title"
                  placeholder="New page title"
                  aria-label="New page title"
                  required
                  maxLength={200}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="submit"
                  variant="primary"
                  icon={<PlusIcon size={14} />}
                  className="shrink-0"
                >
                  Create
                </Button>
              </form>
            </div>

            <nav
              className="px-2 pb-3 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto lg:pb-4"
              aria-label="Pages"
            >
              <ul className="flex gap-1 overflow-x-auto lg:block lg:space-y-1 lg:overflow-visible">
                {pages.map((page) => (
                  <li className="shrink-0 lg:shrink" key={page.id}>
                    <a
                      href={`/pages/${page.id}`}
                      className={
                        page.id === activePageId
                          ? 'block truncate rounded-md bg-kumo-tint px-2 py-1.5 text-sm font-medium text-kumo-strong no-underline ring-1 ring-kumo-line'
                          : 'block truncate rounded-md px-2 py-1.5 text-sm text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default'
                      }
                      title={page.title}
                    >
                      {page.title}
                    </a>
                  </li>
                ))}
              </ul>
              {pages.length === 0 ? (
                <div className="px-2 pt-2">
                  <Text variant="secondary" size="sm">
                    No pages yet.
                  </Text>
                </div>
              ) : null}
            </nav>
          </aside>

          <main className="min-w-0 p-4 lg:p-6">{children}</main>
        </div>
      ) : (
        <main className="mx-auto max-w-[1440px] p-4 lg:p-6">{children}</main>
      )}
    </div>
  );
}
