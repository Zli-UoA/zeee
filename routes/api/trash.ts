import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { listDeletedPages } from '../../src/server/db';
import { jsonError } from '../../src/server/http';
import { PaginationError, parsePagination } from '../../src/server/pagination';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  try {
    const slice = await listDeletedPages(
      (c.env as Env).DB,
      parsePagination(new URL(c.req.url).searchParams),
    );
    return { pages: slice.items, nextCursor: slice.nextCursor, limit: slice.limit };
  } catch (error) {
    if (error instanceof PaginationError) return jsonError(c, 400, error.message);
    throw error;
  }
});
