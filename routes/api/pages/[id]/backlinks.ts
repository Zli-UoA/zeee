import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { listBacklinks } from '../../../../src/server/backlinks';
import { jsonError, pathParam } from '../../../../src/server/http';
import type { Env } from '../../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  return { backlinks: await listBacklinks((c.env as Env).DB, pathParam(c, 'id')) };
});
