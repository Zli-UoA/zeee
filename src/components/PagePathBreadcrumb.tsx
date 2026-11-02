import { Fragment } from 'react';
import { Link } from '@void/react';
import { pagePathContext, pagePathSegments, pagePathTrail } from '../shared/pagePath';

type BreadcrumbProps = {
  title: string;
  className?: string;
};

export function PagePathBreadcrumb({ title, className }: BreadcrumbProps) {
  const trail = pagePathTrail(title);
  if (!trail) {
    return (
      <nav aria-label="パンくずリスト" className={className}>
        <span className="text-sm font-medium text-kumo-strong">ページ</span>
      </nav>
    );
  }

  return (
    <nav
      aria-label="パンくずリスト"
      className={`flex min-w-0 items-center gap-2 ${className ?? ''}`}
    >
      <Link
        href="/"
        className="shrink-0 text-sm text-kumo-subtle no-underline hover:text-kumo-default"
      >
        ページ
      </Link>
      {trail.directories.map((directory) => (
        <Fragment key={directory.path}>
          <span aria-hidden="true" className="text-kumo-subtle">
            /
          </span>
          <Link
            href={`/?dir=${encodeURIComponent(directory.path)}`}
            className="shrink-0 truncate text-sm text-kumo-subtle no-underline hover:text-kumo-default"
          >
            {directory.name}
          </Link>
        </Fragment>
      ))}
      <span aria-hidden="true" className="text-kumo-subtle">
        /
      </span>
      <span
        aria-current="page"
        className="truncate text-sm font-medium text-kumo-strong"
        title={title}
      >
        {trail.current.name}
      </span>
    </nav>
  );
}

export function DirectoryPathBreadcrumb({ path, className }: { path: string; className?: string }) {
  const segments = pagePathSegments(path);
  return (
    <nav
      aria-label="ディレクトリ"
      className={`flex min-w-0 flex-wrap items-center gap-2 ${className ?? ''}`}
    >
      <Link
        href="/"
        className="shrink-0 text-sm text-kumo-subtle no-underline hover:text-kumo-default"
      >
        ページ
      </Link>
      {segments.map((segment, index) => {
        const current = index === segments.length - 1;
        const segmentPath = segments.slice(0, index + 1).join('/');
        return (
          <Fragment key={segmentPath}>
            <span aria-hidden="true" className="text-kumo-subtle">
              /
            </span>
            {current ? (
              <span aria-current="page" className="truncate text-sm font-medium text-kumo-strong">
                {segment}
              </span>
            ) : (
              <Link
                href={`/?dir=${encodeURIComponent(segmentPath)}`}
                className="shrink-0 truncate text-sm text-kumo-subtle no-underline hover:text-kumo-default"
              >
                {segment}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export function PagePathContext({ title }: { title: string }) {
  const context = pagePathContext(title);
  return (
    <span className="text-xs text-kumo-subtle" data-kind="page-path-context">
      {context || 'ルート'}
    </span>
  );
}
