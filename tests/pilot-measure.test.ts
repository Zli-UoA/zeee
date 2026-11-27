import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

// @ts-expect-error - the CLI is plain .mjs and has no TypeScript declarations.
import * as pilot from '../scripts/pilot-measure.mjs';

const {
  evaluateThresholds,
  fetchClassACount,
  main,
  parseArgs,
  percentile,
  runMeasurement,
  summarizeClassA,
  summarizeMeasurements,
} = pilot;

type Call = { url: URL; init: RequestInit };
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      input instanceof URL ? input : input instanceof Request ? new URL(input.url) : new URL(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function headers(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function pageList(ids: string[]): Response {
  return Response.json({
    pages: ids.map((id) => ({ id, title: id })),
    nextCursor: null,
    limit: 1,
    sort: 'updated',
  });
}

describe('pilot-measure', () => {
  it('parses defaults and inline values without corrupting a Cookie header', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({
      requests: 20,
      concurrency: 1,
      dryRun: true,
    });
    const args = parseArgs([
      '--target=https://pilot.example.test',
      '--requests=3',
      '--concurrency=2',
      '--session-cookie=zeee_session=a=b==',
      '--max-error-rate=0.25',
      '--max-p95-ms=500',
      '--label=1-node',
    ]);
    expect(args.target).toBe('https://pilot.example.test');
    expect(args.sessionCookie).toBe('zeee_session=a=b==');
    expect(args.requests).toBe(3);
    expect(args.concurrency).toBe(2);
    expect(args.maxErrorRate).toBe(0.25);
    expect(args.maxP95Ms).toBe(500);
    expect(args.label).toBe('1-node');
    expect(() => parseArgs(['--requests=0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--max-error-rate=1.5'])).toThrow(/between 0 and 1/);
  });

  it('computes p50/p95/p99 with linear interpolation over an unsorted input', () => {
    const values = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];
    expect(percentile(values, 0.5)).toBe(55);
    expect(percentile(values, 0.95)).toBe(95.5);
    expect(percentile(values, 0.99)).toBe(99.1);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
    expect(() => percentile(values, 1.5)).toThrow(/between 0 and 1/);
  });

  it('summarizes latency, error rate and throughput from known samples', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((latencyMs, index) => ({
      index,
      latencyMs,
      ok: index !== 9,
      status: index === 9 ? 500 : 200,
      error: null,
    }));
    const summary = summarizeMeasurements(samples, { elapsedMs: 2000 });
    expect(summary.requests).toBe(10);
    expect(summary.successes).toBe(9);
    expect(summary.errors).toBe(1);
    expect(summary.errorRate).toBe(0.1);
    expect(summary.requestsPerSecond).toBe(5);
    expect(summary.latencyMs).toEqual({ min: 10, p50: 55, p95: 95.5, p99: 99.1, max: 100 });
    expect(summary.statusCounts).toEqual({ '200': 9, '500': 1 });
    expect(summarizeMeasurements([], { elapsedMs: 0 })).toMatchObject({
      errorRate: 0,
      latencyMs: null,
      requestsPerSecond: null,
    });
  });

  it('reports threshold violations without throwing', () => {
    const summary = summarizeMeasurements(
      [10, 20].map((latencyMs, index) => ({
        index,
        latencyMs,
        ok: false,
        status: 500,
        error: null,
      })),
      { elapsedMs: 1000 },
    );
    expect(evaluateThresholds(summary, { maxErrorRate: 0, maxP95Ms: 5 })).toEqual([
      'error rate 1 > 0',
      'p95 latency 19.5ms > 5ms',
    ]);
    expect(evaluateThresholds(summary)).toEqual([]);
  });

  it('sends authenticated snapshot POSTs and records their latency', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const { fetchImpl, calls } = mockFetch(() => {
      clock.advance(10);
      return new Response(null, { status: 200 });
    });
    const result = await runMeasurement({
      target: 'https://pilot.example.test',
      pageId: 'page-1',
      requests: 3,
      cookie: 'zeee_session=test-token',
      fetchImpl,
      now: clock.now,
      log: (message: string) => logs.push(message),
      env: {},
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.pathname === '/api/pages/page-1/snapshot')).toBe(true);
    expect(calls.every((call) => call.init.method === 'POST')).toBe(true);
    expect(calls.every((call) => headers(call).cookie === 'zeee_session=test-token')).toBe(true);
    expect(headers(calls[0]).origin).toBe('https://pilot.example.test');
    expect(result.summary).toMatchObject({
      requests: 3,
      errors: 0,
      errorRate: 0,
      latencyMs: { min: 10, p50: 10, p95: 10, p99: 10, max: 10 },
    });
    expect(logs.join('\n')).toMatch(/3 request\(s\): errors 0\/3/);
  });

  it('discovers a page id from /api/pages when --page-id is absent', async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.pathname === '/api/pages') return pageList(['discovered-page']);
      return new Response(null, { status: 200 });
    });
    const result = await runMeasurement({
      target: 'https://pilot.example.test',
      requests: 1,
      cookie: 'zeee_session=test-token',
      fetchImpl,
      env: {},
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe('/api/pages');
    expect(calls[0].url.searchParams.get('limit')).toBe('1');
    expect(calls[1].url.pathname).toBe('/api/pages/discovered-page/snapshot');
    expect(result.pageId).toBe('discovered-page');
  });

  it('honours --concurrency and counts 4xx/5xx/network errors without throwing', async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let maxInFlight = 0;
    let count = 0;
    const { fetchImpl, calls } = mockFetch(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      clock.advance(5);
      inFlight -= 1;
      count += 1;
      if (count === 1) return Response.json({ error: 'bad request' }, { status: 404 });
      if (count === 2) return new Response('down', { status: 503 });
      if (count === 3) throw new Error('connection reset');
      return new Response(null, { status: 200 });
    });

    const result = await runMeasurement({
      target: 'https://pilot.example.test',
      pageId: 'page-1',
      requests: 8,
      concurrency: 4,
      fetchImpl,
      now: clock.now,
      env: {},
    });

    expect(maxInFlight).toBe(4);
    expect(calls).toHaveLength(8);
    expect(result.summary.errors).toBe(3);
    expect(result.summary.errorRate).toBe(0.375);
    expect(result.summary.statusCounts).toEqual({ '404': 1, '503': 1, network: 1, '200': 5 });
    const networkSample = result.samples.find(
      (sample: { status: number | null }) => sample.status === null,
    );
    expect(networkSample.error).toBe('connection reset');
  });

  it('does no HTTP at all in --dry-run', async () => {
    const { fetchImpl, calls } = mockFetch(() => {
      throw new Error('dry-run must not fetch');
    });
    const result = await runMeasurement({
      target: 'https://pilot.example.test',
      requests: 5,
      dryRun: true,
      fetchImpl,
      env: {},
    });

    expect(calls).toHaveLength(0);
    expect(result.summary).toBeNull();
    expect(result.plan).toMatchObject({ requests: 5, concurrency: 1, pageFromList: true });
  });

  it('writes JSON to stdout and --out, and sets a non-zero exit code on errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-pilot-'));
    try {
      const out = join(dir, 'report.json');
      const clock = fakeClock();
      const { fetchImpl } = mockFetch(() => {
        clock.advance(10);
        return new Response('down', { status: 500 });
      });
      let emitted = '';
      let exitCode: number | null = null;
      const result = await main(
        ['--target=https://pilot.example.test', '--page-id=page-1', '--requests=2', '--out', out],
        {
          env: { ZEEE_SESSION_COOKIE: 'zeee_session=test-token' },
          fetchImpl,
          now: clock.now,
          log: () => {},
          emit: (json: string) => {
            emitted = json;
          },
          writeFileImpl: async (_path: string, data: string) => writeFileSync(out, data),
          setExitCode: (code: number) => {
            exitCode = code;
          },
        },
      );

      expect(result.summary.errors).toBe(2);
      expect(JSON.parse(emitted)).toMatchObject({
        schemaVersion: 1,
        summary: { requests: 2, errors: 2, errorRate: 1 },
      });
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(JSON.parse(emitted));
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours latency thresholds even when every request succeeds', async () => {
    const clock = fakeClock();
    const { fetchImpl } = mockFetch(() => {
      clock.advance(10);
      return new Response(null, { status: 200 });
    });
    let exitCode: number | null = null;
    const result = await main(
      ['--target=https://pilot.example.test', '--page-id=page-1', '--requests=2', '--max-p95-ms=5'],
      {
        env: { ZEEE_SESSION_COOKIE: 'zeee_session=test-token' },
        fetchImpl,
        now: clock.now,
        log: () => {},
        emit: () => {},
        setExitCode: (code: number) => {
          exitCode = code;
        },
      },
    );

    expect(result.summary.errors).toBe(0);
    expect(result.violations).toEqual(['p95 latency 10ms > 5ms']);
    expect(exitCode).toBe(1);
  });

  it('fetches and aggregates R2 Class A counts through an injectable fetch', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      Response.json({
        data: {
          viewer: {
            accounts: [
              {
                r2OperationsAdaptiveGroups: [{ sum: { requests: 7 } }, { sum: { requests: 3 } }],
              },
            ],
          },
        },
      }),
    );
    const count = await fetchClassACount({
      fetchImpl,
      token: 'fake-token',
      accountId: 'fake-account',
      bucket: 'pilot-bucket',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:01:00.000Z',
    });

    expect(count).toBe(10);
    expect(calls[0].url.toString()).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(headers(calls[0]).authorization).toBe('Bearer fake-token');
    expect(JSON.parse(calls[0].init.body as string).variables).toEqual({
      accountId: 'fake-account',
      bucket: 'pilot-bucket',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T00:01:00.000Z',
    });
    expect(summarizeClassA(10, 13)).toEqual({
      operationClass: 'A',
      before: 10,
      after: 13,
      delta: 3,
    });
    expect(() => summarizeClassA(10, -1)).toThrow(/non-negative/);

    const failing = mockFetch(() => Response.json({ errors: [{ message: 'bad query' }] }));
    await expect(
      fetchClassACount({
        fetchImpl: failing.fetchImpl,
        token: 'fake-token',
        accountId: 'fake-account',
        bucket: 'pilot-bucket',
        from: 'a',
        to: 'b',
      }),
    ).rejects.toThrow(/bad query/);
  });

  it('compares Class A counts only when Cloudflare credentials are configured', async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = mockFetch((url, init) => {
      if (url.hostname === 'api.cloudflare.com') {
        const body = JSON.parse(init.body as string);
        const count = body.variables.from === 'before-from' ? 4 : 9;
        return Response.json({
          data: {
            viewer: {
              accounts: [{ r2OperationsAdaptiveGroups: [{ sum: { requests: count } }] }],
            },
          },
        });
      }
      clock.advance(10);
      return new Response(null, { status: 200 });
    });
    const r2Window = {
      before: { from: 'before-from', to: 'before-to' },
      after: { from: 'after-from', to: 'after-to' },
    };
    const result = await runMeasurement({
      target: 'https://pilot.example.test',
      pageId: 'page-1',
      requests: 2,
      fetchImpl,
      now: clock.now,
      env: {
        CLOUDFLARE_API_TOKEN: 'fake-token',
        CLOUDFLARE_ACCOUNT_ID: 'fake-account',
        R2_BUCKET: 'pilot-bucket',
      },
      r2Window,
    });

    expect(result.classA).toEqual({ operationClass: 'A', before: 4, after: 9, delta: 5 });
    expect(calls.filter((call) => call.url.hostname === 'api.cloudflare.com')).toHaveLength(2);

    const withoutEnv = mockFetch(() => {
      clock.advance(10);
      return new Response(null, { status: 200 });
    });
    const skipped = await runMeasurement({
      target: 'https://pilot.example.test',
      pageId: 'page-1',
      requests: 1,
      fetchImpl: withoutEnv.fetchImpl,
      now: clock.now,
      env: {},
    });
    expect(skipped.classA).toBeNull();
    expect(withoutEnv.calls).toHaveLength(1);
  });
});
