import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import { listPageNavigation } from '../../../src/server/db';
import { jsonError } from '../../../src/server/http';
import type { Env, PageTreeNode } from '../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const pages: PageTreeNode[] = await listPageNavigation((c.env as Env).DB);
  return { pages };
});
