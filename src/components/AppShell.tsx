import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@void/react';
import { Button, LinkProvider, Sidebar, Text, useSidebar } from '@cloudflare/kumo';
import {
  ClockCounterClockwiseIcon,
  FileTextIcon,
  HouseIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import { AppLink } from './AppLink';
import { CommandPalette } from './CommandPalette';
import { CreatePageDialog } from './CreatePageDialog';
import { PagePathBreadcrumb } from './PagePathBreadcrumb';
import { SpaceNav } from './SpaceNav';
import { ZeeeLogo } from './ZeeeLogo';
import { sidebarPageLists } from '../client/sidebarPages';
import { useRecentPages, type RecentPage } from '../client/useRecentPages';
import {
  directorySpace,
  listRootPages,
  pagePathName,
  pageSpace,
  parsePagePath,
} from '../shared/pagePath';
import type { PageNavigation, SessionUser } from '../server/types';

type NavSection = 'trash' | 'browse';

type Props = {
  user: SessionUser | null;
  pages: PageNavigation[];
  initialRecentPages?: RecentPage[];
  activePageId?: string;
  activeTitle?: string;
  activeNav?: NavSection;
  query?: string;
  dir?: string;
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
  dir,
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

  const { recentPages: sidebarRecentPages } = useMemo(
    () => sidebarPageLists(livePages, recentPagesWithTitles),
    [livePages, recentPagesWithTitles],
  );

  const isTrash = activeNav === 'trash';
  const isBrowse = activeNav === 'browse';
  const activeSpace = directorySpace(dir ?? '') || pageSpace(liveTitle ?? '');
  const createInitialDirectory = dir || parsePagePath(liveTitle ?? '')?.parentPath || '';
  const isHome = !activePageId && !dir && !isTrash && !isBrowse;

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
        <SidebarPreference />
        <CloseMobileSidebarOnNavigate
          activePageId={activePageId}
          activeNav={activeNav}
          query={query}
          dir={dir}
        />
        <SkipToContent />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 h-14 border-b border-kumo-line bg-kumo-base/90 backdrop-blur">
            <div className="flex h-full w-full items-center gap-2 px-3 sm:px-4 lg:px-6">
              <div className="flex shrink-0 items-center gap-1.5">
                <Brand />
                <MobileNavButton />
                <DesktopSidebarToggle />
              </div>

              <div
                aria-hidden="true"
                className="mx-1 hidden h-6 w-px shrink-0 bg-kumo-line sm:block"
              />

              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div className="hidden min-w-0 sm:block md:hidden">
                  <span className="block truncate text-sm font-medium text-kumo-strong">
                    {liveTitle ? pagePathName(liveTitle) : 'Zeee'}
                  </span>
                </div>

                {liveTitle ? (
                  <PagePathBreadcrumb title={liveTitle} className="hidden min-w-0 md:flex" />
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
            </div>
          </header>

          <div className="flex min-h-0 min-w-0 flex-1">
            <AppSidebar
              pages={livePages}
              recentPages={sidebarRecentPages}
              activePageId={activePageId}
              liveTitle={liveTitle}
              activeDirectory={dir}
              activeSpace={activeSpace}
              isHome={isHome}
              isTrash={isTrash}
              isBrowse={isBrowse}
            />

            <main
              id="main"
              className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
            >
              {children}
            </main>
          </div>
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          recentPages={recentPagesWithTitles}
        />
        <CreatePageDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          pages={livePages}
          initialDirectory={createInitialDirectory}
        />
      </Sidebar.Provider>
    </LinkProvider>
  );
}

const SIDEBAR_OPEN_STORAGE_KEY = 'zeee.sidebar-open.v1';

type AppSidebarProps = {
  pages: PageNavigation[];
  recentPages: RecentPage[];
  activePageId?: string;
  liveTitle?: string;
  activeDirectory?: string;
  activeSpace: string;
  isHome: boolean;
  isTrash: boolean;
  isBrowse: boolean;
};

function AppSidebar({
  pages,
  recentPages,
  activePageId,
  liveTitle,
  activeDirectory,
  activeSpace,
  isHome,
  isTrash,
  isBrowse,
}: AppSidebarProps) {
  const { open, isMobile } = useSidebar();
  const rootPages = useMemo(() => listRootPages(pages), [pages]);

  return (
    <Sidebar
      id="pages-nav"
      className="md:sticky md:top-14 md:h-[calc(100svh-3.5rem)]"
      inert={!isMobile && !open ? true : undefined}
    >
      <Sidebar.Header className="h-14 justify-between px-3 md:hidden">
        <Brand />
        <Sidebar.Close className="size-8" aria-label="ページ一覧を閉じる" />
      </Sidebar.Header>

      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              href="/"
              icon={HouseIcon}
              active={isHome}
              aria-current={isHome ? 'page' : undefined}
            >
              ホーム
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>

        {recentPages.length > 0 ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>最近見たページ</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {recentPages.map((page) => (
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

        <SpaceNav
          pages={pages}
          activeSpace={activeSpace}
          activePageId={activePageId}
          activeTitle={liveTitle}
          activeDirectory={activeDirectory}
          isMobile={isMobile}
        />

        {rootPages.length > 0 ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>ルートページ</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {rootPages.map((page) => (
                <Sidebar.MenuButton
                  href={`/pages/${page.id}`}
                  size="sm"
                  icon={FileTextIcon}
                  active={page.id === activePageId}
                  aria-current={page.id === activePageId ? 'page' : undefined}
                  key={page.id}
                >
                  {page.name}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        ) : null}

        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              href="/browse"
              icon={TreeStructureIcon}
              active={isBrowse}
              aria-current={isBrowse ? 'page' : undefined}
            >
              すべてのページ
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>

        {pages.length === 0 ? (
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
  );
}

function SidebarPreference() {
  const { open, setOpen, isMobile } = useSidebar();
  const restoredRef = useRef(false);
  const lastOpenRef = useRef(open);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
      if (stored !== 'open' && stored !== 'closed') return;
      setOpen(stored === 'open');
    } catch {
      return;
    }
  }, [setOpen]);

  useEffect(() => {
    if (isMobile || open === lastOpenRef.current) return;
    lastOpenRef.current = open;
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, open ? 'open' : 'closed');
    } catch {
      return;
    }
  }, [open, isMobile]);

  return null;
}

function CloseMobileSidebarOnNavigate({
  activePageId,
  activeNav,
  query,
  dir,
}: {
  activePageId?: string;
  activeNav?: NavSection;
  query?: string;
  dir?: string;
}) {
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [activePageId, activeNav, query, dir, setOpenMobile]);

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

function DesktopSidebarToggle() {
  const { open } = useSidebar();

  return (
    <Sidebar.Trigger
      aria-label={open ? 'ページ一覧を閉じる' : 'ページ一覧を開く'}
      aria-controls="pages-nav"
      title={open ? 'ページ一覧を閉じる' : 'ページ一覧を開く'}
      className="hidden md:flex"
    />
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
