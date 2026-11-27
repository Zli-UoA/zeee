import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import type { Env } from '../src/server/types';

const writes = vi.hoisted(() => ({
  materialize: vi.fn(async (_db: unknown, _pageId: string, _markdown: string) => undefined),
  revision: vi.fn(async () => 2),
  latest: vi.fn(async () => null),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: Env,
    ) {}
  },
}));
vi.mock('void/durable', () => ({ defineDurableObject: (definition: unknown) => definition }));
vi.mock('../src/server/db', () => ({
  materializePage: writes.materialize,
  latestRevision: writes.latest,
  createRevision: writes.revision,
}));

import { PageRoomObject } from '../durable-objects/page-room';

const databases: DatabaseSync[] = [];

beforeEach(() => {
  writes.materialize.mockReset();
  writes.materialize.mockResolvedValue(undefined);
  writes.revision.mockReset();
  writes.revision.mockResolvedValue(2);
  writes.latest.mockReset();
  writes.latest.mockResolvedValue(null);
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A DO storage backed by real SQLite, including real transaction rollback. */
function harness(connected = false, seed: Uint8Array[] = []) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  const socket = {
    send: vi.fn(),
    deserializeAttachment: () => null,
  } as unknown as WebSocket;
  const ctx = {
    id: { name: 'page-1' },
    storage: {
      sql: {
        exec(sql: string, ...args: unknown[]) {
          if (/^\s*CREATE TABLE/i.test(sql)) {
            sqlite.exec(sql);
            return { toArray: () => [] };
          }
          const statement = sqlite.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            return { toArray: () => statement.all(...(args as SQLInputValue[])) };
          }
          statement.run(...(args as SQLInputValue[]));
          return { toArray: () => [] };
        },
      },
      transactionSync<T>(work: () => T): T {
        sqlite.exec('BEGIN');
        try {
          const result = work();
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
      setAlarm: vi.fn().mockResolvedValue(undefined),
    },
    getWebSockets: () => (connected ? [socket] : []),
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
  const env = { DB: {} } as Env;
  if (seed.length > 0) {
    // The constructor creates the DO tables in its load() step.
    new PageRoomObject(ctx, env);
    for (const data of seed) {
      sqlite
        .prepare('INSERT INTO doc_update (data, actor_id, created_at) VALUES (?, ?, ?)')
        .run(data, 'old-user', 0);
    }
  }
  return {
    room: new PageRoomObject(ctx, env),
    restart: () => new PageRoomObject(ctx, env),
    sqlite,
    ctx,
    socket,
  };
}

function updateFrom(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('markdown').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function importRequest(bytes: Uint8Array): Request {
  return new Request('https://zeee.test/pages/page-1/import-state', {
    method: 'POST',
    headers: { 'x-zeee-user': 'user-1' },
    body: arrayBuffer(bytes),
  });
}

async function stateText(room: PageRoomObject): Promise<string> {
  const response = await room.fetch(
    new Request('https://zeee.test/pages/page-1/state', {
      headers: { 'x-zeee-user': 'user-1' },
    }),
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
  const text = doc.getText('markdown').toJSON();
  doc.destroy();
  return text;
}

function snapshotRow(sqlite: DatabaseSync): { state: Uint8Array; seq: number } {
  return sqlite.prepare('SELECT state, seq FROM doc_snapshot WHERE id = 1').get() as {
    state: Uint8Array;
    seq: number;
  };
}

describe('import-state with real SQLite storage', () => {
  it('stores the raw state as a BLOB and restores it after a restart', async () => {
    const h = harness();
    const state = updateFrom('imported content');
    expect((await h.room.fetch(importRequest(state))).status).toBe(200);

    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_snapshot').get()).toMatchObject({
      count: 1,
    });
    expect(Buffer.from(snapshotRow(h.sqlite).state)).toEqual(Buffer.from(state));
    expect(snapshotRow(h.sqlite).seq).toBe(0);
    expect(h.sqlite.prepare('SELECT actor_id FROM doc_actor WHERE id = 1').get()).toMatchObject({
      actor_id: 'user-1',
    });
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_update').get()).toMatchObject({
      count: 0,
    });
    expect(await stateText(h.restart())).toBe('imported content');
  });

  it('refuses to import while a client is connected', async () => {
    const h = harness(true);
    expect((await h.room.fetch(importRequest(updateFrom('imported')))).status).toBe(409);
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_snapshot').get()).toMatchObject({
      count: 0,
    });
    expect(h.socket.send).not.toHaveBeenCalled();
  });

  it('replaces the snapshot row on a repeat import and survives a restart', async () => {
    const h = harness();
    const second = updateFrom('second');
    expect((await h.room.fetch(importRequest(updateFrom('first')))).status).toBe(200);
    expect((await h.room.fetch(importRequest(second))).status).toBe(200);

    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_snapshot').get()).toMatchObject({
      count: 1,
    });
    expect(Buffer.from(snapshotRow(h.sqlite).state)).toEqual(Buffer.from(second));
    expect(snapshotRow(h.sqlite).seq).toBe(0);
    expect(await stateText(h.restart())).toBe('second');
  });

  it('rolls back the log deletion, snapshot and actor writes together', async () => {
    const original = updateFrom('original');
    const h = harness(false, [original]);
    expect(await stateText(h.room)).toBe('original');

    const exec = h.ctx.storage.sql.exec;
    vi.spyOn(h.ctx.storage.sql, 'exec').mockImplementation(((sql: string, ...args: unknown[]) => {
      if (sql.startsWith('INSERT INTO doc_snapshot')) throw new Error('disk full');
      return exec(sql, ...args);
    }) as typeof h.ctx.storage.sql.exec);

    await expect(h.room.fetch(importRequest(updateFrom('imported')))).rejects.toThrow('disk full');
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_update').get()).toMatchObject({
      count: 1,
    });
    expect(h.sqlite.prepare('SELECT data FROM doc_update').get()).toMatchObject({ data: original });
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_snapshot').get()).toMatchObject({
      count: 0,
    });
    expect(await stateText(h.restart())).toBe('original');
    vi.restoreAllMocks();
  });

  it('waits for an in-flight alarm before materializing the imported state', async () => {
    const h = harness(false, [updateFrom('old content')]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const alarmStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    writes.materialize.mockImplementationOnce(async () => {
      started();
      await gate;
    });

    const alarm = h.room.alarm();
    await alarmStarted;
    let imported = false;
    const importing = h.room
      .fetch(importRequest(updateFrom('imported content')))
      .then((response) => {
        imported = true;
        return response;
      });
    await Promise.resolve();
    expect(imported).toBe(false);

    release();
    const response = await importing;
    await alarm;

    expect(response.status).toBe(200);
    expect(writes.materialize.mock.calls.map((call) => call[2])).toEqual([
      'old content',
      'imported content',
    ]);
    expect(await stateText(h.restart())).toBe('imported content');
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM doc_snapshot').get()).toMatchObject({
      count: 1,
    });
  });
});
