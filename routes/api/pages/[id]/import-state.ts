import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { recordAudit } from '../../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import { roomFetch } from '../../../../src/server/rooms';
import type { Env } from '../../../../src/server/types';
import { MAX_STATE_IMPORT_BYTES } from '../../../../src/shared/yjs';

export const POST = defineHandler(async (c) => {
  const env = c.env as Env;
  // Migration-only endpoint. It must not be reachable during normal operation.
  if (env.ZEEE_MIGRATION_IMPORT !== '1') return jsonError(c, 404, 'not found');

  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STATE_IMPORT_BYTES) {
    return Response.json({ error: 'state is too large' }, { status: 413 });
  }

  const body = await c.req.arrayBuffer();
  const pageId = pathParam(c, 'id');
  const response = await roomFetch(pageId, '/import-state', user, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) return response;
  await recordAudit(env.DB, user.id, 'page.state_import', 'page', pageId);
  return response;
});
