import { defineHandler, defineHead } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import { listPageNavigation } from '../src/server/db';
import { readRecentPages } from '../src/server/recent';
import type { RecentPage } from '../src/shared/recent';
import type { Env, PageNavigation, SessionUser } from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageNavigation[];
  recentPages: RecentPage[];
  loginUrl: string;
};

export const head = defineHead<Props>(() => ({ title: 'すべてのページ' }));

export const loader = defineHandler(async (c): Promise<Props> => {
  const user = await getSessionUser(c);
  if (!user) {
    return {
      user: null,
      pages: [],
      recentPages: [],
      loginUrl: loginPath(c, '/browse'),
    };
  }

  const env = c.env as Env;
  const pages = await listPageNavigation(env.DB);
  return {
    user,
    pages,
    recentPages: readRecentPages(c, pages, user.id),
    loginUrl: loginPath(c, '/browse'),
  };
});
