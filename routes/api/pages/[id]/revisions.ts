import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { listRevisions } from '../../../../src/server/db';
import { jsonError, pathParam } from '../../../../src/server/http';
import type { Env } from '../../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  return { revisions: await listRevisions((c.env as Env).DB, pathParam(c, 'id')) };
});
