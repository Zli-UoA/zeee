import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import {
  getPage,
  PathConflictError,
  recordAudit,
  softDeletePage,
  updatePageTitle,
} from '../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../src/server/http';
import { INVALID_PATH, parsePagePath } from '../../../src/shared/pagePath';
import type { Env } from '../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const page = await getPage((c.env as Env).DB, pathParam(c, 'id'));
  if (!page) return jsonError(c, 404, 'page not found');
  return { page };
});

export const PATCH = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
  const parsed = parsePagePath(typeof body?.title === 'string' ? body.title : '');
  if (!parsed) return jsonError(c, 400, INVALID_PATH);
  const title = parsed.path;

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const page = await getPage(env.DB, pageId);
  if (!page) return jsonError(c, 404, 'page not found');
  try {
    await updatePageTitle(env.DB, pageId, title, page.title, user.id);
  } catch (error) {
    if (error instanceof PathConflictError) return jsonError(c, 409, 'PATH_CONFLICT');
    throw error;
  }
  await recordAudit(env.DB, user.id, 'page.rename', 'page', pageId);
  return { ok: true };
});

export const DELETE = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const page = await getPage(env.DB, pageId);
  if (!page) return jsonError(c, 404, 'page not found');
  await softDeletePage(env.DB, pageId);
  await recordAudit(env.DB, user.id, 'page.delete', 'page', pageId);
  return { ok: true };
});
