import { defineHandler } from 'void';
import { escapeHtml } from '../../src/server/crypto';
import { redirectTo } from '../../src/server/http';
import { OidcError, finishLogin } from '../../src/server/oidc';

export const GET = defineHandler(async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.text('Missing code or state', 400);

  try {
    return redirectTo(c, await finishLogin(c, code, state));
  } catch (error) {
    const message =
      error instanceof OidcError || error instanceof Error ? error.message : 'OIDC login failed';
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Zeee login</title><body style="font-family:system-ui;padding:3rem"><h1>ログインに失敗しました</h1><p>${escapeHtml(
        message,
      )}</p><p><a href="/auth/login">再試行</a></p></body>`,
      400,
    );
  }
});
