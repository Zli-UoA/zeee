import { defineHandler } from 'void';
import {
  clearSessionCookie,
  readCookie,
  requestOrigin,
  sessionCookieName,
} from '../../src/server/cookies';
import { deleteSession } from '../../src/server/db';
import { redirectTo } from '../../src/server/http';
import { endSessionUrl } from '../../src/server/oidc';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const env = c.env as Env;
  const token = readCookie(c, sessionCookieName(c));
  if (token) await deleteSession(env.DB, token);
  clearSessionCookie(c);
  if (env.ZEEE_DEV_AUTH === '1') return redirectTo(c, '/');
  return c.redirect((await endSessionUrl(c)) ?? `${requestOrigin(c)}/`, 303);
});
