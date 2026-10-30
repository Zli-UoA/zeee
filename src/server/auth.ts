import type { CloudContext } from 'void';
import { readCookie, sessionCookieName } from './cookies';
import { getUserBySession } from './db';
import type { Env, SessionUser } from './types';

export async function getSessionUser(c: CloudContext): Promise<SessionUser | null> {
  const env = c.env as Env;
  const token = readCookie(c, sessionCookieName(c));
  if (!token) return null;
  return getUserBySession(env.DB, token);
}

export function loginPath(c: CloudContext, next = '/'): string {
  const env = c.env as Env;
  const base = env.ZEEE_DEV_AUTH === '1' ? '/auth/dev' : '/auth/login';
  return `${base}?next=${encodeURIComponent(next)}`;
}
