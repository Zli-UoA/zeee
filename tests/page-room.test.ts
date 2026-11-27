import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';
import type { Env } from '../src/server/types';

const writes = vi.hoisted(() => ({
  materialize: vi.fn(async (_db: unknown, _pageId: string, _markdown: string) => undefined),
  revision: vi.fn(
    async (
      _db: unknown,
      _pageId: string,
      _markdown: string,
      _actorId: string | null,
      _manual: boolean,
    ) => 2,
  ),
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
  createRevision: writes.revision,
  latestRevision: writes.latest,
  materializePage: writes.materialize,
}));

import { PageRoomObject } from '../durable-objects/page-room';

function setup(initial: Uint8Array[] = [], initialSnapshot?: Uint8Array, connected?: WebSocket[]) {
  let snapshot = initialSnapshot ?? null;
  const rows = [...initial];
  const exec = vi.fn((query: string, ...args: unknown[]) => {
    if (query.startsWith('INSERT INTO doc_update')) rows.push(args[0] as Uint8Array);
    if (query.startsWith('DELETE FROM doc_update')) rows.length = 0;
    if (query.startsWith('INSERT INTO doc_snapshot')) snapshot = args[0] as Uint8Array;
    return {
      toArray: () => {
        if (query.startsWith('SELECT data')) return rows.map((data) => ({ data }));
        if (query.startsWith('SELECT state')) {
          return snapshot ? [{ state: snapshot, created_at: Date.now() }] : [];
        }
        return [];
      },
    };
  });
  const transactionSync = vi.fn(<T>(work: () => T): T => {
    const previousRows = [...rows];
    const previousSnapshot = snapshot;
    try {
      return work();
    } catch (error) {
      rows.length = 0;
      rows.push(...previousRows);
      snapshot = previousSnapshot;
      throw error;
    }
  });
  const setAlarm = vi.fn().mockResolvedValue(undefined);
  const peer = { send: vi.fn() } as unknown as WebSocket;
  const send = vi.fn();
  const socket = {
    send,
    deserializeAttachment: () => null,
  } as unknown as WebSocket;
  const ctx = {
    id: { name: 'page-1' },
    storage: {
      sql: { exec },
      transactionSync,
      setAlarm,
    },
    getWebSockets: () => connected ?? [socket, peer],
  } as unknown as DurableObjectState;
  const room = new PageRoomObject(ctx, {} as Env);
  return {
    room,
    rows,
    socket,
    send,
    peer,
    exec,
    transactionSync,
    ctx,
    setAlarm,
    snapshot: () => snapshot,
  };
}

function updateFrom(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('markdown').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

async function send(harness: ReturnType<typeof setup>, update: Uint8Array, clientSeq = 1) {
  await harness.room.webSocketMessage(
    harness.socket,
    JSON.stringify({
      type: 'update',
      update: encodeBase64(update),
      clientSeq,
    }),
  );
}

async function readStateBytes(harness: ReturnType<typeof setup>): Promise<Uint8Array> {
  const response = await harness.room.fetch(
    new Request('https://zeee.test/api/pages/page-1/state', {
      headers: { 'x-zeee-user': 'user-1' },
    }),
  );
  return new Uint8Array(await response.arrayBuffer());
}

async function readState(harness: ReturnType<typeof setup>): Promise<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await readStateBytes(harness));
  const text = doc.getText('markdown').toJSON();
  doc.destroy();
  return text;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function importRequest(body: ArrayBuffer, headers: Record<string, string> = {}): Request {
  return new Request('https://zeee.test/api/pages/page-1/import-state', {
    method: 'POST',
    headers: { 'x-zeee-user': 'user-1', ...headers },
    body,
  });
}

function replaceRequest(markdown: string): Request {
  return new Request('https://zeee.test/api/pages/page-1/replace', {
    method: 'POST',
    headers: { 'x-zeee-user': 'user-1' },
    body: JSON.stringify({ markdown }),
  });
}

function snapshotRequest(): Request {
  return new Request('https://zeee.test/api/pages/page-1/snapshot', {
    method: 'POST',
    headers: { 'x-zeee-user': 'user-1' },
  });
}

beforeEach(() => {
  writes.materialize.mockReset();
  writes.materialize.mockResolvedValue(undefined);
  writes.revision.mockReset();
  writes.revision.mockResolvedValue(2);
  writes.latest.mockReset();
  writes.latest.mockResolvedValue(null);
});

describe('PageRoom durable acknowledgements', () => {
  it('persists before ack and deduplicates repeated updates, including after room restart', async () => {
    const harness = setup();
    const update = updateFrom('once');
    await send(harness, update);
    expect(harness.rows).toHaveLength(1);
    expect(harness.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', clientSeq: 1 }));
    await send(harness, update, 2);
    expect(harness.rows).toHaveLength(1);
    expect(harness.peer.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', clientSeq: 2 }));
    const restarted = setup(harness.rows);
    await send(restarted, update, 3);
    expect(restarted.rows).toHaveLength(1);
    expect(await readState(restarted)).toBe('once');
  });

  it('does not expose a failed write in sync, then accepts the retry', async () => {
    const harness = setup();
    // Finish loading before faulting the next SQL write.
    expect(await readState(harness)).toBe('');
    const update = updateFrom('retry');
    harness.exec.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await send(harness, update);
    expect(harness.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'nack', clientSeq: 1 }));
    expect(harness.rows).toHaveLength(0);
    expect(harness.peer.send).not.toHaveBeenCalled();
    expect(await readState(harness)).toBe('');
    await send(harness, update);
    expect(harness.rows).toHaveLength(1);
    expect(await readState(harness)).toBe('retry');
  });

  it('persists deletions once even though they do not advance the state vector', async () => {
    const doc = new Y.Doc();
    doc.getText('markdown').insert(0, 'delete');
    const initial = Y.encodeStateAsUpdate(doc);
    let deletion: Uint8Array = new Uint8Array();
    doc.on('update', (update: Uint8Array) => {
      deletion = update;
    });
    doc.getText('markdown').delete(0, 6);
    const harness = setup([initial]);
    await send(harness, deletion);
    expect(harness.rows).toHaveLength(2);
    expect(await readState(harness)).toBe('');
    await send(harness, deletion, 2);
    expect(harness.rows).toHaveLength(2);
    doc.destroy();
  });

  it('retains out-of-order Yjs dependencies durably and deduplicates their replay', async () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    doc.getText('markdown').insert(0, 'A');
    doc.getText('markdown').insert(1, 'B');
    const harness = setup();
    await send(harness, updates[1]);
    expect(harness.rows).toHaveLength(1);
    await send(harness, updates[1]);
    expect(harness.rows).toHaveLength(1);
    await send(harness, updates[0], 2);
    expect(await readState(harness)).toBe('AB');
    doc.destroy();
  });

  it('nacks malformed Yjs data without saving or broadcasting it', async () => {
    const harness = setup();
    await send(harness, new Uint8Array([255]));
    expect(harness.rows).toHaveLength(0);
    expect(harness.peer.send).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'nack', clientSeq: 1 }));
  });

  it('does not expose replacement text when its durable write fails', async () => {
    const harness = setup([updateFrom('original')]);
    expect(await readState(harness)).toBe('original');
    harness.exec.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(
      harness.room.fetch(
        new Request('https://zeee.test/api/pages/page-1/replace', {
          method: 'POST',
          headers: { 'x-zeee-user': 'user-1' },
          body: JSON.stringify({ markdown: 'replacement' }),
        }),
      ),
    ).rejects.toThrow('disk full');
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
    expect(harness.peer.send).not.toHaveBeenCalled();
  });

  it('preserves legacy updates without clientSeq and the existing sync response', async () => {
    const harness = setup();
    await harness.room.webSocketMessage(
      harness.socket,
      JSON.stringify({
        type: 'update',
        update: encodeBase64(updateFrom('legacy')),
      }),
    );
    expect(harness.rows).toHaveLength(1);
    expect(harness.send).not.toHaveBeenCalled();
    const empty = new Y.Doc();
    await harness.room.webSocketMessage(
      harness.socket,
      JSON.stringify({
        type: 'sync',
        stateVector: encodeBase64(Y.encodeStateVector(empty)),
      }),
    );
    const response = JSON.parse(vi.mocked(harness.send).mock.calls[0][0] as string);
    Y.applyUpdate(empty, decodeBase64(response.update));
    expect(response.type).toBe('sync');
    expect(empty.getText('markdown').toJSON()).toBe('legacy');
    empty.destroy();
  });

  it('imports a raw Yjs state and keeps it after a restart', async () => {
    const harness = setup([updateFrom('old')], undefined, []);
    expect(await readState(harness)).toBe('old');

    const state = updateFrom('imported');
    const response = await harness.room.fetch(importRequest(arrayBuffer(state)));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ by: 'someone', version: 2 });
    expect(await readState(harness)).toBe('imported');
    // The old update log is replaced by the imported snapshot.
    expect(harness.rows).toHaveLength(0);
    expect(harness.snapshot()).toEqual(state);

    const restarted = setup([], harness.snapshot()!);
    expect(await readState(restarted)).toBe('imported');
  });

  it('preserves the source client ids when importing state', async () => {
    const source = new Y.Doc();
    source.getText('markdown').insert(0, 'client ids');
    const state = Y.encodeStateAsUpdate(source);
    source.destroy();

    const harness = setup([], undefined, []);
    const response = await harness.room.fetch(importRequest(arrayBuffer(state)));
    expect(response.status).toBe(200);
    // A re-encoded state is byte-for-byte the imported one only when the
    // original client ids and structs survive the import.
    expect(await readStateBytes(harness)).toEqual(state);
  });

  it('rejects invalid bytes with 400 without changing the state or log', async () => {
    const harness = setup([updateFrom('original')], undefined, []);
    expect(await readState(harness)).toBe('original');

    const response = await harness.room.fetch(importRequest(arrayBuffer(new Uint8Array([255]))));
    expect(response.status).toBe(400);
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
    expect(harness.snapshot()).toBeNull();
  });

  it('rejects oversized imports with 413 before reading the body', async () => {
    const harness = setup([updateFrom('original')], undefined, []);
    const response = await harness.room.fetch(
      importRequest(arrayBuffer(new Uint8Array([0, 0])), {
        'content-length': String(5 * 1024 * 1024 + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
  });

  it('rejects an oversized streamed body even without a content-length header', async () => {
    const harness = setup([updateFrom('original')], undefined, []);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const init = {
      method: 'POST',
      headers: { 'x-zeee-user': 'user-1' },
      body,
      duplex: 'half',
    } as unknown as RequestInit;
    const response = await harness.room.fetch(
      new Request('https://zeee.test/api/pages/page-1/import-state', init),
    );
    expect(response.status).toBe(413);
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
  });

  it('refuses to import while a websocket client is connected', async () => {
    const harness = setup([updateFrom('original')]);
    const before = await readStateBytes(harness);
    const response = await harness.room.fetch(importRequest(arrayBuffer(updateFrom('imported'))));
    expect(response.status).toBe(409);
    expect(await readStateBytes(harness)).toEqual(before);
    expect(harness.rows).toHaveLength(1);
    expect(harness.snapshot()).toBeNull();
    expect(harness.transactionSync).not.toHaveBeenCalled();
    expect(harness.peer.send).not.toHaveBeenCalled();
  });

  it('nacks client updates while an import is in progress', async () => {
    const harness = setup([updateFrom('old')], undefined, []);
    expect(await readState(harness)).toBe('old');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(input) {
        controller = input;
      },
    });
    const init = {
      method: 'POST',
      headers: { 'x-zeee-user': 'user-1' },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit;
    const importing = harness.room.fetch(
      new Request('https://zeee.test/api/pages/page-1/import-state', init),
    );
    await Promise.resolve();
    await send(harness, updateFrom('stale'), 7);
    expect(harness.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'nack', clientSeq: 7 }));
    expect(await readState(harness)).toBe('old');

    controller.enqueue(updateFrom('imported'));
    controller.close();
    expect((await importing).status).toBe(200);
    expect(await readState(harness)).toBe('imported');
  });

  it('rolls back the storage swap when a write inside the transaction fails', async () => {
    const harness = setup([updateFrom('original')], undefined, []);
    expect(await readState(harness)).toBe('original');
    const exec = harness.exec.getMockImplementation()!;
    harness.exec.mockImplementation((query: string, ...args: unknown[]) => {
      if (query.startsWith('INSERT INTO doc_snapshot')) throw new Error('disk full');
      return exec(query, ...args);
    });
    await expect(
      harness.room.fetch(importRequest(arrayBuffer(updateFrom('imported')))),
    ).rejects.toThrow('disk full');
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
    expect(harness.snapshot()).toBeNull();
  });

  it('awaits an in-flight replace before materializing the imported state', async () => {
    const harness = setup([updateFrom('old')], undefined, []);
    expect(await readState(harness)).toBe('old');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const replaceStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    writes.materialize.mockImplementationOnce(async () => {
      started();
      await gate;
    });

    const replacing = harness.room.fetch(replaceRequest('replacement'));
    await replaceStarted;
    const importing = harness.room.fetch(importRequest(arrayBuffer(updateFrom('imported'))));
    release();
    const [replaceResponse, importResponse] = await Promise.all([replacing, importing]);

    expect(replaceResponse.status).toBe(200);
    expect(importResponse.status).toBe(200);
    // The replacement's D1 write happens first, but the import wins the final
    // write instead of racing it.
    expect(writes.materialize.mock.calls.map((call) => call[2])).toEqual([
      'replacement',
      'imported',
    ]);
    expect(writes.revision.mock.calls.map((call) => call[2])).toEqual(['replacement', 'imported']);
    expect(await readState(harness)).toBe('imported');
  });

  it('rejects replace and snapshot queued while an import is materializing', async () => {
    const harness = setup([updateFrom('old')], undefined, []);
    expect(await readState(harness)).toBe('old');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    writes.materialize.mockImplementationOnce(async (_db, _pageId, markdown) => {
      if (markdown !== 'imported') return;
      started();
      await gate;
    });

    const importing = harness.room.fetch(importRequest(arrayBuffer(updateFrom('imported'))));
    await importStarted;
    const replacing = harness.room.fetch(replaceRequest('replacement'));
    const snapshotting = harness.room.fetch(snapshotRequest());
    release();
    const [importResponse, replaceResponse, snapshotResponse] = await Promise.all([
      importing,
      replacing,
      snapshotting,
    ]);

    expect(importResponse.status).toBe(200);
    expect(replaceResponse.status).toBe(409);
    expect(snapshotResponse.status).toBe(409);
    expect(writes.materialize.mock.calls.map((call) => call[2])).toEqual(['imported']);
    expect(writes.revision.mock.calls.map((call) => call[2])).toEqual(['imported']);
    expect(await readState(harness)).toBe('imported');
  });

  it('schedules an alarm when a D1 write fails after the import swap', async () => {
    const harness = setup([updateFrom('old')], undefined, []);
    expect(await readState(harness)).toBe('old');
    writes.materialize.mockRejectedValueOnce(new Error('D1 down'));

    await expect(
      harness.room.fetch(importRequest(arrayBuffer(updateFrom('imported')))),
    ).rejects.toThrow('D1 down');
    expect(harness.setAlarm.mock.calls).toHaveLength(1);
    expect(await readState(harness)).toBe('imported');
  });
});
