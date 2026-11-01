import { defineHandler } from 'void';
import { getSessionUser } from '../../../src/server/auth';
import {
  MAX_PAGE_DEPTH,
  getPage,
  getPageAncestors,
  hasAncestor,
  maxSubtreeDepth,
  recordAudit,
  softDeletePage,
  updatePageParent,
  updatePageTitle,
} from '../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../src/server/http';
import type { Env } from '../../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const page = await getPage(env.DB, pageId);
  if (!page) return jsonError(c, 404, 'page not found');
  const ancestors = await getPageAncestors(env.DB, pageId);
  return { page, ancestors };
});

export const PATCH = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');

  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    parentId?: unknown;
  } | null;
  const hasTitle = Boolean(body && 'title' in body);
  const hasParent = Boolean(body && 'parentId' in body);
  if (!hasTitle && !hasParent) return jsonError(c, 400, 'title or parentId is required');
  if (hasTitle && typeof body?.title !== 'string') {
    return jsonError(c, 400, 'title must be a string');
  }
  const rawTitle = typeof body?.title === 'string' ? body.title : '';
  const title = hasTitle ? rawTitle.trim().slice(0, 200) : '';
  if (hasTitle && !title) return jsonError(c, 400, 'title is required');

  let parentId: string | null | undefined;
  if (hasParent) {
    if (body?.parentId === null) {
      parentId = null;
    } else if (typeof body?.parentId === 'string' && body.parentId.trim()) {
      parentId = body.parentId.trim();
    } else {
      return jsonError(c, 400, 'parentId must be a page id or null');
    }
  }

  const env = c.env as Env;
  const pageId = pathParam(c, 'id');
  const page = await getPage(env.DB, pageId);
  if (!page) return jsonError(c, 404, 'page not found');

  if (parentId !== undefined && parentId !== null) {
    const parent = await getPage(env.DB, parentId);
    if (!parent) return jsonError(c, 404, 'parent page not found');
    if (await hasAncestor(env.DB, parentId, pageId)) return jsonError(c, 409, 'cycle');
    const parentDepth = (await getPageAncestors(env.DB, parentId)).length;
    const subtreeDepth = await maxSubtreeDepth(env.DB, pageId);
    if (parentDepth + 1 + subtreeDepth > MAX_PAGE_DEPTH) {
      return jsonError(c, 400, 'page depth limit exceeded');
    }
  }

  if (hasTitle) {
    await updatePageTitle(env.DB, pageId, title, page.title, user.id);
    await recordAudit(env.DB, user.id, 'page.rename', 'page', pageId);
  }
  if (hasParent) {
    await updatePageParent(env.DB, pageId, parentId ?? null);
    await recordAudit(env.DB, user.id, 'page.move', 'page', pageId);
  }
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
  const result = await softDeletePage(env.DB, pageId);
  if (!result.deleted) {
    return c.json({ error: 'has_children', childCount: result.childCount }, 409);
  }
  await recordAudit(env.DB, user.id, 'page.delete', 'page', pageId);
  return { ok: true };
});
