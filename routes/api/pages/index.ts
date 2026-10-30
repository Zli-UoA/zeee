import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import { createPage, listPages, recordAudit } from '../../../src/server/db';
import { jsonError, sameOrigin } from '../../../src/server/http';
import type { Env } from '../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const env = c.env as Env;
  return { pages: await listPages(env.DB) };
});

export const POST = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  const title = (body?.title ?? '').trim().slice(0, 200) || 'Untitled';
  const env = c.env as Env;
  const page = await createPage(env.DB, title, user.id);
  await recordAudit(env.DB, user.id, 'page.create', 'page', page.id);
  return c.json({ page }, 201);
});
