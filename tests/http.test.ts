import { describe, expect, it } from 'vite-plus/test';
import { isAllowedOrigin } from '../src/server/http';

describe('isAllowedOrigin', () => {
  it('allows requests without an origin', () => {
    expect(isAllowedOrigin(undefined, 'http://127.0.0.1:9876')).toBe(true);
  });

  it('allows the origin of the request itself', () => {
    expect(isAllowedOrigin('http://192.168.0.170:9876', 'http://192.168.0.170:9876')).toBe(true);
  });

  it('allows the configured public origin behind a proxy', () => {
    expect(
      isAllowedOrigin('https://zeee.zli.works', 'http://celld:8080', 'https://zeee.zli.works'),
    ).toBe(true);
  });

  it('rejects any other origin', () => {
    expect(isAllowedOrigin('http://localhost:9876', 'http://192.168.0.170:9876')).toBe(false);
  });
});
