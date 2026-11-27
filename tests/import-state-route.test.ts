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

function context(
  options: {
    enabled?: boolean;
    origin?: string;
    contentLength?: string;
    body?: ArrayBuffer;
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
      arrayBuffer: async () => options.body ?? new ArrayBuffer(2),
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
  });

  it('forwards the raw body to the durable object and records an audit event', async () => {
    const body = new Uint8Array([1, 2, 3]).buffer;
    const response = await post(context({ enabled: true, origin: 'http://127.0.0.1:9876', body }));

    expect(response.status).toBe(200);
    expect(roomFetch).toHaveBeenCalledWith(
      'page-1',
      '/import-state',
      user,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'page.state_import',
      'page',
      'page-1',
    );
  });

  it('does not audit when the durable object rejects the import', async () => {
    vi.mocked(roomFetch).mockResolvedValueOnce(new Response('invalid', { status: 400 }));
    const response = await post(context({ enabled: true }));
    expect(response.status).toBe(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before forwarding it', async () => {
    const response = await post(
      context({ enabled: true, contentLength: String(5 * 1024 * 1024 + 1) }),
    );
    expect(response.status).toBe(413);
    expect(roomFetch).not.toHaveBeenCalled();
  });
});
