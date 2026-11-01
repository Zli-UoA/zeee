import { defineHandler, defineHead } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import { listDeletedPages, listPageNavigation } from '../src/server/db';
import { readRecentPages } from '../src/server/recent';
import { jsonError } from '../src/server/http';
import { PaginationError, parsePagination } from '../src/server/pagination';
import type { RecentPage } from '../src/shared/recent';
import type { DeletedPageSummary, Env, PageNavigation, SessionUser } from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageNavigation[];
  recentPages: RecentPage[];
  deletedPages: DeletedPageSummary[];
  nextCursor: string | null;
  cursor: string | null;
  limit: number;
  loginUrl: string;
};

export const head = defineHead<Props>(() => ({ title: 'ゴミ箱' }));

export const loader = defineHandler(async (c): Promise<Props | Response> => {
  const user = await getSessionUser(c);
  if (!user) {
    return {
      user: null,
      pages: [],
      recentPages: [],
      deletedPages: [],
      nextCursor: null,
      cursor: null,
      limit: 50,
      loginUrl: loginPath(c, '/trash'),
    };
  }

  const env = c.env as Env;
  try {
    const options = parsePagination(new URL(c.req.url).searchParams);
    const [pages, slice] = await Promise.all([
      listPageNavigation(env.DB),
      listDeletedPages(env.DB, options),
    ]);
    return {
      user,
      pages,
      recentPages: readRecentPages(c, pages, user.id),
      deletedPages: slice.items,
      nextCursor: slice.nextCursor,
      cursor: options.cursor ?? null,
      limit: slice.limit,
      loginUrl: loginPath(c, '/trash'),
    };
  } catch (error) {
    if (error instanceof PaginationError) return jsonError(c, 400, error.message);
    throw error;
  }
});
