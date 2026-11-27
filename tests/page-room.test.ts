import { describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';
import type { Env } from '../src/server/types';

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
  createRevision: vi.fn().mockResolvedValue(2),
  latestRevision: vi.fn().mockResolvedValue(null),
  materializePage: vi.fn().mockResolvedValue(undefined),
}));

import { PageRoomObject } from '../durable-objects/page-room';

function setup(initial: Uint8Array[] = [], initialSnapshot?: Uint8Array) {
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
  const peer = { send: vi.fn() };
  const send = vi.fn();
  const socket = {
    send,
    deserializeAttachment: () => null,
  } as unknown as WebSocket;
  const ctx = {
    id: { name: 'page-1' },
    storage: { sql: { exec }, setAlarm: vi.fn().mockResolvedValue(undefined) },
    getWebSockets: () => [socket, peer],
  } as unknown as DurableObjectState;
  const room = new PageRoomObject(ctx, {} as Env);
  return { room, rows, socket, send, peer, exec, snapshot: () => snapshot };
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
    const harness = setup([updateFrom('old')]);
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

    const harness = setup();
    const response = await harness.room.fetch(importRequest(arrayBuffer(state)));
    expect(response.status).toBe(200);
    // A re-encoded state is byte-for-byte the imported one only when the
    // original client ids and structs survive the import.
    expect(await readStateBytes(harness)).toEqual(state);
  });

  it('rejects invalid bytes with 400 without changing the state or log', async () => {
    const harness = setup([updateFrom('original')]);
    expect(await readState(harness)).toBe('original');

    const response = await harness.room.fetch(importRequest(arrayBuffer(new Uint8Array([255]))));
    expect(response.status).toBe(400);
    expect(await readState(harness)).toBe('original');
    expect(harness.rows).toHaveLength(1);
    expect(harness.snapshot()).toBeNull();
  });

  it('rejects oversized imports with 413 before reading the body', async () => {
    const harness = setup([updateFrom('original')]);
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
    const harness = setup([updateFrom('original')]);
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
});
