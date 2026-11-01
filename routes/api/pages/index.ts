import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import {
  MAX_PAGE_DEPTH,
  createPage,
  getPage,
  getPageAncestors,
  listPages,
  recordAudit,
} from '../../../src/server/db';
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

  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    parentId?: unknown;
  } | null;
  if (body && 'title' in body && typeof body.title !== 'string') {
    return jsonError(c, 400, 'title must be a string');
  }
  const title =
    (typeof body?.title === 'string' ? body.title : '').trim().slice(0, 200) || 'Untitled';

  let parentId: string | null = null;
  if (body && 'parentId' in body && body.parentId !== null) {
    if (typeof body.parentId !== 'string' || !body.parentId.trim()) {
      return jsonError(c, 400, 'parentId must be a page id or null');
    }
    parentId = body.parentId.trim();
  }

  const env = c.env as Env;
  if (parentId !== null) {
    if (!(await getPage(env.DB, parentId))) {
      return jsonError(c, 404, 'parent page not found');
    }
    if ((await getPageAncestors(env.DB, parentId)).length + 1 > MAX_PAGE_DEPTH) {
      return jsonError(c, 400, 'page depth limit exceeded');
    }
  }
  const page = await createPage(env.DB, title, user.id, parentId);
  await recordAudit(env.DB, user.id, 'page.create', 'page', page.id);
  return c.json({ page }, 201);
});
