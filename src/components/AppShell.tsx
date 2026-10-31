import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Input, Sidebar, Text, useSidebar } from '@cloudflare/kumo';
import {
  ClockCounterClockwiseIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { CommandPalette, type CommandPaletteIntent } from './CommandPalette';
import { sidebarPageLists } from '../client/sidebarPages';
import { useRecentPages } from '../client/useRecentPages';
import type { PageSummary, SessionUser } from '../server/types';

type NavSection = 'trash';

type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  activePageId?: string;
  activeTitle?: string;
  activeNav?: NavSection;
  query?: string;
  children: ReactNode;
};

export function AppShell({
  user,
  pages,
  activePageId,
  activeTitle,
  activeNav,
  query,
  children,
}: Props) {
  const [livePages, setLivePages] = useState(pages);
  const [liveTitle, setLiveTitle] = useState(activeTitle);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIntent, setPaletteIntent] = useState<CommandPaletteIntent>('search');
  const { recentPages, recordVisit } = useRecentPages(user?.id);

  const recentPagesWithTitles = useMemo(
    () =>
      recentPages.map((page) => {
        const current = livePages.find((candidate) => candidate.id === page.id);
        return current ? { ...page, title: current.title } : page;
      }),
    [recentPages, livePages],
  );

  const { recentPages: sidebarRecentPages, otherPages } = useMemo(
    () => sidebarPageLists(livePages, recentPagesWithTitles),
    [livePages, recentPagesWithTitles],
  );

  const isHome = !activePageId && activeNav === undefined;
  const isTrash = activeNav === 'trash';

  useEffect(() => {
    setLivePages(pages);
    setLiveTitle(activeTitle);
  }, [pages, activeTitle]);

  useEffect(() => {
    if (!user || !activePageId || !liveTitle) return;
    recordVisit({ id: activePageId, title: liveTitle });
  }, [user, activePageId, liveTitle, recordVisit]);

  useEffect(() => {
    if (!user) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setPaletteIntent('search');
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [user]);

  function openPalette(intent: CommandPaletteIntent) {
    setPaletteIntent(intent);
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

  useEffect(() => {
    document.title = liveTitle ? `${liveTitle} | Zeee` : query ? '検索結果 | Zeee' : 'Zeee';
  }, [liveTitle, query]);

  if (!user) {
    return (
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
    );
  }

  return (
    <Sidebar.Provider collapsible="offcanvas" className="min-h-svh bg-kumo-canvas">
      <SkipToContent />
      <Sidebar id="pages-nav" className="md:sticky md:top-0 md:h-svh">
        <Sidebar.Header className="h-14 justify-between px-3.5">
          <Brand />
          <Sidebar.Close className="size-8 md:hidden" aria-label="ページ一覧を閉じる" />
        </Sidebar.Header>

        <Sidebar.Content>
          <form
            method="post"
            action="/"
            aria-label="新しいページ"
            className="mb-5 flex flex-col gap-2"
          >
            <Input
              name="title"
              placeholder="ページタイトル"
              aria-label="新しいページのタイトル"
              required
              maxLength={200}
            />
            <Button
              type="submit"
              variant="primary"
              icon={<PlusIcon size={14} />}
              className="w-full"
            >
              作成
            </Button>
          </form>

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
            <Sidebar.GroupLabel>ページ</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                href="/"
                active={isHome}
                aria-current={isHome ? 'page' : undefined}
              >
                すべてのページ
              </Sidebar.MenuButton>
              {otherPages.map((page) => (
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
                <a
                  className="shrink-0 text-sm text-kumo-subtle no-underline hover:text-kumo-default"
                  href="/"
                >
                  ページ
                </a>
                <span className="text-kumo-subtle">/</span>
                <span className="truncate text-sm font-medium text-kumo-strong">{liveTitle}</span>
              </nav>
            ) : null}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <MobilePageActions
                onSearch={() => openPalette('search')}
                onCreate={() => openPalette('create')}
              />

              <form method="get" action="/" role="search" className="hidden lg:block">
                <Input
                  name="q"
                  type="search"
                  defaultValue={query}
                  placeholder="ページを検索"
                  aria-label="ページを検索"
                  enterKeyHint="search"
                  className="w-64"
                />
              </form>

              <span
                className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-tint text-[11px] font-semibold text-kumo-strong"
                aria-label={`ログイン中: ${user.displayName}`}
                title={user.displayName}
              >
                {user.displayName.slice(0, 1)}
              </span>
              <span className="hidden max-w-32 truncate text-xs text-kumo-subtle lg:inline">
                {user.displayName}
              </span>
              <a
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-kumo-subtle no-underline hover:bg-kumo-tint hover:text-kumo-default"
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
        intent={paletteIntent}
        onOpenChange={setPaletteOpen}
        recentPages={recentPagesWithTitles}
      />
    </Sidebar.Provider>
  );
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

function MobilePageActions({ onSearch, onCreate }: { onSearch: () => void; onCreate: () => void }) {
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
      <Button
        type="button"
        variant="ghost"
        shape="square"
        aria-label="新しいページを作成"
        aria-haspopup="dialog"
        title="新しいページを作成"
        onClick={onCreate}
        className="size-11"
      >
        <PlusIcon size={18} />
      </Button>
    </div>
  );
}

function Brand() {
  return (
    <a className="flex shrink-0 items-center gap-2 no-underline" href="/">
      <span className="text-lg font-semibold tracking-tight text-kumo-strong">Zeee</span>
    </a>
  );
}
