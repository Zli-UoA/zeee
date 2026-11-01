import { Link } from '@void/react';

export function Pagination({
  path = '/',
  query = '',
  sort = 'updated',
  cursor,
  nextCursor,
  limit,
}: {
  path?: string;
  query?: string;
  sort?: string;
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
}) {
  function href(next: string | null) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (sort !== 'updated') params.set('sort', sort);
    params.set('limit', String(limit));
    if (next) params.set('cursor', next);
    return `${path}?${params}`;
  }
  if (!cursor && !nextCursor) return null;
  return (
    <nav aria-label="ページ送り" className="flex items-center justify-between gap-4 text-sm">
      {cursor ? (
        <Link href={href(null)} className="text-kumo-link">
          最初のページ
        </Link>
      ) : (
        <span />
      )}
      {nextCursor ? (
        <Link href={href(nextCursor)} className="text-kumo-link" rel="next">
          次のページ
        </Link>
      ) : null}
    </nav>
  );
}
