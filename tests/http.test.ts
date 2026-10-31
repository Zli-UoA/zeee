import type { CloudContext } from 'void';
import { describe, expect, it } from 'vite-plus/test';
import { sameOrigin } from '../src/server/http';

function context(
  url: string,
  origin: string | undefined,
  env: Record<string, string | undefined> = {},
): CloudContext {
  return {
    env,
    req: {
      url,
      header: (name: string) => (name === 'origin' ? origin : undefined),
    },
  } as unknown as CloudContext;
}

describe('sameOrigin', () => {
  it('allows requests without an origin', () => {
    expect(sameOrigin(context('http://127.0.0.1:9876/', undefined))).toBe(true);
  });

  it('allows the actual request origin when dev mode points elsewhere', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://192.168.0.170:9876', {
          ZEEE_DEV_AUTH: '1',
          PUBLIC_ORIGIN: 'http://127.0.0.1:9876',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a different origin in dev mode', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://127.0.0.1:9876', {
          ZEEE_DEV_AUTH: '1',
          PUBLIC_ORIGIN: 'http://127.0.0.1:9876',
        }),
      ),
    ).toBe(false);
  });

  it('allows the public origin behind a proxy in production', () => {
    expect(
      sameOrigin(
        context('http://celld:8080/pages/1', 'https://zeee.zli.works', {
          PUBLIC_ORIGIN: 'https://zeee.zli.works',
        }),
      ),
    ).toBe(true);
  });

  it('does not trust the request origin in production', () => {
    expect(
      sameOrigin(
        context('http://192.168.0.170:9876/pages/1', 'http://192.168.0.170:9876', {
          PUBLIC_ORIGIN: 'https://zeee.zli.works',
        }),
      ),
    ).toBe(false);
  });
});
