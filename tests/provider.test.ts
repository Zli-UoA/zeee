import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ZeeeProvider, type SaveStatus } from '../src/client/provider';

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

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  receive(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type Harness = {
  doc: Y.Doc;
  provider: ZeeeProvider;
  saveStatuses: SaveStatus[];
  socket: () => MockWebSocket;
};

let cleanup: (() => void) | null = null;

function setup(): Harness {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const saveStatuses: SaveStatus[] = [];
  const provider = new ZeeeProvider(
    'page-1',
    doc,
    awareness,
    false,
    () => {},
    () => {},
    (status) => saveStatuses.push(status),
  );
  cleanup = () => {
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  };
  return {
    doc,
    provider,
    saveStatuses,
    socket: () => MockWebSocket.instances[MockWebSocket.instances.length - 1],
  };
}

function updateMessages(socket: MockWebSocket): Array<{ clientSeq: number; type: string }> {
  return socket.sent
    .map((message) => JSON.parse(message) as { clientSeq?: number; type: string })
    .filter((message) => message.type === 'update')
    .map((message) => ({ clientSeq: message.clientSeq ?? -1, type: message.type }));
}

function lastStatus(harness: Harness): SaveStatus {
  return harness.saveStatuses[harness.saveStatuses.length - 1];
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:9876/pages/page-1' } });
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
});

describe('ZeeeProvider save acknowledgements', () => {
  it('marks an update as saved only after the ack', () => {
    const harness = setup();
    const socket = harness.socket();
    socket.open();

    harness.doc.getText('markdown').insert(0, 'hello');
    const [update] = updateMessages(socket);
    expect(update.clientSeq).toBe(1);
    expect(lastStatus(harness)).toEqual({ state: 'saving', pending: 1 });

    socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    expect(lastStatus(harness)).toEqual({ state: 'saved', pending: 0 });
  });

  it('keeps a nacked update pending and resends it on retry', () => {
    const harness = setup();
    const socket = harness.socket();
    socket.open();

    harness.doc.getText('markdown').insert(0, 'retry me');
    const [update] = updateMessages(socket);
    socket.receive({ type: 'nack', clientSeq: update.clientSeq });
    expect(lastStatus(harness)).toEqual({ state: 'failed', pending: 1 });

    harness.provider.retry();
    expect(
      updateMessages(socket).filter((item) => item.clientSeq === update.clientSeq),
    ).toHaveLength(2);
    expect(lastStatus(harness)).toEqual({ state: 'saving', pending: 1 });

    socket.receive({ type: 'ack', clientSeq: update.clientSeq });
    expect(lastStatus(harness)).toEqual({ state: 'saved', pending: 0 });
  });

  it('resends updates queued while disconnected after reconnecting', () => {
    vi.useFakeTimers();
    const harness = setup();
    const first = harness.socket();
    first.open();

    first.close();
    harness.doc.getText('markdown').insert(0, 'offline edit');
    expect(lastStatus(harness)).toEqual({ state: 'unsent', pending: 1 });

    vi.advanceTimersByTime(500);
    const second = harness.socket();
    expect(second).not.toBe(first);
    second.open();

    const resent = updateMessages(second);
    expect(resent).toHaveLength(1);
    second.receive({ type: 'ack', clientSeq: resent[0].clientSeq });
    expect(lastStatus(harness)).toEqual({ state: 'saved', pending: 0 });
  });

  it('ignores a stale close from a socket replaced by retry', () => {
    const harness = setup();
    const stale = harness.socket();
    stale.open();
    stale.readyState = MockWebSocket.CLOSING;

    harness.provider.retry();
    const current = harness.socket();
    expect(current).not.toBe(stale);

    stale.close();
    current.open();
    harness.doc.getText('markdown').insert(0, 'after retry');

    expect(updateMessages(current)).toHaveLength(1);
    expect(lastStatus(harness)).toEqual({ state: 'saving', pending: 1 });
  });
});
