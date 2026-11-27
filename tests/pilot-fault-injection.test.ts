import { describe, expect, it } from 'vite-plus/test';

// @ts-expect-error - the CLI is plain .mjs and has no TypeScript declarations.
import { buildKubectlArgs, main, run } from '../scripts/pilot-fault-injection.mjs';

type Probe = { status: number; body?: unknown };
type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Runner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
type Deps = {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  runner?: Runner;
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  recoveryTimeoutMs?: number;
  pollIntervalMs?: number;
};

const OK: Probe = { status: 200, body: { ok: true } };
const UNHEALTHY: Probe = { status: 503, body: { ok: false } };

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PILOT_BASE_URL: 'http://127.0.0.1:17900',
    PILOT_NAMESPACE: 'workerd-pilot',
    PILOT_DEPLOYMENT: 'workerd',
    ...overrides,
  };
}

/** Returns probe responses in order, repeating the last one. */
function mockProbes(probes: Probe[]) {
  const paths: string[] = [];
  let index = 0;
  const fetchImpl: FetchImpl = async (input) => {
    paths.push(new URL(input).pathname);
    const probe = probes[Math.min(index, probes.length - 1)];
    index += 1;
    return Response.json(probe.body ?? { ok: true }, { status: probe.status });
  };
  return { fetchImpl, paths };
}

function fakeRunner(onCall?: () => void) {
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    onCall?.();
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function captureLogs() {
  const messages: string[] = [];
  return { messages, log: (message: string) => messages.push(message) };
}

describe('pilot-fault-injection', () => {
  it('builds the exact kubectl argument vectors for each mutation', () => {
    const names = { namespace: 'workerd-pilot', deployment: 'workerd', pod: 'workerd-abc' };
    expect(buildKubectlArgs('kill-pod', names)).toEqual([
      ['-n', 'workerd-pilot', 'delete', 'pod', 'workerd-abc', '--grace-period=0', '--force'],
    ]);
    expect(buildKubectlArgs('rolling-restart', names)).toEqual([
      ['-n', 'workerd-pilot', 'rollout', 'restart', 'deployment/workerd'],
      ['-n', 'workerd-pilot', 'rollout', 'status', 'deployment/workerd', '--timeout=180s'],
    ]);
    expect(buildKubectlArgs('rollback', names)).toEqual([
      ['-n', 'workerd-pilot', 'rollout', 'undo', 'deployment/workerd'],
    ]);
  });

  it('runs kill-pod with --force and checks health before and after', async () => {
    const { runner, calls } = fakeRunner();
    const { fetchImpl, paths } = mockProbes([OK]);
    const result = await run(['kill-pod', 'workerd-abc', '--confirm'], {
      env: baseEnv(),
      runner,
      fetchImpl,
      log: () => {},
      logError: () => {},
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      ['-n', 'workerd-pilot', 'delete', 'pod', 'workerd-abc', '--grace-period=0', '--force'],
    ]);
    expect(paths).toEqual(['/api/health', '/ready', '/api/health', '/ready']);
  });

  it('runs rollout restart then rollout status', async () => {
    const { runner, calls } = fakeRunner();
    const { fetchImpl } = mockProbes([OK]);
    expect(
      await run(['rolling-restart', '--confirm'], {
        env: baseEnv(),
        runner,
        fetchImpl,
        log: () => {},
        logError: () => {},
      }),
    ).toBe(0);
    expect(calls).toEqual([
      ['-n', 'workerd-pilot', 'rollout', 'restart', 'deployment/workerd'],
      ['-n', 'workerd-pilot', 'rollout', 'status', 'deployment/workerd', '--timeout=180s'],
    ]);
  });

  it('runs rollout undo for rollback', async () => {
    const { runner, calls } = fakeRunner();
    const { fetchImpl } = mockProbes([OK]);
    expect(
      await run(['rollback', '--confirm'], {
        env: baseEnv(),
        runner,
        fetchImpl,
        log: () => {},
        logError: () => {},
      }),
    ).toBe(0);
    expect(calls).toEqual([['-n', 'workerd-pilot', 'rollout', 'undo', 'deployment/workerd']]);
  });

  it('check is read-only and probes both endpoints', async () => {
    const { runner, calls } = fakeRunner();
    const { fetchImpl, paths } = mockProbes([OK]);
    expect(
      await run(['check'], {
        env: baseEnv(),
        runner,
        fetchImpl,
        log: () => {},
        logError: () => {},
      }),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(paths).toEqual(['/api/health', '/ready']);
  });

  it('defaults to dry-run: no kubectl call and no HTTP call without --confirm', async () => {
    const { runner, calls } = fakeRunner();
    const { fetchImpl, paths } = mockProbes([OK]);
    const { messages, log } = captureLogs();
    const result = await main(['rolling-restart'], {
      env: baseEnv(),
      runner,
      fetchImpl,
      log,
    });

    expect(result).toMatchObject({ command: 'rolling-restart', dryRun: true });
    expect(calls).toEqual([]);
    expect(paths).toEqual([]);
    expect(messages.join('\n')).toContain('--confirm');
    expect(messages.join('\n')).toContain(
      'kubectl -n workerd-pilot rollout restart deployment/workerd',
    );
  });

  it('rejects production-looking namespace, deployment and pod names', async () => {
    for (const env of [
      baseEnv({ PILOT_NAMESPACE: 'production' }),
      baseEnv({ PILOT_DEPLOYMENT: 'zeee-workerd' }),
    ]) {
      const { runner, calls } = fakeRunner();
      const { fetchImpl, paths } = mockProbes([OK]);
      const errors: string[] = [];
      expect(
        await run(['kill-pod', 'workerd-abc', '--confirm'], {
          env,
          runner,
          fetchImpl,
          log: () => {},
          logError: (message: string) => errors.push(message),
        }),
      ).toBe(1);
      expect(errors.join('\n')).toContain('looks non-pilot');
      expect(calls).toEqual([]);
      expect(paths).toEqual([]);
    }

    const { runner, calls } = fakeRunner();
    const errors: string[] = [];
    expect(
      await run(['kill-pod', 'production-pod-1', '--confirm'], {
        env: baseEnv(),
        runner,
        fetchImpl: mockProbes([OK]).fetchImpl,
        log: () => {},
        logError: (message: string) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('pod looks non-pilot');
    expect(calls).toEqual([]);
  });

  it('requires PILOT_NAMESPACE / PILOT_DEPLOYMENT / PILOT_BASE_URL with --confirm', async () => {
    for (const [env, missing] of [
      [baseEnv({ PILOT_NAMESPACE: undefined }), 'PILOT_NAMESPACE'],
      [baseEnv({ PILOT_DEPLOYMENT: undefined }), 'PILOT_DEPLOYMENT'],
      [baseEnv({ PILOT_BASE_URL: undefined }), 'PILOT_BASE_URL'],
    ] as const) {
      const { runner, calls } = fakeRunner();
      const errors: string[] = [];
      expect(
        await run(['rolling-restart', '--confirm'], {
          env,
          runner,
          fetchImpl: mockProbes([OK]).fetchImpl,
          log: () => {},
          logError: (message: string) => errors.push(message),
        }),
      ).toBe(1);
      expect(errors[0]).toContain(missing);
      expect(calls).toEqual([]);
    }
  });

  it('polls until healthy and reports recovery time in seconds', async () => {
    let time = 0;
    const { runner } = fakeRunner(() => {
      time += 2_000;
    });
    const { fetchImpl, paths } = mockProbes([OK, OK, UNHEALTHY, OK]);
    const { messages, log } = captureLogs();

    const result = await main(['kill-pod', 'workerd-abc', '--confirm'], {
      env: baseEnv(),
      runner,
      fetchImpl,
      log,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      pollIntervalMs: 1_000,
      recoveryTimeoutMs: 10_000,
    });

    expect(result).toMatchObject({ recoveryMs: 3_000 });
    expect(messages.join('\n')).toContain('recovery time: 3.00s');
    expect(messages.join('\n')).toContain('waiting for recovery: GET /api/health: HTTP 503');
    expect(paths).toEqual(['/api/health', '/ready', '/api/health', '/api/health', '/ready']);
  });

  it('exits non-zero when the pre-check fails, kubectl fails, or recovery times out', async () => {
    const failure = (overrides: Partial<Deps>, probes: Probe[]) => {
      const { fetchImpl } = mockProbes(probes);
      const errors: string[] = [];
      return run(['rolling-restart', '--confirm'], {
        env: baseEnv(),
        fetchImpl,
        log: () => {},
        logError: (message: string) => errors.push(message),
        ...overrides,
      }).then((code: number) => ({ code, errors }));
    };

    const noRunner = fakeRunner();
    const badPre = await failure({ runner: noRunner.runner }, [UNHEALTHY]);
    expect(badPre.code).toBe(1);
    expect(badPre.errors[0]).toContain('GET /api/health: HTTP 503');
    expect(noRunner.calls).toEqual([]);

    const throwing = await failure(
      {
        runner: async () => {
          throw new Error('kubectl failed');
        },
      },
      [OK],
    );
    expect(throwing.code).toBe(1);
    expect(throwing.errors[0]).toContain('kubectl failed');

    let time = 0;
    const timedOut = await failure(
      {
        runner: fakeRunner().runner,
        now: () => time,
        sleep: async (ms: number) => {
          time += ms;
        },
        recoveryTimeoutMs: 2_000,
        pollIntervalMs: 1_000,
      },
      [OK, OK, UNHEALTHY],
    );
    expect(timedOut.code).toBe(1);
    expect(timedOut.errors[0]).toContain('did not recover within 2s');
  });

  it('check fails with a non-zero exit code when /ready is not serving', async () => {
    const errors: string[] = [];
    const { fetchImpl } = mockProbes([OK, { status: 503 }]);
    expect(
      await run(['check'], {
        env: baseEnv(),
        fetchImpl,
        log: () => {},
        logError: (message: string) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors[0]).toContain('GET /ready: HTTP 503');
  });
});
