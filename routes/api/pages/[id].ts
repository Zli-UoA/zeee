import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import { getPage, recordAudit, softDeletePage, updatePageTitle } from '../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../src/server/http';
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

  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  const title = (body?.title ?? '').trim().slice(0, 200);
  if (!title) return jsonError(c, 400, 'title is required');

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const page = await getPage(env.DB, pageId);
  if (!page) return jsonError(c, 404, 'page not found');
  await updatePageTitle(env.DB, pageId, title, page.title, user.id);
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
