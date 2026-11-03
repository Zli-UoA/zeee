import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@void/react';
import { Button, DropdownMenu, LinkProvider, Sidebar, Text, useSidebar } from '@cloudflare/kumo';
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
import { PageTree } from './PageTree';
import { ZeeeLogo } from './ZeeeLogo';
import { sidebarPageLists } from '../client/sidebarPages';
import { useRecentPages, type RecentPage } from '../client/useRecentPages';
import { CREATE_PAGE_EVENT, type CreatePageEventDetail } from '../client/createPageEvents';
import { pagePathSegments } from '../shared/pagePath';
import type { PageNavigation, SessionUser } from '../server/types';

type NavSection = 'trash' | 'not-found';

type Props = {
  user: SessionUser | null;
  pages: PageNavigation[];
  initialRecentPages?: RecentPage[];
  activePageId?: string;
  activeTitle?: string;
  activeNav?: NavSection;
  query?: string;
  queryResultCount?: number;
  dir?: string;
  children: ReactNode;
};

const SIDEBAR_OPEN_STORAGE_KEY = 'zeee.sidebar-open.v1';
const SIDEBAR_DESKTOP_QUERY = '(min-width: 1280px)';

export function AppShell({
  user,
  pages,
  initialRecentPages = [],
  activePageId,
  activeTitle,
  activeNav,
  query,
  queryResultCount,
  dir,
  children,
}: Props) {
  const [livePages, setLivePages] = useState(pages);
  const [liveTitle, setLiveTitle] = useState(activeTitle);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitialValue, setCreateInitialValue] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const isNotFound = activeNav === 'not-found';

  const createContextPrefix = useMemo(() => {
    if (query && queryResultCount === 0) return query;
    if (dir) return `${dir}/`;
    if (activeTitle) {
      const parent = pagePathSegments(activeTitle).slice(0, -1).join('/');
      return parent ? `${parent}/` : '';
    }
    return '';
  }, [query, queryResultCount, dir, activeTitle]);

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
    if (typeof window === 'undefined') return;
    if (!window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches) {
      setSidebarOpen(false);
      return;
    }
    setSidebarOpen(readSidebarPreference() ?? true);
  }, []);

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
    const handleCreate = (event: Event) => {
      const detail = (event as CustomEvent<CreatePageEventDetail>).detail;
      setCreateInitialValue(typeof detail?.initialValue === 'string' ? detail.initialValue : '');
      setCreateOpen(true);
    };
    window.addEventListener(CREATE_PAGE_EVENT, handleCreate);
    return () => window.removeEventListener(CREATE_PAGE_EVENT, handleCreate);
  }, []);

  function openSearch() {
    setPaletteOpen(true);
  }

  function openCreate(initialValue: string) {
    setCreateInitialValue(initialValue);
    setCreateOpen(true);
  }

  function handleSidebarOpenChange(next: boolean) {
    setSidebarOpen(next);
    if (typeof window === 'undefined') return;
    if (!window.matchMedia(SIDEBAR_DESKTOP_QUERY).matches) return;
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, next ? 'open' : 'closed');
    } catch {
      return;
    }
  }

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
      <Sidebar.Provider
        collapsible="offcanvas"
        className="min-h-svh bg-kumo-canvas"
        open={sidebarOpen}
        onOpenChange={handleSidebarOpenChange}
        animationDuration={0}
      >
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

              <div className="hidden min-w-0 items-center lg:flex">
                <button
                  type="button"
                  onClick={openSearch}
                  className="flex h-9 w-64 items-center gap-2 rounded-lg bg-kumo-base px-3 text-left text-sm text-kumo-subtle ring ring-kumo-line hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
                  aria-label="ページを検索"
                  aria-haspopup="dialog"
                  aria-keyshortcuts="Meta+K Control+K"
                  title="ページを検索（Ctrl+K）"
                >
                  <MagnifyingGlassIcon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">ページを検索</span>
                  <kbd className="shrink-0 rounded border border-kumo-line px-1.5 py-0.5 text-[10px] text-kumo-subtle">
                    Ctrl K
                  </kbd>
                </button>
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <MobileSearchButton onSearch={openSearch} />
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  aria-label="新規ページ"
                  aria-haspopup="dialog"
                  title="新規ページ"
                  onClick={() => openCreate(createContextPrefix)}
                  className="size-11"
                >
                  <PlusIcon size={18} />
                </Button>
                <AccountMenu user={user} />
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
              isAllPages={!activePageId && !isTrash && !isNotFound && !dir}
              isTrash={isTrash}
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
          recentPages={sidebarRecentPages}
        />
        <CreatePageDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          pages={livePages}
          initialValue={createInitialValue}
        />
      </Sidebar.Provider>
    </LinkProvider>
  );
}

function readSidebarPreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    return null;
  }
  return null;
}

type AppSidebarProps = {
  pages: PageNavigation[];
  recentPages: RecentPage[];
  activePageId?: string;
  liveTitle?: string;
  activeDirectory?: string;
  isAllPages: boolean;
  isTrash: boolean;
};

function AppSidebar({
  pages,
  recentPages,
  activePageId,
  liveTitle,
  activeDirectory,
  isAllPages,
  isTrash,
}: AppSidebarProps) {
  const { open, isMobile } = useSidebar();

  return (
    <Sidebar
      id="pages-nav"
      className="md:sticky md:top-14 md:h-[calc(100svh-3.5rem)]"
      inert={!isMobile && !open ? true : undefined}
    >
      <Sidebar.Header className="h-14 justify-between px-3 md:hidden">
        <Brand />
        <Sidebar.Close className="size-8" aria-label="サイドバーを閉じる" />
      </Sidebar.Header>

      <Sidebar.Content>
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

        <Sidebar.Group>
          <Sidebar.GroupLabel>
            <Link
              href="/"
              aria-current={isAllPages ? 'page' : undefined}
              className={`inline-flex rounded-sm no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none ${
                isAllPages
                  ? 'font-semibold text-kumo-strong'
                  : 'text-kumo-subtle hover:text-kumo-default'
              }`}
            >
              すべてのページ
            </Link>
          </Sidebar.GroupLabel>
          <div className="px-1.5">
            <PageTree
              pages={pages}
              activePageId={activePageId}
              activeTitle={liveTitle}
              activeDirectory={activeDirectory}
            />
          </div>
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
  const previousLocationRef = useRef<string | null>(null);

  useEffect(() => {
    const location = `${activePageId ?? ''}|${activeNav ?? ''}|${query ?? ''}|${dir ?? ''}`;
    if (previousLocationRef.current === null) {
      previousLocationRef.current = location;
      return;
    }
    if (previousLocationRef.current === location) return;
    previousLocationRef.current = location;
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
      aria-label={open ? 'サイドバーを閉じる' : 'サイドバーを開く'}
      aria-controls="pages-nav"
      title={open ? 'サイドバーを閉じる' : 'サイドバーを開く'}
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
      aria-label="サイドバーを開く"
      aria-controls="pages-nav"
      aria-expanded={openMobile}
      onClick={() => setOpenMobile(true)}
      className="size-11 md:hidden"
    >
      <ListIcon size={18} />
    </Button>
  );
}

function MobileSearchButton({ onSearch }: { onSearch: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      shape="square"
      aria-label="ページを検索"
      aria-haspopup="dialog"
      title="ページを検索"
      onClick={onSearch}
      className="size-11 lg:hidden"
    >
      <MagnifyingGlassIcon size={18} />
    </Button>
  );
}

function AccountMenu({ user }: { user: SessionUser }) {
  const initial = user.displayName.trim().slice(0, 1) || '?';

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            shape="square"
            aria-label="アカウントメニュー"
            title="アカウントメニュー"
            className="size-11 rounded-full"
          >
            <span className="grid size-7 place-items-center rounded-full bg-kumo-tint text-[11px] font-semibold text-kumo-strong">
              {initial}
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content align="end" className="min-w-56">
        <div className="px-3 py-2">
          <p className="truncate text-sm font-medium text-kumo-strong">{user.displayName}</p>
          <p className="truncate text-sm text-kumo-subtle">@{user.username}</p>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.LinkItem href="/auth/logout" icon={<SignOutIcon size={16} />}>
          ログアウト
        </DropdownMenu.LinkItem>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function Brand() {
  return (
    <Link
      className="flex shrink-0 items-center gap-2 text-kumo-strong no-underline"
      href="/"
      aria-label="Zeee（すべてのページ）"
      title="すべてのページ"
    >
      <ZeeeLogo className="h-6 w-auto" />
    </Link>
  );
}
