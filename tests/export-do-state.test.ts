import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

// @ts-expect-error - the CLI is plain .mjs and has no TypeScript declarations.
import { exportPageStates, main } from '../scripts/export-do-state.mjs';

type Call = { url: URL; init: RequestInit };
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function mockFetch(
  handler: Handler,
  trashIds: string[] = [],
  trashNextCursor: string | null = null,
) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      input instanceof URL ? input : input instanceof Request ? new URL(input.url) : new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/trash' && url.searchParams.get('cursor') === null) {
      return pageList(trashIds, trashNextCursor);
    }
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function pageList(ids: string[], nextCursor: string | null = null): Response {
  return Response.json({
    pages: ids.map((id) => ({ id, title: id })),
    nextCursor,
    limit: 100,
    sort: 'updated',
  });
}

function state(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/octet-stream' },
  });
}

function headers(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe('export-do-state', () => {
  it('follows cursors, saves <pageId>.yjs and sends the session cookie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') {
          if (url.searchParams.get('cursor') === null)
            return pageList(['page-1', 'page-2'], 'next-1');
          if (url.searchParams.get('cursor') === 'next-1') return pageList(['page-3'], 'next-2');
          if (url.searchParams.get('cursor') === 'next-2') return pageList([]);
        }
        if (url.pathname === '/api/pages/page-1/state') return state([1, 2, 3]);
        if (url.pathname === '/api/pages/page-2/state') return state([4, 5]);
        if (url.pathname === '/api/pages/page-3/state') return state([6]);
        throw new Error(`unexpected request: ${url}`);
      });

      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      });

      expect(result.ids).toEqual(['page-1', 'page-2', 'page-3']);
      expect(result.files.map((file: { path: string }) => file.path)).toEqual([
        join(dir, 'page-1.yjs'),
        join(dir, 'page-2.yjs'),
        join(dir, 'page-3.yjs'),
      ]);
      expect(readFileSync(join(dir, 'page-2.yjs'))).toEqual(Buffer.from([4, 5]));

      const listCalls = calls.filter((call) => call.url.pathname === '/api/pages');
      expect(listCalls.map((call) => call.url.searchParams.get('cursor'))).toEqual([
        null,
        'next-1',
        'next-2',
      ]);
      expect(listCalls[0].url.searchParams.get('limit')).toBe('100');
      expect(calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(3);
      expect(calls.every((call) => headers(call).cookie === 'zeee_session=test-token')).toBe(true);
      expect(headers(calls[0]).origin).toBe('https://zeee.example.test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run lists pages without fetching states or writing files', async () => {
    const dir = join(tmpdir(), `zeee-export-dry-${process.pid}`);
    const { fetchImpl, calls } = mockFetch(() => pageList(['page-a', 'page-b']));
    const result = await exportPageStates({
      baseUrl: 'https://zeee.example.test',
      cookie: 'zeee_session=test-token',
      outdir: dir,
      dryRun: true,
      fetchImpl,
      retryDelayMs: 0,
      log: () => {},
    });

    expect(result.ids).toEqual(['page-a', 'page-b']);
    expect(result.files.map((file: { path: string }) => file.path)).toEqual([
      join(dir, 'page-a.yjs'),
      join(dir, 'page-b.yjs'),
    ]);
    expect(calls).toHaveLength(2); // active pages + trash
    expect(calls[0].url.pathname).toBe('/api/pages');
    expect(calls[1].url.pathname).toBe('/api/trash');
    expect(existsSync(dir)).toBe(false);
  });

  it('stops at --limit and requests a matching page size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-limit-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1', 'page-2', 'page-3'], 'more');
        return state([1]);
      });
      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        limit: 2,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      });

      expect(result.ids).toEqual(['page-1', 'page-2']);
      expect(calls).toHaveLength(3); // limit reached in /api/pages; trash is not queried
      expect(calls[0].url.searchParams.get('limit')).toBe('2');
      expect(existsSync(join(dir, 'page-3.yjs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly on a 4xx state response without retrying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-error-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['missing']);
        return Response.json({ error: 'not found' }, { status: 404 });
      });
      await expect(
        exportPageStates({
          baseUrl: 'https://zeee.example.test',
          cookie: 'zeee_session=test-token',
          outdir: dir,
          fetchImpl,
          retries: 2,
          retryDelayMs: 0,
          log: () => {},
        }),
      ).rejects.toMatchObject({ status: 404, message: expect.stringContaining('HTTP 404') });
      expect(calls).toHaveLength(3); // active pages + trash + failing state GET
      expect(existsSync(join(dir, 'missing.yjs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries 5xx responses and succeeds when the next attempt works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-retry-'));
    try {
      let attempts = 0;
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        attempts += 1;
        if (attempts === 1) return new Response('temporarily unavailable', { status: 503 });
        return state([7, 8]);
      });
      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl,
        retries: 2,
        retryDelayMs: 0,
        log: () => {},
      });

      expect(result.count).toBe(1);
      expect(attempts).toBe(2);
      expect(calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(2);
      expect(readFileSync(join(dir, 'page-1.yjs'))).toEqual(Buffer.from([7, 8]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries network failures and names the error when retries are exhausted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-network-'));
    try {
      let attempts = 0;
      const flaky = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        attempts += 1;
        if (attempts < 3) throw new Error('connection reset');
        return state([11]);
      });
      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl: flaky.fetchImpl,
        retries: 3,
        retryDelayMs: 0,
        log: () => {},
      });
      expect(result.count).toBe(1);
      expect(attempts).toBe(3);

      const deadDir = mkdtempSync(join(tmpdir(), 'zeee-export-dead-'));
      const dead = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        throw new Error('connection refused');
      });
      try {
        await expect(
          exportPageStates({
            baseUrl: 'https://zeee.example.test',
            cookie: 'zeee_session=test-token',
            outdir: deadDir,
            fetchImpl: dead.fetchImpl,
            retries: 2,
            retryDelayMs: 0,
            log: () => {},
          }),
        ).rejects.toThrow(/network error: connection refused/);
        expect(dead.calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(3);
      } finally {
        rmSync(deadDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after the configured number of retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-exhaust-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        return new Response('down', { status: 500 });
      });
      await expect(
        exportPageStates({
          baseUrl: 'https://zeee.example.test',
          cookie: 'zeee_session=test-token',
          outdir: dir,
          fetchImpl,
          retries: 2,
          retryDelayMs: 0,
          log: () => {},
        }),
      ).rejects.toMatchObject({ status: 500, message: expect.stringContaining('HTTP 500') });
      expect(calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cursor that does not advance', async () => {
    const { fetchImpl, calls } = mockFetch(() => pageList(['page-1'], 'stuck'));
    await expect(
      exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: join(tmpdir(), 'zeee-export-loop'),
        dryRun: true,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      }),
    ).rejects.toThrow(/cursor did not advance/);
    expect(calls).toHaveLength(2);
  });

  it('acquires a local dev session through /auth/dev when ZEEE_DEV_AUTH=1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-dev-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/auth/dev') {
          return new Response(null, {
            status: 303,
            headers: { 'set-cookie': 'zeee_session=dev-token; Path=/; HttpOnly' },
          });
        }
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        return state([9]);
      });
      await main(['--out', dir], {
        env: { ZEEE_BASE_URL: 'http://127.0.0.1:8787', ZEEE_DEV_AUTH: '1' },
        fetchImpl,
        log: () => {},
      });

      expect(calls[0].url.pathname).toBe('/auth/dev');
      expect(calls[0].init.redirect).toBe('manual');
      expect(headers(calls[1]).cookie).toBe('zeee_session=dev-token');
      expect(headers(calls[2]).cookie).toBe('zeee_session=dev-token');
      expect(readFileSync(join(dir, 'page-1.yjs'))).toEqual(Buffer.from([9]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses dev auth against a non-loopback URL and a missing session cookie', async () => {
    const { fetchImpl, calls } = mockFetch(() => pageList([]));
    await expect(
      main([], {
        env: { ZEEE_BASE_URL: 'https://zeee.example.test', ZEEE_DEV_AUTH: '1' },
        fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/loopback/);
    await expect(
      main([], {
        env: { ZEEE_BASE_URL: 'https://zeee.example.test' },
        fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/ZEEE_SESSION_COOKIE/);
    expect(calls).toHaveLength(0);
  });

  it('retries a 429 state response and fails loudly when retries are exhausted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-429-'));
    try {
      let attempts = 0;
      const flaky = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        attempts += 1;
        if (attempts === 1) return new Response('slow down', { status: 429 });
        return state([1, 2]);
      });
      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl: flaky.fetchImpl,
        retries: 2,
        retryDelayMs: 0,
        log: () => {},
      });
      expect(result.count).toBe(1);
      expect(attempts).toBe(2);
      expect(readFileSync(join(dir, 'page-1.yjs'))).toEqual(Buffer.from([1, 2]));

      const stuckDir = mkdtempSync(join(tmpdir(), 'zeee-export-429-stuck-'));
      const stuck = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1']);
        return new Response('slow down', { status: 429 });
      });
      try {
        await expect(
          exportPageStates({
            baseUrl: 'https://zeee.example.test',
            cookie: 'zeee_session=test-token',
            outdir: stuckDir,
            fetchImpl: stuck.fetchImpl,
            retries: 2,
            retryDelayMs: 0,
            log: () => {},
          }),
        ).rejects.toMatchObject({ status: 429, message: expect.stringContaining('HTTP 429') });
        expect(stuck.calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(3);
      } finally {
        rmSync(stuckDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses unsafe page ids from either list endpoint before building a path', async () => {
    const badIds = ['../escape', 'a/b', '..', 'x'.repeat(129)];
    for (const id of badIds) {
      const { fetchImpl } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList([id]);
        throw new Error('state must not be fetched for an unsafe id');
      });
      await expect(
        exportPageStates({
          baseUrl: 'https://zeee.example.test',
          cookie: 'zeee_session=test-token',
          outdir: join(tmpdir(), 'zeee-export-unsafe-id'),
          dryRun: true,
          fetchImpl,
          retryDelayMs: 0,
          log: () => {},
        }),
      ).rejects.toThrow(/invalid page id/);

      const fromTrash = mockFetch(
        (url) => {
          if (url.pathname === '/api/pages') return pageList([]);
          throw new Error('state must not be fetched for an unsafe id');
        },
        [id],
      );
      await expect(
        exportPageStates({
          baseUrl: 'https://zeee.example.test',
          cookie: 'zeee_session=test-token',
          outdir: join(tmpdir(), 'zeee-export-unsafe-trash-id'),
          dryRun: true,
          fetchImpl: fromTrash.fetchImpl,
          retryDelayMs: 0,
          log: () => {},
        }),
      ).rejects.toThrow(/invalid page id/);
    }
  });

  it('rejects an empty nextCursor instead of looping', async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.pathname === '/api/pages') return pageList(['page-1'], '');
      throw new Error(`unexpected request: ${url}`);
    });
    await expect(
      exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: join(tmpdir(), 'zeee-export-empty-cursor'),
        dryRun: true,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      }),
    ).rejects.toThrow(/cursor did not advance/);
    const listCalls = calls.filter((call) => call.url.pathname === '/api/pages');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].url.searchParams.get('cursor')).toBe('');
  });

  it('rejects a wrong Content-Type and an empty state body', async () => {
    const cases: Array<[Response, RegExp]> = [
      [
        new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
        /unexpected Content-Type/,
      ],
      [
        new Response(new Uint8Array(0), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
        /empty state response/,
      ],
    ];
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-bad-state-'));
    try {
      for (const [response, expected] of cases) {
        const { fetchImpl } = mockFetch((url) => {
          if (url.pathname === '/api/pages') return pageList(['page-1']);
          return response;
        });
        await expect(
          exportPageStates({
            baseUrl: 'https://zeee.example.test',
            cookie: 'zeee_session=test-token',
            outdir: dir,
            fetchImpl,
            retryDelayMs: 0,
            log: () => {},
          }),
        ).rejects.toThrow(expected);
        expect(existsSync(join(dir, 'page-1.yjs'))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks trash cursors too and exports soft-deleted page state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-trash-'));
    try {
      const { fetchImpl, calls } = mockFetch(
        (url) => {
          if (url.pathname === '/api/pages') return pageList(['active-1']);
          if (url.pathname === '/api/trash' && url.searchParams.get('cursor') === 'trash-1') {
            return pageList(['trashed-2']);
          }
          if (url.pathname.endsWith('/state')) return state([7]);
          throw new Error(`unexpected request: ${url}`);
        },
        ['trashed-1'],
        'trash-1',
      );
      const result = await exportPageStates({
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      });
      expect(result.ids).toEqual(['active-1', 'trashed-1', 'trashed-2']);
      expect(readFileSync(join(dir, 'trashed-2.yjs'))).toEqual(Buffer.from([7]));
      expect(
        calls
          .filter((call) => call.url.pathname === '/api/trash')
          .map((call) => call.url.searchParams.get('cursor')),
      ).toEqual([null, 'trash-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a manifest, skips intact files, re-exports stale files and leaves no temp files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-manifest-'));
    try {
      const { fetchImpl, calls } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1', 'page-2']);
        return state([1, 2, 3]);
      });
      const options = {
        baseUrl: 'https://zeee.example.test',
        cookie: 'zeee_session=test-token',
        outdir: dir,
        fetchImpl,
        retryDelayMs: 0,
        log: () => {},
      };
      await exportPageStates(options);

      const manifestPath = join(dir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.version).toBe(1);
      expect(manifest.entries['page-1']).toEqual({
        bytes: 3,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(2);
      expect(readdirSync(dir).some((name) => name.includes('.tmp-'))).toBe(false);

      calls.splice(0);
      const resumed = await exportPageStates(options);
      expect(resumed.files.filter((file: { skipped?: boolean }) => file.skipped)).toHaveLength(2);
      expect(calls.filter((call) => call.url.pathname.endsWith('/state'))).toHaveLength(0);

      writeFileSync(join(dir, 'page-1.yjs'), Buffer.from([9, 9]));
      const repaired = await exportPageStates(options);
      expect(repaired.files.find((file: { id: string }) => file.id === 'page-1').skipped).toBe(
        false,
      );
      expect(readFileSync(join(dir, 'page-1.yjs'))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports N/M progress and keeps completed files when a later page fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-export-progress-'));
    try {
      const logs: string[] = [];
      const { fetchImpl } = mockFetch((url) => {
        if (url.pathname === '/api/pages') return pageList(['page-1', 'page-2', 'page-3']);
        if (url.pathname.endsWith('/page-1/state')) return state([1]);
        return new Response('down', { status: 500 });
      });
      await expect(
        exportPageStates({
          baseUrl: 'https://zeee.example.test',
          cookie: 'zeee_session=test-token',
          outdir: dir,
          fetchImpl,
          retries: 0,
          retryDelayMs: 0,
          log: (message: string) => logs.push(message),
        }),
      ).rejects.toThrow(/HTTP 500/);
      expect(logs.join('\n')).toMatch(/export stopped after 1\/3 page\(s\)/);
      expect(existsSync(join(dir, 'page-1.yjs'))).toBe(true);
      expect(existsSync(join(dir, 'page-2.yjs'))).toBe(false);
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
