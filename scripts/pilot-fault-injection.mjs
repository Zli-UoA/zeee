import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_KUBECTL = 'kubectl';
const ROLLOUT_TIMEOUT_SECONDS = 180;
const CHECK_TIMEOUT_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
const SUBCOMMANDS = new Set(['kill-pod', 'rolling-restart', 'rollback', 'check']);

/** Names that must never be passed to a fault-injection command. */
const UNSAFE_NAME_PARTS = ['prod', 'zeee', 'main', 'master', 'default'];

export const HELP = `Usage: node scripts/pilot-fault-injection.mjs <subcommand> [options]

Subcommands:
  kill-pod <pod>   Delete a pod with --grace-period=0 --force (SIGKILL equivalent)
  rolling-restart  rollout restart + rollout status for the pilot Deployment
  rollback         rollout undo + rollout status for the pilot Deployment
  check            GET /api/health and GET /ready (read-only, no --confirm needed)

Options:
  --confirm        Execute the operation. Without it every command is a dry-run.
  --help, -h       Show this help

Env (all values must be non-production pilot values):
  PILOT_BASE_URL   Base URL of the pilot deployment, e.g. a local port-forward URL
  PILOT_NAMESPACE  Pilot namespace (required for executing mutations)
  PILOT_DEPLOYMENT Pilot Deployment name (required for executing mutations)
  KUBECTL          kubectl executable (default: kubectl)

Mutating commands run a health check before and after the operation and print
the recovery time in seconds. Names and the whole base URL (host AND path)
containing prod / zeee / main / master / default are rejected as a safety guard.

WARNINGS - read these before using the output as evidence:
  1. kill-pod sends --grace-period=0 --force (SIGKILL equivalent). It skips the
     preStop.sleep (5s), WORKERD_SHUTDOWN_DELAY_MS=20000 and
     WORKERD_CLUSTER_STOP_TIMEOUT_MS=8000 graceful shutdown path, so the
     Durable Object's clean handoff to another node is bypassed. Do NOT use
     kill-pod as evidence for "no data loss" or clean DO handoff; use
     rolling-restart for that purpose.
  2. "recovery time" is a HEURISTIC: it only measures until GET /api/health
     answers 200 with {"ok":true} and GET /ready answers 200. It does NOT prove
     the Durable Object handoff completed. Verify WebSocket close code 1012,
     reconnect behaviour and DO ownership transfer separately. rolling-restart
     and rollback also wait for rollout status, but even that does not prove
     DO handoff.
  3. Probes go through a port-forward that may point at the fault-target Pod.
     If that Pod dies the port-forward drops and the probe fails with a network
     error until the 120s timeout (a false negative). A probe answered by a
     different Pod can also look like a falsely quick recovery. Point the
     port-forward at the Service (or at a Pod that is NOT the fault target) and
     confirm which Pod answered before trusting the number.
`;

/** An error that is safe to print (never contains credentials). */
export class PilotError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PilotError';
  }
}

export function parseArgs(argv) {
  // Help must work even without (or before) a valid subcommand.
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    return { command: null, confirm: false, help: true, pod: null };
  }

  const [command, ...rest] = argv;
  if (!command) throw new PilotError(`missing subcommand (${[...SUBCOMMANDS].join(', ')})`);
  if (!SUBCOMMANDS.has(command)) throw new PilotError(`unknown subcommand: ${command}`);

  const options = { command, confirm: false, help: false, pod: null };
  for (const arg of rest) {
    if (arg === '--confirm') options.confirm = true;
    else if (command === 'kill-pod' && options.pod === null && !arg.startsWith('-'))
      options.pod = arg;
    else throw new PilotError(`unexpected argument: ${arg}`);
  }
  if (command === 'kill-pod' && !options.pod) throw new PilotError('kill-pod requires <pod>');
  return options;
}

/** Reject production-looking names before any kubectl or HTTP call. */
export function assertSafeName(label, value) {
  if (typeof value !== 'string' || value.trim() === '') return;
  const lowered = value.toLowerCase();
  const unsafe = UNSAFE_NAME_PARTS.find((part) => lowered.includes(part));
  if (unsafe !== undefined) {
    throw new PilotError(`${label} looks non-pilot (contains "${unsafe}"): ${value}`);
  }
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PilotError('PILOT_BASE_URL must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PilotError('PILOT_BASE_URL must be an http(s) URL without credentials');
  }
  // Check the whole URL, not just the hostname: a pilot-looking host with a
  // production-looking path (e.g. /prod) must be rejected as well.
  assertSafeName('PILOT_BASE_URL', url.href);
  return url;
}

/** Build the exact kubectl argument vectors. Exported for inspection in tests. */
export function buildKubectlArgs(command, { namespace, deployment, pod }) {
  if (command === 'kill-pod') {
    return [['-n', namespace, 'delete', 'pod', pod, '--grace-period=0', '--force']];
  }
  if (command === 'rolling-restart') {
    const target = `deployment/${deployment}`;
    return [
      ['-n', namespace, 'rollout', 'restart', target],
      ['-n', namespace, 'rollout', 'status', target, `--timeout=${ROLLOUT_TIMEOUT_SECONDS}s`],
    ];
  }
  if (command === 'rollback') {
    const target = `deployment/${deployment}`;
    return [
      ['-n', namespace, 'rollout', 'undo', target],
      ['-n', namespace, 'rollout', 'status', target, `--timeout=${ROLLOUT_TIMEOUT_SECONDS}s`],
    ];
  }
  throw new PilotError(`no kubectl command for subcommand: ${command}`);
}

function defaultRunner(executable) {
  return async (args) => {
    const { stdout } = await execFileAsync(executable, args);
    return { stdout, stderr: '' };
  };
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Probe the two pilot endpoints. /api/health must answer 200 with {"ok":true};
 * /ready must answer 200 (503 means starting or stopping).
 */
export async function checkHealth(baseUrl, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? CHECK_TIMEOUT_MS;
  const url = String(baseUrl).replace(/\/$/, '');

  // One signal per probe: sharing a single signal would make `timeoutMs` a
  // combined budget for both requests instead of a per-request timeout.
  let health;
  try {
    health = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new PilotError(`GET /api/health: network error: ${error.message}`, { cause: error });
  }
  if (!health.ok) {
    throw new PilotError(`GET /api/health: HTTP ${health.status}`);
  }
  let body;
  try {
    body = await health.json();
  } catch (error) {
    throw new PilotError('GET /api/health: invalid JSON body', { cause: error });
  }
  if (body?.ok !== true) {
    throw new PilotError('GET /api/health: body.ok is not true');
  }

  let ready;
  try {
    ready = await fetchImpl(`${url}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new PilotError(`GET /ready: network error: ${error.message}`, { cause: error });
  }
  if (!ready.ok) {
    throw new PilotError(`GET /ready: HTTP ${ready.status}`);
  }
  return { ok: true };
}

/** Poll until both endpoints recover, with a bounded deadline. */
export async function waitForHealthy(baseUrl, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const log = dependencies.log ?? console.log;
  const recoveryTimeoutMs = dependencies.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;
  const checkOptions = {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.checkTimeoutMs,
  };
  const startedAt = now();

  for (;;) {
    try {
      await checkHealth(baseUrl, checkOptions);
      return { ok: true };
    } catch (error) {
      const elapsed = now() - startedAt;
      if (elapsed >= recoveryTimeoutMs) {
        throw new PilotError(
          `health did not recover within ${recoveryTimeoutMs / 1000}s: ${error.message}`,
          { cause: error },
        );
      }
      log(`waiting for recovery: ${error.message}`);
      await sleep(pollIntervalMs);
    }
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const log = dependencies.log ?? console.log;
  const options = parseArgs(argv);
  if (options.help) {
    log(HELP);
    return null;
  }

  if (options.command === 'check') {
    const baseUrl = normalizeBaseUrl(env.PILOT_BASE_URL);
    await checkHealth(baseUrl, {
      fetchImpl: dependencies.fetchImpl,
      timeoutMs: dependencies.checkTimeoutMs,
    });
    log('check: OK');
    return { command: 'check', ok: true, dryRun: false };
  }

  const namespace = env.PILOT_NAMESPACE;
  const deployment = env.PILOT_DEPLOYMENT;
  assertSafeName('PILOT_NAMESPACE', namespace);
  assertSafeName('PILOT_DEPLOYMENT', deployment);
  assertSafeName('pod', options.pod);

  const names = {
    namespace: namespace || '<PILOT_NAMESPACE>',
    deployment: deployment || '<PILOT_DEPLOYMENT>',
    pod: options.pod,
  };
  const commands = buildKubectlArgs(options.command, names);

  if (!options.confirm) {
    log(
      `[dry-run] ${options.command}: no kubectl or HTTP call was made (pass --confirm to execute)`,
    );
    for (const args of commands) log(`[dry-run] would run: kubectl ${args.join(' ')}`);
    log(
      `[dry-run] would check: GET ${normalizeBaseUrlOrPlaceholder(env.PILOT_BASE_URL)}/api/health and /ready`,
    );
    return { command: options.command, dryRun: true, commands, recoveryMs: null };
  }

  if (!namespace || !deployment || !env.PILOT_BASE_URL) {
    throw new PilotError(
      'set PILOT_NAMESPACE, PILOT_DEPLOYMENT and PILOT_BASE_URL before using --confirm',
    );
  }
  const baseUrl = normalizeBaseUrl(env.PILOT_BASE_URL);
  const runner = dependencies.runner ?? defaultRunner(env.KUBECTL || DEFAULT_KUBECTL);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;

  const dependenciesForCheck = {
    fetchImpl: dependencies.fetchImpl,
    checkTimeoutMs: dependencies.checkTimeoutMs,
    recoveryTimeoutMs: dependencies.recoveryTimeoutMs,
    pollIntervalMs: dependencies.pollIntervalMs,
    now,
    sleep,
    log,
  };

  await checkHealth(baseUrl, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.checkTimeoutMs,
  });
  log('pre-check: OK');
  const startedAt = now();

  for (const args of commands) {
    log(`kubectl ${args.join(' ')}`);
    await runner(args);
  }

  await waitForHealthy(baseUrl, dependenciesForCheck);
  const recoveryMs = now() - startedAt;
  log(`recovery time: ${(recoveryMs / 1000).toFixed(2)}s`);
  return { command: options.command, dryRun: false, commands, recoveryMs };
}

function normalizeBaseUrlOrPlaceholder(value) {
  if (!value) return '<PILOT_BASE_URL>';
  try {
    return normalizeBaseUrl(value).origin;
  } catch {
    return '<PILOT_BASE_URL>';
  }
}

/** CLI entry point that converts failures into a non-zero exit code. */
export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const logError = dependencies.logError ?? console.error;
  try {
    await main(argv, dependencies);
    return 0;
  } catch (error) {
    logError(`pilot-fault-injection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
