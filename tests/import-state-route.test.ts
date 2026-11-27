import type { CloudContext } from 'void';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../src/server/auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../src/server/rooms', () => ({ roomFetch: vi.fn() }));
vi.mock('../src/server/db', () => ({ recordAudit: vi.fn() }));

import { POST } from '../routes/api/pages/[id]/import-state';
import { getSessionUser } from '../src/server/auth';
import { recordAudit } from '../src/server/db';
import { roomFetch } from '../src/server/rooms';

const user = { id: 'user-1', username: 'tester', displayName: 'Tester' };

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function context(
  options: {
    enabled?: boolean;
    origin?: string;
    contentLength?: string;
    body?: Uint8Array | null;
    stream?: ReadableStream<Uint8Array>;
  } = {},
): CloudContext {
  return {
    env: {
      DB: {},
      PUBLIC_ORIGIN: 'http://127.0.0.1:9876',
      ZEEE_MIGRATION_IMPORT: options.enabled ? '1' : '',
    },
    req: {
      url: 'http://127.0.0.1:9876/api/pages/page-1/import-state',
      header: (name: string) => {
        if (name === 'origin') return options.origin;
        if (name === 'content-length') return options.contentLength;
        return undefined;
      },
      param: (name: string) => (name === 'id' ? 'page-1' : undefined),
      raw: {
        body:
          options.stream ??
          (options.body === null ? null : bodyStream(options.body ?? new Uint8Array([1, 2]))),
      },
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as CloudContext;
}

async function post(c: CloudContext): Promise<Response> {
  return (await POST(c)) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
  vi.mocked(roomFetch).mockResolvedValue(new Response(null, { status: 200 }));
  vi.mocked(recordAudit).mockResolvedValue(undefined);
});

describe('POST /api/pages/:id/import-state', () => {
  it('returns 404 when the migration flag is not enabled', async () => {
    const response = await post(context());
    expect(response.status).toBe(404);
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('requires a session and a same-origin request', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await post(context({ enabled: true }))).status).toBe(401);
    expect((await post(context({ enabled: true, origin: 'https://evil.test' }))).status).toBe(403);
    expect(roomFetch).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('forwards the raw body to the durable object and records an audit event', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const response = await post(context({ enabled: true, origin: 'http://127.0.0.1:9876', body }));

    expect(response.status).toBe(200);
    const init = vi.mocked(roomFetch).mock.calls[0][3] as RequestInit;
    expect(Array.from(new Uint8Array(init.body as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/octet-stream' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'page.state_import',
      'page',
      'page-1',
    );
  });

  it('rejects an empty body before forwarding it to the durable object', async () => {
    // An absent body is read as an empty Uint8Array, which is truthy; a
    // zero-length stream produces the same result. Neither may reach the DO.
    for (const c of [
      context({ enabled: true, origin: 'http://127.0.0.1:9876', body: null }),
      context({ enabled: true, origin: 'http://127.0.0.1:9876', body: new Uint8Array() }),
    ]) {
      expect((await post(c)).status).toBe(400);
    }
    expect(roomFetch).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledTimes(2);
  });

  it('audits every authenticated attempt, including durable-object rejections', async () => {
    for (const status of [400, 409, 413]) {
      vi.mocked(roomFetch).mockResolvedValueOnce(new Response('rejected', { status }));
      expect((await post(context({ enabled: true }))).status).toBe(status);
    }
    expect(recordAudit).toHaveBeenCalledTimes(3);
  });

  it('rejects an oversized declared length before reading the body', async () => {
    const response = await post(
      context({ enabled: true, contentLength: String(5 * 1024 * 1024 + 1) }),
    );
    expect(response.status).toBe(413);
    expect(roomFetch).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('aborts an oversized stream while it is being read', async () => {
    let chunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await post(context({ enabled: true, stream }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    // 5 MiB is allowed; the 6th chunk must stop the read instead of draining
    // an arbitrary amount of data into memory.
    expect(chunks).toBeLessThan(12);
    expect(roomFetch).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('does not turn a successful import into a 500 when the audit write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('audit db down'));
    const response = await post(context({ enabled: true }));
    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
