import { useEffect, useId, useMemo, useState } from 'react';
import { Sidebar } from '@cloudflare/kumo';
import { CaretRightIcon, FolderIcon } from '@phosphor-icons/react';
import { listSpaces, type PagePathPage } from '../shared/pagePath';
import { PageTree } from './PageTree';

type Props = {
  pages: PagePathPage[];
  activeSpace: string;
  activePageId?: string;
  activeTitle?: string;
  activeDirectory?: string;
  isMobile: boolean;
};

export function SpaceNav({
  pages,
  activeSpace,
  activePageId,
  activeTitle,
  activeDirectory,
  isMobile,
}: Props) {
  const spaces = useMemo(() => listSpaces(pages), [pages]);
  const baseId = useId().replaceAll(':', '');
  const [expandedSpace, setExpandedSpace] = useState(activeSpace);

  useEffect(() => {
    setExpandedSpace(activeSpace);
  }, [activeSpace]);

  if (!spaces.length) return null;

  function toggleSpace(path: string) {
    setExpandedSpace((current) => (current === path ? '' : path));
  }

  return (
    <Sidebar.Group>
      <Sidebar.GroupLabel>スペース</Sidebar.GroupLabel>
      <Sidebar.Menu>
        {spaces.map((space, index) => {
          const selected = space.path === activeSpace;
          const expanded = !isMobile && expandedSpace === space.path;
          const treeId = `${baseId}-space-${index}`;
          return (
            <Sidebar.MenuItem key={space.path}>
              <div className="flex items-center">
                {isMobile ? null : (
                  <button
                    type="button"
                    onClick={() => toggleSpace(space.path)}
                    aria-label={`${expanded ? '折りたたむ' : '展開する'}: ${space.name}`}
                    aria-expanded={expanded}
                    aria-controls={expanded ? treeId : undefined}
                    className="grid size-6 shrink-0 place-items-center rounded text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
                  >
                    <CaretRightIcon
                      size={12}
                      className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                )}
                <Sidebar.MenuButton
                  href={`/?dir=${encodeURIComponent(space.path)}`}
                  size="sm"
                  icon={FolderIcon}
                  active={selected}
                  aria-current={activeDirectory === space.path ? 'location' : undefined}
                  onClick={() => setExpandedSpace(space.path)}
                  title={`${space.name}（${space.pageCount}ページ）`}
                  className="min-w-0 flex-1"
                >
                  {space.name}
                </Sidebar.MenuButton>
              </div>
              {expanded ? (
                <div id={treeId} className="mt-0.5 ml-3 border-l border-kumo-line pl-1">
                  <PageTree
                    pages={pages}
                    scope={space.path}
                    activePageId={activePageId}
                    activeTitle={activeTitle}
                    activeDirectory={activeDirectory}
                    variant="sidebar"
                    ariaLabel={`${space.name} のページツリー`}
                  />
                </div>
              ) : null}
            </Sidebar.MenuItem>
          );
        })}
      </Sidebar.Menu>
    </Sidebar.Group>
  );
}
