import { defineHandler } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import {
  createPage,
  listPages,
  recordAudit,
  searchPages,
  sortPageSummaries,
} from '../src/server/db';
import { redirectTo, sameOrigin } from '../src/server/http';
import type { Env, PageSort, PageSummary, SearchResult, SessionUser } from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  query: string;
  sort: PageSort;
  results: SearchResult[];
  now: number;
  loginUrl: string;
};

function parseSort(value: string | null): PageSort {
  if (value === 'created' || value === 'title') return value;
  return 'updated';
}

export const loader = defineHandler(async (c): Promise<Props> => {
  const user = await getSessionUser(c);
  if (!user) {
    return {
      user: null,
      pages: [],
      query: '',
      sort: 'updated',
      results: [],
      now: Date.now(),
      loginUrl: loginPath(c, '/'),
    };
  }

  const env = c.env as Env;
  const url = new URL(c.req.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const sort = parseSort(url.searchParams.get('sort'));
  const pages = sortPageSummaries(await listPages(env.DB), sort);
  return {
    user,
    pages,
    query,
    sort,
    results: query ? await searchPages(env.DB, query) : [],
    now: Date.now(),
    loginUrl: loginPath(c, '/'),
  };
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
