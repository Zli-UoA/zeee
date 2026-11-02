import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import { createPage, listPages, PathConflictError, recordAudit } from '../../../src/server/db';
import { jsonError, sameOrigin } from '../../../src/server/http';
import { PaginationError, parsePagination, parsePageSort } from '../../../src/server/pagination';
import type { Env } from '../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const env = c.env as Env;
  try {
    const params = new URL(c.req.url).searchParams;
    const sort = parsePageSort(params.get('sort'));
    const slice = await listPages(env.DB, { ...parsePagination(params), sort });
    return { pages: slice.items, nextCursor: slice.nextCursor, limit: slice.limit, sort };
  } catch (error) {
    if (error instanceof PaginationError) return jsonError(c, 400, error.message);
    throw error;
  }
});

export const POST = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  const title = (body?.title ?? '').trim().slice(0, 200) || 'Untitled';
  const env = c.env as Env;
  try {
    const page = await createPage(env.DB, title, user.id);
    await recordAudit(env.DB, user.id, 'page.create', 'page', page.id);
    return c.json({ page }, 201);
  } catch (error) {
    if (error instanceof PathConflictError) return jsonError(c, 409, 'PATH_CONFLICT');
    throw error;
  }
});
