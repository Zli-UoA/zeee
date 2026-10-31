import type { CloudContext } from 'void';
import { requestOrigin } from './cookies';
import type { Env } from './types';

export function pathParam(c: CloudContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`Missing path parameter: ${name}`);
  return value;
}

export function redirectTo(c: CloudContext, path: string, status: 302 | 303 = 303): Response {
  return c.redirect(new URL(path, requestOrigin(c)).toString(), status);
}

export function jsonError(
  c: CloudContext,
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
  message: string,
): Response {
  return c.json({ error: message }, status);
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestUrlOrigin: string,
  publicOrigin?: string,
): boolean {
  if (!origin) return true;
  return origin === requestUrlOrigin || origin === publicOrigin;
}

export function sameOrigin(c: CloudContext): boolean {
  const env = c.env as Env;
  return isAllowedOrigin(c.req.header('origin'), new URL(c.req.url).origin, env.PUBLIC_ORIGIN);
}
