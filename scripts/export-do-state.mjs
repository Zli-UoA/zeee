import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_LIST_PATH = '/api/pages';
const STATE_SUFFIX = '/state';
const MAX_REQUEST_PAGE_SIZE = 100; // src/server/pagination.ts: MAX_PAGE_SIZE
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const HELP = `Usage: node scripts/export-do-state.mjs --out <dir> [options]

Env:
  ZEEE_BASE_URL        Base URL of the deployment (required, http/https only)
  ZEEE_SESSION_COOKIE  Full Cookie header value (e.g. __Host-zeee_session=...)
  ZEEE_DEV_AUTH        Set to 1 for a local dev session (loopback hosts only)

Options:
  --out <dir>      Output directory (default: backups/state). Files: <pageId>.yjs
  --limit <n>      Export at most n pages
  --dry-run        Only list page ids and planned file names; no state GET / writes
  --retries <n>    Retries for network errors, 429 and 5xx (default: 2)
  --help           Show this help
`;

/** A failure with an explicit HTTP status where applicable. Never holds credentials. */
export class ExportError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExportError';
    this.status = options.status;
    this.path = options.path;
  }
}

export function parseArgs(argv) {
  const parsed = {
    outdir: 'backups/state',
    limit: null,
    dryRun: false,
    retries: DEFAULT_RETRIES,
    help: false,
  };
  const valueAt = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value === '') throw new ExportError(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--out') parsed.outdir = valueAt(++i, arg);
    else if (arg.startsWith('--out=')) parsed.outdir = arg.slice('--out='.length);
    else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg === '--limit' ? valueAt(++i, arg) : arg.slice('--limit='.length);
      if (!/^[1-9]\d*$/.test(raw)) throw new ExportError('--limit must be a positive integer');
      parsed.limit = Number(raw);
    } else if (arg === '--retries' || arg.startsWith('--retries=')) {
      const raw = arg === '--retries' ? valueAt(++i, arg) : arg.slice('--retries='.length);
      if (!/^\d+$/.test(raw)) throw new ExportError('--retries must be a non-negative integer');
      parsed.retries = Number(raw);
    } else {
      throw new ExportError(`unknown option: ${arg}`);
    }
  }
  if (!parsed.outdir) throw new ExportError('--out requires a value');
  return parsed;
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ExportError('ZEEE_BASE_URL must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ExportError('ZEEE_BASE_URL must be an http(s) URL without credentials');
  }
  return url;
}

function isLoopback(url) {
  return LOOPBACK_HOSTS.has(url.hostname);
}

function requestHeaders(cookie, url) {
  const headers = { origin: url.origin };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function timeoutSignal(timeoutMs) {
  return timeoutMs == null ? undefined : AbortSignal.timeout(timeoutMs);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Retry network failures, 429 and 5xx. 4xx (other than 429) is a hard error. */
export async function fetchWithRetry(fetchImpl, target, init, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectedStatus,
    label = `${init.method ?? 'GET'} ${new URL(target).pathname}`,
  } = options;
  const path = new URL(target).pathname;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(target, {
        ...init,
        signal: init.signal ?? timeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      throw new ExportError(
        `${label}: network error: ${error instanceof Error ? error.message : String(error)}`,
        { path, cause: error },
      );
    }
    if (expectedStatus !== undefined && response.status === expectedStatus) return response;
    if (response.status === 429 || response.status >= 500) {
      if (attempt < retries) {
        await response.body?.cancel?.();
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      throw new ExportError(`${label}: HTTP ${response.status} ${response.statusText}`, {
        status: response.status,
        path,
      });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      const hint =
        response.status === 401
          ? ' (check ZEEE_SESSION_COOKIE / ZEEE_DEV_AUTH)'
          : response.status === 403
            ? ' (check Origin / PUBLIC_ORIGIN)'
            : '';
      throw new ExportError(
        `${label}: HTTP ${response.status} ${response.statusText}${detail ? ` ${detail}` : ''}${hint}`,
        { status: response.status, path },
      );
    }
    return response;
  }
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new ExportError(`${label}: invalid JSON response`, { cause: error });
  }
}

/** Walk /api/pages cursors until exhaustion or `limit` ids have been collected. */
export async function listPageIds(options) {
  const {
    baseUrl,
    cookie = '',
    limit = null,
    fetchImpl = fetch,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url = baseUrl instanceof URL ? baseUrl : normalizeBaseUrl(baseUrl);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new ExportError('limit must be a positive integer');
  }
  const ids = [];
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const target = new URL(PAGE_LIST_PATH, url);
    const requestSize =
      limit === null ? MAX_REQUEST_PAGE_SIZE : Math.min(MAX_REQUEST_PAGE_SIZE, limit - ids.length);
    target.searchParams.set('limit', String(requestSize));
    if (cursor !== null) target.searchParams.set('cursor', cursor);
    const label = `GET ${PAGE_LIST_PATH}`;
    const response = await fetchWithRetry(
      fetchImpl,
      target,
      {
        headers: requestHeaders(cookie, url),
      },
      { retries, retryDelayMs, timeoutMs, label },
    );
    const payload = await readJson(response, label);
    if (!payload || !Array.isArray(payload.pages)) {
      throw new ExportError(`${label}: response has no "pages" array`);
    }
    for (const page of payload.pages) {
      const id = page?.id;
      if (typeof id !== 'string' || !SAFE_PAGE_ID.test(id)) {
        throw new ExportError(`${label}: invalid page id (refusing to build a file path)`);
      }
      ids.push(id);
      if (limit !== null && ids.length >= limit) return ids;
    }
    const next = payload.nextCursor;
    if (next == null) return ids;
    if (typeof next !== 'string' || next === cursor || seenCursors.has(next)) {
      throw new ExportError(`${label}: cursor did not advance (possible loop)`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/** Log in through /auth/dev on a loopback deployment and return its Cookie value. */
export async function acquireDevSession(options) {
  const {
    baseUrl,
    fetchImpl = fetch,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    name = 'dev',
    log = () => {},
  } = options;
  const url = baseUrl instanceof URL ? baseUrl : normalizeBaseUrl(baseUrl);
  if (!isLoopback(url)) {
    throw new ExportError('ZEEE_DEV_AUTH=1 is only allowed for local loopback deployments');
  }
  const target = new URL('/auth/dev', url);
  target.searchParams.set('name', name);
  target.searchParams.set('next', '/');
  const response = await fetchWithRetry(
    fetchImpl,
    target,
    { redirect: 'manual', headers: { origin: url.origin } },
    { retries, retryDelayMs, timeoutMs, expectedStatus: 303, label: 'GET /auth/dev' },
  );
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const entry =
    setCookies.find((value) => /^(?:zeee_session|__Host-zeee_session)=/.test(value)) ??
    setCookies[0];
  if (!entry) throw new ExportError('GET /auth/dev did not set a session cookie');
  log('acquired a local dev session via /auth/dev');
  return entry.split(';')[0];
}

/** Export one .yjs file per page. Only `fetchImpl` is injected by tests. */
export async function exportPageStates(options = {}) {
  const {
    baseUrl,
    cookie = '',
    outdir = 'backups/state',
    limit = null,
    dryRun = false,
    fetchImpl = fetch,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
  } = options;
  const url = baseUrl instanceof URL ? baseUrl : normalizeBaseUrl(baseUrl);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new ExportError('limit must be a positive integer');
  }
  if (!dryRun) await mkdir(outdir, { recursive: true });

  const ids = await listPageIds({
    baseUrl: url,
    cookie,
    limit,
    fetchImpl,
    retries,
    retryDelayMs,
    timeoutMs,
  });
  const files = [];
  for (const id of ids) {
    const path = join(outdir, `${id}.yjs`);
    if (dryRun) {
      files.push({ id, path, bytes: null });
      log(`[dry-run] ${id} -> ${path}`);
      continue;
    }
    const target = new URL(`/api/pages/${encodeURIComponent(id)}${STATE_SUFFIX}`, url);
    const label = `GET /api/pages/${id}${STATE_SUFFIX}`;
    const response = await fetchWithRetry(
      fetchImpl,
      target,
      {
        headers: requestHeaders(cookie, url),
      },
      { retries, retryDelayMs, timeoutMs, label },
    );
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/octet-stream')) {
      throw new ExportError(`${label}: unexpected Content-Type: ${contentType || '(none)'}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new ExportError(`${label}: empty state response`);
    await writeFile(path, bytes);
    files.push({ id, path, bytes: bytes.length });
    log(`exported ${id} -> ${path} (${bytes.length} bytes)`);
  }
  return { ids, files, count: ids.length, dryRun };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const log = dependencies.log ?? ((message) => console.log(message));
  const options = parseArgs(argv);
  if (options.help) {
    log(HELP);
    return null;
  }

  const baseUrl = normalizeBaseUrl(env.ZEEE_BASE_URL);
  let cookie = env.ZEEE_SESSION_COOKIE?.trim() ?? '';
  if (!cookie && env.ZEEE_DEV_AUTH === '1') {
    cookie = await acquireDevSession({
      baseUrl,
      fetchImpl,
      retries: options.retries,
      name: env.ZEEE_DEV_NAME || 'dev',
      log,
    });
  }
  if (!cookie) {
    throw new ExportError('set ZEEE_SESSION_COOKIE (or ZEEE_DEV_AUTH=1 for local development)');
  }

  const result = await exportPageStates({
    baseUrl,
    cookie,
    outdir: options.outdir,
    limit: options.limit,
    dryRun: options.dryRun,
    fetchImpl,
    retries: options.retries,
    log,
  });
  log(
    `${options.dryRun ? '[dry-run] planned' : 'exported'} ${result.count} page(s) -> ${options.outdir}`,
  );
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`export-do-state: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
