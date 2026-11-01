import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@void/react';
import { Button, LinkProvider, Sidebar, Text, useSidebar } from '@cloudflare/kumo';
import {
  ClockCounterClockwiseIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { AppLink } from './AppLink';
import { CommandPalette } from './CommandPalette';
import { CreatePageDialog } from './CreatePageDialog';
import { ZeeeLogo } from './ZeeeLogo';
import { sidebarPageLists } from '../client/sidebarPages';
import { useRecentPages, type RecentPage } from '../client/useRecentPages';
import type { PageNavigation, SessionUser } from '../server/types';

type NavSection = 'trash';

type Props = {
  user: SessionUser | null;
  pages: PageNavigation[];
  initialRecentPages?: RecentPage[];
  activePageId?: string;
  activeTitle?: string;
  activeNav?: NavSection;
  query?: string;
  children: ReactNode;
};

export function AppShell({
  user,
  pages,
  initialRecentPages = [],
  activePageId,
  activeTitle,
  activeNav,
  query,
  children,
}: Props) {
  const [livePages, setLivePages] = useState(pages);
  const [liveTitle, setLiveTitle] = useState(activeTitle);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const { recentPages, recordVisit } = useRecentPages(user?.id, initialRecentPages);

  const recentPagesWithTitles = useMemo(
    () =>
      recentPages.flatMap((page) => {
        const current = livePages.find((candidate) => candidate.id === page.id);
        return current ? [{ ...page, title: current.title }] : [];
      }),
    [recentPages, livePages],
  );

  const { recentPages: sidebarRecentPages, allPages } = useMemo(
    () => sidebarPageLists(livePages, recentPagesWithTitles),
    [livePages, recentPagesWithTitles],
  );

  const isTrash = activeNav === 'trash';

  useEffect(() => {
    setLivePages(pages);
    setLiveTitle(activeTitle);
  }, [pages, activeTitle]);

  useEffect(() => {
    if (liveTitle) document.title = `${liveTitle} | Zeee`;
  }, [liveTitle]);

  useEffect(() => {
    if (!user || !activePageId || !liveTitle) return;
    recordVisit({ id: activePageId, title: liveTitle });
  }, [user, activePageId, liveTitle, recordVisit]);

  useEffect(() => {
    if (!user || createOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [user, createOpen]);

  function openSearch() {
    setPaletteOpen(true);
  }

  useEffect(() => {
    const handleRename = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; title: string }>).detail;
      if (!detail) return;
      setLivePages((current) =>
        current.map((page) => (page.id === detail.id ? { ...page, title: detail.title } : page)),
      );
      if (detail.id === activePageId) setLiveTitle(detail.title);
    };
    window.addEventListener('zeee:page-renamed', handleRename);
    return () => window.removeEventListener('zeee:page-renamed', handleRename);
  }, [activePageId]);

  if (!user) {
    return (
      <LinkProvider component={AppLink}>
        <div className="min-h-svh bg-kumo-canvas text-kumo-default">
          <SkipToContent />
          <header className="h-14 border-b border-kumo-line bg-kumo-base">
            <div className="mx-auto flex h-full max-w-6xl items-center px-4 sm:px-6">
              <Brand />
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
            {children}
          </main>
        </div>
      </LinkProvider>
    );
  }

  return (
    <LinkProvider component={AppLink}>
      <Sidebar.Provider collapsible="offcanvas" className="min-h-svh bg-kumo-canvas">
        <CloseMobileSidebarOnNavigate
          activePageId={activePageId}
          activeNav={activeNav}
          query={query}
        />
        <SkipToContent />
        <Sidebar id="pages-nav" className="md:sticky md:top-0 md:h-svh">
          <Sidebar.Header className="h-14 justify-between px-3.5">
            <Brand />
            <Sidebar.Close className="size-8 md:hidden" aria-label="ページ一覧を閉じる" />
          </Sidebar.Header>

          <Sidebar.Content>
            {sidebarRecentPages.length > 0 ? (
              <Sidebar.Group>
                <Sidebar.GroupLabel>最近見たページ</Sidebar.GroupLabel>
                <Sidebar.Menu>
                  {sidebarRecentPages.map((page) => (
                    <Sidebar.MenuButton
                      href={`/pages/${page.id}`}
                      size="sm"
                      icon={ClockCounterClockwiseIcon}
                      active={page.id === activePageId}
                      aria-current={page.id === activePageId ? 'page' : undefined}
                      key={page.id}
                    >
                      {page.title}
                    </Sidebar.MenuButton>
                  ))}
                </Sidebar.Menu>
              </Sidebar.Group>
            ) : null}

            <Sidebar.Group>
              <Sidebar.GroupLabel>すべてのページ</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {allPages.map((page) => (
                  <Sidebar.MenuButton
                    href={`/pages/${page.id}`}
                    active={page.id === activePageId}
                    aria-current={page.id === activePageId ? 'page' : undefined}
                    key={page.id}
                  >
                    {page.title}
                  </Sidebar.MenuButton>
                ))}
              </Sidebar.Menu>
            </Sidebar.Group>

            {livePages.length === 0 ? (
              <div className="px-3 py-3">
                <Text variant="secondary" size="sm">
                  まだページがありません。
                </Text>
              </div>
            ) : null}
          </Sidebar.Content>

          <Sidebar.Footer>
            <Sidebar.Menu className="w-full">
              <Sidebar.MenuButton
                href="/trash"
                icon={TrashIcon}
                active={isTrash}
                aria-current={isTrash ? 'page' : undefined}
              >
                ゴミ箱
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Footer>
        </Sidebar>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 h-14 border-b border-kumo-line bg-kumo-base/90 backdrop-blur">
            <div className="mx-auto flex h-full w-full max-w-[1100px] items-center gap-2 px-4 sm:px-6 lg:px-8">
              <MobileNavButton />

              <div className="min-w-0 md:hidden">
                <span className="block truncate text-sm font-medium text-kumo-strong">
                  {liveTitle ?? 'Zeee'}
                </span>
              </div>

              {liveTitle ? (
                <nav
                  className="hidden min-w-0 items-center gap-2 md:flex"
                  aria-label="パンくずリスト"
                >
                  <Link
                    className="shrink-0 text-sm text-kumo-subtle no-underline hover:text-kumo-default"
                    href="/"
                  >
                    ページ
                  </Link>
                  <span className="text-kumo-subtle">/</span>
                  <span className="truncate text-sm font-medium text-kumo-strong">{liveTitle}</span>
                </nav>
              ) : null}

              <div className="ml-auto flex shrink-0 items-center gap-2">
                <MobilePageActions onSearch={openSearch} />

                <button
                  type="button"
                  onClick={openSearch}
                  className="hidden h-9 w-64 items-center gap-2 rounded-lg bg-kumo-base px-3 text-left text-sm text-kumo-subtle ring ring-kumo-line hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none lg:flex"
                  aria-label="ページを検索"
                  aria-haspopup="dialog"
                  aria-keyshortcuts="Meta+K Control+K"
                  title="ページを検索（Ctrl+K）"
                >
                  <MagnifyingGlassIcon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{query || 'ページを検索'}</span>
                  <kbd className="shrink-0 rounded border border-kumo-line px-1.5 py-0.5 text-[10px] text-kumo-subtle">
                    Ctrl K
                  </kbd>
                </button>

                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  aria-label="新しいページを作成"
                  aria-haspopup="dialog"
                  title="新しいページを作成"
                  onClick={() => setCreateOpen(true)}
                  className="size-11"
                >
                  <PlusIcon size={18} />
                </Button>

                <span
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-tint text-[11px] font-semibold text-kumo-strong"
                  aria-label={`ログイン中: ${user.displayName}`}
                  title={user.displayName}
                >
                  {user.displayName.slice(0, 1)}
                </span>
                <span className="hidden max-w-32 truncate text-sm text-kumo-subtle lg:inline">
                  {user.displayName}
                </span>
                <a
                  className="inline-flex size-11 items-center justify-center gap-1.5 rounded-md text-sm font-medium text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default lg:h-8 lg:w-auto lg:px-2"
                  href="/auth/logout"
                  aria-label="ログアウト"
                  title="ログアウト"
                >
                  <SignOutIcon size={15} />
                  <span className="hidden lg:inline">ログアウト</span>
                </a>
              </div>
            </div>
          </header>

          <main
            id="main"
            className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
          >
            {children}
          </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          recentPages={recentPagesWithTitles}
        />
        <CreatePageDialog open={createOpen} onOpenChange={setCreateOpen} />
      </Sidebar.Provider>
    </LinkProvider>
  );
}

function CloseMobileSidebarOnNavigate({
  activePageId,
  activeNav,
  query,
}: {
  activePageId?: string;
  activeNav?: NavSection;
  query?: string;
}) {
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [activePageId, activeNav, query, setOpenMobile]);

  return null;
}

function SkipToContent() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-kumo-base focus:px-3 focus:py-2 focus:text-sm focus:ring focus:ring-kumo-line"
    >
      本文へスキップ
    </a>
  );
}

function MobileNavButton() {
  const { openMobile, setOpenMobile } = useSidebar();

  return (
    <Button
      type="button"
      variant="ghost"
      shape="square"
      aria-label="ページ一覧を開く"
      aria-controls="pages-nav"
      aria-expanded={openMobile}
      onClick={() => setOpenMobile(true)}
      className="size-11 md:hidden"
    >
      <ListIcon size={18} />
    </Button>
  );
}

function MobilePageActions({ onSearch }: { onSearch: () => void }) {
  return (
    <div className="flex items-center gap-1 lg:hidden">
      <Button
        type="button"
        variant="ghost"
        shape="square"
        aria-label="ページを検索"
        aria-haspopup="dialog"
        title="ページを検索"
        onClick={onSearch}
        className="size-11"
      >
        <MagnifyingGlassIcon size={18} />
      </Button>
    </div>
  );
}

function Brand() {
  return (
    <Link
      className="flex shrink-0 items-center gap-2 text-kumo-strong no-underline"
      href="/"
      aria-label="Zeee ホーム"
      title="ホーム"
    >
      <ZeeeLogo className="h-6 w-auto" />
    </Link>
  );
}
