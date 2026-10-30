import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { getRevision, recordAudit } from '../../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import { roomFetch } from '../../../../src/server/rooms';
import type { Env } from '../../../../src/server/types';

export const POST = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const body = (await c.req.json().catch(() => null)) as { version?: number } | null;
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) return jsonError(c, 400, 'version is required');

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const revision = await getRevision(env.DB, pageId, version);
  if (!revision) return jsonError(c, 404, 'revision not found');

  const response = await roomFetch(pageId, '/replace', user, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: revision.markdown }),
  });
  if (!response.ok) return response;
  await recordAudit(env.DB, user.id, 'page.restore', 'page', pageId);
  return response;
});
