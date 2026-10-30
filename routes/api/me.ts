import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null }, 401);
  return { user };
});
