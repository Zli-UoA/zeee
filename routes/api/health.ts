import { defineHandler } from 'void';
import { ensureSchema } from '../../src/server/schema';
import type { Env } from '../../src/server/types';

export const GET = defineHandler(async (c) => {
  const env = c.env as Env;
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare('SELECT 1').first();
    return { ok: true };
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : 'unavailable' },
      503,
    );
  }
});
