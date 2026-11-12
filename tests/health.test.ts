import type { CloudContext } from 'void';
import { describe, expect, it } from 'vite-plus/test';
import { GET as healthGET } from '../routes/api/health';

function context(deep: boolean): CloudContext {
  return {
    env: {
      get DB(): never {
        throw new Error('the shallow health check must not touch D1');
      },
    },
    req: {
      url: `http://localhost/api/health${deep ? '?deep=1' : ''}`,
      query: (name: string) => (name === 'deep' && deep ? '1' : undefined),
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as CloudContext;
}

describe('health check', () => {
  it('answers without activating D1 by default', async () => {
    expect(await healthGET(context(false))).toEqual({ ok: true });
  });
});
