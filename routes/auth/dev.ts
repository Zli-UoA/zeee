import { defineHandler } from 'void';
import { setSessionCookie, safeNext } from '../../src/server/cookies';
import { redirectTo } from '../../src/server/http';
import { createSession, upsertUser } from '../../src/server/db';
import { ensureSchema } from '../../src/server/schema';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const env = c.env as Env;
  if (env.ZEEE_DEV_AUTH !== '1') return c.text('Not found', 404);

  await ensureSchema(env.DB);
  const raw = (c.req.query('name') ?? 'dev').trim();
  const displayName = raw.slice(0, 40) || 'dev';
  const username =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'dev';

  const user = await upsertUser(env.DB, {
    issuer: 'dev',
    subject: `dev:${displayName}`,
    username,
    displayName,
  });
  const token = await createSession(env.DB, user.id);
  setSessionCookie(c, token);
  return redirectTo(c, safeNext(new URL(c.req.url).searchParams.get('next') ?? '/'));
});
