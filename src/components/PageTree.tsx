import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@void/react';
import { CaretRightIcon, FileTextIcon, FolderIcon } from '@phosphor-icons/react';
import {
  ancestorDirectoryPaths,
  buildPageTree,
  scopePageTree,
  type PagePathPage,
  type PageTreeNode,
} from '../shared/pagePath';

type Props = {
  pages: PagePathPage[];
  scope?: string;
  activePageId?: string;
  activeTitle?: string;
  activeDirectory?: string;
  variant?: 'sidebar' | 'content';
  ariaLabel?: string;
};

export function PageTree({
  pages,
  scope = '',
  activePageId,
  activeTitle,
  activeDirectory,
  variant = 'sidebar',
  ariaLabel = 'ページツリー',
}: Props) {
  const tree = useMemo(() => buildPageTree(pages), [pages]);
  const nodes = useMemo(() => scopePageTree(tree, scope), [tree, scope]);
  const focusPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const path of ancestorDirectoryPaths(activeTitle ?? '')) paths.add(path);
    if (activeDirectory) {
      for (const path of ancestorDirectoryPaths(activeDirectory)) paths.add(path);
      paths.add(activeDirectory);
    }
    if (scope) {
      for (const path of ancestorDirectoryPaths(scope)) paths.add(path);
      paths.add(scope);
    }
    return paths;
  }, [activeTitle, activeDirectory, scope]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusPaths));

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of focusPaths) next.add(path);
      return next;
    });
  }, [focusPaths]);

  function isExpanded(path: string) {
    return expanded.has(path) || focusPaths.has(path);
  }

  function expand(path: string) {
    setExpanded((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      next.add(path);
      return next;
    });
  }

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNodes(items: PageTreeNode[], depth: number): ReactNode {
    return items.map((node) => {
      if (node.kind === 'page') {
        const active = node.id === activePageId;
        return (
          <li key={`page:${node.id}`} role="treeitem" aria-selected={active}>
            <div style={{ paddingInlineStart: depth * 12 + 24 }}>
              <Link
                href={`/pages/${node.id}`}
                data-kind="page"
                aria-current={active ? 'page' : undefined}
                title={node.title}
                className={`flex min-w-0 items-center gap-1.5 rounded-md no-underline ${
                  variant === 'sidebar' ? 'min-h-8 px-2 text-sm' : 'min-h-10 px-3 text-sm'
                } ${
                  active
                    ? 'bg-kumo-tint font-medium text-kumo-strong'
                    : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
                }`}
              >
                <FileTextIcon size={16} className="shrink-0" />
                <span className="truncate">{node.name}</span>
              </Link>
            </div>
          </li>
        );
      }

      const open = isExpanded(node.path);
      const active = node.path === activeDirectory;
      return (
        <li
          key={`directory:${node.path}`}
          role="treeitem"
          aria-expanded={open}
          aria-selected={active}
        >
          <div className="flex items-center" style={{ paddingInlineStart: depth * 12 }}>
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-label={`${open ? '折りたたむ' : '展開する'}: ${node.name}`}
              aria-expanded={open}
              className="grid size-6 shrink-0 place-items-center rounded text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
            >
              <CaretRightIcon
                size={12}
                className={`transition-transform ${open ? 'rotate-90' : ''}`}
              />
            </button>
            <Link
              href={`/?dir=${encodeURIComponent(node.path)}`}
              onClick={() => expand(node.path)}
              data-kind="directory"
              aria-current={active ? 'location' : undefined}
              title={node.path}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md no-underline ${
                variant === 'sidebar' ? 'min-h-8 px-2 text-sm' : 'min-h-10 px-3 text-sm'
              } ${
                active
                  ? 'bg-kumo-tint font-medium text-kumo-strong'
                  : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
              }`}
            >
              <FolderIcon size={16} className="shrink-0" />
              <span className="truncate">{node.name}</span>
            </Link>
          </div>
          {open ? (
            <ul role="group" className="flex flex-col gap-0.5">
              {renderNodes(node.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  }

  return (
    <ul role="tree" aria-label={ariaLabel} className="flex flex-col gap-0.5">
      {renderNodes(nodes, 0)}
    </ul>
  );
}
