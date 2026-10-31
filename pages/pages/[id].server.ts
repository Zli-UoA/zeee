import { defineHandler } from 'void';
import { getSessionUser, loginPath } from '../../src/server/auth';
import { getPage, listLinkTargets, listPages, listRevisions } from '../../src/server/db';
import { pathParam } from '../../src/server/http';
import type {
  Env,
  LinkTarget,
  PageRecord,
  PageSummary,
  RevisionRecord,
  SessionUser,
} from '../../src/server/types';

export type Props = {
  user: SessionUser | null;
  page: PageRecord | null;
  revisions: RevisionRecord[];
  pages: PageSummary[];
  linkTargets: LinkTarget[];
  loginUrl: string;
};

export const loader = defineHandler(async (c): Promise<Props> => {
  const id = pathParam(c, 'id');
  const loginUrl = loginPath(c, `/pages/${id}`);
  const user = await getSessionUser(c);
  if (!user) return { user: null, page: null, revisions: [], pages: [], linkTargets: [], loginUrl };

  const env = c.env as Env;
  const [page, pages, linkTargets] = await Promise.all([
    getPage(env.DB, id),
    listPages(env.DB),
    listLinkTargets(env.DB),
  ]);
  if (!page) return { user, page: null, revisions: [], pages, linkTargets, loginUrl };

  return {
    user,
    page,
    revisions: await listRevisions(env.DB, id),
    pages,
    linkTargets,
    loginUrl,
  };
});
