import { defineHandler, defineHead } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import {
  createPage,
  listPages,
  recordAudit,
  searchPages,
  listPageNavigation,
} from '../src/server/db';
import { jsonError, redirectTo, sameOrigin } from '../src/server/http';
import { readRecentPages } from '../src/server/recent';
import { normalizeDirectoryPath } from '../src/shared/pagePath';
import type { RecentPage } from '../src/shared/recent';
import { PaginationError, parsePagination, parsePageSort } from '../src/server/pagination';
import type {
  PageNavigation,
  Env,
  PageSort,
  PageSummary,
  SearchResult,
  SessionUser,
} from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  sidebarPages: PageNavigation[];
  nextCursor: string | null;
  cursor: string | null;
  limit: number;
  recentPages: RecentPage[];
  query: string;
  dir: string;
  sort: PageSort;
  results: SearchResult[];
  now: number;
  loginUrl: string;
};

export const head = defineHead<Props>((_c, props) => ({
  title: props.query ? '検索結果' : props.dir || 'ページ',
}));

export const loader = defineHandler(async (c): Promise<Props | Response> => {
  const url = new URL(c.req.url);
  const dir = normalizeDirectoryPath(url.searchParams.get('dir'));
  const user = await getSessionUser(c);
  if (!user) {
    return {
      user: null,
      pages: [],
      nextCursor: null,
      cursor: null,
      limit: 50,
      sidebarPages: [],
      recentPages: [],
      query: '',
      dir,
      sort: 'updated',
      results: [],
      now: Date.now(),
      loginUrl: loginPath(c, '/'),
    };
  }

  const env = c.env as Env;
  const query = (url.searchParams.get('q') ?? '').trim();
  try {
    const sort = parsePageSort(url.searchParams.get('sort'));
    const options = parsePagination(url.searchParams);
    const [sidebarPages, slice] = await Promise.all([
      listPageNavigation(env.DB),
      query ? searchPages(env.DB, query, options) : listPages(env.DB, { ...options, sort }),
    ]);
    return {
      user,
      pages: query ? [] : (slice.items as PageSummary[]),
      sidebarPages,
      recentPages: readRecentPages(c, sidebarPages, user.id),
      query,
      dir,
      sort,
      results: query ? (slice.items as SearchResult[]) : [],
      nextCursor: slice.nextCursor,
      cursor: options.cursor ?? null,
      limit: slice.limit,
      now: Date.now(),
      loginUrl: loginPath(c, '/'),
    };
  } catch (error) {
    if (error instanceof PaginationError) return jsonError(c, 400, error.message);
    throw error;
  }
});

export const action = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return redirectTo(c, loginPath(c, '/'));
  if (!sameOrigin(c)) return c.text('Forbidden', 403);

  const body = await c.req.parseBody();
  const rawTitle = body.title;
  const title = (typeof rawTitle === 'string' ? rawTitle : '').trim().slice(0, 200);
  if (!title) return redirectTo(c, '/');

  const env = c.env as Env;
  const page = await createPage(env.DB, title, user.id);
  await recordAudit(env.DB, user.id, 'page.create', 'page', page.id);
  return redirectTo(c, `/pages/${page.id}`);
});
