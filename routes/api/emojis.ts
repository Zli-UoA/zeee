import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { jsonError } from '../../src/server/http';
import type { Env } from '../../src/server/types';
import { ShortcodeClient } from '../../src/emoji/shortcodesClient';
import { EmojiClient } from '../../src/emoji/client';
import { AccountClient } from '../../src/emoji/accountsClient';
const accountsClients = new Map<string, AccountClient>();
const clients = new Map<string, EmojiClient>();
const shortcodeClients = new Map<string, ShortcodeClient>();
export const GET = defineHandler(async (c) => {
  if (!(await getSessionUser(c))) return jsonError(c, 401, 'login required');
  const service = (c.env as Env).EMOJI_SERVICE_URL;
  if (!service) return { emojis: [], shortcodes: {}, accounts: [], management_url: null };
  try {
    const url = new URL(service);
    if (
      url.origin !== service ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw Error('Invalid emoji service URL');
    let client = clients.get(service);
    if (!client) {
      client = new EmojiClient(service);
      clients.set(service, client);
    }
    let standard = shortcodeClients.get(service);
    if (!standard) {
      standard = new ShortcodeClient(service);
      shortcodeClients.set(service, standard);
    }
    const accountEndpoint = (c.env as Env).EMOJI_ACCOUNT_PROFILE_URL;
    const key = JSON.stringify([accountEndpoint, service]);
    if (accountEndpoint && !accountsClients.has(key))
      accountsClients.set(key, new AccountClient(accountEndpoint, service));
    const [emojis, shortcodes, accounts] = await Promise.all([
      client.list(),
      standard.list().catch(() => ({})),
      accountEndpoint ? accountsClients.get(key)!.list() : Promise.resolve([]),
    ]);
    c.header('Cache-Control', 'private, no-store');
    return {
      emojis,
      shortcodes,
      accounts,
      shortcode_source: standard.source,
      management_url: service,
    };
  } catch {
    return jsonError(c, 503, 'emoji service unavailable');
  }
});
