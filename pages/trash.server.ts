import { defineHandler } from 'void';
import { getSessionUser, loginPath } from '../src/server/auth';
import { listDeletedPages, listPages } from '../src/server/db';
import type { DeletedPageSummary, Env, PageSummary, SessionUser } from '../src/server/types';

export type Props = {
  user: SessionUser | null;
  pages: PageSummary[];
  deletedPages: DeletedPageSummary[];
  loginUrl: string;
};

export const loader = defineHandler(async (c): Promise<Props> => {
  const user = await getSessionUser(c);
  if (!user) {
    return { user: null, pages: [], deletedPages: [], loginUrl: loginPath(c, '/trash') };
  }

  const env = c.env as Env;
  const [pages, deletedPages] = await Promise.all([listPages(env.DB), listDeletedPages(env.DB)]);
  return { user, pages, deletedPages, loginUrl: loginPath(c, '/trash') };
});
