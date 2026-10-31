import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { permanentlyDeletePage, recordAudit } from '../../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import type { Env } from '../../../../src/server/types';

export const DELETE = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const deleted = await permanentlyDeletePage(env.DB, pageId);
  if (!deleted) return jsonError(c, 404, 'deleted page not found');
  await recordAudit(env.DB, user.id, 'page.permanent_delete', 'page', pageId);
  return { ok: true };
});
