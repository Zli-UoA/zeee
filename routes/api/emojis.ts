import { defineHandler } from 'void';
import { getSessionUser } from '../../src/server/auth';
import { jsonError } from '../../src/server/http';
import type { Env } from '../../src/server/types';
import { EmojiClient } from '../../src/emoji/client';
const clients = new Map<string, EmojiClient>();
export const GET = defineHandler(async (c) => {
  if (!(await getSessionUser(c))) return jsonError(c, 401, 'login required');
  const service = (c.env as Env).EMOJI_SERVICE_URL;
  if (!service) return { emojis: [], management_url: null };
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
    c.header('Cache-Control', 'private, no-store');
    return { emojis: await client.list(), management_url: service };
  } catch {
    return jsonError(c, 503, 'emoji service unavailable');
  }
});
