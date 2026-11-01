import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import { encodeBase64 } from '../src/shared/base64';

const writes = vi.hoisted(() => ({
  materialize: vi.fn(async () => 'Page'),
  revision: vi.fn(async () => 1),
}));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock('void/durable', () => ({ defineDurableObject: (options: unknown) => options }));
vi.mock('../src/server/db', () => ({
  materializePage: writes.materialize,
  createRevision: writes.revision,
  latestRevision: vi.fn(async () => null),
}));
import { PageRoom } from '../durable-objects/page-room';

type Room = {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(socket: WebSocket, message: string): Promise<void>;
  alarm(): Promise<void>;
};
const RoomClass = (PageRoom as unknown as { class: new (ctx: unknown, env: unknown) => Room })
  .class;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.clearAllMocks();
});

function roomStore() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  const ctx = {
    id: { name: 'page-1' },
    storage: {
      sql: {
        exec(sql: string, ...args: SQLInputValue[]) {
          if (sql.trim().startsWith('CREATE TABLE')) {
            sqlite.exec(sql);
            return { toArray: () => [] };
          }
          const statement = sqlite.prepare(sql);
          if (sql.startsWith('SELECT')) return { toArray: () => statement.all(...args) };
          statement.run(...args);
          return { toArray: () => [] };
        },
      },
      setAlarm: vi.fn(async () => {}),
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  };
  const env = { DB: {} };
  return { ctx, env, sqlite, room: new RoomClass(ctx, env) };
}

async function edit(room: Room, userId?: string) {
  const doc = new Y.Doc();
  doc.getText('markdown').insert(0, 'Edited text');
  const socket = {
    deserializeAttachment: () => (userId ? { userId } : null),
    send: vi.fn(),
  } as unknown as WebSocket;
  await room.webSocketMessage(
    socket,
    JSON.stringify({
      type: 'update',
      actor: 'spoofed',
      update: encodeBase64(Y.encodeStateAsUpdate(doc)),
    }),
  );
  doc.destroy();
}

describe('authenticated last editor in PageRoom', () => {
  it('ignores client actor claims and restores the authenticated editor after hibernation', async () => {
    const { room, ctx, env } = roomStore();
    await edit(room, 'authenticated-editor');
    await room.alarm();
    expect(writes.materialize).toHaveBeenLastCalledWith(
      env.DB,
      'page-1',
      'Edited text',
      'authenticated-editor',
    );
    const restarted = new RoomClass(ctx, env);
    await restarted.alarm();
    expect(writes.materialize).toHaveBeenLastCalledWith(
      env.DB,
      'page-1',
      'Edited text',
      'authenticated-editor',
    );
  });

  it('records unknown for pre-deploy sockets without an authenticated attachment', async () => {
    const { room, env } = roomStore();
    await edit(room);
    await room.alarm();
    expect(writes.materialize).toHaveBeenLastCalledWith(env.DB, 'page-1', 'Edited text', null);
  });

  it('keeps the content author when someone else saves a manual snapshot', async () => {
    const { room, env } = roomStore();
    await edit(room, 'editor');
    await room.fetch(
      new Request('http://local/pages/page-1/snapshot', {
        method: 'POST',
        headers: { 'x-zeee-user': 'snapshotter' },
      }),
    );
    expect(writes.materialize).toHaveBeenLastCalledWith(env.DB, 'page-1', 'Edited text', 'editor');
    expect(writes.revision).toHaveBeenLastCalledWith(
      env.DB,
      'page-1',
      'Edited text',
      'snapshotter',
      true,
    );
  });
});
