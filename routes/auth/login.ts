import { defineHandler } from 'void';
import { escapeHtml } from '../../src/server/crypto';
import { OidcError, beginLogin } from '../../src/server/oidc';

export const GET = defineHandler(async (c) => {
  try {
    return c.redirect(await beginLogin(c), 302);
  } catch (error) {
    const message =
      error instanceof OidcError || error instanceof Error ? error.message : 'OIDC login failed';
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Zeee login</title><body style="font-family:system-ui;padding:3rem"><h1>AuthZ に接続できません</h1><p>${escapeHtml(
        message,
      )}</p><p><a href="/">戻る</a></p></body>`,
      503,
    );
  }
});
