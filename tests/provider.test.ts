import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ZeeeProvider, type SaveStatus } from '../src/client/provider';
import { PendingUpdateStore } from '../src/client/persistence';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';

type Listener = (event: { data?: unknown }) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string | URL) {
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', {});
  }
  open(doc?: Y.Doc): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
    this.receive({
      type: 'sync',
      update: encodeBase64(doc ? Y.encodeStateAsUpdate(doc) : new Uint8Array([0, 0])),
    });
  }
  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }
  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const cleanups: (() => void)[] = [];

async function setup(
  userId = 'user-1',
  pageId = 'page-1',
  seed: boolean | string = false,
  state?: Uint8Array,
) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const awareness = new Awareness(doc);
  const saveStatuses: SaveStatus[] = [];
  const provider = new ZeeeProvider(
    pageId,
    doc,
    awareness,
    seed,
    () => {},
    () => {},
    (status) => saveStatuses.push(status),
    userId,
  );
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  };
  cleanups.push(destroy);
  await provider.ready;
  return {
    doc,
    provider,
    saveStatuses,
    destroy,
    store: new PendingUpdateStore(userId, pageId),
    socket: () => MockWebSocket.instances[MockWebSocket.instances.length - 1],
    status: () => saveStatuses[saveStatuses.length - 1],
  };
}

function updateMessages(socket: MockWebSocket): Array<{ clientSeq: number; update: string }> {
  return socket.sent
    .map((message) => JSON.parse(message))
    .filter((message) => message.type === 'update');
}

async function sent(socket: MockWebSocket, count = 1) {
  await expect.poll(() => updateMessages(socket)).toHaveLength(count);
  return updateMessages(socket);
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:9876/pages/page-1' } });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
});

describe('ZeeeProvider persistence', () => {
  it('does not seed stale D1 text over an acknowledged deletion after local cleanup', async () => {
    const server = new Y.Doc();
    server.getText('markdown').insert(0, 'deleted');
    server.getText('markdown').delete(0, 7);
    const harness = await setup('user-1', 'page-1', 'deleted', Y.encodeStateAsUpdate(server));
    expect(harness.doc.getText('markdown').length).toBe(0);
    expect(await harness.store.load()).toEqual({ updates: [], states: [] });
    server.destroy();
  });

  it('persists the initial seed for a fresh room', async () => {
    const harness = await setup('user-1', 'page-1', 'initial body');
    expect(harness.doc.getText('markdown').toJSON()).toBe('initial body');
    await expect.poll(async () => (await harness.store.load()).updates.length).toBe(1);
  });
  it('commits to IndexedDB before sending and cleans up only after ack', async () => {
    const harness = await setup();
    const socket = harness.socket();
    socket.open();
    harness.doc.getText('markdown').insert(0, 'hello');
    expect(updateMessages(socket)).toHaveLength(0);
    const [update] = await sent(socket);
    expect((await harness.store.load()).updates).toHaveLength(1);
    expect(harness.status()).toEqual({ state: 'saving', pending: 1 });
    socket.receive({ type: 'ack', clientSeq: 999 });
    expect(harness.status().pending).toBe(1);
    socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    await expect.poll(harness.status).toEqual({ state: 'saved', pending: 0 });
    expect(await harness.store.load()).toEqual({ updates: [], states: [] });
  });

  it('keeps nacked updates durable and resends them on retry without duplicating in-flight sends', async () => {
    const harness = await setup();
    const socket = harness.socket();
    socket.open();
    harness.doc.getText('markdown').insert(0, 'retry me');
    const [update] = await sent(socket);
    harness.provider.retry();
    expect(updateMessages(socket)).toHaveLength(1);
    socket.receive({ type: 'nack', clientSeq: update.clientSeq });
    expect(harness.status()).toEqual({ state: 'failed', pending: 1 });
    expect((await harness.store.load()).updates).toHaveLength(1);
    harness.provider.retry();
    await sent(socket, 2);
    socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    await expect.poll(harness.status).toEqual({ state: 'saved', pending: 0 });
  });

  it('restores offline edits after tab destruction, preserving acknowledged dependencies', async () => {
    const first = await setup();
    const socket = first.socket();
    socket.open();
    first.doc.getText('markdown').insert(0, 'base');
    const [base] = await sent(socket);
    const server = new Y.Doc();
    cleanups.push(() => server.destroy());
    Y.applyUpdate(server, decodeBase64(base.update));
    socket.receive({ type: 'ack', clientSeq: base.clientSeq });
    await expect.poll(first.status).toEqual({ state: 'saved', pending: 0 });
    socket.close();
    first.doc.getText('markdown').insert(4, ' offline');
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(1);
    expect(first.status()).toEqual({ state: 'unsent', pending: 1 });
    first.destroy();

    const reloaded = await setup('user-1', 'page-1', 'stale D1 body');
    expect(reloaded.doc.getText('markdown').toJSON()).toBe('base offline');
    const next = reloaded.socket();
    next.open(server);
    const [replayed] = await sent(next);
    Y.applyUpdate(server, decodeBase64(replayed.update));
    expect(server.getText('markdown').toJSON()).toBe('base offline');
    next.receive({ type: 'ack', clientSeq: replayed.clientSeq });
    await expect.poll(reloaded.status).toEqual({ state: 'saved', pending: 0 });
    expect(await reloaded.store.load()).toEqual({ updates: [], states: [] });
  });

  it('cleans an already applied update after ack loss without retransmission', async () => {
    const first = await setup();
    const socket = first.socket();
    socket.open();
    first.doc.getText('markdown').insert(0, 'once');
    const [update] = await sent(socket);
    const server = new Y.Doc();
    cleanups.push(() => server.destroy());
    Y.applyUpdate(server, decodeBase64(update.update));
    first.destroy();
    const reloaded = await setup();
    const next = reloaded.socket();
    next.open(server);
    await expect.poll(reloaded.status).toEqual({ state: 'saved', pending: 0 });
    expect(updateMessages(next)).toHaveLength(0);
    expect(await reloaded.store.load()).toEqual({ updates: [], states: [] });
  });

  it('replays delete-only updates even when state vectors already match', async () => {
    const first = await setup();
    const socket = first.socket();
    socket.open();
    first.doc.getText('markdown').insert(0, 'remove me');
    const [base] = await sent(socket);
    const server = new Y.Doc();
    cleanups.push(() => server.destroy());
    Y.applyUpdate(server, decodeBase64(base.update));
    socket.receive({ type: 'ack', clientSeq: base.clientSeq });
    await expect.poll(first.status).toEqual({ state: 'saved', pending: 0 });
    first.doc.getText('markdown').delete(0, 9);
    const [, deletion] = await sent(socket, 2);
    expect(Y.encodeStateVector(first.doc)).toEqual(Y.encodeStateVector(server));
    first.destroy();
    const reloaded = await setup('user-1', 'page-1', 'remove me');
    expect(reloaded.doc.getText('markdown').length).toBe(0);
    const next = reloaded.socket();
    next.open(server);
    await sent(next);
    Y.applyUpdate(server, decodeBase64(deletion.update));
    next.close();
    reloaded.provider.retry();
    const third = reloaded.socket();
    third.open(server);
    await expect.poll(reloaded.status).toEqual({ state: 'saved', pending: 0 });
    expect(updateMessages(third)).toHaveLength(0);
  });

  it('resends disconnected edits on reconnect and ignores stale socket events', async () => {
    const harness = await setup();
    const first = harness.socket();
    first.open();
    first.close();
    harness.doc.getText('markdown').insert(0, 'offline edit');
    await expect.poll(() => harness.socket() !== first, { timeout: 1500 }).toBe(true);
    const second = harness.socket();
    second.open();
    const [update] = await sent(second);
    first.receive({ type: 'ack', clientSeq: update.clientSeq });
    first.close();
    expect(harness.status().pending).toBe(1);
    second.receive({ type: 'ack', clientSeq: update.clientSeq });
    await expect.poll(harness.status).toEqual({ state: 'saved', pending: 0 });
  });

  it('keeps users and pages isolated', async () => {
    const first = await setup();
    first.doc.getText('markdown').insert(0, 'private pending');
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(1);
    const otherUser = await setup('user-2');
    const otherPage = await setup('user-1', 'page-2');
    expect(otherUser.doc.getText('markdown').length).toBe(0);
    expect(otherPage.doc.getText('markdown').length).toBe(0);
    expect((await first.store.load()).updates).toHaveLength(1);
  });

  it('never clears another tab’s newer updates when acknowledging restored rows', async () => {
    const first = await setup();
    first.doc.getText('markdown').insert(0, 'A');
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(1);
    const second = await setup();
    const socket = second.socket();
    first.doc.getText('markdown').insert(1, 'B');
    second.doc.getText('markdown').insert(1, 'C');
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(3);
    socket.open();
    const updates = await sent(socket, 2);
    for (const update of updates) socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    await expect.poll(second.status).toEqual({ state: 'saved', pending: 0 });
    const remaining = await first.store.load();
    expect(remaining.updates).toHaveLength(1);
    expect(remaining.states).toHaveLength(1);
    const third = await setup();
    expect(third.doc.getText('markdown').toJSON()).toBe('AB');
  });

  it('surfaces a write failure, retains the edit, and persists it on retry', async () => {
    const harness = await setup();
    const socket = harness.socket();
    socket.open();
    const put = vi
      .spyOn(PendingUpdateStore.prototype, 'put')
      .mockRejectedValueOnce(new Error('quota'));
    harness.doc.getText('markdown').insert(0, 'keep me');
    await expect.poll(harness.status).toEqual({ state: 'failed', pending: 1 });
    expect(updateMessages(socket)).toHaveLength(0);
    harness.provider.retry();
    await sent(socket);
    expect(put).toHaveBeenCalledTimes(2);
    expect((await harness.store.load()).updates).toHaveLength(1);
  });

  it('retries failed ack cleanup without resending acknowledged data', async () => {
    const harness = await setup();
    const socket = harness.socket();
    socket.open();
    harness.doc.getText('markdown').insert(0, 'saved remotely');
    const [update] = await sent(socket);
    vi.spyOn(PendingUpdateStore.prototype, 'remove').mockRejectedValueOnce(new Error('disk'));
    socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    await expect.poll(harness.status).toEqual({ state: 'failed', pending: 1 });
    harness.provider.retry();
    await expect.poll(harness.status).toEqual({ state: 'saved', pending: 0 });
    expect(updateMessages(socket)).toHaveLength(1);
  });

  it('retries unavailable IndexedDB before connecting or discarding restored data', async () => {
    const load = vi
      .spyOn(PendingUpdateStore.prototype, 'load')
      .mockRejectedValueOnce(new Error('unavailable'));
    const harness = await setup();
    expect(harness.status()).toEqual({ state: 'failed', pending: 0 });
    expect(MockWebSocket.instances).toHaveLength(0);
    harness.doc.getText('markdown').insert(0, 'during failure');
    harness.provider.retry();
    await expect.poll(() => MockWebSocket.instances.length).toBe(1);
    harness.socket().open();
    await sent(harness.socket());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets an in-flight persistence transaction finish after destroy', async () => {
    const first = await setup();
    first.doc.getText('markdown').insert(0, 'last edit');
    first.destroy();
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(1);
    const second = await setup();
    expect(second.doc.getText('markdown').toJSON()).toBe('last edit');
  });

  it('does not persist later edits past a failed dependency, then retries them in order', async () => {
    const first = await setup();
    const put = vi
      .spyOn(PendingUpdateStore.prototype, 'put')
      .mockRejectedValueOnce(new Error('disk'));
    first.doc.getText('markdown').insert(0, 'A');
    await expect.poll(first.status).toEqual({ state: 'failed', pending: 1 });
    first.doc.getText('markdown').insert(1, 'B');
    expect(put).toHaveBeenCalledTimes(1);
    expect((await first.store.load()).updates).toHaveLength(0);
    first.provider.retry();
    await expect.poll(async () => (await first.store.load()).updates.length).toBe(2);
    first.destroy();
    const second = await setup();
    expect(second.doc.getText('markdown').toJSON()).toBe('AB');
    const socket = second.socket();
    socket.open();
    const updates = await sent(socket, 2);
    const server = new Y.Doc();
    for (const update of updates) Y.applyUpdate(server, decodeBase64(update.update));
    expect(server.getText('markdown').toJSON()).toBe('AB');
    server.destroy();
  });

  it('does not resurrect a row when sync confirms an update during its local write', async () => {
    const harness = await setup();
    // The original method is explicitly bound with call below.
    // oxlint-disable-next-line typescript/unbound-method
    const original = PendingUpdateStore.prototype.put;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(PendingUpdateStore.prototype, 'put').mockImplementation(async function (
      this: PendingUpdateStore,
      entry,
      state,
    ) {
      await gate;
      await original.call(this, entry, state);
    });
    harness.doc.getText('markdown').insert(0, 'applied elsewhere');
    const socket = harness.socket();
    socket.open(harness.doc);
    resume();
    await expect.poll(harness.status).toEqual({ state: 'saved', pending: 0 });
    expect(await harness.store.load()).toEqual({ updates: [], states: [] });
    expect(updateMessages(socket)).toHaveLength(0);
  });
});
