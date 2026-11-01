import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { searchPages } from '../../src/server/db';
import { jsonError } from '../../src/server/http';
import { PaginationError, parsePagination } from '../../src/server/pagination';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const params = new URL(c.req.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  try {
    const slice = await searchPages((c.env as Env).DB, query, parsePagination(params));
    return { query, results: slice.items, nextCursor: slice.nextCursor, limit: slice.limit };
  } catch (error) {
    if (error instanceof PaginationError) return jsonError(c, 400, error.message);
    throw error;
  }
});
