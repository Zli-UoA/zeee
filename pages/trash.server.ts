import { defineHandler, defineHead } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import { listDeletedPages, listPages } from '../src/server/db';
import { readRecentPages } from '../src/server/recent';
import type { RecentPage } from '../src/shared/recent';
import type { DeletedPageSummary, Env, PageSummary, SessionUser } from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  recentPages: RecentPage[];
  deletedPages: DeletedPageSummary[];
  loginUrl: string;
};

export const head = defineHead<Props>(() => ({ title: 'ゴミ箱' }));

export const loader = defineHandler(async (c): Promise<Props> => {
  const user = await getSessionUser(c);
  if (!user) {
    return {
      user: null,
      pages: [],
      recentPages: [],
      deletedPages: [],
      loginUrl: loginPath(c, '/trash'),
    };
  }

  const env = c.env as Env;
  const [pages, deletedPages] = await Promise.all([listPages(env.DB), listDeletedPages(env.DB)]);
  return {
    user,
    pages,
    recentPages: readRecentPages(c, pages, user.id),
    deletedPages,
    loginUrl: loginPath(c, '/trash'),
  };
});
