import type { CloudContext } from 'void';
import type { Env } from './types';

export const SESSION_COOKIE = '__Host-zeee_session';
export const DEV_SESSION_COOKIE = 'zeee_session';

export function isSecureRequest(c: CloudContext): boolean {
  const env = c.env as Env;
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.startsWith('https://');
  return new URL(c.req.url).protocol === 'https:';
}

export function sessionCookieName(c: CloudContext): string {
  return isSecureRequest(c) ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export function readCookie(c: CloudContext, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setSessionCookie(c: CloudContext, token: string): void {
  const secure = isSecureRequest(c) ? '; Secure' : '';
  c.header(
    'Set-Cookie',
    `${sessionCookieName(c)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      60 * 60 * 24 * 7
    }${secure}`,
  );
}

export function clearSessionCookie(c: CloudContext): void {
  const secure = isSecureRequest(c) ? '; Secure' : '';
  c.header(
    'Set-Cookie',
    `${sessionCookieName(c)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function requestOrigin(c: CloudContext): string {
  const env = c.env as Env;
  return env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
}

export function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
