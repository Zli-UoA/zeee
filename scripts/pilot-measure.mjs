import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_LIST_PATH = '/api/pages';
const SNAPSHOT_SUFFIX = '/snapshot';
const DEFAULT_REQUESTS = 20;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const R2_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const R2_WINDOW_MS = 60_000;

export const HELP = `Usage: node scripts/pilot-measure.mjs --target <baseUrl> [options]

Measure POST /api/pages/:id/snapshot (D1 materialize + DO snapshot) latency.
Only a small number of requests are sent by default; use --dry-run to plan
without touching a deployment at all.

Env:
  ZEEE_BASE_URL              Base URL (alternative to --target)
  ZEEE_SESSION_COOKIE        Full Cookie header (alternative to --session-cookie)
  CLOUDFLARE_API_TOKEN       When all three Cloudflare vars below are set,
  CLOUDFLARE_ACCOUNT_ID        Class A operations are compared before/after
  R2_BUCKET                    the run via the Cloudflare GraphQL API.

Options:
  --target <url>            Deployment base URL (http/https; required unless --dry-run)
  --page-id <id>            Page to snapshot (otherwise GET /api/pages?limit=1)
  --requests <n>            Number of requests (default: ${DEFAULT_REQUESTS})
  --concurrency <n>         Parallel workers (default: ${DEFAULT_CONCURRENCY})
  --out <file>              Also write the JSON report to this file
  --session-cookie <...>    Full Cookie header value (never printed)
  --timeout-ms <n>          Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --label <name>            Run label, e.g. "1-node" or "3-node"
  --max-error-rate <f>      Fail if error rate > f (0..1)
  --max-p95-ms <n>          Fail if p95 latency > n ms
  --dry-run                 Print the plan only; no HTTP requests
  --help                    Show this help
`;

/** Configuration error. Never holds a cookie, token or other credential. */
export class MeasureError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MeasureError';
  }
}

export function parseArgs(argv) {
  const parsed = {
    target: null,
    pageId: null,
    requests: DEFAULT_REQUESTS,
    concurrency: DEFAULT_CONCURRENCY,
    out: null,
    sessionCookie: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    label: null,
    maxErrorRate: null,
    maxP95Ms: null,
    dryRun: false,
    help: false,
  };
  const valueAt = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value === '') throw new MeasureError(`${flag} requires a value`);
    return value;
  };
  const positiveInt = (raw, flag) => {
    if (!/^[1-9]\d*$/.test(raw)) throw new MeasureError(`${flag} must be a positive integer`);
    return Number(raw);
  };
  const nonNegativeInt = (raw, flag) => {
    if (!/^\d+$/.test(raw)) throw new MeasureError(`${flag} must be a non-negative integer`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    // Do not split on '=' blindly: a Cookie header value commonly contains '='.
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => (inline === undefined ? valueAt(++i, name) : inline);
    if (name === '--help' || name === '-h') parsed.help = true;
    else if (name === '--dry-run') parsed.dryRun = true;
    else if (name === '--target') parsed.target = value();
    else if (name === '--page-id') parsed.pageId = value();
    else if (name === '--out') parsed.out = value();
    else if (name === '--session-cookie') parsed.sessionCookie = value();
    else if (name === '--label') parsed.label = value();
    else if (name === '--requests') parsed.requests = positiveInt(value(), name);
    else if (name === '--concurrency') parsed.concurrency = positiveInt(value(), name);
    else if (name === '--timeout-ms') parsed.timeoutMs = positiveInt(value(), name);
    else if (name === '--max-p95-ms') parsed.maxP95Ms = nonNegativeInt(value(), name);
    else if (name === '--max-error-rate') {
      const rate = Number(value());
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new MeasureError('--max-error-rate must be a number between 0 and 1');
      }
      parsed.maxErrorRate = rate;
    } else {
      throw new MeasureError(`unknown option: ${arg}`);
    }
  }
  // Target/cookie may come from the environment; main() enforces them for real runs.
  return parsed;
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MeasureError('--target must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new MeasureError('--target must be an http(s) URL without credentials');
  }
  return url;
}

function requestHeaders(cookie, url) {
  const headers = { origin: url.origin };
  if (cookie) headers.cookie = cookie;
  return headers;
}

const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Linear-interpolation percentile over an unsorted copy of the samples. */
export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new MeasureError('percentile fraction must be between 0 and 1');
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower), 6);
}

export function countStatuses(samples) {
  const counts = {};
  for (const sample of samples) {
    const key = sample.status == null ? 'network' : String(sample.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function summarizeMeasurements(samples, { elapsedMs = 0 } = {}) {
  const latencies = samples.map((sample) => sample.latencyMs);
  const errors = samples.filter((sample) => !sample.ok).length;
  const requests = samples.length;
  return {
    requests,
    successes: requests - errors,
    errors,
    errorRate: requests === 0 ? 0 : round(errors / requests),
    elapsedMs: round(elapsedMs),
    requestsPerSecond: elapsedMs > 0 ? round(requests / (elapsedMs / 1000)) : null,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            min: round(Math.min(...latencies)),
            p50: round(percentile(latencies, 0.5)),
            p95: round(percentile(latencies, 0.95)),
            p99: round(percentile(latencies, 0.99)),
            max: round(Math.max(...latencies)),
          },
    statusCounts: countStatuses(samples),
  };
}

export function evaluateThresholds(summary, { maxErrorRate, maxP95Ms } = {}) {
  const violations = [];
  if (maxErrorRate != null && summary.errorRate > maxErrorRate) {
    violations.push(`error rate ${summary.errorRate} > ${maxErrorRate}`);
  }
  if (maxP95Ms != null && summary.latencyMs?.p95 > maxP95Ms) {
    violations.push(`p95 latency ${summary.latencyMs.p95}ms > ${maxP95Ms}ms`);
  }
  return violations;
}

/** Pick one active page id, or use --page-id directly. Only one list request. */
export async function resolvePageId(options) {
  const {
    baseUrl,
    pageId,
    cookie = '',
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
  } = options;
  const url = baseUrl instanceof URL ? baseUrl : normalizeBaseUrl(baseUrl);
  if (pageId != null) {
    if (typeof pageId !== 'string' || !SAFE_PAGE_ID.test(pageId)) {
      throw new MeasureError('invalid --page-id');
    }
    log(`using page id ${pageId}`);
    return pageId;
  }
  const target = new URL(PAGE_LIST_PATH, url);
  target.searchParams.set('limit', '1');
  let response;
  try {
    response = await fetchImpl(target, {
      headers: requestHeaders(cookie, url),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new MeasureError(`GET ${PAGE_LIST_PATH}: network error: ${error?.message ?? error}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new MeasureError(`GET ${PAGE_LIST_PATH}: HTTP ${response.status} ${response.statusText}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new MeasureError(`GET ${PAGE_LIST_PATH}: invalid JSON response`, { cause: error });
  }
  const id = payload?.pages?.[0]?.id;
  if (typeof id !== 'string' || !SAFE_PAGE_ID.test(id)) {
    throw new MeasureError(`GET ${PAGE_LIST_PATH}: no valid page id in response`);
  }
  log(`using page id ${id} from ${PAGE_LIST_PATH}`);
  return id;
}

/** One snapshot request. HTTP errors become error samples, never exceptions. */
async function sendSnapshot(options) {
  const { url, pageId, cookie, timeoutMs, index, total, fetchImpl, now, log } = options;
  const startedAt = now();
  let status = null;
  let ok = false;
  let error = null;
  try {
    const response = await fetchImpl(
      new URL(`/api/pages/${encodeURIComponent(pageId)}${SNAPSHOT_SUFFIX}`, url),
      {
        method: 'POST',
        headers: requestHeaders(cookie, url),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    status = response.status;
    ok = response.ok;
    try {
      await response.body?.cancel?.();
    } catch {
      // Body cancellation is housekeeping; the response status is already recorded.
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const latencyMs = now() - startedAt;
  log(`[${index + 1}/${total}] ${ok ? 'OK' : 'ERR'} ${status ?? error} ${round(latencyMs)}ms`);
  return { index, latencyMs, ok, status, error };
}

export function r2ConfigFromEnv(env) {
  const token = env?.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  const bucket = env?.R2_BUCKET?.trim() ?? '';
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  if (!token || !bucket) return null;
  if (!accountId) {
    throw new MeasureError(
      'CLOUDFLARE_ACCOUNT_ID is required when CLOUDFLARE_API_TOKEN and R2_BUCKET are set',
    );
  }
  return { token, bucket, accountId };
}

const CLASS_A_QUERY = `
  query R2ClassA($accountId: String!, $bucket: String!, $from: Time!, $to: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountId }) {
        r2OperationsAdaptiveGroups(
          filter: { bucket: $bucket, class: "A", datetime_ge: $from, datetime_lt: $to }
          limit: 10000
        ) {
          sum { requests }
          dimensions { bucket class }
        }
      }
    }
  }
`;

/** Fetch one Class A count. `fetchImpl` is injected so tests do no network I/O. */
export async function fetchClassACount(options) {
  const { fetchImpl = fetch, token, accountId, bucket, from, to } = options;
  if (!token || !accountId || !bucket) {
    throw new MeasureError('token, accountId and bucket are required for R2 analytics');
  }
  let response;
  try {
    response = await fetchImpl(R2_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: CLASS_A_QUERY,
        variables: { accountId, bucket, from, to },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MeasureError(`R2 analytics: network error: ${error?.message ?? error}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new MeasureError(`R2 analytics: HTTP ${response.status} ${response.statusText}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new MeasureError('R2 analytics: invalid JSON response', { cause: error });
  }
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new MeasureError(`R2 analytics: ${payload.errors[0]?.message ?? 'GraphQL error'}`);
  }
  const groups = payload?.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    throw new MeasureError('R2 analytics: missing r2OperationsAdaptiveGroups');
  }
  return groups.reduce((total, group) => total + (Number(group?.sum?.requests) || 0), 0);
}

/** Pure before/after aggregation for the Class A comparison. */
export function summarizeClassA(before, after) {
  for (const [name, value] of [
    ['before', before],
    ['after', after],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new MeasureError(`${name} must be a non-negative finite number`);
    }
  }
  return { operationClass: 'A', before, after, delta: after - before };
}

/**
 * Run the measurement. Only `fetchImpl`, `now` and `env` are injected by tests;
 * every request failure is recorded as a sample instead of being thrown.
 */
export async function runMeasurement(options = {}) {
  const {
    target,
    pageId = null,
    requests = DEFAULT_REQUESTS,
    concurrency = DEFAULT_CONCURRENCY,
    cookie = '',
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = null,
    maxErrorRate = null,
    maxP95Ms = null,
    fetchImpl = fetch,
    now = () => performance.now(),
    log = () => {},
    env = process.env,
    r2Window = null,
  } = options;
  const url = target == null ? null : normalizeBaseUrl(target);
  if (!dryRun && !url) throw new MeasureError('--target (or ZEEE_BASE_URL) is required');
  if (!Number.isInteger(requests) || requests < 1) {
    throw new MeasureError('--requests must be a positive integer');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new MeasureError('--concurrency must be a positive integer');
  }

  const common = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    label,
    dryRun,
    target: url?.origin ?? null,
    pageId: pageId ?? null,
    requests,
    concurrency,
    classA: null,
    violations: [],
  };

  if (dryRun) {
    log(
      `[dry-run] would send ${requests} POST ${SNAPSHOT_SUFFIX} request(s), concurrency ${concurrency}`,
    );
    return {
      ...common,
      plan: {
        requests,
        concurrency,
        endpoint:
          url && pageId
            ? new URL(`/api/pages/${encodeURIComponent(pageId)}${SNAPSHOT_SUFFIX}`, url).toString()
            : null,
        pageFromList: pageId == null,
      },
      summary: null,
      samples: [],
    };
  }

  const r2 = r2ConfigFromEnv(env);
  let classABefore = null;
  if (r2) {
    const window =
      r2Window?.before ??
      (() => {
        const end = Date.now();
        return {
          from: new Date(end - R2_WINDOW_MS).toISOString(),
          to: new Date(end).toISOString(),
        };
      })();
    classABefore = await fetchClassACount({ fetchImpl, ...r2, ...window });
  }

  const id = await resolvePageId({ baseUrl: url, pageId, cookie, fetchImpl, timeoutMs, log });
  const samples = Array.from({ length: requests });
  let cursor = 0;
  const startedAt = now();
  const workers = Array.from({ length: Math.min(concurrency, requests) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= requests) return;
      samples[index] = await sendSnapshot({
        url,
        pageId: id,
        cookie,
        timeoutMs,
        index,
        total: requests,
        fetchImpl,
        now,
        log,
      });
    }
  });
  await Promise.all(workers);
  const elapsedMs = now() - startedAt;

  let classA = null;
  if (r2) {
    const window =
      r2Window?.after ??
      (() => {
        const start = Date.now() - elapsedMs;
        return {
          from: new Date(start).toISOString(),
          to: new Date(start + elapsedMs).toISOString(),
        };
      })();
    const classAAfter = await fetchClassACount({ fetchImpl, ...r2, ...window });
    classA = summarizeClassA(classABefore, classAAfter);
  }

  const summary = summarizeMeasurements(samples, { elapsedMs });
  const violations = evaluateThresholds(summary, { maxErrorRate, maxP95Ms });
  log(
    `${requests} request(s): errors ${summary.errors}/${requests}, ` +
      `p50 ${summary.latencyMs?.p50 ?? '-'}ms, p95 ${summary.latencyMs?.p95 ?? '-'}ms, ` +
      `p99 ${summary.latencyMs?.p99 ?? '-'}ms`,
  );
  return {
    ...common,
    pageId: id,
    summary,
    samples,
    classA,
    violations,
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const log = dependencies.log ?? ((message) => console.error(message));
  const emit = dependencies.emit ?? ((json) => console.log(json));
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  const setExitCode =
    dependencies.setExitCode ??
    ((code) => {
      process.exitCode = code;
    });
  const now = dependencies.now ?? (() => performance.now());
  const r2Window = dependencies.r2Window ?? null;

  const options = parseArgs(argv);
  if (options.help) {
    log(HELP);
    return null;
  }
  const target = options.target ?? env.ZEEE_BASE_URL ?? null;
  const cookie = options.sessionCookie ?? env.ZEEE_SESSION_COOKIE ?? '';
  if (!options.dryRun && !target) {
    throw new MeasureError('--target (or ZEEE_BASE_URL) is required');
  }
  if (!options.dryRun && !cookie) {
    throw new MeasureError(
      '--session-cookie (or ZEEE_SESSION_COOKIE) is required for snapshot requests',
    );
  }

  const result = await runMeasurement({
    ...options,
    target,
    cookie,
    env,
    fetchImpl,
    log,
    now,
    r2Window,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  emit(json);
  if (options.out) await writeFileImpl(options.out, json);

  if (!result.dryRun && (result.summary.errors > 0 || result.violations.length > 0)) {
    setExitCode(1);
  }
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`pilot-measure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
