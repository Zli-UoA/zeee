import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { PathConflictError, recordAudit, undeletePage } from '../../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import type { Env } from '../../../../src/server/types';

export const POST = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  let restored: boolean;
  try {
    restored = await undeletePage(env.DB, pageId);
  } catch (error) {
    if (error instanceof PathConflictError) return jsonError(c, 409, 'PATH_CONFLICT');
    throw error;
  }
  if (!restored) return jsonError(c, 404, 'deleted page not found');
  await recordAudit(env.DB, user.id, 'page.undelete', 'page', pageId);
  return { ok: true };
});
