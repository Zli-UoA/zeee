import type { CloudContext } from 'void';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { requestOrigin, safeNext } from './cookies';
import { randomToken, sha256Base64Url } from './crypto';
import { createLoginFlow, consumeLoginFlow, createSession, upsertUser } from './db';
import { setSessionCookie } from './cookies';
import type { Env } from './types';

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

const discoveryCache = new Map<string, Promise<Discovery>>();

export class OidcError extends Error {}

function env(c: CloudContext): Env {
  return c.env as Env;
}

function issuer(c: CloudContext): string {
  return env(c).AUTHZ_ISSUER ?? 'https://account.zli.works/api/auth';
}

function clientId(c: CloudContext): string {
  const value = env(c).AUTHZ_CLIENT_ID;
  if (!value) throw new OidcError('AUTHZ_CLIENT_ID is not configured');
  return value;
}

async function discover(c: CloudContext): Promise<Discovery> {
  const value = issuer(c);
  let pending = discoveryCache.get(value);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${value.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!response.ok) throw new OidcError(`OIDC discovery failed: ${response.status}`);
      const body = (await response.json()) as Partial<Discovery>;
      if (!body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri || !body.issuer) {
        throw new OidcError('OIDC discovery response is incomplete');
      }
      return body as Discovery;
    })();
    discoveryCache.set(value, pending);
    pending.catch(() => discoveryCache.delete(value));
  }
  return pending;
}

export async function beginLogin(c: CloudContext): Promise<string> {
  const metadata = await discover(c);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = `${requestOrigin(c)}/auth/callback`;
  const returnTo = safeNext(new URL(c.req.url).searchParams.get('next') ?? '/');

  await createLoginFlow(env(c).DB, { state, nonce, codeVerifier: verifier, returnTo });

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId(c));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function finishLogin(c: CloudContext, code: string, state: string): Promise<string> {
  const flow = await consumeLoginFlow(env(c).DB, state);
  if (!flow) throw new OidcError('Login state is invalid or expired');

  const metadata = await discover(c);
  const redirectUri = `${requestOrigin(c)}/auth/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId(c),
    code_verifier: flow.codeVerifier,
  });

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  if (!response.ok) {
    throw new OidcError(`OIDC token exchange failed: ${response.status}`);
  }

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw new OidcError('OIDC response has no id_token');

  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: metadata.issuer,
    audience: clientId(c),
    algorithms: ['RS256'],
  });

  if (payload.nonce !== flow.nonce) throw new OidcError('OIDC nonce mismatch');
  if (!payload.sub) throw new OidcError('OIDC subject is missing');

  const preferredUsername =
    typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const username = preferredUsername ?? name ?? payload.sub;
  const displayName = name ?? username;
  const user = await upsertUser(env(c).DB, {
    issuer: typeof payload.iss === 'string' ? payload.iss : metadata.issuer,
    subject: payload.sub,
    username,
    displayName,
  });
  const token = await createSession(env(c).DB, user.id);
  setSessionCookie(c, token);
  return flow.returnTo;
}

export async function endSessionUrl(c: CloudContext): Promise<string | null> {
  if (!env(c).AUTHZ_CLIENT_ID) return null;
  try {
    const metadata = await discover(c);
    const endpoint =
      metadata.end_session_endpoint ?? `${issuer(c).replace(/\/$/, '')}/oauth2/end-session`;
    const url = new URL(endpoint);
    url.searchParams.set('client_id', clientId(c));
    url.searchParams.set('post_logout_redirect_uri', `${requestOrigin(c)}/`);
    return url.toString();
  } catch {
    return null;
  }
}
