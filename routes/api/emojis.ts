import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { jsonError } from '../../src/server/http';
import type { Env } from '../../src/server/types';
import { ShortcodeClient } from '../../src/emoji/shortcodesClient';
import { EmojiClient } from '../../src/emoji/client';
const clients = new Map<string, EmojiClient>();
const shortcodeClients = new Map<string, ShortcodeClient>();
export const GET = defineHandler(async (c) => {
  if (!(await getSessionUser(c))) return jsonError(c, 401, 'login required');
  const service = (c.env as Env).EMOJI_SERVICE_URL;
  if (!service) return { emojis: [], shortcodes: {}, management_url: null };
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
    const [emojis, shortcodes] = await Promise.all([
      client.list(),
      standard.list().catch(() => ({})),
    ]);
    c.header('Cache-Control', 'private, no-store');
    return { emojis, shortcodes, shortcode_source: standard.source, management_url: service };
  } catch {
    return jsonError(c, 503, 'emoji service unavailable');
  }
});
