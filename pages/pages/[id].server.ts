import { defineHandler } from 'void';
import { getSessionUser, loginPath } from '../../src/server/auth';
import { getPage, listRevisions } from '../../src/server/db';
import { pathParam } from '../../src/server/http';
import type { Env, PageRecord, RevisionRecord, SessionUser } from '../../src/server/types';

export type Props = {
  user: SessionUser | null;
  page: PageRecord | null;
  revisions: RevisionRecord[];
  loginUrl: string;
};

export const loader = defineHandler(async (c): Promise<Props> => {
  const id = pathParam(c, 'id');
  const loginUrl = loginPath(c, `/pages/${id}`);
  const user = await getSessionUser(c);
  if (!user) return { user: null, page: null, revisions: [], loginUrl };

  const env = c.env as Env;
  const page = await getPage(env.DB, id);
  if (!page) return { user, page: null, revisions: [], loginUrl };

  return {
    user,
    page,
    revisions: await listRevisions(env.DB, id),
    loginUrl,
  };
});
