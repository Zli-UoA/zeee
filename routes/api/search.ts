import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { searchPages } from '../../src/server/db';
import { jsonError } from '../../src/server/http';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  const query = c.req.query('q') ?? '';
  return { query, results: await searchPages((c.env as Env).DB, query) };
});
